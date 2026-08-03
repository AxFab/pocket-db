# ADR 0010: Single-Writer Enforcement via a PID Lock File, Not Multi-Process Coordination

## Status

Accepted (V1).

## Context

Pocket DB's storage engine assumes a single writer: the in-memory primary
index, secondary indexes, and the `currentOffset` write cursor
(`FileStorage`) are all process-local state with no cross-process
synchronization (see [ADR 0001](0001-append-only-storage.md) and
`storage.md`'s Write Path). If two processes opened the same file and both
wrote, their in-memory offset counters would diverge from the file's actual
length and each would silently corrupt the other's writes — there is no
locking at the `appendOperation()` level itself.

Something has to prevent that scenario from ever occurring, given that
Pocket DB's target deployments (CLI tools, Electron apps, local servers)
can plausibly have a user or script accidentally launch two instances
against the same database file.

## Decision

Enforce single-process access with a lock file, not a multi-writer
coordination protocol:

- `open()` calls `FileLock.acquire(dbPath)` before opening storage. The lock
  is a file at `<dbPath>.lock`, created with `openSync`'s exclusive `wx`
  flag (fails if the file already exists) and containing the acquiring
  process's PID.
- **Conflict resolution checks liveness, not just existence.** If the lock
  file already exists, Pocket DB reads the PID inside it and probes whether
  that process is still alive via `process.kill(pid, 0)` (a signal-0 check —
  no signal is actually sent, the call just validates the PID exists). A
  live conflicting process causes `open()` to throw immediately, naming the
  holding PID. A **stale** lock (the recorded PID is no longer running,
  e.g. a crashed process) is removed and acquisition retried, bounded to a
  few attempts before giving up.
- `lock.release()` unlinks the lock file; this happens in `close()` and also
  on a failed `open()` partway through, so a bad open never leaves the file
  permanently locked.
- This is the *only* concurrency control in the system. It answers "is
  another process already writing to this file" and nothing more — there is
  no shared-memory coordination, no advisory range locking, no reader/writer
  distinction. A second process is refused entry outright, whether it
  intended to read or write.

## Consequences

- The failure mode for accidental double-open is a clear, immediate
  exception naming the conflicting PID, rather than silent corruption from
  two writers racing on the same offsets — this is the primary goal, and it
  is met without needing any change to the storage layer's single-writer
  assumptions.
- Crash recovery for the lock itself is automatic: a process that dies
  without calling `close()` leaves a stale lock file, but the next `open()`
  attempt detects the dead PID via `process.kill(pid, 0)` and reclaims it.
  There is no manual "force unlock" step required from the user in the
  common case.
- **No multi-process concurrent access at all**, not even read-only. A
  second process cannot open the file for reads while a first process holds
  it, which rules out patterns like "one writer process, several read-only
  reader processes" that some embedded databases (e.g. SQLite in WAL mode)
  support. This is an explicit, accepted scope limitation — Pocket DB is
  positioned as a single-process embedded store, not a lightweight
  client/server or multi-reader system.
- The check is PID-liveness, not PID-*identity*. On systems where PIDs are
  reused quickly, a narrow race exists: the original process crashes, a new
  unrelated process is assigned the same PID before Pocket DB's stale-lock
  check runs, and the lock would be (incorrectly) treated as still held.
  This is a known, accepted limitation of PID-based liveness checks in
  general, not something Pocket DB's lock file attempts to solve (e.g. via
  a start-time+PID composite key).
- Because locking happens once at `open()` and is process-wide (not
  per-collection or per-operation), there is no per-write locking overhead
  — consistent with [ADR 0012](0012-synchronous-writes.md)'s decision that
  writes are synchronous and unqueued; the lock exists to keep *other
  processes* out, not to serialize writes within one process.

## Alternatives Considered

- **OS-level advisory file locking** (`flock`/`fcntl` locks via a native
  addon or a library) — rejected: Node's core `fs` module has no built-in
  cross-platform advisory lock primitive, and reaching for a native
  dependency conflicts with the project's minimal-dependency,
  pure-`node:fs` storage layer (see `src/native/` being reserved but empty
  in V1). A plain `wx`-flag lock file achieves the same exclusivity using
  only standard filesystem semantics available everywhere Node runs.
- **No locking at all, document the single-process requirement** —
  rejected: silent corruption from an accidental double-open (e.g. a
  restarted process, a stray second CLI invocation) is a much worse failure
  mode than a clear thrown error, and the target embedded-app scenarios
  make double-open a plausible operator mistake rather than a theoretical
  concern.
- **Multi-reader/single-writer coordination** (allow concurrent read-only
  opens) — rejected for V1: would require distinguishing read-only opens
  from writer opens in the lock protocol and reasoning about a reader
  observing a file mid-compaction or mid-write, which interacts with
  [ADR 0004](0004-cursor-snapshot-semantics.md)'s cursor-snapshot guarantees
  in ways not yet designed. Left out rather than partially solved.
