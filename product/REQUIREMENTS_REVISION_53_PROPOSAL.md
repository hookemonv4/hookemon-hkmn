# Requirements Revision 53 Proposal

## Status

Approved by the owner on 30 August 2026. The hash-bound gate receipt is the authority record.

## Base

- Previous approved requirements revision: `49`
- Proposed requirements revision: `53`
- Reason for four revision increments: four requirements were added through the stable-ID CLI.

## Rationale

Revision 49 did not prove the minimum product loop. It deferred pack execution and the website, then used synthetic payout funding. Revision 53 makes one real pack cycle and a small read-only dashboard part of Phase 1 while removing nonessential immutable contract state.

The required loop is:

`canonical HKMN buy -> exact fee split -> process release -> Robinhood USDG to Solana USD Coin -> one configured non-turbo pack purchase -> open -> standard buyback -> Solana USD Coin to Robinhood USDG -> sum-bound payout funding -> holder payment -> dashboard verification`

## Added requirements

| Requirement | Purpose |
| --- | --- |
| `REQ-canonical-market-4` | Prove that a canonical buy actually credits HKMN to the buyer. |
| `REQ-cycle-runner-1` | Prove one owner-authorized fixed Collector Crypt Solana-mainnet USD Coin pack and standard-buyback cycle without blind retry or unauthorized external writes. |
| `REQ-cycle-runner-2` | Reconcile the closed Solana asset path, actual returned USDG, and an explicit owner-approved recipient-and-amount manifest before payout funding. |
| `REQ-dashboard-1` | Provide the minimal read-only public view of the complete loop. |

## Revised immutable behavior

- Fee rounding now conserves actual collected USDG exactly. Programmable and treasury use floor division; process liability receives only the remaining rounding units within the total 3.00% fee.
- Initialization is atomic, single-use, provider-bound, and validates the complete PoolKey, permission bits, and official hook-address construction.
- Process release stores only cycle identifier, amount, and the cycle-bound Operations identity. Event block data supplies timing. Policy hashes, caps, scheduler state, pack settings, and arbitrary destinations are absent.
- Payout funding uses a caller-chosen unique identifier and a canonical depth-10 Merkle-sum tree with 1,024 indexed positions, index-derived path bits, and a root sum equal to the exact inbound USDG balance increase.
- The canonical-manifest digest is bound into every leaf and the funding event; funding preflight requires two independently fetched digest-matching publication copies.
- One immediate, non-expiring, permissionless function pays a committed recipient once using paid key `(payoutId, index)`. The worker and holders use the same function.
- Every USDG path shares one global money-path lock and verifies exact balance deltas and post-call solvency.
- Treasury and Operations are exact owner-approved addresses with evidence-bound custody controls and retain only narrow two-step successor handovers. Each released cycle keeps its releasing Operations account as funder. The hook does not require a particular wallet implementation. Generic admin, automation-only, and pause roles are absent.

## Removed V1 behavior

The following behavior from revision 49 is not present in the immutable V1 hook:

- 300-second emergency-claim timing;
- authorized batch-specific settlement state;
- explicit failed-recipient state;
- admin recipient replacement and replacement history;
- fixed recipient-limit configuration from 100 through 600;
- surplus recovery or rescue withdrawal;
- process policy, specification, cap, and canary-configuration state;
- generic admin and automation-only roles;
- process-release pause state; and
- future marketplace, routing, ranking, LP, scheduler, or dashboard state.

Offchain features may be added around the same deployment. Any removed onchain behavior requires a new specification and successor deployment.

## Added reversible V1 behavior

- one operator-triggered fixed Collector Crypt Solana-mainnet USD Coin path, with manual approval for every conversion, external write, signature, broadcast, or spend;
- one standard non-turbo pack purchase, open, and immediate buyback flow using one approved Solana wallet and no alternate recipient;
- one minimal durable hash-chained intent, canonical-request, response, transaction-message, authorization, signed-bytes, signature, finality, and receipt-consumption journal that prevents duplicate external writes after restart;
- one separate post-open buyback authorization bound to the exact awarded NFT, custody, return destination, refund amount, token account, and owner minimum receive;
- one deterministic distribution compiler and independent verifier;
- one finalized direct-HKMN-holder snapshot with at most 1,024 indexed recipients;
- redundant content-addressed artifact publication;
- one simple permissionless payment worker; and
- one minimal read-only website dashboard.

## Superseding decisions

- ADR-0013 supersedes ADR-0007 for the Phase 1 product boundary.
- ADR-0014 supersedes ADR-0005, ADR-0010, ADR-0012, ADR-0003's surplus-recovery clause, and ADR-0009's settlement-batch-sizing clause for payout and recovery behavior.
- ADR-0015 supersedes ADR-0004, ADR-0006, and ADR-0011 for release and authority behavior.
- ADR-0016 supersedes the fee-rounding deferral clauses of ADR-0003 and ADR-0009.
- ADR-0001, ADR-0002, ADR-0008, and the unaffected clauses of ADR-0003 and ADR-0009 remain applicable.

## Owner-selected marketplace chain

- The production Collector Crypt pack subloop uses Solana mainnet and Circle's canonical six-decimal USD Coin mint `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`, not Base.
- The outbound and return conversions remain offchain and use one exact route pinned before execution; no bridge or route logic enters the hook.
- V1 performs those conversions as operator-assisted, separately authorized steps. Its code verifies the frozen binding manifest, finalized receipts, exact asset deltas, and final attributable USDG credit; route discovery, quote engines, generic provider adapters, and automatic retries are deferred.
- Only the exact final USDG credit returned to the cycle-bound Operations account can fund holders. A pack price, insured value, API response, buyback quote, or assumed one-to-one conversion creates no entitlement.

## Known release blockers

- Programmable Robinhood V4 is still officially planned rather than verifiably deployed at the latest evidence point.
- Final callback, admission, fee-custody, Launchpad, and hook-address behavior cannot be frozen before official activation.
- The exact Collector Crypt pack, production Solana API snapshot, authorized credential identifier, generated transaction instruction allowlist, and current purchase, custody, buyback, fee, and settlement bindings remain unbound. The fixed Circle USD Coin identity is re-verified rather than selected at release. The API credential secret is never a repository artifact.
- The exact outbound Robinhood-USDG-to-Solana-USD Coin and return Solana-USD Coin-to-Robinhood-USDG providers, contracts or programs, destinations, quotes, minimum receives, and deadlines remain unbound.
- Live launch, marketplace execution, signing, broadcast, and spending require separate exact owner authorization.

These blockers prevent production release. They do not prevent provider-independent implementation and local or fork verification of the approved money kernel.
