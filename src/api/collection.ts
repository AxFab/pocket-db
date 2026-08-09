import {
  IndexManager,
  InMemoryPrimaryIndex,
  type SecondaryIndexDefinition,
  type SecondaryIndexType
} from "../indexes/index.js";
import { compileQuery, updateDocument, valuesEqual, type DocumentRecord, type DocumentValue, type Query, type UpdateExpression } from "../search/index.js";
import {
  CREATE_INDEX_OPERATION,
  DELETE_DOCUMENT_OPERATION,
  DROP_COLLECTION_OPERATION,
  DROP_INDEX_OPERATION,
  PUT_DOCUMENT_OPERATION,
  TRANSACTION_BEGIN_OPERATION,
  TRANSACTION_COMMIT_OPERATION
} from "../storage/constants.js";
import { assertObjectIdHex, createObjectId, objectIdFromHex } from "../storage/document-id.js";
import { decodePutDocumentPayload, encodeDeleteDocumentPayload, encodePutDocumentPayload } from "../storage/document-operation.js";
import type { DocumentEncoder } from "../storage/encoding/document-encoder.js";
import type { FileStorage } from "../storage/file-storage.js";
import { encodeCreateIndexPayload, encodeDropIndexPayload } from "../storage/index-operation.js";
import { encodeDropCollectionPayload } from "../storage/collection-operation.js";
import { readOperationFromBuffer } from "../storage/operation-record.js";
import { PocketCursor } from "./cursor.js";
import { DocumentCache, type DocumentCacheStats } from "./document-cache.js";
import type {
  Collection,
  Cursor,
  CreateIndexOptions,
  CollectionStats,
  CreateIndexResult,
  DeleteManyResult,
  DeleteOneResult,
  DistinctOptions,
  DropIndexResult,
  DropResult,
  InsertManyResult,
  InsertOneResult,
  ReplaceOneResult,
  StorageStatsCore,
  UpdateResult
} from "./types.js";

/**
 * Minimum number of candidates required before the cursor pre-loads the
 * candidate range into memory for zero-syscall document reads.
 *
 * Below this threshold (e.g. findById, updateOne, deleteOne) the existing
 * per-record readSync path is cheaper than a bulk range read.
 */
const SCAN_PRELOAD_THRESHOLD = 2;

/**
 * Default cap on the number of distinct values `distinct()` will collect
 * before throwing. Guards against unbounded memory growth when called on a
 * field that turns out to be high-cardinality (e.g. a free-text field or a
 * unique id by mistake). Override per call via `DistinctOptions.limit`.
 */
const DEFAULT_DISTINCT_LIMIT = 100;

export class PocketCollection implements Collection {
  private readonly primaryIndex = new InMemoryPrimaryIndex();
  private readonly indexManager = new IndexManager();
  private dropped = false;

  /**
   * Hot-document cache. `null` (the default) means caching is disabled: the
   * cache object is never even instantiated, so write/read paths only pay a
   * single `null` check. Activated lazily by {@link enableCache}.
   */
  private cache: DocumentCache | null = null;

  constructor(
    readonly id: Buffer,
    readonly name: string,
    private readonly storage: FileStorage,
    private readonly onDrop: () => void,
    private readonly encoder: DocumentEncoder,
    /**
     * Provides this collection's storage counters (operation/byte tallies) via
     * a single log scan owned by the database. Injected to avoid a back
     * reference to {@link PocketDatabase}.
     */
    private readonly storageStats: () => StorageStatsCore
  ) {}

  /** Number of live documents in the collection (O(1), in-memory). */
  get documentCount(): number {
    return this.primaryIndex.size;
  }

  get indexes(): readonly SecondaryIndexDefinition[] {
    return this.indexManager.definitions;
  }

  getIndexes(): { name: string; type: string; unique: boolean }[] {
    return this.indexManager.definitions.map((def) => ({
      name: def.field,
      type: def.type,
      unique: def.unique
    }));
  }

  existsIndex(name: string): boolean {
    return this.indexManager.definitions.some((def) => def.field === name);
  }

  stats(): CollectionStats {
    this.assertNotDropped();
    const core = this.storageStats();

    return {
      name: this.name,
      documentCount: this.primaryIndex.size,
      indexCount: this.indexManager.definitions.length,
      operationCount: core.operationCount,
      tombstoneCount: core.tombstoneCount,
      liveBytes: core.liveBytes,
      deadBytes: core.deadBytes
    };
  }

  /**
   * Enables the hot-document cache, or resizes it if already enabled.
   *
   * Caching is **off by default**; this is the only way to turn it on. It trades
   * memory for read latency: repeatedly read documents are served from memory,
   * skipping the file read and payload decode. The cache is purely in-memory and
   * is not persisted — it starts empty on every `open()` and warms with traffic.
   *
   * @param maxBytes Approximate byte budget for resident documents (positive
   *                 integer). Least-recently-used documents are evicted once the
   *                 budget is exceeded.
   */
  enableCache(maxBytes: number): void {
    this.assertNotDropped();

    if (this.cache === null) {
      this.cache = new DocumentCache({ maxBytes });
      return;
    }

    this.cache.setMaxBytes(maxBytes);
  }

  /**
   * Disables the hot-document cache and frees all cached entries, returning the
   * collection to the zero-overhead default.
   */
  disableCache(): void {
    this.cache = null;
  }

  /**
   * Returns cache statistics (hit/miss/eviction counts, byte usage), or `null`
   * when caching is disabled.
   */
  cacheStats(): DocumentCacheStats | null {
    return this.cache?.stats() ?? null;
  }

  insertOne(document: Record<string, unknown>): InsertOneResult {
    this.assertNotDropped();
    const documentId = this.createDocumentId(document._id);
    const insertedId = documentId.toString("hex");
    const documentToStore = {
      ...document,
      _id: insertedId
    };

    this.indexManager.assertUnique(documentToStore as DocumentRecord);

    const offset = this.appendPutDocument(documentId, documentToStore);

    this.applyPutDocument(insertedId, offset, documentToStore);

    return {
      acknowledged: true,
      insertedId
    };
  }

  insertMany(documents: Record<string, unknown>[]): InsertManyResult {
    this.assertNotDropped();
    const preparedDocuments = documents.map((document) => this.prepareInsertedDocument(document));
    assertUniqueBatchIds(preparedDocuments.map((document) => document.id));
    this.indexManager.assertUniqueBatch(
      preparedDocuments.map((document) => ({ id: document.id, document: document.document as DocumentRecord }))
    );

    if (preparedDocuments.length === 0) {
      return {
        acknowledged: true,
        insertedCount: 0,
        insertedIds: []
      };
    }

    const offsets: number[] = [];

    this.appendTransactionBegin();

    for (const document of preparedDocuments) {
      offsets.push(this.appendPutDocument(document.documentId, document.document));
    }

    this.appendTransactionCommit();

    preparedDocuments.forEach((document, index) => {
      this.applyPutDocument(document.id, offsets[index], document.document);
    });

    const insertedIds = preparedDocuments.map((document) => document.id);

    return {
      acknowledged: true,
      insertedCount: insertedIds.length,
      insertedIds
    };
  }

  replaceOne(id: string, document: Record<string, unknown>): ReplaceOneResult;

  replaceOne(document: Record<string, unknown> & { _id: string }): ReplaceOneResult;

  replaceOne(
    idOrDocument: string | (Record<string, unknown> & { _id: string }),
    replacement?: Record<string, unknown>
  ): ReplaceOneResult {
    this.assertNotDropped();
    const id = typeof idOrDocument === "string" ? idOrDocument : idOrDocument._id;
    const document = typeof idOrDocument === "string" ? replacement : idOrDocument;

    if (!document) {
      throw new Error("Replacement document is required.");
    }

    if (!this.existsId(id)) {
      throw new Error(`Cannot replace document: unknown _id "${id}".`);
    }

    const documentId = objectIdFromHex(id);
    const documentToStore = {
      ...document,
      _id: id
    };

    this.indexManager.assertUnique(documentToStore as DocumentRecord, id);

    const offset = this.appendPutDocument(documentId, documentToStore);

    this.applyPutDocument(id, offset, documentToStore);

    return {
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1
    };
  }

  updateOne(id: string, update: UpdateExpression): UpdateResult;

  updateOne(query: Query, update: UpdateExpression): UpdateResult;

  updateOne(idOrQuery: string | Query, update: UpdateExpression): UpdateResult {
    this.assertNotDropped();
    if (isEmptyUpdate(update)) {
      return {
        acknowledged: true,
        matchedCount: 0,
        modifiedCount: 0
      };
    }

    const document = typeof idOrQuery === "string" ? this.findOne({ _id: idOrQuery }) : this.findOne(idOrQuery);

    if (!document || typeof document._id !== "string") {
      return {
        acknowledged: true,
        matchedCount: 0,
        modifiedCount: 0
      };
    }

    this.appendUpdatedDocument(document, update);

    return {
      acknowledged: true,
      matchedCount: 1,
      modifiedCount: 1
    };
  }

  updateMany(query: Query, update: UpdateExpression): UpdateResult {
    this.assertNotDropped();
    if (isEmptyUpdate(update)) {
      return {
        acknowledged: true,
        matchedCount: 0,
        modifiedCount: 0
      };
    }

    const documents = this.find(query).toArray();
    const updates = documents
      .filter((document): document is Record<string, unknown> & { _id: string } => {
        return typeof document._id === "string" && this.existsId(document._id);
      })
      .map((document) => ({
        id: document._id,
        documentId: objectIdFromHex(document._id),
        document: this.buildUpdatedDocument(document, update)
      }));

    if (updates.length === 0) {
      return {
        acknowledged: true,
        matchedCount: 0,
        modifiedCount: 0
      };
    }

    this.indexManager.assertUniqueBatch(
      updates.map((entry) => ({ id: entry.id, document: entry.document as DocumentRecord }))
    );

    const offsets: number[] = [];

    this.appendTransactionBegin();

    for (const entry of updates) {
      offsets.push(this.appendPutDocument(entry.documentId, entry.document));
    }

    this.appendTransactionCommit();

    updates.forEach((entry, index) => {
      this.applyPutDocument(entry.id, offsets[index], entry.document);
    });

    return {
      acknowledged: true,
      matchedCount: updates.length,
      modifiedCount: updates.length
    };
  }

  find(query: Query = {}): Cursor {
    const compiledQuery = compileQuery(query);
    const plan = this.indexManager.plan(compiledQuery, this.primaryIndex);

    // Pre-load the byte range spanning the candidate set into a single Buffer
    // when there are enough candidates to justify the cost. This reduces N×3
    // individual readSync syscalls (one per candidate: header, payload,
    // CRC32) down to two (one small header peek + one range read), at the
    // cost of holding that range in memory for the lifetime of the cursor.
    // Only the span the candidates actually occupy is read — not the whole
    // file — see `FileStorage.readBulkRange`.
    //
    // For single-document lookups (findById, updateOne, deleteOne) the
    // per-record path is cheaper, so we only pre-load above the threshold.
    const bulkRange = plan.candidates.length >= SCAN_PRELOAD_THRESHOLD
      ? this.storage.readBulkRange(plan.candidates.map((candidate) => candidate.offset))
      : null;

    return new PocketCursor(
      this.storage,
      plan.residualQuery,
      plan.candidates,
      bulkRange,
      this.encoder,
      this.cache
    );
  }

  findOne(query: Query = {}): Record<string, unknown> | null {
    return this.find(query).limit(1).next();
  }

  countDocuments(query: Query = {}): number {
    return this.find(query).count();
  }

  /**
   * Returns the distinct values held by `field` across documents matching
   * `query` (default: all documents).
   *
   * Values are compared by deep equality — the same rule `$eq`/`$in` use
   * ({@link valuesEqual}: strict equality for primitives, JSON-structural
   * equality for arrays and objects) — so two documents with, say,
   * `{ tags: ["a"] }` and `{ tags: ["a"] }` contribute one distinct value,
   * while `{ tags: ["a"] }` and `{ tags: ["b"] }` contribute two. Documents
   * where `field` is missing do not contribute a value.
   *
   * Stops reading further documents and throws as soon as the number of
   * distinct values would exceed `options.limit` (default {@link
   * DEFAULT_DISTINCT_LIMIT}) — a safety guard against unbounded memory growth
   * when `field` turns out to be high-cardinality. Pass a higher `limit`
   * explicitly when more distinct values are legitimately expected.
   */
  distinct(field: string, query: Query = {}, options?: DistinctOptions): unknown[] {
    this.assertNotDropped();
    const limit = options?.limit ?? DEFAULT_DISTINCT_LIMIT;
    assertPositiveIntegerLimit(limit);

    const cursor = this.find(query);
    const values: DocumentValue[] = [];

    for (let document = cursor.next(); document !== null; document = cursor.next()) {
      if (!Object.hasOwn(document, field)) {
        continue;
      }

      const value = document[field] as DocumentValue;

      if (values.some((existing) => valuesEqual(existing, value))) {
        continue;
      }

      if (values.length >= limit) {
        throw new Error(`Too many distinct values for field "${field}" (limit: ${limit}).`);
      }

      values.push(value);
    }

    return values;
  }

  deleteOne(id: string): DeleteOneResult;

  deleteOne(query: Query): DeleteOneResult;

  deleteOne(idOrQuery: string | Query): DeleteOneResult {
    this.assertNotDropped();
    const id = typeof idOrQuery === "string" ? idOrQuery : this.findOne(idOrQuery)?._id;

    if (typeof id !== "string" || !this.existsId(id)) {
      return {
        acknowledged: true,
        deletedCount: 0
      };
    }

    this.appendDeleteDocument(id);

    return {
      acknowledged: true,
      deletedCount: 1
    };
  }

  deleteMany(query: Query = {}): DeleteManyResult {
    this.assertNotDropped();
    const ids = this.find(query)
      .toArray()
      .map((document) => document._id)
      .filter((id): id is string => typeof id === "string");

    const existingIds = ids.filter((id) => this.existsId(id));

    if (existingIds.length === 0) {
      return {
        acknowledged: true,
        deletedCount: 0
      };
    }

    this.appendTransactionBegin();

    for (const id of existingIds) {
      this.appendDeleteDocumentRecord(id);
    }

    this.appendTransactionCommit();

    for (const id of existingIds) {
      this.deletePrimaryIndexEntry(id);
    }

    return {
      acknowledged: true,
      deletedCount: existingIds.length
    };
  }

  drop(): DropResult {
    this.assertNotDropped();

    this.storage.appendOperation(
      DROP_COLLECTION_OPERATION,
      encodeDropCollectionPayload(this.id)
    );

    this.dropFromReplay();

    return { acknowledged: true };
  }

  dropIndex(field: string): DropIndexResult {
    this.assertNotDropped();

    if (!this.indexManager.hasIndex(field)) {
      throw new Error(`No index exists on field "${field}".`);
    }

    this.storage.appendOperation(
      DROP_INDEX_OPERATION,
      encodeDropIndexPayload({ collectionId: this.id, field })
    );

    this.indexManager.removeIndex(field);

    return { acknowledged: true, field };
  }

  createIndex(field: string, options: CreateIndexOptions): CreateIndexResult {
    this.assertNotDropped();
    const unique = options.unique ?? false;
    const alreadyExists = this.indexes.some((index) => index.field === field && index.type === options.type);
    const definition = this.createIndexInMemory(field, options.type, unique);

    if (!alreadyExists) {
      this.storage.appendOperation(
        CREATE_INDEX_OPERATION,
        encodeCreateIndexPayload({
          collectionId: this.id,
          field: definition.field,
          type: definition.type,
          unique: definition.unique
        })
      );
    }

    return {
      acknowledged: true,
      field: definition.field,
      type: definition.type,
      unique: definition.unique
    };
  }

  existsId(id: string): boolean {
    return this.primaryIndex.has(id);
  }

  addPrimaryIndexEntry(id: string, offset: number, document?: Record<string, unknown>): void {
    this.primaryIndex.set(id, offset);

    if (document) {
      this.indexManager.updateDocument(document as DocumentRecord, { id, offset });
    }
  }

  deletePrimaryIndexEntry(id: string): void {
    this.primaryIndex.remove(id);
    this.indexManager.removeDocument(id);
    this.cache?.invalidate(id);
  }

  createIndexFromReplay(field: string, type: SecondaryIndexType, unique: boolean): void {
    this.createIndexInMemory(field, type, unique);
  }

  dropFromReplay(): void {
    this.primaryIndex.clear();
    this.indexManager.clear();
    this.cache?.clear();
    this.dropped = true;
    this.onDrop();
  }

  dropIndexFromReplay(field: string): void {
    this.indexManager.removeIndex(field);
  }

  primaryIndexOffsetFor(id: string): number | undefined {
    return this.primaryIndex.get(id)?.offset;
  }

  updateDocumentOffset(id: string, newOffset: number): void {
    this.primaryIndex.set(id, newOffset);
  }

  hasIndex(field: string): boolean {
    return this.indexManager.hasIndex(field);
  }

  refreshIndexesAfterCompaction(): void {
    this.indexManager.clearAllIndexContents();

    const candidates = this.primaryIndex.snapshot();

    if (candidates.length === 0) {
      return;
    }

    // Same bulk-range read as rebuildIndex() and find()'s multi-candidate
    // scan — one range read instead of one readOperationAtOffset call per
    // document, which matters here just as much: compact() is precisely the
    // maintenance operation someone reaches for on a large database.
    const { buffer, rangeStart } = this.storage.readBulkRange(candidates.map((candidate) => candidate.offset));

    for (const candidate of candidates) {
      const operation = readOperationFromBuffer(buffer, candidate.offset - rangeStart);

      if (!operation.identifier.equals(PUT_DOCUMENT_OPERATION)) {
        throw new Error("Invalid index refresh candidate: expected a put document operation.");
      }

      const document = decodePutDocumentPayload(operation.payload, this.encoder).document;
      this.indexManager.updateDocument(document as DocumentRecord, candidate);
    }
  }

  private assertNotDropped(): void {
    if (this.dropped) {
      throw new Error(`Collection "${this.name}" has been dropped.`);
    }
  }

  private createDocumentId(providedId: unknown): Buffer {
    if (providedId !== undefined) {
      if (typeof providedId !== "string") {
        throw new Error("Document _id must be a string when provided.");
      }

      assertObjectIdHex(providedId);

      if (this.existsId(providedId)) {
        throw new Error(`Cannot insert document: duplicate _id "${providedId}".`);
      }

      return objectIdFromHex(providedId);
    }

    let id = createObjectId();

    while (this.existsId(id.toString("hex"))) {
      id = createObjectId();
    }

    return id;
  }

  private prepareInsertedDocument(document: Record<string, unknown>): {
    id: string;
    documentId: Buffer;
    document: Record<string, unknown>;
  } {
    const documentId = this.createDocumentId(document._id);
    const id = documentId.toString("hex");

    return {
      id,
      documentId,
      document: {
        ...document,
        _id: id
      }
    };
  }

  private appendPutDocument(documentId: Buffer, document: Record<string, unknown>): number {
    return this.storage.appendOperation(
      PUT_DOCUMENT_OPERATION,
      encodePutDocumentPayload(
        { collectionId: this.id, documentId, document },
        this.encoder
      )
    );
  }

  private appendDeleteDocument(id: string): void {
    this.appendDeleteDocumentRecord(id);
    this.deletePrimaryIndexEntry(id);
  }

  private appendDeleteDocumentRecord(id: string): void {
    this.storage.appendOperation(
      DELETE_DOCUMENT_OPERATION,
      encodeDeleteDocumentPayload({
        collectionId: this.id,
        documentId: objectIdFromHex(id)
      })
    );
  }

  private appendUpdatedDocument(document: Record<string, unknown>, update: UpdateExpression): void {
    if (typeof document._id !== "string") {
      throw new Error("Cannot update document: missing string _id.");
    }

    assertUpdateDoesNotMutateId(update);

    const updatedDocument = this.buildUpdatedDocument(document, update);

    this.indexManager.assertUnique(updatedDocument as DocumentRecord, document._id);

    const offset = this.appendPutDocument(objectIdFromHex(document._id), updatedDocument);

    this.applyPutDocument(document._id, offset, updatedDocument);
  }

  private buildUpdatedDocument(document: Record<string, unknown>, update: UpdateExpression): Record<string, unknown> {
    if (typeof document._id !== "string") {
      throw new Error("Cannot update document: missing string _id.");
    }

    assertUpdateDoesNotMutateId(update);

    return {
      ...updateDocument(document as DocumentRecord, update),
      _id: document._id
    };
  }

  private appendTransactionBegin(): void {
    this.storage.appendOperation(TRANSACTION_BEGIN_OPERATION, Buffer.alloc(0));
  }

  private appendTransactionCommit(): void {
    this.storage.appendOperation(TRANSACTION_COMMIT_OPERATION, Buffer.alloc(0));
  }

  private applyPutDocument(id: string, offset: number, document: Record<string, unknown>): void {
    this.primaryIndex.set(id, offset);
    this.indexManager.updateDocument(document as DocumentRecord, { id, offset });
    // Refresh the cached version with the new offset so the document stays hot
    // across updates. The document is freshly built and never mutated after this
    // call, so the cache can safely take ownership by reference.
    this.cache?.set(id, offset, document);
  }

  private createIndexInMemory(field: string, type: SecondaryIndexType, unique: boolean): SecondaryIndexDefinition {
    assertIndexField(field);
    const isNewIndex = !this.indexManager.hasIndex(field);
    const definition = this.indexManager.createIndex(field, type, unique);
    this.rebuildIndex(definition);

    // Only a brand-new unique index can contain pre-existing duplicates — once
    // created, every subsequent write is checked by assertUnique/assertUniqueBatch,
    // so an index that already existed can never have drifted into conflict.
    if (isNewIndex && unique) {
      const duplicateIds = this.indexManager.findDuplicate(field);

      if (duplicateIds) {
        this.indexManager.removeIndex(field);
        throw new Error(
          `Cannot create unique index on "${field}": documents ${duplicateIds.map((id) => `"${id}"`).join(", ")} ` +
          "share the same value."
        );
      }
    }

    return definition;
  }

  /**
   * Backfills a newly created (or replayed) index from every document
   * currently in the collection.
   *
   * Uses the same bulk-range read as `find()`'s multi-candidate scan (see
   * `FileStorage.readBulkRange`) instead of one `readOperationAtOffset` call
   * per document: on a collection with N existing documents that's 2
   * syscalls total instead of up to 3×N. This matters most exactly where
   * rebuilding is most expensive — `createIndex()` called on an
   * already-populated collection, and replaying an `idx1` record for a
   * collection whose documents were all inserted before it in the log (see
   * `docs/adr/0003-replay-based-startup.md`'s documented O(documents ×
   * indexes) startup cost).
   */
  private rebuildIndex(_definition: SecondaryIndexDefinition): void {
    const candidates = this.primaryIndex.snapshot();

    if (candidates.length === 0) {
      return;
    }

    const { buffer, rangeStart } = this.storage.readBulkRange(candidates.map((candidate) => candidate.offset));

    for (const candidate of candidates) {
      const operation = readOperationFromBuffer(buffer, candidate.offset - rangeStart);

      if (!operation.identifier.equals(PUT_DOCUMENT_OPERATION)) {
        throw new Error("Invalid index rebuild candidate: expected a put document operation.");
      }

      const document = decodePutDocumentPayload(operation.payload, this.encoder).document;

      this.indexManager.updateDocument(document as DocumentRecord, {
        id: candidate.id,
        offset: candidate.offset
      });
    }
  }

}

function assertUpdateDoesNotMutateId(update: UpdateExpression): void {
  if (update.$unset && Object.hasOwn(update.$unset, "_id")) {
    throw new Error("Cannot update immutable field _id.");
  }

  if (update.$set && Object.hasOwn(update.$set, "_id")) {
    throw new Error("Cannot update immutable field _id.");
  }

  if (update.$currentDate && Object.hasOwn(update.$currentDate, "_id")) {
    throw new Error("Cannot update immutable field _id.");
  }

  if (update.$rename) {
    for (const [field, target] of Object.entries(update.$rename)) {
      if (field === "_id" || target === "_id") {
        throw new Error("Cannot update immutable field _id.");
      }
    }
  }
}

function assertUniqueBatchIds(ids: string[]): void {
  const seen = new Set<string>();

  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`Cannot insert documents: duplicate _id "${id}" in batch.`);
    }

    seen.add(id);
  }
}

function isEmptyUpdate(update: UpdateExpression): boolean {
  return Object.keys(update).length === 0;
}

function assertIndexField(field: string): void {
  if (field.length === 0) {
    throw new Error("Index field cannot be empty.");
  }
}

function assertPositiveIntegerLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error("distinct() limit must be a positive integer.");
  }
}
