# Requirements Revision 54 Proposal

## Status

Approved by the owner on 30 August 2026. The hash-bound spec-gate receipt is the authority record.

## Base

- Previous approved requirements revision: `53`
- Approved requirements revision: `54`
- Added requirement: `REQ-canonical-market-5`

## Rationale

Revision 53 fixed the initial 90 percent HKMN market allocation but left the resulting Uniswap v4 position rights unspecified. Red-team review showed that a transferable or withdrawable position could remove the canonical market despite an immutable token and hook. The owner selected permanent non-withdrawable custody, a zero static LP fee, and only the existing inclusive 3.00 percent Hookemon hook fee.

## Added requirement

| Requirement | Purpose |
| --- | --- |
| `REQ-canonical-market-5` | Keep the 90 percent launch position permanently outside project control, keep normal trading available, set the LP fee to zero, and prohibit any second trading fee or position-withdrawal authority. |

## Exact approved behavior

- The canonical PoolKey static LP fee is zero.
- The approved inclusive 3.00 percent Hookemon hook fee is the only trading fee on the canonical route. No protocol, router, provider, integrator, token-transfer, or other surcharge may supplement it; network gas is separate.
- The launch position representing 90 percent of HKMN is permanently non-transferable and non-withdrawable by every project role and arbitrary caller.
- The custody restriction does not freeze user balances or prevent valid buys and sells.
- The position exposes no approval, liquidity-decrease, principal-withdrawal, fee-collection, rescue, upgrade, delegatecall, or successor-control path.
- The remaining 10 percent allocation and every other revision-53 requirement remain unchanged.

## Owner approval

The owner approved the exact proposal in German:

`90 % HKMN dauerhaft und nicht entziehbar im USDG/HKMN-Pool, LP-Fee 0 %, ausschließlich die genehmigte 3 %-Hook-Fee. Arbeite weiter, lass die Agenten jetzt alle laufen ohne Fragen.`

This approval changes no external-action authority. Signing, broadcast, deployment, liquidity seeding, spending, secret access, and publication still require separate exact authorization.
