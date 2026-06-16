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

describe("Collection insertMany, findOne, and deleteMany", () => {
  it("inserts multiple documents and returns their ids in insertion order", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");

    const result = users.insertMany([
      { name: "Ada" },
      { name: "Grace" }
    ]);

    assert.equal(result.acknowledged, true);
    assert.equal(result.insertedCount, 2);
    assert.equal(result.insertedIds.length, 2);
    assert.notEqual(users.findOne({ _id: result.insertedIds[0] }), null);
    assert.notEqual(users.findOne({ _id: result.insertedIds[1] }), null);
    assert.deepEqual(
      users.find({}).toArray().map((document) => document.name),
      ["Ada", "Grace"]
    );

    db.close();
  });

  it("finds the first matching document or null", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.insertMany([
      { name: "Ada", role: "admin" },
      { name: "Grace", role: "admin" }
    ]);

    assert.equal(users.findOne({ role: "admin" })?.name, "Ada");
    assert.equal(users.findOne({ role: "reader" }), null);

    db.close();
  });

  it("deletes all documents matching a query", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    const result = users.insertMany([
      { name: "Ada", role: "admin" },
      { name: "Grace", role: "admin" },
      { name: "Margaret", role: "reader" }
    ]);
    const sizeBeforeDelete = statSync(path).size;

    const deleteResult = users.deleteMany({ role: "admin" });

    assert.deepEqual(deleteResult, {
      acknowledged: true,
      deletedCount: 2
    });
    assert.equal(users.findOne({ _id: result.insertedIds[0] }), null);
    assert.equal(users.findOne({ _id: result.insertedIds[1] }), null);
    assert.notEqual(users.findOne({ _id: result.insertedIds[2] }), null);
    assert.deepEqual(
      users.find({}).toArray().map((document) => document.name),
      ["Margaret"]
    );
    assert.equal(statSync(path).size > sizeBeforeDelete, true);

    db.close();
  });

  it("deletes all documents when deleteMany receives no query", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.insertMany([{ name: "Ada" }, { name: "Grace" }]);

    const result = users.deleteMany();

    assert.deepEqual(result, {
      acknowledged: true,
      deletedCount: 2
    });
    assert.deepEqual(users.find({}).toArray(), []);

    db.close();
  });

  it("rebuilds insertMany and deleteMany effects when the database opens", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const first = pocketDb({ path });
    const users = first.collection("users");
    users.insertMany([
      { name: "Ada", role: "admin" },
      { name: "Grace", role: "admin" },
      { name: "Margaret", role: "reader" }
    ]);
    users.deleteMany({ role: "admin" });
    first.close();

    const second = pocketDb({ path });
    const loadedUsers = second.collection("users");

    assert.deepEqual(
      loadedUsers.find({}).toArray().map((document) => document.name),
      ["Margaret"]
    );

    second.close();
  });
});
