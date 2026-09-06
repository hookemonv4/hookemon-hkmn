# Domain

## Purpose

`packages/domain` is a shared, dependency-free source contract for the public network profile and
public cycle-status projection shape. It is consumed by the runner's own projections and by the
public dashboard view; it has no adapter, runner, dashboard, or web import of its own.

## Public interface

- `packages/domain/src/public-dashboard-profile.js` exports `readPublicDashboardProfile(id)` and
  `publicDashboardNetwork(id)`. Both accept only the `testnet` or `mainnet` profile id and return a
  frozen clone with exactly the `evm` and `solana` network keys.
- `packages/domain/src/cycle-status.js` exports `normalizePublicCycleStatus(status)` and
  `projectPublicCycle(input)`, which validate and project the public cycle-status shape against an
  exact allow-listed key set per section (status, network, cycle, actions, round accounting, cards).
- `cycle-status.js` imports only `public-dashboard-profile.js`; both modules otherwise use Node
  built-ins only.

## Invariants

- An unknown profile id throws `PUBLIC_DASHBOARD_PROFILE_INVALID`. A status or network object
  carrying any key outside its approved set throws `PUBLIC_CYCLE_STATUS_INVALID`.
- Network shape is exactly `{ evm, solana }`; no other or legacy chain key is ever present.
- Untyped legacy settlement fields are never silently relabeled as typed `*MicroUsdg` pack
  economics; only the exact current producer field names are read.

## State transitions

None. Both modules are pure functions over their input; they hold no mutable state and perform no
I/O.

## Operational commands

```sh
node --test packages/domain/test/cycle-status.test.mjs packages/domain/test/public-dashboard-profile.test.mjs
```

## Recovery pointers

- Do not add an adapter, runner, dashboard, or web import into this package; it must stay a
  standalone shared source contract.
- Do not widen an allow-listed key set to accept a retired or legacy field name; add a new field
  under its own name instead.

## Registration note

This card is new; `docs/modules/index.json`'s `modules` array does not yet list `domain`. Per this
extraction's scope, the index registration (id, path, sha256) is reported to the coordinator rather
than applied here. Source dependency extraction only; no deployed behavior is proven by this change.
