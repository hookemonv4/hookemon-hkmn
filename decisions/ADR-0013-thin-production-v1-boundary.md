# ADR-0013: Thin production V1 boundary

## Status

Accepted by the owner on 30 August 2026. Supersedes ADR-0007.

## Context

The previous Phase 1 boundary proved swap accounting and a synthetically funded payout but deferred the pack cycle and website. That did not prove the owner's minimum product: buy HKMN, split fees, buy and monetize a pack, return actual proceeds, pay holders, and show the result. The first release must validate this loop quickly without putting reversible marketplace or product behavior into the immutable hook.

## Decision

- Make the complete thin product loop normative for Phase 1.
- Keep the immutable boundary limited to issuance, canonical-market authentication, exact fee accounting, process release, sum-bound payout funding, permissionless entitlement payment, and read-only state.
- Add one operator-triggered offchain runner for one configured Collector Crypt Solana-mainnet USD Coin pack-and-buyback path.
- Convert the authorized Robinhood USDG principal through one pinned outbound route, execute one standard non-turbo pack purchase, open, and immediate standard buyback on Solana, then convert the realized Solana USD Coin through one pinned return route to the cycle-bound Operations account.
- Use one owner-approved Solana execution wallet as player, NFT recipient, and buyback-USD Coin recipient. Do not use Base, turbo mode, YOLO batches, or alternate recipients in V1.
- Require separate owner authorization for every conversion, external API mutation, signature, broadcast, and spend. Independently decode every generated Solana transaction before signing.
- Keep conversions operator-assisted in V1. Verify one frozen binding manifest, finalized receipts, exact asset deltas, and final attributable USDG credit without building route discovery, quote engines, generic provider adapters, or automatic retries.
- Keep one minimal durable journal that records every authorized intent and canonical request before an external mutation, then hash-chains response, provider partial signatures, memo, transaction message, blockhash validity, authorization, signed bytes, broadcast signature, and finality evidence. Give every external receipt a globally unique consumption key and reconcile RPC and API state before any retry.
- Require a separate post-open owner authorization for the exact awarded NFT, current custody, Collector return destination, fixed USD Coin account, absent alternate recipient, exact refund amount, and minimum receive before signing the buyback.
- Add a deterministic distribution compiler that verifies positive direct HKMN balances at one finalized snapshot, a simple payment worker, and a minimal read-only website dashboard.
- Permit operator-assisted marketplace steps in V1.
- Defer scheduling, unattended custody, route optimization, multiple pack strategies, ranking, LP weighting, recipient replacement, advanced operations, and product polish.
- Start the next product phase from a fresh specification and owner approval.

## Alternatives

### Keep packs and the dashboard outside Phase 1

Pros:

- The initial repository would contain only the onchain core.
- No marketplace or website integration would be required for the first gate.

Cons:

- The release would not prove the owner's actual product loop.
- Synthetic payout funding could hide failures in the path from released budget to realized USDG.

Rejected: the owner requires one real pack cycle and a small dashboard in the first version.

### Build the complete automated product in Phase 1

Pros:

- Scheduling, ranking, routes, support, and analytics would be available at launch.

Cons:

- Reversible product work would delay the demand test.
- More integrations and policy decisions would expand the failure surface before demand is known.

Rejected: the owner prioritizes the smallest working release and later offchain updates.

### Put marketplace execution in the hook

Pros:

- One contract could appear to coordinate the entire loop.

Cons:

- External marketplace, custody, and routing behavior cannot safely run inside a swap callback.
- An immutable adapter would bind the project to changing offchain interfaces.

Rejected: only custody and accounting invariants belong in the immutable hook.

### Use the Collector Crypt Base EVM path

Pros:

- The Operations side already uses EVM-compatible Robinhood infrastructure.

Cons:

- It is not the owner-selected Collector Crypt production path.
- It would still require cross-chain asset conversion while introducing a second EVM integration that is unnecessary for the first proof.

Rejected: the owner selected Solana mainnet USD Coin rather than Base for the Phase 1 pack subloop.

## Evidence

- Collector Crypt's official Solana Gacha API documents USD Coin pack purchases, one-pack transaction generation, idempotent opening, standard buyback within the eligibility window, transaction submission, and memo-keyed status reconstruction: <https://docs.collectorcrypt.com/gacha/api>.
- Circle's official address registry identifies Solana mainnet USD Coin as `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`: <https://developers.circle.com/stablecoins/%75%73%64%63-contract-addresses>.
- The exact mutable API responses, selected pack, generated transaction instructions, and cross-chain routes remain release bindings. Release evidence re-verifies the fixed Circle USD Coin identity rather than selecting another mint.

## Consequences

- Phase 1 now proves the complete economic loop instead of a synthetic substitute.
- Marketplace and dashboard code remain replaceable without changing the hook.
- The small durable journal is required for exactly-once external intent handling; broader unattended orchestration remains deferred.
- External actions still require exact owner authorization.
- The fixed Solana marketplace and conversion paths require current Collector Crypt, Solana USD Coin, and route evidence before a real cycle.
- Later phases cannot reserve V1 selectors or storage for deferred features.
