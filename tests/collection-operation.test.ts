import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decodeNewCollectionPayload,
  encodeNewCollectionPayload
} from "../src/storage/collection-operation.js";

describe("new collection operation payload", () => {
  it("stores a four-byte collection id followed by a U29-sized UTF-8 name", () => {
    const id = Buffer.from([1, 2, 3, 4]);
    const payload = encodeNewCollectionPayload({ id, name: "utilisateurs", indexes: [] });
    const decoded = decodeNewCollectionPayload(payload);

    assert.equal(payload.byteLength % 4, 0);
    assert.deepEqual(decoded.id, id);
    assert.equal(decoded.name, "utilisateurs");
    assert.deepEqual(decoded.indexes, []);
  });
});
