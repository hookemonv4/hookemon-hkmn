# Phase 2 autonomous rebuild: handoff and execution plan

Status date: 2026-09-02. Integration branch: `codex/phase2-autonomous` (mirrors the session branch `claude/dynamic-workflow-token-097109`). This document lets the owner or any engineer continue the rebuild without the original session. All audit, design, and package artifacts live under `docs/audit/2026-09-02/`.

Update 2026-09-03: execution status, open problems, the remaining packages and the launch procedure are maintained in `2026-09-03-phase2-status-and-continuation.md`; this document keeps the owner decisions, the package loop and the CI explanation.

## 1. Owner target and confirmed decisions

Target: community token HKMN on Robinhood Chain (4663) launched through the Programmable launchpad; 3.00% inclusive swap fee on the canonical USDG/HKMN pool; a fully autonomous loop every N minutes (default 20, dashboard-editable): buy one Collector Crypt pack from the process budget, open it, sell the card through the Collector Crypt standard buyback, bridge proceeds back to Robinhood USDG, pay HKMN holders pro rata; a dashboard for pack choice, interval, pause, stuck-cycle recovery, and a public status page on hookemon.com.

Owner confirmations (chat, 2026-09-02):

- "Bybit" in the transcript means the Collector Crypt buyback. No exchange integration.
- Fee split of the 3.00%: 0.40% treasury, 0.10% Programmable, 2.50% process budget (packs). Already implemented.
- Router opening approved: any wallet or router may swap; the fee is enforced inside the hook; hookData is optional (WP-05).

Decisions taken by the coordinator (change only with a new owner decision): D1 rev57 task ids stay canonical; D3 local keychain-backed signer behind the injected signer client first; D4 first live caps one 25 Circle USD pack per cycle, at most 72 cycles per day; D5 chunked payouts built but inactive (chunk count 1); D6 rounding dust carries forward; D7 distribution approval stays automated with a second independent verifier process holding its own key (no manual signature per cycle); D8 no new on-chain pause role; D10 placeholders for remainder custody and LBP curve, labeled PLACEHOLDER_OWNER_DECISION; D11 protocol-fee monitoring only. Full rationale: `docs/audit/2026-09-02/design/DESIGN.md`.

## 2. State of the integration branch

Merged packages (see `docs/audit/2026-09-02/design/PLAN.json` for scope): WP-01 (rev57 merge base, Foundry CI fix, fee event), WP-02 (cumulative fee remainders, 1000-unit minimum revert), WP-03 (vault DEGRADED quarantine, dust fast path, expiry renewal test), WP-04 (payout sentinel fix, TREE_WIDTH literal, chunked payouts gated to the vault authorizer), WP-06 (packages/adapters scaffold with pinned viem and @solana/web3.js, operator configuration schema, policy-wallet schema), WP-11 (holder snapshot indexer from Transfer logs), WP-25 (phase-2 readiness probe and binding drift check; the repo-pinned Universal Router 0x06afBA43fd06227fA663b0dAeCF536F6eaA6BF99 is the live one), WP-27 (disk-backed durable cycle store), plus the hotfix that restored the six-section vault card and clean-room wording. The operator configuration schema names USDG micro units; the previous currency vocabulary is rejected by the clean-room scanner.

Verified on the integrated head: forge test --ffi 215/215; runner tests 168/168; fixture verification passes. Control-script tests: 382/387, the five failures are process artifacts, not code (see section 5).

In flight when this document was written (worktrees under `<main-checkout>/.worktrees/p2-wp-NN`, branches `codex/p2-wp-NN`): WP-29 reducer production model, WP-21 requirements revision 58 plus ADR-0021 and unsigned owner-approval drafts, WP-12 pro-rata manifest compiler, WP-13 automated distribution verifier service, WP-05 router opening plus Programmable owner pin, WP-23 end-to-end fixtures, WP-08 Collector Crypt adapter, WP-09 Relay adapter. If a worktree contains an uncommitted or unreviewed result, treat it as a resume point, not as done.

Remaining groups after that: group 4 (WP-07 automation port, WP-10 Robinhood and Solana RPC adapters, WP-19 submission.json and launch plan, WP-20 custom launcher strategy plus HKMN issuance wiring plus CREATE2 mining, WP-24 anvil fork tests, WP-28 PegCycleRouteExecutor contract), group 5 (WP-14 scheduler and cycle worker, WP-15 settlement worker), group 6 (WP-16 observability and protocol-fee monitor), group 7 (WP-17 dashboard control service serving the hookemon.com contracts), group 8 (WP-18 website port and wiring, WP-22 module cards, README, PRD, registry updates), group 9 (WP-26 red-team refresh at revision 58).

## 3. How to execute a package (the loop the session used)

1. Create a worktree from the integration head: `git worktree add <main-checkout>/.worktrees/p2-wp-NN -b codex/p2-wp-NN <head>`; for contract packages initialize submodules (`git submodule update --init` for v4-core and v4-periphery, then v4-core recursive and v4-periphery lib/permit2).
2. Give one implementer (Sonnet) the package file `docs/audit/2026-09-02/packages/WP-NN.json`, the design document, the findings report, `AGENTS.md`, and the coordinator directives (section 4). It must stay inside the package's writeSet, add tests first, run the package tests and the broader suites (`forge test --ffi` for contracts, `node --test` for runner and scripts), and commit exactly once with the repo identity, an English single-line message, and no trailers.
3. Give a fresh, independent reviewer (Sonnet) the same inputs plus the diff; it re-runs the tests itself and returns APPROVE or CHANGES_REQUIRED with file:line items. R3 and R4 packages always get this review before merge; one fix round, then re-review.
4. Merge approved branches serially into the integration branch with `git merge --no-ff`; if only `docs/modules/index.json` conflicts, run `node docs/audit/2026-09-02/tools/sync-module-index.mjs <repo>` and commit (`docs/audit/2026-09-02/tools/merge-group.sh` automates both).
5. Run the baselines once on the merged head, remove the merged worktree, fast-forward the remaining worktrees, start the next group.

Groups run in dependency order; packages inside a group have disjoint write sets and may run in parallel. Delete `packages/contracts/out` and `cache` and any `node_modules` in finished worktrees; the machine ran out of disk twice during this session.

## 4. Coordinator directives for every package

- Repository rules from `AGENTS.md` apply unchanged: English git surface, one commit per package, no trailers, never edit `receipts/`, `STATE.md`, `state.json`, `tasks.json`, `gates/runs/*`; never run ledger commands from a worktree; never sign, broadcast, deploy, spend, or read secrets.
- `packages/contracts` and `packages/runner` stay dependency-free (Node 24 builtins). Only `packages/adapters` carries npm dependencies (pinned, lockfile committed, `npm ci --ignore-scripts`). `packages/dashboard` uses `node:http` and `node:sqlite` only.
- The public Robinhood RPC serves state only at `latest`; reads at `finalized`, `safe`, or older blocks fail. Read at latest with the block hash recorded and re-confirm after finality, or configure an archive RPC. Never require the `finalized` tag.
- New module cards use the R1 six-section format. Gate A6 couples `docs/modules/index.json`, `architecture/capability-map.json` (modules and topologicalOrder), and `specs/requirements.json` revisions; gate I6 lists every card in `gates/init.json`. WP-21 and WP-22 register cards; other packages leave the registries alone and list the card as pending.
- Legacy code on `codex/mainnet-cycle-canary` informs technique only; re-implement clean-room in new paths; copy no historical EVM L1 or Circle transfer protocol addresses.

## 5. Pull requests and continuous integration

Why the three draft PRs on the GitHub repository (see `git remote -v`) are red:

- PR #1 (vendored swap-integration skill): red because main's workflow expects the Foundry version string `1.7.1-stable` while forge prints `1.7.1`, and it would stay red afterwards because the vendored third-party document uses retired-architecture chain names that `scripts/check-cleanroom.mjs` rejects. Close PR #1; install the skill locally in the agent environment instead of vendoring it into this clean-room tree.
- PR #2 (Foundry version fix): the fix is correct and is included in WP-01, but after it CI reaches `node scripts/v4.mjs status --check`, which recomputes every gate as STALE because `policy/policy.json` changed after the gate receipts were recorded. Close PR #2 as superseded.
- PR #3 (evidence refresh): re-records evidence at revision 56 and leaves the red-team gate FAILED by design, so `status --check` exits nonzero. The integration branch moves to revision 57 and 58, which makes that evidence stale again. Close PR #3; its approach (re-recording gates) is repeated on the integration branch in the step below.

Making CI green requires one process step that only works from the main checkout with the ledger (`<main-checkout>/.v4/ledger.db`) and the owner's approvals, because the gate receipts must be re-recorded against the current `policy/policy.json` and requirements revision:

1. Merge or check out the integration branch in the main checkout.
2. Run `node scripts/v4.mjs gate check init`, then `spec`, `architecture`, `feasibility`, `redteam`, `tasks`, `build`, `ship`. Each check writes a new receipt.
3. Where an item cannot pass yet (feasibility F3 production bindings, red-team R4 open findings until WP-26 lands, ship H1/H2/H4), record an owner override with `node scripts/v4.mjs gate override <phase> --rationale "..." --approval decisions/owner-approvals/<file>.json`; the approval files must carry the current `policy/policy.json` hash and the phrase `OWNER APPROVED` as the token, exactly like the revision-56 local-closure overrides.
4. Commit the new receipts together with the regenerated `STATE.md` and `state.json` (run `node scripts/v4.mjs status`), then `node scripts/v4.mjs status --check` exits 0 and the CI step passes.
5. The remaining red control-script tests: `delivery-boundary` (P1-011 deferral bound to the revision-56 requirements hash) and `phase1-release` and `phase1-reproducibility` (stale `release/phase1/local-candidate.json` hashes). WP-21 rebinds the deferral and the delivery boundary for revision 58; WP-22 regenerates the release candidate manifest. Until then these tests stay red for process reasons, not code.

Order for the owner: close #1, #2, #3; open the draft PR for `codex/phase2-autonomous`; merge it only after the gate re-recording above and after groups 4 to 9 land (or merge it as the new base and continue on top, which is what the session did).

## 6. Website and dashboard wiring

The live site https://hookemon.com is a Cloudflare Worker (source only on `codex/mainnet-cycle-canary` under `apps/web`). It already calls `/api/cycle-status` and `/api/community-dashboard`, which the Worker proxies to `PUBLIC_CYCLE_STATUS_URL` and `PUBLIC_COMMUNITY_SNAPSHOT_URL`, and `/operator/api/*`, which it proxies to `OPERATOR_CONTROL_SERVICE_URL` with `OPERATOR_CONTROL_PROXY_CREDENTIAL` and a Cloudflare Access JWT. The old backend is gone, so the page shows "Connecting" today. `/dashboard` returns 404; the cycle tracker lives on the start page and the operator console under `/operator`.

Plan: WP-17 builds `packages/dashboard` as the control service that serves exactly those contracts (validators in `apps/web/lib/public-cycle-status.ts` and `public-community-snapshot.ts`, schemaVersion 3 and 5). WP-18 ports `apps/web` into a standalone repository directory, updates the network profile to Robinhood Chain 4663 and the copy to USDG and pro-rata payouts, and documents the five Worker secrets. Owner actions after that: create the GitHub repository for the site, deploy the control service to a host with HTTPS, set the five Worker secrets, run the manual deploy workflow.

## 7. Launch gating

Nothing runs live until all of these hold: Programmable's Robinhood profile reports readiness available (today it is planned and unavailable at https://api.programmable.market/v4/chains/4663/capabilities); the owner supplies the Collector Crypt API key, RPC endpoints, and signer credentials outside the repository; ADR-0021 and the revision-58 owner approvals are signed; the readiness probe `node scripts/verify-phase2-readiness.mjs` reports every precondition PASSED; the scheduler ran a full dry-run cycle; a capped live canary (one pack) completed and reconciled. Only then set `liveMode` to true in the operator configuration.

## 8. Artifacts

- Audit: `docs/audit/2026-09-02/FINDINGS_REPORT.md`, `findings-final.json`, `summaries/*.json` (one per module, branch, and external-fact check).
- Design and plan: `docs/audit/2026-09-02/design/DESIGN.md`, `PLAN.json`, the three candidate designs.
- Package definitions: `docs/audit/2026-09-02/packages/WP-01.json` to `WP-29.json`.
- Tools: `docs/audit/2026-09-02/tools/merge-group.sh`, `sync-module-index.mjs`.
