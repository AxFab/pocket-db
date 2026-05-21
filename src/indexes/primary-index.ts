import type { DocumentRecord, FieldPredicate } from "../search/index.js";
import type { IndexCandidate, PrimaryIndex } from "./types.js";

export class InMemoryPrimaryIndex implements PrimaryIndex {
  readonly definition = {
    field: "_id",
    type: "$id"
  } as const;

  private readonly candidatesById = new Map<string, IndexCandidate>();

  add(_document: DocumentRecord, candidate: IndexCandidate): void {
    this.set(candidate.id, candidate.offset);
  }

  remove(id: string): void {
    this.candidatesById.delete(id);
  }

  update(_document: DocumentRecord, candidate: IndexCandidate): void {
    this.set(candidate.id, candidate.offset);
  }

  scan(predicate: FieldPredicate): IndexCandidate[] | null {
    if (predicate.field !== "_id") {
      return null;
    }

    const ids = collectIdValues(predicate);

    if (!ids) {
      return null;
    }

    return ids.flatMap((id) => {
      const candidate = this.get(id);
      return candidate ? [candidate] : [];
    });
  }

  has(id: string): boolean {
    return this.candidatesById.has(id);
  }

  get(id: string): IndexCandidate | undefined {
    return this.candidatesById.get(id);
  }

  set(id: string, offset: number): void {
    this.candidatesById.set(id, { id, offset });
  }

  snapshot(): IndexCandidate[] {
    return Array.from(this.candidatesById.values());
  }

  clear(): void {
    this.candidatesById.clear();
  }

  clearContents(): void {
    this.candidatesById.clear();
  }
}

function collectIdValues(predicate: FieldPredicate): string[] | null {
  if (predicate.operators.length === 0) {
    return null;
  }

  const ids: string[] = [];

  for (const operator of predicate.operators) {
    if (operator.type === "eq") {
      if (typeof operator.value !== "string") {
        return [];
      }

      ids.push(operator.value);
      continue;
    }

    if (operator.type === "in") {
      ids.push(...operator.values.filter((value): value is string => typeof value === "string"));
      continue;
    }

    return null;
  }

  return ids;
}
