# Relay wrong-asset finalized delta

## Detection

Alert when an own-RPC finalized destination delta is attributable to the leg
but has an asset identity different from the recorded destination asset. Record
`HELD_RELAY_WRONG_ASSET`.

## Safe stop

Do not settle, swap, re-quote, create a replacement bridge, or pay out from the
credit. Preserve the complete `RelayLegV1` and both finalized observations.

## Runner behavior

Return reconciliation verifies one exact USDG Transfer to Operations from this
process's finalized destination receipt. A wrong token or recipient persists
`HELD_RELAY_WRONG_ASSET` before payout custody can be recorded.

## Operator recovery

Allowed recovery is read-only inspection of the recorded leg, own-RPC finality,
and exact asset evidence. No supported operator command can resume or abort it.

## Escalation

Escalate the request identifier, transaction hashes, source and destination
asset identities, amounts, and finality observations for an owner decision.

## Evidence

Owning work package: WP07.
Traceability: L4-M15.

## Recovery contract

Failure-matrix cells: Relay leg:wrong-asset-finalized-delta
Owning work package: WP07
Expected outcome: terminal=HELD_RELAY_WRONG_ASSET; attempt=FINALIZED; next=owner-decision
Test: packages/adapters/test/app/cycle-repository.test.mjs — settleRelayLeg holds a wrong-token or wrong-recipient return receipt as HELD_RELAY_WRONG_ASSET after reopen
Alarm reason/code: OPEN FACT (WP07): no dedicated alarm code is emitted for finalized wrong-asset Relay delta.
Resume command: none supported; retain both finalized deltas until the owner-decision path is recorded.
