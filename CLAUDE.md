# CLAUDE.md

This file provides guidance to Claude when working with code in this repository.

## Project Synopsis

Pocket DB is an embedded NoSQL document database for Node.js, persisted in a single append-only file. The design is inspired by SQLite (single-file, embedded) and MongoDB (document model, familiar API), but intentionally compact. Target use cases: desktop apps, CLI tools, Electron apps, prototypes, local servers, plugins, structured caches.

The core constraint is **never reserializing the entire database on write**. All writes are append-only records; the in-memory state is rebuilt by replaying the log at open time.

## Commands

```bash
npm install          # install dependencies (typescript + @types/node; better-sqlite3 for benchmarks)
npm run build        # compile TypeScript → dist/
npm test             # build then run all tests
npm run bench        # build then run the benchmark
```

To run a single test file:
```bash
npm run build && node --test "dist/tests/indexes.test.js"
```

To run tests matching a name pattern:
```bash
npm run build && node --test --test-name-pattern="creates a string index" "dist/tests/**/*.test.js"
```

There is no linter configured yet.

## Architecture Overview

### Layer Diagram

```
src/api/          ← public surface: open(), Database, Collection, Cursor
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

### Sort (`src/search/sort.ts`)

- `parseSortSpec(spec)`: validates max 4 fields, direction must be `1` or `-1`.
- `compareDocuments(a, b, fields)`: iterates sort fields left-to-right, multiplies natural comparison by direction.
- `compareValues(a, b)`: missing/null/undefined/NaN → treated as minimum value (-1). Type ranks: boolean=1, number=2, string=3. Arrays and objects throw. Combined with direction: missing values appear **first** in ascending, **last** in descending.

### Query Planning (`src/indexes/index-manager.ts` — `plan`)

`IndexManager.plan(compiledQuery, primaryIndex)` extracts all `FieldPredicate` nodes from the compiled query tree and checks whether any registered index can answer them. If an index returns candidates, the planner picks the index with the fewest candidates (smallest result set). The full query is always re-evaluated against each candidate document as a residual filter.

`fieldPredicates()` only recurses into `and` nodes. It returns `[]` for `or` and `nor` nodes — disjunctive queries cannot be answered by a single index scan (would miss documents from unscanned branches).

### Query Compilation (`src/search/compile-query.ts`)

Supported query operators: `$eq` (implicit from bare value), `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$not`, `$and`, `$or`, `$nor`.

Unsupported operators throw at compile time.

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

### Update Operators (`src/search/update-document.ts`)

Supported: `$set`, `$unset`, `$min`, `$max`, `$inc`, `$push`.  
Unsupported operators throw. `_id` is immutable — `$set: { _id }` and `$unset: { _id }` both throw.

### Secondary Indexes (`src/indexes/`)

**`StringIndex`**: maps `string field value → Map<id, candidate>`. Skips non-string fields. Answers `$eq` and `$in` predicates only; range predicates fall through to full scan.

**`NumberIndex`**: maps `number field value → Map<id, candidate>` with a maintained sorted array for range queries. Skips non-finite numbers. Answers `$eq`, `$in`, `$gt`, `$gte`, `$lt`, `$lte` predicates. `ne`, `nin`, `not`, `exists` return `null` (full scan fallback). `NumberRange` has four bounds: `minExclusive`, `minInclusive`, `maxExclusive`, `maxInclusive`.

Index definitions are persisted in the log (`idx1`). Index contents are rebuilt from the log every time the database opens (secondary indexes are not checkpointed to disk yet).

**`InMemoryPrimaryIndex`**: handles `_id` equality and `$in` lookups. `snapshot()` returns all `{ id, offset }` pairs for full-collection scans.

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
```

`pocketDb` is a convenience alias for `open()`. When its first argument is a `string` it is treated as `options.path`; the optional second argument accepts the same `OpenOptions` minus `path`. Both call sites are equivalent:
```ts
open({ path: "./data.pdb" })
pocketDb("./data.pdb")
```

`Collection` interface does **not** expose `id: Buffer` or `existsId()` — those are internal to `PocketCollection`. Tests that need the internal collection id (low-level storage tests) cast to `(collection as any).id`.

`Database` exposes `getCollections(): string[]` and `existsCollection(name): boolean` for introspection without side-effects (unlike `collection()` which creates on first access).

`Collection` exposes `getIndexes(): IndexInfo[]` (where `IndexInfo = { name: string; type: string }`) and `existsIndex(name): boolean` for index introspection.

### TypeScript Configuration

- **ESM only** (`"type": "module"`, `"module": "NodeNext"`). All internal imports must use `.js` extensions even for `.ts` source files.
- Strict mode enabled. `target: "ES2022"`.
- `outDir: "dist"`, `rootDir: "."` — tests and benchmarks compile into `dist/tests/` and `dist/benchmarks/`.
- Tests use Node's built-in `node:test` runner and `node:assert/strict`. No external test framework.

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

## Current Development Status

**V1 complete:**
- Collections, JSON documents, auto `_id`
- `insertOne` / `insertMany`, `findOne` / `find`, `updateOne` / `updateMany`, `deleteOne` / `deleteMany`
- Update operators: `$set`, `$unset`, `$inc`, `$min`, `$max`, `$push`
- Query operators: `$eq`, `$ne`, `$gt`, `$gte`, `$lt`, `$lte`, `$in`, `$nin`, `$exists`, `$not`, `$and`, `$or`, `$nor`
- Secondary indexes: `StringIndex` (`$eq`, `$in`) and `NumberIndex` (`$eq`, `$in`, `$gt`, `$gte`, `$lt`, `$lte`)
- `count()` on cursor, `countDocuments()` on collection
- `sort()` on cursor (up to 4 fields, ascending/descending, stable missing-value semantics)
- `skip()` and `limit()` on cursor
- Manual compaction (`db.compact()`)
- Single-process file lock (`.lock` file with PID + stale detection)
- Bulk-read optimization for multi-candidate scans
- `pocketDb(path, options?)` convenience alias for `open()`
- `Database.getCollections()` / `Database.existsCollection(name)`
- `Collection.getIndexes()` / `Collection.existsIndex(name)`
- Clean public API surface and TypeScript exports
- Benchmarks vs. SQLite (in-memory and file-backed) and JSON file

**V2 planned:** unique indexes, persisted index snapshots, automatic compaction, read snapshots, `durability: "strict" | "relaxed"` with fsync, streaming scan, improved query planner, `$or`/`$nor` index support.

**V3 planned:** compound indexes, lightweight transactions, compression, optional native C engine.

## Test Patterns

All tests create a fresh temporary directory per test (using `mkdtempSync`) and clean up in `afterEach`. Database files use `.pdb` extension. Tests import directly from `src/` (not from `dist/`) but the test runner runs compiled output from `dist/` — building first is required.

When testing storage-layer behavior (e.g. crash recovery, transaction replay), tests manipulate `FileStorage` directly and re-open the database to verify replay semantics. These tests cast `(collection as any).id` to access the internal collection Buffer id needed to construct raw payloads.

`existsId()` was removed from the public `Collection` interface. Tests that previously used it now use `findOne({ _id }) !== null` (with the assertion made before `db.close()` since `findOne` reads from disk).
