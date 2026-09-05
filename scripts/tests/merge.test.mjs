import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger, mergeEnqueue, mergeNext, mergeRecord } from '../lib/ledger.mjs';

test('merge queue is serialized and demands retest when integration HEAD moved', () => {
  const db = openLedger(mkdtempSync(join(tmpdir(), 'v4-')));
  const a = mergeEnqueue(db, { taskId: 'T1', candidateSha: 'c1', integrationSha: 'main1' });
  const b = mergeEnqueue(db, { taskId: 'T2', candidateSha: 'c2', integrationSha: 'main1' });
  assert.equal(mergeNext(db).seq, a);
  assert.equal(mergeRecord(db, a, { mergedSha: 'm1', currentIntegrationSha: 'main1' }), 'merged');
  assert.equal(mergeNext(db).seq, b);
  assert.equal(mergeRecord(db, b, { mergedSha: null, currentIntegrationSha: 'm1' }), 'retest');
  assert.equal(mergeNext(db), null);
  const c = mergeEnqueue(db, { taskId: 'T2', candidateSha: 'c2r', integrationSha: 'm1' });
  assert.equal(mergeRecord(db, c, { mergedSha: 'm2', currentIntegrationSha: 'm1' }), 'merged');
});
