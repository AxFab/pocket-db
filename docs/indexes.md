# Indexes

Pocket DB maintains one primary index per collection and zero or more secondary
indexes. All indexes are held in memory; their contents are rebuilt from the
append-only log every time the database is opened.

## Primary Index

`InMemoryPrimaryIndex` is a `Map<string, { id, offset }>` keyed by the
document id hex string. It answers two kinds of query:

- **Equality** (`_id = value`): direct map lookup, O(1).
- **Inclusion** (`_id $in [v1, v2, …]`): one lookup per value, O(k).

Any other predicate on `_id` (range, existence, etc.) causes the primary index
to return `null`, signalling the planner to fall back to a full collection scan.

`snapshot()` returns all `{ id, offset }` pairs in insertion order and is used
for full collection scans. The snapshot is taken at `find()` time; subsequent
writes do not affect it.

## Secondary Indexes

Secondary indexes are created explicitly with `collection.createIndex(field,
{ type, unique? })`. Two types are supported. `unique` (default `false`) turns
the index into a uniqueness constraint — see [Unique Indexes](#unique-indexes)
below.

### StringIndex

`StringIndex` maintains two maps:

```
values:    Map<string_value, Map<document_id, IndexCandidate>>
valuesById: Map<document_id, string_value>
```

`valuesById` is the reverse map, used to remove a document from its value
bucket when it is updated or deleted.

**Indexed values.** Only fields whose value is a `string` are indexed. Numeric,
boolean, null, array, object, and missing fields are silently ignored.

**Supported predicates.**

| Operator | Behaviour |
|----------|-----------|
| `$eq` | Returns all candidates for that string value |
| `$in` | Returns the union of candidates across all listed string values |
| `$gt`, `$lt`, `$exists`, other | Returns `null` (no index used) |

### NumberIndex

`NumberIndex` maintains two maps and a sorted array:

```
values:       Map<number_value, Map<document_id, IndexCandidate>>
valuesById:   Map<document_id, number_value>
sortedValues: number[]   (maintained in ascending order via binary-search insert)
```

**Indexed values.** Only fields whose value is a finite `number` are indexed.
`NaN`, `Infinity`, `-Infinity`, non-number types, and missing fields are
silently ignored.

**Supported predicates.**

| Operator | Behaviour |
|----------|-----------|
| `$eq` | Direct map lookup for the exact number value |
| `$in` | Union of map lookups for all listed finite number values |
| `$gt` | Filters `sortedValues` for values strictly greater than the bound |
| `$lt` | Filters `sortedValues` for values strictly less than the bound |
| Combined `$gt`+`$lt` | Single filter pass over `sortedValues` with both bounds |
| `$exists`, other | Returns `null` (no index used) |

Range queries use `sortedValues` to identify the matching value buckets, then
collect all candidates from those buckets.

## Unique Indexes

`collection.createIndex(field, { type, unique: true })` adds a uniqueness
constraint on top of an ordinary `StringIndex`/`NumberIndex`: at most one
document may hold any given value for that field. Only `StringIndex` and
`NumberIndex` support `unique`; the primary index (`_id`) is implicitly unique
already and does not go through this mechanism.

**Check-before-append.** Storage is append-only — once a `put1` record is
written it cannot be rolled back — so every write path validates uniqueness
against the *document it is about to store*, before calling
`appendOperation`:

- `insertOne` / `replaceOne` / `updateOne` call `IndexManager.assertUnique(document,
  excludeId?)`, which asks each `unique` index for the id currently holding the
  same value (`QueryIndex.findOwner`) and throws if it belongs to a different
  document. `excludeId` is the document's own id for `replaceOne`/`updateOne`,
  so a document may keep its own existing value without tripping the check
  against itself.
- `insertMany` / `updateMany` call `IndexManager.assertUniqueBatch(entries)`
  instead. Beyond checking each entry against the already-stored index
  contents, it also tracks values seen earlier in the same batch, because two
  documents inserted or updated together are invisible to each other until the
  whole batch is applied. A conflict anywhere in the batch rejects the entire
  call — nothing is written (both are wrapped in `txnb`/`txnc` and the
  in-memory index update never runs).

**Type participation.** A value only participates in the uniqueness check if
it matches the index's own type — exactly the same rule `add()` uses to decide
whether to index a value at all (`StringIndex` only cares about `string`
values, `NumberIndex` only about finite numbers). A missing field, or a field
holding a value of a different type, never conflicts, mirroring "indexes
narrow, unique constraints only see what would otherwise be indexed."

**Creating a unique index over existing data.** `createIndex(field, { type,
unique: true })` populates the index from the current documents exactly like a
non-unique index, then scans the freshly built index for any value mapped to
more than one document (`QueryIndex.findDuplicate`). If a conflict is found,
the index is removed again (nothing is persisted) and the call throws —
`existsIndex(field)` remains `false` and no `idx1` record is written. Creating
a unique index is otherwise the same O(N) operation as any other `createIndex`
call.

Once an index exists as `unique`, every subsequent write is checked, so it can
never drift back into conflict — the duplicate scan above only matters for the
very first population of a **new** index.

**Recreating with a different flag.** Calling `createIndex` again for a field
that already has an index, but with a different `unique` value than the
existing index, throws (same as passing a different `type`).

## IndexManager

`IndexManager` orchestrates all secondary indexes for one collection. Its
responsibilities are:

- **Create / remove** secondary indexes (`createIndex`, `removeIndex`).
- **Maintain** index contents as documents are inserted, updated, or deleted
  (`updateDocument`, `removeDocument`).
- **Plan** queries by selecting the most selective index (`plan`).
- **Clear** index contents for compaction refresh (`clearAllIndexContents`).
- **Enforce** `unique` constraints on the write path (`assertUnique`,
  `assertUniqueBatch`) and at index-creation time (`findDuplicate`) — see
  [Unique Indexes](#unique-indexes).

## Query Planner

`IndexManager.plan(compiledQuery, primaryIndex)` selects at most one index to
narrow the candidate set for a query. The algorithm:

1. Walk every `FieldPredicate` node in the compiled query tree.
2. For each predicate, look for a matching index:
   - the primary index if the predicate is on `_id`;
   - a secondary index if one exists for the predicate's field.
3. Ask each candidate index to `scan` the predicate; `scan` returns a candidate
   list or `null` if the index cannot answer that predicate type.
4. Among all non-null results, pick the index with the **fewest candidates**
   (smallest result set).

If no index can serve any predicate, the planner falls back to `primaryIndex.
snapshot()`, which is the full collection scan.

The selected index and its candidates are returned in a `QueryPlan`:

```ts
interface QueryPlan {
  candidates: IndexCandidate[];
  residualQuery: CompiledQuery;
  usedIndex?: IndexDefinition;
}
```

`residualQuery` is always the full compiled query. Indexes only narrow
candidates; document-level filtering is always performed regardless of which
index was used.

## Indexes Narrow, Documents Filter

This is the central invariant of the index system: **an index can only reduce
the set of candidate documents; it never replaces the full query evaluation**.

Every candidate returned by an index is read from disk and re-evaluated against
the complete compiled query before being returned to the caller. This means:

- An index on `role` can be used to narrow a query for
  `{ role: "admin", age: { $gt: 30 } }`, but the `age > 30` condition is still
  checked on every document read.
- A document missing the indexed field is simply not in the index and will not
  appear as a candidate; it is not a false positive.
- Composite conditions, nested predicates, and operators the index does not
  understand are all handled correctly by the residual evaluation.

This keeps index implementations simple: they only need to produce a
conservative superset of matching documents, never an exact set.

## Secondary Index Persistence

Secondary index **definitions** (field name, type, and the `unique` flag) are
persisted in the log via `idx1` records. Secondary index **contents** (the
actual value-to-document mappings) are not persisted. They are rebuilt from the
`put1` records in the log at every open.

Consequence: startup time grows with the number of live documents when secondary
indexes exist. For a collection with N documents and K secondary indexes, startup
requires N document reads from disk (one per `put1`) plus N × K index insertions
in memory.

Persisted index snapshots that eliminate the rebuild cost are planned for V2.

## Index Lifecycle

### Creation

`collection.createIndex(field, { type, unique? })` writes an `idx1` record and
then immediately rebuilds the new index contents from the current primary
index. Creating an index on a collection with many existing documents is
therefore an O(N) disk read operation at call time. When `unique: true`, the
freshly built index is also scanned for conflicts (see [Unique
Indexes](#unique-indexes)); a conflict undoes the in-memory creation and
throws before anything is appended to the log.

If `createIndex` is called again for the same field, type, and `unique` flag,
no new `idx1` record is written; the existing in-memory index is returned.

If `createIndex` is called for the same field with a different type or a
different `unique` flag, it throws.

### Removal

`collection.dropIndex(field)` writes a `dix1` record and removes the index from
the in-memory index manager. The index contents are discarded. Queries that
previously used the index fall back to a full scan.

### Compaction

During compaction, a `idx1` record is kept only if the corresponding index still
exists in memory (i.e. it was not subsequently dropped). A `dix1` record is
always discarded because its effect has already been applied during replay.
After the file is truncated, all secondary indexes are cleared and repopulated
from the updated primary index. See [compact.md](compact.md).
