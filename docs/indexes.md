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
{ type })`. Two types are supported.

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

## IndexManager

`IndexManager` orchestrates all secondary indexes for one collection. Its
responsibilities are:

- **Create / remove** secondary indexes (`createIndex`, `removeIndex`).
- **Maintain** index contents as documents are inserted, updated, or deleted
  (`updateDocument`, `removeDocument`).
- **Plan** queries by selecting the most selective index (`plan`).
- **Clear** index contents for compaction refresh (`clearAllIndexContents`).

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

Secondary index **definitions** (field name and type) are persisted in the log
via `idx1` records. Secondary index **contents** (the actual value-to-document
mappings) are not persisted. They are rebuilt from the `put1` records in the log
at every open.

Consequence: startup time grows with the number of live documents when secondary
indexes exist. For a collection with N documents and K secondary indexes, startup
requires N document reads from disk (one per `put1`) plus N × K index insertions
in memory.

Persisted index snapshots that eliminate the rebuild cost are planned for V2.

## Index Lifecycle

### Creation

`collection.createIndex(field, { type })` writes an `idx1` record and then
immediately rebuilds the new index contents from the current primary index.
Creating an index on a collection with many existing documents is therefore an
O(N) disk-read operation at call time.

If `createIndex` is called again for the same field and type, no new `idx1`
record is written; the existing in-memory index is returned.

If `createIndex` is called for the same field with a different type, it throws.

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
