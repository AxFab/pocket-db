# Compaction

Pocket DB appends every write to the end of the file and never modifies
existing records in place. Over time the file accumulates dead records:
superseded document versions, deleted documents, dropped collections, dropped
indexes, and transaction boundary markers. Compaction rewrites the live portion
of the file in a single forward pass, then truncates the file to reclaim the
freed space.

## What compaction keeps and discards

| Operation | Kept? | Condition |
|-----------|-------|-----------|
| `ncl1` | yes | collection still exists in memory |
| `idx1` | yes | index still exists on the collection |
| `put1` | yes | offset matches the primary index entry for that document id |
| `del1` | no | always discarded — already applied during replay |
| `dco1` | no | always discarded — already applied during replay |
| `dix1` | no | always discarded — already applied during replay |
| `txnb` | no | always discarded |
| `txnc` | no | always discarded |
| `hol0` | no | always discarded — explicit no-op |
| unknown | yes | kept to avoid silently losing unrecognised data |

The key rule for `put1` records is: only the **latest committed version** of a
document is kept. Because replay always updates the primary index to point to
the last `put1` offset for a given document id, the primary index already holds
the canonical offset when compaction starts. Any `put1` record whose offset does
not match the primary index is a superseded or uncommitted version and is
discarded.

Uncommitted records — those written after a `txnb` without a closing `txnc`,
as happens when a process crashes mid-batch — are automatically excluded. Replay
ignores uncommitted operations and never registers them in the primary index, so
their `put1` and `del1` records fail the offset check and are silently dropped
by compaction.

## The forward pass

Compaction operates entirely within the existing file. It maintains two cursors:

- **`scan_head`**: the current read position, always at the start of the next
  operation record to examine.
- **`write_head`**: the current write position, always at the start of the next
  slot to fill with a kept record.

Both start at `FILE_HEADER_BYTES` (the byte immediately after the 12-byte file
header). The pass walks every record in order:

```
for each operation record at scan_head:
    if shouldKeepOperation(record):
        if write_head < scan_head:
            copy record bytes from scan_head → write_head
            if record is put1: update primary index offset to write_head
        write_head += record.byteLength
    scan_head += record.byteLength

truncate file to write_head
```

When a record is discarded, `write_head` does not advance, so it falls behind
`scan_head`. Every subsequent kept record is then copied leftward into the gap.
The file is truncated to `write_head` at the end.

### Invariant: `write_head <= scan_head`

This invariant holds throughout the pass and guarantees that a raw in-place copy
never reads from a position that has already been overwritten.

**Proof by induction.**

*Base case.* Both cursors start at `FILE_HEADER_BYTES`, so
`write_head == scan_head`.

*Inductive step.* After processing one record of byte length `B`:

- If the record is **kept**: `scan_head` and `write_head` both advance by `B`,
  preserving the gap (or equality).
- If the record is **discarded**: only `scan_head` advances by `B`, so the gap
  widens by `B`.

The gap is therefore monotonically non-decreasing, and `write_head <= scan_head`
holds at every step.

### Why no copy is needed when `write_head == scan_head`

When the gap is zero the record is already in the correct position, so the copy
is skipped. The update to `write_head` still happens so the cursor advances past
the record.

## Primary index offset update

When a `put1` record is copied to a new position, the in-memory primary index
must be updated to point to `write_head` (the destination) rather than the
original `scan_head` (the source). This update happens immediately after the
copy, before moving either cursor.

If the copy is skipped (gap is zero), the offset is unchanged and no update is
needed.

## Secondary index refresh

Secondary indexes store `{ id, offset }` candidates. After the forward pass,
the file offsets held by the primary index are correct but the secondary indexes
still reference the old offsets via their internal candidates. Rather than
tracking per-document offset changes during the pass, compaction refreshes all
secondary indexes in a single sweep after truncation:

1. Clear the contents of every secondary index (the index definitions and their
   field registrations are preserved).
2. Iterate all candidates in the primary index, which already carries the new
   offsets.
3. Read each document from disk at its new offset.
4. Re-insert the document into all secondary indexes.

This is the same operation as an index rebuild at startup, and it is correct
because the primary index is fully up to date by this point.

## Crash safety

If the process crashes during the forward pass, the file may be in a partially
compacted state:

- Some records have been copied to their new (lower) positions.
- Some original records at higher positions have not yet been overwritten.
- The file has not been truncated.

Because `write_head <= scan_head`, the original content of every kept record
still exists somewhere in the file at `scan_head` or higher. On the next open,
replay scans forward from `FILE_HEADER_BYTES`, encounters each record at its
original position, and rebuilds the primary index exactly as before. The
partially written copies at lower offsets are simply overwritten again on the
next compaction run.

No data is lost. Compaction is safe to restart from scratch after a crash.

## Idempotency

Running compaction twice on the same file produces identical output. After the
first run every remaining record is already in its final position
(`write_head == scan_head` for every kept record), so the second pass performs
no copies and the truncation point is unchanged.

## File header

The 12-byte file header is never touched by compaction. The two cursors start
immediately after it and the `truncateTo` call always targets a value of at
least `FILE_HEADER_BYTES`, so the magic and format bytes are always preserved.

## Limitations

**Active cursors.** `find()` captures a snapshot of `{ id, offset }` candidates
at call time. Compaction changes the file offsets of moved documents without
invalidating open cursors, which still hold old offsets. Callers are responsible
for ensuring no cursors are alive when compaction is called. A future version
will track active cursors and either block compaction or keep old file regions
mapped until all cursors are closed.

**Single process.** Pocket DB's `.lock` file (see
[storage.md](storage.md#concurrency)) prevents a second process from opening
the same file while the first still holds it, so compaction never runs
concurrently with another process's writes. Within one process all operations
are synchronous, so `compact()` cannot itself race with another write — the
remaining risk is the active-cursors limitation above, not cross-process
concurrency.

**No background compaction.** Compaction is a synchronous, blocking operation
that holds the file open exclusively for the duration of the pass. Automatic
background compaction is planned for V2.
