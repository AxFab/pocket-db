import { mkdtempSync, rmSync, statSync } from "node:fs";
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

describe("Collection updateOne and updateMany", () => {
  it("updates one document by id and appends a put document operation", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    const { insertedId } = users.insertOne({ name: "Ada", count: 1 });
    const sizeBeforeUpdate = statSync(path).size;

    const result = users.updateOne(insertedId, {
      $set: { name: "Grace" },
      $inc: { count: 2 }
    });

    assert.deepEqual(result, {
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1
    });
    assert.deepEqual(users.findOne({ _id: insertedId }), {
      _id: insertedId,
      name: "Grace",
      count: 3
    });
    assert.equal(statSync(path).size > sizeBeforeUpdate, true);

    db.close();
  });

  it("updates one document matching a query", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.insertMany([
      { name: "Ada", role: "admin", count: 1 },
      { name: "Grace", role: "admin", count: 1 }
    ]);

    const result = users.updateOne({ role: "admin" }, { $inc: { count: 1 } });

    assert.deepEqual(result, {
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1
    });
    assert.deepEqual(
      users.find({ role: "admin" }).toArray().map((document) => document.count),
      [2, 1]
    );

    db.close();
  });

  it("returns an empty update result when updateOne matches nothing", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.insertOne({ name: "Ada", count: 1 });
    const sizeBeforeUpdate = statSync(path).size;

    const result = users.updateOne({ name: "Grace" }, { $inc: { count: 1 } });

    assert.deepEqual(result, {
      acknowledged: true,
      matchedCount: 0,
      modifiedCount: 0
    });
    assert.equal(statSync(path).size, sizeBeforeUpdate);

    db.close();
  });

  it("updates all documents matching a query from a snapshot", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.insertMany([
      { name: "Ada", role: "admin", count: 1, tags: ["engine"] },
      { name: "Grace", role: "admin", count: 3, tags: ["engine"] },
      { name: "Margaret", role: "reader", count: 1, tags: ["math"] }
    ]);

    const result = users.updateMany(
      { role: "admin" },
      {
        $inc: { count: 2 },
        $push: { tags: "updated" }
      }
    );

    assert.deepEqual(result, {
      acknowledged: true,
      matchedCount: 2,
      modifiedCount: 2
    });
    assert.deepEqual(
      users.find({ role: "admin" }).toArray().map((document) => ({
        count: document.count,
        tags: document.tags
      })),
      [
        { count: 3, tags: ["engine", "updated"] },
        { count: 5, tags: ["engine", "updated"] }
      ]
    );
    assert.equal(users.findOne({ role: "reader" })?.count, 1);

    db.close();
  });

  it("keeps updated documents after reopening the database", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const first = open({ path });
    const users = first.collection("users");
    const { insertedId } = users.insertOne({ name: "Ada", count: 1 });
    users.updateOne(insertedId, { $max: { count: 10 } });
    first.close();

    const second = open({ path });
    const loadedUsers = second.collection("users");

    assert.deepEqual(loadedUsers.findOne({ _id: insertedId }), {
      _id: insertedId,
      name: "Ada",
      count: 10
    });

    second.close();
  });

  it("rejects updates that mutate _id", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    const { insertedId } = users.insertOne({ name: "Ada" });

    assert.throws(
      () => users.updateOne(insertedId, { $set: { _id: "00112233445566778899aabb" } }),
      /immutable field _id/
    );
    assert.throws(
      () => users.updateOne(insertedId, { $unset: { _id: true } }),
      /immutable field _id/
    );
    assert.throws(
      () => users.updateOne(insertedId, { $rename: { _id: "documentId" } }),
      /immutable field _id/
    );
    assert.throws(
      () => users.updateOne(insertedId, { $rename: { name: "_id" } }),
      /immutable field _id/
    );
    assert.throws(
      () => users.updateOne(insertedId, { $currentDate: { _id: true } }),
      /immutable field _id/
    );

    db.close();
  });
});
