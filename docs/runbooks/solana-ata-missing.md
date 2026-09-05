# Solana missing associated token account

## Detection

Alert when the token account derived for the owner and Solana stablecoin mint
cannot be read, or preflight/RPC reports the destination account is absent.
Journal the owner, mint, derived address, and error before any signature.

## Safe stop

Do not substitute a caller-supplied account or sign a transfer. The destination,
mint, amount, and absence of extra instructions remain bound by transaction
policy.

## Runner behavior

The adapter can derive the canonical associated token address and build a
`TransferChecked` instruction. The target path must check the account before
signing and hold the stage if it is absent.

OPEN FACT: The documented interface has no create-account operation or live ATA
recovery path. WP08a and WP08b must provide the policy-bound implementation.
Until then, stop the stage before signature.

## Operator recovery

No supported CLI or dashboard control creates an associated token account. Do
not create one manually under this runbook. `resume` and `abort-cycle` are
planned (WP12); dashboard pause/resume is planned (WP10b) after a compliant
runner path has produced verified evidence.

## Escalation

Escalate for a policy-approved account-provisioning path and its test coverage.
Escalate immediately if a proposed destination differs from the derived address.

## Evidence

Owning work package: WP08a.
Plan source: Solana Public-RPC failure row, WP08a/WP08b/WP13.
OPEN FACT: The matrix has no ATA-missing cell and the current interface has no
create-account operation. Until those land, the stage remains stopped before signature.

## Recovery contract

Failure-matrix cells: none (not in frozen matrix)
Owning work package: WP08a
Expected outcome: terminal=none; attempt=none; next=none
Test: OPEN FACT (WP08a): no executed missing-account recovery test exists.
Alarm reason/code: OPEN FACT (WP08a): no dedicated alert code is emitted for a missing account.
Resume command: none supported; do not create an account outside an approved stage transition.
