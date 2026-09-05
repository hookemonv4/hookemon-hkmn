# ADR-0014: Sum-bound permissionless payouts

## Status

Accepted by the owner on 30 August 2026. Supersedes ADR-0005, ADR-0010, ADR-0012, the surplus-recovery clause of ADR-0003, and the settlement-batch-sizing clause of ADR-0009.

## Context

The previous payout state machine included authorized batches, a 300-second claim boundary, explicit failure state, recipient replacement, surplus recovery, and recipient-limit metadata. Those features enlarge the immutable surface. A normal Merkle root is not a safe simplification because it does not prove that all valid leaf amounts sum to the funded total, and a root alone cannot recreate proofs after the dashboard disappears.

## Decision

- Let Operations choose a unique `bytes32` payout identifier before the distribution root is built.
- Commit through one canonical depth-10 Merkle-sum tree with 1,024 indexed positions, index-derived path bits, distinct leaf and node domain tags, canonical padding, and the paid key `(payoutId, index)`.
- Bind the canonical-manifest digest, chain, hook, cycle, payout identifier, index, recipient, and amount into every nonempty leaf.
- Require the committed root sum and exact inbound USDG balance increase to equal the funded total.
- Bind the canonical-manifest digest into every leaf and the funding event, and require two independently fetched digest-matching publication copies before funding preflight may submit the transaction.
- Use one immediate, non-expiring, permissionless per-entitlement payment function. Any caller may submit a proof, but payment always goes to the committed recipient.
- Use one paid bit per leaf and one global money-path reentrancy boundary.
- Revert the complete entitlement call on a false, reverted, malformed, short, or excess USDG balance delta.
- Omit authorized batch state, a special emergency mode, the 300-second boundary, explicit failed state, recipient replacement, recipient-limit fields, and privileged surplus recovery from V1.

## Alternatives

### Use a normal Merkle root plus a funded total

Pros:

- Standard proof libraries are widely available.
- Proof verification is simpler.

Cons:

- The root does not prove that all valid leaves sum to the funded total.
- Early claims could exhaust a malformed underfunded distribution.

Rejected: every committed entitlement must be fully backed by construction.

### Store every entitlement onchain during funding

Pros:

- Funding could assign an explicit balance to each recipient.
- Proof publication would not be required.

Cons:

- Funding gas grows linearly with the cohort.
- Storage cost and deployment assumptions would constrain later offchain cohort sizes.

Rejected: a sum-bound commitment preserves full backing with a small onchain surface.

### Keep automatic batches, delayed claims, and admin replacement

Pros:

- The contract could distinguish worker settlement, self-service recovery, and support intervention.

Cons:

- Multiple modes add timing, role, replacement, and replay state.
- A permissionless function already lets a worker sponsor holder payments immediately.

Rejected: one payment path meets the V1 outcome with fewer immutable states.

## Consequences

- The offchain compiler and independent verifier become security-critical release artifacts.
- Distribution bytes must remain available independently of the Hookemon website.
- A wrong recipient cannot be changed in V1; the entitlement remains funded and unpaid.
- Direct USDG transfers may remain stranded because V1 has no privileged recovery path.
- Payment cost is bounded per proof rather than by an onchain batch-size state machine.
- The immutable technical capacity is 1,024 indexed positions; V1 has no configurable Top-N product setting.
