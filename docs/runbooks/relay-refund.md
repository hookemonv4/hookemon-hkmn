# Relay refund

## Detection

Alert only when the finalized source debit and a request-bound Relay `REFUND` pointer lead to one
finalized origin-chain USDG credit from the persisted EVM depository to Operations observed through
the Robinhood RPC client. Record `HELD_RELAY_REFUND`; a Relay status, detail response, or a negative
Solana owner delta does not prove a refund.

## Safe stop

Do not count the destination leg as delivered and do not spend the origin or
destination balance. Preserve the request identifier, status, detail response,
and finalized chain observations without issuing a new bridge action.

## Runner behavior

Outbound reconciliation writes `HELD_RELAY_REFUND` only after the process observes the exact
origin-chain credit in the pointed EVM receipt. The receipt must contain exactly one positive USDG
Transfer from the persisted depository to Operations, no larger than the attributed source amount,
at or after source finality. A destination-side debit remains unresolved. A Relay status response
alone cannot classify custody.

## Operator recovery

Allowed recovery is read-only reconciliation of the retained `RelayLegV1`, source finality, and
the pointed origin receipt. Do not accept the refund as a new route, re-quote, retry, or pay out.
No supported operator command exists today.

## Escalation

Escalate when the pointed receipt is absent or unfinalized, carries zero or multiple matching
credits, credits another account or token, precedes source finality, or any credit cannot be
attributed to this cycle. Do not use a wallet-wide balance as a substitute for refund evidence.

## Evidence

Owning work package: WP07.
Traceability: L4-M13, L4-M15.

## Recovery contract

Failure-matrix cells: Relay leg:refund-finalized-delta
Owning work package: WP07
Expected outcome: terminal=HELD_RELAY_REFUND; attempt=FINALIZED; next=owner-decision
Test: packages/adapters/test/app/cycle-repository.test.mjs — settleRelayLeg holds a process-RPC origin refund credit after reopen without a second settlement
Alarm reason/code: OPEN FACT (WP07): no dedicated alarm code is emitted for finalized Relay refund.
Resume command: none supported; retain the source finality and pointed origin receipt until the owner-decision path is recorded.
