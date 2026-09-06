# Policy Engine

## Purpose

`packages/runner/src/automation/policy-engine.mjs` decides whether a cycle start, claim, purchase,
or execution boundary may proceed. It reads the persisted operator configuration and works only in
canonical micro-USDG integer strings.

## Public interface

- `deriveCyclePolicyDigest(input)` binds a production cycle id, pack id, release amount, mode, and
  immutable economic-policy material to one SHA-256 digest. When supplied, a
  `hookemon.policy-admission.v2` record is part of the digest.
- `evaluateClaim`, `evaluatePurchase`, and `evaluateSignature` evaluate a supplied configuration
  and custody projection without writing state.
- `createPolicyEngine(dependencies)` returns `evaluate`, `evaluateClaim`, `evaluatePurchase`,
  `admit`, `recordManualApproval`, and `assertExecutionAllowed`.
- `recordManualApproval` accepts an optional `expectedRevision` and forwards it to the durable
  configuration mutation as an atomic compare-and-swap condition.

## Invariants

- The operator state configuration is the authority for allowlists, caps, pauses, approvals, and
  durable spend and cycle ledgers.
- Runner-owned state validation applies the immutable `OPERATOR_HARD_CAPS` from
  `packages/runner/src/operator/state-file.mjs`: 1,000 boosters per cycle; a 50,000,000 micro-USDG
  unit-price ceiling anchored to the highest verified public catalog pack price (`pokemon_50`, $50,
  H-funding-observations.md); a 150,000,000 micro-USDG cycle-budget ceiling and a 450,000,000
  micro-USDG trailing-24-hour ceiling, each a small labeled multiple of the unit-price ceiling for a
  modest multi-pack cycle and a modest number of cycles per day. These are pack-spend rails, not the
  owner's separate $250 total top-up ceiling — the two are deliberately kept apart, since neither
  bounds nor authorizes the other (a process can also recycle finalized returns without another
  owner dollar). Startup and every configuration CAS enforce them. Policy digest derivation and
  admission repeat the checks, so a persisted or direct over-cap configuration cannot expand
  spending authority. The operator's own
  `perCycleCapMicroUsdg`/`max24HourBudgetMicroUsdg`/`lossCapMicroUsdg` remain the tighter, day-to-day
  operating limits; this fixed ceiling only bounds how far a configuration edit can ever raise them.
- A production claim checks the allowlist, order request, cycle and trailing-24-hour offchain spend limits,
  per-cycle cap, loss cap, custody cap, held-position limits, unattributed deposits, and unvalued custody.
  It returns `HELD_LIMIT` when the open position count is greater than or equal to
  `maxHeldPositions`, or their persisted USDG control value is greater than
  `maxHeldValueMicroUsdg`. A position uses a verified insured value only when it is already typed
  as the configured USDG asset; otherwise it uses its attributed purchase cost.
- `pendingEpicDecisions` and the legacy `heldAssets` signal do not independently refuse a new
  claim. Per-card positions are assessed only through the held-position limits. The automation
  join gate retains unattributed custody and unresolved obligations as the separate fail-closed
  conditions.
- Operator configuration sets `maxHeldPositions` from 0 through 1,000,
  `maxHeldValueMicroUsdg` as a canonical micro-USDG string, and
  `unresolvedCardDeadlineMinutes` from 5 through 1,440. Their defaults are 10,
  `5000000000`, and 30 respectively.
- `admit` repeats the custody and configuration check inside the supplied durable mutation before
  recording a new production cycle and its spend reservation.
- A reservation at or beyond the trailing-24-hour boundary is refused. A current reservation counts
  as pending principal for loss and outstanding-custody limits; this policy state has no
  execution-evidence release path, so an incomplete reservation remains conservative until expiry.
- Purchases require the exact existing cycle digest and reservation. Before signing, policy checks
  typed unitPriceAtomic, totalAtomic, and boundedOverheadAtomic plus positive integer-string
  quantity; totalAtomic equals quantity multiplied by unitPriceAtomic, all money fields share one
  asset identity, and the reservation covers totalAtomic plus boundedOverheadAtomic.
- A `policy-admission.v2` binds one typed catalog unit target, its checked aggregate target, a
  separate N=1 source funding quote, an aggregate source funding quote, and the `EXACT_OUTPUT`
  Relay identity. Both the unit and aggregate quotes carry independently identified `EXACT_OUTPUT`
  Relay evidence, deadlines, and quote digests. The canonical USDG/USDC routes and Operations
  sender/recipient are required. The unit rail compares only `unitFundingQuote.amountAtomic`; per-cycle and
  trailing-24-hour reservations compare only `aggregateFundingQuote.amountAtomic` once. The
  aggregate quote is never divided by quantity and no USDG/USDC conversion is inferred.
- The current digest excludes the generic configuration revision and binds every economic-policy
  field, including held-position limits and the unresolved-card deadline, so a pause or resume does
  not invalidate an admitted cycle. Existing version-3, version-2, and version-1 digests remain
  recognizable for their recorded policy material.
- Cycle mode is persisted at creation and immutable. Production services refuse rehearsal cycles
  and rehearsal services refuse production cycles.
- `executionPaused` and `killSwitch` refuse cycle starts and every signature, broadcast, or generic
  mutation guard. Before claim admission, the eligibility-snapshot mutation guard has no reservation
  to recheck and enforces those immediate controls only. A claim-stage guard requires the durable
  admission record and repeats claim admission; later cycle-bound effects recheck the pack, cycle
  digest, reservation, approval, and current loss and custody caps without reserving the same
  principal again. The first configured production cycles require an approval for their exact digest.

## State transitions

- A permitted production claim appends one cycle-ledger record and one spend-ledger record. An
  existing current digest is idempotent and does not reserve again; an expired reservation is not
  refreshed by a retry.
- A manual approval adds one digest-keyed approval or returns the same approval when the cycle and
  supplied timestamp agree. Conflicting data is rejected. When an operator supplies an expected
  state revision, the approval mutation checks and writes that revision in one CAS without retrying
  against a later configuration.
- A refusal returns a stable reason and leaves configuration and custody unchanged.

## Operational commands

```sh
node --test packages/runner/test/automation/policy-engine.test.mjs \
  packages/runner/test/config/state-schema.test.mjs
```

- Record a manual approval with the digest produced for the intended cycle before retrying its claim.
- Investigate a held-position limit, unattributed custody, or unvalued custody before clearing the
  underlying condition.

## Recovery pointers

- Use the incident procedures for a [wrong asset](../runbooks/relay-wrong-asset.md),
  [wrong recipient](../runbooks/transaction-policy-wrong-recipient.md),
  [held Epic card](../runbooks/epic-card-held.md),
  [threshold equality](../runbooks/epic-threshold-equality.md), or an
  [unattributed deposit](../runbooks/unattributed-deposit.md). Each recovery contract records the
  supported resume command or its absence.
- Do not retry a refused claim with a different amount or pack id under the same cycle id.
- Preserve a `SENT_UNKNOWN` provider attempt for reconciliation; policy admission never authorizes a
  replacement send by itself.
- If the state mutation contends, reread the configuration and evaluate again rather than reusing a
  stale decision.
- A legacy digest remains usable only when the current economic-policy material reproduces its
  recorded value at a bounded historical revision. Otherwise pause the cycle and reconcile it under
  an explicit operator decision.
- Do not authorize purchase from a release cap alone. Persist the full purchase request before
  signing, validate its arithmetic and typed assets, reserve its total plus overhead, and keep
  finalized observed balances separate from obligations with unresolved principal counted once.
- A changed admission, target, route, deadline, or quote digest changes the cycle digest and is
  refused under the prior reservation. The caller must create a new admission rather than reuse
  the prior authorization.
- Admission refuses a quote at its exact deadline. Purchase also refuses after its durable spend
  reservation leaves the trailing 24-hour window, even if a separately recorded quote would still
  be valid.
- OPEN FACT: No frozen conversion quote binds a Collector Solana stablecoin insured amount to USDG.
  Resolve it by adding a quoted, digest-bound USDG conversion to the held-position contract and
  tests that reject a substituted quote. Verified safe alternative: use the cycle-attributed USDG
  purchase cost unless `insuredValue` is already the configured USDG asset; do not price a foreign
  insured amount.
- OPEN FACT: A completed cycle with open held positions remains an active DurableCycleStore record,
  whose capacity is 16. The default `maxHeldPositions: 10` is safe when positions span completed
  cycles, but values above 10 have no verified capacity guarantee and values at or above 16 can
  exhaust the store before `HELD_LIMIT` protects a future cycle. Resolve this by adding
  post-completion position archival with recoverable supplementary evidence, or a store-capacity
  exemption, and test admission across the configured position cap. Verified safe alternative:
  keep `maxHeldPositions` at 10 or lower.
- OPEN FACT: The configuration schema has no durable, projected pending-manual-approval pair for a
  refused cycle. Resolve it through an owner-approved requirements and interface revision that
  defines the pair, its lifecycle, and its status projection, then regenerate the frozen interface
  artifacts. Verified safe alternative: reject the cycle before an effect and accept only a
  caller-supplied digest through the revision-atomic approval CAS; do not infer or invent a pending
  approval from a refusal.
