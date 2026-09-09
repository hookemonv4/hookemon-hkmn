# Eligibility Snapshot

## Purpose

The eligibility-snapshot stage freezes HKMN holder weights and a pre-claim native ETH payout-feasibility envelope. It is read-only: it never signs, broadcasts, prepares a claim, or reads historical contract state.

## Public interface

- `freezeEligibilityBeforeClaim({ adapters, config, context })` selects `latest - K` only when a fresh finalized-head read proves that candidate finalized, pins its hash, replays HKMN `Transfer` logs from two sources, and returns legacy `hookemon.eligibility-payout-manifest.v1` evidence or selection-bearing v2 evidence for a cycle with an explicit frozen reward policy.
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
- Full holder replay remains complete. A cycle with a frozen reward policy selects the top N positive non-excluded direct balances, breaking ties by normalized address. Its v2 manifest binds the complete holder snapshot, selected count, policy digest and selected/unselected/excluded balance totals. Historical cycles without a policy retain all eligible holders.
- Selected-cycle feasibility uses the selected recipient count conservatively and never shrinks selection to fit gas or transaction limits. The independent direct-payout capacity ceiling is 10,000; selected limits are 100 through 1000. Full replay must also fit its separately validated evidence storage bounds.

## State transitions

- A caller obtains snapshot evidence only after finality selection, pinned replay, supply reconciliation, dual-source agreement, and feasibility all pass.
- `AutomatedCycleService` durably completes `eligibility-snapshot` from that evidence before it can prepare `claim-process`.
- A hash, log, source, supply, or configuration verification failure holds the cycle as `HELD_DATA_UNVERIFIED`; an exceeded envelope holds it as `HELD_UNAVAILABLE`.
- A detected stale lease is rethrown without issuing a terminal hold. The repository transition remains responsible for atomic fencing across workers.
- A held envelope refusal records block identity, holder-snapshot digest, source evidence, and feasibility summary without shortening the holder set. The current bounded journal cannot persist a complete large entry array.

## Operational commands

- Provide a verified depth for `robinhood-stage-finality-v1`; an absent depth is refused before any RPC read.
- Supply a content-addressed launch manifest and two genuinely independent log sources before reconciling.
- Keep measured transfer gas, gas-price ceiling, native reserve, native balance and transaction capacity current. Store large evidence through the existing content-addressed paged-stage path; a selected count does not permit truncating full replay evidence.
- Ensure the production composition supplies token decimals, snapshot configuration, and both log clients. Missing values fail closed before claim processing.

## Recovery pointers

- For a changed hash, unavailable finalized head, or unstable page, discard the candidate and reconcile from a newly selected block.
- For supply or source disagreement, correct the authority record or provider evidence and run a new reconciliation; never patch entries or a digest.
- For an exceeded envelope, increase verified operating capacity and use an owner-approved
  payout-capacity/storage revision before creating a new immutable manifest. Never silently reduce an already selected set to fit capacity.
- For lease loss, let the current lease holder reconcile the cycle. Do not write a terminal state from a stale worker.

Native payout uses the frozen HKMN weights without changing token supply or exclusions. The eligibility envelope measures native gas separately; payout admission and the first signature verify that current ETH covers both attributed principal and the frozen fee envelope plus reserve.
