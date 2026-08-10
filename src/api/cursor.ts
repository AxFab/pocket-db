import { evaluateCompiledQuery, type CompiledQuery, type DocumentRecord } from "../search/index.js";
import { compareDocuments, parseSortSpec, type SortDirection, type SortField } from "../search/sort.js";
import { PUT_DOCUMENT_OPERATION } from "../storage/constants.js";
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

/** A pre-loaded byte range from {@link FileStorage.readBulkRange}. */
export interface BulkRange {
  buffer: Buffer;
  /** Absolute file offset that `buffer[0]` corresponds to. */
  rangeStart: number;
}

/**
 * Minimum number of candidates required before bulk-reading the candidate
 * range into memory is worth its own cost at all. Below this threshold
 * (e.g. findById, updateOne, deleteOne) the per-record readSync path is
 * cheaper than a bulk range read regardless of `limit`.
 */
const SCAN_PRELOAD_THRESHOLD = 2;

/**
 * When a `limit` is set and the cursor is still deferring the bulk-range
 * decision (see `resolveBulkRange`), this caps how many candidates get read
 * one at a time before giving up on "the limit will be satisfied quickly"
 * and falling back to a single bulk read for the rest. Bounds the worst case
 * for a rare-match query under a small limit (e.g. a `findOne()` whose match
 * is near the end of the candidate set, or missing entirely) to a fixed,
 * small number of extra small reads instead of scanning the whole candidate
 * set one record at a time.
 */
const MAX_PER_RECORD_READS_BEFORE_BULK_ESCALATION = 256;

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

  // Lazy/adaptive bulk-range read state (see `resolveBulkRange`).
  // `undefined` = not decided yet, `null` = decided against it (permanently,
  // when below threshold; or for now, when deferred behind a `limit`).
  private bulkRange: BulkRange | null | undefined = undefined;
  private perRecordReadsSinceDeferred = 0;

  /**
   * @param storage     File storage used for individual record reads, and to
   *                    lazily compute a bulk range when it becomes worth it
   *                    (see `resolveBulkRange`).
   * @param query       Compiled residual query evaluated against every candidate.
   * @param candidates  Snapshot of { id, offset } pairs captured at find() time.
   * @param encoder     Document encoder used to deserialize payload bytes.
   * @param cache       Optional hot-document cache. When `null` (the default,
   *                    i.e. caching disabled on the collection) the read path is
   *                    byte-for-byte the original behaviour with no overhead.
   */
  constructor(
    private readonly storage: FileStorage,
    private readonly query: CompiledQuery,
    private readonly candidates: QueryCandidate[],
    private readonly encoder: DocumentEncoder,
    private readonly cache: DocumentCache | null = null
  ) {}

  next(): Record<string, unknown> | null {
    if (this.sortFields !== null) {
      return this.nextSorted();
    }

    this.applyMatchAllSkipFastPath();

    while (this.currentIndex < this.candidates.length) {
      if (this.limitCount !== null && this.returnedCount >= this.limitCount) {
        return null;
      }

      const candidate = this.candidates[this.currentIndex];
      this.currentIndex += 1;

      // No limit means we expect to eventually consume most/all candidates
      // (toArray() with no limit(), or an unbounded iteration), so it's
      // worth forcing the bulk read up front, same as the old eager
      // behaviour. With a limit, defer — see `resolveBulkRange`.
      const document = this.readCandidateDocument(candidate, this.limitCount === null);

      if (this.bulkRange === undefined) {
        // Still deferring: this read went through the per-record path.
        // Escalate to a bulk read for the remainder if it's taking too long
        // to satisfy the limit (see MAX_PER_RECORD_READS_BEFORE_BULK_ESCALATION).
        this.perRecordReadsSinceDeferred += 1;

        if (this.perRecordReadsSinceDeferred >= MAX_PER_RECORD_READS_BEFORE_BULK_ESCALATION) {
          this.resolveBulkRange(true);
        }
      }

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
   *
   * Every candidate must be read regardless of `limit` (count() ignores it),
   * so this always forces the bulk-range decision rather than deferring it.
   */
  count(): number {
    if (isMatchAll(this.query)) {
      return this.candidates.length;
    }

    let total = 0;

    for (const candidate of this.candidates) {
      const document = this.readCandidateDocument(candidate, true);

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
   * Fast-forwards past skipped candidates without reading or decoding them,
   * when possible.
   *
   * Applies only to the unsorted path (sorting always reads every matching
   * candidate up front regardless of skip — see `nextSorted`). When the
   * residual query is match-all, every candidate counts toward `skip`
   * unconditionally, so which ones get skipped never depends on their
   * content — the same reasoning `count()`'s match-all fast path already
   * relies on. That means `currentIndex` can jump straight to `skipCount`
   * with no document reads at all, instead of reading and discarding each
   * skipped candidate one at a time.
   *
   * A non-match-all query can't take this shortcut: `skip` counts *matching*
   * documents, so whether a given candidate counts toward it depends on
   * evaluating the query against it first.
   *
   * Runs once, lazily, before the first candidate is read (guarded by
   * `currentIndex === 0 && skippedMatches === 0`) — safe to call on every
   * `next()` since it's a no-op on every call after the first.
   */
  private applyMatchAllSkipFastPath(): void {
    if (this.currentIndex === 0 && this.skippedMatches === 0 && this.skipCount > 0 && isMatchAll(this.query)) {
      this.currentIndex = Math.min(this.skipCount, this.candidates.length);
      this.skippedMatches = this.skipCount;
    }
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
   * the residual query. Used exclusively by the sorted path — sorting always
   * needs every matching candidate up front regardless of `limit`, so this
   * always forces the bulk-range decision rather than deferring it.
   */
  private collectAllMatching(): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];

    for (const candidate of this.candidates) {
      const document = this.readCandidateDocument(candidate, true);

      if (evaluateCompiledQuery(this.query, document as DocumentRecord)) {
        results.push(document);
      }
    }

    return results;
  }

  /**
   * Decides whether to pre-load the candidate range into a single Buffer, and
   * returns it if so — lazily and adaptively, unlike the old eager
   * `Collection.find()`-time computation (see ADR 0018).
   *
   * The eager version paid for a bulk read sized to *every* candidate before
   * the cursor knew whether the caller only wanted the first match — a
   * `findOne()` (`find(query).limit(1)`) on a large, unindexed, high-match
   * query paid the full-span cost for one document. Since `limit()` is only
   * known once the caller has chained it onto the cursor returned by
   * `find()`, that decision can't be made inside `find()` — only here, once
   * `limitCount` is settled and the first candidate is actually about to be
   * read.
   *
   * Decision, cached in `this.bulkRange` once made permanently:
   * - Below `SCAN_PRELOAD_THRESHOLD` candidates: never worth it. Decided once,
   *   permanently (`null`, cached).
   * - No `limit` set, or `forceFullRead` (count()/sort() always need every
   *   candidate regardless of limit): bulk-read everything now, same as the
   *   old eager behaviour, just deferred to first read instead of at find()
   *   time. Decided once, permanently.
   * - A `limit` is set and this isn't a forced read: defer. Returns `null`
   *   for *this* call without caching the decision, so per-record reads are
   *   used instead — the common `findOne()` case never touches the rest of
   *   the candidate span at all. `next()` tracks how many per-record reads
   *   this costs and escalates to a full bulk read if the limit isn't being
   *   satisfied quickly (see `MAX_PER_RECORD_READS_BEFORE_BULK_ESCALATION`),
   *   bounding the worst case for a rare-match query under a small limit.
   */
  private resolveBulkRange(forceFullRead: boolean): BulkRange | null {
    if (this.bulkRange !== undefined) {
      return this.bulkRange;
    }

    if (this.candidates.length < SCAN_PRELOAD_THRESHOLD) {
      this.bulkRange = null;
      return null;
    }

    if (!forceFullRead && this.limitCount !== null) {
      return null;
    }

    this.bulkRange = this.storage.readBulkRange(this.candidates.map((candidate) => candidate.offset));
    return this.bulkRange;
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
   *
   * @param forceFullRead Forces `resolveBulkRange` to make (or reuse) its
   *                       permanent bulk-read decision now instead of
   *                       deferring behind a `limit` — see `resolveBulkRange`.
   */
  private readCandidateDocument(candidate: QueryCandidate, forceFullRead = false): Record<string, unknown> {
    if (this.cache !== null) {
      const cached = this.cache.get(candidate.id, candidate.offset);

      if (cached !== undefined) {
        return cached;
      }
    }

    const bulkRange = this.resolveBulkRange(forceFullRead);

    const operation = bulkRange !== null
      ? readOperationFromBuffer(bulkRange.buffer, candidate.offset - bulkRange.rangeStart)
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
