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

  // ── $mul ──────────────────────────────────────────────────────────────

  it("multiplies an existing number field with $mul", () => {
    const updated = updateDocument({ price: 10, qty: 4 }, { $mul: { price: 2.5, qty: 0 } });
    assert.deepEqual(updated, { price: 25, qty: 0 });
  });

  it("rejects $mul on missing or non-number fields", () => {
    assert.throws(
      () => updateDocument({ price: "10" }, { $mul: { price: 2 } }),
      /expected an existing number field/
    );
    assert.throws(
      () => updateDocument({}, { $mul: { price: 2 } }),
      /expected an existing number field/
    );
    assert.throws(
      () => updateDocument({ price: 10 }, { $mul: { price: "2" } } as never),
      /update value must be a number/
    );
  });

  // ── $rename ───────────────────────────────────────────────────────────

  it("renames a field with $rename", () => {
    const document = { name: "Ada", age: 37 };
    const updated = updateDocument(document, { $rename: { name: "firstName" } });

    assert.deepEqual(updated, { firstName: "Ada", age: 37 });
    assert.deepEqual(document, { name: "Ada", age: 37 });
  });

  it("$rename on a missing source field is a no-op and overwrites an existing target", () => {
    assert.deepEqual(
      updateDocument({ age: 37 }, { $rename: { name: "firstName" } }),
      { age: 37 }
    );
    assert.deepEqual(
      updateDocument({ name: "Ada", firstName: "Old" }, { $rename: { name: "firstName" } }),
      { firstName: "Ada" }
    );
  });

  it("rejects invalid $rename targets", () => {
    assert.throws(
      () => updateDocument({ name: "Ada" }, { $rename: { name: "" } }),
      /must be a non-empty string/
    );
    assert.throws(
      () => updateDocument({ name: "Ada" }, { $rename: { name: 42 } } as never),
      /must be a non-empty string/
    );
    assert.throws(
      () => updateDocument({ name: "Ada" }, { $rename: { name: "name" } }),
      /source and target names must differ/
    );
  });

  // ── $currentDate ──────────────────────────────────────────────────────

  it("sets the current date as ISO string with true or { $type: \"date\" }", () => {
    const before = Date.now();
    const updated = updateDocument({}, {
      $currentDate: { updatedAt: true, modifiedAt: { $type: "date" } }
    });
    const after = Date.now();

    for (const field of ["updatedAt", "modifiedAt"] as const) {
      const value = updated[field];
      assert.equal(typeof value, "string");
      const parsed = Date.parse(value as string);
      assert.ok(parsed >= before && parsed <= after);
    }
  });

  it("sets the current date as epoch milliseconds with { $type: \"timestamp\" }", () => {
    const before = Date.now();
    const updated = updateDocument({}, { $currentDate: { updatedAt: { $type: "timestamp" } } });
    const after = Date.now();

    const value = updated.updatedAt;
    assert.equal(typeof value, "number");
    assert.ok((value as number) >= before && (value as number) <= after);
  });

  it("rejects invalid $currentDate specifications", () => {
    assert.throws(
      () => updateDocument({}, { $currentDate: { updatedAt: false } } as never),
      /must be true or \{ \$type/
    );
    assert.throws(
      () => updateDocument({}, { $currentDate: { updatedAt: { $type: "unix" } } } as never),
      /must be true or \{ \$type/
    );
  });

  // ── $addToSet ─────────────────────────────────────────────────────────

  it("$addToSet appends only missing values (deep equality)", () => {
    const document = { tags: ["engine", { kind: "io" }] };

    const unchanged = updateDocument(document, { $addToSet: { tags: "engine" } });
    assert.deepEqual(unchanged, { tags: ["engine", { kind: "io" }] });

    const unchangedDeep = updateDocument(document, { $addToSet: { tags: { kind: "io" } } });
    assert.deepEqual(unchangedDeep, { tags: ["engine", { kind: "io" }] });

    const updated = updateDocument(document, { $addToSet: { tags: "storage" } });
    assert.deepEqual(updated, { tags: ["engine", { kind: "io" }, "storage"] });
    assert.deepEqual(document, { tags: ["engine", { kind: "io" }] });
  });

  it("rejects $addToSet on missing or non-array fields", () => {
    assert.throws(
      () => updateDocument({}, { $addToSet: { tags: "x" } }),
      /expected an existing array field/
    );
  });

  // ── $pop ──────────────────────────────────────────────────────────────

  it("$pop removes the last (1) or first (-1) element", () => {
    const document = { tags: ["a", "b", "c"] };

    assert.deepEqual(updateDocument(document, { $pop: { tags: 1 } }), { tags: ["a", "b"] });
    assert.deepEqual(updateDocument(document, { $pop: { tags: -1 } }), { tags: ["b", "c"] });
    assert.deepEqual(updateDocument({ tags: [] }, { $pop: { tags: 1 } }), { tags: [] });
    assert.deepEqual(document, { tags: ["a", "b", "c"] });
  });

  it("rejects invalid $pop directions and non-array fields", () => {
    assert.throws(
      () => updateDocument({ tags: ["a"] }, { $pop: { tags: 2 } } as never),
      /must be 1 \(last\) or -1 \(first\)/
    );
    assert.throws(
      () => updateDocument({}, { $pop: { tags: 1 } }),
      /expected an existing array field/
    );
  });

  // ── $pull / $pullAll ──────────────────────────────────────────────────

  it("$pull removes elements equal to a literal value", () => {
    const document = { scores: [1, 2, 1, 3] };
    const updated = updateDocument(document, { $pull: { scores: 1 } });

    assert.deepEqual(updated, { scores: [2, 3] });
    assert.deepEqual(document, { scores: [1, 2, 1, 3] });
  });

  it("$pull removes elements matching an operator expression", () => {
    assert.deepEqual(
      updateDocument({ scores: [1, 5, 8, 3] }, { $pull: { scores: { $gte: 5 } } }),
      { scores: [1, 3] }
    );
    assert.deepEqual(
      updateDocument({ tags: ["ab", "cd", "ax"] }, { $pull: { tags: { $regex: "^a" } } }),
      { tags: ["cd"] }
    );
  });

  it("$pullAll removes elements equal to any listed value", () => {
    assert.deepEqual(
      updateDocument({ scores: [1, 2, 3, 2, 4] }, { $pullAll: { scores: [2, 4] } }),
      { scores: [1, 3] }
    );
  });

  it("rejects $pull / $pullAll on non-array fields and invalid $pullAll values", () => {
    assert.throws(
      () => updateDocument({}, { $pull: { tags: "x" } }),
      /expected an existing array field/
    );
    assert.throws(
      () => updateDocument({ tags: ["a"] }, { $pullAll: { tags: "a" } } as never),
      /must be an array/
    );
  });

  // ── unsupported operators ─────────────────────────────────────────────

  it("rejects unsupported update operators", () => {
    assert.throws(
      () => updateDocument({ name: "Ada" }, { $setOnInsert: { name: "Grace" } } as never),
      /Unsupported update operator/
    );
  });
});
