import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pocketDb } from "../src/index.js";
import type { Collection } from "../src/index.js";

const tempDirectories: string[] = [];

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pocket-db-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

/**
 * Wraps a collection's internal `FileStorage` with call counters for
 * `readBulkRange` (the whole-candidate-span pre-load) and
 * `readOperationAtOffset` (the per-record fallback), so tests can assert
 * *which* read strategy the cursor actually used instead of only checking
 * the returned documents are correct.
 */
function spyOnStorageReads(collection: Collection): { bulkReadCalls: number; perRecordReadCalls: number } {
  const storage = (collection as any).storage;
  const counts = { bulkReadCalls: 0, perRecordReadCalls: 0 };

  const originalReadBulkRange = storage.readBulkRange.bind(storage);
  storage.readBulkRange = (offsets: readonly number[]) => {
    counts.bulkReadCalls += 1;
    return originalReadBulkRange(offsets);
  };

  const originalReadOperationAtOffset = storage.readOperationAtOffset.bind(storage);
  storage.readOperationAtOffset = (offset: number) => {
    counts.perRecordReadCalls += 1;
    return originalReadOperationAtOffset(offset);
  };

  return counts;
}

describe("Cursor lazy/adaptive bulk-range read", () => {
  it("findOne()-style limit(1) on a large unindexed high-match query avoids the full-span bulk read", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");

    // 500 candidates, every one matches — the very first candidate read
    // should already satisfy limit(1), so only one small per-record read is
    // needed instead of a bulk read sized for all 500.
    for (let i = 0; i < 500; i += 1) {
      users.insertOne({ tag: "match", index: i });
    }

    const counts = spyOnStorageReads(users);

    const result = users.find({ tag: "match" }).limit(1).next();

    assert.notEqual(result, null);
    assert.equal(result?.index, 0);
    assert.equal(counts.bulkReadCalls, 0, "limit(1) on a high-match query must not trigger a full bulk read");
    assert.equal(counts.perRecordReadCalls, 1, "only the single matching candidate should be read");

    db.close();
  });

  it("findOne() (collection method) gets the same lazy benefit as find().limit(1)", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");

    for (let i = 0; i < 500; i += 1) {
      users.insertOne({ tag: "match", index: i });
    }

    const counts = spyOnStorageReads(users);

    const result = users.findOne({ tag: "match" });

    assert.notEqual(result, null);
    assert.equal(counts.bulkReadCalls, 0);
    assert.equal(counts.perRecordReadCalls, 1);

    db.close();
  });

  it("toArray() without a limit still uses a single bulk read for large candidate sets (no regression)", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");

    for (let i = 0; i < 500; i += 1) {
      users.insertOne({ tag: "match", index: i });
    }

    const counts = spyOnStorageReads(users);

    const documents = users.find({ tag: "match" }).toArray();

    assert.equal(documents.length, 500);
    assert.equal(counts.bulkReadCalls, 1, "an unbounded scan should still pre-load the whole candidate range once");
    assert.equal(counts.perRecordReadCalls, 0);

    db.close();
  });

  it("count() forces the full bulk read even when a limit is set (count ignores limit)", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");

    for (let i = 0; i < 500; i += 1) {
      users.insertOne({ tag: i % 2 === 0 ? "match" : "other", index: i });
    }

    const counts = spyOnStorageReads(users);

    const cursor = users.find({ tag: "match" }).limit(1);
    const total = cursor.count();

    assert.equal(total, 250);
    assert.equal(counts.bulkReadCalls, 1, "count() must force the deferred bulk-read decision regardless of limit");
    assert.equal(counts.perRecordReadCalls, 0);

    db.close();
  });

  it("sort() forces the full bulk read even when a limit is set (sort always reads every match)", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");

    for (let i = 0; i < 500; i += 1) {
      users.insertOne({ tag: "match", index: 499 - i });
    }

    const counts = spyOnStorageReads(users);

    const documents = users.find({ tag: "match" }).sort({ index: 1 }).limit(1).toArray();

    assert.deepEqual(documents.map((d) => d.index), [0]);
    assert.equal(counts.bulkReadCalls, 1, "sort() must force the deferred bulk-read decision regardless of limit");
    assert.equal(counts.perRecordReadCalls, 0);

    db.close();
  });

  it("escalates to a bulk read for the remainder when a small limit's match is never found via per-record reads", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");

    // Enough non-matching candidates to exceed the escalation cap before a
    // limit(1) query on a field nothing has would ever be satisfied via
    // per-record reads alone.
    for (let i = 0; i < 1000; i += 1) {
      users.insertOne({ tag: "other", index: i });
    }

    const counts = spyOnStorageReads(users);

    const result = users.find({ tag: "nonexistent" }).limit(1).next();

    assert.equal(result, null);
    assert.equal(counts.bulkReadCalls, 1, "a rare/absent match under a limit must still escalate to a bulk read");
    // Escalation must kick in well before scanning every candidate one at a time.
    assert.ok(
      counts.perRecordReadCalls > 0 && counts.perRecordReadCalls < 1000,
      `expected escalation before exhausting all candidates individually, got ${counts.perRecordReadCalls} per-record reads`
    );

    db.close();
  });

  it("small collections (below the pre-load threshold) never bulk-read regardless of limit", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.insertOne({ name: "Ada" });

    const counts = spyOnStorageReads(users);

    const result = users.find({}).toArray();

    assert.equal(result.length, 1);
    assert.equal(counts.bulkReadCalls, 0);
    assert.equal(counts.perRecordReadCalls, 1);

    db.close();
  });

  it("returns correct results across skip + limit combinations while deferring the bulk read", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");

    for (let i = 0; i < 500; i += 1) {
      users.insertOne({ tag: "match", index: i });
    }

    const counts = spyOnStorageReads(users);

    const documents = users.find({ tag: "match" }).skip(2).limit(3).toArray();

    assert.deepEqual(documents.map((d) => d.index), [2, 3, 4]);
    assert.equal(counts.bulkReadCalls, 0);
    assert.equal(counts.perRecordReadCalls, 5);

    db.close();
  });
});
