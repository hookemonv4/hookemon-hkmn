# Pool protocol fee set

## Detection

- Planned alert reason (WP14): the pool-fee canary observes nonzero protocol or live LP fee state, or the canonical callback rejects that state.
- Target journal state: retain the pending stage without a new signature or broadcast and record the canary drift.

## Safe stop

- Mark the path unavailable and do not invoke a live runner for new claims or scheduled work. An execution-pause control is planned (WP10b).
- Do not treat the observed pool fee as project revenue or amend accounting around a rejected swap.

## Runner behavior

- Planned (WP14): the runner refuses the next irreversible action and emits one deduplicated drift alert.
- Until WP14 lands, stop before a new manual action and retain existing transactions for read-only reconciliation.

## Operator recovery

- The production status output does not expose the canary evidence. Reconciliation control is planned (WP10b).
- No existing CLI or dashboard control changes a pool protocol fee. After the controlling protocol restores zero fee state, rerun the canary before the planned (WP12) resume control.

## Escalation

Escalate the pool identifier, observed fee state, canary result, and callback evidence to the pool protocol controller and release owner. `CONFUSION FEE-01` does not authorize a pool-fee exception.

## Evidence

- Owning work package: WP14.
- Traceability: L1-M5 and L5-M18.
- No matching failure-matrix cell exists; WP14 owns the fee-drift alert and terminal-state test.

## Recovery contract

Failure-matrix cells: none (not in frozen matrix)
Owning work package: WP14
Expected outcome: terminal=none; attempt=none; next=none
Test: packages/runner/test/observability/canaries.test.mjs — decodes the protocol and live LP fees from the canonical pool slot0 word
Alarm reason/code: `POOL_FEE_NONZERO`
Resume command: none supported; a clear canary is required after the protocol controller restores zero fees.
