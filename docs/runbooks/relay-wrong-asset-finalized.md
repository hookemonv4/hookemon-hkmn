# Relay wrong-asset finalized delta

## Detection

Inspect a rejected native return when its destination receipt has the wrong
asset or recipient. The authenticated payment producer refuses that receipt
before settlement; the attempt remains `RECORDED` and the journal is unchanged.

## Safe stop

Do not settle, swap, re-quote, create a replacement bridge, or pay out from the
credit. Preserve the complete `RelayLegV1` and both finalized observations.

## Runner behavior

Native return reconciliation requires the release-bound Relay runtime, exact
order metadata and one successful native payment to Operations. A wrong asset
or recipient cannot produce authenticated payment evidence or payout custody.

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
Expected outcome: terminal=null; attempt=RECORDED; next=owner-decision
Test: packages/adapters/test/app/cycle-repository.test.mjs — native return refuses a wrong-token or wrong-recipient receipt before settlement after reopen
Alarm reason/code: OPEN FACT (WP07): no dedicated alarm code is emitted for finalized wrong-asset Relay delta.
Resume command: none supported; retain both finalized deltas until the owner-decision path is recorded.
