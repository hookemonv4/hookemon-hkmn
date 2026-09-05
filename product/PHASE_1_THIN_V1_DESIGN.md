# Phase 1 Thin Production V1

## Status

Owner-approved design and requirements revision 55.

## Outcome

Phase 1 proves one manually started, capped, real and inspectable product loop with the smallest immutable onchain surface:

1. a buyer acquires HKMN in the canonical USDG/HKMN market;
2. the executed USDG volume produces the approved 0.10%, 0.40%, and 2.50% liabilities;
3. the Operations account releases one cycle's available process budget to itself;
4. the operator converts the authorized principal to canonical Solana-mainnet USD Coin, buys and opens one configured Collector Crypt pack, and immediately monetizes the awarded NFT through the standard Solana buyback path;
5. the realized Solana USD Coin is returned through one pinned conversion path and the actual net USDG proceeds are credited to Operations;
6. Operations funds a complete holder distribution at the hook;
7. permissionless proof submissions pay every valid holder at most once; and
8. contract state, receipts, canonical manifest bytes, and entitlement state reconcile the complete loop.

The loop is intentionally narrow. Its purpose is to validate demand and the core economics before the project spends time on broader automation or product polish.

## Immutable onchain boundary

The production trusted surface contains only the officially supported HKMN issuance path and one non-upgradeable hook. The hook provides the minimum state transitions required to:

- authenticate the final PoolManager and complete canonical PoolKey;
- account for the approved fee split from actual collected USDG;
- isolate Programmable, treasury, process-budget, and funded-payout liabilities;
- let Programmable and treasury claim only their own accrued liabilities;
- release a unique process-budget cycle only to the bound Operations account;
- atomically receive and commit an actual net-USDG payout funded by Operations;
- verify canonical depth-10 Merkle-sum proofs and pay the proof's recipient; and
- expose balances, releases, payout totals, and paid status through contract reads and events.

The hook does not buy packs, route assets, rank holders, schedule work, call a marketplace, store dashboard settings, or contain website behavior.

## Minimal offchain boundary

Phase 1 includes only the reversible components required to complete and observe the loop:

- an operator-triggered cycle runner for one configured Collector Crypt Solana-mainnet USD Coin pack path;
- an explicit manual approval boundary for every conversion, marketplace transaction, signature, broadcast, external API mutation, or spend;
- a deterministic distribution compiler that verifies direct HKMN holders at one finalized snapshot and creates a canonical manifest plus a depth-10 Merkle-sum root;
- two independent publication locations whose digest-matching manifest bytes are fetched before funding;
- a simple payment worker that submits the same permissionless per-entitlement function available to any caller; and
- final reconciliation from contract reads, events, receipts, canonical manifest bytes, and entitlement state.

The first runner may use operator-assisted conversion and marketplace steps. It does not schedule itself, run continuously or unattended, persist a catalog, optimize routes, support multiple packs, publish a dashboard or UI, assume autonomous custody, or implement a general marketplace abstraction.

## Fixed Solana pack cycle

The production pack subloop uses Solana mainnet and Circle's canonical six-decimal USD Coin mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, not the Collector Crypt Base EVM path. Before execution, the cycle artifact pins the Solana cluster and RPC evidence, selected public pack code, live price, production API host, credential identifier, approved Solana execution wallet and token account, outbound and return conversion providers, transaction destinations, minimum receives, deadlines, principal cap, and native-gas caps. Credentials remain outside repository artifacts and logs.

The first runner uses the standard single-pack path with turbo disabled and no alternate card or funds recipient. Before each external mutation it durably records the authorized intent and exact canonical request fields and digest, excluding secrets. It then chains the response digest, provider partial-signature set, decoded transaction-message digest, recent blockhash and last-valid height, owner authorization, exact signed-bytes digest, broadcast signature, and independently verified final state before advancing. Every purchase, buyback, outbound conversion, and return receipt has one globally unique consumption key. A restart reconciles RPC and API state and never generates or signs a replacement action while an earlier intent cannot be proven absent or terminal.

The persisted generate request proves the exact player, pack code, quantity, non-turbo mode, and absence of alternate recipients because those choices are not recoverable from the generated payment transaction alone. The runner independently decodes and validates the returned purchase transaction, pauses for wallet signing and broadcast approval, verifies finalized Solana state independently of the API, and checks the resulting pack status for the same player, pack, mode, memo, and fixed token mint. It opens the pack once and verifies that the awarded NFT reaches the same approved wallet.

After the random NFT is known, a separate owner authorization binds that exact mint, its current onchain owner, the original Collector prize-wallet return destination, the fixed USD Coin mint and approved token account, absent alternate recipient, API refund amount, and an owner minimum receive in base units. The runner signs only a decoded buyback transaction matching those fields and verifies that the same finalized transaction debits that NFT and credits at least the minimum and exactly the approved refund amount. It does not use YOLO packs, automatic Common-only resale, alternate recipients, or blind retries.

The cycle ledger closes only after it can reconcile the exact Robinhood USDG debit, canonical Solana USD Coin credit, pack debit, NFT receipt, NFT return, buyback USD Coin credit, return-route USD Coin debit, and final USDG credit to the cycle-bound Operations account. An estimate, insured value, buyback quote, API success response, pending signature, unresolved NFT, or unreturned USD Coin is not distributable proceeds. The holder payout total is the exact attributable USDG credit after the return path; native gas is recorded separately and cannot inflate that total.

## Payout construction

The Operations account bound to the released cycle supplies a caller-chosen unique `bytes32` payout identifier. The identifier is included in every leaf before the root is constructed and can never be reused, even if Operations changes later.

The canonical manifest binds one finalized Robinhood snapshot and at most 1,024 unique direct HKMN holders with positive balances, unique indices, and positive amounts. Its digest enters every leaf. A full depth-10 tree uses the index bits as the only path directions, domain-separates leaves from internal nodes, and pads every unused position canonically. The committed root sum must equal both the exact Operations USDG balance decrease and the exact hook USDG balance increase during `fundPayout`. This prevents a manifest from promising more than the funded payout and prevents index collisions or early claims from exhausting money owed to later leaves.

The funding event binds the cycle identifier, payout identifier, manifest digest, root, and funded total. Funding preflight must fetch digest-matching canonical manifest bytes from two independent locations because a root alone cannot recreate leaves or proofs.

Each entitlement uses the paid key `(payoutId, index)`. Any caller may submit its proof, but payment always goes to the recipient committed in the leaf. A failed transfer or any non-exact hook debit or recipient credit reverts the entitlement transaction and leaves it unpaid. No batch state machine, five-minute claim mode, failed-recipient state, or recipient-replacement state exists in the first version.

## Money safety

The canonical PoolKey static LP fee is zero. The position representing the 90 percent HKMN market allocation enters permanent non-project-controlled custody and exposes no transfer, approval, liquidity-decrease, principal-withdrawal, fee-collection, rescue, upgrade, delegatecall, or successor-control path. This restriction does not freeze user balances or block supported buys and sells. The approved inclusive 3.00 percent Hookemon hook fee is the only trading fee on the canonical route; no protocol, router, provider, integrator, token-transfer, or other surcharge may supplement it. Network gas is separate.

Every external USDG path shares one reentrancy boundary and verifies exact pre-call and post-call source and destination balance deltas. State transitions and transfers preserve both global solvency and per-payout conservation.

Fee rounding has one deterministic dust rule. For every supported swap, actual collected USDG equals the sum of the Programmable, treasury, and process-budget liability increases. Unsupported provider behavior fails before any liability mutation.

Initialization is atomic and single-use. It binds nonzero and distinct provider, asset, beneficiary, treasury, and Operations identities, the complete PoolKey, and the required hook permission bits. Deployment evidence verifies the CREATE2 preimage or other officially required address construction before production use.

Treasury and Operations each retain one minimal two-step successor handover: the current account proposes a nonzero successor and only that successor can accept. There is no generic admin role. Production release binds the exact owner-approved addresses, custody controls, and recovery procedure without requiring the hook to detect or depend on a particular wallet implementation. The onchain handover prevents the immutable hook from permanently fixing future authority to one address.

## Deferred product work

Phase 2 may add:

- public or operator dashboards, OpenUI, and other user interfaces;
- timed scheduling and unattended cycle execution;
- continuous operation and multiple concurrent cycles;
- catalog persistence, caching, background refresh, search, and ranking;
- route discovery, bridge automation, and marketplace optimization beyond the one pinned Solana path;
- multiple pack types, pack counts, and sale strategies;
- holder ranking, canonical LP weighting, and configurable cohort sizes;
- recipient replacement and holder-driven wallet verification;
- batch-specific settlement state and advanced gas optimization;
- pause controls, surplus recovery, policy registries, and richer role administration;
- durable support workflows, alerts, and analytics; and
- mobile or holder-facing product polish.

Deferred features do not reserve selectors, storage, or privileged paths in the immutable V1 hook.
Offchain features may be added around the same deployment. A deferred onchain feature requires a separately specified successor hook; the original V1 hook remains unchanged and available for every historical liability and unpaid entitlement.

## Release proof

The minimum complete proof is:

`launch -> canonical buy -> fee split -> process release -> Robinhood USDG to Solana USD Coin -> one real non-turbo pack purchase -> open -> standard buyback -> Solana USD Coin to Robinhood USDG -> payout funding -> one or more holder payments -> final reconciliation`

Local and fork evidence must pass before any live action, but fixture replay never counts as a real conversion or pack receipt. One separately authorized and capped live cycle must bind the same cycle identifier across at least one real canonical HKMN buy, its exact fee split, process release from the resulting accrued liability, both conversions, pack purchase, open, buyback, returned USDG, payout funding, at least one holder payment from that payout, and final contract, receipt, manifest, and entitlement reconciliation. A live marketplace operation, canary, launch, signature, broadcast, or spend requires separate owner authorization with exact destinations and caps.

The final Programmable callback, admission, fee-custody, and Launchpad interfaces remain `INTEGRATION_PENDING`. The exact Collector Crypt pack, Solana transaction allowlist, canonical Solana USD Coin binding, and outbound and return conversion route also require current release evidence. No provider-dependent production interface is frozen or deployed while Programmable Robinhood V4 remains unavailable or unverifiable.

## Success boundary

Phase 1 succeeds when the exact loop above passes with no unresolved critical or high finding and its contract state, receipt chain, canonical manifest, and entitlement state reconcile. It does not require a dashboard or UI, evidence of market demand, long-term runway, autonomous operations, or completion of the later product roadmap.
