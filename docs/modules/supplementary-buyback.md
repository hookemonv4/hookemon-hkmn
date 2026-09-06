# Supplementary Buyback

## Purpose

`packages/adapters/src/app/stages/supplementary-buyback.mjs` is the production, provider-facing
resale handler for a held card whose owner has chosen `sell` (LAUNCH-CS, item 5 of the C-brief). It
reconciles exactly one transition of the durable supplementary settlement machine owned by
`cycle-repository.mjs`: `PREPARED -> BUYBACK_SENT_UNKNOWN`. Everything before that state (the held
position itself, the owner's `sell` decision, the settlement's creation) and everything after it
(the return bridge to EVM, payout) belong to C and D respectively; this module's job ends at
durably recording a resale outcome -- confirmed, submitted, or provider-ambiguous -- for the same
position, memo, and mint the owner approved.

This is not registered in `docs/modules/index.json` / `architecture/capability-map.json`: those
files are cross-team architecture artifacts outside this task's exclusive file scope
(`packages/adapters/src/app/stages/supplementary-buyback.mjs`,
`packages/adapters/test/app/supplementary-buyback.test.mjs`, this doc). Registration is for the
coordinator/I to do once the module is wired into composition.

## Public interface

- `createSupplementaryBuybackHandler({ adapters, signerClient })` returns
  `{ stage: 'supplementary-buyback', async reconcile({ config, cycleRepository, position, settlement }) }`
  -- the exact shape `stage-driver.mjs`'s `runSupplementarySettlement` already dispatches to via
  `supplementaryStageHandlers.PREPARED` (see "Coordination with stage-driver.mjs" below).
  `adapters`/`signerClient` are closed over at construction time by the caller (I's composition
  root), not read from the `reconcile()` call; see that section for why.
- `reconcileSupplementaryBuybackSale({ adapters, config, cycleRepository, position })` is a
  read-only helper, safe to call at any time and any number of times. It resolves Collector's own
  memo-keyed buyback record for a held position, verified against Solana finality exactly like
  `buyback.mjs`'s own reconciliation (finalized signature, card left the operator, exact settlement
  proceeds delta). It never mutates anything and makes no provider call besides the read-only
  `getBuybackCheck`. Returns one of:
  - `{ status: 'PENDING' }` -- no record yet, or a record that cannot yet be verified (not
    finalized, an RPC hiccup). Never a reason to give up or invent a result.
  - `{ status: 'CONFIRMED', memo, mint, signature, proceeds, createdAt }` -- a verified sale. `D`'s
    return-bridge handler (or an operator) can use this to build its own return evidence.
  - `{ status: 'DATA_UNVERIFIED', reason, ... }` -- a provider record exists but does not bind the
    expected wallet/card/memo, or on-chain evidence does not match it. Never silently adopted.

  This is the exact seam D's own `BUYBACK_SENT_UNKNOWN`-consuming code should call to resolve a
  `submitted`/`unknown` evidence record into a confirmed proceeds amount before bridging, instead of
  re-implementing Solana finality verification a second time.

## Invariants

- Immutable identity: every read and write is bound to the held position's own
  `(positionId, cycleId, memo, mint)`, validated by `assertHeldPositionForResale` before any
  provider call. A position without an owner `sell` decision, or one already resolved, is refused
  outright.
- Fresh eligibility, not a replay: unlike ordinary buyback (which replays an epic-gate offer), a
  held position has no epic-gate decision to bind against. Its offer is always re-read fresh via
  `getBuybackAvailable` at resale time. An unavailable offer, or any pre-flight failure (token
  account, money configuration), is money-safe to abandon: the settlement simply stays `PREPARED`,
  a truthful pending/held result. It never fabricates success and never silently resolves the
  position.
- No duplicate resale across restart: before ever calling the ambiguous provider mutation, the
  handler always checks `reconcileSupplementaryBuybackSale` first, using the position's own
  already-durable memo as the recovery key (Collector's documented `buyback/check` lookup). A
  confirmed or data-unverified existing record is recorded and the settlement advances without ever
  calling `getBuybackAvailable` or `buyback` again for that position.
- One ambiguous boundary, wrapped once: the canary authorization check, Collector's `buyback` call,
  transaction decode/policy/binding, the signer's transaction-policy canary, sign, and broadcast all
  run inside one `try`/`catch`, mirroring `buyback.mjs`'s `sellPack` exactly. Any failure past that
  point is recorded `unknown` (provider-ambiguous, never retried, never held as though nothing
  happened) rather than distinguishing "denied before send" from "failed after send" -- the two are
  operationally indistinguishable and treating them differently risks a double sale.
- Existing transaction-policy and canary boundary, not a new one: signing goes through B's
  `createPolicySigner` (`packages/adapters/src/signing/signer-client.mjs`, commit `9d85282f`), the
  same `collectorPolicyForStage(config, 'buyback')` pinned policy bundle ordinary buyback uses, and
  the same `requireCollectorOnlyMutationAuthority` canary gate. There is no raw-signer shortcut.
- Bridge architecture and original-cycle attribution are retained: this module never touches the
  return bridge, payout, or the holder snapshot. Its confirmed-sale evidence carries the original
  `positionId`/`cycleId`/`memo`/`mint` so a later payout still attributes to the original cycle's
  frozen eligibility snapshot, never a new one.

## State transitions

`PREPARED -> BUYBACK_SENT_UNKNOWN` is the only transition this module makes, via
`cycleRepository.advanceSupplementarySettlement(positionId, { expectedState: 'PREPARED', nextState:
'BUYBACK_SENT_UNKNOWN', evidence })`. `evidence.decision` is one of:

- `sold` -- recovered from an already-confirmed Collector record (restart/crash recovery path);
  carries `signature`, `proceeds` (internal typed amount), `createdAt`.
- `submitted` -- a fresh sale was signed and broadcast this call; carries `signature`, `offer`,
  `refundAmount`. Finality is not yet confirmed; a later caller resolves it via
  `reconcileSupplementaryBuybackSale`.
- `unknown` -- the provider mutation was ambiguous (any failure after the canary check); carries
  `offer` and a `reason`. Never resent; resolved only via `reconcileSupplementaryBuybackSale`.
- `data_unverified` -- a provider response or existing record does not bind the expected memo,
  wallet, card, or amount; carries a `reason`. Never treated as a sale or a payout source.

No other state is written by this module. `BUYBACK_SENT_UNKNOWN -> RETURN_BROADCAST` (the return
bridge) is D's transition, using `reconcileSupplementaryBuybackSale`'s `CONFIRMED` result to build
its `finalizedReturnEvidence`.

## Operational commands

None. This module has no CLI or operator-facing entry point; it is invoked exclusively through
`stage-driver.mjs`'s `runSupplementarySettlement` (or directly, in tests, and by D's own
`reconcileSupplementaryBuybackSale` reuse) with the injected `adapters`/`signerClient`/
`cycleRepository` capabilities described above.

## Recovery pointers

- A crash between the durable `PREPARED -> BUYBACK_SENT_UNKNOWN` write and any later confirmation
  never reaches this module again for that position (the driver dispatches by `settlement.state`,
  and this module owns only `PREPARED`). Recovery of a `submitted`/`unknown` evidence record is
  `reconcileSupplementaryBuybackSale`, called by whoever owns `BUYBACK_SENT_UNKNOWN` next.
- A crash before that write (mid pre-flight, mid sign, mid broadcast) resolves on the next
  `PREPARED` dispatch: `reconcileSupplementaryBuybackSale` is always the first thing this handler
  does, so any provider-side record already created is discovered and durably recorded instead of
  re-sent.

## Coordination with stage-driver.mjs (open, cross-team)

`stage-driver.mjs`'s `runSupplementarySettlement` currently calls `handler.reconcile(...)` with
`adapters: EMPTY_SUPPLEMENTARY_CAPABILITIES` (frozen empty object) and no `signerClient` at all, for
every settlement state (see `C-supplementary-resale-design.md`). This module therefore does not
read `adapters`/`signerClient` from the `reconcile()` call; `createSupplementaryBuybackHandler`
closes over the real ones at construction time instead, so the handler is fully functional today
against a real repository and fake provider/chain transport boundaries, independent of when C lands
the stage-driver capability-plumbing fix C has already proposed and coordinator has authorized C to
implement. Once that fix ships (an additive `supplementaryAdapters`/`supplementarySignerClient`
constructor seam, per C's own design doc), `config`/`cycleRepository`/`context`/`position`/
`settlement` continue to arrive exactly as they do today; nothing in this module needs to change.

Also open, tracked in `C-inbox.md`: the settlement repository facade passed to supplementary
handlers (`SUPPLEMENTARY_SETTLEMENT_REPOSITORY_METHODS` in `stage-driver.mjs`) exposes only
`advanceSupplementarySettlement` as a write primitive -- there is no durable, position-scoped
"pre-send intent" or "signed bytes before broadcast" record analogous to the generic
`prepareChainTransactionAttempt`/`recordSignedTransaction`/`recordBroadcast` chain-journal
primitives ordinary stages use (their read-only counterparts, `readChainTransactionAttempt`/
`readChainAttemptRecoveryContext`, are already exposed). This module's no-duplicate-resale guarantee
therefore rests on Collector's own memo-keyed `buyback/check` lookup (the position's memo is already
durable well before this settlement exists) rather than a same-process durable pre-send marker --
the same category of residual gap `C-interface.json` already documents as
`signedByteRecoveryAcrossRestart` for ordinary buyback. Exposing those chain-journal write
primitives to supplementary handlers (keyed by a per-position stage id, not the original cycle's
`buyback` stage) would close it; requested from C, not implemented here to avoid a second
authoritative store or an unreviewed `cycle-repository.mjs`/`stage-driver.mjs` edit outside this
task's exclusive file scope.

D's downstream evidence-shape question (exact field names for `RETURN_BROADCAST`) is answered by
`reconcileSupplementaryBuybackSale`'s `CONFIRMED` return shape above, communicated in `D-inbox.md`.
