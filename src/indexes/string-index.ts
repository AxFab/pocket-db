import type { DocumentRecord, FieldPredicate } from "../search/index.js";
import type { IndexCandidate, IndexDefinition, QueryIndex } from "./types.js";

export class StringIndex implements QueryIndex {
  readonly definition: IndexDefinition;
  private readonly values = new Map<string, Map<string, IndexCandidate>>();
  private readonly valuesById = new Map<string, string>();

  constructor(field: string, unique = false) {
    this.definition = { field, type: "string", unique };
  }

  add(document: DocumentRecord, candidate: IndexCandidate): void {
    const value = document[this.definition.field];

    if (typeof value !== "string") {
      return;
    }

    let candidates = this.values.get(value);

    if (!candidates) {
      candidates = new Map();
      this.values.set(value, candidates);
    }

    candidates.set(candidate.id, candidate);
    this.valuesById.set(candidate.id, value);
  }

  remove(id: string): void {
    const value = this.valuesById.get(id);

    if (value === undefined) {
      return;
    }

    const candidates = this.values.get(value);
    candidates?.delete(id);

    if (candidates?.size === 0) {
      this.values.delete(value);
    }

    this.valuesById.delete(id);
  }

  update(document: DocumentRecord, candidate: IndexCandidate): void {
    this.remove(candidate.id);
    this.add(document, candidate);
  }

  clearContents(): void {
    this.values.clear();
    this.valuesById.clear();
  }

  findOwner(document: DocumentRecord, excludeId?: string): string | undefined {
    const value = document[this.definition.field];

    if (typeof value !== "string") {
      return undefined;
    }

    const candidates = this.values.get(value);

    if (!candidates) {
      return undefined;
    }

    for (const id of candidates.keys()) {
      if (id !== excludeId) {
        return id;
      }
    }

    return undefined;
  }

  findDuplicate(): string[] | undefined {
    for (const candidates of this.values.values()) {
      if (candidates.size > 1) {
        return Array.from(candidates.keys());
      }
    }

    return undefined;
  }

  scan(predicate: FieldPredicate): IndexCandidate[] | null {
    if (predicate.field !== this.definition.field) {
      return null;
    }

    const equalityValues = collectStringEqualityValues(predicate);

    if (!equalityValues) {
      return null;
    }

    const candidates = new Map<string, IndexCandidate>();

    for (const value of equalityValues) {
      for (const [id, candidate] of this.values.get(value) ?? []) {
        candidates.set(id, candidate);
      }
    }

    return Array.from(candidates.values());
  }
}

function collectStringEqualityValues(predicate: FieldPredicate): string[] | null {
  if (predicate.operators.length === 0) {
    return null;
  }

  const values: string[] = [];

  for (const operator of predicate.operators) {
    if (operator.type === "eq") {
      if (typeof operator.value !== "string") {
        return [];
      }

      values.push(operator.value);
      continue;
    }

    if (operator.type === "in") {
      const stringValues = operator.values.filter((value): value is string => typeof value === "string");
      values.push(...stringValues);
      continue;
    }

    return null;
  }

  return values;
}
