# Hookemon Product Requirements

> "Phase 1", "Phase 2", and "Phase 3" in this document always mean Product Phase 1/2/3 — the delivery scopes — not the v4 process phases (spec, architecture, feasibility, redteam, tasks, build, ship), which chain automatically per AGENTS.md.

## Intent

**Thesis:** Hookemon uses a small immutable Programmable-compatible Robinhood Chain hook to collect the approved USDG trading-fee policy and enforce fully funded USDG payments to HKMN holders.

**User:** A community member who buys and holds HKMN in the canonical USDG/HKMN market.

**Why now:** The project must prove the complete money path with a working coin, one real pack cycle, holder payments, and final reconciliation before investing in broader automation or product surfaces.

**Success metric:** Phase 1 completes one inspectable loop: HKMN purchase, exact fee split, process-budget release, one fixed outbound route, one real pack purchase, open and buyback, one fixed return route, actual net-USDG return, sum-bound payout funding, one or more holder payments, and final reconciliation.

**Binding constraint:** The production token and hook are non-upgradeable. Reversible marketplace, runner, and distribution code remains offchain; dashboard and UI are deferred to Phase 2.

**Out of scope:** Public or operator dashboard, OpenUI or any other UI, timed scheduling, continuous or unattended operation, catalog persistence, autonomous custody, route optimization, multiple pack strategies, holder ranking, LP weighting, recipient replacement, batch-specific settlement state, pause controls, surplus recovery, governance, advanced analytics, support products, and mobile product polish.

There is no long-term runway requirement. Phase 1 proves technical operation, not market demand or a multi-year business model.

## Authority

This document is a clean-room restatement of current owner decisions. It is not derived from historical contracts, deployment files, submissions, evidence bundles, provider handoffs, or website copy.

The exact approval tokens and their bounded scope are recorded in [OWNER_DECISIONS.md](OWNER_DECISIONS.md).

The authority order is:

1. explicit current owner decisions;
2. official, versioned Programmable, Robinhood, USDG, Solana, Circle USD Coin, and Collector Crypt evidence;
3. requirements, ADRs, interfaces, tests, and receipts derived from those sources; and
4. isolated historical code study only after a current requirement already exists.

Historical code may suggest a test or implementation technique. It cannot establish intended behavior, an address, an ABI, a dependency, a fee, a role, or release readiness.

## Proposed Phase 1 baseline

The following baseline implements the owner-approved thin-V1 direction and becomes normative only after exact PRD and requirements approval:

- dedicated Programmable Launchpad on Robinhood Chain ID `4663`;
- one desired canonical USDG/HKMN market;
- inclusive fee policy of 3.00% of executed USDG quote volume:
  - 0.10% Programmable liability;
  - 0.40% treasury liability; and
  - 2.50% process-budget liability, including deterministic rounding dust;
- immutable HKMN issuance, one non-upgradeable fee-and-payout hook, and its immutable hook-bound `PegCycleVault`;
- one operator-triggered fixed Collector Crypt Solana-mainnet USD Coin pack-and-buyback path;
- actual net USDG, rather than estimated or gross proceeds, funds holders;
- one immediate permissionless holder-payment path used by both the worker and holders;
- final contract, receipt, manifest, and entitlement reconciliation; and
- dashboard, UI, scheduling, continuous operation, catalog persistence, route optimization, and multi-pack capabilities delivered only under a fresh Phase 2 specification.

Provider-independent accounting and payout work may proceed before final integration. Provider-dependent behavior fails closed until official bindings exist. Signing, broadcast, launch, marketplace actions, and spending require separate exact authorization.

## Integration binding status

| Binding | Required state | Current state |
| --- | --- | --- |
| Robinhood target chain | Chain ID `4663` and official genesis/RPC evidence | `INTEGRATION_PENDING` |
| Robinhood USDG | Official address, decimals, proxy behavior, and runtime hashes | `INTEGRATION_PENDING` |
| Programmable Robinhood V4 | Live Launchpad, admission, callback, fee, and custody interfaces | `INTEGRATION_PENDING`; officially planned but not deployed at the latest verified observation |
| Uniswap v4 | PoolManager, router, hook permissions, PoolKey, callback semantics, and limits | `INTEGRATION_PENDING` |
| Collector Crypt Solana | Production API host and authentication boundary, exact pack, Circle USD Coin mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` with six decimals, generated transaction allowlist, purchase, opening, standard buyback, fee, idempotency, and settlement behavior | API shape and canonical mint observed; exact release snapshot and pack binding `INTEGRATION_PENDING` |
| Cross-chain conversion | One exact outbound Robinhood-USDG-to-Solana-USD Coin route and one exact return route, including providers, programs or contracts, assets, destinations, quotes, minimum receives, deadlines, and finality | `INTEGRATION_PENDING` |
| Treasury and Operations | Exact owner-approved addresses, custody controls, recovery procedure, and two-step successor behavior without a required wallet implementation | Deployment selection pending; Operations is trigger-only for peg cycles |

No address, ABI, version, code hash, or behavior from a previous-chain implementation may satisfy a Robinhood binding.

## Product behavior

### HKMN issuance

- Name: Hookemon.
- Symbol: HKMN.
- Fixed total supply: `420,690,000,000 HKMN` adjusted for the officially bound decimals.
- HKMN is created once through the officially bound Programmable Launchpad mechanism.
- Decimals are `18` when supported; otherwise the mechanism's mandatory canonical value requires explicit compatibility evidence.
- Initial allocation is 90% to the canonical market and 10% to an officially supported treasury lock or vesting mechanism. If no such mechanism exists, the 10% remains outside treasury control and circulation through an officially evidenced undistributed state.
- The launch position representing the 90% canonical-market allocation is permanently held outside project control. No deployer, treasury, Operations, worker, or other caller can transfer it, decrease its liquidity, withdraw its principal, collect value to an arbitrary project destination, rescue it, upgrade it, or appoint a successor controller.
- HKMN has no later mint, blacklist, confiscation, proxy upgrade, delegatecall replacement, or hidden transfer tax.
- Wallet-to-wallet HKMN transfers do not create Hookemon fee liability.

### Canonical purchase and market

- Exactly one complete PoolKey at the officially bound PoolManager is canonical.
- The canonical PoolKey uses a zero static LP fee. The approved inclusive 3.00% Hookemon hook fee is the only trading fee on the canonical route. No protocol, router, provider, integrator, token-transfer, or other surcharge may supplement it; network gas is separate.
- Only supported finalized swaps in that market create Hookemon liabilities.
- Currency ordering derives from final token addresses.
- A supported canonical buy credits the buyer with the exact HKMN output produced by the bound PoolManager semantics.
- Foreign pools and failed, unsupported, or zero-output operations create no Hookemon liability.
- Permanent custody of the launch position never freezes user HKMN, blocks a supported buy or sell, or creates a second fee.

### Exact fee accounting

For executed USDG quote volume `Q`:

- `totalFee = floor(Q * 300 / 10,000)`;
- `programmableLiability = floor(Q * 10 / 10,000)`;
- `treasuryLiability = floor(Q * 40 / 10,000)`; and
- `processLiability = totalFee - programmableLiability - treasuryLiability`.

The immutable calculation is `totalFee = floor(Q * 300 / 10,000)`, `programmableLiability = floor(Q * 10 / 10,000)`, `treasuryLiability = floor(Q * 40 / 10,000)`, and the exact remaining process liability.

The process share receives only the rounding remainder needed for exact conservation. Actual USDG collected must equal the sum of the three liability increases.

Programmable, each historical treasury beneficiary, process budget, and every payout remain isolated liabilities. Every external USDG path uses one global reentrancy boundary, verifies exact balance deltas, and preserves post-call solvency.

### Process release

- The current Operations account chooses a unique cycle identifier and positive release amount.
- A release cannot exceed accrued process liability.
- A successful release transfers the exact amount only while atomically funding the cycle's immutable return escrow under the hook-bound `PegCycleVault` coordinator.
- A cycle identifier is permanently single-use.
- The hook stores the cycle identifier, amount, vault binding, and Operations trigger identity; event block data provides release timing.
- The hook contains no process cap, policy registry, specification hash, pack setting, scheduler, or arbitrary release destination.
- A rejected release does not stop trading, fee accrual, fee claims, payout funding, or holder payments.

Operations is a trigger only and never a process principal, external-route, return-proceeds, or payout-funding custodian. Its two-step rotation affects a future unopened-cycle trigger only. It never redirects vault principal or returned USDG.

Before any external purchase, the offchain cycle record binds requirements revision 57, the hook and vault identities, the cycle identifier, current Operations trigger, released amount, total principal and spend cap, per-chain native-gas caps, exact external binding-manifest digest, exact outbound route and request digests, the deterministic cycle-specific return escrow, and one owner authorization. The external binding manifest is the single source for the Solana, Circle USD Coin, Collector, execution-wallet, pack, and outbound and return conversion fields described below.

### One fixed pack cycle

- The first runner supports one configured Collector Crypt production path on Solana mainnet using canonical Solana USD Coin. It does not use the Base EVM path.
- It uses exactly one standard non-turbo pack. The approved Solana execution wallet is the player, NFT recipient, and buyback-USD Coin recipient; alternate recipients and YOLO batches are disabled.
- The selected public pack code, live price, machine status, stock, and buyback percentage are captured from the pinned production API snapshot before execution.
- It is operator-triggered and may use operator-assisted steps.
- V1 does not discover routes, obtain autonomous quotes, or implement a generic conversion-provider adapter. The operator executes the two frozen, separately authorized conversions; the runner verifies binding metadata, finalized receipts, exact balance deltas, and the final attributable USDG credit.
- Every conversion, external API mutation, signature, broadcast, or spend pauses for its separately required authorization.
- Before every external mutation, the runner durably records the authorized intent and exact canonical request fields and digest without secret material. It chains the response digest, provider partial-signature set, memo, decoded transaction-message digest, recent blockhash and last-valid height, owner authorization, exact signed-bytes digest, broadcast signature, and independently verified final state before advancing.
- The generate request record binds player address, pack code, quantity one, non-turbo mode, and absent alternate recipients. After purchase, pack status must reproduce the same wallet, pack code, mode, memo, and fixed token mint, and the awarded NFT must finalize at the approved wallet.
- After opening, a separate owner authorization binds the exact NFT mint, current onchain owner, original Collector prize-wallet destination, fixed USD Coin mint and token account, absent alternate recipient, API refund amount, and owner minimum receive in base units. Every generated purchase or buyback transaction is independently decoded before signing. The runner rejects an unexpected cluster, mint, program, instruction, account, recipient, debit, signer, fee payer, memo, or amount.
- One purchase signature verified as finalized through an independently bound Solana RPC and its memo precede one idempotent pack open. The awarded NFT must reach the approved wallet before a standard buyback is built, signed, broadcast, and independently verified as finalized within the official eligibility window.
- Uncertain external state is reconciled before retry; the runner never blindly repeats a purchase or sale.
- Every purchase, buyback, outbound conversion, and return receipt has one globally unique consumption key. A restart reconciles RPC and API state and cannot generate or sign a replacement action while a prior intent, memo, transaction message, signature, or broadcast cannot be proven absent or terminal.
- A rejected, timed-out, duplicate, ambiguous, wrong-chain, wrong-asset, altered-transaction, expired, ineligible, pending, or unsold result cannot be labeled a completed positive-proceeds cycle.
- Only actual realized proceeds count. Unsold inventory creates no promised holder payout.

### Actual net return and distribution

- The cycle record forms one closed ledger across the exact cycle-escrow USDG debit, canonical Solana USD Coin credit, pack debit, NFT receipt, NFT return, buyback USD Coin credit, return-route USD Coin debit, and final USDG credit to the same cycle escrow.
- The exact final attributable USDG credit after the return path is committed from that escrow through the vault coordinator to the hook as one sum-bound holder payout. Native gas is recorded separately and cannot inflate that amount.
- The cycle remains incomplete while any cycle-attributed NFT, pending transaction, unmatched asset movement, or intended return-route USD Coin remains unresolved.
- A buyback counts only when the same finalized transaction debits the exact awarded NFT to the authorized Collector destination and credits at least the owner minimum and exactly the approved positive refund amount to the bound token account.
- Zero, negative, pending, short, wrong-asset, or unreconciled proceeds create no payout.
- V1 uses an explicitly owner-approved recipient-and-amount manifest derived from one finalized Robinhood snapshot. Every nonzero recipient must have a positive direct HKMN balance at that snapshot; LP ownership is not counted.
- The manifest contains at most 1,024 unique recipients with unique indices from 0 through 1,023 and positive amounts. It does not claim a permanent ranking or allocation algorithm.
- The complete recipient amounts sum exactly to the actual net USDG return.
- A deterministic compiler creates canonical manifest bytes and a full depth-10 Merkle-sum tree. Index bit `i` determines path direction at level `i`; unused positions use canonical empty leaves.
- Before payout funding, preflight fetches digest-matching canonical manifest bytes from at least two independent publication locations so proofs remain reconstructible without the Hookemon API or dashboard.

### Sum-bound payout funding

- The owner-authorized vault commitment chooses a unique `bytes32` payout identifier before building the tree.
- Every nonempty leaf binds a leaf domain tag, chain, hook, cycle, payout identifier, canonical-manifest digest, leaf index, recipient, and amount through one canonical encoding.
- Internal nodes bind a distinct node domain tag, ordered child hashes, and subtree sums through one canonical encoding.
- The committed root sum equals both the exact vault USDG balance decrease and the exact hook USDG balance increase during funding.
- Funding atomically binds cycle identifier, immutable vault, payout identifier, manifest digest, root, and funded total; event block data provides funding timing.
- Direct or excess USDG transfers create no liability.
- V1 exposes no surplus sweep, rescue, or arbitrary withdrawal path.
- For every payout, `funded = paid + unpaid`, and every valid unpaid leaf remains fully backed.

### Holder payment

- Any caller may submit a valid proof immediately or at any later block.
- Payment always goes to the recipient committed in the leaf.
- The paid key `(payoutId, index)` prevents duplicate payment without colliding with another position.
- A failed or non-exact USDG transfer reverts the complete entitlement call and leaves the leaf unpaid.
- Failure of one leaf cannot roll back or block a separate successful leaf.
- The same function is used by the simple payment worker and by a holder or gas sponsor.
- Entitlements never expire.
- V1 has no separate batch state, emergency-claim delay, failed-recipient state, or recipient replacement.

A wrong or USDG-blocked recipient may therefore remain funded but unpaid in V1. A later replacement feature requires a separately specified successor hook; it cannot be added to the immutable V1 deployment.

### Minimal authority

- The Programmable beneficiary and share are immutable.
- Treasury beneficiaries own only liability accrued for them.
- Current Operations triggers each new process cycle only while atomically funding its immutable cycle escrow through the PegCycleVault coordinator. Operations never receives process principal or funds a payout; its frozen trigger identity affects no cycle custody after a later handover.
- Treasury and Operations use exact owner-approved addresses with evidence-bound custody controls and recovery procedures. The hook does not detect or require a particular wallet implementation.
- Treasury and Operations each use one two-step successor handover: the current role proposes and only the proposed nonzero successor accepts.
- Handovers affect only future authority and never rewrite historical liabilities, cycles, payouts, or paid bits.
- There is no generic admin, automation-only role, pause authority, policy manager, or emergency withdrawal role.

### Deferred product surfaces and automation

Phase 1 has no dashboard, OpenUI, operator control surface, holder-facing UI, scheduler, continuous or unattended operation, catalog database or refresher, route optimizer, or multi-pack execution. The manual runner reads current pack facts directly, freezes one operator-selected pack and both fixed routes into the cycle authorization, and stops after final reconciliation. These deferred capabilities may be specified only in Phase 2 and cannot become implicit Phase 1 obligations.

### Phase 2 manual cycle control

Requirements revision 57 opens only a local manual control surface. The operator imports one exact pack snapshot, selects one pack, edits money parameters before freeze, and then operates one immutable plan. A restart reconstructs the same journal and reconciles an unresolved external attempt before any retry. A terminally failed cycle can be followed only by a fresh cycle identifier, nonce, and deterministic return escrow; delayed funds remain quarantined in the failed cycle's escrow.

Phase 2 adds no dashboard, server, database, scheduler, automatic pack strategy, route discovery, multi-pack execution, concurrency, signer, broadcast path, credential access, or production provider authority. Deadline renewal for a funded or returned cycle may change only the deadline and a fresh nonce; every pack, route, amount, cap, recipient, payout, and receipt field stays frozen.

### Phase 2 autonomous cycle authority (requirements revision 58, pending owner signature)

Requirements revision 58 additionally specifies, but does not activate, a fully autonomous version of the Phase 2 loop: a scheduler that triggers cycle stages on a fixed interval, an open swap router with optional hookData so the community can buy HKMN through any standard wallet or aggregator, chunked payouts for holder counts beyond 1,024 (shipped inactive at chunk count one), and a dashboard with a read-only public status surface plus an owner-authenticated config surface. None of this changes what the paragraph above says is true today: nothing in revision 58 becomes live until `decisions/ADR-0021-autonomous-cycle-authority.md`'s owner-approved standing signing authority is actually signed, checked fresh on every signing request. Until then every revision-58 code path ships and passes tests but the signer service refuses to produce a live signature for it.

The autonomous model keeps a five-identity custody split: an Operations trigger, a vault authorizer, policy-bound EVM/Solana execution signers, a distribution-signer/verifier pair, and a distinct owner standing-authority key. The distribution-signer signature is produced by the worker's own automated process; the verifier is a separate, independently automated process holding its own key, designed to run on a different host, that recomputes the manifest from chain data and signs only on an exact match — so a payout to holders requires two independently produced signatures with no human action required per cycle by default. A two-layer kill switch (an immediate off-chain pause flag, and on-chain revocation of the vault-authorizer and policy-wallet keys) stops the next cycle stage from starting; no new on-chain pause role is added (see ADR-0021's citation of `architecture/trust-boundaries.md` TB-07).

Built and tested against fake transports, all gated behind the same unsigned standing authority above:

- **Scheduler.** An unattended worker wakes on a fixed interval (20 minutes by default, operator-editable through the dashboard) and, while unpaused, either resumes an in-flight cycle or opens a fresh one when the live process-budget gate allows it. Pausing blocks only the next cycle from starting; the current one always finishes.
- **Bridge.** Both cross-chain legs — the outbound Robinhood-Chain-USDG-to-Solana-USD-Coin leg that funds the pack purchase, and the return leg that brings net proceeds back to Robinhood Chain — go through Relay's cross-chain bridge, reconciled independently against Solana signature status and Robinhood Chain transaction receipts rather than trusted from the bridge's own response.
- **Pack cycle.** One Collector Crypt pack purchase, open, and standard buyback per cycle, with the opened card's mint derived independently from the open transaction's own on-chain token-balance change rather than trusted from any API response field.
- **Distribution.** A finalized-block HKMN holder balance snapshot (excluding the vault, hook, pool, treasury, every prior cycle's own return escrow, and the zero address) is turned into a floor-rounded pro-rata USDG share per holder; the rounding remainder carries forward as dust into the next cycle's distribution rather than being paid to anyone. Distributions above 1,024 holders split into deterministic, address-sorted chunks (built and tested, shipped inactive at chunk count one).
- **Dashboard.** A read-only public surface (current cycle stage, next scheduled run, recent outcomes, cumulative distributed total, holder count) and an owner-authenticated control surface (interval, allowed packs, pause/resume, spend caps, and a restart/reconcile request), with every accepted or rejected decision appended to a hash-chained audit log.
- **Dry run by default.** With live mode off — the default, and the only mode reachable without the owner's standing authority signed — every stage performs a real, read-only probe and records what it would do; no signer, broadcast, or provider mutation is ever reached. Live mode requires both the signed standing authority and, for any real launch, Programmable reporting Robinhood Chain (`4663`) launch readiness as available; neither is true at the time of writing.

## Trusted onchain boundary

The production trusted surface contains only:

1. one immutable HKMN token unless the verified Launchpad is the token deployer;
2. one non-upgradeable hook containing canonical-market authentication, fee accounting, process release, payout funding, payment, and minimal role handover state; and
3. one immutable hook-bound `PegCycleVault` coordinator and one deterministic immutable return escrow per sequential cycle, with no proxy, upgrade, successor-control, generic call, approval, rescue, sweep, delegatecall, or arbitrary-recipient path; and
4. one immutable custody surface for the canonical launch position with no transfer, approval, liquidity-decrease, principal-withdrawal, fee-collection, rescue, upgrade, delegatecall, or successor-control path; and
5. the minimum deployment helper required by the official provider interface.

The final deployment binds all nonzero and mutually valid identities, the complete PoolKey, callback permissions, and required hook-address construction atomically and exactly once. No proxy, marketplace adapter, bridge adapter, scheduler, indexer, API, or dashboard contract belongs to the trusted surface.

An onchain behavior change requires a separately specified successor deployment. The original hook remains available for historical claims and entitlements, and a canary is never promoted into production.

## Phase 1 verification

The exact release must prove:

- atomic one-shot initialization and official provider binding;
- canonical buyer output, callback authentication, and both token orderings;
- zero PoolKey LP fee, permanent non-project-controlled custody of the 90 percent launch position, and normal supported trading after custody;
- exact fee rounding, collection, liability isolation, and global solvency;
- replay-safe vault-only process opening triggered by current Operations;
- one real configured Solana-USD Coin non-turbo pack purchase, open, and standard buyback;
- reconciliation of actual net USDG returned to PegCycleVault;
- position-bound Merkle-sum construction and full funding;
- permissionless, non-expiring, exactly-once holder payment;
- exact USDG balance-delta and global reentrancy behavior;
- treasury and Operations handover boundaries;
- independent artifact reconstruction;
- complete contract, receipt, manifest, and entitlement reconciliation;
- runtime, initcode, and gas headroom;
- reproducible release artifacts; and
- zero unresolved critical or high finding.

The first complete local or fork run is non-broadcast and proves the hook plus deterministic replay of pinned external fixtures. It cannot prove a real conversion, Collector purchase, opening, buyback, or return. After provider readiness, one separately authorized and capped live cycle must use one continuous cycle identifier and receipt chain to prove at least one real canonical HKMN buy, its exact fee split, process release from the resulting accrued liability, both conversions, Collector purchase, opening, buyback, returned USDG, payout funding, at least one holder payment from that exact payout, and final reconciliation. No historical test, simulated external receipt, audit, receipt from another release, code hash, or dashboard projection counts as live Phase 1 evidence.

## Ordered delivery

1. Phase 1: thin production V1 described by this document.
2. Phase 2: the revision-57 local manual cycle-control increment described above.
3. Any production automation, user interface, or later onchain behavior: a fresh specification and, where required, a separately deployed successor hook.

Phase 2 starts from its explicit revision-57 requirement and does not inherit a non-operative idea merely because it appeared in an earlier discussion or future note. Phase 2 and Phase 3 remain closed until the preceding interface and evidence handoffs pass. Requirements revision 58 opens `product/delivery-boundary.json`'s machine-readable Phase 2 delivery phase and specifies the autonomous increment described above, but that delivery-boundary opening is a bookkeeping and traceability gate, not a live-authorization gate — see `product/REQUIREMENTS_REVISION_58_PROPOSAL.md` for what is and is not yet authorized.

## Open integration decisions

The following values remain deliberately unbound rather than invented:

- the live Programmable Robinhood V4 Launchpad, admission, callback, and fee interfaces;
- the exact canonical HKMN/USDG PoolKey and deployment construction;
- the exact provider-compatible permanent custody construction for the 90 percent launch position;
- the configured Collector Crypt Solana pack, production API snapshot, authentication boundary, transaction instruction allowlist, re-verification of the fixed Circle USD Coin mint, and exact purchase, custody, opening, buyback, and settlement interfaces;
- the exact outbound and return conversion providers, programs or contracts, assets, destinations, minimum receives, deadlines, and finality rules;
- the first owner-approved recipient-and-amount manifest;
- the Treasury and Operations addresses, custody controls, and recovery procedures; and
- exact canary, conversion, pack, USDG, USD Coin, SOL, and other involved native-gas caps.
