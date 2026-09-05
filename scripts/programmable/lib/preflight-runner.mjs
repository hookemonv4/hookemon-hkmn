import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  assembleV4PreflightRequest,
  loadCommittedPreflightPackage,
  PROGRAMMABLE_API_BASE_URL,
  ROBINHOOD_RPC_URL,
} from './preflight-package.mjs';

const CHAIN_PATH = '/v4/chains/4663/capabilities';
const PREFLIGHT_PATH = '/v4/chains/4663/custom-launches/preflight';
const STATUS_PATH = '/v4/chains/4663/custom-launches/{launchId}';
const SECRET_FIELD = /(?:api.?key|authorization|credential|secret|password|private.?key|access.?token)/iu;

function apiUrl(baseUrl, path) {
  const base = new URL(baseUrl);
  if (base.username || base.password) throw new Error('provider API base URL must not contain credentials');
  const target = new URL(path, base);
  if (target.origin !== base.origin) throw new Error('provider route must remain on the configured API origin');
  return target.toString();
}

async function responseJson(response, label, { allowError = false } = {}) {
  const text = await response.text();
  let body;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!response.ok && !allowError) {
    const detail = typeof body?.error?.code === 'string' ? ` (${body.error.code})` : '';
    throw new Error(`${label} returned HTTP ${response.status}${detail}`);
  }
  return { status: response.status, ok: response.ok, body };
}

export function stripSecrets(value) {
  if (Array.isArray(value)) return value.map(stripSecrets);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SECRET_FIELD.test(key))
    .map(([key, child]) => [key, stripSecrets(child)]));
}

function evidenceName(now) {
  return now.toISOString().replace(/[:.]/gu, '-');
}

function writeEvidence(outputDirectory, now, body) {
  mkdirSync(outputDirectory, { recursive: true });
  const path = resolve(outputDirectory, `${evidenceName(now)}.json`);
  writeFileSync(path, `${JSON.stringify(stripSecrets(body), null, 2)}\n`, { mode: 0o600 });
  return path;
}

function assertCapabilities(capabilities, { requireStatusRoute = false } = {}) {
  if (String(capabilities?.chain?.id) !== '4663') throw new Error('capabilities response is not for chain 4663');
  if (capabilities?.chain?.caip2 !== 'eip155:4663') throw new Error('capabilities response is not for eip155:4663');
  if (capabilities?.safety?.transactionBroadcast !== false) throw new Error('capabilities response does not prohibit provider broadcast');
  if (capabilities?.routes?.preflight !== PREFLIGHT_PATH) {
    throw new Error('capabilities response does not advertise the recorded preflight route');
  }
  if (requireStatusRoute && capabilities?.routes?.status !== STATUS_PATH) {
    throw new Error('capabilities response does not advertise the recorded status route');
  }
}

export async function readLaunchWalletNonce({ rpcUrl = ROBINHOOD_RPC_URL, launchWallet, fetchImpl = fetch } = {}) {
  const response = await responseJson(await fetchImpl(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getTransactionCount', params: [launchWallet, 'latest'] }),
  }), 'Robinhood RPC');
  if (typeof response.body?.result !== 'string' || !/^0x[0-9a-f]+$/iu.test(response.body.result)) {
    throw new Error('Robinhood RPC returned an invalid nonce');
  }
  return response.body.result;
}

function providerError(response) {
  const code = response.body?.error?.code;
  const message = response.body?.error?.message;
  return typeof code === 'string' ? `${code}${typeof message === 'string' ? `: ${message}` : ''}` : `HTTP ${response.status}`;
}

export async function runPreflight({
  root,
  baseUrl = PROGRAMMABLE_API_BASE_URL,
  rpcUrl = ROBINHOOD_RPC_URL,
  apiKey,
  source,
  outputDirectory = resolve(root, 'release/phase3/preflight'),
  now = () => new Date(),
  packageData,
  requestTemplate,
  contract,
  pinnedCapabilities,
  launchWallet,
  nonce,
  fetchImpl = fetch,
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('PROGRAMMABLE_API_KEY is required');
  const committed = requestTemplate === undefined && packageData === undefined
    ? loadCommittedPreflightPackage(root, { source })
    : {};
  const template = packageData?.request ?? requestTemplate ?? committed.template;
  const activeContract = packageData?.contract ?? contract ?? committed.contract;
  const activePinnedCapabilities = packageData?.pinnedCapabilities ?? pinnedCapabilities ?? committed.pinnedCapabilities;
  const activeLaunchWallet = packageData?.launchWallet ?? launchWallet ?? committed.launchWallet;
  if (template === undefined) throw new Error('a V4 request template is required');
  if (activeContract === undefined) throw new Error('a recorded V4 request contract is required');
  if (activePinnedCapabilities === undefined) throw new Error('pinned provider capabilities are required');
  if (typeof activeLaunchWallet !== 'string' || activeLaunchWallet.length === 0) throw new Error('launchWallet is required');
  const capabilityResponse = await responseJson(await fetchImpl(apiUrl(baseUrl, CHAIN_PATH)), 'capabilities');
  const capabilities = capabilityResponse.body;
  assertCapabilities(capabilities);
  const assembledRequest = assembleV4PreflightRequest({
    template,
    contract: activeContract,
    capabilities,
    pinnedCapabilities: activePinnedCapabilities,
    launchWallet: activeLaunchWallet,
    nonce: nonce ?? await readLaunchWalletNonce({ rpcUrl, launchWallet: activeLaunchWallet, fetchImpl }),
    now: now(),
  });
  const providerResponse = await responseJson(await fetchImpl(apiUrl(baseUrl, PREFLIGHT_PATH), {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(assembledRequest),
  }), 'preflight', { allowError: true });
  const mismatches = providerResponse.ok ? [] : [`1. provider: ${providerError(providerResponse)}`];
  const evidencePath = writeEvidence(outputDirectory, now(), {
    schemaVersion: 'hookemon.programmable-preflight-evidence.v2',
    redactions: ['PROGRAMMABLE_API_KEY'],
    request: assembledRequest,
    capabilities,
    providerResponse: { httpStatus: providerResponse.status, body: providerResponse.body },
    mismatches,
  });
  if (!providerResponse.ok) {
    const error = new Error(`preflight returned ${providerError(providerResponse)}`);
    error.evidencePath = evidencePath;
    error.mismatches = mismatches;
    throw error;
  }
  return { request: assembledRequest, capabilities, response: providerResponse.body, mismatches, evidencePath };
}

export async function getPreflightStatus({ baseUrl = PROGRAMMABLE_API_BASE_URL, apiKey, requestId, fetchImpl = fetch } = {}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('PROGRAMMABLE_API_KEY is required');
  if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('a request ID is required');
  const capabilities = (await responseJson(await fetchImpl(apiUrl(baseUrl, CHAIN_PATH)), 'capabilities')).body;
  assertCapabilities(capabilities, { requireStatusRoute: true });
  const statusPath = STATUS_PATH.replace('{launchId}', encodeURIComponent(requestId));
  return stripSecrets((await responseJson(await fetchImpl(apiUrl(baseUrl, statusPath), {
    headers: { authorization: `Bearer ${apiKey}` },
  }), 'status')).body);
}

export function formatWalletHandoff(result) {
  return [
    'READ-ONLY PREFLIGHT',
    `evidence: ${result.evidencePath}`,
    `request schema: ${result.request.schemaVersion}`,
    'A preflight response does not authorize signing, broadcast, or deployment.',
  ].join('\n');
}
