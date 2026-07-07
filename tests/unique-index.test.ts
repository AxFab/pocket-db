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

describe("Unique indexes — creation", () => {
  it("defaults to non-unique when the option is omitted", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");

    const result = users.createIndex("role", { type: "string" });

    assert.equal(result.unique, false);
    assert.deepEqual(users.getIndexes(), [{ name: "role", type: "string", unique: false }]);

    db.close();
  });

  it("creates a unique string index on an empty collection", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");

    const result = users.createIndex("email", { type: "string", unique: true });

    assert.deepEqual(result, { acknowledged: true, field: "email", type: "string", unique: true });
    assert.deepEqual(users.indexes, [{ field: "email", type: "string", unique: true }]);

    db.close();
  });

  it("creates a unique index over existing documents with no conflicts", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.insertMany([
      { name: "Ada", email: "ada@example.com" },
      { name: "Grace", email: "grace@example.com" }
    ]);

    const result = users.createIndex("email", { type: "string", unique: true });

    assert.equal(result.unique, true);

    db.close();
  });

  it("rejects creating a unique index over documents that already conflict, and does not persist it", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.insertMany([
      { name: "Ada", email: "shared@example.com" },
      { name: "Grace", email: "shared@example.com" }
    ]);
    const sizeBefore = statSync(path).size;

    assert.throws(
      () => users.createIndex("email", { type: "string", unique: true }),
      /share the same value/
    );
    assert.equal(users.existsIndex("email"), false);
    assert.equal(statSync(path).size, sizeBefore);

    db.close();
  });

  it("ignores documents missing the field or holding a mismatched type when checking for conflicts", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.insertMany([
      { name: "Ada" },
      { name: "Grace" },
      { name: "Margaret", email: 42 },
      { name: "Hedy", email: 43 }
    ]);

    assert.doesNotThrow(() => users.createIndex("email", { type: "string", unique: true }));

    db.close();
  });

  it("throws when recreating an index with a different unique flag", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.createIndex("email", { type: "string", unique: true });

    assert.throws(
      () => users.createIndex("email", { type: "string", unique: false }),
      /already exists.*unique/
    );

    db.close();
  });
});

describe("Unique indexes — write path", () => {
  it("rejects insertOne with a duplicate value", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.createIndex("email", { type: "string", unique: true });
    users.insertOne({ name: "Ada", email: "ada@example.com" });

    assert.throws(
      () => users.insertOne({ name: "Ada Clone", email: "ada@example.com" }),
      /unique index "email"/
    );
    assert.equal(users.countDocuments(), 1);

    db.close();
  });

  it("allows a second document with a different value, or missing the field entirely", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.createIndex("email", { type: "string", unique: true });
    users.insertOne({ name: "Ada", email: "ada@example.com" });
    users.insertOne({ name: "Grace", email: "grace@example.com" });
    users.insertOne({ name: "NoEmail" });

    assert.equal(users.countDocuments(), 3);

    db.close();
  });

  it("rejects insertMany when two documents in the same batch share a value", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.createIndex("email", { type: "string", unique: true });

    assert.throws(
      () => users.insertMany([
        { name: "Ada", email: "shared@example.com" },
        { name: "Grace", email: "shared@example.com" }
      ]),
      /unique index "email"/
    );
    assert.equal(users.countDocuments(), 0);

    db.close();
  });

  it("rejects insertMany when a batch document collides with an already-stored value", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.createIndex("email", { type: "string", unique: true });
    users.insertOne({ name: "Ada", email: "ada@example.com" });

    assert.throws(
      () => users.insertMany([
        { name: "Grace", email: "grace@example.com" },
        { name: "Ada Clone", email: "ada@example.com" }
      ]),
      /unique index "email"/
    );
    // Atomic: neither document from the rejected batch should be present.
    assert.equal(users.countDocuments(), 1);

    db.close();
  });

  it("rejects replaceOne when the replacement duplicates another document's value", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.createIndex("email", { type: "string", unique: true });
    users.insertOne({ name: "Ada", email: "ada@example.com" });
    const { insertedId } = users.insertOne({ name: "Grace", email: "grace@example.com" });

    assert.throws(
      () => users.replaceOne(insertedId, { name: "Grace", email: "ada@example.com" }),
      /unique index "email"/
    );

    db.close();
  });

  it("allows replaceOne to keep the document's own existing value", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.createIndex("email", { type: "string", unique: true });
    const { insertedId } = users.insertOne({ name: "Ada", email: "ada@example.com" });

    assert.doesNotThrow(() => users.replaceOne(insertedId, { name: "Ada Updated", email: "ada@example.com" }));
    assert.equal(users.findOne({ _id: insertedId })?.name, "Ada Updated");

    db.close();
  });

  it("rejects updateOne when the new value duplicates another document's value", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.createIndex("email", { type: "string", unique: true });
    users.insertOne({ name: "Ada", email: "ada@example.com" });
    const { insertedId } = users.insertOne({ name: "Grace", email: "grace@example.com" });

    assert.throws(
      () => users.updateOne(insertedId, { $set: { email: "ada@example.com" } }),
      /unique index "email"/
    );
    assert.equal(users.findOne({ _id: insertedId })?.email, "grace@example.com");

    db.close();
  });

  it("allows updateOne to re-set the document's own existing value", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.createIndex("email", { type: "string", unique: true });
    const { insertedId } = users.insertOne({ name: "Ada", email: "ada@example.com" });

    assert.doesNotThrow(() => users.updateOne(insertedId, { $set: { email: "ada@example.com" } }));

    db.close();
  });

  it("rejects updateMany when it would make two matched documents share a value", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.createIndex("code", { type: "number", unique: true });
    users.insertMany([
      { name: "Ada", code: 1 },
      { name: "Grace", code: 2 }
    ]);

    assert.throws(
      () => users.updateMany({}, { $set: { code: 9 } }),
      /unique index "code"/
    );
    // Atomic: neither document should have been changed by the rejected batch.
    assert.deepEqual(
      users.find({}).sort({ name: 1 }).toArray().map((doc) => doc.code),
      [1, 2]
    );

    db.close();
  });

  it("allows updateMany when each matched document ends up with a distinct value", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.createIndex("code", { type: "number", unique: true });
    users.insertMany([
      { name: "Ada", code: 1 },
      { name: "Grace", code: 2 }
    ]);

    users.updateMany({}, { $inc: { code: 10 } });

    assert.deepEqual(
      users.find({}).sort({ name: 1 }).toArray().map((doc) => doc.code),
      [11, 12]
    );

    db.close();
  });
});

describe("Unique indexes — persistence", () => {
  it("persists the unique flag and keeps enforcing it after reopening the database", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const first = pocketDb({ path });
    const users = first.collection("users");
    users.createIndex("email", { type: "string", unique: true });
    users.insertOne({ name: "Ada", email: "ada@example.com" });
    first.close();

    const second = pocketDb({ path });
    const loadedUsers = second.collection("users");

    assert.deepEqual(loadedUsers.indexes, [{ field: "email", type: "string", unique: true }]);
    assert.throws(
      () => loadedUsers.insertOne({ name: "Ada Clone", email: "ada@example.com" }),
      /unique index "email"/
    );

    second.close();
  });

  it("keeps enforcing the unique constraint after compaction", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    users.createIndex("email", { type: "string", unique: true });
    users.insertOne({ name: "Ada", email: "ada@example.com" });
    users.insertOne({ name: "Grace", email: "grace@example.com" });
    users.deleteOne({ name: "Grace" });

    db.compact();

    assert.deepEqual(users.indexes, [{ field: "email", type: "string", unique: true }]);
    assert.doesNotThrow(() => users.insertOne({ name: "Grace Again", email: "grace@example.com" }));
    assert.throws(
      () => users.insertOne({ name: "Ada Clone", email: "ada@example.com" }),
      /unique index "email"/
    );

    db.close();
  });
});
