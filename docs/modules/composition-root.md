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
  production construction omits it. Built-in card reconciliation uses the real adapters when no
  explicit reconciliationAdapters are supplied; explicit observation adapters retain precedence.
  Custom handlers retain their separate reconciliation seam. Adapter calls and the narrow
  reconciliation repository remain lease-fenced, and reconciliation does not resend provider mutations. Chain-journal reconciliation for claim, outbound, and return additionally
  receives only fenced broadcast, finality, custody, Relay-settlement, recovery-context, and
  wallet-nonce-release writers after canonical chain observation. Direct payout may idempotently
  record successor dust and release its nonce fence before returning terminal recovery evidence.
- `HOOKEMON_COLLECTOR_EPIC_GATE_CONFIG_PATH` optionally names a JSON object containing exactly
  `nftAddressField`, `insuredValueField`, `prizeTierField`, and `rarityField`. Values are distinct
  plain field identifiers supplied independently of provider responses; there are no default field
  names. The loader freezes the mapping and derives its asset from the native Collector settlement
  identity after validating the configured money asset. The file cannot override that asset or any
  epic threshold. Missing configuration preserves the handler's data-unverified refusal; malformed
  configuration refuses loading. This configuration selects provider fields, not transaction signing
  authority or approval of live provider facts.
- `readEnvironment` accepts standing-authority material only as one document path, one owner public
  key path, and one policy public key path. `loadStandingAuthority` verifies the owner signature and
  policy-key binding, then loads the private canonical state-directory artifact
  `standing-authority-step-authorizations.json`. Its digest-bound, policy-signed entries resolve
  production step authorizations before the private repository writer persists first use and the raw
  signer is invoked.
- `createTrustedSolanaBlockhashContextResolver(client)` builds the one trusted
  `config.solana.blockhashContextResolver` compose wires, constructed only from the composed Solana
  RPC client -- no other adapter or config value feeds it. Called with an observed transaction
  blockhash, it reads a fresh `readUsableLatestBlockhash(client)` pair and accepts only an exact
  match between the observed blockhash and that pair's own current latest, usable blockhash,
  returning its `lastValidBlockHeight`. It refuses any other blockhash outright; it never accepts or
  derives a deadline from an arbitrary still-valid older blockhash.
- The root exposes read-only dependency health and readiness to automation and dashboard surfaces.
  The decoder-backed, request-scoped signing wrapper remains an integration boundary; live startup
  preflight does not replace its final per-signature canary call.
- The runner's start boundary validates the selected profile, replays repository integrity, reads
  the configured RPC chain ID and requires mainnet `4663`, probes both Keychain identities, and runs the observability
  preflight before it constructs a transaction-capable signer. Execution profiles also require a
  valid persisted policy configuration whose `liveMode` matches the selected provider profile.
  Production requires `manualApprovalCycles >= 3`; rehearsal requires at least one manual approval
  slot.

- The supplementary buyback handler resolves the Collector production binding against the original open evidence and freshly finalized ownership, and preserves the frozen policy when replaying signed bytes. See [Supplementary Buyback](supplementary-buyback.md) for its interface and recovery rules.

`HOOKEMON_RELAY_MAX_SETTLEMENT_WINDOW_SECONDS` supplies the explicit positive safe-integer
return settlement bound as a canonical decimal string. It has no default; omission retains the
return handler's pre-sign refusal. The request must carry the same configured bound.

The return policy signer accepts either a plain broadcast port or the owned Keychain client’s
policy-approved broadcast port. The latter stays behind transaction revalidation and the stage
driver’s lease and authority checks; the Keychain child remains sign-only.

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
- For the production profile, `readEnvironment` binds `config.solana.chainId` and
  `config.collectorCrypt.settlementAsset` to the native `COLLECTOR_CRYPT_SETTLEMENT_ASSET`
  (`solana-mainnet`, the Collector transaction-policy label), the same value collector-only
  rehearsal already uses, and refuses a configured `HOOKEMON_RELAY_SOLANA_MINT`/
  `HOOKEMON_RELAY_SOLANA_DECIMALS` pair whose mint and decimals are not exactly that documented
  asset identity, since Collector Crypt purchase and buyback settle only in it. This is an
  asset-identity check, not a namespace merge: `MoneyConfigurationV1`'s Solana asset keeps its own
  numeric Relay chain-id namespace (`792703809`) unchanged.
- The composition return value and dashboard request context expose only the frozen repository
  client. Writer methods remain reachable only through the composition's closed-over automation
  dependencies.
- The policy engine rereads the persisted operator configuration for each decision. Its production
  reservations are written through the operator-state mutation lock, not an in-memory cache.
- The live admission planner (`buildAdmissionPlanner`) admits a cycle only against a full normalized
  reading of the hook's process-liability ledger -- every control getter, the hook and cycle
  identity it was read against, and `ceilingAtomic = min(processLiability,
  remainingProcessClaimCapacity)` -- never a wallet balance or a configured figure. The production
  reader (`buildProcessLiabilityReader`) selects the public finalized block, binds the archive read
  to it, and re-reads the same height from the public client before returning, refusing on a hash
  mismatch. The planner validates that same shape and each control independently of the reader that
  supplied it, so a test reader cannot hand it evidence a real one would have refused.
- After the private `CycleRepository` opens, production composition derives its Robinhood client
  by wiring `createCycleAttributableFinalizedAvailableReader()` (closing over that private
  repository and the distinct archive client) as `readCycleAttributableFinalizedAvailable`,
  spread in last so it always wins over any same-named method an injected raw client already
  carries. This derived view, never the raw injected one, reaches the stage driver and the
  composed result's exposed `adapters`; an untrusted client can never self-attest its own
  cycle-attributable payout availability.
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
- Frozen request/evidence and child stage payloads remain data-only: canonicalization strips
  function fields, so a resolver or other capability is never serialized into a stored record. The
  one exception is the production supplementary reconcile call site, which re-attaches this exact
  in-process `blockhashContextResolver` function after canonicalization solely so the production
  supplementary buyback handler can resolve trusted blockhash context; no other frozen preparation
  or reconciliation payload carries a function capability.

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
node packages/adapters/bin/hookemon-runner.mjs run --mode rehearsal --cycles 1 --cap-micro-usd 25000000 --collector-only --restart-inject
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

Supplementary handlers receive the driver's existing opaque `preflightAuthority` unchanged.
Production callers without that capability retain the frozen-interface authorization check;
the branded fixture authority remains restricted to the Node test runner.

Supplementary return consumes finalized Collector sale proceeds in the native Solana namespace,
with the documented settlement mint and decimals checked against MoneyConfiguration. It preserves
the position-attributed atomic amount; Relay transport identifiers belong to the subsequently
validated bridge quote, not to the confirmed sale evidence.

Supplementary dispatch retains the process-local isolated signer setup by reference alongside the
trusted Solana blockhash resolver. Other configuration remains frozen data. The production binding
boundary still authenticates the setup's private identity; a value-identical copy is not authority.

`createProductionSupplementaryStageHandlers` builds the canary-guarded production handlers.
Its return handler forwards the existing opaque `preflightAuthority` unchanged to the return
mutation helper. Missing authority retains frozen-interface validation; the branded fixture
authority remains restricted to the Node test runner.

The supplementary payout handler passes the complete durable return boundary, including its
evidence digest and attributed payout source, alongside the original completed eligibility
snapshot. After `PAYOUT_BROADCAST`, it reads the carried return boundary and resumes the same
payout manifest without new signatures or transfers for finalized recipients. Both dispatch
states retain exact boundary schema, snapshot, source, and digest validation.

Supplementary dispatch accepts active settlements only. After a payout handler returns, its
result may be `COMPLETE` from either payout dispatch state. The driver rechecks the held-position
identity, original manifest and eligibility digest, any established payout-source digest, and
the current lease before reporting advancement; a completed settlement cannot start dispatch.

The literal production acceptance graph runs `hookemon-runner` against synthetic loopback
providers and the module-owned isolated signing child. It admits two packs, finalizes an ordinary
90-unit payout and a later 45-unit held-sale payout to the original holder snapshot, and checks
conservation and custody independently. Fresh CLI processes reopen both completions without new
logical purchases or payments; durable manifests, attempts, recipients and provider counts remain
stable. Every process must complete without a failed tick, and copied runtime bytes may differ
only at the two fixture identity pins and fixed synthetic interface metadata. This test does not
establish live provider acceptance or authorize live signing, spending or deployment.

The wallet nonce boundary resolves a renewed automation context against the durable reservation before asserting or releasing it. Only the same cycle, chain, wallet, stage, fencing token and acquisition timestamp may retain that reservation's original expiry. A later context expiry does not extend a held nonce lease; signing still refuses after its original deadline. Released handles retain their original window only for idempotent release. A new reservation after release uses the current active lease window. Reopening the repository or rebuilding a context does not change the binding, and a stale release cannot remove a successor's global reservation.

Live Collector resolution reads the fixed release manifest and authenticates its canonical digest
against the active frozen interface authority. Exactly two purchase/buyback anchors bind separate
owner approval receipts, approval bytes and binding bytes; neither registry configuration nor its
adjacent digest grants authority. Load and resolve both repeat these checks. Missing artifacts,
changed release identity and synthetic child configuration fail before a live Collector mutation.
No live binding values ship with this implementation; existing schemas and synthetic isolation
remain enforced.

Live Collector bindings require an executable-pinned SHA-256 of the exact release manifest bytes. The pin remains unset until real, separately owner-approved purchase and buyback artifacts exist. Loaded entries preserve the manifest identity, revisions, binding path and digest, receipt identity and approval evidence hashes; resolution compares that complete identity again. A release change cannot reuse an admitted registry merely because transaction binding bytes match. Synthetic isolated child contexts cannot select live authority.

`createOriginalSolanaBlockhashContextResolver(client)` wires `config.solana.originalBlockhashContextResolver` for purchase only. It reads `isBlockhashValid` for the original provider hash and returns its validity observation slot. It never substitutes the latest hash or an unrelated expiry height. Legacy and buyback resolver behavior is unchanged.

Native composition loads optional payment-binding bytes by absolute path, then requires the
frozen release's exact digest before granting payment authority. Quote validity is an explicit
positive millisecond input; absence grants no valuation capability. Historical process-budget
environment names are refused. Public accounting receives the configured Operations address and
exact `4663/native/18` identity as trusted payout context. Operator USD limits and native principal
remain separate throughout configuration and projection.

The policy valuation verifier accepts fresh Relay producer references or private references restored by the configured cycle repository under its original admission authority and expiry. Plain persisted valuation objects alone confer no new-risk authority.

Production native money configuration activates the admission planner and the finalized hook-liability reader through `assets.eth`. Hook native liability and capacity, never Operations wallet balance, bound the two independently fetched funding quotes and their USD producer capabilities.

Synthetic production-shaped tests may inject a native payment binding only through its original test-branded reference and the exact test mutation authority. Cloned bindings and ordinary configuration still require the frozen release file. A native principal evidence failure holds an active cycle before its mutation boundary.

Collector-only readiness requires `collectorCrypt.packFundingUsd`, a fresh producer valuation of the exact Solana USDC pack amount rounded up. Pack atoms are never USD policy limits. Explicit test mutation authority is also passed to the repository so its restored admission references remain usable in isolated production-shaped tests.

Rehearsal limits use `rehearsalCapMicroUsd`. Collector pack amounts come from `HOOKEMON_COLLECTOR_PACK_PRICE_ATOMS`; policy cost requires an authenticated USD quote. Fake rehearsal settlement uses an explicit `HOOKEMON_REHEARSAL_SETTLEMENT_AMOUNT_ATOMS`, independent of native principal.

Collector-only CLI initialization, preflight and run obtain an exact USDC origin valuation through the Relay quote producer before monetary policy checks. `HOOKEMON_RELAY_QUOTE_VALIDITY_MS` is required; absent TTL refuses before HTTP. The public `release/phase3/launch-inputs.json` Operations role is only a read-only quote recipient coordinate and grants no live authority. The same process valuation is forwarded to preflight and composition, with current TTL enforced. This pricing request neither initializes an EVM signer nor admits a bridge route.

The composition resolves one clock and passes it to custody valuation, policy and durable services. An omitted clock uses wall time; an injected clock remains authoritative for that composition. Native custody requires a fresh authenticated quote under this same clock. Expired quotes leave exposure unvalued, while held purchase cost remains frozen.

Return preparation samples the resolved clock after the quote response for USD valuation. The original request timestamp remains an attribution coordinate and never extends the producer quote validity window. Supplementary return preparation applies the same post-response freshness requirement.

Leg action builders require MoneyConfigurationV2 and the exact Robinhood native asset identity. Outbound input and return output use the internal native asset identifier, while Collector purchase and buyback retain their configured Solana settlement asset. Return floors use `minimums.returnEth`; gas reserves remain separate from principal. Historical money configurations cannot construct new actions.
