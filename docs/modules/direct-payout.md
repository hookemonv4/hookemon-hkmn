# Direct Payout

## Purpose

The direct-payout module distributes a finalized Operations-wallet USDG return to the frozen
pre-claim holder set. It keeps the immutable plan, recipient lifecycle, dust carry, and quarantine
liabilities in durable cycle storage so a restart never invents a payment, nonce, or allocation. It
implements the payout durability contract in `REQ-direct-payout-1`.

## Public interface

- `compileDirectPayoutPlan()` in `packages/runner/src/distribution/payout-plan.mjs` creates a
  floor-and-carry plan from the full frozen eligibility manifest, a finalized return delta and
  evidence binding, and one provenance-bound prior dust record.
- `createDirectPayoutState()` and `initializeDirectPayout()` create or recover the durable payout
  state; initialization returns an existing matching journal instead of overwriting it.
  `advanceDirectPayout()` advances the first unresolved recipient. A dropped broadcast can use only
  `recoverDroppedBroadcast()` with its retained bytes; a nonce consumed by another transaction
  becomes a recipient `NONCE_INTERFERENCE` quarantine.
- `recoverDroppedBroadcast()` reauthorizes and submits only the exact retained signed bytes. It
  requires the stored policy, approval, semantics, signed-message, and fencing-token digests. It
  reloads the authoritative paged payout state before reauthorization and refuses a stale attempt
  after a same-nonce replacement.
- `assertPayoutManifestUnchanged()` checks a candidate plan digest against the frozen journal.
  `isDirectPayoutComplete()` requires terminal recipient states and exact conservation.
- `preparePayoutRequest()` reads the completed eligibility and return stages, reads prior dust, and
  binds their evidence to one immutable request. `mutatePayout()` drives the built-in live payout
  handler and `reconcileLivePayout()` returns terminal stage evidence only after conservation.
  It derives an exact one-recipient policy from the persisted payout attempt around the guarded
  Operations signer facade for every signature. A supplied branded signer is not reused as the
  payout authorization.
- `createCycleAttributableFinalizedAvailableReader()` in
  `packages/adapters/src/app/payout-availability.mjs` is the owned, read-only
  `readCycleAttributableFinalizedAvailable` implementation composition wires onto the production
  Robinhood client. Given the plan's cycle, Operations and USDG identities, return delta, return
  evidence binding, and prior-dust provenance, it independently reloads and re-authenticates the
  completed `return` stage evidence: either the zero-proceeds record with no recorded return Relay
  leg, or exactly one total return Relay leg that is itself `SETTLED` and matches the cycle's
  custody ledger `returnReceived`; a second unresolved or terminal return leg is rejected as
  ambiguous even when the admitted leg is settled. It locates that custody row by the canonical
  CAIP identity built from the request's independently validated USDG asset -- never the settled
  leg's own raw `destinationChainId`/`destinationAssetId` pair -- requiring the durable
  `returnLegLedgerKeys` association this exact Relay request id was recorded under to name that
  same canonical key, a matching v2 row for this cycle with that identity's decimals, and no
  competing legacy raw-identity row for the same asset; a missing or mismatched association, a
  wrong-schema/cycle/asset/decimals row, or any raw-row coexistence all refuse before the balance
  check ever runs. For nonzero carried dust it accepts either the
  exact globally unconsumed source (the later atomic initializer still consumes it) or this exact
  cycle's already-consumed record when it is bound to the request's current plan digest with no
  conflicting payout state -- the durable restart of a crash between dust consumption and
  payout-state persistence; every other consumed source stays refused. It then proves a finalized
  Operations USDG balance at least equal to the attributed sum through a
  public/archive/same-height-public checkpoint before returning exactly `returnDelta +
  previousDust` as a typed USDG amount. It never returns a wallet-wide balance and never mutates
  the cycle repository; the existing atomic initializer remains the sole dust-consuming writer.
- `createCycleRepositoryPayoutStore()` reads and writes recipient state through
  `readPagedPayoutState()` and `persistPagedPayoutState()`. Each retained recipient record contains
  its nonce, signed bytes, transaction hash, policy approval context, and finality or refusal
  evidence. `consumePayoutDustAndPersistPagedPayoutState()` publishes immutable pages, then records
  their compact reference and predecessor-dust consumption. The stage repairs an unbound matching
  page state before it reads a payout nonce or requests a signature.
- The architecture names the durable records `PayoutManifest`, `RecipientPayoutJournal`,
  `ChainTransactionAttemptV2`, `PayoutRecoveryEvidence`, `QuarantineLiability`, and
  `PayoutDustCarryV1`. Recipient attempts retain request and policy identity, the fencing token,
  nonce, approved semantics, exact signed bytes and their hash, transaction hash, and recovery
  evidence.

## Invariants

- Every USDG amount is `{chainId:4663, assetId:<lower-case configured contract address>,
  decimals:6, amountAtomic}`. The plan rejects a symbolic asset identity or a return binding that
  disagrees with the configured Operations address or USDG contract.
- Before a recipient journal is created, the plan validates the frozen total-supply proof, finality,
  exclusions, log-completeness evidence, feasibility envelope, and canonical digest. Recovery
  reconstructs allocations from the retained evidence rather than trusting a supplied digest.
- Allocation uses integer floors. `totalAllocated + dust == returnDelta + previousDust`; nonzero
  prior dust requires `{cycleId, digest, planDigest}` in the plan and is consumed through the
  recoverable initialization protocol before a successor plan can use it. Page publication and the
  journal binding are a recoverable
  initialization protocol rather than one raw storage write: a restart repairs an unbound matching
  page state with the same predecessor source and plan, never with zero dust. Positive successor
  dust is recorded after terminal conservation.
- Direct payout accepts at most 10,000 recipients, subject to the configured recipient and
  transaction limits and native fee/reserve checks. Offline scale coverage compiles a real
  10,000-recipient plan and round-trips both its initial state and a normalizer-valid fully
  finalized fixture through durable paging and reopen, preserving every recipient and atomic-unit
  conservation. This coverage excludes replacement histories, quarantine entries and held-position
  exclusions at that scale; it does not represent live signing or transfers. Recipient-keyed
  durable pages retain the full manifest outside bounded journal payload arrays; journal entries
  retain only compact state metadata and page roots.
- The stage driver uses direct payout by default even if unrelated historical contract identities
  remain configured. The old vault flow is selected only by explicit `payout.legacyVault: true`.
- Before a payout reads a nonce, it reserves `WalletNonceReservationV1` for the Operations wallet
  through `reserveWalletNonce()`. The reservation carries its fencing token and lease window;
  every signer and broadcaster boundary asserts that same active reservation. A different fence may
  take it over only after expiry. Terminal reconciliation releases it with an exact
  compare-and-delete of the global reservation, or idempotently clears the same stranded record.
- Before the first signature, the chain client reads the current Operations native balance and
  confirms the frozen gas envelope. A missing or insufficient balance read fails closed.
- A signed transfer is accepted only when it decodes to the persisted Operations sender, chain,
  nonce, recipient calldata, gas envelope, and raw-byte hash. Replacement bytes retain nonce and
  calldata, increase the fee, and pass the same policy boundary. Signed state retains
  `policyDigest`, `approvalDigest`, `approvedSemanticsDigest`, `signedMessageDigest`, the fencing
  token, and its digest beside the raw-byte hash.
- `FINALIZED` requires a stable canonical receipt at or below the finalized head, matching Transfer
  logs, and archive-capable evidence proving both the Operations debit and recipient credit equal
  the planned amount. Receipt logs alone never settle a payout.
- `evaluateDirectPayoutBridgeAdmission()` reads its `finalizedAvailableAmount` only from
  `adapters.robinhood.client.readCycleAttributableFinalizedAvailable()`, never from a wallet-wide
  balance; the same Operations wallet can hold unrelated cycles' funds that must never fund this
  cycle's shortfall. A missing reader, or one that cannot yet produce a value, fails closed as
  `NON_SPENDING_BRIDGE_AVAILABILITY_UNKNOWN` rather than skipping the check.
- A frozen pre-sign recipient or a finalized reverted transaction becomes `REFUSED` only after a
  custody-backed quarantine reservation succeeds. Paid, quarantined, and dust amounts must exactly
  conserve the distributable pool before terminal evidence exists. The exported direct-payout API
  fails before it persists a refusal when no reservation-capable repository is supplied.
- Quarantining a frozen recipient or nonce interference does not strand later recipients. After the
  immutable payout pass completes, any quarantine liability causes `mutatePayout()` to hold the
  cycle `HELD_OWNER_DECISION` without changing another recipient or allocating a new nonce.
- Every signature and broadcast goes through the Operations transaction-policy signer; direct
  payout never submits raw signed bytes through the RPC client. Composition validates
  `MoneyConfigurationV1`, decodes the persisted recipient transaction, and wraps the guarded
  facade with an exact policy before each initial or replacement signature. The wrapper does not
  bypass standing-authority, lease, policy-engine, or wallet-nonce checks.
- A production-capable direct `advanceDirectPayout()` call ignores caller-supplied policy-signer
  factories and derives the same exact local policy. Isolated non-production helpers may retain
  their explicit policy-signer seam.
- Before either durable admission point (a fresh cycle or a resumed one), `ensurePayoutCustodyLedger`
  writes the `hookemon.custody-ledger.v2` row for the canonical EVM USDG identity
  (`eip155:<chain>` / `eip155:<chain>/erc20:<lower-case token>`, from `MoneyConfigurationV1.assets.usdg`
  independently cross-checked against the configured contract, chain, and the plan's own returnDelta --
  never a raw or candidate-ledger identity). It reuses
  `createEvmCustodyBalanceObservationReader()` (`packages/adapters/src/evm-custody-balance-observation.mjs`)
  with the distinct `adapters.robinhood.client` / `historicalEvidenceClient` pair for
  `verifiedCurrentBalance`, and skips that read entirely for a zero-payable-recipient cycle, matching
  the existing rule that such a cycle never touches the chain. A pre-existing row's fourteen buckets
  and `expectedCycleAsset` are always carried forward byte-for-byte; only `verifiedCurrentBalance` is
  refreshed. If that row does not yet show `returnReceived` covering this payout's returnDelta, the
  write refuses with the same finalized-return-backing error as before -- this reports a pending
  return-leg dependency, it never migrates, downgrades, or resolves another stage's row. The
  repository itself enforces no v2-to-v1 downgrade, no non-null-to-null balance erasure, and monotonic
  finality on every write.
- Before that same write, `ensurePayoutCustodyLedger` also looks up the legacy raw (non-CAIP)
  identity for the same configured USDG asset (`{chainId: '4663', assetId: <configured contract>}` --
  the identity the pre-migration writer, and today's not-yet-migrated return-settlement path, still
  use). If any row exists there -- alone, or already coexisting with a canonical row -- the whole
  custody-ledger step refuses before any new write, signature, or broadcast. It never copies a
  balance or bucket across identities, invents alias resolution, or initializes backing from the
  plan while that predecessor exists; both rows and their full history are left exactly as found.
  This is the explicit, intended block on payout admission until the return consumer's own
  canonical-identity migration lands -- not a bug to route around locally.
- `reservePayoutQuarantine` resolves its custody ledger through the same one narrow relation, always
  independently recomputed from the quarantined amount, never from a caller-trusted identity: chain
  `4663`, six decimals, and a normalized (lower-case) 20-byte token map to `eip155:4663` /
  `eip155:4663/erc20:<that same token>`; anything else stays at its raw amount identity. It prefers a
  canonical row when the relation applies, still reserves against a legacy raw-identity row when only
  that one exists, and refuses outright if a raw and a canonical row for the same asset ever coexist
  -- reserving against either silently would leave the other stale. `assertPayoutQuarantineReservation`
  accepts a stored reservation's embedded ledger under either the historical exact-raw-identity rule
  or this same independently recomputed canonical relation, so a reservation made before the
  canonical-v2 migration keeps replaying unchanged.
- `reconcileLivePayout()` treats a locally complete payout state (`isDirectPayoutComplete`) as
  necessary, never sufficient: a zero-payable-recipient state is complete the instant it is
  persisted, before `ensurePayoutCustodyLedger` ever runs, so a crash between that persist and the
  custody write must not let reconciliation finalize on the bare completion flag. Before it may
  recover a stranded nonce, record successor dust, or return terminal evidence, it re-runs
  `assertRuntimeConfiguration` against the persisted Operations/USDG identity, then independently
  re-validates custody through the same read-only identity/raw-conflict/backing predicate
  `ensurePayoutCustodyLedger` uses, addressed at the exact canonical row for the frozen plan's own
  `returnDelta`. A raw predecessor, a raw-and-canonical pair, a missing canonical row, insufficient
  `returnReceived` backing, or (for a positive-recipient plan) a missing or identity-mismatched
  persisted `verifiedCurrentBalance` observation all refuse before any finalize-side effect; the
  check never writes, reads the chain, or requires a signer, and a missing or corrupt custody row is
  never treated as evidence of a genuine prior admission. A zero-payable-recipient plan keeps the
  accepted null-observation rule -- an existing canonical row with sufficient backing is enough.

## State transitions

- A frozen request initializes ordered `PREPARED` records. A payable record reserves its nonce,
  then transitions `PREPARED -> SIGNED -> BROADCAST -> FINALIZED` after exact finality proof.
- A pre-sign freeze may release the serial tail nonce, then transitions to `REFUSED`. A finalized
  reverted transaction also transitions to `REFUSED` after its nonce outcome is proved and the
  custody liability is reserved.
- A missing broadcast transaction with its nonce still available is decoded and allowlisted again
  as the exact persisted bytes before rebroadcast. A restarted signer never calls `sign()` for that
  path. If another transaction consumed the nonce, the record becomes `NONCE_INTERFERENCE`; later
  recipients may advance from the immutable plan, then the cycle holds `HELD_OWNER_DECISION` for
  the quarantine liability.
- The `SIGNED` recipient page persists the exact signed bytes and its policy approval context in
  one durable recipient record. Recovery derives its authority from that record, so an orphan
  approval context cannot authorize a `PREPARED` recipient and retained bytes stay closed unless
  the signed record itself is complete.
- A crash after terminal recipient persistence is recovered by reconciliation: it records successor
  dust idempotently before returning the direct-payout result to the stage driver.
- Zero-atomic allocations remain in the immutable plan but create no transfer attempt. Completion
  requires every payable recipient to be `FINALIZED` or backed by exactly one quarantined
  `REFUSED` liability and requires `paid + quarantined + dust == distributablePool`.

## Operational commands

```sh
node --test --test-timeout=120000 packages/adapters/test/app/stages-payout.test.mjs
node --test --test-timeout=120000 packages/adapters/test/app/payout-custody-v2.test.mjs
node --test --test-timeout=120000 packages/adapters/test/app/payout-availability.test.mjs
node --test --test-timeout=120000 packages/adapters/test/app/stage-driver.test.mjs
node --test --test-timeout=120000 packages/runner/test/distribution/payout-plan.test.mjs
```

- Run the direct payout through the built-in stage driver; it prepares the request from completed
  eligibility and return evidence and supplies the guarded policy signer and nonce fence.
- Production requires a distinct `HOOKEMON_ROBINHOOD_ARCHIVE_RPC_URL`.
  `readEnvironment` rejects a missing or public-RPC-equal URL, and `compose` wraps the archive
  endpoint as `adapters.robinhood.historicalEvidenceClient.readErc20BalanceAtBlock` for
  block-pinned ERC-20 evidence. The latest-only public RPC is never used as payout finality
  evidence. Explicit injection remains available for controlled compositions and tests.

## Recovery pointers

- Use the specific runbook for a [frozen recipient](../runbooks/payout-recipient-frozen.md),
  [holder-count refusal](../runbooks/payout-holder-envelope.md),
  [nonce interference](../runbooks/evm-nonce-interference.md), or a
  [dropped transaction](../runbooks/evm-transaction-dropped.md) or
  [replaced transaction](../runbooks/evm-transaction-ambiguity.md). Each recovery
  contract records the supported resume command or its absence.
- Reload the durable payout state before signing or rebroadcasting. Reconcile every current and
  replacement hash before constructing a fee bump.
- If recovery finds pages without their matching predecessor-dust journal reference, reconstruct
  the exact plan and source binding and replay
  `consumePayoutDustAndPersistPagedPayoutState` before signing; never rebuild with zero dust.
- A fresh policy signer decodes and evaluates the retained bytes against the persisted approval
  context before broadcast. It never re-signs a dropped broadcast and direct payout never sends
  retained bytes through a raw RPC transport.
- Leave a canonical receipt unresolved if archive balance evidence is missing, the receipt changes,
  or either balance delta differs from the plan. Resolve `NONCE_INTERFERENCE` from independent
  nonce and transaction evidence rather than reusing the nonce.
- Treat a changed plan as a recovery condition and never allocate a replacement nonce or recipient
  transfer. A recipient that freezes before signing is refused and quarantined; a signed transfer
  that finalizes reverted is quarantined before later recipients advance.
- A missing recovery context, changed digest, stale wallet reservation, or changed signed bytes
  keeps the recipient attempt unresolved. It does not create a replacement signature.
