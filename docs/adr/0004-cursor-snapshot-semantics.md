# ADR 0004: Cursors Snapshot Their Candidate Set at Creation

## Status

Accepted (V1).

## Context

Pocket DB's primary index only ever tracks the *latest* offset for each
document id (see [ADR 0001](0001-append-only-storage.md)); older versions
become dead records reclaimed by compaction. A `find()` call compiles a
query, asks the index manager for a candidate set, and returns a cursor that
the caller then iterates — possibly across multiple `next()` calls,
`toArray()`, or a `sort()` that reads eagerly.

Between the moment `find()` is called and the moment the caller finishes
consuming the cursor, other code (in the same process) can insert, update,
or delete documents in the same collection. Two broad options exist for what
a cursor should observe when that happens:

1. **Live view** — each `next()` re-consults the current primary index, so
   writes that happen mid-iteration are visible (or documents can vanish or
   move) partway through a scan.
2. **Snapshot view** — the cursor fixes its candidate set once, at creation
   time, and iterates exactly that set regardless of what happens to the
   collection afterward.

A live view is more surprising under concurrent (same-process, interleaved)
writes: a caller iterating a cursor while also writing can observe a
document twice (if it moved to a not-yet-visited candidate), miss it
entirely, or read a version that didn't exist when the scan started. It also
interacts badly with compaction, which reclaims dead offsets — a live cursor
holding a stale offset into a since-compacted file would need mid-iteration
invalidation logic.

## Decision

`find(query)` captures a snapshot of `{ id, offset }` candidate pairs
immediately, at the moment it is called — not lazily on first `next()`.
Subsequent writes to the collection do not affect any cursor that has
already been created; each `next()` call reads the document at *its stored*
offset, not the current one, and evaluates the residual query against that
read.

This snapshot invariant is load-bearing for other components, not just
`find()` itself:

- **Compaction** must not run while cursors are open, because compaction
  moves live records to new offsets — a cursor's snapshot offsets would
  point at relocated or truncated data. This is currently the caller's
  responsibility (see [compact.md](../compact.md) and the timing note in
  `storage.md`); cursor-tracking to make this safe automatically is a V2
  item.
- **The document cache** (`src/api/document-cache.ts`) is explicitly
  *versioned by offset*, not just keyed by id, specifically to preserve
  this invariant: `cache.get(id, offset)` only returns a hit when the
  cached entry's offset matches the offset the cursor snapshotted. A cursor
  reading from an older snapshot misses a newer cache entry (written by a
  later update) and correctly falls back to reading its own version from
  disk, rather than the cache silently returning the wrong version.
- Tests explicitly verify this invariant (e.g. replacing a document
  mid-cursor still yields the old version to an already-open cursor, with
  and without the cache enabled).

## Consequences

- Iteration is fully repeatable and immune to torn reads from concurrent
  same-process writes — a cursor always reflects the state of the world at
  the moment `find()` was called.
- Callers get MongoDB-cursor-like intuitions for free: opening a cursor and
  then mutating the collection is safe and well-defined, rather than
  undefined behavior.
- The cost is that a long-lived cursor can serve increasingly stale data if
  the caller holds it open across many writes — there is no way to "refresh"
  a cursor; a new `find()` is required to see later writes.
- Compaction cannot safely run concurrently with any open cursor. This is
  currently an unenforced caller contract (not a runtime check), which is a
  known sharp edge tracked for V2 (automatic cursor-aware compaction
  scheduling).
- Every layer that adds caching or indirection on top of the read path
  (notably the document cache) has to be designed around this invariant
  rather than around a simpler "latest wins" model, which adds the
  offset-versioning complexity described above.

## Alternatives Considered

- **Live view with index re-consultation per `next()`** — rejected: makes
  concurrent-write behavior unpredictable (duplicate/missed documents) and
  would require compaction to actively invalidate or remap in-flight
  cursors, which is significantly more complex than "don't compact while
  cursors are open."
- **Snapshot full documents instead of offsets** — rejected: would mean
  `find()` eagerly reads and decodes every candidate document up front,
  defeating the lazy, pay-only-for-what-you-consume design of `next()`/
  `limit()` and duplicating memory for candidate sets that are never fully
  iterated.
