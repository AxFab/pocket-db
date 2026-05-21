import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeDeleteDocumentPayload,
  decodePutDocumentPayload,
  encodeDeleteDocumentPayload,
  encodePutDocumentPayload
} from "../src/storage/document-operation.js";

describe("put document operation payload", () => {
  it("stores collection id, document id, and a U29-sized JSON document", () => {
    const collectionId = Buffer.from([1, 2, 3, 4]);
    const documentId = Buffer.from("00112233445566778899aabb", "hex");
    const payload = encodePutDocumentPayload({
      collectionId,
      documentId,
      document: {
        _id: documentId.toString("hex"),
        name: "Ada"
      }
    });

    const decoded = decodePutDocumentPayload(payload);

    assert.equal(payload.byteLength % 4, 0);
    assert.deepEqual(decoded.collectionId, collectionId);
    assert.deepEqual(decoded.documentId, documentId);
    assert.equal(decoded.documentIdHex, documentId.toString("hex"));
    assert.deepEqual(decoded.document, {
      _id: documentId.toString("hex"),
      name: "Ada"
    });
  });

  it("stores collection id and document id for delete operations", () => {
    const collectionId = Buffer.from([1, 2, 3, 4]);
    const documentId = Buffer.from("00112233445566778899aabb", "hex");
    const payload = encodeDeleteDocumentPayload({
      collectionId,
      documentId
    });

    const decoded = decodeDeleteDocumentPayload(payload);

    assert.deepEqual(decoded.collectionId, collectionId);
    assert.deepEqual(decoded.documentId, documentId);
    assert.equal(decoded.documentIdHex, documentId.toString("hex"));
  });
});
