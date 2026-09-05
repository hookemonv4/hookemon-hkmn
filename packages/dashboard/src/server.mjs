#!/usr/bin/env node
// The control service behind https://hookemon.com (WP-17 goal). A dependency-free `node:http` server
// (packages/dashboard has no npm dependencies) exposing:
//   GET  /healthz
//   GET  /public/api/cycle-status         (unauthenticated, schemaVersion 3)
//   GET  /public/api/community-dashboard  (unauthenticated, schemaVersion 5)
//   GET  /operator/api/bootstrap          (x-hookemon-proxy-credential [+ Access JWT])
//   GET  /operator/api/dashboard          (            "                          )
//   GET  /operator/api/cards              (            "                          )
//   GET  /operator/api/packs              (            "                          )
//   GET  /operator/api/identities         (            "                          )
//   GET  /operator/api/audit              (            "                          )
//   POST /operator/api/decisions          (            "                          )
//   GET  /                                (unauthenticated built-in status/control page, local use)
//
// `createRequestListener(ctx)` is normally called by the runner composition, which injects the one
// operator-control authority. A directly started server can serve static and health routes, but it
// deliberately does not construct a second control or lifecycle store.
import { createServer as createHttpServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { readAllAuditEntries, verifyAuditChain } from './auth/audit-log.mjs';
import { assertProxyCredentialConfigured, proxyCredentialMatches } from './auth/proxy-credential.mjs';
import { createAccessJwtVerifier } from './auth/access-jwt.mjs';
import { openSqliteProjection } from './storage/sqlite-projection.mjs';
import { readDashboardProfile } from './contracts/dashboard-profile.mjs';
import { healthzHandler, createCycleStatusHandler, createCommunityDashboardHandler, sendJson } from './routes/public.mjs';
import {
  createBootstrapHandler,
  createDashboardHandler,
  createPacksHandler,
  createIdentitiesHandler,
  createNetworkHandler,
  createCardsHandler,
  createAuditHandler,
  createDecisionsHandler,
} from './routes/operator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Build the full route table and an http.RequestListener from an explicit context object (never
 * from `process.env` directly — see `readEnvironmentConfig` for how a real deployment builds one).
 *
 * @param {object} ctx
 * @param {'testnet'|'mainnet'} ctx.profileId
 * @param {string} ctx.proxyCredential
 * @param {{status: () => Promise<object>, execute: (input: object) => Promise<object>}} [ctx.operatorControl]
 *   The runner-composed single authority. Omitting it makes control and status routes return 503.
 * @param {object} ctx.sqliteProjection - an `openSqliteProjection(...)` result.
 * @param {string} ctx.auditLogPath
 * @param {(token: string) => Promise<object>} [ctx.accessJwtVerifier] - optional second factor.
 * @param {() => number} [ctx.now]
 * @param {() => {at: number, intervalMs: number}|null} [ctx.lastTick] - optional; feeds `nextCycleAt`
 *   when this process is composed next to a live scheduler that reports its own tick times.
 * @param {number} [ctx.chainId] - when supplied, must match the selected dashboard profile.
 * @param {object|null} [ctx.catalog] @param {object} [ctx.readiness] - passed straight through to
 *   `/operator/api/bootstrap`.
 * @param {(route: string, error: Error) => void} [ctx.onError]
 * @param {string} [ctx.staticPageHtml] - the built-in status page (defaults to reading
 *   src/public/index.html).
 */
export function createRequestListener(ctx) {
  const full = {
    now: () => Date.now(),
    ...ctx,
  };
  if (full.chainId !== undefined && full.chainId !== null) {
    if (!Number.isSafeInteger(full.chainId) || full.chainId <= 0) throw new Error('dashboard chainId must be a positive integer');
    if (readDashboardProfile(full.profileId).network.evm.chainId !== full.chainId) {
      throw new Error(`dashboard profile ${full.profileId} does not match chain ${full.chainId}`);
    }
  }

  const routes = new Map([
    ['/healthz', { GET: healthzHandler }],
    ['/public/api/cycle-status', { GET: createCycleStatusHandler(full) }],
    ['/public/api/community-dashboard', { GET: createCommunityDashboardHandler(full) }],
    ['/operator/api/bootstrap', { GET: createBootstrapHandler(full) }],
    ['/operator/api/dashboard', { GET: createDashboardHandler(full) }],
    ['/operator/api/packs', { GET: createPacksHandler(full) }],
    ['/operator/api/identities', { GET: createIdentitiesHandler(full) }],
    ['/operator/api/network', { GET: createNetworkHandler(full) }],
    ['/operator/api/cards', { GET: createCardsHandler(full) }],
    ['/operator/api/audit', { GET: createAuditHandler(full) }],
    ['/operator/api/decisions', { POST: createDecisionsHandler(full) }],
  ]);

  return async function requestListener(req, res) {
    const path = req.url.includes('?') ? req.url.slice(0, req.url.indexOf('?')) : req.url;
    if (path === '/' && req.method === 'GET') {
      const html = full.staticPageHtml ?? await readFile(join(__dirname, 'public/index.html'), 'utf8');
      const bytes = Buffer.from(html, 'utf8');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': bytes.length, 'cache-control': 'no-store' });
      res.end(bytes);
      return;
    }
    const route = routes.get(path);
    if (!route) return sendJson(res, 404, { code: 'NOT_FOUND' });
    const handler = route[req.method];
    if (!handler) return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED' });
    try {
      await handler(req, res);
    } catch (error) {
      full.onError?.(path, error);
      if (!res.headersSent) sendJson(res, 500, { code: 'INTERNAL_ERROR' });
    }
  };
}

/** Read `HOOKEMON_STATE_DIR` / `HOOKEMON_DASHBOARD_*` environment variables into a config object
 * (never a full `ctx` — this never opens a file or socket); throws a descriptive error on any
 * missing or malformed required variable, matching packages/adapters/src/app/environment.mjs's own
 * "fail loudly at startup, never silently default a security-relevant value" convention. */
export function readEnvironmentConfig(env = process.env) {
  const stateDir = env.HOOKEMON_STATE_DIR;
  if (typeof stateDir !== 'string' || stateDir.length === 0) throw new Error('HOOKEMON_STATE_DIR is required');
  const proxyCredential = assertProxyCredentialConfigured(env.HOOKEMON_DASHBOARD_PROXY_CREDENTIAL);
  const profileId = env.HOOKEMON_DASHBOARD_PROFILE ?? 'mainnet';
  if (profileId !== 'testnet' && profileId !== 'mainnet') throw new Error('HOOKEMON_DASHBOARD_PROFILE must be "testnet" or "mainnet"');
  const chainText = env.HOOKEMON_CHAIN_ID;
  const chainId = chainText === undefined ? null : Number(chainText);
  if (chainText !== undefined && (!Number.isSafeInteger(chainId) || chainId <= 0)) throw new Error('HOOKEMON_CHAIN_ID must be a positive integer');
  if (chainId !== null && readDashboardProfile(profileId).network.evm.chainId !== chainId) {
    throw new Error(`dashboard profile ${profileId} does not match chain ${chainId}`);
  }
  const port = Number(env.HOOKEMON_DASHBOARD_PORT ?? '8787');
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('HOOKEMON_DASHBOARD_PORT must be a valid port number');

  const jwksUrl = env.HOOKEMON_DASHBOARD_ACCESS_JWKS_URL;
  const issuer = env.HOOKEMON_DASHBOARD_ACCESS_ISSUER;
  const audience = env.HOOKEMON_DASHBOARD_ACCESS_AUDIENCE;
  const accessConfigured = [jwksUrl, issuer, audience].filter(value => value !== undefined).length;
  if (accessConfigured !== 0 && accessConfigured !== 3) {
    throw new Error('HOOKEMON_DASHBOARD_ACCESS_JWKS_URL/ISSUER/AUDIENCE must be set together or not at all');
  }

  return {
    stateDir,
    proxyCredential,
    profileId,
    chainId,
    port,
    sqlitePath: env.HOOKEMON_DASHBOARD_SQLITE_PATH ?? join(stateDir, 'dashboard-projection.sqlite'),
    auditLogPath: env.HOOKEMON_DASHBOARD_AUDIT_LOG_PATH ?? join(stateDir, 'dashboard-audit.log'),
    access: accessConfigured === 3 ? { jwksUrl, issuer, audience } : null,
  };
}

/** Build a standalone context with only rebuildable dashboard storage. The composed runner passes
 * its own authority into `createRequestListener`; this function never opens a cycle repository. */
export async function buildContext(config) {
  const auditCheck = await verifyAuditChain(config.auditLogPath);
  if (!auditCheck.valid) {
    throw new Error(`dashboard audit chain is invalid at sequence ${auditCheck.brokenAtSequence}: ${auditCheck.reason}`);
  }
  const auditEntries = await readAllAuditEntries(config.auditLogPath);
  const sqliteProjection = openSqliteProjection(config.sqlitePath);
  sqliteProjection.rebuildAuditProjection(auditEntries);

  const accessJwtVerifier = config.access
    ? createAccessJwtVerifier({ jwksUrl: config.access.jwksUrl, issuer: config.access.issuer, audience: config.access.audience })
    : undefined;

  return {
    profileId: config.profileId,
    chainId: config.chainId,
    proxyCredential: config.proxyCredential,
    operatorControl: null,
    sqliteProjection,
    auditLogPath: config.auditLogPath,
    accessJwtVerifier,
    onError(route, error) {
      // eslint-disable-next-line no-console -- this service has no injected logger seam; stderr is
      // the whole observability story for a dependency-free node:http process.
      console.error(`[dashboard] ${route} failed:`, error);
    },
    async close() {
      sqliteProjection.close();
    },
  };
}

async function main() {
  const config = readEnvironmentConfig();
  const ctx = await buildContext(config);
  const listener = createRequestListener(ctx);
  const server = createHttpServer(listener);
  await new Promise(resolve => server.listen(config.port, resolve));
  // eslint-disable-next-line no-console
  console.log(`[dashboard] listening on :${config.port} (profile=${config.profileId})`);

  const shutdown = async () => {
    server.close();
    await ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(error => {
    console.error('[dashboard] fatal startup error:', error);
    process.exitCode = 1;
  });
}

// Re-exported for auth checks that only need the primitive (tests, and any future in-process
// composition root that wants to authenticate a request outside the HTTP layer).
export { proxyCredentialMatches };
