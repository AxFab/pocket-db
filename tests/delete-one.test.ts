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

describe("Collection deleteOne", () => {
  it("deletes an existing document by id and appends a delete operation", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    const { insertedId } = users.insertOne({ name: "Ada" });
    const sizeBeforeDelete = statSync(path).size;

    const result = users.deleteOne(insertedId);

    db.close();

    assert.deepEqual(result, {
      acknowledged: true,
      deletedCount: 1
    });
    assert.equal(users.findOne({ _id: insertedId }), null);
    assert.deepEqual(users.find({}).toArray(), []);
    assert.equal(statSync(path).size > sizeBeforeDelete, true);
  });

  it("deletes the first document matching a query", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    const ada = users.insertOne({ name: "Ada", role: "admin" });
    const grace = users.insertOne({ name: "Grace", role: "admin" });

    const result = users.deleteOne({ role: "admin" });

    assert.deepEqual(result, {
      acknowledged: true,
      deletedCount: 1
    });
    assert.equal(users.findOne({ _id: ada.insertedId }), null);
    assert.notEqual(users.findOne({ _id: grace.insertedId }), null);
    assert.deepEqual(
      users.find({}).toArray().map((document) => document.name),
      ["Grace"]
    );

    db.close();
  });

  it("does not append an operation when no document matches", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.insertOne({ name: "Ada" });
    const sizeBeforeDelete = statSync(path).size;

    const result = users.deleteOne({ name: "Grace" });

    db.close();

    assert.deepEqual(result, {
      acknowledged: true,
      deletedCount: 0
    });
    assert.equal(statSync(path).size, sizeBeforeDelete);
  });

  it("rebuilds the primary index with deleted documents removed when the database opens", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const first = pocketDb({ path });
    const users = first.collection("users");
    const { insertedId } = users.insertOne({ name: "Ada" });
    users.deleteOne(insertedId);
    first.close();

    const second = pocketDb({ path });
    const loadedUsers = second.collection("users");

    assert.equal(loadedUsers.findOne({ _id: insertedId }), null);
    assert.deepEqual(loadedUsers.find({}).toArray(), []);

    second.close();
  });
});
