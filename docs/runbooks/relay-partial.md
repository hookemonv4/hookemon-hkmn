# Relay partial delivery

## Detection

Alert when both own-RPC observations finalize but the attributed destination
delta is smaller than the recorded leg. Record `HELD_RELAY_PARTIAL`; a Relay
shortfall classification alone is not sufficient settlement evidence.

## Safe stop

Stop the affected cycle before the next money-moving stage. Do not bridge a
second amount, spend a shared wallet balance, or classify the difference as a
fee, dust, or unrelated deposit.

## Runner behavior

Return reconciliation requires the Relay terminal pointer, this process's
finalized source and destination observations, an exact destination USDG
Transfer, and the configured settlement window. A shortfall persists
`HELD_RELAY_PARTIAL` before payout custody can be recorded.

## Operator recovery

Allowed recovery is read-only reconciliation of the retained `RelayLegV1` and
both finalized observations. Do not retry, bridge a replacement amount, or pay
out. No supported operator command can resume or abort this case today.

## Escalation

Escalate for any nonzero shortfall, missing amount evidence, asset mismatch, or
unattributed destination credit. The cycle must remain unresolved until the
exact finalized deltas and custody attribution agree.

## Evidence

Owning work package: WP07.
Traceability: L4-M15.

## Recovery contract

Failure-matrix cells: Relay leg:partial-finalized-delta
Owning work package: WP07
Expected outcome: terminal=HELD_RELAY_PARTIAL; attempt=FINALIZED; next=owner-decision
Test: packages/adapters/test/app/cycle-repository.test.mjs — settleRelayLeg holds a wrong-amount return receipt as HELD_RELAY_PARTIAL after reopen
Alarm reason/code: OPEN FACT (WP07): no dedicated alarm code is emitted for finalized Relay shortfall.
Resume command: none supported; retain both finalized deltas until the owner-decision path is recorded.
