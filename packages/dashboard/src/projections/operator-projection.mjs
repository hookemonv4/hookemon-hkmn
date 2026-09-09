import { assertPackPlan } from '../../../runner/src/config/pack-plan.mjs';
import { nativeUnknownFields } from '../contracts/native-accounting.mjs';
// Maps the runner-owned operator-control status into the dashboard's compatibility read models.
// The dashboard receives a snapshot from `operatorControl.status()` and does not inspect a state
// file or a cycle repository itself. That keeps lifecycle facts on the one authority boundary.
import { createDefaultOperatorConfiguration, DEFAULT_INTERVAL_MINUTES } from '../../../runner/src/config/state-schema.mjs';
import { OPERATOR_HARD_CAPS } from '../../../runner/src/operator/state-file.mjs';

import { REWARD_RECIPIENT_LIMITS } from '../../../runner/src/config/reward-recipient-selection.mjs';
export { REWARD_RECIPIENT_LIMITS };

export const HARD_CAPS = Object.freeze({
  maxBoostersPerCycle: OPERATOR_HARD_CAPS.maxBoostersPerCycle,
  maxUnitPriceMicroUsd: OPERATOR_HARD_CAPS.maxUnitPriceMicroUsd,
  maxCycleBudgetMicroUsd: OPERATOR_HARD_CAPS.maxCycleBudgetMicroUsd,
  max24HourBudgetMicroUsd: OPERATOR_HARD_CAPS.max24HourBudgetMicroUsd,
});

function effectiveConfiguration(configuration) {
  return configuration ?? createDefaultOperatorConfiguration();
}

function isPaused(configuration) {
  return Boolean(configuration?.paused || configuration?.executionPaused || configuration?.killSwitch);
}

function mapOperatorState(configuration, revision) {
  const effective = effectiveConfiguration(configuration);
  return {
    version: revision,
    desiredStatus: effective.killSwitch ? 'killed' : (isPaused(effective) ? 'paused' : 'active'),
    allowedPackIds: effective.allowedPackIds,
    ...(effective.packPlan === undefined ? {} : { packPlan: assertPackPlan(effective.packPlan) }),
    requestedOrders: effective.requestedOrders,
    intervalMinutes: effective.intervalMinutes,
    manualPackOrders: effective.allowedPackIds.length === 1
      ? [{ productId: effective.allowedPackIds[0], quantity: effective.requestedOrders }]
      : [],
    maxBoostersPerCycle: effective.maxBoostersPerCycle,
    rewardRecipientLimit: effective.rewardRecipientLimit ?? null,
    cycleIntervalMinutes: effective.intervalMinutes,
    skipNextCycleSequence: 0,
    runNowSequence: 0,
    maxUnitPriceMicroUsd: effective.maxUnitPriceMicroUsd,
    maxCycleBudgetMicroUsd: effective.maxCycleBudgetMicroUsd,
    max24HourBudgetMicroUsd: effective.max24HourBudgetMicroUsd,
    configurationComplete: configuration !== null && configuration !== undefined && configuration.allowedPackIds.length > 0,
    executionConnected: false,
    liveMode: effective.liveMode === true,
  };
}

function activeCycle(authorityStatus) {
  if (!authorityStatus?.activeCycleId || !Array.isArray(authorityStatus.cycles)) return null;
  return authorityStatus.cycles.find(cycle => cycle?.cycleId === authorityStatus.activeCycleId) ?? null;
}

function visibleStage(cycle) {
  if (typeof cycle?.terminalState === 'string') return cycle.terminalState;
  if (!Array.isArray(cycle?.stages) || cycle.stages.length === 0) return 'UNKNOWN';
  return cycle.stages.find(stage => stage?.status !== 'COMPLETE')?.stage
    ?? cycle.stages.at(-1)?.stage
    ?? 'UNKNOWN';
}

function nextCycleAt(configuration, lastTick) {
  if (!configuration || !lastTick || !Number.isSafeInteger(lastTick.at) || !Number.isSafeInteger(lastTick.intervalMs)) return null;
  return new Date(lastTick.at + lastTick.intervalMs).toISOString();
}

function payoutStatus(cycle) {
  if (!cycle?.payout || typeof cycle.payout.status !== 'string') return null;
  return {
    status: cycle.payout.status,
    transactionIds: Array.isArray(cycle.payout.transactionIds) ? cycle.payout.transactionIds : null,
  };
}

function capProjection(authorityStatus) {
  const cap = authorityStatus?.cap ?? {};
  return {
    offChain24Hour: cap.offChain24Hour ?? null,
    loss: cap.loss ?? null,
    outstandingCustody: cap.outstandingCustody ?? null,
    onChainRemainingCapacity: cap.onChainRemainingCapacity ?? null,
  };
}

function alertSources(authorityStatus) {
  return {
    safetyTelemetry: authorityStatus?.alertSources?.safetyTelemetry === true,
  };
}

/** Build the private bootstrap compatibility response from one authority snapshot. */
export function buildBootstrap({ authorityStatus, identity, catalog = null, readiness = { ready: false, reasons: ['catalog-not-loaded'] } }) {
  const configuration = authorityStatus?.configuration ?? null;
  return {
    identity,
    state: mapOperatorState(configuration, authorityStatus?.revision ?? null),
    hardCaps: HARD_CAPS,
    catalog,
    readiness,
    executionConnected: false,
    rewardRecipientLimits: REWARD_RECIPIENT_LIMITS,
  };
}

/** Project the runner authority snapshot without inventing lifecycle, transaction, or payout facts. */
export function buildDashboardReadModel({ authorityStatus, now = Date.now, lastTick = null }) {
  const configuration = authorityStatus?.configuration ?? null;
  const current = activeCycle(authorityStatus);
  const cycles = Array.isArray(authorityStatus?.cycles) ? authorityStatus.cycles : [];
  const completedCycles = cycles.filter(cycle => cycle?.terminalState === 'COMPLETED').length;

  return {
    schemaVersion: 7,
    historyComplete: true,
    cardHistoryComplete: true,
    generatedAt: new Date(now()).toISOString(),
    nextCycleAt: nextCycleAt(configuration, lastTick),
    cycleIntervalMinutes: configuration ? configuration.intervalMinutes : DEFAULT_INTERVAL_MINUTES,
    execution: { connected: false, lastHeartbeatAt: null },
    cycleStartProjectPoolObservedAt: null,
    latestCompletedAllocationCycleId: null,
    metrics: nativeUnknownFields({
      cycleStartProjectPoolMicroUsdg: null,
      totalCycleFundingMicroUsdg: '0',
      totalCollectorSpendMicroUsdg: '0',
      totalBuybacksReturnedMicroUsdg: '0',
      totalBridgedBackMicroUsdg: '0',
      totalRewardsPaidMicroUsdg: '0',
      totalRewardsDeferredMicroUsdg: '0',
      totalQuotedOperatingCostsMicroUsdg: '0',
      latestRetainedReserveMicroUsdg: '0',
      latestCycleReserveTargetMicroUsdg: '0',
      completedCycles,
      skippedCycles: 0,
      openedPacks: 0,
    }),
    latestCycleTopAllocations: [],
    cards: [],
    activeCycle: current
      ? {
        cycleId: current.cycleId,
        status: visibleStage(current),
        updatedAt: null,
        configurationRevision: current.rewardSelection ? String(current.rewardSelection.configurationRevision) : null,
        allowedPackIds: configuration ? configuration.allowedPackIds : [],
        requestedOrders: configuration?.requestedOrders ?? 0,
        maxBoostersPerCycle: configuration ? configuration.maxBoostersPerCycle : null,
        maxUnitPriceMicroUsd: configuration ? configuration.maxUnitPriceMicroUsd : null,
        maxCycleBudgetMicroUsd: configuration ? configuration.maxCycleBudgetMicroUsd : null,
        max24HourBudgetMicroUsd: configuration ? configuration.max24HourBudgetMicroUsd : null,
        revealedCards: 0,
        rewardRecipientLimit: current.rewardSelection?.rewardRecipientLimit ?? null,
      }
      : null,
    latestCycle: null,
    cycles,
    cap: capProjection(authorityStatus),
    custody: authorityStatus?.custody ?? { buckets: [] },
    alertSources: alertSources(authorityStatus),
    alerts: Array.isArray(authorityStatus?.alerts) ? authorityStatus.alerts : [],
    payoutStatus: payoutStatus(current),
  };
}
