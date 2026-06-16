/**
 * Parsed document as handled by the read/write path. Kept structurally
 * identical to what `find()`/`findOne()` return so the cache can sit on the
 * read path without any conversion.
 */
type CachedDocument = Record<string, unknown>;

/**
 * Runtime statistics for a {@link DocumentCache}.
 *
 * Exposed so that `Collection.cacheStats()` can surface cache effectiveness
 * (hit ratio) and memory pressure (`bytes` / `documentCount`) without the
 * caller reaching into private state.
 */
export interface DocumentCacheStats {
  /** Whether the cache is active (`maxBytes > 0`). */
  enabled: boolean;
  /** Configured byte budget. */
  maxBytes: number;
  /** Approximate retained bytes currently held. */
  bytes: number;
  /** Number of documents currently resident. */
  documentCount: number;
  /** Cache hits since the last {@link DocumentCache.resetStats}. */
  hits: number;
  /** Cache misses since the last {@link DocumentCache.resetStats}. */
  misses: number;
  /** Entries dropped by LRU eviction since the last reset. */
  evictions: number;
}

/**
 * Estimates the retained memory cost (in bytes) of a cached document.
 *
 * The default uses the UTF-16 character count of the JSON serialization as a
 * cheap, deterministic proxy — it intentionally ignores V8 object header
 * overhead and is meant for *relative* budgeting, not exact accounting.
 * A custom estimator can be injected via {@link DocumentCacheOptions.sizeOf}.
 *
 * @param document The parsed document to measure.
 * @returns Approximate retained size in bytes (always ≥ 1).
 */
export function estimateDocumentBytes(document: CachedDocument): number {
  // 2 bytes per UTF-16 code unit; floor of 1 so empty docs still cost something.
  return Math.max(1, JSON.stringify(document).length * 2);
}

/** Construction options for {@link DocumentCache}. */
export interface DocumentCacheOptions {
  /**
   * Byte budget for resident documents. Must be a positive integer — a cache
   * is only ever instantiated once enabled, so there is no "disabled" budget.
   */
  maxBytes: number;
  /**
   * Override for the per-document size estimator. Defaults to
   * {@link estimateDocumentBytes}.
   */
  sizeOf?: (document: CachedDocument) => number;
}

interface CacheEntry {
  /** Parsed document, owned by the cache (never handed out by reference). */
  document: CachedDocument;
  /**
   * File offset this version was read from. Acts as a version tag: a cursor
   * reading from an older snapshot offset will not match a newer cached entry,
   * preserving snapshot semantics (see {@link DocumentCache.get}).
   */
  offset: number;
  /** Cached result of the size estimator for this entry. */
  bytes: number;
}

/**
 * A byte-bounded, least-recently-used cache of parsed "hot" documents,
 * keyed by 24-char hex `_id` and versioned by file offset.
 *
 * ## Why it exists
 * Reads in Pocket DB resolve an `_id` to a file offset (primary index) and then
 * decode the record at that offset. The disk read is usually served from the OS
 * page cache, so the dominant repeatable cost is **re-decoding** the same
 * document. This cache short-circuits both the read and the decode for documents
 * that are accessed repeatedly, trading memory for read latency.
 *
 * ## Keying by id, versioning by offset
 * Records are immutable at a given offset, so the offset uniquely identifies a
 * document *version*. Keying by `_id` keeps a document hot across updates (the
 * write path refreshes the entry with the new offset) and across compaction
 * (`_id` and contents are unchanged). Storing the offset alongside lets
 * {@link get} reject stale lookups: a cursor that snapshotted an older offset at
 * `find()` time will miss the newer cached entry and fall back to reading its
 * own version from disk — which is exactly the cursor-snapshot invariant the
 * rest of the engine guarantees.
 *
 * ## Ownership and cloning
 * The cache **owns** every document it stores. {@link set} takes ownership by
 * reference (callers must not mutate a document after handing it over), and
 * {@link get} returns a deep clone so callers can freely mutate query results
 * without corrupting cached state. This preserves the existing contract that
 * `find()`/`findOne()` return independent, caller-owned objects.
 *
 * ## Eviction
 * LRU ordering is maintained by a `Map`'s insertion order: {@link get} and
 * {@link set} re-insert the touched key so it becomes most-recently-used.
 * When inserting would exceed `maxBytes`, the oldest entries are dropped until
 * the new entry fits.
 *
 * ## Consistency
 * Pocket DB is single-process and writes synchronously, so there are no
 * concurrency concerns. The cache is purely in-memory and is never persisted —
 * like the secondary indexes, it starts empty and warms with traffic.
 */
export class DocumentCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly sizeOf: (document: CachedDocument) => number;

  private maxBytesValue: number;
  private bytesValue = 0;

  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: DocumentCacheOptions) {
    this.maxBytesValue = normalizeMaxBytes(options.maxBytes);
    this.sizeOf = options.sizeOf ?? estimateDocumentBytes;
  }

  /** Configured byte budget. */
  get maxBytes(): number {
    return this.maxBytesValue;
  }

  /** Approximate retained bytes currently held. */
  get bytes(): number {
    return this.bytesValue;
  }

  /** Number of documents currently resident. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Resizes the byte budget at runtime. Shrinking below the current footprint
   * evicts least-recently-used entries until the cache fits.
   *
   * @param maxBytes New byte budget (positive integer).
   */
  setMaxBytes(maxBytes: number): void {
    this.maxBytesValue = normalizeMaxBytes(maxBytes);
    this.evictToFit(0);
  }

  /**
   * Looks up a document by id, but only returns it when the caller's expected
   * `offset` matches the cached version. A mismatch (the cached entry is a newer
   * version than the caller's snapshot) is treated as a miss, leaving the newer
   * entry in place for future lookups.
   *
   * On a hit the entry is marked most-recently-used and a deep clone is
   * returned, so the caller may mutate the result freely.
   *
   * @param id     24-char lowercase hex document id.
   * @param offset File offset of the version the caller expects.
   * @returns A clone of the cached document, or `undefined` on a miss.
   */
  get(id: string, offset: number): CachedDocument | undefined {
    const entry = this.entries.get(id);

    if (entry === undefined || entry.offset !== offset) {
      this.misses += 1;
      return undefined;
    }

    // Re-insert to move this key to the most-recently-used position.
    this.entries.delete(id);
    this.entries.set(id, entry);
    this.hits += 1;

    return structuredClone(entry.document);
  }

  /**
   * Inserts or replaces the cached version of a document, marking it
   * most-recently-used, then evicts least-recently-used entries until the
   * footprint fits within `maxBytes`.
   *
   * The cache takes ownership of `document` by reference; the caller must not
   * mutate it afterwards. (The write path satisfies this: it builds a fresh
   * document per `put1` record and never exposes it directly; the read path
   * hands over a freshly decoded object.)
   *
   * A document larger than the entire budget is intentionally not cached, rather
   * than evicting everything else to hold one oversized entry.
   *
   * @param id       24-char lowercase hex document id.
   * @param offset   File offset this version lives at (its version tag).
   * @param document Parsed document to cache.
   */
  set(id: string, offset: number, document: CachedDocument): void {
    const existing = this.entries.get(id);

    if (existing !== undefined) {
      this.bytesValue -= existing.bytes;
      this.entries.delete(id);
    }

    const bytes = this.sizeOf(document);

    // An entry that cannot ever fit is dropped rather than thrashing the cache.
    if (bytes > this.maxBytesValue) {
      return;
    }

    this.evictToFit(bytes);

    this.entries.set(id, { document, offset, bytes });
    this.bytesValue += bytes;
  }

  /**
   * Removes a document from the cache, if present. Called from the delete path.
   *
   * @param id 24-char lowercase hex document id.
   * @returns `true` if an entry was removed.
   */
  invalidate(id: string): boolean {
    const entry = this.entries.get(id);

    if (entry === undefined) {
      return false;
    }

    this.bytesValue -= entry.bytes;
    this.entries.delete(id);
    return true;
  }

  /** Drops all entries and resets the byte counter (statistics are kept). */
  clear(): void {
    this.entries.clear();
    this.bytesValue = 0;
  }

  /** Resets hit/miss/eviction counters without touching cached entries. */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  /** Snapshot of the current cache statistics. */
  stats(): DocumentCacheStats {
    return {
      enabled: true,
      maxBytes: this.maxBytesValue,
      bytes: this.bytesValue,
      documentCount: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions
    };
  }

  /**
   * Evicts least-recently-used entries until `incomingBytes` more bytes would
   * fit within the budget. With `incomingBytes = 0` this simply trims the cache
   * back down to the current budget (used after {@link setMaxBytes}).
   *
   * Relies on `Map` iteration yielding keys in insertion order, so the first
   * key is always the least-recently-used.
   */
  private evictToFit(incomingBytes: number): void {
    while (this.bytesValue + incomingBytes > this.maxBytesValue && this.entries.size > 0) {
      const oldestKey = this.entries.keys().next().value as string;
      const entry = this.entries.get(oldestKey)!;
      this.bytesValue -= entry.bytes;
      this.entries.delete(oldestKey);
      this.evictions += 1;
    }
  }
}

/**
 * Validates and normalizes a byte budget: must be a positive integer.
 *
 * @throws Error when `maxBytes` is not a positive integer.
 */
function normalizeMaxBytes(maxBytes: number): number {
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) {
    throw new Error("DocumentCache maxBytes must be a positive integer.");
  }

  return maxBytes;
}
