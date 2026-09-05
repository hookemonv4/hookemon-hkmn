import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { normalizeExternalError, redactForLogging } from './logger.mjs';

// A minimal alert webhook (design section 4.7; closes the "no alert channel has ever been test-fired"
// gap ops/HANDOFF.md's Paging section names): a plain HTTP POST with retry, URL from configuration, no
// vendor SDK. Fires on the transitions the design and the coordinator scoped this package to — a
// DEGRADED or FAILED terminal cycle, exclusive-lease contention, a scheduler tick that failed outright,
// and (via protocol-fee-monitor.mjs, which imports `buildAlert`/`createTransitionDeduper` from this
// same module so it fires through the exact same path) a nonzero protocol fee on the canonical pool.
//
// This module has two layers:
//   - `createAlertWebhook({url, ...})` -> `{send(alert)}` - the low-level delivery mechanism. Every
//     alert is one canonical-shaped JSON object, POSTed with a bounded number of retries and a
//     per-attempt timeout; delivery never throws back into the caller (a permanently failed delivery is
//     reported as `{delivered: false, ...}`, not an exception) so a paging outage can never itself take
//     down the cycle loop that is trying to report something is wrong.
//   - `buildAlert(...)` / `alertFromSchedulerTick(event)` / `alertFromTerminalCycle(terminal)` -
//     pure helpers that turn the runner's own event shapes (scheduler.mjs's `onTick` events,
//     operator/state-file.mjs's terminal cycle records) into the fixed alert shape, so a caller wiring
//     this module against the real scheduler/operator state never hand-rolls the mapping.
//   - `createTransitionDeduper()` - a tiny "fire once per key" tracker, shared by any caller (this
//     module's own future wiring, and protocol-fee-monitor.mjs today) that needs "alert once on the
//     transition into a bad state, not once per subsequent observation of that same bad state".

export const ALERT_SCHEMA = 'hookemon.alert.v1';
export const ALERT_SEVERITIES = Object.freeze(['warning', 'critical']);
export const ALERT_REASONS = Object.freeze([
  'LEASE_CONTENTION',
  'SCHEDULER_TICK_FAILED',
  'CYCLE_FAILED',
  'CYCLE_DEGRADED',
  'PROTOCOL_FEE_NONZERO',
  'CANARY_DRIFT',
  'START_PREFLIGHT_FAILED',
]);

const alertFields = Object.freeze(['reason', 'severity', 'cycleId', 'stage', 'message', 'detail']);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isSafeAlertText(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && redactForLogging(value) === value;
}

function isNullableSafeAlertText(value) {
  return value === null || isSafeAlertText(value);
}

function isSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNullableSafeInteger(value) {
  return value === null || isSafeInteger(value);
}

function isCanonicalAtomic(value) {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}

function isCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value);
}

function assertDetailObject(value, schema, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object`);
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(schema, key)) throw new Error(`${label} does not allow field "${key}"`);
    const validator = schema[key];
    if (!validator(entry)) throw new Error(`${label} field "${key}" is invalid`);
  }
}

function assertCanaryEvidence(value, label) {
  if (value === null || typeof value === 'boolean' || isSafeInteger(value) || isSafeAlertText(value)) return;
  assertDetailObject(value, Object.freeze({
    protocolFee: isCanonicalAtomic,
    lpFee: isCanonicalAtomic,
    treasury: isSafeAlertText,
    operations: isSafeAlertText,
    cycle: candidate => {
      assertDetailObject(candidate, Object.freeze({ cycleId: isSafeAlertText, operations: isSafeAlertText }), `${label}.cycle`);
      return true;
    },
    cycleId: isSafeAlertText,
    blockhash: isSafeAlertText,
    lastValidBlockHeight: isCanonicalAtomic,
    isValid: candidate => typeof candidate === 'boolean',
    currentBlockHeight: isCanonicalAtomic,
    chainId: candidate => typeof candidate === 'string' || isSafeInteger(candidate),
    assetId: isSafeAlertText,
    decimals: candidate => Number.isInteger(candidate) && candidate >= 0 && candidate <= 255,
    amountAtomic: isCanonicalAtomic,
    ready: candidate => typeof candidate === 'boolean',
  }), label);
}

function isCanaryEvidence(value) {
  try {
    assertCanaryEvidence(value, 'alert detail evidence');
    return true;
  } catch {
    return false;
  }
}

const ALERT_DETAIL_SCHEMAS = Object.freeze({
  LEASE_CONTENTION: Object.freeze({ tick: isNullableSafeInteger }),
  SCHEDULER_TICK_FAILED: Object.freeze({ tick: isNullableSafeInteger, error: value => value === 'external error' }),
  CYCLE_FAILED: Object.freeze({ failureReceiptDigest: isNullableSafeAlertText }),
  CYCLE_DEGRADED: Object.freeze({ terminalState: isCode, terminalDigest: isNullableSafeAlertText }),
  PROTOCOL_FEE_NONZERO: Object.freeze({ poolId: isSafeAlertText, protocolFee: isCanonicalAtomic }),
  CANARY_DRIFT: Object.freeze({
    code: isCode,
    target: isSafeAlertText,
    expected: isCanaryEvidence,
    observed: isCanaryEvidence,
    action: isSafeAlertText,
  }),
  START_PREFLIGHT_FAILED: Object.freeze({
    code: isCode,
    target: isSafeAlertText,
    expected: isCanaryEvidence,
    observed: isCanaryEvidence,
    action: isSafeAlertText,
  }),
});

function assertAlertDetail(reason, detail) {
  if (detail === null) return;
  const schema = ALERT_DETAIL_SCHEMAS[reason];
  if (schema === undefined) throw new Error(`alert reason "${reason}" has no detail schema`);
  assertDetailObject(detail, schema, 'alert detail');
}

function assertAlert(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('alert must be a plain object');
  if (Object.keys(value).length !== alertFields.length || !alertFields.every(field => Object.hasOwn(value, field))) {
    throw new Error('alert must use the exact schema');
  }
  if (!ALERT_REASONS.includes(value.reason)) throw new Error('alert reason is invalid');
  if (!ALERT_SEVERITIES.includes(value.severity)) throw new Error('alert severity is invalid');
  if (!isNullableSafeAlertText(value.cycleId)) throw new Error('alert cycleId must be a nonempty string or null');
  if (!isNullableSafeAlertText(value.stage)) throw new Error('alert stage must be a nonempty string or null');
  if (!isSafeAlertText(value.message)) throw new Error('alert message must be a nonempty safe string');
  assertAlertDetail(value.reason, value.detail);
  return value;
}

/** Build and validate one alert. `cycleId`/`stage`/`detail` default to `null` since most alert
 * reasons (lease contention, a failed tick, a nonzero protocol fee) are not about any one cycle stage. */
export function buildAlert({ reason, severity, cycleId = null, stage = null, message, detail = null }) {
  return assertAlert({ reason, severity, cycleId, stage, message, detail });
}

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = 250;
const DEFAULT_TIMEOUT_MS = 5000;

function defaultSleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function assertFunction(value, label, { optional = false } = {}) {
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'function') throw new Error(`${label} must be a function`);
  return value;
}

/**
 * Build an alert webhook client. Every dependency is injected: `fetchImpl` defaults to the real global
 * `fetch` (Node 24 ships it as a builtin; this module still imports no package for it), `sleep`
 * defaults to a real `setTimeout`-backed delay, `now` to a real ISO-8601 timestamp — tests substitute
 * deterministic fakes for all three so retry/backoff behavior never has to be waited out in real time.
 *
 * @param {object} options
 * @param {string} options.url - the alert receiver. Validated as a real URL at construction time (a
 *   bad configuration value fails fast at wiring time, not at the first real alert).
 * @param {typeof fetch} [options.fetchImpl] - defaults to `globalThis.fetch`.
 * @param {number} [options.maxAttempts] - defaults to 3. Retries on a network error, a timeout, or any
 *   non-2xx response.
 * @param {number} [options.backoffMs] - defaults to 250. Delay before attempt N+1 is `backoffMs * N`
 *   (linear backoff — this is a low-volume alert path, not a high-throughput client that needs
 *   exponential backoff's steeper falloff).
 * @param {number} [options.timeoutMs] - defaults to 5000. Per-attempt abort timeout.
 * @param {(ms: number) => Promise<void>} [options.sleep] - defaults to a real delay.
 * @param {() => string} [options.now] - defaults to `() => new Date().toISOString()`; used for the
 *   alert envelope's `sentAt`.
 * @param {{error: Function}} [options.logger] - optional; `logger.error(event, fields)` is called once
 *   if every attempt is exhausted (see observability/logger.mjs's `createLogger`).
 */
export function createAlertWebhook(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('alert webhook options must be an object');
  const {
    url,
    fetchImpl = globalThis.fetch,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    backoffMs = DEFAULT_BACKOFF_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    sleep = defaultSleep,
    now = () => new Date().toISOString(),
    logger = null,
  } = options;

  if (typeof url !== 'string' || url.length === 0) throw new Error('alert webhook url must be a nonempty string');
  // eslint-disable-next-line no-new -- validated for the side effect of throwing on a malformed URL.
  new URL(url);
  assertFunction(fetchImpl, 'alert webhook fetchImpl');
  assertFunction(sleep, 'alert webhook sleep');
  assertFunction(now, 'alert webhook now');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('alert webhook maxAttempts must be a positive integer');
  if (!Number.isInteger(backoffMs) || backoffMs < 0) throw new Error('alert webhook backoffMs must be a nonnegative integer');
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('alert webhook timeoutMs must be a positive integer');
  if (logger !== null) assertFunction(logger.error, 'alert webhook logger.error');

  async function send(rawAlert) {
    const alert = assertAlert({ ...rawAlert });
    const body = JSON.stringify({ schema: ALERT_SCHEMA, sentAt: now(), ...redactForLogging(alert) });
    let lastErrorMessage = 'alert webhook delivery failed';
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('alert webhook request timed out')), timeoutMs);
      try {
        // eslint-disable-next-line no-await-in-loop -- attempts are inherently sequential (each retry
        // depends on the previous one having failed).
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: controller.signal,
        });
        if (response.ok) {
          return Object.freeze({ delivered: true, attempts: attempt, status: response.status });
        }
        const status = Number.isSafeInteger(response?.status) ? response.status : 'unknown';
        lastErrorMessage = `alert webhook responded with status ${status}`;
      } catch {
        lastErrorMessage = 'alert webhook transport failed';
      } finally {
        clearTimeout(timer);
      }
      if (attempt < maxAttempts) {
        // eslint-disable-next-line no-await-in-loop -- deliberate backoff between sequential retries.
        await sleep(backoffMs * attempt);
      }
    }
    const safeError = lastErrorMessage;
    logger?.error('alert-webhook-delivery-failed', { reason: alert.reason, attempts: maxAttempts, error: safeError });
    return Object.freeze({ delivered: false, attempts: maxAttempts, error: safeError });
  }

  return Object.freeze({ send });
}

function assertDedupeKey(key) {
  if (typeof key !== 'string' || key.length === 0) throw new Error('persistent alert dedupe key must be a nonempty string');
  return key;
}

function assertTimestamp(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('persistent alert dedupe clock must return a nonnegative safe integer');
  return value;
}

const ALERT_DEDUPE_TABLE = `
  CREATE TABLE IF NOT EXISTS observability_alert_dedupe (
    alert_key TEXT PRIMARY KEY,
    state TEXT NOT NULL,
    alerted_at INTEGER NOT NULL,
    last_attempt_at INTEGER,
    delivered_at INTEGER,
    resolved_at INTEGER,
    lease_expires_at INTEGER,
    attempt_token INTEGER NOT NULL DEFAULT 0,
    CHECK (state IN ('PENDING', 'DELIVERED', 'RESOLVED'))
  );
`;

function migrateLegacyAlertDeduper(db) {
  const table = db.prepare(`
    SELECT sql FROM sqlite_master
    WHERE type = 'table' AND name = 'observability_alert_dedupe'
  `).get();
  if (typeof table?.sql !== 'string' || !table.sql.includes("'ALERTED'")) return false;

  let transactionOpen = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    db.exec('ALTER TABLE observability_alert_dedupe RENAME TO observability_alert_dedupe_legacy');
    db.exec(ALERT_DEDUPE_TABLE);
    db.exec(`
      INSERT INTO observability_alert_dedupe
        (alert_key, state, alerted_at, last_attempt_at, delivered_at, resolved_at, lease_expires_at, attempt_token)
      SELECT alert_key,
        CASE WHEN state = 'ALERTED' THEN 'DELIVERED' ELSE 'RESOLVED' END,
        alerted_at,
        alerted_at,
        CASE WHEN state = 'ALERTED' THEN alerted_at ELSE NULL END,
        resolved_at,
        NULL,
        0
      FROM observability_alert_dedupe_legacy
    `);
    db.exec('DROP TABLE observability_alert_dedupe_legacy');
    db.exec('COMMIT');
    return true;
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the migration failure for the caller.
      }
    }
    throw error;
  }
}

/**
 * Persist alert delivery state independently of the money journal. Each key advances from PENDING
 * to DELIVERED, then to RESOLVED after a verified recovery. `leaseMs` is a lease for a PENDING
 * delivery claimant, never a re-page interval for an unchanged condition.
 */
export function createPersistentAlertDeduper({ path, now = () => Date.now(), windowMs = 300_000, leaseMs = Math.max(1, windowMs) } = {}) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('persistent alert deduper path must be a nonempty string');
  if (typeof now !== 'function') throw new Error('persistent alert deduper now must be a function');
  if (!Number.isSafeInteger(windowMs) || windowMs < 0) throw new Error('persistent alert deduper windowMs must be a nonnegative safe integer');
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1) throw new Error('persistent alert deduper leaseMs must be a positive safe integer');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  if (!migrateLegacyAlertDeduper(db)) db.exec(ALERT_DEDUPE_TABLE);
  const columns = new Set(db.prepare('PRAGMA table_info(observability_alert_dedupe)').all().map(column => column.name));
  for (const [column, definition] of [
    ['last_attempt_at', 'INTEGER'],
    ['delivered_at', 'INTEGER'],
    ['lease_expires_at', 'INTEGER'],
    ['attempt_token', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    if (!columns.has(column)) db.exec(`ALTER TABLE observability_alert_dedupe ADD COLUMN ${column} ${definition}`);
  }
  const select = db.prepare(`
    SELECT state, attempt_token AS attemptToken, lease_expires_at AS leaseExpiresAt
    FROM observability_alert_dedupe WHERE alert_key = ?
  `);
  const insertPending = db.prepare(`
    INSERT INTO observability_alert_dedupe
      (alert_key, state, alerted_at, last_attempt_at, delivered_at, resolved_at, lease_expires_at, attempt_token)
    VALUES (?, 'PENDING', ?, ?, NULL, NULL, ?, 1)
  `);
  const reclaimPending = db.prepare(`
    UPDATE observability_alert_dedupe
    SET state = 'PENDING', last_attempt_at = ?, delivered_at = NULL, resolved_at = NULL,
        lease_expires_at = ?, attempt_token = ?
    WHERE alert_key = ? AND state IN ('PENDING', 'RESOLVED')
  `);
  const markDelivered = db.prepare(`
    UPDATE observability_alert_dedupe
    SET state = 'DELIVERED', delivered_at = ?, lease_expires_at = NULL
    WHERE alert_key = ? AND state = 'PENDING' AND attempt_token = ?
  `);
  const markPending = db.prepare(`
    UPDATE observability_alert_dedupe
    SET lease_expires_at = ?
    WHERE alert_key = ? AND state = 'PENDING' AND attempt_token = ?
  `);
  const markResolved = db.prepare(`
    UPDATE observability_alert_dedupe
    SET state = 'RESOLVED', resolved_at = ?, lease_expires_at = NULL
    WHERE alert_key = ? AND state IN ('PENDING', 'DELIVERED')
  `);

  function transaction(operation) {
    let open = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      open = true;
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      if (open) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // The original transaction error is the useful error for callers.
        }
      }
      throw error;
    }
  }

  function assertClaimToken(value) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error('persistent alert dedupe claim token must be a positive safe integer');
    return value;
  }

  function statusResult(row, updated = false) {
    return Object.freeze(updated ? { state: row.state, updated: true } : { state: row.state, updated: false });
  }

  return Object.freeze({
    ready() {
      return transaction(() => {
        db.prepare('SELECT 1 AS ready').get();
        return true;
      });
    },
    claim(key) {
      const alertKey = assertDedupeKey(key);
      const timestamp = assertTimestamp(now());
      return transaction(() => {
        const row = select.get(alertKey);
        if (row === undefined) {
          insertPending.run(alertKey, timestamp, timestamp, timestamp + leaseMs);
          return Object.freeze({ deliver: true, state: 'PENDING', token: 1 });
        }
        if (row.state === 'DELIVERED') return Object.freeze({ deliver: false, state: 'DELIVERED' });
        if (row.state !== 'PENDING' && row.state !== 'RESOLVED') throw new Error('persistent alert dedupe state is invalid');
        if (row.state === 'PENDING' && row.leaseExpiresAt !== null && row.leaseExpiresAt > timestamp) {
          return Object.freeze({ deliver: false, state: 'PENDING' });
        }
        const token = row.attemptToken + 1;
        reclaimPending.run(timestamp, timestamp + leaseMs, token, alertKey);
        return Object.freeze({ deliver: true, state: 'PENDING', token });
      });
    },
    markDelivered(key, token) {
      const alertKey = assertDedupeKey(key);
      const claimToken = assertClaimToken(token);
      const timestamp = assertTimestamp(now());
      return transaction(() => {
        const updated = markDelivered.run(timestamp, alertKey, claimToken).changes === 1;
        const row = select.get(alertKey);
        if (row === undefined) throw new Error('persistent alert dedupe row disappeared');
        return statusResult(row, updated);
      });
    },
    markPending(key, token) {
      const alertKey = assertDedupeKey(key);
      const claimToken = assertClaimToken(token);
      const timestamp = assertTimestamp(now());
      return transaction(() => {
        const updated = markPending.run(timestamp, alertKey, claimToken).changes === 1;
        const row = select.get(alertKey);
        if (row === undefined) throw new Error('persistent alert dedupe row disappeared');
        return statusResult(row, updated);
      });
    },
    resolve(key) {
      const alertKey = assertDedupeKey(key);
      const timestamp = assertTimestamp(now());
      return transaction(() => {
        const row = select.get(alertKey);
        if (row === undefined) return Object.freeze({ state: 'CLEAR' });
        if (row.state === 'RESOLVED') return Object.freeze({ state: 'RESOLVED' });
        markResolved.run(timestamp, alertKey);
        return Object.freeze({ state: 'RESOLVED' });
      });
    },
    close() {
      db.close();
    },
  });
}

// ---------------------------------------------------------------------------
// Transition -> alert mapping helpers
// ---------------------------------------------------------------------------

/** Map one of scheduler.mjs's `onTick` event objects to an alert, or `null` if the tick does not
 * warrant one. Lease contention (`result.status === 'LEASE_HELD'`) and every tick-failure event type
 * (`TICK_FAILED`, `TICK_STATE_READ_FAILED`, `TICK_WORKER_BUILD_FAILED`, `TICK_WORKER_INVALID`) map to
 * an alert; a clean `TICK_COMPLETE` with any other result, and `TICK_STATE_MISSING` (expected before
 * the operator has ever written a state file), do not. */
export function alertFromSchedulerTick(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  if (event.type === 'TICK_COMPLETE') {
    if (event.result?.status !== 'LEASE_HELD') return null;
    return buildAlert({
      reason: 'LEASE_CONTENTION',
      severity: 'warning',
      message: 'scheduler tick found the exclusive cycle lease already held by another process',
      detail: { tick: event.tick ?? null },
    });
  }
  const tickFailureTypes = new Set(['TICK_FAILED', 'TICK_STATE_READ_FAILED', 'TICK_WORKER_BUILD_FAILED', 'TICK_WORKER_INVALID']);
  if (!tickFailureTypes.has(event.type)) return null;
  return buildAlert({
    reason: 'SCHEDULER_TICK_FAILED',
    severity: 'critical',
    message: `scheduler tick failed: ${event.type}`,
    detail: { tick: event.tick ?? null, error: normalizeExternalError(event.error) },
  });
}

/** Map a terminal cycle record to an alert, or `null` for a clean terminal. Persisted `HELD_*`
 * records represent the current repository authority and use the degraded-cycle alert reason. */
export function alertFromTerminalCycle(terminal) {
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return null;
  if (terminal.lifecycle === 'FAILED') {
    return buildAlert({
      reason: 'CYCLE_FAILED',
      severity: 'critical',
      cycleId: terminal.cycleId ?? null,
      stage: terminal.cycleStage ?? null,
      message: `cycle ${terminal.cycleId} reached a terminal FAILED state`,
      detail: { failureReceiptDigest: terminal.failureReceiptDigest ?? null },
    });
  }
  if (terminal.lifecycle === 'DEGRADED') {
    return buildAlert({
      reason: 'CYCLE_DEGRADED',
      severity: 'critical',
      cycleId: terminal.cycleId ?? null,
      stage: terminal.cycleStage ?? null,
      message: `cycle ${terminal.cycleId} was quarantined in a DEGRADED terminal state and needs owner review`,
      detail: { terminalDigest: terminal.terminalDigest ?? null },
    });
  }
  if (['HELD_DATA_UNVERIFIED', 'HELD_UNAVAILABLE', 'HELD_OWNER_DECISION'].includes(terminal.terminalState)) {
    return buildAlert({
      reason: 'CYCLE_DEGRADED',
      severity: 'critical',
      cycleId: terminal.cycleId ?? null,
      stage: terminal.cycleStage ?? null,
      message: `cycle ${terminal.cycleId} is held as ${terminal.terminalState} and needs owner recovery`,
      detail: { terminalState: terminal.terminalState, terminalDigest: terminal.terminalDigest ?? null },
    });
  }
  return null;
}

/** A tiny "fire once per key" tracker: `shouldFire(key)` returns `true` (and remembers the key) only
 * the first time it is called for that key, `false` on every subsequent call, until `reset(key)` or
 * `clear()` forgets it. Used to keep an alert-worthy condition that a caller re-observes on every tick
 * (a nonzero protocol fee, a still-failed cycle) from paging the same alert repeatedly. */
export function createTransitionDeduper() {
  const fired = new Set();
  return Object.freeze({
    shouldFire(key) {
      if (typeof key !== 'string' || key.length === 0) throw new Error('transition dedupe key must be a nonempty string');
      if (fired.has(key)) return false;
      fired.add(key);
      return true;
    },
    reset(key) {
      if (typeof key !== 'string' || key.length === 0) throw new Error('transition dedupe key must be a nonempty string');
      fired.delete(key);
    },
    clear() {
      fired.clear();
    },
  });
}
