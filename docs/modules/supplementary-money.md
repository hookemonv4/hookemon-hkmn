# Supplementary Money (Return + Payout)

## Purpose

Drives one held position's supplementary settlement through its real return and payout legs after
CS's provider-facing resale (`supplementary-buyback.mjs`) has confirmed a sale. Never invents a
holder snapshot, never uses wallet-wide reserves, and reuses the main direct-payout engine, the
existing `supplementary-payout.mjs` request/store contracts, and the main return leg's real
signing/relay/reconciliation primitives -- never a second authoritative store or a parallel
cross-chain bridge implementation.

## Public interface

- `supplementaryReturnStageId(positionId)` derives the position-scoped, 48-hex-char paged-payout-
  state stage id the return leg's durable attempt record lives under
  (`supplementary-<sha256(positionId + ':return-leg').slice(0,48)>`). Deliberately a different
  digest input than `supplementaryPayoutStageId` so a position's return-leg attempt and its
  payout-leg recipient state never share one `(cycleId, stage)` key in the same paged-payout-state
  store.
- `prepareSupplementaryReturnRequest({ settlement, confirmedSale, config })` is pure: requires a
  `BUYBACK_SENT_UNKNOWN` settlement and CS's own `reconcileSupplementaryBuybackSale` result
  (`{status:'CONFIRMED', memo, mint, signature, proceeds, createdAt}` -- see CS-interface.json).
  Rejects a `mint`/`proceeds.assetId` outside the configured Solana settlement asset (never a
  foreign or wallet-wide asset). Does not call any adapter, sign anything, or touch the repository.
- `mutateSupplementaryReturn({ liveMode, adapters, config, signerClient, cycleRepository, context, confirmedSale, preflightAuthority })`
  drives the **real** Solana source leg: quotes the exact confirmed-sale proceeds through
  `adapters.relay.quoteReturnBridge`/`prepareExecution` (never a custody-ledger delta), signs
  through the real B policy/canary-guarded Solana signer via `return.mjs`'s exported
  `createReturnPolicySigner` (the same function the main cycle's return uses), and durably persists
  signed bytes -- via `cycleRepository.persistPagedPayoutState` under
  `supplementaryReturnStageId(positionId)` -- before ever broadcasting. Resumable: a restart after
  `PREPARED` or `SIGNED` reuses the exact persisted attempt (same `requestDigest`) instead of
  re-quoting or re-signing; a call after `BROADCAST` is a real no-op.
- `reconcileSupplementaryReturn({ adapters, config, cycleRepository, context })` verifies the real,
  independent finality of a `BROADCAST` return attempt -- the actual Solana source debit
  (`readFinalizedRelaySourceDebit`) and the actual EVM destination credit
  (`readReturnLegDestinationProof`), both exported, generic primitives the main cycle's return
  reconciliation also uses -- then calls `recordSupplementaryReturnBroadcast` to durably bind the
  proof and advance the settlement. Returns `null` (safe to retry) until the proof is available.
- `recordSupplementaryReturnBroadcast({ cycleRepository, settlement, finalizedReturnEvidence })`
  durably binds an already-proven EVM destination credit and advances the settlement
  `BUYBACK_SENT_UNKNOWN -> RETURN_BROADCAST` through `cycleRepository.advanceSupplementarySettlement`.
  It only binds and persists proof it is given; it does not originate or verify the cross-chain
  transfer itself (that is `mutateSupplementaryReturn`/`reconcileSupplementaryReturn`'s job).
  Idempotent for an identical replay (enforced by the repository).
- `mutateSupplementaryPayout({ liveMode, adapters, config, signerClient, cycleRepository, context })`
  drives a `RETURN_BROADCAST` (or already-in-progress `PAYOUT_BROADCAST`) settlement to `COMPLETE`
  through the real `createDirectPayoutState`/`advanceDirectPayout`/`isDirectPayoutComplete` engine
  from `payout.mjs`, using `createSupplementaryPayoutStore`'s separate paged namespace -- never the
  main cycle's payout store. Always fully serial (`inFlightWindow` 1). Rechecks native gas before
  initializing durable state via the exported `evaluateDirectPayoutNativeGasAdmission`. Returns the
  current (possibly still in-progress) state when no recipient can advance this pass -- a pending
  wait, not an error -- exactly like the main cycle's dispatch loop.

## Shared `return.mjs` seam (minimal, additive, zero behavior change to existing callers)

Exported (were module-private): `assertReturnConfiguration`, `assertReturnMoneyConfiguration`,
`assertReturnQuote`, `assertReturnLamportReserve`, `assertReturnBroadcastHash`,
`canonicalPositiveInteger`, `typedAmount`. These are pure or adapter-calling helpers with no
`cycleRepository` coupling; exporting them changed nothing about their behavior.

Two functions gained an optional `stage` parameter defaulting to `'return'` (the exact prior
literal, so every existing caller is byte-for-byte unchanged): `createReturnPolicySigner`,
`returnRecoveryContext`. In practice supplementary calls still pass `stage: 'return'` (see below) --
the parameter exists for documentation/future use, not because a different value is used today.

**`mutateReturn`/`reconcileLiveReturn` themselves are NOT reused and NOT generalized.** They filter
the cycle's `relayLegs`/`chainAttempts` by the literal `direction === 'return'` / `stage === 'return'`
and require exactly one match (`RETURN_RELAY_LEG_AMBIGUOUS` otherwise) -- reusing them for a
supplementary settlement under the same `cycleId` as an in-progress main-cycle return would
collide. `mutateSupplementaryReturn`/`reconcileSupplementaryReturn` instead call the lower-level
generic primitives directly (`readFinalizedRelaySourceDebit`, `readReturnLegDestinationProof`,
`extractRelaySolanaInstructionPlan`) and track the return leg's own state (relay request id,
signed bytes, broadcast hash) in a self-contained record under `supplementaryReturnStageId`,
never in the cycle's shared `relayLegs`/`chainAttempts` maps. This is why `recordRelayLeg` was
never needed either: each position's return quote gets its own unique `relayRequestId`, and
`cycleRepository.recordRelayLeg`/`readRelayLeg` are keyed by `relayRequestId` alone (confirmed by
reading the implementation), so there was never a collision risk there to solve.

**The canonical transaction policy's `stage` field is a fixed, shared enum, not free text.** It is
validated against runner-owned `OPERATIONAL_CYCLE_STAGES` (`money-schemas.mjs`:
`eligibility-snapshot, claim-process, outbound, purchase, open, epic-gate, buyback, return, payout`)
-- `'supplementary-return'` is not a member, and that enum is not D-owned to extend. This module
reuses the existing `'return'` value for policy purposes; per-transaction replay protection comes
from `requestDigest` (position-scoped, embedded in the policy and derived from
positionId/cycleId/manifestId/sourceSignature/amount), not from this label, so reusing it is a
correct choice, not a shortcut.

## No new C repository primitive was needed

The originally anticipated ask ("expose position-scoped `prepareChainTransactionAttempt`/
`recordSignedTransaction`/`recordBroadcast` through the production facade") turned out to be
unnecessary: `persistPagedPayoutState`/`readPagedPayoutState` are already on
`C-supplementary-handler-contract.md`'s lease-fenced facade, and they are schema-agnostic --
`assertPagedPayoutState` only requires a `recipients` array field (declared `[]` here) and a
matching `cycleId`. This module reuses that exact store, under `supplementaryReturnStageId`, to
durably record the return leg's own PREPARED/SIGNED/BROADCAST attempt with zero new repository
surface.

## Known parity gap (documented, not blocking, matches CS's own precedent)

Wallet-nonce-lease reservation (`reserveWalletNonce`/`assertWalletNonce`/`releaseWalletNonce`) is
not on the production facade and is not used here, exactly as CS's real `supplementary-buyback.mjs`
signing path also ships without it (see CS-interface.json's own scope). Solana transactions are
fenced by blockhash expiry and durable signed-bytes-before-broadcast, not a sequential per-wallet
nonce the way EVM is; the main cycle's `return.mjs` wallet-nonce lease is an additional, currently
facade-unavailable layer for a different concurrency concern (serializing the main return against
other same-wallet Solana sends), not a prerequisite CS's precedent required either.

## Invariants

- Every settlement write goes through `cycleRepository.advanceSupplementarySettlement`'s existing
  state machine (`PREPARED -> BUYBACK_SENT_UNKNOWN -> RETURN_BROADCAST -> PAYOUT_BROADCAST ->
  COMPLETE`); this module never advances a transition without the evidence that machine requires.
- The confirmed-sale amount (CS's own verified reconciliation result) is the only money this module
  ever attributes to a position's return leg. Nothing here reads or spends the Operations wallet's
  total balance on any chain, or the main cycle's custody ledger.
- Signed Solana bytes are durably persisted (via `persistPagedPayoutState`) before any broadcast is
  attempted, and a restart resumes from exactly that persisted attempt -- never re-signs, never
  double-broadcasts different bytes.
- `mutateSupplementaryPayout` reuses the exact same recipient lifecycle, signed-byte durability,
  and restart-without-re-signing guarantees as the main cycle's payout (same `advanceDirectPayout`
  code path), so a supplementary payout's safety properties are identical to the main payout's.

## Operational commands (current status)

All exported functions are implemented and tested end-to-end in
`packages/adapters/test/app/supplementary-money.test.mjs`: a full sign-durably/lose-the-broadcast-
response/resume-without-resigning/broadcast/reconcile-to-a-real-destination-proof cycle for the
return leg (real `@solana/web3.js` Keypair signing, real Solana/EVM RPC response shapes), a
return-broadcast-to-COMPLETE cycle for the payout leg, a foreign-mint rejection, and a stage-
isolation proof (the return leg's paged state never collides with the payout leg's for the same
position).

## Recovery pointers

- A settlement that never leaves `BUYBACK_SENT_UNKNOWN` is CS's concern (its own no-duplicate-
  resale reconciliation), not this module's.
- A `mutateSupplementaryReturn`/`mutateSupplementaryPayout` call that returns a non-terminal state
  made no unsafe progress: no signature or broadcast happened beyond what the durably persisted
  attempt already proves, and a later call resumes from exactly that state.
- `reconcileSupplementaryReturn` returning `null` means the cross-chain proof is not yet available;
  retry later. It never fabricates or infers a credit from an unauthenticated source.
