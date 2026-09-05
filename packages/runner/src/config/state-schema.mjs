// Operator configuration document: the dashboard-editable knobs (schedule interval, allowed pack
// list, per-cycle order and price caps, spend caps, and the pause/live-mode switches) that the
// automation scheduler reads out of the operator state file (packages/runner/src/operator/state-file.mjs).
// This module holds no secret material and performs no signing; it only validates the shape of a
// plain JSON document and rejects anything that carries a secret-material field.
import { canonicalJson } from '../cycle/journal.mjs';

export const OPERATOR_CONFIGURATION_SCHEMA = 'hookemon.operator-configuration.v2';

const configurationFields = [
  'schema',
  'intervalMinutes',
  'allowedPackIds',
  'requestedOrders',
  'maxBoostersPerCycle',
  'maxUnitPriceMicroUsdg',
  'maxCycleBudgetMicroUsdg',
  'max24HourBudgetMicroUsdg',
  'paused',
  'liveMode',
  'maxCyclesPerDay',
  'perCycleCapMicroUsdg',
  'lossCapMicroUsdg',
  'maxOutstandingCustodyMicroUsdg',
  'executionPaused',
  'killSwitch',
  'manualApprovalCycles',
  'pendingEpicDecisions',
  'approvalsByCycleDigest',
  'spendLedger',
  'cycleLedger',
  'configurationRevision',
];
const unversionedConfigurationFields = configurationFields.filter(field => field !== 'schema');
const legacyConfigurationFields = [
  'intervalMinutes',
  'allowedPackIds',
  'requestedOrders',
  'maxBoostersPerCycle',
  'maxUnitPriceMicroUsdg',
  'maxCycleBudgetMicroUsdg',
  'max24HourBudgetMicroUsdg',
  'paused',
  'liveMode',
  'configurationRevision',
];

// The same field list the policy-wallet module (packages/runner/src/automation/policy-wallets.mjs)
// rejects on any configuration object; kept here too so this schema independently refuses to ever
// accept or round-trip secret material, even if it were ever merged with a wallet configuration.
const prohibitedSecretFields = new Set(['privateKey', 'secretKey', 'mnemonic', 'seed', 'keypair']);

const packCodePattern = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const microUsdgPattern = /^(0|[1-9][0-9]*)$/;
const cycleIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const maxSafeMicroUsdg = BigInt(Number.MAX_SAFE_INTEGER);

const minimumIntervalMinutes = 5;
const maximumIntervalMinutes = 1440;
const maximumBoostersPerCycle = 1000;

export const DEFAULT_INTERVAL_MINUTES = 20;
export const DEFAULT_LIVE_MODE = false;

function assertExactPlainObject(value, fields, label) {
  canonicalJson(value);
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== fields.length
    || !fields.every(field => Object.hasOwn(value, field))
  ) throw new Error(`${label} must use the exact schema`);
}

function assertNoSecretMaterial(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (prohibitedSecretFields.has(key)) throw new Error(`${label} must not carry secret-material fields`);
  }
}

function assertIntegerInRange(value, label, { min, max }) {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  return value;
}

function assertMicroUsdgAmount(value, label) {
  if (typeof value !== 'string' || !microUsdgPattern.test(value)) {
    throw new Error(`${label} must be a canonical unsigned decimal string`);
  }
  const amount = BigInt(value);
  if (amount > maxSafeMicroUsdg) throw new Error(`${label} exceeds the maximum representable micro-USDG amount`);
  return amount;
}

function assertAllowedPackIds(value) {
  if (!Array.isArray(value)) throw new Error('operator configuration allowedPackIds must be an array');
  let previous = null;
  for (const code of value) {
    if (typeof code !== 'string' || !packCodePattern.test(code)) throw new Error('operator configuration allowedPackIds entry is invalid');
    if (previous !== null && code <= previous) throw new Error('operator configuration allowedPackIds must be unique and sorted');
    previous = code;
  }
  return [...value];
}

function assertTimestamp(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative safe integer`);
  return value;
}

function assertCycleId(value, label) {
  if (typeof value !== 'string' || !cycleIdPattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !digestPattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function assertExactRecord(value, fields, label) {
  assertExactPlainObject(value, fields, label);
  return value;
}

function freezeRecords(records) {
  return Object.freeze(records.map(record => Object.freeze(record)));
}

function assertPendingEpicDecisions(value) {
  if (!Array.isArray(value)) throw new Error('operator configuration pendingEpicDecisions must be an array');
  const seenCycleIds = new Set();
  const decisions = value.map((entry, index) => {
    assertExactRecord(entry, ['cycleId', 'cycleDigest', 'heldAtMs'], `operator configuration pendingEpicDecisions[${index}]`);
    assertCycleId(entry.cycleId, `operator configuration pendingEpicDecisions[${index}] cycleId`);
    assertDigest(entry.cycleDigest, `operator configuration pendingEpicDecisions[${index}] cycleDigest`);
    assertTimestamp(entry.heldAtMs, `operator configuration pendingEpicDecisions[${index}] heldAtMs`);
    if (seenCycleIds.has(entry.cycleId)) throw new Error('operator configuration pendingEpicDecisions cycleId is duplicated');
    seenCycleIds.add(entry.cycleId);
    return { ...entry };
  });
  return freezeRecords(decisions);
}

function assertApprovalsByCycleDigest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('operator configuration approvalsByCycleDigest must be a plain object');
  }
  const approvals = {};
  for (const [cycleDigest, approval] of Object.entries(value)) {
    assertDigest(cycleDigest, 'operator configuration approval cycle digest');
    assertExactRecord(approval, ['cycleId', 'approvedAtMs'], `operator configuration approval ${cycleDigest}`);
    assertCycleId(approval.cycleId, `operator configuration approval ${cycleDigest} cycleId`);
    assertTimestamp(approval.approvedAtMs, `operator configuration approval ${cycleDigest} approvedAtMs`);
    approvals[cycleDigest] = Object.freeze({ ...approval });
  }
  return Object.freeze(approvals);
}

function assertCycleLedger(value) {
  if (!Array.isArray(value)) throw new Error('operator configuration cycleLedger must be an array');
  const seenCycleIds = new Set();
  const seenDigests = new Set();
  let previousOpenedAtMs = -1;
  const ledger = value.map((entry, index) => {
    assertExactRecord(entry, ['cycleId', 'cycleDigest', 'mode', 'openedAtMs', 'releaseAmountMicroUsdg'], `operator configuration cycleLedger[${index}]`);
    assertCycleId(entry.cycleId, `operator configuration cycleLedger[${index}] cycleId`);
    assertDigest(entry.cycleDigest, `operator configuration cycleLedger[${index}] cycleDigest`);
    if (entry.mode !== 'production' && entry.mode !== 'rehearsal') throw new Error(`operator configuration cycleLedger[${index}] mode is invalid`);
    assertTimestamp(entry.openedAtMs, `operator configuration cycleLedger[${index}] openedAtMs`);
    assertMicroUsdgAmount(entry.releaseAmountMicroUsdg, `operator configuration cycleLedger[${index}] releaseAmountMicroUsdg`);
    if (seenCycleIds.has(entry.cycleId) || seenDigests.has(entry.cycleDigest)) throw new Error('operator configuration cycleLedger cycle identity is duplicated');
    if (entry.openedAtMs < previousOpenedAtMs) throw new Error('operator configuration cycleLedger must be ordered by openedAtMs');
    seenCycleIds.add(entry.cycleId);
    seenDigests.add(entry.cycleDigest);
    previousOpenedAtMs = entry.openedAtMs;
    return { ...entry };
  });
  return freezeRecords(ledger);
}

function assertSpendLedger(value, cycleLedger) {
  if (!Array.isArray(value)) throw new Error('operator configuration spendLedger must be an array');
  const cycleDigests = new Set(cycleLedger.map(entry => entry.cycleDigest));
  const seenCycleDigests = new Set();
  let previousReservedAtMs = -1;
  const ledger = value.map((entry, index) => {
    assertExactRecord(entry, ['cycleId', 'cycleDigest', 'amountMicroUsdg', 'reservedAtMs'], `operator configuration spendLedger[${index}]`);
    assertCycleId(entry.cycleId, `operator configuration spendLedger[${index}] cycleId`);
    assertDigest(entry.cycleDigest, `operator configuration spendLedger[${index}] cycleDigest`);
    assertMicroUsdgAmount(entry.amountMicroUsdg, `operator configuration spendLedger[${index}] amountMicroUsdg`);
    assertTimestamp(entry.reservedAtMs, `operator configuration spendLedger[${index}] reservedAtMs`);
    if (!cycleDigests.has(entry.cycleDigest)) throw new Error('operator configuration spendLedger must bind a recorded cycle digest');
    if (seenCycleDigests.has(entry.cycleDigest)) throw new Error('operator configuration spendLedger cycle digest is duplicated');
    if (entry.reservedAtMs < previousReservedAtMs) throw new Error('operator configuration spendLedger must be ordered by reservedAtMs');
    seenCycleDigests.add(entry.cycleDigest);
    previousReservedAtMs = entry.reservedAtMs;
    return { ...entry };
  });
  return freezeRecords(ledger);
}

/**
 * Validate a plain-object operator configuration document against the exact schema (no unknown
 * fields, no missing fields, no secret-material fields, every value in range) and return a frozen,
 * schema-clean copy. Throws on any violation; never mutates its input.
 */
export function assertOperatorConfiguration(value) {
  assertNoSecretMaterial(value, 'operator configuration');
  assertExactPlainObject(value, configurationFields, 'operator configuration');
  if (value.schema !== OPERATOR_CONFIGURATION_SCHEMA) throw new Error('operator configuration schema is invalid');

  const intervalMinutes = assertIntegerInRange(value.intervalMinutes, 'operator configuration intervalMinutes', {
    min: minimumIntervalMinutes,
    max: maximumIntervalMinutes,
  });
  const allowedPackIds = assertAllowedPackIds(value.allowedPackIds);
  const maxBoostersPerCycle = assertIntegerInRange(value.maxBoostersPerCycle, 'operator configuration maxBoostersPerCycle', {
    min: 1,
    max: maximumBoostersPerCycle,
  });
  const requestedOrders = assertIntegerInRange(value.requestedOrders, 'operator configuration requestedOrders', {
    min: 0,
    max: maxBoostersPerCycle,
  });
  const maxUnitPriceMicroUsdg = assertMicroUsdgAmount(value.maxUnitPriceMicroUsdg, 'operator configuration maxUnitPriceMicroUsdg');
  const maxCycleBudgetMicroUsdg = assertMicroUsdgAmount(value.maxCycleBudgetMicroUsdg, 'operator configuration maxCycleBudgetMicroUsdg');
  const max24HourBudgetMicroUsdg = assertMicroUsdgAmount(value.max24HourBudgetMicroUsdg, 'operator configuration max24HourBudgetMicroUsdg');
  if (maxUnitPriceMicroUsdg > maxCycleBudgetMicroUsdg) {
    throw new Error('operator configuration maxUnitPriceMicroUsdg must not exceed maxCycleBudgetMicroUsdg');
  }
  if (maxCycleBudgetMicroUsdg > max24HourBudgetMicroUsdg) {
    throw new Error('operator configuration maxCycleBudgetMicroUsdg must not exceed max24HourBudgetMicroUsdg');
  }
  const paused = assertBoolean(value.paused, 'operator configuration paused');
  const liveMode = assertBoolean(value.liveMode, 'operator configuration liveMode');
  const maxCyclesPerDay = assertIntegerInRange(value.maxCyclesPerDay, 'operator configuration maxCyclesPerDay', {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  const perCycleCapMicroUsdg = assertMicroUsdgAmount(value.perCycleCapMicroUsdg, 'operator configuration perCycleCapMicroUsdg');
  if (perCycleCapMicroUsdg !== maxCycleBudgetMicroUsdg) {
    throw new Error('operator configuration perCycleCapMicroUsdg must equal maxCycleBudgetMicroUsdg');
  }
  const lossCapMicroUsdg = assertMicroUsdgAmount(value.lossCapMicroUsdg, 'operator configuration lossCapMicroUsdg');
  const maxOutstandingCustodyMicroUsdg = assertMicroUsdgAmount(value.maxOutstandingCustodyMicroUsdg, 'operator configuration maxOutstandingCustodyMicroUsdg');
  const executionPaused = assertBoolean(value.executionPaused, 'operator configuration executionPaused');
  const killSwitch = assertBoolean(value.killSwitch, 'operator configuration killSwitch');
  const manualApprovalCycles = assertIntegerInRange(value.manualApprovalCycles, 'operator configuration manualApprovalCycles', {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  const pendingEpicDecisions = assertPendingEpicDecisions(value.pendingEpicDecisions);
  const approvalsByCycleDigest = assertApprovalsByCycleDigest(value.approvalsByCycleDigest);
  const cycleLedger = assertCycleLedger(value.cycleLedger);
  const spendLedger = assertSpendLedger(value.spendLedger, cycleLedger);
  const configurationRevision = assertIntegerInRange(value.configurationRevision, 'operator configuration configurationRevision', {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });

  return Object.freeze({
    schema: OPERATOR_CONFIGURATION_SCHEMA,
    intervalMinutes,
    allowedPackIds: Object.freeze(allowedPackIds),
    requestedOrders,
    maxBoostersPerCycle,
    maxUnitPriceMicroUsdg: value.maxUnitPriceMicroUsdg,
    maxCycleBudgetMicroUsdg: value.maxCycleBudgetMicroUsdg,
    max24HourBudgetMicroUsdg: value.max24HourBudgetMicroUsdg,
    paused,
    liveMode,
    maxCyclesPerDay,
    perCycleCapMicroUsdg: value.perCycleCapMicroUsdg,
    lossCapMicroUsdg: value.lossCapMicroUsdg,
    maxOutstandingCustodyMicroUsdg: value.maxOutstandingCustodyMicroUsdg,
    executionPaused,
    killSwitch,
    manualApprovalCycles,
    pendingEpicDecisions,
    approvalsByCycleDigest,
    spendLedger,
    cycleLedger,
    configurationRevision,
  });
}

/**
 * The conservative starting configuration: no packs allowed, zero spend caps, dry-run
 * (liveMode false) and unpaused. Promotion to real spend is an explicit dashboard edit, never an
 * inferred default.
 */
export function createDefaultOperatorConfiguration() {
  return assertOperatorConfiguration({
    schema: OPERATOR_CONFIGURATION_SCHEMA,
    intervalMinutes: DEFAULT_INTERVAL_MINUTES,
    allowedPackIds: [],
    requestedOrders: 0,
    maxBoostersPerCycle: 1,
    maxUnitPriceMicroUsdg: '0',
    maxCycleBudgetMicroUsdg: '0',
    max24HourBudgetMicroUsdg: '0',
    paused: false,
    liveMode: DEFAULT_LIVE_MODE,
    maxCyclesPerDay: 0,
    perCycleCapMicroUsdg: '0',
    lossCapMicroUsdg: '0',
    maxOutstandingCustodyMicroUsdg: '0',
    executionPaused: false,
    killSwitch: false,
    manualApprovalCycles: 0,
    pendingEpicDecisions: [],
    approvalsByCycleDigest: {},
    spendLedger: [],
    cycleLedger: [],
    configurationRevision: 0,
  });
}

function hasExactFields(value, fields) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && Object.keys(value).length === fields.length
    && fields.every(field => Object.hasOwn(value, field));
}

/**
 * Converts persisted pre-versioned configuration records to the current exact schema. Legacy
 * records preserve their original budget controls but add every newly introduced control in a
 * fail-closed state. Invalid shapes remain unmodified so the normal validator refuses them.
 */
export function migrateOperatorConfiguration(value) {
  if (value === null) return Object.freeze({ configuration: null, migrated: false });
  if (hasExactFields(value, configurationFields) && value.schema === OPERATOR_CONFIGURATION_SCHEMA) {
    return Object.freeze({ configuration: assertOperatorConfiguration(value), migrated: false });
  }
  if (hasExactFields(value, unversionedConfigurationFields)) {
    return Object.freeze({
      configuration: assertOperatorConfiguration({ schema: OPERATOR_CONFIGURATION_SCHEMA, ...value }),
      migrated: true,
    });
  }
  if (hasExactFields(value, legacyConfigurationFields)) {
    return Object.freeze({
      configuration: assertOperatorConfiguration({
        schema: OPERATOR_CONFIGURATION_SCHEMA,
        ...value,
        maxCyclesPerDay: 0,
        perCycleCapMicroUsdg: value.maxCycleBudgetMicroUsdg,
        lossCapMicroUsdg: '0',
        maxOutstandingCustodyMicroUsdg: '0',
        executionPaused: true,
        killSwitch: false,
        manualApprovalCycles: 0,
        pendingEpicDecisions: [],
        approvalsByCycleDigest: {},
        spendLedger: [],
        cycleLedger: [],
      }),
      migrated: true,
    });
  }
  return Object.freeze({ configuration: value, migrated: false });
}

/**
 * Apply a full-replacement edit (as the dashboard would submit) to the current configuration
 * (or the default configuration when none exists yet), bumping configurationRevision by exactly
 * one. `patch` must supply every field except configurationRevision, which this function owns.
 */
export function applyOperatorConfiguration(current, patch) {
  const base = current === null ? createDefaultOperatorConfiguration() : assertOperatorConfiguration(current);
  assertNoSecretMaterial(patch, 'operator configuration patch');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('operator configuration patch must be a plain object');
  if (Object.hasOwn(patch, 'schema') && patch.schema !== OPERATOR_CONFIGURATION_SCHEMA) {
    throw new Error('operator configuration patch schema is invalid');
  }
  if (Object.hasOwn(patch, 'configurationRevision')) throw new Error('operator configuration patch must not set configurationRevision directly');
  for (const field of ['pendingEpicDecisions', 'approvalsByCycleDigest', 'spendLedger', 'cycleLedger']) {
    if (Object.hasOwn(patch, field)) throw new Error(`operator configuration patch must not set ${field} directly`);
  }
  const next = { ...base, ...patch };
  if (Object.hasOwn(patch, 'maxCycleBudgetMicroUsdg') && !Object.hasOwn(patch, 'perCycleCapMicroUsdg')) {
    next.perCycleCapMicroUsdg = patch.maxCycleBudgetMicroUsdg;
  }
  if (Object.hasOwn(patch, 'perCycleCapMicroUsdg') && !Object.hasOwn(patch, 'maxCycleBudgetMicroUsdg')) {
    next.maxCycleBudgetMicroUsdg = patch.perCycleCapMicroUsdg;
  }
  return assertOperatorConfiguration({ ...next, configurationRevision: base.configurationRevision + 1 });
}
