# Robinhood RPC latest-only state reads

## Detection

Alert when a state read has only a `latest` block context, finality confirmation
is false or unavailable, or a historical state request returns `metadata is not
found`. Journal the value with its block number and hash; it is not finality
evidence on its own.

## Safe stop

Do not prepare a claim or payout manifest from that read. Keep the snapshot
candidate unprepared until its block context is confirmed finalized.

## Runner behavior

The client reads state at `latest`, carries the block number and hash, then uses
a separate finalized-block comparison. Eligibility snapshot rejects evidence
that cannot establish finality before a claim.

OPEN FACT: The end-to-end finality-bound holder snapshot is missing. L5-M9
assigns the construction to WP09a. Until then, keep the candidate unprepared
and do not request a claim.

## Operator recovery

No supported control can turn a latest-only state read into a finalized read.
Do not issue a custom historical state query. `resume` and `abort-cycle` are
planned (WP12); dashboard pause/resume is planned (WP10b), after a verified
snapshot is rebuilt.

## Escalation

Escalate when finalized-block confirmation remains unavailable or the required
archive/second-source evidence cannot be obtained.

## Evidence

Owning work package: WP09a.
Traceability: L5-M9.
Existing adapter evidence: latest-state reads carry block context and are
separately checked by `confirmReadFinalized`.

## Recovery contract

Failure-matrix cells: none (not in frozen matrix)
Owning work package: WP09a
Expected outcome: terminal=none; attempt=none; next=none
Test: OPEN FACT (WP09a): no executed latest-only recovery test is cited by the current runbook.
Alarm reason/code: OPEN FACT (WP09a): no dedicated alert code is emitted for a latest-only response.
Resume command: none supported; retain the pinned block and use finality-qualified reads only.
