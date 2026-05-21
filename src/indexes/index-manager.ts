import type { CompiledQuery, DocumentRecord, FieldPredicate } from "../search/index.js";
import { NumberIndex } from "./number-index.js";
import { StringIndex } from "./string-index.js";
import type {
  IndexCandidate,
  IndexDefinition,
  PrimaryIndex,
  QueryIndex,
  QueryPlan,
  SecondaryIndexDefinition,
  SecondaryIndexType
} from "./types.js";

export class IndexManager {
  private readonly indexesByField = new Map<string, QueryIndex>();

  get definitions(): SecondaryIndexDefinition[] {
    return Array.from(this.indexesByField.values()).map((index) => index.definition as SecondaryIndexDefinition);
  }

  createIndex(field: string, type: SecondaryIndexType): SecondaryIndexDefinition {
    if (type !== "string" && type !== "number") {
      throw new Error(`Unsupported index type: ${type}.`);
    }

    const existing = this.indexesByField.get(field);

    if (existing) {
      if (existing.definition.type !== type) {
        throw new Error(`Index already exists on "${field}" with type "${existing.definition.type}".`);
      }

      return existing.definition as SecondaryIndexDefinition;
    }

    const index = type === "string" ? new StringIndex(field) : new NumberIndex(field);
    this.indexesByField.set(field, index);

    return index.definition as SecondaryIndexDefinition;
  }

  addDocument(document: DocumentRecord, candidate: IndexCandidate): void {
    for (const index of this.indexesByField.values()) {
      index.add(document, candidate);
    }
  }

  updateDocument(document: DocumentRecord, candidate: IndexCandidate): void {
    for (const index of this.indexesByField.values()) {
      index.update(document, candidate);
    }
  }

  removeDocument(id: string): void {
    for (const index of this.indexesByField.values()) {
      index.remove(id);
    }
  }

  removeIndex(field: string): void {
    if (!this.indexesByField.has(field)) {
      throw new Error(`No index exists on field "${field}".`);
    }

    this.indexesByField.delete(field);
  }

  hasIndex(field: string): boolean {
    return this.indexesByField.has(field);
  }

  clearAllIndexContents(): void {
    for (const index of this.indexesByField.values()) {
      index.clearContents();
    }
  }

  clear(): void {
    this.indexesByField.clear();
  }

  plan(query: CompiledQuery, primaryIndex: PrimaryIndex): QueryPlan {
    let selectedCandidates: IndexCandidate[] | null = null;
    let selectedIndex: IndexDefinition | undefined;

    for (const predicate of fieldPredicates(query)) {
      for (const index of this.indexesForPredicate(predicate, primaryIndex)) {
        const candidates = index.scan(predicate);

        if (!candidates) {
          continue;
        }

        if (!selectedCandidates || candidates.length < selectedCandidates.length) {
          selectedCandidates = candidates;
          selectedIndex = index.definition;
        }
      }
    }

    return {
      candidates: selectedCandidates ?? primaryIndex.snapshot(),
      residualQuery: query,
      usedIndex: selectedIndex
    };
  }

  private indexesForPredicate(predicate: FieldPredicate, primaryIndex: PrimaryIndex): QueryIndex[] {
    const indexes: QueryIndex[] = [];

    if (predicate.field === primaryIndex.definition.field) {
      indexes.push(primaryIndex);
    }

    const secondaryIndex = this.indexesByField.get(predicate.field);

    if (secondaryIndex) {
      indexes.push(secondaryIndex);
    }

    return indexes;
  }
}

function fieldPredicates(query: CompiledQuery): FieldPredicate[] {
  if (query.type === "field") {
    return [query];
  }

  // Only recurse into AND nodes — OR / NOR are disjunctive and cannot be
  // answered by a single index scan (we would miss documents that match a
  // branch not covered by the chosen index).
  if (query.type === "and") {
    return query.predicates.flatMap((predicate) => fieldPredicates(predicate));
  }

  return [];
}
