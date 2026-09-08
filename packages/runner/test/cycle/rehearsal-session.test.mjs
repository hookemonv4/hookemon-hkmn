import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  openOrCreateRehearsalSession,
  readRehearsalSession,
  recordRehearsalSessionCompletion,
  recordRehearsalSessionRestart,
} from '../../src/cycle/rehearsal-session.mjs';

test('a rehearsal restart session persists its cap, completed cycles, and restart count', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hookemon-rehearsal-session-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const input = { stateDir, cycles: 2, capMicroUsd: '30', collectorOnly: true };
  const first = await openOrCreateRehearsalSession(input);
  const resumed = await openOrCreateRehearsalSession(input);
  assert.equal(resumed.path, first.path);

  await recordRehearsalSessionRestart({ path: first.path });
  await recordRehearsalSessionCompletion({
    path: first.path,
    cycleId: 'cycle-rehearsal-one',
    evidencePath: join(stateDir, 'rehearsal-evidence', 'cycle-rehearsal-one.json'),
  });
  assert.deepEqual(await readRehearsalSession({ path: first.path }), {
    schema: 'hookemon.rehearsal-session.v2',
    sessionId: first.session.sessionId,
    state: 'RUNNING',
    cycles: 2,
    capMicroUsd: '30',
    collectorOnly: true,
    restartCount: 1,
    completed: [{
      cycleId: 'cycle-rehearsal-one',
      evidencePath: join(stateDir, 'rehearsal-evidence', 'cycle-rehearsal-one.json'),
    }],
  });

  await recordRehearsalSessionCompletion({
    path: first.path,
    cycleId: 'cycle-rehearsal-two',
    evidencePath: join(stateDir, 'rehearsal-evidence', 'cycle-rehearsal-two.json'),
  });
  assert.equal((await readRehearsalSession({ path: first.path })).state, 'COMPLETE');
});

test('a restart invocation refuses to reuse a session with a different cap or collector boundary', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hookemon-rehearsal-session-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  await openOrCreateRehearsalSession({ stateDir, cycles: 2, capMicroUsd: '30', collectorOnly: true });
  await assert.rejects(
    () => openOrCreateRehearsalSession({ stateDir, cycles: 2, capMicroUsd: '31', collectorOnly: true }),
    /active rehearsal session does not match the requested run/, 
  );
});

test('historical USDG rehearsal sessions remain readable and cannot resume as native USD budgets', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hookemon-history-session-')); t.after(() => rm(stateDir, { recursive: true, force: true }));
  const current = await openOrCreateRehearsalSession({ stateDir, cycles: 1, capMicroUsd: '30', collectorOnly: true });
  const historical = { ...current.session, schema: 'hookemon.rehearsal-session.v1', capUsdg: '30' }; delete historical.capMicroUsd;
  await writeFile(current.path, JSON.stringify(historical));
  assert.deepEqual(await readRehearsalSession({ path: current.path }), historical);
  await assert.rejects(recordRehearsalSessionRestart({ path: current.path }), /historical rehearsal session/);
  await assert.rejects(openOrCreateRehearsalSession({ stateDir, cycles: 1, capMicroUsd: '30', collectorOnly: true }), /historical rehearsal session/);
  assert.deepEqual(await readRehearsalSession({ path: current.path }), historical);
});
