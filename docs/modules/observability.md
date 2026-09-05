# Observability

## Purpose

Observability provides canary readback and a fail-closed live startup gate. It evaluates pinned chain and provider evidence, reports unsafe conditions through one webhook client, and keeps persistent alert dedupe separate from the CycleRepository money journal.

## Public interface

- `createObservability(config, deps)` in `packages/adapters/src/app/observability.mjs` returns
  `{ logger, runUsdgStatusCanary, runPreSignatureCanaries, runStartPreflight, close }`.
- `runUsdgStatusCanary({ destinations })` reads the USDG pause state and freeze state for
  Operations and supplied destinations. Production composition invokes it before an active cycle's
  next mutation; a paused or frozen result holds the cycle `HELD_UNAVAILABLE` before signing.
- `runPreSignatureCanaries(context)` returns `{ ok, drift }`. It is the request-bound signing guard: its caller must invoke it immediately before each irreversible signature and must not call the signer when `ok` is `false`.
- `runStartPreflight()` runs before a live service starts. It checks config completeness, a usable durable alert sink, each required sign-only `probe()`, and positive EVM and Solana RPC evidence.
- `createCanonicalPoolStateReader({ evmClient, poolManager })` reads the canonical pool slot through `IExtsload` and returns `{ protocolFee, lpFee }` as `bigint` values.
- `runPreSignatureCanaries` accepts expected values at `config.canaries`, readers, destination accounts, one freshness record, persisted operator state, and custody readback. The composition root refuses live service calls when this configuration is absent or its start preflight fails.

`config.canaries.nativeGasReserves` uses typed integer amounts:

```js
{ chainId, assetId, decimals, amountAtomic }
```

`amountAtomic` is a canonical unsigned integer string. The configured reserve list contains exactly one native EVM reserve for the configured chain and one native Solana reserve.

The pre-signature canary verifies all of the following from current readback:

- chain ID;
- USDG proxy implementation pointer, proxy runtime hash, implementation runtime hash, and decimals;
- PoolManager, PositionManager, configured router, configured quoter, and optional StateView runtime hashes;
- USDG pause state and freeze state for operations and every supplied destination;
- hook treasury and operations roles plus the cycle-specific Operations binding for the configured cycle;
- canonical pool protocol and live LP fees are both zero;
- provider policy digest;
- EVM pending nonce or the request's still-valid Solana blockhash, with bigint-safe block-height comparison;
- native gas reserves above configured minimums;
- persisted pause, kill, and loss-limit state; and
- custody with no unattributed balance.

The PoolManager reader computes `keccak256(abi.encode(poolId, bytes32(6)))` and calls `extsload(bytes32)`. The pinned v4-core artifacts identify `POOLS_SLOT` as `6`; the fee bit positions are cross-checked by [CanonicalMarket.sol](packages/contracts/src/market/CanonicalMarket.sol:142) and [BlindCanonicalMarketAdapter.t.sol](packages/contracts/test/blind/market-fees/BlindCanonicalMarketAdapter.t.sol:42).

The composition root runs start preflight before every live service entry point and refuses a live
service call without observability configuration. This is a startup gate. Its production mutation
boundary also runs the USDG status canary against the active cycle. The broader decoder-backed
pre-signature canary remains a request-bound signing integration boundary.

## Invariants

- Missing, malformed, stale, contradictory, or unreadable evidence produces a drift. A signing
  wrapper that invokes the canary must refuse the signature; production composition also converts
  USDG pause or freeze drift into an active-cycle hold before the stage handler runs.
- A drift contains a stable code, target, expected value, observed value when safe, and an actionable recovery step.
- One configured webhook is the only outbound alert sink. Startup requires a successful operational probe of its durable SQLite state and delivery client.
- Alert dedupe uses a SQLite file containing only non-secret alert keys and timestamps. It is not a money-state authority.
- Logging emits one JSON object per line with `debug`, `info`, `warn`, or `error` level. Registered event names and schemas reject unknown events or fields. Webhook endpoints, credential-shaped fields, bearer values, raw signed payloads, binary values, and keychain references are rejected or redacted before any logger or webhook receives them.
- The status projection remains read-only and cannot advance a cycle or clear an alert.

## State transitions

For each stable alert key, the persistent record is `CLEAR`, then `PENDING`, `DELIVERED`, and `RESOLVED` after a current successful check. A failed delivery stays `PENDING` for retry. A `DELIVERED` condition stays suppressed until verified recovery. Legacy `ALERTED` rows migrate conservatively to `DELIVERED`. The pending lease covers the complete configured webhook retry budget.

## Operational commands

Run the scoped checks:

```sh
node --test --test-timeout=120000 packages/runner/test/observability/canaries.test.mjs packages/runner/test/observability/alert-webhook.test.mjs packages/runner/test/observability/logger.test.mjs packages/runner/test/observability/protocol-fee-monitor.test.mjs
cd packages/adapters && npm ci --ignore-scripts && node --test --test-timeout=120000 test/app/observability.test.mjs test/app/compose.test.mjs
node scripts/check-cleanroom.mjs .
```

## Recovery pointers

The owning signing path must remain unavailable while a drift is present. Re-read the pin, provider policy, signer readiness, custody preconditions, or chain state that produced it; only a current successful canary resolution re-arms a delivered alert.

OPEN FACT: the final signer guard needs decoder-derived request context, signer identity, authoritative configuration and custody readback, durable nonce or blockhash reservation, and the wallet-wide lock. The signing-boundary owner can resolve this by passing that immutable context to `runPreSignatureCanaries()` immediately before each signer call; live composition already fails closed at startup.

OPEN FACT: scheduler, terminal, degraded-return, and pool-fee observations are not yet routed through the persistent reporter. The owner of those event sources can resolve this by sending their authoritative records through the reporter and adding restart coverage; the mapper and durable delivery state are available now.

OPEN FACT: provider-policy comparison needs an authoritative source and a canonical digest preimage. Until an approved interface defines both, the injected reader remains a fail-closed comparison seam rather than an independent live authority.

Use the [incident index](../runbooks/README.md) for the failure-specific safe
stop, recovery boundary, and escalation record. The direct canary recoveries
are [USDG paused](../runbooks/usdg-paused.md), [USDG frozen](../runbooks/usdg-frozen.md),
[nonzero pool fee](../runbooks/pool-protocol-fee.md), [stale Solana blockhash](../runbooks/solana-blockhash-expiry.md),
[EVM nonce interference](../runbooks/evm-nonce-interference.md), and
[unattributed custody](../runbooks/unattributed-deposit.md). The status output
does not carry this evidence and cannot authorize a recovery.

The [relay bridge client](relay-bridge-client.md), [Collector adapter](collector-crypt-adapter.md),
[transaction policy](transaction-policy.md), [Robinhood RPC client](robinhood-rpc-client.md),
[holder snapshot indexer](holder-snapshot-indexer.md), [cycle repository](cycle-repository.md),
[policy engine](policy-engine.md), and [direct payout](direct-payout.md) cards link directly to
their incident-specific runbooks.
