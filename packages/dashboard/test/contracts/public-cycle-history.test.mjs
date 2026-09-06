import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readDashboardProfile } from '../../src/contracts/dashboard-profile.mjs';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  normalizePublicCycleHistory,
} from '../../src/contracts/public-cycle-history.mjs';

function baseResponse(profileId = 'mainnet') {
  const profile = readDashboardProfile(profileId);
  return {
    schemaVersion: 1,
    profile: profileId,
    network: profile.network,
    generatedAt: '2026-01-01T00:00:00.000Z',
    asOf: '2026-01-01T00:00:00.000Z',
    historyComplete: true,
    items: [],
    nextCursor: null,
  };
}

test('accepts a well-formed empty history', () => {
  const result = normalizePublicCycleHistory(baseResponse(), 'mainnet');
  assert.equal(result.items.length, 0);
  assert.equal(result.nextCursor, null);
});

test('rejects asOf after generatedAt (stale-source honesty)', () => {
  const input = baseResponse();
  input.asOf = '2026-01-01T00:05:00.000Z';
  assert.throws(() => normalizePublicCycleHistory(input, 'mainnet'));
});

test('accepts two items in descending terminalAt order', () => {
  const input = baseResponse();
  input.items = [
    { cycleId: 'cycle-2', status: 'paid-out', terminalAt: '2026-01-01T00:00:05.000Z', updatedAt: null },
    { cycleId: 'cycle-1', status: 'paid-out', terminalAt: '2026-01-01T00:00:01.000Z', updatedAt: null },
  ];
  const result = normalizePublicCycleHistory(input, 'mainnet');
  assert.equal(result.items.length, 2);
});

test('rejects items out of descending terminalAt order', () => {
  const input = baseResponse();
  input.items = [
    { cycleId: 'cycle-1', status: 'paid-out', terminalAt: '2026-01-01T00:00:01.000Z', updatedAt: null },
    { cycleId: 'cycle-2', status: 'paid-out', terminalAt: '2026-01-01T00:00:05.000Z', updatedAt: null },
  ];
  assert.throws(() => normalizePublicCycleHistory(input, 'mainnet'));
});

test('rejects a non-empty items array when historyComplete is false (fail-closed shape must be entirely empty)', () => {
  const input = baseResponse();
  input.historyComplete = false;
  input.items = [{ cycleId: 'cycle-1', status: 'paid-out', terminalAt: '2026-01-01T00:00:01.000Z', updatedAt: null }];
  assert.throws(() => normalizePublicCycleHistory(input, 'mainnet'));
});

test('rejects more than MAX_HISTORY_PAGE_SIZE items', () => {
  const input = baseResponse();
  input.items = Array.from({ length: 21 }, (_, index) => ({
    cycleId: `cycle-${index}`, status: 'paid-out',
    terminalAt: new Date(2026, 0, 1, 0, 0, 20 - index).toISOString(), updatedAt: null,
  }));
  assert.throws(() => normalizePublicCycleHistory(input, 'mainnet'));
});

test('encodeHistoryCursor/decodeHistoryCursor round-trip', () => {
  const cursor = encodeHistoryCursor({ terminalAtMs: 12345, cycleId: 'cycle-1' });
  assert.equal(typeof cursor, 'string');
  assert.deepEqual(decodeHistoryCursor(cursor), { terminalAtMs: 12345, cycleId: 'cycle-1' });
});

test('decodeHistoryCursor rejects a malformed cursor', () => {
  assert.throws(() => decodeHistoryCursor('not-a-real-cursor'));
  assert.throws(() => decodeHistoryCursor(Buffer.from(JSON.stringify({ t: -1, c: 'x' })).toString('base64url')));
});
