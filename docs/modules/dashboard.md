# Dashboard

## Purpose

The dashboard is an HTTP transport and read projection over the runner's single operator-control
authority. It provides authoritative Phase 3 status and operator commands without opening a cycle
repository, reading cycle records from a state file, signing, broadcasting, deploying, spending,
or moving custody.

## Public interface

- `GET /operator/api/bootstrap` and `GET /operator/api/dashboard` return views derived from
  `operatorControl.status()`. The dashboard emits schema version 6 with canonical lifecycle state,
  per-cycle stage and request identifiers, typed transaction identifiers, cap usage, custody
  buckets, telemetry-source availability, alerts, held-owner facts, and payout status from that
  authority snapshot.
- The dashboard response validator continues to accept the prior schema versions with their
  cap-only response shape. Version 6 requires loss and outstanding-custody cap usage plus
  `alertSources`.
- `GET /operator/api/network` returns the configured `mainnet` or `testnet` profile.
  `GET /operator/api/identities` returns only public identities injected by the composed runner.
- `GET /public/api/cycle-status` and `GET /public/api/community-dashboard` derive their read-only
  responses from the same authority snapshot.
- `POST /operator/api/decisions` accepts `pause`, `resume`, `kill`, `run-cycle-now`,
  `resume-cycle`, `reconcile`, `manual-approval`, `held-owner-decision`, and
  `update-configuration`. Compatibility aliases normalize to one of those commands before dispatch.
  Its response includes the durable command state: `APPLIED` (200), `PREPARED` (202), `REJECTED`
  (409), or `UNCERTAIN` (503).
- `GET /operator/api/audit` pages the SQLite projection of the durable audit log. The log is
  authoritative; SQLite is rebuildable.

## Invariants

- Every offered control maps to at most one `operatorControl.execute({ expectedRevision, command })`
  call. The dashboard has no local substitute for an unavailable authority.
- The active-cycle display uses a terminal state before lifecycle stages. A missing payout remains
  unavailable rather than becoming a synthetic pending payout.
- Cap and telemetry fields are copied from the authority snapshot. The dashboard does not calculate
  a balance, substitute a missing transaction identifier, or treat an empty alert list as a healthy
  telemetry source.
- The owner page labels supplied on-chain claim capacity as a six-hour value. Otherwise it labels
  the authority's fallback as an off-chain 24-hour ledger. Held-card information and wallet balances
  are shown only when present in the authority snapshot; the page does not infer either value or a
  held-card decision.
- A command records a hash-chained `PREPARED` audit receipt before the authority call, then appends
  `APPLIED`, `REJECTED`, or `UNCERTAIN` after the outcome is known. Each record binds the request ID,
  expected revision, normalized command, and note. A duplicate request ID with the same digest
  reports its latest durable state without another effect. A reused ID with another digest is
  rejected.
- The owner page retains a request ID across lost responses, reloads, `PREPARED`, and `UNCERTAIN`
  results. It clears that key only after `APPLIED` or a deterministic `REJECTED` result, so an
  unresolved effect cannot be retried under a new request ID.
- Audit reservations and terminal appends take a short process-local queue slot and a cross-process
  audit-log file lock. Authority effects execute after the reservation lock is released, so one slow
  or failed effect cannot block a later audit append.
- Both standalone and composed dashboard startup verify the complete audit hash chain before
  rebuilding the SQLite projection. A malformed chain prevents startup rather than exposing control
  routes against corrupted evidence.
- Reconcile dispatches only the runner's read-only reconcile command. It does not trigger a
  scheduler tick, recovery, signing, or provider mutation.
- The dashboard never signs, broadcasts, deploys, spends, moves custody, or substitutes for the
  runner authority.
- The dashboard profile defaults to `mainnet`. A supplied chain ID must match that profile before a
  request listener is created.
- The owner page shows network profile, cycles, claim capacity, custody buckets, manual approval
  fields, held-cycle facts, alerts, payout state, and public wallet identities. Its controls map
  one-to-one to supported commands, including digest- and revision-bound held-owner decisions.

## State transitions

The route reads the current authority revision, reserves a `PREPARED` audit record, then invokes
the authority outside the audit lock. It appends a terminal `APPLIED`, `REJECTED`, or `UNCERTAIN`
record and projects both durable records into SQLite. A retry reads the terminal record, or an
unresolved `PREPARED` record, without invoking the authority again. Pause, resume, kill, and
configuration changes persist through the runner control service. Manual approval remains
digest-bound. Held-owner decisions remain bound to the repository's held evidence and cycle
revision. Run-now and resume-cycle invoke their composed runner capabilities. Reconcile returns its
inspection through the same authority boundary.

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
  idempotent-effect receipt keyed by the audit request ID, with restart-recovery tests. Verified safe
  alternative: return `PREPARED` or `UNCERTAIN`, never rerun the effect from the dashboard, and
  require the operator to inspect the runner before issuing a new ID.
- OPEN FACT: The authority has no typed outcome for a validation failure known to be non-mutating,
  such as a fixed-cap configuration refusal. Resolve it by documenting a typed `REJECTED` authority
  result and retaining it in the audit lifecycle. Verified safe alternative: record an authority
  exception as `UNCERTAIN` rather than infer that no effect occurred.
