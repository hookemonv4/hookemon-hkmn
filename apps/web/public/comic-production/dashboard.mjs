import { nativeValidationSkeleton, requireNativeRound, formatNativeAmount } from './native-accounting.mjs';
const UNAVAILABLE = '—';
const MISSING_VALUE = '—';
const FRESH_MS = 90_000;
const POLL_MS = 5_000;
const MAX_POLL_BACKOFF_MS = 30_000;
const money = (value) => typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value);
const signedMoney = (value) => typeof value === 'string' && /^(0|-?[1-9]\d{0,77})$/.test(value);
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const heldReason = (value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(value);
const nullable = (check) => (value) => value === null || check(value);
const optional = (check) => (value) => value === undefined || check(value);
const oneOf = (...values) => (value) => values.includes(value);
const timestamp = (value) => text(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fields = (keys, check) => Object.fromEntries(keys.split(' ').map((key) => [key, check]));
const record = (shape) => (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Object.keys(value).every((key) => Object.hasOwn(shape, key))
  && Object.entries(shape).every(([key, check]) => check(Object.hasOwn(value, key) ? value[key] : undefined));
const list = (check, max) => (value) => Array.isArray(value) && value.length <= max
  && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index) && check(value[index])).every(Boolean);

export function safeCardImage(value) {
  try {
    if (!text(value)) return null;
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function historyRefreshDecision({ previousFingerprint, community, retryPending }) {
  const fingerprint = JSON.stringify([
    community.metrics.completedCycles,
    community.metrics.skippedCycles,
    community.historyComplete,
    community.latestCycle?.cycleId ?? null,
  ]);
  return {
    fingerprint,
    reload: retryPending || (previousFingerprint !== null && previousFingerprint !== fingerprint),
  };
}

// The Worker normalizes legacy inputs. This client accepts only its canonical public output.
const cardShape = {
  productId: text, rarity: text,
  ...fields('nftAddress cardName setName cardNumber', nullable(text)),
  imageUrl: nullable((value) => safeCardImage(value) !== null),
  ...fields('packPriceMicroUsdg buybackMicroUsdg', nullable(money)),
};
const nativeFee = nullable(record({ lamports: money, paidBy: text }));
const quotedCostsShape = record(fields('outboundBridgeMicroUsdg inboundBridgeMicroUsdg collectorApiMicroUsdg evmNetworkMicroUsdg solanaNetworkMicroUsdg slippageMicroUsdg', nullable(money)));
const networkFeesShape = record({ walletLamportsCharged: nullable(money), purchase: nativeFee, buyback: nativeFee });
const amountShape = record({
  chainId: text, assetId: text, units: money,
  decimals: (value) => Number.isInteger(value) && value >= 0 && value <= 255,
});
const nullableAmount = nullable(amountShape);
const roundShape = record({
  ...fields('packSpendMicroUsdg buybackMicroUsdg packGainMicroUsdg packLossMicroUsdg', money),
  quotedCosts: quotedCostsShape,
  ...fields('protectedCostsMicroUsdg cycleGainMicroUsdg cycleLossMicroUsdg walletBalanceBeforeMicroUsdg walletBalanceAfterMicroUsdg feeReserveBeforeMicroUsdg feeReserveTargetMicroUsdg feeReserveTopUpMicroUsdg feeReserveAfterMicroUsdg plannedHolderRewardsMicroUsdg paidHolderRewardsMicroUsdg', nullable(money)),
  confirmedCostsMicroUsdg: nullable(signedMoney),
  networkFees: networkFeesShape,
  holderRewardsStatus: text, distributionStatus: text,
});
// schemaVersion 6 (status) / 8 (community): packSpend/buyback/packGain/packLoss become nullable
// (an unknown amount is `null`, never a fabricated '0'), plus typed Amount|null fields
// distinguishing the real Collector-Crypt-side (Solana) amounts and the EVM USDG bridge amounts
// from each other, and nullable real payout-liability/dust/recipient-count facts.
const roundShapeTyped = record({
  ...fields('packSpendMicroUsdg buybackMicroUsdg', nullable(money)),
  outboundBridgeDebit: nullableAmount, inboundBridgeProceeds: nullableAmount,
  collectorPurchaseDebit: nullableAmount, collectorBuybackProceeds: nullableAmount,
  ...fields('packGainMicroUsdg packLossMicroUsdg', nullable(money)),
  quotedCosts: quotedCostsShape,
  ...fields('protectedCostsMicroUsdg cycleGainMicroUsdg cycleLossMicroUsdg walletBalanceBeforeMicroUsdg walletBalanceAfterMicroUsdg feeReserveBeforeMicroUsdg feeReserveTargetMicroUsdg feeReserveTopUpMicroUsdg feeReserveAfterMicroUsdg plannedHolderRewardsMicroUsdg paidHolderRewardsMicroUsdg payoutLiabilityMicroUsdg payoutDustMicroUsdg', nullable(money)),
  confirmedCostsMicroUsdg: nullable(signedMoney),
  paidHolderRewardsRecipientCount: nullable(count),
  networkFees: networkFeesShape,
  holderRewardsStatus: text, distributionStatus: text,
});
const exclusive = (gain, loss) => (gain === null && loss === null)
  || (gain !== null && loss !== null && (gain === '0' || loss === '0'));
const accountingChecker = (shape) => nullable((value) => shape(value)
  && exclusive(value.packGainMicroUsdg, value.packLossMicroUsdg)
  && exclusive(value.cycleGainMicroUsdg, value.cycleLossMicroUsdg));
const accounting = accountingChecker(roundShape);
const accountingTyped = accountingChecker(roundShapeTyped);
const heldPositionV4Item = record({ positionId: text, cycleId: text, reason: heldReason, ageSeconds: count, cycleState: text });
const heldPositionV5Item = record({ reason: heldReason, ageSeconds: count, cycleState: text });
const heldPositionsChecker = (itemShape) => (value) => list(itemShape, 1_000)(value);
const heldPositionsV4 = heldPositionsChecker(heldPositionV4Item);
const heldPositionsV5 = heldPositionsChecker(heldPositionV5Item);
// The frozen SchedulerView (E-interface.json's scheduler.mjs#getView()). nextCycleAt/
// nextReconcileAt are mutually exclusive at any instant -- one timer, one next wakeup.
const schedulerShape = record({
  nextCycleAt: nullable(timestamp), nextReconcileAt: nullable(timestamp),
  automationEnabled: (value) => value === true || value === false,
  paused: (value) => value === true || value === false,
  pendingReason: nullable(text),
});
const scheduler = (value) => schedulerShape(value)
  && (value.nextCycleAt === null || value.nextReconcileAt === null);
const action = record({ type: text, status: oneOf('pending', 'complete', 'failed'), at: timestamp });
// The frozen PublicCardEvent shape verbatim (schemaVersion 8's real recent-winners feed) --
// replaces the legacy productId/rarity card shape, which has no honest source in a real provider
// observation. `state` is exactly 'observed' | 'finalized' per the real producer
// (packages/adapters/src/collector/recent-winners.mjs).
const cardEventShape = record({
  cycleId: text, operationId: text, packIndex: count, memo: nullable(text), mint: nullable(text),
  eventId: text, sequence: text, state: oneOf('observed', 'finalized'),
  name: nullable(text), imageUrl: nullable((value) => safeCardImage(value) !== null),
  observedAt: timestamp, finalizedAt: nullable(timestamp), transactionId: nullable(text),
  proceeds: nullableAmount,
});
const cardEvent = (value) => cardEventShape(value)
  && (value.finalizedAt === null || Date.parse(value.finalizedAt) >= Date.parse(value.observedAt));
const cycleShapeFor = (schemaVersion) => record({
  cycleId: text, status: text, selectedPackId: nullable(text),
  maxBoostersPerCycle: nullable((value) => count(value) && value > 0),
  plannedBoosters: count, openedBoosters: count, actions: list(action, 128), cards: list(record(cardShape), 60),
  returnedMicroUsdg: nullable(money), rewardStatus: nullable(text),
  roundAccounting: schemaVersion === 6 ? accountingTyped : accounting,
  startedAt: optional(timestamp), updatedAt: optional(timestamp),
  spentMicroUsdg: optional(nullable(money)), paidMicroUsdg: optional(nullable(money)),
  reason: optional((value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)),
});
const cycleFor = (schemaVersion) => nullable((value) =>
  cycleShapeFor(schemaVersion)(value) && value.cards.length === Math.min(value.openedBoosters, 60));
const network = record({
  evm: record({ name: text, chainId: count, label: text }),
  solana: record({ name: text, genesisHash: text, label: text }),
});
const transactionShape = record({ chain: oneOf('evm', 'solana'), purpose: text, id: text });
const transaction = (value) => transactionShape(value) && (value.chain === 'evm'
  ? ['outbound-burn', 'inbound-finalization', 'reward-settlement'].includes(value.purpose) && /^0x[0-9a-fA-F]{64}$/.test(value.id)
  : ['outbound-mint', 'inbound-burn', 'collector-purchase', 'collector-buyback'].includes(value.purpose) && /^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(value.id));
const transactions = (value) => list(transaction, 24)(value)
  && new Set(value.map(({ chain, id }) => `${chain}:${chain === 'evm' ? id.toLowerCase() : id}`)).size === value.length;
const recipientLimit = (value) => count(value) && (value === 50 || (value >= 100 && value <= 1000 && value % 100 === 0));
// schemaVersion 8: no durable recipient-count/configured-limit producer exists yet, so both
// become honestly nullable rather than a fabricated count or the old always-200 placeholder.
const latestCycleShapeFor = (schemaVersion) => {
  const base = {
    cycleId: text, status: text, reason: nullable(text), updatedAt: nullable(timestamp),
    paidMicroUsdg: nullable(money), payoutRecipientCount: schemaVersion === 8 ? nullable(count) : count,
    roundAccounting: schemaVersion === 8 ? accountingTyped : accounting, transactions,
  };
  if (schemaVersion < 5) return base;
  return { ...base, rewardRecipientLimit: schemaVersion === 8 ? nullable(recipientLimit) : recipientLimit };
};
const latestCycleFor = (schemaVersion) => (value) =>
  value === null || record(latestCycleShapeFor(schemaVersion))(value);

const STATUS_HELD_VERSIONS = new Set([4, 5, 6]);
function readStatusShape(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const schemaVersion = value.schemaVersion;
  if (![3, 4, 5, 6].includes(schemaVersion)) return false;
  const held = STATUS_HELD_VERSIONS.has(schemaVersion);
  const base = record({
    schemaVersion: oneOf(schemaVersion), profile: oneOf('testnet', 'mainnet'), network,
    executionState: oneOf('active', 'paused', 'unknown'), executionReason: oneOf(null, 'operator-paused'),
    generatedAt: timestamp, nextCycleAt: timestamp, countdownSeconds: count, cycle: cycleFor(schemaVersion),
    ...(held ? { heldPositionCount: count, heldPositions: schemaVersion === 4 ? heldPositionsV4 : heldPositionsV5 } : {}),
    ...(schemaVersion === 6 ? { scheduler } : {}),
  });
  if (!base(value)) return false;
  if (held && value.heldPositionCount !== value.heldPositions.length) return false;
  return true;
}
const metricsShape = record({
  latestObservedProjectPoolMicroUsdg: nullable(money),
  ...fields('totalCycleFundingMicroUsdg totalCollectorSpendMicroUsdg totalBuybacksReturnedMicroUsdg totalBridgedBackMicroUsdg totalRewardsPaidMicroUsdg totalRewardsDeferredMicroUsdg totalQuotedOperatingCostsMicroUsdg latestRetainedReserveMicroUsdg latestCycleReserveTargetMicroUsdg', money),
  ...fields('completedCycles skippedCycles openedPacks', count),
});
// schemaVersion 8: no durable lifetime-aggregate producer exists yet, so every money field except
// completedCycles (a real derived count), plus skippedCycles/openedPacks, is honestly null rather
// than a fabricated '0'.
const metricsShapeV8 = record({
  latestObservedProjectPoolMicroUsdg: nullable(money),
  ...fields('totalCycleFundingMicroUsdg totalCollectorSpendMicroUsdg totalBuybacksReturnedMicroUsdg totalBridgedBackMicroUsdg totalRewardsPaidMicroUsdg totalRewardsDeferredMicroUsdg totalQuotedOperatingCostsMicroUsdg latestRetainedReserveMicroUsdg latestCycleReserveTargetMicroUsdg', nullable(money)),
  completedCycles: count,
  ...fields('skippedCycles openedPacks', nullable(count)),
});
const metricsShapeFor = (schemaVersion) => schemaVersion === 8 ? metricsShapeV8 : metricsShape;
const COMMUNITY_HELD_VERSIONS = new Set([6, 7, 8]);
function readCommunityShape(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const schemaVersion = value.schemaVersion;
  if (![4, 5, 6, 7, 8].includes(schemaVersion)) return false;
  const held = COMMUNITY_HELD_VERSIONS.has(schemaVersion);
  const cardCheck = schemaVersion === 8 ? cardEvent : record({ cycleId: text, ...cardShape });
  const base = record({
    schemaVersion: oneOf(schemaVersion), profile: oneOf('testnet', 'mainnet'), badge: oneOf('TESTNET', 'MAINNET'), network,
    historyComplete: oneOf(true, false), generatedAt: timestamp, nextCycleAt: nullable(timestamp),
    delayed: oneOf(true, false), poolObservedAt: nullable(timestamp), metrics: metricsShapeFor(schemaVersion),
    latestCycle: latestCycleFor(schemaVersion),
    cards: list(cardCheck, 12),
    ...(held ? { heldPositionCount: count, heldPositions: schemaVersion === 6 ? heldPositionsV4 : heldPositionsV5 } : {}),
  });
  if (!base(value)) return false;
  if (held && value.heldPositionCount !== value.heldPositions.length) return false;
  return true;
}
const networkIdentity = (value) => [value.evm.name, value.evm.chainId, value.evm.label,
  value.solana.name, value.solana.genesisHash, value.solana.label].join('|');
const identities = {
  testnet: 'sepolia|11155111|Sepolia|devnet|EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG|Solana Devnet',
  mainnet: 'robinhood|4663|Robinhood Chain|mainnet-beta|5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d|Solana',
};

// GET /public/api/cycle-history's contract, schemaVersion 1 (packages/dashboard/src/contracts/
// public-cycle-history.mjs). A cycle whose terminalAt is not yet a verified timestamp is `null`,
// never ordered against its neighbors as if it were -- itemOrderDescends treats a null terminalAt
// as unorderable, matching the producer's own fail-closed pagination (a source set missing even
// one terminalAtMs returns items:[]/historyComplete:false entirely, never a partial reorder).
export const MAX_HISTORY_PAGE_SIZE = 20;
const historyItemShape = record({
  cycleId: text, status: text, terminalAt: nullable(timestamp), updatedAt: nullable(timestamp),
});
// A null terminalAt is never orderable against a neighbor -- historyComplete:true guarantees every
// item already has a real terminalAt (enforced below), so reaching a null here means the response
// is already invalid, not merely unorderable.
const historyItemOrderDescends = (previous, current) => {
  if (previous.terminalAt === null || current.terminalAt === null) return false;
  const previousMs = Date.parse(previous.terminalAt), currentMs = Date.parse(current.terminalAt);
  return previousMs !== currentMs ? previousMs > currentMs : previous.cycleId.localeCompare(current.cycleId) < 0;
};
function readCycleHistoryShape(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  if (value.schemaVersion !== 1) return false;
  const shape = record({
    schemaVersion: oneOf(1), profile: oneOf('testnet', 'mainnet'), network,
    generatedAt: timestamp, asOf: timestamp, historyComplete: oneOf(true, false),
    items: list(historyItemShape, MAX_HISTORY_PAGE_SIZE), nextCursor: nullable(text),
  });
  if (!shape(value)) return false;
  if (Date.parse(value.asOf) > Date.parse(value.generatedAt)) return false;
  for (let index = 1; index < value.items.length; index += 1) {
    if (!historyItemOrderDescends(value.items[index - 1], value.items[index])) return false;
  }
  if (!value.historyComplete && (value.items.length !== 0 || value.nextCursor !== null)) return false;
  // The producer's own all-or-nothing rule: a source set missing even one cycle's verified
  // terminalAtMs fails the WHOLE page closed (historyComplete:false, items:[]) rather than
  // ordering the reachable subset -- a null terminalAt can never coexist with historyComplete:true.
  if (value.historyComplete && value.items.some((item) => item.terminalAt === null)) return false;
  return true;
}
export function normalizePublicCycleHistory(value, expectedProfile) {
  if (!readCycleHistoryShape(value) || networkIdentity(value.network) !== identities[value.profile]) {
    throw new TypeError('PUBLIC_CYCLE_HISTORY_INVALID');
  }
  if (expectedProfile !== undefined && value.profile !== expectedProfile) {
    throw new TypeError('PUBLIC_CYCLE_HISTORY_INVALID');
  }
  return value;
}

export function validateDashboardPair(status, community) {
  if (status?.schemaVersion === 7 || community?.schemaVersion === 9) {
    const nativeStatus = status?.schemaVersion === 7;
    const nativeCommunity = community?.schemaVersion === 9;
    if (nativeStatus) requireNativeRound(status.cycle?.roundAccounting ?? null);
    if (nativeCommunity) requireNativeRound(community.latestCycle?.roundAccounting ?? null);
    const statusShape = nativeStatus ? nativeValidationSkeleton(status) : status;
    const communityShape = nativeCommunity ? nativeValidationSkeleton(community) : community;
    if (nativeStatus) statusShape.schemaVersion = 6;
    if (nativeCommunity) communityShape.schemaVersion = 8;
    validateDashboardPair(statusShape, communityShape);
    return { status, community };
  }
  if (!readStatusShape(status) || !readCommunityShape(community)
    || status.profile !== community.profile || community.badge !== status.profile.toUpperCase()
    || networkIdentity(status.network) !== identities[status.profile]
    || networkIdentity(community.network) !== identities[status.profile]
    || status.executionReason !== (status.executionState === 'paused' ? 'operator-paused' : null)
    || status.countdownSeconds !== Math.ceil(Math.max(0, Date.parse(status.nextCycleAt) - Date.parse(status.generatedAt)) / 1000)
    || (community.latestCycle !== null && Object.hasOwn(community.latestCycle, 'rewardRecipientLimit') !== (community.schemaVersion >= 5))
    || (community.poolObservedAt === null) !== (community.metrics.latestObservedProjectPoolMicroUsdg === null)
    || (community.poolObservedAt !== null && (Date.parse(community.poolObservedAt) > Date.parse(community.generatedAt)
      || (Date.parse(community.generatedAt) - Date.parse(community.poolObservedAt) > FRESH_MS && !community.delayed)))) {
    throw new TypeError('PUBLIC_DASHBOARD_INVALID');
  }
  return { status, community };
}

export function formatMicroUsdg(value) {
  if (!money(value)) return MISSING_VALUE;
  const digits = value.padStart(7, '0');
  const whole = BigInt(digits.slice(0, -6)).toLocaleString('en-US');
  const fraction = digits.slice(-6).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} USDG`;
}

export function latestPayout(cycle) {
  const native = cycle?.roundAccounting?.schema === 'hookemon.native-round-accounting.v1';
  if (!cycle || !text(cycle.status) || !['complete', ...(native ? ['paid-out'] : [])].includes(cycle.status.toLowerCase())) return null;
  const accounting = cycle.roundAccounting;
  if (accounting && !['reconciled', 'complete', 'paid', 'settled', 'legacy-settlement-recorded'].includes(accounting.distributionStatus.toLowerCase())) return null;
  const accountingPaid = native ? accounting.paidHolderRewardsWei : accounting?.paidHolderRewardsMicroUsdg;
  const cyclePaid = native ? cycle.paidWei : cycle.paidMicroUsdg;
  const paid = accountingPaid ?? cyclePaid;
  if (!money(paid) || !count(cycle.payoutRecipientCount) || cycle.payoutRecipientCount <= 0) return null;
  if (money(accountingPaid) && money(cyclePaid) && accountingPaid !== cyclePaid) return null;
  return { ...(native ? { unit: "ETH" } : {}), paid, recipients: cycle.payoutRecipientCount, average: (BigInt(paid) / BigInt(cycle.payoutRecipientCount)).toString() };
}

export function historyPresentation(community) {
  const complete = community?.historyComplete === true;
  const metrics = community?.metrics;
  const formatCount = (value) => complete && count(value) ? value.toLocaleString('en-US') : MISSING_VALUE;
  return {
    totalPaid: community?.schemaVersion === 9 ? formatNativeAmount(complete ? metrics?.totalRewardsPaidWei : null) : formatMicroUsdg(complete ? metrics?.totalRewardsPaidMicroUsdg : null),
    completedCycles: formatCount(metrics?.completedCycles),
    skippedCycles: formatCount(metrics?.skippedCycles),
    openedPacks: formatCount(metrics?.openedPacks),
    note: !community ? 'Awaiting verified history' : complete ? 'Complete verified cycle history' : 'Verified history is incomplete',
  };
}

export function payoutPresentation(community) {
  const payout = latestPayout(community?.latestCycle);
  const cycle = community?.latestCycle;
  const note = !community ? 'Awaiting verified payout data'
    : payout ? 'Completed holder distribution'
      : cycle && cycle.status.toLowerCase() !== 'complete' ? 'Latest cycle has no completed payout'
        : !cycle && !community.historyComplete ? 'Payout history not reported' : 'No completed payout reported';
  return { payout, note };
}

const KNOWN_REASON_LABELS = {
  INSUFFICIENT_FUNDS: 'Waiting for sufficient funds',
  LEASE_HELD_BY_ANOTHER_RUNNER: 'Another runner holds the active lease',
  RECONCILING_PENDING_TRANSACTION: 'Reconciling a pending transaction',
  TICK_FAILED: 'Last tick failed; retrying',
  STATE_UNAVAILABLE: 'Operator state is unavailable',
  WORKER_UNAVAILABLE: 'Execution worker is unavailable',
  CONFIGURATION_NOT_SET: 'Configuration is not set',
  SCHEDULER_STOPPED: 'Scheduler is stopped',
};
function humanizeCode(code) {
  return code.split(/[-_]/).filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`).join(' ');
}
export function humanizeSchedulerReason(reason) {
  if (KNOWN_REASON_LABELS[reason]) return KNOWN_REASON_LABELS[reason];
  const policyRefused = /^POLICY_REFUSED_(.+)$/.exec(reason);
  if (policyRefused) return `Policy refused: ${humanizeCode(policyRefused[1])}`;
  const recoveryRefused = /^RECOVERY_REFUSED_(.+)$/.exec(reason);
  if (recoveryRefused) return `Recovery refused: ${humanizeCode(recoveryRefused[1])}`;
  return humanizeCode(reason);
}

export function dashboardTiming(pair, now = Date.now(), failed = false) {
  if (!pair) return { delayed: false, countdown: '--:--', note: 'Schedule not reported' };
  const { status, community } = pair;
  const observations = [status.generatedAt, community.generatedAt, community.poolObservedAt].filter(Boolean);
  const delayed = failed || community.delayed || observations.some((value) => now - Date.parse(value) > FRESH_MS || Date.parse(value) - now > 5000);
  const scheduler = status.scheduler ?? null;
  if (scheduler) {
    if (delayed) return { delayed, countdown: '--:--', note: 'Waiting for fresh schedule data' };
    if (scheduler.pendingReason !== null) {
      return { delayed, countdown: '--:--', note: humanizeSchedulerReason(scheduler.pendingReason) };
    }
    const wakeupAt = scheduler.nextCycleAt ?? scheduler.nextReconcileAt;
    if (wakeupAt === null || Date.parse(wakeupAt) <= now) {
      return { delayed, countdown: '--:--', note: scheduler.paused ? 'Cycles paused' : 'Waiting for the next update' };
    }
    const seconds = Math.ceil((Date.parse(wakeupAt) - now) / 1000);
    const parts = [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60];
    const kind = scheduler.nextReconcileAt !== null ? 'Reconciling' : 'Scheduled';
    return {
      delayed,
      countdown: (parts[0] ? parts : parts.slice(1)).map((value) => String(value).padStart(2, '0')).join(':'),
      note: `${kind} ${formatTime(wakeupAt)}`,
    };
  }
  // Pre-scheduler (schemaVersion < 6) fallback: infer readiness from executionState/nextCycleAt
  // alone, since no real SchedulerView is available yet.
  const target = Date.parse(status.nextCycleAt);
  const schedulesAgree = community.nextCycleAt === null || community.nextCycleAt === status.nextCycleAt;
  if (status.executionState !== 'active' || delayed || !schedulesAgree || target <= now) {
    return { delayed, countdown: '--:--', note: status.executionState === 'paused' ? 'Cycles paused'
      : delayed ? 'Waiting for fresh schedule data' : target <= now && status.executionState === 'active' ? 'Waiting for the next cycle update' : 'Schedule not reported' };
  }
  const seconds = Math.ceil((target - now) / 1000);
  const parts = [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60];
  return { delayed, countdown: (parts[0] ? parts : parts.slice(1)).map((value) => String(value).padStart(2, '0')).join(':'), note: `Scheduled ${formatTime(status.nextCycleAt)}` };
}

const stepActions = { fees: ['fees-collected'], budget: ['pack-plan-ready'], packs: ['packs-bought'], cards: ['packs-bought'],
  sales: ['buybacks-settled'], return: ['return-bridge-finalized', 'evm-funded'], holders: ['rewards-complete', 'rewards-paid', 'payouts-settled'] };
const stateLabels = { waiting: 'Waiting for this step', active: 'In progress', complete: 'Complete', paused: 'Paused', skipped: 'Skipped', failed: 'Action needs attention', deferred: 'Distribution pending' };
export function processStep(id, status) {
  const cycle = status?.cycle;
  if (!cycle || !stepActions[id]) return { state: status?.executionState === 'paused' ? 'paused' : 'waiting', amount: UNAVAILABLE };
  const actions = cycle.actions.filter((action) => stepActions[id].includes(action.type));
  const done = actions.some((action) => action.status === 'complete');
  const complete = id === 'budget' ? cycle.selectedPackId !== null || cycle.plannedBoosters > 0 || done
    : id === 'cards' ? cycle.openedBoosters > 0
      : id === 'holders' ? money(cycle.paidMicroUsdg) || ['complete', 'paid', 'settled'].includes(cycle.rewardStatus) || done : done;
  const state = actions.some((action) => action.status === 'failed') ? 'failed'
    : id === 'holders' && /deferred|pending|not-executed/i.test(cycle.rewardStatus ?? '') ? 'deferred'
      : complete ? 'complete' : cycle.status === 'skipped' ? 'skipped'
        : status.executionState === 'paused' ? 'paused'
          : actions.some((action) => action.status === 'pending') || (id === 'cards' && done) ? 'active' : 'waiting';
  const native = status.schemaVersion === 7;
  const amounts = { packs: cycle.spentMicroUsdg, sales: cycle.roundAccounting?.buybackMicroUsdg, return: cycle.returnedMicroUsdg, holders: cycle.paidMicroUsdg };
  const nativeAmounts = { packs: cycle.spentWei, sales: cycle.roundAccounting?.buybackMicroUsd, return: cycle.returnedWei ?? cycle.roundAccounting?.inboundBridgeProceeds?.units, holders: cycle.paidWei ?? cycle.roundAccounting?.paidHolderRewardsWei };
  const amount = id === 'budget' ? cycle.plannedBoosters > 0 ? `${cycle.plannedBoosters} planned` : cycle.selectedPackId ? 'Pack selected' : UNAVAILABLE
    : id === 'cards' ? cycle.openedBoosters > 0 ? `${cycle.openedBoosters} opened` : UNAVAILABLE : native ? formatNativeAmount(nativeAmounts[id], id === 'sales' ? 6 : 18, id === 'sales' ? 'USD' : 'ETH') : formatMicroUsdg(amounts[id]);
  return { state, amount };
}

function formatTime(value) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

function humanizeCardState(state) {
  return state.split('-').filter(Boolean).map((part) => `${part[0].toUpperCase()}${part.slice(1)}`).join(' ');
}

/**
 * Presents one card for display, whether it is the legacy productId/rarity shape or the frozen
 * PublicCardEvent recent-winners feed (schemaVersion 8). Never invents a name/image before it is
 * actually observed, and never shows a not-yet-sold/not-yet-finalized card as if it had proceeds.
 */
export function presentCard(card) {
  if (Object.hasOwn(card, 'operationId')) {
    const isFinalized = card.finalizedAt !== null && card.proceeds !== null;
    return {
      key: `${card.cycleId}:${card.operationId}:${card.packIndex}`,
      imageUrl: safeCardImage(card.imageUrl),
      label: card.name ?? card.operationId,
      stateLabel: humanizeCardState(card.state),
      detailLine: isFinalized ? `Proceeds: ${formatAmount(card.proceeds)}` : 'Not yet sold',
    };
  }
  return {
    key: card.nftAddress ?? card.productId,
    imageUrl: safeCardImage(card.imageUrl),
    label: card.cardName ?? card.productId,
    stateLabel: card.rarity,
    detailLine: `Buyback: ${formatMicroUsdg(card.buybackMicroUsdg)}`,
  };
}

function formatAmount(amount) {
  const padded = amount.units.padStart(amount.decimals + 1, '0');
  const whole = amount.decimals === 0 ? padded : padded.slice(0, -amount.decimals);
  const fraction = amount.decimals === 0 ? '' : padded.slice(-amount.decimals).replace(/0+$/, '');
  const grouped = BigInt(whole).toLocaleString('en-US');
  return `${grouped}${fraction ? `.${fraction}` : ''} ${amount.assetId}`;
}

export function startDashboard(doc = document) {
  const setText = (id, value) => { const node = doc.getElementById(id); if (node) node.textContent = value; };
  let pair = null, failed = false, controller = null, version = 0, pollTimer, tickTimer, stopped = false, consecutiveFailures = 0;
  const visible = () => doc.visibilityState === 'visible';
  const renderTiming = () => {
    const timing = dashboardTiming(pair, Date.now(), failed);
    setText('headerCountdown', timing.countdown);
    setText('navCountdown', timing.countdown);
    const navCycle = doc.getElementById('navCycle');
    if (navCycle) {
      navCycle.title = timing.note;
      navCycle.setAttribute('aria-label', `Next cycle: ${timing.countdown === '--:--' ? timing.note : timing.countdown}. Open dashboard.`);
      navCycle.dataset.state = timing.countdown === '--:--' ? 'unknown' : 'scheduled';
    }
    setText('metricCountdown', timing.countdown);
    setText('metricCountdownNote', timing.note);
    const feedState = !pair ? failed ? 'unavailable' : 'connecting' : timing.delayed ? 'delayed' : 'live';
    const banner = doc.getElementById('dashboardStatus');
    if (banner) {
      banner.dataset.state = feedState;
      const heldCount = pair?.status.heldPositionCount ?? pair?.community.heldPositionCount ?? null;
      const heldNote = heldCount ? ` · ${heldCount} held pending owner decision` : '';
      banner.textContent = pair ? `${pair.community.badge} · ${pair.status.network.evm.label} · ${timing.delayed ? 'Updates delayed · showing last verified data' : 'Verified public observations'}${heldNote}`
        : failed ? 'Live cycle data is temporarily unavailable' : 'Connecting to cycle data…';
    }
    setText('headerCycleState', pair ? timing.delayed ? 'DELAYED' : pair.status.executionState === 'paused' ? 'PAUSED' : pair.community.badge : failed ? 'UNAVAILABLE' : 'CONNECTING');
  };
  const render = () => {
    renderTiming();
    const status = pair?.status, community = pair?.community;
    const { payout, note: payoutNote } = payoutPresentation(community);
    const history = historyPresentation(community);
    const cards = status?.cycle?.cards.length ? [...status.cycle.cards].reverse() : community?.cards ?? [];
    setText('metricPool', community?.schemaVersion === 9 ? formatNativeAmount(community.metrics.latestObservedProjectPoolWei) : formatMicroUsdg(community?.metrics.latestObservedProjectPoolMicroUsdg));
    setText('metricPoolNote', community?.poolObservedAt ? `Observed ${formatTime(community.poolObservedAt)}` : 'Awaiting a verified pool observation');
    setText('metricPaid', payout?.unit === 'ETH' ? formatNativeAmount(payout.paid) : formatMicroUsdg(payout?.paid));
    setText('metricAverage', payout?.unit === 'ETH' ? formatNativeAmount(payout.average) : formatMicroUsdg(payout?.average));
    setText('metricPaidNote', payoutNote);
    setText('metricAverageNote', payout ? payout.unit === 'ETH' ? 'Per actual recipient · rounded down to one wei' : 'Per actual recipient · rounded down to 0.000001 USDG' : payoutNote);
    setText('metricRecipients', payout ? payout.recipients.toLocaleString('en-US') : MISSING_VALUE);
    setText('metricPacks', history.openedPacks);
    setText('metricTotalPaid', history.totalPaid);
    setText('metricCompletedCycles', history.completedCycles);
    setText('metricSkippedCycles', history.skippedCycles);
    doc.querySelectorAll('[data-history-note]').forEach((node) => { node.textContent = history.note; });
    setText('metricCards', cards.length ? String(Math.min(cards.length, 12)) : community?.historyComplete ? '0' : MISSING_VALUE);
    doc.querySelectorAll('[data-step]').forEach((node) => {
      const step = processStep(node.dataset.step, status);
      node.dataset.state = step.state;
      const amount = node.querySelector('.s'), label = node.querySelector('.w');
      if (amount) amount.textContent = step.amount;
      if (label) label.textContent = stateLabels[step.state];
    });
    const cardList = doc.getElementById('latestCards');
    if (!cardList) return;
    cardList.replaceChildren();
    if (!cards.length) { cardList.textContent = 'No verified card results reported.'; return; }
    cards.slice(0, 12).forEach((card) => {
      const display = presentCard(card);
      const article = doc.createElement('article'); article.className = 'history-card';
      if (display.imageUrl) {
        const image = doc.createElement('img'); image.src = display.imageUrl; image.alt = display.label;
        image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; article.append(image);
      }
      const copy = doc.createElement('div'); copy.className = 'card-copy';
      for (const [tag, value] of [['span', display.stateLabel], ['strong', display.label], ['small', display.detailLine]]) {
        const node = doc.createElement(tag); node.textContent = value; copy.append(node);
      }
      article.append(copy); cardList.append(article);
    });
  };
  const poll = async () => {
    if (stopped || !visible() || controller) return;
    const requestVersion = ++version;
    const requestController = new AbortController();
    controller = requestController;
    const signal = requestController.signal;
    const timeout = setTimeout(() => requestController.abort(), 8000);
    try {
      const [status, community] = await Promise.all(['/api/cycle-status', '/api/community-dashboard'].map(async (url) => {
        const response = await fetch(url, { cache: 'no-store', credentials: 'omit', signal });
        if (!response.ok) throw new Error('PUBLIC_DASHBOARD_UNAVAILABLE');
        return response.json();
      }));
      if (requestVersion !== version || !visible() || stopped) return;
      try { pair = validateDashboardPair(status, community); }
      catch (error) { pair = null; throw error; }
      failed = false;
      consecutiveFailures = 0;
      const refreshDecision = historyRefreshDecision({
        previousFingerprint: previousCompletionFingerprint,
        community: pair.community,
        retryPending: historyRetryPending,
      });
      previousCompletionFingerprint = refreshDecision.fingerprint;
      if (refreshDecision.reload) {
        historyRetryPending = false;
        void loadHistory(null, false);
      }
    } catch {
      if (requestVersion === version && visible() && !stopped) { failed = true; consecutiveFailures += 1; }
    }
    finally {
      clearTimeout(timeout);
      if (requestVersion === version) {
        controller?.abort(); controller = null;
        if (!stopped && visible()) {
          render();
          const delay = consecutiveFailures > 0
            ? Math.min(POLL_MS * 2 ** consecutiveFailures, MAX_POLL_BACKOFF_MS)
            : POLL_MS;
          pollTimer = setTimeout(poll, delay);
        }
      }
    }
  };
  const visibilityChanged = () => {
    clearTimeout(pollTimer); clearInterval(tickTimer);
    version += 1; controller?.abort(); controller = null;
    if (visible() && !stopped) {
      renderTiming(); tickTimer = setInterval(renderTiming, 1000); void poll();
    }
  };

  // The cycle-history list is deliberately its own independent fetch loop, never reset by the
  // main status/community poll above: a paginated "load more" list must not be wiped out from
  // under the reader by an unrelated background refresh. A request-generation counter discards
  // any response that arrives after a newer request has already started (e.g. a fast double-click
  // on "Load more"), so responses can never apply out of order.
  let historyItems = [], historyGeneration = 0, historyLoadingMore = false;
  let historyRetryPending = false;
  let previousCompletionFingerprint = null;
  const renderHistory = (page, unavailable) => {
    const statusNode = doc.getElementById('cycleHistoryStatus');
    const listNode = doc.getElementById('cycleHistoryList');
    const moreButton = doc.getElementById('cycleHistoryMore');
    if (!listNode) return;
    if (unavailable || (page && !page.historyComplete)) {
      if (statusNode) statusNode.textContent = 'Cycle history unavailable: awaiting a verified terminal timestamp for every cycle.';
      listNode.replaceChildren();
      listNode.append(Object.assign(doc.createElement('p'), { className: 'empty-pulls', textContent: 'Cycle history unavailable.' }));
      if (moreButton) moreButton.hidden = true;
      return;
    }
    if (!page) return;
    if (statusNode) statusNode.textContent = 'Verified cycle history';
    listNode.replaceChildren();
    if (!historyItems.length) {
      listNode.append(Object.assign(doc.createElement('p'), { className: 'empty-pulls', textContent: 'No completed cycles yet.' }));
    } else {
      for (const item of historyItems) {
        const article = doc.createElement('article');
        article.append(
          Object.assign(doc.createElement('h3'), { textContent: item.cycleId }),
          Object.assign(doc.createElement('p'), {
            textContent: `${item.status} · ${item.terminalAt ? formatTime(item.terminalAt) : 'Awaiting terminal timestamp'}`,
          }),
        );
        listNode.append(article);
      }
    }
    if (moreButton) {
      moreButton.hidden = page.nextCursor === null;
      moreButton.textContent = historyLoadingMore ? 'Loading…' : 'Load more cycles';
      moreButton.disabled = historyLoadingMore;
    }
  };
  const loadHistory = async (cursor, append) => {
    const generation = ++historyGeneration;
    if (append) { historyLoadingMore = true; renderHistory(lastHistoryPage, false); }
    try {
      const url = new URL('/api/cycle-history', location.origin);
      url.searchParams.set('limit', '10');
      if (cursor !== null) url.searchParams.set('cursor', cursor);
      const response = await fetch(url, { cache: 'no-store', credentials: 'omit' });
      if (!response.ok) throw new Error('PUBLIC_CYCLE_HISTORY_UNAVAILABLE');
      const page = normalizePublicCycleHistory(await response.json());
      if (historyGeneration !== generation) return;
      historyItems = append ? [...historyItems, ...page.items] : page.items;
      lastHistoryPage = page;
      historyLoadingMore = false;
      renderHistory(page, false);
    } catch {
      if (historyGeneration !== generation) return;
      historyLoadingMore = false;
      if (!append) {
        historyRetryPending = true;
        renderHistory(null, true);
      }
    }
  };
  let lastHistoryPage = null;
  const historyMoreButton = doc.getElementById('cycleHistoryMore');
  if (historyMoreButton) {
    historyMoreButton.addEventListener('click', () => {
      if (lastHistoryPage?.nextCursor) void loadHistory(lastHistoryPage.nextCursor, true);
    });
  }

  doc.addEventListener('visibilitychange', visibilityChanged);
  render(); visibilityChanged(); void loadHistory(null, false);
  return () => { stopped = true; visibilityChanged(); doc.removeEventListener('visibilitychange', visibilityChanged); };
}

// The recorded-cycles feed (simple-cycles.mjs) takes the page when it is present; the live feed is
// the fallback, unchanged.
if (typeof document !== 'undefined' && !document.body?.hasAttribute('data-information-page')) {
  import('./simple-cycles.mjs')
    .then((module) => module.startSimpleCycles(document))
    .catch(() => false)
    .then((handled) => { if (!handled) startDashboard(); });
}
