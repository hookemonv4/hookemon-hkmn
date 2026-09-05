# Requirements Revision 55 Proposal

## Status

Approved by the owner on 31 August 2026. The owner approved the manual one-cycle Phase 1 design and then gave the unambiguous release instruction `freigeben`.

## Base

- Previous approved requirements revision: `54`
- Approved requirements revision: `55`
- Removed active requirement: `REQ-dashboard-1`
- Permanently reserved requirement ID: `REQ-dashboard-1`

## Exact revision 54 to 55 field diff

No requirement field changes except the paths listed below.

### `/revision`

- Revision 54: `54`
- Revision 55: `55`

### `/requirements[id=REQ-release-evidence-4]/statement`

- Revision 54: `A local or fork run first proves launch-ready initialization, one canonical HKMN buy, exact fee accounting, one process release, sum-bound payout funding, one or more holder payments, dashboard verification, and deterministic replay of pinned fixtures for both conversions and the Collector pack, open, and buyback sequence. No fixture proves a real external action. One separately authorized and capped live cycle then binds one continuous cycle identifier and receipt chain across at least one real canonical HKMN buy, its exact fee split, process release from the resulting accrued process liability, the fixed Robinhood-USDG-to-Solana-USD Coin route, one configured non-turbo Collector Crypt Solana pack purchase and open, one standard finalized buyback, the fixed Solana-USD Coin-to-Robinhood-USDG return, payout funding from that exact returned USDG, at least one holder payment from that exact payout, and dashboard verification.`
- Revision 55: `A local or fork run first proves launch-ready initialization, one canonical HKMN buy, exact fee accounting, one process release, sum-bound payout funding, one or more holder payments, final reconciliation, and deterministic replay of pinned fixtures for both conversions and the Collector pack, open, and buyback sequence. No fixture proves a real external action. One separately authorized and capped live cycle then binds one continuous cycle identifier and receipt chain across at least one real canonical HKMN buy, its exact fee split, process release from the resulting accrued process liability, the fixed Robinhood-USDG-to-Solana-USD Coin route, one configured non-turbo Collector Crypt Solana pack purchase and open, one standard finalized buyback, the fixed Solana-USD Coin-to-Robinhood-USDG return, payout funding from that exact returned USDG, at least one holder payment from that exact payout, and final reconciliation.`

### `/requirements[id=REQ-release-evidence-4]/measurement`

- Revision 54: `The evidence bundle separates local or fork fixture results from the live receipt bundle. The live bundle binds one cycle identifier to release SHA, canonical swap transaction and executed USDG volume, exact fee and process-liability deltas, process-release transaction, binding-manifest digest, chain and asset identities, addresses, blocks or slots, conversion receipts, Collector memo and API snapshot, decoded purchase and buyback transactions, Solana signatures, exact Operations USDG and Solana-wallet USD Coin balance deltas, NFT custody transitions, distribution artifact digest, payout-funding transaction, at least one holder-payment transaction referencing that payout, dashboard assertions for the same cycle and payout, measured gas, and exact owner-approved USDG, USD Coin, SOL, and other involved native-gas caps.`
- Revision 55: `The evidence bundle separates local or fork fixture results from the live receipt bundle. The live bundle binds one cycle identifier to release SHA, canonical swap transaction and executed USDG volume, exact fee and process-liability deltas, process-release transaction, binding-manifest digest, chain and asset identities, addresses, blocks or slots, conversion receipts, Collector memo and API snapshot, decoded purchase and buyback transactions, Solana signatures, exact Operations USDG and Solana-wallet USD Coin balance deltas, NFT custody transitions, distribution artifact digest, payout-funding transaction, at least one holder-payment transaction referencing that payout, final contract, receipt, manifest, and entitlement reconciliation, measured gas, and exact owner-approved USDG, USD Coin, SOL, and other involved native-gas caps.`

### `/requirements[id=REQ-phase-boundary-1]/statement`

- Revision 54: `Phase 1 contains the immutable money kernel, one operator-triggered fixed Collector Crypt Solana-mainnet USD Coin pack-and-buyback path, a deterministic distribution compiler, a permissionless payment worker, and a minimal read-only website dashboard. The hook itself contains no scheduler, holder ranking, LP ownership calculation, marketplace call, route logic, pack policy, sale logic, API, dashboard setting, or user-interface behavior.`
- Revision 55: `Phase 1 contains the immutable money kernel, one manually started one-shot runner for the fixed Robinhood-USDG-to-Solana-USD Coin route, one operator-selected Collector Crypt Solana pack purchase and open, one standard buyback, the fixed Solana-USD Coin-to-Robinhood-USDG return, exact payout funding, a deterministic distribution compiler, and a permissionless payment worker. Dashboard, user interface, scheduler, continuous operation, catalog persistence, route optimization, and multi-pack execution are deferred to Phase 2. The hook itself contains no scheduler, holder ranking, LP ownership calculation, marketplace call, route logic, pack policy, sale logic, API, dashboard setting, or user-interface behavior.`

### `/requirements[id=REQ-dashboard-1]`

Revision 54 contained the following active record; revision 55 removes the complete record from the active requirements array:

```json
{
  "id": "REQ-dashboard-1",
  "kind": "functional",
  "title": "Minimal read-only loop dashboard",
  "statement": "Given finalized chain state and published cycle and distribution artifacts, when the Phase 1 website dashboard loads, then it shows the canonical market identity, fee liabilities, process release, pack-cycle result, payout funding, and paid or unpaid entitlement state without holding a signing key. Edge case: a stale, missing, malformed, or conflicting source is shown as unavailable or inconsistent and is never replaced by invented success data.",
  "measurement": "Browser integration tests compare every displayed field with pinned chain and artifact fixtures, exercise stale, missing, malformed, and conflicting sources, and verify that the delivered website contains no signing key, transaction broadcaster, or privileged write path.",
  "module": "dashboard",
  "status": "approved"
}
```

`REQ-dashboard-1` is permanently reserved. It cannot be reused for a different requirement or reintroduced as an active Phase 1 requirement.

## Unchanged authority

All other revision-54 requirement bytes remain unchanged, including fixed HKMN supply, provider bindings, fee formulas and rounding, cycle-runner and payout requirements, money roles, `REQ-canonical-market-5`, the zero static LP fee, and permanent non-project-controlled launch-position custody. The fixed manual path remains:

`canonical HKMN buy -> exact fee split -> process release -> Robinhood USDG to Solana USD Coin -> one Collector pack purchase and open -> standard buyback -> Solana USD Coin to Robinhood USDG -> exact payout funding -> holder payment -> final reconciliation`

## External-action boundary

This approval changes repository requirements only. It does not authorize credential access, API mutation, signing, broadcast, deployment, bridge transfer, marketplace action, launch, canary execution, or spending. Every such action still requires separate exact owner authorization with destinations, amounts, minimum receives, and caps.
