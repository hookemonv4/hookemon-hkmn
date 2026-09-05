# Phase 3 incident runbooks

Use these runbooks before resuming a cycle or resolving a held position. Each one records the detection
signal, safe stop, automatic runner behavior, operator recovery boundary,
escalation point, and the evidence that proves the expected result.

Current controls are named exactly. A control marked `planned (WP12)` or
`planned (WP10b)` does not exist yet and must not be substituted with an
ad-hoc transaction or dashboard action.

## Release control

- Phase 3 owner closeout: `docs/superpowers/plans/owner-closeout.md`.

## CI

- [Fork proof](ci-fork-proof.md)

## Relay

- [Delay](relay-delay.md)
- [Partial finalized delta](relay-partial.md)
- [Refund finalized delta](relay-refund.md)
- [Late finalized delta](relay-late.md)
- [Wrong asset](relay-wrong-asset.md)
- [Wrong-asset finalized delta](relay-wrong-asset-finalized.md)
- [Expired quote](relay-quote-expired.md)

## Collector

- [Already opened](collector-already-opened.md)
- [Missing mint after an unknown open](collector-missing-mint-sent-unknown.md)
- [Timeout](collector-timeout.md)
- [Schema drift](collector-schema-drift.md)
- [Blocked request](collector-blocked.md)

## Solana

- [Blockhash expiry](solana-blockhash-expiry.md)
- [EVM dropped transaction](evm-transaction-dropped.md)
- [EVM replaced transaction](evm-transaction-ambiguity.md)
- [EVM nonce interference](evm-nonce-interference.md)
- [RPC 429](solana-rpc-429.md)
- [Dropped transaction](solana-dropped-transaction.md)
- [Missing associated token account](solana-ata-missing.md)

## Robinhood RPC

- [Latest-only response](robinhood-rpc-latest-only.md)
- [Reorganization](robinhood-rpc-reorg.md)
- [Incomplete logs](robinhood-rpc-incomplete-logs.md)

## USDG and pool controls

- [Paused USDG](usdg-paused.md)
- [Frozen USDG account](usdg-frozen.md)
- [USDG implementation change](usdg-upgraded.md)
- [Nonzero pool protocol fee](pool-protocol-fee.md)

## Cycle and payout controls

- [Provider pre-call failure](provider-pre-call-failure.md)
- [Standing authority replay after expiry](standing-authority-replay-after-expiry.md)
- [Keychain interaction denial](keychain-user-interaction.md)
- [Crash after provider call](provider-call-journal-crash.md)
- [Lease expiry during mutation](lease-expiry-mid-mutation.md)
- [Repository state-directory loss](repository-state-directory-loss.md)
- [Held epic card](epic-card-held.md)
- [Epic threshold equality](epic-threshold-equality.md)
- [Wrong transaction recipient](transaction-policy-wrong-recipient.md)
- [Frozen payout recipient](payout-recipient-frozen.md)
- [Holder count above payout envelope](payout-holder-envelope.md)
- [Unattributed deposit](unattributed-deposit.md)

## Held positions

- Detection: inspect the operator dashboard or status projection for an open held position and its
  reason class, terminal state, `ageSeconds`, attributed cycle, evidence digest, and position revision. A
  completed cycle can legitimately retain open positions while its settled proceeds have paid out.
  The public projection exposes only the count, reason class, `ageSeconds`, and public cycle state.
- Limit refusal: `HELD_LIMIT` means the open-position count has reached `maxHeldPositions` or the
  USDG control value exceeds `maxHeldValueMicroUsdg`. The control value is a verified insured
  amount only when it is already the configured USDG asset; otherwise it is the attributed purchase
  cost. A verified Collector Solana stablecoin amount is not converted because no frozen quote
  binding exists. Do not bypass the refusal with a new claim. Resolve a position or reduce exposure
  through the owner-controlled configuration path.
- Capacity: a completed cycle with open positions remains one active DurableCycleStore record even
  though scheduling can start a different cycle. The store has 16 entries. Keep
  `maxHeldPositions` at the default 10 or lower: higher values have no verified capacity guarantee,
  and values at or above 16 can exhaust the store when positions span completed cycles. OPEN FACT:
  resolve this by adding recoverable post-completion position archival or a capacity exemption and
  test new-cycle admission across the configured cap. Verified safe alternative: do not raise the
  cap until that path exists.
- Decision: request `sell` or `keep-holding` for one position with the displayed evidence digest
  and position revision. Reuse the same request ID after an uncertain response. `keep-holding`
  leaves the position against the limits; it does not release custody. `sell` creates that
  position's supplementary settlement; it does not authorize a manual provider request or transfer.
- Supplementary payout: follow the position-scoped settlement through `PREPARED`,
  `BUYBACK_SENT_UNKNOWN`, `RETURN_BROADCAST`, `PAYOUT_BROADCAST`, and `COMPLETE`. Its manifest ID
  is `<cycleId>:supplementary:<n>`, reuses the original cycle's frozen eligibility snapshot by its
  stored evidence digest, and is distinct from the main manifest. The return boundary also freezes
  the exact attributed USDG return and zero/null supplementary dust setting. After a restart,
  reconcile those recorded bindings; never create a replacement manifest or a manual transfer. A
  nonzero normal-cycle dust record remains unavailable until a position-aware atomic consumption
  transition is implemented.
- Supplementary execution: OPEN FACT: the durable plan and boundary records do not yet invoke live
  buyback, return, or recipient transfers. Resolve this by wiring manifest-scoped stage adapters to
  the existing write-ahead provider and payout contracts with restart-to-finality tests. Verified
  safe alternative: retain the position and do not send a manual provider request or transfer.
- Late resolution: OPEN FACT: the repository can record `SOLD`, `REFUNDED`, or `NEVER_SENT` from
  evidence, but no production observation-only provider reconciler collects that evidence or
  starts a supplementary intent. Resolve it with a lease-fenced read adapter and restart-tested
  handoff to the position settlement. Verified safe alternative: keep the position open and do not
  resend the provider mutation.
- Escalation: escalate a missing, conflicting, or stale evidence record, a position that exceeds
  the reconciliation deadline without a resolution, a settlement boundary that cannot be reconciled,
  or an unexpected cross-cycle attribution to the cycle owner with the position ID, cycle ID,
  manifest ID where present, and durable evidence references.
