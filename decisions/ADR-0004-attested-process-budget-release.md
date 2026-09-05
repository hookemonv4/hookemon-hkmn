# ADR-0004: Attested process-budget release

## Status

Accepted for Phase 1 on 30 August 2026. Superseded by ADR-0015 (minimal money authority).

## Context

Marketplace, route, reserve, and execution affordability cannot be recomputed inside the hook. Phase 1 must expose a safe funding boundary without implementing the Phase 2 external cycle.

## Decision

- Keep affordability computation and external execution offchain and outside Phase 1.
- Require each release to bind a unique cycle identifier, amount, policy hash, recipient limit, snapshot reference, operations destination, and release time.
- Allow only the operations role to release an amount no greater than both accrued process liability and the active cap.
- Reject reused identifiers, missing commitment fields, zero destinations, paused releases, or insufficient backing atomically.
- Initialize the production release cap at zero until Product Phase 2 supplies a newly approved policy; a separately authorized disposable canary may use its exact approved cap.
- Permit the admin to pause or resume only new process releases. Trading, fee accrual, fee claims, funded settlement, and emergency claims remain available.

## Alternatives

### Execute marketplace and bridge operations onchain

Pros:

- Fewer offchain attestations.

Cons:

- External APIs, custody, routes, and pricing cannot safely run in a swap callback.
- It expands Phase 1 beyond the approved trusted boundary.

Rejected: external-cycle behavior belongs to a fresh Product Phase 2 specification.

### Allow arbitrary admin withdrawals from process funds

Pros:

- Operationally simple.

Cons:

- It bypasses caps, replay protection, and frozen cycle evidence.

Rejected: every release must be bounded and attributable.

## Consequences

- Phase 1 defines the release interface and invariants, not the external cycle engine.
- Production process funds remain immobile until a Phase 2 policy is approved.
- The canary requires separate spending authorization.
