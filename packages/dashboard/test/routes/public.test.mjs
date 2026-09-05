import assert from 'node:assert/strict';
import test from 'node:test';

import { createCycleStatusHandler } from '../../src/routes/public.mjs';

async function request(handler) {
  let status = null;
  const chunks = [];
  await handler(
    { method: 'GET', url: '/public/api/cycle-status' },
    {
      writeHead(nextStatus) { status = nextStatus; },
      end(chunk) { if (chunk) chunks.push(Buffer.from(chunk)); },
    },
  );
  return { status, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) };
}

test('public cycle status reports a held terminal state instead of an earlier completed stage', async () => {
  const handler = createCycleStatusHandler({
    profileId: 'mainnet',
    now: () => Date.UTC(2026, 0, 1),
    operatorControl: {
      async status() {
        return {
          configuration: { intervalMinutes: 20, maxBoostersPerCycle: 1, paused: false, executionPaused: false, killSwitch: false },
          activeCycleId: 'cycle-held',
          cycles: [{
            cycleId: 'cycle-held',
            terminalState: 'HELD_OWNER_DECISION',
            stages: [{ stage: 'purchase', status: 'COMPLETE' }],
          }],
        };
      },
    },
  });

  const result = await request(handler);

  assert.equal(result.status, 200);
  assert.equal(result.body.cycle.status, 'HELD_OWNER_DECISION');
});
