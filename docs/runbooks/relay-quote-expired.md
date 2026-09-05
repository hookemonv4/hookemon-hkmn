# Relay quote expired

## Detection

Treat an expired Relay quote as unavailable before any signature or broadcast.

## Safe stop

Do not sign an expired quote or create a replacement economic action.

## Runner behavior

The cycle is held and preserves the expired quote with its request evidence.

## Operator recovery

No supported command can re-quote a held cycle.

## Escalation

Escalate the quote expiry, request digest, and available custody evidence.

## Evidence

The original quote and its expiry remain attached to the held cycle.

## Recovery contract

Failure-matrix cells: Relay quote:expired-quote
Owning work package: WP07
Expected outcome: terminal=HELD_UNAVAILABLE; attempt=none; next=owner-decision
Test: packages/adapters/test/app/stage-driver.test.mjs — holds an expired Relay quote before any request or broadcast
Alarm reason/code: OPEN FACT (WP07): no dedicated alert code is emitted for quote expiry.
Resume command: none supported; an approved reconciliation must resolve the original held cycle first.
