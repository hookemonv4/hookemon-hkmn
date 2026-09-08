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
- terminal `HELD_DATA_UNVERIFIED`, `HELD_UNAVAILABLE`, and `HELD_OWNER_DECISION` states alongside
  completed and failed states; and
- custody-ledger entries keyed by cycle, chain, and asset, with atomic buckets for claims, bridge
  legs, pack cost, proceeds, returns, refunds, residual, held assets, payout liability, dust, and
  unattributed value. The first record for a key fixes its decimal value; replay rejects a later
  record that changes atomic units.

Return attribution retains either the historical exact 16-field Relay intent or the current exact
18-field intent with both `tradeType` and `quoteDigest`. Partial pairs, unknown fields, unsupported
trade types and malformed digests refuse; accepted fields round-trip unchanged. The nested quote
digest is distinct from the enclosing Relay-leg digest. Historical records remain readable, but the
current live Relay adapter refuses restoring a 16-field intent without its original trade evidence.

The general chain-attempt runtime is v1; the frozen v2 policy, fencing, refusal,
and approval-digest fields are unavailable. Built-in outbound and return retain their
recovery authority with the repository's combined Relay signing record. Provider pre-call recovery
is implemented through `PREPARED -> NOT_SENT -> PREPARED` for the same request.

For ordinary provider stages, the operational stage driver constructs a canonical provider request
from frozen data-only input, then writes its digest in `PREPARED` before a capability reaches a
provider or signer. It passes the same request to the mutation with lease-fenced capability views,
but only a later reconciliation supplies evidence that `AutomatedCycleService` can commit as a
completed stage. A lost response therefore remains `SENT_UNKNOWN` and is never retried as a new
provider mutation. Pending purchase, open, epic-gate, and buyback handlers stop at that prepared
record; dry-run refuses to probe past an unresolved live attempt.

Live reconciliation receives a separate lease-fenced read-adapter seam and a read-only repository
facade. Chain-journal reconciliation for claim, outbound, and return is the narrow exception: after
canonical observation it may write only the relevant broadcast, finality, custody, Relay settlement,
recovery-context, and wallet-nonce-release transitions. A pre-call failure records retryable
`NOT_SENT`; only the same request may return to `PREPARED` under the current lease. Only an error
after an adapter capability call can become observation-only `SENT_UNKNOWN`. This generic
`NOT_SENT -> PREPARED` retry applies only when no more specific frozen recovery contract already
terminalizes the cycle. A `TransactionPolicyError` before any signature or broadcast is that
exception: the prepared request itself is semantically wrong (wrong asset, wrong recipient), which
an unmodified retry cannot correct, so the attempt still records `NOT_SENT` but the whole cycle also
holds `HELD_DATA_UNVERIFIED` for an owner decision instead of being retried
(`docs/runbooks/relay-wrong-asset.md`, `docs/runbooks/transaction-policy-wrong-recipient.md`).

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
  `readChainTransactionAttempt(stage, requestDigest)`, and `describe()` through a frozen repository
  client. Chain attempts retain one immutable signed transaction and distinct broadcast/finality
  evidence per request digest.
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
- A return delta is attributed to payout only when `ReturnLegDestinationProofV1` records an
  authenticated terminal Relay pointer, source and destination finality from this process, the
  exact USDG Transfer to Operations, a timestamp inside the settlement window, and globally unique
  source and destination hashes. Other finalized transfer observations enter their named hold.
- `MoneyConfigurationV1` describes retained read-only vault preflight evidence. Native signer paths require `MoneyConfigurationV2`.
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
- A held card, unattributed inbound amount, pause, kill switch, or unresolved journal prevents the
  next irreversible stage.
- A completed `payout` stage closes the cycle only after recipient records reconcile.
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
- Pause new claims when an inbound amount lacks cycle attribution.
- Do not create a first-use authorization after its standing authority expires. Obtain a fresh owner
  decision. A decision recorded before expiry may replay only through
  `verifyAndRecordStepAuthorization`, which reuses its exact durable reservations rather than
  calling the synchronous verifier at a signing boundary.

## Native money boundary

Active money configuration uses `hookemon.money-configuration.v2`, `assets.eth` and
`minimums.returnEth`, with exact internal identity `4663/native/18`. The historical v1 decoder
is read-only. A native claim requires admission v3 and writes claim-process-request.v2. Its
finalized proof matches persisted signed bytes, the successful post-payment hook event and
release-pinned runtime at the payment block. Finalized recovery reauthenticates that proof.
Native balance observations use a distinct archive reader and public canonical-block recheck.
Custody v3 retains the existing obligation buckets and adds typed `gasReserve`/`gasSpent`;
claim gas is charged once, separately from claimed principal. Historical EVM rows cannot be
reinterpreted as native rows.

Native return legs and destination proofs use version 2. Historical version 1 evidence remains
readable, but cannot enter the active return settlement path. Native custody uses version 3 and
requires separately typed gas reserve and spent gas. A return hold clears the pending expectation
without creating payout principal; an exact attributed return credits and clears atomically.

Native rehearsal sessions and stage evidence use v2. Session caps are microUSD, source principal is native wei, and simulated Solana settlement requires an explicit USDC atomic amount. Historical v1 sessions remain readable with their original units and cannot resume native execution.

The production evidence profile requires native `MoneyConfigurationV2`. Test configuration defaults use that schema; historical USDG fixtures use the separate `createHistoricalTestProductionEvidenceProfile` / `createHistoricalProductionTestFixture` simulation entry points and the read-only historical validator. The native production and default test factories reject historical configuration; retained v1 preflight rejects native configuration rather than reinterpreting its units. Historical simulation authority does not enable retained custody mutations. Native recovery tests obtain quote valuation capabilities from an independent fixture source after journal reads; serialized values alone grant no valuation authority.
