import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { open } from "../src/index.js";
import { DELETE_DOCUMENT_OPERATION, FILE_HEADER_BYTES, HOLE_OPERATION, PUT_DOCUMENT_OPERATION, TRANSACTION_BEGIN_OPERATION } from "../src/storage/constants.js";
import { createObjectId, objectIdFromHex } from "../src/storage/document-id.js";
import { encodeDeleteDocumentPayload, encodePutDocumentPayload } from "../src/storage/document-operation.js";
import { jsonEncoder } from "../src/storage/encoding/json-encoder.js";
import { FileStorage } from "../src/storage/file-storage.js";

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

function fileSize(path: string): number {
  return statSync(path).size;
}

describe("compact — basic correctness", () => {
  it("reduces file size after inserting and deleting documents", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    const { insertedId } = users.insertOne({ name: "Ada" });
    users.deleteOne(insertedId);
    const sizeBeforeCompact = fileSize(path);

    db.compact();

    const sizeAfterCompact = fileSize(path);
    assert.ok(sizeAfterCompact < sizeBeforeCompact, "file should shrink after compacting deleted doc");
    db.close();
  });

  it("reduces file size after updating a document (old version discarded)", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    const { insertedId } = users.insertOne({ name: "Ada", age: 30 });
    users.updateOne(insertedId, { $set: { age: 31 } });
    const sizeBeforeCompact = fileSize(path);

    db.compact();

    const sizeAfterCompact = fileSize(path);
    assert.ok(sizeAfterCompact < sizeBeforeCompact, "file should shrink after compacting superseded version");
    db.close();
  });

  it("compact on a clean file (no dead records) does not corrupt data", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.insertMany([{ name: "Ada" }, { name: "Grace" }]);
    const sizeBeforeCompact = fileSize(path);

    db.compact();

    const sizeAfterCompact = fileSize(path);
    // No dead records means no shrinkage; transaction wrappers ARE removed though.
    assert.ok(sizeAfterCompact <= sizeBeforeCompact);

    const names = users.find({}).toArray().map((d) => d.name);
    assert.deepEqual(names.sort(), ["Ada", "Grace"]);
    db.close();
  });

  it("compact on an empty database produces a file of exactly FILE_HEADER_BYTES", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    db.compact();
    db.close();

    assert.equal(fileSize(path), FILE_HEADER_BYTES);
  });

  it("removes hol0 records during compaction", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    db.collection("users").insertOne({ name: "Ada" });
    db.close();

    // Inject a hol0 directly.
    const storage = FileStorage.open(path);
    storage.appendOperation(HOLE_OPERATION, Buffer.alloc(0));
    storage.close();

    const sizeWithHole = fileSize(path);

    const db2 = open({ path });
    db2.compact();
    db2.close();

    const sizeAfterCompact = fileSize(path);
    assert.ok(sizeAfterCompact < sizeWithHole, "hol0 should be removed by compact");
  });
});

describe("compact — live data preserved", () => {
  it("all surviving documents are still readable after compact", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.insertMany([{ name: "Ada" }, { name: "Grace" }, { name: "Margaret" }]);
    users.deleteOne({ name: "Grace" });

    db.compact();

    const names = users.find({}).toArray().map((d) => d.name).sort();
    assert.deepEqual(names, ["Ada", "Margaret"]);
    db.close();
  });

  it("documents keep correct field values after compact", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    const { insertedId } = users.insertOne({ name: "Ada", age: 30, role: "admin" });
    users.updateOne(insertedId, { $set: { age: 37 } });

    db.compact();

    const doc = users.findOne({ _id: insertedId });
    assert.ok(doc);
    assert.equal(doc.name, "Ada");
    assert.equal(doc.age, 37);
    assert.equal(doc.role, "admin");
    db.close();
  });

  it("_id values survive compact intact", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    const { insertedId } = users.insertOne({ name: "Ada" });

    db.compact();

    const doc = users.findOne({ _id: insertedId });
    assert.ok(doc);
    assert.equal(doc._id, insertedId);
    db.close();
  });
});

describe("compact — reopen after compact", () => {
  it("database reopens correctly after compact", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.insertMany([{ name: "Ada" }, { name: "Grace" }]);
    users.deleteOne({ name: "Grace" });
    db.compact();
    db.close();

    const reopened = open({ path });
    const names = reopened.collection("users").find({}).toArray().map((d) => d.name);
    reopened.close();

    assert.deepEqual(names, ["Ada"]);
  });

  it("new insertions after compact go to correct file offsets", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.insertOne({ name: "Ada" });
    db.compact();

    const { insertedId } = users.insertOne({ name: "Grace" });
    db.close();

    const reopened = open({ path });
    const doc = reopened.collection("users").findOne({ _id: insertedId });
    reopened.close();

    assert.ok(doc);
    assert.equal(doc.name, "Grace");
  });

  it("multiple compactions are idempotent", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.insertMany([{ name: "Ada" }, { name: "Grace" }]);
    users.deleteOne({ name: "Grace" });

    db.compact();
    const sizeAfterFirst = fileSize(path);

    db.compact();
    const sizeAfterSecond = fileSize(path);

    assert.equal(sizeAfterFirst, sizeAfterSecond, "second compact should not change size");

    const names = users.find({}).toArray().map((d) => d.name);
    assert.deepEqual(names, ["Ada"]);
    db.close();
  });

  it("update operations are gone from file and correct version is returned after reopen", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    const { insertedId } = users.insertOne({ name: "Ada", version: 1 });
    users.updateOne(insertedId, { $set: { version: 2 } });
    users.updateOne(insertedId, { $set: { version: 3 } });
    db.compact();
    db.close();

    const reopened = open({ path });
    const doc = reopened.collection("users").findOne({ _id: insertedId });
    reopened.close();

    assert.ok(doc);
    assert.equal(doc.version, 3);
  });
});

describe("compact — secondary indexes", () => {
  it("string index works correctly after compact", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.createIndex("role", { type: "string" });
    users.insertMany([
      { name: "Ada", role: "admin" },
      { name: "Grace", role: "reader" },
      { name: "Margaret", role: "admin" }
    ]);
    users.deleteOne({ name: "Margaret" });

    db.compact();

    const admins = users.find({ role: "admin" }).toArray().map((d) => d.name);
    assert.deepEqual(admins, ["Ada"]);
    db.close();
  });

  it("number index works correctly after compact", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.createIndex("age", { type: "number" });
    users.insertMany([
      { name: "Ada", age: 37 },
      { name: "Grace", age: 52 },
      { name: "Margaret", age: 44 }
    ]);
    users.deleteOne({ name: "Grace" });

    db.compact();

    const over40 = users.find({ age: { $gt: 40 } }).toArray().map((d) => d.name).sort();
    assert.deepEqual(over40, ["Margaret"]);
    db.close();
  });

  it("secondary indexes survive reopen after compact", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.createIndex("role", { type: "string" });
    users.insertMany([
      { name: "Ada", role: "admin" },
      { name: "Grace", role: "reader" }
    ]);
    db.compact();
    db.close();

    const reopened = open({ path });
    const col = reopened.collection("users");
    assert.deepEqual(col.indexes, [{ field: "role", type: "string" }]);
    const admins = col.find({ role: "admin" }).toArray().map((d) => d.name);
    assert.deepEqual(admins, ["Ada"]);
    reopened.close();
  });
});

describe("compact — collection and index drop", () => {
  it("dropped collection is absent from file after compact", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    db.collection("users").insertMany([{ name: "Ada" }, { name: "Grace" }]);
    db.collection("users").drop();
    db.compact();
    db.close();

    const reopened = open({ path });
    // Re-accessing the collection creates a fresh empty one.
    const users = reopened.collection("users");
    assert.deepEqual(users.find({}).toArray(), []);
    reopened.close();
  });

  it("dropped index is absent from file after compact", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    const users = db.collection("users");
    users.createIndex("role", { type: "string" });
    users.createIndex("age", { type: "number" });
    users.insertOne({ name: "Ada", role: "admin", age: 37 });
    users.dropIndex("role");
    db.compact();
    db.close();

    const reopened = open({ path });
    const col = reopened.collection("users");
    assert.deepEqual(col.indexes, [{ field: "age", type: "number" }]);
    reopened.close();
  });

  it("transaction boundaries (txnb/txnc) are removed from file after compact", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = open({ path });
    // insertMany wraps in a transaction.
    db.collection("users").insertMany([{ name: "Ada" }, { name: "Grace" }]);
    const sizeBeforeCompact = fileSize(path);

    db.compact();

    const sizeAfterCompact = fileSize(path);
    assert.ok(sizeAfterCompact < sizeBeforeCompact, "txnb/txnc records should be removed");

    const names = db.collection("users").find({}).toArray().map((d) => d.name).sort();
    assert.deepEqual(names, ["Ada", "Grace"]);
    db.close();
  });
});

describe("compact — interrupted transactions (crash simulation)", () => {
  it("compact removes put1 records from an uncommitted transaction", () => {
    // Scenario: txnb is written, one or more put1 records follow, but the process
    // crashes before txnc. On the next open, replay discards those documents.
    // compact() must then also discard the orphaned put1 records from the file.
    const path = join(createTempDirectory(), "test.pdb");

    // Create the collection via the normal API so its ncl1 record is on disk.
    const db = open({ path });
    const users = db.collection("users");
    users.insertOne({ name: "Ada" }); // committed, must survive
    const collectionId = Buffer.from((users as any).id);
    db.close();

    // Simulate a crash: write txnb + put1 records without txnc.
    const storage = FileStorage.open(path);
    const docId1 = createObjectId();
    const docId2 = createObjectId();
    storage.appendOperation(TRANSACTION_BEGIN_OPERATION, Buffer.alloc(0));
    storage.appendOperation(
      PUT_DOCUMENT_OPERATION,
      encodePutDocumentPayload({
        collectionId,
        documentId: docId1,
        document: { _id: docId1.toString("hex"), name: "Orphan1" }
      }, jsonEncoder)
    );
    storage.appendOperation(
      PUT_DOCUMENT_OPERATION,
      encodePutDocumentPayload({
        collectionId,
        documentId: docId2,
        document: { _id: docId2.toString("hex"), name: "Orphan2" }
      }, jsonEncoder)
    );
    // No txnc — process "crashed" here.
    storage.close();

    const sizeWithOrphans = fileSize(path);

    // Reopen: replay must silently discard the orphaned records.
    const reopened = open({ path });
    const docsAfterReopen = reopened.collection("users").find({}).toArray();
    assert.deepEqual(
      docsAfterReopen.map((d) => d.name),
      ["Ada"],
      "only the committed document should be visible after reopen"
    );

    // compact() must physically remove the orphaned put1 records from the file.
    reopened.compact();
    const sizeAfterCompact = fileSize(path);
    assert.ok(
      sizeAfterCompact < sizeWithOrphans,
      "compact should shrink the file by removing orphaned put1 records"
    );

    // The surviving document must still be there.
    assert.deepEqual(
      reopened.collection("users").find({}).toArray().map((d) => d.name),
      ["Ada"]
    );
    reopened.close();

    // Verify on a fresh reopen after compact.
    const final = open({ path });
    const finalDocs = final.collection("users").find({}).toArray();
    final.close();

    assert.deepEqual(
      finalDocs.map((d) => d.name),
      ["Ada"],
      "orphaned documents must not reappear after reopen of the compacted file"
    );
  });

  it("compact on a file with only an uncommitted transaction yields an empty collection", () => {
    // All records are orphaned — compact must leave only the file header and ncl1.
    const path = join(createTempDirectory(), "test.pdb");

    const db = open({ path });
    const collectionId = Buffer.from((db.collection("users") as any).id);
    db.close();

    const storage = FileStorage.open(path);
    const docId = createObjectId();
    storage.appendOperation(TRANSACTION_BEGIN_OPERATION, Buffer.alloc(0));
    storage.appendOperation(
      PUT_DOCUMENT_OPERATION,
      encodePutDocumentPayload({
        collectionId,
        documentId: docId,
        document: { _id: docId.toString("hex"), name: "Ghost" }
      }, jsonEncoder)
    );
    storage.close();

    const reopened = open({ path });
    assert.deepEqual(reopened.collection("users").find({}).toArray(), []);

    reopened.compact();
    reopened.close();

    const final = open({ path });
    assert.deepEqual(final.collection("users").find({}).toArray(), []);
    final.close();
  });

  it("compact discards an uncommitted update — original document is preserved", () => {
    // A put1 for an already-existing document ID written inside an uncommitted
    // transaction must not replace the committed version in the file.
    const path = join(createTempDirectory(), "test.pdb");

    const db = open({ path });
    const users = db.collection("users");
    const { insertedId } = users.insertOne({ name: "Ada", version: 1 });
    const collectionId = Buffer.from((users as any).id);
    db.close();

    // Simulate crash: write txnb + put1 (update) without txnc.
    const storage = FileStorage.open(path);
    const documentId = objectIdFromHex(insertedId);
    storage.appendOperation(TRANSACTION_BEGIN_OPERATION, Buffer.alloc(0));
    storage.appendOperation(
      PUT_DOCUMENT_OPERATION,
      encodePutDocumentPayload({
        collectionId,
        documentId,
        document: { _id: insertedId, name: "Ada", version: 2 }
      }, jsonEncoder)
    );
    // No txnc — crash.
    storage.close();

    const sizeWithOrphan = fileSize(path);

    // Reopen: replay must ignore the uncommitted update.
    const reopened = open({ path });
    const docAfterReopen = reopened.collection("users").findOne({ _id: insertedId });
    assert.ok(docAfterReopen, "committed document must still exist");
    assert.equal(docAfterReopen.version, 1, "version must be the committed one, not the orphaned update");

    // compact() must remove the orphaned put1 and keep only the committed version.
    reopened.compact();
    const sizeAfterCompact = fileSize(path);
    assert.ok(sizeAfterCompact < sizeWithOrphan, "compact should remove the orphaned put1 record");

    const docAfterCompact = reopened.collection("users").findOne({ _id: insertedId });
    assert.ok(docAfterCompact);
    assert.equal(docAfterCompact.version, 1);
    reopened.close();

    // Final reopen: the committed version must still be the only one.
    const final = open({ path });
    const docFinal = final.collection("users").findOne({ _id: insertedId });
    final.close();

    assert.ok(docFinal);
    assert.equal(docFinal.version, 1, "orphaned update must not reappear after reopen of compacted file");
  });

  it("compact discards an uncommitted delete — document is preserved", () => {
    // A del1 written inside an uncommitted transaction must not erase the
    // committed document from the file.
    const path = join(createTempDirectory(), "test.pdb");

    const db = open({ path });
    const users = db.collection("users");
    const { insertedId } = users.insertOne({ name: "Ada" });
    const collectionId = Buffer.from((users as any).id);
    db.close();

    // Simulate crash: write txnb + del1 without txnc.
    const storage = FileStorage.open(path);
    storage.appendOperation(TRANSACTION_BEGIN_OPERATION, Buffer.alloc(0));
    storage.appendOperation(
      DELETE_DOCUMENT_OPERATION,
      encodeDeleteDocumentPayload({
        collectionId,
        documentId: objectIdFromHex(insertedId)
      })
    );
    // No txnc — crash.
    storage.close();

    const sizeWithOrphan = fileSize(path);

    // Reopen: the uncommitted delete must be ignored; document still visible.
    const reopened = open({ path });
    const docAfterReopen = reopened.collection("users").findOne({ _id: insertedId });
    assert.ok(docAfterReopen, "document must still exist — delete was not committed");
    assert.equal(docAfterReopen.name, "Ada");

    // compact() must remove the orphaned del1; the committed put1 must stay.
    reopened.compact();
    const sizeAfterCompact = fileSize(path);
    assert.ok(sizeAfterCompact < sizeWithOrphan, "compact should remove the orphaned del1 record");

    const docAfterCompact = reopened.collection("users").findOne({ _id: insertedId });
    assert.ok(docAfterCompact, "document must survive compact");
    assert.equal(docAfterCompact.name, "Ada");
    reopened.close();

    // Final reopen: document must still be present after compact.
    const final = open({ path });
    const docFinal = final.collection("users").findOne({ _id: insertedId });
    final.close();

    assert.ok(docFinal, "document must not be erased by an uncommitted delete after reopen");
    assert.equal(docFinal.name, "Ada");
  });
});
