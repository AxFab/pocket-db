# ADR 0019: Torn-Tail Recovery on Open, Scoped Strictly to the Trailing Record

## Status

Accepted (V1.1).

## Context

[ADR 0001](0001-append-only-storage.md) already promises that "a torn write
at the tail is trivially detectable and truncatable," and `docs/storage.md`'s
Corruption Policy sketched an intended recovery behavior from the project's
earliest days. Until now neither was implemented: `FileStorage.readOperations()`
threw on any incomplete record — too few bytes for a header, a declared
length running past the end of the file, or a CRC32 mismatch — and
`PocketDatabase`'s constructor (`loadCollections()`) had no `try`/`catch`
around it, so the throw propagated straight out of `open()`.

Because writes are synchronous and unqueued ([ADR 0012](0012-synchronous-writes.md)),
a process that is killed (crash, `SIGKILL`, power loss) mid-`appendOperation`
leaves exactly one possible artifact behind: an incomplete or corrupt record
at the true end of the file. Everything before it is untouched, since
append-only storage never writes anywhere except the current end of file
([ADR 0001](0001-append-only-storage.md)). Before this ADR, that single torn
record made the *entire database* unopenable on the next `open()` — a crash
during an otherwise ordinary write turned into total, permanent data loss for
every document in the file, not just the one being written when the crash
happened. This is a materially worse outcome than what an append-only,
crash-oriented design is supposed to offer.

## Decision

Recover automatically from a torn trailing record, and only a torn trailing
record:

- `FileStorage.readOperations()` catches three cases at the point it is about
  to read a new record: (1) fewer bytes remain than a record header needs,
  (2) the declared payload length runs past the end of the file, or (3) the
  full declared length is present but `decodeOperationRecord` throws
  (CRC32 mismatch). In all three cases, if — and only if — this is the last
  record in the file (nothing valid follows it), the file is truncated back
  to the offset the bad record started at (`FileStorage.truncateTo()`), and
  the generator ends cleanly, exactly as if the log had always ended there.
- `FileStorage.recovered` / `FileStorage.recoveredBytes` record that this
  happened and how many bytes were discarded. `PocketDatabase` exposes the
  same as `Database.recovered` (a plain `boolean`, not part of the `stats()`
  scan — it is known instantly at `open()` time) and emits a `console.warn`
  naming the file and the byte count.
- This is deliberately **not** gated behind an opt-in option. ADR 0001
  already frames trailing-torn-write recovery as an inherent property of the
  append-only design, not a feature a caller must ask for, and case (3)'s
  reasoning below shows why a corrupt trailing record and an incomplete one
  deserve the same default treatment.
- **Case (3) is intentionally narrower than "any CRC failure."** A CRC
  mismatch on a record whose full declared length is on disk is only treated
  as a torn write when nothing valid follows it. `durability: "relaxed"`
  (the default) skips `fsync`, so a power loss can leave a trailing record's
  bytes zero-filled or only partially flushed to the underlying storage even
  though the filesystem already reports the file as long enough to contain
  it — a corrupted-looking record that is nonetheless still a torn write by
  origin. A CRC mismatch on a record that is *not* the last one in the file
  is left to throw, exactly as before this ADR: that pattern (valid records
  before *and* after a corrupt one) is a different problem — a bad sector, a
  manually edited byte, bit rot — where silently discarding the corrupt
  record risks dropping or misattributing live data in ways a pure
  tail-truncation cannot. `docs/storage.md`'s Corruption Policy tracks a
  configurable `corruption: "warn" | "fail" | "repair"` option for that
  broader case as unimplemented future work.
- Recovery runs once, on the very first `readOperations()` pass after
  `open()` (inside `PocketDatabase`'s constructor, via `loadCollections()`).
  Because that pass truncates the file the moment it finds a torn tail,
  every later `readOperations()` call in the same process — from `stats()`
  or `compact()` — runs against an already-clean file and can never trip
  this path again.

## Consequences

- A crash mid-write now costs at most the one in-flight record, matching
  what an append-only, single-writer design ([ADR 0001](0001-append-only-storage.md),
  [ADR 0010](0010-single-process-file-lock.md)) should provide. Before this
  ADR the same crash could make the whole database permanently unopenable.
- `Database.recovered` gives callers a hook to log, alert, or otherwise
  surface that a crash happened on a previous run — useful for desktop apps
  that want to tell the user their last session ended abnormally.
- The `console.warn` is unconditional and not configurable in V1.1 — there is
  no `OpenOptions` flag to silence it or to opt out of recovery entirely.
  Silencing/opt-out, if ever needed, is left for a future version alongside
  the broader `corruption` option.
- Mid-log corruption is explicitly **not** addressed by this ADR and still
  fails hard. Readers should not infer from `Database.recovered` staying
  `false` that a file has no corruption anywhere — only that no *trailing*
  torn record was found.
- No new wire-format operation, no header change, and no new `OpenOptions`
  field — this is purely a replay-time behavior change inside
  `FileStorage.readOperations()`, so it does not affect the file format
  documented in [ADR 0002](0002-binary-file-format.md) or `file-format.md`.

## Alternatives Considered

- **Gate recovery behind an `OpenOptions` flag (opt-in)** — rejected: ADR
  0001 already documents trailing-torn-write recovery as an inherent,
  expected property of an append-only log, not an optional convenience: a
  caller who did not ask for "corruption recovery" still did not consent to
  "a crash costs the whole database." Silent, unconditional recovery of
  *only* the always-safe trailing case keeps that promise without touching
  the harder, genuinely optional mid-log case.
- **Treat every CRC32 mismatch as recoverable, anywhere in the file** —
  rejected: this would risk silently discarding or misattributing live,
  valid records that happen to follow a corrupted one, trading a loud,
  honest failure for a quiet, more dangerous one. Scoping recovery to "is
  this the last record in the file" is a cheap, precise test that never
  needs to make that judgment call.
- **Full `corruption: "warn" | "fail" | "repair"` option in one pass** —
  rejected for V1.1: the trailing-record case has a single unambiguous
  correct action (truncate); the mid-log case does not (skip the record?
  fail the whole open? attempt a structural repair?) and deserves its own
  design pass rather than being bundled in here. Landing the unambiguous,
  high-value half now was judged better than blocking it on the harder half.
