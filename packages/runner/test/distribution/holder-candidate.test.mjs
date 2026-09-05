import assert from 'node:assert/strict';
import test from 'node:test';

import { CycleRunner } from '../../src/cycle/cycle-runner.mjs';
import { FixtureCycleStore } from '../../src/cycle/cycle-store.mjs';
import { digest } from '../../src/cycle/journal.mjs';
import { deriveClosedProceedsBasis } from '../../src/distribution/reconcile.mjs';
import { executeCompleteFixtureCycle } from '../cycle/fixture-cycle.mjs';

const recipientA = `0x${'1'.repeat(40)}`;
const recipientB = `0x${'2'.repeat(40)}`;
const zeroRecipient = `0x${'0'.repeat(40)}`;

function candidateFixture(cycleId = 'cycle-holder-candidate') {
  const cycleStore = new FixtureCycleStore();
  const runner = new CycleRunner(cycleId, [], { cycleStore });
  const { returnReceiptDigest } = executeCompleteFixtureCycle(runner, cycleId);
  runner.deriveClosedCycle();
  const proceedsKey = runner.consumeReturnedProceedsOnce({ receiptDigest: returnReceiptDigest });
  const closedProceedsBasis = deriveClosedProceedsBasis(
    runner.readClosedProceedsBasisHandoff({ proceedsKey }),
  );
  const snapshot = {
    schema: 'hookemon.input-bound-hkmn-snapshot-candidate.v1',
    authority: 'INPUT_BOUND_CANDIDATE_NOT_AUTHENTICATED',
    asset: 'HKMN',
    chainId: '1',
    tokenAddress: `0x${'a'.repeat(40)}`,
    blockNumber: '12345678',
    blockHash: `0x${'b'.repeat(64)}`,
    finalized: true,
    directBalances: [
      { recipient: recipientA, directHkmnBalance: '100' },
      { recipient: recipientB, directHkmnBalance: '200' },
    ],
  };
  const entries = [
    { index: 0, recipient: recipientA, directHkmnBalance: '100', amountAtomicUSDG: '4' },
    { index: 1, recipient: recipientB, directHkmnBalance: '200', amountAtomicUSDG: '6' },
  ];
  return { cycleStore, runner, proceedsKey, closedProceedsBasis, snapshot, entries };
}

test('derives only an input-bound pending holder distribution candidate', async () => {
  const fixture = candidateFixture();
  const beforeRead = fixture.cycleStore.snapshot;
  const module = await import('../../src/distribution/reconcile.mjs');

  assert.equal(typeof module.deriveHolderDistributionCandidate, 'function');
  const first = module.deriveHolderDistributionCandidate({
    closedProceedsBasis: fixture.closedProceedsBasis,
    snapshot: fixture.snapshot,
    entries: fixture.entries,
  });
  const second = module.deriveHolderDistributionCandidate(structuredClone({
    closedProceedsBasis: fixture.closedProceedsBasis,
    snapshot: fixture.snapshot,
    entries: fixture.entries,
  }));

  assert.deepEqual(second, first);
  assert.equal(first.schema, 'hookemon.holder-distribution-candidate.v1');
  assert.equal(first.status, 'PENDING_OWNER_APPROVAL_AND_PROOF_DOMAIN');
  assert.equal(first.authority, 'INPUT_BOUND_CANDIDATE_NOT_AUTHENTICATED');
  assert.equal(first.closedProceedsBasisDigest, fixture.closedProceedsBasis.basisDigest);
  assert.equal(first.entryCount, 2);
  assert.equal(first.totalAmountAtomicUSDG, fixture.closedProceedsBasis.finalCredit.amount);
  for (const field of ['snapshotDigest', 'entriesDigest', 'candidateDigest']) {
    assert.match(first[field], /^sha256:[0-9a-f]{64}$/);
  }
  for (const forbidden of ['manifestDigest', 'root', 'proof', 'publication', 'fundingIntent']) {
    assert.equal(Object.hasOwn(first, forbidden), false);
  }
  assert.throws(
    () => fixture.runner.preparePayoutFunding({
      proceedsKey: fixture.proceedsKey,
      verificationReceiptDigest: first.candidateDigest,
      expiresAt: '1893456000',
      nonce: '9',
    }),
    /recorded distribution verification/i,
  );
  assert.deepEqual(fixture.cycleStore.snapshot, beforeRead);
});

test('accepts sparse holder candidate indices within the 0..1023 range', async () => {
  const fixture = candidateFixture('cycle-holder-candidate-sparse-indices');
  const { deriveHolderDistributionCandidate } = await import('../../src/distribution/reconcile.mjs');
  const entries = structuredClone(fixture.entries);
  entries[0].index = 7;
  entries[1].index = 1023;

  const candidate = deriveHolderDistributionCandidate({
    closedProceedsBasis: fixture.closedProceedsBasis,
    snapshot: fixture.snapshot,
    entries,
  });

  assert.deepEqual(candidate.entries.map(({ index }) => index), [7, 1023]);
  assert.equal(candidate.status, 'PENDING_OWNER_APPROVAL_AND_PROOF_DOMAIN');
  assert.equal(candidate.authority, 'INPUT_BOUND_CANDIDATE_NOT_AUTHENTICATED');
});

test('rejects invalid holder candidate indices, recipients, balances, amounts, and sums', async () => {
  const fixture = candidateFixture('cycle-holder-candidate-invalid');
  const { deriveHolderDistributionCandidate } = await import('../../src/distribution/reconcile.mjs');
  const derive = (snapshot, entries) => deriveHolderDistributionCandidate({
    closedProceedsBasis: fixture.closedProceedsBasis,
    snapshot,
    entries,
  });

  assert.throws(() => derive(fixture.snapshot, []), /between 1 and 1024/);
  for (const [name, mutate, error] of [
    ['duplicate index', entries => { entries[1].index = 0; }, /strictly increasing/],
    ['unsorted index', entries => { entries[0].index = 2; }, /strictly increasing/],
    ['negative index', entries => { entries[0].index = -1; }, /between 0 and 1023/],
    ['index over 1023', entries => { entries[1].index = 1024; }, /between 0 and 1023/],
    ['fractional index', entries => { entries[0].index = 0.5; }, /integer/],
    ['duplicate recipient', entries => { entries[1].recipient = recipientA; }, /recipient.*unique/],
    ['zero recipient', entries => { entries[0].recipient = zeroRecipient; }, /recipient.*nonzero/],
    ['zero direct balance', entries => { entries[0].directHkmnBalance = '0'; }, /HKMN balance.*positive/],
    ['zero amount', entries => { entries[0].amountAtomicUSDG = '0'; }, /USDG amount.*positive/],
    ['sum short by one', entries => { entries[1].amountAtomicUSDG = '5'; }, /sum.*final credit/],
    ['sum over by one', entries => { entries[1].amountAtomicUSDG = '7'; }, /sum.*final credit/],
  ]) {
    const entries = structuredClone(fixture.entries);
    mutate(entries);
    assert.throws(() => derive(fixture.snapshot, entries), error, name);
  }

  const mismatched = structuredClone(fixture.entries);
  mismatched[0].directHkmnBalance = '101';
  assert.throws(() => derive(fixture.snapshot, mismatched), /does not match the snapshot/);

  const accessorEntries = structuredClone(fixture.entries);
  Object.defineProperty(accessorEntries, '0', {
    enumerable: true,
    get() { throw new Error('candidate accessor executed'); },
  });
  assert.throws(() => derive(fixture.snapshot, accessorEntries), /dense and unadorned/);

  const tooMany = Array.from({ length: 1025 }, (_, index) => ({
    index,
    recipient: `0x${(index + 1).toString(16).padStart(40, '0')}`,
    directHkmnBalance: '1',
    amountAtomicUSDG: '1',
  }));
  const largeSnapshot = {
    ...fixture.snapshot,
    directBalances: tooMany.map(({ recipient, directHkmnBalance }) => ({ recipient, directHkmnBalance })),
  };
  assert.throws(() => derive(largeSnapshot, tooMany), /between 1 and 1024/);
});

test('rejects non-final or authority-overclaimed HKMN snapshot candidates', async () => {
  const fixture = candidateFixture('cycle-holder-snapshot-invalid');
  const { deriveHolderDistributionCandidate } = await import('../../src/distribution/reconcile.mjs');
  const derive = snapshot => deriveHolderDistributionCandidate({
    closedProceedsBasis: fixture.closedProceedsBasis,
    snapshot,
    entries: fixture.entries,
  });

  assert.throws(() => derive({ ...fixture.snapshot, finalized: false }), /snapshot must be finalized/);
  assert.throws(
    () => derive({ ...fixture.snapshot, authority: 'OWNER_APPROVED' }),
    /snapshot schema or authority/,
  );
  assert.throws(() => derive({ ...fixture.snapshot, asset: 'OTHER' }), /snapshot asset must be HKMN/);
});

test('accepts the 1024-entry holder candidate boundary without creating proof artifacts', async () => {
  const fixture = candidateFixture('cycle-holder-candidate-boundary');
  const { deriveHolderDistributionCandidate } = await import('../../src/distribution/reconcile.mjs');
  const closedProceedsBasis = structuredClone(fixture.closedProceedsBasis);
  closedProceedsBasis.finalCredit.preBalance = '7';
  closedProceedsBasis.finalCredit.postBalance = '1031';
  closedProceedsBasis.finalCredit.amount = '1024';
  const { basisDigest: _oldBasisDigest, ...basis } = closedProceedsBasis;
  closedProceedsBasis.basisDigest = digest({ domain: 'hookemon.closed-proceeds-basis.v1', basis });
  const entries = Array.from({ length: 1024 }, (_, index) => ({
    index,
    recipient: `0x${(index + 1).toString(16).padStart(40, '0')}`,
    directHkmnBalance: '1',
    amountAtomicUSDG: '1',
  }));
  const snapshot = {
    ...fixture.snapshot,
    directBalances: entries.map(({ recipient, directHkmnBalance }) => ({
      recipient,
      directHkmnBalance,
    })),
  };

  const candidate = deriveHolderDistributionCandidate({ closedProceedsBasis, snapshot, entries });

  assert.equal(candidate.entryCount, 1024);
  assert.equal(candidate.totalAmountAtomicUSDG, '1024');
  assert.equal(candidate.status, 'PENDING_OWNER_APPROVAL_AND_PROOF_DOMAIN');
  assert.equal(Object.hasOwn(candidate, 'root'), false);
  assert.equal(Object.hasOwn(candidate, 'proof'), false);
});
