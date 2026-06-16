import { performance } from "node:perf_hooks";
import type { Adapter } from "./adapters/adapter.js";
import { generateDocs } from "./data.js";
import { CASES, INITIAL_DATASET_SIZE, type BenchCase } from "./suite.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CaseResult {
  opsPerSecond: number;
  totalMs: number;
  iterations: number;
}

interface AdapterResult {
  adapterName: string;
  cases: Map<string, CaseResult>;
}

// ---------------------------------------------------------------------------
// Core timing
// ---------------------------------------------------------------------------

function runCase(adapter: Adapter, benchCase: BenchCase, initialIds: string[]): CaseResult {
  const context = benchCase.prepare ? benchCase.prepare(adapter, initialIds) : initialIds;

  // Warmup — not measured.
  for (let i = 0; i < benchCase.warmup; i++) {
    benchCase.run(adapter, i, context);
  }

  // Measured phase.
  const start = performance.now();

  for (let i = 0; i < benchCase.iterations; i++) {
    benchCase.run(adapter, i, context);
  }

  const totalMs = performance.now() - start;
  const opsPerSecond = Math.round((benchCase.iterations / totalMs) * 1_000);

  return { opsPerSecond, totalMs, iterations: benchCase.iterations };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export function runBenchmarks(adapters: Adapter[]): AdapterResult[] {
  const results: AdapterResult[] = [];
  const initialDocs = generateDocs(INITIAL_DATASET_SIZE);

  for (const adapter of adapters) {
    process.stdout.write(`  ${adapter.name.padEnd(16)} `);
    const caseResults = new Map<string, CaseResult>();

    let initialIds: string[];
    try {
      initialIds = adapter.setup(initialDocs);
    } catch (error) {
      process.stdout.write(`[setup failed: ${(error as Error).message}]\n`);
      continue;
    }

    for (const benchCase of CASES) {
      try {
        const result = runCase(adapter, benchCase, initialIds);
        caseResults.set(benchCase.name, result);
        process.stdout.write(".");
      } catch {
        caseResults.set(benchCase.name, { opsPerSecond: -1, totalMs: 0, iterations: 0 });
        process.stdout.write("!");
      }
    }

    adapter.teardown();
    process.stdout.write(" done\n");

    results.push({ adapterName: adapter.name, cases: caseResults });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Table rendering
// ---------------------------------------------------------------------------

const COL_WIDTH = 16;   // numeric field width
const COL_TOTAL = COL_WIDTH + 2;  // + 2 chars for "  " or " *" marker
const LABEL_WIDTH = 24;

function fmt(n: number): string {
  if (n < 0) return "(error)".padStart(COL_WIDTH);
  return n.toLocaleString("en-US").padStart(COL_WIDTH);
}

function separator(adapterCount: number): string {
  return "─".repeat(LABEL_WIDTH) + "─".repeat(COL_TOTAL * adapterCount);
}

function bestIndex(row: number[]): number {
  let best = 0;
  for (let i = 1; i < row.length; i++) {
    if (row[i] > row[best]) best = i;
  }
  return best;
}

export function printTable(results: AdapterResult[]): void {
  const adapterNames = results.map((r) => r.adapterName);
  const caseNames = CASES.map((c) => c.name);

  console.log("");
  console.log(`Benchmark results — ${INITIAL_DATASET_SIZE.toLocaleString("en-US")} documents`);
  console.log(separator(adapterNames.length));

  // Header row.
  const header =
    "Operation".padEnd(LABEL_WIDTH) +
    adapterNames.map((n) => n.padStart(COL_TOTAL)).join("");
  console.log(header);
  console.log(separator(adapterNames.length));

  // One row per benchmark case.
  for (const caseName of caseNames) {
    const values = results.map((r) => r.cases.get(caseName)?.opsPerSecond ?? -1);
    const best = bestIndex(values);

    const cells = values.map((v, i) => {
      const marker = i === best && v > 0 ? " *" : "  ";
      return fmt(v) + marker;
    });

    console.log(caseName.padEnd(LABEL_WIDTH) + cells.join(""));
  }

  console.log(separator(adapterNames.length));
  console.log("All values in ops/sec.  * = fastest for this operation.");
  console.log("");

  // Per-adapter summary: geometric mean of normalised scores vs pocket-db.
  const pocketDbResults = results.find((r) => r.adapterName === "pocket-db");
  if (pocketDbResults && results.length > 1) {
    console.log("Relative throughput vs pocket-db (geometric mean across all operations):");
    for (const result of results) {
      if (result.adapterName === "pocket-db") continue;
      const ratios: number[] = [];
      for (const caseName of caseNames) {
        const ours = pocketDbResults.cases.get(caseName)?.opsPerSecond ?? 0;
        const theirs = result.cases.get(caseName)?.opsPerSecond ?? 0;
        if (ours > 0 && theirs > 0) {
          ratios.push(theirs / ours);
        }
      }
      if (ratios.length === 0) continue;
      const geoMean = Math.pow(ratios.reduce((a, b) => a * b, 1), 1 / ratios.length);
      const sign = geoMean >= 1 ? "+" : "";
      const pct = ((geoMean - 1) * 100).toFixed(1);
      console.log(`  ${result.adapterName.padEnd(20)} ${sign}${pct}%`);
    }
    console.log("");
  }
}
