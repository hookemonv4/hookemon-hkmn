# Product Phase 3 Execution Topology

## Status and objective

This topology implements requirements revision `65` and architecture revision `9`. It describes a proposed Operations-wallet money path and does not authorize deployment, signing, broadcasting, spending, or publication.

Phase 3 replaces the deployed vault runtime with one Operations EVM identity and one Operations Solana identity. The 2.5% process liability remains inside the immutable hook until a bounded `claimProcess` call succeeds. Successful claims count while `block.timestamp - claimedAt < 21600`; equality is expired. A scheduled limit increase activates after 21600 seconds, while decreases, zero, and pauses remain immediate. `processClaimMaxCount` is hard-capped at 64, `Xmax` is 500000 USDG, and the immutable emergency-rotation delay is 43200 seconds. A pending rotation cannot be cancelled by Operations and only a new Treasury intent may replace it. The content-addressed deployment manifest is the authority for the deployed runtime set; the former vault, escrow, route, commitment, settlement, and Merkle family remains frozen source evidence and has zero Phase 3 runtime instances.

## Runtime topology

```text
canonical market callbacks
  -> fee accounting and role control
  -> eligibility-snapshot
  -> Operations claim policy
  -> Operations EVM identity
  -> CycleRepository <-> policy engine <-> transaction policy <-> external signer pair
  -> outbound -> purchase -> open -> epic-gate -> buyback -> return
  -> finalized attributed USDG credit
  -> frozen eligibility manifest -> direct per-holder payout
```

The hook is the only onchain source of process liability. `beforeInitialize` is enabled at mask `0x20CC`; only hook-self initialization inside the provider graph transaction can initialize the pool. That atomic graph deploys the token, custody, and hook targets; allocates the complete HKMN supply through `token.allocate(hook)`; configures custody; initializes the fixed-price pool; and writes the launch stamp. The separate owner-signed seed transaction atomically pulls at most 240 USDG through Permit2, performs `MINT_POSITION` and `SETTLE_PAIR` to custody with the complete HKMN allocation, returns unused USDG to the payer, and reverts on an HKMN residual. Before that seed succeeds, the HKMN allocated to the hook cannot transfer to any other recipient and swaps are unavailable because the pool has no liquidity. A failed seed rolls back only seed-local state and can be retried.

The external operations identities have separate domains. Chain-4663 USDG and Solana stablecoins are represented as typed amounts and never treated as interchangeable. Signing happens outside the Node process unless a recorded owner exception applies. The signer pair contains exactly the Operations EVM and Operations Solana identities.

## Money-mutation authority

`CycleRepository` is the sole durable authority for each money mutation. The dashboard, CLI, scheduler, automation, and public projection are clients of that repository; none can maintain a parallel balance, journal, or authority path. Every cycle records custody buckets by cycle, chain, and asset for claims, bridge flows, provider costs and proceeds, refunds, held assets, payout liability, dust, and unattributed deposits.

Provider attempts write ahead through `PREPARED -> NOT_SENT -> PREPARED` for a pre-call failure without provider contact, `PREPARED -> SENT_UNKNOWN -> RESPONSE_RECORDED -> RECONCILED` for post-send ambiguity, or `PREPARED -> RESPONSE_RECORDED -> RECONCILED` for a recorded response. `SENT_UNKNOWN` is observation-only. Chain attempts persist `PREPARED(requestDigest, policyDigest, fencingToken) -> SIGNED(rawSignedBytesHash, nonceOrBlockhash, txHash, approvedSemanticsDigest) -> BROADCAST -> FINALIZED` or `REFUSED(reason, fencingToken)`. Raw signed bytes are immutable and retrievable by their content address. A restart revalidates the persisted approval digest before any rebroadcast and never creates another nonce, blockhash, bytes, or signature while the prior action is unresolved. One wallet-wide nonce and fencing lock covers claim, outbound, return, and payout.

Every Relay leg is a persisted `RelayLegV1` record containing its cycle and direction, request and quote digests, typed source and destination assets and amounts, both transaction hashes, both finality observations, and destination-unit net delta. A source or destination hash may attribute to exactly one leg across all cycles. A leg reaches `SETTLED` only after this process's own RPC clients observe both finalized deltas and attribute the destination delta by amount, time window, and memo or request identifier; Relay status is never settlement evidence. A partial, refund, late, or wrong-asset result reaches its corresponding terminal `HELD_RELAY_*` state. Outbound may use only the cycle's claimed principal, and return may bridge only that cycle's attributed proceeds delta.

At first use, the repository checks standing authority against wall-clock expiry, then atomically persists `StandingAuthorityDecisionV1(authorityDigest, verifiedAt, intentDigest, dayCapReservation, nonceReservation)` before any signable action. Expired authority is refused. Replaying the same persisted decision is idempotent and cannot reserve another day cap or nonce.

The ordered stages are `eligibility-snapshot`, `claim-process`, `outbound`, `purchase`, `open`, `epic-gate`, `buyback`, `return`, and `payout`. Cycle mode is persisted as immutable `production` or `rehearsal`; each service refuses the other mode. Purchase is persisted before signing as typed `unitPriceAtomic`, `totalAtomic`, and `boundedOverheadAtomic` plus integer-string `quantity`; policy verifies the product and reserves `totalAtomic + boundedOverheadAtomic`. The custody ledger keeps finalized observed balances separate from obligations, counts unresolved principal once, and classifies expected cycle assets separately from unattributed external deposits. Only a finalized, cycle-attributed USDG credit to Operations can advance into payout. Any unattributed inbound asset pauses new claims until reconciliation.

## Control and recovery boundaries

Every provider transaction is semantically decoded by the runner's authoritative `hookemon.transaction-policy.v1` version 1 schema and positively allowlisted before signing and again before broadcast. The adapters decoder must emit that same schema. The policy covers EVM and Solana legacy or v0-with-ALT messages, including chain or program, target or selector, source and destination, mint, amount bounds, value and gas, fee payer, co-signer, extra instructions, deadline or blockhash, and priority fee. Every money minimum is an explicit typed amount. The production return minimum is `{chainId: 4663, assetId: USDG, decimals: 6, amountAtomic: 0}`. EVM per-transaction gas-price caps and native reserves plus Solana priority-fee caps and lamport reserves are mandatory; atomic amount `1` is a configuration error, never a fallback.

The policy engine maps dashboard controls atomically and checks its separate rolling 24-hour spend ledger, cycles-per-day cap, per-cycle cap, rolling loss cap, maximum outstanding custody, pause or kill switch, and digest-bound manual approval for the first configured production cycles. It runs canaries before every signature. Every `HELD_*` state is terminal until an idempotent owner decision records the follow-up. The Collector adapter accepts numeric tiers 1 through 4, an integer or numeric-string `contains`, and documented idempotent `openPack`; it accepts an insured value only after reconciling its unit against the machine instant-buyback percentage, otherwise it records `HELD_DATA_UNVERIFIED`.

Eligibility freezes before the process claim at a finalized block. The snapshot pins and rechecks the block hash, replays holder transfers from deployment, reconciles launch-manifest mint minus burn, and proves log completeness with a second source or archive RPC. Payout feasibility is evaluated before claim. Once the first direct payout broadcast occurs, the manifest is immutable; frozen recipients remain explicit quarantine liabilities without blocking the rest of the manifest. Signed payout records survive restart. A dropped broadcast resolves by receipt search or replacement with the same nonce and calldata, and payout dust carry is persisted and atomically consumed with its cycle provenance.

## Readiness and integration

`repairMergeEligible` reports code and integration readiness only. `launchEligible` additionally requires the admitted deployment graph, current provider facts, deployment-manifest verification, signer and operational canaries, and all separately governed live prerequisites. Neither value authorizes an external action.

Build waves start with the interface and admission evidence, then the immutable claim, fee, and launch path, then the repository and policy-controlled runner, then snapshot and direct payout. Release evidence proves the exact graph and recovery behavior before it can contribute to `launchEligible`.
