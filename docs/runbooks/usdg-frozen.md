# USDG frozen

## Detection

- The USDG canary reads `isFrozen(address) == true` for Operations or an intended destination.
- It retains the pending stage and records `HELD_UNAVAILABLE`; it does not create a replacement
  recipient record.

## Safe stop

- Mark the path unavailable and do not invoke a live runner before the next claim, signature, or payout.
- Preserve the original recipient, typed amount, and journal bytes. A different destination cannot repair a frozen address.

## Runner behavior

- The runner refuses the pending irreversible action, deduplicates the alert, and leaves unresolved
  attempts available only for observation.

## Operator recovery

- The production status output does not expose the affected account or canary evidence. Reconciliation control is planned (WP10b).
- After the issuer clears the freeze, rerun the canary. Resume control is planned (WP12) and requires a clear canary and resolved earlier attempts.

## Escalation

Send the frozen address, canary result, affected cycle, and journal digest to the USDG issuer and the release owner. Treat an Operations-address freeze as a signing and custody incident.

## Evidence

- Failure-matrix cell: `USDG canary:frozen` expects `HELD_UNAVAILABLE` and is owned by WP14.
- Traceability: L1-M6 and L2-M10.

## Recovery contract

Failure-matrix cells: USDG canary:frozen
Owning work package: WP14
Expected outcome: terminal=HELD_UNAVAILABLE; attempt=none; next=owner-decision
Test: packages/adapters/test/app/compose.test.mjs — holds an active cycle on a frozen USDG status canary before any signing boundary
Alarm reason/code: `USDG_FROZEN`
Resume command: none supported; use an unfrozen configured account and require a clear canary before signing.
