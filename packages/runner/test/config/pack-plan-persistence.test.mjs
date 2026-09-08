import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { applyOperatorConfiguration, createDefaultOperatorConfiguration, migrateOperatorConfiguration, assertOperatorConfiguration } from '../../src/config/state-schema.mjs';
import { readOperatorState, mutateOperatorState } from '../../src/operator/state-file.mjs';
import { canonicalJson } from '../../src/cycle/journal.mjs';

function legacyConfiguration() {
  const { packPlan, ...current } = createDefaultOperatorConfiguration();
  return { ...current, schema: 'hookemon.operator-configuration.v4', allowedPackIds: ['alpha', 'beta'], requestedOrders: 2, maxBoostersPerCycle: 3, maxUnitPriceMicroUsd: '100', maxCycleBudgetMicroUsd: '200', perCycleCapMicroUsd: '200', max24HourBudgetMicroUsd: '400', configurationRevision: 12 };
}

async function stateFile(t, configuration = legacyConfiguration()) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-pack-plan-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'operator.json');
  await writeFile(path, `${canonicalJson({ schema: 'hookemon.operator-state.v2', revision: 7, configuration })}\n`, { mode: 0o600 });
  return path;
}

test('v4 migration preserves every prior value and never promotes an allowlist into a plan', () => {
  const legacy = legacyConfiguration();
  const migrated = migrateOperatorConfiguration(legacy);
  assert.equal(migrated.migrated, true);
  const { packPlan, schema, ...fields } = migrated.configuration;
  const { schema: oldSchema, ...oldFields } = legacy;
  assert.deepEqual(fields, oldFields);
  assert.equal(schema, 'hookemon.operator-configuration.v5');
  assert.deepEqual(packPlan, { schema: 'hookemon.pack-plan.v1', revision: 0, orders: [] });
  assert.equal(migrateOperatorConfiguration(migrated.configuration).migrated, false);
  assert.throws(() => assertOperatorConfiguration(legacy), /exact schema/);
});

test('legacy migration refuses malformed fields and unexpected plan or secret injection', () => {
  for (const patch of [{ maxBoostersPerCycle: -1 }, { packPlan: { orders: [] } }, { privateKey: 'not-a-key' }]) {
    assert.throws(() => migrateOperatorConfiguration({ ...legacyConfiguration(), ...patch }));
  }
  const { cycleLedger, ...missing } = legacyConfiguration();
  assert.throws(() => migrateOperatorConfiguration(missing), /exact schema/);
});

test('existing atomic state authority persists migration once and survives a fresh process read', async t => {
  const path = await stateFile(t);
  const migrated = await readOperatorState(path);
  assert.equal(migrated.revision, 8);
  assert.equal(migrated.configuration.configurationRevision, 12);
  assert.deepEqual(migrated.configuration.packPlan.orders, []);
  const bytes = await readFile(path, 'utf8');
  assert.equal(bytes, `${canonicalJson(migrated)}\n`);
  const script = `import { readOperatorState } from ${JSON.stringify(new URL('../../src/operator/state-file.mjs', import.meta.url).href)}; console.log(JSON.stringify(await readOperatorState(process.argv[1])));`;
  const restarted = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, path], { encoding: 'utf8' }));
  assert.deepEqual(restarted, migrated);
  assert.equal(await readFile(path, 'utf8'), bytes);
});

test('saved plan persists after restart, repeats unchanged, and edits preserve the old snapshot', async t => {
  const path = await stateFile(t, createDefaultOperatorConfiguration());
  const saved = await mutateOperatorState(path, 7, current => ({ ...current, configuration: applyOperatorConfiguration(current.configuration, { packPlan: { orders: [{ pack: 'alpha', quantity: 2 }, { pack: 'beta', quantity: 1 }] } }) }));
  const snapshot = saved.configuration.packPlan;
  for (let index = 0; index < 3; index += 1) assert.deepEqual((await readOperatorState(path)).configuration.packPlan, snapshot);
  const revised = await mutateOperatorState(path, saved.revision, current => ({ ...current, configuration: applyOperatorConfiguration(current.configuration, { packPlan: { orders: [{ pack: 'alpha', quantity: 2 }, { pack: 'gamma', quantity: 1 }] } }) }));
  assert.equal(revised.configuration.packPlan.revision, 2);
  assert.deepEqual(snapshot.orders, [{ pack: 'alpha', quantity: 2 }, { pack: 'beta', quantity: 1 }]);
  const script = `import { readOperatorState } from ${JSON.stringify(new URL('../../src/operator/state-file.mjs', import.meta.url).href)}; console.log(JSON.stringify((await readOperatorState(process.argv[1])).configuration.packPlan));`;
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, path], { encoding: 'utf8' })), revised.configuration.packPlan);
  await assert.rejects(mutateOperatorState(path, saved.revision, current => ({ ...current, configuration: applyOperatorConfiguration(current.configuration, { packPlan: { orders: [] } }) })), /stale operator state revision/);
  assert.deepEqual((await readOperatorState(path)).configuration.packPlan, revised.configuration.packPlan);
});

test('plan revisions are server-owned and unchanged replacements preserve retry postconditions', () => {
  const patch = { packPlan: { orders: [{ pack: 'alpha', quantity: 1 }] } };
  const first = applyOperatorConfiguration(null, patch);
  const retry = applyOperatorConfiguration(first, patch);
  const { configurationRevision: firstRevision, ...firstFields } = first;
  const { configurationRevision: retryRevision, ...retryFields } = retry;
  assert.deepEqual(firstFields, retryFields);
  assert.equal(retryRevision, firstRevision + 1);
  assert.equal(applyOperatorConfiguration(first, { paused: true }).packPlan.revision, 1);
  assert.throws(() => applyOperatorConfiguration(first, { packPlan: { ...patch.packPlan, revision: 9 } }), /exact schema/);
  assert.throws(() => applyOperatorConfiguration(first, { packPlan: first.packPlan }), /exact schema/);
  assert.deepEqual(applyOperatorConfiguration(first, { packPlan: { orders: [] } }).packPlan.orders, []);
});
