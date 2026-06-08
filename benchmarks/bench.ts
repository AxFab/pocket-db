/**
 * Pocket DB benchmark suite.
 *
 * Compares pocket-db against SQLite (in-memory), SQLite (file), a naive
 * JSON-file store, lowdb, and LokiJS across eight common document-database
 * operations.
 *
 * Usage:
 *   npm run bench
 *
 * Prerequisites:
 *   npm install   (requires node-gyp / Xcode Command Line Tools for better-sqlite3)
 */
import { PocketDbAdapter } from "./adapters/pocket-db.js";
import { SqliteAdapter } from "./adapters/sqlite.js";
import { JsonFileAdapter } from "./adapters/json-file.js";
import { LowDbAdapter } from "./adapters/lowdb.js";
import { LokiJsAdapter } from "./adapters/lokijs.js";
import { runBenchmarks, printTable } from "./runner.js";

const adapters = [
  new PocketDbAdapter('strict-json'),
  new PocketDbAdapter('relaxed-json'),
  // new PocketDbAdapter('relaxed-bson'),
  // new PocketDbAdapter('relaxed-amf3'),
  // new PocketDbAdapter('relaxed-cbor'),
  new PocketDbAdapter('relaxed-msgpack'),
  new SqliteAdapter('memory'),
  new SqliteAdapter('file'),
  new JsonFileAdapter(),
  new LowDbAdapter(),
  new LokiJsAdapter(),
];

console.log("Pocket DB benchmark suite");
console.log(`Node.js ${process.version}  —  ${new Date().toISOString()}`);
console.log("");
console.log("Running (. = case completed, ! = case failed):");

const results = runBenchmarks(adapters);
printTable(results);
