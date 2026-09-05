# ADR-0010: Treasury-only surplus recovery

## Status

Accepted by the owner on 30 August 2026. Superseded by ADR-0014 (sum-bound permissionless payouts).

## Context

ADR-0003 defines mathematically proven unsolicited USDG surplus and fixes its destination to the current treasury. ADR-0006 defines the bounded role matrix but does not assign the authority that initiates surplus recovery. Phase 1 must assign that authority explicitly without allowing any caller to redirect or consume recorded liabilities.

## Decision

- Only the current treasury role may initiate surplus recovery.
- Recovery always pays the current treasury address active when the recovery executes.
- The recoverable amount is limited to a positive actual USDG balance minus every recorded liability.
- Admin, operations, automation, the Programmable beneficiary, entitlement recipients, and arbitrary callers cannot initiate recovery.
- Treasury rotation changes initiation authority and destination only after the proposed nonzero treasury accepts through the approved two-step transition.

This ADR supplements ADR-0003 and ADR-0006 with the previously unspecified caller authority.

## Alternatives

### Let the admin initiate recovery

Pros:

- The admin could coordinate recovery with other operational actions.

Cons:

- It expands the approved admin capability set.
- A compromised admin could trigger an unrelated treasury operation.

Rejected: the owner selected the current treasury as the only recovery initiator.

### Let any caller initiate recovery

Pros:

- No privileged transaction sender would be required.
- The fixed destination and solvency bound would still prevent caller theft.

Cons:

- Arbitrary callers could force recovery timing and create unwanted events.
- Treasury would lose control over when surplus is reconciled.

Rejected: the owner selected treasury-controlled initiation.

## Consequences

- Authorization tests must reject every non-treasury caller without balance or liability mutation.
- A completed treasury handover immediately transfers future recovery authority to the new treasury.
- Surplus destination, amount bounds, and global solvency remain unchanged from ADR-0003.
