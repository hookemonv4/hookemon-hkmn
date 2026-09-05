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
const NETWORK_KEYS = new Set(["evm", "solana"]);
const EVM_NETWORK_KEYS = new Set(["name", "chainId", "label"]);
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
  "returnedMicroUsdg",
  "rewardStatus",
  "roundAccounting",
];
const PUBLIC_CYCLE_KEYS = new Set([
  ...PUBLIC_CYCLE_REQUIRED_KEYS,
  "reason",
  "startedAt",
  "updatedAt",
  "spentMicroUsdg",
  "paidMicroUsdg",
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
  "spentMicroUsdg",
  "paidMicroUsdg",
]);
const PUBLIC_CARD_KEYS = new Set([
  ...CARD_TEXT_FIELDS,
  "imageUrl",
  "packPriceMicroUsdg",
  "buybackMicroUsdg",
]);
const LEGACY_PUBLIC_CARD_KEYS = new Set([...CARD_TEXT_FIELDS, "imageUrl"]);
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
  const evm = requiredPublicRecord(source.evm);
  const solana = requiredPublicRecord(source.solana);
  exactKeys(evm, EVM_NETWORK_KEYS);
  exactKeys(solana, SOLANA_NETWORK_KEYS);
  requiredKeys(evm, EVM_NETWORK_KEYS);
  requiredKeys(solana, SOLANA_NETWORK_KEYS);
  const expected = publicDashboardNetwork(profile);
  if (
    evm.name !== expected.evm.name ||
    evm.chainId !== expected.evm.chainId ||
    evm.label !== expected.evm.label ||
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
    returnedMicroUsdg: publicNullableMoney(source.returnedMicroUsdg),
    rewardStatus: publicNullableText(source.rewardStatus),
    roundAccounting: schemaVersion === 3
      ? readRoundAccounting(source.roundAccounting)
      : null,
  };
  if (Object.hasOwn(source, "reason")) cycle.reason = optionalReason(source.reason);
  if (Object.hasOwn(source, "startedAt")) cycle.startedAt = publicIsoTimestamp(source.startedAt);
  if (Object.hasOwn(source, "updatedAt")) cycle.updatedAt = publicIsoTimestamp(source.updatedAt);
  if (Object.hasOwn(source, "spentMicroUsdg")) cycle.spentMicroUsdg = publicNullableMoney(source.spentMicroUsdg);
  if (Object.hasOwn(source, "paidMicroUsdg")) cycle.paidMicroUsdg = publicNullableMoney(source.paidMicroUsdg);
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
    packPriceMicroUsdg: publicNullableMoney(source.packPriceMicroUsdg ?? null),
    buybackMicroUsdg: publicNullableMoney(source.buybackMicroUsdg ?? null),
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
    packSpendMicroUsdg: requiredMoney(source.packSpendMicroUsdg),
    buybackMicroUsdg: requiredMoney(source.buybackMicroUsdg),
    packGainMicroUsdg: requiredMoney(source.packGainMicroUsdg),
    packLossMicroUsdg: requiredMoney(source.packLossMicroUsdg),
    quotedCosts: readQuotedCosts(source.quotedCosts),
    protectedCostsMicroUsdg: publicNullableMoney(source.protectedCostsMicroUsdg),
    confirmedCostsMicroUsdg: publicNullableSignedMoney(source.confirmedCostsMicroUsdg),
    cycleGainMicroUsdg: publicNullableMoney(source.cycleGainMicroUsdg),
    cycleLossMicroUsdg: publicNullableMoney(source.cycleLossMicroUsdg),
    walletBalanceBeforeMicroUsdg: publicNullableMoney(source.walletBalanceBeforeMicroUsdg),
    walletBalanceAfterMicroUsdg: publicNullableMoney(source.walletBalanceAfterMicroUsdg),
    networkFees: readNetworkFees(source.networkFees),
    feeReserveBeforeMicroUsdg: publicNullableMoney(source.feeReserveBeforeMicroUsdg),
    feeReserveTargetMicroUsdg: publicNullableMoney(source.feeReserveTargetMicroUsdg),
    feeReserveTopUpMicroUsdg: publicNullableMoney(source.feeReserveTopUpMicroUsdg),
    feeReserveAfterMicroUsdg: publicNullableMoney(source.feeReserveAfterMicroUsdg),
    plannedHolderRewardsMicroUsdg: publicNullableMoney(source.plannedHolderRewardsMicroUsdg),
    paidHolderRewardsMicroUsdg: publicNullableMoney(source.paidHolderRewardsMicroUsdg),
    holderRewardsStatus: publicBoundedText(source.holderRewardsStatus),
    distributionStatus: publicBoundedText(source.distributionStatus),
  };
  assertExclusive(normalized.packGainMicroUsdg, normalized.packLossMicroUsdg);
  assertNullableExclusive(normalized.cycleGainMicroUsdg, normalized.cycleLossMicroUsdg);
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

function publicNullableSignedMoney(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^(0|-?[1-9]\d{0,77})$/.test(value)) invalidPublicStatus();
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
    returnedMicroUsdg: optionalMoney(record.inbound?.amountReceived),
    rewardStatus: optionalText(record.settlement?.status),
    roundAccounting: projectRoundAccounting(record),
  };
  if (record.reason !== undefined) projected.reason = optionalReason(record.reason);
  if (record.startedAt !== undefined) projected.startedAt = isoTimestamp(record.startedAt);
  if (record.updatedAt !== undefined) projected.updatedAt = isoTimestamp(record.updatedAt);
  if (record.packPlan?.spentMicroUsdg !== undefined) {
    projected.spentMicroUsdg = optionalMoney(record.packPlan.spentMicroUsdg);
  }
  if (record.settlement?.paidThisCycleMicroUsdg !== undefined) {
    projected.paidMicroUsdg = publisherMoney(record.settlement.paidThisCycleMicroUsdg);
  } else if (record.settlement?.paid !== undefined) {
    projected.paidMicroUsdg = optionalMoney(record.settlement.paid);
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
    packPriceMicroUsdg: optionalAnyMoney(card.packPriceMicroUsdg ?? unitPrice),
    buybackMicroUsdg: optionalAnyMoney(card.buybackMicroUsdg ?? card.buybackAmount),
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

// Provenance rule (F-inbox): a legacy record field named with the old `*MicroUsdc` suffix may
// actually be denominated in chain1 Ethereum USDC, not chain4663 Robinhood USDG. Since these old
// fields carry no companion chain/asset identity to verify against, they are never read as a
// same-value fallback for the new `*MicroUsdg` fields — only the exact `*MicroUsdg`-named record
// field (written by a producer that has already adopted the current chain/asset identity) is
// accepted. An absent `*MicroUsdg` field means the amount is genuinely unknown here, not '0' and
// not a silently reinterpreted legacy value.
function projectRoundAccounting(record) {
  const accounting = record.roundAccounting;
  if (accounting === undefined || accounting === null) return null;
  const packSpend = anyMoney(accounting.grossPackDebitMicroUsdg);
  const buyback = anyMoney(accounting.confirmedBuybackMicroUsdg);
  const confirmedCosts = optionalAnySignedMoney(accounting.confirmedCostMicroUsdg);
  const completeCost = confirmedCosts === null ? null : packSpend + BigInt(confirmedCosts);
  const planned = optionalAnyMoney(accounting.holderRewardsMicroUsdg);
  const paid = optionalAnyMoney(
    record.settlement?.paidThisCycleMicroUsdg ?? record.settlement?.paid,
  );
  return {
    packSpendMicroUsdg: packSpend.toString(),
    buybackMicroUsdg: buyback.toString(),
    packGainMicroUsdg: subtractAtZero(buyback, packSpend).toString(),
    packLossMicroUsdg: subtractAtZero(packSpend, buyback).toString(),
    quotedCosts: {
      outboundBridgeMicroUsdg: optionalAnyMoney(record.ledgerSnapshot?.outboundMicroUsdg),
      inboundBridgeMicroUsdg: optionalAnyMoney(record.ledgerSnapshot?.inboundMicroUsdg),
      collectorApiMicroUsdg: optionalAnyMoney(record.ledgerSnapshot?.collectorMicroUsdg),
      evmNetworkMicroUsdg: optionalAnyMoney(record.ledgerSnapshot?.evmGasMicroUsdg),
      solanaNetworkMicroUsdg: optionalAnyMoney(record.ledgerSnapshot?.solanaGasMicroUsdg),
      slippageMicroUsdg: optionalAnyMoney(record.ledgerSnapshot?.slippageMicroUsdg),
    },
    protectedCostsMicroUsdg: optionalAnyMoney(accounting.protectedCostForecastMicroUsdg),
    confirmedCostsMicroUsdg: confirmedCosts,
    cycleGainMicroUsdg: completeCost === null
      ? null
      : subtractAtZero(buyback, completeCost).toString(),
    cycleLossMicroUsdg: completeCost === null
      ? null
      : subtractAtZero(completeCost, buyback).toString(),
    walletBalanceBeforeMicroUsdg: optionalAnyMoney(record.roundEvidence?.walletBalanceBeforeMicroUsdg),
    walletBalanceAfterMicroUsdg: optionalAnyMoney(record.roundEvidence?.walletBalanceAfterMicroUsdg),
    networkFees: projectNetworkFees(record.roundEvidence?.networkFees),
    feeReserveBeforeMicroUsdg: optionalAnyMoney(accounting.feeReserveBeforeMicroUsdg),
    feeReserveTargetMicroUsdg: optionalAnyMoney(accounting.feeReserveTargetMicroUsdg),
    feeReserveTopUpMicroUsdg: optionalAnyMoney(accounting.feeReserveTopUpMicroUsdg),
    feeReserveAfterMicroUsdg: optionalAnyMoney(accounting.feeReserveAfterMicroUsdg),
    plannedHolderRewardsMicroUsdg: planned,
    paidHolderRewardsMicroUsdg: paid,
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

function optionalAnySignedMoney(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint" && value > -(10n ** 78n) && value < 10n ** 78n) return value.toString();
  if (typeof value === "string" && /^(0|-?[1-9]\d{0,77})$/.test(value)) return value;
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
