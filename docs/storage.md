# Storage Semantics

Pocket DB uses a single append-only file. Opening a database validates the
12-byte file header, then replays all operation records sequentially to rebuild
the in-memory state: collection registry, primary indexes, and secondary index
definitions.

## Replay

Replay starts at byte offset 12, immediately after the file header.

The replay rules are:

- `ncl1` registers a collection and initialises its primary index.
- `dco1` removes the collection from the registry and clears its primary index.
- `idx1` registers a secondary index definition and rebuilds its contents from
  documents already loaded into the primary index at that point in the log.
- `dix1` removes the secondary index from the collection's index manager.
- `put1` records or replaces the file offset for a document id in the primary
  index. Later records for the same id overwrite earlier ones; replay always
  keeps the last seen offset.
- `del1` removes a document id from the primary index and from all secondary
  indexes.
- `txnb` starts staging subsequent operations instead of applying them.
- `txnc` applies all staged operations at once and clears the staging buffer.
- `hol0` is silently skipped; it has no effect on state.

If the log ends after `txnb` without a `txnc`, the staged operations are
silently discarded. This gives batch operations atomic replay semantics after a
crash: either all operations in a batch are visible or none are.

Replay fails hard if:
- a document or index operation references an unknown collection id;
- a CRC32 checksum does not match;
- a `txnb` appears while a transaction is already open;
- a `txnc` appears with no preceding `txnb`.

## Write Path

All writes go through `FileStorage.appendOperation(identifier, payload)`:

1. The current write offset is read from the in-memory `currentOffset` counter,
   which is initialised from `fstatSync` when the file is opened and maintained
   internally thereafter — no `stat` call per write.
2. The record is encoded as `[identifier][length][payload][crc32]`.
3. The record is written atomically via a retry loop over `writeSync`.
4. `currentOffset` advances by the record's byte length.
5. The write offset (before the advance) is returned as the record's file
   offset.

Single-record operations (`insertOne`, `replaceOne`, `updateOne`, `deleteOne`,
`drop`, `dropIndex`, `createIndex`) write one record and update the in-memory
state immediately.

Batch operations (`insertMany`, `updateMany`, `deleteMany`) write a `txnb`
record, then all individual records, then a `txnc` record, and only then update
the in-memory state. If the process crashes between `txnb` and `txnc`, the
partial batch is invisible on the next open.

## Document Storage

Documents are stored as `JSON.stringify` output, encoded as UTF-8. There is no
partial-field encoding or delta compression: every `put1` record contains the
full document, including the `_id` field. Updates produce a new `put1` record
for the updated document; the previous version becomes a dead record.

The document serialization format is recorded in the file header (`j` for JSON,
version `0`). All records in a file use the same format.

## Corruption Policy

The intended first-version recovery policy is:

- if the last operation is truncated, ignore it, truncate the file to the last
  valid offset, emit a warning, and mark the database instance as recovered;
- if a CRC check fails or a payload is invalid, follow the `pocketDb()` corruption
  option:
  - `warn`: ignore the invalid operation when this can be done safely;
  - `fail`: close the database and throw;
  - `repair`: attempt to truncate or rebuild from the last known valid point.

The recovered flag should be visible on the database instance so compaction can
make conservative choices after a damaged tail was found.

Neither truncation recovery nor the corruption option are implemented yet.

## Durability

The intended API should expose a durability option:

```ts
pocketDb({ durability: "relaxed" | "strict" })
```

- `relaxed`: write to the file descriptor without forcing an fsync after every
  operation. Data may be lost if the OS crashes before flushing its buffers.
- `strict`: force data to disk with `fsync` before acknowledging the write.

The current implementation does not call `fsync` and should not claim full crash
durability until this option is implemented. It does provide atomic replay
semantics for batches: uncommitted records are ignored on reopen.

## Compaction

Compaction rewrites the live portion of the file in a single forward pass and
truncates dead space. See [compact.md](compact.md) for the full algorithm.

A note on timing: cursors capture a `{ id, offset }` snapshot when `find()` is
called. Compaction moves records to lower file offsets without invalidating
in-memory primary index entries, which are updated during the pass. However,
open cursors still hold the old offsets from before compaction started. Callers
must ensure no cursors are alive when compaction runs. See
[compact.md](compact.md) for the planned cursor-tracking mechanism.

## Indexes

Secondary indexes are in-memory only. Their definitions (`idx1` records) are
persisted in the log, but their contents are rebuilt from documents at every
open. For large databases with many secondary indexes, startup time grows
proportionally to the number of live documents.

Persisted index snapshots that allow skipping the rebuild on open are planned
for V2.

See [indexes.md](indexes.md) for the full description of the index model and
query planner.

## Concurrency

Pocket DB is designed as a single-process embedded database.

Multiple processes must not open and write to the same file simultaneously. No
file locking is implemented yet. A lock file or platform-specific file locking
is planned for V1 completion.

Within one process, all writes are synchronous and serialised. There is no write
queue or async I/O.
