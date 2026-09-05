// Structured JSON logging (design section 4.7 / ops/HANDOFF.md's paging gap): every log line this
// module emits is one canonical JSON object on its own line, with a fixed set of leading fields
// (`schema`, `ts`, `level`, `event`) followed by the typed fields registered for that event.
// Deliberately dependency-free — no pino, no winston, no vendor SDK — because this project's logging
// need is "grep-able structured lines a human or a log shipper can parse", not a logging framework.
//
// Two call shapes cover the runner's actual event sources without this module knowing anything about
// their domains:
//   - `logStageTransition({cycleId, stage, status, message, ...fields})` — one line per cycle stage
//     transition (the eight-stage sequence in automation/automated-cycle-service.mjs), with the log
//     level derived from `status` (FAILED/DEGRADED -> error, RETRY/LEASE_HELD -> warn, everything else
//     -> info) so a log shipper's severity filter needs no domain knowledge either.
//   - `logSchedulerTick(event)` — one line per scheduler tick, taking the exact event object
//     scheduler.mjs's `onTick` hook already produces (`{type, tick, at, error, paused, liveMode,
//     intervalMs, calledMethod, result}`) with no reshaping required at the call site.
// Both are optional conveniences. `debug`/`info`/`warn`/`error` only emit registered observability
// events so opaque provider or signer data cannot become a log field through a new call site.
export const LOG_SCHEMA = 'hookemon.runner-log.v1';
export const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);

const LOG_LEVEL_RANK = Object.freeze({ debug: 0, info: 1, warn: 2, error: 3 });
const SENSITIVE_FIELD = /(?:authorization|credential|keychain|mnemonic|pass(?:word|phrase)?|private|secret|seed|signature|token|webhook|api[-_]?key|\burl\b)/i;
const SENSITIVE_VALUE = /(?:(?:https?|keychain):\/\/|\bbearer\s+|0x[0-9a-f]{130,}|\b(?:api[-_]?key|authorization|credential|key|mnemonic|pass(?:word|phrase)?|private|secret|seed|token)\s*(?:=|:)\s*\S+|(?:raw|signed|serialized|binary)[\s_-]*(?:bytes?|tx(?:base64)?|transaction|payload|message|data|base64))/i;
const UNSAFE_TRANSACTION_FIELD = /(?:raw|signed|serialized|binary|encoded).*(?:bytes?|tx(?:base64)?|transaction|payload|message|data|base64)|^(?:raw|signed|serialized|binary|payload(?:bytes)?|transaction|data|wire|keypair|cookies?)$/i;
const EXTERNAL_ERROR_FIELD = /(?:^|[_-])(?:error|errors|cause)(?:$|[_-])|(?:error|errors|cause)$/i;
const REDACTED = '[REDACTED]';
const EXTERNAL_ERROR = 'external error';

function isBinaryValue(value) {
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Replace externally supplied error text with a stable, non-sensitive description. */
export function normalizeExternalError() {
  return EXTERNAL_ERROR;
}

function redactValue(value, seen, key = '') {
  if (SENSITIVE_FIELD.test(key) || UNSAFE_TRANSACTION_FIELD.test(key)) return REDACTED;
  if (EXTERNAL_ERROR_FIELD.test(key)) return normalizeExternalError(value);
  if (typeof value === 'string') return SENSITIVE_VALUE.test(value) ? REDACTED : value;
  if (typeof value === 'bigint') return value.toString();
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return normalizeExternalError(value);
  if (isBinaryValue(value)) return REDACTED;
  if (seen.has(value)) return REDACTED;
  seen.add(value);
  if (Array.isArray(value)) return value.map(entry => redactValue(entry, seen));
  if (!isPlainObject(value)) return REDACTED;
  const result = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    result[entryKey] = redactValue(entryValue, seen, entryKey);
  }
  return result;
}

/** Return a JSON-safe copy with credentials and signer references removed before any sink sees it. */
export function redactForLogging(value) {
  return redactValue(value, new WeakSet());
}

// Status -> level is intentionally a lookup with a permissive 'info' fallback, not an exhaustive enum
// check: new stage statuses can be introduced by the cycle domain without requiring an edit here.
const STAGE_STATUS_LEVELS = Object.freeze({
  STARTED: 'info',
  COMPLETE: 'info',
  RETRY: 'warn',
  LEASE_HELD: 'warn',
  FAILED: 'error',
  DEGRADED: 'error',
});

// Mirrors the event `type` values scheduler.mjs's `emit()` produces (see scheduler.mjs's runTick).
const SCHEDULER_EVENT_LEVELS = Object.freeze({
  TICK_COMPLETE: 'info',
  TICK_STATE_MISSING: 'warn',
  TICK_STATE_READ_FAILED: 'error',
  TICK_WORKER_BUILD_FAILED: 'error',
  TICK_WORKER_INVALID: 'error',
  TICK_FAILED: 'error',
});

const fixedFields = Object.freeze(['schema', 'ts', 'level', 'event']);

function isSafeLogText(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= 512
    && !SENSITIVE_VALUE.test(value);
}

function isNullableSafeLogText(value) {
  return value === null || isSafeLogText(value);
}

function isSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNullableSafeInteger(value) {
  return value === null || isSafeInteger(value);
}

function isNullableBoolean(value) {
  return value === null || typeof value === 'boolean';
}

function isCanonicalAtomic(value) {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}

function isCode(value) {
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]*$/.test(value);
}

function assertSchemaObject(value, schema, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object`);
  for (const [key, entry] of Object.entries(value)) {
    if (!Object.hasOwn(schema, key)) throw new Error(`${label} does not allow field "${key}"`);
    const validator = schema[key];
    if (!validator(entry)) throw new Error(`${label} field "${key}" is invalid`);
  }
}

function assertCanaryDriftValue(value, label) {
  if (value === null || typeof value === 'boolean' || isSafeInteger(value) || isSafeLogText(value)) return;
  const fields = Object.freeze({
    protocolFee: isCanonicalAtomic,
    lpFee: isCanonicalAtomic,
    treasury: isSafeLogText,
    operations: isSafeLogText,
    cycle: candidate => {
      assertSchemaObject(candidate, Object.freeze({ cycleId: isSafeLogText, operations: isSafeLogText }), `${label}.cycle`);
      return true;
    },
    cycleId: isSafeLogText,
    blockhash: isSafeLogText,
    lastValidBlockHeight: isCanonicalAtomic,
    isValid: candidate => typeof candidate === 'boolean',
    currentBlockHeight: isCanonicalAtomic,
    chainId: candidate => typeof candidate === 'string' || isSafeInteger(candidate),
    assetId: isSafeLogText,
    decimals: candidate => Number.isInteger(candidate) && candidate >= 0 && candidate <= 255,
    amountAtomic: isCanonicalAtomic,
    ready: candidate => typeof candidate === 'boolean',
  });
  assertSchemaObject(value, fields, label);
}

function assertCanaryDriftField(value) {
  assertCanaryDriftValue(value, 'canary drift value');
  return true;
}

function assertSchedulerResult(value) {
  assertSchemaObject(value, Object.freeze({
    status: isCode,
    cycleId: isNullableSafeLogText,
    stage: isNullableSafeLogText,
    requiredProcessUsdg: isCanonicalAtomic,
    reason: isCode,
    feeSettlement: candidate => {
      assertSchemaObject(candidate, Object.freeze({
        cycleId: isNullableSafeLogText,
        status: isCode,
      }), 'scheduler result.feeSettlement');
      return true;
    },
  }), 'scheduler result');
}

function assertSchedulerResultField(value) {
  assertSchedulerResult(value);
  return true;
}

const SCHEDULER_COMMON_FIELDS = Object.freeze({
  tick: isNullableSafeInteger,
  tickAt: isNullableSafeInteger,
  paused: isNullableBoolean,
  liveMode: isNullableBoolean,
  intervalMs: isNullableSafeInteger,
  calledMethod: isSafeLogText,
  error: value => value === EXTERNAL_ERROR,
});

const LOG_EVENT_SCHEMAS = Object.freeze({
  'stage-transition': Object.freeze({
    cycleId: isSafeLogText,
    stage: isSafeLogText,
    status: isCode,
    message: isSafeLogText,
  }),
  'scheduler-tick-complete': Object.freeze({ ...SCHEDULER_COMMON_FIELDS, result: assertSchedulerResultField }),
  'scheduler-tick-state-missing': SCHEDULER_COMMON_FIELDS,
  'scheduler-tick-state-read-failed': SCHEDULER_COMMON_FIELDS,
  'scheduler-tick-worker-build-failed': SCHEDULER_COMMON_FIELDS,
  'scheduler-tick-worker-invalid': SCHEDULER_COMMON_FIELDS,
  'scheduler-tick-failed': SCHEDULER_COMMON_FIELDS,
  'protocol-fee-nonzero': Object.freeze({ poolId: isSafeLogText, protocolFee: isCanonicalAtomic }),
  'alert-webhook-delivery-failed': Object.freeze({
    reason: isCode,
    attempts: value => Number.isSafeInteger(value) && value > 0,
    error: value => value === 'alert webhook transport failed' || /^alert webhook responded with status (?:[1-5][0-9]{2}|unknown)$/.test(value),
  }),
  'observability-alert-dedupe-unavailable': Object.freeze({ reason: isSafeLogText, code: isCode, target: isSafeLogText }),
  'observability-alert-webhook-unavailable': Object.freeze({ reason: isSafeLogText }),
  'observability-alert-sink-unavailable': Object.freeze({ code: isCode, target: isSafeLogText }),
  'pre-signature-canary-drift': Object.freeze({
    code: isCode,
    target: isSafeLogText,
    expected: assertCanaryDriftField,
    observed: assertCanaryDriftField,
    action: isSafeLogText,
    delivered: value => typeof value === 'boolean',
  }),
  'start-preflight-drift': Object.freeze({
    code: isCode,
    target: isSafeLogText,
    expected: assertCanaryDriftField,
    observed: assertCanaryDriftField,
    action: isSafeLogText,
    delivered: value => typeof value === 'boolean',
  }),
});

function assertRegisteredEventFields(event, value, label) {
  if (!Object.hasOwn(LOG_EVENT_SCHEMAS, event)) throw new Error(`log event "${event}" is not a registered observability event`);
  const schema = LOG_EVENT_SCHEMAS[event];
  assertSchemaObject(value, schema, label);
}

function assertSafeLogValue(value, label, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'bigint') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must not contain a non-finite number`);
    return;
  }
  if (value instanceof Error) return;
  if (isBinaryValue(value)) throw new Error(`${label} must not contain a binary log value`);
  if (typeof value !== 'object' || value === null) throw new Error(`${label} must contain JSON-safe values`);
  if (seen.has(value)) throw new Error(`${label} must not contain a cyclic log value`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (const entry of value) assertSafeLogValue(entry, label, seen);
    return;
  }
  if (!isPlainObject(value)) throw new Error(`${label} must contain plain object values`);
  for (const [key, entry] of Object.entries(value)) {
    if (UNSAFE_TRANSACTION_FIELD.test(key)) throw new Error(`${label} contains unsafe log field "${key}"`);
    assertSafeLogValue(entry, label, seen);
  }
}

function assertExtraFields(event, value, label) {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a plain object`);
  for (const key of fixedFields) {
    if (Object.hasOwn(value, key)) throw new Error(`${label} must not redefine the fixed log field "${key}"`);
  }
  assertRegisteredEventFields(event, value, label);
  assertSafeLogValue(value, label);
  return value;
}

function errorMessage(error) {
  if (error === undefined) return undefined;
  return normalizeExternalError(error);
}

/**
 * Build a logger. Every dependency is injected for testability: `clock` defaults to a real
 * ISO-8601 timestamp, `stdout`/`stderr` default to `console.log`/`console.error` (the module never
 * imports `node:process` or any I/O framework — a fixed schema written to the two standard streams is
 * the entire contract).
 *
 * @param {object} [options]
 * @param {() => string} [options.clock] - defaults to `() => new Date().toISOString()`.
 * @param {(line: string) => void} [options.stdout] - defaults to `console.log`. Used for debug/info.
 * @param {(line: string) => void} [options.stderr] - defaults to `console.error`. Used for warn/error.
 */
export function createLogger(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('logger options must be an object');
  const {
    clock = () => new Date().toISOString(),
    stdout = line => console.log(line),
    stderr = line => console.error(line),
    minimumLevel = 'debug',
  } = options;
  if (typeof clock !== 'function') throw new Error('logger clock must be a function');
  if (typeof stdout !== 'function') throw new Error('logger stdout must be a function');
  if (typeof stderr !== 'function') throw new Error('logger stderr must be a function');
  if (!LOG_LEVELS.includes(minimumLevel)) throw new Error(`logger minimumLevel must be one of ${LOG_LEVELS.join(', ')}`);

  function write(level, event, fields) {
    if (!LOG_LEVELS.includes(level)) throw new Error(`log level must be one of ${LOG_LEVELS.join(', ')}`);
    if (typeof event !== 'string' || event.length === 0) throw new Error('log event must be a nonempty string');
    const extra = assertExtraFields(event, fields, 'log fields');
    if (LOG_LEVEL_RANK[level] < LOG_LEVEL_RANK[minimumLevel]) return null;
    const record = Object.freeze({ schema: LOG_SCHEMA, ts: clock(), level, event, ...redactForLogging(extra) });
    const line = JSON.stringify(record);
    (level === 'warn' || level === 'error' ? stderr : stdout)(line);
    return record;
  }

  return Object.freeze({
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),

    /** One structured line per cycle stage transition. `status` drives the log level (see
     * STAGE_STATUS_LEVELS above). The emitted fields are fixed because stage output is an
     * observability boundary, not a general event transport. */
    logStageTransition({ cycleId, stage, status, message, ...rest }) {
      if (typeof cycleId !== 'string' || cycleId.length === 0) throw new Error('stage transition cycleId must be a nonempty string');
      if (typeof stage !== 'string' || stage.length === 0) throw new Error('stage transition stage must be a nonempty string');
      if (typeof status !== 'string' || status.length === 0) throw new Error('stage transition status must be a nonempty string');
      const level = STAGE_STATUS_LEVELS[status] ?? 'info';
      const fields = { cycleId, stage, status, ...(message !== undefined ? { message } : {}), ...rest };
      return write(level, 'stage-transition', fields);
    },

    /** One structured line per scheduler tick, taking the exact `onTick` event shape scheduler.mjs
     * emits. Unknown scheduler event types are rejected so a future result shape cannot leak into logs
     * without an explicit schema review. */
    logSchedulerTick(event) {
      if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('scheduler tick event must be an object');
      if (typeof event.type !== 'string' || event.type.length === 0) throw new Error('scheduler tick event type must be a nonempty string');
      const level = SCHEDULER_EVENT_LEVELS[event.type];
      if (level === undefined) throw new Error(`scheduler tick event type "${event.type}" is not registered`);
      const fields = {
        tick: event.tick ?? null,
        tickAt: event.at ?? null,
        paused: event.paused ?? null,
        liveMode: event.liveMode ?? null,
        intervalMs: event.intervalMs ?? null,
      };
      if (event.calledMethod !== undefined) fields.calledMethod = event.calledMethod;
      if (event.result !== undefined) fields.result = event.result;
      if (event.error !== undefined) fields.error = errorMessage(event.error);
      const eventName = `scheduler-${event.type.toLowerCase().replace(/_/g, '-')}`;
      return write(level, eventName, fields);
    },
  });
}
