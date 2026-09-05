import {
  readDashboardProfile,
  type DashboardNetwork,
  type DashboardProfileId,
} from "./public-dashboard-profile.ts";

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
  packPriceMicroUsdc: string | null;
  buybackMicroUsdc: string | null;
};

export type PublicQuotedCosts = {
  outboundBridgeMicroUsdc: string | null;
  inboundBridgeMicroUsdc: string | null;
  collectorApiMicroUsdc: string | null;
  ethereumNetworkMicroUsdc: string | null;
  solanaNetworkMicroUsdc: string | null;
  slippageMicroUsdc: string | null;
};

export type PublicNativeFee = { lamports: string; paidBy: string };

export type PublicRoundAccounting = {
  packSpendMicroUsdc: string;
  buybackMicroUsdc: string;
  packGainMicroUsdc: string;
  packLossMicroUsdc: string;
  quotedCosts: PublicQuotedCosts;
  protectedCostsMicroUsdc: string | null;
  confirmedCostsMicroUsdc: string | null;
  cycleGainMicroUsdc: string | null;
  cycleLossMicroUsdc: string | null;
  walletBalanceBeforeMicroUsdc: string | null;
  walletBalanceAfterMicroUsdc: string | null;
  networkFees: {
    walletLamportsCharged: string | null;
    purchase: PublicNativeFee | null;
    buyback: PublicNativeFee | null;
  };
  feeReserveBeforeMicroUsdc: string | null;
  feeReserveTargetMicroUsdc: string | null;
  feeReserveTopUpMicroUsdc: string | null;
  feeReserveAfterMicroUsdc: string | null;
  plannedHolderRewardsMicroUsdc: string | null;
  paidHolderRewardsMicroUsdc: string | null;
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
  returnedMicroUsdc: string | null;
  rewardStatus: string | null;
  roundAccounting: PublicRoundAccounting | null;
  reason?: string;
  startedAt?: string;
  updatedAt?: string;
  spentMicroUsdc?: string | null;
  paidMicroUsdc?: string | null;
};

export type PublicCycleStatus = {
  schemaVersion: 3;
  profile: DashboardProfileId;
  network: DashboardNetwork;
  executionState: "active" | "paused" | "unknown";
  executionReason: "operator-paused" | null;
  generatedAt: string;
  nextCycleAt: string;
  countdownSeconds: number;
  cycle: PublicCycle | null;
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
const LEGACY_IDLE_STATUS_KEYS = new Set([
  "schemaVersion",
  "generatedAt",
  "nextCycleAt",
  "countdownSeconds",
  "cycle",
]);
const NETWORK_KEYS = new Set(["ethereum", "solana"]);
const ETHEREUM_NETWORK_KEYS = new Set(["name", "chainId", "label"]);
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
  "returnedMicroUsdc",
  "rewardStatus",
  "roundAccounting",
] as const;
const CYCLE_KEYS = new Set([
  ...CYCLE_REQUIRED_KEYS,
  "startedAt",
  "updatedAt",
  "spentMicroUsdc",
  "paidMicroUsdc",
  "reason",
]);
const LEGACY_CYCLE_REQUIRED_KEYS = CYCLE_REQUIRED_KEYS.filter(
  (key) => key !== "roundAccounting",
);
const LEGACY_CYCLE_KEYS = new Set([
  ...LEGACY_CYCLE_REQUIRED_KEYS,
  "startedAt",
  "updatedAt",
  "spentMicroUsdc",
  "paidMicroUsdc",
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
  "packPriceMicroUsdc",
  "buybackMicroUsdc",
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
const ACTION_STATUSES = new Set(["pending", "complete", "failed"]);
const EXECUTION_STATES = new Set(["active", "paused", "unknown"]);
const MAX_PUBLIC_CARDS = 60;
const MAX_TEXT_LENGTH = 512;

export function normalizePublicCycleStatus(
  value: unknown,
  expectedProfile?: DashboardProfileId,
): PublicCycleStatus {
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
  exactKeys(source, STATUS_KEYS);
  requiredKeys(source, STATUS_KEYS);
  if (!(source.schemaVersion === 2 || source.schemaVersion === 3)) invalid();
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

  return {
    schemaVersion: 3,
    profile: selected.id,
    network: readNetwork(source.network, selected.network),
    executionState: source.executionState as PublicCycleStatus["executionState"],
    executionReason: source.executionReason as PublicCycleStatus["executionReason"],
    generatedAt,
    nextCycleAt,
    countdownSeconds: nonNegativeInteger(source.countdownSeconds),
    cycle: source.cycle === null ? null : readCycle(source.cycle, schemaVersion),
  };
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

function readCycle(value: unknown, schemaVersion: unknown): PublicCycle {
  const source = requiredRecord(value);
  exactKeys(source, schemaVersion === 3 ? CYCLE_KEYS : LEGACY_CYCLE_KEYS);
  requiredKeys(source, schemaVersion === 3 ? CYCLE_REQUIRED_KEYS : LEGACY_CYCLE_REQUIRED_KEYS);

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
    returnedMicroUsdc: optionalMoney(source.returnedMicroUsdc),
    rewardStatus: optionalText(source.rewardStatus),
    roundAccounting: schemaVersion === 3 ? readRoundAccounting(source.roundAccounting) : null,
  };
  if (source.startedAt !== undefined) cycle.startedAt = isoTimestamp(source.startedAt);
  if (source.updatedAt !== undefined) cycle.updatedAt = isoTimestamp(source.updatedAt);
  if (source.spentMicroUsdc !== undefined) cycle.spentMicroUsdc = optionalMoney(source.spentMicroUsdc);
  if (source.paidMicroUsdc !== undefined) cycle.paidMicroUsdc = optionalMoney(source.paidMicroUsdc);
  if (source.reason !== undefined) cycle.reason = stableReason(source.reason);
  return cycle;
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
  exactKeys(source, schemaVersion === 3 ? CARD_KEYS : LEGACY_CARD_KEYS);
  requiredKeys(source, schemaVersion === 3 ? CARD_KEYS : new Set(["productId", "rarity"]));
  const card: PublicCycleCard = {
    productId: boundedText(source.productId),
    rarity: boundedText(source.rarity),
    nftAddress: nullableText(source.nftAddress),
    cardName: nullableText(source.cardName),
    setName: nullableText(source.setName),
    cardNumber: nullableText(source.cardNumber),
    imageUrl: null,
    packPriceMicroUsdc: optionalMoney(source.packPriceMicroUsdc ?? null),
    buybackMicroUsdc: optionalMoney(source.buybackMicroUsdc ?? null),
  };
  if (source.imageUrl !== undefined && source.imageUrl !== null) {
    const imageUrl = new URL(boundedText(source.imageUrl));
    if (imageUrl.protocol !== "https:" || imageUrl.username || imageUrl.password) invalid();
    card.imageUrl = imageUrl.toString();
  }
  return card;
}

function readRoundAccounting(value: unknown): PublicRoundAccounting | null {
  if (value === null) return null;
  const source = requiredRecord(value);
  exactKeys(source, ROUND_ACCOUNTING_KEYS);
  requiredKeys(source, ROUND_ACCOUNTING_KEYS);
  const result: PublicRoundAccounting = {
    packSpendMicroUsdc: money(source.packSpendMicroUsdc),
    buybackMicroUsdc: money(source.buybackMicroUsdc),
    packGainMicroUsdc: money(source.packGainMicroUsdc),
    packLossMicroUsdc: money(source.packLossMicroUsdc),
    quotedCosts: readQuotedCosts(source.quotedCosts),
    protectedCostsMicroUsdc: optionalMoney(source.protectedCostsMicroUsdc),
    confirmedCostsMicroUsdc: optionalMoney(source.confirmedCostsMicroUsdc),
    cycleGainMicroUsdc: optionalMoney(source.cycleGainMicroUsdc),
    cycleLossMicroUsdc: optionalMoney(source.cycleLossMicroUsdc),
    walletBalanceBeforeMicroUsdc: optionalMoney(source.walletBalanceBeforeMicroUsdc),
    walletBalanceAfterMicroUsdc: optionalMoney(source.walletBalanceAfterMicroUsdc),
    networkFees: readNetworkFees(source.networkFees),
    feeReserveBeforeMicroUsdc: optionalMoney(source.feeReserveBeforeMicroUsdc),
    feeReserveTargetMicroUsdc: optionalMoney(source.feeReserveTargetMicroUsdc),
    feeReserveTopUpMicroUsdc: optionalMoney(source.feeReserveTopUpMicroUsdc),
    feeReserveAfterMicroUsdc: optionalMoney(source.feeReserveAfterMicroUsdc),
    plannedHolderRewardsMicroUsdc: optionalMoney(source.plannedHolderRewardsMicroUsdc),
    paidHolderRewardsMicroUsdc: optionalMoney(source.paidHolderRewardsMicroUsdc),
    holderRewardsStatus: boundedText(source.holderRewardsStatus),
    distributionStatus: boundedText(source.distributionStatus),
  };
  assertExclusive(result.packGainMicroUsdc, result.packLossMicroUsdc);
  assertNullableExclusive(result.cycleGainMicroUsdc, result.cycleLossMicroUsdc);
  return result;
}

function readQuotedCosts(value: unknown): PublicQuotedCosts {
  const source = requiredRecord(value);
  exactKeys(source, QUOTED_COST_KEYS);
  requiredKeys(source, QUOTED_COST_KEYS);
  return {
    outboundBridgeMicroUsdc: optionalMoney(source.outboundBridgeMicroUsdc),
    inboundBridgeMicroUsdc: optionalMoney(source.inboundBridgeMicroUsdc),
    collectorApiMicroUsdc: optionalMoney(source.collectorApiMicroUsdc),
    ethereumNetworkMicroUsdc: optionalMoney(source.ethereumNetworkMicroUsdc),
    solanaNetworkMicroUsdc: optionalMoney(source.solanaNetworkMicroUsdc),
    slippageMicroUsdc: optionalMoney(source.slippageMicroUsdc),
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

function exactKeys(value: Record<string, unknown>, allowed: Set<string>) {
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
