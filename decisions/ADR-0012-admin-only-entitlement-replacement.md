# ADR-0012: Admin-only entitlement replacement execution

## Status

Accepted as a clarification of the approved Phase 1 role matrix on 30 August 2026. Superseded by ADR-0014 (sum-bound permissionless payouts).

## Context

ADR-0005 described the manual support process as an `owner/admin` replacement action, while the later bounded role matrix in ADR-0006 assigned exact-entitlement replacement to the admin. Phase 1 has no separate onchain owner role. The support decision and the onchain caller must be distinguished without expanding authority.

## Decision

- Keep holder contact and owner coordination outside the protocol.
- Use the current admin as the only onchain caller that may replace the active recipient of one explicitly failed and unpaid entitlement.
- Reject stale admins and every other role without changing entitlement state.
- Keep replacement scoped to the exact origin cycle, payout identifier, and leaf while preserving original recipient identity and amount.
- Preserve the existing no-signature support process, complete events, independent read access, and repeated-replacement rule after a new explicit failure.
- Treat this ADR as the authority clarification for the `owner/admin` wording in ADR-0005; no separate owner role is introduced.

## Alternatives

### Add a separate onchain owner role

Pros:

- The owner could execute replacement directly without using the admin address.

Cons:

- It adds an authority that is absent from the approved bounded role matrix.
- It creates another key, rotation path, and caller-by-operation surface.

Rejected: the approved role matrix assigns exact-entitlement replacement to the admin.

### Let either owner or admin call through interchangeable addresses

Pros:

- Either support identity could complete the replacement.

Cons:

- The contract would need an additional owner identity and ambiguous precedence between two privileged callers.
- A stale or misconfigured owner address could bypass the current admin boundary.

Rejected: one current admin caller gives the bounded and testable authority already approved.

### Assign replacement to the operations wallet

Pros:

- Routine operational actions would share one wallet.

Cons:

- It would override an explicitly assigned admin capability.
- Compromise of the money-path operations wallet would also gain holder-support authority.

Rejected: the operations-wallet default applies only to previously unassigned operational cycle actions.

## Consequences

- Architecture exposes one admin-authorized replacement command and public read-only verification.
- Rotation tests must reject the stale admin and preserve historical replacement records.
- Owner coordination remains an offchain process and does not imply an onchain owner capability.
