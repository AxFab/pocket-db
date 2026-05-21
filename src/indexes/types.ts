import type { CompiledQuery, DocumentRecord, FieldPredicate } from "../search/index.js";

export type IndexType = "$id" | "string" | "number";
export type SecondaryIndexType = Exclude<IndexType, "$id">;

export interface IndexDefinition {
  field: string;
  type: IndexType;
}

export interface SecondaryIndexDefinition {
  field: string;
  type: SecondaryIndexType;
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
}

export interface PrimaryIndex extends QueryIndex {
  readonly definition: { field: "_id"; type: "$id" };

  has(id: string): boolean;

  get(id: string): IndexCandidate | undefined;

  set(id: string, offset: number): void;

  snapshot(): IndexCandidate[];
}

export interface QueryPlan {
  candidates: IndexCandidate[];
  residualQuery: CompiledQuery;
  usedIndex?: IndexDefinition;
}
