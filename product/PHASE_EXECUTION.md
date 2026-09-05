# Hookemon Delivery Program

Status: `CURRENT_REQUIREMENTS_REVISION_57_ARCHITECTURE_5`

## Objective

Deliver the smallest complete production loop: canonical HKMN purchase, exact fee split, process release, one manually started fixed cross-chain Solana Collector pack/open/buyback cycle, actual USDG return, sum-bound payout funding, at least one permissionless holder payment, and final reconciliation.

The authoritative capability and task topology is `architecture/execution-topology.md`. This record fixes the program boundary and handoff rule; it does not create task-ledger entries or authorize implementation or external actions.

Phase 2 and Phase 3 tasks are not created until their start gates pass.

## Fresh-context hierarchy

Phase 1 uses one fresh visible `P1 — Build Coordinator` task. The coordinator owns ledger state, path reservations, gates, review routing, and serial integration but no production implementation.

Fresh visible worker tasks are created in dependency waves:

1. Interface & Storage Base;
2. Provider & Binding;
3. Onchain Kernel, as the only writer for the complete onchain source root;
4. Cycle, Distribution & Payment Worker;
5. Independent Security, with no production write authority;
6. Release Integration, as the only writer during final composition.

Each worker owns one clean worktree, `codex/` branch, Draft pull request, and exclusive path set. A worker may use one level of internal source-research, blind-test, or fresh-review subagents. It may not delegate a second production writer into its paths.

## Merge points

1. Feasibility binds real providers and freezes interfaces; Red-team closes every critical and high finding.
2. Interface & Storage Base merges before implementation workstreams consume shared surfaces.
3. Provider & Binding merges before cycle code consumes real transaction schemas.
4. Onchain Kernel merges as one reviewed source closure.
5. Cycle, Distribution & Payment Worker merges against the real ABI and provider bindings.
6. Independent Security closes conformance and adversarial evidence; production fixes return to their owning workstream.
7. Release Integration alone composes and proves the complete local or fork path.
8. A live cycle remains a separate ask-first action with exact owner-authorized API mutations, signatures, broadcasts, amounts, destinations, minimum receives, and per-chain caps.

After every merge, every waiting branch integrates current `origin/main`, resolves conflicts semantically, and reruns its checks. Shared configuration, dependencies, CI, storage layout, root routing, ledger projections, and final composition change serially.

## Scope boundary

Phase 1 contains no dashboard or UI, generic route discovery, route optimization, quote engine, automatic conversion retry, multiple packs, scheduling, continuous or unattended operation, catalog persistence, ranking, LP weighting, marketplace policy, batch settlement, delayed claim, recipient replacement, surplus withdrawal, administrator, automation role, pause, proxy, or migration path.

Provider research, fixtures, independent tests, and runner tooling may proceed in parallel only when their write sets and frozen inputs do not overlap. Onchain implementation remains one workstream because the hook shares storage, USDG custody, solvency, and reentrancy boundaries.

## Phase 2 restart

Product Phase 2 does not continue this requirements document by implication. It starts with a fresh specification interview, a new requirements revision, new architecture, and exact owner approval. Reversible website, dashboard, and offchain product behavior may then evolve without silently changing the immutable Phase 1 contract.

## Hard stops

External writes, credential or secret access, API mutations, signing, broadcast, deployment, and spending require exact action-specific owner approval. Missing official provider evidence, unresolved journal state, overlapping write ownership, a dirty base, failed required checks, non-positive size or gas headroom, or an open critical or high finding stops the affected path.
