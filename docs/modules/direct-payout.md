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
- `DIRECT_PAYOUT_RECIPIENT_LIMIT` bounds plan compilation and the feasibility gate at 1,025.
  Recipient-keyed durable pages retain the full manifest outside bounded journal payload arrays;
  journal entries retain only compact state metadata and page roots.
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

## Operational commands

```sh
node --test --test-timeout=120000 packages/adapters/test/app/stages-payout.test.mjs
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
