# ADR-0017: Permanent zero-LP-fee canonical market

## Status

Accepted by the owner on 30 August 2026.

## Context

Requirements revision 53 assigned 90 percent of HKMN to the canonical USDG/HKMN market but did not define who controls the resulting Uniswap v4 position. A transferable or withdrawable position would let its holder remove the market inventory and paired USDG even though the HKMN token and Hookemon hook are immutable. A separate LP fee would also charge traders in addition to the approved inclusive 3.00 percent Hookemon fee.

## Decision

- Set the canonical PoolKey static LP fee to zero.
- Apply only the approved inclusive 3.00 percent Hookemon hook fee to supported swaps: 0.10 percent Programmable, 0.40 percent treasury, and 2.50 percent process liability including the approved rounding rule.
- Reject any canonical route that adds a protocol, router, provider, integrator, token-transfer, or other trading surcharge. Network gas remains a separate execution cost and is not a trading fee.
- Put the launch position representing the 90 percent HKMN market allocation into permanent non-project-controlled custody.
- Expose no transfer, approval, liquidity-decrease, principal-withdrawal, fee-collection, rescue, upgrade, delegatecall, or project-controlled successor path for that position.
- Keep normal buys and sells available. The custody restriction applies to the launch position, not to user HKMN balances or wallet transfers.
- Treat any provider mechanism that cannot prove these properties as incompatible with the Phase 1 launch.

## Alternatives

### Give the LP position to treasury

Pros:

- Treasury could migrate or recover the position later.

Cons:

- Treasury or a compromised treasury key could remove the market liquidity.
- The onchain market would depend on an ongoing privileged custody decision.

Rejected: the owner selected permanent non-withdrawable market liquidity.

### Use a timelock with a later withdrawal

Pros:

- The position would be protected during launch while remaining recoverable later.

Cons:

- The withdrawal authority would reappear when the timelock expires.
- Users would still depend on a future project-controlled liquidity decision.

Rejected: the owner selected a permanent restriction rather than a delayed privilege.

### Charge an LP fee in addition to the Hookemon fee

Pros:

- The position could earn standard Uniswap LP fees.

Cons:

- Traders would pay more than the approved Hookemon fee policy.
- LP-fee ownership and collection would add another immutable money path.

Rejected: the owner selected a zero LP fee and only the approved 3.00 percent hook fee.

## Consequences

- The canonical market remains tradable while its launch position cannot be removed by a worker, deployer, treasury, Operations, or other project role.
- Pool principal cannot be recovered or migrated from the original position after deployment.
- A defect in the immutable market cannot be repaired by withdrawing the old position; a separately specified successor may be deployed, but the original custody remains unchanged.
- Provider binding and deployment tests must prove normal buy and sell behavior after permanent custody, the absence of every forbidden position-control path, and the absence of every additional trading surcharge.
