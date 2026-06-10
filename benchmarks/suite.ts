import type { Adapter } from "./adapters/adapter.js";
import { generateDoc, generateDocs } from "./data.js";

export const INITIAL_DATASET_SIZE = 1_000;

/**
 * A single benchmark case.
 *
 * The runner calls `prepare` once before the warmup phase. The returned value
 * (context) is passed to every `run` call. Use `prepare` to pre-insert
 * documents that the case will consume (e.g. for deleteOne).
 */
export interface BenchCase {
  /** Label shown in the results table. */
  name: string;
  /** Number of un-timed warmup calls before measurement begins. */
  warmup: number;
  /** Number of timed calls to measure. */
  iterations: number;
  /**
   * Optional pre-case setup. Receives the adapter and the ids inserted at
   * setup time. Returns a context value passed to every `run` call.
   */
  prepare?: (adapter: Adapter, initialIds: string[]) => unknown;
  /**
   * The operation under measurement. Called `warmup + iterations` times total.
   * `iteration` is the zero-based index within the timed phase only.
   */
  run(adapter: Adapter, iteration: number, context: unknown): void;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function pickId(ids: string[], iteration: number): string {
  return ids[iteration % ids.length];
}

// ---------------------------------------------------------------------------
// Benchmark cases
// ---------------------------------------------------------------------------

export const CASES: BenchCase[] = [
  {
    name: "insertOne",
    warmup: 100,
    iterations: 500,
    run(adapter, iteration) {
      adapter.insertOne(generateDoc(iteration));
    }
  },

  {
    name: "insertMany (100)",
    warmup: 10,
    iterations: 50,
    run(adapter, iteration) {
      adapter.insertMany(generateDocs(100).map((d, i) => ({ ...d, score: iteration * 100 + i })));
    }
  },

  {
    name: "findById",
    warmup: 100,
    iterations: 1_000,
    run(adapter, iteration, context) {
      adapter.findById(pickId(context as string[], iteration));
    }
  },

  {
    name: "findAll",
    warmup: 10,
    iterations: 50,
    run(adapter) {
      adapter.findAll();
    }
  },

  {
    name: "findByName (scan)",
    warmup: 50,
    iterations: 300,
    run(adapter, iteration) {
      // Names cycle through 8 values; pick a different one each iteration.
      const names = ["Ada", "Grace", "Margaret", "Hedy", "Katherine", "Dorothy", "Radia", "Barbara"];
      adapter.findByName(names[iteration % names.length]);
    }
  },

  {
    name: "findByNameRegex (scan)",
    warmup: 50,
    iterations: 300,
    run(adapter, iteration) {
      // Regex full-collection scan; patterns cycle to avoid engine-side caching bias.
      const patterns = ["^Ad", "race$", "^Ka.*e$", "a.+a"];
      adapter.findByNameRegex(patterns[iteration % patterns.length]);
    }
  },

  {
    name: "findByRole (index)",
    warmup: 100,
    iterations: 1_000,
    run(adapter, iteration) {
      const roles = ["admin", "editor", "reader"];
      adapter.findByRole(roles[iteration % roles.length]);
    }
  },

  {
    name: "updateOne",
    warmup: 100,
    iterations: 500,
    run(adapter, iteration, context) {
      adapter.updateOne(pickId(context as string[], iteration), iteration % 1000);
    }
  },

  {
    name: "deleteOne",
    warmup: 50,
    iterations: 300,
    prepare(adapter) {
      // Pre-insert exactly warmup + iterations documents so every call deletes
      // a real, existing document rather than a no-op.
      const ids: string[] = [];
      for (let i = 0; i < 50 + 300; i++) {
        ids.push(adapter.insertOne(generateDoc(i)));
      }
      return ids;
    },
    run(adapter, iteration, context) {
      adapter.deleteOne((context as string[])[iteration]);
    }
  },

  {
    name: "countAll",
    warmup: 500,
    iterations: 5_000,
    run(adapter) {
      adapter.countAll();
    }
  },

  {
    name: "sortByScore (desc)",
    warmup: 10,
    iterations: 50,
    run(adapter) {
      adapter.sortByScore();
    }
  }
];
