# Hot-Document Cache

Pocket DB resolves a read by looking up a document's file offset in the primary
index and then decoding the record at that offset. The disk read is usually
served from the operating system's page cache, so for documents that are read
repeatedly the dominant, *repeatable* cost is decoding the payload (and, for
single-document lookups, the read syscalls). The hot-document cache keeps parsed
documents in memory so that repeated reads skip both the read and the decode,
trading memory for read latency.

The cache is **disabled by default**. When it is off, no cache object is even
instantiated and the read and write paths pay only a single `null` check, so
collections that do not opt in are unaffected.

## Enabling the cache

```ts
const users = db.collection("users");

users.enableCache(16 * 1024 * 1024); // 16 MB budget
// ... reads of frequently accessed documents are now served from memory ...

users.cacheStats();  // { enabled, maxBytes, bytes, documentCount, hits, misses, evictions }
users.disableCache(); // frees all entries, back to the zero-overhead default
```

`enableCache(maxBytes)` activates the cache (or resizes it if already active).
The budget is an approximate byte ceiling for resident documents; once it is
exceeded the least-recently-used documents are evicted. `disableCache()` drops
the cache entirely. `cacheStats()` returns a snapshot of effectiveness and
memory pressure, or `null` when caching is disabled.

The cache is purely in-memory and is never persisted. Like the secondary
indexes, it starts empty on every `open()` and warms with traffic.

## What is cached, and how it is keyed

Each entry is a parsed document keyed by its 24-character hex `_id`, tagged with
the file offset the version was read from, and annotated with an estimated byte
size.

```text
_id (hex)  →  { document, offset, bytes }
```

Two design choices follow from how the storage engine works.

### Keying by id, not offset

A `put1` record is immutable once written: the bytes at a given offset never
change. An offset-keyed cache would therefore never need invalidation — but it
would lose its entry on every update (the document moves to a new offset) and on
every compaction (all offsets are rewritten). Keying by `_id` instead keeps a
document hot across updates and across compaction.

The cost of id-keying is explicit invalidation on the write path, which is cheap
because every write funnels through a small number of methods in
`PocketCollection` (see [Integration points](#integration-points)).

### Versioning by offset

Because Pocket DB guarantees that **cursors snapshot at creation** — `find()`
captures each candidate's `{ id, offset }` and later writes must not become
visible to an already-open cursor — an id-keyed cache cannot blindly return its
latest entry. The latest entry may be a *newer* version than the one the cursor
snapshotted.

The offset stored alongside each entry solves this. It acts as a version tag:

```text
get(id, offset):
  entry = map.get(id)
  if entry is missing OR entry.offset ≠ offset:   → miss
  else:                                            → hit (return a clone)
```

A cursor that snapshotted an older offset will *miss* a newer cached entry and
fall back to reading its own version from disk — exactly preserving the
snapshot invariant. In steady state (no concurrent write between `find()` and
the read) the offsets match and the lookup hits. After an update, the write path
refreshes the entry with the new offset, so subsequent reads at the new offset
hit again.

## Ownership and cloning

The cache **owns** every document it stores and never hands out a reference to
it:

- `set(id, offset, document)` takes ownership *by reference*. The caller must
  not mutate the document afterwards. The write path satisfies this — it builds
  a fresh document per `put1` record and never exposes it directly — and the
  read path hands over a freshly decoded object.
- `get(id, offset)` returns a deep clone (`structuredClone`). Callers may freely
  mutate query results without corrupting cached state.

This preserves the existing contract that `find()` / `findOne()` return
independent, caller-owned objects. The clone on read is the cache's main runtime
cost, and the benchmarks below show it is comfortably outweighed by skipping the
read and decode.

## Eviction

LRU ordering is maintained using a `Map`'s insertion order: both `get` (on a
hit) and `set` re-insert the touched key so it becomes the most-recently-used,
which makes the first key in iteration order the least-recently-used. When
inserting a document would push the total past `maxBytes`, the oldest entries
are evicted one by one until it fits.

A document larger than the entire budget is intentionally **not** cached, rather
than evicting everything else to hold a single oversized entry.

Byte sizes are estimated by `estimateDocumentBytes`, which uses the UTF-16
length of the JSON serialization (`JSON.stringify(doc).length * 2`) as a cheap,
deterministic proxy. It ignores per-object engine overhead and is intended for
*relative* budgeting, not exact memory accounting. A custom estimator can be
injected when constructing the cache directly.

## Integration points

The cache is wired into `PocketCollection` at the points where reads and writes
already converge, so there is a single place to keep it correct:

| Path | Hook | Effect |
|------|------|--------|
| `find()` | passes the cache to `PocketCursor` | reads consult the cache |
| `applyPutDocument` (insert / replace / update) | `cache.set(id, offset, doc)` | primes/refreshes the hot entry for free — the document is already in memory at write time |
| `deletePrimaryIndexEntry` (delete) | `cache.invalidate(id)` | removes the stale entry |
| `dropFromReplay` (drop collection) | `cache.clear()` | frees everything |
| `compact()` | *(nothing)* | ids and contents are unchanged; entries stay valid |

Inside the cursor, `readCandidateDocument` consults the cache first. On a hit
(matching offset) it returns the clone from `get`. On a miss it reads the record
(from the bulk buffer or a single record read), decodes it, hands the decoded
object to the cache by reference, and returns a clone to the caller.

When the collection has no cache, the cursor receives `null` and takes the
original read-and-decode path with no added work.

## Compaction interaction

`compact()` rewrites the file and changes every document's offset, but it does
not change any `_id` or any document's contents. Because cache entries are keyed
by id and only *validated* by offset, the cached documents remain logically
correct after compaction. The primary index is updated to the new offsets during
compaction; the next read at a new offset that does not match a cached entry's
old offset simply misses and re-populates. No explicit cache action is required.

## Benchmarks

Measured on 2,000 documents, JSON serialization, relaxed durability. Values are
operations per second; higher is better.

| operation | no-cache | cache | speedup |
|-----------|---------:|------:|--------:|
| `findById` (uniform over all ids) | 196,170 | 575,116 | **2.93×** |
| `findByIdHot` (16-document working set) | 248,700 | 587,915 | **2.36×** |
| `findAll` (full scan) | 313 | 574 | **1.83×** |
| `findByName` (unindexed scan) | 307 | 548 | **1.79×** |

Single-document reads roughly triple. Even full scans gain ~1.8×: avoiding the
per-document file read and JSON parse beats a `structuredClone` of an
already-parsed object.

In this run the budget held the entire dataset, so there was zero eviction. The
`pocket-db (relaxed-json-cache)` adapter and the `findByIdHot (16)` case in the
benchmark suite reproduce these comparisons (`npm run bench`).

## Drawbacks and limitations

- **Memory.** The cache is a deliberate memory-for-latency trade. Size the
  budget for your hot working set, not your whole dataset, unless you intend a
  fully resident collection.
- **Scan pollution.** Large scans currently populate the cache as they read. If
  the budget is smaller than a scan's footprint, a one-off scan can evict
  genuinely hot single-lookup documents (classic LRU scan pollution), and the
  scan speedup shrinks or reverses. Hot single-document reads are unaffected as
  long as the hot set fits.
- **Clone cost on read.** Every cached read returns a deep clone. This is what
  makes the speedup smaller for very large documents; it is never worse than the
  uncached path in the benchmarks above, but the margin narrows with document
  size.
- **Bulk-read path is not yet cache-aware.** When a query has two or more
  candidates the cursor still performs one contiguous bulk read of the candidate
  range even if some of those documents are already cached. A future change can
  restrict the bulk read to the range of *missing* candidates.
- **Lazy only.** The cache fills on read (and on write). It is not an eager,
  fully-resident mode — a budget larger than the collection does not pre-load
  documents at open; they are cached as they are first touched.

## Related

- [Storage semantics](storage.md) — the append-only write path and replay.
- [Indexes](indexes.md) — the primary index that maps `_id` to a file offset.
- [Compaction](compact.md) — how offsets are rewritten and indexes refreshed.
