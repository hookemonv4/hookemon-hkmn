import { assertPackPlan } from '../../../runner/src/config/pack-plan.mjs';
// Maps the runner-owned operator-control status into the dashboard's compatibility read models.
// The dashboard receives a snapshot from `operatorControl.status()` and does not inspect a state
// file or a cycle repository itself. That keeps lifecycle facts on the one authority boundary.
import { createDefaultOperatorConfiguration, DEFAULT_INTERVAL_MINUTES } from '../../../runner/src/config/state-schema.mjs';
import { OPERATOR_HARD_CAPS } from '../../../runner/src/operator/state-file.mjs';

import { REWARD_RECIPIENT_LIMITS } from '../../../runner/src/config/reward-recipient-selection.mjs';
import { nativeUnknownFields } from '../contracts/native-accounting.mjs';
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

function mapOperatorState(configuration, revision, lastTick = null, now = Date.now) {
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
    executionConnected: tickConnected(lastTick, now()),
    liveMode: effective.liveMode === true,
  };
}

function tickConnected(lastTick, nowMs) {
  return Number.isSafeInteger(lastTick?.at)
    && Number.isSafeInteger(lastTick?.intervalMs)
    && Number.isSafeInteger(nowMs)
    && nowMs - lastTick.at <= 2 * lastTick.intervalMs;
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

function operatorCards(cards) {
  if (!Array.isArray(cards)) return [];
  return cards.map(card => ({
    cycleId: card?.cycleId ?? '',
    productId: card?.productId ?? '',
    rarity: card?.rarity ?? '',
    nftAddress: card?.nftAddress ?? null,
    cardName: card?.cardName ?? null,
    setName: card?.setName ?? null,
    cardNumber: card?.cardNumber ?? null,
    imageUrl: card?.imageUrl ?? null,
    packPriceMicroUsdg: card?.packPriceMicroUsdg ?? null,
    buybackMicroUsdg: card?.buybackMicroUsdg ?? null,
  }));
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

function projectHeldPositions(positions) {
  if (!Array.isArray(positions)) return null;
  return positions.map(position => ({
    positionId: position.positionId,
    cycleId: position.cycleId,
    costMicroUsd: position.costMicroUsd,
    insuredValue: position.insuredValue === null ? null : structuredClone(position.insuredValue),
    reason: position.reason,
    terminalState: position.terminalState,
    evidenceDigest: position.evidenceDigest,
    openedAt: new Date(position.openedAtMs).toISOString(),
    positionRevision: position.positionRevision,
    ownerDecision: position.ownerDecision === null ? null : structuredClone(position.ownerDecision),
  }));
}

function projectManualApprovals(approvals) {
  if (!Array.isArray(approvals)) return null;
  return approvals.map(approval => ({
    cycleId: approval.cycleId,
    cycleDigest: approval.cycleDigest,
    mode: approval.mode,
    ordinal: approval.ordinal,
    releaseCostMicroUsd: approval.releaseCostMicroUsd,
    openedAt: new Date(approval.openedAtMs).toISOString(),
    approved: approval.approved,
    approvedAt: approval.approvedAtMs === null ? null : new Date(approval.approvedAtMs).toISOString(),
  }));
}

/** Build the private bootstrap compatibility response from one authority snapshot. */
export function buildBootstrap({
  authorityStatus,
  identity,
  catalog = null,
  readiness = { ready: false, reasons: ['catalog-not-loaded'] },
  now = Date.now,
  lastTick = null,
}) {
  const configuration = authorityStatus?.configuration ?? null;
  return {
    identity,
    state: mapOperatorState(configuration, authorityStatus?.revision ?? null, lastTick, now),
    hardCaps: HARD_CAPS,
    catalog,
    readiness,
    executionConnected: tickConnected(lastTick, now()),
    rewardRecipientLimits: REWARD_RECIPIENT_LIMITS,
  };
}

/** Project the runner authority snapshot without inventing lifecycle, transaction, or payout facts. */
export function buildDashboardReadModel({
  authorityStatus,
  now = Date.now,
  lastTick = null,
  lifetimeTotals = null,
  cardHistory = null,
  latestCycleAllocations = null,
  schedulerView = null,
}) {
  const configuration = authorityStatus?.configuration ?? null;
  const current = activeCycle(authorityStatus);
  const cycles = Array.isArray(authorityStatus?.cycles) ? authorityStatus.cycles : [];
  const completedCycles = cycles.filter(cycle => cycle?.terminalState === 'COMPLETED').length;

  const terminalCycles = cycles.filter(cycle => typeof cycle?.terminalState === 'string');
  const historyComplete = terminalCycles.every(
    cycle => Number.isSafeInteger(cycle?.terminalAtMs) && cycle.terminalAtMs >= 0,
  );
  const latest = lifetimeTotals?.latestCycle ?? null;
  const native = latest?.accounting?.schema === 'hookemon.native-round-accounting.v1'
    || lifetimeTotals?.units === 'wei';
  const activeLifetime = lifetimeTotals?.perCycle?.find(cycle => cycle.cycleId === current?.cycleId) ?? null;
  const historicalMetrics = lifetimeTotals ? {
    cycleStartProjectPoolMicroUsdg: null,
    totalCycleFundingMicroUsdg: lifetimeTotals.totals.totalCycleFundingMicroUsdg,
    totalCollectorSpendMicroUsdg: lifetimeTotals.totals.totalCollectorSpendMicroUsdg,
    totalBuybacksReturnedMicroUsdg: lifetimeTotals.totals.totalBuybacksReturnedMicroUsdg,
    totalBridgedBackMicroUsdg: lifetimeTotals.totals.totalBridgedBackMicroUsdg,
    totalRewardsPaidMicroUsdg: lifetimeTotals.totals.totalRewardsPaidMicroUsdg,
    totalRewardsDeferredMicroUsdg: lifetimeTotals.totals.totalRewardsDeferredMicroUsdg,
    totalQuotedOperatingCostsMicroUsdg: lifetimeTotals.totals.totalQuotedOperatingCostsMicroUsdg,
    latestRetainedReserveMicroUsdg: lifetimeTotals.totals.latestRetainedReserveMicroUsdg,
    latestCycleReserveTargetMicroUsdg: lifetimeTotals.totals.latestCycleReserveTargetMicroUsdg,
    completedCycles,
    skippedCycles: lifetimeTotals.completeness.skippedCycles ? lifetimeTotals.counts.skippedCycles : null,
    openedPacks: lifetimeTotals.completeness.openedPacks ? lifetimeTotals.counts.openedPacks : null,
  } : {
    cycleStartProjectPoolMicroUsdg: null,
    totalCycleFundingMicroUsdg: null,
    totalCollectorSpendMicroUsdg: null,
    totalBuybacksReturnedMicroUsdg: null,
    totalBridgedBackMicroUsdg: null,
    totalRewardsPaidMicroUsdg: null,
    totalRewardsDeferredMicroUsdg: null,
    totalQuotedOperatingCostsMicroUsdg: null,
    latestRetainedReserveMicroUsdg: null,
    latestCycleReserveTargetMicroUsdg: null,
    completedCycles,
    skippedCycles: null,
    openedPacks: null,
  };
  const metrics = native
    ? {
      cycleStartProjectPoolWei: null,
      totalCycleFundingWei: lifetimeTotals?.completeness?.totalCycleFundingWei ? lifetimeTotals.totals.totalCycleFundingWei : null,
      totalCollectorSpendMicroUsd: null,
      totalBuybacksReturnedMicroUsd: null,
      totalBridgedBackWei: lifetimeTotals?.completeness?.totalBridgedBackWei ? lifetimeTotals.totals.totalBridgedBackWei : null,
      totalRewardsPaidWei: lifetimeTotals?.completeness?.totalRewardsPaidWei ? lifetimeTotals.totals.totalRewardsPaidWei : null,
      totalRewardsDeferredWei: lifetimeTotals?.completeness?.totalRewardsDeferredWei ? lifetimeTotals.totals.totalRewardsDeferredWei : null,
      totalQuotedOperatingCostsMicroUsd: null,
      latestRetainedReserveWei: null,
      latestCycleReserveTargetWei: null,
      completedCycles: historicalMetrics.completedCycles,
      skippedCycles: historicalMetrics.skippedCycles,
      openedPacks: historicalMetrics.openedPacks,
    }
    : historicalMetrics;
  const schemaVersion = lifetimeTotals || cardHistory || latestCycleAllocations ? 8 : 7;
  const allocations = Array.isArray(latestCycleAllocations) ? latestCycleAllocations : [];
  const projectedCap = capProjection(authorityStatus);
  const heldPositions = projectHeldPositions(authorityStatus?.heldPositions);
  const manualApprovals = projectManualApprovals(authorityStatus?.manualApprovals);
  return {
    schemaVersion,
    historyComplete,
    cardHistoryComplete: cardHistory?.complete === true,
    ...(schemaVersion === 8 ? {
      completeness: {
        cyclesScanned: lifetimeTotals?.cyclesScanned ?? 0,
        ...Object.fromEntries(Object.entries(lifetimeTotals?.completeness ?? {}).map(([key, value]) => [key, value === true])),
        heldPositions: heldPositions !== null,
        manualApprovals: manualApprovals !== null,
      },
    } : {}),
    ...(schemaVersion === 8 ? {
      activeCycleId: authorityStatus?.activeCycleId ?? null,
      pendingReason: schedulerView?.pendingReason ?? null,
      heldPositions,
      manualApprovals,
    } : {}),
    generatedAt: new Date(now()).toISOString(),
    nextCycleAt: nextCycleAt(configuration, lastTick),
    cycleIntervalMinutes: configuration ? configuration.intervalMinutes : DEFAULT_INTERVAL_MINUTES,
    execution: {
      connected: tickConnected(lastTick, now()),
      lastHeartbeatAt: Number.isSafeInteger(lastTick?.at) ? new Date(lastTick.at).toISOString() : null,
    },
    cycleStartProjectPoolObservedAt: null,
    latestCompletedAllocationCycleId: allocations.length > 0 ? latest?.cycleId ?? null : null,
    metrics: schemaVersion === 8 ? metrics : nativeUnknownFields(metrics),
    latestCycleTopAllocations: allocations.slice().sort((left, right) =>
      BigInt(right.allocatedWei ?? right.allocatedMicroUsdg)
      > BigInt(left.allocatedWei ?? left.allocatedMicroUsdg) ? 1 : -1).slice(0, 10),
    cards: operatorCards(cardHistory?.cards),
    activeCycle: current
      ? {
        cycleId: current.cycleId,
        status: visibleStage(current),
        updatedAt: current?.stages?.map(stage => stage?.updatedAtMs).filter(Number.isSafeInteger)
          .sort((left, right) => right - left)[0] === undefined
          ? null
          : new Date(Math.max(...current.stages.map(stage => stage.updatedAtMs).filter(Number.isSafeInteger))).toISOString(),
        configurationRevision: current.rewardSelection ? String(current.rewardSelection.configurationRevision) : null,
        allowedPackIds: configuration ? configuration.allowedPackIds : [],
        requestedOrders: configuration?.requestedOrders ?? 0,
        maxBoostersPerCycle: configuration ? configuration.maxBoostersPerCycle : null,
        maxUnitPriceMicroUsd: configuration ? configuration.maxUnitPriceMicroUsd : null,
        maxCycleBudgetMicroUsd: configuration ? configuration.maxCycleBudgetMicroUsd : null,
        max24HourBudgetMicroUsd: configuration ? configuration.max24HourBudgetMicroUsd : null,
        revealedCards: activeLifetime?.openedPacks ?? null,
        rewardRecipientLimit: current.rewardSelection?.rewardRecipientLimit ?? null,
      }
      : null,
    latestCycle: latest ? {
      cycleId: latest.cycleId,
      status: latest.terminalState,
      reason: null,
      updatedAt: Number.isSafeInteger(latest.terminalAtMs) ? new Date(latest.terminalAtMs).toISOString() : null,
      ...(native ? { paidWei: latest.paidWei } : { paidMicroUsdg: latest.paidMicroUsdg }),
      payoutRecipientCount: latest.accounting?.paidHolderRewardsRecipientCount ?? null,
      rewardRecipientLimit: null,
      selectedCount: null,
      paidCount: latest.accounting?.paidHolderRewardsRecipientCount ?? null,
      deferredCount: latest.accounting?.payoutLiabilityMicroUsdg === null ? null : null,
      roundAccounting: latest.accounting,
      transactions: [],
    } : null,
    cycles,
    cap: schemaVersion === 8
      ? {
        offChain24Hour: projectedCap.offChain24Hour,
        onChainRemainingCapacity: projectedCap.onChainRemainingCapacity,
      }
      : projectedCap,
    custody: authorityStatus?.custody ?? { buckets: [] },
    alertSources: alertSources(authorityStatus),
    alerts: Array.isArray(authorityStatus?.alerts) ? authorityStatus.alerts : [],
    payoutStatus: payoutStatus(current),
  };
}
