import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { open } from "../src/index.js";

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

describe("cursor count() and countDocuments()", () => {
  it("count() returns 0 on an empty collection", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const col = db.collection("items");

    assert.equal(col.find().count(), 0);
    assert.equal(col.countDocuments(), 0);

    db.close();
  });

  it("count() returns the total number of inserted documents (no query)", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const col = db.collection("items");

    col.insertMany([{ x: 1 }, { x: 2 }, { x: 3 }]);

    assert.equal(col.find().count(), 3);
    assert.equal(col.countDocuments(), 3);

    db.close();
  });

  it("count() applies the residual query filter", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const col = db.collection("items");

    col.insertMany([
      { role: "admin" },
      { role: "user" },
      { role: "user" },
      { role: "guest" }
    ]);

    assert.equal(col.find({ role: "user" }).count(), 2);
    assert.equal(col.countDocuments({ role: "user" }), 2);
    assert.equal(col.countDocuments({ role: "admin" }), 1);
    assert.equal(col.countDocuments({ role: "guest" }), 1);
    assert.equal(col.countDocuments({ role: "unknown" }), 0);

    db.close();
  });

  it("count() uses the index candidate set (secondary index narrows candidates)", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const col = db.collection("items");

    col.createIndex("role", { type: "string" });
    col.insertMany([
      { role: "admin", active: true },
      { role: "user", active: true },
      { role: "user", active: false },
    ]);

    assert.equal(col.countDocuments({ role: "user" }), 2);
    assert.equal(col.countDocuments({ role: "admin" }), 1);

    db.close();
  });

  it("count() does NOT respect skip() or limit() — returns the full match set", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const col = db.collection("items");

    col.insertMany([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }]);

    const cursor = col.find().skip(2).limit(2);

    // skip/limit affect next()/toArray() but not count()
    assert.equal(cursor.count(), 5);
    // toArray() on the same cursor still respects skip/limit
    assert.equal(cursor.toArray().length, 2);

    db.close();
  });

  it("count() does not advance the cursor — next() still works after count()", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const col = db.collection("items");

    col.insertMany([{ v: 10 }, { v: 20 }, { v: 30 }]);

    const cursor = col.find();
    assert.equal(cursor.count(), 3);

    // The cursor is not consumed; next() starts from the beginning.
    const first = cursor.next();
    assert.ok(first !== null);

    db.close();
  });

  it("countDocuments() reflects deletions correctly", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const col = db.collection("items");

    const { insertedIds } = col.insertMany([{ k: 1 }, { k: 2 }, { k: 3 }]);

    assert.equal(col.countDocuments(), 3);

    col.deleteOne(insertedIds[0]);
    assert.equal(col.countDocuments(), 2);

    col.deleteMany({});
    assert.equal(col.countDocuments(), 0);

    db.close();
  });

  it("countDocuments() is consistent after reopen", () => {
    const path = join(createTempDirectory(), "test.pdb");

    {
      const db = open({ path });
      const col = db.collection("items");
      col.insertMany([{ a: 1 }, { a: 2 }]);
      db.close();
    }

    const db = open({ path });
    const col = db.collection("items");
    assert.equal(col.countDocuments(), 2);
    db.close();
  });
});
