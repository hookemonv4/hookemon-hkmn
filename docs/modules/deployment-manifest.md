# Deployment Manifest

## Purpose

The deployment-manifest module defines the content-addressed Phase 3 target-template set. It records the three future CREATE2 targets and proves that the former process-contract family is absent from the declared deployed set.

## Public interface

- `release/phase3/deployment-manifest.json` records the HKMN token, `HookemonHook`, and `PermanentPositionCustody`, their source paths, roles, constructor schemas, CREATE2 derivation reference, and manifest digest. The Hookemon tuple ends with `processClaimLimit6h:uint256`, `processClaimLimitMax:uint256`, `processClaimMaxCount:uint256`, and `operationsRotationDelay:uint256`.
- `verifyDeploymentManifest()` in `scripts/verify-deployment-manifest.mjs` recomputes the digest, validates the three-target schema, and rejects an excluded process contract in `deployed`.
- The release address-manifest draft records draft compiler settings and local template-hash evidence. Runtime and initcode hashes in `deployment-manifest.json` remain `null` until a checked-in launch profile, address-bound constructor values, and immutable patches produce the final graph artifacts.
- `PhaseThreeReleasePlan` is a draft-only policy validator. It binds the fixed chain identities, template code hashes, owner allocation, source fee split, and either approved address-order seed tuple; it rejects target addresses, route fields, calldata digests, and runtime assertions until provider derivation is complete. It does not verify deployed runtime or CREATE2 outputs.
- The manifest is evidence only; it grants no deployment, signing, broadcast, or asset-movement authority.

## Invariants

- The manifest digest covers every field except `deploymentManifestDigest` itself.
- `deployed` contains exactly the HKMN token, `HookemonHook`, and `PermanentPositionCustody`.
- The excluded process-contract family remains frozen source evidence and has runtime count zero.
- A verified code artifact does not imply `launchEligible` or authorize a live action.

## State transitions

- A candidate runtime template set becomes a manifest after its entries, exclusions, and digest are recorded. It becomes a final runtime set only after target addresses and immutable values are materialized.
- A manifest becomes verified when its recomputed digest, source references, required targets, and exclusions match.
- A digest mismatch, missing target, or excluded runtime in `deployed` keeps the release outside launch readiness.

## Operational commands

- Run `node scripts/verify-deployment-manifest.mjs` with Node 24.19.0.
- Run `node --test scripts/tests/deployment-manifest.test.mjs` for the checked-in manifest, excluded-contract fixture, and digest-mismatch fixture.
- Compare the manifest digest with release evidence before any launch rehearsal or live-readiness evaluation.

## Recovery pointers

- Rebuild a mismatched manifest from the frozen graph inputs; do not patch a digest.
- Preserve excluded source evidence without placing it in `deployed`.
- When compiler artifacts and address-bound values become final, replace only the null runtime and initcode hash fields, recompute the digest, and rerun the validator.
