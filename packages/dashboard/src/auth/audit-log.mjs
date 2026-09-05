// Append-only, hash-chained audit log for each dispatched operator command. Each entry embeds the
// SHA-256 digest of the entry
// before it (the canonical-JSON `digest()` helper this repository already uses for the durable cycle
// journal — packages/runner/src/cycle/journal.mjs — reused here rather than re-implemented, since it
// is the exact hash-chaining primitive this repo standardizes on), so any edit, reordering, or
// deletion of a past line breaks the chain from that point forward and is detectable by
// `verifyAuditChain`. This is a *record* of decisions, never the money-moving state itself — the
// runner authority remains the sole source of truth the scheduler reads; this log cannot mutate it
// and is never consulted to decide whether a decision is authorized.
import { open, mkdir, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

import { canonicalJson, digest } from '../../../runner/src/cycle/journal.mjs';

export const GENESIS_HASH = `sha256:${'0'.repeat(64)}`;
const MAX_LINE_BYTES = 65_536;
const COMMAND_STATES = new Set(['PREPARED', 'APPLIED', 'REJECTED', 'UNCERTAIN']);
const LOCK_RETRY_MS = 5;
const LOCK_STALE_MS = 60_000;

function assertEntryInput(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('audit entry must be an object');
  const required = ['eventId', 'occurredAt', 'actor', 'actorRole', 'action', 'outcome', 'resultCode', 'observedVersion', 'note'];
  for (const field of required) {
    if (!Object.hasOwn(entry, field)) throw new Error(`audit entry missing field: ${field}`);
  }
  if (typeof entry.eventId !== 'string' || entry.eventId.length === 0) throw new Error('audit entry eventId must be a nonempty string');
  if (typeof entry.occurredAt !== 'string' || Number.isNaN(Date.parse(entry.occurredAt))) throw new Error('audit entry occurredAt must be an ISO timestamp');
  if (!entry.actor || typeof entry.actor.email !== 'string') throw new Error('audit entry actor.email must be a string');
  if (entry.actorRole !== 'viewer' && entry.actorRole !== 'operator') throw new Error('audit entry actorRole must be viewer or operator');
  if (typeof entry.action !== 'string' || entry.action.length === 0) throw new Error('audit entry action must be a nonempty string');
  if (entry.outcome !== 'accepted' && entry.outcome !== 'rejected') throw new Error('audit entry outcome must be accepted or rejected');
  if (typeof entry.resultCode !== 'string' || entry.resultCode.length === 0) throw new Error('audit entry resultCode must be a nonempty string');
  if (!Number.isSafeInteger(entry.observedVersion) || entry.observedVersion < 0) throw new Error('audit entry observedVersion must be a non-negative integer');
  if (entry.note !== null && typeof entry.note !== 'string') throw new Error('audit entry note must be a string or null');
  if (Object.hasOwn(entry, 'requestId') && (typeof entry.requestId !== 'string' || entry.requestId.length === 0)) {
    throw new Error('audit entry requestId must be a nonempty string');
  }
  if (Object.hasOwn(entry, 'commandDigest') && (typeof entry.commandDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(entry.commandDigest))) {
    throw new Error('audit entry commandDigest is invalid');
  }
  if (Object.hasOwn(entry, 'requestId') !== Object.hasOwn(entry, 'commandDigest')) {
    throw new Error('audit entry requestId and commandDigest must be supplied together');
  }
  if (Object.hasOwn(entry, 'commandState')) {
    if (!Object.hasOwn(entry, 'requestId') || !COMMAND_STATES.has(entry.commandState)) {
      throw new Error('audit entry commandState is invalid');
    }
  }
}

async function readLastLine(path) {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') return { sequence: 0, hash: GENESIS_HASH };
    throw error;
  }
  try {
    const text = await handle.readFile({ encoding: 'utf8' });
    const lines = text.split('\n').filter(line => line.length > 0);
    if (lines.length === 0) return { sequence: 0, hash: GENESIS_HASH };
    const last = JSON.parse(lines.at(-1));
    return { sequence: last.sequence, hash: last.hash };
  } finally {
    await handle.close();
  }
}

/** Append one audit entry to the hash-chained log at `path` (absolute). Assigns `sequence`
 * (1-based, monotonically increasing) and `prevHash`/`hash` itself; the caller supplies everything
 * else. Returns the full stored entry, including its assigned `sequence` and `hash`. This function
 * serializes short append/reservation sections both in-process and across processes. Effects never
 * execute while that lock is held. */
const writeLocks = new Map();

function assertAuditPath(path) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('audit path must be a nonempty string');
}

function waitForLock() {
  return new Promise(resolve => setTimeout(resolve, LOCK_RETRY_MS));
}

function parseLockOwner(value) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed.token === 'string' && Number.isInteger(parsed.pid) && parsed.pid > 0
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function ownerIsAlive(owner) {
  if (owner === null) return false;
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function removeDeadLock(lockPath) {
  try {
    const [metadata, lockStat] = await Promise.all([
      readFile(lockPath, 'utf8'),
      stat(lockPath),
    ]);
    const owner = parseLockOwner(metadata);
    if (ownerIsAlive(owner)) return false;
    if (owner !== null || Date.now() - lockStat.mtimeMs >= LOCK_STALE_MS) {
      await unlink(lockPath);
      return true;
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return true;
    throw error;
  }
  return false;
}

async function acquireAuditLock(path) {
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const token = crypto.randomUUID();
  for (;;) {
    let handle;
    try {
      handle = await open(lockPath, 'wx', 0o600);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      await removeDeadLock(lockPath);
      await waitForLock();
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ token, pid: process.pid }), { encoding: 'utf8' });
      await handle.sync();
    } catch (error) {
      await handle.close();
      await unlink(lockPath).catch(unlinkError => {
        if (unlinkError?.code !== 'ENOENT') throw unlinkError;
      });
      throw error;
    }
    return async () => {
      try {
        const owner = parseLockOwner(await readFile(lockPath, 'utf8'));
        if (owner?.token === token) await unlink(lockPath);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      } finally {
        await handle.close();
      }
    };
  }
}

async function withAuditLock(path, operation) {
  const release = await acquireAuditLock(path);
  try {
    return await operation();
  } finally {
    await release();
  }
}

function serializeWrite(path, operation) {
  assertAuditPath(path);
  const previous = writeLocks.get(path) ?? Promise.resolve();
  let next;
  const run = async () => {
    try {
      return await withAuditLock(path, operation);
    } finally {
      if (writeLocks.get(path) === next) writeLocks.delete(path);
    }
  };
  next = previous.then(run, run);
  writeLocks.set(path, next);
  return next;
}

export async function appendAuditEntry(path, entry) {
  assertEntryInput(entry);
  return serializeWrite(path, () => doAppend(path, entry));
}

async function doAppend(path, entry) {
  await mkdir(dirname(path), { recursive: true });
  const { sequence: lastSequence, hash: prevHash } = await readLastLine(path);
  const sequence = lastSequence + 1;
  const unhashed = {
    sequence,
    eventId: entry.eventId,
    occurredAt: entry.occurredAt,
    actor: { email: entry.actor.email },
    actorRole: entry.actorRole,
    action: entry.action,
    outcome: entry.outcome,
    resultCode: entry.resultCode,
    observedVersion: entry.observedVersion,
    note: entry.note,
    prevHash,
    ...(Object.hasOwn(entry, 'requestId') ? {
      requestId: entry.requestId,
      commandDigest: entry.commandDigest,
    } : {}),
    ...(Object.hasOwn(entry, 'commandState') ? { commandState: entry.commandState } : {}),
  };
  const hash = digest({ domain: 'hookemon.dashboard-audit-entry.v1', entry: unhashed });
  const record = { ...unhashed, hash };
  const line = `${canonicalJson(record)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw new Error('audit entry exceeds the line byte limit');
  const handle = await open(path, 'a', 0o600);
  try {
    await handle.writeFile(line, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
  return record;
}

export class AuditRequestConflict extends Error {
  constructor(requestId) {
    super(`request ID ${requestId} was already used for a different command`);
    this.code = 'AUDIT_REQUEST_ID_CONFLICT';
  }
}

export class AuditedCommandEffectError extends Error {
  constructor(receipt, commandState, cause) {
    super('audited command effect failed', { cause });
    this.code = 'AUDITED_COMMAND_EFFECT_FAILED';
    this.receipt = receipt;
    this.commandState = commandState;
  }
}

export function commandDigest({ expectedVersion, command, note }) {
  return digest({
    domain: 'hookemon.dashboard-command.v1',
    command: { expectedVersion, command, note },
  });
}

function receiptFromEntry(entry) {
  return Object.freeze({
    sequence: entry.sequence,
    eventId: entry.eventId,
    requestId: entry.requestId,
    commandDigest: entry.commandDigest,
    action: entry.action,
    resultCode: entry.resultCode,
    observedVersion: entry.observedVersion,
    commandState: entry.commandState ?? null,
  });
}

function requestRecord(entries, requestId) {
  const records = entries.filter(entry => entry.requestId === requestId);
  if (records.length === 0) return null;
  const initial = records[0];
  const stateRecord = [...records].reverse().find(entry => COMMAND_STATES.has(entry.commandState)) ?? null;
  return {
    initial,
    record: stateRecord ?? initial,
    commandState: stateRecord?.commandState ?? 'UNCERTAIN',
  };
}

function commandResult(record, commandState, replayed) {
  const receipt = receiptFromEntry(record);
  return Object.freeze({ replayed, commandState, receipt, result: receipt });
}

function resultCodeForState(commandState, appliedResultCode) {
  if (commandState === 'PREPARED') return 'COMMAND_PREPARED';
  if (commandState === 'REJECTED') return 'COMMAND_REJECTED';
  if (commandState === 'UNCERTAIN') return 'COMMAND_UNCERTAIN';
  return appliedResultCode;
}

async function appendCommandState(path, initial, commandState, now, appliedResultCode) {
  return doAppend(path, {
    eventId: crypto.randomUUID(),
    occurredAt: new Date(now()).toISOString(),
    actor: initial.actor,
    actorRole: initial.actorRole,
    action: initial.action,
    outcome: commandState === 'REJECTED' ? 'rejected' : 'accepted',
    resultCode: resultCodeForState(commandState, appliedResultCode),
    observedVersion: initial.observedVersion,
    note: initial.note,
    requestId: initial.requestId,
    commandDigest: initial.commandDigest,
    commandState,
  });
}

async function completeCommand(path, requestId, commandState, now, appliedResultCode) {
  return serializeWrite(path, async () => {
    const current = requestRecord(await readAllAuditEntries(path), requestId);
    if (current === null) throw new Error('audited command preparation is missing');
    if (current.commandState !== 'PREPARED') return current;
    const record = await appendCommandState(path, current.initial, commandState, now, appliedResultCode);
    return { initial: current.initial, record, commandState };
  });
}

/**
 * Reserve an append-only command record before invoking the authority. The short reservation and
 * completion transitions are serialized; the effect runs outside the write lock. A retry observes
 * the actual PREPARED/APPLIED/REJECTED/UNCERTAIN state and never turns an unresolved effect into a
 * synthetic success.
 */
export async function executeAuditedCommand({
  path,
  requestId,
  command,
  actor,
  actorRole,
  expectedVersion,
  observedVersion,
  note = null,
  resultCode = 'COMMAND_DISPATCHED',
  now = Date.now,
  effect,
}) {
  if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('audited command requestId must be a nonempty string');
  if (typeof effect !== 'function') throw new Error('audited command effect must be a function');
  const requestedDigest = commandDigest({ expectedVersion, command, note });

  const reservation = await serializeWrite(path, async () => {
    const existing = requestRecord(await readAllAuditEntries(path), requestId);
    if (existing !== null) {
      if (existing.initial.commandDigest !== requestedDigest) throw new AuditRequestConflict(requestId);
      if (existing.commandState !== 'PREPARED' && existing.record.commandState !== null && existing.record.commandState !== undefined) {
        return { execute: false, ...existing };
      }
      if (existing.commandState === 'PREPARED') return { execute: false, ...existing };
      const record = await appendCommandState(path, existing.initial, 'UNCERTAIN', now, resultCode);
      return { execute: false, initial: existing.initial, record, commandState: 'UNCERTAIN' };
    }

    const record = await doAppend(path, {
      eventId: crypto.randomUUID(),
      occurredAt: new Date(now()).toISOString(),
      actor,
      actorRole,
      action: command.type,
      outcome: 'accepted',
      resultCode: resultCodeForState('PREPARED', resultCode),
      observedVersion,
      note,
      requestId,
      commandDigest: requestedDigest,
      commandState: 'PREPARED',
    });
    return { execute: true, initial: record, record, commandState: 'PREPARED' };
  });
  if (!reservation.execute) return commandResult(reservation.record, reservation.commandState, true);

  const preparedReceipt = receiptFromEntry(reservation.record);
  try {
    const effectResult = await effect(preparedReceipt);
    const commandState = effectResult?.auditCommandState === 'REJECTED'
      ? 'REJECTED'
      : effectResult?.auditCommandState === 'UNCERTAIN'
        ? 'UNCERTAIN'
        : 'APPLIED';
    const completed = await completeCommand(path, requestId, commandState, now, resultCode);
    return commandResult(completed.record, completed.commandState, false);
  } catch (error) {
    const completed = await completeCommand(path, requestId, 'UNCERTAIN', now, resultCode);
    throw new AuditedCommandEffectError(receiptFromEntry(completed.record), completed.commandState, error);
  }
}

/** Read every stored entry in append order. Used by `verifyAuditChain` and by the sqlite projection
 * rebuild (storage/sqlite-projection.mjs); not used directly by the paginated `/operator/api/audit`
 * route, which reads the projection instead. */
export async function readAllAuditEntries(path) {
  let handle;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  try {
    const text = await handle.readFile({ encoding: 'utf8' });
    return text.split('\n').filter(line => line.length > 0).map(line => JSON.parse(line));
  } finally {
    await handle.close();
  }
}

/** Verify the full hash chain at `path`: sequence numbers are contiguous from 1, every entry's
 * `prevHash` matches the previous entry's `hash` (or `GENESIS_HASH` for the first entry), and every
 * entry's own `hash` recomputes correctly from its fields. Returns `{ valid: true, count }` or
 * `{ valid: false, brokenAtSequence, reason }`. */
export async function verifyAuditChain(path) {
  const entries = await readAllAuditEntries(path);
  let expectedPrevHash = GENESIS_HASH;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.sequence !== index + 1) {
      return { valid: false, brokenAtSequence: entry.sequence, reason: 'sequence gap' };
    }
    if (entry.prevHash !== expectedPrevHash) {
      return { valid: false, brokenAtSequence: entry.sequence, reason: 'prevHash mismatch' };
    }
    const { hash, ...unhashed } = entry;
    const expectedHash = digest({ domain: 'hookemon.dashboard-audit-entry.v1', entry: unhashed });
    if (hash !== expectedHash) {
      return { valid: false, brokenAtSequence: entry.sequence, reason: 'hash mismatch' };
    }
    expectedPrevHash = hash;
  }
  return { valid: true, count: entries.length };
}
