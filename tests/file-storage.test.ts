import { closeSync, mkdtempSync, openSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { FILE_HEADER_BYTES } from "../src/storage/constants.js";
import { FileStorage } from "../src/storage/file-storage.js";
import { readOperationFromBuffer } from "../src/storage/operation-record.js";

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

  describe("readOperations (streaming replay)", () => {
    it("returns nothing for an empty log", () => {
      const path = join(createTempDirectory(), "test.pdb");
      const storage = FileStorage.open(path);

      const operations = [...storage.readOperations()];

      storage.close();
      assert.deepEqual(operations, []);
    });

    it("yields every record in order with the default chunk size", () => {
      const path = join(createTempDirectory(), "test.pdb");
      const storage = FileStorage.open(path);
      const identifier = Buffer.from("ins1", "utf8");
      const offsets: number[] = [];

      for (let i = 0; i < 50; i++) {
        offsets.push(storage.appendOperation(identifier, Buffer.from(`payload-${i}`, "utf8")));
      }

      const operations = [...storage.readOperations()];

      storage.close();
      assert.equal(operations.length, 50);
      operations.forEach((operation, i) => {
        assert.equal(operation.offset, offsets[i]);
        assert.equal(operation.payload.toString("utf8"), `payload-${i}`);
      });
    });

    it("yields identical records regardless of chunk size, including chunks far smaller than a single record", () => {
      const path = join(createTempDirectory(), "test.pdb");
      const storage = FileStorage.open(path);
      const identifier = Buffer.from("ins1", "utf8");

      for (let i = 0; i < 40; i++) {
        // Payload length varies so records straddle chunk boundaries differently
        // from one iteration to the next.
        storage.appendOperation(identifier, Buffer.from(`x${"y".repeat(i % 13)}-${i}`, "utf8"));
      }

      const fullChunk = [...storage.readOperations()];
      // Smaller than a single 8-byte record header: forces the sliding window
      // to refill on almost every record.
      const tinyChunk = [...storage.readOperations(4)];
      // Exactly one byte: the most aggressive boundary-crossing case.
      const oneByteChunk = [...storage.readOperations(1)];

      storage.close();

      assert.equal(tinyChunk.length, fullChunk.length);
      assert.equal(oneByteChunk.length, fullChunk.length);

      for (let i = 0; i < fullChunk.length; i++) {
        assert.equal(tinyChunk[i].offset, fullChunk[i].offset);
        assert.deepEqual(tinyChunk[i].payload, fullChunk[i].payload);
        assert.equal(oneByteChunk[i].offset, fullChunk[i].offset);
        assert.deepEqual(oneByteChunk[i].payload, fullChunk[i].payload);
      }
    });

    it("handles a single record larger than the chunk size", () => {
      const path = join(createTempDirectory(), "test.pdb");
      const storage = FileStorage.open(path);
      const identifier = Buffer.from("ins1", "utf8");
      const largePayload = Buffer.alloc(4096, "z");

      storage.appendOperation(identifier, Buffer.from("before", "utf8"));
      const largeOffset = storage.appendOperation(identifier, largePayload);
      storage.appendOperation(identifier, Buffer.from("after", "utf8"));

      // Chunk size (64 bytes) is far smaller than the 4096-byte payload: the
      // sliding window must grow past chunkBytes for that one record, then
      // shrink back for the next.
      const operations = [...storage.readOperations(64)];

      storage.close();
      assert.equal(operations.length, 3);
      assert.equal(operations[0].payload.toString("utf8"), "before");
      assert.equal(operations[1].offset, largeOffset);
      assert.deepEqual(operations[1].payload, largePayload);
      assert.equal(operations[2].payload.toString("utf8"), "after");
    });
  });

  describe("readBulkRange", () => {
    it("reads a range covering the given offsets, independent of FILE_HEADER_BYTES", () => {
      const path = join(createTempDirectory(), "test.pdb");
      const storage = FileStorage.open(path);
      const identifier = Buffer.from("ins1", "utf8");

      const offsetA = storage.appendOperation(identifier, Buffer.from("aaa", "utf8"));
      const offsetB = storage.appendOperation(identifier, Buffer.from("bbbb", "utf8"));
      const offsetC = storage.appendOperation(identifier, Buffer.from("ccccc", "utf8"));

      const { buffer, rangeStart } = storage.readBulkRange([offsetA, offsetC]);

      storage.close();

      assert.equal(rangeStart, offsetA);
      // The range must at least span from offsetA to the end of the record at offsetC.
      assert.ok(buffer.length >= offsetC - offsetA);

      const first = readOperationFromBuffer(buffer, offsetA - rangeStart);
      const second = readOperationFromBuffer(buffer, offsetB - rangeStart);
      const third = readOperationFromBuffer(buffer, offsetC - rangeStart);

      assert.equal(first.payload.toString("utf8"), "aaa");
      assert.equal(second.payload.toString("utf8"), "bbbb");
      assert.equal(third.payload.toString("utf8"), "ccccc");
    });

    it("does not read past the requested range's own file size", () => {
      const path = join(createTempDirectory(), "test.pdb");
      const storage = FileStorage.open(path);
      const identifier = Buffer.from("ins1", "utf8");

      const offset = storage.appendOperation(identifier, Buffer.from("only", "utf8"));
      const { buffer, rangeStart } = storage.readBulkRange([offset]);

      storage.close();

      assert.equal(rangeStart, offset);
      const operation = readOperationFromBuffer(buffer, 0);
      assert.equal(operation.payload.toString("utf8"), "only");
    });
  });
});
