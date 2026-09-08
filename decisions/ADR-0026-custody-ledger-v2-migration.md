# ADR-0026: Custody ledger v2 exact shape and migration contract

## Status

PROPOSED_PENDING_OWNER_APPROVAL. Drafted for requirements revision 66,
alongside ADR-0024 and ADR-0025. This decision grants no deployment,
credential use, signing, broadcast, asset movement, spending, or publication
authority, and is not itself an owner approval of requirements revision 66.

The field shapes this ADR specifies (`CustodyBalanceObservationV1`, the
singular `expectedCycleAsset`, the canonical-identity requirement) are a
**proposed amendment** to `architecture/interfaces.json:169-176`'s
concept-level `custodyLedger` stub, not a reading of a contract that stub
already fixes. That amendment needs its own matching
`specs/requirements.json`/`architecture/interfaces.json` revision and that
revision's own `S5` approval, defined in `gates/spec.json`, before code may
be written against it as final. `S5` approval, when granted, binds the
literal approved text — including a path and content hash, when the approved
prose names one — into the requirement record; it is a textual owner
approval gate, not a mechanism that itself dereferences, executes, or
hash-validates an external artifact. No `decisions/owner-approvals/*` record
exists for this ADR or for requirements revision 66, and this ADR does not
create one.

## Context

`REQ-cycle-repository-1` and `REQ-cycle-runner-3` (`specs/requirements.json`,
approved) require a custody ledger that separates a finalized observed
current balance from obligations, counts unresolved principal once, and
classifies cycle-attributed expected assets separately from unattributed
external deposits that pause new claims. `architecture/interfaces.json:169-176`
names this `hookemon.custody-ledger.v2` and describes `verifiedCurrentBalance`
as "finalized observed on-chain TypedAmount" and `expectedCycleAssets`
(plural) as "cycle-attributed TypedAmounts" — a concept-level stub. The
runtime at `bot-continuation` `af384dbd` accepts and writes only
`hookemon.custody-ledger.v1` (`packages/runner/src/cycle/money-schemas.mjs:63-78,278-288`),
whose fourteen atomic buckets have no observed-balance field and no
expected-assets field.

Payout commit `a2a08797` (`createCycleAttributableFinalizedAvailableReader`
in `packages/adapters/src/app/payout-availability.mjs`) independently proves
a finalized Operations USDG balance covers `returnDelta + previousDust` for
direct-payout admission; it does not write a ledger, does not persist a
balance, and its `returnReceived` check deliberately keeps reading v1.
Commit `2d7c28fa` (same file) leaves that unchanged. Neither is modified by
this ADR. `payout-availability.mjs:140-142` filters every return-direction
Relay leg regardless of state and refuses admission unless exactly one
exists, then separately requires that one to be `SETTLED` — this is that
reader's own admission-time defense against return-leg ambiguity; it is not
a schema or repository invariant, and `recordRelayLeg` has no cardinality
check of its own (`cycle-repository.mjs:5045-5065`): a second
`return`-direction `RelayLegV1` for one cycle is reachable repository data.

The existing shape this ADR extends:

- `CUSTODY_LEDGER_BUCKETS` (unchanged, all fourteen, exact names and order):
  `claimed, bridgeOut, bridgeIn, packCost, buybackProceeds, returnInput,
  returnReceived, refunds, residual, heldAssets, heldPositions,
  payoutLiability, dust, unattributed` (`money-schemas.mjs:63-78`).
- `assertCustodyLedger` requires the object to carry exactly `schema,
  cycleId, chainId, assetId, decimals` plus those fourteen buckets, nothing
  more (`assertPlainObject`'s exact-field-count check, `money-schemas.mjs:85-93,278-288`).
- One row per `(cycleId, chainId, assetId)`, keyed by `chainId` and `assetId`
  joined with a NUL separator (`custodyLedgerKey`), written exclusively
  through `CycleRepository#recordCustodyLedger`, which appends a
  `custody-ledger-recorded` journal event (`cycle-repository.mjs:5556-5568`).
- Replay calls `assertCustodyLedger(entry.payload.ledger, ...,
  {allowLegacyBuckets: true})` for every stored `custody-ledger-recorded`
  entry (`cycle-repository.mjs:3166-3174`); `completeLegacyCustodyBuckets`
  backfills a missing `heldPositions` bucket with the truthful zero `'0'`
  only in the value returned to the caller, never in the persisted journal
  entry (`money-schemas.mjs:262-276`). A thirteen-bucket historical row's
  stored journal bytes stay exactly as written; the projected row every
  consumer (`describeCycle`, the policy projection, the dashboard) reads
  always has all fourteen buckets.
- `recordHeldPosition` stages one journal entry whose payload carries both
  `position` and, optionally, `ledger`, validated together by one
  `assertState` callback and committed by one `#append` call
  (`cycle-repository.mjs:3730-3772`) — the existing precedent for one atomic
  append covering two related durable records.
- `assertReturnRelaySettlementInput` throws if `value.custodyLedger !== null`
  for any return-leg terminal state other than `SETTLED`
  (`cycle-repository.mjs:1140-1148`): a held return leg
  (`HELD_RELAY_PARTIAL`/`REFUND`/`LATE`/`WRONG_ASSET`) leaves whatever
  ledger row already exists completely untouched. This is a distinct
  mechanism from ADR-0024/ADR-0025's per-card held *positions* (whole-cycle
  Relay-leg failure versus one card's custody).
- `CycleRepository` is constructed from a directory path and a clock only
  (`constructor(guard, store, now)`, `static async open(directory, now)`,
  `cycle-repository.mjs:2492-2513`) — it receives no money configuration, no
  chain-identity mapping, and no other injected dependency anywhere. Every
  writer function it exposes validates a caller-supplied payload structurally
  (`assertCustodyLedger`, `assertRelayLeg`, ...) and, where it needs an
  "expected" value to compare a write against, recomputes that value purely
  from previously replayed durable state (e.g. `returnSettlementCustodyLedger(state, leg)`,
  `cycle-repository.mjs:1074-1106`) — never from configuration. This ADR's
  write set preserves that boundary rather than injecting configuration into
  it.
- `claimCustodyAsset` builds the CAIP identity
  `{chainId: eip155:${configured.chainId}, assetId: eip155:${configured.chainId}/erc20:${configured.usdg.toLowerCase()}, decimals: USDG_DECIMALS}`
  for the claim row (`claim-process.mjs:635-641`), and asserts, before any
  claim proceeds, that `money.assets.usdg.chainId === String(configured.chainId)`,
  `money.assets.usdg.assetId.toLowerCase() === configured.usdg.toLowerCase()`,
  and `money.assets.usdg.decimals === USDG_DECIMALS` (`claim-process.mjs:73-75`).
  `money` (`MoneyConfigurationV1`) is threaded to `return.mjs`'s stage
  functions as well (`return.mjs:136,172,485,562,597`, all destructuring a
  `money` parameter), which already reads `money.assets.usdg.decimals` and
  `money.assets.solanaStablecoin.assetId` directly.
- `return.mjs` builds its own request/intent identity from
  `EVM_CHAIN_ID = String(RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID)` and
  `USDG_ADDRESS = RELAY_CONSTANTS.USDG_ADDRESS.toLowerCase()`
  (`return.mjs:48,50`) — a raw `(numeric-chain-id-string, lowercase-address)`
  pair, not the CAIP form — and requires the return request's destination
  amount to equal `{chainId: EVM_CHAIN_ID, assetId: USDG_ADDRESS, decimals:
  money.assets.usdg.decimals}` exactly (`return.mjs:500-511`).
  `RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID` (`4663`) and `USDG_ADDRESS`
  (`0x5fc5360d0400a0fd4f2af552add042d716f1d168`) are hardcoded literal
  constants exported from `relay-client.mjs:50,52,1055-1062`, already
  imported by both `return.mjs` and `payout-availability.mjs`.
  `createRecordedRelayLeg` copies the raw destination pair straight into
  `RelayLegV1.destinationChainId`/`destinationAssetId`
  (`money-schemas.mjs:513-539`), and `returnSettlementCustodyLedger` keys the
  settlement ledger row by that same raw pair (`cycle-repository.mjs:1074-1090`).
  `projectPolicyCustody` matches a ledger to its configured `evmUsdg`
  parameter by exact `chainId`/`assetId`/`decimals` equality
  (`ledgerMatchesAsset`, `accounting-projection.mjs:626-628`) and subtracts
  `returnReceived` from `claimed` only within one matching row
  (`accounting-projection.mjs:740-749`). **The claim row (CAIP identity) and
  the return-settlement row (raw identity) are two different rows today**,
  so the claimed principal is never actually netted against its own return
  under current behavior.
- `MoneyConfigurationV1.assets.solanaStablecoin` is a plain configuration
  field, not a function, with its own third identity convention — a
  Relay-style numeric chain id (e.g. `"792703809"`) plus a mint address, not
  the CAIP EVM form (`packages/adapters/src/app/environment.mjs:502-522,534-560`).
  No producer, finalized-slot evidence reader, or reorg/staleness rule for a
  Solana account balance exists anywhere in this codebase; the closest
  available primitive, `packages/adapters/src/solana-rpc.mjs`, exposes
  current blockhash, SOL balance, signature status, and transaction helpers,
  not an archived SPL-token balance at a finalized slot with an independent
  recheck.
- `projectPolicyCustody` already computes, per matching-asset row,
  `unresolvedClaim = claimed - returnReceived` (`accounting-projection.mjs:740-745`),
  and already sets `unvaluedExposure = true` for a *foreign* (non-matching)
  ledger with nonzero current custody in
  `POLICY_CUSTODY_CURRENT_BUCKETS = [refunds, residual, heldAssets,
  payoutLiability, dust, unattributed]` (`accounting-projection.mjs:568-577,626-631,736`).
  `readClaimPreconditions` separately pauses claims on `heldAssets`,
  `unattributed`, or nonzero `payoutLiability`/`refunds`/`residual`
  (`cycle-repository.mjs:4713-4747`).
- `assertRelayFinality` defines the chain-agnostic finality shape
  `{height, hash, timestampUnixSeconds}` for both an EVM block number and a
  Solana slot (`money-schemas.mjs:457-463`); `assertTypedAmount` defines
  `{chainId, assetId, decimals, amountAtomic}` (`money-schemas.mjs:119-126`).
- `payout-availability.mjs#reloadFinalizedOperationsUsdgBalance` proves a
  finalized EVM USDG balance at a public/archive/public-recheck checkpoint
  and refuses if the observed value is below an attributed amount — it never
  allocates or subtracts the observed balance, only lower-bounds against it
  (`payout-availability.mjs:199-227`).

## Decision

### Scope: the EVM USDG row only, in this revision

This ADR's `verifiedCurrentBalance` producer, and the admission rule that
depends on it, apply only to the canonical EVM USDG ledger row. No Solana
observation producer, finalized-slot evidence reader, or reorg/staleness
rule is defined here, because none exists in this codebase to build on and
inventing one without an evidence source would fabricate exactly the kind of
durable money contract R4 forbids. A custody-ledger row for any other chain
or asset stays on `hookemon.custody-ledger.v1` in this revision; this ADR's
v2 writers are exactly the ones that already construct the EVM USDG row
today (`recordClaimCustodyLedger`, `returnSettlementCustodyLedger`, and the
new return-leg method below). If a non-EVM-USDG row is ever written as `v2`
by a future writer, its `verifiedCurrentBalance` stays permanently `null`
until a future ADR defines its producer, and it is fail-closed by the same
unvalued-custody rule this ADR adds (below) — not by any new mechanism. A
Solana observation producer and its evidence contract are an explicit open
fact this ADR does not resolve.

### Schema identity and row shape

`hookemon.custody-ledger.v2` keeps every field of v1 unchanged — the same
`schema, cycleId, chainId, assetId, decimals` identity, the same fourteen
`CUSTODY_LEDGER_BUCKETS` with the same names and per-row semantics, keyed the
same way, written through the same `recordCustodyLedger` append point — and
adds exactly two new fields:

```
{
  "schema": "hookemon.custody-ledger.v2",
  "cycleId": "<string>",
  "chainId": "<string>",
  "assetId": "<string>",
  "decimals": <integer 0-255>,
  "claimed": "<atomic>", "bridgeOut": "<atomic>", "bridgeIn": "<atomic>",
  "packCost": "<atomic>", "buybackProceeds": "<atomic>",
  "returnInput": "<atomic>", "returnReceived": "<atomic>",
  "refunds": "<atomic>", "residual": "<atomic>", "heldAssets": "<atomic>",
  "heldPositions": "<atomic>", "payoutLiability": "<atomic>",
  "dust": "<atomic>", "unattributed": "<atomic>",
  "verifiedCurrentBalance": <CustodyBalanceObservationV1 | null>,
  "expectedCycleAsset": <TypedAmount | null>
}
```

`assertCustodyLedger` branches on `value.schema`: a `hookemon.custody-ledger.v1`
value validates exactly as today (nineteen fields, `allowLegacyBuckets`
unchanged); a `hookemon.custody-ledger.v2` value requires exactly those
twenty-one fields, none fewer, none extra. `v1` and `v2` are the only two
schema strings this function accepts. `obligations`, as named in
`interfaces.json`'s stub, is the existing fourteen-bucket set, structurally
distinct from the two new fields — no new field represents it.
`unattributedExternalDeposits` is the existing `unattributed` bucket,
carried into v2 unchanged.

### Canonical asset identity for the EVM USDG row

The canonical identity for a v2 EVM USDG row is
`{chainId: eip155:${money.assets.usdg.chainId}, assetId:
eip155:${money.assets.usdg.chainId}/erc20:${money.assets.usdg.assetId.toLowerCase()},
decimals: money.assets.usdg.decimals}` — the same formula
`claimCustodyAsset` already applies to `configured.chainId`/`configured.usdg`,
applied instead to `money.assets.usdg` (`MoneyConfigurationV1`, already
in scope in `return.mjs`). Because `claim-process.mjs:73-75` already asserts
`money.assets.usdg` equals `configured.chainId`/`configured.usdg` before any
claim proceeds, this construction is provably the same value
`claimCustodyAsset(configured)` produces for the claim row — one canonical
identity reached from two already-equal configuration sources, not two
independent guesses that merely need to agree.

Before constructing that canonical identity for a return-settlement row, the
return stage checks the full raw identity of the leg it is settling:
`leg.destinationChainId === EVM_CHAIN_ID`,
`leg.destinationAssetId.toLowerCase() === USDG_ADDRESS`, and
`leg.destinationDecimals === money.assets.usdg.decimals`. All three must
match before the canonical identity is constructed and used; a mismatch on
any one of them — including decimals alone, with chain and address both
matching — refuses the write. This check exists because the ledger row's own
`decimals` field is sourced from `money.assets.usdg.decimals` (the trusted
configured value), never copied from `leg.destinationDecimals`: the check is
not there to sanitize the ledger row (that is already safe by construction)
but to catch a settled leg whose actual decimals convention disagrees with
what is configured — a real settlement/configuration mismatch that must
refuse, not silently pass through under the configured value while the leg
itself used a different one.

This resolution happens once, in the return stage (`return.mjs`), which
already holds both `money` and the raw `RELAY_CONSTANTS`-derived comparison
values. `CycleRepository`'s writer and replay functions receive the already
-resolved canonical `chainId`/`assetId`/`decimals` as part of the ledger row
payload the stage constructs, exactly as they already receive every other
field of that row; they perform no resolution of their own; and this ADR
adds no configuration, resolver, or adapters import to `cycle-repository.mjs`.
Their existing per-key structural guarantee is sufficient: a ledger row's
`chainId`/`assetId` are part of `custodyLedgerKey`, so two writes that
disagree on either field are, by construction, two different rows, never a
merge or a silent overwrite — the failure mode of an incorrectly resolved
identity is a stray, unreferenced row, not corrupted shared state, and the
stage-side gate above is what prevents that failure mode from being reached
in practice.

This is one fixed mapping for the one asset in scope, not a general
N-chain/N-asset resolution framework: a second asset needing the same
treatment gets its own equally narrow, equally evidenced construction when
that need is concrete.

### `verifiedCurrentBalance`: producer, account, and the admission rule that replaces silent nulls

`verifiedCurrentBalance` is `CustodyBalanceObservationV1 | null`:

```
CustodyBalanceObservationV1 = {
  "schema": "hookemon.custody-balance-observation.v1",
  "account": "<non-empty string, exact chain-native address of the observed wallet>",
  "balance": TypedAmount,   // .chainId/.assetId/.decimals MUST equal the row's own canonical identity
  "finality": { "height": "<atomic>", "hash": "<non-empty string>", "timestampUnixSeconds": "<atomic>|null" }  // assertRelayFinality's exact shape
}
```

It is produced, for the EVM USDG row only, by one new adapters-layer
function reusing the identical evidence discipline
`reloadFinalizedOperationsUsdgBalance` already implements — read a finalized
block from the public Robinhood RPC client, read the balance at that exact
block/hash from a distinct archive-capable client, and re-read the public
client's block hash at that number to detect a reorg before trusting the
read (`payout-availability.mjs:199-227` is the pattern to copy; this
function does not call into or modify that file). `account` is the
configured Operations EVM address — the one signer identity
`REQ-transaction-policy-1` already fixes for EVM. This function is invoked
by each EVM-row v2 writer (`recordClaimCustodyLedger`,
`returnSettlementCustodyLedger`, `heldPositionCustodyLedger`, and the new
return-leg method below) at the moment it writes a v2 row for that key.

A write may supply `null` only on a key's first-ever write, when no prior
observation exists to preserve — never as a way to skip observing on a key
that already has one (see the forbidden-transitions rule below). This alone
does not satisfy `REQ-cycle-repository-1`'s finalized-balance requirement,
because a row could otherwise carry real, nonzero custody with a permanently
unobserved balance. This ADR closes that gap by extending
`projectPolicyCustody`'s existing `unvaluedExposure` flag, currently set only
for a foreign non-matching-asset ledger with nonzero
`POLICY_CUSTODY_CURRENT_BUCKETS` custody: **it also becomes `true` for the
canonical EVM USDG row when `verifiedCurrentBalance` is `null` while either
`unresolvedClaim` (`claimed - returnReceived`) is positive or any
`POLICY_CUSTODY_CURRENT_BUCKETS` bucket on that row is nonzero.** Because a
claim write always sets `claimed` before anything else touches that key,
this rule takes effect immediately after the first write that puts real
money on the row — there is no window in which a funded row can sit
unobserved without pausing new claims, consistent with
`projectPolicyCustody`'s existing contract that an unvalued projection
pauses claims via the policy engine (`docs/modules/custody-ledger.md`'s
existing invariant). A row with `verifiedCurrentBalance` non-null is never
marked unvalued by this rule regardless of its custody buckets.

`verifiedCurrentBalance.balance` records what this producer observed the
named `account` to hold in the named asset at one finalized height — a
wallet-level fact. It is never subtracted, summed, or divided across the
cycles that share that wallet; the only legitimate use is the same
coverage/lower-bound comparison `reloadFinalizedOperationsUsdgBalance`
already performs for payout admission — does the observed balance cover an
attributed amount, yes or no — never a persisted "remaining after this
cycle" figure.

### `expectedCycleAsset`: singular, with the second unresolved leg refused before it can be appended

A ledger row is scoped to one `(cycleId, chainId, assetId)`. Because a
return leg has no schema- or repository-enforced cardinality, this field's
correctness does not depend on assuming one exists; it depends on the write
path never allowing a second, competing unresolved expectation to be
appended in the first place. The new return-leg-recording repository method
introduced below is, from this revision forward, the only sanctioned way to
record a `return`-direction `RelayLegV1`. Before appending a new `RECORDED`
return leg, it replays the cycle's current state and refuses the write if an
unresolved (`RECORDED`, not yet `SETTLED` or terminal) return-direction leg
already exists whose resolved destination chain/asset equals the new leg's —
the append does not happen, and the row's already-populated
`expectedCycleAsset` is left exactly as it was. A second return leg for a
*different* resolved chain/asset is unaffected and independent, since it
targets a different row. Once the first leg resolves (`SETTLED` or any
`HELD_RELAY_*` terminal state, both of which clear `expectedCycleAsset` to
`null` per the transition table below), a new return leg for that same
resolved chain/asset may be recorded again.

This refusal is a new condition this repository method introduces; it is
not one of ADR-0024's exhaustively named semantic-invalid classes (wrong-asset,
wrong-recipient, cross-cycle attribution failure, conflicting canonical
evidence, unattributed deposit, missing predecessor evidence, snapshot
failure), and this ADR does not claim it is. How the calling stage surfaces
this refusal as an owner-visible cycle state — its own named class, or an
extension of an existing one — is an open fact for the implementation task
that wires this method into `return.mjs`, not resolved here.

Transition table, driven by `RELAY_LEG_STATES` (`money-schemas.mjs:41-50`),
for the one leg a row can ever have open at a time under the rule above:

| Return leg state | Row's `expectedCycleAsset` |
| --- | --- |
| No return leg recorded for this row's resolved chain/asset | `null` |
| Exactly one, `RECORDED` | `{chainId, assetId, decimals, amountAtomic}` from `leg.destinationChainId/Asset/Decimals/AmountAtomic`, resolved to the row's canonical identity |
| That leg transitions to `SETTLED` | `null`, cleared in the same existing atomic append that adds the amount to `returnReceived` (`cycle-repository.mjs:1074-1150`) |
| That leg transitions to any `HELD_RELAY_*` terminal state | `null`, written by a new dedicated atomic clearing append (below) — current behavior writes no ledger row at all for this outcome, so this write is new |

### Atomic creation and clearing

The return-leg-recording write appends a single journal entry carrying both
the `RECORDED` leg and the ledger row with its newly populated
`expectedCycleAsset`, validated together by one `assertState` callback and
committed by one `#append` call — the same shape as the existing
`recordHeldPosition` precedent (`cycle-repository.mjs:3730-3772`), not two
independent calls with two independent CAS windows. The same method, or an
equivalent single-append path, performs the `HELD_RELAY_*` clearing write:
one entry carrying the leg's terminal transition and the ledger row with
`expectedCycleAsset` reset to `null`. Settlement keeps its existing paired
Relay-leg-plus-ledger append (`cycle-repository.mjs:1074-1150`) and
additionally clears `expectedCycleAsset` to `null` in that same append — no
new call site there, only a field addition to what it already writes
atomically.

### Forbidden transitions, enforced at the repository boundary

The following are `assertState` checks inside
`CycleRepository#recordCustodyLedger` (and the new return-leg method),
reading the previous row for the same key before accepting a write — the
same style as the existing `decimals`-immutability check
(`cycle-repository.mjs:5556-5568`):

- **No `v2` → `v1` downgrade.** If the previous row for a key is `v2`, a
  write for that key whose `schema` is not `v2` is refused.
- **No non-null → null erasure.** If the previous row's
  `verifiedCurrentBalance` is non-null, a write that sets it to `null` is
  refused.
- **Monotonic, non-rewriting finality.** A new non-null
  `verifiedCurrentBalance` may replace a non-null previous one only if its
  `finality.height` is strictly greater than the previous one's, or the new
  observation is canonically identical in full to the previous one
  (`canonicalJson(next) === canonicalJson(previous)`) — an exact idempotent
  replay, not merely a matching `height`/`hash` with a different `account`,
  `balance`, or `timestampUnixSeconds`. An equal `height` with anything else
  different is refused as conflicting evidence; a lower `height` is refused
  as stale.
- **Expected-asset identity.** A non-null `expectedCycleAsset`'s
  `chainId`/`assetId`/`decimals` must equal the row's own canonical
  identity.

Cross-cycle: `CycleRepository` provides no cross-cycle transaction. That is
safe because `verifiedCurrentBalance` is never additively consumed across
cycles — two cycles sharing the Operations wallet may each independently
record their own observation of it, exactly as `projectPolicyCustody`
already reduces each cycle on its own before totals are added
(`accounting-projection.mjs:689-693`).

### Relationship to the payout availability reader

`payout-availability.mjs`'s `createCycleAttributableFinalizedAvailableReader`
is not modified, not reopened, and not fed from `verifiedCurrentBalance` by
this ADR. It remains the sole source of truth for direct-payout admission.
The new balance-observation producer deliberately does not share code with
it — same evidence discipline, distinct function, distinct call sites.

## Finite test matrix

**Schema and replay**
1. A stored `v1` row's journal bytes are never rewritten by replay; a
   thirteen-bucket historical row's projected value always has all fourteen
   buckets with `heldPositions: '0'` backfilled, and never gains a `v2`
   field.
2. A `v2` row missing `verifiedCurrentBalance` or `expectedCycleAsset`, or
   carrying a third schema string, or a `v1` row with a `v2` field, is
   rejected.
3. `CustodyBalanceObservationV1.balance`/`expectedCycleAsset` with
   `chainId`/`assetId`/`decimals` not matching the row's own canonical
   identity is rejected.
4. A write for a key whose previous row is `v2` and whose new row is `v1` is
   rejected.
5. A write that would set a previously non-null `verifiedCurrentBalance` to
   `null` is rejected.
6. Same `height` and `hash` with a changed `account`, `balance.amountAtomic`,
   or `timestampUnixSeconds` is rejected; same `height` with a different
   `hash` is rejected; a strictly greater `height` succeeds; a lower
   `height` is rejected; an exact, fully-identical replay succeeds as a
   no-op.

**Canonical identity**
7. The return stage's raw-identity gate refuses a leg whose
   `destinationChainId`, `destinationAssetId`, or `destinationDecimals`
   disagrees with `EVM_CHAIN_ID`/`USDG_ADDRESS`/`money.assets.usdg.decimals`
   — three independent negatives, including decimals alone with chain and
   address both matching.
8. A full claim-to-return conservation case: the same claimed atomic amount,
   claimed under the canonical identity, settled under the canonical
   identity built from `money.assets.usdg`, lands in one row and nets to
   zero unresolved principal after settlement.

**Attribution**
9. Cycle B's return leg cannot populate cycle A's `expectedCycleAsset`.
10. A second `RECORDED` return-direction leg for the same resolved
    chain/asset is refused before append; the first leg's
    `expectedCycleAsset` is unchanged by the refused attempt.
11. A crash after the leg-plus-ledger append's journal write, before any
    dependent read, shows both the leg and the populated
    `expectedCycleAsset` durably together, never one without the other.
12. A `HELD_RELAY_*` terminal return leg clears `expectedCycleAsset` to
    `null` via its own atomic write.
13. A canonical EVM USDG row with positive `unresolvedClaim` or any nonzero
    `POLICY_CUSTODY_CURRENT_BUCKETS` bucket and `verifiedCurrentBalance:
    null` marks `unvaluedExposure: true`; the same row with a non-null
    `verifiedCurrentBalance` does not.
14. `unattributed` (unchanged bucket) still independently pauses claims
    regardless of `verifiedCurrentBalance` or `expectedCycleAsset` values.

**Conservation**
15. `expectedCycleAsset` transitions to `null` at the exact same write that
    increments `returnReceived` by the settled amount; the amount is never
    both.
16. Two cycles' rows carrying the same wallet's `verifiedCurrentBalance`
    never sum that balance into a combined figure anywhere in the
    projection.

**Consumers**
17. `readClaimPreconditions` output is unchanged for a `v2` row whose new
    fields are both `null` and whose custody buckets are all zero (the
    genuine first-write case).
18. `payout-availability.mjs`'s existing tests are unaffected.

## Alternatives

### Store `verifiedCurrentBalance` as a bare `TypedAmount`

Rejected: cannot carry the account, block-or-slot, or hash provenance
`REQ-cycle-repository-1` requires, and cannot support the monotonic-finality
and no-erasure rules above.

### Make `expectedCycleAsset` a collection keyed by `relayRequestId`

Rejected: with the second-leg refusal enforced at the write boundary, a row
can never durably hold more than one unresolved expectation, so a
collection would carry a dimension that can never legitimately hold more
than one populated entry — unnecessary generality the write-time refusal
already makes unreachable.

### Inject money configuration or a resolver into `CycleRepository`

Rejected: `CycleRepository` is constructed from a directory and a clock only
and validates every writer input structurally or against its own replayed
state, never against configuration. Threading configuration into it would
change its construction signature across every existing call site for a
concern the stage layer, which already holds that configuration for every
other money check it performs, can resolve before ever calling in.

### A generalized N-chain/N-asset alias-resolution framework

Rejected: only the EVM USDG row is in scope for this revision. One
formula, evidenced against two already-provably-equal configuration
sources, solves it; a general resolver has no second case to justify it
yet.

### Define a Solana balance-observation producer now

Rejected: no archived SPL-token balance-at-finalized-slot-with-independent-recheck
primitive exists in this codebase to build one from, and inventing an
untested evidence path for a money contract is exactly what R4 forbids.
Scoping this revision to the EVM row and leaving a Solana row fail-closed
under the existing unvalued-custody mechanism is the closest verified
alternative until a Solana evidence producer is defined and reviewed on its
own.

### Backfill `v2` fields onto existing `v1` rows during replay

Rejected: there is no independent finalized evidence to backfill a
historical row with, so any populated value would be invented. `v1` replay
stays untouched; only a genuinely new write, with genuinely new evidence,
produces a `v2` row.

### Feed `verifiedCurrentBalance` into `payout-availability.mjs`'s admission check now

Rejected for this migration: that reader's `returnDelta + previousDust`
source- and dust-provenance discipline is independently correct today and
does not depend on this ADR's shape decision.

## Consequences

Once this ADR and its companion `specs/requirements.json`/
`architecture/interfaces.json` amendment are separately approved under their
own `S5`, the write set is:

1. `packages/runner/src/cycle/money-schemas.mjs` — add
   `assertCustodyBalanceObservation`, branch `assertCustodyLedger` on
   `schema`, add the `v2` field list and the expected-asset identity check.
2. `packages/adapters/src/app/cycle-repository.mjs` — add the
   schema-downgrade, non-null-to-null, and monotonic-finality `assertState`
   checks to `recordCustodyLedger`; add the new atomic return-leg method
   (creation with second-leg refusal, and the `HELD_RELAY_*` clearing
   write); extend `returnSettlementCustodyLedger` and
   `heldPositionCustodyLedger` to accept and carry forward the caller
   -resolved canonical identity and the two new fields on unrelated writes.
3. `packages/adapters/src/app/stages/return.mjs` — add the stage-local
   canonical-identity construction from `money.assets.usdg` and the
   pre-construction raw-identity (chain, address, decimals) gate; call the
   new atomic return-leg method instead of a bare `recordRelayLeg`.
4. `packages/adapters/src/app/stages/claim-process.mjs`,
   `stages/payout.mjs` — switch their `v1` schema constant to `v2` and
   supply the two new fields and the producer's observation at each write.
5. A new adapters-layer balance-observation producer function for the EVM
   USDG account, distinct from `payout-availability.mjs`, reusing its
   evidence pattern only.
6. `packages/adapters/src/app/accounting-projection.mjs` — extend
   `projectPolicyCustody`'s `unvaluedExposure` computation with the
   null-observation-with-nonzero-custody rule above; no change to its
   `unresolvedClaim` arithmetic.
7. Direct consumers (`readClaimPreconditions` tests, operator
   control/CLI/observability tests, `docs/modules/custody-ledger.md`,
   `docs/modules/cycle-repository.md`) get focused test and card updates
   once items 1-6 land.

`payout-availability.mjs` and its tests are untouched by this migration.
`specs/requirements.json` and `architecture/interfaces.json` are untouched by
this ADR. A Solana observation producer, its evidence interface, and its
reorg/staleness rule remain an open fact for a future revision; until it
exists, a non-EVM-USDG row stays on `v1` or, if migrated, stays permanently
unvalued and fail-closed under the rule above — never silently treated as
compliant. This ADR does not itself authorize anything; requirements
revision 66 and this ADR's companion interface amendment remain proposals
pending the owner's own, separate, explicit approval of each.
