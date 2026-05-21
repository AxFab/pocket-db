import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { updateDocument } from "../src/search/index.js";

describe("document update evaluation", () => {
  it("sets and unsets fields without mutating the original document", () => {
    const document = {
      name: "Ada",
      title: "Programmer"
    };

    const updated = updateDocument(document, {
      $set: { active: true },
      $unset: { title: true }
    });

    assert.deepEqual(updated, {
      name: "Ada",
      active: true
    });
    assert.deepEqual(document, {
      name: "Ada",
      title: "Programmer"
    });
  });

  it("applies numeric min, max, and increment updates", () => {
    const updated = updateDocument(
      {
        low: 10,
        high: 10,
        count: 2
      },
      {
        $min: { low: 5 },
        $max: { high: 20 },
        $inc: { count: 3 }
      }
    );

    assert.deepEqual(updated, {
      low: 5,
      high: 20,
      count: 5
    });
  });

  it("keeps numeric values when min or max does not cross the current value", () => {
    const updated = updateDocument(
      {
        low: 10,
        high: 10
      },
      {
        $min: { low: 12 },
        $max: { high: 8 }
      }
    );

    assert.deepEqual(updated, {
      low: 10,
      high: 10
    });
  });

  it("pushes a value to an existing array without mutating the original array", () => {
    const document = {
      tags: ["engine"]
    };

    const updated = updateDocument(document, {
      $push: { tags: "storage" }
    });

    assert.deepEqual(updated, {
      tags: ["engine", "storage"]
    });
    assert.deepEqual(document, {
      tags: ["engine"]
    });
  });

  it("rejects numeric updates on missing or non-number fields", () => {
    assert.throws(
      () => updateDocument({ count: "2" }, { $inc: { count: 1 } }),
      /expected an existing number field/
    );
    assert.throws(
      () => updateDocument({}, { $min: { count: 1 } }),
      /expected an existing number field/
    );
  });

  it("rejects push updates on missing or non-array fields", () => {
    assert.throws(
      () => updateDocument({ tags: "engine" }, { $push: { tags: "storage" } }),
      /expected an existing array field/
    );
    assert.throws(
      () => updateDocument({}, { $push: { tags: "storage" } }),
      /expected an existing array field/
    );
  });

  it("rejects unsupported update operators", () => {
    assert.throws(
      () => updateDocument({ name: "Ada" }, { $rename: { name: "firstName" } } as never),
      /Unsupported update operator/
    );
  });
});
