# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.3] — 2026-06-16

### Added

- **Hot-document cache** (opt-in, off by default) — a per-collection, byte-bounded LRU of
  parsed "hot" documents. Enable with `Collection.enableCache(maxBytes)`, inspect with
  `Collection.cacheStats()`, and turn off with `Collection.disableCache()`. It is keyed by
  `_id` and versioned by file offset, so it stays correct across updates, deletes,
  compaction, and open cursors (the cursor-snapshot invariant is preserved), and it returns
  deep-cloned, caller-owned documents. Repeated single-document reads are ~2.9× faster and
  full scans ~1.8× faster on the JSON benchmark; when disabled no cache object is allocated,
  so the read/write paths pay only a single `null` check. New `DocumentCacheStats` type
  exported from the package root. See [docs/cache.md](docs/cache.md).
- **`Database.stats()` and `Collection.stats()`** — usage statistics: size on disk,
  document / collection / index counts, total operation and tombstone counts, and live /
  dead byte totals (the space `compact()` would reclaim). New `DatabaseStats`,
  `CollectionStats`, and `StorageStatsCore` types exported.
- **Query operators `$type` and `$regex`** — `$type` matches a field by its JSON type
  (single name or array of names); `$regex` (with `$options`, a `RegExp` value, or a bare
  `RegExp` shorthand) matches string values, rejecting the stateful `g` and `y` flags.
- **Update operators `$mul`, `$rename`, `$currentDate`, `$addToSet`, `$pop`, `$pull`,
  `$pullAll`** — joining the existing `$set` / `$unset` / `$inc` / `$min` / `$max` / `$push`.

### Changed

- Benchmark suite extended with a cache-vs-no-cache `pocket-db (relaxed-json-cache)` adapter
  and a `findByIdHot (16)` hot-working-set case.

### Documentation

- New [docs/cache.md](docs/cache.md) article covering the cache internals (id keying, offset
  versioning, eviction, ownership/cloning, benchmarks, and limitations).
- Documented the **safe-reads** guarantee in the README: every query result is an
  independent, caller-owned copy, so mutating it never corrupts stored data — including
  reads served from the cache.

> Note: the new query and update operators above were merged after the `v0.1.2` tag, so they
> are recorded here in `0.1.3` rather than retroactively under `0.1.2`.

---

## [0.1.2] — 2026-06-08

### Fixed

- **Critical CJS import fix** — CommonJS consumers (`require('@axfab/pocket-db')`) were
  broken due to a missing `tsconfig.cjs.json` and incorrect package exports wiring. This
  release adds a proper CJS build pipeline and verifies both ESM and CJS entry points.

### Added

- **`durability` option** in `OpenOptions` — controls `fsync` behaviour after every write:
  - `"relaxed"` (default) — skips `fsync`; writes reach the OS page cache. Faster; suitable
    when data loss on a hard crash is acceptable.
  - `"strict"` — calls `fsync` after each `appendOperation`, guaranteeing the kernel has
    flushed data to durable storage before the call returns. One extra syscall per write.
- **`serialization` option** in `OpenOptions` — selects the document encoding format when
  creating a **new** database file. Existing files are unaffected (format is read from the
  file header):
  - `"json"` (default) — documents stored as UTF-8 JSON.
  - `"bson"` — documents stored as BSON (Binary JSON), supporting double, string, document,
    array, boolean, null, int32, int64.
  - `"amf3"` — documents stored as AMF3 (Action Message Format 3), a compact binary format
    supporting undefined, null, boolean, integer, double, string, array, and object.

### Changed

- Binary encoders (BSON, AMF3) now use a single pre-allocated `WriteBuffer` for all
  encoding, eliminating per-field allocations and reducing GC pressure on write-heavy
  workloads.

---

## [0.1.1] — 2026-05-31

Small fixes of the first release. README and a few utilities functions.

- Add alias `pocketDb()` instead of `open()`
- `db.getCollections(): string[]`
- `db.existsCollection(name: string): boolean`
- `col.indexes: readonly SecondaryIndexDefinition[]`
- `col.getIndexes(): { name: string; type: string }[]`
- `col.existsIndex(name: string): boolean`

---

## [0.1.0] — 2026-05-21

First public release. Covers everything needed to use pocket-db as an embedded
document store in a Node.js application.

### Storage engine

- Append-only single-file format with 4-byte operation identifiers, length-prefixed payloads, 4-byte alignment, and CRC32 integrity checks on every record.
- Variable-length U29 integer encoding for compact payload length representation.
- Atomic batch replay: operations wrapped in `txnb`/`txnc` transaction envelopes are applied in full or not at all on crash recovery.
- File locking via a `.lock` file containing the writer PID; stale locks from dead processes are detected and cleared automatically.
- Manual compaction (`db.compact()`) rewrites the file in a single forward pass, discarding dead records and refreshing all in-memory indexes.

### Collections and documents

- Named collections created on first access and persisted to the log.
- JSON documents with auto-generated `_id` (24-character hex, 12-byte ObjectId layout: 4-byte timestamp, 5-byte process-random, 3-byte counter).
- `insertOne`, `insertMany`, `findOne`, `find`, `countDocuments`.
- `updateOne`, `updateMany` with operators: `$set`, `$unset`, `$inc`, `$min`, `$max`, `$push`.
- `replaceOne` (by id or by document with `_id`).
- `deleteOne`, `deleteMany`.
- `insertMany`, `updateMany`, `deleteMany` are crash-safe via transaction envelopes.

### Query operators

`$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$not`, `$and`, `$or`, `$nor`.

### Cursor

- Lazy evaluation: candidates are snapshotted at `find()` time; subsequent writes do not affect open cursors.
- Bulk-read optimisation: when ≥ 2 candidates are selected, all their byte ranges are fetched in a single `readSync` call.
- `sort()` up to 4 fields, ascending or descending. Missing/null/NaN values sort first in ascending, last in descending.
- `skip()` and `limit()`.
- `count()` fast path for match-all queries (no document reads).

### Secondary indexes

- `StringIndex`: equality and `$in` lookups on string fields.
- `NumberIndex`: equality, `$in`, and range (`$gt`, `$gte`, `$lt`, `$lte`) lookups on numeric fields via a maintained sorted array.
- Index definitions are persisted to the log and rebuilt from it on every open.
- Query planner picks the most selective available index per query; disjunctive queries (`$or`, `$nor`) fall back to a full collection scan.

---

## [Unreleased]

See [ROADMAP.md](ROADMAP.md) for planned V2 and V3 features.
