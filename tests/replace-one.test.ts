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

describe("Collection replaceOne", () => {
  it("replaces an existing document by id and appends a new put document operation", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    const { insertedId } = users.insertOne({ name: "Ada" });
    const sizeBeforeReplace = statSync(path).size;

    const result = users.replaceOne(insertedId, { name: "Grace" });

    assert.deepEqual(result, {
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1
    });
    assert.notEqual(users.findOne({ _id: insertedId }), null);

    db.close();

    assert.equal(statSync(path).size > sizeBeforeReplace, true);
  });

  it("replaces an existing document from a document containing its id", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    const { insertedId } = users.insertOne({ name: "Ada" });

    const result = users.replaceOne({ _id: insertedId, name: "Grace" });

    assert.deepEqual(result, {
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1
    });
    assert.notEqual(users.findOne({ _id: insertedId }), null);

    db.close();
  });

  it("rejects replacements for unknown document ids", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");

    assert.throws(
      () => users.replaceOne("00112233445566778899aabb", { name: "Grace" }),
      /unknown _id/
    );

    db.close();
  });

  it("rebuilds the primary index with replaced documents when the database opens", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const first = open({ path });
    const users = first.collection("users");
    const { insertedId } = users.insertOne({ name: "Ada" });
    users.replaceOne(insertedId, { name: "Grace" });
    first.close();

    const second = open({ path });
    const loadedUsers = second.collection("users");

    assert.notEqual(loadedUsers.findOne({ _id: insertedId }), null);

    second.close();
  });
});
