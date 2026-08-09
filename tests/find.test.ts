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

  it("skip on a match-all query jumps directly to the offset (fast path) and still returns correct results", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    const names = ["Ada", "Grace", "Margaret", "Hedy", "Katherine"];
    for (const name of names) users.insertOne({ name });

    assert.deepEqual(users.find({}).skip(3).toArray().map((d) => d.name), ["Hedy", "Katherine"]);
    assert.deepEqual(users.find({}).skip(names.length).toArray(), []);
    assert.deepEqual(users.find({}).skip(names.length + 10).toArray(), []);
    assert.deepEqual(users.find({}).skip(0).limit(2).toArray().map((d) => d.name), ["Ada", "Grace"]);

    db.close();
  });

  it("skip with a filtering (non-match-all) query only counts matching documents", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.insertOne({ name: "Ada", role: "reader" });
    users.insertOne({ name: "Grace", role: "admin" });
    users.insertOne({ name: "Margaret", role: "reader" });
    users.insertOne({ name: "Hedy", role: "admin" });
    users.insertOne({ name: "Katherine", role: "reader" });

    // Non-matching documents (the "admin" ones) must not count toward skip.
    const documents = users.find({ role: "reader" }).skip(1).toArray();

    assert.deepEqual(
      documents.map((document) => document.name),
      ["Margaret", "Katherine"]
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

  it("returns correct results when a scan's candidates are scattered across the file by interleaved writes", () => {
    // Regression test for the bulk-read path: candidate offsets here are not
    // contiguous — another collection's records and superseded put1 versions
    // sit between them — so the multi-candidate scan (>= 2 candidates) must
    // read a range wide enough to cover every candidate, not assume they're
    // adjacent.
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    const logs = db.collection("logs");

    const ada = users.insertOne({ name: "Ada", age: 37 }).insertedId;
    logs.insertOne({ line: "noise-1" });
    const grace = users.insertOne({ name: "Grace", age: 85 }).insertedId;
    logs.insertOne({ line: "noise-2" });
    users.insertOne({ name: "Margaret", age: 29 });
    logs.insertOne({ line: "noise-3" });
    // Rewrites Ada and Grace's records to new offsets further down the file,
    // leaving their original put1 records as dead space in between.
    users.updateOne(ada, { $set: { age: 38 } });
    users.updateOne(grace, { $set: { age: 86 } });

    const documents = users.find({ age: { $gt: 30 } }).toArray();

    assert.deepEqual(
      documents.map((document) => `${document.name}:${document.age}`).sort(),
      ["Ada:38", "Grace:86"]
    );

    db.close();
  });
});
