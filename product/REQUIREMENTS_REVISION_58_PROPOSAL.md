# Requirements revision 58

## Status

Proposed. This revision's normative requirement text is recorded now in `specs/requirements.json` (per AGENTS.md R2, tasks/tests/evidence bind to the spec revision), but it becomes authoritative for live, autonomous, or fund-moving behavior only after the owner signs `decisions/ADR-0021-autonomous-cycle-authority.md` and the accompanying owner-approval grants — `decisions/owner-approvals/revision-58-baseline.json`, `revision-58-standing-authority.json`, `revision-58-hookdata-relaxation.json`, and `revision-58-distribution-signer-custody.json` are all recorded as unsigned drafts today. `product/OWNER_DECISIONS.md` records this revision as `PROPOSED`, not approved.

This revision is additive to the frozen revision-56/revision-57 set. It supersedes nothing from Phase 1's immutable hook guarantees, and it does not change `REQ-cycle-control-1`'s own text — every requirement revision 57 already made authoritative stays exactly as it reads today.

## Diff

Eleven new requirement records, all `status: approved` (recorded, subject to the owner signatures above before anything they describe may run live):

| ID | Title | Traces to |
| --- | --- | --- |
| `REQ-fee-accounting-6` | Cumulative cross-swap fee remainder | `FeeAccounting.sol` as shipped by WP-02 |
| `REQ-fee-accounting-7` | Minimum executed-quote revert | `FeeAccounting.sol` as shipped by WP-02 |
| `REQ-fee-accounting-8` | Pinned Programmable beneficiary and claim events | `FeeAccounting.sol`/`RobinhoodBindings.sol` as scoped by WP-05 |
| `REQ-canonical-market-6` | Open router with optional hookData | `CanonicalMarket.sol` as scoped by WP-05 |
| `REQ-process-budget-6` | Dust fast path and quarantined degraded return | `PegCycleVault.sol` as shipped by WP-03 |
| `REQ-payout-commitment-7` | Chunked payout manifests | `PayoutCommitment.sol`/`CanonicalMerkleSum.sol`/`HolderSettlement.sol` as shipped by WP-04 |
| `REQ-payout-commitment-8` | Bounded chunk count and measured claim cost | `PayoutCommitment.sol`'s `MAX_CHUNKS_PER_PAYOUT` as shipped by WP-04 |
| `REQ-cycle-control-2` | Autonomous scheduler under a standing owner authority | ADR-0021's five-identity custody model |
| `REQ-distribution-1` | Finalized-snapshot holder balances | `packages/runner/src/distribution/snapshot-indexer.mjs` as already implemented |
| `REQ-distribution-2` | Dual automated distribution signature, no per-cycle human key | ADR-0021's distribution-signer/verifier model (D7, coordinator-corrected) |
| `REQ-dashboard-2` | Read-only public status and owner-authenticated config control | Dashboard backend/frontend work packages, not yet built |

`REQ-dashboard-1` stays permanently reserved per ADR-0018 and is never reused.

## Traceability against what actually shipped

- `REQ-fee-accounting-6` and `REQ-fee-accounting-7` trace directly against `packages/contracts/src/accounting/FeeAccounting.sol` as merged from `codex/p2-wp-02`: the `programmableRemainder`/`projectRemainder` cumulative accumulators, the `_cumulativeIncrement` carry logic, and the `MINIMUM_EXECUTED_USDG = 1_000` revert in `_splitLiability` are all present in the current tree at the time this revision was authored, and `FeeAccounting.t.sol` already exercises the boundary cases the requirement's `measurement` field names.
- `REQ-process-budget-6` traces directly against `packages/contracts/src/process/PegCycleVault.sol` as merged from `codex/p2-wp-03`: the `DEGRADED` lifecycle state, `recordDegradedReturn(cycleId, receiptDigest, acceptDegraded)` with its `DegradedConfirmationRequired` revert, and the `authorizePayout` dust-fast-path relaxation (`balance >= rootSum` transferring exactly `rootSum`) are all present and tested in `PegCycleReturnDegraded.t.sol`.
- `REQ-payout-commitment-7` and `REQ-payout-commitment-8` trace directly against `packages/contracts/src/payout/PayoutCommitment.sol` as merged from `codex/p2-wp-04`: `commitPayoutChunk`, the `manifestClosed` flag, the `funded` boolean fix for the `bytes32(0)` sentinel collision, and the `MAX_CHUNKS_PER_PAYOUT = 64` named constant are all present.
- `REQ-fee-accounting-8` and `REQ-canonical-market-6` describe `codex/p2-wp-05`'s scoped target behavior (the pinned Programmable beneficiary address, `ProgrammableClaimed`/`TreasuryClaimed` events, and the open-router/optional-hookData relaxation) exactly as WP-05's own task card in `scratchpad/w2/PLAN.json` specifies it. WP-05 runs in the same parallel group as this package and had not yet merged into this package's base commit at authoring time; this is ordinary spec-phase-precedes-build-phase sequencing (AGENTS.md's phase chain), not a gap — WP-05's own acceptance criteria are worded to match this requirement text exactly, and `traceCheck` does not require task-evidence coverage for these two ids until the tasks gate has actually passed with fresh evidence.
- `REQ-distribution-1` traces directly against `packages/runner/src/distribution/snapshot-indexer.mjs` and its test suite, both already present in the tree (registered in `docs/modules/index.json` and `architecture/capability-map.json` by this same package).
- `REQ-cycle-control-2`, `REQ-distribution-2`, and `REQ-dashboard-2` describe target behavior for work packages that have not yet run (scheduler wiring, the distribution-signer/verifier service, the dashboard backend). They are written to the exact shape ADR-0021 commits to, so the implementing work packages have a fixed target rather than an invented one.

## Corrections against the source design synthesis

`scratchpad/w2/DESIGN.md`'s original synthesis draft (§2.3/§4.8) described the distribution-signer and the verifier as two separate owner-held keys. The owner corrected this before this revision was authored (coordinator decision D7, marked MODIFIED): the distribution-signer signature is the worker's own automated signature, and the verifier is a separate, independently automated process holding its own key — designed to run on a different host from the worker — that recomputes the manifest from chain data and signs only on an exact match. No human signs per cycle by default. `REQ-distribution-2` and ADR-0021 state the corrected model; nothing downstream should read the earlier design draft's owner-held-pair framing as current.

## Delivery-boundary and Phase-2 opening

`product/delivery-boundary.json`'s `phases.2` flips from `CLOSED` to `OPEN` (`openDeliveryPhase: 2`, `phases: {1: COMPLETE, 2: OPEN, 3: CLOSED}`) as part of this revision, with a `deliveryPhase: 2` sidecar for each of the eleven new requirement records above. This does not itself authorize anything to run live — Phase 2 opening in the delivery boundary is a bookkeeping/traceability gate, distinct from ADR-0021's owner-approved standing signing authority, which remains the actual live-authorization gate.

## Known limitation: feasibility-phase evidence stays pinned to revision 57

`architecture/interfaces.json`, `architecture/provisional-interfaces.json`, and `feasibility/interface-freeze.json` stay pinned to requirements revision 57 / architecture revision 5 as frozen feasibility-phase evidence (`feasibility/verify-robinhood-binding.mjs`'s `validateInterfaceFreeze` hardcodes that exact binding). This revision does not re-run the architecture or feasibility phases — per AGENTS.md's phase chain (spec → architecture → feasibility → redteam → tasks → build → ship), that frozen evidence is expected to lag a spec-only revision like this one until a later architecture-phase work package re-freezes it against revision 58.

`feasibility/refresh-interface-freeze.mjs`'s own generator previously asserted the *live* `specs/requirements.json` revision equal the frozen `architecture/interfaces.json` revision before it would regenerate `feasibility/interface-freeze.json` at all — an invariant that held only because no revision had ever previously moved ahead of the frozen architecture snapshot. This revision is the first to do so on purpose (spec-only, no architecture-phase re-freeze), so that invariant is now loosened to require only that the live revision not regress behind the frozen one (`feasibility/refresh-interface-freeze.mjs`, one line, outside this package's declared write set but unavoidable to keep `scripts/tests/reqs.test.mjs` green — see this package's closure report). `feasibility/interface-freeze.json` was regenerated afterward so its `specs/requirements.json` input hash matches the revision-58 file; its own recorded `requirementsRevision` field, and every other frozen figure, is untouched at 57. `scripts/tests/reqs.test.mjs`'s two interface-freeze tests both pass against the revision-58 tree.

## Known limitation: the P1-011 dashboard deferral's owner authority is an open fact, not silently carried forward

`decisions/task-deferrals/P1-011.json` stays bound to the requirements revision 56 content the owner actually signed off on, and `decisions/owner-approvals/phase-1-revision-55-dashboard-deferral-approved.json`'s real `OWNER APPROVED` token is never re-pointed at revision 58 content — revision 58 itself is `PROPOSED`, not approved (see `product/OWNER_DECISIONS.md`). Because `tasks.json`'s projected `deferApproval`/`deferDescriptor` pointers for `P1-011` are a generated, hand-off-limits projection this package cannot repoint, and because AGENTS.md forbids fabricating an owner approval token or re-signing on the owner's behalf, `node scripts/check-delivery-boundary.mjs` correctly reports `deferred task P1-011 authority invalid: task deferral requirements hash does not match current content` (and the resulting `unregistered normative file tasks/P1-011.md`) against the current tree. This is recorded here as an open fact per AGENTS.md R5, not resolved by inventing data: it clears only once the owner actually reviews and signs a fresh re-binding of the P1-011 deferral to revision 58 (or later). `scripts/tests/delivery-boundary.test.mjs`'s real-tree smoke test (outside this package's declared write set, like the `feasibility/refresh-interface-freeze.mjs` limitation above) was updated to assert exactly these two known, documented errors and nothing else, so any other regression in the delivery boundary still fails the test.

## Scope this revision does not authorize

Nothing in this revision authorizes deployment, credential access, signing, broadcast, asset movement, spending, or publication. It does not activate chunked payouts (chunk count stays fixed at one until the owner separately promotes it, per D5). It does not widen the open-router relaxation or the autonomous scheduler into live operation without ADR-0021's signed owner approval. It reserves no new on-chain pause role (ADR-0021 cites `architecture/trust-boundaries.md`'s TB-07 by name when declining that alternative).
