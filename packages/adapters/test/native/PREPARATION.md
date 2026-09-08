# Native bot preparation

Prepared on base 63396266 for ETH-BOT; implementation awaits integrated PR39 and the coordinator's exact interface checkpoint. Proposal ab56f229 is a design input, not authoritative live configuration. No production code has changed. The negative-case JSON files are reviewable fixture specifications, not passing implementation tests or fabricated chain proofs.

## Required execution changes

- `money-schemas.mjs`: native money v2, custody v3, Relay intent/leg v2, destination proof v2. Preserve generic chain attempts, signed-message policy and provider attempts when their semantics are unchanged. Native resume must reject old money identities; history viewing remains possible.
- `state-schema.mjs`, policy engine/wallet/service: USD-named operator limits and cost basis, separate `releaseAmountWei` and `releaseCostMicroUsd`, quote-bound conservative valuation. Do not create another budget helper. Audit all arithmetic consuming the old release scalar before renaming it.
- `robinhood-rpc.mjs`, native proof producer and EVM custody observer: process-local proof authority, canonical receipt/runtime-at-block, claim post-payment event, exact native source/value and separate gas accounting. Relay source evidence is pinned by acce05b4; missing archive runtime proof or order-metadata attribution supplies no credit.
- Claim/outbound: new request versions; one observed native deposit with exact value and orderId, no USDG approval attempt. Keep genuine claim principal, gas reserve and cross-cycle reservations separate.
- Return/payout/supplementary: new native settlement proof, transaction value and liabilities. Preserve explicit zero minimum, refusal/quarantine behavior, frozen snapshot and once-only credit. No USDG transfer log or balance delta substitutes for a native payment.
- Environment/compose: assets.eth, minimums.returnEth, typed 18-decimal native values; preserve Solana USDC, original Collector blockhash resolver, provider co-signatures and immutable message bytes from PR39.

## Nested-record inventory before edits

| Existing record/location | Required treatment |
| --- | --- |
| operator v3 `cycleLedger.releaseAmountMicroUsdg`, `spendLedger.amountMicroUsdg` in state-schema | Operator v4; split native principal from USD commitment; spend ledger records USD valuation basis |
| `hookemon.held-position-evidence.v1` in cycle-repository | Version bump when renaming embedded `costMicroUsdg`/`valueMicroUsdg`; preserve original history |
| Held position validators/public snapshots and policy held-position totals in cycle-repository | Update cost/value units together; no mixing USD valuation with native custody totals |
| `hookemon.return-leg-attribution-context.v1` in money-schemas | Inspect all embedded request/proof semantics; new version if native/token distinction changes fields, otherwise enforce new nested versions |
| `hookemon.outbound-relay-origin-refund-proof.v1` in cycle-repository | Native proof replaces token credit; bump version and bind the trusted producer |
| `hookemon.supplementary-return-request.v1`, request-digest v1, return-attempt v1 in supplementary-money | Native request/digest version required; attempt wrapper may stay only if shape unchanged and nested new version is mandatory |
| supplementary payout state/source/return-boundary/finalized-return/settlement-evidence v1 in supplementary-payout | Inspect explicit fields and embedded token proof; bump affected wrappers, reject old native resume |
| supplementary-finalized-return-binding v1 in supplementary-payout and cycle-repository | Same authoritative native identity/proof contract on both producer and validator; no mixed version acceptance |
| supplementary-direct-payout-plan v1 and supplementary-payout-request v1 | Native transaction values, cost/proof version updates; preserve entitlement and rejected recipient semantics |
| `hookemon.production-execution-accounting.v1` and fixture execution accounting v1 | Review token-specific proof assumptions before deciding version; synthetic evidence cannot become native live authority |
| outbound-quote-refresh-decision v1 in policy-engine | Enforce newly versioned immutable native quote/request; retain original retry class |
| generic provider mutation, chain transaction attempt, wallet nonce reservation, transaction-policy, Collector binding | Preserve unchanged; do not rename by keyword |

Extension candidates outside the assigned bot files: production execution-accounting producers/validators, supplementary buyback cost fields, config-store/API consumers, and their affected tests may require transfer after the interface baseline is frozen. No write ownership is assumed merely because an imported module references old units.

## Relay ALT investigation

`relay-return-instruction-case.json` retains the exact full instruction keys/data, payer and table address from the unsigned scenario response at acce05b4, with its original response SHA256. It has one instruction, ten unique static accounts including the program, one required signer, and a calculated complete legacy wire size of 483 bytes including the signature slot. That is below Solana's 1232-byte legacy limit. This is exact format arithmetic, not an SDK serialization test or an executable packet.

The official Solana [versioned transaction documentation](https://solana.com/docs/core/transactions/versioned-transactions) describes ALT as account-address compression for v0; legacy stores addresses inline. The official [RPC JSON structures](https://solana.com/docs/rpc/json-structures) distinguish full account keys and dynamically loaded table addresses. Relay's preserved [quote API schema](https://api.relay.link/documentation/json) supplies complete unsigned program IDs, account metas and data rather than a co-signed serialized message. Thus compiling these full unsigned instructions with all addresses inline is technically plausible. Provider-specific equivalence has not been established by a Relay statement in this preparation.

Existing `solana-rpc.mjs:buildRelayLegacyTransaction` explicitly refuses a nonempty table list; return admission also insists on no decoded lookup tables. Do not remove either guard merely because the payload appears small. The bounded next verification is to use the pinned web3.js 1.98.4 compiler, retain the original plan/table list, explicitly compile a legacy candidate from every full supplied instruction, serialize within the real limit, decode and compare all instruction bytes, account order, signer/writable flags and payer, and test oversized, incomplete/index-only, mutated and extra-signer cases. Obtain documented Relay-specific justification or an exact provider-supported no-table quote option before enabling the conversion. A size overflow must refuse, never truncate.

This concerns initial compilation of unsigned Relay instructions only. Collector's provider-co-signed legacy message must never be recompiled, have its original blockhash replaced, or have its policy relaxed. No signature, current blockhash or live transaction was generated here.

## Pending executable checks

Turn native-proof-negative-cases.json and runner valuation-negative-cases.json into focused tests against approved producers once the production interfaces exist. Add a positive producer-authenticated proof test from controlled RPC fixtures; do not expose a JSON constructor that grants authority. Source matching at latest, event-name matching and unsigned quotes are insufficient positive live settlement evidence. Validate conservative decimal costs/proceeds with integer arithmetic and quote identity/TTL; persist gas liabilities separately.
