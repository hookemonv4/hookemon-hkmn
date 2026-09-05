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
    sequence: '0000000001',
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

test('assertPublicCardEvent rejects a malformed observation', () => {
  assert.throws(() => assertPublicCardEvent(event({ eventId: '' })), /eventId/);
  assert.throws(() => assertPublicCardEvent(event({ state: 'bogus' })), /state/);
  assert.throws(() => assertPublicCardEvent(event({ observedAt: 'not-a-date' })), /observedAt/);
});

test('ingest drops an observation whose memo is not one of this project\'s known memos', () => {
  const collector = createRecentWinnersCollector({ knownMemos: new Set(['hookemon-cycle-1']) });
  const result = collector.ingest(event({ memo: 'some-other-project-cycle-9' }));
  assert.equal(result, null);
  assert.equal(collector.size(), 0);
});

test('ingest drops an observation with a null memo (cannot attribute it to this project)', () => {
  const collector = createRecentWinnersCollector({ knownMemos: new Set(['hookemon-cycle-1']) });
  assert.equal(collector.ingest(event({ memo: null })), null);
  assert.equal(collector.size(), 0);
});

test('duplicate observations of the same durable identity collapse into one card', () => {
  const collector = createRecentWinnersCollector({ knownMemos: new Set(['hookemon-cycle-1']) });
  collector.ingest(event({ eventId: 'evt-a', sequence: '0000000001' }));
  collector.ingest(event({ eventId: 'evt-b', sequence: '0000000001' })); // same identity, different eventId
  assert.equal(collector.size(), 1);
  assert.equal(collector.list().length, 1);
});

test('an out-of-order lower-sequence duplicate does not regress a later observation', () => {
  const collector = createRecentWinnersCollector({ knownMemos: new Set(['hookemon-cycle-1']) });
  collector.ingest(event({ sequence: '0000000005', name: 'Later Name' }));
  const kept = collector.ingest(event({ sequence: '0000000002', name: 'Earlier Name (arrived late)' }));
  assert.equal(kept.name, 'Later Name');
  assert.equal(collector.list()[0].name, 'Later Name');
});

test('a finalized observation is never regressed back to observed by a later out-of-order "observed" duplicate', () => {
  const collector = createRecentWinnersCollector({ knownMemos: new Set(['hookemon-cycle-1']) });
  collector.ingest(event({ sequence: '0000000001', state: 'finalized', finalizedAt: '2026-01-01T00:05:00.000Z' }));
  const kept = collector.ingest(event({ sequence: '0000000009', state: 'observed', finalizedAt: null }));
  assert.equal(kept.state, 'finalized');
});

test('a card from a different operation/packIndex within the same cycle is a distinct card', () => {
  const collector = createRecentWinnersCollector({ knownMemos: new Set(['hookemon-cycle-1']) });
  collector.ingest(event({ operationId: 'op-1', packIndex: 0, sequence: '0000000001' }));
  collector.ingest(event({ operationId: 'op-1', packIndex: 1, sequence: '0000000002' }));
  assert.equal(collector.size(), 2);
});

test('list returns newest-sequence-first and respects limit', () => {
  const collector = createRecentWinnersCollector({ knownMemos: new Set(['hookemon-cycle-1']) });
  for (let index = 0; index < 5; index += 1) {
    collector.ingest(event({ operationId: `op-${index}`, sequence: String(index).padStart(10, '0'), eventId: `evt-${index}` }));
  }
  const listed = collector.list({ limit: 2 });
  assert.deepEqual(listed.map(item => item.operationId), ['op-4', 'op-3']);
});

test('retention evicts the oldest-sequence entries once maxRetained is exceeded', () => {
  const collector = createRecentWinnersCollector({ knownMemos: new Set(['hookemon-cycle-1']), maxRetained: 2 });
  collector.ingest(event({ operationId: 'op-0', sequence: '0000000000' }));
  collector.ingest(event({ operationId: 'op-1', sequence: '0000000001' }));
  collector.ingest(event({ operationId: 'op-2', sequence: '0000000002' }));
  assert.equal(collector.size(), 2);
  assert.deepEqual(collector.list().map(item => item.operationId), ['op-2', 'op-1']);
});

test('reconcileFromJournal ingests durable operations and reports how many were accepted', async () => {
  const collector = createRecentWinnersCollector({ knownMemos: new Set(['hookemon-cycle-1']) });
  const accepted = await reconcileFromJournal(collector, {
    cycleId: 'cycle-1',
    readOperations: async cycleId => [
      event({ operationId: 'op-1', sequence: '0000000001' }),
      event({ operationId: 'op-2', sequence: '0000000002', memo: 'other-project' }), // dropped
      event({ cycleId, operationId: 'op-3', sequence: '0000000003' }),
    ],
  });
  assert.equal(accepted, 2);
  assert.equal(collector.size(), 2);
});

test('reconcileFromJournal restores history after a restart (fresh collector, same durable operations)', async () => {
  const knownMemos = new Set(['hookemon-cycle-1']);
  const operations = [
    event({ operationId: 'op-1', sequence: '0000000001' }),
    event({ operationId: 'op-2', sequence: '0000000002' }),
  ];
  const before = createRecentWinnersCollector({ knownMemos });
  await reconcileFromJournal(before, { cycleId: 'cycle-1', readOperations: async () => operations });
  assert.equal(before.size(), 2);

  // Simulate a process restart: a brand-new collector, reconciled from the same durable source.
  const after = createRecentWinnersCollector({ knownMemos });
  await reconcileFromJournal(after, { cycleId: 'cycle-1', readOperations: async () => operations });
  assert.deepEqual(after.list(), before.list());
});
