# Collector Crypt Adapter

## Purpose

`packages/adapters/src/collector-crypt.mjs` is a dependency-injected client for the Collector Crypt gacha API. It validates documented request and response lower bounds, adds a per-attempt deadline, and keeps provider mutations single-attempt. It never signs, broadcasts, or treats a provider response as settled chain evidence.

## Public interface

- `createCollectorCryptClient({ apiKey, baseUrl?, fetchImpl?, dryRun?, maxAttempts?, baseDelayMs?, maxDelayMs?, sleep?, readRetryableStatuses?, mutationRetryableStatuses?, timeoutMs? })` returns a frozen client. `timeoutMs` is a positive safe integer and applies to each HTTP attempt.
- Read methods: `getMachines()`, `getStatus()`, `getBuybackAvailable({ nft, wallet? })`, `getBuybackCheck({ memo })`, `getPackStatus({ memo })`, and `getNfts({ code?, rarity?, page?, limit? })`.
- Mutation methods: `generatePack(request)`, `openPack({ memo })`, `buyback(request)`, and `submitTransaction({ signedTransaction })`.
- `computeCollectorCryptRequestDigest(endpoint, request)` creates the canonical request digest used by the durable stage journal. `hasDryRunFlag(argv?)` recognizes an explicit dry-run flag.
- `COLLECTOR_CRYPT_SETTLEMENT_ASSET` identifies the documented six-decimal Solana settlement asset
  used when parsing Collector buyback amounts. Purchase and buyback additionally require the
  configured settlement asset to match `MoneyConfigurationV1` before a signer is called.
  `parseCollectorMachineContains(value)` accepts a non-negative safe integer or numeric string and
  rejects every other machine card-count shape.
- Errors are `CollectorCryptError`, `CollectorCryptTimeoutError`, and `CollectorCryptDryRunRefusalError`.

## Invariants

- Every request carries `x-api-key`. Mutation requests also carry a deterministic `x-idempotency-key`, but that header is client-only and is not verified as provider-side deduplication.
- Read requests may retry transient network and configured HTTP failures. Every mutation receives exactly one HTTP attempt. `mutationRetryableStatuses` must be an empty array; callers cannot enable a blind retry.
- A timeout, disconnect, or non-success mutation response can follow provider acceptance. The client raises an error and leaves `SENT_UNKNOWN` versus a definitive outcome to the durable lifecycle owner; it never issues a replacement mutation.
- The in-memory overlap map can collapse identical concurrent calls in one process. It provides no crash recovery or cross-process idempotency guarantee.
- `dryRun: true` refuses all mutation methods before a network call but leaves read methods available.
- Requests and documented response fields are strictly validated. `getNfts` requires pagination metadata when a page or page size is requested, while an unpaged read accepts the documented `{ nfts }` response. Prize tiers are numeric 1 through 4. `getBuybackAvailable(...).amount` and `buyback(...).refundAmount` are converted to `{ chainId, assetId, decimals, amountAtomic }` for the documented Solana settlement asset. A type drift holds as unverified, while unknown nested `pack/status` fields remain opaque.
- A selected machine's `contains` field accepts a non-negative safe integer or numeric string and is parsed only during purchase planning. The planner records the expected count, and the current single-award open path refuses a fan-out it cannot independently reconcile.
- An `openPack` response that carries an award must carry `nft_address` and either `transaction_signature` or `transactionSignature`; snake-case signatures are normalized to `transactionSignature`. Waiting and already-opened responses with no award remain valid provider observations but cannot complete the stage alone. A response-recorded or guarded-retry open without a memo-bound mint holds `HELD_DATA_UNVERIFIED` in the stage journal.
- The [EVM API documentation](https://docs.collectorcrypt.com/gacha/evm-api) says that calling `openPack` twice returns the same award. Its scope is EVM-only and never relaxes the durable request and reconciliation rule. The Solana lifecycle therefore never retries automatically: after `SENT_UNKNOWN`, it may make one guarded call only when the request digest binds the completed purchase memo and the returned `nft_address` agrees with fresh memo-bound status evidence.
- A present `getBuybackCheck` record requires the documented wallet, card, signature, amount, timestamp, and status fields. Lifecycle reconciliation treats a missing record or the documented empty pending status as unresolved, holds unknown statuses, and requires an exact completed record before it accepts finalized chain deltas.
- The public read-only capture at `packages/adapters/test/fixtures/collector-crypt/live-2026-09-04/public-readonly-capture.json` records that the permitted machine URL returned HTML, not a live JSON schema. Buyback values use configured Solana stablecoin base units with six decimals. `insured_value` is usable only when persisted reconciliation proves its unit against the machine `instantBuyback` percentage; absent, contradictory, or unreconciled evidence is `HELD_DATA_UNVERIFIED`. Lifecycle code must hold rather than infer those facts.

## State transitions

The client has no durable state. A stage persists its request digest before calling a mutation and
reconciles a lost response through memo-correlated read endpoints plus finalized chain evidence.
Buyback reconciliation uses `getBuybackCheck({ memo })` to bind the completed provider record before
checking card transfer and settlement deltas. This client only returns validated provider
observations and cannot advance a cycle from `SENT_UNKNOWN` to reconciled. The open-stage
sent-unknown exception owns its memo, card, and mutation-guard checks; a missing memo-bound mint
holds rather than inferring a card. Purchase and buyback decode the provider transaction, require a
matching `MoneyConfigurationV1` settlement asset, cap the decoded priority fee, and check the
configured lamport reserve plus maximum priority fee before signing. Those stages do not make this
client a generic signed-byte recovery or rebroadcast authority.

## Operational commands

```sh
cd packages/adapters && npm ci --ignore-scripts
node --test --test-timeout=120000 test/collector-crypt.test.mjs
```

## Recovery pointers

- Use the runbooks for a [mutation timeout](../runbooks/collector-timeout.md),
  [already-opened result](../runbooks/collector-already-opened.md),
  [unknown-open missing mint](../runbooks/collector-missing-mint-sent-unknown.md),
  [blocked buyback](../runbooks/collector-blocked.md), or
  [schema drift](../runbooks/collector-schema-drift.md). Each recovery contract records the
  supported resume command or its absence.
- Fixture-only coverage lives in `packages/adapters/test/collector-crypt.test.mjs` and `packages/adapters/test/fixtures/collector-crypt/`.
- On a mutation timeout or lost response, do not call the same endpoint again. The only narrow exception is the open-stage memo-bound retry described above. Query the memo-bound status endpoint for the affected operation and inspect persisted chain evidence from the stage journal. For buyback, use `getBuybackCheck({ memo })`; do not treat a later availability quote as proof of the original sale.
- If a response validator fails, update it only after a current authenticated provider example or documentation establishes the new field shape. Do not relax validation to accept an unknown economic value.
- Documentation excerpts and their URLs are recorded in `packages/adapters/test/fixtures/collector-crypt/docs-evidence-2026-09-04.json`. The unresolved Solana insured-value unit remains an OPEN FACT and is reconciled at the epic gate rather than inferred by this client.
