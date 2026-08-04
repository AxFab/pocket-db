# ADR 0014: Clone Writes the Live Data Set to a New File, as a Method Separate from `compact()`

## Status

Proposed.

## Context

[ADR 0009](0009-in-place-forward-pass-compaction.md) established compaction
as an in-place, single forward pass over the existing database file, and
explicitly rejected a new-file strategy for that use case: writing to a
temporary file and renaming it over the original doubles peak disk usage and
adds a rename step, for no correctness benefit once the in-place invariant
(`write_head <= scan_head`) is established. That ADR's Alternatives
Considered section notes, in passing, that the new-file pattern is not
rejected outright — it "is used elsewhere in the codebase for header/format
changes that can't be done in-place" — only that it is the wrong choice for
the *steady-state, reclaim-space-in-this-file* compaction path.

A different need has since come up: producing an independent copy of a
database's live data set in a second file. Motivating cases include taking a
backup without disturbing the file an application is actively writing to,
handing a point-in-time export to another process or machine, and — as a
planned future extension, not part of this decision — giving the
in-progress Snapshot/recovery-point design a way to materialize a durable
recovery point as a standalone file instead of pinning dead space inside the
live file indefinitely (a problem identified while reviewing that design:
an in-file snapshot marker prevents compaction from reclaiming anything
written before it, for as long as the marker exists).

Both compaction and cloning share the same core question — "which operation
records in this log are still live?" — answered by the existing
`shouldKeepOperation()` predicate in `database.ts`. They differ entirely in
where the answer is written: compaction overwrites the source file in place;
cloning must produce a second, independent file without touching the
source. That difference in target, not the liveness logic itself, is what
this ADR is about.

## Decision

Add `cloneToFile(destinationPath, options?)` to `Database`, implemented as a
straight sequential export rather than a variant of the in-place forward
pass:

1. Refuse if `destinationPath` already exists, unless `options.overwrite` is
   `true` — cloning must never silently clobber an existing file.
2. Create the destination via `FileStorage.open()` on the new path, passing
   the *source's* `serializationFormat` so the destination's file header
   matches the source exactly (same magic, format version, serialization
   format and version — see [file-format.md](../file-format.md)). Creating
   a file this way already writes a correct 12-byte header as a side effect
   of `FileStorage.open()`; cloning does not need its own header-writing
   logic.
3. Iterate `source.readOperations()` in order, exactly as `compact()` does
   today, and reuse `shouldKeepOperation()` unchanged. For every operation
   that predicate keeps, call `destination.appendOperation(identifier,
   payload)`.
4. `fsyncSync` the destination once after the last record is written,
   regardless of the source database's `durability` setting (see below).
5. Close the destination file descriptor. The clone is a plain, complete
   `.pdb` file at this point — opening it later goes through the normal
   `open()` → replay path like any other database file. `cloneToFile()`
   does not itself construct a `Database`/`PocketCollection` graph for the
   destination and does not create a `.lock` file for it (locking is a
   concern of `open()`, not of writing bytes to a path).

Additionally, extend `compact()` itself with an optional `{ backup:
destinationPath, overwriteBackup?: boolean }` argument, implemented as a
single forward pass shared with the existing in-place logic rather than as
two independent passes. `compact()`'s existing loop already reads each
operation exactly once (via `readOperations()`) and decides liveness once
(via `shouldKeepOperation()`); when `backup` is given, every operation that
predicate keeps is *additionally* written to a freshly created backup
`FileStorage` — `backup.appendOperation(operation.identifier,
operation.payload)` — unconditionally, in the same loop iteration as the
existing (conditional, gap-dependent) in-place copy. Because
`operation.payload` is already the parsed payload from the one
`readOperations()` call, the backup write costs nothing beyond the
`appendOperation()` call itself: there is no second bulk read, no second
CRC-verification pass, and no second decode of every `put1`/`ncl1`/`idx1`
payload to evaluate liveness — the two most expensive parts of processing a
log are paid once, not twice. `overwriteBackup` defaults to `false`,
consistent with `cloneToFile()`'s own `overwrite` default, and the
destination path is validated and created *before* the forward loop starts
— an already-existing backup path without `overwriteBackup` is rejected
before either file is touched, exactly as in the non-interleaved case.

The one guarantee this changes from a simpler sequential design (run the
backup export fully, then run the existing in-place pass) is what happens
if the backup write fails *after* the destination was successfully created
— in practice, the backup running out of disk space partway through. In a
sequential design that failure leaves the source completely untouched,
because the in-place pass hasn't started yet. In the interleaved design the
in-place pass is already underway, so such a failure can leave the source
partially rewritten: some records already moved to lower offsets,
`truncateTo()` not yet called. This is not a new or weaker safety property,
just a different one — it is exactly the state a process crash mid-`compact()`
already leaves the file in today, and [ADR
0009](0009-in-place-forward-pass-compaction.md)'s `write_head <= scan_head`
invariant already proves that state is safe: every live record's original
bytes are still intact at or above `scan_head`, and the next `compact()`
call — with or without a backup — resumes cleanly. What sequential
composition could promise ("nothing happened to the source if the backup
failed") becomes, under interleaving, "whatever happened to the source is
safe to leave as-is or finish later" — a real change, but one covered by an
invariant this codebase already relies on elsewhere, not a new risk. This is
accepted in exchange for halving the read and decode cost of the combined
operation (see Alternatives Considered).

Because the destination is always a brand-new, empty file, this does not
need the two-cursor (`scan_head`/`write_head`) machinery `compact()` needs
to prove it never overwrites data it still has to read (see
[compact.md](../compact.md)). Source and destination are different files
under different file descriptors, so plain sequential appends are
sufficient — there is no gap-tracking invariant to establish. Writing
through `appendOperation()` (re-encoding identifier + payload, recomputing
the CRC32) rather than raw-copying bytes via `readRawBytes`/`writeRawAt` is
a deliberate simplification: `compact()` needs the raw-copy path because it
writes into the middle of a file it is simultaneously still reading later
parts of; cloning has no such constraint, so the simpler, already-audited
`appendOperation()` path is preferred over reintroducing a raw-copy path
for a marginal, unmeasured speed gain. The backup sink inside the
interleaved `compact({ backup })` loop is the same kind of target — a
brand-new file receiving plain sequential appends — so it needs none of the
source's `scan_head`/`write_head` bookkeeping either, even though it is
driven from within that same loop.

## Consequences

- **The source file is never touched.** `cloneToFile()` performs no writes,
  truncation, or in-memory index mutation on the source database. This is a
  strictly weaker set of side effects than `compact()`, which has real
  consequences for callers:
  - Unlike `compact()`, `cloneToFile()` has no "no active cursors" caveat.
    Compaction is unsafe with open cursors because it moves live records to
    new offsets out from under them ([ADR
    0009](0009-in-place-forward-pass-compaction.md)); cloning changes no
    offset the source knows about, so cursors open on the source before,
    during, or after a clone remain exactly as valid as they already were.
  - `cloneToFile()` can be called at any point in a database's lifecycle
    without the scheduling concerns compaction already has to document.
- **Disk usage is the opposite trade-off from in-place compaction.**
  Compaction's whole point (per ADR 0009) is reclaiming space with no extra
  footprint; cloning's whole point is producing a second file, so it
  necessarily costs up to the full live-data size again, for the duration
  the clone is wanted. This is accepted as inherent to what cloning is for,
  not a regression relative to `compact()`.
- **The destination is always fsynced once at the end**, independent of the
  source database's `durability` option. A clone is typically taken *for*
  backup or export, where a caller reasonably expects the bytes just
  written to be durable; silently inheriting `"relaxed"` from the source
  would undermine that expectation for no benefit (a single fsync at the
  end of the whole export is cheap relative to the per-write fsync cost
  `"strict"` mode accepts elsewhere, see [ADR
  0012](0012-synchronous-writes.md)).
- **No format conversion.** The destination inherits the source's
  serialization format as-is; there is no option to clone a JSON-format
  database into a BSON-format file in the same call. Converting formats
  mid-copy would mean decoding and re-encoding every document instead of
  copying operation payloads unchanged, which is a reasonable future
  feature but orthogonal to "produce an independent copy of this data," and
  nothing in the motivating use cases needs it today.
- **`compact({ backup })` and `cloneToFile()` serve different call
  patterns, so both are kept — but they no longer share an implementation,
  only a predicate.** With the interleaved design, `compact({ backup })`
  does not call `cloneToFile()` internally; each has its own loop over
  `readOperations()`. What they still share is `shouldKeepOperation()` (the
  liveness predicate) and the trivial "write this kept operation to an
  append-only sink" action, which is worth factoring into one small shared
  helper used by both loops rather than duplicated, even though it is only
  a couple of lines. The reason to keep both methods is unchanged and does
  not depend on this: `cloneToFile()` is for "get me an independent,
  compacted copy, with no opinion about whether or when the source itself
  is compacted" — no active-cursor constraint, no forced rewrite of the
  source, usable on whatever schedule the caller wants. `compact({ backup
  })` is for "I'm about to run the in-place pass anyway, and I want a
  known-good copy of what the source held immediately beforehand, in one
  call." Dropping `cloneToFile()` would force every caller who just wants a
  copy to also accept compaction's cost and constraints on the source at
  that moment; dropping the `compact()` option would leave "compact with a
  safety copy" as a two-call pattern with no way to express "these two
  things happen together" as a single request.
- **This is a building block for the Snapshot design, not a preview of
  it.** A future bounded variant (export only the data live as of a given
  historical log offset, for a durable recovery point that does not pin
  space in the live file) will very likely reuse this same "walk kept
  operations, append to a fresh file" shape, but needs a liveness predicate
  bounded to a historical offset rather than `shouldKeepOperation()`'s
  current-primary-index check — a predicate that does not exist yet. This
  ADR intentionally ships only the unbounded "clone everything live right
  now" case; the bounded case is left to whichever ADR formalizes Snapshot
  records, to keep this decision's scope honest.

## Alternatives Considered

- **Add a `{ to: path }` option to `compact()` instead of a new method** —
  rejected. `compact()` and a new-file export have almost disjoint
  consequences: one mutates the source's file, offsets, and in-memory
  indexes and is subject to the active-cursor caveat; the other touches
  none of that. `to` names the destination without saying what happens to
  the source, so a caller could easily misread `compact({ to: "backup.pdb"
  })` as "write there *instead of* compacting in place" rather than "do
  both." A separately named method for the standalone case makes the call
  site unambiguous about which contract applies.
- **`compact({ backup: path, overwriteBackup?: boolean })` instead of `{
  to: path }`** — considered and accepted, as an *addition* to
  `cloneToFile()` rather than a replacement for it (see Decision and
  Consequences above). `backup` does not have the same ambiguity as `to`:
  it reads as "also keep a copy," which correctly implies the source is
  still compacted in place, and `overwriteBackup` is namespaced to the
  backup file specifically rather than reusing a bare `overwrite` that
  could later be misread as applying to the in-place pass itself.
- **Implement `compact({ backup })` as sequential composition — a full
  `cloneToFile()` pass, then the existing in-place pass, unchanged** — this
  was the first shape of this decision and is superseded by the interleaved
  single pass described above. Sequential composition is simpler to reason
  about (a clean "nothing happened to the source if the backup failed"
  guarantee) and was accepted initially on those grounds, but it reads and
  parses the entire log twice — one bulk read, one full record-parse-and-
  CRC-check, and one full liveness-decode of every `put1`/`ncl1`/`idx1`
  payload, per pass. That cost falls hardest on exactly the files this
  operation is meant for: large logs with a lot of accumulated dead space,
  where the second pass re-reads and re-decodes dead records for no
  purpose. The interleaved pass eliminates the duplicate read and decode
  entirely, at the cost of a weaker-but-still-sound failure guarantee (see
  Decision) — judged worth it once it was clear the weaker guarantee is
  just ADR 0009's existing crash-safety invariant applied to a new trigger,
  not a new failure mode to reason about from scratch.
- **Plain OS-level file copy (`fs.copyFileSync`/`cp`) instead of
  `cloneToFile()`** — rejected as a replacement for `cloneToFile()`,
  accepted as the right tool for a narrower need that doesn't belong in
  this library at all. A filesystem copy cannot apply the liveness filter:
  it has no access to the in-memory primary index that knows which `put1`
  records are superseded, so it can only copy whatever bytes exist,
  including all accumulated dead space — it produces a duplicate, not a
  compacted copy, which is the entire reason `cloneToFile()` exists (see
  Context). For a caller who genuinely wants neither of those things — no
  filtering, just the fastest possible point-in-time duplicate of whatever
  is currently on disk — a raw OS copy is not just adequate but likely
  better than anything built here: on filesystems with reflink/copy-on-write
  support (APFS, Btrfs, XFS with reflink) it can share disk blocks with the
  original instead of duplicating them, something `cloneToFile()`'s
  parse-and-re-encode approach can never do. That need requires no pocket-db
  API at all — the single-process file lock already rules out a concurrent
  writer racing the copy — so it is left to callers to `cp` the `.pdb` path
  directly rather than adding a redundant wrapper.
- **Raw byte copy (`readRawBytes`/`writeRawAt`) instead of
  `appendOperation()`** — considered and deferred, not rejected outright.
  Raw copying would skip re-deriving payloads and recomputing CRC32, a
  small potential speed gain, but only by reintroducing the kind of
  offset/gap bookkeeping that exists in `compact()` specifically to satisfy
  the in-place invariant — bookkeeping that has no purpose when reading and
  writing are already two independent files. If benchmarking later shows
  `appendOperation()`'s per-record overhead matters for very large clones,
  this can be revisited without changing the public API.
- **Convert serialization format during clone** — rejected for this
  decision (see Consequences); left as a distinct, separately-scoped
  feature if it turns out to be wanted.
- **Let `cloneToFile()` overwrite an existing destination by default** —
  rejected. A clone is frequently used for backup/export, where silently
  replacing an existing file is a more dangerous default than requiring an
  explicit `overwrite: true`.
