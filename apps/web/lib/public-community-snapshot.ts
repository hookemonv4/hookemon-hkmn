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
} from "./public-cycle-status.ts";

export type PublicCommunityMetrics = {
  latestObservedProjectPoolMicroUsdc: string | null;
  totalCycleFundingMicroUsdc: string;
  totalCollectorSpendMicroUsdc: string;
  totalBuybacksReturnedMicroUsdc: string;
  totalBridgedBackMicroUsdc: string;
  totalRewardsPaidMicroUsdc: string;
  totalRewardsDeferredMicroUsdc: string;
  totalQuotedOperatingCostsMicroUsdc: string;
  latestRetainedReserveMicroUsdc: string;
  latestCycleReserveTargetMicroUsdc: string;
  completedCycles: number;
  skippedCycles: number;
  openedPacks: number;
};

export type PublicCommunityCycle = {
  cycleId: string;
  status: string;
  reason: string | null;
  updatedAt: string | null;
  paidMicroUsdc: string | null;
  payoutRecipientCount: number;
  roundAccounting: PublicCommunityRoundAccounting | null;
  transactions: PublicTransactionReference[];
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
  packPriceMicroUsdc: string | null;
  buybackMicroUsdc: string | null;
};

export type PublicCommunitySnapshot = {
  schemaVersion: 4;
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
  cards: PublicCommunityCard[];
};

const MONEY_KEYS = [
  "latestObservedProjectPoolMicroUsdc",
  "totalCycleFundingMicroUsdc",
  "totalCollectorSpendMicroUsdc",
  "totalBuybacksReturnedMicroUsdc",
  "totalBridgedBackMicroUsdc",
  "totalRewardsPaidMicroUsdc",
  "totalRewardsDeferredMicroUsdc",
  "totalQuotedOperatingCostsMicroUsdc",
  "latestRetainedReserveMicroUsdc",
  "latestCycleReserveTargetMicroUsdc",
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
const NETWORK_KEYS = new Set(["ethereum", "solana"]);
const ETHEREUM_NETWORK_KEYS = new Set(["name", "chainId", "label"]);
const SOLANA_NETWORK_KEYS = new Set(["name", "genesisHash", "label"]);
const METRIC_KEYS = new Set([...MONEY_KEYS, ...COUNT_KEYS]);
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
const CARD_KEYS = new Set([
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
    exactKeys(source, SNAPSHOT_KEYS);
    requiredKeys(source, SNAPSHOT_KEYS);
    if (!(source.schemaVersion === 3 || source.schemaVersion === 4) ||
      typeof source.historyComplete !== "boolean") invalid();
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
      (metricsSource.latestObservedProjectPoolMicroUsdc === null)
    ) invalid();
    const metrics = {} as PublicCommunityMetrics;
    metrics.latestObservedProjectPoolMicroUsdc =
      metricsSource.latestObservedProjectPoolMicroUsdc === null
        ? null
        : money(metricsSource.latestObservedProjectPoolMicroUsdc);
    for (const key of MONEY_KEYS.slice(1)) metrics[key] = money(metricsSource[key]);
    for (const key of COUNT_KEYS) metrics[key] = count(metricsSource[key]);

    return {
      schemaVersion: 4,
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
        readCard(card, sourceSchemaVersion)),
    };
  } catch {
    throw new TypeError("PUBLIC_COMMUNITY_SNAPSHOT_INVALID");
  }
}

function readNetwork(value: unknown, expected: DashboardNetwork): DashboardNetwork {
  const source = requiredRecord(value);
  exactKeys(source, NETWORK_KEYS);
  requiredKeys(source, NETWORK_KEYS);
  const ethereum = requiredRecord(source.ethereum);
  const solana = requiredRecord(source.solana);
  exactKeys(ethereum, ETHEREUM_NETWORK_KEYS);
  exactKeys(solana, SOLANA_NETWORK_KEYS);
  requiredKeys(ethereum, ETHEREUM_NETWORK_KEYS);
  requiredKeys(solana, SOLANA_NETWORK_KEYS);
  if (
    ethereum.name !== expected.ethereum.name ||
    ethereum.chainId !== expected.ethereum.chainId ||
    ethereum.label !== expected.ethereum.label ||
    solana.name !== expected.solana.name ||
    solana.genesisHash !== expected.solana.genesisHash ||
    solana.label !== expected.solana.label
  ) invalid();
  return expected;
}

function readLatestCycle(value: unknown, schemaVersion: unknown): PublicCommunityCycle | null {
  if (value === null) return null;
  const source = requiredRecord(value);
  exactKeys(source, LATEST_CYCLE_KEYS);
  requiredKeys(source, LATEST_CYCLE_KEYS);
  const transactions = boundedArray(source.transactions, MAX_TRANSACTIONS).map(readTransaction);
  if (
    new Set(transactions.map(({ chain, id }) =>
      `${chain}:${chain === "ethereum" ? id.toLowerCase() : id}`)).size !== transactions.length
  ) invalid();
  return {
    cycleId: boundedText(source.cycleId),
    status: boundedText(source.status),
    reason: source.reason === null ? null : boundedText(source.reason),
    updatedAt: optionalTimestamp(source.updatedAt),
    paidMicroUsdc: source.paidMicroUsdc === null ? null : money(source.paidMicroUsdc),
    payoutRecipientCount: count(source.payoutRecipientCount),
    roundAccounting: readRoundAccounting(
      source.roundAccounting,
      schemaVersion,
      source.paidMicroUsdc,
    ),
    transactions,
  };
}

function readRoundAccounting(
  value: unknown,
  schemaVersion: unknown,
  paidMicroUsdc: unknown,
): PublicCommunityRoundAccounting | null {
  if (value === null) return null;
  const source = requiredRecord(value);
  if (schemaVersion === 3) return readLegacyRoundAccounting(source, paidMicroUsdc);
  exactKeys(source, ROUND_ACCOUNTING_KEYS);
  requiredKeys(source, ROUND_ACCOUNTING_KEYS);
  const result: PublicCommunityRoundAccounting = {
    packSpendMicroUsdc: money(source.packSpendMicroUsdc),
    buybackMicroUsdc: money(source.buybackMicroUsdc),
    packGainMicroUsdc: money(source.packGainMicroUsdc),
    packLossMicroUsdc: money(source.packLossMicroUsdc),
    quotedCosts: readQuotedCosts(source.quotedCosts),
    protectedCostsMicroUsdc: nullableMoney(source.protectedCostsMicroUsdc),
    confirmedCostsMicroUsdc: source.confirmedCostsMicroUsdc === null
      ? null
      : money(source.confirmedCostsMicroUsdc),
    cycleGainMicroUsdc: nullableMoney(source.cycleGainMicroUsdc),
    cycleLossMicroUsdc: nullableMoney(source.cycleLossMicroUsdc),
    walletBalanceBeforeMicroUsdc: nullableMoney(source.walletBalanceBeforeMicroUsdc),
    walletBalanceAfterMicroUsdc: nullableMoney(source.walletBalanceAfterMicroUsdc),
    networkFees: readNetworkFees(source.networkFees),
    feeReserveBeforeMicroUsdc: nullableMoney(source.feeReserveBeforeMicroUsdc),
    feeReserveTargetMicroUsdc: nullableMoney(source.feeReserveTargetMicroUsdc),
    feeReserveTopUpMicroUsdc: nullableMoney(source.feeReserveTopUpMicroUsdc),
    feeReserveAfterMicroUsdc: nullableMoney(source.feeReserveAfterMicroUsdc),
    plannedHolderRewardsMicroUsdc: nullableMoney(source.plannedHolderRewardsMicroUsdc),
    paidHolderRewardsMicroUsdc: nullableMoney(source.paidHolderRewardsMicroUsdc),
    holderRewardsStatus: boundedText(source.holderRewardsStatus),
    distributionStatus: boundedText(source.distributionStatus),
  };
  assertExclusive(result.packGainMicroUsdc, result.packLossMicroUsdc);
  assertNullableExclusive(result.cycleGainMicroUsdc, result.cycleLossMicroUsdc);
  return result;
}

function readLegacyRoundAccounting(
  source: Record<string, unknown>,
  paidMicroUsdc: unknown,
): PublicCommunityRoundAccounting {
  exactKeys(source, LEGACY_ROUND_ACCOUNTING_KEYS);
  requiredKeys(source, LEGACY_ROUND_ACCOUNTING_KEYS);
  const packSpend = money(source.packSpendMicroUsdc);
  const buyback = money(source.buybackMicroUsdc);
  const confirmedCosts = nullableMoney(source.confirmedCostsMicroUsdc);
  const completeCost = confirmedCosts === null ? null : addDecimal(packSpend, confirmedCosts);
  return {
    packSpendMicroUsdc: packSpend,
    buybackMicroUsdc: buyback,
    packGainMicroUsdc: subtractAtZero(buyback, packSpend),
    packLossMicroUsdc: subtractAtZero(packSpend, buyback),
    quotedCosts: {
      outboundBridgeMicroUsdc: null,
      inboundBridgeMicroUsdc: null,
      collectorApiMicroUsdc: null,
      ethereumNetworkMicroUsdc: null,
      solanaNetworkMicroUsdc: null,
      slippageMicroUsdc: null,
    },
    protectedCostsMicroUsdc: money(source.protectedCostsMicroUsdc),
    confirmedCostsMicroUsdc: confirmedCosts,
    cycleGainMicroUsdc: completeCost === null
      ? null
      : subtractAtZero(buyback, completeCost),
    cycleLossMicroUsdc: completeCost === null
      ? null
      : subtractAtZero(completeCost, buyback),
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

function readQuotedCosts(value: unknown): PublicQuotedCosts {
  const source = requiredRecord(value);
  exactKeys(source, QUOTED_COST_KEYS);
  requiredKeys(source, QUOTED_COST_KEYS);
  return {
    outboundBridgeMicroUsdc: nullableMoney(source.outboundBridgeMicroUsdc),
    inboundBridgeMicroUsdc: nullableMoney(source.inboundBridgeMicroUsdc),
    collectorApiMicroUsdc: nullableMoney(source.collectorApiMicroUsdc),
    ethereumNetworkMicroUsdc: nullableMoney(source.ethereumNetworkMicroUsdc),
    solanaNetworkMicroUsdc: nullableMoney(source.solanaNetworkMicroUsdc),
    slippageMicroUsdc: nullableMoney(source.slippageMicroUsdc),
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
  if (source.chain === "ethereum") {
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

function readCard(value: unknown, schemaVersion: unknown): PublicCommunityCard {
  const source = requiredRecord(value);
  exactKeys(source, schemaVersion === 4 ? CARD_KEYS : LEGACY_CARD_KEYS);
  requiredKeys(
    source,
    schemaVersion === 4 ? CARD_KEYS : new Set(["cycleId", "productId", "rarity"]),
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

function exactKeys(value: Record<string, unknown>, allowed: Set<string>) {
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

function nullableText(value: unknown): string | null {
  return value === undefined || value === null ? null : boundedText(value);
}

function addDecimal(left: string, right: string): string {
  let carry = 0;
  let result = "";
  for (let offset = 0; offset < Math.max(left.length, right.length); offset += 1) {
    const sum = Number(left.at(-1 - offset) ?? 0) + Number(right.at(-1 - offset) ?? 0) + carry;
    result = String(sum % 10) + result;
    carry = Math.floor(sum / 10);
  }
  return carry === 0 ? result : String(carry) + result;
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

function count(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function invalid(): never {
  throw new TypeError("PUBLIC_COMMUNITY_SNAPSHOT_INVALID");
}
