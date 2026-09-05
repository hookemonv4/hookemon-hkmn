import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { canonicalJson } from './journal.mjs';

const SESSION_SCHEMA = 'hookemon.rehearsal-session.v1';
const decimalPattern = /^(0|[1-9][0-9]*)$/;
const cycleIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;

function assertStateDir(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) throw new Error('rehearsal session stateDir must be absolute');
  return value;
}

function assertCycles(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('rehearsal session cycles must be a positive safe integer');
  return value;
}

function assertCap(value) {
  if (typeof value !== 'string' || !decimalPattern.test(value) || value === '0') {
    throw new Error('rehearsal session capUsdg must be a positive atomic amount');
  }
  return value;
}

function assertCollectorOnly(value) {
  if (typeof value !== 'boolean') throw new Error('rehearsal session collectorOnly must be a boolean');
  return value;
}

function assertPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) throw new Error('rehearsal session path must be absolute');
  return value;
}

function sessionsDirectory(stateDir) {
  return join(assertStateDir(stateDir), 'rehearsal-sessions');
}

function validateCompleted(value) {
  if (!Array.isArray(value)) throw new Error('rehearsal session completed records are invalid');
  const cycleIds = new Set();
  return Object.freeze(value.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || !cycleIdPattern.test(entry.cycleId ?? '') || typeof entry.evidencePath !== 'string' || !entry.evidencePath.startsWith('/')) {
      throw new Error('rehearsal session completion record is invalid');
    }
    if (cycleIds.has(entry.cycleId)) throw new Error('rehearsal session contains a duplicate completed cycle');
    cycleIds.add(entry.cycleId);
    return Object.freeze({ cycleId: entry.cycleId, evidencePath: entry.evidencePath });
  }));
}

function validateSession(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('rehearsal session document is invalid');
  if (value.schema !== SESSION_SCHEMA) throw new Error('rehearsal session schema is invalid');
  if (typeof value.sessionId !== 'string' || !/^rehearsal-[0-9a-f-]{36}$/.test(value.sessionId)) {
    throw new Error('rehearsal session id is invalid');
  }
  if (value.state !== 'RUNNING' && value.state !== 'COMPLETE') throw new Error('rehearsal session state is invalid');
  const cycles = assertCycles(value.cycles);
  const capUsdg = assertCap(value.capUsdg);
  const collectorOnly = assertCollectorOnly(value.collectorOnly);
  if (!Number.isSafeInteger(value.restartCount) || value.restartCount < 0) throw new Error('rehearsal session restartCount is invalid');
  const completed = validateCompleted(value.completed);
  if (completed.length > cycles || (value.state === 'COMPLETE' && completed.length !== cycles)) {
    throw new Error('rehearsal session completion state is inconsistent');
  }
  return Object.freeze({
    schema: SESSION_SCHEMA,
    sessionId: value.sessionId,
    state: value.state,
    cycles,
    capUsdg,
    collectorOnly,
    restartCount: value.restartCount,
    completed,
  });
}

async function writeSession(path, session) {
  const target = assertPath(path);
  const value = validateSession(session);
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${canonicalJson(value)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return value;
}

async function readSessionFile(path) {
  const target = assertPath(path);
  let parsed;
  try {
    parsed = JSON.parse(await readFile(target, 'utf8'));
  } catch {
    throw new Error('rehearsal session document is unreadable');
  }
  return validateSession(parsed);
}

function sameRequestedRun(session, input) {
  return session.cycles === input.cycles && session.capUsdg === input.capUsdg && session.collectorOnly === input.collectorOnly;
}

/** Opens the single durable restart session for an equivalent bounded rehearsal, or creates it. */
export async function openOrCreateRehearsalSession({ stateDir, cycles, capUsdg, collectorOnly }) {
  const input = Object.freeze({
    stateDir: assertStateDir(stateDir),
    cycles: assertCycles(cycles),
    capUsdg: assertCap(capUsdg),
    collectorOnly: assertCollectorOnly(collectorOnly),
  });
  const directory = sessionsDirectory(input.stateDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const active = [];
  for (const name of await readdir(directory)) {
    if (!/^rehearsal-[0-9a-f-]{36}\.json$/.test(name)) continue;
    const path = join(directory, name);
    const session = await readSessionFile(path);
    if (session.state === 'RUNNING') active.push({ path, session });
  }
  if (active.length > 1) throw new Error('multiple active rehearsal sessions require operator review');
  if (active.length === 1) {
    if (!sameRequestedRun(active[0].session, input)) {
      throw new Error('active rehearsal session does not match the requested run');
    }
    return Object.freeze(active[0]);
  }
  const sessionId = `rehearsal-${crypto.randomUUID()}`;
  const path = join(directory, `${sessionId}.json`);
  const session = await writeSession(path, {
    schema: SESSION_SCHEMA,
    sessionId,
    state: 'RUNNING',
    cycles: input.cycles,
    capUsdg: input.capUsdg,
    collectorOnly: input.collectorOnly,
    restartCount: 0,
    completed: [],
  });
  return Object.freeze({ path, session });
}

export async function readRehearsalSession({ path }) {
  return readSessionFile(path);
}

export async function recordRehearsalSessionRestart({ path }) {
  const session = await readSessionFile(path);
  if (session.state !== 'RUNNING') throw new Error('rehearsal session is already complete');
  return writeSession(path, { ...session, restartCount: session.restartCount + 1 });
}

export async function recordRehearsalSessionCompletion({ path, cycleId, evidencePath }) {
  if (!cycleIdPattern.test(cycleId ?? '')) throw new Error('rehearsal session cycleId is invalid');
  if (typeof evidencePath !== 'string' || !evidencePath.startsWith('/')) throw new Error('rehearsal session evidencePath is invalid');
  const session = await readSessionFile(path);
  if (session.state !== 'RUNNING') throw new Error('rehearsal session is already complete');
  if (session.completed.some(entry => entry.cycleId === cycleId)) {
    throw new Error('rehearsal session cycle is already complete');
  }
  const completed = [...session.completed, Object.freeze({ cycleId, evidencePath })];
  return writeSession(path, {
    ...session,
    state: completed.length === session.cycles ? 'COMPLETE' : 'RUNNING',
    completed,
  });
}
