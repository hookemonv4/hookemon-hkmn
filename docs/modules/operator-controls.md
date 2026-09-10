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
  usage, telemetry-source availability, alerts, payout state, held positions, and manual approvals.
- Each cycle exposes its repository `version`, `heldEvidenceDigest`, and `ownerDecision` exactly
  when the repository supplies them.
- `execute({ expectedRevision, requestId, command })` accepts `pause`, `resume`, `kill`,
  `update-configuration`, `manual-approval`, `held-owner-decision`, `reconcile`, `resume-cycle`,
  and `run-cycle-now`.

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
- Pack-plan edits use `configuration.packPlan: { orders: [{ pack, quantity }] }`; the server owns
  the plan schema and revision. A new pack or increased quantity for any pack increases exposure,
  even if the total quantity falls. Identical, reduced, or empty plans remain editable without
  safety telemetry. The allowlist and budget controls remain independent admission constraints.
- Operator configuration v6 requires a numeric `rewardRecipientLimit` from the shared 100–1000
  options in steps of 100. The default is 200. Native v4/v5 migration preserves every existing
  field and configuration revision, adds only the future-cycle selection default, and persists
  atomically through the existing state-file CAS revision. Pre-native money state stays non-executable.
- Recipient edits use `update-configuration` and the same revision CAS as other controls. Invalid
  or stale edits leave durable state unchanged. Each cycle exposes its validated frozen
  `rewardSelection`; historical cycles expose null and retain all-holder semantics.
- `pause` sets both `paused` and `executionPaused`. `kill` additionally sets `killSwitch`.
  `resume` clears only the two pause fields and never clears a kill switch.
- `manualApprovals` is null when configuration is unavailable. Otherwise it contains the pending
  manual-approval ledger entries (terminal cycles excluded), sorted by cycle ID with each entry's
  same-mode ordinal, release cost, durable approval state, and approval timestamp. A digest-bound
  approval with a mismatched cycle ID remains unapproved.
- A held-owner decision binds `positionId`, held-evidence digest, request ID, expected position
  revision, and owner choice before it reaches the repository authority.
- The service does not append audit records or deduplicate request IDs. Its caller persists the
  dispatch receipt before an effect and returns the stored receipt for a duplicate request.
- The dashboard caller stores the original request envelope before dispatch and reuses its request
  ID, expected revision, command, and note for recovery. A `PREPARED` or `UNCERTAIN` response is
  not a rejection: the browser retries the same envelope with bounded backoff and retains it in
  session storage if recovery is exhausted.

## State transitions

- Configuration commands use the operator-state revision as their compare-and-swap value.
- Pause, resume, kill, and configuration updates persist the next configuration before returning.
- Manual approval persists through the policy engine. A held-owner decision persists through the
  repository. The accepted command shapes are:

  ```js
  { type: 'manual-approval', cycleId, cycleDigest }
  { type: 'held-owner-decision', positionId, heldEvidenceDigest,
    expectedPositionRevision, choice: 'sell' | 'keep-holding' }
  ```

  Recovery and tick commands return the result of their one injected authority call. The dashboard
  `restart-request` alias invokes the existing `resume-cycle` command.
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
- For `UNCERTAIN`, do not click a replacement command or mint a new request ID until the audit
  record and authority state have been checked. The page exposes the original request ID and
  response code in its command-status line.
- When safety telemetry is unavailable, use pause or kill if needed, restore the accounting reader,
  and verify its status before resuming an exposure-increasing action.
- Reconcile an interrupted provider or chain attempt from the repository before requesting
  `resume-cycle`.
- Treat null cap, payout, and transaction data as unavailable, never as a zero balance or a pending
  effect.

## Open facts

- OPEN FACT: The composed observability service delivers and deduplicates alerts but does not expose
  a read-only durable alert feed to operator control. Resolve it by adding a read-only alert snapshot
  interface to composition and passing it into this control service. Verified safe alternative: show
  telemetry-source availability and emit the authority alert when required safety telemetry is
  unavailable; do not report an empty alert list as proof that the alert sink is healthy.

Active operator monetary controls use USD micro-units (`*MicroUsd`). Cycle reservations keep
`releaseAmountWei` distinct from `releaseCostMicroUsd`; cap usage reads the USD spend ledger.
Native principal and gas never enter a USD cap field without authenticated valuation.

The managed claim path uses the durable [Process USD budget](process-usd-budget.md). `processClaimLimit6hMicroUsd` defaults to USD25,000, accepts zero, and is owner-adjustable up to USD50,000; it does not replace the other spend controls.

Unresolved browser commands retain their exact request envelope after automatic recovery exhausts its attempts. New commands remain disabled until a matching durable APPLIED or REJECTED receipt resolves that envelope. Explicit recovery reuses the original request ID, expected version and command. Authentication failures, malformed responses and unreceipted conflicts preserve uncertainty; an HTTP success alone never clears the recovery identity.
