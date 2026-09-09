import test from 'node:test';
import assert from 'node:assert/strict';
import { createDefaultOperatorConfiguration, applyOperatorConfiguration, migrateOperatorConfiguration } from '../../src/config/state-schema.mjs';

test('recipient control accepts every option, preserves revisions and rejects coercion', () => {
  const initial = createDefaultOperatorConfiguration();
  assert.equal(initial.schema, 'hookemon.operator-configuration.v6');
  assert.equal(initial.rewardRecipientLimit, 200);
  for (let limit = 100; limit <= 1000; limit += 100) {
    const next = applyOperatorConfiguration(initial, { rewardRecipientLimit: limit });
    assert.equal(next.rewardRecipientLimit, limit);
    assert.equal(next.configurationRevision, initial.configurationRevision + 1);
  }
  for (const value of [null, '200', true, 0, 99, 150, 1001, 200.5, NaN, Infinity]) {
    assert.throws(() => applyOperatorConfiguration(initial, { rewardRecipientLimit: value }));
    assert.equal(initial.rewardRecipientLimit, 200);
  }
});

test('native migrations default future selection while preserving safety and pack revision', () => {
  const configured = applyOperatorConfiguration(createDefaultOperatorConfiguration(), { packPlan: { orders: [{ pack: 'alpha', quantity: 2 }] }, paused: true, executionPaused: true });
  const { rewardRecipientLimit, ...v5 } = configured;
  v5.schema = 'hookemon.operator-configuration.v5';
  assert.deepEqual(migrateOperatorConfiguration(v5), { configuration: configured, migrated: true });
  const { packPlan, ...v4 } = v5;
  v4.schema = 'hookemon.operator-configuration.v4';
  const result = migrateOperatorConfiguration(v4).configuration;
  assert.equal(result.configurationRevision, configured.configurationRevision);
  assert.equal(result.rewardRecipientLimit, 200);
  assert.equal(result.paused, true);
  assert.deepEqual(result.packPlan.orders, []);
  assert.throws(() => migrateOperatorConfiguration({ ...v5, unexpected: 1 }));
  for (const version of [1, 2, 3]) assert.throws(() => migrateOperatorConfiguration({ ...v5, schema: `hookemon.operator-configuration.v${version}` }));
});
