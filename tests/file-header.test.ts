import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  FILE_HEADER_BYTES,
  FORMAT_MAJOR_VERSION,
  HOLE_OPERATION,
  MAGIC_HEADER,
  MAGIC_HEADER_BYTES,
  SERIALIZATION_FORMAT
} from "../src/storage/constants.js";
import { FileStorage } from "../src/storage/file-storage.js";
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

describe("file header", () => {
  it("writes the full 12-byte header on a new file", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const storage = FileStorage.open(path);
    storage.close();

    // First operation starts exactly after the header.
    const identifier = Buffer.from("wrt1", "utf8");
    const reopen = FileStorage.open(path);
    const offset = reopen.appendOperation(identifier, Buffer.alloc(0));
    reopen.close();

    assert.equal(offset, FILE_HEADER_BYTES);
  });

  it("reopens a valid file without error", () => {
    const path = join(createTempDirectory(), "test.pdb");
    FileStorage.open(path).close();
    assert.doesNotThrow(() => FileStorage.open(path).close());
  });

  it("rejects a file whose magic header does not match", () => {
    const path = join(createTempDirectory(), "bad-magic.pdb");

    // Write a 12-byte header with wrong magic.
    const fd = openSync(path, "wx+");
    const header = Buffer.alloc(FILE_HEADER_BYTES);
    Buffer.from("wrongmag", "utf8").copy(header, 0);
    writeSync(fd, header, 0, header.length, 0);
    closeSync(fd);

    assert.throws(
      () => FileStorage.open(path),
      new RegExp(`expected "${MAGIC_HEADER}" header`)
    );
  });

  it("rejects a file whose format major version differs", () => {
    const path = join(createTempDirectory(), "test.pdb");
    FileStorage.open(path).close();

    // Corrupt the format major version byte (offset 8).
    const fd = openSync(path, "r+");
    const bump = Buffer.from([FORMAT_MAJOR_VERSION + 1]);
    writeSync(fd, bump, 0, 1, MAGIC_HEADER_BYTES.byteLength);
    closeSync(fd);

    assert.throws(
      () => FileStorage.open(path),
      /Unsupported Pocket DB format version/
    );
  });

  it("rejects a file whose serialization format char differs", () => {
    const path = join(createTempDirectory(), "test.pdb");
    FileStorage.open(path).close();

    // Corrupt the serialization format byte (offset 10 = magic(8) + formatMinor(1) + skip(1)).
    const fd = openSync(path, "r+");
    const bump = Buffer.from([SERIALIZATION_FORMAT + 1]);
    writeSync(fd, bump, 0, 1, MAGIC_HEADER_BYTES.byteLength + 2);
    closeSync(fd);

    assert.throws(
      () => FileStorage.open(path),
      /Unsupported serialization format/
    );
  });

  it("rejects a file whose serialization version differs", () => {
    const path = join(createTempDirectory(), "test.pdb");
    FileStorage.open(path).close();

    // Corrupt the serialization version byte (offset 11).
    const fd = openSync(path, "r+");
    const bump = Buffer.from([1]);
    writeSync(fd, bump, 0, 1, MAGIC_HEADER_BYTES.byteLength + 3);
    closeSync(fd);

    assert.throws(
      () => FileStorage.open(path),
      /Unsupported serialization version/
    );
  });

  it("rejects a file that is too short to hold a header", () => {
    const path = join(createTempDirectory(), "short.pdb");

    const fd = openSync(path, "wx+");
    writeSync(fd, Buffer.from("pocket", "utf8"), 0, 6, 0);
    closeSync(fd);

    assert.throws(
      () => FileStorage.open(path),
      /header too short/
    );
  });
});

describe("hol0 (hole operation) replay", () => {
  it("skips hol0 records and makes no change to the database state", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.insertOne({ name: "Ada" });
    db.close();

    // Append a bare hol0 directly via FileStorage.
    const storage = FileStorage.open(path);
    storage.appendOperation(HOLE_OPERATION, Buffer.alloc(0));
    storage.close();

    // Reopen — the hol0 must be silently skipped during replay.
    const reopened = open({ path });
    const docs = reopened.collection("users").find({}).toArray();
    reopened.close();

    assert.equal(docs.length, 1);
    assert.equal(docs[0].name, "Ada");
  });

  it("allows appending operations after hol0 without corrupting the log", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    db.collection("users");
    db.close();

    const storage = FileStorage.open(path);
    storage.appendOperation(HOLE_OPERATION, Buffer.alloc(0));
    storage.close();

    // Now open via the full API and insert normally.
    const db2 = open({ path });
    db2.collection("users").insertOne({ name: "Grace" });
    db2.close();

    const db3 = open({ path });
    const docs = db3.collection("users").find({}).toArray();
    db3.close();

    assert.equal(docs.length, 1);
    assert.equal(docs[0].name, "Grace");
  });
});
