import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileQuery, evaluateCompiledQuery, matchesQuery } from "../src/search/index.js";

const ada = { name: "Ada", age: 37, role: "admin", active: true };

describe("search query evaluation", () => {

  // ── equality ────────────────────────────────────────────────────────────

  it("matches shorthand equality queries", () => {
    assert.equal(matchesQuery({ name: "Ada" }, { name: "Ada", age: 37 }), true);
    assert.equal(matchesQuery({ name: "Grace" }, { name: "Ada", age: 37 }), false);
  });

  it("matches explicit $eq queries", () => {
    assert.equal(matchesQuery({ age: { $eq: 37 } }, ada), true);
    assert.equal(matchesQuery({ age: { $eq: 42 } }, ada), false);
  });

  // ── comparison ──────────────────────────────────────────────────────────

  it("matches $gt and $lt queries", () => {
    assert.equal(matchesQuery({ age: { $gt: 30, $lt: 40 } }, ada), true);
    assert.equal(matchesQuery({ age: { $gt: 40 } }, ada), false);
    assert.equal(matchesQuery({ age: { $lt: 30 } }, ada), false);
  });

  it("matches $gte (greater than or equal)", () => {
    assert.equal(matchesQuery({ age: { $gte: 37 } }, ada), true);   // boundary
    assert.equal(matchesQuery({ age: { $gte: 38 } }, ada), false);
    assert.equal(matchesQuery({ age: { $gte: 36 } }, ada), true);
  });

  it("matches $lte (less than or equal)", () => {
    assert.equal(matchesQuery({ age: { $lte: 37 } }, ada), true);   // boundary
    assert.equal(matchesQuery({ age: { $lte: 36 } }, ada), false);
    assert.equal(matchesQuery({ age: { $lte: 38 } }, ada), true);
  });

  it("matches combined $gte / $lte range (inclusive boundaries)", () => {
    assert.equal(matchesQuery({ age: { $gte: 37, $lte: 37 } }, ada), true);
    assert.equal(matchesQuery({ age: { $gte: 30, $lte: 37 } }, ada), true);
    assert.equal(matchesQuery({ age: { $gte: 38, $lte: 50 } }, ada), false);
  });

  // ── inequality ──────────────────────────────────────────────────────────

  it("matches $ne (not equal)", () => {
    assert.equal(matchesQuery({ name: { $ne: "Grace" } }, ada), true);
    assert.equal(matchesQuery({ name: { $ne: "Ada" } }, ada), false);
    assert.equal(matchesQuery({ age: { $ne: 42 } }, ada), true);
  });

  it("$ne on a missing field returns true (field ≠ value is vacuously true)", () => {
    assert.equal(matchesQuery({ email: { $ne: "x@y.com" } }, ada), true);
  });

  // ── inclusion / exclusion ───────────────────────────────────────────────

  it("matches $in queries", () => {
    assert.equal(matchesQuery({ role: { $in: ["admin", "writer"] } }, ada), true);
    assert.equal(matchesQuery({ role: { $in: ["reader"] } }, ada), false);
  });

  it("matches $nin (not in)", () => {
    assert.equal(matchesQuery({ role: { $nin: ["reader", "writer"] } }, ada), true);
    assert.equal(matchesQuery({ role: { $nin: ["admin"] } }, ada), false);
    assert.equal(matchesQuery({ age: { $nin: [30, 40] } }, ada), true);
    assert.equal(matchesQuery({ age: { $nin: [37] } }, ada), false);
  });

  // ── existence ───────────────────────────────────────────────────────────

  it("matches $exists queries", () => {
    assert.equal(matchesQuery({ name: { $exists: true } }, ada), true);
    assert.equal(matchesQuery({ email: { $exists: false } }, ada), true);
    assert.equal(matchesQuery({ email: { $exists: true } }, ada), false);
  });

  // ── $not ────────────────────────────────────────────────────────────────

  it("matches $not negating a comparison", () => {
    assert.equal(matchesQuery({ age: { $not: { $gt: 40 } } }, ada), true);   // NOT (age > 40)
    assert.equal(matchesQuery({ age: { $not: { $gt: 30 } } }, ada), false);  // NOT (age > 30) → false
  });

  it("$not on a missing field: inner operator is false, so $not is true", () => {
    assert.equal(matchesQuery({ email: { $not: { $eq: "x@y.com" } } }, ada), true);
  });

  it("$not with multiple inner operators negates the conjunction", () => {
    // $not: { $gte: 30, $lte: 40 } → NOT (age >= 30 AND age <= 40)
    assert.equal(matchesQuery({ age: { $not: { $gte: 30, $lte: 40 } } }, ada), false);
    assert.equal(matchesQuery({ age: { $not: { $gte: 50, $lte: 60 } } }, ada), true);
  });

  it("rejects $not with a non-object value", () => {
    assert.throws(
      () => matchesQuery({ age: { $not: 42 } as never }, ada),
      /\$not requires an operator expression/
    );
  });

  it("rejects $not with an empty operator object", () => {
    assert.throws(
      () => matchesQuery({ age: { $not: {} } }, ada),
      /\$not requires at least one operator/
    );
  });

  // ── $and ────────────────────────────────────────────────────────────────

  it("matches $and (conjunction)", () => {
    assert.equal(matchesQuery({ $and: [{ name: "Ada" }, { age: { $gt: 30 } }] }, ada), true);
    assert.equal(matchesQuery({ $and: [{ name: "Ada" }, { age: { $lt: 30 } }] }, ada), false);
  });

  // ── $or ─────────────────────────────────────────────────────────────────

  it("matches $or (disjunction) — true when any branch matches", () => {
    assert.equal(matchesQuery({ $or: [{ name: "Ada" }, { name: "Grace" }] }, ada), true);
    assert.equal(matchesQuery({ $or: [{ name: "Grace" }, { age: { $gt: 30 } }] }, ada), true);
    assert.equal(matchesQuery({ $or: [{ name: "Grace" }, { age: { $gt: 40 } }] }, ada), false);
  });

  it("$or with a single matching branch returns true", () => {
    assert.equal(matchesQuery({ $or: [{ role: "admin" }] }, ada), true);
  });

  it("empty $or array returns false", () => {
    assert.equal(matchesQuery({ $or: [] }, ada), false);
  });

  // ── $nor ────────────────────────────────────────────────────────────────

  it("matches $nor — true when no branch matches", () => {
    assert.equal(matchesQuery({ $nor: [{ name: "Grace" }, { age: { $gt: 50 } }] }, ada), true);
    assert.equal(matchesQuery({ $nor: [{ name: "Ada" }, { age: { $gt: 50 } }] }, ada), false);
  });

  it("empty $nor array returns true", () => {
    assert.equal(matchesQuery({ $nor: [] }, ada), true);
  });

  // ── combinations ────────────────────────────────────────────────────────

  it("combines $or inside $and", () => {
    const query = {
      $and: [
        { active: true },
        { $or: [{ role: "admin" }, { role: "editor" }] }
      ]
    };
    assert.equal(matchesQuery(query, ada), true);
    assert.equal(matchesQuery(query, { name: "Bob", active: true, role: "reader" }), false);
    assert.equal(matchesQuery(query, { name: "Carol", active: false, role: "admin" }), false);
  });

  it("$nor combined with $and", () => {
    const query = { $nor: [{ name: "Grace" }], age: { $gte: 30 } };
    assert.equal(matchesQuery(query, ada), true);
    assert.equal(matchesQuery(query, { name: "Grace", age: 37 }), false);
  });

  // ── compile / evaluate low-level ────────────────────────────────────────

  it("evaluates a pre-compiled query", () => {
    const query = compileQuery({ name: "Ada" });
    assert.equal(evaluateCompiledQuery(query, ada), true);
    assert.equal(evaluateCompiledQuery(query, { name: "Grace" }), false);
  });

  // ── regular expressions ──────────────────────────────────────────────────

  it("matches $regex with a string pattern", () => {
    assert.equal(matchesQuery({ name: { $regex: "^Ad" } }, ada), true);
    assert.equal(matchesQuery({ name: { $regex: "^Gr" } }, ada), false);
    assert.equal(matchesQuery({ name: { $regex: "da$" } }, ada), true);
  });

  it("matches $regex with $options flags", () => {
    assert.equal(matchesQuery({ name: { $regex: "^ada$", $options: "i" } }, ada), true);
    assert.equal(matchesQuery({ name: { $regex: "^ada$" } }, ada), false);
  });

  it("matches $regex with a RegExp value", () => {
    assert.equal(matchesQuery({ name: { $regex: /^A.a$/ } }, ada), true);
    assert.equal(matchesQuery({ name: { $regex: /^ada$/i } }, ada), true);
    assert.equal(matchesQuery({ name: { $regex: /^Grace$/ } }, ada), false);
  });

  it("matches a bare RegExp condition as $regex shorthand", () => {
    assert.equal(matchesQuery({ name: /^Ad/ }, ada), true);
    assert.equal(matchesQuery({ name: /^gr/i }, ada), false);
  });

  it("$regex never matches non-string values", () => {
    assert.equal(matchesQuery({ age: { $regex: "37" } }, ada), false);
    assert.equal(matchesQuery({ active: { $regex: "true" } }, ada), false);
    assert.equal(matchesQuery({ missing: { $regex: ".*" } }, ada), false);
  });

  it("supports $regex inside $not", () => {
    assert.equal(matchesQuery({ name: { $not: { $regex: "^Gr" } } }, ada), true);
    assert.equal(matchesQuery({ name: { $not: { $regex: "^Ad" } } }, ada), false);
  });

  it("rejects the stateful g and y regex flags", () => {
    assert.throws(() => matchesQuery({ name: { $regex: "a", $options: "g" } }, ada), /Unsupported \$regex flag/);
    assert.throws(() => matchesQuery({ name: { $regex: /a/g } }, ada), /Unsupported \$regex flag/);
    assert.throws(() => matchesQuery({ name: { $regex: /a/y } }, ada), /Unsupported \$regex flag/);
  });

  it("rejects invalid $regex usage", () => {
    assert.throws(() => matchesQuery({ name: { $regex: 42 } as never }, ada), /\$regex must be a string or a RegExp/);
    assert.throws(() => matchesQuery({ name: { $options: "i" } as never }, ada), /\$options requires a \$regex/);
    assert.throws(() => matchesQuery({ name: { $regex: /a/i, $options: "i" } }, ada), /cannot be combined/);
    assert.throws(() => matchesQuery({ name: { $regex: "(" } }, ada), /Invalid \$regex pattern/);
  });

  // ── unsupported operators ────────────────────────────────────────────────

  it("rejects unsupported operators", () => {
    assert.throws(
      () => matchesQuery({ age: { $where: "true" } as never }, ada),
      /Unsupported query operator/
    );
  });

  it("rejects $in with a non-array value", () => {
    assert.throws(
      () => matchesQuery({ age: { $in: 42 } as never }, ada),
      /\$in must be an array/
    );
  });

  it("rejects $nin with a non-array value", () => {
    assert.throws(
      () => matchesQuery({ age: { $nin: 42 } as never }, ada),
      /\$nin must be an array/
    );
  });

  it("rejects $exists with a non-boolean value", () => {
    assert.throws(
      () => matchesQuery({ name: { $exists: "yes" } as never }, ada),
      /\$exists must be a boolean/
    );
  });

  it("rejects $or with a non-array value", () => {
    assert.throws(
      () => matchesQuery({ $or: "bad" } as never, ada),
      /\$or must be an array/
    );
  });

  it("rejects $nor with a non-array value", () => {
    assert.throws(
      () => matchesQuery({ $nor: "bad" } as never, ada),
      /\$nor must be an array/
    );
  });
});
