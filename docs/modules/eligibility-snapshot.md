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
- Full holder replay remains complete. A cycle with a frozen reward policy selects the top N positive non-excluded direct balances, breaking ties by normalized address. Its v2 manifest binds the complete holder snapshot, selected count, policy digest and selected/unselected/excluded balance totals. Historical cycles without a policy retain all eligible holders. Direct payout v4 plans replace the embedded snapshot with a `hookemon.reward-selection-summary.v1`; the durable eligibility stage remains the authoritative full evidence.
- Holder snapshots are bounded at 250,000 positive direct balances before top-recipient selection; this bound is separate from the 10,000-recipient direct-payout admission ceiling.
- Feasibility never shrinks the applicable holder set to fit gas or transaction limits. Selected-cycle feasibility uses the selected recipient count conservatively; historical cycles evaluate every eligible holder. Recipient and transaction admission limits remain the lower of the configured maximum and the independent 10,000-recipient implementation ceiling (`DIRECT_PAYOUT_RECIPIENT_LIMIT`). The owner selection options of 100 through 1000 are separate from these capacity limits.
- Completed manifests that exceed the journal payload limit use immutable paged stage evidence. The journal retains a content-addressed reference; reopening resolves and verifies the full manifest, including full replay evidence for selected cycles. The shared page budget covers 250,000 holder balances, two 1,000-entry reward-selection arrays, and structural headroom. Real eligibility-manifest persistence is tested at 250,000 holders; the ceiling alone does not establish persistence capacity.

## State transitions

- A caller obtains snapshot evidence only after finality selection, pinned replay, supply reconciliation, dual-source agreement, and feasibility all pass.
- `AutomatedCycleService` durably completes `eligibility-snapshot` from that evidence before it can prepare `claim-process`.
- A hash, log, source, supply, or configuration verification failure holds the cycle as `HELD_DATA_UNVERIFIED`; an exceeded envelope holds it as `HELD_UNAVAILABLE`.
- A detected stale lease is rethrown without issuing a terminal hold. The repository transition remains responsible for atomic fencing across workers.
- A held envelope refusal records block identity, holder-snapshot digest, source evidence, and feasibility summary without shortening the holder set. The hold summary does not replace the complete successful manifest.

## Operational commands

- Provide a verified depth for `robinhood-stage-finality-v1`; an absent depth is refused before any RPC read.
- Supply a content-addressed launch manifest and two genuinely independent log sources before reconciling.
- Keep measured transfer gas, gas-price ceiling, native reserve, native balance, and recipient/transaction limits current before reconciliation. Raising a configured maximum never bypasses the 10,000-recipient implementation ceiling or the native fee check.
- Run `node --test --test-name-pattern='capacity matrix' packages/adapters/test/app/eligibility-snapshot.test.mjs` for the 100, 200, 300, 400, 500 and 600-holder cases: admission through the actual gate, `completeStage` persistence that writes the paged `stage-evidence/<cycleId>/eligibility-snapshot/manifest.json`, reopen of the full manifest, and the exact `recipient-count-exceeds-configured-maximum`, `transaction-count-exceeds-configured-maximum` and `native-balance-below-reserve-and-fee(deficitWei=1)` refusals. The same file's 250,000-holder test persists and reopens full selection evidence, compiles a v4 plan without the holder snapshot, persists paged payout state, and reloads it. Repository-only fixtures do not replace these adapter-produced manifest checks. RPC logs are fixtures; these checks do not measure live payment throughput.
- The 10,000-recipient direct-payout ceiling is separate from holder-snapshot capacity: holder snapshots may contain 250,000 positive balances, while payout plans retain only the bounded selected entries and summary. `packages/adapters/test/app/payout-resume-scale.test.mjs` covers 10,000-recipient payout-state persistence.
- Ensure the production composition supplies token decimals, snapshot configuration, and both log clients. Missing values fail closed before claim processing.

## Recovery pointers

- For a changed hash, unavailable finalized head, or unstable page, discard the candidate and reconcile from a newly selected block.
- For supply or source disagreement, correct the authority record or provider evidence and run a new reconciliation; never patch entries or a digest.
- For an exceeded envelope, increase verified operating capacity and use an owner-approved
  payout-capacity/storage revision before creating a new immutable manifest. Never silently reduce an already selected set to fit capacity.
- For lease loss, let the current lease holder reconcile the cycle. Do not write a terminal state from a stale worker.

Native payout uses the frozen HKMN weights without changing token supply or exclusions. The eligibility envelope measures native gas separately; payout admission and the first signature verify that current ETH covers both attributed principal and the frozen fee envelope plus reserve.
