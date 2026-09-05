# Operator Controls

## Purpose

`packages/runner/src/operator/control.mjs` exposes the repository-backed operator control service.
It changes durable operator configuration or invokes one explicitly composed authority; it never
creates a local cycle store, signer, or provider effect.

## Public interface

- `createOperatorControl({ statePath, cycleRepository, policyEngine, now, triggerTick,
  resumeActiveCycle, readCustody, recordHeldOwnerDecision })` returns frozen `{ status, execute }`
  functions.
- `status()` returns the configuration revision, active and known repository cycles, canonical
  lifecycle stages, provider requests, typed chain transaction evidence, custody buckets, cap
  usage, open held positions, telemetry-source availability, alerts, and payout state.
- `status().cap.heldPositions` is `{ count, maxCount, valueMicroUsdg, maxValueMicroUsdg }` and
  `status().heldPositions` is the repository's flattened open position list.
- Each cycle exposes its repository `version`, `heldEvidenceDigest`, and `ownerDecision` exactly
  when the repository supplies them.
- `execute({ expectedRevision, requestId, command })` accepts `pause`, `resume`, `kill`,
  `update-configuration`, `manual-approval`, `held-owner-decision`, `reconcile`, `resume-cycle`,
  and `run-cycle-now`.
- A `resume-cycle` receipt carries the exact injected recovery result. A recovered sell position
  returns `resultCode: RECOVERY_SUPPLEMENTARY_SETTLEMENT` with its original cycle, position,
  manifest, stage, and settlement state; it is not reported as a resumed main cycle.

## Invariants

- `CycleRepository` is the source for every cycle, lifecycle stage, provider attempt, chain
  transaction, held-decision fact, and custody fact. The operator state file contains only
  configuration and its revision.
- Status uses `peekActiveCycle()`, which does not perform archival repair or change repository
  state.
- Lifecycle stages use the canonical operational order. Durable `PENDING`, `UNKNOWN`, prepared,
  provider-attempt, and chain-attempt states are retained. For an active non-terminal cycle with
  only a completed prefix, status derives only its first missing canonical stage as `PENDING`.
- Chain transaction evidence is validated against the durable transaction-attempt schema. The
  projection exposes stage, state, request digest, and transaction identifier; it does not expose
  signing bytes or signing material.
- Payout is `null` when no durable payout stage exists or a non-completed terminal state prevents
  a payout. A payout status is never fabricated from an absent stage.
- Safety telemetry is available only when accounting supplies canonical realized-loss, at-risk,
  outstanding-custody, and custody-condition values. An unavailable reader or malformed telemetry
  produces null loss and outstanding-cap projections, `alertSources.safetyTelemetry: false`, and a
  critical authority alert.
- `resume`, `manual-approval`, `resume-cycle`, `run-cycle-now`, and exposure-increasing
  configuration changes refuse to act while safety telemetry is unavailable. `pause`, `kill`, and
  read-only `reconcile` remain available for safe-stop and inspection.
- `pause` sets both `paused` and `executionPaused`. `kill` additionally sets `killSwitch`.
  `resume` clears only the two pause fields and never clears a kill switch.
- A held-owner decision binds position ID, held-evidence digest, request ID, expected position
  revision, and the `sell` or `keep-holding` choice before it reaches the repository authority.
  A `sell` decision creates only the durable supplementary-settlement intent; it does not invoke a
  provider mutation or recipient transfer through this control service.
- Increasing `maxHeldPositions`, `maxHeldValueMicroUsdg`, or
  `unresolvedCardDeadlineMinutes` is exposure-increasing and requires available safety telemetry.
- The service does not append audit records or deduplicate request IDs. Its caller persists the
  dispatch receipt before an effect and returns the stored receipt for a duplicate request.

## State transitions

- Configuration commands use the operator-state revision as their compare-and-swap value.
- Pause, resume, kill, and configuration updates persist the next configuration before returning.
- Manual approval persists through the policy engine. A held-owner decision persists through the
  repository for one position and either retains its limit exposure or starts that position's
  supplementary settlement. `resume-cycle` can recover that durable settlement after its main
  cycle is `COMPLETED`, while tick commands and normal recovery leave the main stage sequence
  closed. Recovery and tick commands return the result of their one injected authority call.
- Reconcile reads repository state only. It never invokes a tick, recovery callback, signer, or
  provider mutation.

## Operational commands

```sh
node --test --test-timeout=120000 packages/runner/test/operator/control.test.mjs
```

- Compose this service with the process-wide repository, policy engine, accounting reader, and
  audited command executor.
- Submit effects through a pre-effect audited request executor.

## Recovery pointers

- On a stale revision, read `status()` again and submit a fresh request ID with the current
  revision.
- When safety telemetry is unavailable, use pause or kill if needed, restore the accounting reader,
  and verify its status before resuming an exposure-increasing action.
- Reconcile an interrupted provider or chain attempt from the repository before requesting
  `resume-cycle`.
- For a held position, submit the exact displayed evidence digest and position revision. Reuse the
  request ID after an uncertain response; `keep-holding` remains counted, while `sell` must resume
  the durable supplementary settlement instead of issuing a manual transfer. Read a
  `RECOVERY_SUPPLEMENTARY_SETTLEMENT` receipt as recovery of that immutable position, snapshot,
  and manifest binding, not permission to reopen or alter the main cycle.
- Treat null cap, payout, and transaction data as unavailable, never as a zero balance or a pending
  effect.

## Open facts

- OPEN FACT: The composed observability service delivers and deduplicates alerts but does not expose
  a read-only durable alert feed to operator control. Resolve it by adding a read-only alert snapshot
  interface to composition and passing it into this control service. Verified safe alternative: show
  telemetry-source availability and emit the authority alert when required safety telemetry is
  unavailable; do not report an empty alert list as proof that the alert sink is healthy.
