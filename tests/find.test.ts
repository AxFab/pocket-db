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

describe("Collection find", () => {
  it("returns matching documents with next", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    const ada = users.insertOne({ name: "Ada", age: 37 });
    users.insertOne({ name: "Grace", age: 85 });

    const cursor = users.find({ name: "Ada" });

    assert.deepEqual(cursor.next(), {
      _id: ada.insertedId,
      name: "Ada",
      age: 37
    });
    assert.equal(cursor.next(), null);

    db.close();
  });

  it("returns all matching documents with toArray", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.insertOne({ name: "Ada", age: 37 });
    users.insertOne({ name: "Grace", age: 85 });
    users.insertOne({ name: "Margaret", age: 29 });

    const documents = users.find({ age: { $gt: 30 } }).toArray();

    assert.deepEqual(
      documents.map((document) => document.name),
      ["Ada", "Grace"]
    );

    db.close();
  });

  it("supports skip and limit", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.insertOne({ name: "Ada", age: 37 });
    users.insertOne({ name: "Grace", age: 85 });
    users.insertOne({ name: "Margaret", age: 29 });

    const documents = users.find({}).skip(1).limit(1).toArray();

    assert.deepEqual(
      documents.map((document) => document.name),
      ["Grace"]
    );

    db.close();
  });

  it("uses an offset snapshot created when find is called", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.insertOne({ name: "Ada" });

    const cursor = users.find({});

    users.insertOne({ name: "Grace" });

    assert.deepEqual(
      cursor.toArray().map((document) => document.name),
      ["Ada"]
    );

    db.close();
  });

  it("reads replaced documents from the snapshot offset", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    const { insertedId } = users.insertOne({ name: "Ada" });

    const cursor = users.find({});

    users.replaceOne(insertedId, { name: "Grace" });

    assert.deepEqual(
      cursor.toArray().map((document) => document.name),
      ["Ada"]
    );
    assert.deepEqual(
      users.find({}).toArray().map((document) => document.name),
      ["Grace"]
    );

    db.close();
  });

  it("rebuilds find candidates after reopening the database", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const first = pocketDb({ path });
    first.collection("users").insertOne({ name: "Ada" });
    first.close();

    const second = pocketDb({ path });
    const documents = second.collection("users").find({ name: { $exists: true } }).toArray();

    assert.deepEqual(
      documents.map((document) => document.name),
      ["Ada"]
    );

    second.close();
  });
});
