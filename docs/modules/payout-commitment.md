# Payout Commitment

## Purpose

This module remains retained source evidence for an on-chain commitment payout design. The content-addressed Phase 3 deployment manifest excludes its runtime. Phase 3 uses a frozen direct-holder payout manifest and per-recipient durable finality instead.

## Public interface

- Retained source interfaces are available for review only.
- The Phase 3 deployment manifest must record zero runtime entries for this module.
- Phase 3 payout preparation uses the direct-payout interface, not an on-chain commitment path.

## Invariants

- The module is `FROZEN_NOT_DEPLOYED` for Phase 3.
- A holder payout manifest becomes immutable after its first broadcast.
- Frozen recipients become explicit quarantine liabilities; they are never silently omitted or redirected.
- A manifest entry for this runtime makes `launchEligible` false.

## State transitions

The module has no Phase 3 execution state. Its manifest classification remains `FROZEN_NOT_DEPLOYED`.

## Operational commands

Run `node scripts/check-cleanroom.mjs .` after changing retained source documentation. Confirm that the deployment manifest excludes this runtime before evaluating payout readiness.

## Recovery pointers

Reject a proposed payout path that invokes this runtime. Resume a direct payout only from its recipient journal, using the same nonce and calldata for a permitted replacement.
