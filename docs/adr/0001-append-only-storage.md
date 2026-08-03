# ADR 0001: Append-Only Storage, No In-Place Updates

## Status

Accepted (V1).

## Context

Pocket DB targets embedded use cases — desktop apps, CLI tools, Electron apps,
prototypes, local servers, plugins, structured caches — where the database is
a single file shipped alongside the application. Two storage strategies are
common for this kind of engine:

1. **Reserialize on write.** Keep the whole dataset in memory and rewrite the
   entire file (or large pages of it) on every mutation, as many JSON-file and
   `lowdb`-style stores do.
2. **Append-only log.** Every mutation is written as a new record at the end
   of the file; nothing already on disk is ever modified in place.

Reserializing the entire file on every write is simple to reason about but
scales linearly with database size per write — an application with a
10 MB document store pays a 10 MB rewrite for a one-document update. That cost
is invisible in a small demo and prohibitive in the exact use cases Pocket DB
targets (a growing local cache or CLI tool's working set).

## Decision

Never reserialize the entire database on write. All writes are append-only
operation records; the in-memory state (primary indexes, secondary indexes,
collection registry) is rebuilt by replaying the log at open time.

Concretely:

- Every mutation — insert, replace, update, delete, create/drop
  collection/index — is encoded as one operation record and appended to the
  file via `FileStorage.appendOperation()`.
- `updateOne`/`updateMany` do not modify the existing `put1` record for a
  document. They read the current version, apply the update in memory, and
  append a brand new `put1` record. The primary index is repointed to the new
  offset; the old record becomes dead space.
- The primary index (`Map<id, offset>`) always tracks only the latest offset
  for each document id. Nothing on disk is ever mutated after being written.
- Dead space (superseded `put1` records, `del1` tombstones, closed
  transaction envelopes) accumulates until an explicit `compact()` rewrites
  the live subset of the file in a single forward pass.

See [file-format.md](../file-format.md) for the record layout and
[storage.md](../storage.md) for the write path and replay rules.

## Consequences

- Write cost is O(1) in database size — a single `write()` syscall of the
  new record, regardless of how large the database has grown. This is the
  property that makes Pocket DB viable for the append-heavy, long-lived local
  stores it targets.
- The file only grows between compactions. Disk usage is not a real-time
  reflection of live data size; `Database.stats()` exposes `liveBytes` /
  `deadBytes` so callers can decide when to compact.
- Compaction is manual (`db.compact()`), not automatic, and cannot safely run
  while cursors are open (see [ADR 0004](0004-cursor-snapshot-semantics.md)
  and [compact.md](../compact.md)). Automatic compaction is deferred to V2.
- Every historical version of a document remains physically present on disk
  until compaction. This is a byproduct of the design, not a feature —
  Pocket DB does not currently expose any way to query prior versions.
- The design assumes a single writer process (see the file-lock ADR-worthy
  decision documented in `storage.md`'s Concurrency section); append-only
  logs do not by themselves solve concurrent-writer coordination.

## Alternatives Considered

- **Reserialize whole file on write** — rejected: violates the core
  performance constraint for the target use cases (see Context).
  Reserializing on demand (i.e. a full write of everything).
- **In-place binary updates** (rewrite only the bytes of the changed record)
  — rejected: fixed-size records would waste space for most documents,
  variable-size in-place updates require a free-space allocator and risk
  partial-write corruption on crash. Append-only sidesteps both by making
  every write a pure addition; a torn write at the tail is trivially
  detectable and truncatable (see the Corruption Policy in `storage.md`).
