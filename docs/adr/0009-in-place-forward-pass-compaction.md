# ADR 0009: Compaction Rewrites the Existing File In-Place, in a Single Forward Pass

## Status

Accepted (V1). Automatic/background compaction and cursor-aware scheduling
planned for V2.

## Context

Append-only storage ([ADR 0001](0001-append-only-storage.md)) means dead
records — superseded `put1` versions, `del1` tombstones, dropped
collections/indexes, `txnb`/`txnc` markers, `hol0` holes — accumulate
indefinitely. Something has to reclaim that space, or the file grows without
bound relative to live data.

Two broad implementation strategies exist:

1. **Write a brand-new file** containing only live records, then swap it in
   (rename over the original).
2. **Rewrite the existing file in place**, shifting live records toward the
   front of the same file and truncating the tail.

A new-file approach is conceptually simpler (the source file is untouched
until the very end) but requires up to 2× the disk space during compaction
and a rename/replace step. An in-place approach avoids the space overhead
but has to prove it never overwrites data it still needs to read.

## Decision

Implement compaction as an in-place, single forward pass over the existing
file, using two cursors:

- `scan_head` — the next record to examine (read position).
- `write_head` — the next slot to fill with a kept record (write position).

Both start at `FILE_HEADER_BYTES`. For each record at `scan_head`:
`shouldKeepOperation()` decides liveness (`put1` is kept only if its offset
still matches the primary index's current entry for that document id —
everything else follows a fixed table: `ncl1`/`idx1` kept if the
collection/index still exists, `del1`/`dco1`/`dix1`/`txnb`/`txnc`/`hol0`
always discarded, unknown identifiers always kept defensively). A kept
record is copied from `scan_head` to `write_head` only if the two have
diverged (`write_head < scan_head`); either way `write_head` advances by the
record's length. `scan_head` always advances by the record's length. The
file is truncated to the final `write_head` at the end.

This decision rests on an invariant proven by induction over the pass:
`write_head <= scan_head` holds at every step (a kept record advances both
cursors equally; a discarded record widens the gap). Because the write
cursor never overtakes the read cursor, an in-place copy never reads bytes
that have already been overwritten by an earlier copy in the same pass.

Two properties fall out of the same reasoning:

- **Crash safety without a second file.** If the process dies mid-pass, some
  records exist at both their old and new (lower) positions, some only at
  their original position, and the file is not yet truncated — but every
  live record's *original* bytes are still intact somewhere at
  `scan_head` or higher, because nothing at or above `scan_head` has been
  touched. The next `open()` simply replays the file as it is (pre- or
  mid-compaction), rebuilding correct state; the next `compact()` call
  starts the pass over from scratch. No explicit recovery logic is needed.
- **Idempotency.** Running compaction twice produces identical output — after
  the first pass every kept record already sits at `write_head == scan_head`,
  so the second pass performs zero copies and truncates to the same point.

The 12-byte file header is never touched; both cursors start immediately
after it and truncation never targets below `FILE_HEADER_BYTES`.

Secondary indexes are not tracked incrementally during the pass (their
candidates hold `{id, offset}` pairs that would otherwise need per-record
updates as documents move). Instead, after the forward pass and truncation,
every secondary index is cleared and rebuilt in one sweep from the
now-correct primary index — the same operation as an index rebuild at
startup (see [ADR 0003](0003-replay-based-startup.md) and
[ADR 0006](0006-secondary-indexing-strategy.md)).

## Consequences

- Compaction needs no extra disk space proportional to file size — it
  operates entirely within the current file's existing footprint, which
  matters for the embedded, often storage-constrained targets (desktop
  apps, Electron apps, CLI tools).
- Crash safety is a corollary of the monotonic-gap invariant rather than a
  separately implemented recovery path. This mirrors the project's general
  preference (see [ADR 0001](0001-append-only-storage.md),
  [ADR 0003](0003-replay-based-startup.md)) for correctness that falls out
  of a simple invariant over correctness bolted on with explicit recovery
  code.
- Compaction is entirely unsafe to run while cursors are open: cursors hold
  `{id, offset}` snapshots (see
  [ADR 0004](0004-cursor-snapshot-semantics.md)), and compaction moves live
  records to new offsets without any mechanism to notify or remap open
  cursors. This is documented as a caller responsibility, not enforced at
  runtime, in V1 — a known sharp edge tracked for V2 (cursor-aware
  scheduling that blocks or defers compaction).
- Compaction is synchronous and blocking — it holds the file exclusively for
  the whole pass, with no incremental/background variant in V1. For very
  large files this means a compaction call is a visible latency spike, a
  tradeoff accepted in favor of the invariant's simplicity (a background or
  incremental compactor would need to interleave with live writes, breaking
  the clean single-pass proof above).
- Because the single-process file lock (see
  [ADR 0010](0010-single-process-file-lock.md)) already prevents a second
  process from writing concurrently, and all operations within one process
  are synchronous, compaction cannot race with another write at all — the
  only remaining risk is the active-cursors limitation, not cross-process or
  cross-write concurrency.

## Alternatives Considered

- **Write to a temporary file, then rename over the original** — rejected
  for the primary compaction path: doubles peak disk usage and adds a
  rename step whose atomicity depends on the filesystem, for no correctness
  benefit once the in-place invariant is established. (Note: this pattern
  *is* used elsewhere in the codebase for header/format changes that can't
  be done in-place — the in-place forward pass is specifically the
  steady-state compaction strategy.)
- **Compact incrementally in the background** (e.g. a small amount of work
  per write) — deferred to V2: would remove the blocking-pass latency spike
  but requires interleaving compaction state with live writes and cursor
  lifetimes, a substantially more complex design than a stop-the-world pass
  with a proven invariant.
- **Mark-and-sweep with a separate free-list** rather than a single forward
  pass — rejected: would require persisting or rebuilding free-space
  metadata, adding a structure this project's every-other-design-decision
  deliberately avoids (see [ADR 0001](0001-append-only-storage.md)'s
  rejection of in-place binary updates with a free-space allocator, for the
  same underlying reasoning).
