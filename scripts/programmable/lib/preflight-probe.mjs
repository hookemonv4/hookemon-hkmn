import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { stripSecrets } from './preflight-runner.mjs';

const PREFLIGHT_PATH = '/v4/chains/4663/custom-launches/preflight';
const DEFAULT_API_BASE_URL = 'https://api.programmable.market';
const MINIMUM_INTERVAL_MS = 10_000;
const MAXIMUM_PROBES = 60;
const PROBE_RESERVATION_SUFFIX = '.pending.json';
const PROBE_LOCK_FILENAME = '.reservation.lock';

function requiredString(value, name) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function preflightUrl(baseUrl) {
  const base = new URL(baseUrl);
  if (base.origin !== DEFAULT_API_BASE_URL || base.username || base.password) {
    throw new Error('preflight probe requires the fixed provider origin');
  }
  return `${DEFAULT_API_BASE_URL}${PREFLIGHT_PATH}`;
}

function responseBody(text) {
  try {
    return text === '' ? null : JSON.parse(text);
  } catch {
    return { unparsedBody: '[REDACTED_NON_JSON]', byteLength: Buffer.byteLength(text, 'utf8') };
  }
}

function probeRecordFilenames(outputDirectory) {
  if (!existsSync(outputDirectory)) return [];
  return readdirSync(outputDirectory).filter((entry) => /^\d{3}\.json$/u.test(entry));
}

function probeReservationFilenames(outputDirectory) {
  if (!existsSync(outputDirectory)) return [];
  return readdirSync(outputDirectory).filter((entry) => /^\d{3}\.pending\.json$/u.test(entry));
}

function probeIdFromFilename(filename) {
  return filename.slice(0, 3);
}

function latestProbeTimestamp(outputDirectory) {
  if (!existsSync(outputDirectory)) return null;
  let latest = null;
  for (const filename of [...probeRecordFilenames(outputDirectory), ...probeReservationFilenames(outputDirectory)]) {
    let record;
    try {
      record = JSON.parse(readFileSync(resolve(outputDirectory, filename), 'utf8'));
    } catch {
      throw new Error(`probe log record is unreadable: ${filename}`);
    }
    const timestamp = new Date(record?.recordedAt);
    if (Number.isNaN(timestamp.getTime())) throw new Error(`probe log record has no valid timestamp: ${filename}`);
    if (latest === null || timestamp > latest) latest = timestamp;
  }
  return latest;
}

function enforceProbeLimits(outputDirectory, recordedAt) {
  const attemptIds = new Set([
    ...probeRecordFilenames(outputDirectory),
    ...probeReservationFilenames(outputDirectory),
  ].map(probeIdFromFilename));
  if (attemptIds.size >= MAXIMUM_PROBES) throw new Error('preflight probe log has reached the maximum of 60 requests');
  const previous = latestProbeTimestamp(outputDirectory);
  if (previous !== null && recordedAt.getTime() - previous.getTime() < MINIMUM_INTERVAL_MS) {
    throw new Error('preflight probes must be at least 10 seconds apart');
  }
}

function assertProbeIdUnused(outputDirectory, probeId) {
  if (existsSync(resolve(outputDirectory, `${probeId}.json`))
    || existsSync(resolve(outputDirectory, `${probeId}${PROBE_RESERVATION_SUFFIX}`))) {
    throw new Error(`preflight probe log record already exists: ${probeId}.json`);
  }
}

function clearCompletedReservations(outputDirectory) {
  for (const filename of probeReservationFilenames(outputDirectory)) {
    const probeId = probeIdFromFilename(filename);
    if (existsSync(resolve(outputDirectory, `${probeId}.json`))) {
      unlinkSync(resolve(outputDirectory, filename));
    }
  }
}

function reservationLockPath(outputDirectory) {
  return resolve(outputDirectory, PROBE_LOCK_FILENAME);
}

function withReservationLock(outputDirectory, callback) {
  mkdirSync(outputDirectory, { recursive: true });
  const lockPath = reservationLockPath(outputDirectory);
  try {
    writeFileSync(lockPath, `${JSON.stringify({ pid: process.pid })}\n`, { mode: 0o600, flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('another preflight probe is reserving a request');
    throw error;
  }
  try {
    return callback();
  } finally {
    unlinkSync(lockPath);
  }
}

function reserveProbe({ outputDirectory, probeId, now, request, summary, url }) {
  return withReservationLock(outputDirectory, () => {
    clearCompletedReservations(outputDirectory);
    enforceProbeLimits(outputDirectory, now);
    assertProbeIdUnused(outputDirectory, probeId);
    const path = resolve(outputDirectory, `${probeId}${PROBE_RESERVATION_SUFFIX}`);
    writeFileSync(path, `${JSON.stringify({
      schemaVersion: 'hookemon.programmable-preflight-probe-reservation.v1',
      probeId,
      recordedAt: now.toISOString(),
      state: 'reserved',
      route: {
        method: 'POST',
        url,
        headers: { authorization: '[REDACTED]', 'content-type': 'application/json' },
      },
      request: stripSecrets(request),
      learned: summary,
    }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    return path;
  });
}

function clearReservation(path) {
  if (existsSync(path)) unlinkSync(path);
}

function writeProbeEvidence({ outputDirectory, probeId, now, request, response, summary, url }) {
  const path = resolve(outputDirectory, `${probeId}.json`);
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(path, `${JSON.stringify({
    schemaVersion: 'hookemon.programmable-preflight-probe.v1',
    probeId,
    recordedAt: now.toISOString(),
    route: {
      method: 'POST',
      url,
      headers: { authorization: '[REDACTED]', 'content-type': 'application/json' },
    },
    request: stripSecrets(request),
    response: response === null
      ? { httpStatus: null, transportError: '[REDACTED_TRANSPORT_ERROR]' }
      : { httpStatus: response.status, body: stripSecrets(response.body) },
    learned: summary,
  }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return path;
}

export async function sendPreflightProbe({
  apiKey,
  request,
  probeId,
  summary,
  outputDirectory,
  baseUrl = DEFAULT_API_BASE_URL,
  now = () => new Date(),
  fetchImpl = fetch,
} = {}) {
  const credential = requiredString(apiKey, 'PROGRAMMABLE_API_KEY');
  const id = requiredString(probeId, 'probeId');
  if (!/^\d{3}$/u.test(id)) throw new Error('probeId must be a three-digit sequence');
  requiredString(summary, 'summary');
  requiredString(outputDirectory, 'outputDirectory');
  if (request === null || typeof request !== 'object' || Array.isArray(request)) throw new Error('request must be an object');
  const recordedAt = now();
  if (!(recordedAt instanceof Date) || Number.isNaN(recordedAt.getTime())) throw new Error('now must return a valid Date');
  const url = preflightUrl(baseUrl);
  const reservationPath = reserveProbe({
    outputDirectory,
    probeId: id,
    now: recordedAt,
    request,
    summary,
    url,
  });
  let response;
  let body;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
      body: JSON.stringify(request),
    });
    body = responseBody(await response.text());
  } catch {
    const evidencePath = writeProbeEvidence({
      outputDirectory,
      probeId: id,
      now: recordedAt,
      request,
      response: null,
      summary,
      url,
    });
    clearReservation(reservationPath);
    throw new Error(`preflight probe transport failed; evidence recorded at ${evidencePath}`);
  }
  const evidencePath = writeProbeEvidence({
    outputDirectory,
    probeId: id,
    now: recordedAt,
    request,
    response: { status: response.status, body },
    summary,
    url,
  });
  clearReservation(reservationPath);
  return { httpStatus: response.status, body, evidencePath };
}
