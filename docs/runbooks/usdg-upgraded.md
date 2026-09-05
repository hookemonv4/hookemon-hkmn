# USDG upgraded

## Detection

- Planned alert reason (WP14): the USDG proxy implementation or runtime hash differs from the pinned canary value. A decimals, pause, or freeze read that changes with the implementation is the same incident.
- Target journal state: preserve the current stage and its evidence; do not create a new `PREPARED` action after the drift.

## Safe stop

- Mark the path unavailable, do not invoke a live runner, and leave any unsigned or unresolved action in its existing journal state. An execution-pause control is planned (WP10b).
- Do not accept the new implementation, change token metadata, or bypass the runtime-hash check from the runner.

## Runner behavior

- Planned (WP14): the runner rejects the next signature, writes one drift alert, and permits read-only reconciliation of existing attempts.
- Until WP14 lands, do not classify a changed implementation as equivalent from an address match alone or start a new manual action.

## Operator recovery

- The production status output does not expose implementation evidence. Reconciliation control is planned (WP10b).
- No CLI or dashboard control accepts a new implementation hash. A reviewed binding update must precede a clear canary; resume is planned (WP12) and remains unavailable until then.

## Escalation

Escalate the old and observed runtime hashes, block reference, canary record, and affected cycle to the USDG issuer and release owner for binding review.

## Evidence

- Owning work package: WP14.
- Traceability: L1-M6 and L2-M10.
- No matching failure-matrix cell exists; WP14 owns the upgraded-USDG alert and terminal-state test.

## Recovery contract

Failure-matrix cells: none (not in frozen matrix)
Owning work package: WP14
Expected outcome: terminal=none; attempt=none; next=none
Test: packages/runner/test/observability/canaries.test.mjs — every unsafe canary observation blocks signing and requests one actionable alert
Alarm reason/code: OPEN FACT (WP14): the implementation-change alert code is not covered by a runbook recovery test.
Resume command: none supported; a reviewed binding update and clear canary are required first.
