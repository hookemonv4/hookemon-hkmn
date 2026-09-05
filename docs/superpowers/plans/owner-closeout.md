# Owner closeout for requirements revision 58

This plan is for the owner (or an engineer acting with the owner present), run **from the main
checkout** — the working tree that holds `.v4/ledger.db` — **never from a `.worktrees/*` clone**.
`scripts/owner-closeout.sh` refuses to run anywhere else. It walks the eight v4 phase gates in
order, stops at the first one that needs an owner decision, and never sets an `approvalToken`
itself — only the owner does that, by hand, in the five approval files listed in section 2.

## 1. Preconditions

- You are on the integration branch (`codex/phase2-autonomous` or its current successor) in the
  main checkout, working tree clean, `git status` shows nothing pending.
- `node --version` reports 24.x (this machine's pinned Node 24 install first on `PATH`, or set
  `HOOKEMON_NODE_BIN` to its `node` binary — see `scripts/owner-closeout.sh`).
- `node scripts/v4.mjs status` (read-only: prints `STATE.md`'s content as JSON) shows the phase
  results you expect from the last merge.

## 2. Sign the five revision-58 approval files

Requirements revision 58 needs five owner approvals before the gates that depend on it can pass
or be knowingly overridden. WP-22 already refreshed every `subjectHashes` entry in these files
against the current tree; **do not touch `subjectHashes` yourself** — if any of them fail to
verify when a gate command reads the file, the underlying content moved since WP-22 refreshed it
and the file needs a fresh regeneration pass, not a hand edit.

1. `decisions/owner-approvals/revision-58-baseline.json`
2. `decisions/owner-approvals/revision-58-distribution-signer-custody.json`
3. `decisions/owner-approvals/revision-58-hookdata-relaxation.json`
4. `decisions/owner-approvals/revision-58-standing-authority.json`
5. `decisions/owner-approvals/phase-2-revision-58-dashboard-deferral-approved.json`

For each of the five: read the file's `rationale` field in full, and only if it is an unambiguous
yes, change exactly two things:

- delete the `draftStatus` field if present (files 1-4 carry one; file 5 does not) — the owner
  approval schema (`scripts/lib/gates.mjs`'s `OWNER_APPROVAL_KEYS`) accepts exactly eight fields
  (`action`, `approvalToken`, `authority`, `itemId`, `phase`, `rationale`, `schema`,
  `subjectHashes`) and rejects a ninth field, so a file signed with `draftStatus` still present
  will fail to validate the first time it is used as gate evidence;
- set `"approvalToken"` to the literal string `"OWNER APPROVED"`.

Change nothing else — not the rationale text, not `subjectHashes`, not field order. Do not sign a
file whose rationale you have not read, and do not sign file 5 without first reading section 3
below (it defers a task, a distinct ask-first action from a gate override).

Files 1-4 are the substantive owner-facing record of what is being approved, but signing them does
**not** by itself make gate item S5 ("the owner approved the spec revision with an unambiguous
yes", `gates/spec.json`) pass: S5's own evidence policy allows only `specs/requirements.json` as an
artifact input, so none of files 1-4 can be handed to `node scripts/v4.mjs gate owner-authorize
spec --item S5 ...` directly (their `subjectHashes` cite paths — `decisions/ADR-0021-...`,
`product/REQUIREMENTS_REVISION_58_PROPOSAL.md`, `product/delivery-boundary.json`,
`decisions/task-deferrals/P1-011.json` — S5 does not allow), and the pre-existing S5 evidence
receipt from requirements revision 56 goes stale the moment `specs/requirements.json` changes
underneath it. `scripts/owner-closeout.sh` handles this itself: on its first pass over the `spec`
phase it drafts a sixth file, `decisions/owner-approvals/phase-2-revision-58-spec-s5-approved.json`
— rationale already written (it quotes files 1-4 in full), subject hashes already computed
(`gates/spec.json`, `policy/policy.json`, `specs/requirements.json` — the exact shape S5 requires)
— and stops the same way it stops for an override draft. Read that file, and if it accurately
reflects what files 1-4 already convinced you of, set its `approvalToken` to `"OWNER APPROVED"` and
re-run the script; it then runs the real `gate owner-authorize` call for you.

## 3. Rebind the P1-011 dashboard deferral

`decisions/task-deferrals/P1-011.json` is still bound to requirements revision 56 (its original,
still-historically-accurate content). WP-22 prepared the revision-58 rebind as a separate staged
file, `decisions/task-deferrals/P1-011-revision-58-rebind.json`, with the identical prestate and
fingerprint (P1-011 itself has not changed — only which requirements revision the deferral cites)
and `requirements.revision: 58` pointing at the current `specs/requirements.json`. Promote it only
once file 5 above carries `"approvalToken": "OWNER APPROVED"`:

```sh
cp decisions/task-deferrals/P1-011-revision-58-rebind.json decisions/task-deferrals/P1-011.json
```

`scripts/owner-closeout.sh` performs exactly this copy for you, but only after confirming file 5
is signed, and never before.

## 4. Run the closeout script

```sh
bash scripts/owner-closeout.sh
```

It runs, strictly in order: `gate check init`, `spec`, `architecture`, `feasibility`, `redteam`,
`tasks`, `build`, `ship`. `spec` gets the S5-evidence handling from section 2 the first time it
fails. Every other phase is expected to reach `PASSED` on its own except the three the review below
names — the script recognizes exactly those three by phase name and,
on a `FAILED` result there, drafts an override-approval template under
`decisions/owner-approvals/closeout-<phase>-override-draft.json`, populated with the exact
`subjectHashes` the override will need to validate (computed from the `FAILED` gate receipt's own
`inputHashes` plus `policy/policy.json` — the same transitive input closure
`scripts/lib/gates.mjs`'s `overrideGate` itself checks), and stops with a nonzero exit and a
one-line instruction. The script never writes `"OWNER APPROVED"` into that draft; you do, after
reading the drafted `rationale` placeholder and replacing it with your own words (or the exact
carried-forward rationale below, if it still says what you mean).

For the three that are expected to need one:

- **`feasibility` (item F3 — external-service spikes for unproven integrations).** Robinhood
  Chain's public RPC facts and the Programmable custom-launch route were verified by direct
  request (see `docs/superpowers/plans/2026-09-03-phase2-status-and-continuation.md` section 6),
  but Programmable's own `readiness.status` for chain 4663 is `unavailable` — no live spike against
  an actually-launchable chain is possible yet. Rationale to carry forward (edit only if it no
  longer matches reality): *"Owner overrides the feasibility gate for local revision-58 closure
  while F3 remains blocked on Programmable's own readiness.status for Robinhood Chain 4663
  reporting unavailable; this does not claim F3 passed or authorize deployment, credentials,
  signing, broadcast, asset movement, spending, or publication."*
- **`redteam` (item R4 — doubt-loop termination without open findings).** `decisions/redteam/findings.json`
  currently records four genuinely open findings at revision 58: two critical
  (`RT-R58-01` — the vault accepts a payout authorization from the worker's own authorizer key
  alone, with no on-chain distribution-signer/verifier signature check; `RT-R58-02` — the
  off-chain manifest verification keys are hardcoded test fixtures with their private halves
  committed in this repository) and two medium (`RT-R58-03` — only one EVM signer role exists,
  so `operationsTrigger != authorizer` can never hold and no live cycle can complete;
  `RT-R58-04` — `acceptDegraded` is trusted from the worker with no on-chain distinction from a
  genuinely human-confirmed call). **Do not sign a redteam override that claims these are
  resolved — they are not**, regardless of what any prior planning document says. Rationale to
  carry forward: *"Owner overrides the redteam gate for local revision-58 closure while R4 remains
  escalated: RT-R58-01 and RT-R58-02 (critical) and RT-R58-03 and RT-R58-04 (medium) remain
  OPEN_FAIL_CLOSED in decisions/redteam/findings.json. This override does not resolve those
  findings and authorizes no deployment, credentials, signing, broadcast, asset movement,
  spending, or publication; live mode stays refused by the signer service regardless (see section
  6 of this plan)."*
- **`ship` (items H1, H2, H4).** No release has reached `operating` state (H1), no alert has been
  test-fired into a real paging channel (H2), and no owner advisory review has been recorded for
  this revision (H4) — none of that changes until a live cycle actually runs. Rationale to carry
  forward: *"Owner overrides the ship gate for local revision-58 closure only. H1 remains open
  because no release reached operating state, H2 remains open because no alert was test-fired into
  a real channel, and H4 remains open because the revision-58 advisory review was not recorded.
  This override does not claim release or operating readiness and authorizes no deployment,
  publication, credential access, signing, broadcast, asset movement, spending, or production
  use."*

After you sign a drafted override file (delete nothing from it except the placeholder text,
`OWNER APPROVED` for the token), re-run `bash scripts/owner-closeout.sh` — it picks up from the
first still-unresolved step; passed and overridden phases are not re-touched.

Once all eight gates read `PASSED` or `OVERRIDDEN`, the script promotes the P1-011 deferral
(section 3) and runs:

```sh
node scripts/v4.mjs task defer P1-011 \
  --record decisions/task-deferrals/P1-011.json \
  --approval decisions/owner-approvals/phase-2-revision-58-dashboard-deferral-approved.json \
  --rationale "<the exact rationale text inside that approval file's "rationale" field>"
node scripts/v4.mjs status
```

and exits 0 only if `node scripts/v4.mjs status --check` itself would exit 0.

## 5. Commit and push

```sh
git add receipts/ STATE.md state.json \
  decisions/owner-approvals/revision-58-*.json \
  decisions/owner-approvals/phase-2-revision-58-*.json \
  decisions/owner-approvals/closeout-*-override-*.json \
  decisions/task-deferrals/P1-011.json
git commit -m "chore(owner): close out requirements revision 58"
git push
```

PR #4 (or whatever the current integration PR is) turns green once CI re-runs against this push.
Merge it, then close any superseded prior PRs as superseded — do not force-push or delete a
branch the owner has not explicitly said to remove.

## 6. Launch gating — what must be true before `liveMode: true`

None of the following is true at the time of writing. Every one of them must be, in order:

1. Every approval in section 2 carries `"OWNER APPROVED"` and every gate reads `PASSED` or
   `OVERRIDDEN` (section 4).
2. `RT-R58-01` and `RT-R58-02` (both critical) are actually resolved in code and in
   `decisions/redteam/findings.json` — not merely overridden at the gate. `RT-R58-01` needs
   `PegCycleVault.authorizePayout`/`PayoutCommitment.commitPayoutChunk` to check two independent,
   non-worker signatures on-chain (or an equivalent contract-enforced binding) before accepting a
   payout authorization. `RT-R58-02` needs the distribution-signer and verifier public keys the
   off-chain manifest check verifies against to come from operator configuration, with a hard
   refusal — never a fallback to the fixture keys — under a production evidence profile.
3. `RT-R58-03` is resolved: a second, distinct EVM signer identity exists for the Operations
   trigger role, separate from the vault authorizer, so `PegCycleVault`'s
   `operationsTrigger != authorizer` check can actually be satisfied by a real cycle.
4. `RT-R58-04` is resolved or explicitly accepted by the owner as a standing risk with a scoped
   owner standing-authority requirement wired to `acceptDegraded`.
5. The owner has signed the standing-authority document (`bin/hookemon-authority.mjs print`, a
   human signature applied outside this repository, then `bin/hookemon-authority.mjs verify`
   against `HOOKEMON_STANDING_AUTHORITY_PATH`) naming the exact per-cycle spend cap, the exact
   maximum-cycles-per-day cap, and the immediately effective pause/key-revocation kill switch —
   without it the signer service refuses every live signing request regardless of what any gate
   says.
6. Programmable reports `readiness.status: available` for Robinhood Chain 4663
   (`curl -s https://api.programmable.market/v4/chains/4663/capabilities | jq .readiness`) — it
   was `unavailable` with twelve provider-side reason codes as of 2026-09-03.
7. `node scripts/verify-phase2-readiness.mjs` reports every precondition `PASSED` against the real
   deployed vault, hook, and HKMN token addresses (none exist yet — `bindings/robinhood-chain.json`
   still carries `status: "INTEGRATION_PENDING"` with `hook: null`).
8. One dry-run cycle (`liveMode: false`) has completed end to end against the real deployed
   contracts, then one capped live cycle with a single pack has completed, reconciled, and been
   reviewed by the owner — only then does `liveMode` flip to `true` in the operator configuration
   through the dashboard.

Any one of these being false means live mode stays off. This list, not any planning document's
optimism, is the actual gate.

## 7. Operations: identities and environment

Every identity below is an injected signer client — keychain-backed (`HOOKEMON_KEYCHAIN_COMMAND`)
or an external module (`HOOKEMON_SIGNER_MODULE`) — never a key file committed to this repository.

- **Operator EVM authorizer** (`HOOKEMON_EVM_ACCOUNT`, or `HOOKEMON_KEYCHAIN_EVM_ACCOUNT` under the
  keychain backend). Signs `authorizeFunding`/`authorizePayout` as `PegCycleVault`'s `authorizer`.
- **Operations trigger** — a distinct EVM identity `PegCycleVault` requires to differ from the
  authorizer above (`executeOutbound`'s `operationsTrigger`). Not yet wired as a separate
  configuration value in `packages/adapters/src/app/environment.mjs` — this is `RT-R58-03`
  (section 6.3); resolving it adds the second identity's own environment variable.
- **Distribution signer and distribution verifier** — the two EVM addresses `PegCycleVault` is
  meant to pin at deployment (once `RT-R58-01` is resolved). The distribution signer runs as part
  of the always-on worker process via `config.signerClient.distributionSigner` (never the operator
  `evm`/`solana` client — decision D7). The verifier runs as its own separate process,
  `bin/hookemon-verifier.mjs`, with its own key, designed for a different host.
- **Solana operator wallet** (`HOOKEMON_SOLANA_ACCOUNT`, or `HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT`).
  Signs Collector Crypt pack purchase/open/buyback transactions and the Solana-side leg of the
  Relay return bridge.
- **Owner standing authority** — not a signer client the worker holds; a document the owner signs
  outside this repository naming the exact per-cycle spend cap, max-cycles-per-day cap, and kill
  switch. `bin/hookemon-authority.mjs print` renders it for signing;
  `bin/hookemon-authority.mjs verify` checks a signed copy against
  `HOOKEMON_STANDING_AUTHORITY_PATH` / `HOOKEMON_STANDING_AUTHORITY_OWNER_PUBLIC_KEY_PATH`.

Environment variables `packages/adapters/src/app/environment.mjs` reads (see that file's own
header for the authoritative list; this is a summary). Only `HOOKEMON_STATE_DIR` is
unconditionally required — every dry-run stage degrades to `configured: false` rather than throw
when its own address or credential is absent, so a partially-configured operator can still run a
full dry-run cycle:

- **Always needed:** `HOOKEMON_STATE_DIR`.
- **Needed for a dry run to observe anything real** (each is independently optional; an absent one
  just makes that one stage report `configured: false`): `HOOKEMON_CHAIN_ID`,
  `HOOKEMON_ROBINHOOD_RPC_URL`, `HOOKEMON_SOLANA_RPC_URL`, `HOOKEMON_COLLECTOR_CRYPT_BASE_URL`,
  `HOOKEMON_COLLECTOR_CRYPT_API_KEY`, `HOOKEMON_RELAY_BASE_URL`, `HOOKEMON_RELAY_API_KEY`,
  `HOOKEMON_PACK_CODE`, `HOOKEMON_VAULT_ADDRESS`, `HOOKEMON_HOOK_ADDRESS`,
  `HOOKEMON_HKMN_ADDRESS`, `HOOKEMON_HKMN_DEPLOY_BLOCK`, `HOOKEMON_POOL_ADDRESS`,
  `HOOKEMON_TREASURY_ADDRESS`, `HOOKEMON_EXCLUDED_HOLDER_ADDRESSES`, `HOOKEMON_DISTRIBUTION_DIR`.
- **Needed only for live mode to actually sign or broadcast anything**:
  `HOOKEMON_SIGNER_BACKEND`, `HOOKEMON_SIGNER_LIVE_MODE`, `HOOKEMON_SIGNER_MODULE`,
  `HOOKEMON_KEYCHAIN_COMMAND` (required when the backend is `keychain`), `HOOKEMON_EVM_ACCOUNT` /
  `HOOKEMON_KEYCHAIN_EVM_ACCOUNT`, `HOOKEMON_SOLANA_ACCOUNT` /
  `HOOKEMON_KEYCHAIN_SOLANA_ACCOUNT`, `HOOKEMON_STANDING_AUTHORITY_PATH`,
  `HOOKEMON_STANDING_AUTHORITY_OWNER_PUBLIC_KEY_PATH`, the five `HOOKEMON_BUDGET_*` fields,
  `HOOKEMON_MIN_RETURN_USDG`, `HOOKEMON_MIN_ROBINHOOD_RECEIVE`, `HOOKEMON_MIN_SOLANA_RECEIVE`,
  `HOOKEMON_NATIVE_GAS_CAP_ROBINHOOD`, `HOOKEMON_NATIVE_GAS_CAP_SOLANA`.
- **Scheduling and worker identity**: `HOOKEMON_DEFAULT_INTERVAL_MS`, `HOOKEMON_LEASE_TTL_MS`,
  `HOOKEMON_WORKER_OWNER`.
- **Dashboard** (read by `packages/dashboard/src/server.mjs`'s own `readEnvironmentConfig`, not by
  `environment.mjs`, but allow-listed there so the two readers coexist on the same `process.env`):
  `HOOKEMON_DASHBOARD_PORT`, `HOOKEMON_DASHBOARD_PROFILE`, `HOOKEMON_DASHBOARD_STATE_PATH`,
  `HOOKEMON_DASHBOARD_SQLITE_PATH`, `HOOKEMON_DASHBOARD_AUDIT_LOG_PATH`,
  `HOOKEMON_DASHBOARD_PROXY_CREDENTIAL` (required unless `hookemon-runner run --no-dashboard` is
  used), `HOOKEMON_DASHBOARD_ACCESS_JWKS_URL`, `HOOKEMON_DASHBOARD_ACCESS_ISSUER`,
  `HOOKEMON_DASHBOARD_ACCESS_AUDIENCE`.
- **Launch only**: `HOOKEMON_PROGRAMMABLE_API_KEY` — read only by the (not yet built) launch step,
  never written into this repository, the journal, or the dashboard. An API key pasted into a chat
  session is compromised the moment it is pasted; treat any such key as already exposed, revoke it
  at https://programmable.market/developers/api-keys, and issue a fresh one before use.

The Collector Crypt API key and Robinhood/Solana RPC endpoints are ordinary configuration values
read from `HOOKEMON_COLLECTOR_CRYPT_API_KEY` / `HOOKEMON_COLLECTOR_CRYPT_BASE_URL` /
`HOOKEMON_ROBINHOOD_RPC_URL` / `HOOKEMON_SOLANA_RPC_URL` — no default endpoint is hardcoded, and
none should ever be committed to this repository. The dashboard proxy credential
(`HOOKEMON_DASHBOARD_PROXY_CREDENTIAL`) gates every `/operator/api/*` route; Cloudflare Access
(`HOOKEMON_DASHBOARD_ACCESS_JWKS_URL`/`_ISSUER`/`_AUDIENCE`) is an additional, optional layer in
front of that same proxy, configured on the Cloudflare Worker side of the standalone
`hookemon-web` repository, not inside this one.

## 8. Findings from the first closeout run (2026-09-03)

- The task CLI takes the subcommand before the task id: `node scripts/v4.mjs task defer P1-011 ...`.
- A task that is already deferred cannot be deferred again through the CLI (`taskDeferralPrestate` accepts only ready or done tasks), so rebinding the P1-011 deferral to the revision-58 approval requires updating the ledger row (defer_approval, defer_descriptor, defer_prestate_fingerprint) directly; the prestate fingerprint stays the same.
- Once the tasks gate is authoritative, `node scripts/v4.mjs trace check` requires every requirement to be covered by an active task and every done task to hold an evidence receipt bound to the current requirements revision. After a requirements revision change, re-record the Phase 1 task evidence (`receipt add --type evidence --result PASSED --task P1-NNN --commit <completion commit> --input <verification artifacts>`) and add a Phase 2 task covering the new requirements before the closeout commit.
- Override approval files must have lowercase names (`scripts/lib/gates.mjs` OWNER_APPROVAL_PATH).

## 9. Findings from the second and third closeout runs (2026-09-03)

- Run `node scripts/v4.mjs task project` before recording any receipt. Task evidence binds to the task fingerprint in `tasks.json`; a projection written afterwards marks the evidence stale.
- Task evidence counts only with `--result PASSED`. `receipt add --type evidence` without a result writes a receipt that `trace check` ignores.
- Every new task (here P2-001) needs a sidecar `{ "recordId": "tasks:<id>", "deliveryPhase": <open phase> }` in `product/delivery-boundary.json`, otherwise `check-delivery-boundary.mjs` fails.
- A fresh receipt for a prerequisite gate invalidates the gate receipts of every later phase, so gates are re-checked strictly in phase order and the feasibility and ship overrides are re-recorded last; the approval files are rebound to the new subject hashes.
- `check-append-only.mjs` inspects a merge commit against every parent. A merge whose second parent carried a superseded worktree ledger needs a reviewed entry in `SUPERSEDED_MERGE_PARENTS`.
- A Gitleaks allowlist change alters the config digest pinned in `.github/workflows/v4-gates.yml`, `product/dependency-pins.json` and `scripts/tests/cleanroom.test.mjs`; the new workflow digest then flows into `product/dependency-pins.json` and `scripts/verify-control-dependencies.mjs`, and `product/dependency-verification.json`, `feasibility/interface-freeze.json` and `release/phase1/local-candidate.json` are regenerated. Any such change is followed by a fresh driver run and a new ledger commit.
- CI must initialize `packages/contracts/lib/liquidity-launcher` and `lib/uerc20-factory`; `CustomLaunchStrategy.sol` imports the launcher interfaces and `forge fmt --check` fails without them.
