# File Format

Pocket DB files are append-only operation logs.

All multi-byte integers in the current format are encoded as big-endian unless
explicitly stated otherwise.

## File Header

Every database file starts with a 12-byte file header:

```text
8 bytes   magic string "pocketdb" (ASCII)
1 byte    file format major version
1 byte    file format minor version
1 byte    serialization format ('j' = JSON, ASCII)
1 byte    serialization format version
```

The magic string is used to reject files that are not Pocket DB files. The
format major version gates breaking changes; any mismatch causes `open()` to
throw. The serialization format byte identifies the document encoding used
throughout the file; all operation payloads that embed documents use the same
format. Mixing serialization formats inside one file is not supported.

Current values:

| Field | Value |
|-------|-------|
| magic | `pocketdb` |
| format major | `0` |
| format minor | `1` |
| serialization format | `j` (0x6a) JSON — default, or `b` (0x62) BSON, or `a` (0x61) AMF3 |
| serialization version | `0` |

The format is chosen via the `serialization` option on `pocketDb()` when a
**new** file is created; it is read from the header (not re-selectable) when
opening an existing file. Whichever format is recorded, every `put1` payload
in the file is a document encoded in that format — see the encoders under
`src/storage/encoding/` for the BSON/AMF3 wire layouts, which are not detailed
byte-by-byte in this document (only the JSON case is below in "Put Document").

Operation records start at byte offset 12 (immediately after the file header).

## Operation Record

Every operation record has the same outer layout:

```text
4 bytes   operation identifier (4 ASCII bytes)
4 bytes   payload length, uint32 big-endian
N bytes   payload (padded to 4-byte alignment, length stored is padded length)
4 bytes   crc32(identifier + length_field + payload)
```

The operation identifier also acts as a per-operation magic value. The CRC32
is computed over the identifier, the length field, and the full padded payload.
A checksum mismatch causes the read to throw immediately.

Total record size: `4 + 4 + N + 4` bytes, where N is the padded payload length.

## U29

`U29` encodes an unsigned 29-bit integer in 1 to 4 bytes, using the same broad
shape as UTF-8 variable-length encoding. The high bit of each byte signals
whether more bytes follow.

| Range | Bytes used |
|-------|-----------|
| 0x00 – 0x7F | 1 |
| 0x80 – 0x3FFF | 2 |
| 0x4000 – 0x1FFFFF | 3 |
| 0x200000 – 0x1FFFFFFF | 4 |

Pocket DB uses `U29` for UTF-8 string and JSON byte lengths inside payloads.

## Operations

### `ncl1` — New Collection

```text
4 bytes   collection id
U29       collection name byte length
N bytes   collection name, UTF-8
padding   zero bytes until payload is aligned to 4 bytes
```

The collection id is a 4-byte binary identifier chosen randomly at creation
time. Collection names must be unique inside a database. A `ncl1` record is
written whenever `db.collection(name)` is called for a name not yet in the
database.

### `dco1` — Drop Collection

```text
4 bytes   collection id
```

Marks the collection and all its documents as deleted. During replay, `dco1`
removes the collection from the in-memory registry and clears its primary index.
Compaction discards all `ncl1`, `idx1`, and `put1` records that belonged to
the dropped collection.

### `idx1` — Create Index

```text
4 bytes   collection id
1 byte    index type (1 = string, 2 = number)
1 byte    unique flag (0 = false, 1 = true)
U29       field name byte length
N bytes   field name, UTF-8
padding   zero bytes until payload is aligned to 4 bytes
```

Index definitions are persisted in the log. Index contents are rebuilt in
memory when the database opens. A `idx1` record is written once per
`createIndex()` call; calling `createIndex()` again for the same field, type,
and `unique` flag is a no-op at the log level.

The `unique` flag marks the index as a uniqueness constraint: every write is
checked against it (see [indexes.md](indexes.md#unique-indexes)) before its
`put1` record is appended. This is a V1.1 addition to the `idx1` payload —
files written before it lack the byte entirely, so the format is not backward
compatible with pre-unique-index database files.

### `dix1` — Drop Index

```text
4 bytes   collection id
U29       field name byte length
N bytes   field name, UTF-8
padding   zero bytes until payload is aligned to 4 bytes
```

During replay, `dix1` removes the named index from the in-memory index manager
of its collection.

### `put1` — Put Document

```text
4 bytes    collection id
12 bytes   document id
U29        JSON document byte length
N bytes    JSON.stringify(document), UTF-8
padding    zero bytes until payload is aligned to 4 bytes
```

`put1` is used for inserts, replacements, and updates. The document is stored as
its full JSON representation. Replay updates the primary index to point to the
latest `put1` offset for each document id; earlier versions of the same document
are superseded and become dead records until the next compaction.

### `del1` — Delete Document

```text
4 bytes    collection id
12 bytes   document id
```

Replay removes the document id from the collection's primary index and all
secondary indexes. There is no padding: the payload is exactly 16 bytes and is
already 4-byte aligned.

### `txnb` — Transaction Begin

```text
empty payload
```

Starts a transaction group. Operations after `txnb` are staged during replay
until a matching `txnc` is found. Nested `txnb` inside an open transaction is
an error.

### `txnc` — Transaction Commit

```text
empty payload
```

Commits the staged transaction operations all at once. If the log ends after
`txnb` without a `txnc` (e.g. the process crashed mid-batch), the staged
operations are silently discarded during replay. `txnc` without a preceding
`txnb` is an error.

### `hol0` — Hole

```text
empty payload (or arbitrary payload)
```

A no-op placeholder. Replay skips `hol0` records entirely. Compaction discards
them. Reserved for future use: potential uses include reserving space for
in-place rewriting within a single record slot, or acting as a tombstone in
scenarios where an operation is logically cancelled before the file is
compacted.

## Document Identifiers

Document ids are 12-byte ObjectId-style values:

```text
4 bytes   unix timestamp, seconds, big-endian
5 bytes   process-random (fixed per process lifetime)
3 bytes   monotonic counter, big-endian, wraps at 0xFFFFFF
```

Exposed as 24-character lowercase hexadecimal strings.

The process-random component differentiates ids generated by different
processes; the counter differentiates ids generated within the same second by
the same process. The combination makes collisions extremely unlikely without
requiring global coordination.

## Payload Alignment

All payloads with variable-length content are zero-padded to 4-byte alignment.
The stored payload length includes the padding. Decoders verify that padding
bytes are zero and reject payloads with non-zero padding.

## Summary Table

| Identifier | Name | Payload size |
|-----------|------|-------------|
| `ncl1` | New collection | variable (aligned) |
| `dco1` | Drop collection | 4 bytes |
| `idx1` | Create index | variable (aligned) |
| `dix1` | Drop index | variable (aligned) |
| `put1` | Put document | variable (aligned) |
| `del1` | Delete document | 16 bytes |
| `txnb` | Transaction begin | 0 bytes |
| `txnc` | Transaction commit | 0 bytes |
| `hol0` | Hole | 0 bytes |
