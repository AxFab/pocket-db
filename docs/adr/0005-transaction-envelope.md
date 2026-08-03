# ADR 0005: Batch Atomicity via `txnb`/`txnc` Envelope Records, Not a Separate WAL

## Status

Accepted (V1).

## Context

`insertMany`, `updateMany`, and `deleteMany` each write multiple `put1`/`del1`
records for one logical call. If the process crashes after writing some but
not all of those records, replay (see [ADR 0003](0003-replay-based-startup.md))
would otherwise apply a partial batch — some documents inserted, others not —
silently corrupting the caller's atomicity expectations for what was meant to
be a single operation.

Databases typically solve this with a write-ahead log (WAL) that is separate
from the main data file: operations are staged in the WAL, and only
committed (copied/marked visible) in the main store once a commit marker is
durably written. That requires a second file, a second set of durability
rules, and a checkpoint process to reconcile the WAL back into the main
store.

Pocket DB already has exactly one log — the main data file — and no second
file to coordinate (see [ADR 0001](0001-append-only-storage.md)).

## Decision

Represent a batch as an envelope of ordinary operation records in the same
log, rather than as a separate staging file:

- A batch method writes a `txnb` (transaction begin, empty payload) record,
  then each individual `put1`/`del1` record for the batch, then a `txnc`
  (transaction commit, empty payload) record.
- **Replay-time semantics, not write-time semantics.** During replay,
  operations seen between a `txnb` and its matching `txnc` are staged in a
  buffer instead of being applied to the in-memory index immediately. Only
  when the matching `txnc` is found are all staged operations applied at
  once.
- **In-process, the in-memory state is updated only after every record in
  the batch has been appended to disk** — mirroring the replay rule so a
  live process and a freshly reopened one never disagree about whether a
  batch is visible.
- If the log ends with an open `txnb` and no matching `txnc` (a crash
  mid-batch), replay silently discards every operation staged since that
  `txnb`. There is no partial application, no error, and no repair step —
  the batch simply never happened as far as the reopened database is
  concerned.
- Nesting is disallowed: a `txnb` while a transaction is already open, or a
  `txnc` with no preceding `txnb`, both fail replay hard.

## Consequences

- Batch atomicity falls out of the same replay pass that builds all other
  state — there is no separate commit protocol, no second file, and no
  checkpoint/reconciliation step to get wrong. This is a direct extension of
  [ADR 0003](0003-replay-based-startup.md)'s "log replay is the only source
  of truth" decision rather than a bolt-on mechanism.
- The cost of a batch is `N + 2` records instead of `N` (the two envelope
  markers), each with the same fixed per-record overhead as any other
  operation (see [ADR 0002](0002-binary-file-format.md)) — negligible for
  the batch sizes Pocket DB targets.
- Atomicity is **crash-atomicity across process restarts**, not isolation.
  Within a single running process, a batch's individual `put1`/`del1`
  records are written sequentially and are not visible to concurrent reads
  until the whole batch's in-memory update runs — but Pocket DB has no
  concurrent readers within one process to begin with (single-threaded,
  synchronous writes; see the Concurrency section of `storage.md`), so this
  is a non-issue in practice rather than a guarantee actively enforced by
  the envelope.
- A transaction currently cannot be explicitly rolled back mid-batch by
  application code — the only way an in-flight batch fails to commit is a
  process crash before `txnc` is written. There is no user-facing "abort
  transaction" API in V1.
- This mechanism only covers the batch methods that use it
  (`insertMany`/`updateMany`/`deleteMany`). Multi-statement, user-composed
  transactions across arbitrary operations are out of scope for V1 —
  "lightweight transactions" are explicitly listed as a V3 item.

## Alternatives Considered

- **Separate write-ahead log file** — rejected: would introduce a second
  file to keep durable and consistent with the main store, undermining the
  single-file simplicity that is central to the project's design (see the
  Project Synopsis). Pocket DB's target deployments (desktop apps, CLI
  tools) favor "one file to back up/copy/ship" over WAL-style throughput
  optimizations that matter more for high-concurrency server databases.
- **Two-phase commit with a separate commit record referencing offsets** —
  rejected as unnecessary complexity: because the envelope markers and the
  operations they bracket are all in the same sequential log, a simple
  "was there a matching `txnc`" check is sufficient; there's no cross-file
  pointer to validate.
- **Write batch records out of order with a trailing commit that lists
  offsets** — rejected: would require buffering the whole batch's records
  in memory before writing any of them (to know the final commit record's
  content up front), whereas the begin/commit bracket lets each record be
  written and forgotten immediately, keeping memory use flat regardless of
  batch size.
