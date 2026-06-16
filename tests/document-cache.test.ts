import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { open } from "../src/index.js";
import { DocumentCache } from "../src/api/document-cache.js";

const tempDirectories: string[] = [];

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "pocket-db-"));
  tempDirectories.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("DocumentCache (unit)", () => {
  it("rejects a non-positive or non-integer byte budget", () => {
    assert.throws(() => new DocumentCache({ maxBytes: 0 }));
    assert.throws(() => new DocumentCache({ maxBytes: -1 }));
    assert.throws(() => new DocumentCache({ maxBytes: 1.5 }));
  });

  it("returns a cached document only when the offset matches", () => {
    const cache = new DocumentCache({ maxBytes: 1_000 });
    cache.set("a", 100, { _id: "a", v: 1 });

    assert.deepEqual(cache.get("a", 100), { _id: "a", v: 1 });
    // A different offset is a newer/older version → treated as a miss.
    assert.equal(cache.get("a", 200), undefined);
  });

  it("refreshes the cached version when the offset changes", () => {
    const cache = new DocumentCache({ maxBytes: 1_000 });
    cache.set("a", 100, { _id: "a", v: 1 });
    cache.set("a", 200, { _id: "a", v: 2 });

    assert.equal(cache.get("a", 100), undefined);
    assert.deepEqual(cache.get("a", 200), { _id: "a", v: 2 });
    assert.equal(cache.size, 1);
  });

  it("returns clones so callers cannot mutate cached state", () => {
    const cache = new DocumentCache({ maxBytes: 1_000 });
    cache.set("a", 100, { _id: "a", tags: ["x"] });

    const first = cache.get("a", 100)!;
    (first.tags as string[]).push("y");
    first._id = "mutated";

    assert.deepEqual(cache.get("a", 100), { _id: "a", tags: ["x"] });
  });

  it("evicts least-recently-used entries when the budget is exceeded", () => {
    // Fixed 10-byte cost per document → budget of 20 holds exactly two.
    const cache = new DocumentCache({ maxBytes: 20, sizeOf: () => 10 });

    cache.set("a", 1, { _id: "a" });
    cache.set("b", 2, { _id: "b" });
    // Touch "a" so "b" becomes the least-recently-used entry.
    cache.get("a", 1);
    cache.set("c", 3, { _id: "c" });

    assert.deepEqual(cache.get("a", 1), { _id: "a" });
    assert.equal(cache.get("b", 2), undefined);
    assert.deepEqual(cache.get("c", 3), { _id: "c" });
    assert.equal(cache.stats().evictions, 1);
  });

  it("does not cache a document larger than the whole budget", () => {
    const cache = new DocumentCache({ maxBytes: 5, sizeOf: () => 10 });
    cache.set("a", 1, { _id: "a" });

    assert.equal(cache.get("a", 1), undefined);
    assert.equal(cache.size, 0);
    assert.equal(cache.bytes, 0);
  });

  it("evicts to fit when the budget is shrunk", () => {
    const cache = new DocumentCache({ maxBytes: 30, sizeOf: () => 10 });
    cache.set("a", 1, { _id: "a" });
    cache.set("b", 2, { _id: "b" });
    cache.set("c", 3, { _id: "c" });
    assert.equal(cache.size, 3);

    cache.setMaxBytes(10);

    assert.equal(cache.size, 1);
    assert.deepEqual(cache.get("c", 3), { _id: "c" });
  });

  it("invalidate removes an entry and reclaims its bytes", () => {
    const cache = new DocumentCache({ maxBytes: 1_000, sizeOf: () => 10 });
    cache.set("a", 1, { _id: "a" });

    assert.equal(cache.invalidate("a"), true);
    assert.equal(cache.invalidate("a"), false);
    assert.equal(cache.bytes, 0);
    assert.equal(cache.get("a", 1), undefined);
  });

  it("tracks hit/miss/eviction statistics", () => {
    const cache = new DocumentCache({ maxBytes: 10, sizeOf: () => 10 });
    cache.set("a", 1, { _id: "a" });
    cache.get("a", 1); // hit
    cache.get("a", 1); // hit
    cache.get("z", 9); // miss
    cache.set("b", 2, { _id: "b" }); // evicts "a"

    const stats = cache.stats();
    assert.equal(stats.hits, 2);
    assert.equal(stats.misses, 1);
    assert.equal(stats.evictions, 1);

    cache.resetStats();
    assert.deepEqual(
      [cache.stats().hits, cache.stats().misses, cache.stats().evictions],
      [0, 0, 0]
    );
  });
});

describe("Collection hot-document cache", () => {
  it("is disabled by default", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");

    assert.equal(users.cacheStats(), null);

    db.close();
  });

  it("primes the cache on insert and serves reads from it", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.enableCache(1_000_000);

    const { insertedId } = users.insertOne({ name: "Ada", age: 37 });
    assert.equal(users.cacheStats()?.documentCount, 1);

    const document = users.findOne({ _id: insertedId });
    assert.deepEqual(document, { _id: insertedId, name: "Ada", age: 37 });
    assert.ok((users.cacheStats()?.hits ?? 0) >= 1);

    db.close();
  });

  it("warms from cold when enabled after inserts", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    const { insertedId } = users.insertOne({ name: "Ada" });

    users.enableCache(1_000_000);
    assert.equal(users.cacheStats()?.documentCount, 0);

    users.findOne({ _id: insertedId }); // miss → populates
    const stats = users.cacheStats()!;
    assert.equal(stats.misses, 1);
    assert.equal(stats.documentCount, 1);

    users.findOne({ _id: insertedId }); // hit
    assert.ok(users.cacheStats()!.hits >= 1);

    db.close();
  });

  it("keeps a document hot across updates", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.enableCache(1_000_000);

    const { insertedId } = users.insertOne({ name: "Ada", age: 37 });
    users.updateOne(insertedId, { $set: { age: 38 } });

    const document = users.findOne({ _id: insertedId });
    assert.deepEqual(document, { _id: insertedId, name: "Ada", age: 38 });
    assert.equal(users.cacheStats()?.documentCount, 1);

    db.close();
  });

  it("invalidates a deleted document", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.enableCache(1_000_000);

    const { insertedId } = users.insertOne({ name: "Ada" });
    assert.equal(users.cacheStats()?.documentCount, 1);

    users.deleteOne(insertedId);
    assert.equal(users.cacheStats()?.documentCount, 0);
    assert.equal(users.findOne({ _id: insertedId }), null);

    db.close();
  });

  it("preserves cursor snapshot semantics with the cache enabled", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.enableCache(1_000_000);

    const { insertedId } = users.insertOne({ name: "Ada" });

    const cursor = users.find({});
    // Replace after the cursor snapshot: the cache now holds the newer version
    // at a new offset, but the cursor's candidate offset still points at "Ada".
    users.replaceOne(insertedId, { name: "Grace" });

    assert.deepEqual(
      cursor.toArray().map((document) => document.name),
      ["Ada"]
    );
    assert.deepEqual(
      users.find({}).toArray().map((document) => document.name),
      ["Grace"]
    );

    db.close();
  });

  it("returns independent objects that do not corrupt the cache when mutated", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.enableCache(1_000_000);

    const { insertedId } = users.insertOne({ name: "Ada", tags: ["a"] });

    const first = users.findOne({ _id: insertedId })!;
    (first.tags as string[]).push("b");
    first.name = "Mutated";

    assert.deepEqual(users.findOne({ _id: insertedId }), {
      _id: insertedId,
      name: "Ada",
      tags: ["a"]
    });

    db.close();
  });

  it("disableCache frees the cache and falls back to disk reads", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.enableCache(1_000_000);

    const { insertedId } = users.insertOne({ name: "Ada" });
    users.disableCache();

    assert.equal(users.cacheStats(), null);
    assert.deepEqual(users.findOne({ _id: insertedId }), { _id: insertedId, name: "Ada" });

    db.close();
  });
});
