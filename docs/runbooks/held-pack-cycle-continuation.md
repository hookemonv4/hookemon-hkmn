# Held pack and continuing cycle

## Detection

A purchased pack cannot complete its open path while another pack has attributable progress.

## Safe stop

Do not retry the held pack or spend its custody value.

## Runner behavior

The unresolved pack is carved into a held position; the other pack proceeds through open, gate and sale.

## Operator recovery

Keep recovery scoped to the original position. Review its evidence before any owner decision.

## Escalation

Escalate conflicting identities, custody deltas or repeated effects before permitting another mutation.

## Evidence

Preserve the original cycle, position, attempt and evidence digests. The cited test establishes the bounded recovery case below.

## Recovery contract

Failure-matrix cells: Held position:card-carved-out-cycle-completes
Owning work package: WP08b
Expected outcome: terminal=COMPLETED; attempt=none; next=return-and-payout
Test: packages/adapters/test/app/multi-pack-recovery.test.mjs — mixed batch: one purchased pack that never opens is held, the other pack still opens, gates, and sells
Alarm reason/code: OPEN FACT (WP08b): no dedicated alert code is bound to this recovery case.
Resume command: none supported by this runbook; use only the approved position-specific reconciliation path.
