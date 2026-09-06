import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPublicCycleHistory } from '../../src/projections/cycle-history-projection.mjs';

const GENERATED_AT = '2026-01-01T00:10:00.000Z';

test('two completed cycles plus a third still-running one: history lists only the terminal two, deterministically ordered', () => {
  // The still-running third cycle is never part of terminalCycles (only terminal cycles are), the
  // same convention community-snapshot-projection.mjs uses.
  const history = buildPublicCycleHistory({
    profileId: 'mainnet',
    terminalCycles: [
      { cycleId: 'cycle-1', terminalState: 'COMPLETED', terminalAtMs: 1_000 },
      { cycleId: 'cycle-2', terminalState: 'COMPLETED', terminalAtMs: 5_000 },
    ],
    generatedAt: GENERATED_AT,
  });
  assert.equal(history.historyComplete, true);
  assert.deepEqual(history.items.map(item => item.cycleId), ['cycle-2', 'cycle-1']);
  assert.equal(history.nextCursor, null);
});

test('stable cursor pagination: page 1 (limit 1) returns a cursor that page 2 uses to continue', () => {
  const terminalCycles = [
    { cycleId: 'cycle-1', terminalState: 'COMPLETED', terminalAtMs: 1_000 },
    { cycleId: 'cycle-2', terminalState: 'COMPLETED', terminalAtMs: 2_000 },
    { cycleId: 'cycle-3', terminalState: 'COMPLETED', terminalAtMs: 3_000 },
  ];
  const page1 = buildPublicCycleHistory({ profileId: 'mainnet', terminalCycles, generatedAt: GENERATED_AT, limit: 1 });
  assert.deepEqual(page1.items.map(item => item.cycleId), ['cycle-3']);
  assert.notEqual(page1.nextCursor, null);

  const page2 = buildPublicCycleHistory({
    profileId: 'mainnet', terminalCycles, generatedAt: GENERATED_AT, limit: 1, cursor: page1.nextCursor,
  });
  assert.deepEqual(page2.items.map(item => item.cycleId), ['cycle-2']);
  assert.notEqual(page2.nextCursor, null);

  const page3 = buildPublicCycleHistory({
    profileId: 'mainnet', terminalCycles, generatedAt: GENERATED_AT, limit: 1, cursor: page2.nextCursor,
  });
  assert.deepEqual(page3.items.map(item => item.cycleId), ['cycle-1']);
  assert.equal(page3.nextCursor, null, 'no more pages after the oldest cycle');
});

test('a deterministic tie-break by cycleId applies when two cycles share the same terminalAtMs', () => {
  const history = buildPublicCycleHistory({
    profileId: 'mainnet',
    terminalCycles: [
      { cycleId: 'cycle-b', terminalState: 'COMPLETED', terminalAtMs: 5_000 },
      { cycleId: 'cycle-a', terminalState: 'COMPLETED', terminalAtMs: 5_000 },
    ],
    generatedAt: GENERATED_AT,
  });
  assert.deepEqual(history.items.map(item => item.cycleId), ['cycle-a', 'cycle-b']);
});

test('a repeated call with the same inputs produces the exact same page (stable order across calls)', () => {
  const terminalCycles = [
    { cycleId: 'cycle-1', terminalState: 'COMPLETED', terminalAtMs: 1_000 },
    { cycleId: 'cycle-2', terminalState: 'FAILED', terminalAtMs: 2_000 },
  ];
  const first = buildPublicCycleHistory({ profileId: 'mainnet', terminalCycles, generatedAt: GENERATED_AT });
  const second = buildPublicCycleHistory({ profileId: 'mainnet', terminalCycles: [...terminalCycles].reverse(), generatedAt: GENERATED_AT });
  assert.deepEqual(first.items, second.items);
});

test('an absent terminalAtMs on any cycle fails closed: empty items, no cursor, historyComplete false', () => {
  const history = buildPublicCycleHistory({
    profileId: 'mainnet',
    terminalCycles: [
      { cycleId: 'cycle-1', terminalState: 'COMPLETED', terminalAtMs: 1_000 },
      { cycleId: 'cycle-2', terminalState: 'COMPLETED' }, // no terminalAtMs
    ],
    generatedAt: GENERATED_AT,
  });
  assert.equal(history.historyComplete, false);
  assert.deepEqual(history.items, []);
  assert.equal(history.nextCursor, null);
});

test('a single terminal cycle without a terminalAtMs still fails closed (no cardinality shortcut for history, unlike latest-cycle selection)', () => {
  const history = buildPublicCycleHistory({
    profileId: 'mainnet',
    terminalCycles: [{ cycleId: 'cycle-1', terminalState: 'COMPLETED' }],
    generatedAt: GENERATED_AT,
  });
  assert.equal(history.historyComplete, false);
  assert.deepEqual(history.items, []);
});

test('an empty terminal-cycle set is historyComplete with no items', () => {
  const history = buildPublicCycleHistory({ profileId: 'mainnet', terminalCycles: [], generatedAt: GENERATED_AT });
  assert.equal(history.historyComplete, true);
  assert.deepEqual(history.items, []);
});

test('observation freshness: asOf is preserved separately from generatedAt and stays stale after a fresh re-request', () => {
  const staleAsOf = '2025-12-31T23:00:00.000Z';
  const history = buildPublicCycleHistory({
    profileId: 'mainnet',
    terminalCycles: [{ cycleId: 'cycle-1', terminalState: 'COMPLETED', terminalAtMs: 1_000 }],
    generatedAt: GENERATED_AT,
    asOf: staleAsOf,
  });
  assert.equal(history.generatedAt, GENERATED_AT);
  assert.equal(history.asOf, staleAsOf, 'a fresh HTTP response must not silently launder a stale source read into a fresh one');
});

test('rejects an out-of-range limit', () => {
  assert.throws(() => buildPublicCycleHistory({
    profileId: 'mainnet', terminalCycles: [], generatedAt: GENERATED_AT, limit: 21,
  }));
  assert.throws(() => buildPublicCycleHistory({
    profileId: 'mainnet', terminalCycles: [], generatedAt: GENERATED_AT, limit: 0,
  }));
});
