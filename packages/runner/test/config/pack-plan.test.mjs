import test from 'node:test';
import assert from 'node:assert/strict';
import { PACK_PLAN_SCHEMA, assertPackPlan, createEmptyPackPlan, replacePackPlan, packPlanFromSelection } from '../../src/config/pack-plan.mjs';

const plan = orders => ({ schema: PACK_PLAN_SCHEMA, revision: 0, orders });

test('empty plan has no admission orders or invented money amounts', () => {
  assert.deepEqual(createEmptyPackPlan(), plan([]));
});

test('selection is canonical and preserves explicit quantities until edited', () => {
  const first = replacePackPlan(createEmptyPackPlan(), [{ pack: 'alpha', quantity: 2 }]);
  const next = packPlanFromSelection(['beta', 'alpha', 'beta'], first);
  assert.deepEqual(next.orders, [{ pack: 'alpha', quantity: 2 }, { pack: 'beta', quantity: 1 }]);
  assert.equal(next.revision, 2);
  assert.deepEqual(first.orders, [{ pack: 'alpha', quantity: 2 }]);
  assert.equal(packPlanFromSelection(['alpha', 'beta'], next).revision, 2);
  assert.deepEqual(packPlanFromSelection([], next), { ...plan([]), revision: 3 });
});

test('validated plans are detached immutable cycle snapshots', () => {
  const input = plan([{ pack: 'alpha', quantity: 1 }]);
  const snapshot = assertPackPlan(input);
  input.orders[0].quantity = 8;
  assert.equal(snapshot.orders[0].quantity, 1);
  assert.throws(() => { snapshot.orders[0].quantity = 3; }, TypeError);
  assert.throws(() => snapshot.orders.push({ pack: 'beta', quantity: 1 }), TypeError);
});

test('rejects malformed quantities, codes, duplicate orders, and oversized totals', () => {
  for (const quantity of [0, -1, 1.5, '1', 1001, NaN]) {
    assert.throws(() => assertPackPlan(plan([{ pack: 'alpha', quantity }])));
  }
  for (const orders of [
    [{ pack: 'alpha', quantity: 1 }, { pack: 'alpha', quantity: 1 }],
    [{ pack: 'beta', quantity: 1 }, { pack: 'alpha', quantity: 1 }],
    [{ pack: 'alpha', quantity: 40 }, { pack: 'beta', quantity: 25 }],
    [{ pack: 'A', quantity: 1 }],
    [{ pack: 'alpha', quantity: 1, privateKey: 'not-a-key' }],
  ]) assert.throws(() => assertPackPlan(plan(orders)));
  assert.equal(assertPackPlan(plan([{ pack: 'alpha', quantity: 64 }])).orders[0].quantity, 64);
});

test('rejects revision tampering shapes and overflow', () => {
  for (const revision of [-1, '0', 0.1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => assertPackPlan({ ...plan([]), revision }));
  }
  assert.throws(() => assertPackPlan({ ...plan([]), amount: '100' }));
  assert.throws(() => replacePackPlan({ ...plan([]), revision: Number.MAX_SAFE_INTEGER }, [{ pack: 'alpha', quantity: 1 }]));
});
