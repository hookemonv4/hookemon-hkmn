# Native principal canary: wrong principal identity

## Detection

The canary refuses the next signing boundary when the observed asset identity differs from 4663/native/18. It records `HELD_UNAVAILABLE` against the active cycle and preserves existing attempts.

## Safe stop

Do not sign, broadcast, claim, substitute another asset or retry an unresolved payment. Preserve the intended account, principal, gas reservation and RPC observation.

## Runner behavior

The active stage remains pending with no new attempt or signer invocation. The canary records `NATIVE_PRINCIPAL_UNVERIFIED`; the held cycle requires an owner decision.

## Operator recovery

Inspect the configured chain and native identity, finalized balance and existing obligations. A funding or configuration change requires its own authority. No supported command silently resumes a terminal held cycle.

## Escalation

Provide the cycle identifier, exact typed principal, gas reservation and observed checkpoint to the release owner.

## Evidence

The cited composed test verifies the held state after reopening and zero mutation, signing and broadcast calls.

## Recovery contract

Failure-matrix cells: Native principal canary:wrong-principal-identity
Owning work package: WP14
Expected outcome: terminal=HELD_UNAVAILABLE; attempt=none; next=owner-decision
Test: packages/adapters/test/app/compose.test.mjs — holds an active cycle on a wrong native principal identity before any signing boundary
Alarm reason/code: `NATIVE_PRINCIPAL_UNVERIFIED`
Resume command: none supported; retain the failed observation for an owner decision.
