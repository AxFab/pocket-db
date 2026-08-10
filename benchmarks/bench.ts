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
 *   npm run bench -- --runs=5   # median of 5 independent runs per case, in this process
 *
 * `--runs=N` re-runs the whole suite (setup → every case → teardown, per
 * adapter) N times and reports the median ops/sec per case, with the
 * min/max spread shown alongside it — a single slow run (GC pause, OS
 * scheduling blip) no longer skews the reported number the way a single
 * `--runs=1` sample can. Costs roughly N× the total runtime. Defaults to `1`
 * (today's single-sample behavior) when omitted.
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

const runsArg = process.argv.find((arg) => arg.startsWith("--runs="));
const runs = runsArg ? Number.parseInt(runsArg.slice("--runs=".length), 10) : 1;

if (runsArg && (!Number.isInteger(runs) || runs < 1)) {
  console.error(`Invalid --runs value: "${runsArg}". Expected a positive integer, e.g. --runs=5.`);
  process.exit(1);
}

console.log("Pocket DB benchmark suite");
console.log(`Node.js ${process.version}  —  ${new Date().toISOString()}`);
if (runs > 1) {
  console.log(`Running ${runs} samples per case (median ± spread reported).`);
}
console.log("");
console.log("Running (. = case completed, ! = case failed):");

const results = runBenchmarks(adapters, { runs });

console.log(renderConsole(results));

const { markdownPath, jsonPath } = writeResults(results);
console.log("");
console.log(`Full results written to:\n  ${markdownPath}\n  ${jsonPath}`);
