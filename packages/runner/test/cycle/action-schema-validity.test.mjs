import assert from 'node:assert/strict';
import test from 'node:test';

import { assertFixtureAction, assertProductionAction } from '../../src/cycle/schemas.mjs';
import { fixtureCycleAction } from './fixture-cycle.mjs';
import { productionCycleAction } from './production-cycle.mjs';

const PREFLIGHT_DIGEST = `sha256:${'a'.repeat(64)}`;

test('permits a fixture action at its last valid block height and rejects the next height', () => {
  const action = {
    ...fixtureCycleAction('outbound', 'cycle-fixture-validity-boundary', PREFLIGHT_DIGEST),
    validity: { recentBlockhash: 'aabb', currentHeight: '20', lastValidHeight: '20' },
  };

  assert.deepEqual(assertFixtureAction(action), action);
  assert.throws(
    () => assertFixtureAction({ ...action, validity: { ...action.validity, currentHeight: '21' } }),
    /fixture validity window is invalid/,
  );
});

test('permits a production action at its last valid block height and rejects the next height', () => {
  const action = {
    ...productionCycleAction('outbound', 'cycle-production-validity-boundary', PREFLIGHT_DIGEST),
    validity: { recentBlockhash: 'aabbcc', currentHeight: '20', lastValidHeight: '20' },
  };

  assert.deepEqual(assertProductionAction(action), action);
  assert.throws(
    () => assertProductionAction({ ...action, validity: { ...action.validity, currentHeight: '21' } }),
    /production validity window is invalid/,
  );
});
