# ADR 0002: Self-Describing Binary Record Format

## Status

Accepted (V1). Extended in V1.1 (unique-index flag on `idx1`).

## Context

Once storage is append-only (see [ADR 0001](0001-append-only-storage.md)),
every mutation becomes a discrete record in the log. That log needs a wire
format that supports several requirements at once:

- Replay must be able to read one record, know exactly where the next one
  starts, and detect corruption without a separate index or manifest file.
- Reads must be able to fetch a single document by seeking directly to a
  known offset and reading only that record's bytes — not the whole file.
- The format has to stay simple enough to hand-decode/encode without a
  schema compiler, since Pocket DB has no external dependencies for this
  layer.
- The format needs to evolve (new operation types, new index flags) without
  breaking the ability to detect old-format files.

## Decision

Adopt a self-describing, fixed-shape record envelope for every operation,
with a small set of primitives reused across all payloads:

- **Record envelope:** `[4-byte identifier][4-byte payload length][N-byte
  payload][4-byte CRC32]`. The identifier is 4 ASCII bytes (`put1`, `del1`,
  `idx1`, …) acting as both an operation tag and a per-record magic value;
  the length field makes each record self-delimiting so replay always knows
  where the next record starts; the CRC32 covers everything before itself
  and is checked on every read.
- **Big-endian integers** throughout, for consistency and because it is the
  conventional choice for on-disk formats intended to be inspected/ported.
- **4-byte payload alignment**, zero-padded, with decoders rejecting
  non-zero padding bytes. This trades a few wasted bytes per record for
  simpler, cache-friendlier offset arithmetic and matches the alignment
  assumptions of the bulk-read optimization (a single contiguous `readSync`
  across multiple candidate offsets).
- **`U29`** — a variable-length 1–4 byte unsigned integer using the same
  high-bit continuation scheme as UTF-8 — for string and JSON byte lengths
  inside payloads, so small documents don't pay a fixed 4-byte length tax.
- **A 12-byte file header** (`magic`, format major/minor version,
  serialization format byte, serialization version) that gates the whole
  file: an unrecognized magic or major-version mismatch causes `open()` to
  throw immediately, before any record is interpreted.
- **Per-file, not per-record, document serialization.** The header records
  one serialization format (JSON, BSON, or AMF3) for the entire file; all
  `put1` payloads in that file use it. Format is chosen at file creation and
  fixed for the file's lifetime.

See [file-format.md](../file-format.md) for the full byte-level layout of
every operation.

## Consequences

- Any single record can be validated (CRC) and skipped (length field)
  independently of the rest of the file — replay does not need to
  understand an operation's payload internals to skip past it, and reading
  one document never requires parsing unrelated records.
- Corruption is detected at the smallest possible granularity (one record),
  which is what makes the planned truncate-and-recover policy
  (see `storage.md`'s Corruption Policy) feasible.
- The format is intentionally low-level and hand-rolled rather than
  delegated to an existing serialization framework (protobuf, Avro, …) —
  consistent with the project's "no native dependencies, single file"
  positioning against SQLite/MongoDB-inspired but compact goals.
- Extending the format is additive-by-convention rather than
  schema-versioned per field: the V1.1 `unique` flag was added to `idx1`'s
  payload by appending a byte, which makes old-format files unreadable by
  the new decoder (not forward/backward compatible) rather than requiring a
  generic field-versioning scheme. This is an accepted tradeoff for
  simplicity — the project does not yet have a migration story for file
  format changes.
- Fixing the serialization format per file (not per record) means a running
  database can never mix JSON/BSON/AMF3 documents; switching formats
  requires creating a new file.

## Alternatives Considered

- **Length-prefixed payload without a magic identifier** — rejected: would
  make replay unable to distinguish operation types without a secondary tag
  byte anyway, and would be harder to eyeball/debug with a hex viewer.
- **Little-endian** — rejected in favor of big-endian purely as a
  convention choice; no performance difference on common architectures for
  this access pattern (reads are per-record, not vectorized).
- **JSON-lines log** (one JSON object per line, no binary envelope) —
  rejected: no CRC protection per record short of re-parsing, no O(1)
  seek-to-offset without scanning, and text encoding overhead on every
  document, which conflicts with the "read one document without touching
  the rest of the file" requirement.
