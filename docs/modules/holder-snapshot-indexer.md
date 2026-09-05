# Holder Snapshot Indexer

## Purpose

The holder-snapshot-indexer is a pure HKMN `Transfer` replay and holder-set materializer. It receives already-pinned RPC evidence and makes no network call, state query, mutation, signing request, or payout decision.

## Public interface

- `buildHolderSnapshot(input)` folds ordered Transfer tuples into `hookemon.hkmn-holder-snapshot.v1` and verifies mint minus burn against supplied immutable total supply.
- `assertHolderSnapshot(snapshot)` validates the complete holder snapshot and its content digest.
- `digestTransferLogReplay({ snapshotBlock, transferLogs })` digests the exact ordered raw tuple sequence for independent-source comparison.
- `buildEligibilityHolderSet(input)` returns typed HKMN holder entries, normalized exclusions, Transfer-log digest, and holder-snapshot digest for the pre-claim manifest.
- `toSnapshotCandidate(holderSnapshot, options)` remains the legacy per-chunk projection and retains its 1,024-entry candidate bound. It is not used to freeze eligibility.

## Invariants

- Transfer tuples must be canonical, strictly ordered by `(blockNumber, logIndex)`, and never debit more than their folded balance.
- The snapshot block hash, immutable total supply, exclusion list, and complete log sequence are explicit inputs. The module does not replace any of them with a local or live state read.
- Zero address exclusion evidence is retained, while only positive non-excluded balances become holder entries.
- Holder and exclusion arrays have no indexer-defined cardinality limit. A large holder set is retained intact for the caller's feasibility decision.
- The indexer receives and folds a complete in-memory log array. The adapter and durable stage integration must impose an approved aggregate resource envelope and persist a large manifest outside the bounded journal.

## State transitions

- Validated raw tuples become a folded balance map.
- A matching immutable supply turns the fold into a holder snapshot.
- Typed eligible entries and source digest turn that snapshot into a holder set usable by eligibility-snapshot.
- Any ordering, balance, schema, digest, or supply failure rejects the candidate without producing a partial set.

## Operational commands

- Give the indexer logs only after the adapter has pinned the target block and applied an approved aggregate resource envelope.
- Compare `digestTransferLogReplay` from independent sources before accepting the primary holder set.
- Send the full holder set to the feasibility envelope; use `toSnapshotCandidate` only after a later payout path has deliberately chunked entries.

## Recovery pointers

- Follow the [incomplete-log](../runbooks/robinhood-rpc-incomplete-logs.md),
  [reorganization](../runbooks/robinhood-rpc-reorg.md), and
  [holder-envelope](../runbooks/payout-holder-envelope.md) procedures for the corresponding
  snapshot refusal. Each recovery contract records the supported resume command or its absence.
- Re-fetch a failed range from the adapter rather than editing log tuples or balances.
- Rebuild after correcting a supply or exclusion manifest mismatch.
- Preserve all entries on an envelope refusal so an operator can distinguish capacity from missing evidence.
