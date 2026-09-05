# Hookemon Product Phase 3 Capability Map

## Authority and scope

- Normative requirements source: revision `65` in `specs/requirements.json`.
- Architecture revision: `9`.
- This map records the proposed Operations-wallet money path. It does not authorize signing, broadcasting, deploying, spending, or publication.
- `consumer -> provider` means the consumer requires the provider's output, authority, or interface. Providers never call back into consumers.
- Amounts are `{chainId, assetId, decimals, amountAtomic}`. Atomic amounts are integer strings. Chain-4663 USDG and Solana stablecoins are separate assets.

## Deployment model

Phase 3 deploys one immutable token runtime, one immutable hook runtime, and one permanent position-custody runtime. The 2.5% process share is claimed by the current Operations EVM identity under the hook's bounded claim policy. A distinct Operations Solana identity performs the Solana leg. The content-addressed deployment manifest is authoritative for this runtime set.

The legacy custody family is frozen source evidence, not a Phase 3 runtime. It includes the former vault-coordination, per-cycle escrow, route, on-chain commitment, settlement, and Merkle components. The manifest must reject every member of that family.

The hook exposes `beforeInitialize`, `beforeSwap`, `afterSwap`, and the two return-delta callbacks at mask `0x20CC`. Only hook-self initialization inside the atomic provider graph transaction is permitted. That graph deploys the token, custody, and hook targets; allocates the complete HKMN supply through `token.allocate(hook)`; configures custody; initializes the fixed-price pool; and stamps launch. A separate owner-signed atomic seed transaction pulls at most 240 USDG through Permit2, mints and settles the complete HKMN allocation to custody, returns unused USDG to the payer, and reverts on any HKMN residual. Before seed success, HKMN held at the hook cannot transfer to anyone else and swaps remain unavailable because there is no liquidity.

## Stable module map

| Stable module ID | Capability | Placement | Direct providers consumed | Primary Phase 3 requirements |
| --- | --- | --- | --- | --- |
| `phase-boundary` | Keeps code readiness, launch readiness, owner authority, and live action distinct. | Offchain control | None | `REQ-phase3-deployment-1` |
| `provider-binding` | Binds provider facts, graph admission, fee policy, and readiness. | Offchain control | None | `REQ-provider-binding-4` |
| `deployment-manifest` | Proves the runtime set and exclusion of the legacy custody family. | Offchain control | `provider-binding` | `REQ-phase3-deployment-1` |
| `role-control` | Controls Treasury, Operations, beneficiary claims, limits, pause, and rotation. | Immutable hook runtime | None | `REQ-operations-wallet-1..3` |
| `token-core` | Creates fixed-supply HKMN through the admitted launch path. | Token runtime | `provider-binding` | `REQ-token-core-1..4` |
| `canonical-market` | Authenticates the canonical market, initialization, gross volume, and whole-fill swaps. | Immutable hook runtime and position custody | `token-core`, `role-control` | `REQ-canonical-market-7` |
| `fee-accounting` | Maintains solvent 10/40/250 liabilities and lifetime remainders. | Immutable hook runtime | `canonical-market`, `role-control` | `REQ-fee-accounting-9` |
| `operations-wallet` | Releases bounded process liability to Operations, retains immutable claim history, and supports a Treasury-only delayed emergency rotation. | Immutable hook runtime and external identities | `fee-accounting`, `role-control` | `REQ-operations-wallet-1..3` |
| `launch-orchestration` | Performs an atomic provider graph transaction and a separate retryable atomic owner-signed seed transaction. | Immutable launch runtime | `provider-binding`, `token-core`, `canonical-market`, `fee-accounting`, `operations-wallet` | `REQ-launch-orchestration-1..2` |
| `legacy-custody-family` | Keeps the excluded legacy family frozen and non-deployed. | Frozen not deployed | None | `REQ-phase3-deployment-1` |
| `adapters` | Provides dependency-injected EVM and Solana client seams. | Offchain adapter library | None | `REQ-transaction-policy-1` |
| `hook-contract-client` | Builds typed Phase 3 hook calls and reads. | Offchain adapter library | `adapters`, `operations-wallet` | `REQ-operations-wallet-1..2` |
| `robinhood-rpc-client` | Reads and broadcasts pre-signed EVM transactions. | Offchain adapter library | `adapters`, `provider-binding` | `REQ-eligibility-snapshot-1` |
| `solana-rpc-client` | Builds and observes typed Solana transactions. | Offchain adapter library | `adapters`, `provider-binding` | `REQ-cycle-runner-3` |
| `relay-bridge-client` | Treats bridge output as untrusted data and settles persisted Relay legs only from own-RPC finalized deltas. | Offchain adapter library | `adapters`, `provider-binding` | `REQ-cycle-runner-3` |
| `collector-crypt-adapter` | Validates documented pack, open, and buyback data, including reconciled insured-value units. | Offchain adapter library | `adapters`, `provider-binding` | `REQ-collector-crypt-adapter-1` |
| `transaction-policy` | Uses the runner's canonical schema, explicit typed minima, and mandatory gas caps before external signing. | Offchain control | `provider-binding`, `adapters` | `REQ-transaction-policy-1` |
| `cycle-repository` | Holds immutable cycle modes, durable attempts, Relay legs, authority reservations, wallet nonce locks, custody observations, and recovery state. | Offchain control | `operations-wallet` | `REQ-cycle-repository-1` |
| `policy-engine` | Applies caps, explicit production minima, holds, manual approval, pause, loss, and canary controls. | Offchain control | `cycle-repository`, `transaction-policy` | `REQ-policy-engine-1..2` |
| `cycle-runner` | Runs the nine ordered money-path stages; outbound uses claimed principal and return uses only cycle-attributed proceeds. | Offchain execution | `cycle-repository`, `policy-engine`, `transaction-policy`, `eligibility-snapshot`, provider clients | `REQ-cycle-runner-3` |
| `eligibility-snapshot` | Freezes holder eligibility and feasibility before claim. | Offchain control | `robinhood-rpc-client`, `cycle-repository` | `REQ-eligibility-snapshot-1` |
| `direct-payout` | Executes per-holder direct transfers with durable signed records, same-nonce recovery, quarantine, and dust carry. | Offchain execution | `eligibility-snapshot`, `cycle-repository`, `policy-engine`, `transaction-policy`, `signing` | `REQ-direct-payout-1` |
| `signing` | Uses only external Operations EVM and Solana signers. | Offchain control | `transaction-policy` | `REQ-transaction-policy-1` |
| `automation` | Drives policy-gated work without a second state authority. | Offchain execution | `cycle-runner`, `policy-engine` | `REQ-policy-engine-1` |
| `scheduler` | Schedules only policy-gated runner stages. | Offchain execution | `automation` | `REQ-policy-engine-1` |
| `observability` | Persists deduplicated held and drift alerts. | Offchain control | `cycle-repository`, `policy-engine` | `REQ-policy-engine-2` |
| `composition-root` | Wires one repository, policy engine, adapter set, signer pair, and network profile. | Offchain control | execution and control modules | `REQ-cycle-repository-1` |
| `dashboard` | Shows authoritative state and maps controls to repository actions. | Offchain control | `composition-root` | `REQ-dashboard-2`, `REQ-policy-engine-1` |
| `release-evidence` | Separately evaluates code readiness and `launchEligible`. | Offchain control | deployment, runner, payout, and alert evidence | `REQ-release-evidence-7` |
| `website` | Presents bound status and the eventual swap route without wallet authority. | Offchain public interface | `dashboard`, `release-evidence` | `REQ-canonical-market-7` |

## Dependency direction

The topological order is:

1. `phase-boundary`, `provider-binding`, `role-control`
2. `deployment-manifest`, `token-core`, `adapters`
3. `canonical-market`, `transaction-policy`
4. `fee-accounting`, `signing`
5. `operations-wallet`, `legacy-custody-family`
6. `launch-orchestration`, provider clients, `cycle-repository`
7. `policy-engine`, `eligibility-snapshot`
8. `cycle-runner`, `direct-payout`
9. `automation`, `scheduler`, `observability`
10. `composition-root`, `dashboard`, `release-evidence`, `website`

No callback edge can move from an offchain client into a provider of its own authority. The repository owns all money mutation state, immutable cycle modes, and durable attempt records. The policy engine evaluates every irreversible boundary before signing. The signer pair does not hold data-store authority, and the dashboard never signs or broadcasts.

## Readiness boundary

`repairMergeEligible` is a code and integration-repair gate. `launchEligible` additionally requires provider admission, an exact deployment graph, current operational canaries, and all separately owner-gated live prerequisites. Neither value is an authorization to act.

## CONFUSION FEE-01

Recorded verbatim from the approved planning record:

> **CONFUSION FEE-01:** Discovery v4 verlangt 20 bps an `0xD885…79da` (`enforcement: not-guaranteed-onchain`, Basis/Rundung/Claim `null`); Owner-Entscheidung 10 bps an `0x4957…76c` per Absprache. Optionen: (A) 10 bps bestätigt (Owner-Aussage, Nachweis via WP00b) — Plan-Default; (B) 20/40/240 in 300; (C) 20/40/250 = 310; (D) andere Route. Nur fee-/graphabhängige WPs (WP01ff.) warten auf die Bestätigung; alles andere läuft.
