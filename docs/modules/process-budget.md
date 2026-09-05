# Process Budget

## Purpose

Process Budget is frozen compatibility source from an earlier custody design. It is not a Phase 3 runtime module, has no deployment-manifest entry, and cannot receive process liability or execute an external action.

## Public interface

No Process Budget operation participates in the Phase 3 deployed interface. Bounded process claims are defined by Operations Wallet, and all subsequent money mutations are owned by Cycle Repository and Policy Engine.

## Invariants

- The frozen source is excluded by the content-addressed deployment manifest.
- No deployed component may call it, transfer value to it, or use it as custody.
- Its prior records do not authorize a claim, outbound transaction, return credit, payout, or recovery action.
- Reintroducing it requires a new approved architecture, deployment-manifest revision, and feasibility evidence.

## State transitions

The module has no Phase 3 runtime state transition. Any attempted deployment or runtime reference fails deployment-manifest validation.

## Operational commands

Verify that the content-addressed deployment manifest excludes this module and that the runtime dependency graph contains no reference to it.

## Recovery pointers

- Treat a manifest entry or runtime reference as a release-integrity failure.
- Preserve the frozen source for audit only; do not reactivate it to handle an operational incident.
- Resume money movement only through the current Operations Wallet and Cycle Repository controls.
