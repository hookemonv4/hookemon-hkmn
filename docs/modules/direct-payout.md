# Direct Payout

## Purpose

Distribute finalized native ETH returned to Operations among the frozen pre-claim HKMN holders. Preserve exact wei, immutable allocations, globally consumed predecessor dust, and recoverable recipient attempts.

## Public interface

`compileDirectPayoutPlan` creates `hookemon.direct-payout-plan.v2`; `createNativePayoutAmount` requires chain 4663, asset `native`, and eighteen decimals. Return bindings contain Operations, `assetId: native`, and the finalized evidence digest. `preparePayoutRequest`, `initializeDirectPayout`, `advanceDirectPayout`, `mutatePayout`, and `reconcileLivePayout` use the same frozen plan. Supplementary plan, source, return boundary, and payout state use v2 and preserve the original held-position eligibility snapshot.

`createCycleAttributableFinalizedAvailableReader` reloads the completed native return and its exact durable Relay leg association, native custody v3 row, and predecessor dust provenance. It returns only the attributed return plus dust, after a finalized public/archive/public native balance check. Unrelated wallet funds never increase the payout allocation. Zero attributed proceeds require no balance read.

`assertFinalizedPayoutTransferEvidence` validates persisted native payment facts and their digest for projections. `assertHistoricalFinalizedPayoutTransferEvidence` decodes historical USDG evidence without granting execution authority. Native execution requires a fresh process capability from the RPC payment producer; parsed JSON is insufficient.

## Invariants

Holder weights, exclusions, floor rounding, residual dust, and bounded in-flight windows remain frozen. Native payment sends exact value to each recipient with empty calldata. Successful finalized signed-transaction inclusion proves payment, including to forwarding contracts; token logs or recipient balance deltas cannot prove native payment.

The first signature requires current native balance covering the distributable principal, frozen maximum payout fees, and gas reserve. Each signature uses exact transaction policy, Operations identity, approved bytes, nonce fencing, and fee bounds. Nonce interference and reverted transactions preserve unsent liability.

Native custody keeps principal separate from `gasReserve`, `gasSpent`, and an append-only `gasPayments` transaction list. A freshly authenticated finalized transaction records gas before terminal recipient state. Replaying its hash preserves the total, including after a crash between those writes. A gas-only reverted-transaction capability cannot authorize a paid principal.

Historical USDG plans and money configuration never enter native execution. HKMN remains the eligibility token. USD purchase cost is not added to native principal or payout dust.

## State transitions

Recipients progress through prepared, signed, broadcast, and finalized states. Persist signed bytes and policy approval together before submission. Recovery reloads those exact bytes; replacement retains the original nonce, recipient, and value under the existing fee envelope. A finalized failed transaction becomes refused liability. Terminal payout requires conservation across finalized amounts, unresolved liabilities, and dust.

Supplementary return publication requires a current native return-proof capability bound to the persisted position return attempt. The repository reserves evidence globally; the original payout snapshot and one-use dust ownership survive restarts.

## Operational commands

Run the focused runner distribution and adapter payout, availability, custody, supplementary, and observability tests with Node 24. Production signing and submission remain separately authorized operations.

## Recovery pointers

Inspect the frozen plan, paged recipient state, wallet nonce reservation, native custody row, and gas transaction list together. Reconcile finalized RPC evidence before recovery. Never edit signed bytes, receipts, principal amounts, or proof digests to advance a stalled recipient.
