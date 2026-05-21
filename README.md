<p align="center">
  <img src="docs/pocket-db.png" alt="pocket-db" width="260" />
</p>

<p align="center">
  An embedded, single-file NoSQL database for Node.js — simple to set up, zero production dependencies.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/pocket-db"><img src="https://img.shields.io/npm/v/pocket-db.svg" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-brightgreen" alt="Node ≥ 18" />
</p>

---

Pocket DB stores everything in a **single append-only file** — no server, no daemon, no setup. You open a file, work with collections of JSON documents, and close. That is the whole model.

It is inspired by SQLite (one file, embedded) and MongoDB (document model, familiar API), but intentionally small. The core constraint — *never reserialise the entire database on a write* — means every insert, update and delete is a fast append. Reading a document means seeking to its offset and reading only those bytes.

Good fit for: desktop apps, CLI tools, Electron apps, local servers, plugins, structured caches, offline-first prototypes.

Not a fit for: multi-process concurrent writers, datasets requiring complex aggregation pipelines, or anything that would normally call for a full server database.

---

## Install

```bash
npm install pocket-db
```

No native binaries. No optional dependencies. Pure TypeScript compiled to ESM.

---

## Quick start

```ts
import { open } from "pocket-db";

const db = open({ path: "./data.pdb" });
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

---

## API

### Database

```ts
const db = open({ path?: string });

db.collection(name: string): Collection
db.compact(): void          // reclaim space from dead records
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
collection.drop(): DropResult
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
```

---

## Update operators

Updates are expressed as operator objects applied to the current document.

| Operator | Description |
|----------|-------------|
| `$set` | Set one or more fields |
| `$unset` | Remove one or more fields |
| `$inc` | Increment a numeric field |
| `$min` / `$max` | Set field only if new value is lower / higher |
| `$push` | Append a value to an array field |

```ts
users.updateOne(id, {
  $set: { role: "editor" },
  $inc: { loginCount: 1 }
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

`open()` creates a `.lock` file next to the database file. A second `open()` on the same path from a different process will throw. Stale locks left by crashed processes are detected via PID check and cleared automatically.

Pocket DB is designed for **single-process use**. Multiple concurrent writers on the same file are not supported.

---

## TypeScript

Pocket DB is written in TypeScript and ships its own type declarations. All public types are exported from the package root:

```ts
import type {
  Database, Collection, Cursor,
  InsertOneResult, InsertManyResult,
  UpdateResult, ReplaceOneResult,
  DeleteOneResult, DeleteManyResult,
  CreateIndexResult, DropIndexResult, DropResult,
  OpenOptions, SortDirection
} from "pocket-db";
```

---

## Documentation

The `docs/` folder contains in-depth documentation available as a wiki:

- [File format](docs/file-format.md) — binary layout, record structure, U29 encoding
- [Storage semantics](docs/storage.md) — replay rules, write path, crash recovery
- [Query & update model](docs/query.md) — operators, compilation, cursor semantics
- [Indexes](docs/indexes.md) — primary index, StringIndex, NumberIndex, query planner
- [Compaction](docs/compact.md) — algorithm, invariants, secondary index refresh

---

## License

[MIT](LICENSE) © Fabien Bavent
