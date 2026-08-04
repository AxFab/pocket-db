# ADR 0015: Lock-Free Readonly Sessions Coexist with a Single Writer via a Sidecar Generation Counter and Per-Record Identity Checks

## Status

Proposed.

## Context

[ADR 0010](0010-single-process-file-lock.md) enforces single-process access
with one `.lock` file: whoever holds it is the only opener, full stop —
"no multi-process concurrent access at all, not even read-only," an
explicit, deliberate V1 scope limitation. Reviewing the Snapshot /
recovery-point design surfaced a real want that bumps against that limit: a
readonly session — a second process, or a long-lived in-process handle —
that can serve reads from the live database file without taking the
exclusive lock, while a single writer keeps operating normally.

Two very different hazards hide inside "just read the file while it's being
written to":

- **Appends are close to free to read concurrently.** Once a `writeSync`
  returns, the bytes are in the OS page cache and visible to any other file
  descriptor on the same machine — there is no cross-process torn-write
  hazard for a fully-written record. The only real risk is a reader
  catching a record whose length header is written but whose payload isn't
  yet, and CRC32 already exists to catch exactly that (see [ADR
  0002](0002-binary-file-format.md)). The gap today is that a CRC mismatch
  currently makes replay "fail hard" (`docs/storage.md`'s corruption
  policy); a tailing reader needs to treat a mismatch on the *last* record
  it can see as "not written yet," not as corruption — the same leniency
  `docs/storage.md` already describes wanting for truncation recovery, just
  applied incrementally instead of once at startup.
- **Compaction (and, by the same reasoning, `restore()` from the Snapshot
  design) is not close to free.** Both rewrite or truncate the file in
  place. Compaction can relocate any live document to a different offset
  in the same pass ([ADR
  0009](0009-in-place-forward-pass-compaction.md)); `restore()` discards
  everything after a chosen point. A reader holding offsets from an earlier
  replay has no way to know, from the bytes alone, that an offset it's
  about to read no longer means what it used to mean.

This ADR is about the second hazard — coexisting safely with compaction and
restore — with the first (tailing appends) included as a smaller,
comparatively simple extension of the same mechanism.

## Decision

**A sidecar file carries one generation counter.** A new file next to the
database, e.g. `<dbPath>.gen`, holds a single 4-byte big-endian counter,
even when stable and odd while a compaction or restore is in progress. It
is intentionally not the `.lock` file: `.lock`'s lifecycle is scoped to one
writer session (created at `open()`, removed at `close()`), while the
counter must persist across writer sessions and be readable whether or not
a writer currently has the database open. It is also intentionally not
grown into the 12-byte file header — see Alternatives Considered.

**The writer's protocol is unconditional and requires no reader
awareness.** `compact()` (with or without the `backup` option from [ADR
0014](0014-clone-to-new-file.md) — the backup file never touches source
offsets, so it never needs to bump this) and `restore()` each increment the
counter once at the very start of the call and once at the very end,
regardless of whether the pass turns out to move anything. No fsync: this
counter coordinates visibility between processes on the same machine, which
the shared OS page cache already guarantees the instant a write syscall
returns — fsync is a durability-against-a-crash concern, not a visibility
one, and is irrelevant here since a crashed writer's in-flight generation
is meaningless to any reader on the next `open()` anyway. The writer never
checks the counter itself, never waits on it, and never knows or cares
whether any readonly session exists — this preserves [ADR
0010](0010-single-process-file-lock.md) and [ADR
0012](0012-synchronous-writes.md)'s "no per-write coordination cost"
posture for the writer entirely; the entire cost of this feature is paid on
the reader side.

**A readonly session opens without acquiring `.lock`,** performs the
existing bounded replay unchanged, and additionally reads the sidecar
counter, requiring it to be even before trusting that replay (retrying
until it observes an even value if it is not — a compaction was in
progress at the moment of open). It remembers that value as its own
baseline generation.

**Per-read safety does not depend on re-checking the counter around every
read.** Three signatures, all already available at effectively no extra
cost, together form a complete backstop against a read racing a
compaction:

1. **CRC32 failure** — an existing check, already run on every read —
   catches a read landing on a genuine torn mix of old and new bytes.
2. **Document identity mismatch** — new, gated to lock-free readonly
   sessions only (a normal single-writer session skips it; the offset →
   id correspondence is guaranteed by construction there, and re-checking
   it would be pure overhead for the common case). After decoding a `put1`
   record read via a candidate's expected offset, compare the record's own
   embedded `_id` to the id the candidate expected. A mismatch means the
   live document that used to be at this offset moved and something else
   has taken its place — this is the one failure CRC32 cannot see (the
   bytes are perfectly well-formed, just for a different document), and
   catching it costs nothing extra: the payload is already decoded to be
   returned to the caller.
3. **Short read / unexpected EOF** at a previously-valid offset — the
   existing `readExact` failure mode — catches an offset that no longer
   exists because `restore()` or a shrinking compaction truncated past it.

Any of these three firing is treated identically: read the sidecar
counter; if odd, wait for it to go even; if even but different from the
reader's remembered baseline, perform a full fresh replay (there is no
cheaper partial resync — compaction can relocate any live document in one
pass, so nothing short of a full re-scan can say which offsets moved) and
adopt the new value as the baseline; then retry. If the counter comes back
unchanged and still even and the read still fails, this is genuine
corruption, handled exactly as today's corruption policy already specifies
for that case. A reader *may* also check the counter proactively — e.g.
once when opening a cursor — purely as an efficiency measure, to avoid
issuing reads it already knows will fail during a compaction it's aware
of; this is an optimization, not a correctness requirement, since the
three signatures above are sufficient on their own.

**Tailing new appends is a smaller, largely separate mechanism.** Because
appends only extend the file and never invalidate an existing offset, a
readonly session can pick up new writes simply by re-running the existing
replay logic from its last-known end-of-file forward, exactly like startup
replay, just resumed from a checkpoint instead of from offset zero. The one
adjustment needed: if the record nearest the current end of file fails its
CRC check, treat that specifically as "the writer hasn't finished
appending it yet," stop before consuming it, and retry the tail on the next
trigger — the same leniency `docs/storage.md`'s planned truncation-recovery
policy already describes, applied continuously rather than once at
startup. This needs no counter involvement at all; the generation counter
exists specifically for offset-*invalidating* operations, and appends are
not one.

Unlike the generation counter, tailing is triggered by watching the main
`.pdb` file directly with `fs.watch()` (inotify/kqueue/ReadDirectoryChangesW
under the hood, depending on platform) rather than by polling alone: any
change event attempts an immediate tail-replay. This is a genuine latency
win over a fixed polling interval and is worth taking as a first-class part
of tailing, not an optional extra — the whole point of tailing is seeing
new writes promptly, and a poll-only design forces a choice between wasted
wakeups (short interval) and stale reads (long interval) that a push
notification avoids. It is paired with a periodic polling fallback
regardless (a coarse interval, e.g. on the order of seconds), because
`fs.watch()`'s reliability is not uniform across platforms and filesystems
— it can silently stop delivering events on some network filesystems and
certain container volume drivers. The fallback means a missed or absent
watch degrades tailing to bounded-latency polling rather than indefinite
silence; it is not a single point of failure for anything
correctness-related, only for how promptly new data becomes visible.

**`readOperationAtOffset` reads payload and CRC in one call instead of
two.** They are contiguous on disk (`[payload][crc32]`), so once the header
has been read (necessarily first and alone — payload length isn't known
until then), a single `readExact` of `payloadLength + OPERATION_CRC32_BYTES`
followed by an in-memory slice replaces the two separate reads. This drops
a single-document read from 3 syscalls to 2, benefits every caller (not
just lock-free readonly sessions), and keeps the identity check above
genuinely free — it operates on a payload that's already in hand either
way.

## Consequences

- **The writer's cost is flat and unconditional**: two small sidecar writes
  per `compact()`/`restore()` call, no fsync, no branching on whether
  readers exist. Negligible next to the forward pass itself, and — unlike
  the document cache's "must be zero-cost when off" bar ([ADR
  0008](0008-optional-document-cache.md)) — this doesn't need to be free,
  because `compact()`/`restore()` are already big, explicit, blocking
  operations where a couple of extra small writes don't change the
  character of the call.
- **The reader's cost is close to zero on the steady-state path.** One
  full replay and one counter read at open. Thereafter: the identity check
  is free (already-decoded data), the counter is consulted only reactively
  (on one of the three failure signatures) or optionally once per cursor,
  never per document. This is a materially smaller cost than an earlier
  version of this design that checked the counter before and after every
  individual read — that version is recorded and superseded below.
- **A resync is always a full replay, never partial.** Not a limitation
  particular to this design — compaction can move any live document in one
  pass, so there is no way to know which offsets changed without rebuilding
  from scratch, on the reader side exactly as on the writer side (see
  `refreshIndexesAfterCompaction` in [ADR
  0009](0009-in-place-forward-pass-compaction.md)/`compact.md`).
- **Multiple concurrent readonly sessions need no coordination with each
  other.** Each maintains its own remembered generation independently;
  there is nothing shared between readers beyond the one sidecar file they
  all read.
- **Old databases, or databases not yet touched by a writer that knows
  about this feature, have no sidecar file.** A writer creates it lazily —
  at the first `compact()` or `restore()` call, initialized to `0`
  (even) — so any database gains one automatically the first time it's
  compacted or restored under an updated build; no migration step is
  required. A readonly session that finds no sidecar treats that the same
  as generation `0`, stable, and simply starts maintaining its own baseline
  from there once one appears.
- **This does not deliver uninterrupted reads during an active compaction**
  — a reader that hits the in-progress window waits or retries; it is not
  served stale-but-consistent data through it. That remains a deliberate,
  accepted limitation, matching the earlier conclusion that true
  uninterrupted concurrent reads through a live compaction is a
  significantly larger undertaking (heading toward MVCC/versioned regions)
  than this ADR is scoping.
- **Tailing latency depends on `fs.watch()` support.** On common local-disk
  setups — the project's primary target (desktop, Electron, CLI, local
  server) — new writes become visible to a tailing reader promptly. On
  filesystems where `fs.watch()` is unreliable, tailing silently falls back
  to the polling interval instead of failing outright, so the worst case is
  bounded staleness, not lost updates.
- **No changes to [ADR 0010](0010-single-process-file-lock.md)'s writer
  lock protocol.** A readonly session never calls `FileLock.acquire`; the
  writer never calls anything new to check for readers. The two coexist
  because they're built to not need to know about each other, not because
  the lock model changed.

## Alternatives Considered

- **Per-read seqlock discipline: read the counter before and after every
  individual document read, retry if it changed or was odd** — this was
  the first shape of this decision and is superseded by the design above.
  It's a well-established, correct pattern in general (the Linux kernel
  uses exactly this for low-overhead reader/writer coordination), but it
  solves a more general problem than the one here: a generic reader with no
  independent notion of "current" needs to bracket every read to detect
  a concurrent change. A lock-free session here already has a specific,
  meaningful baseline — its last-synced generation — and CRC32, the new
  identity check, and existing short-read handling already catch every way
  a racing read can go wrong without needing to be told exactly when the
  race happened. Bracketing every read was strictly more coordination than
  the failure modes require.
- **Grow the 12-byte file header to carry the counter and an in-progress
  flag, instead of a sidecar file** — rejected. `FILE_HEADER_BYTES` is
  used pervasively (`readOperations`, `compact`, cursor offset math), and
  while `constants.ts` anticipates "backward-compatible additions" via a
  minor-version bump, `FileStorage.open()` does not currently branch on
  minor version for anything — an older pocket-db build opening a file
  with a grown header would silently misread the new bytes as the start of
  the first operation record and throw a confusing CRC/identifier error
  instead of a clean "unsupported version" one. A sidecar file, mirroring
  the existing `.lock` file precedent, avoids any change to the `.pdb`
  format or its version handling entirely.
- **Store the counter inside the existing `.lock` file** — considered and
  rejected: `.lock` is deleted on `close()` and re-created per writer
  session; the counter needs to survive across writer sessions and be
  readable even when no writer currently has the database open. Folding
  them together would mean the counter vanishes exactly when a reader most
  needs it to still be there.
- **Block or defer compaction while any readonly session is attached** —
  rejected, revisiting the same conclusion reached earlier when this was
  discussed generally: a cross-process reader registry needs real
  coordination beyond a lock file (shared counters, IPC), reintroducing the
  kind of complexity [ADR 0010](0010-single-process-file-lock.md)
  deliberately avoided, and it would impose a cost or constraint on the
  writer, which this design specifically keeps free of any reader
  awareness.
- **`select()`/`poll()` on the sidecar file descriptor, to avoid reading
  the counter when nothing changed** — the premise doesn't hold. POSIX
  defines `select()`/`poll()` as always reporting a regular file
  immediately ready; unlike a socket or pipe, file data isn't a readiness
  condition these calls can block on, so there is no "wait until this file
  changes" behavior to get from them here. The correct primitive is a
  filesystem watch — `inotify`/`kqueue`/`ReadDirectoryChangesW`, exposed in
  Node as `fs.watch()` — not `select()`/`poll()`. Layering a watch onto the
  generation counter specifically is safe to do regardless of how reliable
  it turns out to be: the correctness backstop (CRC, the identity check,
  EOF handling) doesn't depend on when or whether the counter gets
  checked, so a watch that silently stops firing can only cost extra
  retries, never a wrong answer. It's deferred here rather than adopted,
  though: the read it would save is already close to free (at most one
  small read per cursor open, itself optional — see Decision), while
  `fs.watch()` carries real portability risk of its own (unreliable or
  silent on some network filesystems and container volume drivers). Worth
  revisiting only if profiling a high-QPS, small-point-lookup workload
  shows this specific check is a measurable fraction of per-query cost —
  not assumed up front. The same technique is adopted, not deferred, for
  tailing (see Decision), where what it optimizes — latency until a new
  write becomes visible to a reader — is large enough on a poll-only
  design to justify the same portability trade-off, provided the polling
  fallback stays in place so a missed watch degrades gracefully instead of
  going silent.
- **Read the payload and CRC as two separate calls (status quo)** —
  replaced. They are contiguous on disk with no dependency between them
  once the header is known, so reading them together and slicing in memory
  is strictly better with no downside; kept as part of this decision
  because it's what keeps the new identity check free rather than adding a
  fourth syscall on top of what was already three.
