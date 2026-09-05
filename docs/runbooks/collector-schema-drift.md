# Collector schema drift

## Detection

Alert when Collector returns non-JSON data, omits a documented required field,
or changes a response variant so the client raises `CollectorCryptError`. Keep
the affected provider attempt unresolved; a parser exception is not proof that
the mutation did not happen.

## Safe stop

Do not relax validation, reinterpret unknown fields, or retry a mutation to see
whether a new response shape succeeds. Suspend the affected stage and retain the
request, response body, endpoint, and parser error as evidence.

## Runner behavior

The adapter rejects malformed responses rather than returning a guessed value.
It has no durable schema-drift reconciliation or automatic compatibility mode;
the required mutation lifecycle and fixtures are owned by WP08b.

## Operator recovery

Existing read-only Collector calls may be used only to preserve corroborating
evidence for an already-known memo or mint. There is no supported command to
override the schema or continue the cycle. `resume` and `abort-cycle` are
planned (WP12); dashboard controls are planned (WP10b).

## Escalation

Escalate if the drift follows any mutation, if a required mint, memo, signature,
or amount is missing, or if the provider documentation no longer matches the
observed response. Keep the cycle held until the provider contract is verified.

## Evidence

Owning work package: WP08b.
Traceability: L4-M7.

## Recovery contract

Failure-matrix cells: none (not in frozen matrix)
Owning work package: WP08b
Expected outcome: terminal=none; attempt=none; next=none
Test: OPEN FACT (WP08b): no executed schema-drift recovery test exists.
Alarm reason/code: OPEN FACT (WP08b): no dedicated alarm reason/code is emitted for schema drift.
Resume command: none supported; retain the provider evidence until the response contract is verified.
