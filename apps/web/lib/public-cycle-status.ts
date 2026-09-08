import { nativeValidationSkeleton, requireNativeRound } from "./native-accounting.mjs";
import {
  readDashboardProfile,
  type DashboardNetwork,
  type DashboardProfileId,
} from "./public-dashboard-profile.ts";
import { type Amount, normalizeAmount } from "./public-card-event.ts";
import { normalizeSchedulerView, type SchedulerView } from "./scheduler-view.ts";

export type PublicCycleAction = {
  type: string;
  status: "pending" | "complete" | "failed";
  at: string;
};

export type PublicCycleCard = {
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

export type PublicQuotedCosts = {
  outboundBridgeMicroUsdg: string | null;
  inboundBridgeMicroUsdg: string | null;
  collectorApiMicroUsdg: string | null;
  evmNetworkMicroUsdg: string | null;
  solanaNetworkMicroUsdg: string | null;
  slippageMicroUsdg: string | null;
};

export type PublicNativeFee = { lamports: string; paidBy: string };

export type PublicRoundAccounting = {
  packSpendMicroUsdg: string | null;
  buybackMicroUsdg: string | null;
  outboundBridgeDebit?: Amount | null;
  inboundBridgeProceeds?: Amount | null;
  collectorPurchaseDebit?: Amount | null;
  collectorBuybackProceeds?: Amount | null;
  packGainMicroUsdg: string | null;
  packLossMicroUsdg: string | null;
  quotedCosts: PublicQuotedCosts;
  protectedCostsMicroUsdg: string | null;
  confirmedCostsMicroUsdg: string | null;
  cycleGainMicroUsdg: string | null;
  cycleLossMicroUsdg: string | null;
  walletBalanceBeforeMicroUsdg: string | null;
  walletBalanceAfterMicroUsdg: string | null;
  networkFees: {
    walletLamportsCharged: string | null;
    purchase: PublicNativeFee | null;
    buyback: PublicNativeFee | null;
  };
  feeReserveBeforeMicroUsdg: string | null;
  feeReserveTargetMicroUsdg: string | null;
  feeReserveTopUpMicroUsdg: string | null;
  feeReserveAfterMicroUsdg: string | null;
  plannedHolderRewardsMicroUsdg: string | null;
  paidHolderRewardsMicroUsdg: string | null;
  payoutLiabilityMicroUsdg?: string | null;
  payoutDustMicroUsdg?: string | null;
  paidHolderRewardsRecipientCount?: number | null;
  holderRewardsStatus: string;
  distributionStatus: string;
};

export type PublicCycle = {
  cycleId: string;
  status: string;
  selectedPackId: string | null;
  maxBoostersPerCycle: number | null;
  plannedBoosters: number;
  openedBoosters: number;
  actions: PublicCycleAction[];
  cards: PublicCycleCard[];
  returnedMicroUsdg: string | null;
  rewardStatus: string | null;
  roundAccounting: PublicRoundAccounting | null;
  reason?: string;
  startedAt?: string;
  updatedAt?: string;
  spentMicroUsdg?: string | null;
  paidMicroUsdg?: string | null;
};

export type PublicHeldPosition = {
  positionId?: string;
  cycleId?: string;
  reason: string;
  ageSeconds: number;
  cycleState: string;
};

export type PublicCycleStatus = {
  schemaVersion: 3 | 4 | 5 | 6 | 7;
  profile: DashboardProfileId;
  network: DashboardNetwork;
  executionState: "active" | "paused" | "unknown";
  executionReason: "operator-paused" | null;
  generatedAt: string;
  nextCycleAt: string;
  countdownSeconds: number;
  cycle: PublicCycle | null;
  heldPositionCount?: number;
  heldPositions?: PublicHeldPosition[];
  scheduler?: SchedulerView;
};

const STATUS_KEYS = new Set([
  "schemaVersion",
  "profile",
  "network",
  "executionState",
  "executionReason",
  "generatedAt",
  "nextCycleAt",
  "countdownSeconds",
  "cycle",
]);
const STATUS_V4_KEYS = new Set([...STATUS_KEYS, "heldPositionCount", "heldPositions"]);
const STATUS_V6_KEYS = new Set([...STATUS_V4_KEYS, "scheduler"]);
const LEGACY_IDLE_STATUS_KEYS = new Set([
  "schemaVersion",
  "generatedAt",
  "nextCycleAt",
  "countdownSeconds",
  "cycle",
]);
const NETWORK_KEYS = new Set(["evm", "solana"]);
const EVM_NETWORK_KEYS = new Set(["name", "chainId", "label"]);
const SOLANA_NETWORK_KEYS = new Set(["name", "genesisHash", "label"]);
const CYCLE_REQUIRED_KEYS = [
  "cycleId",
  "status",
  "selectedPackId",
  "maxBoostersPerCycle",
  "plannedBoosters",
  "openedBoosters",
  "actions",
  "cards",
  "returnedMicroUsdg",
  "rewardStatus",
  "roundAccounting",
] as const;
const CYCLE_KEYS = new Set([
  ...CYCLE_REQUIRED_KEYS,
  "startedAt",
  "updatedAt",
  "spentMicroUsdg",
  "paidMicroUsdg",
  "reason",
]);
const LEGACY_CYCLE_REQUIRED_KEYS = CYCLE_REQUIRED_KEYS.filter(
  (key) => key !== "roundAccounting",
);
const LEGACY_CYCLE_KEYS = new Set([
  ...LEGACY_CYCLE_REQUIRED_KEYS,
  "startedAt",
  "updatedAt",
  "spentMicroUsdg",
  "paidMicroUsdg",
  "reason",
]);
const ACTION_KEYS = new Set(["type", "status", "at"]);
const CARD_KEYS = new Set([
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
  "productId",
  "rarity",
  "nftAddress",
  "cardName",
  "setName",
  "cardNumber",
  "imageUrl",
]);
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
// schemaVersion 6: packSpend/buyback/packGain/packLoss become nullable (an unknown amount is
// `null`, never an invented '0'), and two typed Amount|null fields distinguish the real
// Collector-Crypt-side (Solana) purchase debit/buyback proceeds from the EVM-side USDG bridge
// amounts, which are a different chain/asset and never assumed at parity.
const ROUND_ACCOUNTING_V6_KEYS = new Set([
  ...ROUND_ACCOUNTING_KEYS,
  "outboundBridgeDebit",
  "inboundBridgeProceeds",
  "collectorPurchaseDebit",
  "collectorBuybackProceeds",
  "payoutLiabilityMicroUsdg",
  "payoutDustMicroUsdg",
  "paidHolderRewardsRecipientCount",
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
const HELD_POSITION_V4_KEYS = new Set(["positionId", "cycleId", "reason", "ageSeconds", "cycleState"]);
const HELD_POSITION_V5_KEYS = new Set(["reason", "ageSeconds", "cycleState"]);
const SCHEDULER_KEYS = new Set(["nextCycleAt", "nextReconcileAt", "automationEnabled", "paused", "pendingReason"]);
const ACTION_STATUSES = new Set(["pending", "complete", "failed"]);
const EXECUTION_STATES = new Set(["active", "paused", "unknown"]);
const MAX_PUBLIC_CARDS = 60;
const MAX_TEXT_LENGTH = 512;

export function normalizePublicCycleStatus(
  value: unknown,
  expectedProfile?: DashboardProfileId,
): PublicCycleStatus {
  if (value !== null && typeof value === "object" && "schemaVersion" in value && value.schemaVersion === 7) {
    const source = value as Record<string, unknown>;
    const cycle = source.cycle as Record<string, unknown> | null;
    requireNativeRound(cycle?.roundAccounting ?? null);
    const skeleton = nativeValidationSkeleton(source) as Record<string, unknown>;
    skeleton.schemaVersion = 6;
    normalizePublicCycleStatus(skeleton, expectedProfile);
    return structuredClone(source) as unknown as PublicCycleStatus;
  }
  try {
    return readPublicCycleStatus(value, expectedProfile);
  } catch {
    throw new TypeError("PUBLIC_CYCLE_STATUS_INVALID");
  }
}

function readPublicCycleStatus(
  value: unknown,
  expectedProfile?: DashboardProfileId,
): PublicCycleStatus {
  const source = requiredRecord(value);
  if (source.schemaVersion === 1) {
    return readLegacyIdleStatus(source, expectedProfile);
  }
  const statusKeys = source.schemaVersion === 6
    ? STATUS_V6_KEYS
    : (source.schemaVersion === 5 || source.schemaVersion === 4 ? STATUS_V4_KEYS : STATUS_KEYS);
  exactKeys(source, statusKeys);
  requiredKeys(source, statusKeys);
  if (
    !(source.schemaVersion === 2 || source.schemaVersion === 3 || source.schemaVersion === 4 ||
      source.schemaVersion === 5 || source.schemaVersion === 6)
  ) invalid();
  const schemaVersion = source.schemaVersion;
  const selected = readDashboardProfile(source.profile);
  if (expectedProfile !== undefined && readDashboardProfile(expectedProfile).id !== selected.id) {
    invalid();
  }
  if (
    !EXECUTION_STATES.has(String(source.executionState)) ||
    source.executionReason !== (source.executionState === "paused" ? "operator-paused" : null)
  ) invalid();

  const generatedAt = isoTimestamp(source.generatedAt);
  const nextCycleAt = isoTimestamp(source.nextCycleAt);
  const expectedCountdown = Math.ceil(
    Math.max(0, Date.parse(nextCycleAt) - Date.parse(generatedAt)) / 1_000,
  );
  if (source.countdownSeconds !== expectedCountdown) invalid();

  const result: PublicCycleStatus = {
    schemaVersion: schemaVersion === 6 ? 6 : (schemaVersion === 5 ? 5 : (schemaVersion === 4 ? 4 : 3)),
    profile: selected.id,
    network: readNetwork(source.network, selected.network),
    executionState: source.executionState as PublicCycleStatus["executionState"],
    executionReason: source.executionReason as PublicCycleStatus["executionReason"],
    generatedAt,
    nextCycleAt,
    countdownSeconds: nonNegativeInteger(source.countdownSeconds),
    cycle: source.cycle === null ? null : readCycle(source.cycle, schemaVersion),
  };
  if (schemaVersion === 4 || schemaVersion === 5 || schemaVersion === 6) {
    result.heldPositionCount = nonNegativeInteger(source.heldPositionCount);
    result.heldPositions = readHeldPositions(source.heldPositions, result.heldPositionCount, schemaVersion);
  }
  if (schemaVersion === 6) {
    result.scheduler = readScheduler(source.scheduler);
  }
  return result;
}

function readScheduler(value: unknown): SchedulerView {
  const source = requiredRecord(value);
  exactKeys(source, SCHEDULER_KEYS);
  requiredKeys(source, SCHEDULER_KEYS);
  try {
    return normalizeSchedulerView(source);
  } catch {
    invalid();
  }
}

function readLegacyIdleStatus(
  source: Record<string, unknown>,
  expectedProfile?: DashboardProfileId,
): PublicCycleStatus {
  exactKeys(source, LEGACY_IDLE_STATUS_KEYS);
  requiredKeys(source, LEGACY_IDLE_STATUS_KEYS);
  if (source.cycle !== null) invalid();
  const selected = readDashboardProfile(expectedProfile);
  const generatedAt = isoTimestamp(source.generatedAt);
  const nextCycleAt = isoTimestamp(source.nextCycleAt);
  const expectedCountdown = Math.ceil(
    Math.max(0, Date.parse(nextCycleAt) - Date.parse(generatedAt)) / 1_000,
  );
  if (source.countdownSeconds !== expectedCountdown) invalid();

  return {
    schemaVersion: 3,
    profile: selected.id,
    network: selected.network,
    executionState: "unknown",
    executionReason: null,
    generatedAt,
    nextCycleAt,
    countdownSeconds: nonNegativeInteger(source.countdownSeconds),
    cycle: null,
  };
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

function readCycle(value: unknown, schemaVersion: unknown): PublicCycle {
  const source = requiredRecord(value);
  const currentSchema = schemaVersion === 3 || schemaVersion === 4 || schemaVersion === 5 || schemaVersion === 6;
  exactKeys(source, currentSchema ? CYCLE_KEYS : LEGACY_CYCLE_KEYS);
  requiredKeys(source, currentSchema ? CYCLE_REQUIRED_KEYS : LEGACY_CYCLE_REQUIRED_KEYS);

  const maxBoostersPerCycle = source.maxBoostersPerCycle === null
    ? null
    : positiveSafeInteger(source.maxBoostersPerCycle);
  const plannedBoosters = nonNegativeInteger(source.plannedBoosters);
  const openedBoosters = nonNegativeInteger(source.openedBoosters);

  const actions = boundedArray(source.actions, 128).map(readAction);
  const cards = boundedArray(source.cards, MAX_PUBLIC_CARDS).map((card) =>
    readCard(card, schemaVersion));
  if (cards.length !== Math.min(openedBoosters, MAX_PUBLIC_CARDS)) invalid();

  const cycle: PublicCycle = {
    cycleId: boundedText(source.cycleId),
    status: boundedText(source.status),
    selectedPackId: optionalText(source.selectedPackId),
    maxBoostersPerCycle,
    plannedBoosters,
    openedBoosters,
    actions,
    cards,
    returnedMicroUsdg: optionalMoney(source.returnedMicroUsdg),
    rewardStatus: optionalText(source.rewardStatus),
    roundAccounting: currentSchema ? readRoundAccounting(source.roundAccounting, schemaVersion) : null,
  };
  if (source.startedAt !== undefined) cycle.startedAt = isoTimestamp(source.startedAt);
  if (source.updatedAt !== undefined) cycle.updatedAt = isoTimestamp(source.updatedAt);
  if (source.spentMicroUsdg !== undefined) cycle.spentMicroUsdg = optionalMoney(source.spentMicroUsdg);
  if (source.paidMicroUsdg !== undefined) cycle.paidMicroUsdg = optionalMoney(source.paidMicroUsdg);
  if (source.reason !== undefined) cycle.reason = stableReason(source.reason);
  return cycle;
}

function readHeldPositions(
  value: unknown,
  heldPositionCount: number,
  schemaVersion: unknown,
): PublicHeldPosition[] {
  const positions = boundedArray(value, 1_000).map((position) => {
    const source = requiredRecord(position);
    const keys = schemaVersion === 5 || schemaVersion === 6 ? HELD_POSITION_V5_KEYS : HELD_POSITION_V4_KEYS;
    exactKeys(source, keys);
    requiredKeys(source, keys);
    if (typeof source.reason !== "string" || !/^[A-Z][A-Z0-9_]{2,63}$/.test(source.reason)) invalid();
    const result: PublicHeldPosition = {
      reason: source.reason,
      ageSeconds: nonNegativeInteger(source.ageSeconds),
      cycleState: boundedText(source.cycleState),
    };
    if (schemaVersion === 4) {
      result.positionId = boundedText(source.positionId);
      result.cycleId = boundedText(source.cycleId);
    }
    return result;
  });
  if (heldPositionCount !== positions.length) invalid();
  return positions;
}

function stableReason(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) invalid();
  return value;
}

function readAction(value: unknown): PublicCycleAction {
  const source = requiredRecord(value);
  exactKeys(source, ACTION_KEYS);
  requiredKeys(source, ACTION_KEYS);
  if (!ACTION_STATUSES.has(String(source.status))) invalid();
  return {
    type: boundedText(source.type),
    status: source.status as PublicCycleAction["status"],
    at: isoTimestamp(source.at),
  };
}

function readCard(value: unknown, schemaVersion: unknown): PublicCycleCard {
  const source = requiredRecord(value);
  const currentSchema = schemaVersion === 3 || schemaVersion === 4 || schemaVersion === 5 || schemaVersion === 6;
  exactKeys(source, currentSchema ? CARD_KEYS : LEGACY_CARD_KEYS);
  requiredKeys(source, currentSchema ? CARD_KEYS : new Set(["productId", "rarity"]));
  const card: PublicCycleCard = {
    productId: boundedText(source.productId),
    rarity: boundedText(source.rarity),
    nftAddress: nullableText(source.nftAddress),
    cardName: nullableText(source.cardName),
    setName: nullableText(source.setName),
    cardNumber: nullableText(source.cardNumber),
    imageUrl: null,
    packPriceMicroUsdg: optionalMoney(source.packPriceMicroUsdg ?? null),
    buybackMicroUsdg: optionalMoney(source.buybackMicroUsdg ?? null),
  };
  if (source.imageUrl !== undefined && source.imageUrl !== null) {
    const imageUrl = new URL(boundedText(source.imageUrl));
    if (imageUrl.protocol !== "https:" || imageUrl.username || imageUrl.password) invalid();
    card.imageUrl = imageUrl.toString();
  }
  return card;
}

function readRoundAccounting(value: unknown, schemaVersion: unknown): PublicRoundAccounting | null {
  if (value === null) return null;
  const source = requiredRecord(value);
  if (schemaVersion === 6) return readRoundAccountingV6(source);
  exactKeys(source, ROUND_ACCOUNTING_KEYS);
  requiredKeys(source, ROUND_ACCOUNTING_KEYS);
  const result: PublicRoundAccounting = {
    packSpendMicroUsdg: money(source.packSpendMicroUsdg),
    buybackMicroUsdg: money(source.buybackMicroUsdg),
    packGainMicroUsdg: money(source.packGainMicroUsdg),
    packLossMicroUsdg: money(source.packLossMicroUsdg),
    quotedCosts: readQuotedCosts(source.quotedCosts),
    protectedCostsMicroUsdg: optionalMoney(source.protectedCostsMicroUsdg),
    confirmedCostsMicroUsdg: optionalSignedMoney(source.confirmedCostsMicroUsdg),
    cycleGainMicroUsdg: optionalMoney(source.cycleGainMicroUsdg),
    cycleLossMicroUsdg: optionalMoney(source.cycleLossMicroUsdg),
    walletBalanceBeforeMicroUsdg: optionalMoney(source.walletBalanceBeforeMicroUsdg),
    walletBalanceAfterMicroUsdg: optionalMoney(source.walletBalanceAfterMicroUsdg),
    networkFees: readNetworkFees(source.networkFees),
    feeReserveBeforeMicroUsdg: optionalMoney(source.feeReserveBeforeMicroUsdg),
    feeReserveTargetMicroUsdg: optionalMoney(source.feeReserveTargetMicroUsdg),
    feeReserveTopUpMicroUsdg: optionalMoney(source.feeReserveTopUpMicroUsdg),
    feeReserveAfterMicroUsdg: optionalMoney(source.feeReserveAfterMicroUsdg),
    plannedHolderRewardsMicroUsdg: optionalMoney(source.plannedHolderRewardsMicroUsdg),
    paidHolderRewardsMicroUsdg: optionalMoney(source.paidHolderRewardsMicroUsdg),
    holderRewardsStatus: boundedText(source.holderRewardsStatus),
    distributionStatus: boundedText(source.distributionStatus),
  };
  assertExclusive(result.packGainMicroUsdg as string, result.packLossMicroUsdg as string);
  assertNullableExclusive(result.cycleGainMicroUsdg, result.cycleLossMicroUsdg);
  return result;
}

function readRoundAccountingV6(source: Record<string, unknown>): PublicRoundAccounting {
  exactKeys(source, ROUND_ACCOUNTING_V6_KEYS);
  requiredKeys(source, ROUND_ACCOUNTING_V6_KEYS);
  const result: PublicRoundAccounting = {
    packSpendMicroUsdg: nullableMoney(source.packSpendMicroUsdg),
    buybackMicroUsdg: nullableMoney(source.buybackMicroUsdg),
    outboundBridgeDebit: nullableAmount(source.outboundBridgeDebit),
    inboundBridgeProceeds: nullableAmount(source.inboundBridgeProceeds),
    collectorPurchaseDebit: nullableAmount(source.collectorPurchaseDebit),
    collectorBuybackProceeds: nullableAmount(source.collectorBuybackProceeds),
    packGainMicroUsdg: nullableMoney(source.packGainMicroUsdg),
    packLossMicroUsdg: nullableMoney(source.packLossMicroUsdg),
    quotedCosts: readQuotedCosts(source.quotedCosts),
    protectedCostsMicroUsdg: optionalMoney(source.protectedCostsMicroUsdg),
    confirmedCostsMicroUsdg: optionalSignedMoney(source.confirmedCostsMicroUsdg),
    cycleGainMicroUsdg: optionalMoney(source.cycleGainMicroUsdg),
    cycleLossMicroUsdg: optionalMoney(source.cycleLossMicroUsdg),
    walletBalanceBeforeMicroUsdg: optionalMoney(source.walletBalanceBeforeMicroUsdg),
    walletBalanceAfterMicroUsdg: optionalMoney(source.walletBalanceAfterMicroUsdg),
    networkFees: readNetworkFees(source.networkFees),
    feeReserveBeforeMicroUsdg: optionalMoney(source.feeReserveBeforeMicroUsdg),
    feeReserveTargetMicroUsdg: optionalMoney(source.feeReserveTargetMicroUsdg),
    feeReserveTopUpMicroUsdg: optionalMoney(source.feeReserveTopUpMicroUsdg),
    feeReserveAfterMicroUsdg: optionalMoney(source.feeReserveAfterMicroUsdg),
    plannedHolderRewardsMicroUsdg: optionalMoney(source.plannedHolderRewardsMicroUsdg),
    paidHolderRewardsMicroUsdg: optionalMoney(source.paidHolderRewardsMicroUsdg),
    payoutLiabilityMicroUsdg: optionalMoney(source.payoutLiabilityMicroUsdg),
    payoutDustMicroUsdg: optionalMoney(source.payoutDustMicroUsdg),
    paidHolderRewardsRecipientCount: nullableNonNegativeInteger(source.paidHolderRewardsRecipientCount),
    holderRewardsStatus: boundedText(source.holderRewardsStatus),
    distributionStatus: boundedText(source.distributionStatus),
  };
  assertNullableExclusive(result.packGainMicroUsdg, result.packLossMicroUsdg);
  assertNullableExclusive(result.cycleGainMicroUsdg, result.cycleLossMicroUsdg);
  return result;
}

function nullableNonNegativeInteger(value: unknown): number | null {
  return value === null ? null : nonNegativeInteger(value);
}

function nullableAmount(value: unknown): Amount | null {
  if (value === null) return null;
  try {
    return normalizeAmount(value);
  } catch {
    invalid();
  }
}

function readQuotedCosts(value: unknown): PublicQuotedCosts {
  const source = requiredRecord(value);
  exactKeys(source, QUOTED_COST_KEYS);
  requiredKeys(source, QUOTED_COST_KEYS);
  return {
    outboundBridgeMicroUsdg: optionalMoney(source.outboundBridgeMicroUsdg),
    inboundBridgeMicroUsdg: optionalMoney(source.inboundBridgeMicroUsdg),
    collectorApiMicroUsdg: optionalMoney(source.collectorApiMicroUsdg),
    evmNetworkMicroUsdg: optionalMoney(source.evmNetworkMicroUsdg),
    solanaNetworkMicroUsdg: optionalMoney(source.solanaNetworkMicroUsdg),
    slippageMicroUsdg: optionalMoney(source.slippageMicroUsdg),
  };
}

function readNetworkFees(value: unknown): PublicRoundAccounting["networkFees"] {
  const source = requiredRecord(value);
  exactKeys(source, NETWORK_FEE_KEYS);
  requiredKeys(source, NETWORK_FEE_KEYS);
  return {
    walletLamportsCharged: optionalMoney(source.walletLamportsCharged),
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

function requiredRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) invalid();
  return value as Record<string, unknown>;
}

function requiredKeys(
  value: Record<string, unknown>,
  required: ReadonlySet<string> | readonly string[],
) {
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

function optionalText(value: unknown): string | null {
  return value === null ? null : boundedText(value);
}

function nullableText(value: unknown): string | null {
  return value === undefined || value === null ? null : boundedText(value);
}

function isoTimestamp(value: unknown): string {
  const text = boundedText(value);
  const timestamp = new Date(text);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== text) invalid();
  return text;
}

function optionalMoney(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value)) invalid();
  return value;
}

function nullableMoney(value: unknown): string | null {
  return value === undefined || value === null ? null : optionalMoney(value);
}

function optionalSignedMoney(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !/^(0|-?[1-9]\d{0,77})$/.test(value)) invalid();
  return value;
}

function money(value: unknown): string {
  const result = optionalMoney(value);
  if (result === null) invalid();
  return result;
}

function positiveSafeInteger(value: unknown): number {
  const result = nonNegativeInteger(value);
  if (result === 0) invalid();
  return result;
}

function nonNegativeInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function invalid(): never {
  throw new TypeError("PUBLIC_CYCLE_STATUS_INVALID");
}
