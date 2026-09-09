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
- `GET /public/api/cycle-history` returns a schema version 1, paginated, read-only page of terminal
  cycles from the same authority snapshot, ordered by verified terminal completion time descending
  (ties by cycle ID ascending). Optional `?limit=` (1-20, default 10) and `?cursor=` query an opaque
  cursor from a prior page's `nextCursor`; any other query key, or an out-of-range `limit`, is
  rejected as `QUERY_INVALID`. If any terminal cycle in the source set lacks a verified terminal
  timestamp, the whole response fails closed: `historyComplete: false`, `items: []`,
  `nextCursor: null`, rather than ordering only the reachable subset and hiding the gap.
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
- Cycle history never mints a terminal timestamp or an ordering it cannot prove. A page is only
  ever computed from a source set where every returned item already carries a verified terminal
  timestamp; the route does not substitute a missing one or infer order from array position.
- The owner page labels supplied on-chain claim capacity as a six-hour value. Otherwise it labels
  the authority's fallback as an off-chain 24-hour ledger. Held-card information and wallet balances
  are shown only when present in the authority snapshot; the page does not infer either value or a
  held-card decision.
- A command records a hash-chained `PREPARED` audit receipt before the authority call, then appends
  `APPLIED`, `REJECTED`, or `UNCERTAIN` after the outcome is known. Each record binds the request ID,
  expected revision, normalized command, and note. A duplicate request ID with the same digest
  reports its latest durable state without another effect. A reused ID with another digest is
  rejected.
- Fixed USD cap refusals are deterministic pre-effect rejections: the audit records `REJECTED` and
  HTTP returns 409. Unclassified authority errors retain `UNCERTAIN` and HTTP 503.
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

The owner page lists the authenticated `/operator/api/packs` catalog with checkboxes, select-all,
clear and save controls. Selection comes from the stored `packPlan.orders`, independently of the
safety allowlist. Existing quantities remain visible and preserved; newly selected packs receive
quantity one. The revision-checked `update-configuration` command accepts exactly
`packPlan: { orders: [{ pack, quantity }] }`; clients cannot assign a plan schema or revision.
The runner owns plan revisions. Bootstrap exposes the complete validated versioned plan.

Saving unions selected codes into the existing `allowedPackIds`, so deselecting a pack or clearing
the plan does not remove permission needed by an already admitted cycle. Empty selection stores
an empty plan. Saving does not start a cycle or buy a pack. Previously selected codes absent from
the catalog remain visible until deselected. An unavailable catalog disables saving without hiding
the dashboard. Provider names render as text. Confirmation compares authoritative plan readback,
including quantities; uncertain requests retain their identity for reconciliation.

Legacy bootstrap payloads without a plan remain readable, but the page disables plan saving and
never infers selection from their safety allowlist. Operator configuration v6 retains native public
accounting schema v7. No monetary contract is relaxed for compatibility.

The page persists the plan through the injected operator authority. Cycle execution must consume
the plan through the runner's admission and snapshot integration. A standalone dashboard without
that composition has no production authority or catalog, and a read-only local service remains
read-only. Adding permitted packs retains the authority's safety-telemetry checks.

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
  result and retaining it in the audit lifecycle. Verified alternative: the exact-message classifier
  recognizes stale-revision and fixed-cap refusals as `REJECTED`; unclassified authority exceptions
  remain `UNCERTAIN`.

The bootstrap hard-cap projection exposes only its four published pack-spend fields. Additional runner custody limits remain enforced by the operator authority and do not change the dashboard response schema.

## Native money boundary

Cycle status v7, community snapshots v9 and the private dashboard v7 carry native accounting.
`native-accounting.mjs` validates integer wei separately from micro-USD valuation fields and rejects
historical `MicroUsdg` keys in native money surfaces. A validation-only historical skeleton checks
unchanged layout and metadata fields with amount-presence sentinels; native scalars are never
copied into historical money output. Existing public versions through cycle v6 and community v8
retain their original readers. The standalone website parser copies are byte-parity tested.

`hookemon.native-round-accounting.v1` identifies native round records. Release, outbound bridge
and return amounts carry the explicit 4663/native/18 identity; Collector debit and proceeds retain
their Solana asset identity. Physical balances, reserves and payout liabilities use `Wei`; economic
valuations use `MicroUsd` and remain null without corresponding evidence. A funding quote does
not establish actual pack spend. Lifetime monetary totals remain null without an accounting index.

Operator bootstrap and configuration decisions use USD caps with `MicroUsd` names. Historical
USDG configuration keys fail validation before a command reaches the runner. Native public payout
projection requires a trusted native asset and Operations identity, a native v2 result, validated
recipient proofs and full paid/liability/dust conservation; terminal lifecycle status alone does
not establish payment. Native cycle history retains the status-and-timestamp-only v1 contract.

Focused verification: `node --experimental-strip-types --test apps/web/tests/native-accounting.test.mjs`
exercises projection, both public parser boundaries, the served comic dashboard, exact wei averages
and parser parity. Historical contract and dashboard presentation tests exercise the old readers.

Pack selection groups use native expandable sections, with Pokémon first, followed by One Piece, Sports, and other packs. Pokémon opens initially; each group orders packs by catalog price and code. Collapsing a section preserves selection.

## Reward recipient controls

Bootstrap publishes the runner's canonical recipient options and the saved future-cycle limit.
The authenticated configuration command accepts only numeric integers 100–1000 in steps of 100.
The owner page separates the editable choice, confirmed saved value and active-cycle frozen value.
A successful command requires an authoritative matching bootstrap readback before the page reports
success. Stale, uncertain, failed or unreadable outcomes remain visibly unconfirmed; reload restores
the authority's value. Pack-plan editing remains independent.

Private active-cycle and public latest-cycle limits come only from the persisted `rewardSelection`
snapshot. A missing historic snapshot yields null and an all-holder label; the current configuration
never supplies an active or historical cycle limit. The website's active-cycle decoder accepts this
null representation. `operator/control.mjs` validates the snapshot digest and cycle identity before
projecting repository data.

The disconnected local selection wrapper uses `assertLocalSelectionCommand` to accept only pack-plan and reward-recipient updates while paused, execution-paused and non-live. Reward-only edits do not depend on catalog availability. Pack edits retain catalog membership and the existing allowlist protections. The wrapper grants no execution operation.
