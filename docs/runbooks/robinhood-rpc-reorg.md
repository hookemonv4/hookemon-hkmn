# Robinhood RPC reorganization during log scan

## Detection

Alert when a log page's ending block hash differs before and after `eth_getLogs`,
or page retries exhaust with `RobinhoodFinalityUnavailableError`. Journal the
candidate snapshot as `HELD_DATA_UNVERIFIED` and retain both observed hashes.

## Safe stop

Stop before `claim-process`. Discard the invalidated snapshot; do not patch its
hash, merge its logs with a later page, or reuse it for a payout manifest.

## Runner behavior

`getTransferLogs` retries a reorged page from scratch and never returns an
unstable page. The eligibility path requires a finalized block and hash recheck;
`reconcileLiveEligibilitySnapshot` holds the cycle `HELD_DATA_UNVERIFIED` when
that recheck fails.

## Operator recovery

No current CLI/dashboard action rebuilds a snapshot or edits its hash. Do not
use manual log data. `resume` and `abort-cycle` are planned (WP12); dashboard
pause/resume is planned (WP10b) after a newly verified snapshot exists.

## Escalation

Escalate when page retries exhaust, a second source disagrees, or a reorg occurs
after the finalized block was pinned.

## Evidence

Failure-matrix cell: Snapshot:reorg.
Owning work package: WP09a.
Existing adapter test: a changed page hash is retried; repeated changes fail closed.

## Recovery contract

Failure-matrix cells: Snapshot:reorg
Owning work package: WP09a
Expected outcome: terminal=HELD_DATA_UNVERIFIED; attempt=none; next=owner-decision
Test: packages/adapters/test/app/eligibility-snapshot.test.mjs — holds a snapshot reorg durably after reopen before the sole claim transition
Alarm reason/code: OPEN FACT (WP09a): no dedicated alert code is emitted for a snapshot reorganization.
Resume command: none supported; discard the invalid snapshot evidence and rebuild at a finalized block.
