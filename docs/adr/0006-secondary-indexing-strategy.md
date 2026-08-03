# ADR 0006: In-Memory, Type-Specific Secondary Indexes with a "Narrow, Never Replace" Planner

## Status

Accepted (V1). Compound indexes and `$or`/`$nor` index support planned for
later versions (see Consequences).

## Context

Full collection scans are O(N) per query. Once a collection grows, callers
need a way to avoid reading every document to answer a selective query
(`{ email: "x@y.com" }`, `{ age: { $gt: 30 } }`). Supporting this requires
deciding, for V1:

- What data structures back an index, and for which value types.
- Where index contents live relative to the append-only log (see
  [ADR 0001](0001-append-only-storage.md) and
  [ADR 0003](0003-replay-based-startup.md)).
- How a query planner chooses between multiple candidate indexes, and what
  happens when no index can fully answer a query.

A general-purpose secondary index (arbitrary types, arbitrary operators,
compound fields) is a significantly larger surface than what most embedded
use cases need in practice — most queries filter on one or two scalar
fields.

## Decision

Build secondary indexes as **type-specific, single-field, in-memory**
structures, with a planner that only ever narrows candidates and never
replaces full query evaluation:

- **Two index types**: `StringIndex` (only indexes `string`-valued fields)
  and `NumberIndex` (only indexes finite `number`-valued fields — `NaN`,
  `±Infinity`, and non-numbers are silently skipped). Both are
  `Map<value, Map<id, candidate>>`; `NumberIndex` additionally maintains a
  sorted array of values for range queries via binary-search insertion.
- **Predicate coverage is deliberately partial.** `StringIndex` answers only
  `$eq`/`$in` (range predicates on strings fall through to a full scan).
  `NumberIndex` answers `$eq`, `$in`, `$gt`, `$gte`, `$lt`, `$lte`; it
  returns `null` (meaning "can't help, fall back") for `$ne`, `$nin`,
  `$not`, `$exists`. Every index method returns `null` rather than an
  incorrect or partial answer whenever it can't fully characterize a
  predicate — the planner always treats `null` as "this index does not
  apply," never as "this index found zero matches."
- **In-memory only; definitions persisted, contents are not.** `idx1`
  records persist the field name, type, and `unique` flag in the log,
  making index *definitions* durable. Index *contents* are always rebuilt
  from `put1` records during replay — there is no persisted index snapshot
  in V1 (see [ADR 0003](0003-replay-based-startup.md)).
- **Planner picks one index, by smallest candidate count.**
  `IndexManager.plan()` walks the compiled query for `FieldPredicate` nodes,
  asks every index that matches a predicate's field to `scan()` it, and
  among all non-null results picks the index whose candidate set is
  smallest. If nothing applies, it falls back to `primaryIndex.snapshot()`
  — the full scan.
- **Indexes narrow; documents always filter.** Whichever index is chosen
  (or none), the *full* compiled query is re-evaluated against every
  candidate document read from disk. An index result is a conservative
  superset, never treated as an exact answer. This is the central invariant
  of the whole system (see [indexes.md](../indexes.md)'s "Indexes Narrow,
  Documents Filter" section) and is what keeps each index implementation
  simple — it never has to prove completeness for compound or unsupported
  predicates, only avoid false negatives.
- **`fieldPredicates()` only recurses into `and` nodes.** `or`/`nor` nodes
  return no predicates, so disjunctive queries always planner-fall-back to
  a full scan today — a known, explicit limitation rather than an oversight
  (see Consequences).

## Consequences

- Adding an index type is additive: a new `QueryIndex` implementation with
  its own `scan()`/`add()`/`remove()` needs no changes to the planner or
  cursor, only registration in `IndexManager`. `NumberIndex`'s range support
  demonstrates this — it coexists with `StringIndex`'s narrower `$eq`/`$in`
  contract with no shared-interface friction.
- The planner only ever selects **one** index per query, even when multiple
  fields in an `and` predicate each have their own index. There is no
  intersection of multiple index candidate sets in V1 — the chosen index
  narrows the scan, and every other condition in the query is left entirely
  to the residual per-document filter. Compound indexes (indexing a
  combination of fields together) are explicitly deferred to V3.
- `$or`/$nor` queries never benefit from indexing in V1, even if every
  branch is individually indexable — they always fall back to a full
  primary-index scan. This is called out explicitly in the roadmap as a V2
  item ("`$or`/`$nor` index support") rather than left implicit; the
  query-evaluation semantics for `$or`/`$nor` are already fully correct,
  only planner assistance is missing.
- Because index contents are rebuilt from scratch on every open, the cost
  of having many secondary indexes on a large collection is paid at startup
  (O(N × K) — see [ADR 0003](0003-replay-based-startup.md)), not at query
  time. This is a deliberate tradeoff: query-time performance is prioritized
  over startup-time performance, on the assumption that a given process
  opens the database once and then serves many queries.
- Silently skipping non-conforming values (a number in a `StringIndex`
  field, a missing field) means an index is never wrong, only incomplete —
  callers can rely on results being correct even when a field's type is
  inconsistent across documents, at the cost of that inconsistency being
  invisible (there is no diagnostic today for "N documents were skipped by
  this index due to type mismatch").

## Alternatives Considered

- **A single generic index type handling all value types and operators** —
  rejected: would require a total ordering across mixed types inside one
  structure (similar to `compareValues` in the sort module) and a much
  larger predicate-matching surface, for a V1 whose target queries are
  simple equality/range filters on scalar fields.
- **Intersecting candidate sets across multiple applicable indexes** —
  deferred, not rejected outright: would improve selectivity for
  multi-field `and` queries where more than one field is indexed, but adds
  set-intersection logic and cost-estimation complexity that wasn't judged
  necessary before compound indexes (V3) make the single-index limitation
  more visible.
- **Always re-scan for `or`/`nor` via per-branch index lookups, unioned** —
  deferred to V2: technically feasible (each branch could independently
  consult `fieldPredicates()`), but was left out of V1 to keep the planner
  contract simple ("and-only fast path, everything else is a full scan")
  while the surrounding index infrastructure was still new.
