# Website

## Purpose

The public site at `https://hookemon.com` — landing page, comic-styled product explainer, public
read-only cycle dashboard, and a private owner-only operator console — lives in its own standalone
git repository, `hookemon-web` (a Cloudflare Worker serving a `vinext`/React app), not inside this
repository. This card is that repository's contract card as seen from here: what it is, what it
depends on from this repository's control service, and where its own source and README live. The
site holds no signer, wallet, RPC, or transaction-submission capability of any kind; every public
figure it displays is either observed by `packages/dashboard` and served through the two public
contracts below, or an honest "nothing observed yet" placeholder — never an invented number.

## Public interface

- Repository: a standalone git repository at `hookemon-web` (owner-hosted; see Recovery pointers for
  how to re-derive it). Layout mirrors the legacy `apps/web` structure one level deep
  (`apps/web/{app,lib,worker,tests,public,package.json,...}`) plus `local-preview-comic/` (source
  comic assets) and `.github/workflows/{ci.yml,deploy-web.yml}` at the repository root, so the
  original CI/deploy-workflow tests (`tests/cloudflare-deploy.test.mjs`,
  `tests/web-install-policy.test.mjs`) keep working unchanged.
- Public routes served by the Worker (`apps/web/worker/index.ts`): `GET /` (the baked
  `public/comic-production/index.html`, not the React `app/page.tsx` — that page renders at every
  other path and stays available for local development and future migration), `GET /api/collector-cards`,
  `GET /api/cycle-status`, `GET /api/community-dashboard`, `GET|POST /operator/api/*` (Cloudflare
  Access protected), `GET /operator*` (Access protected page shell).
  - The Worker's own client-facing paths (`/api/cycle-status`, `/api/community-dashboard`) are
    distinct from the two upstream control-service paths it proxies to, which are fixed by
    `apps/web/worker/public-dashboard-config.ts` to exactly `/public/api/cycle-status` and
    `/public/api/community-dashboard` — the same two routes `packages/dashboard`'s
    `src/routes/public.mjs` serves in this repository (see `docs/modules/dashboard.md`).
- Site-side contracts, clean-room ported field-for-field from
  `packages/dashboard/src/contracts/{dashboard-profile,public-cycle-status,public-community-snapshot}.mjs`
  at this integration head: `apps/web/lib/public-dashboard-profile.ts`
  (`readDashboardProfile`, `dashboardExplorerHref` — `testnet` = Sepolia + Solana devnet, `mainnet` =
  Robinhood Chain (`evm: {name:"robinhood", chainId:4663, label:"Robinhood Chain"}`) + Solana
  mainnet-beta), `apps/web/lib/public-cycle-status.ts`
  (`normalizePublicCycleStatus`), `apps/web/lib/public-community-snapshot.ts`
  (`normalizePublicCommunitySnapshot`). Every money field carries the `MicroUsdg` suffix and the EVM
  side of `network` is keyed `evm` (not `evm`), matching this repository's contracts exactly.
- `apps/web/lib/public-dashboard-view.ts`: `resolveDashboardEnvironment`, `buildPublicCycleProcess`,
  `formatPublicMicroUsdg`, `latestDashboardCards`, `hasLatestPayoutFacts` — pure client-side
  presentation derived from the two contracts above, no network or backend access of its own.
- Private operator console: `apps/web/app/operator/OperatorControlPanel.tsx` and
  `apps/web/worker/operator-proxy.ts` proxy `/operator/api/*` to `OPERATOR_CONTROL_SERVICE_URL` with
  the shared `x-hookemon-proxy-credential`. **Known gap:** the console's own configuration form still
  speaks the legacy operator-control vocabulary (`mode`, `communityPackIds`, `manualPackOrders`,
  `rewardRecipientLimit`, `skipNextCycleSequence`, `runNowSequence`), which does not match this
  repository's actual `/operator/api/decisions` command shape
  (`packages/dashboard/src/contracts/operator-contracts.mjs`'s `DECISION_TYPES`:
  `activate`/`pause`/`run-cycle-now`/`skip-next-cycle`/`update-configuration`/`restart-request`/
  `reconcile-request`, and `state-schema.mjs`'s `intervalMinutes`/`allowedPackIds`/`requestedOrders`/
  `maxBoostersPerCycle`/the three `max*MicroUsdg` caps/`paused`/`liveMode`). WP-18 only re-homed the
  site, updated its network/money vocabulary, and cross-checked the two **public** contracts against
  this repository's fixtures (`apps/web/tests/dashboard-fixture-cross-check.test.mjs`); reconciling
  the operator console's decision shape to this repository's actual operator API is unstarted and
  needs its own work package before the private console is wired to a live `packages/dashboard`
  deployment.

## Invariants

- The site never holds a signer, private key, RPC credential, or Collector Crypt/Relay/Solana
  provider secret; `apps/web/worker/index.ts`'s `WorkerEnv` only ever carries public read
  configuration and the operator proxy credential.
- `apps/web/lib/public-*-status.ts`/`*-snapshot.ts` are byte-exact validators: any field this
  repository's `packages/dashboard` contracts do not define is rejected (`exactKeys`), and every
  money field is an unsigned or signed decimal string in `MicroUsdg` base units, never a floating
  point number.
- The Worker's `/api/cycle-status` and `/api/community-dashboard` only ever forward the exact
  upstream path `/public/api/cycle-status` / `/public/api/community-dashboard`
  (`apps/web/worker/public-dashboard-config.ts`'s `exactPublicUrl`) — a misconfigured
  `PUBLIC_CYCLE_STATUS_URL`/`PUBLIC_COMMUNITY_SNAPSHOT_URL` (wrong path, query string, non-HTTPS)
  fails closed with `PUBLIC_DASHBOARD_URL_INVALID`, never silently proxies elsewhere.
- The site repository never deploys itself and never creates its own GitHub repository; both are
  owner actions gated behind a manual `workflow_dispatch` of `.github/workflows/deploy-web.yml` after
  `.github/workflows/ci.yml` is green on `main`, plus the protected `production` environment's
  required reviewer approval (see that repository's README "Deploy runbook").
- Public copy makes no live-mainnet or audit claim beyond the honest disclaimers already in the
  markup ("No audit, approval, or sale availability claim is being made.", "Always verify current
  deployment and audit state before interacting."); it names Robinhood Chain 4663 and USDG for every
  holder-payout figure, never EVM mainnet or Circle USD.

## State transitions

- The site repository's own git history is independent of this repository's; a change here to
  `packages/dashboard`'s contracts (a new or renamed field, a schema version bump) requires a manual,
  separate follow-up commit in `hookemon-web` re-porting the affected contract file and re-running its
  test suite — there is no automated sync between the two repositories.
- `PUBLIC_DASHBOARD_PROFILE` (Worker secret) and `HOOKEMON_DASHBOARD_PROFILE` (control-service
  environment variable, this repository) must always be changed together, to the same value; the
  Worker's `readPublicDashboardConfig` and this repository's `readDashboardProfile` both reject a
  profile mismatch between the two ends of a request.
- A push to `main` in the site repository only ever runs CI (build + test); production delivery is a
  separate, manually triggered event (see Operational commands) that never happens automatically.

## Operational commands

- `cd apps/web && npm ci --ignore-scripts && npm test` (Node.js 22.13+) — builds the Worker
  (`npm run build`, via `vinext build`) and then runs the full `node:test` suite, including the
  fixture cross-check against this repository's public contracts.
- `cd apps/web && npm run dev` — local Wrangler/Miniflare dev server.
- `gh workflow run deploy-web.yml --ref main` (after CI is green and the required secrets are
  configured) — the only way this site reaches production; see that repository's README "Deploy
  runbook" for the exact secret names and the required `production` environment approval step.
- `node --test packages/dashboard/test/routes/*.test.mjs` (this repository) — the control-service
  side of the contract this card documents; a green run here does not by itself prove the site
  repository's copy of the contract still matches (see State transitions).

## Recovery pointers

- If the `hookemon-web` repository or its clone is lost, its source of truth for re-deriving it is
  this repository's local git branch `codex/mainnet-cycle-canary` (`apps/web` and
  `.github/workflows/deploy-web.yml`, plus `local-preview-comic/` at that branch's root) — historical
  reference only per `product/SOURCE_BOUNDARY.md`, re-apply the Robinhood Chain 4663 / USDG /
  `evm`-network-key renames documented in this card's Public interface section rather than trusting
  that branch's copy verbatim.
- If the public dashboard shows "Unavailable" everywhere, the Worker's
  `PUBLIC_CYCLE_STATUS_URL`/`PUBLIC_COMMUNITY_SNAPSHOT_URL` secrets are missing, wrong, or the
  control service they point at is down or returning a shape its own contract rejects — check
  `packages/dashboard`'s `/healthz` first, then confirm the Worker secrets exactly match this
  repository's live control-service origin and paths.
- If the operator console cannot save changes, remember it currently speaks a different
  configuration vocabulary than this repository's actual `/operator/api/decisions` endpoint (see the
  "Known gap" note in Public interface) — this is expected until a follow-up work package reconciles
  the two, not evidence of a live deployment bug.
- If `apps/web/tests/dashboard-fixture-cross-check.test.mjs` fails after a `packages/dashboard`
  contract change, that is the intended signal to re-port the changed file into `hookemon-web`
  (State transitions) — never edit the site's fixture to make it pass without also updating its
  validator to match.
