import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createDefaultOperatorConfiguration } from '../../src/config/state-schema.mjs';
import { canonicalJson } from '../../src/cycle/journal.mjs';

const stateFileUrl = new URL('../../src/operator/state-file.mjs', import.meta.url);

async function stateFile() {
  return import(stateFileUrl.href);
}

async function temporaryState(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-operator-state-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, statePath: join(directory, 'operator-state.json') };
}

function legacyState(configuration = null) {
  return {
    schema: 'hookemon.operator-state.v1',
    revision: 7,
    packSnapshot: null,
    draft: null,
    frozenPlan: null,
    frozenBinding: null,
    cycleEscrowObservation: null,
    activeCycleId: null,
    terminalCycles: [],
    cycleStore: {
      schema: 'hookemon.fixture-cycle-store.v1',
      cycles: [],
      authorizations: [],
      receipts: [],
    },
    configuration,
  };
}

test('state-file source has no legacy cycle-store ownership', async () => {
  const source = await readFile(stateFileUrl, 'utf8');
  assert.doesNotMatch(source, /FixtureCycleStore|CycleRunner/);
  assert.doesNotMatch(source, /activeCycleId|terminalCycles/);
  assert.doesNotMatch(source, /createFrozenCycleControl|assertFrozenCyclePlan|assertCycleDraft/);
});

test('migrates an empty legacy state to a configuration-only record', async t => {
  const { statePath } = await temporaryState(t);
  await writeFile(statePath, `${canonicalJson(legacyState())}\n`, { mode: 0o600 });

  const { readOperatorState } = await stateFile();
  const migrated = await readOperatorState(statePath);

  assert.deepEqual(migrated, {
    schema: 'hookemon.operator-state.v2',
    revision: 8,
    configuration: null,
  });
  assert.equal(await readFile(statePath, 'utf8'), `${canonicalJson(migrated)}\n`);
});

test('refuses a nonempty legacy state instead of discarding cycle records', async t => {
  const { statePath } = await temporaryState(t);
  const legacy = legacyState();
  legacy.cycleStore.cycles.push({ cycleId: 'cycle-kept-for-recovery' });
  await writeFile(statePath, `${canonicalJson(legacy)}\n`, { mode: 0o600 });

  const { readOperatorState } = await stateFile();
  await assert.rejects(readOperatorState(statePath), /legacy operator state.*nonempty/i);
  assert.equal(await readFile(statePath, 'utf8'), `${canonicalJson(legacy)}\n`);
});

test('persists only configuration with canonical bytes and revision CAS', async t => {
  const { statePath } = await temporaryState(t);
  const { createEmptyOperatorState, mutateOperatorState, readOperatorState } = await stateFile();

  const initial = await mutateOperatorState(statePath, null, () => createEmptyOperatorState());
  assert.deepEqual(initial, {
    schema: 'hookemon.operator-state.v2',
    revision: 0,
    configuration: null,
  });
  assert.equal(await readFile(statePath, 'utf8'), `${canonicalJson(initial)}\n`);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);

  const next = await mutateOperatorState(statePath, 0, state => ({
    ...state,
    configuration: null,
  }));
  assert.equal(next.revision, 1);
  assert.deepEqual(await readOperatorState(statePath), next);
  await assert.rejects(
    mutateOperatorState(statePath, 0, state => state),
    /stale operator state revision/i,
  );
  await assert.rejects(
    mutateOperatorState(statePath, 1, state => ({ ...state, unexpected: true })),
    /exact schema/i,
  );
});

test('rejects permissive configuration-only state files', async t => {
  const { statePath } = await temporaryState(t);
  const { createEmptyOperatorState, readOperatorState } = await stateFile();
  await writeFile(statePath, `${canonicalJson(createEmptyOperatorState())}\n`, { mode: 0o600 });
  await chmod(statePath, 0o644);
  await assert.rejects(readOperatorState(statePath), /mode|permission/i);
});

test('refuses a persisted configuration above the fixed operator ceilings at startup', async t => {
  const { statePath } = await temporaryState(t);
  const configuration = {
    ...createDefaultOperatorConfiguration(),
    maxUnitPriceMicroUsdg: '25000001',
    maxCycleBudgetMicroUsdg: '50000001',
    max24HourBudgetMicroUsdg: '3600000001',
    perCycleCapMicroUsdg: '50000001',
  };
  await writeFile(statePath, `${canonicalJson({
    schema: 'hookemon.operator-state.v2',
    revision: 0,
    configuration,
  })}\n`, { mode: 0o600 });

  const { readOperatorState } = await stateFile();
  await assert.rejects(readOperatorState(statePath), /fixed hard cap/i);
});
