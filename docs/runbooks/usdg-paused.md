# USDG paused

## Detection

- The USDG canary reads `paused() == true` before a production signing boundary.
- It records the failed canary against the active cycle and enters `HELD_UNAVAILABLE`; any prior
  unresolved attempt remains unchanged.

## Safe stop

- Mark the path unavailable and do not invoke a live runner for new ticks or process claims.
- Do not sign, broadcast, claim, retry an unresolved transfer, or treat another asset balance as USDG.

## Runner behavior

- The canary refuses the next irreversible action, holds the active cycle before signing, and emits
  one deduplicated alert for the drift.

## Operator recovery

- The production status output does not expose the canary evidence. Reconciliation control is planned (WP10b).
- After the issuer restores transfers, rerun the canary. Resume control is planned (WP12) and requires a clear canary and no unresolved journal entry.

## Escalation

Escalate the canary timestamp, affected Operations or recipient address, and journal digest to the USDG issuer and the release owner. Keep claims paused until both parties can review the evidence.

## Evidence

- Failure-matrix cell: `USDG canary:paused` expects `HELD_UNAVAILABLE` and is owned by WP14.
- Traceability: L1-M6 and L2-M10.

## Recovery contract

Failure-matrix cells: USDG canary:paused
Owning work package: WP14
Expected outcome: terminal=HELD_UNAVAILABLE; attempt=none; next=owner-decision
Test: packages/adapters/test/app/compose.test.mjs — holds an active cycle on a paused USDG status canary before any signing boundary
Alarm reason/code: `USDG_PAUSED`
Resume command: none supported; wait for a clear canary after the issuer removes the pause.
