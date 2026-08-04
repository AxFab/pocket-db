# Architecture Decision Records

Records of significant architectural decisions in Pocket DB, why they were
made, and what they trade off against.

| ADR | Title | Status |
|-----|-------|--------|
| [0001](0001-append-only-storage.md) | Append-Only Storage, No In-Place Updates | Accepted |
| [0002](0002-binary-file-format.md) | Self-Describing Binary Record Format | Accepted |
| [0003](0003-replay-based-startup.md) | Rebuild All In-Memory State by Replaying the Log at Open | Accepted |
| [0004](0004-cursor-snapshot-semantics.md) | Cursors Snapshot Their Candidate Set at Creation | Accepted |
| [0005](0005-transaction-envelope.md) | Batch Atomicity via `txnb`/`txnc` Envelope Records | Accepted |
| [0006](0006-secondary-indexing-strategy.md) | In-Memory, Type-Specific Secondary Indexes | Accepted |
| [0007](0007-unique-constraint-check-before-append.md) | Unique Constraints Checked Before the Append | Accepted |
| [0008](0008-optional-document-cache.md) | Hot-Document Cache Is Opt-In and Zero-Cost When Disabled | Accepted |
| [0009](0009-in-place-forward-pass-compaction.md) | Compaction Rewrites the File In-Place, in a Single Forward Pass | Accepted |
| [0010](0010-single-process-file-lock.md) | Single-Writer Enforcement via a PID Lock File | Accepted |
| [0011](0011-esm-first-dual-build.md) | ESM-First Source with a Generated CommonJS Build | Accepted |
| [0012](0012-synchronous-writes.md) | All Storage I/O Is Synchronous, No Write Queue | Accepted |
| [0013](0013-mongodb-style-object-id.md) | 12-Byte ObjectId-Style Document Identifiers | Accepted |
| [0014](0014-clone-to-new-file.md) | Clone Writes the Live Data Set to a New File, Separate from `compact()` | Proposed |
| [0015](0015-lockfree-readonly-sessions.md) | Lock-Free Readonly Sessions via a Sidecar Generation Counter and Per-Record Identity Checks | Proposed |

See also the spec-level docs these ADRs reference: [storage.md](../storage.md),
[file-format.md](../file-format.md), [indexes.md](../indexes.md),
[compact.md](../compact.md), [cache.md](../cache.md), [query.md](../query.md).
