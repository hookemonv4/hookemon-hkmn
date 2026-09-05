# Dashboard

## Purpose

The dashboard is an HTTP transport and read projection over the runner's single operator-control
authority. It shows cycle and held-position state and accepts authorized operator commands without
opening a cycle repository, reading cycle records from a state file, signing, broadcasting,
deploying, spending, or moving custody.

## Public interface

- `GET /operator/api/bootstrap` and `GET /operator/api/dashboard` return views derived from
  `operatorControl.status()`. Dashboard schema version 7 includes lifecycle state, cycle data,
  cap usage, custody buckets, alerts, private held-position records, and held-position limit usage.
  A held-position record includes its position and cycle IDs, reason, age, typed insured value or
  purchase cost, evidence digest, decision state, terminal state, and revision.
- The bootstrap configuration includes `maxHeldPositions`, `maxHeldValueMicroUsdg`, and
  `unresolvedCardDeadlineMinutes`. The decision endpoint accepts those fields through
  `update-configuration` with the runner's validation ranges.
- `POST /operator/api/decisions` accepts `held-owner-decision` for one `positionId`,
  `heldEvidenceDigest`, `expectedPositionRevision`, and `choice` (`sell` or `keep-holding`). Its
  response reports the durable command state: `APPLIED` (200), `PREPARED` (202), `REJECTED` (409),
  or `UNCERTAIN` (503). An accepted `sell` starts that position's durable supplementary settlement;
  the dashboard never constructs a transfer locally.
- `GET /public/api/cycle-status` emits public schema version 5 and
  `GET /public/api/community-dashboard` emits public schema version 7. Both expose only held
  position count plus each position's `reason`, `ageSeconds`, and public `cycleState`. Public responses
  never expose a position ID, cycle ID, memo, mint, card reference, value, or evidence digest.
  Their contract normalizers retain strict backwards-compatible validation for version-4
  cycle-status and version-6 community input, while new route responses use the identifier-free
  version-5 and version-7 shapes.
- `GET /operator/api/network` returns the configured `mainnet` or `testnet` profile.
  `GET /operator/api/identities` returns only public identities injected by the composed runner.
- `GET /operator/api/audit` pages the SQLite projection of the durable audit log. The log is
  authoritative; SQLite is rebuildable.

## Invariants

- Every offered control maps to at most one `operatorControl.execute({ expectedRevision, command })`
  call. The dashboard has no local substitute for an unavailable authority.
- Held-position reason classes, values, age seconds, decision state, and cap usage are copied from
  the authority snapshot. The dashboard does not calculate a custody value, infer a missing
  decision, or turn an empty position list into a clearance decision.
- Public routes remove position and cycle identifiers, memo, mint, card reference, purchase cost,
  insured value, and evidence digest before validation and serialization. They do not expose a
  signer identity, exact holder balance, or in-flight authorization digest.
- Public contract compatibility accepts only the documented version-4 and version-6 predecessor
  keys. It rejects mixed, extra, or missing held-position fields rather than silently treating a
  legacy payload as a current public projection.
- The active-cycle display uses a terminal state before lifecycle stages. A missing payout remains
  unavailable rather than becoming a synthetic pending payout.
- A command records a hash-chained `PREPARED` audit receipt before the authority call, then appends
  `APPLIED`, `REJECTED`, or `UNCERTAIN` after the outcome is known. Each record binds the request
  ID, expected revision, normalized command, and note. A duplicate request ID with the same digest
  reports its latest durable state without another effect. A reused ID with another digest is
  rejected.
- The owner page retains a request ID across lost responses, reloads, `PREPARED`, and `UNCERTAIN`
  results. It clears that key only after `APPLIED` or a deterministic `REJECTED` result.
- Both standalone and composed startup verify the complete audit hash chain before rebuilding the
  SQLite projection. A malformed chain prevents startup rather than exposing control routes against
  corrupted evidence.
- The dashboard never signs, broadcasts, deploys, spends, moves custody, or substitutes for the
  runner authority.

## State transitions

The route reads the current authority revision, reserves a `PREPARED` audit record, invokes the
authority outside the audit lock, then appends `APPLIED`, `REJECTED`, or `UNCERTAIN`. A retry reads
the durable record without invoking the authority again. A held-owner decision remains bound to one
position's evidence digest and position revision. A `sell` decision starts the repository-backed
supplementary settlement for that position; a `keep-holding` decision leaves the position in the
authority's limit calculation.

## Operational commands

Start the composed service with `node packages/adapters/bin/hookemon-runner.mjs run`, then open
`http://127.0.0.1:8787` unless `HOOKEMON_DASHBOARD_PORT` selects another port. The browser
credential is `HOOKEMON_DASHBOARD_PROXY_CREDENTIAL`. Run the dashboard tests with Node 24, then run
`node scripts/check-cleanroom.mjs .`. Rebuild the SQLite audit projection from the durable log after
a projection loss or migration issue.

## Recovery pointers

If an authority call fails after a `PREPARED` receipt, the command becomes `UNCERTAIN`; retrying the
same request ID reports that state without another invocation. If a process ends with a `PREPARED`
record, do not rerun its effect locally. Verify runner state before intentionally issuing a new
request ID. Do not construct a local cycle store as a fallback. Rebuild SQLite from the verified
audit log if its projection is missing or stale.

- OPEN FACT: The dashboard can show that required safety telemetry is unavailable, but composition
  does not yet provide a read-only persistent canary-alert feed. Resolve it by exposing a typed,
  read-only alert snapshot from the composed observability service. Verified safe alternative: show
  the unavailable source and its authority alert; do not infer that no alerts means the source is
  healthy.
- OPEN FACT: The authority has no request-ID keyed reconciliation result for an audit record left in
  `PREPARED` after a process interruption. Resolve it by adding a documented authority status or
  idempotent-effect receipt keyed by the audit request ID, with restart-recovery tests. Verified
  safe alternative: return `PREPARED` or `UNCERTAIN`, never rerun the effect from the dashboard,
  and require the operator to inspect the runner before issuing a new ID.
