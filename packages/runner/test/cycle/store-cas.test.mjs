import assert from 'node:assert/strict';
import test from 'node:test';

import { CycleRunner } from '../../src/cycle/cycle-runner.mjs';
import { CycleJournal, RECOVERY_LIMITS } from '../../src/cycle/journal.mjs';
import { FixtureCycleStore } from '../../src/cycle/cycle-store.mjs';
import { executeCompleteFixtureCycle } from './fixture-cycle.mjs';

const authorizationRecord = (overrides = {}) => ({
  key: 'sha256:' + '1'.repeat(64),
  nonceKey: 'sha256:' + '2'.repeat(64),
  cycleId: 'cycle-atomic',
  actionKind: 'outbound',
  authorizationKind: 'mutation',
  actionDigest: 'sha256:' + '3'.repeat(64),
  subjectDigest: 'sha256:' + '3'.repeat(64),
  commitment: 'sha256:' + '4'.repeat(64),
  validatedAt: '2029-01-01T00:00:00.000Z',
  ...overrides,
});

const receiptRecord = (overrides = {}) => ({
  key: 'sha256:' + '5'.repeat(64),
  provider: 'fixture-provider',
  providerReceiptId: 'receipt-1',
  cycleId: 'cycle-atomic',
  actionKind: 'outbound',
  receiptDigest: 'sha256:' + '6'.repeat(64),
  receiptCommitment: 'sha256:' + '7'.repeat(64),
  ...overrides,
});

test('cycle store prevents parallel transactions from forking one journal head', () => {
  const store = new FixtureCycleStore();
  const first = store.begin('cycle-cas', { expectedVersion: 0, expectedJournalHead: null });
  const stale = store.begin('cycle-cas', { expectedVersion: 0, expectedJournalHead: null });
  const journal = new CycleJournal('cycle-cas');
  first.stageEvent(journal.propose('fixture-event', { value: 'first' }));
  stale.stageEvent(journal.propose('fixture-event', { value: 'fork' }));
  store.commit(first);
  assert.throws(() => store.commit(stale), /stale cycle journal (?:version|head)/);

  const reopened = FixtureCycleStore.reopen(store.snapshot).readCycle('cycle-cas');
  assert.equal(reopened.entries.length, 1);
  assert.equal(reopened.entries[0].payload.value, 'first');
});

test('journal append and durable authorization and receipt writes roll back together', () => {
  const store = new FixtureCycleStore();
  const tx = store.begin('cycle-atomic', { expectedVersion: 0, expectedJournalHead: null });
  tx.consumeAuthorization(authorizationRecord());
  tx.consumeReceipt(receiptRecord());
  tx.stageEvent({ cycleId: 'cycle-atomic', index: 0, kind: 'attacker-event', payload: {}, previousDigest: null, digest: 'sha256:' + '8'.repeat(64) });

  assert.throws(() => store.commit(tx), /journal event digest/);
  assert.deepEqual(store.snapshot.cycles, []);
  assert.deepEqual(store.snapshot.authorizations, []);
  assert.deepEqual(store.snapshot.receipts, []);
});

test('binds transactions, records, and authorization nonces to one atomic cycle commit', () => {
  const first = new FixtureCycleStore();
  const second = new FixtureCycleStore();
  const foreign = first.begin('cycle-atomic', { expectedVersion: 0, expectedJournalHead: null });
  foreign.stageEvent(new CycleJournal('cycle-atomic').propose('fixture-event', { value: 'foreign' }));
  assert.throws(() => second.commit(foreign), /transaction store|different store/i);
  assert.deepEqual(second.snapshot.cycles, []);

  const wrongCycle = first.begin('cycle-atomic', { expectedVersion: 0, expectedJournalHead: null });
  wrongCycle.stageEvent(new CycleJournal('cycle-atomic').propose('fixture-event', { value: 'wrong-cycle' }));
  wrongCycle.consumeReceipt(receiptRecord({ cycleId: 'cycle-other' }));
  assert.throws(() => first.commit(wrongCycle), /receipt cycle|cycle mismatch/i);
  assert.deepEqual(first.snapshot.cycles, []);
  assert.deepEqual(first.snapshot.receipts, []);

  const duplicateNonce = first.begin('cycle-atomic', { expectedVersion: 0, expectedJournalHead: null });
  duplicateNonce.stageEvent(new CycleJournal('cycle-atomic').propose('fixture-event', { value: 'duplicate-nonce' }));
  duplicateNonce.consumeAuthorization(authorizationRecord());
  assert.throws(
    () => duplicateNonce.consumeAuthorization(authorizationRecord({
      key: 'sha256:' + '9'.repeat(64),
      actionDigest: 'sha256:' + 'a'.repeat(64),
      commitment: 'sha256:' + 'b'.repeat(64),
    })),
    /authorization nonce/i,
  );
  assert.deepEqual(first.snapshot.cycles, []);
  assert.deepEqual(first.snapshot.authorizations, []);
});

test('reopens every complete cycle allowed by the bounded store', () => {
  const store = new FixtureCycleStore();
  for (let index = 1; index <= RECOVERY_LIMITS.storeCycles; index += 1) {
    const cycleId = `cycle-recovery-boundary-${index}`;
    executeCompleteFixtureCycle(
      new CycleRunner(cycleId, [], { cycleStore: store }),
      cycleId,
    );
  }

  const snapshot = store.snapshot;
  assert.equal(snapshot.cycles.length, RECOVERY_LIMITS.storeCycles);
  assert.equal(snapshot.authorizations.length, RECOVERY_LIMITS.storeCycles * 23);
  assert.equal(snapshot.receipts.length, RECOVERY_LIMITS.storeCycles * 4);
  assert.deepEqual(FixtureCycleStore.reopen(snapshot).snapshot, snapshot);
});
