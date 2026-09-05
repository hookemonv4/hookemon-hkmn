# ADR-0002: Launchpad token issuance and initial allocation

## Status

Accepted by the owner on 30 August 2026.

## Context

Phase 1 needs immutable HKMN issuance parameters without importing any historical token behavior. The exact Programmable Robinhood Launchpad interface remains an official-binding dependency.

## Decision

- Create HKMN through the officially bound Programmable Launchpad mechanism.
- Fix total supply at `420,690,000,000 HKMN` with no later minting.
- Use 18 decimals when supported. If the official mechanism mandates another canonical value, bind that value through compatibility evidence before release.
- Allocate 90% to the canonical USDG/HKMN market and 10% to treasury, with no presale or other initial allocation.
- Require an officially supported, evidence-bound lock or vesting mechanism for the treasury allocation. If none exists, leave that allocation undistributed.
- Keep name `Hookemon`, symbol `HKMN`, and the no-blacklist, no-confiscation, no-transfer-tax, non-upgradeable constraints.

## Alternatives

### Predeploy HKMN outside the Launchpad

Pros:

- Token implementation could begin without the final Launchpad interface.

Cons:

- It may not satisfy Programmable admission or atomic-launch requirements.
- It creates a second deployment path.

Rejected: the owner selected Launchpad creation as the only production path.

### Make the treasury allocation immediately transferable

Pros:

- No lock integration is required.

Cons:

- It weakens the owner-approved launch constraint and increases custody risk.

Rejected: treasury tokens require an officially supported lock or remain undistributed.

## Consequences

- Token implementation remains blocked until the Launchpad binding is official.
- The supply and allocation are fixed product requirements.
- A mandatory Launchpad decimals value is a compatibility fact, not an agent-chosen change.
