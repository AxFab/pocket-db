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

Replay reads the log through a bounded sliding window (`FileStorage.readOperations()`,
default 8MiB), not by loading the whole file into memory at once — peak memory
during `open()`/`stats()`/`compact()` is a small multiple of the window size,
not the file size. See [ADR 0017](adr/0017-streaming-replay-buffer.md).

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

Documents are stored using one of three serialization formats, selected per
file: JSON (`JSON.stringify` output, UTF-8), BSON (Binary JSON), or AMF3
(Action Message Format 3). There is no partial-field encoding or delta
compression regardless of format: every `put1` record contains the full
document, including the `_id` field. Updates produce a new `put1` record for
the updated document; the previous version becomes a dead record.

The document serialization format is recorded in the file header (`j` = JSON,
`b` = BSON, `a` = AMF3, currently all version `0`) and chosen via the
`serialization` option on `pocketDb()` when a **new** file is created; opening
an existing file always uses the format already recorded in its header. All
records in a given file use the same format — formats are never mixed.

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

`OpenOptions` exposes a `durability` option:

```ts
pocketDb(path, { durability: "relaxed" | "strict" })
```

- `relaxed` (default): write to the file descriptor without forcing an fsync
  after every operation. Data may be lost if the OS crashes before flushing its
  buffers.
- `strict`: call `fsyncSync` after every `appendOperation`, guaranteeing the
  kernel has flushed the record to durable storage before the call returns.
  One extra syscall per write.

`relaxed` does not call `fsync` and therefore should not be relied on for full
crash durability against an OS-level crash (a process crash is unaffected
either way, since already-written bytes are in the OS page cache). Both modes
provide atomic replay semantics for batches: uncommitted `txnb`/`txnc` records
are ignored on reopen regardless of durability mode.

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
proportionally to the number of live documents. The rebuild itself reads
every existing document via one bulk range read per index (not one `readSync`
per document — see [ADR 0016](adr/0016-bounded-candidate-range-read.md)), so
this cost is dominated by JSON decode rather than syscall overhead.

Persisted index snapshots that allow skipping the rebuild on open are planned
for V2.

See [indexes.md](indexes.md) for the full description of the index model and
query planner.

## Concurrency

Pocket DB is designed as a single-process embedded database.

`open()` acquires a `.lock` file next to the database (created with the
exclusive `wx` flag, containing the writer's PID) before opening storage, and
releases it in `close()` — including when `open()` itself fails partway
through, so a bad open never leaves the file permanently locked. If the lock
file already exists, Pocket DB reads the PID inside it and checks whether that
process is still alive (`process.kill(pid, 0)`); a stale lock left behind by a
crashed process is removed and acquisition retried (bounded to a few attempts
before throwing). A live conflicting process causes `open()` to throw
immediately, naming the holding PID.

This prevents two processes from opening the same file concurrently, but
Pocket DB still supports only one writer at a time — there is no multi-process
write coordination beyond the exclusivity of the lock itself.

Within one process, all writes are synchronous and serialised. There is no write
queue or async I/O.
