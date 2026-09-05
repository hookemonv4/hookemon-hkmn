// Clean-room re-implementation of GET /public/api/cycle-status's contract (readSet:
// apps/web/lib/public-cycle-status.ts on the legacy codex/mainnet-cycle-canary branch,
// `normalizePublicCycleStatus`/schemaVersion 3). Ported field-for-field, including the legacy
// schemaVersion-1/2 acceptance paths the website's validator still carries — this service only ever
// *emits* schemaVersion 3, but the validator is reused verbatim by the dashboard's own tests as the
// exact gate the website itself would apply, so it must accept the same inputs the website accepts.
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
const QUOTED_COST_KEYS = new Set([
  'outboundBridgeMicroUsdg', 'inboundBridgeMicroUsdg', 'collectorApiMicroUsdg',
  'evmNetworkMicroUsdg', 'solanaNetworkMicroUsdg', 'slippageMicroUsdg',
]);
const NETWORK_FEE_KEYS = new Set(['walletLamportsCharged', 'purchase', 'buyback']);
const NATIVE_FEE_KEYS = new Set(['lamports', 'paidBy']);
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
  exactKeys(source, STATUS_KEYS, invalid);
  requiredKeys(source, STATUS_KEYS, invalid);
  if (!(source.schemaVersion === 2 || source.schemaVersion === 3)) invalid();
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

  return {
    schemaVersion: 3,
    profile: selected.id,
    network: readNetwork(source.network, selected.network),
    executionState: source.executionState,
    executionReason: source.executionReason,
    generatedAt,
    nextCycleAt,
    countdownSeconds: nonNegativeInteger(source.countdownSeconds, invalid),
    cycle: source.cycle === null ? null : readCycle(source.cycle, schemaVersion),
  };
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
  exactKeys(source, schemaVersion === 3 ? CYCLE_KEYS : LEGACY_CYCLE_KEYS, invalid);
  requiredKeys(source, schemaVersion === 3 ? CYCLE_REQUIRED_KEYS : LEGACY_CYCLE_REQUIRED_KEYS, invalid);

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
    roundAccounting: schemaVersion === 3 ? readRoundAccounting(source.roundAccounting) : null,
  };
  if (source.startedAt !== undefined) cycle.startedAt = isoTimestamp(source.startedAt, invalid);
  if (source.updatedAt !== undefined) cycle.updatedAt = isoTimestamp(source.updatedAt, invalid);
  if (source.spentMicroUsdg !== undefined) cycle.spentMicroUsdg = optionalMoney(source.spentMicroUsdg, invalid);
  if (source.paidMicroUsdg !== undefined) cycle.paidMicroUsdg = optionalMoney(source.paidMicroUsdg, invalid);
  if (source.reason !== undefined) cycle.reason = stableReason(source.reason);
  return cycle;
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
  exactKeys(source, schemaVersion === 3 ? CARD_KEYS : LEGACY_CARD_KEYS, invalid);
  requiredKeys(source, schemaVersion === 3 ? CARD_KEYS : new Set(['productId', 'rarity']), invalid);
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

function readRoundAccounting(value) {
  if (value === null) return null;
  const source = requiredRecord(value, invalid);
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
