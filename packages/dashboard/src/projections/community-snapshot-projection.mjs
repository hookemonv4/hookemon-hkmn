// Maps terminal cycle facts supplied by the repository-backed operator authority onto the website's
// public community-dashboard contract (contracts/public-community-snapshot.mjs, schemaVersion 5).
// Lifetime aggregate amounts have no accounting-index evidence path, so they remain zero rather than
// being reconstructed from incomplete lifecycle data. `latestCycle.roundAccounting` is read through
// the optional composed accounting seam for one unambiguously selected repository cycle.
import { readDashboardProfile } from '../contracts/dashboard-profile.mjs';
import { normalizePublicCommunitySnapshot } from '../contracts/public-community-snapshot.mjs';

const ZERO_METRICS = Object.freeze({
  latestObservedProjectPoolMicroUsdg: null,
  totalCycleFundingMicroUsdg: '0',
  totalCollectorSpendMicroUsdg: '0',
  totalBuybacksReturnedMicroUsdg: '0',
  totalBridgedBackMicroUsdg: '0',
  totalRewardsPaidMicroUsdg: '0',
  totalRewardsDeferredMicroUsdg: '0',
  totalQuotedOperatingCostsMicroUsdg: '0',
  latestRetainedReserveMicroUsdg: '0',
  latestCycleReserveTargetMicroUsdg: '0',
});

/** The reward-recipient-limit feature (a configurable payout batch size the legacy site exposes)
 * has no equivalent field in this integration head's operator configuration
 * (packages/runner/src/config/state-schema.mjs). This fixed value is a PLACEHOLDER_OWNER_DECISION:
 * it satisfies the contract's `recipientLimit` validator (must be 50 or a multiple of 100 in
 * [100,1000]) without asserting a real configured limit. Whichever work package wires holder-reward
 * chunking should replace this with the real configured value. */
const PLACEHOLDER_REWARD_RECIPIENT_LIMIT = 200;

const repositoryTerminalStatus = Object.freeze({
  COMPLETED: 'paid-out',
  FAILED: 'failed',
  HELD_DATA_UNVERIFIED: 'held-data-unverified',
  HELD_UNAVAILABLE: 'held-unavailable',
  HELD_OWNER_DECISION: 'held-owner-decision',
});

/**
 * @param {object} input
 * @param {'testnet'|'mainnet'} input.profileId
 * @param {Array<object>} input.repositoryCycles - terminal cycles from `operatorControl.status()`.
 * @param {string} input.generatedAt - ISO timestamp.
 * @param {string|null} [input.nextCycleAt] - ISO timestamp or null (matches the cycle-status
 *   projection's own `nextCycleAt`, or null when no configuration has been written yet).
 * @param {number} [input.completedCycles] @param {number} [input.skippedCycles]
 *   @param {number} [input.openedPacks] - from the internal status projection's `totals` (paidOut
 *   count doubles as `completedCycles`; `skippedCycles`/`openedPacks` are not tracked anywhere in
 *   this integration head yet and default to 0 — honestly, not fabricated).
 * @param {(cycleId: string) => Promise<object>} [input.readAccounting] - entirely optional; when
 *   supplied, called once for the most recent terminal cycle (if any) and attached as
 *   `latestCycle.roundAccounting` — typically `packages/adapters/src/app/accounting-projection.mjs`'s
 *   `projectCycleAccounting` bound to the live `cycleRepository`. Omitted, `latestCycle.roundAccounting`
 *   stays `null`, exactly as before this parameter existed.
 * @returns {Promise<object>} a `PublicCommunitySnapshot` (schemaVersion 5), already validated.
 */
export async function buildPublicCommunitySnapshot({
  profileId,
  repositoryCycles,
  generatedAt,
  nextCycleAt = null,
  completedCycles = 0,
  skippedCycles = 0,
  openedPacks = 0,
  readAccounting = null,
}) {
  const profile = readDashboardProfile(profileId);
  const latestTerminal = repositoryCycles.length > 0 ? repositoryCycles.at(-1) : null;

  const snapshot = {
    schemaVersion: 5,
    profile: profile.id,
    badge: profile.badge,
    network: profile.network,
    historyComplete: true,
    generatedAt,
    nextCycleAt,
    delayed: false,
    poolObservedAt: null,
    metrics: { ...ZERO_METRICS, completedCycles, skippedCycles, openedPacks },
    latestCycle: latestTerminal ? await buildLatestCycle(latestTerminal, readAccounting) : null,
    cards: [],
  };
  return normalizePublicCommunitySnapshot(snapshot, profileId);
}

async function buildLatestCycle(repositoryCycle, readAccounting) {
  const roundAccounting = typeof readAccounting === 'function' ? await readAccounting(repositoryCycle.cycleId) : null;
  return {
    cycleId: repositoryCycle.cycleId,
    status: repositoryTerminalStatus[repositoryCycle.terminalState] ?? 'unknown',
    reason: null,
    updatedAt: null,
    paidMicroUsdg: null,
    payoutRecipientCount: 0,
    rewardRecipientLimit: PLACEHOLDER_REWARD_RECIPIENT_LIMIT,
    roundAccounting,
    transactions: [],
  };
}
