# Legacy Custody Family

## Purpose

The legacy-custody-family module records the former custody, route, commitment, settlement, and sum-tree source family as frozen evidence. It is deliberately outside the Phase 3 deployment topology.

## Public interface

- There is no Phase 3 production entry point for this module.
- `assertLegacyFamilyExcluded()` is the deployment-manifest check that proves its absence.
- Source hashes may be read for audit, but source evidence cannot create a runtime authority.

## Invariants

- Runtime count is zero in every Phase 3 deployment manifest.
- No member of the family holds Phase 3 process liability, position custody, or holder payout authority.
- Frozen source is not a migration path, fallback, withdrawal path, or execution adapter.

## State transitions

- The family remains `FROZEN_NOT_DEPLOYED` throughout Phase 3.
- A source-hash audit can confirm retained evidence without changing that state.
- Any proposal to deploy a member requires a new approved architecture and a new manifest, rather than an in-place transition.

## Operational commands

- Verify the content-addressed deployment manifest excludes the complete family.
- Keep source evidence available for audit and avoid invoking it in rehearsal or production workflows.
- Escalate a proposed runtime dependency to the architecture decision process.

## Recovery pointers

- If a candidate manifest includes this family, reject the candidate and rebuild the manifest.
- Do not repurpose frozen interfaces to recover an interrupted Phase 3 cycle.
- Use the CycleRepository journal and direct-payout records for Phase 3 recovery instead.
