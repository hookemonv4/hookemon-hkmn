import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { DurableCycleStore } from '../../../runner/src/cycle/durable-store.mjs';
import { CycleJournal } from '../../../runner/src/cycle/journal.mjs';
import { createPackPlanSnapshot } from '../../../runner/src/automation/pack-plan-snapshot.mjs';

const plan = () => ({ schema: 'hookemon.pack-plan.v1', revision: 1, orders: [{ pack: 'pack-a', quantity: 2 }] });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-plan-snapshot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, repository: await CycleRepository.open(directory, () => 1000) };
}
async function append(directory, cycleId, kind, payload) {
  const store = await DurableCycleStore.open(directory);
  const stored = store.readCycle(cycleId);
  const entry = new CycleJournal(cycleId, stored?.entries ?? []).propose(kind, payload);
  const transaction = store.begin(cycleId, { expectedVersion: stored?.version ?? 0, expectedJournalHead: stored?.journalHead ?? null });
  transaction.stageEvent(entry);
  await store.commit(transaction);
}

test('initial event persists exact snapshot across input edits and repository restart', async t => {
  const { directory, repository } = await fixture(t);
  const selected = plan();
  const opened = await repository.createCycle({ cycleId: 'cycle-plan-1', releaseAmount: '1', mode: 'rehearsal', packPlan: selected });
  const expected = createPackPlanSnapshot({ cycleId: opened.cycleId, plan: selected });
  selected.revision = 2;
  selected.orders[0].quantity = 5;
  assert.deepEqual(opened.packPlanSnapshot, expected);
  assert.deepEqual((await repository.describeCycle(opened.cycleId)).packPlanSnapshot, expected);
  const reopened = await CycleRepository.open(directory, () => 2000);
  assert.deepEqual((await reopened.readActiveCycle()).packPlanSnapshot, expected);
  assert.deepEqual((await reopened.describeCycle(opened.cycleId)).packPlanSnapshot, expected);
  await assert.rejects(reopened.createCycle({ cycleId: opened.cycleId, releaseAmount: '1', mode: 'rehearsal', packPlan: selected }), /already active/);
  assert.equal(typeof reopened.setPackPlanSnapshot, 'undefined');
  assert.deepEqual((await reopened.readActiveCycle()).packPlanSnapshot, expected);
});

test('legacy cycle remains without a fabricated snapshot and explicit invalid plan creates no cycle', async t => {
  const { repository } = await fixture(t);
  await assert.rejects(repository.createCycle({ releaseAmount: '1', mode: 'rehearsal', packPlan: null }), /exact schema/);
  assert.equal(await repository.readActiveCycle(), null);
  const opened = await repository.createCycle({ releaseAmount: '1', mode: 'rehearsal' });
  assert.equal(Object.hasOwn(opened, 'packPlanSnapshot'), false);
  assert.equal((await repository.describeCycle(opened.cycleId)).packPlanSnapshot, null);
  assert.equal(Object.hasOwn(await repository.readActiveCycle(), 'packPlanSnapshot'), false);
});

for (const corruption of ['digest', 'cycle']) {
  test(`replay refuses a stored snapshot with invalid ${corruption}`, async t => {
    const { directory } = await fixture(t);
    const cycleId = 'cycle-corrupt-1';
    const snapshot = { ...createPackPlanSnapshot({ cycleId: corruption === 'cycle' ? 'cycle-other' : cycleId, plan: plan() }) };
    if (corruption === 'digest') snapshot.digest = `sha256:${'0'.repeat(64)}`;
    await append(directory, cycleId, 'cycle-opened', { releaseAmount: '1', mode: 'rehearsal', openedAtMs: 1000, packPlanSnapshot: snapshot });
    const reopened = await CycleRepository.open(directory, () => 2000);
    await assert.rejects(reopened.describeCycle(cycleId), /snapshot.*mismatch/);
  });
}

test('replay rejects a second opening that attempts to replace the bound plan', async t => {
  const { directory, repository } = await fixture(t);
  const opened = await repository.createCycle({ releaseAmount: '1', mode: 'rehearsal', packPlan: plan() });
  await append(directory, opened.cycleId, 'cycle-opened', { releaseAmount: '1', mode: 'rehearsal', openedAtMs: 1001, packPlanSnapshot: createPackPlanSnapshot({ cycleId: opened.cycleId, plan: { ...plan(), revision: 2 } }) });
  const reopened = await CycleRepository.open(directory, () => 2000);
  await assert.rejects(reopened.describeCycle(opened.cycleId), /second cycle-opened/);
});
