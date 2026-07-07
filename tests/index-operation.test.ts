import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeCreateIndexPayload,
  encodeCreateIndexPayload
} from "../src/storage/index-operation.js";

describe("create index operation payload", () => {
  it("stores collection id, index type, and a U29-sized UTF-8 field", () => {
    const collectionId = Buffer.from([1, 2, 3, 4]);
    const payload = encodeCreateIndexPayload({
      collectionId,
      field: "email",
      type: "string",
      unique: false
    });

    const decoded = decodeCreateIndexPayload(payload);

    assert.equal(payload.byteLength % 4, 0);
    assert.deepEqual(decoded.collectionId, collectionId);
    assert.equal(decoded.field, "email");
    assert.equal(decoded.type, "string");
    assert.equal(decoded.unique, false);
  });

  it("round-trips the unique flag", () => {
    const collectionId = Buffer.from([9, 8, 7, 6]);
    const payload = encodeCreateIndexPayload({
      collectionId,
      field: "email",
      type: "string",
      unique: true
    });

    const decoded = decodeCreateIndexPayload(payload);

    assert.equal(payload.byteLength % 4, 0);
    assert.equal(decoded.unique, true);
  });
});
