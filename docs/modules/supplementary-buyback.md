# Supplementary Buyback

## Purpose

`packages/adapters/src/app/stages/supplementary-buyback.mjs` is the production, provider-facing
resale handler for a held card whose owner has chosen `sell` (LAUNCH-CS, item 5 of the C-brief). It
reconciles exactly one transition of the durable supplementary settlement machine owned by
`cycle-repository.mjs`: `PREPARED -> BUYBACK_SENT_UNKNOWN`. Everything before that state (the held
position itself, the owner's `sell` decision, the settlement's creation) and everything after it
(the return bridge to EVM, `supplementary-money.mjs`, payout) belong to C and D respectively; this
module's job ends at durably recording a **confirmed** sale, in D's exact
`hookemon.supplementary-confirmed-sale.v1` shape, for the same position, memo, and mint the owner
approved -- it never advances the settlement on an unconfirmed outcome.

Registered as `productionSupplementaryStageHandlers.PREPARED` per
`C-supplementary-handler-contract.md` (commit `e3ae4db9`) -- the capability-bound production seam,
never the Node-test-only `supplementaryStageHandlers` observation-only seam.

This is not registered in `docs/modules/index.json` / `architecture/capability-map.json`: those
files are cross-team architecture artifacts outside this task's exclusive file scope
(`packages/adapters/src/app/stages/supplementary-buyback.mjs`,
`packages/adapters/test/app/supplementary-buyback.test.mjs`, this doc). Registration is for the
coordinator/I to do once the module is wired into composition.

## Public interface

- `createSupplementaryBuybackHandler()` returns
  `{ stage: 'supplementary-buyback', async reconcile({ adapters, signerClient, config, cycleRepository, context, position, settlement }) }`
  -- the exact shape `createStageDriver`'s `productionSupplementaryStageHandlers.PREPARED` entry
  must be. Takes no capabilities itself: `reconcile` consumes exactly the `adapters`/`signerClient`
  the driver passes through from `createStageDriver({supplementaryAdapters,
  supplementarySignerClient, productionSupplementaryStageHandlers})` -- the same lease-fenced,
  canary-gated production capabilities every other stage uses, never a closure-captured substitute.
  `context.fencingToken` is required (durable signed-bytes recovery binds to it, exactly like
  `return.mjs`'s own wallet-fencing pattern); the caller of `runSupplementarySettlement` must supply
  one.
- `reconcileSupplementaryBuybackSale({ adapters, config, cycleRepository, position })` is a
  read-only helper, safe to call at any time and any number of times. It resolves Collector's own
  memo-keyed buyback record for a held position, verified against Solana finality exactly like
  `buyback.mjs`'s own reconciliation (finalized signature, card left the operator, exact settlement
  proceeds delta). It never mutates anything and makes no provider call besides the read-only
  `getBuybackCheck`. Returns one of:
  - `{ status: 'PENDING' }` -- no record yet, or a record that cannot yet be verified (not
    finalized, an RPC hiccup). Never a reason to give up or invent a result.
  - `{ status: 'CONFIRMED', signature, proceeds, sourceFinality }` -- a verified sale (internal
    typed-amount `proceeds`).
  - `{ status: 'DATA_UNVERIFIED', reason, ... }` -- a provider record exists but does not bind the
    expected wallet/card/memo, or on-chain evidence does not match it. Never silently adopted.

## Invariants

- Immutable identity: every read and write is bound to the held position's own
  `(positionId, cycleId, memo, mint)`, validated by `assertHeldPositionForResale` before any
  provider call. A position without an owner `sell` decision, or one already resolved, is refused
  outright.
- Fresh eligibility, not a replay: unlike ordinary buyback (which replays an epic-gate offer), a
  held position has no epic-gate decision to bind against. Its offer is always re-read fresh via
  `getBuybackAvailable` at resale time. An unavailable offer, or any pre-flight failure (token
  account, money configuration), is money-safe to abandon *before any durable write*: the settlement
  simply stays `PREPARED`, a truthful pending/held result.
- **Durable pre-send intent, written before the ambiguous provider boundary.** Once pre-flight
  passes, the handler durably `prepareChainTransactionAttempt`s a `PREPARED` chain-transaction
  attempt -- keyed by the existing `'buyback'` stage enum value plus a position-scoped
  `requestDigest` (`digest({schema, positionId, cycleId, memo})`, stable across every retry) --
  *before* Collector's `buyback()` endpoint is ever called. `cycleAttemptKey(stage, requestDigest)`
  keys by the pair, so this never collides with the original cycle's own buyback chain attempts for
  the same `(cycleId, 'buyback')`.
- **No duplicate resale across restart, via the durable attempt, not just a lookup.** If a
  `reconcile()` call finds an *already-existing* `PREPARED` attempt (one it did not just create
  itself this call), it never calls the provider mutation again -- the outcome of the prior attempt
  is unknown, and only `reconcileSupplementaryBuybackSale`'s independent, read-only check (or an
  operator) can resolve it. This is the primary safety property; the memo-based
  `reconcileSupplementaryBuybackSale` check (always run first, every call) is a second, independent
  layer that also recovers a sale resolved entirely outside this handler's own attempt.
- **Signed bytes and their transaction-policy recovery context are durably recorded before
  broadcast**, via `recordSignedTransactionWithRecoveryContext` (or the `recordSignedTransaction` +
  `persistChainAttemptRecoveryContext` fallback), exactly like `return.mjs`'s own reviewed
  `mutateReturn`. A restart that finds a `SIGNED` attempt reauthorizes and rebroadcasts the *exact*
  recorded bytes via `recoverTransactionPolicyBroadcast` -- it never re-signs.
- **Fails closed, not weakly, when the durable-attempt primitives are missing.** If
  `cycleRepository` does not expose `prepareChainTransactionAttempt` /
  `recordSignedTransactionWithRecoveryContext` (or its two-call fallback) /
  `recordBroadcast` / `readChainAttemptRecoveryContext`, the handler throws immediately rather than
  degrading to a memo-lookup-only guarantee. See "Coordination with stage-driver.mjs" below: these
  are not yet on the production facade as of `e3ae4db9`.
- Existing transaction-policy and canary boundary, not a new one: signing goes through B's
  `createPolicySigner` (`packages/adapters/src/signing/signer-client.mjs`, commit `9d85282f`), the
  same `collectorPolicyForStage(config, 'buyback')` pinned policy bundle ordinary buyback uses, and
  the same `requireCollectorOnlyMutationAuthority` canary gate. There is no raw-signer shortcut.
- Bridge architecture and original-cycle attribution are retained: this module never touches the
  return bridge, payout, or the holder snapshot. Its confirmed-sale evidence carries the original
  `positionId`/`cycleId`/`manifestId`/`memo` so a later payout still attributes to the original
  cycle's frozen eligibility snapshot, never a new one.

## State transitions

`PREPARED -> BUYBACK_SENT_UNKNOWN` is the **only** transition this module makes, and only once the
sale is fully confirmed (never on a merely `SIGNED`/`BROADCAST`-but-unconfirmed outcome). The
evidence is exactly D's `hookemon.supplementary-confirmed-sale.v1` (validated in this module via
`assertConfirmedSale`, imported read-only from D's `supplementary-money.mjs`, so a schema drift
fails loudly here rather than downstream):

```
{ schema: 'hookemon.supplementary-confirmed-sale.v1',
  positionId, cycleId, manifestId,
  sourceWallet,          // config.accounts.solana -- the operator wallet that received proceeds
  mint,                  // the settlement asset's own mint (e.g. Circle USDC), NOT the card mint
  decimals, amountAtomic,
  transactionSignature,  // the real Solana signature, recomputed from durably-recorded raw bytes
  memo,                  // the held position's immutable memo
  sourceFinality }       // opaque: {schema, signature, slot, confirmationStatus}
```

An unconfirmed or ambiguous outcome (pre-flight failure, provider-ambiguous mutation, unconfirmed
broadcast, a conflicting existing record) never writes anything and leaves the settlement truthfully
`PREPARED`; only a subsequent `reconcile()` call (or an operator, via
`reconcileSupplementaryBuybackSale`) can resolve it further. `BUYBACK_SENT_UNKNOWN ->
RETURN_BROADCAST` (the return bridge) is D's transition (`supplementary-money.mjs`).

## Operational commands

None. This module has no CLI or operator-facing entry point; it is invoked exclusively through
`stage-driver.mjs`'s `runSupplementarySettlement` with the driver-supplied `adapters`/`signerClient`/
`cycleRepository` capabilities described above.

## Recovery pointers

- A crash before any durable write (mid pre-flight) resolves cleanly: nothing was sent to the
  provider, and the next `reconcile()` call retries pre-flight fresh.
- A crash after the `PREPARED` chain attempt is durably written but before `buyback()` returns
  (or its response is lost) is the one irreducible ambiguity: the next `reconcile()` call finds an
  already-existing `PREPARED` attempt and refuses to call the provider mutation again. Resolution is
  `reconcileSupplementaryBuybackSale`'s memo-based lookup, or an operator, discovering the provider's
  own record once it becomes visible -- the same category of residual gap `purchase.mjs`'s own
  `packBatchIntentLedger` accepts for `generateYoloPacks` (no documented provider idempotency lookup
  for the mutation *call itself*, only for its eventual result).
- A crash after signing but before broadcast recovers the exact same signed bytes via the durable
  recovery context and rebroadcasts them -- never re-signs, never creates a second transaction.
- A crash after broadcast but before finality is confirmed leaves the chain attempt at `BROADCAST`;
  the next `reconcile()` call polls finality again (read-only) using the already-known signature,
  with no further mutation.

## Coordination with stage-driver.mjs and C (open, cross-team)

`C-supplementary-handler-contract.md` (commit `e3ae4db9`) documents the production seam this module
now uses (`createStageDriver({supplementaryAdapters, supplementarySignerClient,
productionSupplementaryStageHandlers})`); `reconcile()` receives the driver's real, unexamined
`adapters`/`signerClient` and a lease-fenced `cycleRepository` facade. As of that commit, the facade
exposes only `advanceSupplementarySettlement`/`resolveHeldPosition`/`readPagedPayoutState`/
`persistPagedPayoutState` as writes, plus read-only `readChainTransactionAttempt`/
`readChainAttemptRecoveryContext` -- **not** the write counterparts
(`prepareChainTransactionAttempt`, `recordSignedTransactionWithRecoveryContext` /
`recordSignedTransaction` + `persistChainAttemptRecoveryContext`, `recordBroadcast`) this module
requires for durable pre-send intent and signed-bytes-before-broadcast recovery.

Requested from C (`C-inbox.md`), with the exact mechanism already verified against the real
`cycle-repository.mjs` source (not invented): add those write methods to
`SUPPLEMENTARY_SETTLEMENT_REPOSITORY_METHODS`, using the existing `'buyback'` stage enum value (no
`OPERATIONAL_CYCLE_STAGES` change needed) together with this module's own position-scoped
`requestDigest`. `chainAttemptKey(stage, requestDigest)` in `cycle-repository.mjs` keys by the pair,
so a position's supplementary buyback attempt (`'buyback'`, `digest({positionId,...})`) never
collides with the original cycle's own buyback attempts for the same `(cycleId, 'buyback')` (which
use a different requestDigest entirely). This mirrors `docs/modules/supplementary-money.md`'s own
"Open" item's exact suggested mechanism (a position-scoped relay leg / chain-attempt stage) applied
to the pre-existing `'buyback'` enum value instead of a Relay leg.

Until those methods are exposed, this handler **throws** rather than shipping with a weaker
guarantee (see `assertProductionSupplementaryBuybackRepository`); its own tests validate the full
durable-attempt flow (pre-send intent, signed-bytes-before-broadcast recovery, no-resend-on-restart)
against an in-memory fake implementing exactly this proposed contract, so consumption is a
zero-further-change wire-up once C ships matching methods on the real facade.

D's downstream evidence-shape question is answered directly: this module's confirmed-sale output
*is* D's `hookemon.supplementary-confirmed-sale.v1` (self-validated via `assertConfirmedSale`,
imported read-only from `supplementary-money.mjs`), communicated in `D-inbox.md`.
