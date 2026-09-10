# Cycle Repository

## Purpose

The cycle-repository module is the durable authority for operational cycle progress, provider and
chain attempts, Relay legs, standing-authority decisions, wallet nonce reservations, custody
buckets, payout carry records, terminal holds, and recovery facts. Automation owns its writer;
dashboard, CLI, and runner callers receive a frozen read client rather than a second state path.

## Public interface

`createCycle` optionally accepts a validated `packPlan` and binds its revision, orders, and digest to the cycle in the initial `cycle-opened` event. `readActiveCycle` and `describeCycle` return this immutable `packPlanSnapshot` after restart. Legacy cycles retain no snapshot; recovery does not infer one from current settings. See [Pack plan snapshot](pack-plan-snapshot.md).

`recordSupplementaryPayoutGas` records finalized native transaction gas against an existing supplementary manifest and its persisted signed recipient bytes. It accepts only process-authenticated payment or gas-only proofs, reserves each transaction globally, and replays idempotently after restart. Replay checks the exact event against its atomic global reservation, including the original signed-transaction and proof digests. This write changes gas accounting only, including for reverted transactions after the main cycle completes; it grants no principal and does not extend generic custody writes.

- `CYCLE_REPOSITORY_CLIENT_INTERFACE` exposes `readActiveCycle`, `peekActiveCycle`, `readStage`,
  `describeCycle`, `readOperationalStageAttempt`,
  `readChainTransactionAttempt(cycleId, stage, requestDigest)`, `readClaimPreconditions`, and
  `listKnownCycleIds`, plus `readPagedPayoutState` for durable payout allocation projections.
  `peekActiveCycle` observes the active slot without performing the archival repair that
  `readActiveCycle` may perform.
- `CYCLE_REPOSITORY_INTERFACE` adds `createCycle`, `prepareStage`, `completeStage`,
  `completeCycle`, `holdCycle`, provider-attempt writes, chain-attempt writes, Relay settlement,
  standing-authority decisions, wallet nonce reservations, paged payout state, and custody writes.
- Provider writes are `prepareStageAttempt`, `markStageAttemptNotSent`,
  `markStageAttemptSentUnknown`, `recordStageAttemptResponse`, and
  `anchorOperationalStageDeadline`, and `reconcileStageAttempt`.
  `anchorOperationalStageDeadline` appends the observational
  `stage-attempt-deadline-anchored` event for a legacy `SENT_UNKNOWN` or `RESPONSE_RECORDED`
  attempt whose sent, response, and prior anchor timestamps are all absent. Its
  `deadlineAnchorMs` is the first durable observation time, is replay-validated against the
  unchanged attempt and request digest, and repeated calls return the existing record without
  another append. `markStageAttemptNotSent` preserves the request digest without effect
  evidence so the same request can return to `PREPARED` for a lease-fenced retry.
- Chain writes are `prepareChainTransactionAttempt`,
  `recordSignedTransaction(cycleId, stage, requestDigest, signingMaterial)`,
  `recordSignedTransactionWithRecoveryContext(...)`,
  `recordBroadcast(cycleId, stage, requestDigest, evidence)`, and
  `recordFinality(cycleId, stage, requestDigest, evidence)`. The combined write commits a signed
  attempt, its recovery authority, and an optional Relay source reservation in one append; live
  Relay stages use it. `persistChainAttemptRecoveryContext` remains a separate companion write for
  ordinary chain-attempt compatibility paths, and reads by the exact
  `(stage, recipient, requestDigest, rawSignedBytesHash)` selector.
- `recordRelayLeg`, `recordRelayLegSource`, `readRelayLeg`, and `settleRelayLeg` manage one
  `RelayLegV1` per Relay request. `recordRelayLeg` accepts only an unsigned `RECORDED` leg;
  `recordRelayLegSource` attaches a source hash after its bytes are durable; `settleRelayLeg`
  accepts only independently observed finality and attribution evidence. A return settlement takes
  `ReturnLegDestinationProofV1`: an authenticated terminal Relay pointer and one finalized source
  and destination observation from this process. It records `SETTLED` only when the observed
  transfer is the exact USDG credit to Operations for the quoted amount within the persisted
  window; other observed transfer facts enter their named terminal hold. Source and destination
  hashes are globally unique.
- `readStandingAuthorityDecision` and `recordStandingAuthorityDecision` persist one exact
  `StandingAuthorityDecisionV1` with its day-cap and nonce reservations. The latter operation is
  atomic with the repository's global reservation store.
- `reserveWalletNonce`, `assertWalletNonce`, and `releaseWalletNonce` manage a global
  `WalletNonceReservationV1` for `(chainId, wallet)`. The older `acquireEvmNonceLock`,
  `assertEvmNonceLock`, and `releaseEvmNonceLock` remain compatibility methods for callers that
  have not moved to the typed reservation.
- `createCycleRepositoryClient` and `createCycleRepositoryRunner` return frozen client facades.
  Amounts use `{chainId, assetId, decimals, amountAtomic}` with `amountAtomic` as an integer
  string; USDG and Solana stablecoins remain distinct assets.
- `createCycle({ ..., dryRun: true })` records an explicit production dry run with fake providers;
  reopening preserves that flag. `CycleRepository.open(stateDir)` verifies a private sibling store
  identity, an in-directory device-and-inode witness, and a sibling identity-witness hard link
  before opening the journal. The in-directory (device, inode) pair can be reused by the filesystem
  immediately after a delete-and-recreate (observed on Linux ext4/tmpfs), so it alone cannot tell a
  genuine reopen from a replacement directory with a byte-copied marker; the sibling hard link
  outside the state directory closes that gap, since its target inode cannot be reused elsewhere
  while the link survives. The witness link is created only once, at first bootstrap of a genuinely
  new (empty) state directory. There is no automatic backfill for a store that lacks it: a missing
  witness link is indistinguishable from a store that was just attacked this way, so it fails closed
  identically to a mismatched one, with no owner-decision-free migration path. A missing, changed,
  copied, or replacement directory, or a sibling witness link that is absent or stops pointing at the
  current in-directory marker, produces a durable, read-only `HELD_DATA_UNVERIFIED` recovery facade
  rather than a fresh cycle. Bootstrap itself refuses to overwrite or delete a witness link that
  already exists and does not match the marker it just wrote (a crash-retry artifact or tampering,
  which it cannot tell apart); it raises a bootstrap error and preserves the orphan link for review
  instead.
- The backing durable store serializes cross-process writes with a private 0700
  `.store-lock/lease.sqlite` file and a SQLite `BEGIN EXCLUSIVE` transaction. Once it owns that
  lease, each acquisition creates `store.lock` with exclusive creation, records its PID and random
  token, syncs the file and directory, and verifies the same inode, PID, and token before removing
  its own fence. A clean release always removes its own `store.lock` fence before it commits and
  releases the SQLite lease, so a fresh acquirer unblocked by that release never observes (or races
  against) a fence file the departing owner is still in the middle of deleting; the SQLite lease
  covers the fence's entire lifetime, not just its creation. A clean release retains the 0600
  SQLite file. After a crash releases SQLite's operating-system lease, a new owner may remove a
  legacy fence only after it confirms the same inode and token and that the recorded PID no longer
  exists; a live or ambiguous PID remains lock contention.
- `recordHeldOwnerDecision(cycleId, { heldEvidenceDigest, requestId, expectedRevision, choice })`
  is a writer-only transition for `HELD_OWNER_DECISION`. `choice` is `sell` or `keep-holding`;
  the method is deliberately outside the read facade until a separately authorized control path
  consumes it.
- `recordHeldPositionIdentity(positionId, { mint, provenance, evidence })` records a verified
  identity for an unresolved null-mint held position. Replay and retries preserve the original
  position identity and revision, including after the original cycle terminates or completes.
  Recovery leaves the original terminal state and timestamp unchanged; the enrichment is accepted only when the open signature source
  (`held-evidence`, `open-evidence`, or `collector-finalized-send`), Collector pack-status mint,
  transaction-derived mint and asset kind (`spl` or `mpl-core`), and finalized custody provenance
  agree. Historical identity events without the two newer provenance fields remain readable as
  legacy records.
- `readHeldPositionEvidence(positionId)` returns the original held-position evidence retained by
  the journal projection, including signature or candidate-mint evidence when present; it is
  read-only and returns `null` for an unknown position.
- `persistSignOnlyPreSignBinding(cycleId, stage, requestDigest, binding)` and
  `readSignOnlyPreSignBinding(cycleId, stage, requestDigest)` manage the ADR-0025
  `hookemon.sign-only-pre-sign-binding.v1` record `signer-client.mjs`'s recovery-aware policy-sign
  facade persists before a verified owned Keychain broker's first sign-only invocation for a given
  chain attempt: exact unsigned wire bytes, signer role and account, the request and policy digests,
  and a decoded chain-validity-context digest. `persistSignOnlyPreSignBinding` requires that
  `(cycleId, stage, requestDigest)` already name a `PREPARED` chain attempt, is idempotent for a
  byte-identical replay, and refuses a changed field, a concurrent conflicting write, or a chain
  attempt that has moved past `PREPARED`.
- `reserveSignOnlyInvocation(cycleId, stage, requestDigest, ordinal)`,
  `recordSignOnlyInvocationTimeout(cycleId, stage, requestDigest, ordinal)`, and
  `readSignOnlyInvocationLedger(cycleId, stage, requestDigest)` manage the durable
  `hookemon.sign-only-invocation-ledger.v1` record that bounds the sign-only pre-sign binding's
  retry budget -- exactly two invocation ordinals ever exist for one binding. `reserveSignOnlyInvocation`
  is a one-shot reservation, never idempotent-on-match: ordinal 1 succeeds only when no ledger
  exists yet, ordinal 2 only when the ledger's current state is exactly `ORDINAL_1_TIMED_OUT`, and
  both re-verify the bound chain attempt is still `PREPARED` atomically at the moment of
  reservation, so a concurrent second caller racing for the same ordinal always refuses rather than
  also winning. `recordSignOnlyInvocationTimeout` is idempotent for the identical already-recorded
  outcome (recording a fact, not granting new permission) and otherwise requires the exact
  currently-allocated ordinal. A generic error, a proven pre-invocation denial, or a crash with no
  observed outcome after a reservation never calls `recordSignOnlyInvocationTimeout`, so the ledger
  simply never advances past `ORDINAL_{ordinal}_ALLOCATED` for that case -- permanently refusing any
  further ordinal for that binding, including after a restart.
- `readPayoutDust(cycleId, {chainId, assetId, decimals})` returns either the one unconsumed prior
  record as `{amount, source: {cycleId, digest, planDigest}}` or a zero amount with `source: null`.
  `recordPayoutDust` records positive successor dust, `consumePayoutDust` consumes its exact source,
  and `readPayoutDustConsumption` reconstructs a committed predecessor binding after restart.
- `readPagedPayoutState`, `persistPagedPayoutState`, and
  `consumePayoutDustAndPersistPagedPayoutState` publish recipient-keyed payout pages outside the
  bounded journal payload, then record only a compact page reference with predecessor-dust
  consumption. Page publication and the journal commit have a recoverable boundary rather than one
  filesystem transaction: if pages survive without their reference, the payout stage repeats the
  exact binding before a nonce read or signature. `consumePayoutDustAndRecordStageAttempt` remains
  available for non-paged compatibility callers.
- `reservePayoutQuarantine` and `readPayoutQuarantine` manage recipient liabilities keyed by plan
  digest and recipient. `requestPayoutQuarantineRetry` records an audited, idempotent retry
  request for a definitively refused native recipient; `recordPayoutQuarantineRetryRefusal`
  records a later finalized retry refusal without reserving liability again. `settlePayoutQuarantine`
  accepts only an authenticated direct native payment proof, atomically decrements the matching
  `payoutLiability`, and records the settlement. `listPayoutObligations` and
  `listOpenPayoutRetries` expose per-recipient obligations for operator status and automated retry.
  The open-retry reader also returns a retry whose quarantine journal is already resolved while
  its paged payout state is still unresolved, allowing the next lease-fenced tick to repair a
  crash gap between the journal and payout-state persistence.
  Settlement and refusal records retain the finalized payment, refusal, and retry projection
  evidence needed for that repair. Replay is idempotent: gas is keyed by transaction proof,
  liability is released at most once, and quarantine remains after a retry refusal.
  A cycle held as `HELD_OWNER_DECISION` for `PAYOUT_QUARANTINED_LIABILITY` may reserve the
  Operations nonce only while an unresolved quarantine retry is durable; other terminal states
  remain fenced.

## Invariants

- `createCycle`'s optional `admission` is validated by the policy engine's own
  `assertPolicyAdmission` (`assertDurableCycleAdmission`), so the stored record is exactly the
  normalized result that engine will later digest, including its required `processLiabilityEvidence`.
  A quote-bound admission missing that evidence is refused at `createCycle` and, for a record written
  before this requirement existed, at replay -- neither path accepts an evidence-free admission as
  equivalent to a covered one. The admission rides in `cycle-opened` itself and is immutable for the
  cycle's life; replay re-validates the stored record on every read, so a resumed cycle's evidence and
  policy digest reproduce unchanged.
- Provider attempts progress through `PREPARED -> NOT_SENT -> PREPARED` for a pre-call failure,
  `PREPARED -> SENT_UNKNOWN -> RESPONSE_RECORDED -> RECONCILED` for post-send ambiguity, or
  `PREPARED -> RESPONSE_RECORDED -> RECONCILED` for a recorded response. `SENT_UNKNOWN` is
  observation-only. Historical attempts without timestamps gain a persisted `deadlineAnchorMs`
  only on first deadline observation; the anchor event cannot alter the attempt or request digest.
  A completed stage with a provider attempt must use its matching reconciliation evidence.
- Chain attempts are keyed by `(cycleId, stage, requestDigest)`. They progress through
  `PREPARED`, `SIGNED`, `BROADCAST`, and `FINALIZED`; `SIGNED` stores raw bytes, one nonce or
  blockhash, and a hash. Later transitions cannot replace that material. Broadcast and finality
  each retain their own canonical observation evidence. `recordSignedTransactionWithRecoveryContext`
  binds the immutable bytes to policy, approval, approved-semantics, signed-message, and
  fencing-token digests in the same append before exact-byte Relay recovery can broadcast them.
- The general chain-attempt runtime is v1; the frozen v2 policy, fencing, refusal, and
  approval-digest fields are unavailable. Its ordinary `recordSignedTransaction` write does not
  gain those fields merely because a separate recovery context may later be attached. Direct-payout
  recipient pages retain signed bytes and approval context, but recovery derives authority only
  after rereading the matching authoritative paged repository state.
- A stage is prepared once. Retrying preparation returns its original journal head without adding a
  duplicate event. Operational completion requires that preparation and every earlier configured
  stage to be complete.
- A pre-call lease loss, signing denial, or policy refusal records `NOT_SENT` before its matching
  terminal hold. A completed stage with a provider attempt uses matching reconciliation evidence.
- A chain-specific Relay source or destination transaction identifier may attribute to one
  `RelayLegV1` across every cycle and direction. A leg is settled only with both finalized own-RPC
  observations and a
  destination attribution that binds the amount, time window, and memo or request ID.
  Chain 4663 transaction hashes must be 32-byte EVM hashes and are canonicalized to lower case;
  Solana signatures stay byte-exact. The durable reservation key includes the source or destination
  chain, so it does not apply EVM normalization to a Solana signature. Outbound settlement also
  reads the persisted route tuple and requires the own-RPC source proof to bind its sender and
  depository, an origin refund credit to bind that same depository as its Transfer sender, and the
  destination observation to bind its persisted destination owner.
  `settleRelayLeg` accepts only opaque runtime evidence capabilities issued by the RPC readers;
  it derives serializable finality, attribution, and the terminal result instead of accepting
  caller-supplied settlement facts. The permanent transaction-hash reservation is staged in the
  same durable commit as the corresponding journal event. Relay provider status is not a
  settlement input. A partial, refund, late, or wrong-asset observation records its corresponding
  terminal `HELD_RELAY_*` cycle state atomically with the leg.
- A first-use standing-authority decision checks expiry before it is stored. Its authority nonce is
  globally single-use, its day-cap slot is reserved atomically, and an exact replay returns the
  stored decision without consuming another slot.
- A positive dust record has one source journal digest. Consumption writes both a journal fact and
  a durable anti-replay record keyed by that source, so an archived source cannot enter two
  successor plans. A cycle records successor dust only after it has consumed any prior dust for the
  same asset.
- A quarantine reservation requires a pre-existing custody ledger with the exact chain, asset, and
  decimals. Its journal event carries the resulting ledger, and replay verifies that
  `payoutLiability` increases by exactly the reserved atomic amount while recorded returned custody
  remains sufficient.
- Wallet keys use lower-case EVM addresses. `WalletNonceReservationV1` is reserved in the durable
  global key store before a nonce read, asserted immediately before signing and broadcast, and
  released only by the owning cycle, fencing token, and lease window. A competing cycle cannot
  acquire the same `(chainId, wallet)` reservation until the held lease has expired, and its
  replacement must carry a later valid lease window. Normal release journals the state transition
  and compare-and-deletes the same global key; an already released record can self-heal only its
  exact stranded global value.
- Recipient pages contain the full immutable payout state while the journal retains a compact
  reference. Pages are keyed by recipient and split below the journal's array limit, so a
  1,025-recipient manifest round-trips without lowering the payout feasibility limit. A page-only
  publication is not signable until recovery records its matching compact reference and predecessor
  dust consumption.
- A cycle closes only after every configured operational stage is complete, all provider attempts
  reconcile, all chain attempts finalize, and no custody record retains held assets, payout
  liability, refunds, residual, dust, or unattributed value.
- The first custody record for `(cycleId, chainId, assetId)` fixes decimals. Writes and replay
  reject a later record that changes atomic units.
- CycleRecord stores immutable `production` or `rehearsal` mode. Finalized observed balances remain
  separate from obligations, unresolved principal is counted once, and unattributed external
  deposits pause new claims.
- A held-owner decision binds the cycle id, a digest of the original held evidence, request id,
  and the journal revision observed by the owner. An exact retry is idempotent; any changed
  request, revision, evidence digest, or choice conflicts. Replay validates the same binding.
- A sign-only pre-sign binding exists only while its chain attempt is `PREPARED` and is never
  mutated once written: `outbound` (EVM) and `return` (Solana) are the two stages whose live signer
  facade currently persists one, always before that attempt's first Keychain sign-only call. It
  durably fixes the exact unsigned bytes, role, account, and digests a bounded sign-only retry, and
  a restart that reaches the same call again, must reuse unchanged; it grants no broadcast authority
  and is unrelated to `persistChainAttemptRecoveryContext`, which binds already-*signed* bytes.
- The sign-only invocation ledger's retry budget is durable, not a property of one in-process call:
  it advances only `ORDINAL_1_ALLOCATED -> ORDINAL_1_TIMED_OUT -> ORDINAL_2_ALLOCATED ->
  ORDINAL_2_TIMED_OUT`, each transition re-verified atomically against the bound chain attempt's
  own `PREPARED` state, and a caller that reserves a specific ordinal is the only caller ever
  permitted to invoke Keychain for it -- a restart, a concurrent second wrapper, or the same process
  calling again all observe the identical durable ledger and refuse before Keychain once nothing
  remains eligible. No ordinal beyond 2 exists for one binding.

## State transitions

- Provider lifecycle: `PREPARED -> NOT_SENT -> PREPARED`,
  `PREPARED -> SENT_UNKNOWN -> RESPONSE_RECORDED -> RECONCILED`, or
  `PREPARED -> RESPONSE_RECORDED -> RECONCILED`.
- Implemented chain lifecycle: `PREPARED -> SIGNED -> BROADCAST -> FINALIZED`. The frozen v2
  lifecycle additionally permits a fenced `PREPARED -> REFUSED` transition.
- Relay lifecycle: `RECORDED` -> source hash attributed after durable signed bytes -> `SETTLED` or
  `HELD_RELAY_PARTIAL`, `HELD_RELAY_REFUND`, `HELD_RELAY_LATE`, or
  `HELD_RELAY_WRONG_ASSET`. Held Relay states are terminal cycle states.
- Standing-authority lifecycle: no decision -> wall-clock verification -> atomic decision, day-cap,
  and nonce reservation. An exact replay reads that decision; an expired first use is refused.
- Wallet nonce lifecycle: `HELD(fencingToken, lease window) -> RELEASED`. An expired held record
  may be replaced by a later valid fence; a conflicting owner, token, or lease never reaches a
  signer or broadcaster.
- Dust lifecycle: no prior record -> positive source record -> recoverable page publication ->
  compact successor reference plus consumption -> positive successor record when floor carry
  remains. A historical consume-only fact, or pages without their reference, recovers only with its
  exact original payout state; it cannot proceed to signature or make the predecessor dust
  available to the next cycle first.
- Quarantine lifecycle: verified recipient evidence plus a matching custody ledger -> durable
  liability reservation.
- Stage lifecycle: `PENDING -> PREPARED -> COMPLETE`; preparation is journal-idempotent.
- Cycle lifecycle: active -> held terminal state or fully closed -> archived.
- Owner-decision lifecycle: `HELD_OWNER_DECISION -> HELD_OWNER_DECISION + owner decision record`.
  Recording `sell` or `keep-holding` never resumes an effect on its own.
- Sign-only pre-sign binding lifecycle: no binding, chain attempt `PREPARED` -> durable binding ->
  (byte-identical rebind stays the same record; any other rebind, or a chain attempt that leaves
  `PREPARED`, is refused). It never transitions further on its own; the chain attempt's own
  `SIGNED`/`BROADCAST`/`FINALIZED` progression is unaffected and unrelated.
- Sign-only invocation ledger lifecycle: no ledger -> `ORDINAL_1_ALLOCATED` (only from no ledger,
  only while the chain attempt is `PREPARED`) -> `ORDINAL_1_TIMED_OUT` (only from an allocated
  ordinal 1) -> `ORDINAL_2_ALLOCATED` (only from an ordinal-1 timeout, only while still `PREPARED`)
  -> `ORDINAL_2_TIMED_OUT`, terminal. A generic error, a proven pre-invocation denial, or a crash
  after either allocation leaves the ledger exactly where it is -- no third ordinal, no
  reallocation of the same ordinal, and no path back to an earlier state ever exists.

## Operational commands

```sh
Use Node v24.19.0 (for example through nvm) before running the commands below.
node --test --test-timeout=120000 packages/adapters/test/app/cycle-repository.test.mjs
node --test --test-timeout=120000 packages/runner/test/cycle/money-schemas.test.mjs
```

## Recovery pointers

- Use the runbooks for [state-directory loss](../runbooks/repository-state-directory-loss.md), a
  [provider-call journal gap](../runbooks/provider-call-journal-crash.md), a
  [pre-call failure](../runbooks/provider-pre-call-failure.md),
  [lease expiry](../runbooks/lease-expiry-mid-mutation.md), or an
  [unattributed deposit](../runbooks/unattributed-deposit.md). Each recovery contract records the
  supported resume command or its absence.
- Read unresolved provider and chain attempts by their request digest before recovery. A pre-call
  `NOT_SENT` attempt may return to `PREPARED` only for the same request under the current wallet
  lease. Reauthorize a signed or broadcast attempt only when its persisted recovery context matches
  the exact raw bytes; otherwise leave it unresolved. Do not construct a new nonce, blockhash, or
  signature while an attempt remains unresolved.
- A timeout or lost response remains observation-only until reconciliation establishes an outcome.
- Keep a cycle held when custody attribution or finality cannot be proven. Do not close it by
  substituting another cycle's balance or evidence.
- For `HELD_OWNER_DECISION`, read `heldEvidenceDigest` and `version` from `describeCycle`, then
  retry only the exact durable decision tuple. The operator CLI and dashboard can record the
  choice, but no transaction path consumes it; custody remains held until an authorized recovery
  transition does so.
- Bind a predecessor dust source into the frozen payout plan, then call
  `consumePayoutDustAndPersistPagedPayoutState` before allocations can use it. If a crash leaves
  page data without its compact journal reference, replay that same call with the same source and
  plan before signing or starting the next cycle. Record only positive successor dust after terminal
  conservation.
- Reserve a frozen or cancelled recipient through `reservePayoutQuarantine` only after durable
  evidence establishes that its amount cannot become a normal final payment. A missing custody
  ledger is not a substitute for backing.
- Acquire and assert `WalletNonceReservationV1` immediately before every Operations signature and
  broadcast, using the signed attempt's fencing token and the active stage lease window. A stale or
  expired reservation stops the caller before it reaches the signer. Release only the exact global
  reservation during matching terminal reconciliation; a stale release cannot erase a newer fence.
- Durable `FINALIZED` evidence for a Relay source transaction is that source wallet's matching
  terminal reconciliation. It releases only the source reservation while its Relay leg remains
  unsettled until separate destination attribution is recorded.
- For a Relay leg, retain the complete leg, both own-RPC finality observations, and the destination
  attribution. If the observation is partial, refunded, late, or for another asset, preserve the
  matching terminal hold and do not retry or pay out. Runtime evidence capabilities are not
  journal records; a return proof is accepted only while its full observed value still matches the
  process-RPC capability. After restart, read fresh finalized evidence through the process RPC
  clients rather than reconstructing a settlement payload.
- A recovery context that is absent, changed, or bound to different bytes leaves the chain attempt
  unresolved. Recovery never manufactures a replacement signature.
- A sign-only pre-sign binding is read, never regenerated, on restart: if one already exists for a
  `PREPARED` `outbound`/`return` chain attempt, the live signer facade's next attempt must reproduce
  the exact same bytes/role/account/digests or it is refused before Keychain is invoked. See
  [keychain sign-only timeout](../runbooks/keychain-user-interaction.md) for the bounded-retry
  contract this binding backs.
- The sign-only invocation ledger, not local retry logic, is the source of truth for how many
  Keychain calls remain for a binding. On restart, `readSignOnlyInvocationLedger` before deciding
  anything: no ledger means ordinal 1 is still available, `ORDINAL_1_TIMED_OUT` means exactly
  ordinal 2 remains, and any other state (including a crash-ambiguous `ORDINAL_1_ALLOCATED` with no
  recorded outcome) means nothing remains -- `reserveSignOnlyInvocation` enforces this atomically
  and refuses before Keychain regardless of what a caller assumes locally.
- If the sibling identity, in-directory device-and-inode witness, or sibling identity-witness hard
  link is absent or changed, use the durable recovery facade instead of recreating the directory.
  There is no supported way to mint or restore a missing witness link for an existing store; doing
  so would just re-derive trust from the checks the link exists to cover for. It records the loss
  reason and refuses `createCycle` and stage preparation until an owner reviews restored journal and
  custody evidence.
- On durable-store lock contention, do not delete `.store-lock/lease.sqlite`, its rollback journal,
  or `store.lock`. A retained `lease.sqlite` file alone is expected after a clean release. Reopen
  after a crashed writer's SQLite operating-system lease has released: the store reclaims only an
  unchanged fence whose recorded PID is absent. A live PID, an inaccessible PID, or changed fence
  metadata remains contention and requires owner review rather than manual deletion.

## Native held-cost and custody records

New held NFT evidence uses `hookemon.held-position-evidence.v2` with `costMicroUsd` and
`valueMicroUsd`. Both equal the committed admission's aggregate USD purchase cost; the existing
conservative per-position attribution remains, including when several cards share a cycle.
Insured amounts are informational. These position records retain count and USD risk without
writing USD micro-units into an ETH principal bucket. The native held writer therefore omits the
optional asset-ledger association. A missing committed USD basis refuses the held write.
Historical v1 evidence keeps its original fields and digest; it cannot authorize native risk.

Native custody rows use v3 at `4663/native/18`. Their typed gas costs never decrease, their
verified balance cannot disappear or move backward, and a prior historical row cannot be
reinterpreted at that key. Stored v2 policy admissions use the dedicated historical decoder;
new admissions use the strict native v3 validator.

Native policy custody exposes `cycleExposureMicroUsd` for reservation reconciliation. Native
amounts require fresh exact-amount Relay USD valuation capabilities with upward rounding; missing,
stale or serialized valuation objects make exposure unvalued and prevent new risk. Gas reserve and
spent gas remain separate wei fields. Held positions contribute their original USD purchase cost
and count even when they have no native principal ledger association.

Native custody records gas costs as append-only `gasPayments` entries containing a unique
transaction hash and canonical `amountWei`. Their exact sum equals typed `gasSpent`.
`applyNativeCustodyGasPayment` accepts a process-authenticated payment proof and returns the same
fields on replay of that hash and cost. A changed cost, removed entry or duplicate hash refuses.

Native supplementary return boundaries require the persisted signed source and a process-authenticated destination payment. A single journal event consumes the destination transaction globally and credits the existing native custody row. The row retains its gas reservation and payment history; a missing native row refuses settlement. Historical v1 supplementary evidence retains its original decoder and cannot resume native execution.

A finalized reverted claim or outbound deposit records its signed-transaction gas proof before recovery reports the failure. Repeated reconciliation preserves the unique gas entry and every principal bucket; failed transactions never grant payment authority.

Native admission creation requires original Relay USD producer capabilities. Its immutable opening event records `nativeAdmissionProvenance` v1: cycle identity, current mutation authority, admission digest, and exact request/response and valuation digests for both quotes. Repository replay can issue private in-process valuation references only under the same authority and original expiry. Ordinary JSON, caller paths, and records without provenance cannot authorize new risk. This boundary trusts the configured durable repository; its journal integrity is not external provider attestation.

Native return attribution v2 freezes a downward-rounded `destinationUsd` and its exact request, raw response digest, valuation digest, and quote before source effects. Creating the native return expectation requires its original producer capability; replay validates the retained evidence. Completed USD loss uses original committed admission cost minus exact settled proceeds observed inside that original valuation window. Missing, expired, or mismatched realized proceeds remain unvalued and prohibit new risk; current ETH pricing never revises completed loss.

A supplementary return atomically reserves both source and destination transaction identities in the shared Relay namespace, plus its order identity. A second position cannot consume one signed source through a different destination event.

Supplementary return preparation accepts USD proceeds only from the original fresh producer capability and binds the paged attempt to its position manifest. Source bytes become immutable when present; source identity, quote, and USD evidence cannot change on later writes. The authenticated return boundary stores exact timely realized proceeds in the same journal event as native credit. `supplementaryRealizedProceedsUsd` exposes that frozen value for completed-loss accounting; absent or expired valuation leaves the credited principal unvalued for new-risk policy.

Return preparation preserves the original immutable quote valuation capability alongside its canonical request bytes. The durable request digest binds those bytes; a JSON copy cannot regain producer authority and requires fresh authenticated quote evidence before settlement expectations are written.

Outbound signed recovery checkpoints preserve the Relay v2 internal `native` asset identity only for chain 4663 with 18 decimals and a bound trade type/quote digest. Other EVM assets and the sender still require addresses; historical incomplete intent decoding grants no native identity. A refused identity leaves the attempt PREPARED, while an accepted checkpoint preserves signed bytes and the exact intent across reopen. Focused check: `node --test packages/adapters/test/native/outbound-recovery-checkpoint.test.mjs`.

Blockhash-based signed material uses canonical base64 with at most 1,232 decoded wire bytes (1,644 encoded characters). It is validated before persistence and on replay. This permits complete Solana messages while refusing oversized or noncanonical encodings; nonce-based EVM material and unrelated string limits retain their existing bounds.

Native outbound settlement compares the stored v2 leg with the Relay producer's internal `native` origin identity. Zero-address conversion belongs to EVM calldata and provider wire formats, not the durable intent comparison. The signed-source/refund regression obtains its intent from `prepareExecution` and retains settlement and duplicate-after-reopen checks.

Plan-backed native cycles use admission v4 and provenance v2. The admission's exact plan must equal the atomic `packPlanSnapshot.plan`; all unit and aggregate valuation producer evidence is validated on creation and restored from separately checked journal provenance on replay. Outbound expiry evidence v2 binds an ordered list of unit quote identities and the aggregate; a replacement preserves the plan, every unit purchase target and the released principal.

`recordPackOrderIntent(cycleId, orderIndex, intent, requestDigest)` and `recordPackOrderRequest(cycleId, orderIndex, packs)` persist generation separately for every admitted order. Intent records bind the admission digest and immutable parent request digest before any provider call. Response records bind exact quantities, pack types, card counts and global pack indices, with memos unique across the cycle. Identical retries are idempotent; conflicts and response-without-intent refuse. Reads expose per-order state and a combined purchase batch with `generationComplete`; completing purchase requires reconciliation of every admitted order. `recordPackOrderReconciliation(cycleId, orderIndex, outcomes)` records complete terminal outcomes bound to the exact admission and generated response. Replay validates memo identities and each purchased debit against its own unit bound. `readPackOrderReconciliation` supplies the durable prefix recovery authority; partial reconciliation never completes the parent stage. Legacy batch events cannot mutate v4 cycles.

New selected cycles atomically persist a cycle-bound `hookemon.reward-selection-snapshot.v1` in `cycle-opened`. The snapshot freezes the operator configuration revision and recipient limit. Creation, replay and eligibility-stage completion validate the policy and its matching v2 manifest. Historical events without selection retain all-holder behavior and unchanged journal bytes. Read APIs expose the frozen policy; no setter can replace it. Large eligibility evidence uses the existing paged store and is validated after resolution.

The managed claim path uses the durable [Process USD budget](process-usd-budget.md). `processClaimLimit6hMicroUsd` defaults to USD25,000, accepts zero, and is owner-adjustable up to USD50,000; it does not replace the other spend controls.
