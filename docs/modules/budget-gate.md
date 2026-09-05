# Budget Gate

## Purpose

`packages/runner/src/automation/budget-gate.mjs` converts observed atomic USDG reserve inputs into
one conservative cycle release decision. It does not read wallets, mutate state, or sign.

## Public interface

- `decideCycleBudget(input)` accepts exact canonical-string inputs for available reserve, pack
  price, outbound cap, return cap, operating margin, and active cycle id.
- It returns `READY` with `releaseAmount`, `ACTIVE_CYCLE`, or `INSUFFICIENT_PROCESS_LIABILITY`.

## Invariants

- The release amount is `packPrice + outboundCap + returnCap + operatingMargin` using `BigInt`.
- All values are unsigned canonical decimal strings and the computation rejects uint256 overflow.
- An active cycle prevents a new release regardless of available reserve.
- In production composition, the persisted maximum unit price supplies the pack-price cap and the
  policy engine checks the resulting release against all remaining controls.

## State transitions

The module is pure. It creates no ledger entry; policy admission records any production reservation.

## Operational commands

```sh
node --test packages/runner/test/automation/budget-gate.test.mjs
```

## Recovery pointers

- Treat a non-ready result as a wait condition, not a reason to lower a cap automatically.
- Reconcile observed reserve and active-cycle state before retrying a budget decision.
