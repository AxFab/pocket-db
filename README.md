
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/pocket-db-dk.svg">
    <img src="docs/pocket-db.svg" alt="pocket-db" width="300">
  </picture>
</p>

**Pocket DB** — the local database for Electron, desktop and CLI apps.
One file, **zero native dependencies**, a familiar MongoDB-style API.

<p align="center">
  <a href="https://www.npmjs.com/package/@axfab/pocket-db"><img src="https://img.shields.io/npm/v/@axfab/pocket-db.svg" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node ≥ 18" />
  <a href="https://npmcharts.com/compare/@axfab/pocket-db?minimal=true"><img src="https://img.shields.io/npm/dm/@axfab/pocket-db.svg" alt="npm downloads" /></a>
</p>

---

Add persistent local storage to a Node.js or Electron app — no server, no daemon,
and **no native bindings**. No `node-gyp`, no rebuilding against every Electron
version, none of the `better-sqlite3` recompile dance. Run `npm install` and you
have a working document store backed by a single file.

```ts
import { pocketDb } from "@axfab/pocket-db";

const db = pocketDb("./data.pdb");
const users = db.collection("users");

users.insertOne({ name: "Ada", role: "admin" });
const admins = users.find({ role: "admin" }).toArray();

db.close();
```

That's the whole setup — open a file, work with collections of JSON documents, close.

## Why pocket-db

- 🪶 **Zero native dependencies** — pure TypeScript, no `node-gyp`, no per-Electron rebuilds
- 📄 **Single file** — back up your whole database by copying one `.pdb` file
- 🍃 **MongoDB-style API** — `find` / `insert` / `update` with the operators you already know
- ⚡ **Append-only writes** — every mutation is a fast sequential append, with crash-safe batches
- 🛡️ **Safe reads** — every query returns an independent copy, so mutating a result never corrupts your stored data

Inspired by SQLite (one embedded file) and MongoDB (document model), but intentionally
small. The core rule — *never reserialise the whole database on a write* — makes every
insert, update and delete a fast append, and reads seek straight to a document's offset.

**Good fit:** Electron & desktop apps, CLI tools, local servers, plugins, structured
caches, offline-first prototypes.
**Not a fit:** multiple processes writing the same file at once, complex aggregation
pipelines, or anything that really wants a server database.

---

## Install

```bash
npm install @axfab/pocket-db
```

No native binaries. No optional dependencies. Pure TypeScript compiled to ESM. Node.js ≥ 18 is required (the package only relies on `structuredClone` and `Object.hasOwn`, both available since Node 17/16.9).

**Bun / Deno:** not officially tested, but should work — the package touches only `node:fs`, `node:path`, `node:os`, `node:crypto`, and `Buffer`, all well-covered by both runtimes' Node compatibility layers, and `with { type: 'json' }` isn't used here so there's no import-attribute version floor to worry about.

---

## Quick start

```ts
import { pocketDb } from "@axfab/pocket-db";

const db = pocketDb("./data.pdb");
const users = db.collection("users");

// Insert
const { insertedId } = users.insertOne({ name: "Ada", role: "admin", age: 37 });

// Find
const ada = users.findOne({ name: "Ada" });
console.log(ada); // { _id: "...", name: "Ada", role: "admin", age: 37 }

// Query with operators
const admins = users.find({ role: "admin", age: { $gte: 18 } }).toArray();

// Update
users.updateOne(insertedId, { $set: { age: 38 }, $inc: { loginCount: 1 } });

// Delete
users.deleteOne(insertedId);

db.close();
```

---

## Core concepts

### Single file, append-only

All writes are appended to the end of the file. Reads go directly to the byte offset of the document — no full-file scan. The in-memory state is rebuilt by replaying the log when `open()` is called. Deleted and updated documents leave dead records behind; `db.compact()` reclaims that space in a single forward pass.

### Collections

A database holds any number of named collections. Collections are created implicitly on first access and persisted to the log. Each collection has its own primary index (keyed by `_id`) and optional secondary indexes.

### Document IDs

Every document gets a `_id`: a 24-character lowercase hex string (12-byte ObjectId layout — 4-byte timestamp, 5-byte random, 3-byte counter). You can supply your own `_id` on insert as long as it matches that format.

### Safe reads

Every document returned by `findOne`, `find`, or a cursor is a fresh, independent object that you fully own. Mutating a query result never affects what is stored — exactly what you'd expect from a real database. This holds whether the read came from disk or from the [hot-document cache](#hot-document-cache) (cached reads are deep-cloned on the way out).

This is a deliberate guarantee: some in-memory stores return references to their internal objects by default, which is faster but means modifying a query result silently corrupts the database. Pocket DB always isolates your results.

---

## API

### Opening a database

```ts
import { pocketDb } from "@axfab/pocket-db";
const db = pocketDb("./data.pdb");
```

You can also merge both arguments by setting the `path` property in the options object, or pass all options together:

```ts
const db = pocketDb({ path: "./data.pdb" });
```

`pocketDb` accepts an optional `OpenOptions` object as its second argument (or first, when using the object form):

```ts
const db = pocketDb("./data.pdb", {
  durability: "strict",      // default: "relaxed"
  serialization: "bson",     // default: "json" — only applies when creating a new file
});
```

#### `durability`

Controls whether `fsync` is called after every write.

- `"relaxed"` *(default)* — skips `fsync`. Writes reach the OS page cache but may be lost on a power failure or OS crash before the cache is flushed. Faster; suitable when losing the last few writes on a hard crash is acceptable.
- `"strict"` — calls `fsync` after every `appendOperation`, guaranteeing data is on durable storage before the call returns. Safest; incurs one extra syscall per write.

#### `serialization`

Selects the document encoding format when **creating a new database file**. Opening an existing file always uses the format recorded in the file header — this option is ignored.

- `"json"` *(default)* — documents stored as UTF-8 JSON. Human-readable, universally compatible.
- `"bson"` — documents stored as BSON (Binary JSON). Supports double, string, document, array, boolean, null, int32, int64. More compact than JSON for numeric-heavy documents.
- `"amf3"` — documents stored as AMF3 (Action Message Format 3). A compact binary format supporting undefined, null, boolean, integer, double, string, array, and object.

### Database

```ts
db.collection(name: string): Collection
db.getCollections(): string[]              // names of all registered collections
db.existsCollection(name: string): boolean
db.compact(): void                         // reclaim space from dead records
db.close(): void
```

### Collection

```ts
collection.insertOne(doc): InsertOneResult
collection.insertMany(docs): InsertManyResult

collection.findOne(query?): Record | null
collection.find(query?): Cursor
collection.countDocuments(query?): number

collection.updateOne(id | query, update): UpdateResult
collection.updateMany(query, update): UpdateResult

collection.replaceOne(id, doc): ReplaceOneResult
collection.replaceOne(doc & { _id }): ReplaceOneResult

collection.deleteOne(id | query): DeleteOneResult
collection.deleteMany(query?): DeleteManyResult

collection.createIndex(field, { type: "string" | "number" }): CreateIndexResult
collection.dropIndex(field): DropIndexResult
collection.getIndexes(): { name: string; type: string }[]
collection.existsIndex(name: string): boolean
collection.drop(): DropResult

collection.enableCache(maxBytes: number): void   // hot-document cache (off by default)
collection.disableCache(): void
collection.cacheStats(): DocumentCacheStats | null
```

### Cursor

```ts
cursor.next(): Record | null
cursor.toArray(): Record[]
cursor.count(): number

cursor.sort(spec: Record<string, 1 | -1>): Cursor   // up to 4 fields
cursor.limit(n: number): Cursor
cursor.skip(n: number): Cursor
```

---

## Query operators

Queries are plain objects. A bare value is shorthand for `$eq`.

| Operator | Description |
|----------|-------------|
| `$eq` | Strict equality (no type coercion) |
| `$ne` | Not equal |
| `$gt` / `$gte` | Greater than / greater than or equal |
| `$lt` / `$lte` | Less than / less than or equal |
| `$in` | Field value is in the given array |
| `$nin` | Field value is not in the given array |
| `$exists` | Field is present (`true`) or absent (`false`) |
| `$regex` | String matches a regular expression (flags via `$options`; `g`/`y` rejected) |
| `$not` | Negates an operator expression |
| `$and` | Logical AND of sub-queries |
| `$or` | Logical OR of sub-queries |
| `$nor` | Logical NOR of sub-queries |

```ts
// Compound query
users.find({
  $and: [
    { role: { $in: ["admin", "editor"] } },
    { age: { $gte: 18, $lt: 65 } }
  ]
});

// Negation
users.find({ status: { $not: { $eq: "banned" } } });

// OR
users.find({ $or: [{ role: "admin" }, { role: "editor" }] });

// Regex (string pattern + $options, RegExp value, or bare RegExp shorthand)
users.find({ name: { $regex: "^ada", $options: "i" } });
users.find({ name: { $regex: /^ada/i } });
users.find({ name: /^Ada/ });
```

---

## Update operators

Updates are expressed as operator objects applied to the current document.

| Operator | Description |
|----------|-------------|
| `$set` | Set one or more fields |
| `$unset` | Remove one or more fields |
| `$inc` | Increment a numeric field |
| `$mul` | Multiply a numeric field by a factor |
| `$min` / `$max` | Set field only if new value is lower / higher |
| `$rename` | Rename a field (missing source is a no-op) |
| `$currentDate` | Set field to the current date (`true` / `{ $type: "date" }` → ISO string, `{ $type: "timestamp" }` → epoch ms) |
| `$push` | Append a value to an array field |
| `$addToSet` | Append a value only if no equal element exists |
| `$pop` | Remove the last (`1`) or first (`-1`) array element |
| `$pull` | Remove array elements equal to a value or matching a condition |
| `$pullAll` | Remove array elements equal to any listed value |

```ts
users.updateOne(id, {
  $set: { role: "editor" },
  $inc: { loginCount: 1 },
  $mul: { score: 1.1 },
  $currentDate: { lastLogin: true },
  $addToSet: { tags: "active" },
  $pull: { scores: { $lt: 10 } }
});
```

`_id` is immutable and cannot be modified by any update operator.

---

## Indexes

Secondary indexes speed up equality and range queries. They are rebuilt from the log at every open.

```ts
// Create
users.createIndex("role", { type: "string" });
users.createIndex("age",  { type: "number" });

// Drop
users.dropIndex("role");
```

`StringIndex` supports `$eq` and `$in` lookups. `NumberIndex` additionally supports `$gt`, `$gte`, `$lt`, `$lte` range scans. The query planner automatically picks the most selective available index for each query.

---

## Hot-document cache

By default every read decodes its document from the file. For workloads that read the same documents repeatedly, you can opt into an in-memory cache that keeps parsed *hot* documents around, so repeated reads skip both the file read and the decode.

```ts
users.enableCache(16 * 1024 * 1024); // 16 MB budget; least-recently-used docs are evicted
users.cacheStats();                  // { hits, misses, evictions, bytes, documentCount, ... }
users.disableCache();                // free everything, back to zero overhead
```

The cache is **off by default** — when disabled it costs nothing (no object is even allocated). It is keyed by `_id` and versioned by file offset, so it stays correct across updates, deletes, compaction, and open cursors (snapshot reads are preserved).

**The gain:** on a 2,000-document JSON dataset, single-document reads get ~**2.9×** faster and even full scans ~**1.8×** faster, because skipping the read + JSON parse outweighs the cost of cloning the cached object.

**The drawbacks:** it trades memory for speed, so size the budget for your hot working set. It is rebuilt empty on every `open()` (in-memory only, never persisted). And large scans populate the cache as they read — if the budget is smaller than a scan's footprint, a one-off scan can evict genuinely hot documents.

See [docs/cache.md](docs/cache.md) for the full design, internals, and benchmark methodology.

---

## Sorting and pagination

```ts
const page = users
  .find({ role: "admin" })
  .sort({ age: -1, name: 1 })   // up to 4 sort fields
  .skip(20)
  .limit(10)
  .toArray();
```

Sort accepts `1` (ascending) and `-1` (descending). Missing values sort **first** in ascending order and **last** in descending order. Sorting is always eager — narrow the candidate set with an indexed query before sorting over large collections.

---

## Compaction

Dead records accumulate as documents are updated or deleted. `compact()` rewrites the file in a single forward pass, keeping only live data:

```ts
db.compact();
```

After compaction, all in-memory indexes are refreshed automatically.

---

## Batch atomicity

`insertMany`, `updateMany`, and `deleteMany` are crash-safe: if the process is killed mid-batch, the partial batch is silently discarded on the next open. Either all operations are visible or none are.

---

## File locking

`pocketDb()` creates a `.lock` file next to the database file. A second `pocketDb()` on the same path from a different process will throw. Stale locks left by crashed processes are detected via PID check and cleared automatically.

Pocket DB is designed for **single-process use**. Multiple concurrent writers on the same file are not supported.

---

## TypeScript

Pocket DB is written in TypeScript and ships its own type declarations. All public types are exported from the package root:

```ts
import { pocketDb } from "@axfab/pocket-db";
import type {
  Database, Collection, Cursor,
  InsertOneResult, InsertManyResult,
  UpdateResult, ReplaceOneResult,
  DeleteOneResult, DeleteManyResult,
  CreateIndexResult, DropIndexResult, DropResult,
  IndexInfo, OpenOptions, SortDirection,
  DocumentCacheStats
} from "@axfab/pocket-db";
```

---

## Documentation

The `docs/` folder contains in-depth documentation available as a wiki:

- [File format](docs/file-format.md) — binary layout, record structure, U29 encoding
- [Storage semantics](docs/storage.md) — replay rules, write path, crash recovery
- [Query & update model](docs/query.md) — operators, compilation, cursor semantics
- [Indexes](docs/indexes.md) — primary index, StringIndex, NumberIndex, query planner
- [Hot-document cache](docs/cache.md) — LRU cache internals, offset versioning, eviction, benchmarks
- [Compaction](docs/compact.md) — algorithm, invariants, secondary index refresh

---

## Performance

Pocket DB is built for fast, durable writes. Benchmarked against other embedded
stores on 1,000 documents across the operations in our benchmark suite — ops/sec,
higher is better.

**The headline:** for durable writes, pocket-db is **40–700× faster** than every other
file-backed store here, and lands within ~12% of in-memory SQLite — which isn't even
durable.

📊 **[Full results table → benchmarks/RESULTS.md](benchmarks/RESULTS.md)** — all
adapters and operations side by side. Regenerate anytime with `npm run bench`, which
prints a width-aware ranked view to the console and refreshes `RESULTS.md` and
`results.json`.

### Reading the results

**Writes — where pocket-db shines.** Every mutation is a single sequential append:
no B-tree rebalancing, no page allocation, no full-file reserialisation. That's why
`insertOne`, `updateOne` and `deleteOne` leave every other persistent store far behind
and sit right next to in-memory SQLite. For a desktop or Electron app writing to disk
on every user action, this is exactly the path that matters — and it stays durable.

**Single-document reads are fast too.** `findById` runs at ~140k ops/sec — more than
enough for typical app workloads, even though it reads from disk rather than RAM.

**Full scans and sorts — the current tradeoff, by design.** json-file, lowdb and LokiJS
win on `findAll` and `sortByScore` because they hold the *entire dataset in memory* and
serve reads from there. That speed has a hard ceiling: your database can never grow
larger than available RAM. Pocket DB keeps only its indexes in memory and reads each
document from its file offset on demand — so it can back a database **far larger than
RAM would ever allow**. The price today is slower full scans.

A **hot-document cache** now closes most of that read gap without touching the append-only
write model. Opt in with `collection.enableCache(maxBytes)` and hot documents stay parsed
in memory: single-document reads get ~2.9× faster and full scans ~1.8× faster on the
2,000-document JSON benchmark. It is off by default and trades memory for speed — see
[docs/cache.md](docs/cache.md).

**Reading the read numbers fairly.** pocket-db returns an independent copy of every
document, so mutating a result never touches stored data. Some in-memory stores in this
table return references to their internal objects by default — fast, but modifying a query
result silently corrupts the database. Part of their read-throughput lead is simply the
defensive copy pocket-db makes and they skip; it buys a correctness guarantee we keep on
purpose.

**In short:** if your workload is write-heavy, needs durability, or outgrows memory,
pocket-db is the right tool. If you need pure in-memory read throughput on a dataset that
comfortably fits in RAM, an in-memory store still wins today.

Run the benchmarks yourself:
```bash
npm install
npm run bench
```

---

## License

[MIT](LICENSE) © Fabien Bavent
