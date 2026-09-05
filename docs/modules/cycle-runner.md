# Cycle Runner

## Purpose

The cycle-runner module executes one policy-controlled Operations-wallet cycle against the
authoritative `CycleRepository`. It coordinates work but does not own a signer, a second money
store, or independent authority to move assets.

`CycleRunner` remains the domain evidence engine. The unattended operational path uses
`packages/runner/src/cycle/money-schemas.mjs` and the adapter-owned `CycleRepository` as its
durable authority; it does not construct a separate `CycleRunner` journal in `compose.mjs`.
`createCycleRepositoryRunner` exposes a frozen, read-only cycle client over that same repository
for the scheduler, CLI, and dashboard. Its repository facade contains only the published client
interface, never the repository's writer methods.

`money-schemas.mjs` defines the implemented shared operational contract:

- current exported stage order: `eligibility-snapshot`, `claim-process`, `outbound`, `purchase`,
  `open`, `epic-gate`, `buyback`, `return`, `payout`;
- typed atomic amounts `{chainId, assetId, decimals, amountAtomic}`;
- provider attempts `PREPARED -> NOT_SENT -> PREPARED`,
  `PREPARED -> SENT_UNKNOWN -> RESPONSE_RECORDED -> RECONCILED`, or
  `PREPARED -> RESPONSE_RECORDED -> RECONCILED`; and chain attempts
  `PREPARED(requestDigest) -> SIGNED(rawBytes, nonce or blockhash, hash) -> BROADCAST -> FINALIZED`;
- whole-cycle terminal `HELD_*` states for non-card lifecycle failures that cannot safely progress,
  alongside completed and failed states; card-stage holds use held positions instead; and
- custody-ledger entries keyed by cycle, chain, and asset, with atomic buckets for claims, bridge
  legs, pack cost, proceeds, returns, refunds, residual, held assets, held positions, payout
  liability, dust, and unattributed value. The first record for a key fixes its decimal value;
  replay rejects a later record that changes atomic units.

The general chain-attempt runtime is v1; the frozen v2 policy, fencing, refusal,
and approval-digest fields are unavailable. Built-in outbound and return retain their
recovery authority with the repository's combined Relay signing record. Provider pre-call recovery
is implemented through `PREPARED -> NOT_SENT -> PREPARED` for the same request.

For ordinary provider stages, the operational stage driver constructs a canonical provider request
from frozen data-only input, then writes its digest in `PREPARED` before a capability reaches a
provider or signer. It passes the same request to the mutation with lease-fenced capability views,
but only a later reconciliation supplies evidence that `AutomatedCycleService` can commit as a
completed stage. A lost response therefore remains `SENT_UNKNOWN` and is never retried as a new
provider mutation. For `open`, `epic-gate`, and `buyback`, a `SENT_UNKNOWN` attempt past the
  operator-controlled deadline becomes a position-bound held record instead of a whole-cycle hold;
  it is never resent. Pending purchase, open, epic-gate, and buyback handlers stop at that prepared
  record; dry-run refuses to probe past an unresolved live attempt.

The repository can record a later `SOLD`, `REFUNDED`, or `NEVER_SENT` resolution from evidence, but
the production runner does not yet obtain an observation-only provider result for an overdue held
position or start its supplementary intent automatically. It retains the position until that path
exists.

Live reconciliation receives a separate lease-fenced read-adapter seam and a read-only repository
facade. Chain-journal reconciliation for claim, outbound, and return is the narrow exception: after
canonical observation it may write only the relevant broadcast, finality, custody, Relay settlement,
recovery-context, and wallet-nonce-release transitions. A pre-call failure records retryable
`NOT_SENT`; only the same request may return to `PREPARED` under the current lease. Only an error
after an adapter capability call can become observation-only `SENT_UNKNOWN`.

Claim processing, outbound, and return are chain-journal stages. Claim persists `PREPARED`,
immutable signed bytes, broadcast evidence, and canonical finality in sequence. Outbound and return
also retain a Relay leg and return canonical settlement evidence on a `SETTLED` replay, allowing the
service to complete the stage. Their reconciler receives no signer or provider-send capability. A
signer refusal before an adapter provider invocation leaves the chain attempt at `PREPARED`.

The eligibility snapshot does not use the provider-attempt path. Its built-in live reconciliation
selects `latest - K` only after a fresh finalized-head read proves the candidate finalized, requires
matching pinned Transfer-log replays from distinct primary and secondary clients, and returns the
canonical pre-claim evidence directly. `execute()` rejects this stage as read-only and no provider
attempt is created.

## Public interface

- The current ordered stage surface is `eligibility-snapshot`, `claim-process`, `outbound`,
  `purchase`, `open`, `epic-gate`, `buyback`, `return`, and `payout`.
- A repository runner exposes `readStage(stage)`, `readOperationalStageAttempt(stage)`,
  `readChainTransactionAttempt(stage, requestDigest)`, `readHeldPosition(positionId)`,
  `listHeldPositions()`, `readSupplementarySettlement(positionId)`, and `describe()` through a
  frozen repository client. Chain attempts retain one immutable signed transaction and distinct
  broadcast/finality evidence per request digest.
- Every stage receives a cycle identifier, typed amounts, policy decision, and `CycleRepository`
  transaction boundary.
- The runner persists `production` or `rehearsal` mode at cycle creation; it never changes and each
  service refuses the other mode. Rehearsal retains bounded cycle count, cap, restart injection,
  and evidence output.
- A production-profile dry run persists `dryRun: true` with its fake provider profile. It follows
  the production stage order but never constructs or invokes a signer, broadcast, or provider
  mutation. `hookemon-runner dry-run --mode production` selects this profile explicitly.
- The production runner remains provisional until provider, feasibility, and live-readiness
  evidence meet the `launchEligible` gate.
- `createProductionEvidenceProfile` requires an explicitly supplied read-only preflight authority;
  it does not load the active mutation authority while constructing or verifying evidence.
  `createTestProductionEvidenceProfile` is the retained-authority simulation used by deterministic
  tests.
- `createStandingAuthorityProvider` verifies an owner-signed authority document against its owner
  and policy public keys. `verifyAndRecordStepAuthorization` checks wall-clock expiry at first use,
  then persists `StandingAuthorityDecisionV1` through the repository before a production signing
  boundary can reach a raw signer.
- `createStandingAuthorityStepAuthorizationResolver` selects only exact policy-signed intents from
  the private, canonical state-directory authority artifact bound to the verified document digest.

## Invariants

- Stages cannot skip, reorder, or advance while their repository journal is unresolved.
- The runner uses only `{chainId, assetId, decimals, amountAtomic}` amounts and keeps chain 4663
  USDG separate from Solana stablecoins.
- Only a finalized, cycle-attributed return delta can form a payout basis.
- A held card is a position `{positionId, cycleId, packId, memo, mint, cardRef, costMicroUsdg,
  insuredValue, reason, terminalState, evidenceDigest, openedAtMs, ownerDecision, resolution}`.
  Its USDG control value is the verified insured amount only when that amount is already USDG;
  otherwise it is the card's attributed purchase cost. No stablecoin conversion is inferred or
  permitted without a frozen quote binding.
- The insured-value hold threshold applies only to the existing documented epic tier
  (`prizeTier === '1'`): `offerAtomic * 100 < insuredValueAtomic * 40` holds and equality follows
  the sell path. Other documented tiers do not enter that threshold branch.
- Main-cycle return and payout exclude held-position proceeds. A cycle with only held positions
  completes its return and payout with zero proceeds and a zero payout manifest; open positions
  remain visible to the policy limit and dashboard after main-cycle completion. `COMPLETED` does
  not archive a record with open positions: scheduler admission skips it, but it remains one active
  DurableCycleStore entry until every position resolves.
- A return delta is attributed to payout only when `ReturnLegDestinationProofV1` records an
  authenticated terminal Relay pointer, source and destination finality from this process, the
  exact USDG Transfer to Operations, a timestamp inside the settlement window, and globally unique
  source and destination hashes. Other finalized transfer observations enter their named hold.
- `MoneyConfigurationV1` is the authoritative frozen input for money preflight and signer paths.
  Its return minimum must be exactly zero. Claim checks both EIP-1559 fee fields and the post-fee
  native reserve; return, purchase, and buyback check the configured Solana asset, priority-fee cap,
  and post-fee lamport reserve before signing.
- Before signing a purchase, the runner persists typed `unitPriceAtomic`, `totalAtomic`, and
  `boundedOverheadAtomic` plus integer-string quantity; policy checks the product and reserves total
  plus overhead. Finalized observed balances remain separate from obligations, and unresolved
  principal is counted once.
- The runner requests signatures only through transaction-policy and performs no signing in Node.
- Fixture and test profiles use the retained binding record for deterministic verification only.
  They accept its historical version-1 shape or the version-2 shape with a Phase 3 supplement while
  requiring the same top-level revision-54, architecture-revision-3 build-only record.
  `requireLiveMutationAuthority` reads the active interface authority at each live external-effect
  boundary and refuses a provisional or digestless authority before signing, broadcasting, or a
  provider mutation.
- Loading a runner module, constructing a fixture profile, probing, and read-only reconciliation do
  not read the live mutation authority.
- A read-only production preflight authority validates evidence only. It is not a signing or
  mutation capability; those boundaries independently read the active authority immediately before
  their external effect.
- A first-use standing-authority decision contains its authority digest, verification time, intent
  digest, day-cap reservation, and nonce reservation. The repository reserves both capacity keys
  atomically. An exact replay returns the stored decision before checking expiry, so it cannot
  reserve a second daily slot or nonce.

## State transitions

- A verified eligibility snapshot is durably completed before `claim-process` can be prepared.
- Each stage advances only after policy approval, journal finality, and custody reconciliation.
- A held card completes its own stage as held and does not prevent later main-cycle settlement or a
  later cycle. Unattributed inbound value, a failed eligibility snapshot, a missing predecessor
  evidence chain, a pause, kill switch, or an unresolved journal still prevents the affected
  irreversible action.
- A position-bound `sell` decision starts a supplementary settlement identity with the original
  frozen eligibility-snapshot evidence digest and a new `<cycleId>:supplementary:<n>` manifest.
  `RETURN_BROADCAST` then freezes the attributed USDG return and zero/null supplementary dust
  setting. Any later buyback, return, and payout integration must retain those bindings, the
  original cycle's custody attribution, and write-ahead recovery states. A nonzero normal-cycle
  dust record needs a separate position-aware atomic consumption transition before use.
- A completed `payout` stage closes the cycle only after recipient records reconcile.
- `recoverActiveCycle()` may return `SUPPLEMENTARY_SETTLEMENT` for a sell decision after the main
  cycle is `COMPLETED`. It advances only that durable position settlement and does not reopen the
  main stage sequence or create a new cycle.
- A standing-authority attempt verifies wall-clock expiry before its first reservation and persists
  the decision before signing. An exact replay uses that stored decision, including after the
  authority expires; an expired first use records no decision and reaches no signer.

## Operational commands

- Run rehearsal through the same stage order and policy checks as production.
- Reconcile the `CycleRepository` before resuming an interrupted cycle.
- Evaluate `launchEligible` separately from code readiness before any live execution.

## Recovery pointers

- Resume from the journaled stage and exact transaction bytes, never from an inferred balance.
  Generic v1 live rebroadcast remains unavailable because it does not persist the frozen v2 approval
  digest. Outbound and return use their combined Relay recovery record for exact-byte recovery;
  direct payout uses its self-contained signed recipient record.
- Keep an uncertain provider or chain action in its recorded unresolved state until observation
  proves the outcome.
- Reconcile a held position by its immutable evidence digest and position revision. `keep-holding`
  is repeatable. A `sell` decision preserves the manifest-scoped supplementary boundary state; it
  never recomputes the original eligibility snapshot, substitutes the return source or fixed
  zero/null dust setting, or creates a broadcast transfer by itself. Use `resume-cycle` to recover
  its existing settlement; its result identifies supplementary recovery rather than a resumed main
  cycle.
- A completed record with open positions still consumes DurableCycleStore capacity even though the
  scheduler does not select it as the active cycle. Keep `maxHeldPositions` at its default 10 or
  lower until position archival or a capacity exemption has a recovery contract and admission test.
- OPEN FACT: Late held-position resolution is durable and repository-tested, but the runner has no
  production observation-only provider reconciler or automatic supplementary-intent handoff.
  Resolve it by wiring a lease-fenced read adapter to evidence-bound `SOLD`, `REFUNDED`, and
  `NEVER_SENT` transitions, then test restart recovery. Verified safe alternative: retain the
  position; do not resend the provider mutation.
- Pause new claims when an inbound amount lacks cycle attribution.
- Do not create a first-use authorization after its standing authority expires. Obtain a fresh owner
  decision. A decision recorded before expiry may replay only through
  `verifyAndRecordStepAuthorization`, which reuses its exact durable reservations rather than
  calling the synchronous verifier at a signing boundary.
