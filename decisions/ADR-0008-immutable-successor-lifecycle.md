# ADR-0008: Immutable successor lifecycle

## Status

Accepted by the owner on 30 August 2026.

## Context

The production hook is non-upgradeable, but a future independently specified deployment may eventually replace it for new activity.

## Decision

- Provide no proxy upgrade, delegatecall replacement, state migration, or state-import path.
- Introduce any successor as a separate deployment under a new specification, provider binding, review, and owner approval.
- Keep the original hook available indefinitely for its historical fee claims, funded payouts, and unpaid holder claims.
- Never copy or move historical liabilities, payout identifiers, or entitlement state into a successor.
- Let a successor handle only newly bound activity.
- Permit a later product interface to display multiple generations together.
- Never promote a disposable canary into production.

## Alternatives

### Deploy behind an upgradeable proxy

Pros:

- Logic could change at the same address.

Cons:

- It violates the approved immutable trust model.
- An upgrade authority could alter fee and payout rules.

Rejected: production behavior is intentionally non-upgradeable.

### Migrate balances and claims to a successor

Pros:

- Users would see one active deployment.

Cons:

- Migration can omit, duplicate, or redirect liabilities.
- Old proof domains would no longer match their original custody boundary.

Rejected: the owner selected old-hook continuity with no liability migration.

## Consequences

- Old and new claims may coexist at separate addresses.
- Historical rights remain bound to their original code and funding.
- Multi-generation display is a later product concern.
