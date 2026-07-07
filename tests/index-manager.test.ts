import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileQuery, type DocumentRecord } from "../src/search/index.js";
import { IndexManager, InMemoryPrimaryIndex, type IndexCandidate } from "../src/indexes/index.js";

type Doc = { _id: string } & Record<string, unknown>;

function seed(manager: IndexManager, primaryIndex: InMemoryPrimaryIndex, docs: Doc[]): void {
  docs.forEach((doc, offset) => {
    primaryIndex.set(doc._id, offset);
    manager.updateDocument(doc as unknown as DocumentRecord, { id: doc._id, offset });
  });
}

function ids(candidates: IndexCandidate[]): string[] {
  return candidates.map((candidate) => candidate.id).sort();
}

describe("IndexManager.plan — candidate intersection", () => {
  it("intersects two different indexed fields instead of picking only the smaller one", () => {
    const manager = new IndexManager();
    manager.createIndex("role", "string");
    manager.createIndex("age", "number");
    const primaryIndex = new InMemoryPrimaryIndex();

    // role = "admin": A, B, C, D  (4 candidates)
    // age > 30:       B, C, E     (3 candidates)
    // intersection:   B, C        (2 candidates)
    seed(manager, primaryIndex, [
      { _id: "A", role: "admin", age: 20 },
      { _id: "B", role: "admin", age: 40 },
      { _id: "C", role: "admin", age: 50 },
      { _id: "D", role: "admin", age: 25 },
      { _id: "E", role: "reader", age: 60 },
      { _id: "F", role: "reader", age: 10 }
    ]);

    const query = compileQuery({ role: "admin", age: { $gt: 30 } });
    const plan = manager.plan(query, primaryIndex);

    assert.deepEqual(ids(plan.candidates), ["B", "C"]);
    assert.deepEqual(
      plan.usedIndexes.map((definition) => definition.field).sort(),
      ["age", "role"]
    );
  });

  it("falls back to the single index result when only one predicate is indexed", () => {
    const manager = new IndexManager();
    manager.createIndex("role", "string");
    const primaryIndex = new InMemoryPrimaryIndex();

    seed(manager, primaryIndex, [
      { _id: "A", role: "admin", age: 20 },
      { _id: "B", role: "admin", age: 40 },
      { _id: "C", role: "reader", age: 40 }
    ]);

    // `age` has no index — only `role` narrows; `age` is left to the residual filter.
    const query = compileQuery({ role: "admin", age: { $gt: 30 } });
    const plan = manager.plan(query, primaryIndex);

    assert.deepEqual(ids(plan.candidates), ["A", "B"]);
    assert.deepEqual(plan.usedIndexes.map((definition) => definition.field), ["role"]);
  });

  it("falls back to a full primary index snapshot when no predicate is indexed", () => {
    const manager = new IndexManager();
    const primaryIndex = new InMemoryPrimaryIndex();

    seed(manager, primaryIndex, [
      { _id: "A", role: "admin" },
      { _id: "B", role: "reader" }
    ]);

    const query = compileQuery({ role: "admin" });
    const plan = manager.plan(query, primaryIndex);

    assert.deepEqual(ids(plan.candidates), ["A", "B"]);
    assert.deepEqual(plan.usedIndexes, []);
  });

  it("intersects two predicates on the same field from a $and clause", () => {
    const manager = new IndexManager();
    manager.createIndex("age", "number");
    const primaryIndex = new InMemoryPrimaryIndex();

    seed(manager, primaryIndex, [
      { _id: "A", age: 3 },
      { _id: "B", age: 7 },
      { _id: "C", age: 9 },
      { _id: "D", age: 12 }
    ]);

    // Two separate FieldPredicates on "age" (not merged at compile time),
    // each answered by the same NumberIndex; both scans must be intersected.
    const query = compileQuery({ $and: [{ age: { $gt: 5 } }, { age: { $lt: 10 } }] });
    const plan = manager.plan(query, primaryIndex);

    assert.deepEqual(ids(plan.candidates), ["B", "C"]);
    assert.deepEqual(plan.usedIndexes.map((definition) => definition.field), ["age", "age"]);
  });

  it("empties the result as soon as an intersection has no overlap, without needing every list", () => {
    const manager = new IndexManager();
    manager.createIndex("role", "string");
    manager.createIndex("age", "number");
    manager.createIndex("score", "number");
    const primaryIndex = new InMemoryPrimaryIndex();

    seed(manager, primaryIndex, [
      { _id: "A", role: "admin", age: 40, score: 1 },
      { _id: "B", role: "reader", age: 50, score: 2 }
    ]);

    const query = compileQuery({ role: "admin", age: { $gt: 30 }, score: { $gt: 100 } });
    const plan = manager.plan(query, primaryIndex);

    assert.deepEqual(plan.candidates, []);
  });
});
