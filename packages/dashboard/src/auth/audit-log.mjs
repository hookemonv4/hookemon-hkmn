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
const claimTokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Default PREPARED claim lease: how long a claim stays authoritative without renewal before another
 * claimant may treat it as orphaned. Renewed at half this interval while an effect is in flight (see
 * `startClaimHeartbeat`), matching the ttlMs/renew-at-half convention this repo already uses for the
 * cycle-exclusive lease (packages/runner/src/automation/exclusive-lease.mjs). */
const DEFAULT_CLAIM_LEASE_TTL_MS = 30_000;

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
  if (Object.hasOwn(entry, 'claimToken')) {
    if (!Object.hasOwn(entry, 'commandState') || entry.commandState !== 'PREPARED') {
      throw new Error('audit entry claimToken is only valid on a PREPARED command state');
    }
    if (typeof entry.claimToken !== 'string' || !claimTokenPattern.test(entry.claimToken)) {
      throw new Error('audit entry claimToken must be a UUID');
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

// A PID-liveness check (`process.kill(pid, 0)`) only ever inspects the local host's process table: on
// a host other than the one holding the lock, every remote PID looks absent, so a liveness check would
// treat a genuinely-held remote lock as dead and unlink it out from under its owner. The lock's
// filesystem modification time is instead a durable fact any host observes identically, making
// time-based staleness the only check here that is safe across hosts (and immune to local PID reuse).
async function removeDeadLock(lockPath) {
  try {
    const lockStat = await stat(lockPath);
    if (Date.now() - lockStat.mtimeMs >= LOCK_STALE_MS) {
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
    ...(Object.hasOwn(entry, 'claimToken') ? { claimToken: entry.claimToken } : {}),
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

function effectAuditResultCode(effectResult, fallback) {
  if (!effectResult || typeof effectResult !== 'object' || Array.isArray(effectResult)
    || !Object.hasOwn(effectResult, 'auditResultCode')) {
    return fallback;
  }
  if (typeof effectResult.auditResultCode !== 'string' || effectResult.auditResultCode.length === 0) {
    throw new Error('audited command effect auditResultCode must be a nonempty string');
  }
  return effectResult.auditResultCode;
}

async function appendCommandState(path, initial, commandState, now, appliedResultCode, claimToken = null) {
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
    ...(commandState === 'PREPARED' && claimToken !== null ? { claimToken } : {}),
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
 * Renews a PREPARED claim while its effect is in flight, so another claimant never sees it go stale
 * merely because the effect is taking a while. Each renewal is itself a durable, lock-serialized
 * append, so its freshness is visible to every host reading the same log — not a local, in-memory fact.
 * A renewal that finds the claim already lost (a different claimToken now owns it) or already resolved
 * (no longer PREPARED) simply stops; it never fights to reclaim what it does not durably still own.
 * Returns a stop function; safe to call more than once.
 */
function startClaimHeartbeat({ path, requestId, claimToken, initial, now, leaseTtlMs, heartbeatIntervalMs }) {
  let stopped = false;
  let timer = null;
  const renew = async () => {
    if (stopped) return;
    try {
      await serializeWrite(path, async () => {
        const current = requestRecord(await readAllAuditEntries(path), requestId);
        if (stopped || current === null || current.commandState !== 'PREPARED' || current.record.claimToken !== claimToken) return;
        await appendCommandState(path, initial, 'PREPARED', now, initial.resultCode, claimToken);
      });
    } catch {
      // A missed renewal is not fatal here: either the next renewal catches up before the lease
      // expires, or the lease's own bounded expiry is the correct, honest signal to a new claimant.
    }
    if (!stopped) {
      timer = setTimeout(renew, heartbeatIntervalMs);
      timer.unref?.();
    }
  };
  timer = setTimeout(renew, heartbeatIntervalMs);
  timer.unref?.();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * Reserve an append-only command record before invoking the authority. The short reservation and
 * completion transitions are serialized; the effect runs outside the write lock. A retry observes
 * the actual PREPARED/APPLIED/REJECTED/UNCERTAIN state and never turns an unresolved effect into a
 * synthetic success.
 *
 * A PREPARED record left behind by a process that died before it could complete its own effect (a
 * hard crash, not a normal thrown error — a normal error already resolves to UNCERTAIN inside the
 * same call, see the catch block below) is detected purely from the durable claim's age: every
 * PREPARED record — freshly reserved, reclaimed, or renewed — carries a random `claimToken` and its
 * `occurredAt` timestamp, both written under the same cross-process/cross-host file lock every append
 * already uses. A claim older than `leaseTtlMs` with no renewal is orphaned; a live claimant renews it
 * (via `startClaimHeartbeat`) well before that, at half the lease interval, so a claim genuinely still
 * in flight never appears stale to a second claimant. This is deliberately not PID-based: a local
 * `process.kill` liveness check only ever sees the local host's process table (useless or actively
 * wrong from a second host's point of view) and cannot distinguish a dead PID from one since reused by
 * an unrelated process. A legacy PREPARED record from before this field existed has no claimToken but
 * still carries `occurredAt`, so it ages out and becomes reclaimable exactly the same way — no separate
 * migration path is needed.
 *
 * Reclaiming an orphan never assumes the crashed attempt's effect did or did not run: the retried
 * effect is simply called again through the same authority, under a fresh claim so a second concurrent
 * recovery attempt sees a live claim and backs off. Whether that authority is itself safe to call twice
 * for the same intent (idempotent under its own compare-and-swap, as `operator/control.mjs` is) is the
 * authority's responsibility, not this log's: this module never infers "already applied" from a generic
 * error message, since a shared-state conflict error carries no command-specific identity or
 * postcondition. Any effect failure — first attempt or recovered — is finalized UNCERTAIN alike; only an
 * effect that actually returns successfully (because the authority itself recognized its own prior
 * effect, or because this attempt genuinely just applied it) is finalized APPLIED. The original request
 * ID's identity (eventId, commandDigest) is preserved through a reclaim, so the same request ID stays
 * idempotent across the crash and the recovery.
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
  leaseTtlMs = DEFAULT_CLAIM_LEASE_TTL_MS,
  heartbeatIntervalMs = Math.max(1, Math.floor(leaseTtlMs / 2)),
  effect,
}) {
  if (typeof requestId !== 'string' || requestId.length === 0) throw new Error('audited command requestId must be a nonempty string');
  if (typeof effect !== 'function') throw new Error('audited command effect must be a function');
  if (!Number.isSafeInteger(leaseTtlMs) || leaseTtlMs <= 0) throw new Error('audited command leaseTtlMs must be a positive integer');
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) throw new Error('audited command heartbeatIntervalMs must be a positive integer');
  const requestedDigest = commandDigest({ expectedVersion, command, note });

  const reservation = await serializeWrite(path, async () => {
    const existing = requestRecord(await readAllAuditEntries(path), requestId);
    if (existing !== null) {
      if (existing.initial.commandDigest !== requestedDigest) throw new AuditRequestConflict(requestId);
      if (existing.commandState !== 'PREPARED' && existing.record.commandState !== null && existing.record.commandState !== undefined) {
        return { execute: false, ...existing };
      }
      if (existing.commandState === 'PREPARED') {
        const claimedAtMs = Date.parse(existing.record.occurredAt);
        const stale = !Number.isFinite(claimedAtMs) || now() - claimedAtMs >= leaseTtlMs;
        if (!stale) return { execute: false, ...existing };
        const claimToken = crypto.randomUUID();
        const reclaimed = await appendCommandState(path, existing.initial, 'PREPARED', now, existing.initial.resultCode, claimToken);
        return {
          execute: true, recovered: true, initial: existing.initial, record: reclaimed, claimToken, commandState: 'PREPARED',
        };
      }
      const record = await appendCommandState(path, existing.initial, 'UNCERTAIN', now, resultCode);
      return { execute: false, initial: existing.initial, record, commandState: 'UNCERTAIN' };
    }

    const claimToken = crypto.randomUUID();
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
      claimToken,
    });
    return {
      execute: true, initial: record, record, claimToken, commandState: 'PREPARED',
    };
  });
  if (!reservation.execute) return commandResult(reservation.record, reservation.commandState, true);

  const preparedReceipt = receiptFromEntry(reservation.record);
  const stopHeartbeat = startClaimHeartbeat({
    path, requestId, claimToken: reservation.claimToken, initial: reservation.initial, now, leaseTtlMs, heartbeatIntervalMs,
  });
  try {
    const effectResult = await effect(preparedReceipt);
    const commandState = effectResult?.auditCommandState === 'REJECTED'
      ? 'REJECTED'
      : effectResult?.auditCommandState === 'UNCERTAIN'
        ? 'UNCERTAIN'
        : 'APPLIED';
    const completionResultCode = commandState === 'APPLIED'
      ? effectAuditResultCode(effectResult, resultCode)
      : resultCode;
    const completed = await completeCommand(
      path,
      requestId,
      commandState,
      now,
      completionResultCode,
    );
    return commandResult(completed.record, completed.commandState, false);
  } catch (error) {
    const completed = await completeCommand(path, requestId, 'UNCERTAIN', now, resultCode);
    throw new AuditedCommandEffectError(receiptFromEntry(completed.record), completed.commandState, error);
  } finally {
    stopHeartbeat();
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
