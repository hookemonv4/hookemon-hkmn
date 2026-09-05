# Revision 65 red-team review

## Review contract

This is the third artifact-only red-team cycle. It reviews requirements revision 65 and architecture revision 9 with fresh, read-only inspection. It records issues and executable evidence only. It is not owner approval, deployment authorization, signing authorization, or a release-readiness claim.

The formal gate contract recognizes the eleven carried findings listed below. The review also found one revision 65 issue outside that fixed identifier set. That supplemental finding is recorded separately so the gate schema can be extended without weakening or concealing the result.

## Formal findings

| ID | Severity | Classification | Status | Result |
| --- | --- | --- | --- | --- |
| RT-R55-01 | critical | valid-actionable | RESOLVED | Gate evidence recorders and validators bind semantic inputs and reject forged F3 evidence. |
| RT-R55-03 | high | valid-actionable | RESOLVED | Gate authority is receipt-backed and stale projected state cannot replace an authoritative receipt. |
| RT-R55-04 | high | valid-actionable | RESOLVED | Architecture gate A6 binds the exact module set, revisions, paths, structure, and digests. |
| RT-R58-01 | critical | valid-actionable | OPEN_FAIL_CLOSED | The vault now verifies two payout signatures, but the excluded chunk-commit family still permits an authorizer to replace a funded root without the second signature. |
| RT-R58-02 | critical | valid-actionable | OPEN_FAIL_CLOSED | The production signing path has distinct configured EVM identities, while the excluded legacy distribution family still embeds fixture verification keys and defaults to its fixture profile. |
| RT-R58-03 | medium | valid-actionable | RESOLVED | The active topology removes the incompatible legacy authorizer and trigger composition and refuses a third Operations EVM identity. |
| RT-R58-04 | medium | valid-tradeoff | OPEN_FAIL_CLOSED | The excluded vault family still trusts an authorizer-supplied degraded-return confirmation boolean without a second cryptographic confirmation. |
| RT-R58-05 | high | valid-actionable | RESOLVED | The hook enforces the six-hour rolling Operations exposure bound on-chain without changing the policy spend ledger. |
| RT-R58-06 | high | valid-actionable | RESOLVED | Direct payout persists boundaries, recovers by durable state, prevents a second signature for one recipient and nonce, and quarantines ambiguous outcomes. |
| RT-R58-07 | high | valid-actionable | RESOLVED | The production router and PoolManager path has a pinned mandatory archive-fork proof that fails closed when its endpoint is absent. |
| RT-R58-08 | medium | valid-actionable | RESOLVED | Holder snapshots exclude deployment, custody, beneficiary, and historical role addresses while retaining unrelated recipients. |

### RT-R55-01: generic SYSTEM evidence semantic bypass

The evidence recorder and validator require exact proof schemas and content hashes. The negative gate test rejects forged F3 evidence for blocked spikes. Evidence: `scripts/lib/gates.mjs:213-285`, `scripts/lib/gates.mjs:474-492`, and `scripts/tests/gates.test.mjs:612-635`.

### RT-R55-03: stale red-team authority

Authoritative phase state comes from the receipt chain, not generated projections. Receipt ordering, current hashes, and predecessor authority are recomputed. Evidence: `scripts/lib/gates.mjs:911-996`, `scripts/lib/gates.mjs:1103-1147`, `scripts/verify-release-ready.mjs:748-819`, and `scripts/tests/release-ready.test.mjs:522-531`.

### RT-R55-04: module-index authority

Architecture gate A6 validates the exact module-card set and binds each current card. The negative test rejects reduced sets and stale revision bindings. Evidence: `scripts/lib/gates.mjs:288-416` and `scripts/tests/gates.test.mjs:445-465`.

### RT-R58-01: payout authorization binding

`PegCycleVault.authorizePayout` now verifies independent distribution-signer and verifier signatures. The legacy `PayoutCommitment.commitPayoutChunk` path still accepts a root from the authorizer alone, including after funding, so that family remains excluded from the Phase 3 deployment manifest. Evidence: `packages/contracts/src/process/PegCycleVault.sol:340-381`, `packages/contracts/src/payout/PayoutCommitment.sol:131-170`, `release/phase3/deployment-manifest.json:119-127`, and `scripts/tests/deployment-manifest.test.mjs:195-216`.

### RT-R58-02: legacy distribution verification keys

The active production signing path requires configured identities and keeps fixture keys out of the production module. The excluded legacy runner distribution module still carries public fixture verification keys and a fixture default. It has not been promoted into the release surface. Evidence: `packages/runner/src/distribution/manifest.mjs:11-26`, `packages/runner/src/distribution/manifest.mjs:107-219`, `packages/adapters/src/signing/payout-distribution.mjs:16-20`, `packages/adapters/src/signing/payout-distribution.mjs:95-135`, `packages/adapters/test/signing/payout-distribution.test.mjs:116-147`, and `release/phase3/deployment-manifest.json:119-127`.

### RT-R58-03: incompatible EVM signer roles

The incompatible legacy vault-authorizer and Operations-trigger topology is excluded from the active runtime. The current composition exposes only the approved Operations identities and refuses an extra Operations EVM identity rather than constructing an ambiguous service graph. Evidence: `packages/adapters/src/app/compose.mjs:640-670` and `packages/adapters/test/app/compose.test.mjs:2246-2267`.

### RT-R58-04: degraded-return confirmation

`PegCycleVault.recordDegradedReturn` still trusts an authorizer-provided boolean as evidence of confirmation. The call can quarantine value but cannot redirect it, and the affected process family remains excluded from the release manifest. Evidence: `packages/contracts/src/process/PegCycleVault.sol:466-485`, `release/phase3/deployment-manifest.json:119-127`, and `scripts/tests/deployment-manifest.test.mjs:195-216`.

### RT-R58-05: compromised Operations exposure

The hook enforces a strict six-hour rolling process window and accounts exposure on-chain. Boundary tests cover expiry and replenishment without changing the separate policy spend ledger. Evidence: `packages/contracts/src/HookemonHook.sol:62-80`, `packages/contracts/src/HookemonHook.sol:490-549`, `packages/contracts/src/HookemonHook.sol:638-680`, and `scripts/tests/reqs.test.mjs:33-48`.

### RT-R58-06: durable payout recovery

The direct-payout state machine persists each effect boundary, recovers submitted transactions by nonce and receipt, prevents duplicate signing, and quarantines ambiguous outcomes. Evidence: `packages/adapters/src/app/stages/payout.mjs:557-721`, `packages/adapters/src/app/stages/payout.mjs:1522-1706`, `packages/adapters/src/app/stages/payout.mjs:1795-1829`, and `packages/adapters/test/app/stages-payout.test.mjs:1095-1157`.

### RT-R58-07: production router proof

The release binds the archive fork to a pinned chain and block. The required workflow refuses to run without its configured endpoint, and the fork suite exercises the production PoolManager route. Evidence: `.github/workflows/fork-proof.yml:1-106`, `release/phase3/fork-pin.json:1-42`, `packages/contracts/test/integration/RobinhoodV4ArchiveFork.t.sol:620-763`, and `scripts/tests/workflow-security.test.mjs:159-188`.

### RT-R58-08: holder snapshot exclusions

The snapshot builder excludes deployment and historical role addresses, including prior cycle escrows, without excluding unrelated contract recipients. Evidence: `packages/adapters/src/app/stages/eligibility-snapshot.mjs:99-184`, `packages/runner/src/distribution/snapshot-indexer.mjs:236-368`, and `packages/adapters/test/app/eligibility-snapshot.test.mjs:633-667`.

## Supplemental finding

### RT-R65-01: seed intent is not bound on-chain

Severity: high. Classification: valid-actionable. Status: OPEN_FAIL_CLOSED.

`HookemonHook.seedCanonicalLiquidity` authenticates the launch authority, binds graph-mode custody, and requires the hook's complete current token balance. It still derives the position limits from caller-supplied calldata and forwards caller-selected ticks, liquidity, payer, maxima, and deadline. The contract does not bind those fields to the approved full-range position, 240000000 USDG atomic units, selected liquidity, payer, or a deadline no more than 900 seconds from submission. `PhaseThreeReleasePlan` validates draft constants but rejects materialized seed calldata, so it is not an executable pre-sign or on-chain binding. The package records manual wallet review as the remaining control.

A mistaken or compromised launch authority could therefore lock the complete token supply into a different economic position or draw from a different approved payer. The current package remains fail-closed because the required owner authorization is absent and the address-dependent package is not signable.

Evidence: `packages/contracts/src/HookemonHook.sol:337-370`, `packages/contracts/src/HookemonHook.sol:752-807`, `packages/contracts/script/release/PhaseThreeReleasePlan.sol:119-164`, `packages/contracts/test/integration/LaunchComposition.t.sol:407-513`, `packages/contracts/test/integration/RobinhoodV4ArchiveFork.t.sol:876-897`, `specs/requirements.json:608-614`, `docs/modules/launch-orchestration.md:13-14`, `release/phase3/launch-plan.md:50-69`, and `release/phase3/submission.json:1134`.

Required resolution: bind an immutable seed-intent digest or equivalent payer, tick, liquidity, amount, and deadline fields in the hook before any token transfer; decode and verify the final calldata before signing; and add negative unit and archive-fork mutations for every bound field. The red-team verifier and gate definition must also add this identifier to their enforced finding set.

## STRIDE coverage

| Category | Reviewed risk |
| --- | --- |
| Spoofing | Configured signing identities, legacy fixture verification identities, and production route identity. |
| Tampering | Receipt inputs, module-card authority, payout roots, seed calldata, and snapshot exclusions. |
| Repudiation | Receipt ordering, current revision binding, durable payout boundaries, and transaction recovery. |
| Information Disclosure | Repository evidence was checked for live credentials and signing material; none is recorded by this review. |
| Denial of Service | Degraded-return quarantine, fork-endpoint absence, payout ambiguity, and excluded legacy process paths. |
| Elevation of Privilege | Operations exposure, dual-signature payout authority, release-role separation, and launch seed authority. |

## Termination and release posture

The formal cycle ends with eight resolved findings and three `OPEN_FAIL_CLOSED` findings. RT-R58-01 and RT-R58-04 affect process contracts explicitly excluded by the deployment manifest. RT-R58-02 concerns a retained legacy off-chain distribution module and remains open; its safety cannot be inferred from the contract deployment manifest. RT-R65-01 is supplemental and remains fail-closed through the unsigned, address-pending release package.

The current red-team gate schema cannot express a failed gate whose problems are these finding identifiers because its R1 through R5 items validate artifact presence and hashes only. Fresh evidence receipts will also be required after these artifacts change. The integration owner must update that executable gate path, refresh the phase receipts, and record the owner-controlled S5 authorization before a current red-team gate can be authoritative. The owner review attestation must be created last because it binds the completed repository tree.
