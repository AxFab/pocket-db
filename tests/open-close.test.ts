import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { open } from "../src/index.js";
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

describe("open", () => {
  it("creates a database file and writes the full 12-byte file header", () => {
    const path = join(createTempDirectory(), "test.pdb");

    const db = open({ path });
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

    const first = open({ path });
    first.close();

    const second = open({ path });
    second.close();

    assert.equal(readFileSync(path).subarray(0, MAGIC_HEADER_BYTES.byteLength).toString("utf8"), MAGIC_HEADER);
  });
});
