import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { pocketDb } from "../src/index.js";
import { PUT_DOCUMENT_OPERATION, TRANSACTION_BEGIN_OPERATION, TRANSACTION_COMMIT_OPERATION } from "../src/storage/constants.js";
import { createObjectId } from "../src/storage/document-id.js";
import { encodePutDocumentPayload } from "../src/storage/document-operation.js";
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

describe("transaction replay", () => {
  it("ignores operations after transaction begin when commit is missing", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    const collectionId = Buffer.from((users as any).id);
    db.close();

    const storage = FileStorage.open(path);
    const documentId = createObjectId();
    storage.appendOperation(TRANSACTION_BEGIN_OPERATION, Buffer.alloc(0));
    storage.appendOperation(
      PUT_DOCUMENT_OPERATION,
      encodePutDocumentPayload({
        collectionId,
        documentId,
        document: {
          _id: documentId.toString("hex"),
          name: "Ada"
        }
      }, jsonEncoder)
    );
    storage.close();

    const reopened = pocketDb({ path });

    assert.deepEqual(reopened.collection("users").find({}).toArray(), []);

    reopened.close();
  });

  it("applies transaction operations after commit", () => {
    const path = join(createTempDirectory(), "test.pdb");
    const db = pocketDb({ path });
    const users = db.collection("users");
    const collectionId = Buffer.from((users as any).id);
    db.close();

    const storage = FileStorage.open(path);
    const documentId = createObjectId();
    storage.appendOperation(TRANSACTION_BEGIN_OPERATION, Buffer.alloc(0));
    storage.appendOperation(
      PUT_DOCUMENT_OPERATION,
      encodePutDocumentPayload({
        collectionId,
        documentId,
        document: {
          _id: documentId.toString("hex"),
          name: "Ada"
        }
      }, jsonEncoder)
    );
    storage.appendOperation(TRANSACTION_COMMIT_OPERATION, Buffer.alloc(0));
    storage.close();

    const reopened = pocketDb({ path });

    assert.deepEqual(
      reopened.collection("users").find({}).toArray().map((document) => document.name),
      ["Ada"]
    );

    reopened.close();
  });
});
