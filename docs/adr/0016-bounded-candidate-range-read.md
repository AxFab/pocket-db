# ADR 0016: Multi-Candidate Reads Are Bounded to the Candidate Range, Not the Whole File

## Status

Accepted (V1).

## Context

Benchmarking pocket-db against two real, multi-hundred-thousand-document
datasets (see `benchmarks/large-scale.ts`) surfaced that `Collection.find()`'s
bulk-read optimization — documented in `storage.md` and referenced by
[ADR 0008](0008-optional-document-cache.md) as reading "the candidate byte
range" — did not actually do that. `FileStorage.readBulk()` read
`currentOffset - FILE_HEADER_BYTES` bytes: the entire operation log, every
time `find()`'s candidate count reached `SCAN_PRELOAD_THRESHOLD` (`2`), no
matter how few candidates there were or where in the file they lived. A
two-candidate lookup on a 1GB file triggered a ~1GB read and a ~1GB
allocation. This was a drift between documented intent and implementation,
not a deliberate design choice — nothing in `storage.md` or ADR 0008 called
for reading anything beyond the candidates' own span.

The same one-record-at-a-time pattern this optimization was meant to replace
also still existed, unoptimized, in two other places that read every document
in a collection: `rebuildIndex()` (called by `createIndex()` on an
already-populated collection, and by replaying an `idx1` record for a
collection whose documents were all inserted before it in the log — the
`O(documents × indexes)` cost [ADR 0003](0003-replay-based-startup.md)
documents) and `refreshIndexesAfterCompaction()` (called once per collection
after every `compact()`). Both called `readOperationAtOffset` — three
`readSync` calls — once per existing document. On the larger benchmark
dataset (~1.5M live documents across 5 collections, each with one index),
this measured at ~18.8s combined just for the five `createIndex()` calls a
`compact()` or a mid-log `idx1` replay would each pay once.

## Decision

**`FileStorage.readBulkRange(offsets)`** replaces `readBulk()`. Given the set
of offsets a caller needs, it reads the minimum contiguous span that covers
all of them: from the lowest offset to the end of the record at the highest.
The record at the highest offset isn't known to end anywhere in particular
until its length is read, so this costs one small header read (8 bytes)
before the main range read — negligible next to what it saves skipping. The
result is `{ buffer, rangeStart }`; callers index into `buffer` as
`offset - rangeStart`, not `offset - FILE_HEADER_BYTES` (the implicit
contract `readBulk()`'s whole-file buffer had).

Three call sites adopt this:

- `Collection.find()`, when `plan.candidates.length >= SCAN_PRELOAD_THRESHOLD`,
  same as before — just bounded now.
- `rebuildIndex()`, reading every offset in `primaryIndex.snapshot()` in one
  range read instead of one `readOperationAtOffset` call per document.
- `refreshIndexesAfterCompaction()`, same change, same reasoning — this is
  precisely the maintenance operation someone reaches for on a large
  database, so its own cost scaling matters as much as the thing it's
  cleaning up after.

**`PocketCursor` takes a `BulkRange | null`** (`{ buffer, rangeStart }`)
instead of a bare `Buffer | null`, and reads candidates as
`readOperationFromBuffer(bulkRange.buffer, candidate.offset - bulkRange.rangeStart)`.

**A related fix in the same investigation: `Cursor.skip()`'s match-all fast
path.** `next()` read and decoded every skipped candidate one at a time even
when the residual query was match-all — where every candidate counts toward
`skip` unconditionally, so which ones get skipped never depends on their
content, the same reasoning `count()`'s existing match-all fast path already
relies on (`count()` returns `candidates.length` with zero reads for the same
case). `applyMatchAllSkipFastPath()` now jumps `currentIndex` straight to
`skipCount` before the first candidate is read, whenever the query is
match-all — turning a large `skip()` from O(skipCount) reads into O(1). A
non-match-all query still can't take this shortcut: `skip` counts *matching*
documents, so whether a given candidate counts toward it depends on
evaluating the query against it first.

## Consequences

- **`find()` never reads more than the candidates it was asked to serve
  actually span**, down from always reading the entire file past the
  threshold. This is a strict improvement — never worse than before, often
  far better — but the size of the improvement is data-dependent: on a
  collection whose live documents are scattered across most of the file
  (heavy interleaved writes across collections, heavy update churn pushing
  old records to dead space and live copies to new, scattered offsets), the
  lowest-to-highest span can still approach the whole file. Benchmarking
  confirmed both ends of this: a few-hundred-KB collection's full scan
  dropped in lockstep with peak process memory, while a collection with ~25%
  of the file as dead space from updates saw a much smaller improvement on
  its own full-scan case, because its own live offsets are simply spread
  that widely. The bound is on what gets read, not a promise about how
  clustered any given collection's data happens to be.
- **Index rebuild cost is now dominated by decode, not syscalls.** Measured
  directly on the larger benchmark dataset: five indexes over ~1.5M total
  documents, mostly ~5–20µs/document with `readBulkRange`, versus an
  implementation that needed 3 syscalls per document beforehand. The
  `O(documents × indexes)` complexity ADR 0003 documents as a startup cost is
  unchanged in shape — this reduces the constant factor, not the asymptotic
  behavior — but the constant factor was large enough to be the dominant
  contributor to a large multi-index database's `open()` time.
- **`skip()` on a match-all query is now O(1) in the number of skipped
  candidates**, not O(skipCount). A `find({}).skip(500000).limit(10)` no
  longer reads and discards 500,000 documents to get there.
- **`readBulk()` is removed.** Its only callers were the three sites above,
  and all three had a real bounded-offset-set available at the call site —
  nothing in the codebase actually needed "the whole file" as such.
- **`BulkRange`'s `rangeStart` is not `FILE_HEADER_BYTES`.** Any future code
  reading from a `bulkBuffer`-shaped value must use the range's own start,
  not the file header constant — the previous implicit "starts at
  `FILE_HEADER_BYTES`" contract no longer holds.

## Alternatives Considered

- **Keep `readBulk()` for `find()`, only fix `rebuildIndex()`/
  `refreshIndexesAfterCompaction()`** — rejected: `find()`'s version of the
  same problem was the larger one in practice (`SCAN_PRELOAD_THRESHOLD` of
  `2` means almost any multi-document query hits it), and fixing one call
  site but not the structurally identical other three would leave the
  "whole file" bug in the highest-traffic path.
- **Track exact candidate spans and skip past known-dead gaps within the
  range** — not pursued: `shouldKeepOperation`-style liveness reasoning
  during a query would mean re-deriving what `compact()` already computes
  separately, for a benefit that only matters on datasets with the kind of
  heavy update-driven fragmentation this ADR's Consequences section already
  flags as the case where range-bounding helps least. Left as a possible
  future refinement, not built into V1.
- **Give `skip()` a general fast path via a residual-independent
  "count-only" pre-pass** — rejected: the match-all case already covers the
  common pagination pattern (`find({}).skip(...).limit(...)`) with no
  extra machinery; a general pre-pass would still need to read every
  candidate for a filtering query, which is inherent to "skip counts
  matches," not a gap this ADR's mechanism can close.
