import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { keccak256Hex } from './keccak.mjs';
import { loadCommittedPreflightPackage, PROGRAMMABLE_API_BASE_URL } from './preflight-package.mjs';

const CHAIN_PATH = '/v4/chains/4663/capabilities';
const SECRET_FIELD = /(?:api.?key|authorization|credential|secret|password|private.?key|access.?token)/iu;

function apiUrl(baseUrl, path) {
  return new URL(path, baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).toString();
}

async function responseJson(response, label) {
  const text = await response.text();
  let body;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!response.ok) {
    const detail = typeof body?.error?.code === 'string' ? ` (${body.error.code})` : '';
    throw new Error(`${label} returned HTTP ${response.status}${detail}`);
  }
  return body;
}

function sameAddress(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.toLowerCase() === right.toLowerCase();
}

function compareField(mismatches, path, actual, expected, comparator = Object.is) {
  if (!comparator(actual, expected)) mismatches.push(`${path}: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
}

function compareResponse(response, expected) {
  const mismatches = [];
  compareField(mismatches, 'profile.structuralProfileId', response?.profile?.structuralProfileId, expected.profile.structuralProfileId);
  compareField(mismatches, 'profile.profileDigest', response?.profile?.profileDigest, expected.profile.profileDigest);
  for (const [key, value] of Object.entries(expected.roots)) compareField(mismatches, `roots.${key}`, response?.roots?.[key], value);
  for (const [key, value] of Object.entries(expected.digests)) compareField(mismatches, `digests.${key}`, response?.digests?.[key], value);
  compareField(mismatches, 'caller', response?.caller, expected.caller, sameAddress);
  compareField(mismatches, 'deployer', response?.deployer, expected.deployer, sameAddress);
  compareField(mismatches, 'graphTransaction.chainId', String(response?.graphTransaction?.chainId ?? ''), expected.graphTransaction.chainId);
  compareField(mismatches, 'graphTransaction.to', response?.graphTransaction?.to, expected.graphTransaction.to, sameAddress);
  compareField(mismatches, 'graphTransaction.value', String(response?.graphTransaction?.value ?? ''), expected.graphTransaction.value);
  if (typeof response?.graphTransaction?.data !== 'string' || !/^0x[0-9a-f]+$/iu.test(response.graphTransaction.data)) {
    mismatches.push('graphTransaction.data: expected non-empty hexadecimal calldata');
  }
  if (Number.isNaN(Date.parse(response?.graphTransaction?.expiresAt ?? ''))) {
    mismatches.push('graphTransaction.expiresAt: expected an ISO-8601 expiry');
  }
  const allowance = response?.seedTransaction?.permit2Allowance;
  for (const [key, value] of Object.entries(expected.seedTransaction.permit2Allowance)) {
    compareField(mismatches, `seedTransaction.permit2Allowance.${key}`, String(allowance?.[key] ?? ''), String(value));
  }
  const deadline = response?.seedTransaction?.deadlineSeconds;
  if (!Number.isInteger(deadline) || deadline < 1 || deadline > expected.seedTransaction.maximumDeadlineSeconds) {
    mismatches.push(`seedTransaction.deadlineSeconds: expected an integer from 1 through ${expected.seedTransaction.maximumDeadlineSeconds}, received ${JSON.stringify(deadline)}`);
  }
  compareField(mismatches, 'seedTransaction.refundDestination', response?.seedTransaction?.refundDestination, expected.seedTransaction.refundDestination, sameAddress);
  return mismatches.map((message, index) => `${index + 1}. ${message}`);
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

function assertCapabilities(capabilities) {
  if (String(capabilities?.chain?.id) !== '4663') throw new Error('capabilities response is not for chain 4663');
  if (capabilities?.safety?.transactionBroadcast !== false) throw new Error('capabilities response does not prohibit provider broadcast');
  if (typeof capabilities?.routes?.preflight !== 'string') throw new Error('capabilities response does not advertise a preflight route');
}

export async function runPreflight({
  root,
  baseUrl = PROGRAMMABLE_API_BASE_URL,
  apiKey,
  outputDirectory = resolve(root, 'release/phase3/preflight'),
  now = () => new Date(),
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('PROGRAMMABLE_API_KEY is required');
  const packageData = loadCommittedPreflightPackage(root);
  const capabilities = await responseJson(await fetch(apiUrl(baseUrl, CHAIN_PATH)), 'capabilities');
  assertCapabilities(capabilities);
  const preflightPath = capabilities.routes.preflight;
  const response = await responseJson(await fetch(apiUrl(baseUrl, preflightPath), {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(packageData.request),
  }), 'preflight');
  const mismatches = compareResponse(response, packageData.expected);
  const evidencePath = writeEvidence(outputDirectory, now(), {
    schemaVersion: 'hookemon.programmable-preflight-evidence.v1',
    apiKey: '[REDACTED]',
    redactions: ['PROGRAMMABLE_API_KEY'],
    package: {
      commit: packageData.commit,
      tree: packageData.tree,
      packageTree: packageData.packageTree,
    },
    capabilities,
    expected: packageData.expected,
    response,
    mismatches,
  });
  return { ...packageData, capabilities, response, mismatches, evidencePath };
}

export async function getPreflightStatus({ baseUrl = PROGRAMMABLE_API_BASE_URL, apiKey, requestId } = {}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('PROGRAMMABLE_API_KEY is required');
  if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('a request ID is required');
  const capabilities = await responseJson(await fetch(apiUrl(baseUrl, CHAIN_PATH)), 'capabilities');
  assertCapabilities(capabilities);
  if (typeof capabilities?.routes?.status !== 'string') throw new Error('capabilities response does not advertise a status route');
  const statusPath = capabilities.routes.status.replace('{launchId}', encodeURIComponent(requestId));
  return stripSecrets(await responseJson(await fetch(apiUrl(baseUrl, statusPath), {
    headers: { authorization: `Bearer ${apiKey}` },
  }), 'status'));
}

export function formatWalletHandoff(result) {
  const { expected, response } = result;
  const calldataDigest = keccak256Hex(Buffer.from(response.graphTransaction.data.slice(2), 'hex'));
  return [
    'WALLET HANDOFF',
    'Transaction 1: graph deployment and pool initialization',
    `chainId: ${expected.graphTransaction.chainId}`,
    `to: ${response.graphTransaction.to}`,
    `value: ${response.graphTransaction.value}`,
    `calldata digest: ${calldataDigest}`,
    `graph digest: ${response.digests.graphDraftSha256}`,
    `expected addresses: ${JSON.stringify(result.graphDraft.graph.targets.map(({ targetId, address }) => ({ targetId, address })))}`,
    'nonce: set in Rabby immediately before signing',
    'gas: set in Rabby immediately before signing',
    `deadline: ${response.graphTransaction.expiresAt}`,
    '',
    'Transaction 2: seed and custody binding',
    `Permit2 allowance: ${expected.seedTransaction.permit2Allowance.amountAtomic} USDG atomic units (240 USDG)`,
    `deadline: ${response.seedTransaction.deadlineSeconds} seconds (must not exceed ${expected.seedTransaction.maximumDeadlineSeconds})`,
    `refund destination: ${response.seedTransaction.refundDestination}`,
    '',
    'Verify in Rabby before signing: chain 4663, recipient, value, calldata digest, graph digest, expected addresses, nonce, gas, deadline, exact 240 USDG Permit2 allowance, and refund destination.',
  ].join('\n');
}
