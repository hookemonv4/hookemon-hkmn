import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRewardSelectionSnapshot } from '../../../runner/src/automation/reward-selection-snapshot.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { DurableCycleStore } from '../../../runner/src/cycle/durable-store.mjs';
import { CycleJournal } from '../../../runner/src/cycle/journal.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'reward-selection-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, repository: await CycleRepository.open(directory, () => 1000) };
}
async function append(directory, cycleId, kind, payload) {
  const store = await DurableCycleStore.open(directory);
  const stored = store.readCycle(cycleId);
  const entry = new CycleJournal(cycleId, stored?.entries ?? []).propose(kind, payload);
  const tx = store.begin(cycleId, { expectedVersion: stored?.version ?? 0, expectedJournalHead: stored?.journalHead ?? null });
  tx.stageEvent(entry); await store.commit(tx);
}
for (const rewardRecipientLimit of [100,200,300,400,500,600,700,800,900,1000]) {
  test(`freezes ${rewardRecipientLimit} in the first cycle event across restart`, async t => {
    const { directory, repository } = await fixture(t);
    const opened = await repository.createCycle({ cycleId: 'cycle-reward-1', releaseAmount: '1', mode: 'rehearsal', rewardRecipientLimit, configurationRevision: 7 });
    assert.equal(opened.rewardSelection.rewardRecipientLimit, rewardRecipientLimit);
    assert.equal(opened.rewardSelection.configurationRevision, 7);
    assert.equal(opened.rewardSelection.cycleId, opened.cycleId);
    const saved = structuredClone(opened.rewardSelection);
    opened.rewardSelection.rewardRecipientLimit = rewardRecipientLimit === 100 ? 200 : 100;
    const restarted = await CycleRepository.open(directory, () => 2000);
    assert.deepEqual((await restarted.readActiveCycle()).rewardSelection, saved);
    assert.deepEqual((await restarted.describeCycle(opened.cycleId)).rewardSelection, saved);
  });
}
test('legacy absence stays absent and invalid settings create no journal', async t => {
  const { repository } = await fixture(t);
  for (const value of [null,0,50,99,101,150,1100,'200',200.5]) {
    await assert.rejects(repository.createCycle({ releaseAmount: '1', mode: 'rehearsal', rewardRecipientLimit: value, configurationRevision: 1 }));
    assert.equal(await repository.readActiveCycle(), null);
  }
  const opened = await repository.createCycle({ releaseAmount: '1', mode: 'rehearsal' });
  assert.equal(Object.hasOwn(opened, 'rewardSelection'), false);
  assert.equal(Object.hasOwn(await repository.readActiveCycle(), 'rewardSelection'), false);
  assert.equal((await repository.describeCycle(opened.cycleId)).rewardSelection, null);
});
for (const fault of ['digest','cycle']) {
  test(`refuses corrupted frozen selection ${fault} on replay`, async t => {
    const { directory } = await fixture(t);
    const cycleId = 'cycle-invalid-reward';
    const body = { schema: 'hookemon.reward-selection-snapshot.v1', cycleId: fault === 'cycle' ? 'other-cycle' : cycleId, configurationRevision: 1, rewardRecipientLimit: 200 };
    const { schema, ...input } = body;
    const rewardSelection = { ...createRewardSelectionSnapshot(input) };
    if (fault === 'digest') rewardSelection.digest = `sha256:${'0'.repeat(64)}`;
    await append(directory, cycleId, 'cycle-opened', { releaseAmount: '1', mode: 'rehearsal', openedAtMs: 1000, rewardSelection });
    const restarted = await CycleRepository.open(directory, () => 2000);
    await assert.rejects(restarted.describeCycle(cycleId), /mismatch|invalid/);
  });
}
