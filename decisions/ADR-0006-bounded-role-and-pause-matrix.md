# ADR-0006: Bounded role and pause matrix

## Status

Accepted by the owner on 30 August 2026. Superseded by ADR-0015 (minimal money authority).

## Context

Phase 1 needs operational control without allowing any role to rewrite immutable economics or historical claims.

## Decision

- Keep the Programmable beneficiary and 0.10% share immutable; it can claim only its accrued liability.
- Let the current treasury receive its own accrued 0.40% liabilities and proven surplus.
- Let the admin manage two-step admin and treasury transitions, future operations and automation wallets, the narrow process-release pause, and exact-entitlement recipient replacement.
- Let operations submit only bounded process releases.
- Let automation settle only funded entitlements.
- Let each current recipient claim only its own unpaid entitlement after the 300-second boundary.
- Use proposal and acceptance by the proposed nonzero address for admin and treasury transfers.
- Apply operations and automation changes immediately, emit complete events, and affect only future actions.
- Never pause supported trading, fee accounting, fee claims, funded settlement, or emergency claims.

## Alternatives

### Use one omnibus owner role

Pros:

- Fewer access checks.

Cons:

- Compromise grants unrelated money-moving capabilities.
- Operational responsibilities cannot be independently constrained.

Rejected: capabilities must follow the approved role matrix.

### Pause every contract operation

Pros:

- A single switch appears simple during incidents.

Cons:

- It could freeze trading accounting and already funded holder rights.

Rejected: pause authority is limited to new process-budget releases.

## Consequences

- Authorization tests require a caller-by-operation matrix.
- Historical liability ownership is unaffected by role transitions.
- Incident response cannot suspend already funded holder access.
