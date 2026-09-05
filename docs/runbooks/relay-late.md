# Relay late finalized delta

## Detection

Alert when an attributable own-RPC delta finalizes after the recorded Relay leg
has passed its permitted attribution window. Record `HELD_RELAY_LATE`.

## Safe stop

Do not settle, retry, re-quote, create a replacement bridge, or pay out from a
late credit. Preserve the complete `RelayLegV1` and both finalized observations.

## Runner behavior

Return reconciliation compares the finalized destination block timestamp with
the persisted request window and writes `HELD_RELAY_LATE` before payout custody
can be recorded.

## Operator recovery

Allowed recovery is read-only inspection of the recorded leg, own-RPC finality,
and attribution evidence. No supported operator command can resume or abort it.

## Escalation

Escalate the request identifier, source and destination transaction hashes,
timestamps, asset identities, and finality observations for an owner decision.

## Evidence

Owning work package: WP07.
Traceability: L4-M15.

## Recovery contract

Failure-matrix cells: Relay leg:late-finalized-delta
Owning work package: WP07
Expected outcome: terminal=HELD_RELAY_LATE; attempt=FINALIZED; next=owner-decision
Test: packages/adapters/test/app/cycle-repository.test.mjs — settleRelayLeg holds a late return receipt as HELD_RELAY_LATE after reopen
Alarm reason/code: OPEN FACT (WP07): no dedicated alarm code is emitted for late Relay finality.
Resume command: none supported; retain both finalized deltas until the owner-decision path is recorded.
