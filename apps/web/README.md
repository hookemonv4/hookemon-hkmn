# Hookemon web

Public Hookemon website and dashboard in the canonical [hookemon-hkmn repository](https://github.com/hookemonv4/hookemon-hkmn). Holding, reward accounting, and automatic payment do not depend on a website login.

## Local development

Requires Node.js 22.13 or newer.

```bash
cd apps/web
npm ci
npm run dev
npm test
npm run lint
```

The public version uses no D1 database or R2 bucket.

## Public dashboard profile

The operator-control service requires `OPERATOR_CONTROL_PUBLIC_PROFILE`. The Cloudflare Worker
requires `PUBLIC_DASHBOARD_PROFILE`. Both accept only `testnet` or `mainnet`, and both public
upstream URLs must use the same HTTPS origin and their exact public paths.

For development, CI, and testnet verification, set both profile values to `testnet`. Do not set
either value to `mainnet` as part of dashboard testing. A future mainnet activation is a separate
reviewed release and must update the operator service and Worker together after the mainnet runbook
gates pass.

The operator-control service requires this protected value:

- `OPERATOR_CONTROL_PUBLIC_PROFILE`: the public dashboard deployment profile

## Private operator control

`/operator*` is a private Cloudflare Worker surface. Cloudflare Access must protect
that route for approved, MFA-authenticated members. The Worker independently requires
the `cf-access-jwt-assertion` header and forwards only allowlisted requests to the
isolated `hookemon-operator-control` service. That service validates both the signed
Access JWT and a server-only proxy credential before serving or recording an action.

The Node control service owns the operator configuration, read-only catalog client,
dashboard read model, decisions, and PostgreSQL audit log. It shares that database with
the separately deployed cycle runner, so audited configuration changes and one-shot
cycle commands are visible to execution without giving the public Worker any signer,
wallet, RPC, or transaction capability. Each decision includes the normalized Access
identity and a hash-chain link.

The built Worker declaration is generated at `dist/server/wrangler.json` by
`npm run build`. GitHub Actions deploys the exact successful main-push website CI
revision through the `production` environment. Repository environment settings and
secrets must be configured in the canonical repository; source migration does not
copy them. For an explicitly authorized manual deployment from the repository root:

```bash
cd apps/web
npm run build
node scripts/verify-cloudflare-deploy.mjs config dist/server/wrangler.json
./node_modules/.bin/wrangler deploy --config dist/server/wrangler.json
```

Configure these five encrypted Worker secret names. Keep their values out of the
repository, browser-visible environment, command output, and documentation:

- `OPERATOR_CONTROL_SERVICE_URL`: the HTTPS origin of `hookemon-operator-control`
- `OPERATOR_CONTROL_PROXY_CREDENTIAL`: the same high-entropy value configured only on
  the Worker and the Render control service
- `PUBLIC_DASHBOARD_PROFILE`: the public dashboard deployment profile
- `PUBLIC_CYCLE_STATUS_URL`: the full HTTPS URL of the control service's public status
  route, with the exact shape
  `https://<operator-control-host>/public/api/cycle-status` and no query or fragment
- `PUBLIC_COMMUNITY_SNAPSHOT_URL`: the full HTTPS URL of the redacted aggregate
  dashboard route, with the exact shape
  `https://<operator-control-host>/public/api/community-dashboard` and no query or fragment

The generated deployment config declares all five names as required secrets, and
`verify-cloudflare-deploy.mjs` rejects the deployment target if any name is missing.
Wrangler then checks that every required secret is already configured on
`hookemon-web` before deploying. In the Cloudflare dashboard, use **Workers & Pages**
> **hookemon-web** > **Settings** > **Variables and Secrets** > **Add**, choose
**Secret**, enter the variable name exactly, enter its value without exposing it in a
log or ticket, and select **Deploy**. Configure the secrets before merging a website
revision that requires them.

The Render service must expose `/public/api/cycle-status` and
`/public/api/community-dashboard` from the same PostgreSQL state used by the cycle
runner. Both routes are intentionally unauthenticated and return only their normalized
public contracts; private operator APIs remain protected by the Worker credential and
Cloudflare Access.

For the private page, open **Zero Trust** > **Access controls** > **Applications**,
configure the application covering `hookemon.com/operator*`, and keep an **Allow**
policy limited to the approved identity or identity-provider group. Under
**Authentication** > **MFA**, select **Custom MFA settings** (or inherit an enforced
global setting), choose the allowed MFA methods and session duration, then save. Each
operator must enroll and complete MFA before the first `/operator` verification.

The Worker strips cookies, browser authorization, client service credentials, arbitrary
headers, and any client-supplied proxy credential. It blocks redirects and non-HTTPS
service URLs. Neither the Worker nor the isolated control service receives execution
RPCs, wallet keys, signers, or transaction-submission dependencies.
