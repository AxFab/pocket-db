# ADR 0012: All Storage I/O Is Synchronous, No Write Queue

## Status

Accepted (V1).

## Context

Node.js `fs` exposes both synchronous (`readSync`, `writeSync`, `fstatSync`,
`fsyncSync`) and asynchronous (callback/promise-based) file I/O. An embedded
database's write path could be built on either:

- **Async I/O** would avoid blocking the event loop during a write, letting
  other work (handling other requests, timers, other I/O) proceed while a
  write is in flight. It requires a write queue or equivalent serialization
  mechanism, since concurrent async writes to the same file at
  caller-supplied offsets would race, and every public API method becomes
  `Promise`-returning.
- **Sync I/O** blocks the calling turn of the event loop for the duration of
  each `read`/`write` syscall, but every operation completes-or-throws
  within the same synchronous call, with no queue, no interleaving, and no
  `Promise` machinery anywhere in the storage layer.

Pocket DB's other foundational decisions already lean toward simplicity over
throughput: append-only writes ([ADR 0001](0001-append-only-storage.md)),
replay-rebuilt state ([ADR 0003](0003-replay-based-startup.md)), and a
single-process model enforced by a PID lock
([ADR 0010](0010-single-process-file-lock.md)).

## Decision

Build the entire storage layer on Node's synchronous `fs` API, with no write
queue and no async I/O anywhere in the write or read path:

- `FileStorage.appendOperation()` uses `writeSync` in a retry loop (to
  handle partial writes) and returns the offset synchronously — callers get
  a definite success-or-throw before the call returns, not a `Promise` to
  await.
- Reads (`readOperationAtOffset`, the bulk multi-candidate read) use
  `readSync` for the same reason: a document read completes fully within
  the calling turn.
- The in-memory `currentOffset` counter (initialized once via `fstatSync` at
  open, then maintained purely in memory) is safe to update immediately
  after a synchronous write returns, because nothing else can interleave
  and observe an intermediate state — there is no `await` point between
  reading the offset, writing the record, and advancing the counter.
- The public API (`insertOne`, `find`, `updateOne`, etc.) is consequently
  synchronous end-to-end: no method returns a `Promise`, and no caller needs
  `await` to know a write has landed.

## Consequences

- **No write queue is needed.** Because every write fully completes before
  the function that issued it returns, there is no window in which a second
  write could be issued against a stale `currentOffset` — the hazard a queue
  would normally exist to prevent simply cannot occur within one process.
  This directly enables the simple offset-counter design described in
  `storage.md`'s Write Path.
- **The execution model stays simple to reason about**: every Pocket DB call
  either has completed its effect or has thrown by the time it returns.
  There are no partial-completion states to account for in application code
  built on top of it (no "write in flight" concept to synchronize against).
- **Every write blocks the event loop** for the duration of its syscalls.
  For the target embedded use cases (desktop apps, CLI tools, local
  servers, structured caches) this is judged an acceptable tradeoff — these
  are typically not high-throughput multi-tenant servers processing
  thousands of concurrent requests where event-loop blocking would be a
  severe availability problem. A single-user Electron app or CLI tool
  rarely notices a few synchronous microseconds-to-milliseconds of file I/O
  per operation.
- **Durability options compose naturally** with synchronous I/O:
  `durability: "strict"` simply adds an `fsyncSync` call after every
  `appendOperation`, another synchronous, blocking call with the same
  complete-or-throw semantics — no separate async flush protocol was needed
  to add this option (see `storage.md`'s Durability section).
- There is no path to overlap I/O with computation within Pocket DB itself
  (e.g. prefetching the next document while decoding the current one) —
  everything is strictly sequential. This is a real ceiling on possible
  throughput that an async, queued design could in principle exceed, traded
  away for the simplicity above.
- This decision is coupled to
  [ADR 0010](0010-single-process-file-lock.md)'s single-writer-process
  model: synchronous, unqueued writes are only safe from races because
  Pocket DB assumes (and enforces via the lock file) that no other process
  is writing to the same file concurrently. Synchronous I/O does not, by
  itself, prevent *cross-process* races — that is the lock's job.

## Alternatives Considered

- **Async I/O with an internal write queue** — rejected for V1: would add a
  serialization structure (a promise chain or explicit queue) purely to
  recreate the ordering guarantee that synchronous calls provide for free
  within one process, while making every public method `async` and
  requiring `await` throughout consuming code — a meaningful API ergonomics
  cost for use cases that don't need the concurrency benefit.
- **Async I/O without a queue, relying on callers to serialize** — rejected:
  would silently reintroduce the exact race (two writes reading the same
  stale offset) that the write queue exists to prevent, but push the burden
  of avoiding it onto every consumer instead of guaranteeing it inside the
  library.
- **Worker-thread-based I/O** (offload sync calls to a worker to avoid
  blocking the main thread) — not pursued: adds message-passing overhead
  and serialization cost per operation, and reintroduces an async
  boundary (worker round-trip) at the API surface for a benefit
  (non-blocking main thread) that most of Pocket DB's target deployments
  don't need enough to justify the added complexity.
