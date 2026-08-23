import { closeSync, mkdtempSync, openSync, rmSync, statSync, truncateSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pocketDb } from "../src/index.js";
import { OPERATION_HEADER_BYTES } from "../src/storage/constants.js";
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

/**
 * Flips one byte inside the payload of the record at `offset` (a few bytes
 * in, well past the header, so the declared length is untouched and only the
 * CRC32 check fails).
 */
function corruptByteAt(path: string, offset: number): void {
  const fd = openSync(path, "r+");
  writeSync(fd, Buffer.from("x", "utf8"), 0, 1, offset + OPERATION_HEADER_BYTES);
  closeSync(fd);
}

describe("torn-tail recovery (FileStorage.readOperations)", () => {
  it("recovers when the trailing record is missing part of its header", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const identifier = Buffer.from("ins1", "utf8");
    let storage = FileStorage.open(path);

    storage.appendOperation(identifier, Buffer.from("first", "utf8"));
    const secondOffset = storage.appendOperation(identifier, Buffer.from("second", "utf8"));
    storage.close();

    // Only 3 of the 8 header bytes for the second record made it to disk —
    // simulates a crash partway through writeSync for that record.
    const tornSize = secondOffset + 3;
    truncateSync(path, tornSize);

    storage = FileStorage.open(path);
    const operations = [...storage.readOperations()];

    assert.equal(operations.length, 1);
    assert.equal(operations[0].payload.toString("utf8"), "first");
    assert.equal(storage.recovered, true);
    assert.equal(storage.recoveredBytes, tornSize - secondOffset);
    assert.equal(storage.size, secondOffset);

    storage.close();
  });

  it("recovers when the trailing record's payload/CRC is cut short", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const identifier = Buffer.from("ins1", "utf8");
    let storage = FileStorage.open(path);

    storage.appendOperation(identifier, Buffer.from("first", "utf8"));
    const secondOffset = storage.appendOperation(identifier, Buffer.alloc(20, "z"));
    storage.close();

    // Full header present, but only 10 of the 20 payload bytes (and no CRC)
    // made it to disk.
    const tornSize = secondOffset + OPERATION_HEADER_BYTES + 10;
    truncateSync(path, tornSize);

    storage = FileStorage.open(path);
    const operations = [...storage.readOperations()];

    assert.equal(operations.length, 1);
    assert.equal(operations[0].payload.toString("utf8"), "first");
    assert.equal(storage.recovered, true);
    assert.equal(storage.recoveredBytes, tornSize - secondOffset);
    assert.equal(storage.size, secondOffset);

    storage.close();
  });

  it("recovers when the trailing record's full length is present but its CRC32 is wrong", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const identifier = Buffer.from("ins1", "utf8");
    let storage = FileStorage.open(path);

    storage.appendOperation(identifier, Buffer.from("first", "utf8"));
    const secondOffset = storage.appendOperation(identifier, Buffer.from("second", "utf8"));
    const fullSize = statSync(path).size;
    storage.close();

    // The record claims its full declared length, but a byte inside its
    // payload was flipped after the fact (relaxed durability can leave a
    // trailing record like this after a power loss even when the file's
    // apparent length already covers it).
    corruptByteAt(path, secondOffset);

    storage = FileStorage.open(path);
    const operations = [...storage.readOperations()];

    assert.equal(operations.length, 1);
    assert.equal(operations[0].payload.toString("utf8"), "first");
    assert.equal(storage.recovered, true);
    assert.equal(storage.recoveredBytes, fullSize - secondOffset);
    assert.equal(storage.size, secondOffset);

    storage.close();
  });

  it("does NOT recover a CRC32 mismatch when valid records follow it", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const identifier = Buffer.from("ins1", "utf8");
    let storage = FileStorage.open(path);

    storage.appendOperation(identifier, Buffer.from("first", "utf8"));
    const secondOffset = storage.appendOperation(identifier, Buffer.from("second", "utf8"));
    storage.appendOperation(identifier, Buffer.from("third", "utf8"));
    storage.close();

    // The corrupted record is no longer the last one in the file — this is
    // "corruption in the middle of the log", a different, still-unimplemented
    // problem (see docs/storage.md's Corruption Policy). It must still throw
    // rather than silently dropping data.
    corruptByteAt(path, secondOffset);

    storage = FileStorage.open(path);

    assert.throws(
      () => [...storage.readOperations()],
      /CRC32 checksum mismatch/
    );
    assert.equal(storage.recovered, false);

    storage.close();
  });

  it("returns nothing to recover on a clean, complete log", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const identifier = Buffer.from("ins1", "utf8");
    const storage = FileStorage.open(path);

    storage.appendOperation(identifier, Buffer.from("only", "utf8"));

    const operations = [...storage.readOperations()];

    assert.equal(operations.length, 1);
    assert.equal(storage.recovered, false);
    assert.equal(storage.recoveredBytes, 0);

    storage.close();
  });
});

describe("torn-tail recovery (Database.recovered)", () => {
  it("opens normally after a simulated crash mid-write, keeping every document written before it and reporting recovered=true", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const items = db.collection("items");

    const firstId = items.insertOne({ n: 1 }).insertedId;
    const afterFirstInsert = db.stats().sizeOnDisk;
    items.insertOne({ n: 2 });
    db.close();

    const fullSize = statSync(path).size;
    // Truncate partway through the second document's record: past the point
    // where the first insert was fully durable, short of the file's full size.
    const tornSize = Math.min(afterFirstInsert + 10, fullSize - 1);
    assert.ok(tornSize > afterFirstInsert, "test fixture needs a second record longer than 10 bytes");
    truncateSync(path, tornSize);

    const reopened = pocketDb({ path });

    assert.equal(reopened.recovered, true);
    const docs = reopened.collection("items").find({}).toArray();
    assert.equal(docs.length, 1);
    assert.equal(docs[0]._id, firstId);
    assert.equal(docs[0].n, 1);
    reopened.close();

    // The recovery already truncated the file to a clean state, so a later
    // open sees nothing left to recover.
    const reopenedAgain = pocketDb({ path });
    assert.equal(reopenedAgain.recovered, false);
    reopenedAgain.close();
  });

  it("reports recovered=false on an ordinary clean open", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    db.collection("items").insertOne({ n: 1 });
    db.close();

    const reopened = pocketDb({ path });
    assert.equal(reopened.recovered, false);
    reopened.close();
  });
});
