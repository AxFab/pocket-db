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
  /** Median ops/sec across all runs (see {@link aggregateSamples}). */
  opsPerSecond: number;
  /** totalMs of whichever run's opsPerSecond is closest to the median. */
  totalMs: number;
  iterations: number;
  /** Number of independent samples this result is aggregated from. */
  runs: number;
  minOpsPerSecond: number;
  maxOpsPerSecond: number;
}

interface AdapterResult {
  adapterName: string;
  cases: Map<string, CaseResult>;
}

// ---------------------------------------------------------------------------
// Core timing
// ---------------------------------------------------------------------------

/** A single warmup+measure sample for one case, before aggregation across runs. */
interface RawSample {
  opsPerSecond: number;
  totalMs: number;
  iterations: number;
}

function runCase(adapter: Adapter, benchCase: BenchCase, initialIds: string[]): RawSample {
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

/**
 * Folds N raw samples for one case into a single {@link CaseResult}, using
 * the median ops/sec (robust to a single GC-pause/scheduler-blip outlier,
 * unlike the mean) plus the min/max spread so callers can see how much
 * variance was actually smoothed over. Failed samples (`opsPerSecond < 0`)
 * are excluded from the statistics; if every sample failed, the result
 * reports the error state.
 */
function aggregateSamples(samples: RawSample[]): CaseResult {
  const valid = samples.filter((s) => s.opsPerSecond >= 0);

  if (valid.length === 0) {
    return { opsPerSecond: -1, totalMs: 0, iterations: 0, runs: samples.length, minOpsPerSecond: -1, maxOpsPerSecond: -1 };
  }

  const sortedOps = valid.map((s) => s.opsPerSecond).sort((a, b) => a - b);
  const mid = Math.floor(sortedOps.length / 2);
  const median = sortedOps.length % 2 === 0
    ? Math.round((sortedOps[mid - 1] + sortedOps[mid]) / 2)
    : sortedOps[mid];

  // totalMs/iterations are reported from whichever sample's opsPerSecond is
  // closest to the median — there's no single "median sample" when medians
  // are averaged across an even count, so this picks the most representative
  // real sample rather than fabricating one.
  const representative = valid.reduce((a, b) =>
    Math.abs(a.opsPerSecond - median) <= Math.abs(b.opsPerSecond - median) ? a : b
  );

  return {
    opsPerSecond: median,
    totalMs: representative.totalMs,
    iterations: representative.iterations,
    runs: samples.length,
    minOpsPerSecond: sortedOps[0],
    maxOpsPerSecond: sortedOps[sortedOps.length - 1]
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RunBenchmarksOptions {
  /**
   * Number of independent samples to collect per case, in this same process.
   * Each run is a full `adapter.setup()` → all cases → `adapter.teardown()`
   * cycle, not just a repeat of the measured loop in isolation — several
   * cases (e.g. `deleteOne`, which pre-inserts exactly `warmup + iterations`
   * documents once via `prepare()`) depend on starting from a fresh adapter
   * state, so re-running only the timed portion would silently measure a
   * cheaper, partially-drained case on the second and later repeats.
   *
   * Reported ops/sec is the median across runs (see {@link aggregateSamples}).
   * Defaults to `1` (today's behavior — a single sample, no aggregation).
   */
  runs?: number;
}

export function runBenchmarks(adapters: Adapter[], options: RunBenchmarksOptions = {}): AdapterResult[] {
  const runs = Math.max(1, Math.floor(options.runs ?? 1));
  const results: AdapterResult[] = [];
  const initialDocs = generateDocs(INITIAL_DATASET_SIZE);

  for (const adapter of adapters) {
    process.stdout.write(`  ${adapter.name.padEnd(16)} `);

    const samplesByCase = new Map<string, RawSample[]>();
    let setupFailed = false;

    for (let run = 0; run < runs; run++) {
      let initialIds: string[];
      try {
        initialIds = adapter.setup(initialDocs);
      } catch (error) {
        process.stdout.write(`[setup failed: ${(error as Error).message}]\n`);
        setupFailed = true;
        break;
      }

      for (const benchCase of CASES) {
        const existing = samplesByCase.get(benchCase.name) ?? [];

        try {
          existing.push(runCase(adapter, benchCase, initialIds));
          process.stdout.write(".");
        } catch {
          existing.push({ opsPerSecond: -1, totalMs: 0, iterations: 0 });
          process.stdout.write("!");
        }

        samplesByCase.set(benchCase.name, existing);
      }

      adapter.teardown();
    }

    if (setupFailed) {
      continue;
    }

    process.stdout.write(`${runs > 1 ? ` (${runs} runs)` : ""} done\n`);

    const caseResults = new Map<string, CaseResult>();
    for (const [caseName, samples] of samplesByCase) {
      caseResults.set(caseName, aggregateSamples(samples));
    }

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
 * Formats the min–max spread around the median as a single `±X%` figure —
 * the larger of the two-sided deviations, so it reads as "the worst-case
 * distance from the reported number," not an average. Returns `""` when
 * there's only one run (nothing to show) or the case errored.
 */
function spreadFor(result: AdapterResult, caseName: string): string {
  const c = result.cases.get(caseName);
  if (!c || c.runs <= 1 || c.opsPerSecond <= 0) return "";

  const belowPct = ((c.opsPerSecond - c.minOpsPerSecond) / c.opsPerSecond) * 100;
  const abovePct = ((c.maxOpsPerSecond - c.opsPerSecond) / c.opsPerSecond) * 100;
  const worst = Math.max(belowPct, abovePct);

  return `±${worst.toFixed(1)}%`;
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

  const anyMultiRun = results.some((r) => [...r.cases.values()].some((c) => c.runs > 1));

  for (const caseName of caseNames) {
    const rows = results
      .map((r) => ({ name: r.adapterName, ops: opsFor(r, caseName), spread: spreadFor(r, caseName) }))
      .sort((a, b) => b.ops - a.ops); // fastest first; errors (-1) sink to the bottom

    const maxOps = Math.max(0, ...rows.map((r) => r.ops));
    const numWidth = Math.max(...rows.map((r) => formatOps(r.ops).length));
    // Bar width still budgets against the plain number column — the spread
    // suffix rides after the bar and isn't part of the aligned grid, since
    // its width varies per row and would otherwise force every bar shorter
    // than necessary on runs where most cases happen to be low-variance.
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

      const suffix = row.spread ? `  ${row.spread}` : "";
      lines.push(`  ${name}  ${num} ${bar}${suffix}`.trimEnd());
    }

    lines.push("");
  }

  lines.push("ops/sec, higher is better. Full table: benchmarks/RESULTS.md");
  if (anyMultiRun) {
    lines.push("±X% = worst-case spread (min/max vs. the reported median) across repeated runs.");
  }
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
  const maxRuns = Math.max(1, ...results.flatMap((r) => [...r.cases.values()].map((c) => c.runs)));

  const lines: string[] = [
    "# Benchmark results",
    "",
    `- **Dataset:** ${INITIAL_DATASET_SIZE.toLocaleString("en-US")} documents`,
    `- **Runtime:** Node.js ${process.version}`,
    `- **Generated:** ${new Date().toISOString().slice(0, 10)}`,
    ...(maxRuns > 1 ? [`- **Runs per case:** up to ${maxRuns} (median reported, ± worst-case spread shown per cell)`] : []),
    "",
    "All values in operations per second; higher is better. **Bold** = fastest adapter for that operation.",
    "",
    `| Operation | ${names.join(" | ")} |`,
    `| :--- | ${names.map(() => "---:").join(" | ")} |`
  ];

  for (const caseName of caseNames) {
    const values = results.map((r) => opsFor(r, caseName));
    const best = Math.max(...values);
    const cells = results.map((r) => {
      const v = opsFor(r, caseName);
      if (v < 0) return "—";
      const text = v.toLocaleString("en-US");
      const spread = spreadFor(r, caseName);
      const withSpread = spread ? `${text} (${spread})` : text;
      return v === best ? `**${withSpread}**` : withSpread;
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
  // This module already lives in benchmarks/, so its own directory *is* the
  // target — no need to walk up and back down (a previous version did
  // `join(..., "..", "..", "benchmarks")`, which resolves one level too high
  // and writes outside the project entirely, e.g. `<parent>/benchmarks/`
  // instead of `<project>/benchmarks/`).
  const benchDir = dirname(fileURLToPath(import.meta.url));
  const markdownPath = join(benchDir, "RESULTS.md");
  const jsonPath = join(benchDir, "results.json");

  writeFileSync(markdownPath, `${renderMarkdown(results)}\n`);
  writeFileSync(jsonPath, `${renderJson(results)}\n`);

  return { markdownPath, jsonPath };
}
