/**
 * Pocket DB benchmark suite.
 *
 * Compares pocket-db against SQLite (in-memory), SQLite (file), and a
 * naive JSON-file store across eight common document-database operations.
 *
 * Usage:
 *   npm run bench
 *
 * Prerequisites:
 *   npm install   (requires node-gyp / Xcode Command Line Tools for better-sqlite3)
 */
import { PocketDbAdapter } from "./adapters/pocket-db.js";
import { SqliteMemoryAdapter } from "./adapters/sqlite-memory.js";
import { SqliteFileAdapter } from "./adapters/sqlite-file.js";
import { JsonFileAdapter } from "./adapters/json-file.js";
import { runBenchmarks, printTable } from "./runner.js";

const adapters = [
  new PocketDbAdapter(),
  new SqliteMemoryAdapter(),
  new SqliteFileAdapter(),
  new JsonFileAdapter()
];

console.log("Pocket DB benchmark suite");
console.log(`Node.js ${process.version}  —  ${new Date().toISOString()}`);
console.log("");
console.log("Running (. = case completed, ! = case failed):");

const results = runBenchmarks(adapters);
printTable(results);
