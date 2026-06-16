import { evaluateCompiledQuery, type CompiledQuery, type DocumentRecord } from "../search/index.js";
import { compareDocuments, parseSortSpec, type SortDirection, type SortField } from "../search/sort.js";
import { FILE_HEADER_BYTES, PUT_DOCUMENT_OPERATION } from "../storage/constants.js";
import { decodePutDocumentPayload } from "../storage/document-operation.js";
import type { DocumentEncoder } from "../storage/encoding/document-encoder.js";
import type { FileStorage } from "../storage/file-storage.js";
import { readOperationFromBuffer } from "../storage/operation-record.js";
import type { DocumentCache } from "./document-cache.js";
import type { Cursor } from "./types.js";

export interface QueryCandidate {
  id: string;
  offset: number;
}

export class PocketCursor implements Cursor {
  private currentIndex = 0;
  private skippedMatches = 0;
  private returnedCount = 0;
  private limitCount: number | null = null;
  private skipCount = 0;

  // Sort state — null means unsorted (fast path).
  private sortFields: SortField[] | null = null;
  private sortedBuffer: Record<string, unknown>[] | null = null;
  private sortedIndex = 0;

  /**
   * @param storage     File storage used for individual record reads (fallback).
   * @param query       Compiled residual query evaluated against every candidate.
   * @param candidates  Snapshot of { id, offset } pairs captured at find() time.
   * @param bulkBuffer  Optional pre-loaded file content (starting at FILE_HEADER_BYTES).
   *                    When provided, all document reads are served from this buffer
   *                    with zero additional syscalls.
   * @param encoder     Document encoder used to deserialize payload bytes.
   * @param cache       Optional hot-document cache. When `null` (the default,
   *                    i.e. caching disabled on the collection) the read path is
   *                    byte-for-byte the original behaviour with no overhead.
   */
  constructor(
    private readonly storage: FileStorage,
    private readonly query: CompiledQuery,
    private readonly candidates: QueryCandidate[],
    private readonly bulkBuffer: Buffer | null = null,
    private readonly encoder: DocumentEncoder,
    private readonly cache: DocumentCache | null = null
  ) {}

  next(): Record<string, unknown> | null {
    if (this.sortFields !== null) {
      return this.nextSorted();
    }

    while (this.currentIndex < this.candidates.length) {
      if (this.limitCount !== null && this.returnedCount >= this.limitCount) {
        return null;
      }

      const candidate = this.candidates[this.currentIndex];
      this.currentIndex += 1;

      const document = this.readCandidateDocument(candidate);

      if (!evaluateCompiledQuery(this.query, document as DocumentRecord)) {
        continue;
      }

      if (this.skippedMatches < this.skipCount) {
        this.skippedMatches += 1;
        continue;
      }

      this.returnedCount += 1;
      return document;
    }

    return null;
  }

  toArray(): Record<string, unknown>[] {
    const documents: Record<string, unknown>[] = [];

    for (let document = this.next(); document !== null; document = this.next()) {
      documents.push(document);
    }

    return documents;
  }

  /**
   * Counts matching documents without consuming or advancing the cursor.
   * Ignores `skip` and `limit` — returns the total result set size.
   *
   * Fast path: when the residual query is empty (match-all), returns
   * `candidates.length` with no document reads.
   */
  count(): number {
    if (isMatchAll(this.query)) {
      return this.candidates.length;
    }

    let total = 0;

    for (const candidate of this.candidates) {
      const document = this.readCandidateDocument(candidate);

      if (evaluateCompiledQuery(this.query, document as DocumentRecord)) {
        total += 1;
      }
    }

    return total;
  }

  sort(spec: Record<string, SortDirection>): Cursor {
    this.sortFields = parseSortSpec(spec);
    return this;
  }

  limit(count: number): Cursor {
    assertPositiveIntegerOrZero(count, "limit");
    this.limitCount = count;
    return this;
  }

  skip(count: number): Cursor {
    assertPositiveIntegerOrZero(count, "skip");
    this.skipCount = count;
    return this;
  }

  /**
   * Sorted path for next(): builds and sorts the full result set on the first
   * call, then yields one document per subsequent call.
   *
   * Sorting requires reading all matching candidates before returning the first
   * result — this is inherent to any sort that lacks a pre-sorted index.
   */
  private nextSorted(): Record<string, unknown> | null {
    if (this.sortedBuffer === null) {
      this.sortedBuffer = this.collectAllMatching();
      this.sortedBuffer.sort((a, b) => compareDocuments(a, b, this.sortFields!));
      this.sortedIndex = 0;
    }

    while (this.sortedIndex < this.sortedBuffer.length) {
      if (this.limitCount !== null && this.returnedCount >= this.limitCount) {
        return null;
      }

      const document = this.sortedBuffer[this.sortedIndex];
      this.sortedIndex += 1;

      if (this.skippedMatches < this.skipCount) {
        this.skippedMatches += 1;
        continue;
      }

      this.returnedCount += 1;
      return document;
    }

    return null;
  }

  /**
   * Reads all candidates from disk (or bulk buffer) and filters them through
   * the residual query. Used exclusively by the sorted path.
   */
  private collectAllMatching(): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];

    for (const candidate of this.candidates) {
      const document = this.readCandidateDocument(candidate);

      if (evaluateCompiledQuery(this.query, document as DocumentRecord)) {
        results.push(document);
      }
    }

    return results;
  }

  /**
   * Resolves a candidate to its document, honouring the cursor's offset
   * snapshot.
   *
   * When a cache is present, it is consulted first: a hit returns a clone of the
   * cached version *only if the cached offset matches this candidate's snapshot
   * offset* (otherwise the cache holds a newer version and we must read our own).
   * On a miss the record is read (from the bulk buffer or a single record read),
   * decoded, and handed to the cache by reference. The cache then owns that
   * object, so the caller receives a clone instead — preserving the contract
   * that query results are independent, caller-owned objects.
   *
   * When no cache is present this is the original read-and-decode path with zero
   * added overhead.
   */
  private readCandidateDocument(candidate: QueryCandidate): Record<string, unknown> {
    if (this.cache !== null) {
      const cached = this.cache.get(candidate.id, candidate.offset);

      if (cached !== undefined) {
        return cached;
      }
    }

    const operation = this.bulkBuffer !== null
      ? readOperationFromBuffer(this.bulkBuffer, candidate.offset - FILE_HEADER_BYTES)
      : this.storage.readOperationAtOffset(candidate.offset);

    if (!operation.identifier.equals(PUT_DOCUMENT_OPERATION)) {
      throw new Error("Invalid cursor candidate: expected a put document operation.");
    }

    const document = decodePutDocumentPayload(operation.payload, this.encoder).document;

    if (this.cache !== null) {
      // The cache takes ownership of the decoded object; the caller gets a clone.
      this.cache.set(candidate.id, candidate.offset, document);
      return structuredClone(document);
    }

    return document;
  }
}

function assertPositiveIntegerOrZero(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Cursor ${name} must be a positive integer or zero.`);
  }
}

/**
 * Returns true when the compiled query is a match-all predicate
 * (i.e. `compileQuery({})` — an AND with no clauses).
 * Used by `count()` to skip document reads entirely.
 */
function isMatchAll(query: CompiledQuery): boolean {
  return query.type === "and" && query.predicates.length === 0;
}
