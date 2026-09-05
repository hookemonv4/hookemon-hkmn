# Phase 3 incident runbooks

Use these runbooks before resuming a held cycle. Each one records the detection
signal, safe stop, automatic runner behavior, operator recovery boundary,
escalation point, and the evidence that proves the expected result.

Current controls are named exactly. A control marked `planned (WP12)` or
`planned (WP10b)` does not exist yet and must not be substituted with an
ad-hoc transaction or dashboard action.

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
