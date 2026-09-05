# Phase Boundary

## Purpose

The phase-boundary module records Delivery Phase 3 as open for requirements revision 65 and architecture revision 9. It keeps code readiness, `launchEligible`, separate live-action authorization, and actual execution distinct.

## Public interface

- `product/delivery-boundary.json` declares Phases 1 and 2 complete and Phase 3 open.
- `feasibility/refresh-architecture-projections.mjs` binds the architecture Markdown projections to their exact bytes and offers a read-only `--check` mode.
- `repairMergeEligible` is a code and integration-repair result.
- `launchEligible` requires provider admission, the exact deployment graph, current operational canaries, and every separately authorized live prerequisite.
- Signing, broadcast, deployment, spend, custody mutation, and publication remain separate actions.

## Invariants

- Technical evidence never authorizes an external action.
- The declared Phase 3 deployment-manifest path remains provisional until a bound digest exists; the retained custody family remains forbidden. A generic frozen authority cannot reactivate that family: a separately approved runtime interface is required.
- Read-only fixture and test profiles may load while the deployment authority is provisional. Every
  live signer or mutation boundary must reject that authority until its frozen status and digest exist;
  imports, probes, and read-only reconciliation remain available.
- The one CycleRepository and policy engine govern every money mutation.
- A held-card state, failed canary, paused policy, or absent live prerequisite makes `launchEligible` false.

## State transitions

Phases 1 and 2 remain complete. Phase 3 is open for scoped work while its interfaces are provisional pending feasibility. A passing repair gate can establish code readiness; only complete launch prerequisites can establish `launchEligible`; neither state authorizes a live action.

## Operational commands

Run `node scripts/v4.mjs status` to inspect the current projected phase records. Run `node feasibility/refresh-architecture-projections.mjs --check` before validating the open Phase 3 boundary with `node scripts/check-delivery-boundary.mjs`. Run `node scripts/check-cleanroom.mjs .` before handoff.

## Recovery pointers

If evidence, a canary, or the deployment graph changes, clear the affected readiness result and re-evaluate it. Do not close Phase 3 or treat an open delivery record as permission to sign, broadcast, deploy, spend, or publish.
