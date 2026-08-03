import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeCreateIndexPayload,
  encodeCreateIndexPayload
} from "../src/storage/index-operation.js";
import { alignTo4Bytes } from "../src/storage/padding.js";
import { encodeU29 } from "../src/storage/u29.js";

/**
 * Builds a create-index payload using the pre-0.1.4 layout, i.e. without the
 * "unique" byte that was inserted after the type byte in 0.1.4:
 *   collectionId(4) + type(1) + U29 field length + field bytes
 * (0.1.4+ layout is collectionId(4) + type(1) + unique(1) + U29 field length + field bytes.)
 */
function encodeLegacyCreateIndexPayload(collectionId: Buffer, type: number, field: string): Buffer {
  const fieldBytes = Buffer.from(field, "utf8");
  const encodedFieldLength = encodeU29(fieldBytes.byteLength);
  const unalignedLength = collectionId.byteLength + 1 /* type */ + encodedFieldLength.byteLength + fieldBytes.byteLength;
  const payload = Buffer.alloc(alignTo4Bytes(unalignedLength));

  collectionId.copy(payload, 0);
  payload.writeUInt8(type, collectionId.byteLength);
  encodedFieldLength.copy(payload, collectionId.byteLength + 1);
  fieldBytes.copy(payload, collectionId.byteLength + 1 + encodedFieldLength.byteLength);

  return payload;
}

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

  it("decodes pre-0.1.4 payloads (no unique byte) and defaults unique to false", () => {
    const collectionId = Buffer.from([1, 2, 3, 4]);
    const payload = encodeLegacyCreateIndexPayload(collectionId, 1 /* string */, "email");

    const decoded = decodeCreateIndexPayload(payload);

    assert.deepEqual(decoded.collectionId, collectionId);
    assert.equal(decoded.field, "email");
    assert.equal(decoded.type, "string");
    assert.equal(decoded.unique, false);
  });

  it("decodes pre-0.1.4 payloads with a numeric index type", () => {
    const collectionId = Buffer.from([9, 8, 7, 6]);
    const payload = encodeLegacyCreateIndexPayload(collectionId, 2 /* number */, "age");

    const decoded = decodeCreateIndexPayload(payload);

    assert.equal(decoded.type, "number");
    assert.equal(decoded.unique, false);
  });

  it("decodes pre-0.1.4 payloads for a single-character field name (unique/length byte ambiguity)", () => {
    // A 1-character field name encodes its U29 length as the single byte `1`,
    // which is also a valid "unique" byte under the current layout. This
    // exercises the fallback path picking the legacy layout correctly even
    // in this ambiguous case.
    const collectionId = Buffer.from([1, 1, 1, 1]);
    const payload = encodeLegacyCreateIndexPayload(collectionId, 1 /* string */, "x");

    const decoded = decodeCreateIndexPayload(payload);

    assert.equal(decoded.field, "x");
    assert.equal(decoded.unique, false);
  });
});
