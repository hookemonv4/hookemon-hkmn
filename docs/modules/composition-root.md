# Composition Root

## Purpose

`packages/adapters/src/app/compose.mjs` assembles the Phase 3 runtime from the pinned network
profile and content-addressed deployment manifest. One composed process contains the policy
engine, provider adapters, sign-only boundary, scheduler, `AutomatedCycleService`, durable
`CycleRepository`, fenced file lease, snapshot and payout stages, projections, and optional
in-process dashboard. The composed service owns the writable repository instance; the CLI and
dashboard receive frozen clients bound to that same instance. There is no in-memory runner
placeholder or second money store. WP10b owns migration of a standalone dashboard to the
repository client.

## Public interface

- `compose(config)` returns `{scheduler, service, cycleRepository, createCycleRunner,
  operatorControl, executeAudited, dashboard, policyEngine, adapters, standingAuthority,
  assertRepositoryIntegrity, assertStartReadiness, shutdown}`. `operatorControl` is the one
  composed control authority; `executeAudited` records its listener-free CLI requests in the same
  durable audit ledger as an optional dashboard.
- The runner supplies one explicit execution profile, `production` or `rehearsal`, and the
  composition passes it unchanged to the cycle service and its policy boundary. An explicit
  production `dryRun` permits fake providers without rehearsal flags; the repository records the
  immutable mode, provider profile, and dry-run flag when it opens a cycle.
- `hookemon-runner dry-run --mode production` selects that explicit production dry run. It requires
  fake providers, does not construct a signer, and never invokes a provider mutation or broadcast.
- `config.observability` supplies the canary, alert, and start-preflight configuration. The runner
  requires it before every explicitly selected production or rehearsal profile, including a fake
  rehearsal, and runs it before signer construction. A live `runOnce`, `recoverActiveCycle`, or
  scheduler-built worker also refuses to run until its start preflight succeeds.
- `cycleRepository` is a frozen `CYCLE_REPOSITORY_CLIENT_INTERFACE` facade containing
  `readActiveCycle`, `peekActiveCycle`, `readStage`, `describeCycle`, `readOperationalStageAttempt`,
  `readChainTransactionAttempt`, `readClaimPreconditions`, and `listKnownCycleIds`. The
  composition keeps `CYCLE_REPOSITORY_INTERFACE` private. Automation uses `createCycle`,
  `prepareStage`, `completeStage`, `completeCycle`, `holdCycle`, `prepareStageAttempt`,
  `markStageAttemptSentUnknown`, `recordStageAttemptResponse`, `reconcileStageAttempt`,
  `prepareChainTransactionAttempt`, `recordSignedTransaction`,
  `recordSignedTransactionWithRecoveryContext`, `recordBroadcast`, `recordFinality`,
  `recordCustodyLedger`, Relay-leg settlement, and wallet-nonce reservation methods internally;
  callers and dashboard routes cannot invoke them. Its private provider writer also exposes
  `markStageAttemptNotSent` for pre-call failures.
- `createCycleRunner(cycleId)` returns a frozen, read-only repository-backed client with `schema`,
  `cycleId`, `repository`, `readStage(stage)`, `readOperationalStageAttempt(stage)`,
  `readChainTransactionAttempt(stage, requestDigest)`, and `describe()`. Its frozen `repository`
  facade exposes only `CYCLE_REPOSITORY_CLIENT_INTERFACE`.
- `createStageDriver({liveMode, adapters, reconciliationAdapters, signerClient, config,
  cycleRepository, preflightAuthority})` returns the `reconcile`, `execute`, and side-effect-free `commit` methods
  used by `AutomatedCycleService`. `preflightAuthority` accepts only the exact Node test fixture;
  production construction omits it. The ordinary reconciliation seam is read-only and separate from
  mutation adapters. Chain-journal reconciliation for claim, outbound, and return additionally
  receives only fenced broadcast, finality, custody, Relay-settlement, recovery-context, and
  wallet-nonce-release writers after canonical chain observation. Direct payout may idempotently
  record successor dust and release its nonce fence before returning terminal recovery evidence.
- `readEnvironment` accepts standing-authority material only as one document path, one owner public
  key path, and one policy public key path. `loadStandingAuthority` verifies the owner signature and
  policy-key binding, then loads the private canonical state-directory artifact
  `standing-authority-step-authorizations.json`. Its digest-bound, policy-signed entries resolve
  production step authorizations before the private repository writer persists first use and the raw
  signer is invoked.
- The root exposes read-only dependency health and readiness to automation and dashboard surfaces.
  The decoder-backed, request-scoped signing wrapper remains an integration boundary; live startup
  preflight does not replace its final per-signature canary call.
- The runner's start boundary validates the selected profile, replays repository integrity, reads
  the configured RPC chain ID and requires mainnet `4663`, probes both Keychain identities, and runs the observability
  preflight before it constructs a transaction-capable signer. Execution profiles also require a
  valid persisted policy configuration whose `liveMode` matches the selected provider profile.
  Production requires `manualApprovalCycles >= 3`; rehearsal requires at least one manual approval
  slot.

## Invariants

- Exactly one `CycleRepository` and policy engine serve every money mutation. Operations EVM and
  Operations Solana are the only signer identities wired into the sign-only boundary.
- `production` requires live providers unless explicit `dryRun` selects fake providers and rejects
  all rehearsal flags in either case.
- A production dry run is not rehearsal: it uses the production mode and persisted flag while
  omitting signer construction and all mutation capabilities.
  The runnable rehearsal profile requires sealed fake providers. A requested live rehearsal is
  refused before signer construction until the dedicated Solana proceeds projection and finality
  evidence are implemented. The runnable profiles use the same runner, repository, policy engine,
  leases, and write-ahead stage driver.
- `execution.enforceProfile` makes the composed runner reject an inspection profile that attempts
  live execution, a production profile that is not live production, and a rehearsal profile whose
  live state disagrees with its explicit provider mode. The CLI sets this boundary for every
  runner-created composition.
- Every `liveMode === true` `runOnce`, `recoverActiveCycle`, and scheduler worker runs start
  preflight independently of `execution.enforceProfile`; profile/mode consistency cannot disable
  the observability gate.
- A supplied third Operations EVM identity is rejected while composing the input, so no redundant
  live-start identity comparison remains in the cycle-service builder.
- Startup requires every money-relevant configuration field, including pinned asset identities,
  RPC URLs, Operations identities, policy caps and minima, and EVM and Solana gas envelopes.
  There are no implicit money minima. The return minimum must be explicitly configured as the
  revision-63 zero value; any nonzero return value is rejected.
- The frozen `MoneyConfigurationV1` is passed to money preflight and signer paths. Claim checks
  both EIP-1559 fee fields and a post-fee native reserve. Return, purchase, and buyback require the
  configured Solana asset, cap the decoded priority fee, and check the post-fee lamport reserve;
  these are pre-sign balance checks, not transactional balance reservations.
- The composition return value and dashboard request context expose only the frozen repository
  client. Writer methods remain reachable only through the composition's closed-over automation
  dependencies.
- The policy engine rereads the persisted operator configuration for each decision. Its production
  reservations are written through the operator-state mutation lock, not an in-memory cache.
- A cycle stores one immutable mode, `production` or `rehearsal`, at creation. Production services
  refuse rehearsal cycles and rehearsal services refuse production cycles.
- `readEnvironment` resolves the EVM USDG address and decimals from the frozen binding. The
  configured identity projects custody from all known cycles. Missing identity or an unvalued
  foreign current balance prevents a production claim.
- Runtime hashes, chain identity, asset decimals, roles, provider policy, and custody dependencies
  match the verified profile. Composition can establish code readiness but cannot set
  `launchEligible` without the release-evidence gate.
- Before opening the cycle repository or dashboard listener, production composition reads EVM
  `eth_chainId` and Solana `getGenesisHash`. Both must match the configured chain and selected
  dashboard profile; unavailable or malformed identity fails closed. Test-only injected adapters
  must provide `networkIdentity` with those two reads for deterministic validation without a
  transport.
- The listener-free operator facade and an optional dashboard share one append-only audit ledger.
  Dashboard startup verifies its hash chain before it opens or rebuilds SQLite; a listener-free
  command uses the same pre-effect reservation and terminal outcome protocol.
- `packages/runner/src/cycle/money-schemas.mjs` defines the operational order as
  `eligibility-snapshot`, `claim-process`, `outbound`, `purchase`, `open`, `epic-gate`, `buyback`,
  `return`, and `payout`. The retired `funding` and `distribution` stages have no dispatcher or live
  handler path.
- `claim-process` requires completed eligibility-snapshot evidence and a custody ledger with no
  held, unattributed, or unresolved obligations. `payout` requires completed eligibility-snapshot
  and return evidence.
- In live mode, a handler constructs one canonical request before calling a provider. The driver
  freezes that request, records its digest in `PREPARED`, and passes the same value to the mutation.
  A pre-call failure records `NOT_SENT` before the capability boundary and may retry only that same
  request after returning to `PREPARED`. A thrown post-send request becomes `SENT_UNKNOWN`, which
  retries reconciliation instead of calling the provider again. Only `reconcileLive` evidence
  permits the service to complete the stage.
- Before an injected live mutation, direct provider or RPC mutation, and each signer `sign` or
  `broadcast` call, the driver invokes the service-provided policy and lease guard with the cycle,
  amount, pack, request digest, stage, and fencing token.
- In production with live providers, each `sign` call also requires a verified, branded standing
  authority provider and an already policy-signed step intent bound to the cycle, stage, and
  signing boundary. The provider atomically records `StandingAuthorityDecisionV1` before the raw
  signer is reached. Missing, expired, mismatched, or malformed authority leaves the attempt
  `NOT_SENT`; authority capabilities are not exposed to stage handlers or request preparation.
- Before an injected live handler reaches `mutate()`, the driver re-reads the generic mutation
  authority. The current provisional Phase 3 interface therefore cannot reach a custom handler;
  the exact fixture authority is available only to the Node test runner.
- The eligibility snapshot is a built-in read-only live reconciliation. It returns canonical
  evidence directly to `AutomatedCycleService`, which completes it before `claim-process`, and it
  never creates a provider attempt. It selects `latest - K` only when a fresh finalized-head read
  proves that block finalized, then requires matching pinned Transfer-log replays from distinct
  primary and secondary clients. Pending provider stages record `PREPARED` and throw
  `LiveModeIntegrationPendingError` before an unavailable integration can mutate. Claim processing
  uses its durable chain journal and records custody before finality. Built-in outbound and return
  use their durable Relay legs and complete only from canonical own-RPC settlement evidence,
  including a `SETTLED` replay. Built-in payout prepares an immutable direct-transfer request,
  advances durable recipient state, and reconciles only terminal conservation evidence after return
  is complete. Purchase, open, epic gate, and buyback remain pending. The CLI still cannot reach
  payout from a fresh live cycle until all predecessor stage integrations and pinned signer policy
  inputs are available. Read-only probes for eligibility snapshot, claim process, and epic gate live in
  `packages/adapters/src/app/stages/eligibility-snapshot.mjs`, `claim-process.mjs`, and
  `epic-gate.mjs`.
- An explicit production dry run can traverse return and payout with fake providers and injected
  stage handlers, but it does not construct a signer or make a provider mutation.
- Dry runs use probes only. They never invoke a signer, broadcast, or provider mutation, and they
  refuse to probe past an unresolved live attempt. A missing policy configuration refuses every
  policy-gated execution profile, including fake rehearsal.
- An unset process-pack code is omitted when building a dry-run service, so the conservative
  no-budget state returns `WAITING_FOR_PROCESS_BUDGET`. Live service construction still requires a
  nonempty pack ID.
- A held cycle remains active as `HELD_DATA_UNVERIFIED`, `HELD_UNAVAILABLE`, or
  `HELD_OWNER_DECISION`; the scheduler does not resume it automatically.
- Live composition fails closed when observability configuration is absent, its durable alert sink is
  unavailable, a required signer is not ready, or required RPC evidence is not positive. The startup
  gate does not replace the decoder-backed canary required at the final signing boundary.
- Fake rehearsal composes sealed fake Relay and Collector adapters. They provide deterministic
  effect records to the rehearsal driver and cannot issue a network request. Its evidence is sealed
  after every stage is reconciled and before terminal archival.

## State transitions

1. A pinned mainnet profile becomes a composed runtime only after configuration, repository
   integrity, RPC chain identity, Keychain probes, policy approval-count validation, and canary
   preflight pass. A failed check leaves the repository inspectable but refuses signer construction
   and every execution path.
2. `createCycle` appends `cycle-opened`; each incomplete stage is prepared, reconciled, and
   completed in the fixed operational order. The event includes immutable `production` or
   `rehearsal` mode and its provider profile. Recovery rejects an absent or conflicting provider
   profile before stage work.
3. A provider attempt follows `PREPARED → NOT_SENT → PREPARED` for a pre-call failure,
   `PREPARED → RESPONSE_RECORDED → RECONCILED` when a response is observed, or
   `PREPARED → SENT_UNKNOWN` when send ambiguity requires reconciliation without another provider
   call. A general chain attempt follows `PREPARED → SIGNED → BROADCAST → FINALIZED` with
   `requestDigest`, raw bytes, one nonce or blockhash, and a hash. The general chain-attempt runtime
   is v1; the frozen v2 policy, fencing, refusal, and approval-digest fields are unavailable.
   Live outbound and return use the repository's combined Relay signing record for recovery fields.
4. `completeCycle` archives a fully reconciled cycle. `holdCycle` records an explicit held terminal
   state and leaves the journal readable for recovery and an owner decision. A
   `HELD_OWNER_DECISION` record can receive one revision- and evidence-bound owner choice without
   resuming a custody effect.
5. Custody records update atomic buckets, but the first record for a cycle, chain, and asset fixes
   its decimal value. Writes and journal replay reject a later record with inconsistent atomic
   units.
6. The budget reader uses the persisted production pack-price control and the policy engine checks
   the final release before `createCycle`, then again before claim and purchase execution.
7. Readiness changes are projections from evidence; they do not mutate a cycle or override.
8. A production signer first resolves a policy-signed standing-authority intent, then persists or
   reuses its exact first-use decision. Only a verified decision permits the signer call; an exact
   replay reuses its day-cap and nonce reservations.

## Operational commands

```sh
(cd packages/adapters && npm ci --ignore-scripts && \
  node --test --test-timeout=120000 test/app/cycle-repository.test.mjs test/app/stage-driver.test.mjs test/app/observability.test.mjs test/app/compose.test.mjs)
node packages/adapters/bin/hookemon-runner.mjs dry-run
node packages/adapters/bin/hookemon-runner.mjs run --mode rehearsal --cycles 1 --cap-usdg 25000000 --collector-only --restart-inject
node --test packages/runner/test/cycle/money-schemas.test.mjs packages/runner/test/cycle/failure-matrix.test.mjs
```

- Construct runners, schedulers, and payout workers only through this root.
- Refresh dependency health through read-only checks and record results with release evidence.
- Rebuild the root after an approved profile or manifest revision instead of mutating a live
  dependency graph.

## Recovery pointers

- Read `readOperationalStageAttempt` before calling a live stage. Return a pre-call `NOT_SENT`
  attempt to `PREPARED` only for the same request and current lease. Reconcile a `SENT_UNKNOWN` or
  `RESPONSE_RECORDED` attempt with provider status and independent chain evidence, never
  resubmitting it from a scheduler retry.
- Do not rebroadcast an ordinary v1 attempt after restart; it does not persist the frozen v2
  approval digest required for that recovery. Outbound and return can reauthorize only exact bytes
  with their combined Relay recovery record; direct payout reads its authority from the
  self-contained signed recipient record.
- Use `readClaimPreconditions` and the custody ledger to identify held assets, unattributed value,
  or unresolved obligations before starting a claim process.
- If the policy engine returns `POLICY_REFUSED`, change the persisted control or reconcile custody
  before another live attempt. Do not replace the cycle or reuse a stale admission result.
- Reconstruct the root from the pinned profile and repository journal after a process restart. Keep
  a failed composition outside automation until its evidence mismatch is resolved.
- Supply an approved observability configuration before enabling live mode. If start preflight
  fails, restore the alert sink, signer readiness, or chain evidence before rebuilding the live
  service; do not bypass the gate with a dry-run setting.
- Use `hookemon-runner status --cycle <cycle-id>` before recovery. Reconcile a `SENT_UNKNOWN` or
  unresolved `SIGNED` attempt from its recorded digest and evidence before `resume`; no recovery
  path may create replacement bytes, a new nonce, or a new provider effect.
- Use `abort-cycle <cycle-id> --reason <text>` to record an explicit terminal operator action. It
  retains the journal and evidence, so it cannot turn an uncertain effect into a completed one.
- Refuse startup if two repositories, two policy engines, or an unscoped signer would be wired.
- Use the repository-backed cycle client for status inside the composed process. It cannot create,
  complete, hold, or reconcile a cycle. WP10b owns migration of a standalone dashboard to that
  client.
- A listener-free operator invocation must use `executeAudited`; do not call a control effect
  directly or substitute a second audit log.
- Keep production signing closed unless all three standing-authority verification paths and a
  policy-signed step-intent source are present. Do not replace a missing intent with a fixture,
  inferred payload, or a fresh signature.
