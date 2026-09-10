# Direct Payout

## Purpose

Distribute finalized native ETH returned to Operations among the frozen pre-claim HKMN holders. Preserve exact wei, immutable allocations, globally consumed predecessor dust, and recoverable recipient attempts.

## Public interface

`compileDirectPayoutPlan` creates `hookemon.direct-payout-plan.v2` for historical all-holder cycles, v3 remains the legacy selected-cycle plan with full selection evidence, and v4 is the current selected-cycle plan with a validated `hookemon.reward-selection-summary.v1` instead of the 250,000-entry holder snapshot. `createNativePayoutAmount` requires chain 4663, asset `native`, and eighteen decimals. Return bindings contain Operations, `assetId: native`, and the finalized evidence digest. `preparePayoutRequest`, `initializeDirectPayout`, `advanceDirectPayout`, `mutatePayout`, and `reconcileLivePayout` use the same frozen plan. Supplementary plans use v2, legacy v3, or current v4 in parallel. Source, return boundary, and payout state retain their native contracts.

`createCycleAttributableFinalizedAvailableReader` reloads the completed native return and its exact durable Relay leg association, native custody v3 row, and predecessor dust provenance. It returns only the attributed return plus dust, after a finalized public/archive/public native balance check. Unrelated wallet funds never increase the payout allocation. Zero attributed proceeds require no balance read.

`assertFinalizedPayoutTransferEvidence` validates persisted native payment facts and their digest for projections. `assertHistoricalFinalizedPayoutTransferEvidence` decodes historical USDG evidence without granting execution authority. Native execution requires a fresh process capability from the RPC payment producer; parsed JSON is insufficient.

## Invariants

Holder weights, exclusions, floor rounding, residual dust, and bounded in-flight windows remain frozen. Selected manifests validate the complete holder snapshot digest, supply reconciliation, frozen cycle policy, and deterministic balance-ranked top N before computing liabilities. Only selected balances enter the payout denominator. Selected holders with zero-rounded allocations remain selected and receive no transfer. The plan digest binds the entire selection evidence; historical v2 serialization remains unchanged. Native payment sends exact value to each recipient with empty calldata. Successful finalized signed-transaction inclusion proves payment, including to forwarding contracts; token logs or recipient balance deltas cannot prove native payment.

Admission requires current native balance covering the distributable principal, frozen maximum payout fees, and gas reserve before consuming dust or persisting recipient state. The first signature rechecks the same combined requirement. Each signature uses exact transaction policy, Operations identity, approved bytes, nonce fencing, and fee bounds. Nonce interference and reverted transactions preserve unsent liability.

Native custody keeps principal separate from `gasReserve`, `gasSpent`, and an append-only `gasPayments` transaction list. A freshly authenticated finalized transaction records gas before terminal recipient state. Replaying its hash preserves the total, including after a crash between those writes. A gas-only reverted-transaction capability cannot authorize a paid principal.

Historical USDG plans and money configuration never enter native execution. HKMN remains the eligibility token. USD purchase cost is not added to native principal or payout dust. For v4, payout request preparation recompiles the plan from the full durable eligibility-stage evidence and requires the resulting plan and selection-summary digests to match the persisted plan; the compact summary is not an authority replacement.

## State transitions

Recipients progress through prepared, signed, broadcast, and finalized states. Persist signed bytes and policy approval together before submission. Recovery reloads those exact bytes; replacement retains the original nonce, recipient, and value under the existing fee envelope. A finalized failed transaction becomes refused liability. Terminal payout requires conservation across finalized amounts, unresolved liabilities, and dust.

Supplementary return publication requires a current native return-proof capability bound to the persisted position return attempt. The repository reserves evidence globally; the original payout snapshot and one-use dust ownership survive restarts.

## Operational commands

Run the focused runner distribution and adapter payout, availability, custody, supplementary, and observability tests with Node 24. Production signing and submission remain separately authorized operations.

## Recovery pointers

Inspect the frozen plan, paged recipient state, wallet nonce reservation, native custody row, and gas transaction list together. Reconcile finalized RPC evidence before recovery. Never edit signed bytes, receipts, principal amounts, or proof digests to advance a stalled recipient.

Recovery pointers: [rejected recipient](../runbooks/payout-recipient-frozen.md), [holder envelope](../runbooks/payout-holder-envelope.md), [nonce interference](../runbooks/evm-nonce-interference.md), and [ambiguous transaction](../runbooks/evm-transaction-ambiguity.md).

Supplementary payout initialization requires an independently read canonical native balance before persisting recipient state. The balance must cover the distributable principal still unpaid, maximum gas for unresolved recipients, and the fixed native reserve. Finalized principal and completed transaction gas are not charged again on resume; dust and quarantined principal remain reserved. Missing or malformed balance evidence refuses before persistence or signing. A fully terminal recipient set needs no new spending admission.

## Recipient capacity verification

The focused scale matrix covers 100, 200, 300, 400, 500 and 600 recipients. It checks complete allocation, unique recipients, principal-plus-dust conservation, prepared and synthetic finalized payout states through the actual paged store, and rejection of insufficient recipient, transaction or fee envelopes. Synthetic finality validates state shape and persistence; it is not evidence of on-chain payments or live throughput.

Run `node --test --test-name-pattern='(?:100|200|300|400|500|600) recipients' packages/adapters/test/app/payout-resume-scale.test.mjs` with the locked adapter dependencies installed. The recipient count is derived from the full eligible snapshot. A configured maximum does not choose a fixed number of recipients, and the owner dashboard does not expose this maximum as a setting.

Supplementary payout recovery rebuilds a persisted v3 plan from the original frozen eligibility and return boundary using its original schema. Envelope and plan commitments must still match before any recipient advances; signed bytes, nonces and completed payments survive restart without signing again. New selection-based plans use v4.
