# Native reward recipient restoration

Status: owner-approved compatibility contract. The owner answered "ja" to the explicit approval question for this contract and its proposed spec revision on 2026-09-09 in task 01a083d9-313d-7511-b041-5a9630e6b6a1. Implementation is in progress; this is not deployment evidence.

Baseline: origin/main `20eb8e4e`, requirements revision 71. Historical selection references: `07203cd64892ca3620bc4cdb960d38f9ad9f0dd0` and `69f8b71c`. The accompanying `requirements.patch` records the approved revision 72 and changes only REQ-dashboard-2, REQ-cycle-runner-3, REQ-eligibility-snapshot-1 and REQ-direct-payout-1. The same four approved requirement deltas are applied after native revision 73 as revision 74; the original approval patch remains unchanged.

## Financial compatibility

New operator settings accept exactly the integers 100 through 1000 in increments of 100, defaulting to 200. Remove excluded addresses and nonpositive balances before ranking by descending finalized direct HKMN balance, then normalized address ascending. Select min(N, eligibleCount), and serialize the selected entries in canonical address order. The selected count is independent of the configured limit and the number of positive or finalized payments.

The historical system ranked time-weighted balances and used largest-remainder redistribution. The current native system uses finalized direct balances and floor-and-carry dust. This proposal restores the selection semantics while preserving those native weight and rounding rules. It does not restore historical contracts, batches, token identities or signing policies.

For distributable native principal P (attributed finalized return plus permitted prior dust), each selected holder receives floor(P * balance / selectedBalanceTotal). The remainder stays in the existing durable dust mechanism. Unselected balances contribute neither to this denominator nor to payout liabilities. A selected holder whose allocation rounds to zero remains selected and receives no value transfer.

A small arithmetic example illustrates the rule, not an allowed selector value: eligible balances 60, 30 and 10, with the first two selected and P=100, produce 66 and 33, with dust 1. The historical largest-remainder result 67 and 33 is deliberately not imported. For an allowed N=100 example, 101 equal eligible balances and P=101 produce 100 allocations of 1 and dust 1; the highest normalized address is unselected.

Full holder replay, launch supply, exclusions, both log sources and snapshot hash recheck remain prerequisites. Selection evidence must reconstruct the complete eligible list and verify:

- selectedBalanceTotal + unselectedEligibleBalanceTotal = fullEligibleBalanceTotal;
- fullEligibleBalanceTotal + excludedBalanceTotal = frozen supply;
- selectedCount = min(rewardRecipientLimit, fullEligibleCount);
- selected entries equal the deterministic top N of the complete positive non-excluded list.

The excluded total must be bound to the full validated holder snapshot, not fabricated from an unexplained residual. Retain enough canonical full-snapshot data to recompute holderSnapshotDigest. A digest supplied alongside a manipulated list is not proof. Full-holder evidence remains subject to storage limits independently of the 1000-recipient selected limit; an oversized full replay must fail before claim or use the existing verified content-addressed storage path.

## Versioned contracts

PR52 already reserves operator configuration v5 for pack plans. After its integration, add `hookemon.operator-configuration.v6` with required rewardRecipientLimit. Migrate validated native v4/v5 operator settings through the supported state-file/CAS path, preserving pack plan, pause/live flags, caps, revision semantics and all other fields. Set 200 only for the migrated future-cycle setting. Do not migrate pre-native v1/v2/v3 money state into execution.

Define `hookemon.reward-selection-snapshot.v1` with exact fields schema, cycleId, configurationRevision, rewardRecipientLimit and digest. Digest the canonical payload excluding digest, using the schema as its domain. Atomically include rewardSelection in cycle-opened. The repository validates its digest and cycle identity during creation and replay. Scheduler creation reads one authoritative configuration snapshot; eligibility receives the persisted cycle snapshot. No mutation or resume path reads today's operator limit for an existing cycle.

Add `hookemon.eligibility-payout-manifest.v2` for selected cycles. Keep the v1 fields and add selection evidence containing the frozen policy, full validated holder snapshot, eligibleCount, selectedCount, selectedBalanceTotal, unselectedEligibleBalanceTotal, excludedBalanceTotal and a digest. Its digest binds cycle identity, frozen policy, full snapshot digest and selected entries. Validate exact fields, all balances' chain/asset/decimals, counts, exclusions, rank order and supply equations by recomputation. The top-level entries are the selected set, in address order. Feasibility is evaluated against that set conservatively, including zero-rounded recipients before their final proceeds are known. Insufficient gas or transaction capacity holds the cycle; it never shrinks N further.

Selected cycles compile `hookemon.direct-payout-plan.v3`, including selection evidence in plan.eligibility and therefore planDigest. Native payout reconstruction must carry the full selection evidence and rebuild the v2 manifest; it must not reconstruct a v1 manifest from allocations and silently lose policy evidence. Supplementary selected-cycle plans use `hookemon.supplementary-direct-payout-plan.v3` and retain the original cycle selection.

Historical native cycle-opened events with no rewardSelection keep all-holder behavior. Historical eligibility v1, direct payout v2 and supplementary v2 retain identical serialization, digest, recipients, amounts and recovery. Missing historical fields never imply 200. Signed/finalized plans and old journals are not rewritten. The public/private projections show null or an explicit all-holder label when a historic configured limit is absent.

## Dashboard and local service

The backend exports one canonical option list. The authenticated decision path accepts only a valid integer and a current revision, persists through the existing operator control boundary and returns authoritative state. The UI separates the editable next-cycle choice, confirmed saved value and active-cycle frozen value. Failed, stale or unreadable results remain visibly unsuccessful; readback is required before success.

Extend the existing paused local wrapper narrowly to accept rewardRecipientLimit as well as its pack-plan fields. Keep paused=true, executionPaused=true, liveMode=false and refusal of execution commands. Rebuild only the reviewed dashboard image after backing up the mounted operator state. Preserve the production runner and credentials outside the image. Verify HTTPS bootstrap and save/load/restart separately from production execution readiness.

## Ownership and exact planned write set

Canonical ledger CLI cwd: `.worktrees/instruction-alignment-20260908` under the launch-repair repository; resolved ledger: `.v4` at that repository root. Task REWARD-RECIPIENT-RESTORE-20260909 is claimed by reward-recipient-coordinator with token 1. Worktree: `.worktrees/reward-recipient-restore-20260909` under launch-repair, branch `codex/reward-recipient-restore-20260909`.

The main coordinator transferred implementation and integration-preparation ownership of PR52, PR54, PR50, PR56 and PR53 after the dashboard task was archived. Their published heads have been integrated as dependencies, and the canonical coordinator retains the serial main merge queue. PR59 remains independent. The approved source changes below are implemented in PR60; native EVM acceptance, current required CI and local deployment are tracked separately.

The implementation source write set is:

- `specs/requirements.json` through the reviewed revision, and supported task-binding/evidence outputs only through the CLI;
- `packages/runner/src/config/reward-recipient-selection.mjs` (new shared policy), `config/state-schema.mjs`, `operator/state-file.mjs`, `operator/control.mjs`;
- `packages/runner/src/automation/reward-selection-snapshot.mjs` (new), `automation/automated-cycle-service.mjs`;
- `packages/runner/src/distribution/snapshot-indexer.mjs`, `distribution/pro-rata.mjs`, `distribution/payout-plan.mjs`;
- `packages/adapters/src/app/compose.mjs`, `app/cycle-repository.mjs`, `app/stage-driver.mjs`, `app/stages/eligibility-snapshot.mjs`, `app/stages/payout.mjs`, `app/stages/supplementary-payout.mjs`;
- `packages/dashboard/src/contracts/operator-contracts.mjs`, `projections/operator-projection.mjs`, `projections/cycle-status-projection.mjs`, `projections/community-snapshot-projection.mjs`, `public/index.html`; the existing decision route only if current generic authenticated routing requires a field allowlist change;
- corresponding focused tests under runner config/operator/automation/distribution, adapters app/native, and dashboard contracts/projections/routes/public; new isolated native selection acceptance harness and vectors under `packages/adapters/test/native/`;
- affected `docs/modules/{operator-controls,cycle-repository,eligibility-snapshot,direct-payout,automation,composition-root,dashboard}.md` cards;
- the local wrapper `.session/local-dashboard.mjs`, Docker build copy `.session/docker-dashboard/app/.session/local-dashboard.mjs` and Docker build context in the dashboard-post-test worktree, only after explicit coordinator handoff. These local deployment files are not part of the source PR.

The restoration itself changes no Solidity or signing policy. Native release and pack-plan dependencies carry their separately reviewed contract, release and CI updates; the restoration refreshes only the resulting exact requirement and control bindings. Two demonstrated `apps/web` active-cycle null-compatibility fixes affect `app/operator/OperatorControlPanel.tsx` and `app/operator/operator-types.ts`. The local wrapper delegates to the new tested `packages/dashboard/src/local-selection-policy.mjs` guard.

## Authority and requirement binding

The owner's pasted request establishes the selectable count and preservation of native payment boundaries. The owner approved the direct-balance interpretation, native floor-and-carry preservation and version/migration contract under R2; `owner-approval.md` records the exact source. Bind the restoration task and tests to the four requirements at the applied revision through supported ledger tools; this remains canonical coordinator work, not a manual projection edit.

Task creation persisted and claim readback succeeded, but task projection reports the existing historical completion commit 34fc4006e3f05a60d6a3cd9fc8383b445330aa62 as unreachable from the coordinator HEAD. This proposal does not repair unrelated history, edit generated projections or fabricate a completion. Binding and completion must use a coordinator state where the supported checks succeed.

The complete task also requires actual native EVM execution, independent final money-path review, current required CI, serial authorized merge and the reviewed local dashboard deployment. None of those is established by this proposal or by the existing capacity tests.
