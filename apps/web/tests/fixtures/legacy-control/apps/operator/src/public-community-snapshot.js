import { readPublicDashboardProfile } from "../../../packages/domain/src/public-dashboard-profile.js";

const MONEY_KEYS = Object.freeze([
  "cycleStartProjectPoolMicroUsdc",
  "totalCycleFundingMicroUsdc",
  "totalCollectorSpendMicroUsdc",
  "totalBuybacksReturnedMicroUsdc",
  "totalBridgedBackMicroUsdc",
  "totalRewardsPaidMicroUsdc",
  "totalRewardsDeferredMicroUsdc",
  "totalQuotedOperatingCostsMicroUsdc",
  "latestRetainedReserveMicroUsdc",
  "latestCycleReserveTargetMicroUsdc",
]);
const COUNT_KEYS = Object.freeze(["completedCycles", "skippedCycles", "openedPacks"]);
const REMAINING_MONEY_KEYS = Object.freeze(MONEY_KEYS.slice(1));
const PUBLIC_METRIC_KEYS = Object.freeze([
  "latestObservedProjectPoolMicroUsdc",
  ...REMAINING_MONEY_KEYS,
  ...COUNT_KEYS,
]);
const CARD_KEYS = Object.freeze([
  "cycleId",
  "productId",
  "rarity",
  "nftAddress",
  "cardName",
  "setName",
  "cardNumber",
  "imageUrl",
  "packPriceMicroUsdc",
  "buybackMicroUsdc",
]);
const MAX_CARDS = 12;
const MAX_TEXT_LENGTH = 512;
const DELAY_AFTER_MS = 90_000;
const SNAPSHOT_KEYS = new Set([
  "schemaVersion",
  "profile",
  "badge",
  "network",
  "historyComplete",
  "generatedAt",
  "nextCycleAt",
  "delayed",
  "poolObservedAt",
  "metrics",
  "latestCycle",
  "cards",
]);
const NETWORK_KEYS = new Set(["ethereum", "solana"]);
const ETHEREUM_NETWORK_KEYS = new Set(["name", "chainId", "label"]);
const SOLANA_NETWORK_KEYS = new Set(["name", "genesisHash", "label"]);
const METRIC_KEYS = new Set(PUBLIC_METRIC_KEYS);
const PUBLIC_CARD_KEYS = new Set(CARD_KEYS);
const LATEST_CYCLE_KEYS = new Set([
  "cycleId",
  "status",
  "reason",
  "updatedAt",
  "paidMicroUsdc",
  "payoutRecipientCount",
  "roundAccounting",
  "transactions",
]);
const ROUND_ACCOUNTING_KEYS = new Set([
  "packSpendMicroUsdc",
  "buybackMicroUsdc",
  "packGainMicroUsdc",
  "packLossMicroUsdc",
  "quotedCosts",
  "protectedCostsMicroUsdc",
  "confirmedCostsMicroUsdc",
  "cycleGainMicroUsdc",
  "cycleLossMicroUsdc",
  "walletBalanceBeforeMicroUsdc",
  "walletBalanceAfterMicroUsdc",
  "networkFees",
  "feeReserveBeforeMicroUsdc",
  "feeReserveTargetMicroUsdc",
  "feeReserveTopUpMicroUsdc",
  "feeReserveAfterMicroUsdc",
  "plannedHolderRewardsMicroUsdc",
  "paidHolderRewardsMicroUsdc",
  "holderRewardsStatus",
  "distributionStatus",
]);
const LEGACY_ROUND_ACCOUNTING_KEYS = new Set([
  "packSpendMicroUsdc",
  "buybackMicroUsdc",
  "protectedCostsMicroUsdc",
  "confirmedCostsMicroUsdc",
  "feeReserveBeforeMicroUsdc",
  "feeReserveTargetMicroUsdc",
  "feeReserveTopUpMicroUsdc",
  "feeReserveAfterMicroUsdc",
  "holderRewardsMicroUsdc",
  "gainMicroUsdc",
  "lossMicroUsdc",
]);
const QUOTED_COST_KEYS = new Set([
  "outboundBridgeMicroUsdc",
  "inboundBridgeMicroUsdc",
  "collectorApiMicroUsdc",
  "ethereumNetworkMicroUsdc",
  "solanaNetworkMicroUsdc",
  "slippageMicroUsdc",
]);
const NETWORK_FEE_KEYS = new Set(["walletLamportsCharged", "purchase", "buyback"]);
const NATIVE_FEE_KEYS = new Set(["lamports", "paidBy"]);
const TRANSACTION_KEYS = new Set(["chain", "purpose", "id"]);
const ETHEREUM_TRANSACTION_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const SOLANA_TRANSACTION_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;
const TRANSACTION_PURPOSES = Object.freeze({
  ethereum: new Set(["outbound-burn", "inbound-finalization", "reward-settlement"]),
  solana: new Set(["outbound-mint", "inbound-burn", "collector-purchase", "collector-buyback"]),
});
const MAX_TRANSACTIONS = 24;

export function projectPublicCommunitySnapshot(dashboard, { nowMs = Date.now(), profile } = {}) {
  try {
    if (!plainObject(dashboard) || !Number.isSafeInteger(nowMs) || nowMs < 0) invalid();
    const selected = readPublicDashboardProfile(profile);
    const source = requiredRecord(dashboard.communitySnapshot);
    const generatedAt = isoTimestamp(source.generatedAt);
    const generatedAtMs = Date.parse(generatedAt);
    if (generatedAtMs > nowMs) invalid();
    const metricsSource = requiredRecord(source.metrics);
    const poolObservedAt = optionalTimestamp(dashboard.cycleStartProjectPoolObservedAt);
    const poolObservedAtMs = poolObservedAt === null ? null : Date.parse(poolObservedAt);
    if (poolObservedAtMs !== null && poolObservedAtMs > nowMs) invalid();
    const latestObservedProjectPoolMicroUsdc = metricsSource.cycleStartProjectPoolMicroUsdc;
    if ((poolObservedAt === null) !== (latestObservedProjectPoolMicroUsdc === null)) invalid();
    const metrics = {
      latestObservedProjectPoolMicroUsdc: latestObservedProjectPoolMicroUsdc === null
        ? null
        : money(latestObservedProjectPoolMicroUsdc),
      ...remainingPublicMetrics(metricsSource),
    };
    if (typeof source.historyComplete !== "boolean" || !Array.isArray(source.cards)) invalid();
    if (source.cards.length > MAX_CARDS) invalid();

    return {
      schemaVersion: 4,
      profile: selected.id,
      badge: selected.badge,
      network: selected.network,
      historyComplete: source.historyComplete,
      generatedAt,
      nextCycleAt: optionalTimestamp(source.nextCycleAt),
      delayed:
        nowMs - generatedAtMs > DELAY_AFTER_MS ||
        (poolObservedAtMs !== null && nowMs - poolObservedAtMs > DELAY_AFTER_MS),
      poolObservedAt,
      metrics,
      latestCycle: publicLatestCycle(dashboard.latestCycle, 4),
      cards: source.cards.map(publicCard),
    };
  } catch {
    throw new TypeError("PUBLIC_COMMUNITY_SNAPSHOT_INVALID");
  }
}

export function normalizePublicCommunitySnapshot(value) {
  try {
    const source = requiredRecord(value);
    exactKeys(source, SNAPSHOT_KEYS);
    if (!(source.schemaVersion === 3 || source.schemaVersion === 4) ||
      typeof source.historyComplete !== "boolean") invalid();
    const sourceSchemaVersion = source.schemaVersion;
    if (typeof source.delayed !== "boolean" || !Array.isArray(source.cards)) invalid();
    if (source.cards.length > MAX_CARDS) invalid();
    const selected = readPublicDashboardProfile(source.profile);
    if (source.badge !== selected.badge) invalid();
    const network = requiredRecord(source.network);
    exactKeys(network, NETWORK_KEYS);
    validNetwork(network, selected.network);
    const metricsSource = requiredRecord(source.metrics);
    exactKeys(metricsSource, METRIC_KEYS);
    const poolObservedAt = optionalTimestamp(source.poolObservedAt);
    const generatedAt = isoTimestamp(source.generatedAt);
    if (poolObservedAt !== null && Date.parse(poolObservedAt) > Date.parse(generatedAt)) invalid();
    if (
      poolObservedAt !== null &&
      Date.parse(generatedAt) - Date.parse(poolObservedAt) > DELAY_AFTER_MS &&
      source.delayed !== true
    ) invalid();
    if (
      (poolObservedAt === null) !==
      (metricsSource.latestObservedProjectPoolMicroUsdc === null)
    ) invalid();
    const metrics = {
      latestObservedProjectPoolMicroUsdc:
        metricsSource.latestObservedProjectPoolMicroUsdc === null
          ? null
          : money(metricsSource.latestObservedProjectPoolMicroUsdc),
    };
    for (const key of REMAINING_MONEY_KEYS) metrics[key] = money(metricsSource[key]);
    for (const key of COUNT_KEYS) metrics[key] = count(metricsSource[key]);

    return {
      schemaVersion: 4,
      profile: selected.id,
      badge: selected.badge,
      network: selected.network,
      historyComplete: source.historyComplete,
      generatedAt,
      nextCycleAt: optionalTimestamp(source.nextCycleAt),
      delayed: source.delayed,
      poolObservedAt,
      metrics,
      latestCycle: publicLatestCycle(source.latestCycle, sourceSchemaVersion),
      cards: source.cards.map((card) => normalizedPublicCard(card, sourceSchemaVersion)),
    };
  } catch {
    throw new TypeError("PUBLIC_COMMUNITY_SNAPSHOT_INVALID");
  }
}

function remainingPublicMetrics(source) {
  const metrics = {};
  for (const key of REMAINING_MONEY_KEYS) metrics[key] = money(source[key]);
  for (const key of COUNT_KEYS) metrics[key] = count(source[key]);
  return metrics;
}

function publicLatestCycle(value, schemaVersion) {
  if (value === null) return null;
  const source = requiredRecord(value);
  exactKeys(source, LATEST_CYCLE_KEYS);
  if (!Array.isArray(source.transactions) || source.transactions.length > MAX_TRANSACTIONS) invalid();
  const transactions = source.transactions.map(publicTransaction);
  if (new Set(transactions.map(({ chain, id }) => transactionKey(chain, id))).size !== transactions.length) {
    invalid();
  }
  return {
    cycleId: boundedText(source.cycleId),
    status: boundedText(source.status),
    reason: source.reason === null ? null : boundedText(source.reason),
    updatedAt: optionalTimestamp(source.updatedAt),
    paidMicroUsdc: source.paidMicroUsdc === null ? null : money(source.paidMicroUsdc),
    payoutRecipientCount: count(source.payoutRecipientCount),
    roundAccounting: publicRoundAccounting(
      source.roundAccounting,
      schemaVersion,
      source.paidMicroUsdc,
    ),
    transactions,
  };
}

function publicRoundAccounting(value, schemaVersion, paidMicroUsdc) {
  if (value === null) return null;
  const source = requiredRecord(value);
  if (schemaVersion === 3) return legacyRoundAccounting(source, paidMicroUsdc);
  exactRequiredKeys(source, ROUND_ACCOUNTING_KEYS);
  const normalized = {
    packSpendMicroUsdc: money(source.packSpendMicroUsdc),
    buybackMicroUsdc: money(source.buybackMicroUsdc),
    packGainMicroUsdc: money(source.packGainMicroUsdc),
    packLossMicroUsdc: money(source.packLossMicroUsdc),
    quotedCosts: normalizedQuotedCosts(source.quotedCosts),
    protectedCostsMicroUsdc: nullableMoney(source.protectedCostsMicroUsdc),
    confirmedCostsMicroUsdc: nullableMoney(source.confirmedCostsMicroUsdc),
    cycleGainMicroUsdc: nullableMoney(source.cycleGainMicroUsdc),
    cycleLossMicroUsdc: nullableMoney(source.cycleLossMicroUsdc),
    walletBalanceBeforeMicroUsdc: nullableMoney(source.walletBalanceBeforeMicroUsdc),
    walletBalanceAfterMicroUsdc: nullableMoney(source.walletBalanceAfterMicroUsdc),
    networkFees: normalizedNetworkFees(source.networkFees),
    feeReserveBeforeMicroUsdc: nullableMoney(source.feeReserveBeforeMicroUsdc),
    feeReserveTargetMicroUsdc: nullableMoney(source.feeReserveTargetMicroUsdc),
    feeReserveTopUpMicroUsdc: nullableMoney(source.feeReserveTopUpMicroUsdc),
    feeReserveAfterMicroUsdc: nullableMoney(source.feeReserveAfterMicroUsdc),
    plannedHolderRewardsMicroUsdc: nullableMoney(source.plannedHolderRewardsMicroUsdc),
    paidHolderRewardsMicroUsdc: nullableMoney(source.paidHolderRewardsMicroUsdc),
    holderRewardsStatus: boundedText(source.holderRewardsStatus),
    distributionStatus: boundedText(source.distributionStatus),
  };
  assertExclusive(normalized.packGainMicroUsdc, normalized.packLossMicroUsdc);
  assertNullableExclusive(normalized.cycleGainMicroUsdc, normalized.cycleLossMicroUsdc);
  return normalized;
}

function legacyRoundAccounting(source, paidMicroUsdc) {
  exactRequiredKeys(source, LEGACY_ROUND_ACCOUNTING_KEYS);
  const packSpend = BigInt(money(source.packSpendMicroUsdc));
  const buyback = BigInt(money(source.buybackMicroUsdc));
  const confirmedCosts = nullableMoney(source.confirmedCostsMicroUsdc);
  const completeCost = confirmedCosts === null ? null : packSpend + BigInt(confirmedCosts);
  return {
    packSpendMicroUsdc: packSpend.toString(),
    buybackMicroUsdc: buyback.toString(),
    packGainMicroUsdc: subtractAtZero(buyback, packSpend).toString(),
    packLossMicroUsdc: subtractAtZero(packSpend, buyback).toString(),
    quotedCosts: Object.fromEntries([...QUOTED_COST_KEYS].map((key) => [key, null])),
    protectedCostsMicroUsdc: money(source.protectedCostsMicroUsdc),
    confirmedCostsMicroUsdc: confirmedCosts,
    cycleGainMicroUsdc: completeCost === null
      ? null
      : subtractAtZero(buyback, completeCost).toString(),
    cycleLossMicroUsdc: completeCost === null
      ? null
      : subtractAtZero(completeCost, buyback).toString(),
    walletBalanceBeforeMicroUsdc: null,
    walletBalanceAfterMicroUsdc: null,
    networkFees: { walletLamportsCharged: null, purchase: null, buyback: null },
    feeReserveBeforeMicroUsdc: money(source.feeReserveBeforeMicroUsdc),
    feeReserveTargetMicroUsdc: money(source.feeReserveTargetMicroUsdc),
    feeReserveTopUpMicroUsdc: money(source.feeReserveTopUpMicroUsdc),
    feeReserveAfterMicroUsdc: money(source.feeReserveAfterMicroUsdc),
    plannedHolderRewardsMicroUsdc: money(source.holderRewardsMicroUsdc),
    paidHolderRewardsMicroUsdc: nullableMoney(paidMicroUsdc),
    holderRewardsStatus: "computed",
    distributionStatus: paidMicroUsdc === null ? "pending" : "legacy-settlement-recorded",
  };
}

function normalizedQuotedCosts(value) {
  const source = requiredRecord(value);
  exactRequiredKeys(source, QUOTED_COST_KEYS);
  return Object.fromEntries([...QUOTED_COST_KEYS].map((key) => [
    key,
    nullableMoney(source[key]),
  ]));
}

function normalizedNetworkFees(value) {
  const source = requiredRecord(value);
  exactRequiredKeys(source, NETWORK_FEE_KEYS);
  return {
    walletLamportsCharged: nullableMoney(source.walletLamportsCharged),
    purchase: normalizedNativeFee(source.purchase),
    buyback: normalizedNativeFee(source.buyback),
  };
}

function normalizedNativeFee(value) {
  if (value === null) return null;
  const source = requiredRecord(value);
  exactRequiredKeys(source, NATIVE_FEE_KEYS);
  return { lamports: money(source.lamports), paidBy: boundedText(source.paidBy) };
}

function assertExclusive(gain, loss) {
  if (BigInt(gain) > 0n && BigInt(loss) > 0n) invalid();
}

function assertNullableExclusive(gain, loss) {
  if ((gain === null) !== (loss === null)) invalid();
  if (gain !== null) assertExclusive(gain, loss);
}

function transactionKey(chain, id) {
  return `${chain}:${chain === "ethereum" ? id.toLowerCase() : id}`;
}

function publicTransaction(value) {
  const source = requiredRecord(value);
  exactKeys(source, TRANSACTION_KEYS);
  if (
    !(source.chain === "ethereum" || source.chain === "solana") ||
    !TRANSACTION_PURPOSES[source.chain].has(source.purpose) ||
    typeof source.id !== "string" ||
    !(source.chain === "ethereum"
      ? ETHEREUM_TRANSACTION_PATTERN.test(source.id)
      : SOLANA_TRANSACTION_PATTERN.test(source.id))
  ) {
    invalid();
  }
  return { chain: source.chain, purpose: source.purpose, id: source.id };
}

function validNetwork(value, expected) {
  const ethereum = requiredRecord(value.ethereum);
  const solana = requiredRecord(value.solana);
  exactKeys(ethereum, ETHEREUM_NETWORK_KEYS);
  exactKeys(solana, SOLANA_NETWORK_KEYS);
  if (
    ethereum.name !== expected.ethereum.name ||
    ethereum.chainId !== expected.ethereum.chainId ||
    ethereum.label !== expected.ethereum.label ||
    solana.name !== expected.solana.name ||
    solana.genesisHash !== expected.solana.genesisHash ||
    solana.label !== expected.solana.label
  ) invalid();
}

function publicCard(value) {
  const source = requiredRecord(value);
  const card = {
    cycleId: boundedText(source.cycleId),
    productId: boundedText(source.productId),
    rarity: boundedText(source.rarity),
    nftAddress: nullableText(source.nftAddress),
    cardName: nullableText(source.cardName),
    setName: nullableText(source.setName),
    cardNumber: nullableText(source.cardNumber),
    imageUrl: null,
    packPriceMicroUsdc: nullableMoney(source.packPriceMicroUsdc),
    buybackMicroUsdc: nullableMoney(source.buybackMicroUsdc),
  };
  if (source.imageUrl !== undefined && source.imageUrl !== null) {
    const url = new URL(boundedText(source.imageUrl));
    if (url.protocol !== "https:" || url.username || url.password) invalid();
    card.imageUrl = url.toString();
  }
  return card;
}

function normalizedPublicCard(value, schemaVersion) {
  const source = requiredRecord(value);
  if (schemaVersion === 4) exactRequiredKeys(source, PUBLIC_CARD_KEYS);
  else exactKeys(source, new Set(CARD_KEYS.slice(0, 8)));
  return publicCard(source);
}

function requiredRecord(value) {
  if (!plainObject(value)) invalid();
  return value;
}

function exactKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid();
  }
}

function exactRequiredKeys(value, required) {
  exactKeys(value, required);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid();
  }
}

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedText(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH) invalid();
  return value;
}

function isoTimestamp(value) {
  const text = boundedText(value);
  const date = new Date(text);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== text) invalid();
  return text;
}

function optionalTimestamp(value) {
  return value === null ? null : isoTimestamp(value);
}

function money(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value)) invalid();
  return value;
}

function nullableMoney(value) {
  return value === undefined || value === null ? null : money(value);
}

function nullableText(value) {
  return value === undefined || value === null ? null : boundedText(value);
}

function subtractAtZero(minuend, subtrahend) {
  return minuend > subtrahend ? minuend - subtrahend : 0n;
}

function count(value) {
  if (!Number.isSafeInteger(value) || value < 0) invalid();
  return value;
}

function invalid() {
  throw new TypeError("PUBLIC_COMMUNITY_SNAPSHOT_INVALID");
}
