# Dashboard catalog connection

The composed runner injects `collectorCrypt.getMachines()` into `listPacks` in `packages/adapters/src/app/compose.mjs`. The authenticated `GET /operator/api/packs` route projects that catalog. A standalone preview without this injection has no catalog; starting a second control authority does not connect it.

`packages/dashboard/src/connection/diagnose.mjs` exports `diagnoseDashboardConnection({ origin, credential, accessJwt?, timeoutMs? })`. It reads bootstrap and packs from the same origin and returns sanitized check results. `readConnectionReady` means authenticated authority data and a nonempty, uniquely coded catalog were readable. It does not prove write access, production identity, scheduler execution, persisted settings or purchases. Bootstrap's `executionConnected` value is reported without being reinterpreted.

The diagnostic sends GET requests only, follows no redirects, permits plaintext HTTP only on loopback, and never returns credentials, provider bodies or exception messages. It creates no stores and changes no runtime configuration. Each invocation has no persistent state; unavailable authority, authentication failure, missing/empty catalog and invalid responses remain explicit failures.

Using the credential already supplied to an authorized shell, run `node packages/dashboard/src/connection/diagnose.mjs <dashboard-origin>`. The CLI consumes `HOOKEMON_DASHBOARD_PROXY_CREDENTIAL` and optional `HOOKEMON_DASHBOARD_ACCESS_JWT` from that environment; do not put their values in command arguments or repository files. Exit 0 means read connection ready, 1 means a failed read check, and 2 means invalid diagnostic configuration. The command never starts or replaces the runner.

For recovery, use the actual composed simulation dashboard origin supplied by its coordinator. `CATALOG_NOT_CONFIGURED` requires the composed runner's existing catalog injection; `HTTP_401` requires the runtime's existing access configuration; `HTTP_502` points to the upstream catalog adapter. Do not populate a preview with invented catalog data. The verified simulation endpoint remains an external input, not a hardcoded default.

Focused verification: `node --test packages/dashboard/test/connection/diagnose.test.mjs`. Tests use synthetic credentials, an ephemeral loopback HTTP server and the actual dashboard routes. Runtime baseline is Node 24.19.0 from `.nvmrc`; native fetch and timeout behavior follow [Node 24.19.0 globals documentation](https://nodejs.org/download/release/v24.19.0/docs/api/globals.html).
