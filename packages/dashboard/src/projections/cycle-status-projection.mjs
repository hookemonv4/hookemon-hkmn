// Maps the runner's internal status projection (packages/runner/src/observability/
// status-projection.mjs's `projectCycleStatus`) onto the website's public cycle-status contract
// (contracts/public-cycle-status.mjs, schemaVersion 3). The internal projection is deliberately
// conservative — it carries a stage name and stage-completion counts for the active cycle, and
// (only when the caller supplied `projectCycleStatus`'s optional `readAccounting` seam — see
// routes/public.mjs's `ctx.readAccounting`, wired by compose.mjs to
// packages/adapters/src/app/accounting-projection.mjs) real per-cycle accounting derived from the
// durable stage journal. Card details and per-action timestamps still have no evidence path
// upstream of this package (see docs/modules/dashboard.md's "Known contract gaps"), so this module
// still never invents `cards`/`actions` for an active cycle — it reports the honest subset the
// runner actually knows and leaves the rest at the contract's own "nothing observed yet" values
// (`null`/`[]`), which is exactly what the validator in contracts/public-cycle-status.mjs already
// accepts.
import { readDashboardProfile } from '../contracts/dashboard-profile.mjs';
import { normalizePublicCycleStatus } from '../contracts/public-cycle-status.mjs';

/**
 * @param {object} input
 * @param {'testnet'|'mainnet'} input.profileId
 * @param {object} input.internalStatus - the object `projectCycleStatus` returns.
 * @param {{maxBoostersPerCycle: number}|null} [input.configuration] - the runner configuration
 *   supplied with the status projection. It sizes `maxBoostersPerCycle` for the public view.
 * @returns {object} a `PublicCycleStatus` (schemaVersion 3), already validated against
 *   `normalizePublicCycleStatus` — this function never returns a shape the website's own validator
 *   would reject.
 */
export function buildPublicCycleStatus({ profileId, internalStatus, configuration = null }) {
  const profile = readDashboardProfile(profileId);
  const generatedAt = internalStatus.generatedAt;
  const configured = internalStatus.intervalMinutes !== null;
  const executionState = !configured ? 'unknown' : (internalStatus.paused ? 'paused' : 'active');
  const executionReason = executionState === 'paused' ? 'operator-paused' : null;
  const nextCycleAt = internalStatus.nextRunAt
    ?? (configured
      ? new Date(Date.parse(generatedAt) + internalStatus.intervalMinutes * 60_000).toISOString()
      : generatedAt);
  const countdownSeconds = Math.ceil(Math.max(0, Date.parse(nextCycleAt) - Date.parse(generatedAt)) / 1_000);

  const status = {
    schemaVersion: 3,
    profile: profile.id,
    network: profile.network,
    executionState,
    executionReason,
    generatedAt,
    nextCycleAt,
    countdownSeconds,
    cycle: internalStatus.activeCycle ? buildPublicActiveCycle(internalStatus.activeCycle, configuration) : null,
  };
  return normalizePublicCycleStatus(status, profileId);
}

function buildPublicActiveCycle(activeCycle, configuration) {
  return {
    cycleId: activeCycle.cycleId,
    status: activeCycle.stage,
    selectedPackId: null,
    maxBoostersPerCycle: configuration ? configuration.maxBoostersPerCycle : null,
    plannedBoosters: 0,
    openedBoosters: 0,
    actions: [],
    cards: [],
    returnedMicroUsdg: null,
    rewardStatus: activeCycle.accounting ? activeCycle.accounting.distributionStatus : null,
    // `activeCycle.accounting` is present only when `projectCycleStatus` was called with a
    // `readAccounting` function (see this module's own header) — its shape is already exactly
    // `packages/adapters/src/app/accounting-projection.mjs`'s `RoundAccounting` output, which in turn
    // is exactly the shape `contracts/public-cycle-status.mjs`'s `readRoundAccounting` requires, so it
    // is passed straight through rather than re-mapped field by field.
    roundAccounting: activeCycle.accounting ?? null,
  };
}
