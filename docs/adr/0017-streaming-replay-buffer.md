# ADR 0017: Replay Reads the Log Through a Bounded Sliding Window, Not One Whole-File Buffer

## Status

Accepted (V1).

## Context

`FileStorage.readOperations()` — the sole mechanism `loadCollections()`
(startup replay, [ADR 0003](0003-replay-based-startup.md)),
`computeStorageStats()` (`Database.stats()`), and `compact()` walk the log
with — read the entire operation log into one `Buffer` (`readBulk()`) and
parsed every record into an in-memory `OperationRecord[]` before returning.
Peak memory during this pass was driven by file size, not by anything the
caller actually needed resident at once: every one of the three consumers
processes records with a plain `for...of` loop, one at a time, keeping no
more than small running totals or a handful of buffered transaction
operations.

Benchmarking against a real ~1.1GB database file (`benchmarks/large-scale.ts`,
run against real genealogy data) measured `open()` peaking at ~3.07GB
resident — roughly 3x the file size, from holding the raw file buffer, the
parsed array, and transient decode garbage simultaneously. On a
memory-constrained host, a ~1.9GB file's `open()` was reliably OOM-killed
outright, even though the same host had enough free memory to hold any
individual document, or even a reasonably-sized chunk of the file, comfortably.
This is exactly the class of host the project's target use cases (desktop
apps, CLI tools, Electron apps, plugins) most need to work well on.

## Decision

**`readOperations(chunkBytes = DEFAULT_REPLAY_CHUNK_BYTES)` becomes a
generator** using a sliding read window instead of one whole-file buffer:

- Maintains a `window` buffer and a `fileOffset` cursor. `fill(minBytes)`
  tops the window up from disk (in `chunkBytes`-sized reads, or more if a
  single record's length demands it) until it holds at least `minBytes`, or
  reports that end-of-file was reached first.
- Reads a record's 8-byte header to learn its payload length, ensures the
  window holds the full record, parses it with the existing
  `readOperationFromBuffer` (unchanged — see below), yields it, then advances
  past it (`window = window.subarray(recordLength)`) and repeats.
- A single record larger than `chunkBytes` still works correctly: `fill()`
  grows the window past the configured chunk size for exactly that one
  record, then the next `fill()` call (which does `Buffer.concat` on the
  small unconsumed remainder plus a fresh read) drops the oversized backing
  buffer once nothing still references it.
- Default chunk size (`DEFAULT_REPLAY_CHUNK_BYTES`, 8MiB) trades syscall
  count against peak memory: at pocket-db's typical record sizes this reads
  thousands of records per underlying `readSync`, while bounding resident
  memory to a small multiple of the chunk size regardless of file size.

**No caller changes were needed.** `readOperationFromBuffer`'s existing
contract — `identifier` and `payload` on a parsed `OperationRecord` are
independent copies via `Buffer.from(...)`, documented as remaining valid
"after the bulk buffer is discarded" — already meant records are safe to
yield from a window buffer that gets reused and overwritten on the next
`fill()`. Every consumer already iterated with `for...of` and never relied on
`.length` or random access, so a generator is a drop-in replacement for an
array in TypeScript/JavaScript's iteration protocol.

## Consequences

- **Peak memory during `open()`/`stats()`/`compact()` is now O(chunk size +
  largest single record), not O(file size).** Measured directly:
  the same ~1.1GB file that peaked at ~3.07GB resident before this change
  peaked at ~385MB after — roughly an 8x reduction — and a ~1.9GB file that
  previously OOM-killed the process on a 3.8GB-RAM host opened successfully
  afterward (peaking under 2GB).
- **This does not, by itself, make `open()` faster.** Wall-clock time is
  largely unchanged (dominated by decode cost and disk I/O either way, per
  [ADR 0003](0003-replay-based-startup.md)'s documented startup cost model) —
  this ADR is about turning "impossible on this host" into "possible," not
  about the constant factor. See [ADR
  0016](0016-bounded-candidate-range-read.md) for the change that does move
  the constant factor.
- **Transaction buffering (`txnb`/`txnc`) still holds every operation in the
  transaction in memory until `txnc`** — unchanged, and correctly so: that
  memory is bounded by how large a single application-level batch
  (`insertMany`/`updateMany`) is, which the caller controls, not by file
  size. A pathological case where a long transaction's operations happen to
  span many different underlying window chunks could pin more than one
  chunk's worth of memory (each buffered operation's payload keeps its
  originating window buffer's backing store alive via `Buffer.from`'s copy —
  though the copy itself decouples it from the window, so this is bounded by
  transaction size, not by how many window refills occurred during it, not
  by file size). This is strictly better than the previous whole-file-array
  behavior in every case, including this one.
- **`readBulk()` is removed** as part of this change (see [ADR
  0016](0016-bounded-candidate-range-read.md)) — its only remaining caller
  after `readOperations()` no longer needs it was `find()`'s bulk-read path,
  which now uses the bounded `readBulkRange()` instead.

## Alternatives Considered

- **Keep the whole-file read, rely on the OS to page unused parts out under
  memory pressure** — rejected: `readSync` into a `Buffer` populates real
  process memory (not a lazily-faulted mmap region), so there is no
  "unused parts" for the OS to reclaim without pocket-db's own cooperation;
  the measured OOM kill on the 1.9GB file is the concrete counterexample.
- **`mmap` the file instead of `readSync`** — not pursued: would let the OS
  manage residency, but requires either a native addon or an experimental
  Node API, a much larger change than the problem warranted, and still
  wouldn't bound *decode* memory (parsing every `put1` payload into a JS
  object during replay) — a small multiple of the window size, as chosen
  here, addresses the actually-measured problem directly.
- **Expose `chunkBytes` as a public `OpenOptions` field** — deferred: kept as
  an internal default with an optional parameter on the method itself
  (reachable directly in tests, which already construct `FileStorage`
  objects and cast internals where needed) rather than growing the public
  API surface for a knob nothing in the benchmarking done for this decision
  showed a need to tune per-call. Can be promoted to a public option later
  without a breaking change if a real need for tuning it surfaces.
- **Read the file in fixed-size chunks aligned to disk block size instead of
  a flat 8MiB default** — not pursued: `readSync` already goes through the
  OS's own buffered I/O layer, which handles block alignment; a fixed
  application-level chunk size well above typical block sizes gets nearly
  all the syscall-reduction benefit without needing platform-specific
  tuning.
