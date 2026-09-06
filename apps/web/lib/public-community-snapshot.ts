import {
  readDashboardProfile,
  type DashboardNetwork,
  type DashboardProfileId,
  type PublicTransactionReference,
} from "./public-dashboard-profile.ts";
import type {
  PublicRoundAccounting,
  PublicQuotedCosts,
  PublicNativeFee,
  PublicHeldPosition,
} from "./public-cycle-status.ts";
import { type Amount, type PublicCardEvent, normalizeAmount, normalizePublicCardEvent } from "./public-card-event.ts";

export type PublicCommunityMetrics = {
  latestObservedProjectPoolMicroUsdg: string | null;
  totalCycleFundingMicroUsdg: string;
  totalCollectorSpendMicroUsdg: string;
  totalBuybacksReturnedMicroUsdg: string;
  totalBridgedBackMicroUsdg: string;
  totalRewardsPaidMicroUsdg: string;
  totalRewardsDeferredMicroUsdg: string;
  totalQuotedOperatingCostsMicroUsdg: string;
  latestRetainedReserveMicroUsdg: string;
  latestCycleReserveTargetMicroUsdg: string;
  completedCycles: number;
  skippedCycles: number;
  openedPacks: number;
};

export type PublicCommunityCycle = {
  cycleId: string;
  status: string;
  reason: string | null;
  updatedAt: string | null;
  paidMicroUsdg: string | null;
  payoutRecipientCount: number;
  roundAccounting: PublicCommunityRoundAccounting | null;
  transactions: PublicTransactionReference[];
  rewardRecipientLimit?: number;
};

export type PublicCommunityRoundAccounting = PublicRoundAccounting;

export type PublicCommunityCard = {
  cycleId: string;
  productId: string;
  rarity: string;
  nftAddress: string | null;
  cardName: string | null;
  setName: string | null;
  cardNumber: string | null;
  imageUrl: string | null;
  packPriceMicroUsdg: string | null;
  buybackMicroUsdg: string | null;
};

export type PublicCommunitySnapshot = {
  schemaVersion: 4 | 5 | 6 | 7 | 8;
  profile: DashboardProfileId;
  badge: "TESTNET" | "MAINNET";
  network: DashboardNetwork;
  historyComplete: boolean;
  generatedAt: string;
  nextCycleAt: string | null;
  delayed: boolean;
  poolObservedAt: string | null;
  metrics: PublicCommunityMetrics;
  latestCycle: PublicCommunityCycle | null;
  cards: PublicCommunityCard[] | PublicCardEvent[];
  heldPositionCount?: number;
  heldPositions?: PublicHeldPosition[];
};

const MONEY_KEYS = [
  "latestObservedProjectPoolMicroUsdg",
  "totalCycleFundingMicroUsdg",
  "totalCollectorSpendMicroUsdg",
  "totalBuybacksReturnedMicroUsdg",
  "totalBridgedBackMicroUsdg",
  "totalRewardsPaidMicroUsdg",
  "totalRewardsDeferredMicroUsdg",
  "totalQuotedOperatingCostsMicroUsdg",
  "latestRetainedReserveMicroUsdg",
  "latestCycleReserveTargetMicroUsdg",
] as const;
const COUNT_KEYS = ["completedCycles", "skippedCycles", "openedPacks"] as const;
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
const SNAPSHOT_HELD_POSITION_KEYS = new Set([...SNAPSHOT_KEYS, "heldPositionCount", "heldPositions"]);
const NETWORK_KEYS = new Set(["evm", "solana"]);
const EVM_NETWORK_KEYS = new Set(["name", "chainId", "label"]);
const SOLANA_NETWORK_KEYS = new Set(["name", "genesisHash", "label"]);
const METRIC_KEYS = new Set([...MONEY_KEYS, ...COUNT_KEYS]);
const LATEST_CYCLE_KEYS = new Set([
  "cycleId",
  "status",
  "reason",
  "updatedAt",
  "paidMicroUsdg",
  "payoutRecipientCount",
  "roundAccounting",
  "transactions",
]);
const LATEST_CYCLE_V5_KEYS = new Set([...LATEST_CYCLE_KEYS, "rewardRecipientLimit"]);
const ROUND_ACCOUNTING_KEYS = new Set([
  "packSpendMicroUsdg",
  "buybackMicroUsdg",
  "packGainMicroUsdg",
  "packLossMicroUsdg",
  "quotedCosts",
  "protectedCostsMicroUsdg",
  "confirmedCostsMicroUsdg",
  "cycleGainMicroUsdg",
  "cycleLossMicroUsdg",
  "walletBalanceBeforeMicroUsdg",
  "walletBalanceAfterMicroUsdg",
  "networkFees",
  "feeReserveBeforeMicroUsdg",
  "feeReserveTargetMicroUsdg",
  "feeReserveTopUpMicroUsdg",
  "feeReserveAfterMicroUsdg",
  "plannedHolderRewardsMicroUsdg",
  "paidHolderRewardsMicroUsdg",
  "holderRewardsStatus",
  "distributionStatus",
]);
// schemaVersion 8: same nullable/typed evolution as public-cycle-status.ts's schemaVersion 6.
const ROUND_ACCOUNTING_V8_KEYS = new Set([
  ...ROUND_ACCOUNTING_KEYS,
  "collectorPurchaseDebit",
  "collectorBuybackProceeds",
]);
const LEGACY_ROUND_ACCOUNTING_KEYS = new Set([
  "packSpendMicroUsdg",
  "buybackMicroUsdg",
  "protectedCostsMicroUsdg",
  "confirmedCostsMicroUsdg",
  "feeReserveBeforeMicroUsdg",
  "feeReserveTargetMicroUsdg",
  "feeReserveTopUpMicroUsdg",
  "feeReserveAfterMicroUsdg",
  "holderRewardsMicroUsdg",
  "gainMicroUsdg",
  "lossMicroUsdg",
]);
const QUOTED_COST_KEYS = new Set([
  "outboundBridgeMicroUsdg",
  "inboundBridgeMicroUsdg",
  "collectorApiMicroUsdg",
  "evmNetworkMicroUsdg",
  "solanaNetworkMicroUsdg",
  "slippageMicroUsdg",
]);
const NETWORK_FEE_KEYS = new Set(["walletLamportsCharged", "purchase", "buyback"]);
const NATIVE_FEE_KEYS = new Set(["lamports", "paidBy"]);
const HELD_POSITION_V6_KEYS = new Set(["positionId", "cycleId", "reason", "ageSeconds", "cycleState"]);
const HELD_POSITION_V7_KEYS = new Set(["reason", "ageSeconds", "cycleState"]);
const TRANSACTION_KEYS = new Set(["chain", "purpose", "id"]);
const CARD_KEYS = new Set([
  "cycleId",
  "productId",
  "rarity",
  "nftAddress",
  "cardName",
  "setName",
  "cardNumber",
  "imageUrl",
  "packPriceMicroUsdg",
  "buybackMicroUsdg",
]);
const LEGACY_CARD_KEYS = new Set([
  "cycleId",
  "productId",
  "rarity",
  "nftAddress",
  "cardName",
  "setName",
  "cardNumber",
  "imageUrl",
]);
const MAX_CARDS = 12;
const MAX_TRANSACTIONS = 24;
const MAX_TEXT_LENGTH = 512;
const POOL_FRESHNESS_MS = 90_000;

export function normalizePublicCommunitySnapshot(
  value: unknown,
  expectedProfile?: DashboardProfileId,
): PublicCommunitySnapshot {
  try {
    const source = requiredRecord(value);
    const snapshotKeys = source.schemaVersion === 6 || source.schemaVersion === 7 || source.schemaVersion === 8
      ? SNAPSHOT_HELD_POSITION_KEYS
      : SNAPSHOT_KEYS;
    exactKeys(source, snapshotKeys);
    requiredKeys(source, snapshotKeys);
    if (
      !(source.schemaVersion === 3 || source.schemaVersion === 4 || source.schemaVersion === 5 ||
        source.schemaVersion === 6 || source.schemaVersion === 7 || source.schemaVersion === 8) ||
      typeof source.historyComplete !== "boolean"
    ) invalid();
    const sourceSchemaVersion = source.schemaVersion;
    const selected = readDashboardProfile(source.profile);
    if (expectedProfile !== undefined && readDashboardProfile(expectedProfile).id !== selected.id) {
      invalid();
    }
    if (source.badge !== selected.badge || typeof source.delayed !== "boolean") invalid();
    const metricsSource = requiredRecord(source.metrics);
    exactKeys(metricsSource, METRIC_KEYS);
    const poolObservedAt = optionalTimestamp(source.poolObservedAt);
    const generatedAt = isoTimestamp(source.generatedAt);
    if (poolObservedAt !== null && Date.parse(poolObservedAt) > Date.parse(generatedAt)) invalid();
    if (
      poolObservedAt !== null &&
      Date.parse(generatedAt) - Date.parse(poolObservedAt) > POOL_FRESHNESS_MS &&
      source.delayed !== true
    ) invalid();
    if (
      (poolObservedAt === null) !==
      (metricsSource.latestObservedProjectPoolMicroUsdg === null)
    ) invalid();
    const metrics = {} as PublicCommunityMetrics;
    metrics.latestObservedProjectPoolMicroUsdg =
      metricsSource.latestObservedProjectPoolMicroUsdg === null
        ? null
        : money(metricsSource.latestObservedProjectPoolMicroUsdg);
    for (const key of MONEY_KEYS.slice(1)) metrics[key] = money(metricsSource[key]);
    for (const key of COUNT_KEYS) metrics[key] = count(metricsSource[key]);

    const result: PublicCommunitySnapshot = {
      schemaVersion: sourceSchemaVersion === 8
        ? 8
        : (sourceSchemaVersion === 7 ? 7 : (sourceSchemaVersion === 6 ? 6 : (sourceSchemaVersion === 5 ? 5 : 4))),
      profile: selected.id,
      badge: selected.badge,
      network: readNetwork(source.network, selected.network),
      historyComplete: source.historyComplete,
      generatedAt,
      nextCycleAt: optionalTimestamp(source.nextCycleAt),
      delayed: source.delayed,
      poolObservedAt,
      metrics,
      latestCycle: readLatestCycle(source.latestCycle, sourceSchemaVersion),
      cards: boundedArray(source.cards, MAX_CARDS).map((card) =>
        readCard(card, sourceSchemaVersion)) as PublicCommunitySnapshot["cards"],
    };
    if (sourceSchemaVersion === 6 || sourceSchemaVersion === 7 || sourceSchemaVersion === 8) {
      result.heldPositionCount = count(source.heldPositionCount);
      result.heldPositions = readHeldPositions(source.heldPositions, result.heldPositionCount, sourceSchemaVersion);
    }
    return result;
  } catch {
    throw new TypeError("PUBLIC_COMMUNITY_SNAPSHOT_INVALID");
  }
}

function readHeldPositions(
  value: unknown,
  heldPositionCount: number,
  schemaVersion: unknown,
): PublicHeldPosition[] {
  const positions = boundedArray(value, 1_000).map((position) => {
    const source = requiredRecord(position);
    const keys = schemaVersion === 7 || schemaVersion === 8 ? HELD_POSITION_V7_KEYS : HELD_POSITION_V6_KEYS;
    exactKeys(source, keys);
    requiredKeys(source, keys);
    if (typeof source.reason !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/.test(source.reason)) invalid();
    const result: PublicHeldPosition = {
      reason: source.reason,
      ageSeconds: count(source.ageSeconds),
      cycleState: boundedText(source.cycleState),
    };
    if (schemaVersion === 6) {
      result.positionId = boundedText(source.positionId);
      result.cycleId = boundedText(source.cycleId);
    }
    return result;
  });
  if (heldPositionCount !== positions.length) invalid();
  return positions;
}

function readNetwork(value: unknown, expected: DashboardNetwork): DashboardNetwork {
  const source = requiredRecord(value);
  exactKeys(source, NETWORK_KEYS);
  requiredKeys(source, NETWORK_KEYS);
  const evm = requiredRecord(source.evm);
  const solana = requiredRecord(source.solana);
  exactKeys(evm, EVM_NETWORK_KEYS);
  exactKeys(solana, SOLANA_NETWORK_KEYS);
  requiredKeys(evm, EVM_NETWORK_KEYS);
  requiredKeys(solana, SOLANA_NETWORK_KEYS);
  if (
    evm.name !== expected.evm.name ||
    evm.chainId !== expected.evm.chainId ||
    evm.label !== expected.evm.label ||
    solana.name !== expected.solana.name ||
    solana.genesisHash !== expected.solana.genesisHash ||
    solana.label !== expected.solana.label
  ) invalid();
  return expected;
}

function readLatestCycle(value: unknown, schemaVersion: unknown): PublicCommunityCycle | null {
  if (value === null) return null;
  const source = requiredRecord(value);
  const currentSchema = schemaVersion === 5 || schemaVersion === 6 || schemaVersion === 7 || schemaVersion === 8;
  const required = currentSchema ? LATEST_CYCLE_V5_KEYS : LATEST_CYCLE_KEYS;
  exactKeys(source, required);
  requiredKeys(source, required);
  const transactions = boundedArray(source.transactions, MAX_TRANSACTIONS).map(readTransaction);
  if (
    new Set(transactions.map(({ chain, id }) =>
      `${chain}:${chain === "evm" ? id.toLowerCase() : id}`)).size !== transactions.length
  ) invalid();
  const result: PublicCommunityCycle = {
    cycleId: boundedText(source.cycleId),
    status: boundedText(source.status),
    reason: source.reason === null ? null : boundedText(source.reason),
    updatedAt: optionalTimestamp(source.updatedAt),
    paidMicroUsdg: source.paidMicroUsdg === null ? null : money(source.paidMicroUsdg),
    payoutRecipientCount: count(source.payoutRecipientCount),
    roundAccounting: readRoundAccounting(
      source.roundAccounting,
      schemaVersion,
      source.paidMicroUsdg,
    ),
    transactions,
  };
  if (currentSchema) result.rewardRecipientLimit = recipientLimit(source.rewardRecipientLimit);
  return result;
}

function recipientLimit(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value !== 50 && ((value as number) < 100 || (value as number) > 1000 || (value as number) % 100 !== 0))
  ) invalid();
  return value as number;
}

function readRoundAccounting(
  value: unknown,
  schemaVersion: unknown,
  paidMicroUsdg: unknown,
): PublicCommunityRoundAccounting | null {
  if (value === null) return null;
  const source = requiredRecord(value);
  if (schemaVersion === 3) return readLegacyRoundAccounting(source, paidMicroUsdg);
  if (schemaVersion === 8) return readRoundAccountingV8(source);
  exactKeys(source, ROUND_ACCOUNTING_KEYS);
  requiredKeys(source, ROUND_ACCOUNTING_KEYS);
  const result: PublicCommunityRoundAccounting = {
    packSpendMicroUsdg: money(source.packSpendMicroUsdg),
    buybackMicroUsdg: money(source.buybackMicroUsdg),
    packGainMicroUsdg: money(source.packGainMicroUsdg),
    packLossMicroUsdg: money(source.packLossMicroUsdg),
    quotedCosts: readQuotedCosts(source.quotedCosts),
    protectedCostsMicroUsdg: nullableMoney(source.protectedCostsMicroUsdg),
    confirmedCostsMicroUsdg: nullableSignedMoney(source.confirmedCostsMicroUsdg),
    cycleGainMicroUsdg: nullableMoney(source.cycleGainMicroUsdg),
    cycleLossMicroUsdg: nullableMoney(source.cycleLossMicroUsdg),
    walletBalanceBeforeMicroUsdg: nullableMoney(source.walletBalanceBeforeMicroUsdg),
    walletBalanceAfterMicroUsdg: nullableMoney(source.walletBalanceAfterMicroUsdg),
    networkFees: readNetworkFees(source.networkFees),
    feeReserveBeforeMicroUsdg: nullableMoney(source.feeReserveBeforeMicroUsdg),
    feeReserveTargetMicroUsdg: nullableMoney(source.feeReserveTargetMicroUsdg),
    feeReserveTopUpMicroUsdg: nullableMoney(source.feeReserveTopUpMicroUsdg),
    feeReserveAfterMicroUsdg: nullableMoney(source.feeReserveAfterMicroUsdg),
    plannedHolderRewardsMicroUsdg: nullableMoney(source.plannedHolderRewardsMicroUsdg),
    paidHolderRewardsMicroUsdg: nullableMoney(source.paidHolderRewardsMicroUsdg),
    holderRewardsStatus: boundedText(source.holderRewardsStatus),
    distributionStatus: boundedText(source.distributionStatus),
  };
  assertExclusive(result.packGainMicroUsdg as string, result.packLossMicroUsdg as string);
  assertNullableExclusive(result.cycleGainMicroUsdg, result.cycleLossMicroUsdg);
  return result;
}

function readRoundAccountingV8(source: Record<string, unknown>): PublicCommunityRoundAccounting {
  exactKeys(source, ROUND_ACCOUNTING_V8_KEYS);
  requiredKeys(source, ROUND_ACCOUNTING_V8_KEYS);
  const result: PublicCommunityRoundAccounting = {
    packSpendMicroUsdg: nullableMoney(source.packSpendMicroUsdg),
    buybackMicroUsdg: nullableMoney(source.buybackMicroUsdg),
    collectorPurchaseDebit: nullableAmount(source.collectorPurchaseDebit),
    collectorBuybackProceeds: nullableAmount(source.collectorBuybackProceeds),
    packGainMicroUsdg: nullableMoney(source.packGainMicroUsdg),
    packLossMicroUsdg: nullableMoney(source.packLossMicroUsdg),
    quotedCosts: readQuotedCosts(source.quotedCosts),
    protectedCostsMicroUsdg: nullableMoney(source.protectedCostsMicroUsdg),
    confirmedCostsMicroUsdg: nullableSignedMoney(source.confirmedCostsMicroUsdg),
    cycleGainMicroUsdg: nullableMoney(source.cycleGainMicroUsdg),
    cycleLossMicroUsdg: nullableMoney(source.cycleLossMicroUsdg),
    walletBalanceBeforeMicroUsdg: nullableMoney(source.walletBalanceBeforeMicroUsdg),
    walletBalanceAfterMicroUsdg: nullableMoney(source.walletBalanceAfterMicroUsdg),
    networkFees: readNetworkFees(source.networkFees),
    feeReserveBeforeMicroUsdg: nullableMoney(source.feeReserveBeforeMicroUsdg),
    feeReserveTargetMicroUsdg: nullableMoney(source.feeReserveTargetMicroUsdg),
    feeReserveTopUpMicroUsdg: nullableMoney(source.feeReserveTopUpMicroUsdg),
    feeReserveAfterMicroUsdg: nullableMoney(source.feeReserveAfterMicroUsdg),
    plannedHolderRewardsMicroUsdg: nullableMoney(source.plannedHolderRewardsMicroUsdg),
    paidHolderRewardsMicroUsdg: nullableMoney(source.paidHolderRewardsMicroUsdg),
    holderRewardsStatus: boundedText(source.holderRewardsStatus),
    distributionStatus: boundedText(source.distributionStatus),
  };
  assertNullableExclusive(result.packGainMicroUsdg, result.packLossMicroUsdg);
  assertNullableExclusive(result.cycleGainMicroUsdg, result.cycleLossMicroUsdg);
  return result;
}

function nullableAmount(value: unknown): Amount | null {
  if (value === null) return null;
  try {
    return normalizeAmount(value);
  } catch {
    invalid();
  }
}

function readLegacyRoundAccounting(
  source: Record<string, unknown>,
  paidMicroUsdg: unknown,
): PublicCommunityRoundAccounting {
  exactKeys(source, LEGACY_ROUND_ACCOUNTING_KEYS);
  requiredKeys(source, LEGACY_ROUND_ACCOUNTING_KEYS);
  const packSpend = money(source.packSpendMicroUsdg);
  const buyback = money(source.buybackMicroUsdg);
  const confirmedCosts = nullableSignedMoney(source.confirmedCostsMicroUsdg);
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
    protectedCostsMicroUsdg: money(source.protectedCostsMicroUsdg),
    confirmedCostsMicroUsdg: confirmedCosts,
    cycleGainMicroUsdg: completeCost === null
      ? null
      : subtractBigIntAtZero(BigInt(buyback), completeCost),
    cycleLossMicroUsdg: completeCost === null
      ? null
      : subtractBigIntAtZero(completeCost, BigInt(buyback)),
    walletBalanceBeforeMicroUsdg: null,
    walletBalanceAfterMicroUsdg: null,
    networkFees: { walletLamportsCharged: null, purchase: null, buyback: null },
    feeReserveBeforeMicroUsdg: money(source.feeReserveBeforeMicroUsdg),
    feeReserveTargetMicroUsdg: money(source.feeReserveTargetMicroUsdg),
    feeReserveTopUpMicroUsdg: money(source.feeReserveTopUpMicroUsdg),
    feeReserveAfterMicroUsdg: money(source.feeReserveAfterMicroUsdg),
    plannedHolderRewardsMicroUsdg: money(source.holderRewardsMicroUsdg),
    paidHolderRewardsMicroUsdg: nullableMoney(paidMicroUsdg),
    holderRewardsStatus: "computed",
    distributionStatus: paidMicroUsdg === null ? "pending" : "legacy-settlement-recorded",
  };
}

function readQuotedCosts(value: unknown): PublicQuotedCosts {
  const source = requiredRecord(value);
  exactKeys(source, QUOTED_COST_KEYS);
  requiredKeys(source, QUOTED_COST_KEYS);
  return {
    outboundBridgeMicroUsdg: nullableMoney(source.outboundBridgeMicroUsdg),
    inboundBridgeMicroUsdg: nullableMoney(source.inboundBridgeMicroUsdg),
    collectorApiMicroUsdg: nullableMoney(source.collectorApiMicroUsdg),
    evmNetworkMicroUsdg: nullableMoney(source.evmNetworkMicroUsdg),
    solanaNetworkMicroUsdg: nullableMoney(source.solanaNetworkMicroUsdg),
    slippageMicroUsdg: nullableMoney(source.slippageMicroUsdg),
  };
}

function readNetworkFees(value: unknown): PublicRoundAccounting["networkFees"] {
  const source = requiredRecord(value);
  exactKeys(source, NETWORK_FEE_KEYS);
  requiredKeys(source, NETWORK_FEE_KEYS);
  return {
    walletLamportsCharged: nullableMoney(source.walletLamportsCharged),
    purchase: readNativeFee(source.purchase),
    buyback: readNativeFee(source.buyback),
  };
}

function readNativeFee(value: unknown): PublicNativeFee | null {
  if (value === null) return null;
  const source = requiredRecord(value);
  exactKeys(source, NATIVE_FEE_KEYS);
  requiredKeys(source, NATIVE_FEE_KEYS);
  return { lamports: money(source.lamports), paidBy: boundedText(source.paidBy) };
}

function assertExclusive(gain: string, loss: string) {
  if (gain !== "0" && loss !== "0") invalid();
}

function assertNullableExclusive(gain: string | null, loss: string | null) {
  if ((gain === null) !== (loss === null)) invalid();
  if (gain !== null && loss !== null) assertExclusive(gain, loss);
}

function readTransaction(value: unknown): PublicTransactionReference {
  const source = requiredRecord(value);
  exactKeys(source, TRANSACTION_KEYS);
  requiredKeys(source, TRANSACTION_KEYS);
  if (source.chain === "evm") {
    if (
      !new Set(["outbound-burn", "inbound-finalization", "reward-settlement"])
        .has(String(source.purpose)) ||
      typeof source.id !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(source.id)
    ) invalid();
  } else if (
    source.chain !== "solana" ||
    !new Set(["outbound-mint", "inbound-burn", "collector-purchase", "collector-buyback"])
      .has(String(source.purpose)) ||
    typeof source.id !== "string" ||
    !/^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(source.id)
  ) invalid();
  return source as PublicTransactionReference;
}

function readCard(value: unknown, schemaVersion: unknown): PublicCommunityCard | PublicCardEvent {
  if (schemaVersion === 8) {
    try {
      return normalizePublicCardEvent(value);
    } catch {
      invalid();
    }
  }
  const source = requiredRecord(value);
  const currentSchema = schemaVersion === 4 || schemaVersion === 5 || schemaVersion === 6 || schemaVersion === 7;
  exactKeys(source, currentSchema ? CARD_KEYS : LEGACY_CARD_KEYS);
  requiredKeys(
    source,
    currentSchema ? CARD_KEYS : new Set(["cycleId", "productId", "rarity"]),
  );
  const card: PublicCommunityCard = {
    cycleId: boundedText(source.cycleId),
    productId: boundedText(source.productId),
    rarity: boundedText(source.rarity),
    nftAddress: nullableText(source.nftAddress),
    cardName: nullableText(source.cardName),
    setName: nullableText(source.setName),
    cardNumber: nullableText(source.cardNumber),
    imageUrl: null,
    packPriceMicroUsdg: nullableMoney(source.packPriceMicroUsdg),
    buybackMicroUsdg: nullableMoney(source.buybackMicroUsdg),
  };
  if (source.imageUrl !== undefined && source.imageUrl !== null) {
    const url = new URL(boundedText(source.imageUrl));
    if (url.protocol !== "https:" || url.username || url.password) invalid();
    card.imageUrl = url.toString();
  }
  return card;
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) invalid();
  return value as Record<string, unknown>;
}

function requiredKeys(value: Record<string, unknown>, required: ReadonlySet<string>) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid();
  }
}

function boundedArray(value: unknown, maximumLength: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximumLength) invalid();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid();
  }
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid();
  }
}

function boundedText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH) invalid();
  return value;
}

function isoTimestamp(value: unknown): string {
  const text = boundedText(value);
  const date = new Date(text);
  if (Number.isNaN(date.getTime()) || date.toISOString() !== text) invalid();
  return text;
}

function optionalTimestamp(value: unknown): string | null {
  return value === null ? null : isoTimestamp(value);
}

function money(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value)) invalid();
  return value;
}

function nullableMoney(value: unknown): string | null {
  return value === undefined || value === null ? null : money(value);
}

function optionalSignedMoney(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^(0|-?[1-9]\d{0,77})$/.test(value)) invalid();
  return value;
}

function nullableSignedMoney(value: unknown): string | null {
  return value === undefined || value === null ? null : optionalSignedMoney(value);
}

function nullableText(value: unknown): string | null {
  return value === undefined || value === null ? null : boundedText(value);
}

function subtractAtZero(minuend: string, subtrahend: string): string {
  if (
    minuend.length < subtrahend.length ||
    (minuend.length === subtrahend.length && minuend.localeCompare(subtrahend) <= 0)
  ) return "0";
  let borrow = 0;
  let result = "";
  for (let offset = 0; offset < minuend.length; offset += 1) {
    let digit = Number(minuend.at(-1 - offset)) - Number(subtrahend.at(-1 - offset) ?? 0) - borrow;
    borrow = digit < 0 ? 1 : 0;
    if (digit < 0) digit += 10;
    result = String(digit) + result;
  }
  return result.replace(/^0+/, "") || "0";
}

function subtractBigIntAtZero(minuend: bigint, subtrahend: bigint): string {
  return (minuend > subtrahend ? minuend - subtrahend : 0n).toString();
}

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function invalid(): never {
  throw new TypeError("PUBLIC_COMMUNITY_SNAPSHOT_INVALID");
}
