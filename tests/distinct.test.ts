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

describe("collection.distinct()", () => {
  it("returns an empty array on an empty collection", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const col = db.collection("items");

    assert.deepEqual(col.distinct("role"), []);

    db.close();
  });

  it("returns each distinct scalar value once, in first-seen order", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const col = db.collection("items");

    col.insertMany([
      { role: "admin" },
      { role: "user" },
      { role: "admin" },
      { role: "guest" },
      { role: "user" }
    ]);

    assert.deepEqual(col.distinct("role"), ["admin", "user", "guest"]);

    db.close();
  });

  it("distinguishes values by type, not just loose value", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const col = db.collection("items");

    col.insertMany([
      { v: 1 },
      { v: "1" },
      { v: true },
      { v: null }
    ]);

    const values = col.distinct("v");
    assert.equal(values.length, 4);
    assert.ok(values.includes(1));
    assert.ok(values.includes("1"));
    assert.ok(values.includes(true));
    assert.ok(values.includes(null));

    db.close();
  });

  it("documents where the field is missing do not contribute a value", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const col = db.collection("items");

    col.insertMany([
      { role: "admin" },
      { other: "x" },
      { role: "user" }
    ]);

    assert.deepEqual(col.distinct("role"), ["admin", "user"]);

    db.close();
  });

  it("applies the query filter before collecting distinct values", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const col = db.collection("items");

    col.insertMany([
      { role: "admin", active: true },
      { role: "user", active: true },
      { role: "guest", active: false }
    ]);

    assert.deepEqual(col.distinct("role", { active: true }), ["admin", "user"]);

    db.close();
  });

  it("arrays are compared by deep (structural) equality, not by identity", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const col = db.collection("items");

    col.insertMany([
      { tags: ["a", "b"] },
      { tags: ["a", "b"] }, // same content as above -> not a new distinct value
      { tags: ["a", "c"] }, // different content -> a new distinct value
      { tags: [] }
    ]);

    const values = col.distinct("tags") as unknown[][];
    assert.equal(values.length, 3);
    assert.deepEqual(values[0], ["a", "b"]);
    assert.deepEqual(values[1], ["a", "c"]);
    assert.deepEqual(values[2], []);

    db.close();
  });

  it("objects are compared by deep (structural) equality, not by identity", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const col = db.collection("items");

    col.insertMany([
      { address: { city: "Paris" } },
      { address: { city: "Paris" } }, // same content -> not a new distinct value
      { address: { city: "Lyon" } },  // different content -> a new distinct value
      { address: {} }
    ]);

    const values = col.distinct("address") as Record<string, unknown>[];
    assert.equal(values.length, 3);
    assert.deepEqual(values[0], { city: "Paris" });
    assert.deepEqual(values[1], { city: "Lyon" });
    assert.deepEqual(values[2], {});

    db.close();
  });

  it("throws once the number of distinct values would exceed the default limit (100)", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const col = db.collection("items");

    const documents = Array.from({ length: 101 }, (_, i) => ({ n: i }));
    col.insertMany(documents);

    assert.throws(
      () => col.distinct("n"),
      /Too many distinct values for field "n" \(limit: 100\)\./
    );

    db.close();
  });

  it("does not throw when distinct values are exactly at the default limit (100)", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const col = db.collection("items");

    const documents = Array.from({ length: 100 }, (_, i) => ({ n: i }));
    col.insertMany(documents);

    assert.equal(col.distinct("n").length, 100);

    db.close();
  });

  it("accepts a custom limit via options", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const col = db.collection("items");

    col.insertMany([{ n: 1 }, { n: 2 }, { n: 3 }]);

    assert.throws(
      () => col.distinct("n", {}, { limit: 2 }),
      /Too many distinct values for field "n" \(limit: 2\)\./
    );

    assert.equal(col.distinct("n", {}, { limit: 3 }).length, 3);

    db.close();
  });

  it("rejects a non-positive-integer limit", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const col = db.collection("items");

    col.insertOne({ n: 1 });

    assert.throws(() => col.distinct("n", {}, { limit: 0 }), /positive integer/);
    assert.throws(() => col.distinct("n", {}, { limit: -1 }), /positive integer/);
    assert.throws(() => col.distinct("n", {}, { limit: 1.5 }), /positive integer/);

    db.close();
  });

  it("uses a secondary index to narrow candidates when one exists on the field", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const col = db.collection("items");

    col.createIndex("role", { type: "string" });
    col.insertMany([
      { role: "admin" },
      { role: "user" },
      { role: "user" }
    ]);

    assert.deepEqual(col.distinct("role"), ["admin", "user"]);

    db.close();
  });
});
