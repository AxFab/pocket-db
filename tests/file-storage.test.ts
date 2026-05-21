import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { FILE_HEADER_BYTES } from "../src/storage/constants.js";
import { FileStorage } from "../src/storage/file-storage.js";

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

describe("FileStorage", () => {
  it("appends and reads an operation at its offset", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const storage = FileStorage.open(path);
    const identifier = Buffer.from("wrt1", "utf8");
    const payload = Buffer.from(JSON.stringify({ collection: "users", id: "1" }), "utf8");

    const offset = storage.appendOperation(identifier, payload);
    const operation = storage.readOperationAtOffset(offset);

    storage.close();

    assert.equal(offset, FILE_HEADER_BYTES);
    assert.deepEqual(operation.identifier, identifier);
    assert.deepEqual(operation.payload, payload);
  });

  it("can read multiple appended operations by offset", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const storage = FileStorage.open(path);
    const firstIdentifier = Buffer.from("ins1", "utf8");
    const secondIdentifier = Buffer.from("del1", "utf8");

    const firstOffset = storage.appendOperation(firstIdentifier, Buffer.from("first", "utf8"));
    const secondOffset = storage.appendOperation(secondIdentifier, Buffer.from("second", "utf8"));

    const first = storage.readOperationAtOffset(firstOffset);
    const second = storage.readOperationAtOffset(secondOffset);

    storage.close();

    assert.deepEqual(first.identifier, firstIdentifier);
    assert.equal(first.payload.toString("utf8"), "first");
    assert.deepEqual(second.identifier, secondIdentifier);
    assert.equal(second.payload.toString("utf8"), "second");
  });

  it("rejects an operation when the CRC32 checksum does not match", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const storage = FileStorage.open(path);
    const offset = storage.appendOperation(Buffer.from("ins1", "utf8"), Buffer.from("valid", "utf8"));

    storage.close();

    const fd = openSync(path, "r+");
    writeSync(fd, Buffer.from("x", "utf8"), 0, 1, offset + 8);
    closeSync(fd);

    const reopened = FileStorage.open(path);

    assert.throws(
      () => reopened.readOperationAtOffset(offset),
      /CRC32 checksum mismatch/
    );

    reopened.close();
  });
});
