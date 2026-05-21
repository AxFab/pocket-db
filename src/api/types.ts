import type { UpdateExpression } from "../search/index.js";
import type { SecondaryIndexDefinition, SecondaryIndexType } from "../indexes/index.js";

export interface OpenOptions {
  /**
   * Path to the database file.
   *
   * The default keeps the first API call intentionally small while the storage
   * layer is still experimental.
   */
  path?: string;
}

export interface Database {
  collection(name: string): Collection;

  /**
   * Rewrites the database file in a single forward pass, discarding dead
   * records (deleted/updated documents, dropped collections, dropped indexes,
   * transaction boundaries). Updates all in-memory primary indexes to point to
   * the new offsets and refreshes secondary indexes.
   */
  compact(): void;

  /**
   * Closes the database handle.
   *
   * The current implementation only owns a file descriptor. Future storage
   * engines may flush pending writes or release native resources here.
   */
  close(): void;
}

export interface Collection {
  readonly name: string;
  readonly indexes: readonly SecondaryIndexDefinition[];

  insertOne(document: Record<string, unknown>): InsertOneResult;

  insertMany(documents: Record<string, unknown>[]): InsertManyResult;

  replaceOne(id: string, document: Record<string, unknown>): ReplaceOneResult;

  replaceOne(document: Record<string, unknown> & { _id: string }): ReplaceOneResult;

  updateOne(id: string, update: UpdateExpression): UpdateResult;

  updateOne(query: Record<string, unknown>, update: UpdateExpression): UpdateResult;

  updateMany(query: Record<string, unknown>, update: UpdateExpression): UpdateResult;

  createIndex(field: string, options: CreateIndexOptions): CreateIndexResult;

  find(query?: Record<string, unknown>): Cursor;

  findOne(query?: Record<string, unknown>): Record<string, unknown> | null;

  /**
   * Returns the number of documents that match `query` (default: all documents).
   *
   * Equivalent to `collection.find(query).count()`.
   */
  countDocuments(query?: Record<string, unknown>): number;

  deleteOne(id: string): DeleteOneResult;

  deleteOne(query: Record<string, unknown>): DeleteOneResult;

  deleteMany(query?: Record<string, unknown>): DeleteManyResult;

  drop(): DropResult;

  dropIndex(field: string): DropIndexResult;
}

export interface Cursor {
  next(): Record<string, unknown> | null;

  toArray(): Record<string, unknown>[];

  /**
   * Returns the total number of documents that match the cursor's query,
   * scanning from the beginning of the candidate set.
   *
   * Does NOT respect `skip` or `limit` (use those for pagination slices;
   * use `count` for the total result size before slicing). Does not consume
   * or advance the cursor.
   */
  count(): number;

  /**
   * Specifies the sort order for the cursor results.
   *
   * `spec` is a map of field names to direction: `1` for ascending, `-1`
   * for descending. Fields are applied left-to-right as a tie-breaker chain.
   * Maximum of 4 sort fields.
   *
   * Supported field types: boolean, number, string (including `_id`).
   * Missing values (null, undefined, NaN) sort first in ascending order and
   * last in descending order.
   *
   * **Note:** sort triggers a full scan of all matching candidates before the
   * first result is returned. Prefer indexed queries to narrow the candidate
   * set when sorting over large collections.
   */
  sort(spec: Record<string, 1 | -1>): Cursor;

  limit(count: number): Cursor;

  skip(count: number): Cursor;
}

export interface InsertOneResult {
  acknowledged: true;
  insertedId: string;
}

export interface InsertManyResult {
  acknowledged: true;
  insertedCount: number;
  insertedIds: string[];
}

export interface ReplaceOneResult {
  acknowledged: true;
  matchedCount: 1;
  modifiedCount: 1;
}

export interface UpdateResult {
  acknowledged: true;
  matchedCount: number;
  modifiedCount: number;
}

export interface DeleteOneResult {
  acknowledged: true;
  deletedCount: 0 | 1;
}

export interface DeleteManyResult {
  acknowledged: true;
  deletedCount: number;
}

export interface CreateIndexOptions {
  type: SecondaryIndexType;
}

export interface CreateIndexResult {
  acknowledged: true;
  field: string;
  type: SecondaryIndexType;
}

export interface DropResult {
  acknowledged: true;
}

export interface DropIndexResult {
  acknowledged: true;
  field: string;
}
