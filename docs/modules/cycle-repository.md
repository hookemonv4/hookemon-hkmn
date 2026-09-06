# Cycle Repository

## Purpose

The cycle-repository module is the durable authority for operational cycle progress, provider and
chain attempts, Relay legs, standing-authority decisions, wallet nonce reservations, custody
buckets, payout carry records, terminal holds, and recovery facts. Automation owns its writer;
dashboard, CLI, and runner callers receive a frozen read client rather than a second state path.

## Public interface

- `CYCLE_REPOSITORY_CLIENT_INTERFACE` exposes `readActiveCycle`, `peekActiveCycle`, `readStage`,
  `describeCycle`, `readOperationalStageAttempt`,
  `readChainTransactionAttempt(cycleId, stage, requestDigest)`, `readClaimPreconditions`,
  `readHeldPosition`, `listHeldPositions`, `readSupplementarySettlement`, and `listKnownCycleIds`.
  `peekActiveCycle` observes the active slot without performing the archival repair that
  `readActiveCycle` may perform.
- `CYCLE_REPOSITORY_INTERFACE` adds `createCycle`, `prepareStage`, `completeStage`,
  `completeCycle`, `holdCycle`, provider-attempt writes, chain-attempt writes, Relay settlement,
  standing-authority decisions, held-position and supplementary-settlement writes, wallet nonce
  reservations, paged payout state, and custody writes.
- `readHeldPosition(positionId)`, `listHeldPositions({cycleId, includeResolved})`, and
  `readSupplementarySettlement(positionId)` expose durable per-card held positions and their
  settlement preparation through the read client. `recordHeldPosition(cycleId, input)` records the
  card's original cycle, pack, memo, nullable mint, card reference, attributed USDG cost and
  control value, typed insured value when verified, reason, terminal class, and evidence digest
  without changing the cycle terminal state. `resolveHeldPosition(positionId, input)` closes an
  open position as `SOLD`, `REFUNDED`, or `NEVER_SENT` with evidence bound to the held digest and
  position revision.
- Provider writes are `prepareStageAttempt`, `markStageAttemptNotSent`,
  `markStageAttemptSentUnknown`, `recordStageAttemptResponse`, and
  `reconcileStageAttempt`. `markStageAttemptNotSent` preserves the request digest without effect
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
  identity and an in-directory device-and-inode witness before opening the journal. A missing,
  changed, copied, or replacement directory produces a durable, read-only
  `HELD_DATA_UNVERIFIED` recovery facade rather than a fresh cycle.
- The backing durable store serializes cross-process writes with a private 0700
  `.store-lock/lease.sqlite` file and a SQLite `BEGIN EXCLUSIVE` transaction. Once it owns that
  lease, each acquisition creates `store.lock` with exclusive creation, records its PID and random
  token, syncs the file and directory, and verifies the same inode, PID, and token before removing
  its own fence. A clean release retains the 0600 SQLite file. After a crash releases SQLite's
  operating-system lease, a new owner may remove a legacy fence only after it confirms the same
  inode and token and that the recorded PID no longer exists; a live or ambiguous PID remains
  lock contention.
- `recordHeldOwnerDecision(positionId, { heldEvidenceDigest, requestId, expectedRevision, choice })`
  is a writer-only, position-bound transition. `choice` is `sell` or `keep-holding`; its evidence
  digest and revision must match the exact held position. `sell` prepares one supplementary
  settlement with manifest id `<cycleId>:supplementary:<n>`, the digest of that cycle's completed
  `eligibility-snapshot` evidence, and no payout source yet; `keep-holding` leaves the position
  open. A sell decision is refused without the original completed snapshot. The method remains
  outside the read facade until an authorized control path consumes it.
- `advanceSupplementarySettlement(positionId, { expectedState, nextState, evidence })` appends one
  immutable boundary for that prepared settlement. Its only sequence is `PREPARED ->
  BUYBACK_SENT_UNKNOWN -> RETURN_BROADCAST -> PAYOUT_BROADCAST -> COMPLETE`; matching retries
  require the same state and evidence and never replace the manifest id. The
  `RETURN_BROADCAST` evidence must be the position-, cycle-, and manifest-bound finalized-return
  record. The repository derives and persists its USDG return, return binding, and zero-amount
  supplementary dust setting as one `payoutSourceDigest`; callers cannot supply an alternate
  payout source. A nonzero original-cycle dust record cannot enter supplementary settlement until
  a position-aware atomic consumption transition exists.
- `CycleRepository.readSupplementarySettlementEvidence(positionId)` is a full-repository-only
  recovery method. It returns the latest `{state, evidenceDigest, evidence}` record for an existing
  supplementary boundary. The frozen client facade deliberately omits it because that evidence can
  contain provider or transaction facts.
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
  digest and recipient.

## Invariants

- Provider attempts progress through `PREPARED -> NOT_SENT -> PREPARED` for a pre-call failure,
  `PREPARED -> SENT_UNKNOWN -> RESPONSE_RECORDED -> RECONCILED` for post-send ambiguity, or
  `PREPARED -> RESPONSE_RECORDED -> RECONCILED` for a recorded response. `SENT_UNKNOWN` is
  observation-only. A completed stage with a provider attempt must use its matching reconciliation
  evidence.
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
- A pre-call lease loss, signing denial, or policy refusal records `NOT_SENT` for the same durable
  request. These recoverable failures do not become a whole-cycle hold. A completed stage with a
  provider attempt uses matching reconciliation evidence.
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
- A held position is append-only, identity-bound to its original cycle and evidence digest, and
  retries with the same identity-bound evidence reuse the original `openedAtMs` record rather than
  creating another position. When a position supplies an exact configured six-decimal USDG ledger
  asset, its `valueMicroUsdg` is added atomically to that cycle's `heldPositions` custody bucket in
  the same journal event. A verified insured value contributes only when it already uses that exact
  USDG asset; a Solana insured value remains typed evidence and uses the attributed purchase cost
  as its USDG control value.
- The settled main cycle reaches `COMPLETED` only after every configured operational stage is
  complete, all provider attempts reconcile, all chain attempts finalize, and no settled-custody
  record retains held assets, payout liability, refunds, residual, dust, or unattributed value.
  Open `heldPositions` do not prevent `COMPLETED` because they are excluded from the settled main
  proceeds. `COMPLETED` is not archival: the record remains available for position recovery until
  its open positions resolve. `readActiveCycle()` skips it for scheduling admission, but the
  completed record remains one active DurableCycleStore entry until archival follows resolution.
- The first custody record for `(cycleId, chainId, assetId)` fixes decimals. Writes and replay
  reject a later record that changes atomic units.
- CycleRecord stores immutable `production` or `rehearsal` mode. Finalized observed balances remain
  separate from obligations, unresolved principal is counted once, and unattributed external
  deposits pause new claims.
- A held-owner decision binds a position id, a digest of the original held evidence, request id,
  and the position revision observed by the owner. An exact retry is idempotent; a repeated
  `keep-holding` has no effect, while a changed request, revision, evidence digest, or choice
  conflicts. A `sell` decision writes the position's next supplementary manifest identity and the
  original completed eligibility-snapshot evidence digest in the same durable transition. Replay
  validates the same binding.
- A supplementary payout can use only the settlement's original snapshot digest and the
  repository-derived `payoutSourceDigest`. The latter binds the finalized position return, its
  Operations/USDG return binding, and a zero-amount dust value with no source. The immutable
  return-boundary evidence and matching source are retained for restart; a newer snapshot, return,
  or dust setting conflicts before a recipient state can persist. A normal-cycle dust source stays
  unavailable to supplementary settlement until an atomic, position-aware consumption transition
  binds it.
- A held-position resolution binds the original held evidence digest, current position revision,
  terminal outcome, and reconciliation evidence. Resolution removes only that position's control
  value from its original cycle's `heldPositions` bucket; it never reallocates proceeds to another
  cycle.
- Whole-cycle holds remain only for cycle-wide custody, evidence, or safety conditions: unattributed
  deposits, missing predecessor evidence, eligibility-snapshot failure, a paused or frozen USDG
  canary (`HELD_UNAVAILABLE`), and a backed payout quarantine liability
  (`HELD_OWNER_DECISION`). An attributable held card never changes a settled card's return or payout
  path.

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
- Held-position lifecycle: attributable card evidence -> `held-position-recorded` with the
  matching USDG custody bucket -> optional position-bound `keep-holding` or `sell` decision. A
  sell decision creates `PREPARED` supplementary settlement state, which advances only through
  `BUYBACK_SENT_UNKNOWN`, `RETURN_BROADCAST`, `PAYOUT_BROADCAST`, and `COMPLETE` with bound
  evidence. `RETURN_BROADCAST` derives and freezes the payout source; recipient recovery later
  requires that source and the stored original snapshot digest. Reconciliation can append one
  `SOLD`, `REFUNDED`, or `NEVER_SENT` resolution and remove the position from the limit bucket.
  The surrounding cycle remains active and can complete its settled stages.
- Cycle lifecycle: active -> whole-cycle held terminal state for a cycle-level custody, evidence,
  USDG-canary, or payout-quarantine condition, or `COMPLETED`. A completed record with open held
  positions is skipped by scheduler admission but remains an active DurableCycleStore entry for
  supplementary recovery; it archives after its held positions resolve.
- Owner-decision lifecycle: `open position -> keep-holding` (idempotent) or `sell` bound to the
  same position evidence and revision. Recording the choice persists intent only; the later
  supplementary integration must own any provider mutation and reuse its durable attempts after
  restart. The repository boundary record itself does not invoke a provider or broadcaster.

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
- Keep a whole cycle held when custody attribution or finality cannot be proven, a USDG canary is
  paused or frozen, or a payout quarantine liability remains backed. Do not close it by substituting
  another cycle's balance or evidence. For an attributable card, record or read its held position
  instead; the settled portion of that original cycle remains independent.
- For a held position, read its `positionId`, `evidenceDigest`, and `positionRevision`, then retry
  only the exact durable decision tuple. `keep-holding` remains counted in the custody limit.
  A `sell` decision prepares the position's supplementary settlement; resume its durable
  `BUYBACK_SENT_UNKNOWN`, `RETURN_BROADCAST`, or `PAYOUT_BROADCAST` boundary from the recorded
  state and full-repository recovery evidence instead of creating a replacement request or
  manifest. Before an associated payout persists, verify the settlement's original snapshot digest,
  repository-derived return source, and zero-amount dust setting against the retained return
  boundary.
  Reconciliation closes a `SENT_UNKNOWN` position only as `SOLD`, `REFUNDED`, or `NEVER_SENT` with
  evidence bound to that position.
- OPEN FACT: The repository can durably resolve an overdue held position from observation evidence,
  and its repository tests cover `SOLD`, `REFUNDED`, and `NEVER_SENT`; no production service yet
  obtains that observation from a provider or automatically starts the resulting supplementary
  intent. Resolve it by adding a lease-fenced, observation-only provider reconciler and a
  position-bound handoff to the existing supplementary settlement path, with restart tests.
  Verified safe alternative: retain the position and its evidence until an operator supplies a
  reconciled outcome; do not send another provider mutation.
- Bind a predecessor dust source into the frozen payout plan, then call
  `consumePayoutDustAndPersistPagedPayoutState` before allocations can use it. If a crash leaves
  page data without its compact journal reference, replay that same call with the same source and
  plan before signing or starting the next cycle. Record only positive successor dust after terminal
  conservation.
- OPEN FACT: A completed cycle with open positions remains an active DurableCycleStore entry, and
  the store has capacity for 16 entries. The default `maxHeldPositions: 10` remains capacity-safe
  when positions span completed cycles, but values above 10 have no verified new-cycle capacity
  guarantee and values at or above 16 can exhaust the store. Resolve this by adding
  post-completion position archival with recoverable supplementary evidence, or a store-capacity
  exemption, and test new-cycle admission across the configured position cap. Verified safe
  alternative: keep `maxHeldPositions` at 10 or lower until that transition exists.
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
- If the sibling identity or in-directory device-and-inode witness is absent or changed, use the
  durable recovery facade instead of recreating the directory. It records the loss reason and
  refuses `createCycle` and stage preparation until an owner reviews restored journal and custody
  evidence.
- On durable-store lock contention, do not delete `.store-lock/lease.sqlite`, its rollback journal,
  or `store.lock`. A retained `lease.sqlite` file alone is expected after a clean release. Reopen
  after a crashed writer's SQLite operating-system lease has released: the store reclaims only an
  unchanged fence whose recorded PID is absent. A live PID, an inaccessible PID, or changed fence
  metadata remains contention and requires owner review rather than manual deletion.
