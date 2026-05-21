import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createObjectId, objectIdFromHex } from "../src/storage/document-id.js";

describe("ObjectId-like document ids", () => {
  it("generates 12-byte ids exposed as 24-character lowercase hex strings", () => {
    const id = createObjectId();

    assert.equal(id.byteLength, 12);
    assert.match(id.toString("hex"), /^[0-9a-f]{24}$/u);
  });

  it("encodes the current timestamp in the first four bytes", () => {
    const before = Math.floor(Date.now() / 1000);
    const id = createObjectId();
    const after = Math.floor(Date.now() / 1000);
    const timestamp = id.readUInt32BE(0);

    assert.equal(timestamp >= before, true);
    assert.equal(timestamp <= after, true);
  });

  it("decodes valid hex ids and rejects invalid ids", () => {
    assert.deepEqual(
      objectIdFromHex("00112233445566778899aabb"),
      Buffer.from("00112233445566778899aabb", "hex")
    );
    assert.throws(
      () => objectIdFromHex("00112233445566778899AABB"),
      /24-character lowercase hex/
    );
  });
});
