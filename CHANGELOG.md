# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.5] — 2026-08-15

### Fixed

- **Reading pre-0.1.4 databases with indexes crashed on open** — 0.1.4 added a "unique"
  byte to the `idx1` (create index) log record, inserted right after the type byte. Files
  written before 0.1.4 don't have that byte, so `decodeCreateIndexPayload` misread the first
  byte of the field-name length as the unique flag and threw `Invalid create index
  operation: unique flag must be 0 or 1.` on `open()` for any database that had a
  secondary index created before the 0.1.4 upgrade. The decoder now tries the current
  (post-0.1.4) layout first and falls back to the legacy layout — defaulting
  `unique: false`, matching the documented default — when the current layout doesn't
  validate. Existing `.pdb` files with indexes created on 0.1.0–0.1.3 now open normally
  again; no migration or `compact()` is required.
- **`open()` could be OOM-killed on large databases** — replay of the operation log read
  the entire file into a single in-memory `Buffer` before processing any record; a ~1.9GB
  `.pdb` file OOM-killed `open()` on a 3.8GB-RAM machine, and `stats()`/`compact()` shared
  the same code path. Replay now streams the log through a bounded sliding window
  (`FileStorage.readOperations()`, 8MiB default, `DEFAULT_REPLAY_CHUNK_BYTES`), so peak
  memory during `open()`/`stats()`/`compact()` is a small multiple of the window size
  instead of the file size. See [ADR 0017](docs/adr/0017-streaming-replay-buffer.md).
- **Multi-candidate reads pre-loaded the whole file** — any `find()` returning ≥ 2
  candidates, and rebuilding a secondary index on an already-populated collection
  (`createIndex()`, or replaying an `idx1` record for a collection that already had
  documents), read the *entire* database file into memory regardless of how few
  documents were actually needed. Reads are now bounded to the minimum contiguous byte
  range that covers the candidates involved (`FileStorage.readBulkRange`), so a query or
  index rebuild against a large database only pays for the span its candidates occupy.
  See [ADR 0016](docs/adr/0016-bounded-candidate-range-read.md).
- **`skip()` read and decoded every skipped document one at a time** — on a match-all
  query, `skip(N)` used to read and discard `N` documents individually before yielding
  the first result. It now jumps `currentIndex` straight past them with zero reads when
  the residual query is match-all; a non-match-all query still evaluates each candidate,
  since `skip` counts *matching* documents.
- **`findOne()`/`find().limit(N)` paid for a full bulk read meant for the whole candidate
  set** — the multi-candidate fix above made `find()` eagerly bulk-read the entire
  candidate span before returning the cursor, so a `findOne()` (`find(query).limit(1)`)
  on a large, unindexed, high-match-rate query paid that same full-span cost just to
  return one document. The bulk-range decision is now made lazily, on the first candidate
  read, and deferred behind an active `limit`: below 2 candidates it's skipped entirely
  (as before); with no `limit` set the whole span is still read up front; with a `limit`
  set, candidates are read one at a time instead, escalating to a single bulk read only
  if 256 per-record reads (`MAX_PER_RECORD_READS_BEFORE_BULK_ESCALATION`) go by without
  satisfying the limit. `count()` and the sorted path always force the full bulk read
  regardless of `limit`, since both need every candidate anyway. See
  [ADR 0018](docs/adr/0018-lazy-bulk-read-by-limit.md).

### Tooling

- **Large-scale benchmark utility** (`benchmarks/large-scale.ts`, `npm run bench:large`)
  — measures pocket-db alone against real, multi-hundred-megabyte to multi-gigabyte
  `.pdb` files: replay time at `open()`, index rebuild cost, `stats()` scan time, and
  worst-case unindexed lookups. Read-only by default (mutates only the `.lock` file);
  `--rebuild-indexes` opts into additionally measuring index rebuild cost by dropping and
  recreating every existing index against a copy. Building it is what surfaced the two
  large-database memory issues fixed above.
- **`npm run bench -- --runs=N`** — re-runs the full benchmark suite (setup → every case →
  teardown, per adapter) `N` times and reports the median ops/sec per case, with the
  min/max spread shown alongside it, so a single GC pause or OS scheduling blip no longer
  skews the reported number the way a `--runs=1` sample can. Defaults to `1` (previous
  single-sample behaviour) when omitted.

### Documentation

- Added [docs/adr/](docs/adr/README.md), a set of Architecture Decision Records:
  - 13 retroactive records (0001–0013), Accepted, documenting existing decisions:
    append-only storage, the binary file format, replay-based startup, cursor snapshot
    semantics, the transaction envelope, secondary-indexing strategy, unique-constraint
    checks, the optional document cache, in-place compaction, the single-process file
    lock, the ESM/CJS build, synchronous writes, and the ObjectId format.
  - 3 new records (0016–0018), Accepted, for the read-path fixes above: bounded
    candidate-range reads, the streaming replay buffer, and the lazy/adaptive bulk-range
    read keyed on `limit`.
  - 2 new records (0014–0015), Proposed and **not yet implemented**: cloning the live
    data set to a new file for backups, and lock-free readonly sessions coexisting with a
    single writer via a sidecar generation counter.
- `CLAUDE.md` and [docs/storage.md](docs/storage.md) updated to describe the bounded-range
  read and streaming-replay behaviour.

---

## [0.1.4] — 2026-07-07

### Added

- **Unique indexes** — `createIndex(field, { type, unique: true })` (default `unique: false`)
  turns a secondary index into a uniqueness constraint. Enforced on `insertOne`,
  `insertMany`, `replaceOne`, `updateOne`, and `updateMany`, checked *before* the operation
  is appended to the log (writes are append-only and cannot be rolled back). Sibling
  documents within the same `insertMany`/`updateMany` batch are checked against each other
  as well as against the collection. In-place writes may keep their own existing value.
  Only values matching the index's own type participate — a missing field or a
  differently-typed value never conflicts. Creating a `unique` index over a collection
  that already contains duplicates detects the conflict, leaves nothing persisted, and
  throws. The constraint is itself persisted in the `idx1` log record and survives reopen
  and `compact()`. `IndexInfo` and `CreateIndexResult` now report `unique: boolean`. See
  [docs/indexes.md](docs/indexes.md).
- **`Collection.distinct(field, query?, options?)`** — returns the distinct values held by
  `field` across documents matching `query` (default: all documents). Values are compared
  by deep equality (the same rule `$eq`/`$in` use: strict equality for primitives,
  JSON-structural equality for arrays/objects), so distinct array/object contents are
  preserved rather than collapsed into a single bucket. Documents missing `field` don't
  contribute a value. Internally reuses `find(query)`, so an index on `field` (or on the
  query) narrows candidates as usual. Throws once the result would exceed
  `options.limit` (default `100`) — reading stops as soon as the limit would be exceeded,
  rather than scanning the whole collection first. New `DistinctOptions` type exported from
  the package root. See [docs/query.md](docs/query.md#distinct-values).

### Fixed

- **Lock leak on failed `open()`** — if `FileStorage.open()` threw after the `.lock` file
  was acquired (e.g. an unreadable or corrupt database file), the lock was never released,
  permanently blocking future opens of that file until the `.lock` was removed by hand.
  `open()` now releases the lock on any error during initialization before rethrowing.
- **Stale-lock acquisition could recurse without bound** — `FileLock` retried acquisition
  by recursive call after clearing a stale lock; a lock file that kept reappearing (or
  couldn't be removed) could recurse indefinitely. Acquisition is now a bounded loop (3
  attempts) that raises a clear error instead of overflowing the stack.

### Tooling

- Repository cleanup: tightened `.gitignore`/`.npmignore`, dependency and lint config
  updates, `benchmarks/package.json` housekeeping.
- Benchmark suite extended with a `distinctByRole` case (3-value `role` field) and
  `Adapter.distinctRole()` implemented across all five adapters — pocket-db's `distinct()`,
  SQLite `SELECT DISTINCT` (index scan via `idx_role`), and a linear scan-and-dedupe for
  lowdb, LokiJS, and the JSON-file adapter.

### Documentation

- Corrected `CLAUDE.md`'s development-status notes: `durability: "strict" | "relaxed"` is
  implemented (moved out of the "planned" list into "V1 complete"), and clarified that
  `$or`/`$nor` query evaluation is already fully supported — only *index-assisted planning*
  for disjunctive queries remains a full-scan fallback and is still planned for V2.
- Fixed stale claims in `docs/storage.md` and `docs/compact.md` that file locking and the
  `durability` option were not implemented — both have shipped since `0.1.1`/`0.1.2`.
  `docs/storage.md` now also documents the BSON/AMF3 serialization formats (previously
  described as JSON-only).
- `docs/query.md` was missing `$ne`, `$gte`, `$lte`, `$nin`, `$not`, `$or`, and `$nor`
  entirely, and its `CompiledQuery` type omitted `OrPredicate`/`NorPredicate`. All seven
  operators are now documented, and the type definition matches `src/search/types.ts`.

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
- Benchmark output reworked to stay readable as adapters and operations grow: the console
  now prints a width-aware, per-operation ranked view, and `npm run bench` writes the full
  matrix to `benchmarks/RESULTS.md` and `benchmarks/results.json`.

### Tooling

- Added an ESLint setup (flat config, `typescript-eslint`) with `npm run lint` /
  `npm run lint:fix`; `lint` now runs as part of `prepublishOnly`.

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
