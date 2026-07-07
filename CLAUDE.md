# CLAUDE.md

This file provides guidance to Claude when working with code in this repository.

## Project Synopsis

Pocket DB is an embedded NoSQL document database for Node.js, persisted in a single append-only file. The design is inspired by SQLite (single-file, embedded) and MongoDB (document model, familiar API), but intentionally compact. Target use cases: desktop apps, CLI tools, Electron apps, prototypes, local servers, plugins, structured caches.

The core constraint is **never reserializing the entire database on write**. All writes are append-only records; the in-memory state is rebuilt by replaying the log at open time.

## Commands

```bash
npm install          # install dependencies (typescript, @types/node, eslint, tsx)
npm run build        # compile TypeScript → dist/ (ESM + CJS, see below)
npm test             # run all tests directly from .ts via tsx, no build needed
npm run test:coverage # same, with Node's native coverage instrumentation
npm run bench        # run the benchmark suite (separate "benchmarks" workspace)
npm run lint         # eslint .
```

To run a single test file:
```bash
node --import tsx --test "tests/indexes.test.ts"
```

To run tests matching a name pattern:
```bash
node --import tsx --test --test-name-pattern="creates a string index" "tests/*.test.ts"
```

Benchmarks live in `benchmarks/`, a separate npm workspace (`pocket-db-benchmarks`) so
comparison-only dependencies (better-sqlite3, lokijs, lowdb) never pollute the
published package's own `devDependencies`.

## Architecture Overview

### Layer Diagram

```
src/api/          ← public surface: open(), Database, Collection, Cursor, DocumentCache
src/search/       ← query compilation, evaluation, sort, document update operators
src/indexes/      ← primary index, secondary indexes (string/number), IndexManager
src/storage/      ← file format, binary encoding, CRC32 validation, file lock
src/native/       ← reserved for future C backend (empty, interfaces only)
```

### File Storage (`src/storage/`)

`FileStorage` is the lowest layer. It wraps a synchronous Node.js file descriptor (`node:fs` sync API — `readSync`, `writeSync`). Every write goes through `appendOperation(identifier, payload)`, which:
1. uses the in-memory `currentOffset` counter to get the write offset (initialized from `fstatSync` once at open, then maintained internally),
2. encodes the record as `[4-byte identifier][4-byte payload length][N-byte payload][4-byte CRC32]`,
3. writes it atomically (retry loop), advances `currentOffset` by `record.byteLength`, and returns the offset.

Reading a document later means calling `readOperationAtOffset(offset)` — only the bytes for that one record are read from disk.

**Bulk-read optimization:** when the query planner selects ≥ 2 candidates, the cursor reads all their byte ranges in a single `readSync` call (one contiguous read from the first offset to the last), then slices each document out of the in-memory buffer. Single-candidate reads still use `readOperationAtOffset` directly.

**Binary encoding conventions:**
- All multi-byte integers are big-endian.
- Payloads are zero-padded to 4-byte alignment.
- `U29` (in `u29.ts`) is a variable-length 1–4 byte unsigned 29-bit integer used for string/JSON byte lengths, using the same high-bit continuation scheme as UTF-8.
- CRC32 is computed over `identifier + length_field + payload` (everything before the checksum).

**Operation identifiers** (4 ASCII bytes, defined in `constants.ts`):
| Magic | Meaning |
|-------|---------|
| `ncl1` | New collection |
| `dco1` | Drop collection |
| `idx1` | Create index |
| `dix1` | Drop index |
| `put1` | Put document (insert/replace/update — always a full document) |
| `del1` | Delete document |
| `txnb` | Transaction begin |
| `txnc` | Transaction commit |
| `hol0` | Hole marker (used by compaction to pad dead space; silently skipped on replay) |

### File Lock (`src/storage/file-lock.ts`)

`FileLock.acquire(dbPath)` creates a `.lock` file next to the database using `openSync` with the `wx` (exclusive create) flag. The lock file contains the process PID. On conflict it reads the existing PID and checks if that process is alive via `process.kill(pid, 0)`. A stale lock (dead process) is removed and the acquire retried. `lock.release()` unlinks the lock file.

`open()` acquires the lock before opening storage and passes the lock instance to `PocketDatabase`, which releases it in `close()`.

### Startup / Replay (`src/api/database.ts` — `loadCollections`)

When `open()` is called, `PocketDatabase` reads every operation record sequentially from the file and replays them:
- `ncl1` → registers a `PocketCollection`.
- `dco1` → removes the collection from the registry.
- `idx1` → creates and registers an in-memory secondary index on the named collection.
- `dix1` → removes the secondary index from the named collection.
- `put1` → updates the primary index entry for that document id to the current operation's file offset (latest write wins).
- `del1` → removes the document id from the primary index and all secondary indexes.
- `txnb`/`txnc` → transaction envelope: operations between begin and commit are buffered and only applied when commit is found. If the log ends before `txnc`, the buffered operations are silently discarded (crash-safe atomic replay for batch methods).
- `hol0` → silently skipped.

Replay fails hard if an operation references an unknown collection, or if a CRC check fails. Corruption handling and truncation recovery are planned but not yet implemented (see `docs/storage.md`).

### Collection API (`src/api/collection.ts`)

`PocketCollection` holds:
- `InMemoryPrimaryIndex` — a `Map<string, { id, offset }>` keyed by document id hex string.
- `IndexManager` — holds zero or more `StringIndex` / `NumberIndex` instances.

Write path for `insertOne`:
1. Generate or validate the `_id` (24-char lowercase hex, 12-byte ObjectId format).
2. Merge `_id` into the document.
3. Call `storage.appendOperation(PUT_DOCUMENT_OPERATION, encodePutDocumentPayload(...))` → get back the file offset.
4. Update in-memory primary index and all secondary indexes with the new offset.

Batch methods (`insertMany`, `updateMany`, `deleteMany`) wrap their individual records in `txnb`/`txnc` before applying in-memory changes, giving atomic replay semantics.

`updateOne`/`updateMany` work by reading the current document (via cursor), applying the update expression in memory, then appending a new `put1` record. The old record is never modified or removed — the primary index is just updated to point to the new offset. Compaction reclaims dead space.

`replaceOne(id, doc)` and `replaceOne(doc)` (with `_id` in doc) are both valid overloads.

`updateOne(id, update)` and `updateOne(query, update)` are both valid overloads.

`deleteOne(id)` and `deleteOne(query)` are both valid overloads.

`countDocuments(query?)` delegates to `find(query).count()`.

### Cursor (`src/api/cursor.ts`)

`find(query)` compiles the query, asks `IndexManager.plan()` for a candidate set, and returns a `PocketCursor`. The cursor captures a **snapshot** of `{ id, offset }` pairs at the moment `find()` is called. Subsequent writes do not affect open cursors (important invariant — tests explicitly verify this). Each `next()` call reads the document at its stored file offset and evaluates the residual query against it.

**`count()`**: fast path when the compiled query is match-all (`{ type: "and", predicates: [] }`) — returns `candidates.length` with zero document reads. Otherwise scans all candidates and counts matches.

**`sort(spec)`**: stores the sort spec (up to 4 fields, direction `1` or `-1`). On the first `next()` call after `sort()` is set, `nextSorted()` reads all matching documents eagerly into a buffer, sorts them, then yields with skip/limit applied. Sort is always eager — there is no sorted index.

**Cache consultation:** `readCandidateDocument(candidate)` takes the full `{ id, offset }` candidate. When the cursor was given a `DocumentCache` (i.e. the collection has caching enabled), it calls `cache.get(id, offset)` first; a hit returns the cached clone with no read or decode. On a miss it reads (bulk buffer or single record), decodes, hands the decoded object to `cache.set(id, offset, doc)` by reference, and returns a clone. When the cache is `null` (default) this is the original read-and-decode path with only a single `null` check of overhead.

### Sort (`src/search/sort.ts`)

- `parseSortSpec(spec)`: validates max 4 fields, direction must be `1` or `-1`.
- `compareDocuments(a, b, fields)`: iterates sort fields left-to-right, multiplies natural comparison by direction.
- `compareValues(a, b)`: missing/null/undefined/NaN → treated as minimum value (-1). Type ranks: boolean=1, number=2, string=3. Arrays and objects throw. Combined with direction: missing values appear **first** in ascending, **last** in descending.

### Query Planning (`src/indexes/index-manager.ts` — `plan`)

`IndexManager.plan(compiledQuery, primaryIndex)` extracts all `FieldPredicate` nodes from the compiled query tree (`fieldPredicates()`) and resolves **every** indexable one independently, then intersects their candidate sets by id (`intersectCandidates`), instead of picking only the single smallest result. A predicate with no matching index contributes nothing to the intersection and is left entirely to the residual filter. If more than one index can answer the *same* predicate, the smallest of those is kept (same tie-break as before). If no predicate is indexable at all, the plan falls back to `primaryIndex.snapshot()` (full scan). `intersectCandidates` sorts lists smallest-first and short-circuits once the running intersection is empty. `QueryPlan.usedIndexes` lists every index that contributed (`[]` for a full scan). The full query is always re-evaluated against each candidate document as a residual filter regardless of which indexes were used — this is what keeps intersecting multiple independent single-field indexes safe (no compound-index data structure needed).

Two `FieldPredicate`s on the *same* field (e.g. from an explicit `{ $and: [{ age: { $gt: 5 } }, { age: { $lt: 10 } }] }`, which does not get merged into one predicate at compile time) are intersected the same way, so both bounds narrow the scan even though a single `NumberIndex.scan()` call only ever sees one predicate's operators at a time.

`fieldPredicates()` only recurses into `and` nodes. It returns `[]` for `or` and `nor` nodes — disjunctive queries cannot be answered by a single index scan (would miss documents from unscanned branches).

### Query Compilation (`src/search/compile-query.ts`)

Supported query operators: `$eq` (implicit from bare value), `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$type`, `$regex` (with `$options`), `$not`, `$and`, `$or`, `$nor`.

`$type` matches a field by its JSON type. The operand is a single type name or an array of names (matches if any). Accepted names: `null`, `boolean` (alias `bool`), `number`, `string`, `array`, `object` — `array`/`object`/`null` are kept distinct. A missing field never matches. Always evaluated in the residual pass (no index support).

Unsupported operators throw at compile time.

`$regex` accepts a pattern string (flags via `$options`), a `RegExp` instance (flags on the RegExp; mutually exclusive with `$options`), or a bare `RegExp` condition as shorthand. Allowed flags: `i`, `m`, `s`, `u` — `g` and `y` throw at compile time because they make `RegExp.test` stateful. Matches string values only; always evaluated in the residual pass (no index support).

`$not` validation: value must be a non-null, non-array object with at least one key. Empty object `{}` throws because `isOperatorObject({})` returns false (no `$`-keys), so the empty-key check (`Object.keys(value).length === 0`) is done explicitly before calling `compileFieldOperators`.

`CompiledQuery` is a union:
```ts
type CompiledQuery = AndPredicate | OrPredicate | NorPredicate | FieldPredicate
```

### Query Evaluation (`src/search/evaluate-query.ts`)

- `and`: every predicate must match.
- `or`: at least one predicate must match; empty array returns `false`.
- `nor`: no predicate must match; empty array returns `true`.
- `field`: evaluate all operators against the field value.
- `not`: negates the conjunction of its inner operators.
- `ne`: strict inequality.
- `gte` / `lte`: inclusive comparison using the same `compareValues` logic as sort.
- `nin`: every candidate must not equal the field value.
- `exists`: checks presence of the field in the document.
- `regex`: `RegExp.test` on string values only; non-strings and missing fields never match.

### Update Operators (`src/search/update-document.ts`)

Supported: `$set`, `$unset`, `$min`, `$max`, `$inc`, `$mul`, `$rename`, `$currentDate`, `$push`, `$addToSet`, `$pop`, `$pull`, `$pullAll`.  
Unsupported operators throw. `_id` is immutable — `$set`, `$unset`, `$currentDate`, and `$rename` (as source or target) on `_id` all throw (enforced by `assertUpdateDoesNotMutateId` in `collection.ts`).

Semantics: `$inc`/`$mul`/`$min`/`$max` require an existing number field. Array operators (`$push`, `$addToSet`, `$pop`, `$pull`, `$pullAll`) require an existing array field. `$rename` with a missing source is a no-op; an existing target is overwritten. `$currentDate`: `true` / `{ $type: "date" }` → ISO-8601 string, `{ $type: "timestamp" }` → epoch ms. `$pull` accepts a literal (deep equality) or a field operator expression (e.g. `{ $gte: 5 }`) evaluated per array element. `$pop` takes `1` (last) or `-1` (first); empty arrays are a no-op.

### Secondary Indexes (`src/indexes/`)

**`StringIndex`**: maps `string field value → Map<id, candidate>`. Skips non-string fields. Answers `$eq` and `$in` predicates only; range predicates fall through to full scan.

**`NumberIndex`**: maps `number field value → Map<id, candidate>` with a maintained sorted array for range queries. Skips non-finite numbers. Answers `$eq`, `$in`, `$gt`, `$gte`, `$lt`, `$lte` predicates. `ne`, `nin`, `not`, `exists` return `null` (full scan fallback). `NumberRange` has four bounds: `minExclusive`, `minInclusive`, `maxExclusive`, `maxInclusive`.

Index definitions are persisted in the log (`idx1`). Index contents are rebuilt from the log every time the database opens (secondary indexes are not checkpointed to disk yet).

**`InMemoryPrimaryIndex`**: handles `_id` equality and `$in` lookups. `snapshot()` returns all `{ id, offset }` pairs for full-collection scans.

**Unique indexes.** `createIndex(field, { type, unique: true })` (default `unique: false`) turns a `StringIndex`/`NumberIndex` into a uniqueness constraint. Every `QueryIndex` implements `findOwner(document, excludeId?)` (the id currently holding the same value, if any) and `findDuplicate()` (scans the index's own contents for any value shared by more than one id). `IndexManager.assertUnique(document, excludeId?)` and `IndexManager.assertUniqueBatch(entries)` call `findOwner` across every `unique` index and throw on conflict; `assertUniqueBatch` additionally tracks values seen earlier in the same batch, since sibling documents in `insertMany`/`updateMany` are invisible to each other until the batch is applied. These are called from `PocketCollection` **before** `appendPutDocument` in `insertOne`, `insertMany`, `replaceOne`, `updateOne`, and `updateMany` — writes are append-only, so the check must happen ahead of the append, not after. `excludeId` is the document's own id for in-place writes (replace/update), so a document can keep its own value. Only values matching the index's own type participate (same guard as `add()`); a missing field or wrong-typed value never conflicts. Creating a `unique` index over a collection with pre-existing duplicates populates the index, detects the conflict via `findDuplicate()`, removes the index again, and throws — nothing is persisted. The `unique` flag itself is persisted in `idx1` (see Operation identifiers table below).

### Document Cache (`src/api/document-cache.ts`)

`DocumentCache` is an optional, per-collection, byte-bounded LRU of parsed "hot" documents. It is **disabled by default**: `PocketCollection` holds `cache: DocumentCache | null = null` and only instantiates the object on `enableCache(maxBytes)`, so a collection that never opts in pays only a single `null` check on the read/write paths (this is a hard requirement — caching must have no impact when off).

Entries are keyed by `_id` hex and stored as `{ document, offset, bytes }`:
- **Keyed by id** so a document stays cached across updates (the offset moves) and across compaction (ids/contents don't change). The cost is explicit invalidation on the write path.
- **Versioned by offset.** `get(id, offset)` returns a hit only when the stored offset matches the caller's expected offset. This preserves the cursor-snapshot invariant: a cursor reading from an older snapshot offset *misses* a newer cached entry and reads its own version from disk. After a write, the entry is refreshed with the new offset so steady-state reads hit again.
- **Ownership/cloning.** `set` takes ownership by reference (callers must not mutate afterwards — the write path builds fresh docs, the read path decodes fresh docs). `get` returns a `structuredClone`, preserving the contract that query results are independent, caller-owned objects. The clone-on-read is the cache's main cost and is outweighed by skipping the read + decode (see benchmarks).
- **Eviction.** LRU via `Map` insertion order; `get`/`set` re-insert to mark most-recently-used; the first key is least-recently-used. A document larger than the whole budget is not cached. Byte size is estimated by `estimateDocumentBytes` (`JSON.stringify(doc).length * 2`), overridable via `sizeOf`.

The cache is purely in-memory and never persisted — empty on every open, like secondary indexes.

**Integration in `PocketCollection`** (single chokepoints): `find()` passes the cache to the cursor; `applyPutDocument` (insert/replace/update) calls `cache.set(id, offset, doc)` to prime/refresh for free; `deletePrimaryIndexEntry` calls `cache.invalidate(id)`; `dropFromReplay` calls `cache.clear()`; `compact()` needs no cache action (ids/contents unchanged). Public methods: `enableCache(maxBytes)`, `disableCache()`, `cacheStats(): DocumentCacheStats | null`.

**Known limitations (deliberate, V1):** the bulk-read path still reads the full candidate range contiguously even when some candidates are cached (a future change can restrict the read to the *missing* range); large scans populate the cache and can cause LRU scan pollution if the budget is smaller than the scan footprint; the cache is lazy only (no eager fully-resident mode — a budget larger than the collection does not pre-load at open).

### Compaction (`src/api/database.ts` — `compact`)

`compact()` rewrites the database file in a single forward pass:
1. Opens a temporary file alongside the database file.
2. Writes the file header.
3. For each live collection: writes its `ncl1` record, all its live documents (`put1` at new offsets), and any active secondary indexes (`idx1`).
4. Atomically replaces the original file with the temporary file (`renameSync`).
5. Reopens the storage on the new file, updates all primary index entries to the new offsets, and refreshes all secondary index contents.

Dead records (old `put1` versions, `del1`, `txnb`/`txnc`, `hol0`, dropped collections/indexes) are simply not written. The file shrinks to only live data.

### Document IDs

12-byte ObjectId layout (same schema as MongoDB ObjectId):
```
[4 bytes unix timestamp] [5 bytes process-random] [3 bytes counter]
```
Exposed as 24-character lowercase hex strings. When the user supplies `_id` on insert, it must match `/^[0-9a-f]{24}$/`.

### Public API (`src/index.ts`)

All exports are from `src/index.ts`:
```ts
export { open, pocketDb } from "./api/open.js";
export type {
  Collection, CreateIndexOptions, CreateIndexResult, Cursor, Database,
  DeleteManyResult, DeleteOneResult, DropIndexResult, DropResult,
  IndexInfo, InsertManyResult, InsertOneResult, OpenOptions, ReplaceOneResult, UpdateResult
} from "./api/types.js";
export type { SortDirection } from "./search/sort.js";
export type { DocumentCacheStats } from "./api/document-cache.js";
```

`pocketDb` is a convenience alias for `open()`. When its first argument is a `string` it is treated as `options.path`; the optional second argument accepts the same `OpenOptions` minus `path`. Both call sites are equivalent:
```ts
open({ path: "./data.pdb" })
pocketDb("./data.pdb")
```

`Collection` interface does **not** expose `id: Buffer` or `existsId()` — those are internal to `PocketCollection`. Tests that need the internal collection id (low-level storage tests) cast to `(collection as any).id`.

`Database` exposes `getCollections(): string[]` and `existsCollection(name): boolean` for introspection without side-effects (unlike `collection()` which creates on first access).

`Collection` exposes `getIndexes(): IndexInfo[]` (where `IndexInfo = { name: string; type: string; unique: boolean }`) and `existsIndex(name): boolean` for index introspection.

`Collection` exposes the hot-document cache controls `enableCache(maxBytes: number): void`, `disableCache(): void`, and `cacheStats(): DocumentCacheStats | null` (`null` when disabled). The cache is off by default; see the Document Cache section above. `DocumentCacheStats` is exported from the package root.

`Database.stats(): DatabaseStats` and `Collection.stats(): CollectionStats` report usage. The cheap fields — `sizeOnDisk` (from `FileStorage.size`, the in-memory `currentOffset`), `collectionCount`, `documentCount` (primary index `size`), `indexCount` — come straight from memory. The history fields — `operationCount`, `tombstoneCount`, `liveBytes`, `deadBytes` — require one forward scan of the log (`computeStorageStats` in `database.ts`), which reuses `shouldKeepOperation` for liveness so `deadBytes` is exactly what `compact()` would reclaim. Records of dropped collections count toward the global totals but are not attributed to any collection. Per-collection stats are produced by the same scan and injected into `PocketCollection` as a `storageStats` callback (no back-reference to the database). The invariant `sizeOnDisk === FILE_HEADER_BYTES + liveBytes + deadBytes` always holds.

### TypeScript Configuration

- **ESM only** (`"type": "module"`, `"module": "NodeNext"`). All internal imports must use `.js` extensions even for `.ts` source files.
- Strict mode enabled. `target: "ES2022"`.
- `outDir: "dist"`, only `src/**/*` is included — `tsc` infers `rootDir: "src"`, so the build is flat (`dist/index.js`, `dist/cjs/index.js`), no `dist/src/` nesting. Tests and benchmarks are never compiled.
- Tests use Node's built-in `node:test` runner and `node:assert/strict`, executed straight from `.ts` via `node --import tsx --test`. No external test framework, no build step.

## Key Invariants and Design Decisions

- **Writes are synchronous.** There is currently no async I/O, no write queue. This keeps the execution model simple for single-process embedded use.
- **No in-place updates.** Every write is an append. The primary index maps id → latest offset. The file only grows until compaction.
- **Cursors snapshot at creation.** `find()` captures the candidate list immediately; later mutations are invisible to that cursor.
- **Indexes narrow; documents filter.** Even with an index, the cursor always re-evaluates the full compiled query against each document read from disk. Indexes can only be used to reduce candidates, not to skip the document read.
- **Secondary indexes are in-memory only.** They are rebuilt from the log at startup. Persisted index snapshots are planned for V2.
- **Batch methods are atomic on replay.** `insertMany`, `updateMany`, `deleteMany` wrap their records in `txnb`/`txnc`. If the process crashes mid-batch, the uncommitted records are ignored on next open.
- **Single process only.** A `.lock` file prevents concurrent opens from different processes. Multiple writers on the same file are not supported and will corrupt the database.
- **Sort is always eager.** `sort()` reads all matching candidates before returning the first result. Narrow the candidate set with an indexed query before sorting.
- **Missing values sort at minimum.** `null`, `undefined`, and `NaN` rank below all typed values. With direction applied: first in ascending, last in descending.
- **The document cache is off by default and free when off.** No `DocumentCache` is instantiated until `enableCache()`; the read/write paths only pay a `null` check. It is keyed by id and versioned by offset, so it never violates cursor-snapshot semantics, and it stays correct across updates/deletes/compaction.
- **Unique constraints are checked before the append, never after.** Because writes cannot be rolled back once appended, `assertUnique`/`assertUniqueBatch` run against the fully-built document ahead of `appendPutDocument`. A rejected `insertMany`/`updateMany` batch writes nothing at all.

## Current Development Status

**V1 complete:**
- Collections, JSON documents, auto `_id`
- `insertOne` / `insertMany`, `findOne` / `find`, `updateOne` / `updateMany`, `deleteOne` / `deleteMany`
- Update operators: `$set`, `$unset`, `$inc`, `$mul`, `$min`, `$max`, `$rename`, `$currentDate`, `$push`, `$addToSet`, `$pop`, `$pull`, `$pullAll`
- Query operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$type`, `$regex`/`$options`, `$not`, `$and`, `$or`, `$nor`
- Secondary indexes: `StringIndex` (`$eq`, `$in`) and `NumberIndex` (`$eq`, `$in`, `$gt`, `$gte`, `$lt`, `$lte`)
- Unique indexes: `createIndex(field, { type, unique: true })`, enforced on `insertOne`/`insertMany`/`replaceOne`/`updateOne`/`updateMany`
- `count()` on cursor, `countDocuments()` on collection
- `sort()` on cursor (up to 4 fields, ascending/descending, stable missing-value semantics)
- `skip()` and `limit()` on cursor
- Manual compaction (`db.compact()`)
- Single-process file lock (`.lock` file with PID + stale detection)
- Bulk-read optimization for multi-candidate scans
- `pocketDb(path, options?)` convenience alias for `open()`
- `Database.getCollections()` / `Database.existsCollection(name)`
- `Collection.getIndexes()` / `Collection.existsIndex(name)`
- `Database.stats()` / `Collection.stats()` (size on disk, document/operation/tombstone counts, reclaimable bytes)
- Optional hot-document cache: `Collection.enableCache()` / `disableCache()` / `cacheStats()` (off by default, id-keyed + offset-versioned LRU)
- Clean public API surface and TypeScript exports
- Benchmarks vs. SQLite (in-memory and file-backed), JSON file, lowdb, and LokiJS, plus a cache vs. no-cache `pocket-db` comparison

**V2 planned:** persisted index snapshots, automatic compaction, read snapshots, streaming scan, improved query planner, index support for `$or`/`$nor` queries. Note: `$or`/`$nor` themselves are already implemented and evaluated correctly (see the V1 list above) — what's still missing is the *index* side: `IndexManager.plan()`'s `fieldPredicates()` only recurses into `and` nodes, so a disjunctive query always falls back to a full collection scan even if every branch is individually indexable.

`durability: "strict" | "relaxed"` (with `fsync`) is already implemented — see `OpenOptions.durability` and `FileStorage` (`fsyncSync` call gated on `durability === "strict"`) — and was mistakenly still listed here until corrected.

**V3 planned:** compound indexes, lightweight transactions, compression, optional native C engine.

## Test Patterns

All tests create a fresh temporary directory per test (using `mkdtempSync`) and clean up in `afterEach`. Database files use `.pdb` extension. Tests import directly from `src/` and run straight from `.ts` via `tsx` — no build step required before `npm test`.

When testing storage-layer behavior (e.g. crash recovery, transaction replay), tests manipulate `FileStorage` directly and re-open the database to verify replay semantics. These tests cast `(collection as any).id` to access the internal collection Buffer id needed to construct raw payloads.

`existsId()` was removed from the public `Collection` interface. Tests that previously used it now use `findOne({ _id }) !== null` (with the assertion made before `db.close()` since `findOne` reads from disk).

The hot-document cache is covered by `tests/document-cache.test.ts`: unit tests construct `DocumentCache` directly (imported from `src/api/document-cache.js`) to exercise offset versioning, LRU eviction, oversized-doc rejection, shrink-to-fit, and stats; integration tests go through `Collection.enableCache()` and assert priming on insert, hotness across updates, invalidation on delete, the cursor-snapshot invariant *with the cache enabled* (replace mid-cursor, still read the old version), and that mutating a returned document does not corrupt the cache. The benchmark adds a `pocket-db (relaxed-json-cache)` adapter (cache enabled via a `cache` token in the adapter mode) and a `findByIdHot (16)` case to compare against the non-cached adapter.

The planner's candidate intersection is covered by `tests/index-manager.test.ts`: unit tests construct `IndexManager`/`InMemoryPrimaryIndex` directly (imported from `src/indexes/index.js`) and call `plan()` with a query built through the real `compileQuery()`, asserting on `plan.candidates` and `plan.usedIndexes` directly. This is deliberately white-box — a black-box test through `Collection.find()` can't distinguish "intersected correctly" from "picked the smaller index and let the residual filter catch the rest," since both produce the same final documents (the residual query is always fully re-evaluated regardless of which candidates the planner picked).

Unique indexes are covered by `tests/unique-index.test.ts`: creation-time checks (default non-unique, creating over empty/conflict-free/conflicting collections, type/missing-field exemptions, re-creating with a mismatched `unique` flag), write-path enforcement across `insertOne`/`insertMany`/`replaceOne`/`updateOne`/`updateMany` (including in-batch collisions and "keep my own value" cases), and persistence across reopen and `compact()`. The cross-engine benchmark suite (`benchmarks/`) was intentionally left untouched — `unique` is a pocket-db-only construct not shared by the comparison adapters (SQLite, lowdb, LokiJS, JSON-file), and the existing `BenchDocument` schema has no field that's naturally unique per document.
