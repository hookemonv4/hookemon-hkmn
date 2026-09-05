# Owner Decision Record

## Recorded approvals

The owner gave the following unambiguous approvals on 30 and 31 August 2026:

- `SPEC A APPROVED`
- `SPEC B APPROVED`
- `SPEC C APPROVED`
- `PHASE 1 BASELINE APPROVED`
- `LEGACY CLEANUP APPROVED`
- `PHASE-1 PRD, REQUIREMENTS REVISION 53 UND ADR-0013 BIS ADR-0016 GENEHMIG`
- the manual one-cycle Phase 1 design, followed by the explicit release instruction `freigeben`

These approvals bind the clean-room product baseline, the three-phase delivery order, the active-tree cleanup, and the start of Phase 1 after the control pull request passes its required checks and is merged. The owner additionally approved requirements revision 56's immutable peg-cycle custody correction on 1 September 2026.

## Bound target decisions

- Dedicated Programmable Launchpad on Robinhood Chain ID `4663`.
- Desired `USDG/HKMN` project market.
- Inclusive 3.00% executed USDG quote-volume policy: 0.10% Programmable, 0.40% treasury, and 2.50% process budget.
- Immutable HKMN token and non-upgradeable fee-and-holder-payout hook.
- Onchain work has priority; later external-cycle and product phases consume frozen predecessor interfaces.

## Thin production V1 scope decision

The owner approved the thin production V1 direction, requirements revision 53, and the permanent zero-LP-fee market-custody revision 54 on 30 August 2026. On 31 August 2026 the owner approved the manual one-cycle Phase 1 design and explicitly instructed `freigeben`, approving requirements revision 55 and ADR-0018.

- Phase 1 must prove the complete loop: canonical HKMN purchase, exact fee split, process-budget release, one fixed outbound route, one real operator-selected pack purchase and open, standard buyback, one fixed return route, actual net-USDG return, funded holder distribution, holder payment, and final reconciliation.
- The first external runner uses one operator-triggered fixed Collector Crypt path and may use operator-assisted steps.
- The Collector Crypt production pack subloop uses Solana mainnet and Solana USD Coin, not Base. The conversion route remains outside the immutable hook.
- Dashboard and UI, scheduling and continuous operation, catalog persistence, route optimization, and multi-pack execution are deferred to Phase 2. `REQ-dashboard-1` is permanently reserved and is not active in revision 55.
- Reversible offchain behavior may be updated after launch. The immutable hook contains only the money and proof invariants needed by the loop.
- Phase 2 starts from a fresh v4 Spec revision and new owner approval.
- No long-term runway requirement belongs to Phase 1.

Requirements revision 55 and ADR-0013 through ADR-0018 are authoritative for the manual Phase 1 boundary and the unchanged rounding, payout, proof, authority, Solana pack-cycle, permanent market-custody, zero-LP-fee, and deferred-selector mechanics. ADR-0018 supersedes only ADR-0013's dashboard and automation boundary.

## Revision 56 immutable peg-cycle custody decision

Revision 56 keeps the inclusive 3.00% fee: `totalFee = floor(Q * 300 / 10,000)`, `programmableLiability = floor(Q * 10 / 10,000)`, `treasuryLiability = floor(Q * 40 / 10,000)`, and the exact remaining process liability. The hook may debit that liability only while atomically funding its immutable `PegCycleVault`.

Operations remains a two-step-rotated trigger for a future unopened cycle. It is never a process-principal, route, return-proceeds, or payout-funding custodian. All exact attributable returned USDG is committed from the vault to the hook as one sum-bound holder payout. Robinhood-specific Programmable launch and admission facts remain `INTEGRATION_PENDING`.

## Revision 57 manual cycle control decision

On 1 September 2026 the owner approved continuing Phase 2 locally with the smallest manual control surface. The operator may select one pack from an exact snapshot and edit the existing money parameters before freezing a plan. After freeze, the same interrupted cycle resumes from its durable journal and must reconcile unresolved external intent before progress.

After an evidenced terminal failure, a new cycle is allowed only with a fresh cycle identifier, nonce, and immutable cycle-specific return escrow. A late return remains quarantined in the failed cycle's escrow and cannot become a later cycle's proceeds. The approval excludes dashboards, schedulers, automatic pack selection, concurrency, production signing or broadcast, credentials, deployment, publication, and spending.

## Revision 58 autonomous cycle authority decision

Status: `PROPOSED`. Not yet approved. Requirements revision 58's eleven new requirement records, `decisions/ADR-0021-autonomous-cycle-authority.md`, and the four owner-approval drafts under `decisions/owner-approvals/revision-58-*.json` are all unsigned — none carries the `OWNER APPROVED` token, and `product/delivery-boundary.json`'s Phase 2 opening is a bookkeeping and traceability gate, not a live-authorization gate.

What the drafts propose, pending the owner's actual signature:

- **`revision-58-baseline.json`** — adopting requirements revision 58 as a whole: the cumulative fee remainder and minimum-quote revert (already shipped and tested), the dust fast path and `DEGRADED` quarantine (already shipped and tested), chunked payouts shipped inactive at chunk count one, and a future re-binding of the pre-existing `P1-011` dashboard deferral to revision 58's requirements content once a fresh, owner-reviewed deferral descriptor exists. `decisions/task-deferrals/P1-011.json` itself stays bound to its originally owner-approved revision 56 content in this revision, and the real `OWNER APPROVED` token on `decisions/owner-approvals/phase-1-revision-55-dashboard-deferral-approved.json` is not re-pointed at any revision-58 content. `node scripts/check-delivery-boundary.mjs` therefore currently reports `deferred task P1-011 authority invalid: task deferral requirements hash does not match current content` — recorded here as an open fact pending the owner's actual re-approval of the rebinding, not silently resolved.
- **`revision-58-standing-authority.json`** — granting the scheduler a standing signing authority: a per-cycle spend cap and cycles-per-day cap starting at the legacy canary's proven scale (one $25 pack plus bridge fees per cycle, maximum 72 cycles per day, both dashboard-editable within that signed ceiling), and the two-layer kill switch behavior ADR-0021 §"Two-layer kill switch" describes.
- **`revision-58-hookdata-relaxation.json`** — approving the open-router/optional-hookData change to `CanonicalMarket.sol` specifically, because it revises an already-tested, previously owner-reviewed invariant (the single-router binding).
- **`revision-58-distribution-signer-custody.json`** — approving the corrected distribution-signer/verifier custody split: the distribution-signer is the worker's own automated signature, and the verifier is a separate, independently automated process with its own key, ideally on a different host, that recomputes the manifest and signs only on an exact match. No human signs per cycle by default.

Until these are signed, every revision-58 requirement stays recorded as spec-phase text that later work packages build and test against, but the signer service refuses to produce any live signature for autonomous operation, the open router, chunked-payout activation, or the distribution-signer/verifier path.

## Phase 1 token issuance decision

The owner approved the following production token parameters on 30 August 2026:

- HKMN is created through the officially bound Programmable Launchpad mechanism.
- Fixed total supply: `420,690,000,000 HKMN`.
- Decimals: `18` when supported by the official Launchpad mechanism; otherwise the mechanism's mandatory canonical value becomes the binding value and requires compatibility evidence before release.
- Initial allocation: `90%` to the canonical USDG/HKMN market and `10%` to treasury.
- The 90 percent canonical-market launch position is permanently non-transferable and non-withdrawable by every project role.
- The canonical PoolKey LP fee is zero. Only the approved inclusive 3.00 percent Hookemon hook fee applies.
- No presale, no other initial allocation, and no post-initialization minting.
- The treasury allocation uses an officially supported, evidence-bound lock or vesting mechanism. If no such mechanism is available, the treasury allocation remains undistributed rather than becoming freely transferable.

## Phase 1 emergency-claim timing decision

Status: `SUPERSEDED_BY_REVISION_53`.

The owner approved one uniform emergency-claim boundary for every unpaid entitlement:

- Automatic settlement may begin immediately after a payout becomes ready.
- Emergency self-service claims remain unavailable until exactly `payoutReadyAt + 300 seconds`.
- An explicit automatic-transfer failure does not shorten or reset that boundary.
- At and after the boundary, an unpaid entitlement is claimable exactly once and never expires.
- Automatic settlement, emergency claiming, and replacement processing share one paid/unpaid state so the same entitlement can never be transferred twice.

## Phase 1 replacement-recipient decision

Status: `SUPERSEDED_BY_REVISION_53`.

The owner approved a manual support process instead of holder-signed replacement authorization:

- A holder contacts the owner outside the protocol when payment to the current recipient has explicitly failed.
- The owner coordinates the manual support decision, and the current admin role is the only onchain caller that records the replacement wallet.
- No holder signature is required by the Phase 1 contract.
- Replacement is permitted only while the entitlement is explicitly failed and unpaid.
- Replacement preserves the original entitlement identity and amount.
- Every replacement records the old and new recipient, payout identifier, leaf identity, and acting admin in a complete event.
- Paid entitlements can never be replaced or paid again.
- If a replacement recipient also fails while the entitlement remains unpaid, the same controlled and fully emitted process may set another replacement.
- Replacement is scoped to one exact entitlement identified by origin cycle, payout identifier, and leaf identity; it is never a global wallet mapping.
- The owner, holder, and current admin can inspect the original recipient, current recipient, amount, and paid/failed/unpaid status for that exact entitlement before the current admin records a replacement.
- After replacement, only the current recipient can access or receive that exact unpaid entitlement; the previous recipient loses access to it.
- The replacement affects no other payout from the same cycle and no past or future cycle.
- Phase 1 stores and emits the complete data needed by a later admin product, but no dashboard or support UI is part of Phase 1.
- Phase 1 exposes read-only onchain state and complete events so the original and current recipient can independently verify the replacement, entitlement identity, amount, and payment status.
- A holder-facing verification interface is deliberately deferred to Product Phase 3; Product Phase 2 does not gain UI scope from this decision.

## Phase 1 unsolicited-USDG decision

Status: `SUPERSEDED_BY_REVISION_53`.

The owner approved treasury recovery for USDG sent directly to the hook without a recognized accounting operation:

- A direct USDG transfer does not create a fee liability, process-budget balance, payout, or entitlement.
- Recoverable surplus is limited to the hook's actual USDG balance minus every recorded Programmable, treasury, process-budget, and funded-payout liability.
- Only a positive, mathematically proven surplus may be recovered.
- Only the current treasury role may initiate surplus recovery.
- Recovery always pays the current treasury; it cannot choose an arbitrary recipient.
- Recovery must leave every recorded liability fully funded and emits the recovered amount and resulting solvency totals.

## Phase 1 role matrix decision

Status: `SUPERSEDED_BY_REVISION_53`.

The owner approved the following bounded role matrix:

- The immutable Programmable beneficiary can claim only the accrued `0.10%` Programmable liability.
- The current treasury receives only its accrued `0.40%` liabilities and mathematically proven unsolicited-USDG surplus, and it is the only role allowed to initiate surplus recovery.
- The admin can manage two-step admin and treasury transitions, change operations and automation wallets, pause or resume new process-budget releases, and replace the recipient of one explicitly failed and unpaid entitlement.
- The operations role can record or change the Product Phase 2 specification hash, policy hash, and cap after the corresponding owner approval is recorded in offchain release evidence, release fully accrued process budget to the current operations wallet within that active cap and complete frozen commitment, and atomically fund payout commitments from that same operations wallet.
- The automation role can execute only already funded entitlement settlement.
- A current entitlement recipient can claim only its own unpaid entitlement at or after the uniform 300-second boundary.
- No role can redirect another liability class, alter historical beneficiary ownership, withdraw funded payout money, change the immutable Programmable share or beneficiary, or pay an entitlement twice.
- Admin and treasury transfers use proposal and acceptance by the proposed nonzero address. Operations and automation changes are immediate, event-complete, and affect only future actions.

## Phase 1 operational-authority default decision

Status: `SUPERSEDED_BY_REVISION_53`.

The owner approved the current operations wallet as the default authority for previously unassigned operational cycle actions:

- Only the current operations wallet may fund and create an immutable payout commitment, and the USDG payer must be that same current operations wallet.
- Only the current operations wallet may record or change the process-release specification hash, policy hash, and cap. Fresh Product Phase 2 specification and exact owner approval are mandatory offchain release prerequisites; the hook authenticates the operations wallet and records the submitted tuple but does not claim to verify a repository approval artifact or an unapproved owner-signature scheme onchain.
- Every process-budget release pays the current operations wallet; a separate or arbitrary release destination is not permitted.
- This default never overrides an explicitly assigned authority: treasury-only recovery, admin role management and recipient replacement, automation-only settlement, Programmable fee claims, and recipient emergency claims remain unchanged.
- Operations rotation affects only future policy activation, releases, and payout funding. It never rewrites a completed release, funded payout, historical liability, or entitlement.

## Phase 1 immutable-successor decision

The owner approved a no-migration lifecycle for an immutable production deployment:

- The production hook has no in-place upgrade, proxy migration, delegatecall replacement, or state-import path.
- A successor is a separate deployment created only under a new specification, provider binding, review, and owner approval.
- The original hook remains available indefinitely for its historical fee claims, funded payouts, and unpaid holder claims.
- Historical balances, liabilities, payout identifiers, and entitlement state are never copied or moved into a successor.
- A successor handles only newly bound activity; a later product interface may display old and new deployments together.
- A disposable canary can never be promoted or relabeled as the production deployment.

## Specification phase boundary decision

Requirements revision 57 opens only the approved local Phase 2 manual cycle-control increment. All other Product Phase 2 ideas and every later behavior remain non-operative unless a fresh requirement and owner approval make them authoritative. Product Phase 2 does not inherit future behavior merely because it appears in an earlier discussion or a non-operative future-decision note.

Concrete provider addresses, interfaces, runtime hashes, deployment actions, signing, broadcasts, launches, and spending require their separately defined evidence or authorization.

Future product choices that do not affect Phase 1 are recorded outside the normative Phase 1 artifacts and remain closed until their phase opens explicitly.
