# Policy Engine

## Purpose

`packages/runner/src/automation/policy-engine.mjs` decides whether a cycle start, claim, purchase,
or execution boundary may proceed. It reads the persisted operator configuration and works only in
canonical micro-USDG integer strings.

## Public interface

- `deriveCyclePolicyDigest(input)` binds a production cycle id, pack id, release amount, mode, and
  immutable economic-policy material to one SHA-256 digest.
- `evaluateClaim`, `evaluatePurchase`, and `evaluateSignature` evaluate a supplied configuration
  and custody projection without writing state.
- `createPolicyEngine(dependencies)` returns `evaluate`, `evaluateClaim`, `evaluatePurchase`,
  `admit`, `recordManualApproval`, and `assertExecutionAllowed`.
- `recordManualApproval` accepts an optional `expectedRevision` and forwards it to the durable
  configuration mutation as an atomic compare-and-swap condition.
- `assertPolicyAdmission(admission, operations?)` normalizes a quote-bound `hookemon.policy-admission.v2`
  record and requires its `processLiabilityEvidence`. `CycleRepository` and `deriveCyclePolicyDigest`
  both call it, so the durable record, its replay, and the cycle policy digest all bind exactly the
  evidence this normalizer accepted; there is no evidence-free variant of this schema.

## Invariants

- The operator state configuration is the authority for allowlists, caps, pauses, approvals, and
  durable spend and cycle ledgers.
- Runner-owned state validation applies the immutable `OPERATOR_HARD_CAPS` from
  `packages/runner/src/operator/state-file.mjs`: 1,000 boosters per cycle, a 25,000,000 micro-USDG
  unit price, a 50,000,000 micro-USDG cycle budget, and a 3,600,000,000 micro-USDG trailing-24-hour
  budget. Startup and every configuration CAS enforce them. Policy digest derivation and admission
  repeat the checks, so a persisted or direct over-cap configuration cannot expand spending
  authority.
- A production claim checks the allowlist, order request, cycle and trailing-24-hour offchain spend limits,
  per-cycle cap, loss cap, custody cap, held assets, unattributed deposits, and unvalued custody.
- `admit` repeats the custody and configuration check inside the supplied durable mutation before
  recording a new production cycle and its spend reservation.
- A reservation at or beyond the trailing-24-hour boundary is refused. A current reservation counts
  as pending principal for loss and outstanding-custody limits; this policy state has no
  execution-evidence release path, so an incomplete reservation remains conservative until expiry.
- Every `hookemon.policy-admission.v2` admission requires `processLiabilityEvidence`; there is no
  evidence-free equivalent for a quote-bound admission, so an admission missing it is refused
  outright rather than treated as valid without a hook observation. A rehearsal or other cycle that
  has no such read uses the existing no-admission path instead of this schema. Every getter, control
  flag, and `ceilingAtomic` is re-validated against the resolved deployment identity's funding route,
  independent of whichever reader produced it, including the three relationships the hook's own
  accounting guarantees (`remainingProcessClaimCapacity <= activeProcessClaimLimit`,
  `processLiability <= totalLiability`, and `isSolvent` exactly tracking `hookUsdgBalance >=
  totalLiability`) and rejecting any unrecognized field, and the aggregate funding quote must not
  exceed that ceiling. A one-field mutation to a validated record either fails one of these checks or
  survives into the normalized result the policy digest covers.
- A `hookemon.policy-admission.v2` admission's `quantity` is a positive integer bounded to the
  shared purchase-stage batch/catalog ceiling (`MAXIMUM_PACK_BATCH_SIZE`,
  packages/runner/src/cycle/money-schemas.mjs), refused here -- before `CycleRepository` durably
  persists the admission, and therefore before the cycle exists or claim-process can run -- rather
  than only at the later purchase stage's own defense-in-depth check. The operator's own
  `requestedOrders` ceiling (`maxBoostersPerCycle`, up to 1,000,
  packages/runner/src/config/state-schema.mjs) can exceed this batch/catalog bound, so an admitted
  quantity is never trusted past it merely because an operator configured it. The same ceiling is
  independently enforced earlier still, at admission construction: `buildAdmissionPlanner.plan`
  (packages/adapters/src/app/compose.mjs) refuses an over-ceiling `requestedOrders` before any
  catalog read, Relay quote, or hook liability read, so a request this far above the ceiling never
  reaches a Relay quote, a claim, or a durably admitted cycle at all -- not merely this later
  normalizer.
- A `hookemon.policy-admission.v2` binds one typed catalog unit target (`unitPurchase`), its checked
  aggregate target (`aggregatePurchase`), a separate N=1 source funding quote (`unitFundingQuote`),
  an aggregate source funding quote (`aggregateFundingQuote`), and the `EXACT_OUTPUT` Relay identity
  for each. `unitRelayQuote` is the full immutable, parser-shaped N=1 Relay response: policy rechecks
  its raw request/order, route, accounts, deadline, order payments, exact amounts, and the same
  canonical full-response digest produced by the Relay adapter. The persisted raw quote is an
  integrity commitment, not a cryptographic Relay attestation; `buildAdmissionPlanner` obtains it
  through `parseQuoteResponse` before it is ever persisted. The canonical funding/settlement route
  and Operations sender/recipient are required. The unit rail compares only the independently
  verified `unitFundingQuote.amountAtomic` against the per-unit ceiling; per-cycle and
  trailing-24-hour reservations compare only `aggregateFundingQuote.amountAtomic` once. The
  aggregate quote is never divided by quantity to obtain a unit price, and the unit is never
  multiplied by quantity to obtain the aggregate: fees and slippage are not linear in quantity, so
  either substitution would authorize an unquoted spend.
- Purchases require the exact existing cycle digest and reservation. Before signing, policy checks
  typed unitPriceAtomic, totalAtomic, and boundedOverheadAtomic plus positive integer-string
  quantity; totalAtomic equals quantity multiplied by unitPriceAtomic, all money fields share one
  asset identity, and the reservation covers totalAtomic plus boundedOverheadAtomic.
- The current digest excludes the generic configuration revision. It continues to bind every
  economic-policy field, so a pause or resume does not invalidate an admitted cycle.
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
- Investigate held, unattributed, or unvalued custody before clearing the underlying condition.

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
- The cycle record's release cap is not a final provider-validated purchase price. Until the
  purchase stage persists the atomic price, the service passes the release cap to the purchase
  check and refuses a release above the configured unit-price cap.
- OPEN FACT: The configuration schema has no durable, projected pending-manual-approval pair for a
  refused cycle. Resolve it through an owner-approved requirements and interface revision that
  defines the pair, its lifecycle, and its status projection, then regenerate the frozen interface
  artifacts. Verified safe alternative: reject the cycle before an effect and accept only a
  caller-supplied digest through the revision-atomic approval CAS; do not infer or invent a pending
  approval from a refusal.
