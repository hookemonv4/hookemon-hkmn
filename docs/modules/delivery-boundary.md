# Delivery Boundary

## Purpose

The delivery boundary preserves completed Phase 1 and Phase 2 records and opens Phase 3 for the revision-65 Operations-wallet architecture. It classifies Phase 3 work without granting a live-action authority.

## Public interface

- `product/delivery-boundary.json` declares the open delivery phase and per-record sidecars.
- `checkDeliveryBoundary(rootPath)` validates the manifest as a read-only control check. An exact
  unsigned P1-011 renewal reports both its pending owner signature and the missing owner-authorized
  rebind path while the result remains fail-closed.
- Every active Phase 3 requirement has one Phase 3 sidecar.
- The coordinator regenerates registry projections and their digests at the serial integration checkpoint.

## Invariants

- Phase 1 and Phase 2 remain `COMPLETE`; Phase 3 remains `OPEN`.
- The checker accepts only delivery phases 1, 2, and 3 with their exact active phase maps and rejects every other value.
- Every registered record has one stable identifier and one delivery-phase classification.
- Generated registries and receipts remain outside ordinary module-card edits.
- The checker reads gate-run projections when they are present and does not write repository files.
- A Phase 3 classification does not establish code readiness, `launchEligible`, or permission for an external action.
- An unsigned task-deferral renewal never replaces the projected owner authority. The current task
  CLI rejects an already deferred prestate, and the draft approval binds a noncanonical descriptor
  path, so an owner signature alone cannot record the renewal.

## State transitions

An approved record enters the open Phase 3 boundary with one Phase 3 sidecar. It can contribute to code readiness only after its evidence is current. It can contribute to `launchEligible` only after all launch prerequisites are current and separately authorized.

## Operational commands

Run `node scripts/check-delivery-boundary.mjs` to validate the active delivery boundary. Run `node scripts/check-cleanroom.mjs .` before handoff.

## Recovery pointers

If a record lacks a Phase 3 sidecar or a registry digest is stale, repair the manifest and
regenerate the affected projections at the serial checkpoint. OPEN FACT: the task ledger has no
owner-authorized operation that renews an already deferred task, and the unsigned approval hashes
the draft descriptor path rather than the required canonical path. Add a rebind operation that
validates the existing deferral, emits canonical descriptor and approval bytes, and appends the
renewal receipt. Until then, retain the unsigned draft and the failing boundary result; an owner
signature alone is insufficient. Do not misclassify a record into an earlier phase to make a stale
checker pass.
