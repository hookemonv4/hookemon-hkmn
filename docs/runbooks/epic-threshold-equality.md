# Epic threshold equality

## Detection

When `offerAtomic * 100 == insuredValueAtomic * 40`, classify the card as
sellable rather than held.

## Safe stop

Do not reinterpret equality as a held-card decision.

## Runner behavior

The epic gate advances equality to the buyback path.

## Operator recovery

No recovery command is required for the equality case.

## Escalation

Escalate only conflicting quote or insurance evidence.

## Evidence

The equality decision and its typed inputs remain attached to the buyback path.

## Recovery contract

Failure-matrix cells: Epic gate:threshold-equality
Owning work package: WP08b
Expected outcome: terminal=none; attempt=none; next=buyback
Test: packages/adapters/test/app/stages-collector-lifecycle.test.mjs — keeps a forty-percent epic equality sellable after a real repository reopen
Alarm reason/code: OPEN FACT (WP08b): no dedicated equality alert code is emitted.
Resume command: none supported; this branch proceeds through the ordinary buyback stage.
