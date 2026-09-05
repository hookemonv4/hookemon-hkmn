# Unattributed deposit

## Detection

- Planned alert reason (WP10a): the custody ledger records an inbound typed amount with no verified cycle attribution.
- Target journal state: retain the amount in the unattributed bucket and mark the affected claim path unavailable.

## Safe stop

- Mark the claim path unavailable and do not invoke a live runner for new process claims. An execution-pause control is planned (WP10b).
- Do not net the deposit against another cycle, use it for a payout, or assign it from a wallet-balance guess.

## Runner behavior

- Planned (WP10a): the claim stage checks custody blockers and refuses a new claim while unattributed value remains.
- Until WP10a lands, do not create a compensating transfer and retain existing attempts for reconciliation.

## Operator recovery

- The production status output does not expose finality or source evidence. Reconciliation control is planned (WP10b).
- No manual attribution control exists. A custody decision surface is planned (WP10b); retain the amount until that control records an approved decision.

## Escalation

Escalate the typed amount, chain, asset, observed transfer, custody record, and candidate source evidence to the cycle owner. Keep claims paused when attribution remains unproven.

## Evidence

- Owning work package: WP10a.
- No matching failure-matrix cell exists; WP10a owns claim blocking and WP10b owns the planned operator-control evidence.

## Recovery contract

Failure-matrix cells: none (not in frozen matrix)
Owning work package: WP10a
Expected outcome: terminal=none; attempt=none; next=none
Test: packages/runner/test/observability/canaries.test.mjs — all required pre-signature checks pass only with current matching evidence
Alarm reason/code: `UNATTRIBUTED_CUSTODY`
Resume command: none supported; resolve the custody attribution before a new claim is prepared.
