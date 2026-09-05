# Holder Settlement

## Purpose

This module remains retained source evidence for a former on-chain holder settlement design. The content-addressed Phase 3 deployment manifest excludes its runtime. Phase 3 settles directly to a finalized eligibility snapshot through the Operations EVM identity.

## Public interface

- Retained source interfaces are review-only artifacts.
- The Phase 3 deployment manifest must record zero runtime entries for this module.
- Phase 3 payout operations are `preparePayout`, `signPayout`, `broadcastPayout`, `finalizePayout`, and `quarantineFrozenRecipient` from the direct-payout module.

## Invariants

- The module is `FROZEN_NOT_DEPLOYED` for Phase 3.
- Eligibility freezes before an Operations claim at a finalized block and proves log completeness.
- Each recipient result is tied to an exact finalized balance delta.
- A manifest entry for this runtime makes `launchEligible` false.

## State transitions

The module has no Phase 3 execution state. Its manifest classification remains `FROZEN_NOT_DEPLOYED`.

## Operational commands

Run `node scripts/check-cleanroom.mjs .` after changing retained source documentation. Verify the eligibility and direct-payout records before evaluating payout readiness.

## Recovery pointers

Reject a proposed deployment that includes this runtime. Quarantine an inaccessible recipient and preserve its liability; do not reintroduce this retained settlement path.
