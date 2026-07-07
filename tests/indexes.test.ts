import { mkdtempSync, rmSync, statSync } from "node:fs";
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

describe("Collection indexes", () => {
  it("creates a string index and keeps query results correct", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.insertMany([
      { name: "Ada", role: "admin" },
      { name: "Grace", role: "admin" },
      { name: "Margaret", role: "reader" },
      { name: "NoRole" },
      { name: "BadRole", role: 42 }
    ]);

    const result = users.createIndex("role", { type: "string" });

    assert.deepEqual(result, {
      acknowledged: true,
      field: "role",
      type: "string",
      unique: false
    });
    assert.deepEqual(users.indexes, [{ field: "role", type: "string", unique: false }]);
    assert.deepEqual(
      users.find({ role: "admin" }).toArray().map((document) => document.name),
      ["Ada", "Grace"]
    );
    assert.deepEqual(
      users.find({ role: { $in: ["reader", "missing"] } }).toArray().map((document) => document.name),
      ["Margaret"]
    );

    db.close();
  });

  it("uses the primary index definition for _id queries without exposing it as a secondary index", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    const { insertedId } = users.insertOne({ name: "Ada" });

    assert.deepEqual(users.indexes, []);
    assert.deepEqual(users.find({ _id: insertedId }).toArray(), [
      {
        _id: insertedId,
        name: "Ada"
      }
    ]);

    db.close();
  });

  it("creates a number index and supports equality and range predicates", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.insertMany([
      { name: "Ada", age: 37 },
      { name: "Grace", age: 85 },
      { name: "Margaret", age: 29 },
      { name: "NoAge" },
      { name: "BadAge", age: "old" }
    ]);

    users.createIndex("age", { type: "number" });

    assert.deepEqual(
      users.find({ age: { $gt: 30, $lt: 90 } }).toArray().map((document) => document.name),
      ["Ada", "Grace"]
    );
    assert.deepEqual(
      users.find({ age: { $in: [29, 40] } }).toArray().map((document) => document.name),
      ["Margaret"]
    );
    assert.deepEqual(
      users.find({ age: { $exists: false } }).toArray().map((document) => document.name),
      ["NoAge"]
    );

    db.close();
  });

  it("maintains indexes after insert, replace, update, and delete", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.createIndex("role", { type: "string" });
    users.createIndex("score", { type: "number" });

    const ada = users.insertOne({ name: "Ada", role: "reader", score: 1 });

    assert.deepEqual(users.find({ role: "reader" }).toArray().map((document) => document.name), ["Ada"]);

    users.replaceOne(ada.insertedId, { name: "Ada", role: "admin", score: 3 });

    assert.deepEqual(users.find({ role: "reader" }).toArray(), []);
    assert.deepEqual(users.find({ role: "admin" }).toArray().map((document) => document.name), ["Ada"]);

    users.updateOne(ada.insertedId, { $set: { role: "owner" }, $inc: { score: 4 } });

    assert.deepEqual(users.find({ role: "admin" }).toArray(), []);
    assert.deepEqual(users.find({ role: "owner" }).toArray().map((document) => document.name), ["Ada"]);
    assert.deepEqual(users.find({ score: { $gt: 5 } }).toArray().map((document) => document.name), ["Ada"]);

    users.deleteOne(ada.insertedId);

    assert.deepEqual(users.find({ role: "owner" }).toArray(), []);
    assert.deepEqual(users.find({ score: { $gt: 0 } }).toArray(), []);

    db.close();
  });

  it("persists index definitions and rebuilds indexes when the database opens", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const first = pocketDb({ path });
    const users = first.collection("users");
    users.insertMany([
      { name: "Ada", role: "admin" },
      { name: "Grace", role: "admin" },
      { name: "Margaret", role: "reader" }
    ]);
    users.createIndex("role", { type: "string" });
    first.close();

    const second = pocketDb({ path });
    const loadedUsers = second.collection("users");

    assert.deepEqual(loadedUsers.indexes, [{ field: "role", type: "string", unique: false }]);
    assert.deepEqual(
      loadedUsers.find({ role: "admin" }).toArray().map((document) => document.name),
      ["Ada", "Grace"]
    );

    second.close();
  });

  it("does not append another operation when creating an existing index", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.createIndex("role", { type: "string" });
    const sizeAfterFirstCreate = statSync(path).size;

    users.createIndex("role", { type: "string" });

    assert.equal(statSync(path).size, sizeAfterFirstCreate);

    db.close();
  });

  it("rejects invalid index definitions", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.createIndex("role", { type: "string" });

    assert.throws(
      () => users.createIndex("", { type: "string" }),
      /Index field cannot be empty/
    );
    assert.throws(
      () => users.createIndex("role", { type: "number" }),
      /Index already exists/
    );
    assert.throws(
      () => users.createIndex("age", { type: "boolean" as never }),
      /Unsupported index type/
    );

    db.close();
  });
});
