export interface BenchDocument {
  name: string;
  role: "admin" | "editor" | "reader";
  age: number;
  score: number;
  active: boolean;
}

export interface StoredDocument extends BenchDocument {
  _id: string;
}

/**
 * Common interface implemented by every benchmark adapter.
 * All methods are synchronous to match pocket-db's execution model.
 */
export interface Adapter {
  /** Display name shown in the results table. */
  readonly name: string;

  /**
   * Create the database, insert `initialDocs`, and return their ids.
   * Called once before any benchmark cases run.
   */
  setup(initialDocs: BenchDocument[]): string[];

  /** Close the database and remove any temporary files. */
  teardown(): void;

  /** Insert a single document and return its id. */
  insertOne(doc: BenchDocument): string;

  /** Insert a batch of documents. */
  insertMany(docs: BenchDocument[]): void;

  /** Find a document by its primary key. Returns null when not found. */
  findById(id: string): StoredDocument | null;

  /** Return every document in the collection. */
  findAll(): StoredDocument[];

  /**
   * Filter by the `name` field (not indexed).
   * Measures unindexed full-collection scan performance.
   */
  findByName(name: string): StoredDocument[];

  /**
   * Filter by the `role` field (indexed when the adapter supports it).
   * Measures index-backed query performance.
   */
  findByRole(role: string): StoredDocument[];

  /** Replace the `score` field of the given document. */
  updateOne(id: string, score: number): void;

  /** Remove the document with the given id. */
  deleteOne(id: string): void;

  /**
   * Return the total number of documents in the collection.
   * Measures raw count performance; no filter applied.
   */
  countAll(): number;

  /**
   * Return every document sorted by `score` descending.
   * Measures full-collection sort performance.
   */
  sortByScore(): StoredDocument[];
}
