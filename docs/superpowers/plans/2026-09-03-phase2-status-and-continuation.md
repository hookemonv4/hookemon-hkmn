# Phase 2 status and continuation plan (2026-09-03)

This document supersedes the execution sections of `2026-09-02-phase2-autonomous-handoff.md` (its owner decisions, package loop and CI explanation still apply). It is written so that the owner or any engineer can continue without the original session. Package definitions live in `docs/audit/2026-09-02/packages/WP-01.json` to `WP-39.json`; the merge helper is `docs/audit/2026-09-02/tools/merge-group.sh`.

## 1. Where things stand

- Integration branch `codex/phase2-autonomous` (draft PR #4 on the GitHub repository, see `git remote -v`), head `e4f6638` on 2026-09-03 afternoon. Session branch `claude/dynamic-workflow-token-097109` mirrors it.
- Merged: every package WP-01 to WP-40 (WP-22 registries and owner closeout, WP-38 dual-signature payout, WP-39 off-chain typed-data signatures and operations-trigger role, WP-40 Phase 2 release candidate). No worktrees are open.
- Local verification on the head: `forge test --ffi` 255/255, runner 388/388, adapters 405/405 (1 network-gated skip), dashboard 115/115, control scripts 412/412, clean-room scanner clean, release verifier PASS, reproducibility report bound to the source commit.
- CI on PR #4 stays red only until the owner closeout (section 5 and section 9) is committed: the gate receipts and the P1-011 deferral rebind. Everything else CI runs is green locally.
- The website source is a standalone repository directory at `<main-checkout>/.worktrees/hookemon-web` (branch `main`, 189 site tests green, Robinhood Chain 4663 profile, USDG vocabulary, README with the five Worker secrets and a deploy runbook). It is not yet on GitHub and not deployed.
## 2. What works and what does not

Works, proven by tests against injected fake transports (no network, no keys):

- Hook fee split 2.50 / 0.40 / 0.10 of 3.00 percent with cumulative remainders, any router, optional hookData; treasury and Programmable claims.
- Vault lifecycle with per-cycle escrow, DEGRADED quarantine, dust fast path, chunked payouts (inactive), permissionless non-expiring `payEntitlement`.
- Runner: scheduler (interval, pause, liveMode re-read every tick), automation service with budget gate and exclusive lease, durable journal store, CycleRunner with fixture and production evidence profiles, pro-rata compiler, holder snapshot from transfer logs, distribution signer and separate verifier process, settlement worker.
- Composition: `packages/adapters/bin/hookemon-runner.mjs` (`run`, `tick`, `dry-run`, `status`, `--no-dashboard`) starts scheduler and dashboard in one process; `hookemon-verifier.mjs` is the separate verifier process; `hookemon-authority.mjs` prints and verifies the owner standing-authority document.
- All eight live stages run end to end in `packages/adapters/test/app/compose.test.mjs` with fake transports: funding, outbound bridge, pack purchase, open (card mint from the Solana transaction token balances), buyback, return bridge, distribution (two-pass with the verifier process), payout. With `liveMode` false no code path reaches sign or broadcast.
- Dashboard control service (`packages/dashboard`): public endpoints in the website contract shapes, operator routes behind a proxy credential and optional Cloudflare Access JWT, hash-chained audit log, restart and run-now decisions reaching the live scheduler.

Does not work yet or is unverified:

- Live mode against real networks has never run. Every external fact that could not be confirmed (Collector Crypt program ids, Relay deposit target, HKMN address) is a validated configuration value, not a guess.
- Red-team revision 58 found two critical and two medium findings in the payout path (section 3). WP-38 and WP-39 addressed them in code; the findings stay recorded as open until a fresh red-team pass re-verifies them.
- Programmable reports Robinhood Chain 4663 as `readiness.status: unavailable` (section 6). No launch through Programmable is possible until that flips.
- The private operator console inside the website still speaks the legacy decision model; the backend maps it with documented placeholders. The public pages are wired correctly.

## 3. Open problems and their fixes

| Problem | Source | Fix | Status |
| --- | --- | --- | --- |
| Vault accepts a payout authorization from the authorizer alone; one compromised worker key could commit an arbitrary payout root | RT-R58-01 (critical) | WP-38: vault requires two EIP-712 signatures from immutable distribution signer and verifier addresses | merged, re-verification by red-team open |
| Off-chain manifest verification uses hardcoded keys whose private halves are test fixtures | RT-R58-02 (critical) | WP-39: production identities from configuration, fixture keys only under the fixture profile | merged, re-verification open |
| Only one EVM signer role exists, but the vault requires operations trigger != authorizer, so no live cycle can complete | RT-R58-03 (medium) | WP-39: operations-trigger role as a second EVM identity | merged |
| `acceptDegraded` is trusted from the worker | RT-R58-04 (medium) | WP-39: only with a scoped owner standing authority; dashboard exposes it as an owner action | merged |
| Holder snapshot did not exclude pool, treasury and prior escrows | RT-R58-08 | WP-37 merged; RT-R58-08 marked RESOLVED by WP-22 | done |
| Carried findings RT-R58-05/06/07 (revision 55: production bindings, live confirmation) | red-team | blocked on Programmable readiness and the live canary | open by design |
| Two control tests red (release candidate hashes) | process | WP-40 surface policy plus `scripts/release/build-local-candidate.mjs` regenerate the candidate | done |
| Module cards unregistered (A6 coupling) | process | WP-22 registered 31 runtime cards; tooling cards stay in `gates/init.json` | done |
| P1-011 deferral bound to requirements revision 56 | process | owner-authorized closeout in progress (section 9) | in progress |
| CI red on PR #4 | process | gate re-recording in progress (section 9) | in progress |
| Website links to a legacy GitHub repository name | WP-18 report | replace with the new site repository once it exists | owner |

How far this set the plan back: the original plan had 29 packages; reviews and the red-team added eleven (WP-30 to WP-40) because the runner was fixture-only, the payout path needed real two-key enforcement and the release verifier only knew Phase 1. None of the merged work is discarded. Remaining engineering: none required before the intermediate green state. Optional, owner decision: WP-41 rehearsal harness (one command runs a full cycle on a local fork with fake services), WP-42 verifier independence (the verifier re-reads holder balances from chain instead of trusting the requester inputs), WP-43 hold-above-cap policy for cards the Collector Crypt buyback cannot pay in full.

## 4. Remaining packages and how to run them without this session

No package is open. Optional packages WP-41, WP-42 and WP-43 (section 3) would follow the same loop; their definitions are written when the owner decides.

Loop for one package (from `2026-09-02-phase2-autonomous-handoff.md` section 3, unchanged):

1. `git worktree add <main-checkout>/.worktrees/p2-wp-NN -b codex/p2-wp-NN <integration-head>`; for contract packages run `git submodule update --init` and then the nested v4-core and v4-periphery submodules.
2. Give an implementer the package file, `AGENTS.md`, the design document and the coordinator notes inside the package file; it commits exactly once with the repo identity and an English single-line message.
3. Give a fresh reviewer the same inputs plus the diff; one fix round on CHANGES_REQUIRED.
4. Merge with `docs/audit/2026-09-02/tools/merge-group.sh <integration-worktree> codex/p2-wp-NN`; register any new `docs/modules/*.md` card in `gates/init.json` I6 lists in tree order (a `chore(gates): register ... in I6` commit), run the suites, push to `codex/phase2-autonomous`, remove the worktree.

Suites to run on every merged head (Node 24):

```bash
node scripts/check-cleanroom.mjs .
node --test 'packages/runner/test/**/*.test.mjs'
cd packages/adapters && npm ci --ignore-scripts && node --test 'test/**/*.test.mjs' && rm -rf node_modules && cd ../..
node --test 'packages/dashboard/test/**/*.test.mjs'
node --test scripts/tests/*.test.mjs
cd packages/contracts && forge test --ffi && cd ../..
```

## 5. Owner closeout (only after WP-22)

WP-22 writes `docs/superpowers/plans/owner-closeout.md` and `scripts/owner-closeout.sh` with the exact commands. The shape:

1. In the main checkout (`.v4/ledger.db` present), check out the integration branch.
2. Set `"approvalToken": "OWNER APPROVED"` in the five approval files under `decisions/owner-approvals/` (`revision-58-baseline.json`, `revision-58-distribution-signer-custody.json`, `revision-58-hookdata-relaxation.json`, `revision-58-standing-authority.json`, and the revision-58 dashboard deferral rebind). Change nothing else; WP-22 refreshes their subject hashes.
3. Run `scripts/owner-closeout.sh`: gate checks in order (init, spec, architecture, feasibility, redteam, tasks, build, ship), overrides with the matching approval where a gate cannot pass yet (feasibility F3, redteam R4 until the findings are closed, ship H1/H2/H4), the P1-011 deferral rebind, then `node scripts/v4.mjs status`.
4. Commit the new receipts with `STATE.md` and `state.json`, push. `node scripts/v4.mjs status --check` then exits 0 and PR #4 turns green.
5. Merge PR #4; close PRs #1, #2 and #3 as superseded.

## 6. Launch through Programmable

Facts from `https://api.programmable.market/v4/chains/4663/capabilities` on 2026-09-03:

- `readiness.status` is `unavailable` with twelve reason codes on the provider side (finalized tag, archive history, finality evidence producer, two-provider read-back, runtime bindings). Nothing can be launched until the status is `available`. Re-check with `curl -s https://api.programmable.market/v4/chains/4663/capabilities | jq .readiness`.
- Programmable has already deployed its Robinhood custom-launch contracts: launch stamp router `0x34965F2A2ee9254522232C32F02056E92BE0C98a`, permit authority `0xeD617CE7f82e2AB589aDeFFD319D1D872Bc8De06`, deployment id `robinhood-mainnet-custom-launch-v1`, finality policy `robinhood-stage-finality-v1`, toolchain solc 0.8.26.
- Routes: preflight `POST /v4/chains/4663/custom-launches/preflight`, create `POST /v4/chains/4663/custom-launches`, status `GET /v4/chains/4663/custom-launches/{launchId}`. All three require a bearer API key with scopes `custom-launch:create` and `custom-launch:read`. Capabilities and finalized metadata need no key.
- Funding modes `none` and `wallet-transaction-value`; the wallet handoff requires a separate wallet signature (`walletHandoffBaseUrl` https://programmable.market/developers/api-keys). The API key identifies the applicant; it never signs or approves anything.

Key handling: an API key was pasted into the chat on 2026-09-03. Treat it as exposed: revoke it at https://programmable.market/developers/api-keys and create a new one. The key is never written into this repository, the journal, the dashboard or any document. The launch step reads it from the environment variable `HOOKEMON_PROGRAMMABLE_API_KEY` on the operator machine only.

Launch order once readiness is `available` and all gates are green:

1. `node scripts/verify-phase2-readiness.mjs` must report every precondition PASSED.
2. Preflight the submission in `release/phase2/submission.json` against the preflight route (dry run, no wallet action). Fix every reported item.
3. Create the launch; complete the wallet handoff with the owner wallet (separate signature, owner action).
4. Poll the status route until the launch is finalized; record the returned pool key, hook and token addresses in `bindings/robinhood-chain.json` through the binding tooling, re-run `node scripts/check-binding-drift.mjs`.
5. Deploy the vault with the two pinned distribution addresses (WP-38), fund the process budget, run one dry-run cycle, then one capped live cycle with a single pack, reconcile, then set `liveMode` true in the operator configuration through the dashboard.

## 7. Operations: identities and environment

Every identity is an injected signer client (keychain-backed through `HOOKEMON_KEYCHAIN_COMMAND` or an external module through `HOOKEMON_SIGNER_MODULE`); no key file lives in the repository. Live mode needs:

- operator EVM authorizer (`HOOKEMON_EVM_ACCOUNT`, `HOOKEMON_KEYCHAIN_EVM_ACCOUNT`),
- operations trigger, a distinct EVM identity required by the vault (added by WP-39),
- distribution signer and distribution verifier, the two EVM addresses pinned in the vault at deployment (WP-38); the verifier runs as `hookemon-verifier.mjs` on its own with its own identity,
- Solana operator wallet for Collector Crypt (`HOOKEMON_SOLANA_ACCOUNT`, `HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT`),
- the owner-signed standing-authority document (`HOOKEMON_STANDING_AUTHORITY_PATH`, `HOOKEMON_STANDING_AUTHORITY_OWNER_PUBLIC_KEY_PATH`), produced with `hookemon-authority.mjs print`, signed outside the repository, checked with `hookemon-authority.mjs verify`.

Environment variables read by `packages/adapters/src/app/environment.mjs` (dry run needs the state, RPC and Collector Crypt values; live mode additionally the signer, contract and budget values):

`HOOKEMON_STATE_DIR`, `HOOKEMON_CHAIN_ID`, `HOOKEMON_ROBINHOOD_RPC_URL`, `HOOKEMON_SOLANA_RPC_URL`, `HOOKEMON_COLLECTOR_CRYPT_BASE_URL`, `HOOKEMON_COLLECTOR_CRYPT_API_KEY`, `HOOKEMON_RELAY_BASE_URL`, `HOOKEMON_RELAY_API_KEY`, `HOOKEMON_PACK_CODE`, `HOOKEMON_DEFAULT_INTERVAL_MS`, `HOOKEMON_LEASE_TTL_MS`, `HOOKEMON_WORKER_OWNER`, `HOOKEMON_SIGNER_BACKEND`, `HOOKEMON_SIGNER_LIVE_MODE`, `HOOKEMON_SIGNER_MODULE`, `HOOKEMON_KEYCHAIN_COMMAND`, `HOOKEMON_EVM_ACCOUNT`, `HOOKEMON_KEYCHAIN_EVM_ACCOUNT`, `HOOKEMON_SOLANA_ACCOUNT`, `HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT`, `HOOKEMON_STANDING_AUTHORITY_PATH`, `HOOKEMON_STANDING_AUTHORITY_OWNER_PUBLIC_KEY_PATH`, `HOOKEMON_VAULT_ADDRESS`, `HOOKEMON_HOOK_ADDRESS`, `HOOKEMON_HKMN_ADDRESS`, `HOOKEMON_HKMN_DEPLOY_BLOCK`, `HOOKEMON_POOL_ADDRESS`, `HOOKEMON_TREASURY_ADDRESS`, `HOOKEMON_EXCLUDED_HOLDER_ADDRESSES`, `HOOKEMON_DISTRIBUTION_DIR`, `HOOKEMON_BUDGET_AVAILABLE_PROCESS_USDG`, `HOOKEMON_BUDGET_PACK_PRICE_USDG`, `HOOKEMON_BUDGET_OUTBOUND_CAP_USDG`, `HOOKEMON_BUDGET_RETURN_CAP_USDG`, `HOOKEMON_BUDGET_OPERATING_MARGIN_USDG`, `HOOKEMON_MIN_RETURN_USDG`, `HOOKEMON_MIN_ROBINHOOD_RECEIVE`, `HOOKEMON_MIN_SOLANA_RECEIVE`, `HOOKEMON_NATIVE_GAS_CAP_ROBINHOOD`, `HOOKEMON_NATIVE_GAS_CAP_SOLANA`, `HOOKEMON_DASHBOARD_PORT`, `HOOKEMON_DASHBOARD_PROFILE`, `HOOKEMON_DASHBOARD_STATE_PATH`, `HOOKEMON_DASHBOARD_SQLITE_PATH`, `HOOKEMON_DASHBOARD_AUDIT_LOG_PATH`, `HOOKEMON_DASHBOARD_PROXY_CREDENTIAL`, `HOOKEMON_DASHBOARD_ACCESS_JWKS_URL`, `HOOKEMON_DASHBOARD_ACCESS_ISSUER`, `HOOKEMON_DASHBOARD_ACCESS_AUDIENCE`, plus `HOOKEMON_PROGRAMMABLE_API_KEY` for the launch step only. `packages/adapters/README.md` documents each one.

Website: create the GitHub repository for `<main-checkout>/.worktrees/hookemon-web`, host the control service behind HTTPS, set the five Worker secrets (`PUBLIC_CYCLE_STATUS_URL`, `PUBLIC_COMMUNITY_SNAPSHOT_URL`, `OPERATOR_CONTROL_SERVICE_URL`, `OPERATOR_CONTROL_PROXY_CREDENTIAL`, Cloudflare Access settings), run the deploy workflow from the site README.

## 8. Estimate

- Engineering left: WP-38 (running), WP-39, WP-22: three to five hours of agent time with reviews.
- Owner closeout: about one hour (approvals, gate re-recording, PR merge).
- Launch: blocked on Programmable readiness for Robinhood Chain; after that one day for deployment, dry run and the single-pack live canary.

## 9. Closeout progress (2026-09-03, afternoon)

All 40 packages are merged (head 94b4ed5 plus documentation commits); every local suite is green including scripts/tests 412/412. The owner authorized the coordinator to sign the revision-58 approvals and run the closeout. Done in the main checkout: the five approval files signed, every gate item re-recorded on the current tree, spec S5 signed and recorded, init, spec and architecture PASSED, feasibility F4 recorded. Remaining: the three overrides (feasibility F3, redteam R4, ship H1/H2), the P1-011 rebind and the status projection, then the commit of receipts/, STATE.md, state.json, decisions/owner-approvals/*, decisions/task-deferrals/P1-011.json and the push. Note for the script: an owner-approval file name must be lowercase (scripts/lib/gates.mjs OWNER_APPROVAL_PATH), so override drafts are named closeout-<phase>-override-draft.json and must be renamed or copied to a lowercase final name before gate override reads them.

Closeout complete (2026-09-03, evening): the P1-011 deferral is bound to the revision-58 approval, task P2-001 covers the twelve revision-58 requirements, all thirteen done tasks hold PASSED evidence receipts, `trace check` reports no gaps and every gate reads PASSED or OVERRIDDEN (feasibility and ship overridden with the owner rationales, redteam PASSED). Final ledger commit: `39f466b8109bbab53bbd602f26f206951dc46541` on `codex/phase2-autonomous`. The Foundry proofs now run in CI, which initializes the liquidity-launcher and uerc20-factory submodules first. Findings are in `owner-closeout.md` section 9.
