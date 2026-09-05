import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyOperatorConfiguration,
  assertOperatorConfiguration,
  createDefaultOperatorConfiguration,
  DEFAULT_INTERVAL_MINUTES,
  DEFAULT_LIVE_MODE,
  migrateOperatorConfiguration,
} from '../../src/config/state-schema.mjs';

function validConfiguration(overrides = {}) {
  return {
    schema: 'hookemon.operator-configuration.v2',
    intervalMinutes: 20,
    allowedPackIds: ['base', 'turbo-pack'],
    requestedOrders: 1,
    maxBoostersPerCycle: 1,
    maxUnitPriceMicroUsdg: '25000000',
    maxCycleBudgetMicroUsdg: '25500000',
    max24HourBudgetMicroUsdg: '1836000000',
    paused: false,
    liveMode: false,
    maxCyclesPerDay: 10,
    perCycleCapMicroUsdg: '25500000',
    lossCapMicroUsdg: '50000000',
    maxOutstandingCustodyMicroUsdg: '50000000',
    executionPaused: false,
    killSwitch: false,
    manualApprovalCycles: 0,
    pendingEpicDecisions: [],
    approvalsByCycleDigest: {},
    spendLedger: [],
    cycleLedger: [],
    configurationRevision: 0,
    ...overrides,
  };
}

test('accepts a well-formed operator configuration and round-trips every field', () => {
  const input = validConfiguration();
  const result = assertOperatorConfiguration(input);
  assert.deepEqual(result, input);
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.allowedPackIds));
});

test('rejects unknown fields', () => {
  assert.throws(
    () => assertOperatorConfiguration({ ...validConfiguration(), extraField: 1 }),
    /exact schema/,
  );
});

test('rejects a missing field', () => {
  const { paused, ...withoutPaused } = validConfiguration();
  assert.throws(() => assertOperatorConfiguration(withoutPaused), /exact schema/);
});

test('rejects secret-material fields outright, before any other validation', () => {
  for (const field of ['privateKey', 'secretKey', 'mnemonic', 'seed', 'keypair']) {
    assert.throws(
      () => assertOperatorConfiguration({ ...validConfiguration(), [field]: 'obviously-fake-placeholder-value' }),
      /secret-material/,
    );
  }
});

test('rejects intervalMinutes out of the 5..1440 range', () => {
  assert.throws(() => assertOperatorConfiguration(validConfiguration({ intervalMinutes: 4 })), /intervalMinutes/);
  assert.throws(() => assertOperatorConfiguration(validConfiguration({ intervalMinutes: 1441 })), /intervalMinutes/);
  assert.throws(() => assertOperatorConfiguration(validConfiguration({ intervalMinutes: 20.5 })), /intervalMinutes/);
  assert.doesNotThrow(() => assertOperatorConfiguration(validConfiguration({ intervalMinutes: 5 })));
  assert.doesNotThrow(() => assertOperatorConfiguration(validConfiguration({ intervalMinutes: 1440 })));
});

test('rejects malformed, duplicate, or unsorted pack ids', () => {
  assert.throws(() => assertOperatorConfiguration(validConfiguration({ allowedPackIds: ['Bad Code'] })), /allowedPackIds/);
  assert.throws(() => assertOperatorConfiguration(validConfiguration({ allowedPackIds: ['base', 'base'] })), /unique/);
  assert.throws(() => assertOperatorConfiguration(validConfiguration({ allowedPackIds: ['turbo-pack', 'base'] })), /sorted/);
  assert.doesNotThrow(() => assertOperatorConfiguration(validConfiguration({ allowedPackIds: [] })));
});

test('accepts lowercase pack codes containing underscores and rejects spaced names', () => {
  assert.doesNotThrow(() => assertOperatorConfiguration(validConfiguration({ allowedPackIds: ['pokemon_50'] })));
  assert.throws(() => assertOperatorConfiguration(validConfiguration({ allowedPackIds: ['Pokemon 50'] })), /allowedPackIds/);
});

test('rejects requestedOrders above maxBoostersPerCycle', () => {
  assert.throws(
    () => assertOperatorConfiguration(validConfiguration({ maxBoostersPerCycle: 2, requestedOrders: 3 })),
    /requestedOrders/,
  );
  assert.doesNotThrow(() => assertOperatorConfiguration(validConfiguration({ maxBoostersPerCycle: 2, requestedOrders: 2 })));
});

test('rejects maxBoostersPerCycle out of range', () => {
  assert.throws(() => assertOperatorConfiguration(validConfiguration({ maxBoostersPerCycle: 0, requestedOrders: 0 })), /maxBoostersPerCycle/);
  assert.throws(() => assertOperatorConfiguration(validConfiguration({ maxBoostersPerCycle: 1001 })), /maxBoostersPerCycle/);
});

test('rejects non-canonical or negative micro-USDG amounts', () => {
  for (const bad of ['-1', '01', '1.5', 'abc', '', ' 1']) {
    assert.throws(() => assertOperatorConfiguration(validConfiguration({ maxUnitPriceMicroUsdg: bad })), /maxUnitPriceMicroUsdg/);
  }
});

test('rejects a unit price above the cycle budget, and a cycle budget above the 24h budget', () => {
  assert.throws(
    () => assertOperatorConfiguration(validConfiguration({ maxUnitPriceMicroUsdg: '30000000', maxCycleBudgetMicroUsdg: '25000000' })),
    /maxUnitPriceMicroUsdg must not exceed maxCycleBudgetMicroUsdg/,
  );
  assert.throws(
    () => assertOperatorConfiguration(validConfiguration({ maxCycleBudgetMicroUsdg: '2000000000', max24HourBudgetMicroUsdg: '1000000000' })),
    /maxCycleBudgetMicroUsdg must not exceed max24HourBudgetMicroUsdg/,
  );
});

test('rejects non-boolean paused and liveMode', () => {
  assert.throws(() => assertOperatorConfiguration(validConfiguration({ paused: 'yes' })), /paused/);
  assert.throws(() => assertOperatorConfiguration(validConfiguration({ liveMode: 1 })), /liveMode/);
});

test('rejects a negative or non-integer configurationRevision', () => {
  assert.throws(() => assertOperatorConfiguration(validConfiguration({ configurationRevision: -1 })), /configurationRevision/);
  assert.throws(() => assertOperatorConfiguration(validConfiguration({ configurationRevision: 1.5 })), /configurationRevision/);
});

test('the default configuration is conservative: no packs, zero budget, dry-run, unpaused', () => {
  const config = createDefaultOperatorConfiguration();
  assert.equal(config.schema, 'hookemon.operator-configuration.v2');
  assert.equal(config.intervalMinutes, DEFAULT_INTERVAL_MINUTES);
  assert.equal(config.liveMode, DEFAULT_LIVE_MODE);
  assert.deepEqual(config.allowedPackIds, []);
  assert.equal(config.maxCycleBudgetMicroUsdg, '0');
  assert.equal(config.max24HourBudgetMicroUsdg, '0');
  assert.equal(config.paused, false);
  assert.equal(config.configurationRevision, 0);
});

test('the default configuration carries fail-closed policy controls and empty durable ledgers', () => {
  const config = createDefaultOperatorConfiguration();
  assert.equal(config.maxCyclesPerDay, 0);
  assert.equal(config.perCycleCapMicroUsdg, '0');
  assert.equal(config.lossCapMicroUsdg, '0');
  assert.equal(config.maxOutstandingCustodyMicroUsdg, '0');
  assert.equal(config.executionPaused, false);
  assert.equal(config.killSwitch, false);
  assert.equal(config.manualApprovalCycles, 0);
  assert.deepEqual(config.pendingEpicDecisions, []);
  assert.deepEqual(config.approvalsByCycleDigest, {});
  assert.deepEqual(config.spendLedger, []);
  assert.deepEqual(config.cycleLedger, []);
});

test('migrates the prior configuration shape with fail-closed new controls', () => {
  const base = validConfiguration();
  const legacy = Object.fromEntries([
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
  ].map(field => [field, base[field]]));

  const migration = migrateOperatorConfiguration(legacy);
  assert.equal(migration.migrated, true);
  assert.equal(migration.configuration.schema, 'hookemon.operator-configuration.v2');
  assert.equal(migration.configuration.maxCyclesPerDay, 0);
  assert.equal(migration.configuration.perCycleCapMicroUsdg, base.maxCycleBudgetMicroUsdg);
  assert.equal(migration.configuration.lossCapMicroUsdg, '0');
  assert.equal(migration.configuration.maxOutstandingCustodyMicroUsdg, '0');
  assert.equal(migration.configuration.executionPaused, true);
  assert.deepEqual(migration.configuration.spendLedger, []);
});

test('applyOperatorConfiguration bumps the revision by exactly one and starts from the default when null', () => {
  const first = applyOperatorConfiguration(null, {
    intervalMinutes: 30,
    allowedPackIds: ['base'],
    requestedOrders: 1,
    maxBoostersPerCycle: 1,
    maxUnitPriceMicroUsdg: '25000000',
    maxCycleBudgetMicroUsdg: '25000000',
    max24HourBudgetMicroUsdg: '1800000000',
    paused: false,
    liveMode: false,
  });
  assert.equal(first.configurationRevision, 1);
  assert.equal(first.intervalMinutes, 30);

  const {
    configurationRevision: _unused,
    pendingEpicDecisions: _pendingEpicDecisions,
    approvalsByCycleDigest: _approvalsByCycleDigest,
    spendLedger: _spendLedger,
    cycleLedger: _cycleLedger,
    ...firstWithoutRevision
  } = first;
  const second = applyOperatorConfiguration(first, { ...firstWithoutRevision, paused: true });
  assert.equal(second.configurationRevision, 2);
  assert.equal(second.paused, true);
});

test('applyOperatorConfiguration rejects a patch that tries to set configurationRevision directly', () => {
  assert.throws(
    () => applyOperatorConfiguration(null, { ...createDefaultOperatorConfiguration(), configurationRevision: 7 }),
    /must not set configurationRevision directly/,
  );
});

test('applyOperatorConfiguration rejects secret-material fields in the patch', () => {
  assert.throws(
    () => applyOperatorConfiguration(null, { ...createDefaultOperatorConfiguration(), mnemonic: 'obviously-fake-placeholder-value' }),
    /secret-material/,
  );
});

test('dashboard patches cannot rewrite durable policy ledgers and keep the two per-cycle caps aligned', () => {
  const current = createDefaultOperatorConfiguration();
  assert.throws(
    () => applyOperatorConfiguration(current, { spendLedger: [] }),
    /must not set spendLedger directly/,
  );
  const next = applyOperatorConfiguration(current, { maxCycleBudgetMicroUsdg: '7', max24HourBudgetMicroUsdg: '7' });
  assert.equal(next.maxCycleBudgetMicroUsdg, '7');
  assert.equal(next.perCycleCapMicroUsdg, '7');
});

test('assertOperatorConfiguration never mutates its input', () => {
  const input = validConfiguration();
  const frozenInputSnapshot = JSON.stringify(input);
  assertOperatorConfiguration(input);
  assert.equal(JSON.stringify(input), frozenInputSnapshot);
});
