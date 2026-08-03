# ADR 0003: Rebuild All In-Memory State by Replaying the Log at Open

## Status

Accepted (V1). Persisted index snapshots planned for V2 (see Consequences).

## Context

Given an append-only log of operations (see [ADR 0001](0001-append-only-storage.md)),
something has to turn that log into queryable in-memory state each time the
database is opened: the collection registry, the primary index (`id →
offset`) for every collection, and every secondary index's contents.

The alternative to computing this from the log is persisting it separately —
writing a checkpoint file (or a dedicated section of the same file) that
captures index state directly, so `open()` can load it instead of scanning.

## Decision

`open()` reads every operation record sequentially from the file and
replays it against a set of well-defined rules — this is the *only*
mechanism that builds in-memory state; there is no separate checkpoint or
snapshot format in V1:

- `ncl1` / `dco1` register/remove a collection (and its primary index).
- `idx1` / `dix1` register/remove a secondary index definition, and — for
  `idx1` — rebuild that index's contents from documents already loaded into
  the primary index at that point in the log.
- `put1` sets the primary index entry for a document id to the current
  operation's offset; later records for the same id always win.
- `del1` removes the id from the primary index and all secondary indexes.
- `txnb`/`txnc` bracket a transaction: operations in between are staged and
  only applied atomically on `txnc`. An unterminated `txnb` at end-of-log
  (crash mid-batch) is silently discarded.
- `hol0` is skipped.

Replay fails hard (throws) on an operation referencing an unknown collection
or a CRC mismatch — there is no partial/best-effort recovery in V1 (planned,
see `storage.md`'s Corruption Policy).

Secondary indexes in particular are treated as pure derived state: their
persisted footprint in the log is just the `idx1` definition record, never
their contents. Contents are recomputed from scratch on every open.

## Consequences

- **No format for in-memory state to go stale or drift from the log** —
  there is exactly one source of truth (the operation log), and replay is
  the only code path that produces queryable state from it. This
  eliminates an entire class of "checkpoint out of sync with log" bugs at
  the cost of startup work.
- **Startup time is O(live document count × index count)**, dominated by
  rebuilding secondary indexes. For large databases with many indexes, this
  is the current scaling bottleneck — explicitly called out in
  `storage.md` as the reason persisted index snapshots are planned for V2.
- **Compaction and replay share the same liveness logic** conceptually:
  `compact()`'s decision of what counts as a live record is symmetric with
  what replay ends up keeping in the primary index, which is what makes the
  `Database.stats()` invariant (`sizeOnDisk === header + liveBytes +
  deadBytes`) hold.
- **Crash recovery for batches falls out of replay for free.** Because
  `txnb`/`txnc` are just operations interpreted during the same replay pass,
  atomic-batch semantics did not require a separate recovery mechanism —
  an unterminated transaction is simply operations that never got applied.
- The document cache (`src/api/document-cache.ts`) and secondary indexes
  both follow this same "empty on open, rebuilt/repopulated lazily from
  scratch" posture, which keeps the invariant consistent across every piece
  of derived state, not just indexes.

## Alternatives Considered

- **Persist index snapshots alongside the log** (e.g. a checkpoint section
  written periodically or at clean shutdown) — rejected for V1 in favor of
  simplicity and correctness-by-construction; explicitly deferred to V2
  once startup cost on large databases becomes a measured problem rather
  than a theoretical one.
- **Lazy/on-demand index rebuild** (defer building a secondary index until
  first queried) — not adopted; would complicate the query planner's
  candidate-selection logic (`IndexManager.plan()`) with a "is this index
  ready" state and was judged not worth the complexity for V1's target
  database sizes.
