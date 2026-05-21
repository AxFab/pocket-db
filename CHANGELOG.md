# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
