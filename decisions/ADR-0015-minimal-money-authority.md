# ADR-0015: Minimal money authority

## Status

Accepted by the owner on 30 August 2026. Supersedes ADR-0004, ADR-0006, and ADR-0011.

## Context

The previous design used admin, treasury, Operations, and automation roles plus pause, cap, policy, specification-hash, replacement, and recovery controls. V1 needs fewer authorities while preserving recoverability for the two operational money roles and preventing arbitrary destinations.

## Decision

- Keep the Programmable beneficiary and share immutable.
- Freeze each treasury beneficiary when its fee liability accrues.
- Let the current Operations account release each new process cycle only to itself. Freeze that Operations identity into the cycle and require it to fund every payout referencing that cycle, even after a later Operations handover.
- Let any caller submit a valid payout proof, with the committed recipient fixed as destination.
- Give treasury and Operations one two-step successor handover each: the current account proposes and only the proposed nonzero successor accepts.
- Bind every production treasury and Operations identity to an exact owner-approved address, custody-control record, and recovery procedure in release evidence. Do not make a particular wallet implementation or account type part of the hook.
- Apply each handover only to future treasury accrual or creation of new process cycles. Preserve historical liabilities and the funding authority bound to every released cycle, payout, and paid bit.
- Remove the generic admin, automation role, pause state, process cap, policy registry, specification hash, arbitrary release destination, and emergency withdrawal authority.
- Keep spend authorization and the small cycle preflight in offchain evidence rather than hook state.

## Alternatives

### Keep the complete previous role and policy matrix

Pros:

- Pause, replacement, policy activation, and dedicated automation controls would be available immediately.

Cons:

- It adds privileged selectors, storage, transitions, and cross-role tests unrelated to the first product proof.

Rejected: deferred controls must not enlarge the immutable V1 surface.

### Make treasury and Operations permanently fixed addresses

Pros:

- No role-transition code would be required.

Cons:

- Loss or retirement of either account could strand future authority at an immutable hook.
- Recoverability would depend completely on the selected wallet's external custody and recovery controls.

Rejected: two narrow handovers are small and keep the hook operable across account changes.

### Make process release and payout funding permissionless

Pros:

- No Operations availability dependency would remain.

Cons:

- Arbitrary callers could choose cycle timing, reserve identifiers, or force unwanted commitments.
- Payout funding must reconcile actual net proceeds held by Operations.

Rejected: the owner selected the Operations wallet for operational cycle actions.

## Consequences

- The hook has no general-purpose administrator.
- Operations remains a high-risk role, but it can receive only accrued process budget and can fund payouts only with its own USDG.
- An Operations handover cannot strand a released cycle because the releasing account retains funding authority for that cycle.
- Treasury and Operations handovers require monitoring and exact negative tests.
- Exact address, custody-control, and recovery evidence becomes a production release dependency without adding a wallet-integration dependency to the hook.
- Offchain signing, marketplace spending, and authorization remain outside the contract and ask-first.
