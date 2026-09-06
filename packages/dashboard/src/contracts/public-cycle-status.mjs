// Clean-room re-implementation of GET /public/api/cycle-status's contract (readSet:
// apps/web/lib/public-cycle-status.ts on the legacy codex/mainnet-cycle-canary branch,
// `normalizePublicCycleStatus`/schemaVersion 5). Ported field-for-field, including the legacy
// schemaVersion-1/2 acceptance paths the website's validator still carries — this service only ever
// *emits* schemaVersion 6, but the validator is reused verbatim by the dashboard's own tests as the
// exact gate the website itself would apply, so it must accept the same inputs the website accepts.
//
// schemaVersion 6 (F2, frozen `Amount` contract): `roundAccounting.packSpendMicroUsdg`/
// `buybackMicroUsdg`/`packGainMicroUsdg`/`packLossMicroUsdg` become nullable, and two typed
// `Amount|null` fields (`collectorPurchaseDebit`, `collectorBuybackProceeds`) carry the real
// Collector-Crypt-side (Solana) purchase debit / buyback proceeds — a different chain and asset
// than the EVM USDG bridge amounts, never assumed at parity. schemaVersion 3/4/5 keep their
// original non-nullable shape unchanged for any still-current caller. schemaVersion 6 also adds a
// top-level `scheduler` field carrying the frozen `SchedulerView` shape verbatim (see
// E-interface.json's `packages/runner/src/scheduler/scheduler.mjs#getView()`).
import { readDashboardProfile } from './dashboard-profile.mjs';
import {
  boundedArray,
  boundedText,
  ContractValidationError,
  exactKeys,
  invalidWith,
  isoTimestamp,
  money,
  nonNegativeInteger,
  nullableAmount,
  nullableMoney,
  nullableSignedMoney,
  nullableText,
  optionalMoney,
  optionalSignedMoney,
  optionalText,
  positiveSafeInteger,
  requiredKeys,
  requiredRecord,
} from './primitives.mjs';

const invalid = invalidWith('PUBLIC_CYCLE_STATUS_INVALID');

const STATUS_KEYS = new Set([
  'schemaVersion', 'profile', 'network', 'executionState', 'executionReason',
  'generatedAt', 'nextCycleAt', 'countdownSeconds', 'cycle',
]);
const STATUS_V4_KEYS = new Set([...STATUS_KEYS, 'heldPositionCount', 'heldPositions']);
const STATUS_V5_KEYS = new Set([...STATUS_KEYS, 'heldPositionCount', 'heldPositions']);
const STATUS_V6_KEYS = new Set([...STATUS_KEYS, 'heldPositionCount', 'heldPositions', 'scheduler']);
// The frozen `SchedulerView` shape (F-brief / E-interface.json's `scheduler.mjs#getView()`).
// `nextCycleAt`/`nextReconcileAt` are mutually exclusive at any instant (one timer, one next
// wakeup); `pendingReason` is `null` when nothing is blocking automation.
const SCHEDULER_KEYS = new Set(['nextCycleAt', 'nextReconcileAt', 'automationEnabled', 'paused', 'pendingReason']);
const LEGACY_IDLE_STATUS_KEYS = new Set(['schemaVersion', 'generatedAt', 'nextCycleAt', 'countdownSeconds', 'cycle']);
const NETWORK_KEYS = new Set(['evm', 'solana']);
const EVM_NETWORK_KEYS = new Set(['name', 'chainId', 'label']);
const SOLANA_NETWORK_KEYS = new Set(['name', 'genesisHash', 'label']);
const CYCLE_REQUIRED_KEYS = [
  'cycleId', 'status', 'selectedPackId', 'maxBoostersPerCycle', 'plannedBoosters', 'openedBoosters',
  'actions', 'cards', 'returnedMicroUsdg', 'rewardStatus', 'roundAccounting',
];
const CYCLE_KEYS = new Set([...CYCLE_REQUIRED_KEYS, 'startedAt', 'updatedAt', 'spentMicroUsdg', 'paidMicroUsdg', 'reason']);
const LEGACY_CYCLE_REQUIRED_KEYS = CYCLE_REQUIRED_KEYS.filter(key => key !== 'roundAccounting');
const LEGACY_CYCLE_KEYS = new Set([...LEGACY_CYCLE_REQUIRED_KEYS, 'startedAt', 'updatedAt', 'spentMicroUsdg', 'paidMicroUsdg', 'reason']);
const ACTION_KEYS = new Set(['type', 'status', 'at']);
const CARD_KEYS = new Set([
  'productId', 'rarity', 'nftAddress', 'cardName', 'setName', 'cardNumber', 'imageUrl',
  'packPriceMicroUsdg', 'buybackMicroUsdg',
]);
const LEGACY_CARD_KEYS = new Set(['productId', 'rarity', 'nftAddress', 'cardName', 'setName', 'cardNumber', 'imageUrl']);
const ROUND_ACCOUNTING_KEYS = new Set([
  'packSpendMicroUsdg', 'buybackMicroUsdg', 'packGainMicroUsdg', 'packLossMicroUsdg', 'quotedCosts',
  'protectedCostsMicroUsdg', 'confirmedCostsMicroUsdg', 'cycleGainMicroUsdg', 'cycleLossMicroUsdg',
  'walletBalanceBeforeMicroUsdg', 'walletBalanceAfterMicroUsdg', 'networkFees', 'feeReserveBeforeMicroUsdg',
  'feeReserveTargetMicroUsdg', 'feeReserveTopUpMicroUsdg', 'feeReserveAfterMicroUsdg',
  'plannedHolderRewardsMicroUsdg', 'paidHolderRewardsMicroUsdg', 'holderRewardsStatus', 'distributionStatus',
]);
// schemaVersion 6: packSpend/buyback/packGain/packLoss become nullable and, as of the F-sol-review
// correction, are now *permanently* null — there is no honest same-asset USDG producer for pack
// economics (see accounting-projection.mjs's own header for why). Four typed `Amount|null` fields
// replace them with real, distinctly-labeled facts: `outboundBridgeDebit`/`inboundBridgeProceeds`
// (the actual EVM-side USDG bridge movement) and `collectorPurchaseDebit`/`collectorBuybackProceeds`
// (the actual Collector-Crypt-side Solana debit/proceeds) — never conflated or subtracted against
// each other. `payoutLiabilityMicroUsdg`/`payoutDustMicroUsdg`/`paidHolderRewardsRecipientCount` are
// real chain-4663 USDG facts projected from the payout stage's own finalized recipient evidence
// (verified same-asset before being labeled `MicroUsdg`), not inferred from the stage's `COMPLETE`
// status alone.
const ROUND_ACCOUNTING_V6_KEYS = new Set([
  ...ROUND_ACCOUNTING_KEYS,
  'outboundBridgeDebit', 'inboundBridgeProceeds', 'collectorPurchaseDebit', 'collectorBuybackProceeds',
  'payoutLiabilityMicroUsdg', 'payoutDustMicroUsdg', 'paidHolderRewardsRecipientCount',
]);
const QUOTED_COST_KEYS = new Set([
  'outboundBridgeMicroUsdg', 'inboundBridgeMicroUsdg', 'collectorApiMicroUsdg',
  'evmNetworkMicroUsdg', 'solanaNetworkMicroUsdg', 'slippageMicroUsdg',
]);
const NETWORK_FEE_KEYS = new Set(['walletLamportsCharged', 'purchase', 'buyback']);
const NATIVE_FEE_KEYS = new Set(['lamports', 'paidBy']);
const HELD_POSITION_V4_KEYS = new Set(['positionId', 'cycleId', 'reason', 'ageSeconds', 'cycleState']);
const HELD_POSITION_V5_KEYS = new Set(['reason', 'ageSeconds', 'cycleState']);
const ACTION_STATUSES = new Set(['pending', 'complete', 'failed']);
const EXECUTION_STATES = new Set(['active', 'paused', 'unknown']);
const MAX_PUBLIC_CARDS = 60;

export function normalizePublicCycleStatus(value, expectedProfile) {
  try {
    return readPublicCycleStatus(value, expectedProfile);
  } catch (error) {
    if (error instanceof ContractValidationError) throw error;
    throw new ContractValidationError('PUBLIC_CYCLE_STATUS_INVALID');
  }
}

function readPublicCycleStatus(value, expectedProfile) {
  const source = requiredRecord(value, invalid);
  if (source.schemaVersion === 1) return readLegacyIdleStatus(source, expectedProfile);
  const statusKeys = source.schemaVersion === 6
    ? STATUS_V6_KEYS
    : (source.schemaVersion === 5 ? STATUS_V5_KEYS : (source.schemaVersion === 4 ? STATUS_V4_KEYS : STATUS_KEYS));
  exactKeys(source, statusKeys, invalid);
  requiredKeys(source, statusKeys, invalid);
  if (!(source.schemaVersion === 2 || source.schemaVersion === 3 || source.schemaVersion === 4 || source.schemaVersion === 5 || source.schemaVersion === 6)) invalid();
  const schemaVersion = source.schemaVersion;
  const selected = readDashboardProfile(source.profile);
  if (expectedProfile !== undefined && readDashboardProfile(expectedProfile).id !== selected.id) invalid();
  if (
    !EXECUTION_STATES.has(String(source.executionState))
    || source.executionReason !== (source.executionState === 'paused' ? 'operator-paused' : null)
  ) invalid();

  const generatedAt = isoTimestamp(source.generatedAt, invalid);
  const nextCycleAt = isoTimestamp(source.nextCycleAt, invalid);
  const expectedCountdown = Math.ceil(Math.max(0, Date.parse(nextCycleAt) - Date.parse(generatedAt)) / 1_000);
  if (source.countdownSeconds !== expectedCountdown) invalid();

  const result = {
    schemaVersion: schemaVersion === 6 ? 6 : (schemaVersion === 5 ? 5 : (schemaVersion === 4 ? 4 : 3)),
    profile: selected.id,
    network: readNetwork(source.network, selected.network),
    executionState: source.executionState,
    executionReason: source.executionReason,
    generatedAt,
    nextCycleAt,
    countdownSeconds: nonNegativeInteger(source.countdownSeconds, invalid),
    cycle: source.cycle === null ? null : readCycle(source.cycle, schemaVersion),
  };
  if (schemaVersion >= 4) {
    result.heldPositionCount = nonNegativeInteger(source.heldPositionCount, invalid);
    result.heldPositions = readHeldPositions(source.heldPositions, source.heldPositionCount, schemaVersion);
  }
  if (schemaVersion === 6) {
    result.scheduler = readScheduler(source.scheduler);
  }
  return result;
}

function readScheduler(value) {
  const source = requiredRecord(value, invalid);
  exactKeys(source, SCHEDULER_KEYS, invalid);
  requiredKeys(source, SCHEDULER_KEYS, invalid);
  if (typeof source.automationEnabled !== 'boolean' || typeof source.paused !== 'boolean') invalid();
  return {
    nextCycleAt: optionalTimestampOrNull(source.nextCycleAt),
    nextReconcileAt: optionalTimestampOrNull(source.nextReconcileAt),
    automationEnabled: source.automationEnabled,
    paused: source.paused,
    pendingReason: optionalText(source.pendingReason, invalid),
  };
}

function optionalTimestampOrNull(value) {
  return value === null ? null : isoTimestamp(value, invalid);
}

function readLegacyIdleStatus(source, expectedProfile) {
  exactKeys(source, LEGACY_IDLE_STATUS_KEYS, invalid);
  requiredKeys(source, LEGACY_IDLE_STATUS_KEYS, invalid);
  if (source.cycle !== null) invalid();
  const selected = readDashboardProfile(expectedProfile);
  const generatedAt = isoTimestamp(source.generatedAt, invalid);
  const nextCycleAt = isoTimestamp(source.nextCycleAt, invalid);
  const expectedCountdown = Math.ceil(Math.max(0, Date.parse(nextCycleAt) - Date.parse(generatedAt)) / 1_000);
  if (source.countdownSeconds !== expectedCountdown) invalid();
  return {
    schemaVersion: 3,
    profile: selected.id,
    network: selected.network,
    executionState: 'unknown',
    executionReason: null,
    generatedAt,
    nextCycleAt,
    countdownSeconds: nonNegativeInteger(source.countdownSeconds, invalid),
    cycle: null,
  };
}

function readNetwork(value, expected) {
  const source = requiredRecord(value, invalid);
  exactKeys(source, NETWORK_KEYS, invalid);
  requiredKeys(source, NETWORK_KEYS, invalid);
  const evm = requiredRecord(source.evm, invalid);
  const solana = requiredRecord(source.solana, invalid);
  exactKeys(evm, EVM_NETWORK_KEYS, invalid);
  exactKeys(solana, SOLANA_NETWORK_KEYS, invalid);
  requiredKeys(evm, EVM_NETWORK_KEYS, invalid);
  requiredKeys(solana, SOLANA_NETWORK_KEYS, invalid);
  if (
    evm.name !== expected.evm.name
    || evm.chainId !== expected.evm.chainId
    || evm.label !== expected.evm.label
    || solana.name !== expected.solana.name
    || solana.genesisHash !== expected.solana.genesisHash
    || solana.label !== expected.solana.label
  ) invalid();
  return expected;
}

function readCycle(value, schemaVersion) {
  const source = requiredRecord(value, invalid);
  const currentSchema = schemaVersion === 3 || schemaVersion === 4 || schemaVersion === 5 || schemaVersion === 6;
  exactKeys(source, currentSchema ? CYCLE_KEYS : LEGACY_CYCLE_KEYS, invalid);
  requiredKeys(source, currentSchema ? CYCLE_REQUIRED_KEYS : LEGACY_CYCLE_REQUIRED_KEYS, invalid);

  const maxBoostersPerCycle = source.maxBoostersPerCycle === null ? null : positiveSafeInteger(source.maxBoostersPerCycle, invalid);
  const plannedBoosters = nonNegativeInteger(source.plannedBoosters, invalid);
  const openedBoosters = nonNegativeInteger(source.openedBoosters, invalid);

  const actions = boundedArray(source.actions, 128, invalid).map(readAction);
  const cards = boundedArray(source.cards, MAX_PUBLIC_CARDS, invalid).map(card => readCard(card, schemaVersion));
  if (cards.length !== Math.min(openedBoosters, MAX_PUBLIC_CARDS)) invalid();

  const cycle = {
    cycleId: boundedText(source.cycleId, invalid),
    status: boundedText(source.status, invalid),
    selectedPackId: optionalText(source.selectedPackId, invalid),
    maxBoostersPerCycle,
    plannedBoosters,
    openedBoosters,
    actions,
    cards,
    returnedMicroUsdg: optionalMoney(source.returnedMicroUsdg, invalid),
    rewardStatus: optionalText(source.rewardStatus, invalid),
    roundAccounting: currentSchema ? readRoundAccounting(source.roundAccounting, schemaVersion) : null,
  };
  if (source.startedAt !== undefined) cycle.startedAt = isoTimestamp(source.startedAt, invalid);
  if (source.updatedAt !== undefined) cycle.updatedAt = isoTimestamp(source.updatedAt, invalid);
  if (source.spentMicroUsdg !== undefined) cycle.spentMicroUsdg = optionalMoney(source.spentMicroUsdg, invalid);
  if (source.paidMicroUsdg !== undefined) cycle.paidMicroUsdg = optionalMoney(source.paidMicroUsdg, invalid);
  if (source.reason !== undefined) cycle.reason = stableReason(source.reason);
  return cycle;
}

function readHeldPositions(value, heldPositionCount, schemaVersion) {
  const positions = boundedArray(value, 1_000, invalid).map(position => {
    const source = requiredRecord(position, invalid);
    const keys = (schemaVersion === 5 || schemaVersion === 6) ? HELD_POSITION_V5_KEYS : HELD_POSITION_V4_KEYS;
    exactKeys(source, keys, invalid);
    requiredKeys(source, keys, invalid);
    if (typeof source.reason !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(source.reason)) invalid();
    const result = {
      reason: source.reason,
      ageSeconds: nonNegativeInteger(source.ageSeconds, invalid),
      cycleState: boundedText(source.cycleState, invalid),
    };
    if (schemaVersion === 4) {
      result.positionId = boundedText(source.positionId, invalid);
      result.cycleId = boundedText(source.cycleId, invalid);
    }
    return result;
  });
  if (heldPositionCount !== positions.length) invalid();
  return positions;
}

function stableReason(value) {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) invalid();
  return value;
}

function readAction(value) {
  const source = requiredRecord(value, invalid);
  exactKeys(source, ACTION_KEYS, invalid);
  requiredKeys(source, ACTION_KEYS, invalid);
  if (!ACTION_STATUSES.has(String(source.status))) invalid();
  return { type: boundedText(source.type, invalid), status: source.status, at: isoTimestamp(source.at, invalid) };
}

function readCard(value, schemaVersion) {
  const source = requiredRecord(value, invalid);
  const currentSchema = schemaVersion === 3 || schemaVersion === 4 || schemaVersion === 5 || schemaVersion === 6;
  exactKeys(source, currentSchema ? CARD_KEYS : LEGACY_CARD_KEYS, invalid);
  requiredKeys(source, currentSchema ? CARD_KEYS : new Set(['productId', 'rarity']), invalid);
  const card = {
    productId: boundedText(source.productId, invalid),
    rarity: boundedText(source.rarity, invalid),
    nftAddress: nullableText(source.nftAddress, invalid),
    cardName: nullableText(source.cardName, invalid),
    setName: nullableText(source.setName, invalid),
    cardNumber: nullableText(source.cardNumber, invalid),
    imageUrl: null,
    packPriceMicroUsdg: optionalMoney(source.packPriceMicroUsdg ?? null, invalid),
    buybackMicroUsdg: optionalMoney(source.buybackMicroUsdg ?? null, invalid),
  };
  if (source.imageUrl !== undefined && source.imageUrl !== null) {
    const imageUrl = new URL(boundedText(source.imageUrl, invalid));
    if (imageUrl.protocol !== 'https:' || imageUrl.username || imageUrl.password) invalid();
    card.imageUrl = imageUrl.toString();
  }
  return card;
}

function readRoundAccounting(value, schemaVersion) {
  if (value === null) return null;
  const source = requiredRecord(value, invalid);
  if (schemaVersion === 6) return readRoundAccountingV6(source);
  exactKeys(source, ROUND_ACCOUNTING_KEYS, invalid);
  requiredKeys(source, ROUND_ACCOUNTING_KEYS, invalid);
  const result = {
    packSpendMicroUsdg: money(source.packSpendMicroUsdg, invalid),
    buybackMicroUsdg: money(source.buybackMicroUsdg, invalid),
    packGainMicroUsdg: money(source.packGainMicroUsdg, invalid),
    packLossMicroUsdg: money(source.packLossMicroUsdg, invalid),
    quotedCosts: readQuotedCosts(source.quotedCosts),
    protectedCostsMicroUsdg: optionalMoney(source.protectedCostsMicroUsdg, invalid),
    confirmedCostsMicroUsdg: optionalSignedMoney(source.confirmedCostsMicroUsdg, invalid),
    cycleGainMicroUsdg: optionalMoney(source.cycleGainMicroUsdg, invalid),
    cycleLossMicroUsdg: optionalMoney(source.cycleLossMicroUsdg, invalid),
    walletBalanceBeforeMicroUsdg: optionalMoney(source.walletBalanceBeforeMicroUsdg, invalid),
    walletBalanceAfterMicroUsdg: optionalMoney(source.walletBalanceAfterMicroUsdg, invalid),
    networkFees: readNetworkFees(source.networkFees),
    feeReserveBeforeMicroUsdg: optionalMoney(source.feeReserveBeforeMicroUsdg, invalid),
    feeReserveTargetMicroUsdg: optionalMoney(source.feeReserveTargetMicroUsdg, invalid),
    feeReserveTopUpMicroUsdg: optionalMoney(source.feeReserveTopUpMicroUsdg, invalid),
    feeReserveAfterMicroUsdg: optionalMoney(source.feeReserveAfterMicroUsdg, invalid),
    plannedHolderRewardsMicroUsdg: optionalMoney(source.plannedHolderRewardsMicroUsdg, invalid),
    paidHolderRewardsMicroUsdg: optionalMoney(source.paidHolderRewardsMicroUsdg, invalid),
    holderRewardsStatus: boundedText(source.holderRewardsStatus, invalid),
    distributionStatus: boundedText(source.distributionStatus, invalid),
  };
  assertExclusive(result.packGainMicroUsdg, result.packLossMicroUsdg);
  assertNullableExclusive(result.cycleGainMicroUsdg, result.cycleLossMicroUsdg);
  return result;
}

function readRoundAccountingV6(source) {
  exactKeys(source, ROUND_ACCOUNTING_V6_KEYS, invalid);
  requiredKeys(source, ROUND_ACCOUNTING_V6_KEYS, invalid);
  const result = {
    packSpendMicroUsdg: nullableMoney(source.packSpendMicroUsdg, invalid),
    buybackMicroUsdg: nullableMoney(source.buybackMicroUsdg, invalid),
    outboundBridgeDebit: nullableAmount(source.outboundBridgeDebit, invalid),
    inboundBridgeProceeds: nullableAmount(source.inboundBridgeProceeds, invalid),
    collectorPurchaseDebit: nullableAmount(source.collectorPurchaseDebit, invalid),
    collectorBuybackProceeds: nullableAmount(source.collectorBuybackProceeds, invalid),
    packGainMicroUsdg: nullableMoney(source.packGainMicroUsdg, invalid),
    packLossMicroUsdg: nullableMoney(source.packLossMicroUsdg, invalid),
    quotedCosts: readQuotedCosts(source.quotedCosts),
    protectedCostsMicroUsdg: optionalMoney(source.protectedCostsMicroUsdg, invalid),
    confirmedCostsMicroUsdg: optionalSignedMoney(source.confirmedCostsMicroUsdg, invalid),
    cycleGainMicroUsdg: optionalMoney(source.cycleGainMicroUsdg, invalid),
    cycleLossMicroUsdg: optionalMoney(source.cycleLossMicroUsdg, invalid),
    walletBalanceBeforeMicroUsdg: optionalMoney(source.walletBalanceBeforeMicroUsdg, invalid),
    walletBalanceAfterMicroUsdg: optionalMoney(source.walletBalanceAfterMicroUsdg, invalid),
    networkFees: readNetworkFees(source.networkFees),
    feeReserveBeforeMicroUsdg: optionalMoney(source.feeReserveBeforeMicroUsdg, invalid),
    feeReserveTargetMicroUsdg: optionalMoney(source.feeReserveTargetMicroUsdg, invalid),
    feeReserveTopUpMicroUsdg: optionalMoney(source.feeReserveTopUpMicroUsdg, invalid),
    feeReserveAfterMicroUsdg: optionalMoney(source.feeReserveAfterMicroUsdg, invalid),
    plannedHolderRewardsMicroUsdg: optionalMoney(source.plannedHolderRewardsMicroUsdg, invalid),
    paidHolderRewardsMicroUsdg: optionalMoney(source.paidHolderRewardsMicroUsdg, invalid),
    payoutLiabilityMicroUsdg: optionalMoney(source.payoutLiabilityMicroUsdg, invalid),
    payoutDustMicroUsdg: optionalMoney(source.payoutDustMicroUsdg, invalid),
    paidHolderRewardsRecipientCount: source.paidHolderRewardsRecipientCount === null
      ? null
      : nonNegativeInteger(source.paidHolderRewardsRecipientCount, invalid),
    holderRewardsStatus: boundedText(source.holderRewardsStatus, invalid),
    distributionStatus: boundedText(source.distributionStatus, invalid),
  };
  assertNullableExclusive(result.packGainMicroUsdg, result.packLossMicroUsdg);
  assertNullableExclusive(result.cycleGainMicroUsdg, result.cycleLossMicroUsdg);
  return result;
}

function readQuotedCosts(value) {
  const source = requiredRecord(value, invalid);
  exactKeys(source, QUOTED_COST_KEYS, invalid);
  requiredKeys(source, QUOTED_COST_KEYS, invalid);
  return {
    outboundBridgeMicroUsdg: optionalMoney(source.outboundBridgeMicroUsdg, invalid),
    inboundBridgeMicroUsdg: optionalMoney(source.inboundBridgeMicroUsdg, invalid),
    collectorApiMicroUsdg: optionalMoney(source.collectorApiMicroUsdg, invalid),
    evmNetworkMicroUsdg: optionalMoney(source.evmNetworkMicroUsdg, invalid),
    solanaNetworkMicroUsdg: optionalMoney(source.solanaNetworkMicroUsdg, invalid),
    slippageMicroUsdg: optionalMoney(source.slippageMicroUsdg, invalid),
  };
}

function readNetworkFees(value) {
  const source = requiredRecord(value, invalid);
  exactKeys(source, NETWORK_FEE_KEYS, invalid);
  requiredKeys(source, NETWORK_FEE_KEYS, invalid);
  return {
    walletLamportsCharged: optionalMoney(source.walletLamportsCharged, invalid),
    purchase: readNativeFee(source.purchase),
    buyback: readNativeFee(source.buyback),
  };
}

function readNativeFee(value) {
  if (value === null) return null;
  const source = requiredRecord(value, invalid);
  exactKeys(source, NATIVE_FEE_KEYS, invalid);
  requiredKeys(source, NATIVE_FEE_KEYS, invalid);
  return { lamports: money(source.lamports, invalid), paidBy: boundedText(source.paidBy, invalid) };
}

function assertExclusive(gain, loss) {
  if (gain !== '0' && loss !== '0') invalid();
}

function assertNullableExclusive(gain, loss) {
  if ((gain === null) !== (loss === null)) invalid();
  if (gain !== null && loss !== null) assertExclusive(gain, loss);
}
