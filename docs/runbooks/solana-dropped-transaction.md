# Solana dropped transaction

## Detection

Alert when a `BROADCAST` signature remains unknown or non-finalized through its
validity boundary. Journal the raw bytes, signature, blockhash, and every
signature-status observation; do not infer a drop from one empty response.

## Safe stop

Do not request a new signature. The runner may only rebroadcast the retained
identical bytes while validity evidence permits it; otherwise it must reconcile
the original attempt before any fresh intent is prepared.

## Runner behavior

The recovery model permits retirement only with finalized evidence that the
specific intent was never broadcast after its boundary. It never treats an
unknown status as permission to spend again.

OPEN FACT: The automatic liveness proof and transition are missing. L4-M9
assigns them to WP08a and WP13. Until then, retain the unresolved attempt and
do not create a replacement.

## Operator recovery

No supported operator control can resubmit or retire this transaction. Do not
use a wallet or custom RPC call. `resume` and `abort-cycle` are planned (WP12);
dashboard pause/resume is planned (WP10b), after durable reconciliation.

## Escalation

Escalate if observers disagree about the signature, the validity boundary is
not independently confirmed, or any nonzero delta cannot be attributed.

## Evidence

Owning work package: WP13.
Traceability: L4-M9.
OPEN FACT: The matrix has no Solana-specific dropped-transaction cell. WP13
must add the cell and execute its fake; until then, retain the unresolved attempt.

## Recovery contract

Failure-matrix cells: none (not in frozen matrix)
Owning work package: WP13
Expected outcome: terminal=none; attempt=none; next=none
Test: OPEN FACT (WP13): the frozen matrix has no Solana dropped-transaction recovery test.
Alarm reason/code: OPEN FACT (WP13): no dedicated alert code is emitted for a dropped Solana transaction.
Resume command: none supported; reconcile the original signature and finalized deltas before any new signature.
