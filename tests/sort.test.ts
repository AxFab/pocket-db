import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pocketDb } from "../src/index.js";

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

// ─── helpers ────────────────────────────────────────────────────────────────

function pluck<T>(docs: Record<string, unknown>[], field: string): T[] {
  return docs.map((d) => d[field] as T);
}

// ─── ascending / descending on single types ──────────────────────────────────

describe("sort — string field", () => {
  it("sorts ascending", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([{ name: "charlie" }, { name: "alice" }, { name: "bob" }]);

    const names = pluck<string>(col.find().sort({ name: 1 }).toArray(), "name");
    assert.deepEqual(names, ["alice", "bob", "charlie"]);
    db.close();
  });

  it("sorts descending", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([{ name: "charlie" }, { name: "alice" }, { name: "bob" }]);

    const names = pluck<string>(col.find().sort({ name: -1 }).toArray(), "name");
    assert.deepEqual(names, ["charlie", "bob", "alice"]);
    db.close();
  });
});

describe("sort — number field", () => {
  it("sorts ascending", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([{ score: 30 }, { score: 10 }, { score: 20 }]);

    const scores = pluck<number>(col.find().sort({ score: 1 }).toArray(), "score");
    assert.deepEqual(scores, [10, 20, 30]);
    db.close();
  });

  it("sorts descending", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([{ score: 30 }, { score: 10 }, { score: 20 }]);

    const scores = pluck<number>(col.find().sort({ score: -1 }).toArray(), "score");
    assert.deepEqual(scores, [30, 20, 10]);
    db.close();
  });
});

describe("sort — boolean field", () => {
  it("sorts ascending: false before true", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([{ active: true }, { active: false }, { active: true }]);

    const flags = pluck<boolean>(col.find().sort({ active: 1 }).toArray(), "active");
    assert.deepEqual(flags, [false, true, true]);
    db.close();
  });

  it("sorts descending: true before false", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([{ active: true }, { active: false }, { active: true }]);

    const flags = pluck<boolean>(col.find().sort({ active: -1 }).toArray(), "active");
    assert.deepEqual(flags, [true, true, false]);
    db.close();
  });
});

describe("sort — _id field", () => {
  it("sorts by _id ascending (hex order = chronological)", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([{ v: 1 }, { v: 2 }, { v: 3 }]);

    const docs = col.find().sort({ _id: 1 }).toArray();
    const ids = pluck<string>(docs, "_id");
    const sorted = [...ids].sort();
    assert.deepEqual(ids, sorted);
    db.close();
  });

  it("sorts by _id descending", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([{ v: 1 }, { v: 2 }, { v: 3 }]);

    const docs = col.find().sort({ _id: -1 }).toArray();
    const ids = pluck<string>(docs, "_id");
    const sortedDesc = [...ids].sort().reverse();
    assert.deepEqual(ids, sortedDesc);
    db.close();
  });
});

// ─── multi-field sort ────────────────────────────────────────────────────────

describe("sort — multi-field", () => {
  it("applies secondary sort when primary values are equal", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([
      { role: "user", name: "zara" },
      { role: "admin", name: "bob" },
      { role: "user", name: "alice" },
      { role: "admin", name: "alice" },
    ]);

    const docs = col.find().sort({ role: 1, name: 1 }).toArray();
    assert.deepEqual(
      docs.map((d) => `${d.role}:${d.name}`),
      ["admin:alice", "admin:bob", "user:alice", "user:zara"]
    );
    db.close();
  });

  it("supports mixed directions across fields", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([
      { group: "a", score: 10 },
      { group: "b", score: 30 },
      { group: "a", score: 20 },
      { group: "b", score: 10 },
    ]);

    // group asc, score desc
    const docs = col.find().sort({ group: 1, score: -1 }).toArray();
    assert.deepEqual(
      docs.map((d) => `${d.group}:${d.score}`),
      ["a:20", "a:10", "b:30", "b:10"]
    );
    db.close();
  });

  it("accepts exactly 4 sort fields (the maximum)", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertOne({ a: 1, b: 2, c: 3, d: 4 });

    // Should not throw
    const docs = col.find().sort({ a: 1, b: -1, c: 1, d: -1 }).toArray();
    assert.equal(docs.length, 1);
    db.close();
  });
});

// ─── missing / null values ───────────────────────────────────────────────────

describe("sort — missing and null values", () => {
  it("missing field sorts first in ascending order", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([{ score: 20 }, { score: 10 }, {}]);

    const scores = pluck(col.find().sort({ score: 1 }).toArray(), "score");
    assert.deepEqual(scores, [undefined, 10, 20]);
    db.close();
  });

  it("missing field sorts last in descending order", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([{ score: 20 }, { score: 10 }, {}]);

    const scores = pluck(col.find().sort({ score: -1 }).toArray(), "score");
    assert.deepEqual(scores, [20, 10, undefined]);
    db.close();
  });

  it("null value sorts first in ascending order (same as missing)", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([{ score: 20 }, { score: null }, { score: 5 }]);

    const scores = pluck(col.find().sort({ score: 1 }).toArray(), "score");
    assert.deepEqual(scores, [null, 5, 20]);
    db.close();
  });

  it("null value sorts last in descending order (same as missing)", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([{ score: 20 }, { score: null }, { score: 5 }]);

    const scores = pluck(col.find().sort({ score: -1 }).toArray(), "score");
    assert.deepEqual(scores, [20, 5, null]);
    db.close();
  });
});

// ─── cross-type ordering ─────────────────────────────────────────────────────

describe("sort — cross-type ordering", () => {
  it("orders boolean < number < string across mixed documents", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([
      { val: "hello" },
      { val: 42 },
      { val: true },
    ]);

    const vals = pluck(col.find().sort({ val: 1 }).toArray(), "val");
    assert.deepEqual(vals, [true, 42, "hello"]);
    db.close();
  });
});

// ─── interaction with limit / skip ───────────────────────────────────────────

describe("sort — combined with limit and skip", () => {
  it("limit is applied after sort", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([{ n: 5 }, { n: 1 }, { n: 3 }, { n: 2 }, { n: 4 }]);

    const ns = pluck<number>(col.find().sort({ n: 1 }).limit(3).toArray(), "n");
    assert.deepEqual(ns, [1, 2, 3]);
    db.close();
  });

  it("skip is applied after sort", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([{ n: 5 }, { n: 1 }, { n: 3 }, { n: 2 }, { n: 4 }]);

    const ns = pluck<number>(col.find().sort({ n: 1 }).skip(2).toArray(), "n");
    assert.deepEqual(ns, [3, 4, 5]);
    db.close();
  });

  it("skip + limit together slice the sorted result", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([{ n: 5 }, { n: 1 }, { n: 3 }, { n: 2 }, { n: 4 }]);

    const ns = pluck<number>(col.find().sort({ n: 1 }).skip(1).limit(3).toArray(), "n");
    assert.deepEqual(ns, [2, 3, 4]);
    db.close();
  });

  it("skip + limit together slice a descending sorted result", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([{ n: 5 }, { n: 1 }, { n: 3 }, { n: 2 }, { n: 4 }]);

    // Sorted desc → [5, 4, 3, 2, 1]; skip 1 → [4, 3, 2, 1]; limit 3 → [4, 3, 2].
    const ns = pluck<number>(col.find().sort({ n: -1 }).skip(1).limit(3).toArray(), "n");
    assert.deepEqual(ns, [4, 3, 2]);
    db.close();
  });

  it("chaining order does not affect semantics: sort().limit().skip()", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([{ n: 5 }, { n: 1 }, { n: 3 }, { n: 2 }, { n: 4 }]);

    const a = pluck<number>(col.find().sort({ n: 1 }).skip(1).limit(3).toArray(), "n");
    const b = pluck<number>(col.find().limit(3).skip(1).sort({ n: 1 }).toArray(), "n");
    assert.deepEqual(a, b);
    db.close();
  });
});

// ─── count() is not affected by sort ─────────────────────────────────────────

describe("sort — interaction with count()", () => {
  it("count() returns total matches and does not trigger the sort", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([{ n: 3 }, { n: 1 }, { n: 2 }]);

    const cursor = col.find().sort({ n: 1 });
    assert.equal(cursor.count(), 3);

    // The sort buffer is built lazily — next() still works correctly after count()
    const first = cursor.next();
    assert.equal(first?.n, 1);
    db.close();
  });
});

// ─── sort combined with a query filter ───────────────────────────────────────

describe("sort — combined with query", () => {
  it("sorts only the documents that match the query", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([
      { role: "admin", score: 5 },
      { role: "user",  score: 3 },
      { role: "user",  score: 7 },
      { role: "admin", score: 1 },
    ]);

    const docs = col.find({ role: "user" }).sort({ score: -1 }).toArray();
    assert.deepEqual(pluck<number>(docs, "score"), [7, 3]);
    db.close();
  });
});

// ─── validation errors ───────────────────────────────────────────────────────

describe("sort — validation", () => {
  it("throws when sort specification is empty", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertOne({ x: 1 });

    assert.throws(
      () => col.find().sort({} as Record<string, 1 | -1>),
      /at least one field/
    );
    db.close();
  });

  it("throws when more than 4 fields are specified", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertOne({ a: 1 });

    assert.throws(
      () => col.find().sort({ a: 1, b: 1, c: 1, d: 1, e: 1 } as Record<string, 1 | -1>),
      /cannot exceed 4/
    );
    db.close();
  });

  it("throws when direction is not 1 or -1", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertOne({ x: 1 });

    assert.throws(
      () => col.find().sort({ x: 0 } as unknown as Record<string, 1 | -1>),
      /direction must be 1.*-1/
    );
    db.close();
  });

  it("throws when a sorted field contains an array value", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([{ tags: ["a", "b"] }, { tags: ["c"] }]);

    assert.throws(
      () => col.find().sort({ tags: 1 }).toArray(),
      /array.*not supported/i
    );
    db.close();
  });

  it("throws when a sorted field contains an object value", () => {
    const db = pocketDb({ path: join(createTempDirectory(), "test.pdb") });
    const col = db.collection("items");
    col.insertMany([{ meta: { x: 1 } }, { meta: { x: 2 } }]);

    assert.throws(
      () => col.find().sort({ meta: 1 }).toArray(),
      /object.*not supported/i
    );
    db.close();
  });
});
