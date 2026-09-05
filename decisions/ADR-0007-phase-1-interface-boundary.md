# ADR-0007: Phase 1 interface boundary

## Status

Accepted by the owner on 30 August 2026. Superseded by ADR-0013 (thin production V1 boundary).

## Context

The PRD describes an ordered three-phase product. The current specification must not make future marketplace, ranking, automation, or UI choices operative before their own discovery and approval.

## Decision

- Make this specification normative only for Product Phase 1.
- Let Phase 1 accept funded entitlement roots, counts, proofs, snapshot references, policy references, and artifact hashes without computing holder ranking, LP ownership, routes, packs, marketplace actions, or observation cutoffs.
- Keep scheduler, external-cycle execution, holder cohort computation, APIs, dashboards, and support interfaces outside Phase 1.
- Preserve only the minimum Phase 1 ABI and event constraints required for future consumers.
- Start Product Phase 2 with a fresh v4 Spec revision and new owner approval after the Phase 1 interface and evidence handoff closes.
- Defer the holder-facing onchain verification product to Product Phase 3 while exposing verifiable Phase 1 state now.

## Alternatives

### Specify the entire product now

Pros:

- A single document would contain every intended feature.

Cons:

- Provider and marketplace facts are not bound.
- Future decisions would silently become Phase 1 obligations.

Rejected: the owner requires a fresh specification when Product Phase 2 opens.

### Omit future-consumer fields from Phase 1

Pros:

- A smaller initial ABI.

Cons:

- Phase 2 could require changing the immutable payout interface.

Rejected: Phase 1 must freeze a neutral commitment and proof boundary, not future algorithms.

## Consequences

- Product Phase 2 remains closed and non-operative.
- The immutable Phase 1 ABI is algorithm-neutral.
- Future UI and automation can evolve without changing Phase 1 entitlement state.
