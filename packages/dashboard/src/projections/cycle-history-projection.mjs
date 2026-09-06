// Builds the paginated public cycle-history response (contracts/public-cycle-history.mjs,
// schemaVersion 1) from the same terminal-cycle list community-snapshot-projection.mjs consumes.
// Ordering/pagination requires every terminal cycle to carry a verified `terminalAtMs` — if even one
// is missing, the entire result fails closed (see this module's own header comment in the contract)
// rather than silently ordering the reachable subset.
import { readDashboardProfile } from '../contracts/dashboard-profile.mjs';
import {
  decodeHistoryCursor,
  encodeHistoryCursor,
  MAX_HISTORY_PAGE_SIZE,
  normalizePublicCycleHistory,
} from '../contracts/public-cycle-history.mjs';

const repositoryTerminalStatus = Object.freeze({
  COMPLETE: 'paid-out',
  COMPLETED: 'paid-out',
  FAILED: 'failed',
  HELD_DATA_UNVERIFIED: 'held-data-unverified',
  HELD_UNAVAILABLE: 'held-unavailable',
  HELD_OWNER_DECISION: 'held-owner-decision',
});

function isTimestamped(cycle) {
  return Number.isSafeInteger(cycle?.terminalAtMs) && cycle.terminalAtMs >= 0
    && typeof cycle?.cycleId === 'string' && cycle.cycleId.length > 0;
}

function compareDesc(left, right) {
  return right.terminalAtMs - left.terminalAtMs || left.cycleId.localeCompare(right.cycleId);
}

function isAfterCursor(cycle, cursor) {
  if (cycle.terminalAtMs !== cursor.terminalAtMs) return cycle.terminalAtMs < cursor.terminalAtMs;
  return cycle.cycleId.localeCompare(cursor.cycleId) > 0;
}

/**
 * @param {object} input
 * @param {'testnet'|'mainnet'} input.profileId
 * @param {Array<object>} input.terminalCycles - every terminal cycle from `operatorControl.status()`
 *   (the same list `routes/public.mjs`'s `readAuthorityProjection` already computes). Each cycle
 *   should carry `cycleId`, `terminalState`, and (once C's producer exists) `terminalAtMs` /
 *   `updatedAtMs`.
 * @param {string} input.generatedAt - ISO timestamp (HTTP response creation time).
 * @param {string} [input.asOf] - ISO timestamp for when `terminalCycles` was actually observed;
 *   defaults to `generatedAt` when the caller has no separate freshness source. Kept distinct so a
 *   client can detect a stale upstream read even when the response itself is freshly served.
 * @param {number} [input.limit] - page size, 1..20 (MAX_HISTORY_PAGE_SIZE).
 * @param {string|null} [input.cursor] - an opaque cursor from a previous page's `nextCursor`.
 * @returns {object} a `PublicCycleHistory` (schemaVersion 1), already validated.
 */
export function buildPublicCycleHistory({
  profileId,
  terminalCycles,
  generatedAt,
  asOf = generatedAt,
  limit = 10,
  cursor = null,
}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_HISTORY_PAGE_SIZE) {
    throw new TypeError('PUBLIC_CYCLE_HISTORY_INVALID');
  }
  const profile = readDashboardProfile(profileId);

  const response = {
    schemaVersion: 1,
    profile: profile.id,
    network: profile.network,
    generatedAt,
    asOf,
    historyComplete: true,
    items: [],
    nextCursor: null,
  };

  if (terminalCycles.length === 0) return normalizePublicCycleHistory(response, profileId);

  if (!terminalCycles.every(isTimestamped)) {
    // At least one terminal cycle has no verified terminalAtMs: order/completeness cannot be
    // proven for the set as a whole, so the whole response fails closed rather than silently
    // ordering only the reachable subset and hiding the gap.
    response.historyComplete = false;
    return normalizePublicCycleHistory(response, profileId);
  }

  const sorted = [...terminalCycles].sort(compareDesc);
  const startIndex = cursor === null ? 0 : sorted.findIndex(cycle => isAfterCursor(cycle, decodeHistoryCursor(cursor)));
  const page = startIndex === -1 ? [] : sorted.slice(startIndex, startIndex + limit);

  response.items = page.map(cycle => ({
    cycleId: cycle.cycleId,
    status: repositoryTerminalStatus[cycle.terminalState] ?? 'unknown',
    terminalAt: new Date(cycle.terminalAtMs).toISOString(),
    updatedAt: Number.isSafeInteger(cycle.updatedAtMs) ? new Date(cycle.updatedAtMs).toISOString() : null,
  }));
  const lastIndex = startIndex === -1 ? -1 : startIndex + page.length;
  response.nextCursor = (lastIndex >= 0 && lastIndex < sorted.length)
    ? encodeHistoryCursor({ terminalAtMs: sorted[lastIndex - 1].terminalAtMs, cycleId: sorted[lastIndex - 1].cycleId })
    : null;

  return normalizePublicCycleHistory(response, profileId);
}
