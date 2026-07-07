# Query and Update Model

## Query Operators

Queries are plain JavaScript objects whose keys are field names and whose values
are either a direct value (implicit `$eq`) or an operator object.

### Implicit equality

```ts
collection.find({ role: "admin" })
// equivalent to { role: { $eq: "admin" } }
```

### `$eq`

Matches documents where `field === value`. Strict equality; no type coercion.

```ts
collection.find({ age: { $eq: 30 } })
```

### `$ne`

Matches documents where the field value does not strictly equal the given
value (including documents where the field is missing, since `undefined`
never equals the operand).

```ts
collection.find({ status: { $ne: "archived" } })
```

### `$gt` / `$gte` / `$lt` / `$lte`

Matches documents where the field value is strictly greater than / greater
than or equal to / strictly less than / less than or equal to the given value.

```ts
collection.find({ age: { $gt: 18 } })
collection.find({ age: { $gte: 18 } })
collection.find({ score: { $lt: 100 } })
collection.find({ score: { $lte: 100 } })
collection.find({ age: { $gt: 18, $lt: 65 } })
```

Only numeric comparisons are meaningful. Non-numeric fields are not indexed by
`NumberIndex` and will not match.

### `$in` / `$nin`

`$in` matches documents where the field value equals any of the listed
values. `$nin` matches documents where the field value equals none of them
(a missing field also satisfies `$nin`, since it can't equal any listed value).

```ts
collection.find({ role: { $in: ["admin", "editor"] } })
collection.find({ role: { $nin: ["banned", "suspended"] } })
```

### `$exists`

Matches documents where the field is present (`true`) or absent (`false`).

```ts
collection.find({ email: { $exists: true } })
collection.find({ deletedAt: { $exists: false } })
```

`$exists` is always evaluated in the residual pass; no index supports it.

### `$regex`

Matches documents where the field value is a string matching the regular
expression. Non-string values (including missing fields) never match.

The pattern can be a string (flags supplied via `$options`), a `RegExp`
instance (flags on the RegExp itself), or a bare `RegExp` as shorthand for the
whole condition.

```ts
collection.find({ name: { $regex: "^ada", $options: "i" } })
collection.find({ name: { $regex: /^ada/i } })
collection.find({ name: /^Ada/ })
```

Allowed flags are `i`, `m`, `s`, and `u`. The `g` and `y` flags are rejected at
compile time because they make `RegExp.test` stateful (`lastIndex` carries over
between calls). `$options` cannot be combined with a `RegExp` pattern — put the
flags on the RegExp instead.

`$regex` is always evaluated in the residual pass; no index supports it.

### `$type`

Matches documents where the field value has one of the given JSON types. The
operand is a single type name or an array of names (the value matches if it is
any of them). A missing field never matches.

```ts
collection.find({ score: { $type: "number" } })
collection.find({ tags: { $type: "array" } })
collection.find({ value: { $type: ["string", "number"] } })
```

Accepted type names: `null`, `boolean` (alias `bool`), `number`, `string`,
`array`, and `object`. `array` is reported for arrays and `object` only for
plain objects (never arrays); `null` is its own type, distinct from `object`.
Names are case-sensitive — unknown names, an empty array, and non-string
entries throw at compile time.

`$type` is always evaluated in the residual pass; no index supports it.

### `$not`

Negates a field operator expression. Matches documents where the field does
**not** satisfy every operator listed inside `$not` (so a missing field, which
fails most operators, typically matches `$not`).

```ts
collection.find({ age: { $not: { $gt: 65 } } })
collection.find({ tags: { $not: { $in: ["draft", "archived"] } } })
```

The value must be a non-null, non-array object with at least one `$`-operator
key; `{}` and non-object values throw at compile time.

### `$and`

Combines multiple sub-queries with logical AND. The result matches documents
that satisfy every sub-query.

```ts
collection.find({
  $and: [
    { role: "admin" },
    { age: { $gt: 18 } }
  ]
})
```

Top-level fields in the same query object are already implicitly ANDed, so
`$and` is only needed when multiple conditions target the same field or when
explicit grouping is required.

### `$or`

Matches documents that satisfy at least one of the listed sub-queries. An
empty `$or: []` array matches no documents.

```ts
collection.find({
  $or: [
    { role: "admin" },
    { age: { $gte: 65 } }
  ]
})
```

Disjunctive queries (`$or`) are never answered by a secondary index — the
query planner always falls back to a full collection scan for the branch
containing `$or`, since narrowing by one index could miss documents matched
only by another branch. Every candidate is still fully re-evaluated against
the compiled query, so results are correct; only the candidate-narrowing
optimization is unavailable. Index-assisted planning for `$or` is planned for
a future version — see [indexes.md](indexes.md#query-planner).

### `$nor`

Matches documents that satisfy **none** of the listed sub-queries — the
logical negation of `$or`. An empty `$nor: []` array matches every document.

```ts
collection.find({
  $nor: [
    { status: "banned" },
    { status: "suspended" }
  ]
})
```

Like `$or`, `$nor` always falls back to a full collection scan (see above);
the full query is still evaluated correctly against every document.

Unsupported operators (e.g. `$where`, `$size`) throw at query
compilation time.

## Query Compilation

`compileQuery(query)` converts the raw query object into a tree of
`CompiledQuery` nodes:

```
CompiledQuery = AndPredicate | OrPredicate | NorPredicate | FieldPredicate

AndPredicate   = { type: "and"; predicates: CompiledQuery[] }
OrPredicate    = { type: "or"; predicates: CompiledQuery[] }
NorPredicate   = { type: "nor"; predicates: CompiledQuery[] }
FieldPredicate = { type: "field"; field: string; operators: FieldOperator[] }
```

Top-level query fields are combined into a single `AndPredicate`; `$or` and
`$nor` each compile to their own node wrapping their sub-queries (which are
themselves fully compiled, so they can nest `$and`/`$or`/`$nor` arbitrarily).

The compiled form is passed to the query planner and to the per-document
evaluator. Compilation happens once per `find()` or `findOne()` call; cursor
iteration uses the already-compiled query.

## Cursor Semantics

`collection.find(query)` compiles the query, asks the index manager to plan a
candidate set, and returns a `PocketCursor`. The cursor captures a
**snapshot** of `{ id, offset }` pairs at creation time.

Subsequent writes — inserts, updates, deletes — are invisible to the cursor.
This is an intentional invariant: cursor iteration is deterministic and
unaffected by concurrent mutations within the same process.

Each call to `cursor.next()`:
1. Picks the next candidate from the snapshot.
2. Reads the document from disk at the stored file offset.
3. Evaluates the full compiled query against the document.
4. Returns the document if it matches, or advances to the next candidate.

`cursor.toArray()` drains the cursor and collects all matching documents.

### `limit(count)`

Stops iteration after returning `count` matching documents. Must be a
non-negative integer. A limit of `0` returns no documents.

### `skip(count)`

Skips the first `count` matching documents before returning results. Must be a
non-negative integer. Skipping is applied after query evaluation, not before
disk reads.

## Distinct Values

`collection.distinct(field, query?, options?)` returns the distinct values
held by `field` across documents matching `query` (default: all documents).

```ts
collection.distinct("role")
// -> ["admin", "editor", "reader"]

collection.distinct("role", { active: true })
// -> only roles held by active documents
```

Values are compared by deep equality — the same rule `$eq`/`$in` use: strict
equality for primitives, JSON-structural equality for arrays and objects. Two
documents whose `field` holds the same array or object content contribute a
single distinct value; different content contributes separate values.

```ts
collection.insertMany([
  { tags: ["a", "b"] },
  { tags: ["a", "b"] }, // same content — not a new distinct value
  { tags: ["a", "c"] }  // different content — a new distinct value
]);

collection.distinct("tags")
// -> [["a", "b"], ["a", "c"]]
```

Documents where `field` is missing do not contribute a value. `distinct`
reuses `find(query)` internally, so a secondary index on `field` (or on a
field used in `query`) narrows candidates exactly as it would for a normal
query — see [indexes.md](indexes.md).

### Distinct value limit

`distinct` throws once the number of distinct values would exceed
`options.limit` (default `100`) — a safety guard against unbounded memory
growth when `field` turns out to be high-cardinality (e.g. a free-text field
or a unique id used by mistake). Raise the limit explicitly when more values
are legitimately expected:

```ts
collection.distinct("userId")               // throws past 100 distinct values
collection.distinct("userId", {}, { limit: 5000 })
```

The check happens as values are collected — reading stops at the first value
that would exceed the limit rather than reading the whole collection first.

## Update Operators

Updates are expressed as an object whose keys are operator names. Unsupported
operators throw immediately.

### `$set`

Sets the listed fields to the given values. Adds the field if it does not
exist.

```ts
collection.updateOne(id, { $set: { name: "Grace", role: "admin" } })
```

### `$unset`

Removes the listed fields from the document. The value in the `$unset` object
is ignored; by convention use `1` or `true`.

```ts
collection.updateOne(id, { $unset: { tempFlag: 1 } })
```

### `$inc`

Increments a numeric field by the given amount. Throws if the field does not
exist or is not a number.

```ts
collection.updateOne(id, { $inc: { counter: 1, score: -5 } })
```

### `$min`

Sets the field to the given value only if the given value is less than the
current value. Throws if the field does not exist or is not a number.

```ts
collection.updateOne(id, { $min: { temperature: -10 } })
```

### `$max`

Sets the field to the given value only if the given value is greater than the
current value. Throws if the field does not exist or is not a number.

```ts
collection.updateOne(id, { $max: { highScore: 9000 } })
```

### `$mul`

Multiplies a numeric field by the given factor. Throws if the field does not
exist or is not a number.

```ts
collection.updateOne(id, { $mul: { price: 1.2 } })
```

### `$rename`

Renames a field. A missing source field is a no-op; an existing target field
is overwritten. The source and target names must differ.

```ts
collection.updateOne(id, { $rename: { nickname: "displayName" } })
```

### `$currentDate`

Sets a field to the current date. The format is chosen per field:

| Specification | Stored value |
|---------------|--------------|
| `true` or `{ $type: "date" }` | ISO-8601 string, e.g. `"2026-06-10T12:00:00.000Z"` |
| `{ $type: "timestamp" }` | Unix epoch milliseconds (number) |

```ts
collection.updateOne(id, {
  $currentDate: {
    updatedAt: true,
    modifiedAt: { $type: "date" },
    touchedAt: { $type: "timestamp" }
  }
})
```

All fields in one `$currentDate` expression share the same clock reading.

### `$push`

Appends a value to an existing array field. Throws if the field does not exist
or is not an array.

```ts
collection.updateOne(id, { $push: { tags: "typescript" } })
```

### `$addToSet`

Appends a value to an existing array field only if no deep-equal element is
already present. Throws if the field does not exist or is not an array.

```ts
collection.updateOne(id, { $addToSet: { tags: "typescript" } })
```

### `$pop`

Removes the last (`1`) or first (`-1`) element of an existing array field.
An empty array is a no-op. Throws if the field does not exist or is not an
array, or if the direction is not `1` or `-1`.

```ts
collection.updateOne(id, { $pop: { queue: -1 } })  // remove first
collection.updateOne(id, { $pop: { stack: 1 } })   // remove last
```

### `$pull`

Removes all elements of an existing array field that equal a literal value, or
that match an operator expression (the same operators as queries, evaluated
against each element).

```ts
collection.updateOne(id, { $pull: { tags: "obsolete" } })
collection.updateOne(id, { $pull: { scores: { $lt: 10 } } })
collection.updateOne(id, { $pull: { tags: { $regex: "^tmp-" } } })
```

### `$pullAll`

Removes all elements of an existing array field that equal any of the listed
values (deep equality, like `$pull` with literals).

```ts
collection.updateOne(id, { $pullAll: { scores: [0, 1] } })
```

## Immutability of `_id`

The `_id` field cannot be modified by any update operator. Using `$set`,
`$unset`, `$rename`, or `$currentDate` on `_id` (or renaming another field to
`_id`) throws before any disk write occurs.

```ts
collection.updateOne(id, { $set: { _id: "other" } }) // throws
collection.updateOne(id, { $unset: { _id: 1 } })     // throws
```

`_id` can be supplied explicitly on insert if it conforms to the 24-character
lowercase hex format. Once set, it is stored inside the document JSON and
returned with every read.

## Write Model for Updates

Updates are always full-document rewrites. `updateOne` reads the current
document, applies the update expression in memory, and appends a new `put1`
record for the modified document. The previous `put1` record for that document
id becomes a dead record and is reclaimed by the next compaction.

There is no partial-field encoding or delta log. Every `put1` record contains
the complete document.
