# ADR-0001: Clean-room Programmable Robinhood baseline

## Status

Accepted by the owner on 30 August 2026. Evidence note (2026-08-30): live discovery spike SPIKE-R53-PROGRAMMABLE-CHAIN-4663 found chain 4663 unsupported as a production launch target (feasibility/integration-spikes.json, tracked as RT-BLD-01).

## Context

The repository history contains an earlier product implementation. The owner clarified that it is not the target system.

The target is a dedicated Programmable Launchpad on Robinhood Chain (chain ID `4663`) with a desired USDG/HKMN market. The exact Robinhood launch interfaces are not yet officially bound.

## Decision

- Rebuild from a clean active source tree.
- Treat historical commits only as recoverable technical reference.
- Fix the target network to Robinhood Chain ID `4663`.
- Use USDG/HKMN as the desired project market.
- Implement the owner policy of an inclusive 3.00% USDG quote-volume fee allocated as 0.10% Programmable, 0.40% treasury, and 2.50% process budget.
- Keep the token and fee-and-payout trusted surface immutable and non-upgradeable.
- Keep bridge, marketplace, holder ranking, scheduling, and user interfaces outside swap callbacks.
- Fail closed on all provider-dependent behavior until official Programmable Robinhood bindings exist.
- Keep Phase 2 and Phase 3 closed until their predecessor handoffs pass.
- Require a separate authorization for any signing, broadcast, launch, or spend.

## Alternatives

### Continue adapting the historical repository in place

Pros:

- More files appear immediately reusable.

Cons:

- Old addresses, assets, roles, provider assumptions, evidence, and runtime boundaries remain easy to mistake for current truth.
- Review cannot distinguish new evidence from inherited evidence.

Rejected: the owner explicitly removed the historical architecture and documentation from the new product source.

### Use a different standard launch profile

Pros:

- A documented standard path may require fewer custom bindings.

Cons:

- It is not the owner-selected Programmable launchpad or USDG/HKMN market.
- It changes the fee and payout economics.

Rejected: it is a different product.

### Guess the future Programmable Robinhood interface from previous-chain material

Pros:

- Provider-dependent code could begin earlier.

Cons:

- Chain, asset, Factory, Registrar, hook admission, fee semantics, and code hashes may differ.
- A guessed integration can pass local tests while being undeployable.

Rejected: provider-dependent behavior must use official Robinhood evidence.

## Consequences

- The active tree starts small.
- Historical code is still accessible through Git history.
- Provider-independent accounting, payout, and tests can proceed.
- Deployment integration remains blocked until official bindings exist.
- All new evidence is attributable to the clean-room release.
