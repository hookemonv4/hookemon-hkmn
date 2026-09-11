import test from 'node:test';
import assert from 'node:assert/strict';
import { runCli } from '../../bin/hookemon-runner.mjs';

test('manual-start production opens control without starting automatic admission', async () => {
  let starts = 0, recoveries = 0, composed;
  await runCli(['run', '--mode', 'production', '--manual-start'], { buildComposition: async input => {
    composed = input;
    return { dashboard: null, scheduler: { start() { starts += 1; }, settled: async () => {} },
      manualCycleControl: { async recover() { recoveries += 1; setImmediate(() => process.emit('SIGTERM')); } },
      shutdown: async () => {} };
  } });
  assert.equal(composed.manualStart, true); assert.equal(composed.withDashboard, true);
  assert.equal(starts, 0); assert.equal(recoveries, 1);
});

test('manual-start rejects rehearsal and disabled dashboard before composing signers', async () => {
  const options = { buildComposition: async () => { throw new Error('must not compose'); } };
  await assert.rejects(runCli(['run', '--mode', 'rehearsal', '--manual-start'], options), /requires production mode with the dashboard/);
  await assert.rejects(runCli(['run', '--mode', 'production', '--manual-start', '--no-dashboard'], options), /requires production mode with the dashboard/);
});
