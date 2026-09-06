# Direct Payout

## Purpose

The direct-payout module distributes a finalized Operations-wallet USDG return to the frozen
pre-claim holder set. It keeps the immutable plan, recipient lifecycle, dust carry, and quarantine
liabilities in durable cycle storage so a restart never invents a payment, nonce, or allocation.
It also compiles an immutable supplementary plan and records its position-scoped durability
boundaries without changing the original cycle's holder set.

## Public interface

- `compileDirectPayoutPlan()` in `packages/runner/src/distribution/payout-plan.mjs` creates a
  floor-and-carry plan from the full frozen eligibility manifest, a finalized return delta and
  evidence binding, and one provenance-bound prior dust record.
- `compileSupplementaryDirectPayoutPlan()` creates a pure, frozen wrapper for one held-position
  settlement. Its `manifestId` is `<cycleId>:supplementary:<n>`, its wrapper digest binds that id,
  ordinal, and nested direct plan, and the nested plan reuses the original cycle's frozen
  eligibility manifest. The compiler itself has no side effect.
- `prepareSupplementaryPayoutRequest()` in
  `packages/adapters/src/app/stages/supplementary-payout.mjs` accepts only
  `{settlement, eligibilityManifest, returnBoundary}` for a `RETURN_BROADCAST` settlement. It
  hashes the supplied eligibility manifest and requires the settlement's stored
  `eligibilitySnapshotEvidenceDigest`; it derives the return, binding, and zero-amount dust setting
  from the full-repository return boundary and requires its stored `payoutSourceDigest`.
  `supplementaryPayoutStageId()` gives that position a separate paged-state namespace.
  `createSupplementaryPayoutStore()` wraps the existing recipient-state store and rejects a
  position, cycle, snapshot digest, return-source digest, boundary evidence, or manifest mismatch.
  `assertSupplementaryPayoutManifestUnchanged()` rejects a changed frozen plan.
- `createDirectPayoutState()` and `initializeDirectPayout()` create or recover the durable payout
  state; initialization returns an existing matching journal instead of overwriting it. Both accept
  an optional `inFlightWindow` (default 1, byte-identical to fully serial dispatch) that bounds how
  many recipients may hold a live, not-yet-finalized on-chain nonce at once.
  `advanceDirectPayout()` advances any recipient inside that bounded in-flight window: a recipient
  still `PREPARED` (not yet broadcast) always blocks every later recipient, since nonces are handed
  out and broadcast strictly in order, but up to `inFlightWindow` already `SIGNED`/`BROADCAST`
  recipients may await finality concurrently, so one slow confirmation does not stall the recipients
  behind it. A dropped broadcast can use only `recoverDroppedBroadcast()` with its retained bytes; a
  nonce consumed by another transaction becomes a recipient `NONCE_INTERFERENCE` quarantine.
- `evaluateDirectPayoutBridgeAdmission()` and `evaluateDirectPayoutFrozenAssetAdmission()` are pure
  pre-admission checks: the first refuses to admit an attributable distributable amount above the
  actually finalized available proceeds and reports the exact deficit; the second refuses to admit
  any recipient while USDG is frozen for the Operations sender, preserving the whole distributable
  pool as unsent liability instead of partially dispatching. `ensureDirectPayoutState()` runs the
  frozen-asset check before any recipient state is created and holds the cycle `HELD_UNAVAILABLE`
  with the admission evidence when it fails; it never signs, broadcasts, or persists a recipient
  record before that check has passed.
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
- `preparePayoutRequest()` also snapshots unresolved held positions from the same cycle into a
  sorted `heldPositionExclusions` record. Its digest is persisted with the main payout state and
  terminal payout evidence lists the excluded position ID, reason, terminal state, and position
  evidence digest.
- The repository records one position's supplementary boundary sequence:
  `PREPARED -> BUYBACK_SENT_UNKNOWN -> RETURN_BROADCAST -> PAYOUT_BROADCAST -> COMPLETE`. The
  settlement's manifest id, original frozen eligibility-snapshot evidence digest, and later
  repository-derived payout-source digest remain distinct from the main payout manifest.
  `readSupplementarySettlementEvidence(positionId)` is available only on the full repository while
  recovery needs its provider or transaction facts; the narrow read client omits it.
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
- Held positions never enter the main return delta or distributable pool. The request and durable
  payout state bind their exclusion list to the original cycle; a changed list before initialization
  or recovery is refused instead of changing the frozen main settlement.
- A supplementary plan binds exactly one held position and the original cycle's frozen eligibility
  set by the stored eligibility-snapshot evidence digest. It cannot change the main manifest,
  substitute another cycle's attribution, use a later same-cycle snapshot, or accept a different
  manifest ordinal after the settlement is prepared.
- `DIRECT_PAYOUT_RECIPIENT_LIMIT` is a hard technical ceiling (50,000) protecting canonical-JSON and
  in-memory bounds, not a payout-capacity business rule: recipient count alone never truncates a
  feasible holder set. Real admission is feasibility-gated by the actual recipient count's gas
  budget (`estimatedNativeFee = recipientCount * measuredTransferGas * maxGasPriceWei`, computed and
  reported with its exact deficit in `eligibility-snapshot.mjs`), not by a fixed recipient cap.
  Recipient-keyed durable pages retain the full manifest outside bounded journal payload arrays;
  journal entries retain only compact state metadata and page roots.
- A frozen eligibility manifest with no eligible holders compiles to an explicit
  `outcome: 'NON_SPENDING_NO_ELIGIBLE_HOLDERS'` plan instead of throwing: `allocations` is empty,
  `payableRecipientCount` is 0, and the entire distributable pool becomes durable dust for the
  successor cycle. A plan with at least one eligible holder always compiles with
  `outcome: 'ALLOCATED'`. No unallocated value is ever invented or dropped in either case.
- A supplementary wrapper is deterministic for identical frozen inputs and is deeply immutable in
  memory. Its digest detects a changed ordinal, return evidence, allocation, zero-amount dust
  setting, or eligibility proof before an execution layer can bind it. `RETURN_BROADCAST` is the
  only point that freezes its USDG return, Operations return binding, and zero/null supplementary
  dust setting; recovery verifies that full-repository boundary before it persists recipient state.
  The existing implementation preserves the wrapper identity through durable boundary records and
  a separate paged recipient-state namespace.
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
- A supplementary sell records its independent settlement through `PREPARED`,
  `BUYBACK_SENT_UNKNOWN`, `RETURN_BROADCAST`, `PAYOUT_BROADCAST`, and `COMPLETE`. A restart
  preserves the same manifest id, original eligibility-snapshot digest, payout-source digest, and
  boundary evidence; it never replaces the manifest. A supplementary payout request can be
  prepared only at `RETURN_BROADCAST` and persists only its matching manifest-scoped recipient
  state.

## Operational commands

```sh
node --test --test-timeout=120000 packages/adapters/test/app/stages-payout.test.mjs
node --test --test-timeout=120000 packages/adapters/test/app/stage-driver.test.mjs
node --test --test-timeout=120000 packages/adapters/test/app/supplementary-payout.test.mjs
node --test --test-timeout=120000 packages/adapters/test/app/payout-resume-scale.test.mjs
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
- For a supplementary settlement, recover the held position and its manifest-scoped boundary
  record first. Read boundary facts from the full repository's
  `readSupplementarySettlementEvidence(positionId)` only while reconciling the position; the
  dashboard client intentionally cannot read those provider or transaction facts. The same position
  digest, manifest id, state, original eligibility-snapshot digest, and evidence must remain valid
  before advancing it. A payout request also requires the same repository-derived return source,
  zero/null dust setting, and return-boundary evidence. A changed position, snapshot, source, or
  manifest keeps that settlement unresolved rather than creating a replacement transfer.
- OPEN FACT: The supplementary plan and repository boundaries do not yet drive live provider
  buyback, return, or recipient transfers. Current supplementary dispatcher handlers are
  Node-test-only, observation-only, and receive no provider or signer capability. Resolve this by
  wiring manifest-scoped production stage adapters to the existing write-ahead mutation and
  recipient-journal contracts, then add restart tests through finality. Verified safe alternative:
  retain the held position and inspect its immutable plan; do not send a manual provider request or
  transfer.
- OPEN FACT: Supplementary payout has no atomic position-aware transition that consumes a nonzero
  original-cycle dust record. Resolve it by adding a manifest- and position-bound consumption and
  recovery contract, with tests for concurrent main and supplementary settlement. Verified safe
  alternative: persist zero supplementary dust with a null source and never reuse a normal-cycle
  dust record.
