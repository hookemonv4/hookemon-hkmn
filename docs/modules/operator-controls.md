# Operator Controls

## Purpose

`packages/runner/src/operator/control.mjs` exposes the repository-backed operator control service.
It changes durable operator configuration or invokes one explicitly composed authority; it never
creates a local cycle store, signer, or provider effect.

## Public interface

- `createOperatorControl({ statePath, cycleRepository, policyEngine, now, triggerTick,
  resumeActiveCycle, reconcileActiveCycle, readCustody, recordHeldOwnerDecision })` returns frozen
  `{ status, execute }` functions. `reconcileActiveCycle` is the injection point for the composed
  runner graph's serialized, lease-protected recovery call (e.g. the scheduler's
  `recoverActiveCycle` path); this module never imports a stage driver or cycle-domain module to
  reach it itself.
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
  configuration changes refuse to act while safety telemetry is unavailable. `pause` and `kill`
  remain available for safe-stop regardless. `reconcile` without a wired `reconcileActiveCycle`
  stays read-only and available for inspection; wired, it requires safety telemetry the same as
  `resume-cycle`, since it can invoke the same money-moving recovery.
- A generic shared-state compare-and-swap failure (`'stale operator state revision'`) carries no
  command-specific identity or postcondition — it only means some write happened after the caller's
  expected revision, not that this exact patch was the one applied. `pause`, `resume`, `kill`, and
  `update-configuration` recover from that failure by checking a real postcondition instead of
  guessing: applying the same patch again to whatever is durably current now, and comparing every
  field except `configurationRevision` against that current state. A match means this patch's
  intended effect is already durably present regardless of who wrote it, and the call returns that
  current state as success; a mismatch is a genuine conflict and the stale-revision error is
  rethrown unchanged. This makes those four commands safe to retry (including a crash-recovered
  retry through the audited command executor) without ever inferring "applied" from the error
  message alone.
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

## Idempotent authority contract (required for `run-cycle-now`, `reconcile`, `resume-cycle`)

`triggerTick`, `reconcileActiveCycle`, and `resumeActiveCycle` are called as `dependency({ requestId
})`, where `requestId` is required (`assertRequestId`) and is the exact same stable request identity
the audited command layer (`packages/dashboard/src/auth/audit-log.mjs`) assigned when the request was
first dispatched — including on a crash-recovered retry of that same audit claim. `requestId` is
carried through unchanged on every retry of the same original request; it is never regenerated.

This module hands the identity down; it does not and cannot itself make the wrapped authority
idempotent. A compliant `dependency({ requestId })` implementation must persist a durable
postcondition keyed by `requestId` (for example: "a tick dispatched for this request already opened
or advanced cycle X") and, on a repeat call with the same `requestId`, return that durable
postcondition's outcome instead of performing its effect again. Passing the identity through is a
necessary precondition for this, not a proof of it — this control layer has no way to verify a given
authority implementation actually does the lookup. Until an authority does, a crash between the
authority applying its effect and the audit log recording completion can still recover by invoking
the effect again (e.g. `run-cycle-now` opening a second cycle); this is a known composition gap
(`packages/adapters/src/app/compose.mjs` does not yet implement compliant lookups for these three
dependencies) rather than a defect in the identity plumbing itself.

This mirrors the fix already applied to `pause`/`resume`/`kill`/`update-configuration` above: those
recover from a retry by checking whether the intended state is *already durably present* — a real,
inspectable postcondition — never by trusting a bare identity or inferring success from a generic
error message. The difference is only where the postcondition lives: for the four configuration
commands it is the operator configuration itself, checked in this module; for these three recovery
commands it must live in whatever durable state the injected authority owns (the cycle repository,
C-owned), checked by that authority.

## State transitions

- Configuration commands use the operator-state revision as their compare-and-swap value.
- Pause, resume, kill, and configuration updates persist the next configuration before returning.
- Manual approval persists through the policy engine. A held-owner decision persists through the
  repository for one position and either retains its limit exposure or starts that position's
  supplementary settlement. `resume-cycle` can recover that durable settlement after its main
  cycle is `COMPLETED`, while tick commands and normal recovery leave the main stage sequence
  closed. Recovery and tick commands return the result of their one injected authority call.
- Reconcile without a wired `reconcileActiveCycle` reads repository state only; it never invokes a
  tick, recovery callback, signer, or provider mutation. Wired, it calls `reconcileActiveCycle()`
  exactly once and returns its durable outcome (`RECOVERY_<status>`), same as `resume-cycle`; it
  never calls `triggerTick` and so can never open a new cycle.

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
