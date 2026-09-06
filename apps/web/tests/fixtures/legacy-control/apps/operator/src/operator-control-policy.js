export function createInitialOperatorState() {
  return {
    version: 0,
    desiredStatus: "paused",
    mode: "standard",
    communityPackIds: [],
    manualPackOrders: [],
    maxBoostersPerCycle: 100,
    cycleIntervalMinutes: 20,
    skipNextCycleSequence: 0,
    runNowSequence: 0,
    maxUnitPriceMicroUsdc: null,
    maxCycleBudgetMicroUsdc: null,
    max24HourBudgetMicroUsdc: null,
    configurationComplete: false,
    executionConnected: false,
  };
}

export function operatorReadiness({ state, catalog, nowMs }) {
  const reasons = [];
  if (!state.configurationComplete) reasons.push("CONFIGURATION_INCOMPLETE");
  const fresh = catalogIsFresh(catalog, nowMs);
  if (!fresh) reasons.push("CATALOG_STALE");
  if (state.mode === "community" && fresh) {
    const availablePacks = new Map(catalog.packs.map((pack) => [pack.id, pack]));
    const orders = canonicalManualOrders(state, { fallbackEmpty: true });
    const selectedPacks = orders.map((order) => availablePacks.get(order.productId));
    if (selectedPacks.some((pack, index) => !pack || pack.available < orders[index].quantity)) {
      reasons.push("COMMUNITY_PACK_UNAVAILABLE");
    } else if (
      selectedPacks.some(
        (pack) => BigInt(pack.priceMicroUsdc) > BigInt(state.maxUnitPriceMicroUsdc),
      )
    ) {
      reasons.push("COMMUNITY_PACK_PRICE_EXCEEDS_LIMIT");
    }
  }
  return { ready: reasons.length === 0, reasons };
}

export function applyOperatorDecision({ state, command, hardCaps, catalog, nowMs }) {
  if (!plainObject(command) || typeof command.type !== "string") {
    return rejected(state, "DECISION_SHAPE_INVALID");
  }
  if (!new Set([
    "pause",
    "activate",
    "update-configuration",
    "skip-next-cycle",
    "run-cycle-now",
  ]).has(command.type)) {
    return hasExactKeys(command, ["type"])
      ? rejected(state, "DECISION_TYPE_INVALID")
      : rejected(state, "DECISION_SHAPE_INVALID");
  }
  if (command.type !== "update-configuration" && !hasExactKeys(command, ["type"])) {
    return rejected(state, "DECISION_SHAPE_INVALID");
  }
  if (
    command.type === "update-configuration" &&
    (!hasExactKeys(command, ["type", "configuration"]) ||
      !validConfigurationShape(command.configuration))
  ) {
    return rejected(state, "OPERATOR_CONFIGURATION_INVALID");
  }

  if (command.type === "pause") {
    return accepted(state, { ...state, desiredStatus: "paused" });
  }

  if (command.type === "skip-next-cycle" || command.type === "run-cycle-now") {
    if (state.desiredStatus !== "active") {
      return rejected(state, "OPERATOR_EXECUTION_PAUSED");
    }
    if (command.type === "run-cycle-now") {
      const readiness = operatorReadiness({ state, catalog, nowMs });
      if (!readiness.ready) return rejected(state, readiness.reasons[0]);
    }
    const requestSequence = state.version + 1;
    return accepted(state, command.type === "skip-next-cycle"
      ? { ...state, skipNextCycleSequence: requestSequence }
      : { ...state, runNowSequence: requestSequence });
  }

  if (command.type === "update-configuration") {
    try {
      const configuration = validateOperatorConfiguration({
        configuration: command.configuration,
        hardCaps,
        catalog,
        nowMs,
      });
      return accepted(state, {
        ...state,
        ...configuration,
        configurationComplete: true,
      });
    } catch (error) {
      return rejected(
        state,
        error instanceof OperatorPolicyError ? error.message : "OPERATOR_CONFIGURATION_INVALID",
      );
    }
  }

  if (command.type === "activate") {
    const readiness = operatorReadiness({ state, catalog, nowMs });
    if (!readiness.ready) return rejected(state, readiness.reasons[0]);
    return accepted(state, { ...state, desiredStatus: "active" });
  }

  return rejected(state, "DECISION_TYPE_INVALID");
}

export function validateOperatorConfiguration({ configuration, hardCaps, catalog, nowMs }) {
  if (!validConfigurationShape(configuration)) {
    throw new OperatorPolicyError("OPERATOR_CONFIGURATION_INVALID");
  }
  validateLimits(configuration, hardCaps);
  const cycleIntervalMinutes = configuration.cycleIntervalMinutes ?? 20;
  if (
    !Number.isSafeInteger(cycleIntervalMinutes) ||
    cycleIntervalMinutes < 15 ||
    cycleIntervalMinutes > 60
  ) {
    throw new OperatorPolicyError("CYCLE_INTERVAL_INVALID");
  }
  if (!new Set(["standard", "community"]).has(configuration.mode)) {
    throw new OperatorPolicyError("OPERATOR_MODE_INVALID");
  }
  if (configuration.mode === "standard" && configuration.communityPackIds.length !== 0) {
    throw new OperatorPolicyError("STANDARD_PACK_SELECTION_FORBIDDEN");
  }
  if (configuration.mode === "standard" && (configuration.manualPackOrders?.length ?? 0) !== 0) {
    throw new OperatorPolicyError("STANDARD_PACK_SELECTION_FORBIDDEN");
  }
  if (configuration.mode === "community") {
    validateCommunitySelection(configuration, catalog, nowMs);
  }
  return {
    ...structuredClone(configuration),
    cycleIntervalMinutes,
    manualPackOrders: configuration.mode === "community"
      ? canonicalManualOrders(configuration)
      : [],
  };
}

export function parseMicroUsdc(value, code) {
  if (typeof value !== "string" || !/^[1-9]\d*$/.test(value)) {
    throw new OperatorPolicyError(code);
  }
  return BigInt(value);
}

function validateLimits(configuration, hardCaps) {
  const boosters = configuration.maxBoostersPerCycle ?? 100;
  if (!Number.isSafeInteger(boosters) || boosters <= 0) {
    throw new OperatorPolicyError("MAX_BOOSTERS_INVALID");
  }
  if (boosters > (hardCaps.maxBoostersPerCycle ?? 100)) {
    throw new OperatorPolicyError("MAX_BOOSTERS_HARD_CAP_EXCEEDED");
  }
  const unit = parseMicroUsdc(configuration.maxUnitPriceMicroUsdc, "MAX_UNIT_PRICE_INVALID");
  const cycle = parseMicroUsdc(configuration.maxCycleBudgetMicroUsdc, "MAX_CYCLE_BUDGET_INVALID");
  const daily = parseMicroUsdc(
    configuration.max24HourBudgetMicroUsdc,
    "MAX_24_HOUR_BUDGET_INVALID",
  );
  if (unit > hardCaps.maxUnitPriceMicroUsdc) {
    throw new OperatorPolicyError("MAX_UNIT_PRICE_HARD_CAP_EXCEEDED");
  }
  if (cycle > hardCaps.maxCycleBudgetMicroUsdc) {
    throw new OperatorPolicyError("MAX_CYCLE_BUDGET_HARD_CAP_EXCEEDED");
  }
  if (daily > hardCaps.max24HourBudgetMicroUsdc) {
    throw new OperatorPolicyError("MAX_24_HOUR_BUDGET_HARD_CAP_EXCEEDED");
  }
  if (unit > cycle || cycle > daily) throw new OperatorPolicyError("BUDGET_ORDER_INVALID");
}

function validateCommunitySelection(configuration, catalog, nowMs) {
  if (configuration.communityPackIds.length === 0) {
    throw new OperatorPolicyError("COMMUNITY_PACK_REQUIRED");
  }
  if (!catalogIsFresh(catalog, nowMs)) throw new OperatorPolicyError("CATALOG_STALE");
  if (new Set(configuration.communityPackIds).size !== configuration.communityPackIds.length) {
    throw new OperatorPolicyError("COMMUNITY_PACK_DUPLICATE");
  }
  const orders = canonicalManualOrders(configuration);
  if (orders.length === 0) throw new OperatorPolicyError("MANUAL_PACK_REQUIRED");
  if (orders.length !== configuration.communityPackIds.length) {
    throw new OperatorPolicyError("MANUAL_PACK_SELECTION_MISMATCH");
  }
  const orderIds = orders.map((order) => order.productId);
  if (orderIds.some((productId, index) => productId !== configuration.communityPackIds[index])) {
    throw new OperatorPolicyError("MANUAL_PACK_SELECTION_MISMATCH");
  }
  const totalQuantity = orders.reduce((sum, order) => sum + order.quantity, 0);
  if (totalQuantity > (configuration.maxBoostersPerCycle ?? 100)) {
    throw new OperatorPolicyError("MANUAL_PACK_QUANTITY_INVALID");
  }
  const availablePacks = new Map(catalog.packs.map((pack) => [pack.id, pack]));
  const selectedPacks = orders.map((order) => availablePacks.get(order.productId));
  if (selectedPacks.some((pack) => !pack || pack.available <= 0)) {
    throw new OperatorPolicyError("COMMUNITY_PACK_UNAVAILABLE");
  }
  if (selectedPacks.some((pack, index) => pack.available < orders[index].quantity)) {
    throw new OperatorPolicyError("MANUAL_PACK_STOCK_EXCEEDED");
  }
  const maximumUnitPrice = BigInt(configuration.maxUnitPriceMicroUsdc);
  if (selectedPacks.some((pack) => BigInt(pack.priceMicroUsdc) > maximumUnitPrice)) {
    throw new OperatorPolicyError("COMMUNITY_PACK_PRICE_EXCEEDS_LIMIT");
  }
  const grossCollectorDebitMicroUsdc = orders.reduce(
    (sum, order, index) => sum + BigInt(selectedPacks[index].priceMicroUsdc) * BigInt(order.quantity),
    0n,
  );
  if (grossCollectorDebitMicroUsdc > BigInt(configuration.maxCycleBudgetMicroUsdc)) {
    throw new OperatorPolicyError("MANUAL_PACK_BUDGET_EXCEEDED");
  }
}

function canonicalManualOrders(configuration, { fallbackEmpty = false } = {}) {
  if (
    configuration.manualPackOrders === undefined ||
    (fallbackEmpty && configuration.manualPackOrders.length === 0)
  ) {
    return configuration.communityPackIds.map((productId) => ({ productId, quantity: 1 }));
  }
  return configuration.manualPackOrders.map((order) => ({ ...order }));
}

function accepted(previousState, nextState) {
  return {
    accepted: true,
    code: "DECISION_ACCEPTED",
    nextState: {
      ...nextState,
      version: previousState.version + 1,
      executionConnected: false,
    },
  };
}

function rejected(state, code) {
  return {
    accepted: false,
    code,
    nextState: structuredClone(state),
  };
}

class OperatorPolicyError extends Error {}

function catalogIsFresh(catalog, nowMs) {
  return (
    catalog?.status === "fresh" &&
    Number.isSafeInteger(catalog.fetchedAtMs) &&
    nowMs >= catalog.fetchedAtMs &&
    nowMs - catalog.fetchedAtMs <= 120_000 &&
    Array.isArray(catalog.packs)
  );
}

function validConfigurationShape(configuration) {
  const requiredKeys = [
    "mode",
    "communityPackIds",
    "maxUnitPriceMicroUsdc",
    "maxCycleBudgetMicroUsdc",
    "max24HourBudgetMicroUsdc",
  ];
  if (!plainObject(configuration)) return false;
  const optionalKeys = new Set([
    "maxBoostersPerCycle",
    "manualPackOrders",
    "cycleIntervalMinutes",
  ]);
  const actualKeys = Object.keys(configuration);
  return (
    requiredKeys.every((key) => actualKeys.includes(key)) &&
    actualKeys.every((key) => requiredKeys.includes(key) || optionalKeys.has(key)) &&
    typeof configuration.mode === "string" &&
    Array.isArray(configuration.communityPackIds) &&
    configuration.communityPackIds.every(
      (packId) => typeof packId === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(packId),
    ) &&
    (configuration.manualPackOrders === undefined ||
      (Array.isArray(configuration.manualPackOrders) &&
        configuration.manualPackOrders.every(validManualPackOrder)))
  );
}

function validManualPackOrder(order) {
  return (
    plainObject(order) &&
    hasExactKeys(order, ["productId", "quantity"]) &&
    typeof order.productId === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(order.productId) &&
    Number.isSafeInteger(order.quantity) &&
    order.quantity > 0
  );
}

function hasExactKeys(value, keys) {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function plainObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}
