import type { DocumentRecord, FieldPredicate } from "../search/index.js";
import type { IndexCandidate, IndexDefinition, QueryIndex } from "./types.js";

export class NumberIndex implements QueryIndex {
  readonly definition: IndexDefinition;
  private readonly values = new Map<number, Map<string, IndexCandidate>>();
  private readonly valuesById = new Map<string, number>();
  private sortedValues: number[] = [];

  constructor(field: string) {
    this.definition = { field, type: "number" };
  }

  add(document: DocumentRecord, candidate: IndexCandidate): void {
    const value = document[this.definition.field];

    if (typeof value !== "number" || !Number.isFinite(value)) {
      return;
    }

    let candidates = this.values.get(value);

    if (!candidates) {
      candidates = new Map();
      this.values.set(value, candidates);
      insertSorted(this.sortedValues, value);
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
      this.sortedValues = this.sortedValues.filter((entry) => entry !== value);
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
    this.sortedValues = [];
  }

  scan(predicate: FieldPredicate): IndexCandidate[] | null {
    if (predicate.field !== this.definition.field) {
      return null;
    }

    const range = numberPredicateRange(predicate);

    if (!range) {
      return null;
    }

    const values = range.values ?? this.valuesInRange(range);
    const candidates = new Map<string, IndexCandidate>();

    for (const value of values) {
      for (const [id, candidate] of this.values.get(value) ?? []) {
        candidates.set(id, candidate);
      }
    }

    return Array.from(candidates.values());
  }

  private valuesInRange(range: NumberRange): number[] {
    return this.sortedValues.filter((value) => {
      return (
        (range.minExclusive === null || value > range.minExclusive) &&
        (range.minInclusive === null || value >= range.minInclusive) &&
        (range.maxExclusive === null || value < range.maxExclusive) &&
        (range.maxInclusive === null || value <= range.maxInclusive)
      );
    });
  }
}

interface NumberRange {
  minExclusive: number | null;
  minInclusive: number | null;
  maxExclusive: number | null;
  maxInclusive: number | null;
  values?: number[];
}

function numberPredicateRange(predicate: FieldPredicate): NumberRange | null {
  if (predicate.operators.length === 0) {
    return null;
  }

  let minExclusive: number | null = null;
  let minInclusive: number | null = null;
  let maxExclusive: number | null = null;
  let maxInclusive: number | null = null;
  let equalityValues: number[] | null = null;

  for (const operator of predicate.operators) {
    if (operator.type === "eq") {
      if (typeof operator.value !== "number" || !Number.isFinite(operator.value)) {
        return { minExclusive, minInclusive, maxExclusive, maxInclusive, values: [] };
      }
      equalityValues = [operator.value];
      continue;
    }

    if (operator.type === "in") {
      equalityValues = operator.values.filter((v): v is number => {
        return typeof v === "number" && Number.isFinite(v);
      });
      continue;
    }

    if (operator.type === "gt") {
      if (typeof operator.value !== "number" || !Number.isFinite(operator.value)) {
        return { minExclusive, minInclusive, maxExclusive, maxInclusive, values: [] };
      }
      minExclusive = Math.max(minExclusive ?? Number.NEGATIVE_INFINITY, operator.value);
      continue;
    }

    if (operator.type === "gte") {
      if (typeof operator.value !== "number" || !Number.isFinite(operator.value)) {
        return { minExclusive, minInclusive, maxExclusive, maxInclusive, values: [] };
      }
      minInclusive = Math.max(minInclusive ?? Number.NEGATIVE_INFINITY, operator.value);
      continue;
    }

    if (operator.type === "lt") {
      if (typeof operator.value !== "number" || !Number.isFinite(operator.value)) {
        return { minExclusive, minInclusive, maxExclusive, maxInclusive, values: [] };
      }
      maxExclusive = Math.min(maxExclusive ?? Number.POSITIVE_INFINITY, operator.value);
      continue;
    }

    if (operator.type === "lte") {
      if (typeof operator.value !== "number" || !Number.isFinite(operator.value)) {
        return { minExclusive, minInclusive, maxExclusive, maxInclusive, values: [] };
      }
      maxInclusive = Math.min(maxInclusive ?? Number.POSITIVE_INFINITY, operator.value);
      continue;
    }

    // ne, nin, not, exists — cannot be answered by a range scan; fall back.
    return null;
  }

  if (equalityValues) {
    return {
      minExclusive,
      minInclusive,
      maxExclusive,
      maxInclusive,
      values: equalityValues.filter((value) => {
        return (
          (minExclusive === null || value > minExclusive) &&
          (minInclusive === null || value >= minInclusive) &&
          (maxExclusive === null || value < maxExclusive) &&
          (maxInclusive === null || value <= maxInclusive)
        );
      })
    };
  }

  return { minExclusive, minInclusive, maxExclusive, maxInclusive };
}

function insertSorted(values: number[], value: number): void {
  let low = 0;
  let high = values.length;

  while (low < high) {
    const middle = Math.floor((low + high) / 2);

    if (values[middle] < value) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }

  values.splice(low, 0, value);
}
