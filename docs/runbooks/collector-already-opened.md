# Collector already opened

## Detection

Alert when Collector reports that a pack is already opened and does not supply
the transaction signature needed to derive the card mint. Treat `mint: null` as
`HELD_DATA_UNVERIFIED`, never as a completed card that can enter buyback.

## Safe stop

Do not open the pack again, purchase another pack, infer a mint, or submit a
buyback. Retain the original memo, provider response, and any Solana evidence.

## Runner behavior

When an already-recorded provider response lacks its memo-bound mint, the open
stage holds the cycle `HELD_DATA_UNVERIFIED` and retains the
`RESPONSE_RECORDED` attempt. It does not retry the mutation.

## Operator recovery

The existing client exposes read-only `getPackStatus({ memo })` for an already
recorded memo. It can collect evidence but cannot authorize another open. No
supported operator resume or abort command exists today; those are planned
(WP12), and the owner decision control is planned (WP10b).

## Escalation

Escalate if pack status cannot bind the memo to a finalized transaction and one
unambiguous card mint, or if any subsequent action has already been attempted.
The card and the cycle stay held until that evidence exists.

## Evidence

Failure-matrix cell: Open result:missing-mint-response-recorded.
Owning work package: WP08b.
Traceability: L4-M1.

## Recovery contract

Failure-matrix cells: Open result:missing-mint-response-recorded
Owning work package: WP08b
Expected outcome: terminal=HELD_DATA_UNVERIFIED; attempt=RESPONSE_RECORDED; next=owner-decision
Test: packages/adapters/test/app/stages-collector-lifecycle.test.mjs — open response missing its memo-bound mint holds durably without a retry
Alarm reason/code: OPEN FACT (WP08b): no dedicated alarm reason/code is emitted for this hold.
Resume command: none supported; preserve the memo and reconcile through the approved operator control.
