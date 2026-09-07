import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DurableCycleStore } from '../../../runner/src/cycle/durable-store.mjs';
import { CycleJournal } from '../../../runner/src/cycle/journal.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { walletNonceLeaseWindow, resolveWalletNonceReservation } from '../../src/app/wallet-nonce-lease.mjs';

const FIRST = '12345678-1234-4123-8123-123456789abc';
const NEXT = '22345678-1234-4123-8123-123456789abc';
async function reservation(context, repository, options) {
  return resolveWalletNonceReservation(repository, context.cycleId, { chainId: '4663', wallet: '0x00000000000000000000000000000000000000aa',
    stage: context.stage, fencingToken: context.fencingToken,
    ...walletNonceLeaseWindow(context, 'heartbeat regression') }, options);
}
async function fixture(t, stage) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-nonce-heartbeat-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let now = 1_000;
  const repository = await CycleRepository.open(directory, () => now);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  const context = { cycleId, stage, fencingToken: FIRST, lease: { acquiredAt: 1_000, expiresAt: 2_000 } };
  return { repository, context, directory, setNow(value) { now = value; }, now: () => now };
}
for (const stage of ['claim-process', 'outbound', 'payout']) {
  test(`${stage} retains its exact durable nonce reservation across a live heartbeat`, async t => {
    const { repository, context, directory, now } = await fixture(t, stage);
    await repository.reserveWalletNonce(context.cycleId, await reservation(context, repository));
    context.lease.expiresAt = 3_000;
    await repository.assertWalletNonce(context.cycleId, await reservation(context, repository));
    const reopened = await CycleRepository.open(directory, now);
    await reopened.assertWalletNonce(context.cycleId, await reservation(structuredClone(context), reopened));
    await reopened.releaseWalletNonce(context.cycleId, await reservation(context, repository, { release: true }));
  });
}
test('a heartbeat cannot revive the original nonce expiry or let its release erase a newer fence', async t => {
  const { repository, context, setNow } = await fixture(t, 'payout');
  const original = await reservation(context, repository);
  await repository.reserveWalletNonce(context.cycleId, original);
  context.lease.expiresAt = 4_000;
  setNow(2_001);
  await assert.rejects(async () => repository.assertWalletNonce(context.cycleId, await reservation(context, repository)), /expired/);
  const successor = { ...context, fencingToken: NEXT, lease: { acquiredAt: 2_001, expiresAt: 4_000 } };
  await repository.reserveWalletNonce(context.cycleId, await reservation(successor, repository));
  await assert.rejects(async () => repository.releaseWalletNonce(context.cycleId, await reservation(context, repository, { release: true })), /stale/);
  await repository.assertWalletNonce(context.cycleId, await reservation(successor, repository));
});

test('same-fence acquisition drift and a shorter context lease cannot inherit the durable reservation', async t => {
  const { repository, context } = await fixture(t, 'payout');
  await repository.reserveWalletNonce(context.cycleId, await reservation(context, repository));
  for (const lease of [{ acquiredAt: 1_001, expiresAt: 3_000 }, { acquiredAt: 1_000, expiresAt: 1_999 }]) {
    const changed = { ...context, lease };
    await assert.rejects(async () => repository.assertWalletNonce(context.cycleId, await reservation(changed, repository)), /stale/);
  }
});

test('an expired original-cycle release cannot erase another cycle takeover', async t => {
  const { repository, context, directory, setNow } = await fixture(t, 'payout');
  await repository.reserveWalletNonce(context.cycleId, await reservation(context, repository));
  const otherCycle = 'cycle-new-wallet-owner';
  const store = await DurableCycleStore.open(directory);
  const empty = store.readCycle(otherCycle);
  const transaction = store.begin(otherCycle, { expectedVersion: empty.version, expectedJournalHead: empty.journalHead });
  transaction.stageEvent(new CycleJournal(otherCycle, empty.entries).propose('cycle-opened', { releaseAmount: '2', openedAtMs: 1 }));
  await store.commit(transaction);
  setNow(2_001);
  const successor = { cycleId: otherCycle, stage: 'payout', fencingToken: NEXT, lease: { acquiredAt: 2_001, expiresAt: 4_000 } };
  await repository.reserveWalletNonce(otherCycle, await reservation(successor, repository));
  await assert.rejects(async () => repository.releaseWalletNonce(context.cycleId, await reservation(context, repository, { release: true })), /newer fence/);
  await repository.assertWalletNonce(otherCycle, await reservation(successor, repository));
});

test('release stays idempotent across heartbeat and reopen without releasing another cycle reservation', async t => {
  const { repository, context, directory, now } = await fixture(t, 'payout');
  await repository.reserveWalletNonce(context.cycleId, await reservation(context, repository));
  context.lease.expiresAt = 3_000;
  await repository.releaseWalletNonce(context.cycleId, await reservation(context, repository, { release: true }));
  const reopened = await CycleRepository.open(directory, now);
  const freshContext = structuredClone(context);
  await reopened.releaseWalletNonce(context.cycleId, await reservation(freshContext, reopened, { release: true }));
  await assert.rejects(async () => reopened.assertWalletNonce(context.cycleId, await reservation(freshContext, reopened)), /not held/);
  const otherCycle = 'cycle-after-wallet-release';
  const store = await DurableCycleStore.open(directory);
  const empty = store.readCycle(otherCycle);
  const transaction = store.begin(otherCycle, { expectedVersion: empty.version, expectedJournalHead: empty.journalHead });
  transaction.stageEvent(new CycleJournal(otherCycle, empty.entries).propose('cycle-opened', { releaseAmount: '2', openedAtMs: 1 }));
  await store.commit(transaction);
  const successor = { ...freshContext, cycleId: otherCycle, fencingToken: NEXT };
  await reopened.reserveWalletNonce(otherCycle, await reservation(successor, reopened));
  await assert.rejects(async () => reopened.releaseWalletNonce(context.cycleId, await reservation(freshContext, reopened, { release: true })), /newer fence/);
  await reopened.assertWalletNonce(otherCycle, await reservation(successor, reopened));
});

test('a released nonce may be newly reserved under the still-active renewed automation lease', async t => {
  const { repository, context, setNow } = await fixture(t, 'payout');
  await repository.reserveWalletNonce(context.cycleId, await reservation(context, repository));
  await repository.releaseWalletNonce(context.cycleId, await reservation(context, repository, { release: true }));
  context.lease.expiresAt = 4_000;
  setNow(2_001);
  const replacement = await reservation(structuredClone(context), repository);
  assert.equal(replacement.leaseExpiresAtMs, 4_000);
  await repository.reserveWalletNonce(context.cycleId, replacement);
  await repository.assertWalletNonce(context.cycleId, replacement);
});
