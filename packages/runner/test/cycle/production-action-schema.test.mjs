import assert from 'node:assert/strict';
import test from 'node:test';

import { assertProductionAction } from '../../src/cycle/schemas.mjs';
import { productionCycleAction } from './production-cycle.mjs';

const PREFLIGHT_DIGEST = `sha256:${'a'.repeat(64)}`;

test('permits a zero production return floor and rejects it for every other action', () => {
  const returnAction = {
    ...productionCycleAction('return', 'cycle-production-return-floor', PREFLIGHT_DIGEST),
    minimumReceive: '0',
  };
  assert.deepEqual(assertProductionAction(returnAction), returnAction);

  const outboundAction = {
    ...productionCycleAction('outbound', 'cycle-production-outbound-floor', PREFLIGHT_DIGEST),
    minimumReceive: '0',
  };
  assert.throws(() => assertProductionAction(outboundAction), /minimumReceive.*invalid/);
  assert.throws(
    () => assertProductionAction({ ...returnAction, minimumReceive: '-1' }),
    /minimumReceive.*invalid/,
  );
});
