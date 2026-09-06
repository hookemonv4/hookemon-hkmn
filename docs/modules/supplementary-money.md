# Supplementary Money (Return + Payout)

## Purpose

Drives one held position's supplementary settlement through its return and payout legs after CS's
provider-facing resale (`supplementary-buyback.mjs`) has confirmed a sale. It never invents a
holder snapshot, never uses wallet-wide reserves, and reuses the main direct-payout engine and the
existing `supplementary-payout.mjs` request/store contracts rather than a second authoritative
store.

## Public interface

- `assertConfirmedSale(value, settlement)` validates CS's confirmed held-card resale evidence
  (`hookemon.supplementary-confirmed-sale.v1`): `schema, positionId, cycleId, manifestId,
  sourceWallet, mint, decimals, amountAtomic, transactionSignature, memo, sourceFinality`. Binds to
  the settlement's identity; the `amountAtomic` is the sole permitted source for the amount a
  return leg may bridge for this position -- never a wallet-wide Solana balance, never the main
  cycle's custody ledger.
- `prepareSupplementaryReturnRequest({ settlement, confirmedSale, config })` is pure: requires a
  `BUYBACK_SENT_UNKNOWN` settlement, binds the confirmed sale to it, and resolves the configured
  Operations EVM identity the bridged USDG must land on. It does not call any adapter, sign
  anything, or touch the repository.
- `recordSupplementaryReturnBroadcast({ cycleRepository, settlement, finalizedReturnEvidence })`
  durably binds an already-proven EVM destination credit and advances the settlement
  `BUYBACK_SENT_UNKNOWN -> RETURN_BROADCAST` through `cycleRepository.advanceSupplementarySettlement`.
  It only binds and persists proof it is given; it does not originate or verify the cross-chain
  transfer. Idempotent for an identical replay (enforced by the repository).
- `mutateSupplementaryPayout({ liveMode, adapters, config, signerClient, cycleRepository, context })`
  drives a `RETURN_BROADCAST` (or already-in-progress `PAYOUT_BROADCAST`) settlement to `COMPLETE`
  through the real `createDirectPayoutState`/`advanceDirectPayout`/`isDirectPayoutComplete` engine
  from `payout.mjs`, using `createSupplementaryPayoutStore`'s separate paged namespace -- never the
  main cycle's payout store. Always fully serial (`inFlightWindow` 1; a held position's recipient
  count is small). Rechecks native gas before initializing durable state, reusing the exported
  `evaluateDirectPayoutNativeGasAdmission`. Returns the current (possibly still in-progress) state
  when no recipient can advance this pass -- a pending wait, not an error -- exactly like the main
  cycle's dispatch loop.

## Invariants

- Every write goes through `cycleRepository.advanceSupplementarySettlement`'s existing state
  machine (`PREPARED -> BUYBACK_SENT_UNKNOWN -> RETURN_BROADCAST -> PAYOUT_BROADCAST -> COMPLETE`);
  this module never advances a transition without the evidence that machine requires, and never
  invents an intermediate store.
- The confirmed-sale amount is the only money this module ever attributes to a position's return
  leg. Nothing here reads or spends the Operations wallet's total balance on any chain.
- `mutateSupplementaryPayout` reuses the exact same recipient lifecycle, signed-byte durability,
  and restart-without-re-signing guarantees as the main cycle's payout (same `advanceDirectPayout`
  code path), so a supplementary payout's safety properties are identical to the main payout's,
  not a parallel reimplementation.

## Operational commands (current status)

- `prepareSupplementaryReturnRequest` and `recordSupplementaryReturnBroadcast` are implemented and
  tested (`packages/adapters/test/app/supplementary-money.test.mjs`) against a real fake-transport
  boundary and the actual `cycleRepository.advanceSupplementarySettlement` call shape.
- `mutateSupplementaryPayout` is implemented and tested end-to-end (`RETURN_BROADCAST -> COMPLETE`,
  two recipients, real signer, fake chain client) in the same test file.
- **Open**: the live Solana-to-EVM bridge execution that turns a `confirmedSale` into a real,
  verified `finalizedReturnEvidence` (quote, source-leg signing/broadcast, destination-leg proof
  reading) is not implemented in this module yet. `return.mjs`'s `mutateReturn`/`reconcileLiveReturn`
  cannot be reused as-is for this: they filter the cycle's `relayLegs`/`chainAttempts` by the
  literal `direction === 'return'` / `stage === 'return'` and require exactly one match
  (`RETURN_RELAY_LEG_AMBIGUOUS` otherwise), so calling them for a supplementary settlement under
  the same `cycleId` as an in-progress main-cycle return would collide. The underlying shared
  primitives they call (`extractRelaySolanaInstructionPlan`, `readReturnLegDestinationProof`,
  `isProcessRpcReturnLegDestinationProof`, plus `solana-rpc.mjs`/`signer-client.mjs`/
  `transaction-policy.mjs`/`money-schemas.mjs`) are already public and reusable; a correct
  implementation must call those directly with a position-scoped relay leg (its own unique
  `relayRequestId`, which `recordRelayLeg`/`readRelayLeg` already key by, so no collision there)
  and a position-scoped chain-attempt `stage` (`readChainTransactionAttempt` and friends already
  take `stage` as a parameter). Concrete next step, not a silent gap.

## Recovery pointers

- A settlement that never leaves `BUYBACK_SENT_UNKNOWN` is not this module's concern until the
  return-bridge execution above lands; `recordSupplementaryReturnBroadcast` only records a
  boundary it is handed.
- A `mutateSupplementaryPayout` call that returns a non-terminal state made no unsafe progress: no
  signature or broadcast happened beyond what the durable recipient state already proves, and a
  later call resumes from exactly that state.
