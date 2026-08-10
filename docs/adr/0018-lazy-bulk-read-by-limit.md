# ADR 0018: The Bulk-Range Read Is Deferred Until `limit` Is Known, With a Bounded Per-Record Fallback

## Status

Accepted (V1).

## Context

[ADR 0016](0016-bounded-candidate-range-read.md) bounded `find()`'s bulk-range
read to the candidate set's own byte span instead of the whole file — but the
read was still computed *eagerly*, inside `Collection.find()`, before the
returned `Cursor` had been told anything about `limit()`. `findOne()` is
implemented as `find(query).limit(1).next()`: `limit(1)` is applied to the
cursor *after* `find()` has already returned it, so at the point `find()`
decided whether to bulk-read, it had no way to know only one document would
ever be consumed.

On the real, multi-hundred-thousand-document datasets used for
`benchmarks/large-scale.ts`, this showed up as a ~200–500ms floor on
"found-first" `findOne()`-style lookups against unindexed, high-match-rate
fields (e.g. `{ sex: "M" }` matching roughly half of a 500K-document
collection) — the bulk read was sized to the *entire* candidate set (every
document with a primary-index entry, since there's no secondary index to
narrow it), even though the very first candidate read would already satisfy
the limit. Verified directly against `/tmp/bench/genealogy.pdb`
(`individuals`, 289,678 docs): `findOne({ sex: "M" })` cost ~340ms before this
change and ~1ms after.

## Decision

The bulk-range decision moves out of `Collection.find()` and into
`PocketCursor`, made lazily on the first candidate read rather than eagerly
at `find()` time — by then, if the caller chained `.limit()` before consuming
(the standard fluent pattern, and the only order that makes sense — you
can't consume a cursor and then retroactively limit what was already
returned), `limitCount` is already settled.

`PocketCursor.resolveBulkRange(forceFullRead)` replaces the constructor-injected
`bulkRange` parameter:

- **Below `SCAN_PRELOAD_THRESHOLD` (2) candidates:** never worth bulk-reading,
  decided once, permanently — unchanged from ADR 0016.
- **No `limit` set, or `forceFullRead` is `true`:** bulk-read the whole
  candidate span immediately, same as the old eager behavior, just deferred
  to the first actual read instead of computed unconditionally at `find()`
  time. Decided once, permanently, and reused for the rest of the cursor's
  life. `count()` and the sorted path (`collectAllMatching`) always pass
  `forceFullRead: true` — both are structurally required to read every
  candidate regardless of `limit` (`count()` ignores `limit` outright; a sort
  without a pre-sorted index has to see every matching document before it can
  return the first one), so there is nothing to gain by deferring there.
- **A `limit` is set and this isn't a forced read (the unsorted `next()`
  path):** defer. Returns `null` for *this* call without caching the
  decision, so `readCandidateDocument` falls back to per-record
  `readOperationAtOffset` reads — the common `findOne()`/`find().limit(N)`
  case never touches, or pays for, the rest of the candidate span at all.

**Escalation cap.** A pure "defer while there's a limit" rule has a bad
worst case: a `limit(1)` query whose one match sits near the end of a huge
candidate set (or doesn't exist at all) would fall back to reading every
candidate one at a time — up to the whole collection, individually, instead
of the one bulk read the old eager behavior would have done. `next()` counts
per-record reads made while the decision is still deferred
(`perRecordReadsSinceDeferred`) and forces the bulk-range decision
(`resolveBulkRange(true)`) once that count reaches
`MAX_PER_RECORD_READS_BEFORE_BULK_ESCALATION` (256) without the limit being
satisfied. This bounds the worst case to a fixed, small number of wasted
small reads before falling back to the same one-bulk-read behavior as before
this change, rather than an unbounded, collection-size-scaling one.

## Consequences

- **`findOne()` / `find(query).limit(N)` on a large, unindexed,
  high-match-rate query no longer pays for a bulk read sized to the whole
  candidate set.** Measured on `/tmp/bench/genealogy.pdb`'s `individuals`
  collection (289,678 docs, `sex` unindexed, ~50% match rate):
  `findOne({ sex: "M" })` dropped from ~340ms to ~1ms — roughly 300×.
- **No regression for the cases that must read everything anyway.**
  `toArray()`/iteration without a `limit`, `count()` on a non-match-all
  query, and `sort()` all still do exactly one bulk read up front, same as
  before — confirmed unchanged (~5.2s / ~5.3s before and after) on the same
  dataset's full-collection unindexed scan.
- **A rare-match or absent-match query under a small `limit` now costs a
  bounded amount more than before** — up to
  `MAX_PER_RECORD_READS_BEFORE_BULK_ESCALATION` small reads before falling
  back to the bulk read it would have done immediately under the old eager
  behavior. This is a deliberate, bounded trade against the common case: a
  `findOne()` that finds nothing (or finds its match very late) pays a small,
  fixed overhead in exchange for every high-match/early-match `findOne()`
  — the overwhelmingly more common shape of that query — paying almost
  nothing. Confirmed on the same dataset: `findOne()` against a value that
  matches nothing still completes in ~5s (same order of magnitude as before;
  the collection has to be scanned in full either way to conclude "no
  match").
- **`SCAN_PRELOAD_THRESHOLD` moved from `Collection` to `PocketCursor`.** The
  bulk-vs-per-record decision is now entirely the cursor's responsibility;
  `Collection.find()` no longer references storage reads at all beyond
  constructing the cursor.
- **The `PocketCursor` constructor no longer takes a `bulkRange` parameter.**
  Any code constructing a `PocketCursor` directly (none in this codebase
  outside `Collection.find()` as of this change) needs updating.

## Alternatives Considered

- **Scale the escalation cap with `limitCount`** (e.g.
  `max(256, limitCount * 16)`) instead of a flat constant — not pursued for
  V1: `limit` values in practice cluster heavily around small numbers
  (`findOne()` is `limit(1)`; paginated `find().limit(20)` or similar), and a
  flat cap is simpler to reason about and test. Worth revisiting if a
  workload with large `limit` values and a low match rate turns out to hit
  the cap in a way that under-serves the bulk-read benefit.
- **Read only the remaining (unvisited) candidates' span on escalation**,
  instead of re-deriving the bulk range over the full candidate array — not
  pursued: the already-visited prefix is small relative to the cap (≤256
  candidates' worth of small reads, already paid for), so the marginal cost
  of covering it again inside one bulk read is negligible next to the
  syscall savings the escalation is already capturing. Simpler to reuse
  `resolveBulkRange`'s existing "bulk-read everything" path unconditionally.
- **Give `Collection.find()` a way to see `limit` up front** (e.g. an
  options bag on `find(query, { limit })` instead of the fluent
  `.limit()`) — rejected: would change the public `find()` signature and the
  established fluent cursor API for every caller, to work around a
  self-inflicted ordering problem that deferring the decision into the
  cursor solves without any API change at all.
