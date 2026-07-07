import type { DocumentRecord, FieldPredicate } from "../search/index.js";
import type { IndexCandidate, PrimaryIndex } from "./types.js";

export class InMemoryPrimaryIndex implements PrimaryIndex {
  readonly definition = {
    field: "_id",
    type: "$id",
    unique: true
  } as const;

  private readonly candidatesById = new Map<string, IndexCandidate>();

  /** Number of live documents tracked by this index (O(1)). */
  get size(): number {
    return this.candidatesById.size;
  }

  add(_document: DocumentRecord, candidate: IndexCandidate): void {
    this.set(candidate.id, candidate.offset);
  }

  remove(id: string): void {
    this.candidatesById.delete(id);
  }

  update(_document: DocumentRecord, candidate: IndexCandidate): void {
    this.set(candidate.id, candidate.offset);
  }

  /**
   * `_id` uniqueness is already enforced at document-id assignment time (see
   * `PocketCollection.createDocumentId`), so the primary index never needs to
   * be consulted as a `unique`-style constraint check. These exist only to
   * satisfy the {@link QueryIndex} interface.
   */
  findOwner(): string | undefined {
    return undefined;
  }

  findDuplicate(): string[] | undefined {
    return undefined;
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
