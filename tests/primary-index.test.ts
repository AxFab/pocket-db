import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InMemoryPrimaryIndex } from "../src/indexes/index.js";

describe("PrimaryIndex", () => {
  it("stores candidates and returns a full snapshot", () => {
    const index = new InMemoryPrimaryIndex();

    index.set("00112233445566778899aabb", 8);
    index.set("00112233445566778899aacc", 42);

    assert.deepEqual(index.definition, {
      field: "_id",
      type: "$id"
    });
    assert.equal(index.has("00112233445566778899aabb"), true);
    assert.deepEqual(index.get("00112233445566778899aabb"), {
      id: "00112233445566778899aabb",
      offset: 8
    });
    assert.deepEqual(index.snapshot(), [
      { id: "00112233445566778899aabb", offset: 8 },
      { id: "00112233445566778899aacc", offset: 42 }
    ]);
  });

  it("scans _id equality and inclusion predicates", () => {
    const index = new InMemoryPrimaryIndex();
    index.set("00112233445566778899aabb", 8);
    index.set("00112233445566778899aacc", 42);

    assert.deepEqual(index.scan({
      type: "field",
      field: "_id",
      operators: [{ type: "eq", value: "00112233445566778899aabb" }]
    }), [
      { id: "00112233445566778899aabb", offset: 8 }
    ]);
    assert.deepEqual(index.scan({
      type: "field",
      field: "_id",
      operators: [{ type: "in", values: ["missing", "00112233445566778899aacc"] }]
    }), [
      { id: "00112233445566778899aacc", offset: 42 }
    ]);
  });
});
