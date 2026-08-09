/**
 * Large-scale, real-data benchmark.
 *
 * Unlike `bench.ts` (synthetic 1,000-document dataset, pocket-db vs. other
 * engines), this script measures pocket-db alone against real, multi-hundred-
 * megabyte to multi-gigabyte `.pdb` files, to answer one question: does
 * pocket-db still feel fast once a database is far bigger than anything the
 * micro-benchmark suite exercises?
 *
 * READ-ONLY by default — no insert/update/delete/compact is performed, so the
 * source files are never mutated (only the small `.lock` file that every
 * `open()` creates and removes is touched). Pass `--rebuild-indexes` to
 * additionally measure index rebuild cost by actually dropping and recreating
 * every existing index (see the "Index rebuild timing" case below) — that
 * flag DOES mutate the target file; run it against a copy.
 *
 * Every case here is a "long operation" in the terms of the project: things
 * that only show up once a database has millions of records and hundreds of
 * thousands of documents per collection — replay time at open(), index
 * rebuild cost, the forward scan behind `stats()`, and worst-case unindexed
 * lookups.
 *
 * Usage:
 *   npm run bench:large                            # benchmarks/genealogy.pdb + genealogy2.pdb
 *   npm run bench:large -- --rebuild-indexes        # same, plus index rebuild timing (mutates)
 *   node --import tsx large-scale.ts <path>...      # explicit file(s), any location
 *
 * The two datasets this was built against are real genealogy exports
 * (individuals/families/places/medias/sources) that are gitignored (see
 * `benchmarks/*.pdb` — too large to check in). If neither default file is
 * present the script prints a short message and exits cleanly instead of
 * failing, so `npm run bench:large` is harmless on a checkout that doesn't
 * have them.
 *
 * Two scaling issues were found and fixed while building this (see
 * `docs/adr/0016-bounded-candidate-range-read.md` and
 * `docs/adr/0017-streaming-replay-buffer.md`): `open()` used to read the
 * entire log into one Buffer (peaked at ~3x file size resident — a ~1.9GB
 * file OOM-killed an open() on a 3.8GB-RAM machine), and `find()` used to
 * pre-load the *entire file* for any query with 2+ candidates regardless of
 * where those candidates actually lived in it. Both are now bounded to what
 * the operation actually needs. `rebuildIndex()`/`refreshIndexesAfterCompaction()`
 * were also switched from one `readSync` per existing document to a single
 * bulk range read, which is what the "Index rebuild timing" case below
 * measures directly.
 */
import { existsSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pocketDb } from "../src/index.js";
import type { Database } from "../src/api/types.js";

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/** Wall-clock timing for a synchronous block, in milliseconds. */
function timeMs<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

/**
 * Runs `fn` `iterations` times and reports min/mean/p95/max latency in
 * milliseconds plus ops/sec. Used for cheap, repeatable operations (primary
 * key lookups) where a single call is too fast to time meaningfully.
 */
function timeMany(iterations: number, fn: (i: number) => void): { minMs: number; meanMs: number; p95Ms: number; maxMs: number; opsPerSecond: number } {
  const samples: number[] = [];

  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    fn(i);
    samples.push(performance.now() - start);
  }

  samples.sort((a, b) => a - b);
  const total = samples.reduce((a, b) => a + b, 0);
  const p95 = samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))];

  return {
    minMs: samples[0],
    meanMs: total / samples.length,
    p95Ms: p95,
    maxMs: samples[samples.length - 1],
    opsPerSecond: Math.round((iterations / total) * 1_000)
  };
}

function fmtMs(ms: number): string {
  return ms < 1 ? `${(ms * 1000).toFixed(0)}µs` : ms < 1000 ? `${ms.toFixed(2)}ms` : `${(ms / 1000).toFixed(2)}s`;
}

function fmtBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

// ---------------------------------------------------------------------------
// Report accumulation — printed incrementally and written to a Markdown file
// after every section, not just at the end. A multi-gigabyte file can
// plausibly exceed available RAM partway through a dataset's cases (not just
// at open() — see the "Peak RSS" case), which kills the process outright with
// no chance to run cleanup code; writing after each section is the only way
// to guarantee results already computed aren't lost when that happens.
// ---------------------------------------------------------------------------

const reportSections: string[] = [];

function section(title: string, lines: string[]): void {
  const block = [`## ${title}`, "", ...lines, ""].join("\n");
  reportSections.push(block);
  console.log(`\n${title}`);
  console.log("-".repeat(title.length));
  for (const line of lines) console.log(line);
  writeReport();
}

function writeReport(): void {
  const benchDir = dirname(fileURLToPath(import.meta.url));
  const path = join(benchDir, "LARGE-SCALE-RESULTS.md");
  const header = [
    "# Large-scale benchmark results",
    "",
    `- **Node.js:** ${process.version}`,
    `- **Platform:** ${process.platform}/${process.arch}`,
    `- **Generated:** ${new Date().toISOString()}`,
    "",
    "Read-only benchmark against real `.pdb` files, run once per dataset in a fresh process is",
    "recommended (open() cost/memory is cumulative across datasets otherwise). See `large-scale.ts`.",
    ""
  ].join("\n");
  writeFileSync(path, `${header}\n${reportSections.join("\n")}`);
}

// ---------------------------------------------------------------------------
// Per-dataset benchmark
// ---------------------------------------------------------------------------

/** Number of repeated primary-key lookups used to get a stable latency read. */
const PK_LOOKUP_ITERATIONS = 500;

/** How many sample ids to pull per collection for the primary-key lookup case. */
const PK_SAMPLE_SIZE = 200;

function benchmarkDataset(path: string, options: { measureIndexRebuild: boolean }): void {
  if (!existsSync(path)) {
    console.log(`\nSkipping ${path} (file not found).`);
    return;
  }

  console.log(`\n${"=".repeat(70)}\n${path}\n${"=".repeat(70)}`);

  // --- open() : replay time + peak memory --------------------------------
  // open() is synchronous and blocks the event loop for its whole duration,
  // so there's no way to sample RSS *during* the call from the same process;
  // `process.resourceUsage().maxRSS` is the OS-reported high-water mark for
  // the whole process since it started, which is what we want here since
  // this script does nothing memory-heavy before open() runs.
  let db: Database;
  const rssBefore = process.memoryUsage().rss;
  const { ms: openMs } = timeMs(() => {
    db = pocketDb({ path });
  });
  const memAfterOpen = process.memoryUsage();
  const peakRssKb = process.resourceUsage().maxRSS;

  section("open() — replay & index rebuild", [
    `time: ${fmtMs(openMs)}`,
    `rss before open(): ${fmtBytes(rssBefore)}`,
    `rss right after open(): ${fmtBytes(memAfterOpen.rss)}`,
    `peak RSS since process start: ${fmtBytes(peakRssKb * 1024)}`,
    `(peak RSS ÷ file size on disk gives a rough memory multiplier for capacity planning)`
  ]);

  const collectionNames = db!.getCollections();

  // --- collection / index introspection -----------------------------------
  const collectionInfo = collectionNames.map((name) => {
    const coll = db!.collection(name);
    const { result: count, ms: countMs } = timeMs(() => coll.find().count());
    return { name, coll, count, countMs, indexes: coll.getIndexes() };
  });

  section(
    "Collections & indexes",
    collectionInfo.map(
      (c) =>
        `${c.name}: ${fmtNum(c.count)} documents, ${c.indexes.length} index(es)` +
        (c.indexes.length ? ` [${c.indexes.map((i) => `${i.name}:${i.type}${i.unique ? " unique" : ""}`).join(", ")}]` : "") +
        ` — count() in ${fmtMs(c.countMs)}`
    )
  );

  // --- index rebuild timing (opt-in, MUTATES the file) ---------------------
  // Answers "how long would rebuilding this collection's indexes take?" by
  // actually doing it: drop then recreate each existing index and time the
  // createIndex() call. This is what both createIndex() on an already-populated
  // collection and replaying an `idx1` record for one mid-log actually do
  // internally (see `rebuildIndex()` in `src/api/collection.ts`) — replay
  // itself isn't separately instrumented, so this is the closest read of that
  // cost without modifying the library. Opt-in and off by default: unlike
  // every other case in this file, it appends dix1/idx1 records to the target
  // file. Run against a copy, not your primary database.
  if (options.measureIndexRebuild) {
    const rebuildLines: string[] = [];

    for (const c of collectionInfo) {
      for (const index of c.indexes) {
        c.coll.dropIndex(index.name);
        const { ms } = timeMs(() => c.coll.createIndex(index.name, { type: index.type as "string" | "number", unique: index.unique }));
        const perDoc = c.count > 0 ? (ms / c.count) * 1000 : 0;
        rebuildLines.push(
          `${c.name}.${index.name} (${index.type}, ${fmtNum(c.count)} docs): ${fmtMs(ms)} (${perDoc.toFixed(2)}µs/doc)`
        );
      }
    }

    if (rebuildLines.length > 0) {
      section("Index rebuild timing (--rebuild-indexes, MUTATED this file)", [
        "Each line: dropIndex() then createIndex() on an already-populated collection, timed.",
        "This is exactly the work replaying an idx1 record does for indexes created after a",
        "collection already had data (see docs/adr/0003-replay-based-startup.md's documented",
        "O(documents × indexes) startup cost) — open() itself pays this once per index, per open.",
        "",
        ...rebuildLines
      ]);
    } else {
      section("Index rebuild timing (--rebuild-indexes)", ["No secondary indexes exist on this dataset — nothing to rebuild."]);
    }
  }

  // --- primary-key lookups -------------------------------------------------
  // Run the lookup/scan cases (this section and the two below) before
  // db.stats() further down: db.stats() does a full bulk read of the entire
  // log (a multi-hundred-MB to multi-GB allocation) which puts real memory
  // pressure on the process and triggers extra GC pauses that would otherwise
  // bleed into these timings. Measuring lookups first, while the process is
  // still "cool" right after open(), gives a cleaner read on their true cost.
  // Pick the largest collection: the one where an O(1) offset lookup mattering
  // is most visible against the alternative (a full scan, see below).
  const largest = collectionInfo.reduce((a, b) => (b.count > a.count ? b : a));
  const sampleDocs = largest.coll.find().limit(PK_SAMPLE_SIZE).toArray();
  const sampleIds = sampleDocs.map((d) => d._id as string);

  if (sampleIds.length > 0) {
    const pk = timeMany(PK_LOOKUP_ITERATIONS, (i) => {
      largest.coll.findOne({ _id: sampleIds[i % sampleIds.length] });
    });

    section(`findOne by _id — "${largest.name}" (${fmtNum(largest.count)} docs, primary index)`, [
      `${PK_LOOKUP_ITERATIONS} lookups: mean ${fmtMs(pk.meanMs)}, p95 ${fmtMs(pk.p95Ms)}, max ${fmtMs(pk.maxMs)} (${fmtNum(pk.opsPerSecond)} ops/sec)`,
      `Expected to stay ~flat regardless of collection size (Map lookup + one readSync at a known offset).`
    ]);
  }

  // --- unindexed full-collection scans -------------------------------------
  // A field name guaranteed to exist on no real document, so the "not found"
  // case always forces a genuine full scan (IndexManager.plan() never finds
  // an index for it, on either dataset) regardless of what happens to be
  // indexed on a given collection.
  const NEVER_INDEXED_FIELD = "__pocketdb_bench_unindexed_probe__";

  // IMPORTANT: which field is "indexed" varies *per collection* in the
  // dataset this was built against (individuals/families/sources index
  // `uuid`, but places indexes `uid` and medias indexes `url` — all of which
  // also happen to carry a `uuid` field that ISN'T indexed there). Querying
  // the same field name for every collection would silently mix index-assisted
  // and full-scan results without saying so. Each collection's own index list
  // (from the "Collections & indexes" section above) is consulted explicitly
  // below instead of assuming a field name.
  const unindexedLines: string[] = [];
  const indexedLines: string[] = [];

  for (const c of collectionInfo) {
    const sample = c.coll.find().limit(1).toArray()[0];
    if (!sample) continue;

    const indexedFieldNames = new Set(c.indexes.map((index) => index.name));

    const notFound = timeMs(() => c.coll.findOne({ [NEVER_INDEXED_FIELD]: "x" }));
    const unindexedField = Object.keys(sample).find(
      (key) => key !== "_id" && !indexedFieldNames.has(key) && typeof sample[key] === "string"
    );

    if (unindexedField) {
      const last = c.count > 1 ? c.coll.find().skip(c.count - 1).limit(1).toArray()[0] : null;
      const foundFirst = timeMs(() => c.coll.findOne({ [unindexedField]: sample[unindexedField] }));
      const foundLast = last ? timeMs(() => c.coll.findOne({ [unindexedField]: last[unindexedField] })) : null;

      unindexedLines.push(
        `${c.name} (${fmtNum(c.count)} docs) on "${unindexedField}" (not indexed): found-first ${fmtMs(foundFirst.ms)}` +
          (foundLast ? `, found-last ${fmtMs(foundLast.ms)}` : "") +
          `, not-found ${fmtMs(notFound.ms)}`
      );
    } else {
      unindexedLines.push(
        `${c.name} (${fmtNum(c.count)} docs): no unindexed string field to probe — not-found ${fmtMs(notFound.ms)}`
      );
    }

    if (c.indexes.length > 0) {
      const indexField = c.indexes[0].name;
      const value = sample[indexField];
      if (value !== undefined) {
        const foundIndexed = timeMs(() => c.coll.findOne({ [indexField]: value }));
        const notFoundIndexed = timeMs(() => c.coll.findOne({ [indexField]: "__does_not_exist__" }));
        indexedLines.push(
          `${c.name} (${fmtNum(c.count)} docs) on "${indexField}" (${c.indexes[0].type} index): ` +
            `found ${fmtMs(foundIndexed.ms)}, not-found ${fmtMs(notFoundIndexed.ms)}`
        );
      }
    }
  }

  section("Unindexed find() — full collection scan fallback", [
    "Every lookup below queries a field with no secondary index on that specific collection, so",
    "IndexManager.plan() falls back to scanning and decoding candidates from the primary index",
    "snapshot — from the start until a match, or (not-found) to the very end.",
    "",
    ...unindexedLines
  ]);

  if (indexedLines.length > 0) {
    section("Indexed find() — same shape of query, but on this collection's actual index", [
      "Same found/not-found comparison as above, but on the field this collection is actually",
      "indexed on — the contrast against the unindexed numbers is the whole point of having an index.",
      "",
      ...indexedLines
    ]);
  }

  // --- filtered count (non-indexed field) — cross-check against the scan ---
  // count() with a non-match-all query always scans every candidate (there is
  // no early exit — it has to check all of them to get an exact count), so it
  // should land in the same ballpark as the "not found" case above.
  const withSex = collectionInfo.find((c) => "sex" in (c.coll.find().limit(1).toArray()[0] ?? {}));
  if (withSex) {
    const { result: femaleCount, ms } = timeMs(() => withSex.coll.countDocuments({ sex: "F" }));
    section(`countDocuments({ sex: "F" }) — "${withSex.name}" (unindexed filter)`, [
      `${fmtNum(femaleCount)} / ${fmtNum(withSex.count)} matched in ${fmtMs(ms)}`
    ]);
  }

  // --- db.stats() : forward log scan --------------------------------------
  const { result: dbStats, ms: statsMs } = timeMs(() => db!.stats());
  const deadPct = ((dbStats.deadBytes / dbStats.sizeOnDisk) * 100).toFixed(1);

  section("db.stats() — full forward scan of the log", [
    `time: ${fmtMs(statsMs)}`,
    `size on disk: ${fmtBytes(dbStats.sizeOnDisk)}`,
    `operations: ${fmtNum(dbStats.operationCount)} total, ${fmtNum(dbStats.tombstoneCount)} superseded/dead`,
    `live bytes: ${fmtBytes(dbStats.liveBytes)}, dead bytes: ${fmtBytes(dbStats.deadBytes)} (${deadPct}% of file — reclaimable by compact())`,
    `documents: ${fmtNum(dbStats.documentCount)} across ${dbStats.collectionCount} collections`
  ]);

  // --- eager sort ------------------------------------------------------------
  // sort() always reads every matching candidate into memory before returning
  // the first result (no sorted index). Running it against the *largest*
  // collection is the realistic worst case for this dataset; smaller
  // collections are included for comparison at a scale where a full sort is
  // obviously safe.
  const sortTargets = collectionInfo
    .filter((c) => c.count > 0)
    .sort((a, b) => a.count - b.count);

  const sortLines: string[] = [];
  for (const c of sortTargets) {
    const sample = c.coll.find().limit(1).toArray()[0];
    const sortField = ["title", "label", "name"].find((f) => typeof sample?.[f] === "string");
    if (!sortField) continue;

    const { result: sorted, ms } = timeMs(() => c.coll.find().sort({ [sortField]: 1 }).limit(1).toArray());
    sortLines.push(`${c.name} (${fmtNum(c.count)} docs) sorted by "${sortField}": ${fmtMs(ms)} (first: ${JSON.stringify(sorted[0]?.[sortField])})`);
  }

  if (sortLines.length > 0) {
    section("Eager sort() — reads & buffers every candidate before returning", sortLines);
  }

  db!.close();
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const benchDir = dirname(fileURLToPath(import.meta.url));
const rawArgs = process.argv.slice(2);
const measureIndexRebuild = rawArgs.includes("--rebuild-indexes");
const explicitPaths = rawArgs.filter((arg) => !arg.startsWith("--"));
const paths = explicitPaths.length > 0
  ? explicitPaths.map((p) => resolve(p))
  : [join(benchDir, "genealogy.pdb"), join(benchDir, "genealogy2.pdb")];

const anyPresent = paths.some(existsSync);
if (!anyPresent) {
  console.log(
    "No large-scale dataset found (looked for: " + paths.join(", ") + ").\n" +
    "This benchmark is meant to run against real, gitignored .pdb files that aren't part of the repo.\n" +
    "Pass explicit path(s) to run it against your own data: node --import tsx large-scale.ts <path>..."
  );
  process.exit(0);
}

if (measureIndexRebuild) {
  console.log(
    "--rebuild-indexes: this run WILL mutate every target file (drop + recreate each existing\n" +
    "index). Run against a copy if you don't want that.\n"
  );
}

for (const path of paths) {
  // section() already writes the report after every case (see above), so
  // nothing extra is needed here for a crash mid-dataset to still leave a
  // report with everything computed so far.
  benchmarkDataset(path, { measureIndexRebuild });
}

console.log(`\nFull report written to:\n  ${join(benchDir, "LARGE-SCALE-RESULTS.md")}`);
