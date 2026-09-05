# ADR-0022: Operations-wallet money path

## Status

Proposed. Requirements revision 65 and architecture revision 9 record the target architecture. The accompanying revision-65 owner-approval baseline is `DRAFT_UNSIGNED` and does not satisfy spec gate S5 or release readiness. A formal S5 authorization requires a separate explicit `OWNER APPROVED` or `OWNER AUTHORIZED` artifact and an `owner-spec-approved` receipt bound to the current `gates/spec.json`, `policy/policy.json`, and `specs/requirements.json` hashes. This ADR authorizes no deployment, credential use, signing, broadcast, asset movement, spending, or publication.

## Context

The prior deployed-custody design placed the 2.5% process share in a multi-component vault family. The Phase 3 design moves operational custody to one Operations EVM identity and one Operations Solana identity while retaining the process liability in the immutable hook until a bounded claim succeeds. The resulting path must prevent an external provider, dashboard, scheduler, or retry loop from becoming an alternate money authority.

The external path also needs an immutable launch sequence, gross-volume fee accounting across all supported swap forms, recovery-safe provider transactions, a fail-closed epic policy, a finalized pre-claim holder snapshot, and direct per-holder payout finality.

## Decision

### Deployment and custody

The content-addressed Phase 3 deployment manifest is authoritative. It permits the immutable token, hook, permanent position custody, and Operations-wallet control path. The former vault, escrow, route executor, payout commitment, holder settlement, and Merkle-sum family remains frozen source evidence and is excluded from every Phase 3 runtime.

The hook keeps the 2.5% process liability. Current Operations alone may call `claimProcess(bytes32 cycleId, uint256 amountAtomicUsdg, address destination)`, with `destination == msg.sender`, a nonzero permanently unused cycle ID, positive amount, and both liability and capacity checks. A successful claim counts while `block.timestamp - claimedAt < 86400`; equality is expired. Retained window entries are bounded by `N`, while permanent cycle history is never pruned.

Treasury can lower or zero the process-claim limit immediately, pause claims, and schedule an emergency Operations rotation. A limit increase cannot exceed immutable `Xmax` and becomes active only after 24 hours. No limit change or rotation resets usage or history; scheduling and completing a rotation auto-pauses claims. Beneficiary claims require a nonzero destination and transfer and emit the actual destination.

### Atomic launch and fee accounting

The hook enables `beforeInitialize` with permission mask `0x20CC`. Only hook-self initialization inside the authorized atomic launch leg succeeds. That leg initializes, uses PositionManager `MINT_POSITION` and `SETTLE_PAIR` with a Permit2 allowance that is set and cleared in the same transaction, verifies owner, pool, ticks, and liquidity for the actually minted token ID, binds that ID to permanent non-withdrawable custody, and stamps launch completion. A failed substep reverts the complete transaction.

The fee basis is gross USDG quote volume in every ordering, direction, and exactness combination. Exact output uses a monotone gross-up satisfying `gross - sum(feeDeltas(gross)) = requestedNet`. Independent lifetime quotient and remainder accumulators serve 10, 40, and 250 basis points; claims never reset them. Fee-bearing gross amounts below 1,000 atomic USDG revert. Same-pool self-calls are forbidden and partial fills use `REVERT_WHOLE_SWAP`.

### Offchain authority and recovery

`CycleRepository` and the policy engine are the only authority for every money mutation. Provider effects progress through `PREPARED`, `SENT_UNKNOWN`, `RESPONSE_RECORDED`, and `RECONCILED`; chain transactions progress through `PREPARED`, `SIGNED`, `BROADCAST`, and `FINALIZED`. Writes occur before irreversible effects. Recovery rebroadcasts the same signed bytes or reconciles; it never creates a new nonce, blockhash, or signature while unresolved.

Every provider transaction is semantically decoded and positively allowlisted before external signing and revalidated before broadcast. The policy covers EVM and Solana legacy or v0-with-ALT messages. Exactly two signing identities exist: Operations EVM and Operations Solana. Their signing occurs outside the Node process unless a recorded owner exception applies.

The runner stages are `claim-process`, `outbound`, `purchase`, `open`, `epic-gate`, `buyback`, `return`, and `payout`. Amounts are `{chainId, assetId, decimals, amountAtomic}` with integer-string atomics. Chain-4663 USDG and Solana stablecoins remain distinct assets. Only a finalized, cycle-attributed USDG credit to Operations can complete return and fund payout.

### Hold policy, snapshot, and payout

The epic rule holds only when `offerAtomic * 100 < insuredValueAtomic * 40`; equality sells. Missing or invalid data, missing mint, rarity conflict, unavailable buyback, changed quote, or wrong mint enters a fail-closed `HELD_*` state. It never auto-sells, and a held card blocks new claims in v1.

Eligibility is frozen before claim at a finalized block. The snapshot pins and rechecks its hash, replays Transfer logs from deployment, reconciles mint minus burn against the launch manifest, and proves log completeness with a second source or archive RPC. Payout feasibility is measured before claim. Direct USDG transfers pay the frozen manifest; after first broadcast its bytes are immutable. Frozen recipients become quarantine liabilities, and retries preserve the same nonce and calldata.

### Policy and readiness

The policy engine atomically maps dashboard caps, maintains a 24-hour spend ledger, caps cycles, per-cycle amount, rolling loss, and outstanding custody, and checks pause or kill state before every signature. It requires digest-bound manual approval for the first configured production cycles and runs persistent pre-signature canaries. Rehearsal is a runner mode. `repairMergeEligible` and `launchEligible` remain distinct; the latter also requires current provider, manifest, signer, and operational evidence.

## Supersession

This ADR supersedes the deployed-custody topology for Phase 3 only. Frozen source remains available for study and recovery, but no former custody-family runtime is carried into the Phase 3 deployment manifest. Earlier requirements remain historical evidence unless revision 59 explicitly replaces their runtime role.

## Alternatives

### Retain the former deployed vault family

Rejected. It creates a second custody and payout authority that conflicts with the Operations-wallet path and the one-repository rule.

### Give the scheduler or dashboard direct signing authority

Rejected. They remain policy-controlled clients; signing is limited to the external Operations identity pair.

### Use a mutable or onchain Merkle payout runtime

Rejected. Phase 3 uses an immutable post-broadcast direct-transfer manifest with durable recipient finality and quarantine accounting.

## Consequences

- Contract, runner, adapter, and release work must bind to the Operations-wallet interfaces and deployment manifest before implementation.
- The owner-recorded Programmable route acceptance and `FEE-01` acceptance establish the 10-basis-point platform share for the revision-65 implementation baseline. They do not supply a provider graph preimage or authorize an external action.
- Live action remains separately governed after code and launch readiness evidence exists.

## Decision note: 2026-09-04

Requirements revision 60 and architecture revision 7 supersede the earlier process-claim timing. The owner changed the `claimProcess` rolling window from 86400 to 21600 seconds. A claim counts only while `block.timestamp - claimedAt < 21600`; equality is expired. A scheduled limit increase activates after the same 21600-second delay. Decreases, zero, and pauses remain immediate.

The emergency Operations rotation delay remains unchanged. The earlier decision describes it only as its own delay and does not define it by reference to the process-claim window.

The policy engine's rolling 24-hour spend ledger remains unchanged because it is a separate offchain loss-control policy, not the onchain `claimProcess` window.

### Decision note: 2026-09-04 (canonical hook data)

The owner confirmed that `hookData` is unused. Requirements revision 61 supersedes the prior buyer-credit semantics of `REQ-canonical-market-6`: canonical swaps authenticate and account independently of hook-data bytes, which cannot create buyer credit or alter callback context.

## Decision note: 2026-09-04 (revision 62 operational contracts)

The owner delegation dated 2026-09-04 resolves the open operational-contract facts below for
requirements revision 62 and architecture revision 8. These decisions define repository and
interface behavior only; they grant no deployment, signing, broadcast, asset movement, spending,
or publication authority.

1. `REQ-cycle-runner-3` fixes the ordered lifecycle as `eligibility-snapshot`, `claim-process`,
   `outbound`, `purchase`, `open`, `epic-gate`, `buyback`, `return`, and `payout`.
2. `REQ-cycle-repository-1` fixes provider attempts as `PREPARED -> NOT_SENT -> PREPARED` for a
   pre-call failure with no provider contact, and `PREPARED -> SENT_UNKNOWN ->
   RESPONSE_RECORDED -> RECONCILED` after a post-send ambiguity. `SENT_UNKNOWN` is
   observation-only. Every `HELD_*` terminal state advances only through an idempotent owner
   decision.
3. `REQ-cycle-repository-1` and `REQ-direct-payout-1` fix the durable chain attempt as
   `PREPARED(requestDigest, policyDigest, fencingToken) ->
   SIGNED(rawSignedBytesHash, nonceOrBlockhash, txHash, approvedSemanticsDigest) -> BROADCAST ->
   FINALIZED`, or `REFUSED(reason, fencingToken)`. The signer wrapper, payout, relay stages, and
   Collector handlers read and write this record. Restart revalidates the persisted approval digest
   before any rebroadcast.
4. `REQ-cycle-runner-3` and `REQ-policy-engine-1` require a purchase request to persist before
   signing: typed `unitPriceAtomic`, `totalAtomic`, and `boundedOverheadAtomic` values plus a
   positive integer-string `quantity`. Policy verifies every field and reserves quantity times unit
   price plus overhead.
5. `REQ-cycle-repository-1`, `REQ-cycle-runner-3`, and `REQ-policy-engine-1` require immutable
   `production` or `rehearsal` mode in each cycle record. Production and rehearsal services refuse
   the other mode.
6. `REQ-cycle-repository-1`, `REQ-cycle-runner-3`, and `REQ-policy-engine-1` separate finalized
   observed balances from obligations, count unresolved principal once, distinguish expected cycle
   assets from unattributed external deposits, and pause new claims for such deposits.
7. `REQ-transaction-policy-1` names `hookemon.transaction-policy.v1` version 1 as the wire tag.
   The runner canonical validator is authoritative and the adapter decoder must emit the identical
   schema.
8. `REQ-operations-wallet-2` and `REQ-role-control-2` adopt the safer rotation reading: Operations
   cannot cancel a pending rotation, only a new Treasury intent supersedes it and starts a fresh
   delay, and `processClaimMaxCount` is hard-capped at 64 for gas. The immutable constructor input
   is 43200 seconds in production and `Xmax` is 500000 USDG
   `{chainId: 4663, assetId: USDG, decimals: 6, amountAtomic: 500000000000}`.
9. `REQ-collector-crypt-adapter-1` records the Collector response facts: numeric tiers 1 through
   4, configured Solana stablecoin buyback base units, integer-or-numeric-string `contains`, and
   documented idempotent `openPack`. `insured_value` is usable only after reconciliation against
   the machine instant-buyback percentage; otherwise the cycle enters `HELD_DATA_UNVERIFIED`.

Revision 62 adds `REQ-collector-crypt-adapter-1`, revises the active requirements named above,
and supersedes the retired Phase 3 runtime records `REQ-process-budget-1` through
`REQ-process-budget-6`, `REQ-payout-commitment-1` through `REQ-payout-commitment-8`,
`REQ-holder-settlement-1` through `REQ-holder-settlement-7`, `REQ-cycle-runner-1`,
`REQ-cycle-runner-2`, `REQ-cycle-control-1`, `REQ-cycle-control-2`, `REQ-distribution-1`, and
`REQ-distribution-2`.

## Decision note: 2026-09-04 (revision 63 bridge, authority, launch, and payout contracts)

The owner delegation dated 2026-09-04 directs the coordinator to record the following proposed
baseline for requirements revision 63 and architecture revision 9. The accompanying baseline is a
`DRAFT_UNSIGNED` owner-approval artifact. These decisions define target contracts only and grant no
deployment, credential use, signing, broadcast, asset movement, spending, or publication authority.
That historical baseline used a split allocation. Revision 65 supersedes it with the complete fixed
supply allocated to the canonical market and no other allocation.

1. **Bridge settlement** (`REQ-cycle-repository-1`, `REQ-cycle-runner-3`,
   `REQ-transaction-policy-1`). Each outbound or return bridge action persists a `RelayLegV1` with
   `cycleId`, `direction`, `relayRequestId`, `quoteDigest`, source and destination chain,
   transaction-hash, asset, decimal, and atomic-amount fields, `finalizedAtSource`,
   `finalizedAtDestination`, and destination-unit `netDeltaAtomic`. A source or destination
   transaction hash may attribute to exactly one leg across every cycle. `SETTLED` requires both
   finalized deltas observed by this process's own RPC clients and destination attribution by
   amount, time window, and memo or request identifier; Relay status alone is insufficient.
   Partial, refund, late, and wrong-asset outcomes are terminal
   `HELD_RELAY_PARTIAL`, `HELD_RELAY_REFUND`, `HELD_RELAY_LATE`, and
   `HELD_RELAY_WRONG_ASSET`. Outbound uses only the cycle's claimed principal, and return bridges
   only that cycle's attributed proceeds delta.
2. **Standing authority** (`REQ-cycle-repository-1`). First use checks wall-clock expiry and
   atomically persists `StandingAuthorityDecisionV1(authorityDigest, verifiedAt, intentDigest,
   dayCapReservation, nonceReservation)` before any signable action. Expired authority is refused.
   A replay of the persisted decision is idempotent and cannot reserve another day cap or nonce.
3. **Typed minima and gas caps** (`REQ-transaction-policy-1`, `REQ-policy-engine-1`). Every money
   minimum is an explicit `{chainId, assetId, decimals, amountAtomic}` value. The production return
   minimum is `{chainId: 4663, assetId: USDG, decimals: 6, amountAtomic: 0}`, so no general return
   minimum applies. EVM per-transaction gas-price caps and native reserves plus Solana priority-fee
   caps and lamport reserves are mandatory. Atomic value `1` is a configuration error, never a
   placeholder default.
4. **Split launch atomicity** (`REQ-launch-orchestration-1`, `REQ-launch-orchestration-2`). The
   historical graph deployed token, custody, and hook and then executed three ordered initialization
   calls. Revision 65 retains the three-call topology but replaces the former split-allocation
   token call with `token.allocate(hook)`, followed by
   `custody.configureBindingHook(hook)` and
   `hook.initializeGraphLaunch(custody, sqrtPriceX96)`. The third call initializes the fixed-price
   pool and stamps launch. The separate owner-signed seed transaction pulls USDG through Permit2
   and mints through PositionManager to custody. In graph mode it requires zero residual HKMN;
   seed failure rolls back only seed-local state and may be retried. This decision supersedes the
   revision-62 all-in-one launch transaction contract.
5. **Payout durability** (`REQ-cycle-repository-1`, `REQ-direct-payout-1`). One repository-backed
   wallet nonce lock covers claim, outbound, return, and payout. `SIGNED` records survive restart.
   A dropped `BROADCAST` resolves by receipt search or exact-byte rebroadcast while its nonce is
   available.
   A frozen recipient becomes a quarantine liability without blocking the manifest. Dust carry is
   durable and atomically consumed with its cycle provenance.
6. **Payout failure-matrix clarification.** The failure matrix is audit evidence, not the direct-
   payout requirement. When a dropped EVM payout still has its nonce available, recovery searches
   for finality and may rebroadcast only the exact persisted bytes; it leaves the recipient attempt
   `BROADCAST`, creates no terminal state, and never requests a new signature. When another
   transaction has consumed that nonce, the recipient becomes `NONCE_INTERFERENCE`; later manifest
   recipients may proceed, and only after the payout pass does the cycle enter
   `HELD_OWNER_DECISION` for that quarantined liability. A frozen recipient follows the same
   completion rule with recipient state `REFUSED`: its amount is quarantined, later recipients
   proceed from the immutable manifest, and the cycle records `HELD_OWNER_DECISION` after the pass.

## Decision note: 2026-09-05 (revision 64 token supply and source separation)

Requirements revision 64 retains architecture revision 9. The Phase 3 token is a distinct source
target with `WHOLE_HKMN_SUPPLY = 1_000_000_000`; historical issuance and retired-strategy sources
retain their pre-Phase-3 values so the Phase 1 candidate remains reproducible. The revision-64
split-allocation baseline is historical only. Revision 65 replaces it with the owner decision
recorded below. This is not a formal S5 owner authorization or an authorization for launch,
signing, broadcast, asset movement, spending, or publication. The revision-64 `DRAFT_UNSIGNED`
baseline cannot be promoted in place; a later formal approval must be a separate explicit artifact
and current `owner-spec-approved` receipt.

## Decision note: 2026-09-05 (revision 65 allocation and provider acceptance)

Requirements revision 65 retains architecture revision 9. The owner directs that the complete
fixed supply of 1,000,000,000 HKMN, with 18 decimals, is allocated through
`token.allocate(hook)` to the canonical market. `MARKET_ALLOCATION_BPS` is 10,000. There is no
remainder custody allocation, treasury allocation, or other non-circulating HKMN balance.
`PermanentPositionCustody` retains only the permanently bound LP-position role.

The canonical seed is 240 USDG (`240000000` atomic units) from the owner-approved 300 USD total
budget. The release plan accepts only the two address-order price tuples that consume the complete
HKMN allocation and the 240-USDG maximum. Graph-mode seeding rejects a residual HKMN balance.

The owner approved `https://x.com/hookemon4` as the X profile. The owner also recorded that
Programmable accepted the Phase 3 launch route on 2026-09-05 and accepted `FEE-01` as a
10-basis-point platform share on 2026-09-04. These decisions resolve the former allocation and
provider-acceptance questions.

OPEN FACT: the provider has not supplied the encoded launch-intent preimage. The missing values
are the route namespace, route nonce, topology hash, target-id hashes, and serialized graph call
data for the accepted three-call sequence. Obtain those values in the provider preflight response;
until then, the closest verified alternative is the non-signing local draft with no encoded graph
call data or target addresses. This fact does not reopen the owner decisions above.
