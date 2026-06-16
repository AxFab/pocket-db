import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pocketDb } from "../src/index.js";
import {
  FILE_HEADER_BYTES,
  FORMAT_MAJOR_VERSION,
  FORMAT_MINOR_VERSION,
  MAGIC_HEADER,
  MAGIC_HEADER_BYTES,
  SERIALIZATION_FORMAT,
  SERIALIZATION_VERSION
} from "../src/storage/constants.js";

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

describe("durability option", () => {
  it('opens with durability "relaxed" and writes succeed without fsync', () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path, durability: "relaxed" });
    const col = db.collection("items");
    const result = col.insertOne({ name: "a" });
    db.close();
    assert.equal(result.acknowledged, true);
  });

  it('opens with durability "strict" and writes succeed with fsync', () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path, durability: "strict" });
    const col = db.collection("items");
    const result = col.insertOne({ name: "b" });
    db.close();
    assert.equal(result.acknowledged, true);
  });

  it('defaults to "relaxed" when durability is omitted', () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const col = db.collection("items");
    const result = col.insertOne({ name: "c" });
    db.close();
    assert.equal(result.acknowledged, true);
  });

  it('strict mode data survives a close/reopen cycle', () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path, durability: "strict" });
    const id = db.collection("items").insertOne({ x: 42 }).insertedId;
    db.close();

    const db2 = pocketDb({ path, durability: "strict" });
    const doc = db2.collection("items").findOne({ _id: id });
    db2.close();
    assert.deepEqual(doc, { _id: id, x: 42 });
  });
});

describe("open", () => {
  it("creates a database file and writes the full 12-byte file header", () => {
    const path = join(createTempDirectory(), "test.pdb");

    const db = pocketDb({ path });
    db.close();

    const raw = readFileSync(path);
    assert.equal(raw.byteLength, FILE_HEADER_BYTES);
    assert.equal(raw.subarray(0, MAGIC_HEADER_BYTES.byteLength).toString("utf8"), MAGIC_HEADER);
    assert.equal(raw.readUInt8(MAGIC_HEADER_BYTES.byteLength), FORMAT_MAJOR_VERSION);
    assert.equal(raw.readUInt8(MAGIC_HEADER_BYTES.byteLength + 1), FORMAT_MINOR_VERSION);
    assert.equal(raw.readUInt8(MAGIC_HEADER_BYTES.byteLength + 2), SERIALIZATION_FORMAT);
    assert.equal(raw.readUInt8(MAGIC_HEADER_BYTES.byteLength + 3), SERIALIZATION_VERSION);
  });

  it("opens an existing database file when the magic header is valid", () => {
    const path = join(createTempDirectory(), "test.pdb");

    const first = pocketDb({ path });
    first.close();

    const second = pocketDb({ path });
    second.close();

    assert.equal(readFileSync(path).subarray(0, MAGIC_HEADER_BYTES.byteLength).toString("utf8"), MAGIC_HEADER);
  });
});
