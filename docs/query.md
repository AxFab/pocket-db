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

### `$gt` / `$lt`

Matches documents where the field value is strictly greater than / less than the
given value.

```ts
collection.find({ age: { $gt: 18 } })
collection.find({ score: { $lt: 100 } })
collection.find({ age: { $gt: 18, $lt: 65 } })
```

Only numeric comparisons are meaningful. Non-numeric fields are not indexed by
`NumberIndex` and will not match.

### `$in`

Matches documents where the field value equals any of the listed values.

```ts
collection.find({ role: { $in: ["admin", "editor"] } })
```

### `$exists`

Matches documents where the field is present (`true`) or absent (`false`).

```ts
collection.find({ email: { $exists: true } })
collection.find({ deletedAt: { $exists: false } })
```

`$exists` is always evaluated in the residual pass; no index supports it.

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

Unsupported operators (e.g. `$or`, `$not`, `$nor`) throw at query compilation
time.

## Query Compilation

`compileQuery(query)` converts the raw query object into a tree of
`CompiledQuery` nodes:

```
CompiledQuery = AndPredicate | FieldPredicate

AndPredicate   = { type: "and"; predicates: CompiledQuery[] }
FieldPredicate = { type: "field"; field: string; operators: FieldOperator[] }
```

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

### `$push`

Appends a value to an existing array field. Throws if the field does not exist
or is not an array.

```ts
collection.updateOne(id, { $push: { tags: "typescript" } })
```

## Immutability of `_id`

The `_id` field cannot be modified by any update operator. Using `$set` or
`$unset` on `_id` throws before any disk write occurs.

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
