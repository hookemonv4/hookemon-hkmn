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

The hero uses a two-line shared-cycle heading and the supplied transparent Robinhood Chain SVG. The description retains its star marker, and the adventure slogan introduces the loop. In short landscape viewports, the coin scales to the available height.

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
- Private operator console: `apps/web/app/operator/OperatorControlPanel.tsx` uses the authenticated
  `/operator/api/*` proxy. Configuration commands carry `allowedPackIds`, `requestedOrders`,
  `maxBoostersPerCycle`, `intervalMinutes` and `maxUnitPriceMicroUsd`, `maxCycleBudgetMicroUsd`,
  `max24HourBudgetMicroUsd`. These limits are USD valuations, bounded by 55, 165 and 495 USD.
  Collector catalog prices remain Circle USD Coin on Solana. A bootstrap with historical `MicroUsdg` controls
  cannot enable commands; a failed refresh clears the previous bootstrap.
- `operator-locale.ts` formats native ETH from integer wei with bigint arithmetic and USD controls
  from integer micro-USD. Historical USDG formatters and dashboard decoders retain their original
  units. Native public accounting requires a distinct producer schema before its values can be
  displayed; historical scalars are never relabeled as ETH or USD.

## Invariants

- On phones, the logo is centred over a split header: cycle timing on the left and evenly
  spaced social icons on the right. Gallery cards remain upright in individual frames.
  Coin autoplay follows the most recent drag direction instead of reversing a leftward flick.

- Homepage content below the initial viewport reveals once with an upward fade tied to scroll progress. The movement spans up to 112 px and completes without a timed backlog during fast scrolling.
  Reduced motion disables reveals, and content stays visible without animation support.

- Showcase buyback estimates use exact NFT membership and pack rates recorded in
  `docs/evidence/showcase-buyback-sources.json`. Multiple verified rates produce a range;
  unverified membership shows an unavailable estimate. Retrieval dates and the distinction
  between insured values and estimated offers remain visible.

- The illustrated homepage uses 30 px header social icons, decorative Lugia sparkles that stop
  under reduced motion, and one large footer wordmark without a duplicate logo in the bottom row.
- Mobile navigation exposes the pack catalog in a dismissible side panel. The cycle transcript
  has a prominent summary and readable body text. Portrait phone scenes follow scroll progress,
  including shorter Safari viewports; reduced motion retains manual chapter selection.
- Coin dragging survives implicit touch capture moving from a child face to the coin button;
  vertical scrolling remains native. See [Pointer Events implicit capture](https://www.w3.org/TR/pointerevents3/#implicit-pointer-capture).

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

### Iconic card gallery

The landing gallery presents one graded individual card for each of Mew, Mewtwo, Charizard, Blastoise, Venusaur and Pikachu. `config/collector-showcase.json` records the provider snapshot, full catalog coverage and selection rules. Selection uses the highest provider insured value per species across the listed packs, excluding sealed products; insured value is not a sale price. Each upright card has the same framed presentation, its certificate and provider record, and an estimated buyback tied to the named pack rate. Rarity colors are pack-relative: Epic is purple and Uncommon is green. Other verified pack memberships appear in card details. Refresh the snapshot and gallery together after repeating the catalog scan; never infer pack membership from value alone.

Lugia remains the full-width chase card above the six iconic species. Buyback cash-out estimates use Collector Crypt pack rates; different verified rates appear as a cash range, not a guaranteed offer.

## Native display boundary

The served comic page and its `dashboard.mjs` accept cycle-status v7 and community v9 while retaining
historical readers. ETH displays preserve all 18 decimal places, and recipient averages round down
to one wei. Historical USDG values retain their six-decimal label. The standalone
`comic-production/native-accounting.mjs` and React-side parser match the backend contract byte for
byte. Existing comic layout, artwork and audio stay on their current paths.

The React dashboard exposes the same native round through `NativeAccounting.tsx`; USD valuations
and Collector settlement assets retain distinct labels. Native executable operator controls use
micro-USD limits, and unavailable or historical bootstrap data clears the command authority state.

## Inclusive swap fee

The active homepage, transparency page and React fallback describe the same inclusive 3% fee on buys and sells: 0.20% Programmable, 0.40% Hookemon Treasury and 2.40% Hookemon process (the pack engine). Fee bars show these allocations as 2:4:24 shares of the total fee. The platform share is included in 3%; it is not an additional surcharge. On chain 4663, Programmable receives `0xD88539d3c4C460136a733A3Fd60cf6BF269079da`, and the fixed Treasury receives `0xfc82B0da6d487B97d7eA1AA0d51E00AfF4F3a729`. Updating the source does not establish that the public site has been published; deployment and live verification remain separate operations.
