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

describe("Collection drop", () => {
  it("drops a collection and removes all its documents from queries", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.insertMany([{ name: "Ada" }, { name: "Grace" }]);

    const result = users.drop();

    assert.deepEqual(result, { acknowledged: true });
    assert.deepEqual(users.find({}).toArray(), []);

    db.close();
  });

  it("removes the collection from the database registry so the next call recreates it fresh", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.insertOne({ name: "Ada" });

    users.drop();

    const recreated = db.collection("users");
    assert.equal(recreated.countDocuments(), 0);

    db.close();
  });

  it("prevents write operations on a dropped collection", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.drop();

    assert.throws(() => users.insertOne({ name: "Ada" }), /has been dropped/);
    assert.throws(() => users.insertMany([{ name: "Ada" }]), /has been dropped/);
    assert.throws(() => users.updateOne({}, { $set: { name: "Grace" } }), /has been dropped/);
    assert.throws(() => users.updateMany({}, { $set: { name: "Grace" } }), /has been dropped/);
    assert.throws(() => users.deleteOne({}), /has been dropped/);
    assert.throws(() => users.deleteMany({}), /has been dropped/);
    assert.throws(() => users.createIndex("name", { type: "string" }), /has been dropped/);
    assert.throws(() => users.drop(), /has been dropped/);

    db.close();
  });

  it("replays drop collection and rebuilds state correctly on reopen", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const first = open({ path });
    first.collection("users").insertMany([{ name: "Ada" }, { name: "Grace" }]);
    first.collection("users").drop();
    const recreated = first.collection("users");
    recreated.insertOne({ name: "Margaret" });
    first.close();

    const second = open({ path });
    const loaded = second.collection("users");

    assert.deepEqual(
      loaded.find({}).toArray().map((doc) => doc.name),
      ["Margaret"]
    );

    second.close();
  });

  it("replays drop collection that had indexes without error", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const first = open({ path });
    const users = first.collection("users");
    users.createIndex("role", { type: "string" });
    users.insertMany([{ name: "Ada", role: "admin" }]);
    users.drop();
    first.close();

    const second = open({ path });
    const loaded = second.collection("users");

    assert.deepEqual(loaded.indexes, []);
    assert.deepEqual(loaded.find({}).toArray(), []);

    second.close();
  });
});

describe("Collection dropIndex", () => {
  it("drops an existing index and removes it from the index list", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.createIndex("role", { type: "string" });
    users.createIndex("age", { type: "number" });

    const result = users.dropIndex("role");

    assert.deepEqual(result, { acknowledged: true, field: "role" });
    assert.deepEqual(users.indexes, [{ field: "age", type: "number" }]);

    db.close();
  });

  it("queries still return correct results after an index is dropped", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.insertMany([
      { name: "Ada", role: "admin" },
      { name: "Grace", role: "reader" }
    ]);
    users.createIndex("role", { type: "string" });

    users.dropIndex("role");

    assert.deepEqual(
      users.find({ role: "admin" }).toArray().map((doc) => doc.name),
      ["Ada"]
    );

    db.close();
  });

  it("rejects dropIndex when no index exists on that field", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");

    assert.throws(
      () => users.dropIndex("role"),
      /No index exists on field "role"/
    );

    db.close();
  });

  it("replays dropIndex and rebuilds the remaining indexes correctly on reopen", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const first = open({ path });
    const users = first.collection("users");
    users.insertMany([{ name: "Ada", role: "admin", age: 37 }]);
    users.createIndex("role", { type: "string" });
    users.createIndex("age", { type: "number" });
    users.dropIndex("role");
    first.close();

    const second = open({ path });
    const loaded = second.collection("users");

    assert.deepEqual(loaded.indexes, [{ field: "age", type: "number" }]);
    assert.deepEqual(
      loaded.find({ age: { $gt: 30 } }).toArray().map((doc) => doc.name),
      ["Ada"]
    );

    second.close();
  });

  it("allows recreating an index after it has been dropped", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.insertMany([{ name: "Ada", role: "admin" }]);
    users.createIndex("role", { type: "string" });
    users.dropIndex("role");

    const result = users.createIndex("role", { type: "string" });

    assert.deepEqual(result, { acknowledged: true, field: "role", type: "string" });
    assert.deepEqual(users.indexes, [{ field: "role", type: "string" }]);
    assert.deepEqual(
      users.find({ role: "admin" }).toArray().map((doc) => doc.name),
      ["Ada"]
    );

    db.close();
  });
});
