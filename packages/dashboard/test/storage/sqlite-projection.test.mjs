import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openSqliteProjection } from '../../src/storage/sqlite-projection.mjs';

function auditEntry(sequence, overrides = {}) {
  return {
    sequence,
    eventId: `e${sequence}`,
    occurredAt: new Date(2026, 0, 1, 0, sequence).toISOString(),
    actor: { email: 'operator-console' },
    actorRole: 'operator',
    action: 'pause',
    outcome: 'accepted',
    resultCode: 'DECISION_ACCEPTED',
    observedVersion: sequence - 1,
    note: null,
    ...overrides,
  };
}

test('rebuildAuditProjection then listAuditEntries pages most-recent-first', () => {
  const proj = openSqliteProjection(':memory:');
  proj.rebuildAuditProjection([auditEntry(1), auditEntry(2), auditEntry(3)]);
  const page1 = proj.listAuditEntries({ limit: 2 });
  assert.deepEqual(page1.decisions.map(d => d.sequence), [3, 2]);
  assert.equal(page1.nextCursor, 2);
  const page2 = proj.listAuditEntries({ cursor: page1.nextCursor, limit: 2 });
  assert.deepEqual(page2.decisions.map(d => d.sequence), [1]);
  assert.equal(page2.nextCursor, null);
  proj.close();
});

test('appendAuditEntry keeps the projection in sync incrementally', () => {
  const proj = openSqliteProjection(':memory:');
  proj.appendAuditEntry(auditEntry(1));
  proj.appendAuditEntry(auditEntry(2));
  const { decisions } = proj.listAuditEntries({ limit: 10 });
  assert.equal(decisions.length, 2);
  proj.close();
});

test('audit projection preserves the durable request receipt fields', () => {
  const proj = openSqliteProjection(':memory:');
  proj.rebuildAuditProjection([
    auditEntry(1, {
      requestId: 'request-1',
      commandDigest: `sha256:${'a'.repeat(64)}`,
    }),
  ]);
  const { decisions } = proj.listAuditEntries({ limit: 10 });
  assert.equal(decisions[0].requestId, 'request-1');
  assert.equal(decisions[0].commandDigest, `sha256:${'a'.repeat(64)}`);
  proj.close();
});

test('opening a pre-request-receipt projection adds the request columns before rebuilding it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-dashboard-sqlite-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'projection.sqlite');
  const legacy = new DatabaseSync(path);
  legacy.exec(`
    CREATE TABLE audit_entries (
      sequence INTEGER PRIMARY KEY,
      event_id TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      actor_email TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      outcome TEXT NOT NULL,
      result_code TEXT NOT NULL,
      observed_version INTEGER NOT NULL,
      note TEXT
    );
  `);
  legacy.close();

  const proj = openSqliteProjection(path);
  proj.rebuildAuditProjection([
    auditEntry(1, {
      requestId: 'request-legacy',
      commandDigest: `sha256:${'b'.repeat(64)}`,
    }),
  ]);
  assert.equal(proj.listAuditEntries({ limit: 1 }).decisions[0].requestId, 'request-legacy');
  proj.close();
});

function card(cycleId, packIndex, overrides = {}) {
  return {
    cycleId, packIndex,
    productId: overrides.productId ?? 'p1',
    rarity: overrides.rarity ?? 'common',
    nftAddress: null, cardName: null, setName: null, cardNumber: null, imageUrl: null,
    packPriceMicroUsdg: overrides.packPriceMicroUsdg ?? '1000000',
    buybackMicroUsdg: overrides.buybackMicroUsdg ?? '500000',
    observedAt: overrides.observedAt ?? new Date(2026, 0, 1, 0, packIndex).toISOString(),
  };
}

test('listCards filters by productId and rarity', () => {
  const proj = openSqliteProjection(':memory:');
  proj.upsertCard(card('c1', 0, { productId: 'rare-pack', rarity: 'legendary' }));
  proj.upsertCard(card('c1', 1, { productId: 'common-pack', rarity: 'common' }));
  const byProduct = proj.listCards({ productId: 'rare-pack', limit: 10 });
  assert.equal(byProduct.cards.length, 1);
  assert.equal(byProduct.cards[0].productId, 'rare-pack');
  const byRarity = proj.listCards({ rarity: 'common', limit: 10 });
  assert.equal(byRarity.cards.length, 1);
  proj.close();
});

test('listCards sorts by buyback-desc and buyback-asc', () => {
  const proj = openSqliteProjection(':memory:');
  proj.upsertCard(card('c1', 0, { buybackMicroUsdg: '100' }));
  proj.upsertCard(card('c1', 1, { buybackMicroUsdg: '900' }));
  proj.upsertCard(card('c1', 2, { buybackMicroUsdg: '500' }));
  const desc = proj.listCards({ sort: 'buyback-desc', limit: 10 });
  assert.deepEqual(desc.cards.map(c => c.buybackMicroUsdg), ['900', '500', '100']);
  const asc = proj.listCards({ sort: 'buyback-asc', limit: 10 });
  assert.deepEqual(asc.cards.map(c => c.buybackMicroUsdg), ['100', '500', '900']);
  proj.close();
});

test('listCards filters by min/max buyback range', () => {
  const proj = openSqliteProjection(':memory:');
  proj.upsertCard(card('c1', 0, { buybackMicroUsdg: '100' }));
  proj.upsertCard(card('c1', 1, { buybackMicroUsdg: '900' }));
  const { cards } = proj.listCards({ minBuybackMicroUsdg: '200', maxBuybackMicroUsdg: '1000', limit: 10 });
  assert.deepEqual(cards.map(c => c.buybackMicroUsdg), ['900']);
  proj.close();
});

test('upsertCard is idempotent on (cycleId, packIndex)', () => {
  const proj = openSqliteProjection(':memory:');
  proj.upsertCard(card('c1', 0, { rarity: 'common' }));
  proj.upsertCard(card('c1', 0, { rarity: 'legendary' }));
  assert.equal(proj.countCards(), 1);
  const { cards } = proj.listCards({ limit: 10 });
  assert.equal(cards[0].rarity, 'legendary');
  proj.close();
});
