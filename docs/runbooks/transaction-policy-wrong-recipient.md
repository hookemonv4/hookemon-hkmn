# Transaction policy wrong recipient

## Detection

Reject a decoded action whose recipient differs from the approved recipient.

## Safe stop

Do not sign, broadcast, or re-quote the rejected action.

## Runner behavior

The policy boundary records `NOT_SENT` and holds the cycle before any signature
is produced.

## Operator recovery

Correct the approved intent through its owning control path; no current command
can approve the rejected recipient.

## Escalation

Escalate the decoded recipient and request digest to the signing owner.

## Evidence

The rejected action remains unsigned and the original intent is retained.

## Recovery contract

Failure-matrix cells: Transaction policy:wrong-recipient
Owning work package: WP08a
Expected outcome: terminal=HELD_DATA_UNVERIFIED; attempt=NOT_SENT; next=owner-decision
Test: packages/adapters/test/app/stage-driver.test.mjs — holds a wrong-recipient transaction policy refusal before signing
Alarm reason/code: OPEN FACT (WP08a): no dedicated alert code is emitted for a policy refusal.
Resume command: none supported; a corrected decoded intent is required before signing.
