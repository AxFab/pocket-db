import { randomBytes } from "node:crypto";
import {
  decodeNewCollectionPayload,
  encodeNewCollectionPayload,
  type CollectionDefinition
} from "../storage/collection-operation.js";
import {
  CREATE_INDEX_OPERATION,
  DELETE_DOCUMENT_OPERATION,
  DROP_COLLECTION_OPERATION,
  DROP_INDEX_OPERATION,
  FILE_HEADER_BYTES,
  HOLE_OPERATION,
  NEW_COLLECTION_OPERATION,
  PUT_DOCUMENT_OPERATION,
  TRANSACTION_BEGIN_OPERATION,
  TRANSACTION_COMMIT_OPERATION
} from "../storage/constants.js";
import { decodeDeleteDocumentPayload, decodePutDocumentPayload } from "../storage/document-operation.js";
import type { FileLock } from "../storage/file-lock.js";
import type { FileStorage } from "../storage/file-storage.js";
import { decodeCreateIndexPayload, decodeDropIndexPayload } from "../storage/index-operation.js";
import { decodeDropCollectionPayload } from "../storage/collection-operation.js";
import type { OperationRecord } from "../storage/operation-record.js";
import { PocketCollection } from "./collection.js";
import type { Collection, Database } from "./types.js";

export class PocketDatabase implements Database {
  private readonly collectionsByName = new Map<string, PocketCollection>();
  private readonly collectionsById = new Map<string, PocketCollection>();
  private readonly collectionIds = new Set<string>();

  constructor(
    private readonly storage: FileStorage,
    private readonly lock?: FileLock
  ) {
    this.loadCollections();
  }

  getCollections(): string[] {
    return Array.from(this.collectionsByName.keys());
  }

  get collections(): string[] {
    return Array.from(this.collectionsByName.keys());
  }

  existsCollection(name: string): boolean {
    return this.collectionsByName.has(name);
  }

  collection(name: string): Collection {
    const existing = this.collectionsByName.get(name);

    if (existing) {
      return existing;
    }

    const definition: CollectionDefinition = {
      id: this.createCollectionId(),
      name,
      indexes: []
    };

    this.storage.appendOperation(
      NEW_COLLECTION_OPERATION,
      encodeNewCollectionPayload(definition)
    );

    return this.registerCollection(definition);
  }

  compact(): void {
    const operations = this.storage.readOperations();
    let writeHead = FILE_HEADER_BYTES;

    for (const operation of operations) {
      const scanHead = operation.offset!;
      const byteLength = operation.byteLength!;

      if (this.shouldKeepOperation(operation)) {
        if (writeHead < scanHead) {
          // Copy the raw record bytes from their current position to writeHead.
          // writeHead <= scanHead is guaranteed by the forward pass, so we never
          // read from a position we have already overwritten.
          const rawBytes = this.storage.readRawBytes(scanHead, byteLength);
          this.storage.writeRawAt(writeHead, rawBytes);

          // Update the primary index offset for moved documents.
          if (operation.identifier.equals(PUT_DOCUMENT_OPERATION)) {
            const { collectionId, documentIdHex } = decodePutDocumentPayload(operation.payload);
            this.collectionsById.get(collectionId.toString("hex"))?.updateDocumentOffset(documentIdHex, writeHead);
          }
        }

        writeHead += byteLength;
      }
    }

    this.storage.truncateTo(writeHead);

    // Secondary indexes store {id, offset} candidates. After primary offsets
    // changed, repopulate them from the (now-correct) primary index.
    for (const collection of this.collectionsById.values()) {
      collection.refreshIndexesAfterCompaction();
    }
  }

  close(): void {
    this.storage.close();
    this.lock?.release();
  }

  private shouldKeepOperation(operation: OperationRecord): boolean {
    const id = operation.identifier;

    // These operations are already fully applied in memory; no need to replay
    // them on a fresh open of the compacted file.
    if (id.equals(HOLE_OPERATION)) return false;
    if (id.equals(DELETE_DOCUMENT_OPERATION)) return false;
    if (id.equals(DROP_COLLECTION_OPERATION)) return false;
    if (id.equals(DROP_INDEX_OPERATION)) return false;
    if (id.equals(TRANSACTION_BEGIN_OPERATION)) return false;
    if (id.equals(TRANSACTION_COMMIT_OPERATION)) return false;

    if (id.equals(NEW_COLLECTION_OPERATION)) {
      const definition = decodeNewCollectionPayload(operation.payload);
      return this.collectionsById.has(definition.id.toString("hex"));
    }

    if (id.equals(CREATE_INDEX_OPERATION)) {
      const indexOp = decodeCreateIndexPayload(operation.payload);
      const collection = this.collectionsById.get(indexOp.collectionId.toString("hex"));
      return collection !== undefined && collection.hasIndex(indexOp.field);
    }

    if (id.equals(PUT_DOCUMENT_OPERATION)) {
      const docOp = decodePutDocumentPayload(operation.payload);
      const collection = this.collectionsById.get(docOp.collectionId.toString("hex"));
      if (!collection) return false;
      // Keep only the version whose offset matches what the primary index points to.
      return collection.primaryIndexOffsetFor(docOp.documentIdHex) === operation.offset;
    }

    // Unknown identifiers: keep to avoid silently losing data.
    return true;
  }

  private loadCollections(): void {
    let transactionOperations: OperationRecord[] | null = null;

    for (const operation of this.storage.readOperations()) {
      if (operation.identifier.equals(TRANSACTION_BEGIN_OPERATION)) {
        if (transactionOperations !== null) {
          throw new Error("Invalid transaction operation: nested transaction begin.");
        }

        transactionOperations = [];
        continue;
      }

      if (operation.identifier.equals(TRANSACTION_COMMIT_OPERATION)) {
        if (transactionOperations === null) {
          throw new Error("Invalid transaction operation: commit without begin.");
        }

        for (const transactionOperation of transactionOperations) {
          this.applyOperation(transactionOperation);
        }

        transactionOperations = null;
        continue;
      }

      if (transactionOperations !== null) {
        transactionOperations.push(operation);
        continue;
      }

      this.applyOperation(operation);
    }
  }

  private applyOperation(operation: OperationRecord): void {
    if (operation.identifier.equals(NEW_COLLECTION_OPERATION)) {
      this.registerCollection(decodeNewCollectionPayload(operation.payload));
      return;
    }

    if (operation.identifier.equals(PUT_DOCUMENT_OPERATION)) {
      const documentOperation = decodePutDocumentPayload(operation.payload);
      const collection = this.collectionsById.get(documentOperation.collectionId.toString("hex"));

      if (!collection) {
        throw new Error("Invalid put document operation: unknown collection identifier.");
      }

      collection.addPrimaryIndexEntry(documentOperation.documentIdHex, operation.offset ?? 0, documentOperation.document);
      return;
    }

    if (operation.identifier.equals(CREATE_INDEX_OPERATION)) {
      const indexOperation = decodeCreateIndexPayload(operation.payload);
      const collection = this.collectionsById.get(indexOperation.collectionId.toString("hex"));

      if (!collection) {
        throw new Error("Invalid create index operation: unknown collection identifier.");
      }

      collection.createIndexFromReplay(indexOperation.field, indexOperation.type);
      return;
    }

    if (operation.identifier.equals(DELETE_DOCUMENT_OPERATION)) {
      const documentOperation = decodeDeleteDocumentPayload(operation.payload);
      const collection = this.collectionsById.get(documentOperation.collectionId.toString("hex"));

      if (!collection) {
        throw new Error("Invalid delete document operation: unknown collection identifier.");
      }

      collection.deletePrimaryIndexEntry(documentOperation.documentIdHex);
      return;
    }

    if (operation.identifier.equals(DROP_COLLECTION_OPERATION)) {
      const collectionId = decodeDropCollectionPayload(operation.payload);
      const collection = this.collectionsById.get(collectionId.toString("hex"));

      if (!collection) {
        throw new Error("Invalid drop collection operation: unknown collection identifier.");
      }

      collection.dropFromReplay();
      return;
    }

    if (operation.identifier.equals(DROP_INDEX_OPERATION)) {
      const { collectionId, field } = decodeDropIndexPayload(operation.payload);
      const collection = this.collectionsById.get(collectionId.toString("hex"));

      if (!collection) {
        throw new Error("Invalid drop index operation: unknown collection identifier.");
      }

      collection.dropIndexFromReplay(field);
      return;
    }

    if (operation.identifier.equals(HOLE_OPERATION)) {
      return;
    }

    throw new Error(`Unsupported operation identifier: ${operation.identifier.toString("utf8")}.`);
  }

  private registerCollection(definition: CollectionDefinition): PocketCollection {
    const idHex = definition.id.toString("hex");

    const onDrop = (): void => {
      this.collectionsByName.delete(definition.name);
      this.collectionsById.delete(idHex);
      this.collectionIds.delete(idHex);
    };

    const collection = new PocketCollection(definition.id, definition.name, this.storage, onDrop);

    this.collectionsByName.set(collection.name, collection);
    this.collectionsById.set(idHex, collection);
    this.collectionIds.add(idHex);

    return collection;
  }

  private createCollectionId(): Buffer {
    let id = randomBytes(4);

    while (this.collectionIds.has(id.toString("hex"))) {
      id = randomBytes(4);
    }

    return id;
  }
}
