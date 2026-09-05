// Maps the runner-owned operator-control status into the dashboard's compatibility read models.
// The dashboard receives a snapshot from `operatorControl.status()` and does not inspect a state
// file or a cycle repository itself. That keeps lifecycle facts on the one authority boundary.
import { createDefaultOperatorConfiguration, DEFAULT_INTERVAL_MINUTES } from '../../../runner/src/config/state-schema.mjs';
import { OPERATOR_HARD_CAPS } from '../../../runner/src/operator/state-file.mjs';

export const PLACEHOLDER_REWARD_RECIPIENT_LIMIT = 200;
export const REWARD_RECIPIENT_LIMITS = Object.freeze(
  Array.from({ length: 10 }, (_, index) => (index + 1) * 100),
);

export const HARD_CAPS = OPERATOR_HARD_CAPS;

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
    mode: 'standard',
    communityPackIds: [],
    manualPackOrders: effective.allowedPackIds.length === 1
      ? [{ productId: effective.allowedPackIds[0], quantity: effective.requestedOrders }]
      : [],
    maxBoostersPerCycle: effective.maxBoostersPerCycle,
    rewardRecipientLimit: PLACEHOLDER_REWARD_RECIPIENT_LIMIT,
    cycleIntervalMinutes: effective.intervalMinutes,
    skipNextCycleSequence: 0,
    runNowSequence: 0,
    maxUnitPriceMicroUsdg: effective.maxUnitPriceMicroUsdg,
    maxCycleBudgetMicroUsdg: effective.maxCycleBudgetMicroUsdg,
    max24HourBudgetMicroUsdg: effective.max24HourBudgetMicroUsdg,
    maxHeldPositions: effective.maxHeldPositions ?? 10,
    maxHeldValueMicroUsdg: effective.maxHeldValueMicroUsdg ?? '5000000000',
    unresolvedCardDeadlineMinutes: effective.unresolvedCardDeadlineMinutes ?? 30,
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
    heldPositions: cap.heldPositions ?? null,
  };
}

function projectInsuredValue(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.chainId !== 'string' || typeof value.assetId !== 'string'
    || !Number.isSafeInteger(value.decimals) || value.decimals < 0 || value.decimals > 255
    || typeof value.amountAtomic !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value.amountAtomic)) {
    throw new Error('authority held position insured value is invalid');
  }
  return { chainId: value.chainId, assetId: value.assetId, decimals: value.decimals, amountAtomic: value.amountAtomic };
}

function projectHeldOwnerDecision(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || (value.choice !== 'sell' && value.choice !== 'keep-holding')) {
    throw new Error('authority held position owner decision is invalid');
  }
  return { choice: value.choice };
}

function projectHeldPositions(authorityStatus, generatedAtMs) {
  const source = authorityStatus?.heldPositions ?? authorityStatus?.custody?.heldPositions ?? [];
  if (!Array.isArray(source)) throw new Error('authority held positions are invalid');
  return source.map(position => {
    if (!position || typeof position !== 'object' || Array.isArray(position)
      || typeof position.positionId !== 'string' || typeof position.cycleId !== 'string'
      || typeof position.reason !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(position.reason)
      || !Number.isSafeInteger(position.openedAtMs) || position.openedAtMs < 0
      || typeof position.costMicroUsdg !== 'string' || !/^(0|[1-9][0-9]*)$/.test(position.costMicroUsdg)
      || typeof position.valueMicroUsdg !== 'string' || !/^(0|[1-9][0-9]*)$/.test(position.valueMicroUsdg)
      || typeof position.evidenceDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(position.evidenceDigest)
      || typeof position.terminalState !== 'string'
      || !Number.isSafeInteger(position.positionRevision) || position.positionRevision < 0) {
      throw new Error('authority held position is invalid');
    }
    return {
      positionId: position.positionId,
      cycleId: position.cycleId,
      reason: position.reason,
      openedAtMs: position.openedAtMs,
      ageSeconds: Math.max(0, Math.floor((generatedAtMs - position.openedAtMs) / 1_000)),
      insuredValue: projectInsuredValue(position.insuredValue),
      costMicroUsdg: position.costMicroUsdg,
      valueMicroUsdg: position.valueMicroUsdg,
      evidenceDigest: position.evidenceDigest,
      ownerDecision: projectHeldOwnerDecision(position.ownerDecision),
      terminalState: position.terminalState,
      positionRevision: position.positionRevision,
    };
  });
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
  const generatedAtMs = now();
  const completedCycles = cycles.filter(cycle => cycle?.terminalState === 'COMPLETE' || cycle?.terminalState === 'COMPLETED').length;
  const heldPositions = projectHeldPositions(authorityStatus, generatedAtMs);

  return {
    schemaVersion: 7,
    historyComplete: true,
    cardHistoryComplete: true,
    generatedAt: new Date(generatedAtMs).toISOString(),
    nextCycleAt: nextCycleAt(configuration, lastTick),
    cycleIntervalMinutes: configuration ? configuration.intervalMinutes : DEFAULT_INTERVAL_MINUTES,
    execution: { connected: false, lastHeartbeatAt: null },
    cycleStartProjectPoolObservedAt: null,
    latestCompletedAllocationCycleId: null,
    metrics: {
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
    },
    latestCycleTopAllocations: [],
    cards: [],
    activeCycle: current
      ? {
        cycleId: current.cycleId,
        status: visibleStage(current),
        updatedAt: null,
        configurationRevision: configuration ? String(configuration.configurationRevision) : null,
        allowedPackIds: configuration ? configuration.allowedPackIds : [],
        requestedOrders: configuration && configuration.allowedPackIds.length === 1
          ? [{ productId: configuration.allowedPackIds[0], quantity: configuration.requestedOrders }]
          : [],
        maxBoostersPerCycle: configuration ? configuration.maxBoostersPerCycle : null,
        maxUnitPriceMicroUsdg: configuration ? configuration.maxUnitPriceMicroUsdg : null,
        maxCycleBudgetMicroUsdg: configuration ? configuration.maxCycleBudgetMicroUsdg : null,
        max24HourBudgetMicroUsdg: configuration ? configuration.max24HourBudgetMicroUsdg : null,
        revealedCards: 0,
        rewardRecipientLimit: PLACEHOLDER_REWARD_RECIPIENT_LIMIT,
      }
      : null,
    latestCycle: null,
    cycles,
    cap: capProjection(authorityStatus),
    heldPositions,
    custody: authorityStatus?.custody ?? { buckets: [] },
    alertSources: alertSources(authorityStatus),
    alerts: Array.isArray(authorityStatus?.alerts) ? authorityStatus.alerts : [],
    payoutStatus: payoutStatus(current),
  };
}
