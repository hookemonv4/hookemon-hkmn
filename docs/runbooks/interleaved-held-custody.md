# Interleaved held custody

## Detection

Held positions and proceeds from several cycles coexist in the repository.

## Safe stop

Do not transfer attribution between cycles or treat wallet balance as settlement evidence.

## Runner behavior

Held positions and attributed proceeds remain isolated in their original cycles.

## Operator recovery

Inspect the cycle and position identifiers before reconciling an attributed receipt.

## Escalation

Escalate conflicting identities, custody deltas or repeated effects before permitting another mutation.

## Evidence

Preserve the original cycle, position, attempt and evidence digests. The cited test establishes the bounded recovery case below.

## Recovery contract

Failure-matrix cells: Cycle custody:interleaved-held-position-isolation
Owning work package: WP07-0
Expected outcome: terminal=COMPLETED; attempt=none; next=independent-settlement
Test: packages/adapters/test/app/cycle-repository.test.mjs — keeps interleaved held positions and attributed proceeds in their original cycles
Alarm reason/code: OPEN FACT (WP07-0): no dedicated alert code is bound to this recovery case.
Resume command: none supported by this runbook; use only the approved position-specific reconciliation path.
