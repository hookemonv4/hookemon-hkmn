import { publicDashboardNetwork, readPublicDashboardProfile } from "./public-dashboard-profile.js";

const CARD_TEXT_FIELDS = ["productId", "rarity", "nftAddress", "cardName", "setName", "cardNumber"];
const PUBLIC_CARD_WINDOW_SIZE = 60;
const EXECUTION_STATES = new Set(["active", "paused"]);
const PUBLIC_STATUS_KEYS = new Set([
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
const NETWORK_KEYS = new Set(["ethereum", "solana"]);
const ETHEREUM_NETWORK_KEYS = new Set(["name", "chainId", "label"]);
const SOLANA_NETWORK_KEYS = new Set(["name", "genesisHash", "label"]);
const PUBLIC_CYCLE_REQUIRED_KEYS = [
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
];
const PUBLIC_CYCLE_KEYS = new Set([
  ...PUBLIC_CYCLE_REQUIRED_KEYS,
  "reason",
  "startedAt",
  "updatedAt",
  "spentMicroUsdc",
  "paidMicroUsdc",
]);
const PUBLIC_ACTION_KEYS = new Set(["type", "status", "at"]);
const LEGACY_PUBLIC_CYCLE_REQUIRED_KEYS = PUBLIC_CYCLE_REQUIRED_KEYS.filter(
  (key) => key !== "roundAccounting",
);
const LEGACY_PUBLIC_CYCLE_KEYS = new Set([
  ...LEGACY_PUBLIC_CYCLE_REQUIRED_KEYS,
  "reason",
  "startedAt",
  "updatedAt",
  "spentMicroUsdc",
  "paidMicroUsdc",
]);
const PUBLIC_CARD_KEYS = new Set([
  ...CARD_TEXT_FIELDS,
  "imageUrl",
  "packPriceMicroUsdc",
  "buybackMicroUsdc",
]);
const LEGACY_PUBLIC_CARD_KEYS = new Set([...CARD_TEXT_FIELDS, "imageUrl"]);
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
const PUBLIC_ACTION_STATUSES = new Set(["pending", "complete", "failed"]);
const PUBLIC_MAX_ACTIONS = 128;

export function projectPublicCycle({ nowMs, nextCycleAtMs, record, profile, executionState }) {
  assertTime(nowMs);
  assertTime(nextCycleAtMs);
  const selectedProfile = readPublicDashboardProfile(profile).id;
  if (!EXECUTION_STATES.has(executionState)) {
    throw new TypeError("PUBLIC_CYCLE_EXECUTION_STATE_INVALID");
  }
  const countdownMilliseconds = Math.max(0, nextCycleAtMs - nowMs);
  return normalizePublicCycleStatus({
    schemaVersion: 3,
    profile: selectedProfile,
    network: publicDashboardNetwork(selectedProfile),
    executionState,
    executionReason: executionState === "paused" ? "operator-paused" : null,
    generatedAt: new Date(nowMs).toISOString(),
    nextCycleAt: new Date(nextCycleAtMs).toISOString(),
    countdownSeconds: Math.ceil(countdownMilliseconds / 1_000),
    cycle: record === null ? null : projectRecord(record),
  });
}

export function normalizePublicCycleStatus(value) {
  try {
    return readPublicCycleStatus(value);
  } catch {
    throw new TypeError("PUBLIC_CYCLE_STATUS_INVALID");
  }
}

function readPublicCycleStatus(value) {
  const source = requiredPublicRecord(value);
  exactKeys(source, PUBLIC_STATUS_KEYS);
  requiredKeys(source, PUBLIC_STATUS_KEYS);
  if (!(source.schemaVersion === 2 || source.schemaVersion === 3)) invalidPublicStatus();
  const schemaVersion = source.schemaVersion;
  const profile = readPublicDashboardProfile(source.profile).id;
  const generatedAt = publicIsoTimestamp(source.generatedAt);
  const nextCycleAt = publicIsoTimestamp(source.nextCycleAt);
  const countdownSeconds = publicNonnegativeInteger(source.countdownSeconds);
  const expectedCountdown = Math.ceil(
    Math.max(0, Date.parse(nextCycleAt) - Date.parse(generatedAt)) / 1_000,
  );
  if (
    countdownSeconds !== expectedCountdown ||
    !EXECUTION_STATES.has(source.executionState) ||
    source.executionReason !== (source.executionState === "paused" ? "operator-paused" : null)
  ) {
    invalidPublicStatus();
  }
  return {
    schemaVersion: 3,
    profile,
    network: readPublicNetwork(source.network, profile),
    executionState: source.executionState,
    executionReason: source.executionReason,
    generatedAt,
    nextCycleAt,
    countdownSeconds,
    cycle: source.cycle === null ? null : readPublicCycle(source.cycle, schemaVersion),
  };
}

function readPublicNetwork(value, profile) {
  const source = requiredPublicRecord(value);
  exactKeys(source, NETWORK_KEYS);
  requiredKeys(source, NETWORK_KEYS);
  const ethereum = requiredPublicRecord(source.ethereum);
  const solana = requiredPublicRecord(source.solana);
  exactKeys(ethereum, ETHEREUM_NETWORK_KEYS);
  exactKeys(solana, SOLANA_NETWORK_KEYS);
  requiredKeys(ethereum, ETHEREUM_NETWORK_KEYS);
  requiredKeys(solana, SOLANA_NETWORK_KEYS);
  const expected = publicDashboardNetwork(profile);
  if (
    ethereum.name !== expected.ethereum.name ||
    ethereum.chainId !== expected.ethereum.chainId ||
    ethereum.label !== expected.ethereum.label ||
    solana.name !== expected.solana.name ||
    solana.genesisHash !== expected.solana.genesisHash ||
    solana.label !== expected.solana.label
  ) {
    invalidPublicStatus();
  }
  return expected;
}

function readPublicCycle(value, schemaVersion) {
  const source = requiredPublicRecord(value);
  const cycleKeys = schemaVersion === 3 ? PUBLIC_CYCLE_KEYS : LEGACY_PUBLIC_CYCLE_KEYS;
  const requiredCycleKeys = schemaVersion === 3
    ? PUBLIC_CYCLE_REQUIRED_KEYS
    : LEGACY_PUBLIC_CYCLE_REQUIRED_KEYS;
  exactKeys(source, cycleKeys);
  requiredKeys(source, requiredCycleKeys);
  const actions = publicArray(source.actions, PUBLIC_MAX_ACTIONS).map(readPublicAction);
  const cards = publicArray(source.cards, PUBLIC_CARD_WINDOW_SIZE).map((card) =>
    readPublicCard(card, schemaVersion));
  const openedBoosters = publicNonnegativeInteger(source.openedBoosters);
  if (cards.length !== Math.min(openedBoosters, PUBLIC_CARD_WINDOW_SIZE)) invalidPublicStatus();
  const cycle = {
    cycleId: publicBoundedText(source.cycleId),
    status: publicBoundedText(source.status),
    selectedPackId: publicNullableText(source.selectedPackId),
    maxBoostersPerCycle: publicNullablePositiveInteger(source.maxBoostersPerCycle),
    plannedBoosters: publicNonnegativeInteger(source.plannedBoosters),
    openedBoosters,
    actions,
    cards,
    returnedMicroUsdc: publicNullableMoney(source.returnedMicroUsdc),
    rewardStatus: publicNullableText(source.rewardStatus),
    roundAccounting: schemaVersion === 3
      ? readRoundAccounting(source.roundAccounting)
      : null,
  };
  if (Object.hasOwn(source, "reason")) cycle.reason = optionalReason(source.reason);
  if (Object.hasOwn(source, "startedAt")) cycle.startedAt = publicIsoTimestamp(source.startedAt);
  if (Object.hasOwn(source, "updatedAt")) cycle.updatedAt = publicIsoTimestamp(source.updatedAt);
  if (Object.hasOwn(source, "spentMicroUsdc")) cycle.spentMicroUsdc = publicNullableMoney(source.spentMicroUsdc);
  if (Object.hasOwn(source, "paidMicroUsdc")) cycle.paidMicroUsdc = publicNullableMoney(source.paidMicroUsdc);
  return cycle;
}

function readPublicAction(value) {
  const source = requiredPublicRecord(value);
  exactKeys(source, PUBLIC_ACTION_KEYS);
  requiredKeys(source, PUBLIC_ACTION_KEYS);
  if (!PUBLIC_ACTION_STATUSES.has(source.status)) invalidPublicStatus();
  return {
    type: publicBoundedText(source.type),
    status: source.status,
    at: publicIsoTimestamp(source.at),
  };
}

function readPublicCard(value, schemaVersion) {
  const source = requiredPublicRecord(value);
  exactKeys(source, schemaVersion === 3 ? PUBLIC_CARD_KEYS : LEGACY_PUBLIC_CARD_KEYS);
  if (schemaVersion === 3) requiredKeys(source, PUBLIC_CARD_KEYS);
  const card = {
    productId: publicBoundedText(source.productId),
    rarity: publicBoundedText(source.rarity),
    nftAddress: publicNullableText(source.nftAddress ?? null),
    cardName: publicNullableText(source.cardName ?? null),
    setName: publicNullableText(source.setName ?? null),
    cardNumber: publicNullableText(source.cardNumber ?? null),
    imageUrl: null,
    packPriceMicroUsdc: publicNullableMoney(source.packPriceMicroUsdc ?? null),
    buybackMicroUsdc: publicNullableMoney(source.buybackMicroUsdc ?? null),
  };
  if (source.imageUrl !== undefined && source.imageUrl !== null) {
    let url;
    try {
      url = new URL(publicBoundedText(source.imageUrl));
    } catch {
      invalidPublicStatus();
    }
    if (url.protocol !== "https:" || url.username || url.password) invalidPublicStatus();
    card.imageUrl = url.toString();
  }
  return card;
}

function readRoundAccounting(value) {
  if (value === null) return null;
  const source = requiredPublicRecord(value);
  exactKeys(source, ROUND_ACCOUNTING_KEYS);
  requiredKeys(source, ROUND_ACCOUNTING_KEYS);
  const normalized = {
    packSpendMicroUsdc: requiredMoney(source.packSpendMicroUsdc),
    buybackMicroUsdc: requiredMoney(source.buybackMicroUsdc),
    packGainMicroUsdc: requiredMoney(source.packGainMicroUsdc),
    packLossMicroUsdc: requiredMoney(source.packLossMicroUsdc),
    quotedCosts: readQuotedCosts(source.quotedCosts),
    protectedCostsMicroUsdc: publicNullableMoney(source.protectedCostsMicroUsdc),
    confirmedCostsMicroUsdc: publicNullableMoney(source.confirmedCostsMicroUsdc),
    cycleGainMicroUsdc: publicNullableMoney(source.cycleGainMicroUsdc),
    cycleLossMicroUsdc: publicNullableMoney(source.cycleLossMicroUsdc),
    walletBalanceBeforeMicroUsdc: publicNullableMoney(source.walletBalanceBeforeMicroUsdc),
    walletBalanceAfterMicroUsdc: publicNullableMoney(source.walletBalanceAfterMicroUsdc),
    networkFees: readNetworkFees(source.networkFees),
    feeReserveBeforeMicroUsdc: publicNullableMoney(source.feeReserveBeforeMicroUsdc),
    feeReserveTargetMicroUsdc: publicNullableMoney(source.feeReserveTargetMicroUsdc),
    feeReserveTopUpMicroUsdc: publicNullableMoney(source.feeReserveTopUpMicroUsdc),
    feeReserveAfterMicroUsdc: publicNullableMoney(source.feeReserveAfterMicroUsdc),
    plannedHolderRewardsMicroUsdc: publicNullableMoney(source.plannedHolderRewardsMicroUsdc),
    paidHolderRewardsMicroUsdc: publicNullableMoney(source.paidHolderRewardsMicroUsdc),
    holderRewardsStatus: publicBoundedText(source.holderRewardsStatus),
    distributionStatus: publicBoundedText(source.distributionStatus),
  };
  assertExclusive(normalized.packGainMicroUsdc, normalized.packLossMicroUsdc);
  assertNullableExclusive(normalized.cycleGainMicroUsdc, normalized.cycleLossMicroUsdc);
  return normalized;
}

function readQuotedCosts(value) {
  const source = requiredPublicRecord(value);
  exactKeys(source, QUOTED_COST_KEYS);
  requiredKeys(source, QUOTED_COST_KEYS);
  return Object.fromEntries([...QUOTED_COST_KEYS].map((key) => [
    key,
    publicNullableMoney(source[key]),
  ]));
}

function readNetworkFees(value) {
  const source = requiredPublicRecord(value);
  exactKeys(source, NETWORK_FEE_KEYS);
  requiredKeys(source, NETWORK_FEE_KEYS);
  return {
    walletLamportsCharged: publicNullableMoney(source.walletLamportsCharged),
    purchase: readNativeFee(source.purchase),
    buyback: readNativeFee(source.buyback),
  };
}

function readNativeFee(value) {
  if (value === null) return null;
  const source = requiredPublicRecord(value);
  exactKeys(source, NATIVE_FEE_KEYS);
  requiredKeys(source, NATIVE_FEE_KEYS);
  return {
    lamports: requiredMoney(source.lamports),
    paidBy: publicBoundedText(source.paidBy),
  };
}

function requiredMoney(value) {
  const result = publicNullableMoney(value);
  if (result === null) invalidPublicStatus();
  return result;
}

function assertExclusive(gain, loss) {
  if (BigInt(gain) > 0n && BigInt(loss) > 0n) invalidPublicStatus();
}

function assertNullableExclusive(gain, loss) {
  if ((gain === null) !== (loss === null)) invalidPublicStatus();
  if (gain !== null) assertExclusive(gain, loss);
}

function requiredPublicRecord(value) {
  if (
    value === null ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) {
    invalidPublicStatus();
  }
  return value;
}

function exactKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalidPublicStatus();
  }
}

function requiredKeys(value, keys) {
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) invalidPublicStatus();
  }
}

function publicArray(value, maximumLength) {
  if (!Array.isArray(value) || value.length > maximumLength) invalidPublicStatus();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalidPublicStatus();
  }
  return value;
}

function publicBoundedText(value) {
  if (!nonEmptyText(value) || value.length > 512) invalidPublicStatus();
  return value;
}

function publicIsoTimestamp(value) {
  const timestamp = new Date(publicBoundedText(value));
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value) invalidPublicStatus();
  return value;
}

function publicNullableText(value) {
  return value === null ? null : publicBoundedText(value);
}

function publicNullableMoney(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value)) invalidPublicStatus();
  return value;
}

function publicNullablePositiveInteger(value) {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value <= 0) invalidPublicStatus();
  return value;
}

function publicNonnegativeInteger(value) {
  if (!Number.isSafeInteger(value) || value < 0) invalidPublicStatus();
  return value;
}

function invalidPublicStatus() {
  throw new TypeError("PUBLIC_CYCLE_STATUS_INVALID");
}

function projectRecord(record) {
  if (!plainObject(record) || !nonEmptyText(record.cycleId) || !nonEmptyText(record.status)) {
    throw new TypeError("PUBLIC_CYCLE_RECORD_INVALID");
  }
  const actions = Array.isArray(record.timeline)
    ? record.timeline.map(projectAction).sort((left, right) => left.at.localeCompare(right.at))
    : [];
  const packs = Array.isArray(record.packs) ? record.packs : [];
  // Preserve reveal order inside the bounded window: oldest first, newest last.
  const cards = packs.slice(-PUBLIC_CARD_WINDOW_SIZE).map((card) =>
    projectCard(card, packUnitPrice(record, card?.productId)));
  const orders = record.packPlan?.orders;
  const plannedBoosters = Array.isArray(orders)
    ? orders.reduce((sum, order) => {
        if (!Number.isSafeInteger(order?.quantity) || order.quantity < 0) {
          throw new TypeError("PUBLIC_CYCLE_BOOSTER_COUNT_INVALID");
        }
        return sum + order.quantity;
      }, 0)
    : 0;

  const projected = {
    cycleId: record.cycleId,
    status: record.status,
    selectedPackId: optionalText(record.packPlan?.selectedPackId),
    maxBoostersPerCycle: optionalPositiveInteger(record.packPlan?.maxBoostersPerCycle),
    plannedBoosters,
    openedBoosters: packs.length,
    actions,
    cards,
    returnedMicroUsdc: optionalMoney(record.inbound?.amountReceived),
    rewardStatus: optionalText(record.settlement?.status),
    roundAccounting: projectRoundAccounting(record),
  };
  if (record.reason !== undefined) projected.reason = optionalReason(record.reason);
  if (record.startedAt !== undefined) projected.startedAt = isoTimestamp(record.startedAt);
  if (record.updatedAt !== undefined) projected.updatedAt = isoTimestamp(record.updatedAt);
  if (record.packPlan?.spentMicroUsdc !== undefined) {
    projected.spentMicroUsdc = optionalMoney(record.packPlan.spentMicroUsdc);
  }
  if (record.settlement?.paidThisCycleMicroUsdc !== undefined) {
    projected.paidMicroUsdc = publisherMoney(record.settlement.paidThisCycleMicroUsdc);
  } else if (record.settlement?.paid !== undefined) {
    projected.paidMicroUsdc = optionalMoney(record.settlement.paid);
  }
  return projected;
}

function optionalReason(value) {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) {
    throw new TypeError("PUBLIC_CYCLE_REASON_INVALID");
  }
  return value;
}

function projectAction(action) {
  if (
    !plainObject(action) ||
    !nonEmptyText(action.type) ||
    !new Set(["pending", "complete", "failed"]).has(action.status)
  ) {
    throw new TypeError("PUBLIC_CYCLE_ACTION_INVALID");
  }
  return { type: action.type, status: action.status, at: isoTimestamp(action.at) };
}

function projectCard(card, unitPrice) {
  if (!plainObject(card)) throw new TypeError("PUBLIC_CARD_INVALID");
  const projected = {
    productId: requiredBoundedText(card.productId),
    rarity: requiredBoundedText(card.rarity),
    nftAddress: nullableProjectedText(card.nftAddress),
    cardName: nullableProjectedText(card.cardName),
    setName: nullableProjectedText(card.setName),
    cardNumber: nullableProjectedText(card.cardNumber),
    imageUrl: null,
    packPriceMicroUsdc: optionalAnyMoney(card.packPriceMicroUsdc ?? unitPrice),
    buybackMicroUsdc: optionalAnyMoney(card.buybackMicroUsdc ?? card.buybackAmount),
  };
  if (card.imageUrl !== undefined && card.imageUrl !== null) {
    let url;
    try {
      url = new URL(card.imageUrl);
    } catch {
      throw new TypeError("PUBLIC_CARD_IMAGE_INVALID");
    }
    if (url.protocol !== "https:") throw new TypeError("PUBLIC_CARD_IMAGE_INVALID");
    projected.imageUrl = url.toString();
  }
  return projected;
}

function projectRoundAccounting(record) {
  const accounting = record.roundAccounting;
  if (accounting === undefined || accounting === null) return null;
  const packSpend = anyMoney(accounting.grossPackDebitMicroUsdc);
  const buyback = anyMoney(accounting.confirmedBuybackMicroUsdc);
  const confirmedCosts = optionalAnyMoney(accounting.confirmedCostMicroUsdc);
  const completeCost = confirmedCosts === null ? null : packSpend + BigInt(confirmedCosts);
  const planned = optionalAnyMoney(accounting.holderRewardsMicroUsdc);
  const paid = optionalAnyMoney(
    record.settlement?.paidThisCycleMicroUsdc ?? record.settlement?.paid,
  );
  return {
    packSpendMicroUsdc: packSpend.toString(),
    buybackMicroUsdc: buyback.toString(),
    packGainMicroUsdc: subtractAtZero(buyback, packSpend).toString(),
    packLossMicroUsdc: subtractAtZero(packSpend, buyback).toString(),
    quotedCosts: {
      outboundBridgeMicroUsdc: optionalAnyMoney(record.ledgerSnapshot?.outboundMicroUsdc),
      inboundBridgeMicroUsdc: optionalAnyMoney(record.ledgerSnapshot?.inboundMicroUsdc),
      collectorApiMicroUsdc: optionalAnyMoney(record.ledgerSnapshot?.collectorMicroUsdc),
      ethereumNetworkMicroUsdc: optionalAnyMoney(record.ledgerSnapshot?.ethereumGasMicroUsdc),
      solanaNetworkMicroUsdc: optionalAnyMoney(record.ledgerSnapshot?.solanaGasMicroUsdc),
      slippageMicroUsdc: optionalAnyMoney(record.ledgerSnapshot?.slippageMicroUsdc),
    },
    protectedCostsMicroUsdc: optionalAnyMoney(accounting.protectedCostForecastMicroUsdc),
    confirmedCostsMicroUsdc: confirmedCosts,
    cycleGainMicroUsdc: completeCost === null
      ? null
      : subtractAtZero(buyback, completeCost).toString(),
    cycleLossMicroUsdc: completeCost === null
      ? null
      : subtractAtZero(completeCost, buyback).toString(),
    walletBalanceBeforeMicroUsdc: optionalAnyMoney(
      record.roundEvidence?.walletBalanceBeforeMicroUsdc,
    ),
    walletBalanceAfterMicroUsdc: optionalAnyMoney(
      record.roundEvidence?.walletBalanceAfterMicroUsdc,
    ),
    networkFees: projectNetworkFees(record.roundEvidence?.networkFees),
    feeReserveBeforeMicroUsdc: optionalAnyMoney(accounting.feeReserveBeforeMicroUsdc),
    feeReserveTargetMicroUsdc: optionalAnyMoney(accounting.feeReserveTargetMicroUsdc),
    feeReserveTopUpMicroUsdc: optionalAnyMoney(accounting.feeReserveTopUpMicroUsdc),
    feeReserveAfterMicroUsdc: optionalAnyMoney(accounting.feeReserveAfterMicroUsdc),
    plannedHolderRewardsMicroUsdc: planned,
    paidHolderRewardsMicroUsdc: paid,
    holderRewardsStatus: requiredBoundedText(
      record.roundEvidence?.holderRewardsStatus ?? (planned === null ? "pending" : "computed"),
    ),
    distributionStatus: requiredBoundedText(
      record.roundEvidence?.distributionStatus ?? record.settlement?.status ?? "pending",
    ),
  };
}

function projectNetworkFees(value) {
  return {
    walletLamportsCharged: optionalAnyMoney(value?.walletLamportsCharged),
    purchase: projectNativeFee(value?.purchase),
    buyback: projectNativeFee(value?.buyback),
  };
}

function projectNativeFee(value) {
  if (value === undefined || value === null) return null;
  return {
    lamports: anyMoney(value.lamports).toString(),
    paidBy: requiredBoundedText(value.paidBy),
  };
}

function packUnitPrice(record, productId) {
  return Array.isArray(record.packPlan?.orders)
    ? record.packPlan.orders.find((order) => order?.productId === productId)?.unitPrice
    : undefined;
}

function nullableProjectedText(value) {
  return value === undefined || value === null ? null : requiredBoundedText(value);
}

function optionalAnyMoney(value) {
  return value === undefined || value === null ? null : anyMoney(value).toString();
}

function anyMoney(value) {
  if (typeof value === "bigint" && value >= 0n && value < 10n ** 78n) return value;
  if (typeof value === "string" && /^(0|[1-9]\d{0,77})$/.test(value)) return BigInt(value);
  throw new TypeError("PUBLIC_CYCLE_MONEY_INVALID");
}

function subtractAtZero(minuend, subtrahend) {
  return minuend > subtrahend ? minuend - subtrahend : 0n;
}

function optionalMoney(value) {
  if (value === undefined) return null;
  if (typeof value !== "bigint" || value < 0n) throw new TypeError("PUBLIC_CYCLE_MONEY_INVALID");
  return value.toString();
}

function publisherMoney(value) {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,77})$/.test(value)) {
    throw new TypeError("PUBLIC_CYCLE_MONEY_INVALID");
  }
  return value;
}

function optionalText(value) {
  return value === undefined ? null : requiredBoundedText(value);
}

function optionalPositiveInteger(value) {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError("PUBLIC_CYCLE_BOOSTER_COUNT_INVALID");
  }
  return value;
}

function requiredBoundedText(value) {
  if (!nonEmptyText(value) || value.length > 512) throw new TypeError("PUBLIC_CARD_INVALID");
  return value;
}

function isoTimestamp(value) {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) throw new TypeError("PUBLIC_CYCLE_TIMESTAMP_INVALID");
  return timestamp.toISOString();
}

function assertTime(value) {
  if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) {
    throw new TypeError("PUBLIC_CYCLE_TIME_INVALID");
  }
}

function nonEmptyText(value) {
  return typeof value === "string" && value.length > 0;
}

function plainObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}
