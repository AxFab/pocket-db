/**
 * Pocket DB benchmark suite.
 *
 * Compares pocket-db (several durability / serialization / cache configs)
 * against SQLite (in-memory and file), a naive JSON-file store, lowdb, and
 * LokiJS across the operations defined in `suite.ts`.
 *
 * Prints a width-aware ranked view to the console and writes the full matrix to
 * `benchmarks/RESULTS.md` (+ `results.json`) for the README.
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
import { runBenchmarks, renderConsole, writeResults } from "./runner.js";

const adapters = [
  new PocketDbAdapter('strict-json'),
  new PocketDbAdapter('relaxed-json'),
  new PocketDbAdapter('relaxed-json-cache'),
  new PocketDbAdapter('relaxed-bson'),
  new PocketDbAdapter('relaxed-amf3'),
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

console.log(renderConsole(results));

const { markdownPath, jsonPath } = writeResults(results);
console.log("");
console.log(`Full results written to:\n  ${markdownPath}\n  ${jsonPath}`);
