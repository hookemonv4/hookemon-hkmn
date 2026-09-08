# Supplementary Buyback

## Purpose

Resells one held card position outside the normal cycle stage sequence: an owner has chosen `sell`
for a card an earlier buyback carved out as held, and the durable supplementary-settlement machine
(`cycle-repository.mjs#advanceSupplementarySettlement`) is waiting in `PREPARED` for this module to
move it to `BUYBACK_SENT_UNKNOWN`. It owns exactly that one transition; the return-bridge
(`BUYBACK_SENT_UNKNOWN -> RETURN_BROADCAST`, `supplementary-money.mjs`) and everything after it is
that module's territory.

## Public interface

- `packages/adapters/src/app/stages/supplementary-buyback.mjs` exports `SUPPLEMENTARY_BUYBACK_STAGE`,
  `createSupplementaryBuybackHandler()`, and `reconcileSupplementaryBuybackSale({ adapters, config,
  cycleRepository, position })`. `createSupplementaryBuybackHandler()` returns the handler shipped as
  `productionSupplementaryStageHandlers.PREPARED`; its `reconcile({ adapters, signerClient, config,
  cycleRepository, context, position, settlement, preflightAuthority? })` consumes exactly the
  capabilities `createStageDriver`'s `runSupplementarySettlement` passes through, never a
  closure-captured substitute. `reconcileSupplementaryBuybackSale` is read-only and safe to call at
  any time, including from the return-bridge handler once this module hands off durable evidence.
- `preflightAuthority` is optional and forwarded unchanged to
  `requireCollectorOnlyMutationAuthority(config, preflightAuthority)` -- the only value it ever
  admits outside a live collector-only rehearsal is the frozen `createTestProfileMutationAuthority()`
  singleton, and only while `NODE_TEST_CONTEXT` is present. The real stage driver never supplies one;
  a production-profile mutation otherwise resolves through the unchanged `requireLiveMutationAuthority()`
  gate (`architecture/interfaces.json` must be `FROZEN_BUILD_CONTRACT_PRODUCTION_INTEGRATION_PENDING`).
- Two mutually exclusive signing seams, resolved fresh per attempt, never mixed: a Collector
  production binding registry (`config.collectorCrypt.productionBindingRegistry` /
  `productionBindingAuthority`, resolved through `signing/collector-production-binding.mjs`'s
  `resolveCollectorProductionBinding` and turned into a canonical policy through
  `signing/collector-buyback-policy.mjs`'s `createCollectorBuybackPolicy`), and the legacy static
  policy (`collectorPolicyForStage(config, 'buyback')` or `config.collectorCrypt.buyback.policy`).
  The production binding requires the real, offline-execution-boundary-checked production profile
  (`assertCollectorOfflineExecutionBoundary`), which refuses any `rehearsal` configuration at all --
  the two seams can never both be reachable from the same config.
- Durable primitives required beyond the read-only supplementary facade:
  `readSupplementaryChainTransactionAttempt`, `prepareSupplementaryChainTransactionAttempt`,
  `recordSupplementarySignedTransactionWithRecoveryContext`, `recordSupplementaryBroadcast`,
  `readSupplementaryChainAttemptRecoveryContext`, and `advanceSupplementarySettlement`. Missing any
  of them fails closed rather than degrading to a weaker memo-lookup-only guarantee.

## Invariants

- A held position resold here is always identified by its own immutable `memo`/`mint`, its own
  owner `sell` decision, and its own position-scoped chain-attempt namespace
  (`buybackAttemptRequestDigest`, keyed by `positionId`/`cycleId`/`memo`) -- never the ordinary
  cycle's own buyback chain-attempt identity or its sold-pack identity.
- The production binding path additionally requires: the held position's memo/mint to match an
  entry in the original cycle's own finalized `open` stage evidence (never trusted from the position
  record alone); that entry's asset kind to be `mpl-core` (the only kind this path can independently
  verify on-chain ownership for); the operator to be the real, finalized on-chain MPL Core owner,
  checked once before the provider is ever asked to generate a transaction and rechecked after that
  provider call returns and again immediately before signing; and the independently configured
  settlement mint/decimals to match the approved binding's own pinned proceeds asset. Any of these
  failing before the provider call is money-safe (nothing sent); failing after leaves the durable
  attempt ambiguous, exactly like every other post-provider-call failure in this module.
- `cycleFacts` fed into `createCollectorBuybackPolicy` are always durable, already-verified data --
  the position's own mint, the freshly re-verified on-chain owner, the operator's independently
  verified settlement account, and the already-quote-matched offer/refund amounts -- never derived
  from the decoded candidate transaction.
- Durable signed-byte revalidation and replay (`broadcastRecordedBuyback`) are bound to the exact
  same frozen `cycleFacts`/`blockhashContext` and the same approved binding's `expectedDigest` this
  attempt was signed under; a registry that no longer resolves the same binding digest refuses the
  reauthorized broadcast rather than silently rebuilding a different policy.
- A pre-send intent (`PREPARED`) is written before the provider mutation is ever attempted. Signed
  bytes and their transaction-policy recovery context are durably recorded before broadcast. A
  restart that finds an already-`PREPARED` (not freshly created) attempt never calls the provider
  again; a restart that finds a `SIGNED` attempt reauthorizes and rebroadcasts the exact recorded
  bytes, never re-signs.
- `reconcileSupplementaryBuybackSale` never invents a result: a still-pending provider record stays
  `PENDING`, and a confirmed-but-conflicting record is `DATA_UNVERIFIED`, never silently adopted.

## State transitions

- `PREPARED` (owner chose `sell`) -> a durable per-position chain attempt `PREPARED` -> `SIGNED` ->
  `BROADCAST` -> confirmed finality -> settlement `BUYBACK_SENT_UNKNOWN`. Any failure before the
  provider call leaves the settlement truthfully `PREPARED`; any failure after leaves the chain
  attempt at its last durable state, resolved only by `reconcileSupplementaryBuybackSale`'s
  memo-keyed provider check on a later call, never by blind resend.
- Recovery-first on every call: `reconcile()` always checks Collector's own memo-keyed record before
  ever attempting a new sale, covering a resale resolved outside this handler's own chain attempt.

## Operational commands

```sh
node --test packages/adapters/test/app/supplementary-buyback.test.mjs
node --test packages/adapters/test/app/supplementary-buyback-production-binding.test.mjs
```

## Recovery pointers

- A settlement stuck `PREPARED` with no durable chain attempt means every preflight (token account,
  offer availability, open-evidence match, on-chain ownership, settlement-asset binding) failed
  money-safely; inspect the position's original `open` evidence and current on-chain custody before
  retrying.
- A durable chain attempt stuck `PREPARED` with an attempt already recorded is provider-ambiguous;
  do not resend. Resolve it only through Collector's own memo-keyed check
  (`reconcileSupplementaryBuybackSale`), which the next `reconcile()` call already runs first.
- A durable chain attempt stuck `SIGNED` recovers only by reauthorizing and rebroadcasting the exact
  recorded bytes under the same policy (legacy static, or the same production binding digest) they
  were signed under. If the production binding registry has changed since signing, restore the
  original registered binding before retrying recovery; never re-sign different bytes to route
  around a drifted binding.
