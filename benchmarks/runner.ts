import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
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
// Rendering
//
// Rendering is split from collection so the same AdapterResult[] can be shown
// several ways. Adapters are never laid out as columns in the console view —
// they are ranked vertically per operation — so output stays readable no matter
// how many adapters or operations are added.
// ---------------------------------------------------------------------------

/** Formats an ops/sec value, or `(error)` for a failed case (`opsPerSecond < 0`). */
function formatOps(opsPerSecond: number): string {
  return opsPerSecond < 0 ? "(error)" : opsPerSecond.toLocaleString("en-US");
}

/** Ops for a given adapter + case, or `-1` when the case did not run. */
function opsFor(result: AdapterResult, caseName: string): number {
  return result.cases.get(caseName)?.opsPerSecond ?? -1;
}

/**
 * Width-aware console view: one block per operation, adapters ranked
 * fastest-first with a proportional bar. Bar length is linear against the
 * fastest adapter in that block, so orders-of-magnitude differences read as an
 * (almost) empty bar — which is the intended signal. Adding adapters grows each
 * block downward; adding operations adds blocks. Nothing ever grows wider than
 * the terminal.
 */
export function renderConsole(results: AdapterResult[], terminalWidth = process.stdout.columns ?? 80): string {
  const caseNames = CASES.map((c) => c.name);
  const nameWidth = Math.min(30, Math.max(1, ...results.map((r) => r.adapterName.length)));

  const lines: string[] = [
    "",
    `Benchmark results — ${INITIAL_DATASET_SIZE.toLocaleString("en-US")} documents, Node.js ${process.version}`,
    ""
  ];

  for (const caseName of caseNames) {
    const rows = results
      .map((r) => ({ name: r.adapterName, ops: opsFor(r, caseName) }))
      .sort((a, b) => b.ops - a.ops); // fastest first; errors (-1) sink to the bottom

    const maxOps = Math.max(0, ...rows.map((r) => r.ops));
    const numWidth = Math.max(...rows.map((r) => formatOps(r.ops).length));
    const barWidth = Math.max(0, terminalWidth - 2 - nameWidth - 2 - numWidth - 1);

    lines.push(caseName);

    for (const row of rows) {
      const name = row.name.length > nameWidth
        ? `${row.name.slice(0, nameWidth - 1)}…`
        : row.name.padEnd(nameWidth);
      const num = formatOps(row.ops).padStart(numWidth);

      let bar = "";
      if (row.ops > 0 && maxOps > 0 && barWidth >= 1) {
        bar = "█".repeat(Math.round((row.ops / maxOps) * barWidth));
      }

      lines.push(`  ${name}  ${num} ${bar}`.trimEnd());
    }

    lines.push("");
  }

  lines.push("ops/sec, higher is better. Full table: benchmarks/RESULTS.md");
  return lines.join("\n");
}

/**
 * GitHub-flavoured Markdown matrix (operations × adapters) for the README.
 * Numeric columns are right-aligned and the fastest adapter per operation is
 * bolded; failed cases render as an em dash.
 */
export function renderMarkdown(results: AdapterResult[]): string {
  const caseNames = CASES.map((c) => c.name);
  const names = results.map((r) => r.adapterName);

  const lines: string[] = [
    "# Benchmark results",
    "",
    `- **Dataset:** ${INITIAL_DATASET_SIZE.toLocaleString("en-US")} documents`,
    `- **Runtime:** Node.js ${process.version}`,
    `- **Generated:** ${new Date().toISOString().slice(0, 10)}`,
    "",
    "All values in operations per second; higher is better. **Bold** = fastest adapter for that operation.",
    "",
    `| Operation | ${names.join(" | ")} |`,
    `| :--- | ${names.map(() => "---:").join(" | ")} |`
  ];

  for (const caseName of caseNames) {
    const values = results.map((r) => opsFor(r, caseName));
    const best = Math.max(...values);
    const cells = values.map((v) => {
      if (v < 0) return "—";
      const text = v.toLocaleString("en-US");
      return v === best ? `**${text}**` : text;
    });
    lines.push(`| ${caseName} | ${cells.join(" | ")} |`);
  }

  lines.push("");
  return lines.join("\n");
}

/** Machine-readable results for tooling / regression tracking. */
export function renderJson(results: AdapterResult[]): string {
  return JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      node: process.version,
      datasetSize: INITIAL_DATASET_SIZE,
      adapters: results.map((r) => r.adapterName),
      operations: CASES.map((c) => c.name),
      results: results.map((r) => ({
        adapter: r.adapterName,
        cases: Object.fromEntries(r.cases)
      }))
    },
    null,
    2
  );
}

/**
 * Writes `RESULTS.md` and `results.json` into the `benchmarks/` source folder
 * (resolved relative to this module, so it works regardless of cwd). Returns
 * the written paths for logging.
 */
export function writeResults(results: AdapterResult[]): { markdownPath: string; jsonPath: string } {
  const benchDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "benchmarks");
  const markdownPath = join(benchDir, "RESULTS.md");
  const jsonPath = join(benchDir, "results.json");

  writeFileSync(markdownPath, `${renderMarkdown(results)}\n`);
  writeFileSync(jsonPath, `${renderJson(results)}\n`);

  return { markdownPath, jsonPath };
}
