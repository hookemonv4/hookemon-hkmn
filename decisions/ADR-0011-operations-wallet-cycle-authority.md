# ADR-0011: Operations-wallet cycle authority

## Status

Accepted by the owner on 30 August 2026. Superseded by ADR-0015 (minimal money authority).

## Context

The approved role matrix assigned process releases to the operations role and funded settlement to automation, but it did not identify the caller and payer for payout commitment or the caller that may bind a future owner-approved process policy and cap. It also allowed a release commitment to carry a destination without fixing that destination to a role. These choices affect the immutable Phase 1 authorization surface and cannot remain implicit.

## Decision

- Use the current operations wallet as the exclusive caller and USDG payer for atomic payout funding and commitment.
- Use the current operations wallet as the exclusive onchain caller that may record or change the Product Phase 2 specification hash, process-release policy hash, and cap.
- Require fresh Product Phase 2 specification and exact owner approval as offchain release evidence. The hook authenticates operations and records the submitted tuple; it does not pretend that repository approval artifacts are onchain proofs or introduce an unapproved owner-signature role.
- Require every process-budget release destination to equal the current operations wallet at execution.
- Apply the operations-wallet default only to previously unassigned operational cycle actions. It does not override any explicitly assigned treasury, admin, automation, Programmable-beneficiary, or entitlement-recipient authority.
- Apply operations rotation only to future policy activation, releases, and payout funding; preserve every completed release, funded payout, historical liability, and entitlement.

## Alternatives

### Add dedicated payout-funder and policy-manager roles

Pros:

- Funding and policy activation could be separated from process release execution.
- Compromise impact could be narrowed per operational action.

Cons:

- It adds roles, rotation surfaces, and authorization tests not present in the approved role model.
- More wallets increase operational coordination and configuration risk.

Rejected: the owner selected the existing operations wallet for unassigned operational cycle actions.

### Assign both actions to the admin

Pros:

- The admin already manages role configuration and release pause state.

Cons:

- It expands admin authority into routine money-path execution.
- It mixes governance and operational custody responsibilities.

Rejected: the owner selected the operations wallet rather than the admin.

### Permit arbitrary callers when destination and backing are constrained

Pros:

- No privileged operational caller would be required.
- Anyone could make progress if the operations wallet were unavailable.

Cons:

- Arbitrary callers could reserve payout identifiers, force timing, or submit unwanted commitments.
- A permissionless caller cannot supply USDG from the required operations wallet without separate approval complexity.

Rejected: the owner required operations-wallet control for these actions.

## Consequences

- The operations wallet is a high-risk money-path role even though automation remains settlement-only.
- Caller, payer, release destination, policy hash, cap, and role-rotation boundaries require explicit negative tests.
- Product Phase 2 still requires a fresh specification and owner-approved policy before production release activation.
- A compromised operations wallet could submit an unapproved tuple directly; preventing that requires operational key controls and release monitoring unless a future specification explicitly adds an onchain owner-approval proof.
- Release evidence must fail closed when the recorded tuple does not match the fresh Product Phase 2 specification and exact owner approval.
- Architecture and feasibility may refine semantic interfaces but cannot reassign these authorities without returning to Spec.
