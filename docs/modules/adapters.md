# Adapters

## Purpose

`packages/adapters` is the sole npm-dependent package in the repository: it isolates the two
libraries real EVM and Solana chain interaction requires, `viem` and `@solana/web3.js`, behind a
narrow boundary so `packages/contracts` and `packages/runner` stay builtin-only, hash-pinned, and
auditable byte for byte. This package performs no signing and holds no key material; it constructs
and encodes transactions for an injected signer supplied at runtime by the operator's own
infrastructure.

## Public interface

- `packages/adapters/package.json` — private, `type: module`, `engines.node >=24`; pins exact
  versions of `viem` and `@solana/web3.js` as its only dependencies.
- `packages/adapters/package-lock.json` — `lockfileVersion` 3, every resolved entry carries an
  `integrity` field; installed with `npm ci --ignore-scripts` (no lifecycle scripts run).
- The runner core talks to chain adapters only through an injected `signerClient` interface
  (`sign(request)` / `broadcast(request)`) supplied by the caller, matching the seam
  `packages/runner/src/automation/policy-wallets.mjs` already authorizes every mutation through
  (`allowedDestinations`/`allowedFunctions`/`allowedAssets`/`maxAmount`, schema-bound intents,
  single-use authorizations). The signer is never constructed inside this package, never reads raw
  key material, and rejects any configuration object that carries a secret-material field
  (`privateKey`, `secretKey`, `mnemonic`, `seed`, `keypair`).
- `packages/runner/src/config/state-schema.mjs` — `assertOperatorConfiguration`,
  `createDefaultOperatorConfiguration`, `applyOperatorConfiguration`, and
  `migrateOperatorConfiguration` validate and migrate the versioned dashboard-editable operator
  configuration document. The current schema is `hookemon.operator-configuration.v2`; it uses
  exact-schema rejection of unknown fields and secret-material fields. It is wired into
  `packages/runner/src/operator/state-file.mjs` as an optional, nullable `configuration` section of
  the operator state document. `state-file.mjs` additionally owns immutable hard ceilings for
  booster count, unit price, per-cycle budget, and trailing-24-hour budget; the policy engine
  repeats those limits at admission.
- `node scripts/verify-control-dependencies.mjs` verifies `packages/adapters/package-lock.json` is
  `lockfileVersion` 3, that every entry carries an `integrity` field, and that the direct dependency
  set matches the pin recorded in `product/dependency-pins.json`.

### Operational cycle adapters

- `src/app/cycle-repository.mjs` is the durable production authority for the composed service.
  `CYCLE_REPOSITORY_INTERFACE` names its full read/write seam;
  `CYCLE_REPOSITORY_CLIENT_INTERFACE` names the frozen read-only facade returned by
  `createCycleRepositoryClient`, `createCycleRepositoryRunner`, and `compose()`. Composition keeps
  the writer private and gives the CLI and in-process dashboard that facade. WP10b owns the
  standalone dashboard migration.
- `src/app/stage-driver.mjs` dispatches exactly these operational stages:
  `eligibility-snapshot`, `claim-process`, `outbound`, `purchase`, `open`, `epic-gate`, `buyback`,
  `return`, and `payout`. Retired stages are not dispatched. Before an injected live handler can
  call `mutate()`, the driver requires the generic mutation authority; its optional authority
  argument accepts only the exact Node test fixture.
- A custom live handler's `prepareRequest` receives a frozen canonical object containing only
  `liveMode`, configuration data, and `{ cycleId, stage, intent }`. It never receives injected
  adapters, a signer client, standing-authority provider or resolver, or the writable cycle
  repository. After `PREPARED` is durable, `mutate` receives read-only, lease-fenced adapter and
  signer views; each method invocation revalidates `context.assertLease` immediately before it
  reaches the underlying capability.
- `reconcileLive` receives a separate `reconciliationAdapters` seam, a frozen canonical context and
  configuration, and a lease-fenced repository facade containing only read methods. The chain-journal
  facade for claim, outbound, and return additionally exposes lease-fenced broadcast, finality,
  custody, Relay settlement, recovery-context, and wallet-nonce release methods after canonical
  chain observation. The card-stage facade for purchase, open, epic-gate, and buyback additionally
  exposes lease-fenced held-position and whole-cycle hold methods for an unattributable card;
  buyback's own facade also exposes a lease-fenced custody-ledger writer, since only buyback sums
  realized proceeds into the durable custody ledger. Direct payout reads its recipient journal and
  may idempotently record successor dust and release its wallet nonce fence during terminal
  recovery. Reconciliation receives no signer, runner, or provider-mutation capability.
- `src/app/stages/held-pack.mjs` exports `heldPackIdForMemo({ cycleRepository, cycleId, memo, config })`.
  Open, epic-gate, and buyback call it before recording a held position. It resolves the pack
  identity of a purchased memo from the persisted purchase plan: the per-order pack request and
  admission order for `hookemon.policy-admission.v4`, the persisted purchase batch request and
  admission pack id for legacy admissions. Mixed plans resolve each memo to its own order.
  `existingHeldPackOutcome` returns the already recorded held position for a memo so a repeated
  reconciliation tick never records a second one.
- `src/app/stages/eligibility-snapshot.mjs`, `claim-process.mjs`, and `epic-gate.mjs` provide
  read-only probes. Eligibility snapshot completes through direct read-only reconciliation. Claim
  processing persists `PREPARED → SIGNED → BROADCAST → FINALIZED` in the chain journal and records
  exact custody before finality. Direct payout owns a recipient-level journal and emits evidence only
  after terminal conservation. Outbound and return are built-in chain-journal stages: they retain a
  Relay leg, complete only after their own RPC settlement evidence, and return canonical settlement
  evidence on a `SETTLED` replay. Purchase, open, epic gate, and buyback are Collector-capable
  built-in stages: in true production mode (`execution.profile !== 'rehearsal'`), not only the
  narrower collector-only rehearsal profile, their `prepareRequest` receives its own dedicated
  frozen input carrying `liveMode`, a lease-fenced read-only Collector machine-catalog reader
  (purchase only), a lease-fenced read-only `cycleRepository` facade, `config`, and `context` --
  never a signer, a writable repository, or any other adapter. Each reaches its own real refusal
  (missing durable predecessor-stage evidence, the Collector policy evidence-only gate, or a
  downstream configuration or mutation-authority refusal) rather than the frozen
  `LiveModeIntegrationPendingError`, which the driver keeps defined only as inert historical
  journal-compatibility scaffolding; no stage currently maps to it.
- The general chain-attempt runtime is v1; the frozen v2 policy, fencing, refusal, and
  approval-digest fields are unavailable. Live Relay signing uses the separate combined
  recovery record rather than claiming schema parity for all chain attempts.
- Direct Operations seams re-read `requireLiveMutationAuthority` immediately before each injected
  signer, signer broadcast, or provider mutation. Retained Vault/Merkle distribution seams use
  `requireLiveRetainedCustodyMutationAuthority`, which refuses even a future generic frozen Phase 3
  authority until a distinct runtime interface is admitted. `wrapSignerClient` repeats the same
  call-time check at the shared signer and broadcast boundary. A direct stage revalidates again
  after an asynchronous signature and before transport. Payout checks separately for its authorize
  and fund signatures; an unresolved recorded fund attempt remains read-only.
- Live provider attempts are append-only: a handler first constructs a canonical request, the driver
  freezes it and stores its digest in `PREPARED`, then passes that exact request to the provider.
  `markStageAttemptNotSent`, `recordStageAttemptResponse`, `markStageAttemptSentUnknown`, and
  `reconcileStageAttempt` record the provider lifecycle. A pre-call failure persists `NOT_SENT`
  before the capability call and may retry only the same request through `PREPARED`; an error after
  an adapter capability call is observation-only `SENT_UNKNOWN`.
  `reconcileLive` must return `null` for unavailable evidence or a canonical value; `undefined` is
  rejected without advancing the attempt. The driver never completes a stage directly.

## Invariants

- Only `packages/adapters` may depend on pinned npm packages with a lockfile; nothing else in the
  repository may.
- The runner's own test suite runs with zero installs; it never imports `packages/adapters` directly.
- A compromised or vulnerable transitive dependency in `packages/adapters` cannot move funds on its
  own: every mutation still passes through the same schema-bound policy-wallet authorization checks
  (destination, function, asset, and amount allowlists; single-use nonce; independently decoded
  signed-bytes verification) before a signer is ever invoked.
- A held position carries the pack identity recorded in the durable purchase plan for its memo. The
  optional `HOOKEMON_PACK_CODE` configuration is a fallback only for journals without any persisted
  pack record; disagreeing durable sources or a memo without any durable identity fail the hold
  instead of guessing.
- Adapter imports, probes, and reconciliation remain usable while the active interface authority is
  provisional. A direct signer, signer broadcast, or provider mutation refuses that authority at the
  last local boundary before the external effect.
- The shared signer wrapper admits a fixture authority only as the exact test-profile object when
  the Node test-runner context marker is present. It is test plumbing, not a deployment authority
  or a live caller option.
- The operator configuration schema is exact: an unknown field, a missing field, or a
  secret-material field is rejected outright, before any range check runs.
- A legacy configuration gains the current schema marker through the state-file lock. Legacy
  records preserve their prior budget fields, but new cycle, loss, custody, approval, and execution
  controls use fail-closed defaults until an operator configures them.
- `intervalMinutes` is an integer in `[5, 1440]`; `requestedOrders` never exceeds
  `maxBoostersPerCycle`; `maxUnitPriceMicroUsdg` never exceeds `maxCycleBudgetMicroUsdg`, which never
  exceeds `max24HourBudgetMicroUsdg`; every micro-USDG amount is a canonical non-negative decimal
  string. `configurationRevision` only ever advances by exactly one, driven by
  `applyOperatorConfiguration`, never set directly by a caller-supplied patch.
- Parsing persisted state and every state-file CAS reject a configuration above the immutable
  operator hard ceilings. Schema range limits alone cannot grant a larger spending authority.
- The default configuration is conservative: an empty `allowedPackIds`, zero spend caps,
  `liveMode: false` (dry-run), and `paused: false`. Promotion to real spend is a single, explicit,
  dashboard edit, never an inferred default.
- CI installs `packages/adapters` with `npm ci --ignore-scripts` (no lifecycle scripts run) and runs
  its test suite before the pinned-dependency verifier runs.
- A composed service, scheduler, and in-process dashboard share one `CycleRepository`. The
  composition return value and dashboard context use its frozen client facade, which does not
  expose writer methods. WP10b owns migration of a standalone read model.
- A retry after a lost provider response is reconciliation-only. It cannot make a second mutation
  request while an operational attempt is `PREPARED`, `SENT_UNKNOWN`, or `RESPONSE_RECORDED`.
- Phase 3 dry-run and stage-driver construction never load the frozen legacy payout authority. A
  direct legacy live payout resolves that authority only when it reaches its mutation boundary and
  remains fail-closed while the active release is provisional.
- No injected process capability is available while a live handler constructs a request. A mutation
  handler cannot replace an injected adapter or signer view, and its calls are lease-checked at the
  immediate provider or signer boundary.
- An ordinary reconciliation handler can inspect only its explicitly supplied read adapter and the
  repository's read facade. Both are lease-checked at each invocation; it has no route to a signer,
  provider send, or durable state write. Chain-journal reconciliation for claim, outbound, and
  return is the narrow exception: after canonical observation it can write only the relevant
  broadcast, finality, custody, Relay settlement, recovery-context, and nonce-release transitions.
  Built-in direct payout is the other recovery exception: it may idempotently record successor dust
  and update its nonce fence before returning terminal evidence.
- An Operations route acquires and asserts its wallet-keyed nonce reservation before each signature
  and broadcast. The reservation is globally durable, contains its fencing token and lease window,
  and cannot be replaced until expiry; no production composition wires the compatibility-only third
  Operations role.
- For `claim-process` specifically, `stage-driver.mjs`'s `execute()` resolves and verifies the exact
  `operator-evm` standing-authority step authorization for the durably recorded stage/cycle/request
  digest -- through the same `config.standingAuthorityStepAuthorization` resolver and
  `verifyAndRecordStepAuthorization` contract the real sign-time guard uses -- before calling
  `claim-process.mjs`'s own `mutate`, and therefore before that handler's own wallet-nonce
  reservation (`reserveClaimWalletNonce`, which itself precedes any signer call). This is a real
  availability check, not a cached permission: `verifyAndRecordStepAuthorization` is idempotent (a
  repeat call for the same intent only reads back its persisted first-use decision), and every guard
  that already runs at the actual `sign()`/`signApproved()` boundary inside `guardedSignerRole`
  (lease, nonce fence, standing authority) still runs unchanged when `mutate` reaches it. The check
  applies only when a standing authority is required (`execution.profile === 'production'` and
  `providerMode === 'live'`) and only to this one built-in stage; it prevents a first attempt whose
  authorization is not yet available from ever reserving the wallet nonce, so a later retry under a
  rotated lease fencing token is never blocked by a stranded reservation from that refused attempt.
- `src/app/stages/purchase.mjs`'s `preparePurchaseRequest` sources the number of packs a cycle
  purchases from the cycle's own durably admitted record (`cycleRepository.describeCycle(cycleId)
  .admission`, written once at admission by `buildAdmissionPlanner.plan` from the operator's
  `requestedOrders`), not from a second, independently configured quantity. A caller-supplied
  `config.pack.quantity` is consulted only to refuse an explicit contradiction against that
  admission, and, for a genuinely unadmitted context, as a bounded default of 1. In the composed
  production execution profile (`config.execution.profile === 'production'`) a missing admission --
  no cycle-scoped repository/context at all, or a real cycle record whose admission is `null` -- is
  refused before catalog access, policy authorization, signer, or provider mutation, rather than
  silently constructing an unpriced one-pack request; the bounded default remains available for
  every other, explicitly non-production context (a standalone probe/dry run, or the Collector-only
  rehearsal profile). An admitted quantity is independently re-bounded to the shared purchase-stage
  batch/catalog ceiling (`MAXIMUM_PACK_BATCH_SIZE`, packages/runner/src/cycle/money-schemas.mjs) as
  defense against a corrupt or replayed record; the same ceiling is independently enforced earlier,
  before the cycle exists, at both `packages/runner/src/automation/policy-engine.mjs`'s
  `assertPolicyAdmission` (before `CycleRepository` durably persists the admission) and
  `buildAdmissionPlanner.plan`'s own construction boundary in `packages/adapters/src/app/compose.mjs`
  (before any catalog read, Relay quote, or hook liability read).
- A custody ledger key is `(cycleId, chainId, assetId)`. Its first record fixes `decimals`; later
  records with another decimal value are rejected both while writing and during journal replay.
  Buyback reconciliation reads the cycle's existing row for its settlement asset before it writes
  its realized-proceeds total, so every other bucket that row already carried (claimed, bridge,
  pack cost, and the rest) survives unchanged; only `buybackProceeds` is replaced. A consumer that
  looks this row up must reconstruct the repository's own key exactly, never a different separator
  or format, or it silently finds nothing and overwrites the whole row with a fresh, empty one.
- A generic chain transaction is keyed by `(cycleId, stage, requestDigest)`. It persists raw bytes,
  one nonce or blockhash, a signing hash, and later broadcast and finality observations. The current
  schema does not retain policy digest, approved-semantics recovery material, fencing, or a terminal
  refusal. Outbound and return attach those facts through the repository's combined Relay signing
  record; direct payout retains those facts with its signed recipient state in its own durable
  journal.

## State transitions

1. `product/dependency-pins.json` records the exact pinned dependency set and paths for
   `packages/adapters`.
2. CI (`.github/workflows/v4-gates.yml`, "Verify adapters dependencies" step) installs from the
   committed lockfile with `npm ci --ignore-scripts` and runs `node --test test/*.test.mjs`.
3. `scripts/verify-control-dependencies.mjs` re-derives the lockfile's format, integrity fields, and
   direct dependency set and compares them against the pin; any drift fails the gate closed.
4. Separately, an operator (or dashboard) edit to the configuration document goes through
   `applyOperatorConfiguration`, which validates the full replacement, advances
   `configurationRevision` by exactly one, and is persisted through
   `mutateOperatorState`'s existing atomic, revision-compare-and-swap write.
   A read of a canonical legacy configuration performs the same atomic state-file replacement with
   the versioned, fail-closed configuration before returning it.
   The same parse and CAS boundary rejects an over-cap configuration before it can reach policy
   admission or a scheduler.
5. A live operational stage builds and freezes its canonical request from data-only input, persists
   its digest in `PREPARED`, and invokes the mandatory policy and lease guards before mutation and
   before every signer `sign` or `broadcast` call and known direct provider or RPC mutation. The
   active authority is revalidated at the final local boundary before each external effect. A
   refusal before an adapter call persists `NOT_SENT` and may retry only the same request after it
   returns to `PREPARED`; an error after an adapter capability is reached records observation-only
   `SENT_UNKNOWN`; a returned
   provider result records `RESPONSE_RECORDED`. The attempt advances only after `reconcileLive`
   returns non-null canonical evidence. Built-in outbound and return reconciliation may complete
   their chain-journal stage from canonical Relay settlement evidence; pending provider integrations
   stop after `PREPARED`. Dry-run also refuses to bypass an unresolved live attempt with a probe.

## Operational commands

```sh
cd packages/adapters && npm ci --ignore-scripts
node --test packages/adapters/test/*.test.mjs
node scripts/verify-control-dependencies.mjs
node --test packages/runner/test/config/state-schema.test.mjs
node --test packages/runner/test/automation/policy-wallets.test.mjs
node --test packages/runner/test/operator/state-file.test.mjs
node --test packages/adapters/test/app/cycle-repository.test.mjs packages/adapters/test/app/stage-driver.test.mjs
```

## Recovery pointers

- Bump a pinned adapter dependency only from its official release, then update
  `packages/adapters/package.json`, regenerate `packages/adapters/package-lock.json`, and update
  `product/dependency-pins.json` and `product/dependency-verification.json` together; re-run
  `scripts/verify-control-dependencies.mjs` until it passes closed.
- If `npm audit` reports a new advisory against a transitive dependency, record the accepted
  decision in `packages/adapters/README.md`'s "Known accepted advisory" section rather than silently
  ignoring it; never add a private registry override or lockfile-integrity allowlist to force a
  pass.
- A configuration document that fails `assertOperatorConfiguration` never reaches the operator state
  file: fix the caller-supplied patch, never relax the schema, to admit it.
- An over-cap persisted configuration is not migrated or clamped. Correct it through an authorized
  configuration update that stays within the immutable ceiling, then restart from canonical state.
- A pending operational attempt is not a retry signal. Inspect its request digest and reconcile it
  from provider status or finality evidence; retain the cycle in a held state when the evidence is
  unavailable or unverifiable.
- Reuse the injected repository client inside a composed process. Composition hands the dashboard
  and CLI only the frozen client facade; WP10b owns standalone dashboard adoption.
