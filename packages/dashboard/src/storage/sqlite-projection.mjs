// Read-optimized `node:sqlite` projection (design section "Storage": "Dashboard-only concerns
// (cycle-history pagination, cached pack catalog) may use node:sqlite as a read-optimized projection
// rebuilt from the journal, never as a second source of truth for money state."). This module owns
// two tables:
//   - `audit_entries`: a queryable mirror of the hash-chained append-only audit log
//     (auth/audit-log.mjs is the durable source of truth; this table exists only so
//     `/operator/api/audit` can page through it with a SQL query instead of re-reading and
//     re-parsing the whole log file on every request).
//   - `cards`: a queryable mirror of revealed-card history, keyed by (cycleId, packIndex), so
//     `/operator/api/cards` and the community snapshot's "last 12 cards" can filter/sort/paginate
//     without scanning the full durable history on every request.
// Both tables are fully rebuildable: `rebuildAuditProjection` truncates and re-derives `audit_entries`
// from `auth/audit-log.mjs`'s `readAllAuditEntries`, and `upsertCard`/card reads never touch anything
// this service could not re-derive from the durable journal if the sqlite file were deleted. Losing
// this file is a (rebuildable) inconvenience, never data loss.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS audit_entries (
  sequence INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  result_code TEXT NOT NULL,
  observed_version INTEGER NOT NULL,
  note TEXT,
  request_id TEXT,
  command_digest TEXT
);
CREATE TABLE IF NOT EXISTS cards (
  cycle_id TEXT NOT NULL,
  pack_index INTEGER NOT NULL,
  product_id TEXT NOT NULL,
  rarity TEXT NOT NULL,
  nft_address TEXT,
  card_name TEXT,
  set_name TEXT,
  card_number TEXT,
  image_url TEXT,
  pack_price_micro_usdg TEXT,
  buyback_micro_usdg TEXT,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (cycle_id, pack_index)
);
CREATE INDEX IF NOT EXISTS cards_observed_at_idx ON cards (observed_at DESC);
CREATE INDEX IF NOT EXISTS cards_buyback_idx ON cards (CAST(buyback_micro_usdg AS INTEGER));
`;

function migrateAuditReceiptColumns(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(audit_entries)').all().map(column => column.name));
  if (!columns.has('request_id')) db.exec('ALTER TABLE audit_entries ADD COLUMN request_id TEXT');
  if (!columns.has('command_digest')) db.exec('ALTER TABLE audit_entries ADD COLUMN command_digest TEXT');
}

/** Open (creating the parent directory and schema if needed) the sqlite projection at `path`, or an
 * in-memory database when `path` is `':memory:'` (tests). Returns the projection API; call `close()`
 * when done. */
export function openSqliteProjection(path) {
  if (typeof path !== 'string' || path.length === 0) throw new Error('openSqliteProjection requires a path');
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrateAuditReceiptColumns(db);

  const insertAudit = db.prepare(`
    INSERT INTO audit_entries (sequence, event_id, occurred_at, actor_email, actor_role, action, outcome, result_code, observed_version, note, request_id, command_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(sequence) DO NOTHING
  `);
  const selectAuditPage = db.prepare(`
    SELECT * FROM audit_entries
    WHERE (:cursor IS NULL OR sequence < :cursor)
    ORDER BY sequence DESC
    LIMIT :limit
  `);
  const deleteAllAudit = db.prepare('DELETE FROM audit_entries');

  const upsertCardStmt = db.prepare(`
    INSERT INTO cards (cycle_id, pack_index, product_id, rarity, nft_address, card_name, set_name, card_number, image_url, pack_price_micro_usdg, buyback_micro_usdg, observed_at)
    VALUES (:cycleId, :packIndex, :productId, :rarity, :nftAddress, :cardName, :setName, :cardNumber, :imageUrl, :packPriceMicroUsdg, :buybackMicroUsdg, :observedAt)
    ON CONFLICT(cycle_id, pack_index) DO UPDATE SET
      product_id = excluded.product_id, rarity = excluded.rarity, nft_address = excluded.nft_address,
      card_name = excluded.card_name, set_name = excluded.set_name, card_number = excluded.card_number,
      image_url = excluded.image_url, pack_price_micro_usdg = excluded.pack_price_micro_usdg,
      buyback_micro_usdg = excluded.buyback_micro_usdg, observed_at = excluded.observed_at
  `);
  const deleteAllCards = db.prepare('DELETE FROM cards');
  const countCards = db.prepare('SELECT COUNT(*) AS total FROM cards');

  function rowToAuditEntry(row) {
    return {
      sequence: row.sequence,
      eventId: row.event_id,
      occurredAt: row.occurred_at,
      actor: { email: row.actor_email },
      actorRole: row.actor_role,
      action: row.action,
      outcome: row.outcome,
      resultCode: row.result_code,
      observedVersion: row.observed_version,
      note: row.note,
      requestId: row.request_id,
      commandDigest: row.command_digest,
    };
  }

  function rowToCard(row) {
    return {
      cycleId: row.cycle_id,
      productId: row.product_id,
      rarity: row.rarity,
      nftAddress: row.nft_address,
      cardName: row.card_name,
      setName: row.set_name,
      cardNumber: row.card_number,
      imageUrl: row.image_url,
      packPriceMicroUsdg: row.pack_price_micro_usdg,
      buybackMicroUsdg: row.buyback_micro_usdg,
      packIndex: row.pack_index,
      observedAt: row.observed_at,
    };
  }

  return {
    /** Replace the entire `audit_entries` table with `entries` (already-verified, in append order —
     * see auth/audit-log.mjs's `readAllAuditEntries`). Called once at startup and again whenever a
     * caller wants to force a rebuild from the durable log. */
    rebuildAuditProjection(entries) {
      db.exec('BEGIN');
      try {
        deleteAllAudit.run();
        for (const entry of entries) {
          insertAudit.run(
            entry.sequence, entry.eventId, entry.occurredAt, entry.actor.email, entry.actorRole,
            entry.action, entry.outcome, entry.resultCode, entry.observedVersion, entry.note,
            entry.requestId ?? null, entry.commandDigest ?? null,
          );
        }
        db.exec('COMMIT');
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    /** Append one already-durably-written audit entry to the projection (the common case: the audit
     * log itself is written first, then this keeps the projection in sync without a full rebuild). */
    appendAuditEntry(entry) {
      insertAudit.run(
        entry.sequence, entry.eventId, entry.occurredAt, entry.actor.email, entry.actorRole,
        entry.action, entry.outcome, entry.resultCode, entry.observedVersion, entry.note,
        entry.requestId ?? null, entry.commandDigest ?? null,
      );
    },

    /** Page through audit entries, most recent first. `cursor` (a sequence number) returns entries
     * strictly older than it; `limit` defaults to 25, capped at 100 (matching the Worker's own
     * `/operator/api/audit` query-parameter cap). Returns `{ decisions, nextCursor }` where
     * `nextCursor` is the oldest returned entry's sequence (there may be more before it), or `null`
     * when the page reached the beginning of the log. */
    listAuditEntries({ cursor = null, limit = 25 } = {}) {
      const boundedLimit = Math.max(1, Math.min(100, limit));
      const rows = selectAuditPage.all({ cursor, limit: boundedLimit });
      const decisions = rows.map(rowToAuditEntry);
      const nextCursor = decisions.length === boundedLimit ? decisions.at(-1).sequence : null;
      return { decisions, nextCursor };
    },

    /** Insert or replace one card's projection row. */
    upsertCard(card) {
      upsertCardStmt.run({
        cycleId: card.cycleId,
        packIndex: card.packIndex,
        productId: card.productId,
        rarity: card.rarity,
        nftAddress: card.nftAddress,
        cardName: card.cardName,
        setName: card.setName,
        cardNumber: card.cardNumber,
        imageUrl: card.imageUrl,
        packPriceMicroUsdg: card.packPriceMicroUsdg,
        buybackMicroUsdg: card.buybackMicroUsdg,
        observedAt: card.observedAt,
      });
    },

    /** Clear the `cards` table (used before a full rebuild from the durable journal). */
    clearCards() {
      deleteAllCards.run();
    },

    /** Total number of projected card rows (used for `historyComplete`). */
    countCards() {
      return countCards.get().total;
    },

    /** Query cards with the same filter/sort/cursor contract the Worker enforces on
     * `/operator/api/cards` (apps/web/worker/operator-proxy.ts's `cardQueryValid`): `productId`,
     * `rarity`, `from`/`to` (ISO timestamps on `observedAt`), `minBuybackMicroUsdg`/
     * `maxBuybackMicroUsdg`, `sort` (`recent` | `buyback-desc` | `buyback-asc`), `cursor`/`limit`. */
    listCards({
      productId = null, rarity = null, from = null, to = null,
      minBuybackMicroUsdg = null, maxBuybackMicroUsdg = null, sort = 'recent',
      cursor = null, limit = 20,
    } = {}) {
      const boundedLimit = Math.max(1, Math.min(50, limit));
      const clauses = [];
      const params = {};
      if (productId !== null) { clauses.push('product_id = :productId'); params.productId = productId; }
      if (rarity !== null) { clauses.push('rarity = :rarity'); params.rarity = rarity; }
      if (from !== null) { clauses.push('observed_at >= :from'); params.from = from; }
      if (to !== null) { clauses.push('observed_at <= :to'); params.to = to; }
      if (minBuybackMicroUsdg !== null) {
        clauses.push('CAST(buyback_micro_usdg AS INTEGER) >= :minBuyback');
        params.minBuyback = Number(minBuybackMicroUsdg);
      }
      if (maxBuybackMicroUsdg !== null) {
        clauses.push('CAST(buyback_micro_usdg AS INTEGER) <= :maxBuyback');
        params.maxBuyback = Number(maxBuybackMicroUsdg);
      }
      const orderColumn = sort === 'buyback-desc' || sort === 'buyback-asc'
        ? 'CAST(buyback_micro_usdg AS INTEGER)'
        : 'observed_at';
      const orderDirection = sort === 'buyback-asc' ? 'ASC' : 'DESC';
      const cursorColumn = orderColumn;
      if (cursor !== null) {
        const comparator = orderDirection === 'DESC' ? '<' : '>';
        clauses.push(`${cursorColumn} ${comparator} :cursor`);
        params.cursor = sort === 'buyback-desc' || sort === 'buyback-asc' ? Number(cursor) : cursor;
      }
      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const sql = `SELECT * FROM cards ${where} ORDER BY ${orderColumn} ${orderDirection}, cycle_id ${orderDirection}, pack_index ${orderDirection} LIMIT :limit`;
      const rows = db.prepare(sql).all({ ...params, limit: boundedLimit });
      const cards = rows.map(rowToCard);
      const nextCursor = cards.length === boundedLimit
        ? String(sort === 'buyback-desc' || sort === 'buyback-asc' ? Number(cards.at(-1).buybackMicroUsdg ?? '0') : cards.at(-1).observedAt)
        : null;
      return { cards, nextCursor };
    },

    close() {
      db.close();
    },
  };
}
