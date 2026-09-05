# ADR-0003: Segregated USDG liabilities

## Status

Accepted by the owner on 30 August 2026. The surplus-recovery clause is superseded by ADR-0014 and the fee-rounding deferral clause by ADR-0016; the rest remains applicable.

## Context

One immutable hook holds USDG for Programmable fees, treasury fees, process budget, and funded holder payouts. A shared token balance must never imply shared withdrawal rights.

## Decision

- Maintain separate ledgers for Programmable, treasury, process-budget, and funded-payout liabilities at one hook address.
- Freeze the Programmable and treasury beneficiary identities when each fee liability accrues.
- Permit each claim path to reduce only its own liability by the successful transfer amount.
- Maintain `actual USDG balance >= total recorded liabilities` across every state transition.
- Treat direct transfers as unaccounted surplus, never as a liability or payout.
- Permit recovery only of positive `actual balance - total recorded liabilities`, and only to the current treasury.
- Defer exact gross/net, LP interaction, exact-output, partial-fill, and rounding mechanics to the official provider fee binding while preserving the approved inclusive 3.00% split.

## Alternatives

### Use one undifferentiated project balance

Pros:

- Fewer storage fields.

Cons:

- One beneficiary could consume another beneficiary's backing.
- Historical ownership would be ambiguous after role rotation.

Rejected: liability isolation is a binding product invariant.

### Use separate custody contracts

Pros:

- Physical token balances would mirror accounting domains.

Cons:

- It expands the trusted surface and contradicts the single-hook custody boundary.

Rejected: Phase 1 keeps custody and accounting at one immutable hook address.

## Consequences

- Every money-moving path must preserve global and per-domain conservation.
- Treasury rotation never rewrites historical liabilities.
- Surplus recovery cannot touch recorded liabilities.
