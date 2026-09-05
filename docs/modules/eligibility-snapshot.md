# Eligibility Snapshot

## Purpose

The eligibility-snapshot stage freezes HKMN holder weights and a pre-claim payout-feasibility envelope. It is read-only: it never signs, broadcasts, prepares a claim, or reads historical contract state.

## Public interface

- `freezeEligibilityBeforeClaim({ adapters, config, context })` selects `latest - K` only when a fresh finalized-head read proves that candidate finalized, pins its hash, replays HKMN `Transfer` logs from two sources, and returns `hookemon.eligibility-payout-manifest.v1` evidence.
- `reconcileLiveEligibilitySnapshot(...)` runs the same flow. On verification failure it rechecks the supplied lease before it records `HELD_DATA_UNVERIFIED` or `HELD_UNAVAILABLE` through `cycleRepository.holdCycle()` and then rethrows.
- `evaluatePayoutFeasibility({ entries, feasibility })` calculates recipient and transaction counts,
  maximum native fee, reserve, required native amount, the current plan-limit check, and the
  pass/fail reason.
- `probeEligibilitySnapshot(...)` reports configuration presence and does not call an RPC endpoint.

The built-in stage driver invokes live snapshot reconciliation directly and returns its canonical evidence to `AutomatedCycleService`. It never creates a provider-mutation attempt for this stage; `execute()` rejects it as read-only.

The runtime configuration requires `chainId`, `hkmn.{address,deployBlock,decimals}`, and `eligibilitySnapshot`. The latter includes `finality.{policyId:"robinhood-stage-finality-v1",depth}`, a launch manifest plus its matching `launchManifestDigest`, bounded log-page settings, feasibility inputs, and distinct nonempty primary and secondary source IDs. `adapters.robinhood.client` and `adapters.robinhood.secondaryLogClient` are both required and must be different client objects.

## Invariants

- `K` is required. The policy identifier alone does not supply a depth.
- The candidate is rejected if it is newer than the fresh finalized head. Its hash is checked before the scan, across every page, and after both source checks.
- The RPC selector returns finalized-head identity, but the current v1 manifest persists only policy ID and depth. Downstream payout eligibility needs an additive manifest proof before it can rely on that identity.
- Both replays cover every page from the configured deployment block through the selected block. Each must produce the exact ordered Transfer-tuple digest, and the primary replay must reconcile mint minus burn to typed immutable launch supply.
- The stage only emits `dual-source` completeness evidence. Source IDs distinguish configured clients but do not themselves authenticate provider provenance; a frozen provider-authority binding is required before that provenance can be treated as independent.
- The excluded set comes only from the launch manifest and role history. Unlisted contract recipients remain eligible at their own addresses.
- A holder set is never shortened to fit a recipient limit. The feasibility envelope decides whether the cycle is held before claim processing.
- The current recipient and transaction check is the lower of the configured maximum and the
  1,025 plan limit. It is not yet an executable capacity check: the journal's 64-item array bound
  rejects a persisted eligibility manifest and direct-payout state above 64 holders. A storage or
  owner-approved capacity revision must align these limits before a live claim can rely on this
  gate.

## State transitions

- A caller obtains snapshot evidence only after finality selection, pinned replay, supply reconciliation, dual-source agreement, and feasibility all pass.
- `AutomatedCycleService` durably completes `eligibility-snapshot` from that evidence before it can prepare `claim-process`.
- A hash, log, source, supply, or configuration verification failure holds the cycle as `HELD_DATA_UNVERIFIED`; an exceeded envelope holds it as `HELD_UNAVAILABLE`.
- A detected stale lease is rethrown without issuing a terminal hold. The repository transition remains responsible for atomic fencing across workers.
- A held envelope refusal records block identity, holder-snapshot digest, source evidence, and feasibility summary without shortening the holder set. The current bounded journal cannot persist a complete large entry array.

## Operational commands

- Provide a verified depth for `robinhood-stage-finality-v1`; an absent depth is refused before any RPC read.
- Supply a content-addressed launch manifest and two genuinely independent log sources before reconciling.
- Keep measured transfer gas, gas-price ceiling, native reserve, native balance, and
  recipient/transaction limits current before reconciliation. Values above 1,025 do not increase
  the plan limit, and no value above 64 is currently persistence-safe for production.
- Do not configure a feasible large holder set until durable content-addressed manifest storage is available for the full entry array.
- Ensure the production composition supplies token decimals, snapshot configuration, and both log clients. Missing values fail closed before claim processing.

## Recovery pointers

- For a changed hash, unavailable finalized head, or unstable page, discard the candidate and reconcile from a newly selected block.
- For supply or source disagreement, correct the authority record or provider evidence and run a new reconciliation; never patch entries or a digest.
- For an exceeded envelope, increase verified operating capacity and use an owner-approved
  payout-capacity/storage revision before creating a new immutable manifest. Never shorten the
  holder set to fit the current limit.
- For lease loss, let the current lease holder reconcile the cycle. Do not write a terminal state from a stale worker.
