# Peg Cycle Route Executor

## Purpose

This module remains retained source evidence for a former contract-based outbound route. The content-addressed Phase 3 deployment manifest excludes its runtime; outbound execution is instead governed by the journal, transaction policy, and external Operations signer.

## Public interface

- Retained source interfaces are review-only artifacts.
- The Phase 3 deployment manifest must record zero runtime entries for this module.
- No Phase 3 provider transaction may select this contract as a route target.

## Invariants

- The module is `FROZEN_NOT_DEPLOYED` for Phase 3.
- Provider data never converts this retained interface into an allowlisted route.
- Transaction policy semantically decodes and positively allowlists every outbound transaction before an external signature.
- A manifest entry for this runtime makes `launchEligible` false.

## State transitions

The module has no Phase 3 execution state. Its manifest classification remains `FROZEN_NOT_DEPLOYED`.

## Operational commands

Run `node scripts/check-cleanroom.mjs .` after changing retained source documentation. Review the deployment manifest and transaction-policy allowlist before evaluating an outbound action.

## Recovery pointers

Reject a provider route that refers to this runtime. Reconcile an unresolved outbound action from its journal and signed bytes; do not substitute this retained route as a retry path.
