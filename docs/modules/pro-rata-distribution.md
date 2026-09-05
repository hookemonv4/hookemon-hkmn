# Pro Rata Distribution

## Purpose

The distribution module validates the pre-claim eligibility manifest and deterministically derives direct-payout allocations. It is a calculation boundary: it never signs, broadcasts, or records a payment as paid.

## Public interface

- `createEligibilityPayoutManifest(input)` in `packages/runner/src/distribution/pro-rata.mjs`
  validates and freezes the `hookemon.eligibility-payout-manifest.v1` snapshot block and hash,
  typed supply, ordered entries, exclusions, finality, log-completeness, feasibility evidence, and
  content digests. It performs no allocation or payout action.
- `compileDirectPayoutPlan(input)` and `directPayoutPlanDigest(value)` in
  `packages/runner/src/distribution/payout-plan.mjs` derive and authenticate the Operations-wallet
  plan from the frozen manifest, finalized return, durable prior dust and its source evidence, and
  return binding.
- `createUsdgPayoutAmount({ assetId, amountAtomic })` creates the typed USDG amount used by the
  plan. It canonicalizes the deployed token address and fixes chain ID 4663 with six decimals.
- `computeProRataDistribution(input)`, `computeProRataDistributionFromSnapshot(...)`,
  `chunkProRataEntries(entries, options)`, and `toHolderCandidateInput(...)` remain compatibility
  utilities for commitment consumers. Direct ERC-20 payouts use `compileDirectPayoutPlan()`.
- The direct plan contains stable ordered recipients, typed HKMN weights and USDG allocations,
  totals, dust, feasibility evidence, the finalized-return binding, and one plan digest.

## Invariants

- Allocation inputs are frozen before the Operations process claim and remain tied to the exact cycle and asset.
- The manifest persists the snapshot block and hash separately. Its v1 finality object contains the
  policy ID and depth; adding a finalized-head identity requires an additive schema revision.
- The direct plan accepts only same-cycle `hookemon.eligibility-payout-manifest.v1` evidence.
  Non-excluded entries define payout weight, and excluded addresses cannot reappear as recipients.
- Every USDG amount uses `{chainId:4663, assetId:<canonical USDG contract address>, decimals:6,
  amountAtomic}`. The address is the `returnBinding.usdgAddress` frozen with the finalized return.
  HKMN balances and `totalEligibleHkmn` retain the asset identity and decimal precision frozen with
  the supply.
- Direct allocations use integer floor rounding. Residual units remain in `dust`; they are not
  redistributed by address or remainder.
- Durable prior dust joins the next distributable pool. Total allocations plus recorded dust equal
  that pool exactly, including when every payable holder has a nonzero floor allocation.
- `previousDustSource` is `null` exactly when `previousDust.amountAtomic` is zero. Otherwise it is
  `{cycleId, digest, planDigest}` for the consumed dust record. The complete source object is part
  of the unsigned plan digest, so a repository can bind its one-time consumption to this plan.
- The direct plan accepts at most 1,025 frozen recipients. This is a compilation limit, not a
  production storage guarantee: the current cycle journal rejects persisted arrays above 64 items.
  Eligibility feasibility has the same unresolved mismatch until a storage or owner-approved
  capacity revision aligns the limits.
- Compilation never signs, broadcasts, marks a recipient paid, redirects an allocation, or changes
  a CycleRepository custody bucket.

## State transitions

- A finalized pre-claim manifest, finalized cycle return, and prior-dust record produce one immutable
  plan digest bound to the Operations recipient, canonical USDG contract address, return-evidence digest,
  and prior-dust source when dust exists.
- `createDirectPayoutState()` creates ordered `PREPARED` recipient records. Each recipient then moves
  through nonce reservation, `SIGNED`, `BROADCAST`, and `FINALIZED`, or enters a custody-backed
  `REFUSED` state when USDG reports the recipient frozen or a finalized transfer reverts.
- The first broadcast freezes the plan. Fee-bumped replacement bytes must retain the Operations
  sender, recipient calldata, chain, and nonce, and earlier same-nonce attempts remain reconcilable.

## Operational commands

- Run `node --test --test-timeout=120000 packages/runner/test/distribution/payout-plan.test.mjs` for
  floor-and-carry, canonical USDG identity, 1,025-recipient capacity, holder-envelope, dust,
  exclusions, and randomized conservation checks.
- Run `node --test --test-timeout=120000 packages/adapters/test/app/stages-payout.test.mjs` for
  durable recipient boundaries, signer policy, frozen-recipient quarantine, nonce interference,
  replacement, restart, and finalized-transfer reconciliation.
- Keep the compatibility helpers and the direct plan on the same floor-and-carry conservation rule.
  Their chunking limits still belong only to commitment consumers.
- Regenerate the module index at the coordinator checkpoint after this card changes; do not edit it concurrently.

## Recovery pointers

- Rebuild a candidate only from the same frozen manifest, finalized return evidence, and durable
  prior-dust record with its source cycle and digests. A digest mismatch is a failed verification,
  not a reason to edit allocations.
- If feasibility, eligibility, asset identity, or conservation fails, return to snapshot or return reconciliation before any signing boundary.
- Recover from persisted raw signed bytes and reconcile every current or replacement transaction
  before signing again. Keep quarantined liabilities separate from finalized payments.
- The built-in stage driver persists the complete direct-payout state only within the journal's
  64-item array limit. Do not admit a larger holder set in live production until recipient-keyed or
  paged storage is approved and implemented. Do not substitute the generic chain-attempt record
  for policy-approval recovery until its schema has the required approval fields.
