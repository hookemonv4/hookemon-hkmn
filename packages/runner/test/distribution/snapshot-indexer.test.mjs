import assert from 'node:assert/strict';
import test from 'node:test';

import { CycleRunner } from '../../src/cycle/cycle-runner.mjs';
import { FixtureCycleStore } from '../../src/cycle/cycle-store.mjs';
import { deriveClosedProceedsBasis, deriveHolderDistributionCandidate } from '../../src/distribution/reconcile.mjs';
import {
  assertHolderSnapshot,
  buildHolderSnapshot,
  HOLDER_SNAPSHOT_SCHEMA,
  SNAPSHOT_CANDIDATE_AUTHORITY,
  SNAPSHOT_CANDIDATE_SCHEMA,
  toSnapshotCandidate,
} from '../../src/distribution/snapshot-indexer.mjs';
import { executeCompleteFixtureCycle } from '../cycle/fixture-cycle.mjs';

const zeroAddress = `0x${'0'.repeat(40)}`;
const recipientA = `0x${'1'.repeat(40)}`;
const recipientB = `0x${'2'.repeat(40)}`;
const canonicalPool = `0x${'3'.repeat(40)}`;
const hookemonHook = `0x${'4'.repeat(40)}`;
const tokenAddress = `0x${'a'.repeat(40)}`;
const blockHash = `0x${'b'.repeat(64)}`;

function baseSnapshotInput(overrides = {}) {
  return {
    chainId: '4663',
    tokenAddress,
    blockNumber: '100',
    blockHash,
    finalized: true,
    totalSupply: '350',
    excludedAddresses: [{ address: canonicalPool, reason: 'canonical USDG/HKMN pool' }],
    transferLogs: [
      { blockNumber: '10', logIndex: '0', from: zeroAddress, to: recipientA, value: '100' },
      { blockNumber: '10', logIndex: '1', from: zeroAddress, to: recipientB, value: '200' },
      { blockNumber: '20', logIndex: '0', from: zeroAddress, to: canonicalPool, value: '50' },
    ],
    ...overrides,
  };
}

test('folds transfer logs into sorted, positive holder balances and excludes the given addresses', () => {
  const snapshot = buildHolderSnapshot(baseSnapshotInput());

  assert.equal(snapshot.schema, HOLDER_SNAPSHOT_SCHEMA);
  assert.equal(snapshot.finalized, true);
  assert.equal(snapshot.totalSupply, '350');
  assert.equal(snapshot.totalHolderBalance, '300');
  assert.equal(snapshot.totalExcludedBalance, '50');
  assert.equal(snapshot.holderCount, 2);
  assert.deepEqual(snapshot.directBalances, [
    { recipient: recipientA, directHkmnBalance: '100' },
    { recipient: recipientB, directHkmnBalance: '200' },
  ]);
  assert.deepEqual(snapshot.excludedAddresses, [{ address: canonicalPool, reason: 'canonical USDG/HKMN pool' }]);
  assert.match(snapshot.holderSnapshotDigest, /^sha256:[0-9a-f]{64}$/);
  // Excluded addresses (pool/hook/vault/escrow/treasury) must never appear as recipients.
  assert.equal(snapshot.directBalances.some(entry => entry.recipient === canonicalPool), false);
});

test('accounts for transfers between holders and burns, still excluding the pool', () => {
  const snapshot = buildHolderSnapshot(baseSnapshotInput({
    totalSupply: '340',
    excludedAddresses: [
      { address: canonicalPool, reason: 'canonical USDG/HKMN pool' },
      { address: hookemonHook, reason: 'HookemonHook fee-accounting contract' },
    ],
    transferLogs: [
      { blockNumber: '10', logIndex: '0', from: zeroAddress, to: recipientA, value: '100' },
      { blockNumber: '10', logIndex: '1', from: zeroAddress, to: recipientB, value: '200' },
      { blockNumber: '20', logIndex: '0', from: zeroAddress, to: canonicalPool, value: '50' },
      { blockNumber: '30', logIndex: '0', from: recipientA, to: recipientB, value: '40' },
      { blockNumber: '40', logIndex: '0', from: recipientB, to: zeroAddress, value: '10' },
    ],
  }));

  assert.deepEqual(snapshot.directBalances, [
    { recipient: recipientA, directHkmnBalance: '60' },
    { recipient: recipientB, directHkmnBalance: '230' },
  ]);
  assert.equal(snapshot.totalHolderBalance, '290');
  assert.equal(snapshot.totalExcludedBalance, '50');
  assert.equal(snapshot.totalSupply, '340');
});

test('two independent builds of the same finalized block produce byte-identical snapshots', () => {
  const inputA = baseSnapshotInput();
  // Build a structurally distinct (different property-insertion order, freshly-allocated
  // arrays and objects) but semantically identical input, as a second independent builder
  // reading the same finalized block would.
  const inputB = {
    finalized: true,
    blockHash,
    totalSupply: '350',
    transferLogs: inputA.transferLogs.map(log => ({ value: log.value, to: log.to, from: log.from, logIndex: log.logIndex, blockNumber: log.blockNumber })),
    excludedAddresses: inputA.excludedAddresses.map(entry => ({ reason: entry.reason, address: entry.address })),
    blockNumber: '100',
    chainId: '4663',
    tokenAddress,
  };

  const snapshotA = buildHolderSnapshot(inputA);
  const snapshotB = buildHolderSnapshot(inputB);

  assert.deepEqual(snapshotA, snapshotB);
  assert.equal(snapshotA.holderSnapshotDigest, snapshotB.holderSnapshotDigest);
  assert.deepEqual(assertHolderSnapshot(snapshotA), snapshotA);
  assert.deepEqual(assertHolderSnapshot(snapshotB), snapshotB);
});

test('assertHolderSnapshot recomputes the digest and rejects a tampered field', () => {
  const snapshot = buildHolderSnapshot(baseSnapshotInput());
  const tampered = { ...snapshot, chainId: '9999' };

  assert.throws(() => assertHolderSnapshot(tampered), /digest mismatch/);
});

test('assertHolderSnapshot rejects an excluded address that leaked into directBalances', () => {
  const snapshot = buildHolderSnapshot(baseSnapshotInput());
  const leaked = {
    ...snapshot,
    directBalances: [...snapshot.directBalances, { recipient: canonicalPool, directHkmnBalance: '50' }].sort(
      (a, b) => (a.recipient < b.recipient ? -1 : a.recipient > b.recipient ? 1 : 0),
    ),
    totalHolderBalance: '350',
    holderCount: 3,
  };

  assert.throws(() => assertHolderSnapshot(leaked), /never appear as a recipient/);
});

test('rejects a total supply that does not reconcile with the folded log set', () => {
  assert.throws(
    () => buildHolderSnapshot(baseSnapshotInput({ totalSupply: '999' })),
    /total supply does not reconcile/,
  );
});

test('rejects a transfer log that debits more than the running balance', () => {
  assert.throws(
    () => buildHolderSnapshot(baseSnapshotInput({
      totalSupply: '350',
      transferLogs: [
        { blockNumber: '10', logIndex: '0', from: zeroAddress, to: recipientA, value: '100' },
        { blockNumber: '10', logIndex: '1', from: zeroAddress, to: recipientB, value: '200' },
        { blockNumber: '20', logIndex: '0', from: zeroAddress, to: canonicalPool, value: '50' },
        { blockNumber: '30', logIndex: '0', from: recipientA, to: recipientB, value: '1000' },
      ],
    })),
    /debits more than the running balance/,
  );
});

test('rejects out-of-order transfer logs', () => {
  assert.throws(
    () => buildHolderSnapshot(baseSnapshotInput({
      transferLogs: [
        { blockNumber: '20', logIndex: '0', from: zeroAddress, to: canonicalPool, value: '50' },
        { blockNumber: '10', logIndex: '0', from: zeroAddress, to: recipientA, value: '100' },
        { blockNumber: '10', logIndex: '1', from: zeroAddress, to: recipientB, value: '200' },
      ],
    })),
    /out of canonical/,
  );
});

test('rejects a transfer log newer than the finalized snapshot block', () => {
  assert.throws(
    () => buildHolderSnapshot(baseSnapshotInput({
      transferLogs: [
        { blockNumber: '10', logIndex: '0', from: zeroAddress, to: recipientA, value: '100' },
        { blockNumber: '10', logIndex: '1', from: zeroAddress, to: recipientB, value: '200' },
        { blockNumber: '20', logIndex: '0', from: zeroAddress, to: canonicalPool, value: '50' },
        { blockNumber: '200', logIndex: '0', from: zeroAddress, to: recipientA, value: '1' },
      ],
      totalSupply: '351',
    })),
    /newer than the finalized snapshot block/,
  );
});

test('rejects malformed or non-exact-schema input', () => {
  assert.throws(() => buildHolderSnapshot(baseSnapshotInput({ extraField: true })), /exact schema/);
  assert.throws(() => buildHolderSnapshot(baseSnapshotInput({ finalized: false })), /finalized/);
  assert.throws(() => buildHolderSnapshot(baseSnapshotInput({ chainId: '0' })), /chainId/);
  assert.throws(
    () => buildHolderSnapshot(baseSnapshotInput({
      excludedAddresses: [
        { address: canonicalPool, reason: 'pool' },
        { address: canonicalPool, reason: 'duplicate' },
      ],
    })),
    /unique/,
  );
});

test('toSnapshotCandidate projects exactly the schema reconcile.mjs already expects and round-trips through it', () => {
  const cycleStore = new FixtureCycleStore();
  const cycleId = 'cycle-snapshot-indexer';
  const runner = new CycleRunner(cycleId, [], { cycleStore });
  const { returnReceiptDigest } = executeCompleteFixtureCycle(runner, cycleId);
  runner.deriveClosedCycle();
  const proceedsKey = runner.consumeReturnedProceedsOnce({ receiptDigest: returnReceiptDigest });
  const closedProceedsBasis = deriveClosedProceedsBasis(
    runner.readClosedProceedsBasisHandoff({ proceedsKey }),
  );
  assert.equal(closedProceedsBasis.finalCredit.amount, '10');

  const holderSnapshot = buildHolderSnapshot(baseSnapshotInput());
  const candidate = toSnapshotCandidate(holderSnapshot);

  assert.deepEqual(Object.keys(candidate).sort(), [
    'asset', 'authority', 'blockHash', 'blockNumber', 'chainId',
    'directBalances', 'finalized', 'schema', 'tokenAddress',
  ]);
  assert.equal(candidate.schema, SNAPSHOT_CANDIDATE_SCHEMA);
  assert.equal(candidate.authority, SNAPSHOT_CANDIDATE_AUTHORITY);
  assert.equal(candidate.asset, 'HKMN');
  assert.equal(candidate.finalized, true);
  assert.deepEqual(candidate.directBalances, [
    { recipient: recipientA, directHkmnBalance: '100' },
    { recipient: recipientB, directHkmnBalance: '200' },
  ]);

  const entries = [
    { index: 0, recipient: recipientA, directHkmnBalance: '100', amountAtomicUSDG: '4' },
    { index: 1, recipient: recipientB, directHkmnBalance: '200', amountAtomicUSDG: '6' },
  ];

  const distributionCandidate = deriveHolderDistributionCandidate({ closedProceedsBasis, snapshot: candidate, entries });

  assert.equal(distributionCandidate.schema, 'hookemon.holder-distribution-candidate.v1');
  assert.equal(distributionCandidate.entryCount, 2);
  assert.equal(distributionCandidate.totalAmountAtomicUSDG, '10');
  // Independently rebuilding the same candidate from the same inputs is byte-identical.
  assert.deepEqual(
    deriveHolderDistributionCandidate({ closedProceedsBasis, snapshot: toSnapshotCandidate(holderSnapshot), entries }),
    distributionCandidate,
  );
});

test('toSnapshotCandidate rejects an out-of-range or empty direct-balance set', () => {
  const holderSnapshot = buildHolderSnapshot(baseSnapshotInput());

  assert.throws(() => toSnapshotCandidate(holderSnapshot, { directBalances: [] }), /between 1 and 1024/);
});
