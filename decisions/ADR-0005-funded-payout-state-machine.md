# ADR-0005: Funded payout and entitlement state machine

## Status

Accepted by the owner on 30 August 2026. Superseded by ADR-0014 (sum-bound permissionless payouts).

## Context

Holder entitlements must never exceed actual USDG funding, and automatic settlement, emergency claims, and recipient replacement must share one replay-safe state.

## Decision

- Create a payout only through an atomic funding call that transfers the actual USDG and commits a unique payout identifier, origin cycle, root, funded total, recipient count, policy reference, snapshot reference, artifact hash, and readiness time.
- Bind every proof leaf to chain, hook, payout identifier, leaf index, original recipient, and amount.
- Treat direct USDG transfers as no entitlement.
- Preserve `funded = paid + unpaid` for every payout.
- Allow automatic settlement immediately and make it resumable, idempotent, and recipient-failure isolated.
- Apply one claim boundary to every unpaid entitlement: unavailable before `readyAt + 300 seconds`, available exactly once at and after the boundary, and never expiring.
- Let the owner/admin manually replace the active recipient only for one explicitly failed and unpaid entitlement. No holder signature is required by the contract.
- Scope replacement to the exact origin cycle, payout identifier, and leaf. Preserve original identity and amount, revoke the previous recipient's access to that entitlement, and emit complete old/new state.
- Expose read-only state and events for independent verification; defer holder-facing UI to Product Phase 3.

## Alternatives

### Permit immediate claims after an automatic failure

Pros:

- A failed recipient could recover sooner.

Cons:

- It creates a second timing rule and a race with retry settlement.

Rejected: the owner selected one uniform 300-second boundary.

### Require a holder-signed replacement authorization

Pros:

- Replacement authority would be cryptographically delegated.

Cons:

- It adds signature formats, smart-wallet compatibility, nonce state, and support friction.

Rejected: the owner selected a manual owner/admin support process.

### Replace a wallet globally

Pros:

- One update could affect every entitlement.

Cons:

- It could redirect unrelated past or future payouts.

Rejected: replacement is intentionally scoped to one exact entitlement.

## Consequences

- One paid/unpaid flag prevents double payment across every path.
- Support workflow remains adaptable offchain while the entitlement change is verifiable onchain.
- Phase 1 must provide complete read methods and events but no product UI.
