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

describe("Collection insertOne", () => {
  it("appends a document operation and adds the document to the primary index", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    const sizeBeforeInsert = statSync(path).size;

    const result = users.insertOne({ name: "Ada" });

    assert.deepEqual(result, {
      acknowledged: true,
      insertedId: result.insertedId
    });
    assert.equal(result.insertedId.length, 24);
    assert.notEqual(users.findOne({ _id: result.insertedId }), null);

    db.close();

    assert.equal(statSync(path).size > sizeBeforeInsert, true);
  });

  it("rebuilds the primary index when the database opens", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const first = open({ path });
    const users = first.collection("users");
    const result = users.insertOne({ name: "Ada" });
    first.close();

    const second = open({ path });
    const loadedUsers = second.collection("users");

    assert.notEqual(loadedUsers.findOne({ _id: result.insertedId }), null);

    second.close();
  });

  it("accepts a user-provided ObjectId-like _id", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    const id = "00112233445566778899aabb";

    const result = users.insertOne({ _id: id, name: "Ada" });

    assert.equal(result.insertedId, id);
    assert.notEqual(users.findOne({ _id: id }), null);
    assert.deepEqual(users.findOne({ _id: id }), {
      _id: id,
      name: "Ada"
    });

    db.close();
  });

  it("rejects duplicate or invalid user-provided ids", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    const id = "00112233445566778899aabb";

    users.insertOne({ _id: id, name: "Ada" });

    assert.throws(
      () => users.insertOne({ _id: id, name: "Grace" }),
      /duplicate _id/
    );
    assert.throws(
      () => users.insertOne({ _id: "00112233445566778899AABB", name: "Grace" }),
      /24-character lowercase hex/
    );

    db.close();
  });
});
