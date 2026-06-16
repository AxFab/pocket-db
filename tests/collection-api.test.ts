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

describe("Database collections", () => {
  it("creates a collection when it is not already loaded", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });

    const users = db.collection("users");

    db.close();

    assert.equal(users.name, "users");
    assert.deepEqual(users.indexes, []);
    assert.equal(statSync(path).size > "pocketdb".length, true);
  });

  it("loads existing collections when the database opens", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const first = pocketDb({ path });
    const created = first.collection("users");
    first.close();

    const sizeAfterCreation = statSync(path).size;
    const second = pocketDb({ path });
    const loaded = second.collection("users");
    second.close();

    assert.equal(loaded.name, created.name);
    assert.equal(statSync(path).size, sizeAfterCreation);
  });
});
