// Clean-room re-implementation of GET /public/api/community-dashboard's contract (readSet:
// apps/web/lib/public-community-snapshot.ts on the legacy codex/mainnet-cycle-canary branch,
// `normalizePublicCommunitySnapshot`/schemaVersion 5). This service only ever emits schemaVersion 5;
// the legacy schemaVersion-3/4 acceptance paths are ported too so the validator remains the exact
// gate the website itself applies.
import { readDashboardProfile } from './dashboard-profile.mjs';
import {
  boundedArray,
  boundedText,
  ContractValidationError,
  count,
  exactKeys,
  invalidWith,
  isoTimestamp,
  money,
  nullableMoney,
  nullableSignedMoney,
  nullableText,
  optionalTimestamp,
  requiredKeys,
  requiredRecord,
  subtractAtZero,
  subtractBigIntAtZero,
} from './primitives.mjs';

const invalid = invalidWith('PUBLIC_COMMUNITY_SNAPSHOT_INVALID');

const MONEY_KEYS = [
  'latestObservedProjectPoolMicroUsdg', 'totalCycleFundingMicroUsdg', 'totalCollectorSpendMicroUsdg',
  'totalBuybacksReturnedMicroUsdg', 'totalBridgedBackMicroUsdg', 'totalRewardsPaidMicroUsdg',
  'totalRewardsDeferredMicroUsdg', 'totalQuotedOperatingCostsMicroUsdg', 'latestRetainedReserveMicroUsdg',
  'latestCycleReserveTargetMicroUsdg',
];
const COUNT_KEYS = ['completedCycles', 'skippedCycles', 'openedPacks'];
const SNAPSHOT_KEYS = new Set([
  'schemaVersion', 'profile', 'badge', 'network', 'historyComplete', 'generatedAt', 'nextCycleAt',
  'delayed', 'poolObservedAt', 'metrics', 'latestCycle', 'cards',
]);
const NETWORK_KEYS = new Set(['evm', 'solana']);
const EVM_NETWORK_KEYS = new Set(['name', 'chainId', 'label']);
const SOLANA_NETWORK_KEYS = new Set(['name', 'genesisHash', 'label']);
const METRIC_KEYS = new Set([...MONEY_KEYS, ...COUNT_KEYS]);
const LATEST_CYCLE_KEYS = new Set([
  'cycleId', 'status', 'reason', 'updatedAt', 'paidMicroUsdg', 'payoutRecipientCount', 'roundAccounting', 'transactions',
]);
const LATEST_CYCLE_V5_KEYS = new Set([...LATEST_CYCLE_KEYS, 'rewardRecipientLimit']);
const ROUND_ACCOUNTING_KEYS = new Set([
  'packSpendMicroUsdg', 'buybackMicroUsdg', 'packGainMicroUsdg', 'packLossMicroUsdg', 'quotedCosts',
  'protectedCostsMicroUsdg', 'confirmedCostsMicroUsdg', 'cycleGainMicroUsdg', 'cycleLossMicroUsdg',
  'walletBalanceBeforeMicroUsdg', 'walletBalanceAfterMicroUsdg', 'networkFees', 'feeReserveBeforeMicroUsdg',
  'feeReserveTargetMicroUsdg', 'feeReserveTopUpMicroUsdg', 'feeReserveAfterMicroUsdg',
  'plannedHolderRewardsMicroUsdg', 'paidHolderRewardsMicroUsdg', 'holderRewardsStatus', 'distributionStatus',
]);
const LEGACY_ROUND_ACCOUNTING_KEYS = new Set([
  'packSpendMicroUsdg', 'buybackMicroUsdg', 'protectedCostsMicroUsdg', 'confirmedCostsMicroUsdg',
  'feeReserveBeforeMicroUsdg', 'feeReserveTargetMicroUsdg', 'feeReserveTopUpMicroUsdg', 'feeReserveAfterMicroUsdg',
  'holderRewardsMicroUsdg', 'gainMicroUsdg', 'lossMicroUsdg',
]);
const QUOTED_COST_KEYS = new Set([
  'outboundBridgeMicroUsdg', 'inboundBridgeMicroUsdg', 'collectorApiMicroUsdg',
  'evmNetworkMicroUsdg', 'solanaNetworkMicroUsdg', 'slippageMicroUsdg',
]);
const NETWORK_FEE_KEYS = new Set(['walletLamportsCharged', 'purchase', 'buyback']);
const NATIVE_FEE_KEYS = new Set(['lamports', 'paidBy']);
const TRANSACTION_KEYS = new Set(['chain', 'purpose', 'id']);
const CARD_KEYS = new Set([
  'cycleId', 'productId', 'rarity', 'nftAddress', 'cardName', 'setName', 'cardNumber', 'imageUrl',
  'packPriceMicroUsdg', 'buybackMicroUsdg',
]);
const LEGACY_CARD_KEYS = new Set(['cycleId', 'productId', 'rarity', 'nftAddress', 'cardName', 'setName', 'cardNumber', 'imageUrl']);
const MAX_CARDS = 12;
const MAX_TRANSACTIONS = 24;
const POOL_FRESHNESS_MS = 90_000;

export function normalizePublicCommunitySnapshot(value, expectedProfile) {
  try {
    const source = requiredRecord(value, invalid);
    exactKeys(source, SNAPSHOT_KEYS, invalid);
    requiredKeys(source, SNAPSHOT_KEYS, invalid);
    if (
      !(source.schemaVersion === 3 || source.schemaVersion === 4 || source.schemaVersion === 5)
      || typeof source.historyComplete !== 'boolean'
    ) invalid();
    const sourceSchemaVersion = source.schemaVersion;
    const selected = readDashboardProfile(source.profile);
    if (expectedProfile !== undefined && readDashboardProfile(expectedProfile).id !== selected.id) invalid();
    if (source.badge !== selected.badge || typeof source.delayed !== 'boolean') invalid();
    const metricsSource = requiredRecord(source.metrics, invalid);
    exactKeys(metricsSource, METRIC_KEYS, invalid);
    const poolObservedAt = optionalTimestamp(source.poolObservedAt, invalid);
    const generatedAt = isoTimestamp(source.generatedAt, invalid);
    if (poolObservedAt !== null && Date.parse(poolObservedAt) > Date.parse(generatedAt)) invalid();
    if (
      poolObservedAt !== null
      && Date.parse(generatedAt) - Date.parse(poolObservedAt) > POOL_FRESHNESS_MS
      && source.delayed !== true
    ) invalid();
    if ((poolObservedAt === null) !== (metricsSource.latestObservedProjectPoolMicroUsdg === null)) invalid();
    const metrics = {};
    metrics.latestObservedProjectPoolMicroUsdg = metricsSource.latestObservedProjectPoolMicroUsdg === null
      ? null
      : money(metricsSource.latestObservedProjectPoolMicroUsdg, invalid);
    for (const key of MONEY_KEYS.slice(1)) metrics[key] = money(metricsSource[key], invalid);
    for (const key of COUNT_KEYS) metrics[key] = count(metricsSource[key], invalid);

    return {
      schemaVersion: sourceSchemaVersion === 5 ? 5 : 4,
      profile: selected.id,
      badge: selected.badge,
      network: readNetwork(source.network, selected.network),
      historyComplete: source.historyComplete,
      generatedAt,
      nextCycleAt: optionalTimestamp(source.nextCycleAt, invalid),
      delayed: source.delayed,
      poolObservedAt,
      metrics,
      latestCycle: readLatestCycle(source.latestCycle, sourceSchemaVersion),
      cards: boundedArray(source.cards, MAX_CARDS, invalid).map(card => readCard(card, sourceSchemaVersion)),
    };
  } catch (error) {
    if (error instanceof ContractValidationError) throw error;
    throw new ContractValidationError('PUBLIC_COMMUNITY_SNAPSHOT_INVALID');
  }
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

function readLatestCycle(value, schemaVersion) {
  if (value === null) return null;
  const source = requiredRecord(value, invalid);
  const required = schemaVersion === 5 ? LATEST_CYCLE_V5_KEYS : LATEST_CYCLE_KEYS;
  exactKeys(source, required, invalid);
  requiredKeys(source, required, invalid);
  const transactions = boundedArray(source.transactions, MAX_TRANSACTIONS, invalid).map(readTransaction);
  if (
    new Set(transactions.map(({ chain, id }) => `${chain}:${chain === 'evm' ? id.toLowerCase() : id}`)).size
    !== transactions.length
  ) invalid();
  const result = {
    cycleId: boundedText(source.cycleId, invalid),
    status: boundedText(source.status, invalid),
    reason: source.reason === null ? null : boundedText(source.reason, invalid),
    updatedAt: optionalTimestamp(source.updatedAt, invalid),
    paidMicroUsdg: source.paidMicroUsdg === null ? null : money(source.paidMicroUsdg, invalid),
    payoutRecipientCount: count(source.payoutRecipientCount, invalid),
    roundAccounting: readRoundAccounting(source.roundAccounting, schemaVersion, source.paidMicroUsdg),
    transactions,
  };
  if (schemaVersion === 5) result.rewardRecipientLimit = recipientLimit(source.rewardRecipientLimit);
  return result;
}

function readRoundAccounting(value, schemaVersion, paidMicroUsdg) {
  if (value === null) return null;
  const source = requiredRecord(value, invalid);
  if (schemaVersion === 3) return readLegacyRoundAccounting(source, paidMicroUsdg);
  exactKeys(source, ROUND_ACCOUNTING_KEYS, invalid);
  requiredKeys(source, ROUND_ACCOUNTING_KEYS, invalid);
  const result = {
    packSpendMicroUsdg: money(source.packSpendMicroUsdg, invalid),
    buybackMicroUsdg: money(source.buybackMicroUsdg, invalid),
    packGainMicroUsdg: money(source.packGainMicroUsdg, invalid),
    packLossMicroUsdg: money(source.packLossMicroUsdg, invalid),
    quotedCosts: readQuotedCosts(source.quotedCosts),
    protectedCostsMicroUsdg: nullableMoney(source.protectedCostsMicroUsdg, invalid),
    confirmedCostsMicroUsdg: nullableSignedMoney(source.confirmedCostsMicroUsdg, invalid),
    cycleGainMicroUsdg: nullableMoney(source.cycleGainMicroUsdg, invalid),
    cycleLossMicroUsdg: nullableMoney(source.cycleLossMicroUsdg, invalid),
    walletBalanceBeforeMicroUsdg: nullableMoney(source.walletBalanceBeforeMicroUsdg, invalid),
    walletBalanceAfterMicroUsdg: nullableMoney(source.walletBalanceAfterMicroUsdg, invalid),
    networkFees: readNetworkFees(source.networkFees),
    feeReserveBeforeMicroUsdg: nullableMoney(source.feeReserveBeforeMicroUsdg, invalid),
    feeReserveTargetMicroUsdg: nullableMoney(source.feeReserveTargetMicroUsdg, invalid),
    feeReserveTopUpMicroUsdg: nullableMoney(source.feeReserveTopUpMicroUsdg, invalid),
    feeReserveAfterMicroUsdg: nullableMoney(source.feeReserveAfterMicroUsdg, invalid),
    plannedHolderRewardsMicroUsdg: nullableMoney(source.plannedHolderRewardsMicroUsdg, invalid),
    paidHolderRewardsMicroUsdg: nullableMoney(source.paidHolderRewardsMicroUsdg, invalid),
    holderRewardsStatus: boundedText(source.holderRewardsStatus, invalid),
    distributionStatus: boundedText(source.distributionStatus, invalid),
  };
  assertExclusive(result.packGainMicroUsdg, result.packLossMicroUsdg);
  assertNullableExclusive(result.cycleGainMicroUsdg, result.cycleLossMicroUsdg);
  return result;
}

function readLegacyRoundAccounting(source, paidMicroUsdg) {
  exactKeys(source, LEGACY_ROUND_ACCOUNTING_KEYS, invalid);
  requiredKeys(source, LEGACY_ROUND_ACCOUNTING_KEYS, invalid);
  const packSpend = money(source.packSpendMicroUsdg, invalid);
  const buyback = money(source.buybackMicroUsdg, invalid);
  const confirmedCosts = nullableSignedMoney(source.confirmedCostsMicroUsdg, invalid);
  const completeCost = confirmedCosts === null ? null : BigInt(packSpend) + BigInt(confirmedCosts);
  return {
    packSpendMicroUsdg: packSpend,
    buybackMicroUsdg: buyback,
    packGainMicroUsdg: subtractAtZero(buyback, packSpend),
    packLossMicroUsdg: subtractAtZero(packSpend, buyback),
    quotedCosts: {
      outboundBridgeMicroUsdg: null,
      inboundBridgeMicroUsdg: null,
      collectorApiMicroUsdg: null,
      evmNetworkMicroUsdg: null,
      solanaNetworkMicroUsdg: null,
      slippageMicroUsdg: null,
    },
    protectedCostsMicroUsdg: money(source.protectedCostsMicroUsdg, invalid),
    confirmedCostsMicroUsdg: confirmedCosts,
    cycleGainMicroUsdg: completeCost === null ? null : subtractBigIntAtZero(BigInt(buyback), completeCost),
    cycleLossMicroUsdg: completeCost === null ? null : subtractBigIntAtZero(completeCost, BigInt(buyback)),
    walletBalanceBeforeMicroUsdg: null,
    walletBalanceAfterMicroUsdg: null,
    networkFees: { walletLamportsCharged: null, purchase: null, buyback: null },
    feeReserveBeforeMicroUsdg: money(source.feeReserveBeforeMicroUsdg, invalid),
    feeReserveTargetMicroUsdg: money(source.feeReserveTargetMicroUsdg, invalid),
    feeReserveTopUpMicroUsdg: money(source.feeReserveTopUpMicroUsdg, invalid),
    feeReserveAfterMicroUsdg: money(source.feeReserveAfterMicroUsdg, invalid),
    plannedHolderRewardsMicroUsdg: money(source.holderRewardsMicroUsdg, invalid),
    paidHolderRewardsMicroUsdg: nullableMoney(paidMicroUsdg, invalid),
    holderRewardsStatus: 'computed',
    distributionStatus: paidMicroUsdg === null ? 'pending' : 'legacy-settlement-recorded',
  };
}

function readQuotedCosts(value) {
  const source = requiredRecord(value, invalid);
  exactKeys(source, QUOTED_COST_KEYS, invalid);
  requiredKeys(source, QUOTED_COST_KEYS, invalid);
  return {
    outboundBridgeMicroUsdg: nullableMoney(source.outboundBridgeMicroUsdg, invalid),
    inboundBridgeMicroUsdg: nullableMoney(source.inboundBridgeMicroUsdg, invalid),
    collectorApiMicroUsdg: nullableMoney(source.collectorApiMicroUsdg, invalid),
    evmNetworkMicroUsdg: nullableMoney(source.evmNetworkMicroUsdg, invalid),
    solanaNetworkMicroUsdg: nullableMoney(source.solanaNetworkMicroUsdg, invalid),
    slippageMicroUsdg: nullableMoney(source.slippageMicroUsdg, invalid),
  };
}

function readNetworkFees(value) {
  const source = requiredRecord(value, invalid);
  exactKeys(source, NETWORK_FEE_KEYS, invalid);
  requiredKeys(source, NETWORK_FEE_KEYS, invalid);
  return {
    walletLamportsCharged: nullableMoney(source.walletLamportsCharged, invalid),
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

function readTransaction(value) {
  const source = requiredRecord(value, invalid);
  exactKeys(source, TRANSACTION_KEYS, invalid);
  requiredKeys(source, TRANSACTION_KEYS, invalid);
  if (source.chain === 'evm') {
    if (
      !new Set(['outbound-burn', 'inbound-finalization', 'reward-settlement']).has(String(source.purpose))
      || typeof source.id !== 'string'
      || !/^0x[0-9a-fA-F]{64}$/.test(source.id)
    ) invalid();
  } else if (
    source.chain !== 'solana'
    || !new Set(['outbound-mint', 'inbound-burn', 'collector-purchase', 'collector-buyback']).has(String(source.purpose))
    || typeof source.id !== 'string'
    || !/^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(source.id)
  ) invalid();
  return source;
}

function readCard(value, schemaVersion) {
  const source = requiredRecord(value, invalid);
  const currentSchema = schemaVersion === 4 || schemaVersion === 5;
  exactKeys(source, currentSchema ? CARD_KEYS : LEGACY_CARD_KEYS, invalid);
  requiredKeys(source, currentSchema ? CARD_KEYS : new Set(['cycleId', 'productId', 'rarity']), invalid);
  const card = {
    cycleId: boundedText(source.cycleId, invalid),
    productId: boundedText(source.productId, invalid),
    rarity: boundedText(source.rarity, invalid),
    nftAddress: nullableText(source.nftAddress, invalid),
    cardName: nullableText(source.cardName, invalid),
    setName: nullableText(source.setName, invalid),
    cardNumber: nullableText(source.cardNumber, invalid),
    imageUrl: null,
    packPriceMicroUsdg: nullableMoney(source.packPriceMicroUsdg, invalid),
    buybackMicroUsdg: nullableMoney(source.buybackMicroUsdg, invalid),
  };
  if (source.imageUrl !== undefined && source.imageUrl !== null) {
    const url = new URL(boundedText(source.imageUrl, invalid));
    if (url.protocol !== 'https:' || url.username || url.password) invalid();
    card.imageUrl = url.toString();
  }
  return card;
}

function recipientLimit(value) {
  if (
    !Number.isSafeInteger(value)
    || (value !== 50 && (value < 100 || value > 1000 || value % 100 !== 0))
  ) invalid();
  return value;
}
