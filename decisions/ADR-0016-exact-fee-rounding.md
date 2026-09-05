# ADR-0016: Exact fee rounding

## Status

Accepted by the owner on 30 August 2026. Supersedes the fee-rounding deferral clauses of ADR-0003 and ADR-0009.

## Context

The approved fee policy allocates 0.10%, 0.40%, and 2.50% of executed USDG quote volume. Integer arithmetic can leave one or two USDG base units unassigned if all three shares are independently rounded down. An immutable hook must define the dust rule before deployment and must never record less or more liability than the USDG it actually collects.

## Decision

For executed USDG quote volume `Q`:

- compute `totalFee = floor(Q * 300 / 10,000)`;
- compute `programmableLiability = floor(Q * 10 / 10,000)`;
- compute `treasuryLiability = floor(Q * 40 / 10,000)`;
- compute `processLiability = totalFee - programmableLiability - treasuryLiability`; and
- require actual collected USDG to equal the three liability increases exactly.

The process liability receives only the integer remainder inside the already bounded total fee. Unsupported provider semantics or any non-exact collection delta fail before liability mutation.

## Alternatives

### Round every share down independently

Pros:

- Each share uses the same direct formula.

Cons:

- The three liabilities may sum to less than the collected total.
- Unassigned dust would accumulate without an owner.

Rejected: every collected base unit must belong to exactly one liability.

### Give rounding remainder to treasury

Pros:

- Treasury would absorb accounting dust.

Cons:

- It would make treasury the residual share despite process budget being the dominant economic allocation.

Rejected: process budget is the residual policy bucket after the two fixed external shares.

### Round shares up

Pros:

- Small swaps could reach nonzero liabilities sooner.

Cons:

- Recorded liabilities could exceed actual collected USDG or the inclusive 3.00% cap.

Rejected: the hook must never overcharge or create unfunded liability.

## Consequences

- Programmable and treasury never receive more than their exact floor shares.
- Process liability may receive at most the small integer remainder needed for conservation.
- Conformance tests must cover every rounding transition and exact collection delta.
- Final deployment still depends on official Programmable fee-custody semantics supporting this policy.
