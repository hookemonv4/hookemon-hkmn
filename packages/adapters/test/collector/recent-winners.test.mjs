import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertPublicCardEvent,
  createRecentWinnersCollector,
  reconcileFromJournal,
} from '../../src/collector/recent-winners.mjs';

function event(overrides = {}) {
  return {
    cycleId: 'cycle-1',
    operationId: 'op-1',
    packIndex: 0,
    memo: 'hookemon-cycle-1',
    mint: null,
    eventId: 'evt-1',
    sequence: '1',
    state: 'observed',
    name: 'Ember Chick',
    imageUrl: null,
    observedAt: '2026-01-01T00:00:00.000Z',
    finalizedAt: null,
    transactionId: null,
    proceeds: null,
    ...overrides,
  };
}

function trustedOperations(overrides = {}) {
  return new Map([
    ['hookemon-cycle-1', { cycleId: 'cycle-1', operationId: 'op-1', packIndex: 0, mint: null, wallet: null, ...overrides }],
  ]);
}

test('assertPublicCardEvent rejects a malformed observation', () => {
  assert.throws(() => assertPublicCardEvent(event({ eventId: '' })), /eventId/);
  assert.throws(() => assertPublicCardEvent(event({ state: 'bogus' })), /state/);
  assert.throws(() => assertPublicCardEvent(event({ observedAt: 'not-a-date' })), /observedAt/);
});

test('assertPublicCardEvent rejects a non-canonical (zero-padded) sequence', () => {
  assert.throws(() => assertPublicCardEvent(event({ sequence: '007' })), /sequence/);
});

test('assertPublicCardEvent rejects a present proceeds Amount whose units is null (entire Amount must be null instead)', () => {
  assert.throws(
    () => assertPublicCardEvent(event({ proceeds: { chainId: 'solana:mainnet-beta', assetId: 'spl:usdc-mint', decimals: 6, units: null } })),
    /units/,
  );
});

test('ingest drops an observation whose memo has no trusted operation record', () => {
  const collector = createRecentWinnersCollector({ trustedOperations: trustedOperations() });
  const result = collector.ingest(event({ memo: 'some-other-project-cycle-9' }));
  assert.equal(result, null);
  assert.equal(collector.size(), 0);
});

test('ingest drops an observation with a null memo (cannot attribute it to this project)', () => {
  const collector = createRecentWinnersCollector({ trustedOperations: trustedOperations() });
  assert.equal(collector.ingest(event({ memo: null })), null);
  assert.equal(collector.size(), 0);
});

test('ingest drops an observation whose cycleId/operationId conflicts with the trusted record for its memo', () => {
  const collector = createRecentWinnersCollector({ trustedOperations: trustedOperations() });
  assert.equal(collector.ingest(event({ cycleId: 'foreign-cycle' })), null);
  assert.equal(collector.ingest(event({ operationId: 'foreign-op' })), null);
  assert.equal(collector.ingest(event({ packIndex: 5 })), null);
  assert.equal(collector.size(), 0);
});

test('ingest drops an observation whose mint conflicts with the trusted record\'s expected mint', () => {
  const collector = createRecentWinnersCollector({
    trustedOperations: trustedOperations({ mint: 'ExpectedMintAddress' }),
  });
  assert.equal(collector.ingest(event({ mint: 'AttackerMint' })), null);
  const accepted = collector.ingest(event({ mint: 'ExpectedMintAddress' }));
  assert.notEqual(accepted, null);
});

test('ingest drops an observation whose wallet conflicts with the trusted record\'s expected wallet', () => {
  const collector = createRecentWinnersCollector({
    trustedOperations: trustedOperations({ wallet: 'ExpectedWallet111' }),
  });
  assert.equal(collector.ingest({ ...event(), wallet: 'AttackerWallet999' }), null);
  const accepted = collector.ingest({ ...event(), wallet: 'ExpectedWallet111' });
  assert.notEqual(accepted, null);
});

test('a real repro: known memo paired with a foreign cycleId/operationId and arbitrary mint is rejected', () => {
  const collector = createRecentWinnersCollector({ trustedOperations: trustedOperations({ mint: 'RealMint' }) });
  const result = collector.ingest({
    cycleId: 'foreign-cycle', operationId: 'foreign-op', packIndex: 0,
    memo: 'hookemon-cycle-1', mint: 'AttackerMint',
    eventId: 'evt-x', sequence: '1', state: 'observed', name: null, imageUrl: null,
    observedAt: '2026-01-01T00:00:00.000Z', finalizedAt: null, transactionId: null, proceeds: null,
  });
  assert.equal(result, null);
});

test('duplicate observations of the same durable identity collapse into one card', () => {
  const collector = createRecentWinnersCollector({ trustedOperations: trustedOperations() });
  collector.ingest(event({ eventId: 'evt-a', sequence: '1' }));
  collector.ingest(event({ eventId: 'evt-b', sequence: '1' })); // same identity, different eventId
  assert.equal(collector.size(), 1);
  assert.equal(collector.list().length, 1);
});

test('a later observation under the same durable key with a different memo/mint is rejected as a conflicting identity, never silently overwritten', () => {
  const collector = createRecentWinnersCollector({
    trustedOperations: new Map([
      ['hookemon-cycle-1', { cycleId: 'cycle-1', operationId: 'op-1', packIndex: 0, mint: null, wallet: null }],
      ['hookemon-cycle-1-alt', { cycleId: 'cycle-1', operationId: 'op-1', packIndex: 0, mint: 'DifferentMint', wallet: null }],
    ]),
  });
  const first = collector.ingest(event({ memo: 'hookemon-cycle-1', mint: null, sequence: '1' }));
  assert.notEqual(first, null);
  const conflicting = collector.ingest(event({ memo: 'hookemon-cycle-1-alt', mint: 'DifferentMint', sequence: '2' }));
  assert.equal(conflicting, null, 'a different mint under the same cycle/op/pack identity must not replace the retained card');
  assert.equal(collector.size(), 1);
  assert.equal(collector.list()[0].mint, null);
});

test('out-of-order lower-sequence duplicate does not regress a later observation (numeric, not lexical, comparison)', () => {
  const collector = createRecentWinnersCollector({ trustedOperations: trustedOperations() });
  collector.ingest(event({ sequence: '10', name: 'Later Name' }));
  const kept = collector.ingest(event({ sequence: '9', name: 'Earlier Name (arrived late)' }));
  assert.equal(kept.name, 'Later Name', 'sequence "9" must not outrank "10" the way lexical comparison would');
  assert.equal(collector.list()[0].name, 'Later Name');
});

test('a finalized observation is never regressed back to observed by a later out-of-order "observed" duplicate', () => {
  const collector = createRecentWinnersCollector({ trustedOperations: trustedOperations() });
  collector.ingest(event({ sequence: '1', state: 'finalized', finalizedAt: '2026-01-01T00:05:00.000Z' }));
  const kept = collector.ingest(event({ sequence: '9', state: 'observed', finalizedAt: null }));
  assert.equal(kept.state, 'finalized');
});

test('a card from a different operation/packIndex within the same cycle is a distinct card', () => {
  const collector = createRecentWinnersCollector({
    trustedOperations: new Map([
      ['memo-0', { cycleId: 'cycle-1', operationId: 'op-1', packIndex: 0, mint: null, wallet: null }],
      ['memo-1', { cycleId: 'cycle-1', operationId: 'op-1', packIndex: 1, mint: null, wallet: null }],
    ]),
  });
  collector.ingest(event({ memo: 'memo-0', operationId: 'op-1', packIndex: 0, sequence: '1' }));
  collector.ingest(event({ memo: 'memo-1', operationId: 'op-1', packIndex: 1, sequence: '2' }));
  assert.equal(collector.size(), 2);
});

test('list returns newest-sequence-first (numeric) and respects limit', () => {
  const records = new Map();
  for (let index = 0; index < 5; index += 1) {
    records.set(`memo-${index}`, { cycleId: 'cycle-1', operationId: `op-${index}`, packIndex: 0, mint: null, wallet: null });
  }
  const collector = createRecentWinnersCollector({ trustedOperations: records });
  for (let index = 0; index < 5; index += 1) {
    collector.ingest(event({ memo: `memo-${index}`, operationId: `op-${index}`, sequence: String(index), eventId: `evt-${index}` }));
  }
  const listed = collector.list({ limit: 2 });
  assert.deepEqual(listed.map(item => item.operationId), ['op-4', 'op-3']);
});

test('retention evicts the oldest-sequence entries once maxRetained is exceeded', () => {
  const records = new Map([
    ['memo-0', { cycleId: 'cycle-1', operationId: 'op-0', packIndex: 0, mint: null, wallet: null }],
    ['memo-1', { cycleId: 'cycle-1', operationId: 'op-1', packIndex: 0, mint: null, wallet: null }],
    ['memo-2', { cycleId: 'cycle-1', operationId: 'op-2', packIndex: 0, mint: null, wallet: null }],
  ]);
  const collector = createRecentWinnersCollector({ trustedOperations: records, maxRetained: 2 });
  collector.ingest(event({ memo: 'memo-0', operationId: 'op-0', sequence: '0' }));
  collector.ingest(event({ memo: 'memo-1', operationId: 'op-1', sequence: '1' }));
  collector.ingest(event({ memo: 'memo-2', operationId: 'op-2', sequence: '2' }));
  assert.equal(collector.size(), 2);
  assert.deepEqual(collector.list().map(item => item.operationId), ['op-2', 'op-1']);
});

test('reconcileFromJournal ingests durable operations and reports how many were accepted', async () => {
  const collector = createRecentWinnersCollector({
    trustedOperations: new Map([
      ['memo-1', { cycleId: 'cycle-1', operationId: 'op-1', packIndex: 0, mint: null, wallet: null }],
      ['memo-3', { cycleId: 'cycle-1', operationId: 'op-3', packIndex: 0, mint: null, wallet: null }],
    ]),
  });
  const accepted = await reconcileFromJournal(collector, {
    cycleId: 'cycle-1',
    readOperations: async cycleId => [
      event({ memo: 'memo-1', operationId: 'op-1', sequence: '1' }),
      event({ memo: 'other-project', operationId: 'op-2', sequence: '2' }), // dropped: no trusted record
      event({ cycleId, memo: 'memo-3', operationId: 'op-3', sequence: '3' }),
    ],
  });
  assert.equal(accepted, 2);
  assert.equal(collector.size(), 2);
});

test('reconcileFromJournal restores history after a restart (fresh collector, same durable operations)', async () => {
  const trusted = new Map([
    ['memo-1', { cycleId: 'cycle-1', operationId: 'op-1', packIndex: 0, mint: null, wallet: null }],
    ['memo-2', { cycleId: 'cycle-1', operationId: 'op-2', packIndex: 0, mint: null, wallet: null }],
  ]);
  const operations = [
    event({ memo: 'memo-1', operationId: 'op-1', sequence: '1' }),
    event({ memo: 'memo-2', operationId: 'op-2', sequence: '2' }),
  ];
  const before = createRecentWinnersCollector({ trustedOperations: trusted });
  await reconcileFromJournal(before, { cycleId: 'cycle-1', readOperations: async () => operations });
  assert.equal(before.size(), 2);

  // Simulate a process restart: a brand-new collector, reconciled from the same durable operations.
  const after = createRecentWinnersCollector({ trustedOperations: trusted });
  await reconcileFromJournal(after, { cycleId: 'cycle-1', readOperations: async () => operations });
  assert.deepEqual(after.list(), before.list());
});
