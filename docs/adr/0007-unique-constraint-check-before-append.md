# ADR 0007: Unique Constraints Are Checked Before the Append, Never After

## Status

Accepted (V1.1).

## Context

`createIndex(field, { type, unique: true })` turns a `StringIndex` or
`NumberIndex` (see [ADR 0006](0006-secondary-indexing-strategy.md)) into a
uniqueness constraint: at most one document may hold a given value for that
field. The question this decision answers is *when* that constraint is
enforced relative to the write.

In a database that supports in-place updates or transactional rollback, a
uniqueness violation can be caught after a tentative write and undone. Pocket
DB has neither: storage is strictly append-only (see
[ADR 0001](0001-append-only-storage.md)) — once a `put1` record is written
and CRC-sealed, it is durable and cannot be retracted. There is no "undo the
last write" operation anywhere in the engine.

That constraint rules out the usual "write, then validate, then
commit-or-rollback" pattern entirely. Enforcement has to happen before the
record ever reaches `appendOperation`.

## Decision

Every write path that can introduce a uniqueness conflict validates the
**fully-built document** against every `unique` index *before* calling
`appendOperation`:

- `insertOne`, `replaceOne`, and `updateOne` call
  `IndexManager.assertUnique(document, excludeId?)`, which asks each unique
  index for the id currently holding the same value (`findOwner`) and throws
  if that id belongs to a different document. `excludeId` is the document's
  own id, so `replaceOne`/`updateOne` can keep a document's own existing
  value without the check tripping on itself.
- `insertMany` and `updateMany` call `IndexManager.assertUniqueBatch(entries)`
  instead of the single-document check. In addition to validating against
  already-stored index contents, it tracks values seen earlier in the *same
  batch* — sibling documents inserted or updated together are invisible to
  each other until the whole batch is applied (see
  [ADR 0005](0005-transaction-envelope.md)), so batch-internal collisions
  would otherwise slip past a check that only looked at persisted state. A
  conflict anywhere in the batch rejects the call entirely — nothing is
  appended, not even the non-conflicting entries.
- **Type participation mirrors indexing itself.** A value only participates
  in the uniqueness check if it matches the index's own type (`StringIndex`
  only cares about strings, `NumberIndex` only about finite numbers) — the
  same rule that decides whether a value gets indexed at all. A missing
  field, or a field holding a value of a different type, never conflicts.
- **Creating a unique index over pre-existing data** is handled by the same
  principle applied retroactively: `createIndex` populates the index
  normally, then scans it for any value shared by more than one document
  (`findDuplicate`). If found, the index is torn down again — nothing is
  persisted, `existsIndex(field)` stays `false` — and the call throws. Once
  an index exists as `unique`, every later write is checked, so it can never
  drift back into conflict; the duplicate scan only ever matters for a
  brand-new index's first population.

## Consequences

- A rejected write is a true no-op: no partial state, no dangling `put1`
  record for a document that violated a constraint, no need for a
  compensating delete. This holds even for batch methods — a conflict
  anywhere in an `insertMany`/`updateMany` call means the entire batch
  writes nothing, consistent with the batch atomicity in
  [ADR 0005](0005-transaction-envelope.md).
- The cost is paid on every write to a collection with `unique` indexes:
  each insert/replace/update does an index lookup per unique index *before*
  the append, rather than an optimistic write with occasional rollback. For
  the target embedded workloads (moderate write volume, correctness over
  raw insert throughput) this is judged the right tradeoff.
- Batch uniqueness checking requires an extra in-memory "seen this batch"
  tracking structure beyond what a single-document check needs, since
  sibling documents can't consult the real index (it isn't updated until
  the whole batch commits). This is strictly a consequence of batches being
  atomic (ADR 0005) combined with append-only storage (ADR 0001) — neither
  constraint alone would require it.
- Uniqueness is enforced only for `StringIndex`/`NumberIndex` fields with
  `unique: true`; the primary index (`_id`) is implicitly unique by
  construction and does not go through this mechanism at all — ObjectId
  generation is relied upon to avoid collisions (see `file-format.md`'s
  Document Identifiers section) rather than an explicit check.
- This mechanism is pocket-db-specific and has no equivalent in the
  cross-engine benchmark suite (SQLite, lowdb, LokiJS, JSON-file) — none of
  those comparison adapters share a naturally-unique field in the benchmark
  schema, so the benchmark suite was intentionally left untouched when
  unique indexes were added.

## Alternatives Considered

- **Write optimistically, detect conflict on replay, discard the losing
  record** — rejected: would mean an invalid document is durably written to
  disk (if only transiently, until the next open), inconsistent with
  `Collection` methods being expected to throw synchronously on the actual
  call that violates the constraint. It would also make "which write wins"
  dependent on replay order in ambiguous ways, rather than rejecting the
  second writer outright at call time.
- **Soft uniqueness (log a warning, keep both documents)** — rejected:
  defeats the purpose of a uniqueness constraint; callers who ask for
  `unique: true` expect a hard guarantee enforceable at read time (e.g. "at
  most one user per email"), not an advisory hint.
- **Defer the check to compaction time (deduplicate lazily)** — rejected:
  compaction is manual and infrequent (see
  [ADR 0001](0001-append-only-storage.md)); a conflict would be visible to
  readers for an unbounded period before being resolved, which is worse
  than rejecting the write immediately, and still doesn't solve which of
  the two conflicting writes should "win."
