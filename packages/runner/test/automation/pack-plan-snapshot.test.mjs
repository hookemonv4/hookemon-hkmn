import assert from 'node:assert/strict';
import test from 'node:test';
import { createPackPlanSnapshot, assertPackPlanSnapshot } from '../../src/automation/pack-plan-snapshot.mjs';

const plan = () => ({ schema: 'hookemon.pack-plan.v1', revision: 2, orders: [{ pack: 'pack-a', quantity: 2 }, { pack: 'pack-b', quantity: 1 }] });

test('snapshot binds identity and exact plan revision with detached frozen orders', () => {
  const source = plan();
  const snapshot = createPackPlanSnapshot({ cycleId: 'cycle-1', plan: source });
  source.orders[0].quantity = 4;
  assert.equal(snapshot.plan.orders[0].quantity, 2);
  assert.ok(Object.isFrozen(snapshot));
  assert.ok(Object.isFrozen(snapshot.plan.orders[0]));
  assert.deepEqual(assertPackPlanSnapshot(JSON.parse(JSON.stringify(snapshot)), { cycleId: 'cycle-1' }), snapshot);
  for (const changed of [{ ...plan(), revision: 3 }, { ...plan(), orders: [{ pack: 'pack-c', quantity: 1 }] }]) {
    assert.notEqual(createPackPlanSnapshot({ cycleId: 'cycle-1', plan: changed }).digest, snapshot.digest);
  }
  assert.notEqual(createPackPlanSnapshot({ cycleId: 'cycle-2', plan: plan() }).digest, snapshot.digest);
});

test('snapshot refuses corruption, unexpected fields and wrong cycle binding', () => {
  const snapshot = createPackPlanSnapshot({ cycleId: 'cycle-1', plan: plan() });
  assert.throws(() => assertPackPlanSnapshot({ ...snapshot, digest: `sha256:${'0'.repeat(64)}` }), /digest mismatch/);
  assert.throws(() => assertPackPlanSnapshot(snapshot, { cycleId: 'cycle-2' }), /cycleId mismatch/);
  assert.throws(() => assertPackPlanSnapshot({ ...snapshot, schema: 'unknown' }), /schema/);
  assert.throws(() => assertPackPlanSnapshot({ ...snapshot, extra: true }), /exact schema/);
  assert.throws(() => createPackPlanSnapshot({ cycleId: '../escape', plan: plan() }), /cycleId/);
  assert.throws(() => createPackPlanSnapshot({ cycleId: 'cycle-1', plan: null }), /exact schema/);
});
