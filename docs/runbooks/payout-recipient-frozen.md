# Payout recipient frozen

## Detection

- A payout canary or transfer result shows that a manifest recipient cannot receive USDG because the address is frozen.
- Retain that recipient record as `REFUSED`, move its amount to quarantine, and record
  `HELD_OWNER_DECISION` only after the remaining immutable-manifest recipients have been processed.

## Safe stop

- Keep the manifest immutable. Do not substitute a recipient, recompute allocation, or mark the amount paid.
- Continue only later recipients from the same immutable plan; do not prepare another payment for
  the refused recipient.

## Runner behavior

- The runner isolates the recipient as a quarantine liability, preserves its exact amount and
  evidence, and advances later recipients. It holds the cycle only after the payout pass is
  complete, leaving the quarantined liability for an owner decision.

## Operator recovery

- No existing command changes the destination. The owner-decision record cannot itself create a
  payment or alter the frozen manifest.

## Escalation

Escalate the recipient address, canary or transfer evidence, manifest digest, and quarantine amount to the USDG issuer and payout owner.

## Evidence

- Failure-matrix cell: `Payout:frozen-recipient` expects `HELD_OWNER_DECISION` and is owned by WP09b.
- Traceability: L2-M12 and L5-M8.

## Recovery contract

Failure-matrix cells: Payout:frozen-recipient
Owning work package: WP09b
Expected outcome: terminal=HELD_OWNER_DECISION; attempt=REFUSED; next=owner-decision
Test: packages/adapters/test/app/stages-payout.test.mjs — quarantines a frozen recipient, finalizes a later recipient, then holds reopened custody
Alarm reason/code: OPEN FACT (WP09b): no dedicated alert code is emitted for a frozen payout recipient.
Resume command: none supported; retain the immutable manifest and quarantine liability pending an owner decision.
