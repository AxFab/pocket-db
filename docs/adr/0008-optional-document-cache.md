# ADR 0008: Hot-Document Cache Is Opt-In and Zero-Cost When Disabled

## Status

Accepted (V1).

## Context

A read resolves a document by looking up its file offset in the primary
index, then reading and decoding the record at that offset. The disk read is
usually served from the OS page cache, so for documents read repeatedly the
dominant, repeatable cost is JSON decode (plus read syscalls for
single-document lookups). Caching parsed documents in memory can turn a
repeated read into a pure memory-and-clone operation.

Two constraints shape how this can be added, given decisions already made:

1. **The cursor-snapshot invariant** ([ADR 0004](0004-cursor-snapshot-semantics.md))
   means a cache keyed only by document id is not safe on its own — the
   latest cached version of a document may be newer than what an
   already-open cursor is supposed to see.
2. Not every Pocket DB collection benefits from caching (some are
   write-heavy, scan-once workloads), and the project's target use cases
   include memory-constrained environments (Electron apps, CLI tools) where
   an always-on cache would be an unwelcome default cost.

## Decision

Make the cache an explicit opt-in per collection, structurally incapable of
costing anything when unused, and designed around the snapshot invariant
rather than around it:

- `PocketCollection` holds `cache: DocumentCache | null = null`. No cache
  object is instantiated until `enableCache(maxBytes)` is called. Every read
  and write path that consults the cache does so through a single `null`
  check — when caching is off, that check is the entire overhead.
- **Keyed by id, versioned by offset.** Entries are stored as `_id (hex) →
  { document, offset, bytes }`. Keying by id (not offset) keeps a document
  hot across updates (which move it to a new offset) and across compaction
  (which rewrites every offset) — an offset-keyed cache would lose its
  entry on both. The offset field then acts as a version tag:
  `get(id, offset)` is a hit only when the stored offset matches the
  offset the *caller* (a cursor holding a snapshot) expects. A cursor
  snapshotted before a later write will miss the refreshed cache entry and
  correctly fall back to reading its own version from disk — this is the
  mechanism that reconciles caching with
  [ADR 0004](0004-cursor-snapshot-semantics.md) instead of violating it.
- **Ownership by reference on write, clone on read.** `set()` takes the
  document by reference (the write path already builds a fresh object per
  `put1`, so no extra copy is needed to hand it to the cache). `get()`
  returns a `structuredClone`, preserving the existing contract that
  `find()`/`findOne()` results are independent, caller-owned objects that
  can be freely mutated without corrupting cache state.
- **LRU eviction via `Map` insertion order**, bounded by an approximate
  byte budget (`estimateDocumentBytes`, a cheap UTF-16-length proxy,
  overridable). A document larger than the whole budget is simply not
  cached, rather than evicting everything else to fit one entry.
- **Single chokepoints, not scattered calls.** The cache is wired in at the
  few places reads and writes already converge in `PocketCollection`:
  `find()` passes it to the cursor, `applyPutDocument` primes/refreshes it
  for free (the document is already in memory at write time), delete
  invalidates the one entry, drop-collection clears everything, and
  compaction needs no explicit action at all (ids and contents are
  unchanged by compaction; only offsets move, and the offset-versioning
  above handles that automatically).
- Purely in-memory, never persisted — empty on every `open()`, exactly like
  secondary indexes ([ADR 0006](0006-secondary-indexing-strategy.md)).

## Consequences

- Collections that never call `enableCache()` are provably unaffected —
  this was treated as a hard requirement, not just a goal, which is why the
  cache is a nullable field checked once per read/write rather than, say,
  a cache with a zero budget (which would still allocate an object and run
  eviction logic on every operation).
- Benchmarked speedups are substantial where the working set fits the
  budget: ~2.9× for uniform-random single-document reads, ~2.4× for a hot
  16-document working set, and ~1.8× even for full scans (avoiding
  read+parse outweighs the clone-on-read cost). See
  [cache.md](../cache.md#benchmarks) for the full table.
- The design explicitly accepts **scan pollution** as a known limitation:
  a large one-off scan populates the cache as it reads, and if the budget
  is smaller than the scan's footprint it can evict genuinely hot
  single-lookup documents. This wasn't solved in V1 because doing so
  (e.g. distinguishing scan-driven inserts from lookup-driven ones) would
  add policy complexity disproportionate to the cache's opt-in, per-
  collection scope.
- The bulk-read optimization (contiguous multi-candidate reads, see
  `storage.md`) and the cache are not yet integrated: a multi-candidate
  query still bulk-reads the *entire* candidate byte range even if some of
  those documents are already cached. This is a deliberate V1 gap, not an
  oversight — narrowing the bulk read to only the missing range is called
  out as a known follow-up.
- The clone-on-read cost means the cache's benefit narrows (though never
  reverses, per the current benchmarks) for very large documents — the
  design accepts this rather than trying to avoid cloning, because avoiding
  it would mean handing out live references and breaking the
  independent-result-object contract the rest of the API relies on.
- Because the cache is lazy-only (fills on read/write, never eager), a
  budget larger than the whole collection does not pre-load anything at
  `open()` — cold-start reads are always uncached until first touched, even
  with a generous budget.

## Alternatives Considered

- **Cache enabled by default, sized automatically** — rejected: would
  impose memory and clone overhead on every collection regardless of
  whether the workload benefits, conflicting with the project's
  lightweight-embedded-use positioning. Explicit opt-in puts the
  size/workload tradeoff in the caller's hands, where it belongs for a
  library with such varied deployment targets.
- **Offset-keyed cache (no id indirection)** — rejected: as noted in
  Context, this would trivially satisfy the snapshot invariant (each
  offset's contents never change) but would lose the entry on every update
  and every compaction — exactly the two events after which a "hot"
  document is most likely to be read again soon.
- **Cache raw encoded bytes instead of parsed documents** — rejected (not
  pursued): would skip the read syscall but not the decode, capturing less
  of the benefit for single-document lookups, which the benchmarks show is
  where the largest win is.
- **Eager/fully-resident mode (pre-load at open when budget allows)** —
  deferred: would remove the cold-start miss for small collections but
  adds an "is the cache warm yet" state the read path would need to check,
  and duplicates work replay already does when index contents are rebuilt
  ([ADR 0003](0003-replay-based-startup.md)). Left as a possible future
  addition rather than built into V1.
