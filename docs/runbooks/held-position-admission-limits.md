# Held-position admission limits

## Detection

Held-position count or value reaches the configured claim admission limit.

## Safe stop

Do not admit another claim or remove held value from custody accounting.

## Runner behavior

Claim admission refuses at either bound. Existing positions retain their evidence and ownership.

## Operator recovery

Resolve positions through the approved attributed path; changing a limit requires its own owner authority.

## Escalation

Escalate conflicting identities, custody deltas or repeated effects before permitting another mutation.

## Evidence

Preserve the original cycle, position, attempt and evidence digests. The cited test establishes the bounded recovery case below.

## Recovery contract

Failure-matrix cells: Claim admission:held-position-count-limit; Claim admission:held-position-value-limit
Owning work package: WP10a
Expected outcome: terminal=none; attempt=none; next=claim-refused
Test: packages/runner/test/automation/policy-engine.test.mjs — claim admission refuses at the held-position count or value limit
Alarm reason/code: OPEN FACT (WP10a): no dedicated alert code is bound to this recovery case.
Resume command: none supported by this runbook; use only the approved position-specific reconciliation path.
