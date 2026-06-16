import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { open } from "../src/index.js";
import { FILE_HEADER_BYTES } from "../src/storage/constants.js";

const tempDirectories: string[] = [];

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pocket-db-"));
  tempDirectories.push(directory);
  return directory;
}

function openDb() {
  return open({ path: join(createTempDirectory(), "test.pdb") });
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Database.stats()", () => {
  it("reports a header-only file and zero counters for an empty database", () => {
    const db = openDb();
    const stats = db.stats();

    assert.equal(stats.sizeOnDisk, FILE_HEADER_BYTES);
    assert.equal(stats.collectionCount, 0);
    assert.equal(stats.documentCount, 0);
    assert.equal(stats.operationCount, 0);
    assert.equal(stats.tombstoneCount, 0);
    assert.equal(stats.liveBytes, 0);
    assert.equal(stats.deadBytes, 0);
    db.close();
  });

  it("counts collections, documents and operations", () => {
    const db = openDb();
    const col = db.collection("users");
    col.insertOne({ name: "Ada" });
    col.insertOne({ name: "Grace" });
    col.insertOne({ name: "Linus" });

    const stats = db.stats();
    // 1 ncl1 + 3 put1, none dead.
    assert.equal(stats.collectionCount, 1);
    assert.equal(stats.documentCount, 3);
    assert.equal(stats.operationCount, 4);
    assert.equal(stats.tombstoneCount, 0);
    assert.equal(stats.deadBytes, 0);
    db.close();
  });

  it("updates create tombstones without changing the document count", () => {
    const db = openDb();
    const col = db.collection("users");
    const { insertedId } = col.insertOne({ name: "Ada", n: 1 });
    col.updateOne(insertedId, { $set: { n: 2 } });

    const stats = db.stats();
    // ncl1(live) + put1#1(dead) + put1#2(live).
    assert.equal(stats.documentCount, 1);
    assert.equal(stats.operationCount, 3);
    assert.equal(stats.tombstoneCount, 1);
    assert.ok(stats.deadBytes > 0);
    db.close();
  });

  it("deletes count as tombstones and lower the document count", () => {
    const db = openDb();
    const col = db.collection("users");
    const a = col.insertOne({ name: "Ada" }).insertedId;
    col.insertOne({ name: "Grace" });
    col.deleteOne(a);

    const stats = db.stats();
    // ncl1(live) + put1_a(dead) + put1_grace(live) + del1_a(dead).
    assert.equal(stats.documentCount, 1);
    assert.equal(stats.operationCount, 4);
    assert.equal(stats.tombstoneCount, 2);
    db.close();
  });

  it("keeps sizeOnDisk === header + liveBytes + deadBytes", () => {
    const db = openDb();
    const col = db.collection("users");
    const id = col.insertOne({ name: "Ada", n: 1 }).insertedId;
    col.updateOne(id, { $set: { n: 2 } });
    col.insertOne({ name: "Grace" });

    const stats = db.stats();
    assert.equal(stats.sizeOnDisk, FILE_HEADER_BYTES + stats.liveBytes + stats.deadBytes);
    assert.ok(stats.deadBytes > 0);
    db.close();
  });

  it("compact() reclaims deadBytes and clears tombstones", () => {
    const db = openDb();
    const col = db.collection("users");
    const id = col.insertOne({ name: "Ada", n: 1 }).insertedId;
    col.updateOne(id, { $set: { n: 2 } });
    col.updateOne(id, { $set: { n: 3 } });

    const before = db.stats();
    assert.ok(before.deadBytes > 0);
    assert.ok(before.tombstoneCount > 0);

    db.compact();
    const after = db.stats();

    assert.equal(after.deadBytes, 0);
    assert.equal(after.tombstoneCount, 0);
    assert.equal(after.documentCount, before.documentCount);
    assert.ok(after.sizeOnDisk < before.sizeOnDisk);
    assert.equal(after.sizeOnDisk, FILE_HEADER_BYTES + after.liveBytes);
    db.close();
  });
});

describe("Collection.stats()", () => {
  it("isolates counters per collection", () => {
    const db = openDb();
    const users = db.collection("users");
    users.insertOne({ name: "Ada" });
    users.insertOne({ name: "Grace" });

    const logs = db.collection("logs");
    logs.insertOne({ level: "info" });

    const userStats = users.stats();
    assert.equal(userStats.name, "users");
    assert.equal(userStats.documentCount, 2);
    assert.equal(userStats.operationCount, 3); // ncl1 + 2 put1
    assert.equal(userStats.tombstoneCount, 0);

    const logStats = logs.stats();
    assert.equal(logStats.documentCount, 1);
    assert.equal(logStats.operationCount, 2); // ncl1 + 1 put1

    const dbStats = db.stats();
    assert.equal(dbStats.collectionCount, 2);
    assert.equal(dbStats.documentCount, 3);
    // No transaction/hole records here, so the per-collection counts add up.
    assert.equal(userStats.operationCount + logStats.operationCount, dbStats.operationCount);
    db.close();
  });

  it("counts indexes and their create operation", () => {
    const db = openDb();
    const col = db.collection("users");
    col.insertOne({ name: "Ada", age: 37 });
    col.createIndex("age", { type: "number" });

    const stats = col.stats();
    assert.equal(stats.indexCount, 1);
    assert.equal(stats.operationCount, 3); // ncl1 + put1 + idx1
    assert.equal(stats.tombstoneCount, 0);
    db.close();
  });

  it("attributes a collection's own dead records to it", () => {
    const db = openDb();
    const col = db.collection("users");
    const id = col.insertOne({ name: "Ada", n: 1 }).insertedId;
    col.updateOne(id, { $set: { n: 2 } });

    const stats = col.stats();
    assert.equal(stats.documentCount, 1);
    assert.equal(stats.tombstoneCount, 1);
    assert.ok(stats.deadBytes > 0);
    db.close();
  });

  it("throws when called on a dropped collection", () => {
    const db = openDb();
    const col = db.collection("users");
    col.insertOne({ name: "Ada" });
    col.drop();

    assert.throws(() => col.stats(), /has been dropped/);
    db.close();
  });
});
