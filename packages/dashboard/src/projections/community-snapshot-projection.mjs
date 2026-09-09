import { nativeUnknownFields } from '../contracts/native-accounting.mjs';
// Maps terminal cycle facts supplied by the repository-backed operator authority onto the website's
// public community-dashboard contract (contracts/public-community-snapshot.mjs, schemaVersion 8).
// Lifetime aggregate amounts have no durable accounting-index producer anywhere in this codebase, so
// they are honestly `null` (F-sol-review correction: a required `'0'` would be indistinguishable
// from a verified zero history) rather than being reconstructed from incomplete lifecycle data.
// `latestCycle.roundAccounting` is read through the optional composed accounting seam for one
// unambiguously selected repository cycle. `cards` is read through the optional `recentWinners` seam
// — real, already-deduplicated `PublicCardEvent`s (see recent-winners.mjs), the same "optional live
// capability the composition root wires in" pattern `readAccounting` already uses.
import { readDashboardProfile } from '../contracts/dashboard-profile.mjs';
import { normalizePublicCommunitySnapshot } from '../contracts/public-community-snapshot.mjs';

const MAX_CARDS = 12; // must match public-community-snapshot.mjs's own MAX_CARDS.

const UNKNOWN_METRICS = Object.freeze({
  latestObservedProjectPoolMicroUsdg: null,
  totalCycleFundingMicroUsdg: null,
  totalCollectorSpendMicroUsdg: null,
  totalBuybacksReturnedMicroUsdg: null,
  totalBridgedBackMicroUsdg: null,
  totalRewardsPaidMicroUsdg: null,
  totalRewardsDeferredMicroUsdg: null,
  totalQuotedOperatingCostsMicroUsdg: null,
  latestRetainedReserveMicroUsdg: null,
  latestCycleReserveTargetMicroUsdg: null,
});

const repositoryTerminalStatus = Object.freeze({
  COMPLETE: 'paid-out',
  COMPLETED: 'paid-out',
  FAILED: 'failed',
  HELD_DATA_UNVERIFIED: 'held-data-unverified',
  HELD_UNAVAILABLE: 'held-unavailable',
  HELD_OWNER_DECISION: 'held-owner-decision',
});

/**
 * @param {object} input
 * @param {'testnet'|'mainnet'} input.profileId
 * @param {Array<object>} input.repositoryCycles - every terminal cycle from
 *   `operatorControl.status()` (not pre-filtered to one). Selecting "the latest" among two or more
 *   requires each cycle to carry a `terminalAtMs` (non-negative integer epoch-ms) field — the exact
 *   producer field requested from task C via C-inbox.md, not yet emitted by any real
 *   `operatorControl` implementation in this codebase. When every cycle in the array carries a valid
 *   `terminalAtMs`, the latest is the maximum by that field (ties broken by `cycleId` ascending, for
 *   a fully deterministic order); when any cycle is missing it and there are two or more, `latestCycle`
 *   is honestly `null` and `historyComplete` is `false` — never a guess from array order or an
 *   identifier. A single terminal cycle is unambiguous regardless of `terminalAtMs`.
 * @param {string} input.generatedAt - ISO timestamp.
 * @param {string|null} [input.nextCycleAt] - ISO timestamp or null (matches the cycle-status
 *   projection's own `nextCycleAt`, or null when no configuration has been written yet).
 * @param {number} [input.completedCycles] - a real derived count (paidOut count from the internal
 *   status projection's `totals`); defaults to `0`, itself a real fact ("no cycles have completed
 *   yet"), never fabricated.
 * @param {number|null} [input.skippedCycles] @param {number|null} [input.openedPacks] - not tracked
 *   anywhere in this integration head; default `null` (unknown), never a fabricated `0`.
 * @param {(cycleId: string) => Promise<object>} [input.readAccounting] - entirely optional; when
 *   supplied, called once for the most recent terminal cycle (if any) and attached as
 *   `latestCycle.roundAccounting` — typically `packages/adapters/src/app/accounting-projection.mjs`'s
 *   `projectCycleAccounting` bound to the live `cycleRepository`. Omitted, `latestCycle.roundAccounting`
 *   stays `null`, exactly as before this parameter existed.
 * @param {Array<object>} [input.recentWinners] - already-collected, already-deduplicated
 *   `PublicCardEvent`s (typically `packages/adapters/src/collector/recent-winners.mjs`'s
 *   `createRecentWinnersCollector().list()` output) — real observations only, never fabricated.
 *   Passed straight through as `cards`, newest-first, bounded to the contract's own card limit.
 *   Omitted, `cards` stays `[]`, exactly as before this parameter existed.
 * @returns {Promise<object>} a `PublicCommunitySnapshot` (schemaVersion 8), already validated.
 */
export async function buildPublicCommunitySnapshot({
  profileId,
  repositoryCycles,
  generatedAt,
  nextCycleAt = null,
  completedCycles = 0,
  skippedCycles = null,
  openedPacks = null,
  readAccounting = null,
  heldPositions = [],
  recentWinners = [],
}) {
  const profile = readDashboardProfile(profileId);
  const { latest: latestTerminal, historyComplete } = selectLatestTerminalCycle(repositoryCycles);

  const latestCycle = latestTerminal ? await buildLatestCycle(latestTerminal, readAccounting) : null;
  const native = latestCycle?.roundAccounting?.schema === 'hookemon.native-round-accounting.v1';
  if (native) { delete latestCycle.paidMicroUsdg; latestCycle.paidWei = latestCycle.roundAccounting.paidHolderRewardsWei; }
  const snapshot = {
    schemaVersion: native ? 9 : 8,
    profile: profile.id,
    badge: profile.badge,
    network: profile.network,
    historyComplete,
    generatedAt,
    nextCycleAt,
    delayed: false,
    poolObservedAt: null,
    metrics: { ...(native ? nativeUnknownFields(UNKNOWN_METRICS) : UNKNOWN_METRICS), completedCycles, skippedCycles, openedPacks },
    latestCycle,
    cards: Array.isArray(recentWinners) ? recentWinners.slice(0, MAX_CARDS) : [],
    heldPositionCount: heldPositions.length,
    heldPositions,
  };
  return normalizePublicCommunitySnapshot(snapshot, profileId);
}

/** See `buildPublicCommunitySnapshot`'s own `repositoryCycles` doc for the exact rule. Never mutates
 * or reorders the caller's array; returns a fresh sorted copy only when a deterministic order is
 * actually provable. */
function selectLatestTerminalCycle(repositoryCycles) {
  if (repositoryCycles.length === 0) return { latest: null, historyComplete: true };
  if (repositoryCycles.length === 1) return { latest: repositoryCycles[0], historyComplete: true };
  const allTimestamped = repositoryCycles.every(
    cycle => Number.isSafeInteger(cycle?.terminalAtMs) && cycle.terminalAtMs >= 0,
  );
  if (!allTimestamped) return { latest: null, historyComplete: false };
  const sorted = [...repositoryCycles].sort(
    (left, right) => right.terminalAtMs - left.terminalAtMs || left.cycleId.localeCompare(right.cycleId),
  );
  return { latest: sorted[0], historyComplete: true };
}

async function buildLatestCycle(repositoryCycle, readAccounting) {
  const roundAccounting = typeof readAccounting === 'function' ? await readAccounting(repositoryCycle.cycleId) : null;
  return {
    cycleId: repositoryCycle.cycleId,
    status: repositoryTerminalStatus[repositoryCycle.terminalState] ?? 'unknown',
    reason: null,
    updatedAt: null,
    paidMicroUsdg: null,
    // The real finalized-recipient count, when accounting evidence has it (see
    // accounting-projection.mjs's projectPayoutEvidence) — never a fabricated 0.
    payoutRecipientCount: roundAccounting?.paidHolderRewardsRecipientCount ?? null,
    // Historic cycles retain all-holder semantics without a frozen selection.
    rewardRecipientLimit: repositoryCycle.rewardSelection?.rewardRecipientLimit ?? null,
    roundAccounting,
    transactions: [],
  };
}
