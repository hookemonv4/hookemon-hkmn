# Supplementary payout restart

## Detection

A supplementary payout has a BROADCAST attempt but finality was interrupted by restart.

## Safe stop

Do not build another payout or replace the original holder snapshot.

## Runner behavior

Reconciliation resumes the original attempt and pays the original snapshot recipients once.

## Operator recovery

Retain signature, request digest and payout namespace; use reconciliation for the recorded attempt.

## Escalation

Escalate conflicting identities, custody deltas or repeated effects before permitting another mutation.

## Evidence

Preserve the original cycle, position, attempt and evidence digests. The cited test establishes the bounded recovery case below.

## Recovery contract

Failure-matrix cells: Supplementary payout:restart-between-broadcast-and-finality
Owning work package: WP09b
Expected outcome: terminal=COMPLETED; attempt=BROADCAST; next=reconcile
Test: packages/adapters/test/app/supplementary-payout.test.mjs — pays the original supplementary snapshot recipients once when finality resumes after a restart
Alarm reason/code: OPEN FACT (WP09b): no dedicated alert code is bound to this recovery case.
Resume command: none supported by this runbook; use only the approved position-specific reconciliation path.
