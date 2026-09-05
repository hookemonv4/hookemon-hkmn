# Collector blocked

## Detection

Alert when Collector refuses a mutation, a machine is unavailable, or buyback
availability is false for the recorded mint. A received `403` or `404` before a
mutation, or a confirmed unavailable buyback response, holds the stage as
`HELD_UNAVAILABLE`. A `5xx` after a mutation is sent remains `SENT_UNKNOWN`.

## Safe stop

Do not force a purchase, open, buyback, or token submission. Do not bypass a
machine or buyback refusal with a replacement transaction. Retain the provider
response and the relevant memo or mint.

## Runner behavior

The current client does not retry any mutation response, including `5xx`. It
does not create the required durable held state or automatically move a blocked
card to an owner decision path. That lifecycle is owned by WP08b.

## Operator recovery

Existing read-only `getStatus`, `getMachines`, and `getBuybackAvailable` calls
may confirm the condition. They do not authorize a mutation. No supported
operator resume, abort, pause, or override control exists today; recovery CLI is
planned (WP12) and dashboard controls are planned (WP10b).

## Escalation

Escalate when the condition survives a read-only check, when a held card has
custody value, or when new claims could expose another card. Treat an uncertain
provider action or unmatched token delta as an immediate custody escalation.

## Evidence

Failure-matrix cell: Buyback API:unavailable.
Owning work package: WP08b.
Traceability: L4-M8.

## Recovery contract

Failure-matrix cells: Buyback API:unavailable
Owning work package: WP08b
Expected outcome: terminal=HELD_UNAVAILABLE; attempt=none; next=owner-decision
Test: packages/adapters/test/app/stages-collector-lifecycle.test.mjs — holds unavailable buyback durably after reopen before its sole owner decision
Alarm reason/code: OPEN FACT (WP08b): no dedicated alarm reason/code is emitted for this hold.
Resume command: none supported; read-only availability evidence cannot authorize a replacement mutation.
