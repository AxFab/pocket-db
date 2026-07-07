import type { CompiledQuery, DocumentRecord, FieldPredicate } from "../search/index.js";
import { NumberIndex } from "./number-index.js";
import { StringIndex } from "./string-index.js";
import type {
  IndexCandidate,
  IndexDefinition,
  IndexType,
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

  createIndex(field: string, type: SecondaryIndexType, unique = false): SecondaryIndexDefinition {
    if (type !== "string" && type !== "number") {
      throw new Error(`Unsupported index type: ${type}.`);
    }

    const existing = this.indexesByField.get(field);

    if (existing) {
      if (existing.definition.type !== type) {
        throw new Error(`Index already exists on "${field}" with type "${existing.definition.type}".`);
      }

      if (existing.definition.unique !== unique) {
        throw new Error(
          `Index already exists on "${field}" with unique=${existing.definition.unique}.`
        );
      }

      return existing.definition as SecondaryIndexDefinition;
    }

    const index = type === "string" ? new StringIndex(field, unique) : new NumberIndex(field, unique);
    this.indexesByField.set(field, index);

    return index.definition as SecondaryIndexDefinition;
  }

  /**
   * Throws if `document` would duplicate a value already held by another
   * document on any `unique` index. Must be called with the fully-built
   * document, before appending its `put1` record — writes are append-only, so
   * there is no way to roll back after the fact.
   *
   * @param excludeId The document's own id, when this is an in-place write
   *                  (replace/update) rather than a brand-new insert. Lets a
   *                  document keep its own existing value without tripping the
   *                  constraint against itself.
   */
  assertUnique(document: DocumentRecord, excludeId?: string): void {
    for (const index of this.indexesByField.values()) {
      if (!index.definition.unique) {
        continue;
      }

      const owner = index.findOwner(document, excludeId);

      if (owner !== undefined) {
        throw new Error(
          `Cannot write document: value ${JSON.stringify(document[index.definition.field])} for unique index ` +
          `"${index.definition.field}" is already used by document "${owner}".`
        );
      }
    }
  }

  /**
   * Same as {@link assertUnique}, but for a batch of documents written
   * together (`insertMany`/`updateMany`) that are not yet reflected in the
   * index. In addition to checking each document against the current index
   * contents, this also detects two documents in the same batch colliding
   * with each other, since neither would be visible to the other via
   * `findOwner` until after the batch is applied.
   *
   * Each entry's own id is used as its `excludeId`, so `updateMany` entries
   * may keep their own existing value; for `insertMany` entries (new ids) this
   * is a no-op since the id cannot already own anything.
   */
  assertUniqueBatch(entries: { id: string; document: DocumentRecord }[]): void {
    for (const index of this.indexesByField.values()) {
      if (!index.definition.unique) {
        continue;
      }

      const seenInBatch = new Map<string | number, string>();

      for (const entry of entries) {
        const value = normalizeIndexValue(index.definition.type, entry.document[index.definition.field]);

        if (value === undefined) {
          continue;
        }

        const existingOwner = index.findOwner(entry.document, entry.id);

        if (existingOwner !== undefined) {
          throw new Error(
            `Cannot write document "${entry.id}": value ${JSON.stringify(value)} for unique index ` +
            `"${index.definition.field}" is already used by document "${existingOwner}".`
          );
        }

        const batchOwner = seenInBatch.get(value);

        if (batchOwner !== undefined && batchOwner !== entry.id) {
          throw new Error(
            `Cannot write documents "${batchOwner}" and "${entry.id}": both use value ${JSON.stringify(value)} ` +
            `for unique index "${index.definition.field}".`
          );
        }

        seenInBatch.set(value, entry.id);
      }
    }
  }

  /**
   * Scans the named index's current contents for a duplicated value, returning
   * the ids of every document sharing it, or `undefined` if there is none.
   * Used right after populating a brand-new `unique` index over a collection
   * that may already contain conflicting documents.
   */
  findDuplicate(field: string): string[] | undefined {
    return this.indexesByField.get(field)?.findDuplicate();
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

/**
 * Mirrors the type guard each index's own `add()` uses to decide whether a
 * field value participates in that index (`StringIndex` only indexes
 * strings, `NumberIndex` only finite numbers). Returns `undefined` for values
 * that the index would silently skip — such values never conflict under a
 * `unique` constraint.
 */
function normalizeIndexValue(type: IndexType, value: unknown): string | number | undefined {
  if (type === "string") {
    return typeof value === "string" ? value : undefined;
  }

  if (type === "number") {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  // "$id" (the primary index) is never present in indexesByField; unreachable in practice.
  return undefined;
}
