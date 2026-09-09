#!/usr/bin/env node
// Read-only check of an existing composed dashboard, never a replacement server.
import { pathToFileURL } from 'node:url';
import { assertProxyCredentialConfigured } from '../auth/proxy-credential.mjs';
import { assertBootstrap } from '../contracts/operator-contracts.mjs';

export async function diagnoseDashboardConnection({ origin, credential, accessJwt, timeoutMs = 5000 }) {
  let url;
  try { url = new URL(origin); } catch { throw new Error('dashboard origin is invalid'); }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('dashboard requires an HTTPS origin or loopback HTTP origin without credentials, path, query or fragment');
  }
  assertProxyCredentialConfigured(credential);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) throw new Error('invalid diagnostic timeout');
  const headers = { 'x-hookemon-proxy-credential': credential };
  if (accessJwt) headers['cf-access-jwt-assertion'] = accessJwt;
  const checks = [];
  for (const endpoint of ['bootstrap', 'packs']) {
    try {
      const response = await fetch(new URL(`/operator/api/${endpoint}`, url), {
        method: 'GET', headers, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        checks.push({ endpoint, ok: false, code: `HTTP_${response.status}` });
        await response.body?.cancel();
        continue;
      }
      const body = await response.json();
      if (endpoint === 'bootstrap') {
        assertBootstrap(body);
        checks.push({ endpoint, ok: true, code: 'AUTHORITY_READABLE', executionConnected: body.executionConnected });
      } else if (body?.configured === false && Array.isArray(body.machines)) {
        checks.push({ endpoint, ok: false, code: 'CATALOG_NOT_CONFIGURED' });
      } else if (body?.configured !== true || !Array.isArray(body.machines)
        || body.machines.some(machine => typeof machine?.code !== 'string' || !machine.code.trim())
        || new Set(body.machines.map(machine => machine.code)).size !== body.machines.length) {
        checks.push({ endpoint, ok: false, code: 'CATALOG_INVALID' });
      } else {
        checks.push({ endpoint, ok: body.machines.length > 0,
          code: body.machines.length ? 'CATALOG_READABLE' : 'CATALOG_EMPTY', packCount: body.machines.length });
      }
    } catch {
      // Never echo provider bodies, URLs, credentials or exception messages into diagnostic output.
      checks.push({ endpoint, ok: false, code: 'REQUEST_OR_RESPONSE_INVALID' });
    }
  }
  return { readConnectionReady: checks.every(check => check.ok), writesTested: false, checks };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await diagnoseDashboardConnection({ origin: process.argv[2],
      credential: process.env.HOOKEMON_DASHBOARD_PROXY_CREDENTIAL,
      accessJwt: process.env.HOOKEMON_DASHBOARD_ACCESS_JWT });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exitCode = result.readConnectionReady ? 0 : 1;
  } catch {
    process.stderr.write('Diagnostic configuration invalid; provide an origin and the existing dashboard credential through the environment.\n');
    process.exitCode = 2;
  }
}
