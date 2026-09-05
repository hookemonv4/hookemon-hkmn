import assert from 'node:assert/strict';

import { CycleRunner } from './cycle-runner.mjs';
import { FixtureCycleStore } from './cycle-store.mjs';
import { executeCompleteFixtureCycle } from '../../test/cycle/fixture-cycle.mjs';

const cycleId = 'fixture-cycle';
const cycleStore = new FixtureCycleStore();
const runner = new CycleRunner(cycleId, [], { cycleStore });

executeCompleteFixtureCycle(runner, cycleId);
runner.close();
assert.equal(runner.state.stage, 'closed');

const persistedSnapshot = JSON.parse(JSON.stringify(cycleStore.snapshot));
const reopenedStore = FixtureCycleStore.reopen(persistedSnapshot);
const persistedEntries = reopenedStore.readCycle(cycleId).entries;
assert.deepEqual(
  persistedEntries.filter(entry => entry.kind === 'external-mutation-attempted').map(entry => entry.payload.actionKind),
  ['collector-generate', 'outbound', 'purchase', 'collector-open', 'buyback', 'return'],
);
assert.equal(persistedEntries.filter(entry => entry.kind === 'external-mutation-reconciled').length, 6);
const recovered = CycleRunner.recover(cycleId, persistedEntries, { cycleStore: reopenedStore });

assert.equal(recovered.state.stage, 'closed');
assert.equal(recovered.state.version, 6);
assert.deepEqual(reopenedStore.snapshot, persistedSnapshot);
console.log('fixture verification passed: closed CycleRunner recovered durably');
