import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

import {
  assembleV4PreflightRequest,
  assertV4CapabilitiesMatch,
  loadCommittedPreflightPackage,
  normalizeV4PublicSource,
  PROGRAMMABLE_API_BASE_URL,
} from './preflight-package.mjs';
import {
  assertLaunchAttemptSource,
  assertV4LaunchAttemptStoragePath,
  createV4LaunchAttempt,
  defaultV4LaunchAttemptPath,
  generateV4LaunchNonce,
  launchAttemptRequestBytes,
  readV4LaunchAttempt,
} from './launch-attempt.mjs';
import { assertSourceBundleMatchesCommit, buildSourceBundleDescriptor } from './source-bundle.mjs';
import { buildPhaseThreeSourceBundle } from './source-bundle-coverage.mjs';

const CHAIN_PATH = '/v4/chains/4663/capabilities';
const PREFLIGHT_PATH = '/v4/chains/4663/custom-launches/preflight';
const STATUS_PATH = '/v4/chains/4663/custom-launches/{launchId}';
const SECRET_FIELD = /(?:api.?key|authorization|credential|secret|password|private.?key|access.?token)/iu;
const MAXIMUM_PREFLIGHT_REQUESTS = 5;
const RESERVATION_SUFFIX = '.pending.json';
const RESERVATION_LOCK_FILENAME = '.reservation.lock';

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

function redactText(value, secrets) {
  if (typeof value !== 'string') return value;
  return secrets.reduce((redacted, secret) => (
    typeof secret === 'string' && secret.length > 0 ? redacted.split(secret).join('[REDACTED]') : redacted
  ), value);
}

export function stripSecrets(value, { secrets = [] } = {}) {
  if (typeof value === 'string') return redactText(value, secrets);
  if (Array.isArray(value)) return value.map((item) => stripSecrets(item, { secrets }));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SECRET_FIELD.test(key))
    .map(([key, child]) => [key, stripSecrets(child, { secrets })]));
}

function evidenceName(now) {
  return now.toISOString().replace(/[:.]/gu, '-');
}

function evidenceReservationFilenames(outputDirectory) {
  if (!existsSync(outputDirectory)) return [];
  return readdirSync(outputDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(RESERVATION_SUFFIX))
    .map((entry) => entry.name);
}

function evidenceRecordFilenames(outputDirectory) {
  if (!existsSync(outputDirectory)) return [];
  return readdirSync(outputDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json') && !entry.name.endsWith(RESERVATION_SUFFIX))
    .map((entry) => entry.name);
}

function evidenceAttemptCount(outputDirectory) {
  return evidenceRecordFilenames(outputDirectory).length + evidenceReservationFilenames(outputDirectory).length;
}

function withReservationLock(outputDirectory, callback, { validateStoragePath = (candidate) => candidate } = {}) {
  let checkedDirectory = validateStoragePath(assertV4LaunchAttemptStoragePath(outputDirectory));
  mkdirSync(checkedDirectory, { recursive: true, mode: 0o700 });
  checkedDirectory = validateStoragePath(assertV4LaunchAttemptStoragePath(checkedDirectory));
  const directoryStat = lstatSync(checkedDirectory);
  if (!directoryStat.isDirectory() || (directoryStat.mode & 0o077) !== 0) {
    throw new Error('preflight evidence directory must be private');
  }
  const lockPath = resolve(checkedDirectory, RESERVATION_LOCK_FILENAME);
  try {
    writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid })}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('another preflight request is reserving this launch attempt');
    throw error;
  }
  try {
    return callback(checkedDirectory);
  } finally {
    unlinkSync(lockPath);
  }
}

export function v4PreflightEvidenceDirectory(launchAttemptPath, nonce) {
  if (typeof launchAttemptPath !== 'string' || launchAttemptPath.length === 0) throw new Error('launch attempt path is required');
  if (typeof nonce !== 'string' || !/^0x[0-9a-f]{64}$/u.test(nonce)) throw new Error('launch attempt nonce must be 0x plus 64 lowercase hex characters');
  const attemptPath = assertV4LaunchAttemptStoragePath(launchAttemptPath);
  return resolve(dirname(attemptPath), 'preflight-evidence', nonce.slice(2));
}

function reservePreflightRequest(outputDirectory, now, attempt, { validateStoragePath } = {}) {
  return withReservationLock(outputDirectory, (checkedDirectory) => {
    const index = evidenceAttemptCount(checkedDirectory) + 1;
    if (index > MAXIMUM_PREFLIGHT_REQUESTS) throw new Error('a launch attempt permits at most 5 preflight requests');
    const stem = `${evidenceName(now)}-${String(index).padStart(2, '0')}`;
    const reservationPath = resolve(checkedDirectory, `${stem}${RESERVATION_SUFFIX}`);
    const evidencePath = resolve(checkedDirectory, `${stem}.json`);
    writeFileSync(reservationPath, `${JSON.stringify({
      schemaVersion: 'hookemon.programmable-preflight-reservation.v1',
      requestedAt: now.toISOString(),
      requestSha256: attempt.request.sha256,
      state: 'reserved',
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return { reservationPath, evidencePath };
  }, { validateStoragePath });
}

function writeEvidence(reservation, body, { secrets = [] } = {}) {
  writeFileSync(reservation.evidencePath, `${JSON.stringify(stripSecrets(body, { secrets }), null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx',
  });
  unlinkSync(reservation.reservationPath);
  return reservation.evidencePath;
}

function assertAttemptPathOutsideRepository(root, launchAttemptPath) {
  if (typeof root !== 'string' || root.length === 0) throw new Error('repository root is required');
  const repositoryRoot = realpathSync(resolve(root));
  const path = assertV4LaunchAttemptStoragePath(launchAttemptPath);
  const relation = relative(repositoryRoot, path);
  if (relation === '' || (!isAbsolute(relation) && relation !== '..' && !relation.startsWith(`..${sep}`))) {
    throw new Error('launch attempt records must be stored outside the repository');
  }
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

function providerError(response, { secrets = [] } = {}) {
  const code = redactText(response.body?.error?.code, secrets);
  const message = redactText(response.body?.error?.message, secrets);
  return typeof code === 'string' ? `${code}${typeof message === 'string' ? `: ${message}` : ''}` : `HTTP ${response.status}`;
}

function packageInputs({ root, source, packageData, requestTemplate, contract, pinnedCapabilities, launchWallet }) {
  const committed = requestTemplate === undefined && packageData === undefined
    ? loadCommittedPreflightPackage(root, { source })
    : {};
  const template = packageData?.request ?? requestTemplate ?? committed.template;
  const activeContract = packageData?.contract ?? contract ?? committed.contract;
  const activePinnedCapabilities = packageData?.pinnedCapabilities ?? pinnedCapabilities ?? committed.pinnedCapabilities;
  const activeLaunchWallet = packageData?.launchWallet ?? launchWallet ?? committed.launchWallet;
  const sourceBundleCoverage = packageData !== undefined && Object.hasOwn(packageData, 'sourceBundleCoverage')
    ? packageData.sourceBundleCoverage
    : committed.sourceBundleCoverage;
  const providerDocuments = packageData?.providerDocuments ?? committed.providerDocuments ?? { v4RequestContract: activeContract };
  if (template === undefined) throw new Error('a V4 request template is required');
  if (activeContract === undefined) throw new Error('a recorded V4 request contract is required');
  if (activePinnedCapabilities === undefined) throw new Error('pinned provider capabilities are required');
  if (typeof activeLaunchWallet !== 'string' || activeLaunchWallet.length === 0) throw new Error('launchWallet is required');
  return {
    template,
    activeContract,
    activePinnedCapabilities,
    activeLaunchWallet,
    providerDocuments,
    sourceBundleCoverage,
    requiresSourceBundleCoverage: true,
  };
}

function bindSourceBundle(template, { root, coverage, launchWallet, source, required }) {
  if (coverage === undefined) {
    if (required) throw new Error('the committed package does not declare source bundle coverage');
    return template;
  }
  const { manifest } = buildPhaseThreeSourceBundle({ root, coverage, sourceCommit: source.sourceCommit });
  assertSourceBundleMatchesCommit({ root, sourceCommit: source.sourceCommit, manifest });
  const descriptor = buildSourceBundleDescriptor({
    manifest,
    controllerWallet: launchWallet,
    sourceLineageNonce: '1',
    source,
  });
  const request = structuredClone(template);
  request.sourceBundleManifest = manifest;
  request.sourceDescriptor = descriptor;
  if (request.graphBundle !== null && typeof request.graphBundle === 'object') {
    request.graphBundle.sourceBundleSha256 = descriptor.bundleContentSha256;
  }
  return request;
}

function parseRecordedRequest(record) {
  const bytes = launchAttemptRequestBytes(record);
  try {
    return { bytes, request: JSON.parse(bytes.toString('utf8')) };
  } catch {
    throw new Error('launch attempt request bytes are not JSON');
  }
}

/**
 * Resolves the one immutable request for a launch attempt. A retry reads the
 * persisted bytes before any provider request and never reserializes them.
 */
export async function prepareV4PreflightAttempt({
  root,
  baseUrl = PROGRAMMABLE_API_BASE_URL,
  source,
  launchAttemptPath = defaultV4LaunchAttemptPath(),
  newLaunchAttempt = false,
  now = () => new Date(),
  randomBytes,
  packageData,
  requestTemplate,
  contract,
  pinnedCapabilities,
  launchWallet,
  fetchImpl = fetch,
} = {}) {
  if (source === undefined) throw new Error('source flags are required for a launch attempt');
  const resolvedAttemptPath = assertAttemptPathOutsideRepository(root, launchAttemptPath);
  const normalizedSource = normalizeV4PublicSource(root, source);
  const inputs = packageInputs({ root, source: normalizedSource, packageData, requestTemplate, contract, pinnedCapabilities, launchWallet });
  const attemptExists = existsSync(resolvedAttemptPath);
  if (attemptExists && newLaunchAttempt) {
    throw new Error('the launch attempt record already exists; choose a new --launch-attempt path');
  }
  let record = null;
  if (attemptExists && !newLaunchAttempt) {
    record = assertLaunchAttemptSource(readV4LaunchAttempt(resolvedAttemptPath), normalizedSource);
  }

  const template = record === null
    ? bindSourceBundle(inputs.template, {
      root,
      coverage: inputs.sourceBundleCoverage,
      launchWallet: inputs.activeLaunchWallet,
      source: normalizedSource,
      required: inputs.requiresSourceBundleCoverage,
    })
    : inputs.template;
  if (record === null && !newLaunchAttempt) {
    throw new Error('a new launch attempt requires --new-launch-attempt');
  }

  const capabilityResponse = await responseJson(await fetchImpl(apiUrl(baseUrl, CHAIN_PATH), { redirect: 'error' }), 'capabilities');
  const capabilities = capabilityResponse.body;
  assertCapabilities(capabilities);
  assertV4CapabilitiesMatch(capabilities, inputs.activePinnedCapabilities);

  if (record === null) {
    const nonce = generateV4LaunchNonce(randomBytes === undefined ? {} : { randomBytes });
    const request = assembleV4PreflightRequest({
      template,
      contract: inputs.activeContract,
      capabilities,
      pinnedCapabilities: inputs.activePinnedCapabilities,
      launchWallet: inputs.activeLaunchWallet,
      nonce,
      now: now(),
      allowUnresolved: true,
    });
    record = createV4LaunchAttempt({
      path: resolvedAttemptPath,
      source: normalizedSource,
      request,
      providerDocuments: inputs.providerDocuments,
      newLaunchAttempt,
      nonce,
      randomBytes,
      now,
      validateStoragePath: (path) => assertAttemptPathOutsideRepository(root, path),
    });
  }
  const recorded = parseRecordedRequest(record);
  return {
    attempt: record,
    attemptPath: resolvedAttemptPath,
    capabilities,
    request: recorded.request,
    requestBytes: recorded.bytes,
  };
}

export async function runPreflight({
  root,
  baseUrl = PROGRAMMABLE_API_BASE_URL,
  apiKey,
  source,
  launchAttemptPath = defaultV4LaunchAttemptPath(),
  newLaunchAttempt = false,
  now = () => new Date(),
  randomBytes,
  packageData,
  requestTemplate,
  contract,
  pinnedCapabilities,
  launchWallet,
  fetchImpl = fetch,
} = {}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('PROGRAMMABLE_API_KEY is required');
  const prepared = await prepareV4PreflightAttempt({
    root,
    baseUrl,
    source,
    launchAttemptPath,
    newLaunchAttempt,
    now,
    randomBytes,
    packageData,
    requestTemplate,
    contract,
    pinnedCapabilities,
    launchWallet,
    fetchImpl,
  });
  const activeOutputDirectory = assertAttemptPathOutsideRepository(
    root,
    v4PreflightEvidenceDirectory(prepared.attemptPath, prepared.attempt.nonce),
  );
  const reservation = reservePreflightRequest(activeOutputDirectory, now(), prepared.attempt, {
    validateStoragePath: (path) => assertAttemptPathOutsideRepository(root, path),
  });
  let providerResponse;
  try {
    providerResponse = await responseJson(await fetchImpl(apiUrl(baseUrl, PREFLIGHT_PATH), {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: prepared.requestBytes,
    }), 'preflight', { allowError: true });
  } catch {
    const evidencePath = writeEvidence(reservation, {
      schemaVersion: 'hookemon.programmable-preflight-evidence.v3',
      redactions: ['PROGRAMMABLE_API_KEY'],
      request: prepared.request,
      requestSha256: prepared.attempt.request.sha256,
      capabilities: prepared.capabilities,
      providerResponse: { httpStatus: null, transportError: '[REDACTED_TRANSPORT_ERROR]' },
      mismatches: ['1. provider: transport failed'],
    }, { secrets: [apiKey] });
    const error = new Error('preflight transport failed');
    error.evidencePath = evidencePath;
    throw error;
  }
  const mismatches = providerResponse.ok ? [] : [`1. provider: ${providerError(providerResponse, { secrets: [apiKey] })}`];
  const evidencePath = writeEvidence(reservation, {
    schemaVersion: 'hookemon.programmable-preflight-evidence.v3',
    redactions: ['PROGRAMMABLE_API_KEY'],
    request: prepared.request,
    requestSha256: prepared.attempt.request.sha256,
    capabilities: prepared.capabilities,
    providerResponse: { httpStatus: providerResponse.status, body: providerResponse.body },
    mismatches,
  }, { secrets: [apiKey] });
  if (!providerResponse.ok) {
    const error = new Error(`preflight returned ${providerError(providerResponse, { secrets: [apiKey] })}`);
    error.evidencePath = evidencePath;
    error.mismatches = mismatches;
    throw error;
  }
  return {
    request: prepared.request,
    requestBytes: prepared.requestBytes,
    launchAttemptPath: prepared.attemptPath,
    capabilities: prepared.capabilities,
    response: providerResponse.body,
    mismatches,
    evidencePath,
  };
}

export async function getPreflightStatus({ baseUrl = PROGRAMMABLE_API_BASE_URL, apiKey, requestId, fetchImpl = fetch } = {}) {
  if (typeof apiKey !== 'string' || apiKey.length === 0) throw new Error('PROGRAMMABLE_API_KEY is required');
  if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('a request ID is required');
  const capabilities = (await responseJson(await fetchImpl(apiUrl(baseUrl, CHAIN_PATH), { redirect: 'error' }), 'capabilities')).body;
  assertCapabilities(capabilities, { requireStatusRoute: true });
  const statusPath = STATUS_PATH.replace('{launchId}', encodeURIComponent(requestId));
  return stripSecrets((await responseJson(await fetchImpl(apiUrl(baseUrl, statusPath), {
    redirect: 'error',
    headers: { authorization: `Bearer ${apiKey}` },
  }), 'status')).body, { secrets: [apiKey] });
}

export function formatWalletHandoff(result) {
  return [
    'READ-ONLY PREFLIGHT',
    `evidence: ${result.evidencePath}`,
    `launch attempt: ${result.launchAttemptPath}`,
    `request schema: ${result.request.schemaVersion}`,
    'A preflight response does not authorize signing, broadcast, or deployment.',
  ].join('\n');
}
