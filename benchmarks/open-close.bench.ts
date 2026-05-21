import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { open } from "../src/index.js";

const iterations = 1_000;
const directory = mkdtempSync(join(tmpdir(), "pocket-db-bench-"));
const path = join(directory, "bench.pdb");

try {
  const start = performance.now();

  for (let index = 0; index < iterations; index += 1) {
    const db = open({ path });
    db.close();
  }

  const duration = performance.now() - start;
  console.log(`open/close x ${iterations}: ${duration.toFixed(2)}ms`);
} finally {
  rmSync(directory, { recursive: true, force: true });
}
