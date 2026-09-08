# Native ETH revision 71 proposal

This packet proposes the smallest active-release changes needed for the owner's selected native ETH cycle. It is not an approved specification, deployment, funding instruction, provider admission or transaction authorization. The current checkout's authoritative specification is unchanged.

`revision-71.patch` targets only `specs/requirements.json` at reviewed PR39 head `56f185e07dfafe5533df617ec1dad473ecb63f68` (revision 70). `proposal.json` pins its original hash, proposed result hash and 22 affected requirement IDs with rationale. `INTERFACES.md` freezes the proposed money/ABI/proof boundaries for review. `write-ownership.json` lists 117 verified existing paths and three proposed new paths across four disjoint lanes; these are available write boundaries, not instructions to modify every file or live task claims. An implementation needing another path must obtain a coordinator transfer first.

The original technical plan is `TECHNICAL-PLAN.md` in the 2026-09-08 ETH handoff packet. The owner selected native ETH, USD valuation controls and minimal change. This packet turns that scope into a reviewable diff; the coordinator must check the exact existing owner authority against the resulting hash before applying it. PR39's revision 70 interfaces and Collector anchor fixes must enter the authoritative baseline first. Do not copy its colliding receipt filenames as part of this proposal.

## What changes and why

Native ETH is currency0, so the four direction/exactness combinations replace two valid ERC20 address orderings; reversed ordering is now invalid. Fees, seed funds, process claims and holder payments carry wei. The 1000-smallest-unit minimum remains 1000 wei, while monetary policy remains USD and immutable contract claim ceilings require explicit launch-valuation-bound wei values.

ERC20 destination-balance growth is not native-payment proof: a contract recipient may forward ETH during its call. Claims instead require the successful guarded value call and trusted post-payment event. Direct payouts bind the exact signed/finalized transaction. Internal Relay return/refund receipts additionally require verified runtime, request linkage and inner-call success semantics. Rejected recipients keep their unpaid quarantine entitlement; no WETH fallback, retry/redirect feature or new custody contract is proposed.

The existing policy engine admits exact native funding amounts alongside authenticated USD valuations from the same fetched unit/aggregate quotes. USD cost basis stays fixed when committed; unresolved liquid exposure is freshly valued before additional risk, without counting existing reservations twice. Preserve 55/165/495 USD outer rails, held-position/count rules and tighter owner controls. The 250 USD test envelope counts external owner capital once, not recycled turnover.

## Preserved scope

The patch leaves `REQ-transaction-policy-1` byte-for-byte unchanged, including revision 70 Collector instruction shape, immutable anchor and original-blockhash rules. It leaves all superseded requirements and the historical `REQ-provider-binding-2`, `REQ-release-evidence-4` and `REQ-phase-boundary-1` unchanged. `proposal.json.historicalScopeMap` classifies each as HISTORICAL_SELECTED_RELEASE_EXCLUDED with nativeReleaseAuthority false. Those historical descriptions still mention excluded vault/Phase1 behavior; their presence does not authorize porting those contracts into the selected Phase3 release. This native migration is not a historical spec-cleanup project.

The selected deployed contracts and unchanged economics are documented in INTERFACES. In particular, do not substitute the historical embedded token inside HookemonIssuance.sol for the selected standalone HKMNToken.sol. Shared FeeAccounting must retain the excluded ProcessBudget adapter semantics while the active hook implements native payment.

No oracle, second policy/budget helper, USDG-to-ETH rescaling, new account, bonding curve, provider inventory model, withdrawal/rescue authority, or excluded vault family is added. No live provider value, quote, gas bound or funding amount is invented. The selected provider profile version 4.1.0 requires 20 bp gross-native fee accounting and an atomic initial buy of at least 1 USD; those conflicts require exact-model admission and do not change the inclusive 300 bp economics.

## Application and verification

After PR39 integration, compare the current specification to the pinned revision 70 hash. If it differs, reconcile the actual intervening requirement changes before approval; do not apply this patch fuzzily. Verify exact owner authority for the proposed hash, then the coordinator may apply it, synchronize the assigned architecture/module surfaces, regenerate affected projections through supported tools, and bind implementation evidence to revision 71. Contract and bot workers can inspect and prepare their disjoint interfaces now; final interface authority does not arise from this packet's existence.

Run `python3 decisions/native-eth-interface/build-proposal.py` to reconstruct the same patch/manifest from the pinned Git object, and `python3 decisions/native-eth-interface/build-ownership.py` to verify listed existing paths and lane disjointness. `verify-proposal.py` applies the patch only in a disposable directory under this proposal folder and verifies the exact output hash, requirement count/order, preserved statuses and untouched requirements. It never edits authoritative specifications or receipt state.

These are proposal integrity checks, not native implementation, compiler, fork, provider or CI results. Required implementation evidence remains the focused contract/adapter acceptance matrix in the original technical plan: pinned seed debt parity, all four swap forms and rounding, rejected/forwarding recipients, native principal/gas separation, quote valuation negatives, authenticated return proof, exactly-once restarts and unchanged Collector behavior. Final integrated CI and independent changed-money review remain required before merge.
