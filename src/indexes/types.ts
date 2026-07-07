import type { CompiledQuery, DocumentRecord, FieldPredicate } from "../search/index.js";

export type IndexType = "$id" | "string" | "number";
export type SecondaryIndexType = Exclude<IndexType, "$id">;

export interface IndexDefinition {
  field: string;
  type: IndexType;
  /** Whether this index rejects writes that would duplicate a value already held by another document. */
  unique: boolean;
}

export interface SecondaryIndexDefinition {
  field: string;
  type: SecondaryIndexType;
  /** Whether this index rejects writes that would duplicate a value already held by another document. */
  unique: boolean;
}

export interface IndexCandidate {
  id: string;
  offset: number;
}

export interface QueryIndex {
  readonly definition: IndexDefinition;

  add(document: DocumentRecord, candidate: IndexCandidate): void;

  remove(id: string): void;

  update(document: DocumentRecord, candidate: IndexCandidate): void;

  scan(predicate: FieldPredicate): IndexCandidate[] | null;

  clearContents(): void;

  /**
   * Returns the id of the document currently holding the same indexed value as
   * `document` (i.e. the value at `document[definition.field]`), excluding
   * `excludeId` (used when the document being checked is itself an existing,
   * in-place write). Returns `undefined` when the document's value is not of
   * the indexed type (nothing to conflict with) or no other document holds it.
   *
   * Used to enforce `unique` indexes on the write path, ahead of appending the
   * operation record — writes are append-only and cannot be rolled back once
   * written, so the check must happen before the append.
   */
  findOwner(document: DocumentRecord, excludeId?: string): string | undefined;

  /**
   * Scans the index's current contents for a value held by more than one
   * document, returning the ids of every document sharing that value, or
   * `undefined` if every indexed value is unique. Used when a `unique` index
   * is first created over a collection that may already contain duplicates.
   */
  findDuplicate(): string[] | undefined;
}

export interface PrimaryIndex extends QueryIndex {
  readonly definition: { field: "_id"; type: "$id"; unique: true };

  has(id: string): boolean;

  get(id: string): IndexCandidate | undefined;

  set(id: string, offset: number): void;

  snapshot(): IndexCandidate[];
}

export interface QueryPlan {
  candidates: IndexCandidate[];
  residualQuery: CompiledQuery;
  /**
   * Every index that contributed to `candidates`, one per indexable field
   * predicate (their scan results were intersected by id). Empty when no
   * predicate could be answered by an index, i.e. `candidates` is the full
   * primary index snapshot.
   */
  usedIndexes: IndexDefinition[];
}
