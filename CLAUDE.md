# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Synopsis

Pocket DB is an experimental embedded NoSQL document database for Node.js, persisted in a single append-only file. The design is inspired by SQLite (single-file, embedded) and MongoDB (document model, familiar API), but intentionally compact. Target use cases: desktop apps, CLI tools, Electron apps, prototypes, local servers, plugins, structured caches.

The core constraint is **never reserializing the entire database on write**. All writes are append-only records; the in-memory state is rebuilt by replaying the log at open time.

## Commands

```bash
npm install          # install dependencies (only typescript + @types/node)
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
src/search/       ← query compilation, evaluation, document update operators
src/indexes/      ← primary index, secondary indexes (string/number), IndexManager
src/storage/      ← file format, binary encoding, CRC32 validation
src/native/       ← reserved for future C backend (empty, interfaces only)
```

### File Storage (`src/storage/`)

`FileStorage` is the lowest layer. It wraps a synchronous Node.js file descriptor (`node:fs` sync API — `readSync`, `writeSync`). Every write goes through `appendOperation(identifier, payload)`, which:
1. uses the in-memory `currentOffset` counter to get the write offset (initialized from `fstatSync` once at open, then maintained internally),
2. encodes the record as `[4-byte identifier][4-byte payload length][N-byte payload][4-byte CRC32]`,
3. writes it atomically (retry loop), advances `currentOffset` by `record.byteLength`, and returns the offset.

Reading a document later means calling `readOperationAtOffset(offset)` — only the bytes for that one record are read from disk.

**Binary encoding conventions:**
- All multi-byte integers are big-endian.
- Payloads are zero-padded to 4-byte alignment.
- `U29` (in `u29.ts`) is a variable-length 1–4 byte unsigned 29-bit integer used for string/JSON byte lengths, using the same high-bit continuation scheme as UTF-8.
- CRC32 is computed over `identifier + length_field + payload` (everything before the checksum).

**Operation identifiers** (4 ASCII bytes, defined in `constants.ts`):
| Magic | Meaning |
|-------|---------|
| `ncl1` | New collection |
| `idx1` | Create index |
| `put1` | Put document (insert/replace/update — always a full document) |
| `del1` | Delete document |
| `txnb` | Transaction begin |
| `txnc` | Transaction commit |

### Startup / Replay (`src/api/database.ts` — `loadCollections`)

When `open()` is called, `PocketDatabase` reads every operation record sequentially from the file and replays them:
- `ncl1` → registers a `PocketCollection`.
- `idx1` → creates and registers an in-memory secondary index on the named collection.
- `put1` → updates the primary index entry for that document id to the current operation's file offset (latest write wins).
- `del1` → removes the document id from the primary index and all secondary indexes.
- `txnb`/`txnc` → transaction envelope: operations between begin and commit are buffered and only applied when commit is found. If the log ends before `txnc`, the buffered operations are silently discarded (crash-safe atomic replay for batch methods).

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

`updateOne`/`updateMany` work by reading the current document (via cursor), applying the update expression in memory, then appending a new `put1` record. The old record is never modified or removed — the primary index is just updated to point to the new offset. Compaction (not yet implemented) will eventually reclaim space.

`replaceOne(id, doc)` and `replaceOne(doc)` (with `_id` in doc) are both valid overloads.

`updateOne(id, update)` and `updateOne(query, update)` are both valid overloads.

`deleteOne(id)` and `deleteOne(query)` are both valid overloads.

### Cursor (`src/api/cursor.ts`)

`find(query)` compiles the query, asks `IndexManager.plan()` for a candidate set, and returns a `PocketCursor`. The cursor captures a **snapshot** of `{ id, offset }` pairs at the moment `find()` is called. Subsequent writes do not affect open cursors (important invariant — tests explicitly verify this). Each `next()` call reads the document at its stored file offset and evaluates the residual query against it.

### Query Planning (`src/indexes/index-manager.ts` — `plan`)

`IndexManager.plan(compiledQuery, primaryIndex)` extracts all `FieldPredicate` nodes from the compiled query tree and checks whether any registered index can answer them. If an index returns candidates, the planner picks the index with the fewest candidates (smallest result set). The full query is always re-evaluated against each candidate document as a residual filter (indexes only narrow candidates, they don't replace document-level filtering).

### Query Compilation (`src/search/compile-query.ts`)

Supported query operators: `$eq` (implicit from bare value), `$gt`, `$lt`, `$in`, `$exists`, `$and`.  
Unsupported operators throw at compile time.

### Update Operators (`src/search/update-document.ts`)

Supported: `$set`, `$unset`, `$min`, `$max`, `$inc`, `$push`.  
Unsupported operators throw. `_id` is immutable — `$set: { _id }` and `$unset: { _id }` both throw.

### Secondary Indexes (`src/indexes/`)

**`StringIndex`**: maps `string field value → Map<id, candidate>`. Skips non-string fields. Answers `$eq` and `$in` predicates only; range predicates fall through to full scan.

**`NumberIndex`**: maps `number field value → Map<id, candidate>` with a maintained sorted array for range queries. Skips non-finite numbers. Answers `$eq`, `$in`, `$gt`, `$lt` predicates.

Index definitions are persisted in the log (`idx1`). Index contents are rebuilt from the log every time the database opens (secondary indexes are not checkpointed to disk yet).

**`InMemoryPrimaryIndex`**: handles `_id` equality and `$in` lookups. `snapshot()` returns all `{ id, offset }` pairs for full-collection scans.

### Document IDs

12-byte ObjectId layout (same schema as MongoDB ObjectId):
```
[4 bytes unix timestamp] [5 bytes process-random] [3 bytes counter]
```
Exposed as 24-character lowercase hex strings. When the user supplies `_id` on insert, it must match `/^[0-9a-f]{24}$/`.

### TypeScript Configuration

- **ESM only** (`"type": "module"`, `"module": "NodeNext"`). All internal imports must use `.js` extensions even for `.ts` source files.
- Strict mode enabled. `target: "ES2022"`.
- `outDir: "dist"`, `rootDir: "."` — tests and benchmarks compile into `dist/tests/` and `dist/benchmarks/`.
- Tests use Node's built-in `node:test` runner and `node:assert/strict`. No external test framework.

## Key Invariants and Design Decisions

- **Writes are synchronous.** There is currently no async I/O, no write queue. This keeps the execution model simple for single-process embedded use.
- **No in-place updates.** Every write is an append. The primary index maps id → latest offset. The file only grows until compaction (not implemented yet).
- **Cursors snapshot at creation.** `find()` captures the candidate list immediately; later mutations are invisible to that cursor.
- **Indexes narrow; documents filter.** Even with an index, the cursor always re-evaluates the full compiled query against each document read from disk. Indexes can only be used to reduce candidates, not to skip the document read.
- **Secondary indexes are in-memory only.** They are rebuilt from the log at startup. For very large databases with many secondary indexes, startup cost will grow with file size. Persisted index snapshots are planned for V2.
- **Batch methods are atomic on replay.** `insertMany`, `updateMany`, `deleteMany` wrap their records in `txnb`/`txnc`. If the process crashes mid-batch, the uncommitted records are ignored on next open.
- **Single process only.** No file locking is implemented. Multiple writers to the same file will corrupt it. A lock file is planned for V1 completion.
- **No compaction yet.** Deleted and updated documents accumulate as dead records. Manual compaction is on the V1 TODO; automatic compaction is V2.

## Current Development Status (from ROADMAP)

**V1 done:** collections, JSON documents, auto `_id`, insertOne/Many, findOne/find/limit, updateOne with $set/$unset/$inc/$min/$max/$push, deleteOne/deleteMany, simple single-field indexes (string and number types), update/delete.

**V1 still pending:** manual compaction, cleaned-up TypeScript public API surface, single-process file lock, benchmarks vs. full JSON stringify.

**V2 planned:** sorted find, unique indexes, persisted index snapshots, automatic compaction, read snapshots, batching, `durability: "strict" | "relaxed"` with fsync, streaming scan, improved query planner.

**V3 planned:** compound indexes, lightweight transactions, compression, optional native C engine.

## Test Patterns

All tests create a fresh temporary directory per test (using `mkdtempSync`) and clean up in `afterEach`. Database files use `.pdb` extension. Tests import directly from `src/` (not from `dist/`) but the test runner runs compiled output from `dist/` — building first is required.

When testing storage-layer behavior (e.g. crash recovery, transaction replay), tests manipulate `FileStorage` directly and re-open the database to verify replay semantics.
