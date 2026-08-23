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
import type { DocumentEncoder } from "../storage/encoding/document-encoder.js";
import type { FileLock } from "../storage/file-lock.js";
import type { FileStorage } from "../storage/file-storage.js";
import { decodeCreateIndexPayload, decodeDropIndexPayload } from "../storage/index-operation.js";
import { decodeDropCollectionPayload } from "../storage/collection-operation.js";
import type { OperationRecord } from "../storage/operation-record.js";
import { PocketCollection } from "./collection.js";
import type { Collection, Database, DatabaseStats, StorageStatsCore } from "./types.js";

export class PocketDatabase implements Database {
  private readonly collectionsByName = new Map<string, PocketCollection>();
  private readonly collectionsById = new Map<string, PocketCollection>();
  private readonly collectionIds = new Set<string>();

  constructor(
    private readonly storage: FileStorage,
    private readonly lock: FileLock | undefined,
    private readonly encoder: DocumentEncoder
  ) {
    this.loadCollections();

    if (this.storage.recovered) {
      // A previous process crashed mid-append: the trailing record was
      // incomplete or failed its CRC check, and loadCollections() above
      // (via FileStorage.readOperations()) already truncated the file back
      // to its last valid record before replaying it. This is a deliberate,
      // operator-facing warning, not a debug log — see
      // docs/storage.md's Corruption Policy and ADR 0019.
      console.warn(
        `pocket-db: recovered from an incomplete trailing record in "${this.storage.path}" ` +
        `(${this.storage.recoveredBytes} byte(s) discarded, most likely a crash mid-write). ` +
        `The file was truncated to its last valid record and opened normally.`
      );
    }
  }

  get recovered(): boolean {
    return this.storage.recovered;
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

  stats(): DatabaseStats {
    const { global } = this.computeStorageStats();

    let documentCount = 0;
    for (const collection of this.collectionsById.values()) {
      documentCount += collection.documentCount;
    }

    return {
      path: this.storage.path,
      sizeOnDisk: this.storage.size,
      collectionCount: this.collectionsByName.size,
      documentCount,
      operationCount: global.operationCount,
      tombstoneCount: global.tombstoneCount,
      liveBytes: global.liveBytes,
      deadBytes: global.deadBytes
    };
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
            const { collectionId, documentIdHex } = decodePutDocumentPayload(operation.payload, this.encoder);
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
      const docOp = decodePutDocumentPayload(operation.payload, this.encoder);
      const collection = this.collectionsById.get(docOp.collectionId.toString("hex"));
      if (!collection) return false;
      // Keep only the version whose offset matches what the primary index points to.
      return collection.primaryIndexOffsetFor(docOp.documentIdHex) === operation.offset;
    }

    // Unknown identifiers: keep to avoid silently losing data.
    return true;
  }

  /**
   * Single forward scan of the operation log that tallies record counts and
   * byte usage, both globally and per live collection.
   *
   * Liveness reuses {@link shouldKeepOperation} — exactly the predicate that
   * drives {@link compact} — so `deadBytes` is precisely the space a compaction
   * would reclaim. Records belonging to dropped collections still count toward
   * the global totals but are not attributed to any (now-absent) collection.
   */
  private computeStorageStats(): { global: StorageStatsCore; byCollection: Map<string, StorageStatsCore> } {
    const global = createEmptyStatsCore();
    const byCollection = new Map<string, StorageStatsCore>();

    for (const operation of this.storage.readOperations()) {
      const byteLength = operation.byteLength ?? 0;
      const live = this.shouldKeepOperation(operation);

      accumulate(global, live, byteLength);

      const collectionIdHex = this.operationCollectionIdHex(operation);
      if (collectionIdHex !== null && this.collectionsById.has(collectionIdHex)) {
        let core = byCollection.get(collectionIdHex);
        if (!core) {
          core = createEmptyStatsCore();
          byCollection.set(collectionIdHex, core);
        }
        accumulate(core, live, byteLength);
      }
    }

    return { global, byCollection };
  }

  private collectionStorageStats(collectionIdHex: string): StorageStatsCore {
    return this.computeStorageStats().byCollection.get(collectionIdHex) ?? createEmptyStatsCore();
  }

  /**
   * Extracts the owning collection id (hex) of an operation, or `null` for
   * database-level records (transaction boundaries, holes, unknown ids).
   *
   * For `put1`/`del1` the collection id is the first 4 payload bytes, so this
   * avoids decoding the document body.
   */
  private operationCollectionIdHex(operation: OperationRecord): string | null {
    const id = operation.identifier;

    if (id.equals(PUT_DOCUMENT_OPERATION) || id.equals(DELETE_DOCUMENT_OPERATION)) {
      return operation.payload.subarray(0, 4).toString("hex");
    }

    if (id.equals(NEW_COLLECTION_OPERATION)) {
      return decodeNewCollectionPayload(operation.payload).id.toString("hex");
    }

    if (id.equals(DROP_COLLECTION_OPERATION)) {
      return decodeDropCollectionPayload(operation.payload).toString("hex");
    }

    if (id.equals(CREATE_INDEX_OPERATION)) {
      return decodeCreateIndexPayload(operation.payload).collectionId.toString("hex");
    }

    if (id.equals(DROP_INDEX_OPERATION)) {
      return decodeDropIndexPayload(operation.payload).collectionId.toString("hex");
    }

    return null;
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
      const documentOperation = decodePutDocumentPayload(operation.payload, this.encoder);
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

      collection.createIndexFromReplay(indexOperation.field, indexOperation.type, indexOperation.unique);
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

    const collection = new PocketCollection(
      definition.id,
      definition.name,
      this.storage,
      onDrop,
      this.encoder,
      () => this.collectionStorageStats(idHex)
    );

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

function createEmptyStatsCore(): StorageStatsCore {
  return { operationCount: 0, tombstoneCount: 0, liveBytes: 0, deadBytes: 0 };
}

/** Folds one record into a {@link StorageStatsCore} accumulator. */
function accumulate(core: StorageStatsCore, live: boolean, byteLength: number): void {
  core.operationCount += 1;

  if (live) {
    core.liveBytes += byteLength;
  } else {
    core.deadBytes += byteLength;
    core.tombstoneCount += 1;
  }
}
