# Peg Cycle Vault

## Purpose

This module remains retained source evidence for the former cycle-custody design. The content-addressed Phase 3 deployment manifest excludes its runtime, so it has no role in the Operations-wallet money path.

## Public interface

- The source and its historical interfaces remain available only for reproducible review.
- The Phase 3 deployment manifest must record zero runtime entries for this module.
- No Phase 3 control, claim, outbound action, return attribution, or holder payout calls this interface.

## Invariants

- The module is `FROZEN_NOT_DEPLOYED` for Phase 3.
- No active Operations-wallet cycle holds funds here.
- Source inspection, compilation, or local tests do not create deployment, signing, broadcast, or spending authority.
- A manifest entry for this runtime makes `launchEligible` false.

## State transitions

The module has no Phase 3 execution state. Its only allowed manifest classification is `FROZEN_NOT_DEPLOYED`.

## Operational commands

Run `node scripts/check-cleanroom.mjs .` after changing retained source documentation. Review the content-addressed deployment manifest before evaluating `launchEligible`.

## Recovery pointers

If a proposed manifest includes this runtime, reject that manifest and restore the zero-runtime classification. Do not route funds through retained source code to repair a Phase 3 failure.
