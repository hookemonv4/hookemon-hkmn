// Fixture policy engine shaped after the actual production contract (packages/runner/src/config/
// state-schema.mjs's assertOperatorConfiguration/applyOperatorConfiguration and
// packages/dashboard/src/contracts/operator-contracts.mjs's readConfigurationPatch): a single
// aggregate allowedPackIds/requestedOrders model, not the retired mode/communityPackIds/
// manualPackOrders per-pack-quantity model. Reproduces the real bound checks so this fixture's
// transport/auth/audit-chain harness (unchanged) exercises meaningful limit coverage.
const packCodePattern = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export function createInitialOperatorState() {
  return {
    version: 0,
    desiredStatus: "paused",
    allowedPackIds: [],
    requestedOrders: 0,
    maxBoostersPerCycle: 100,
    intervalMinutes: 20,
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
  if (state.allowedPackIds.length > 0 && fresh) {
    const availableIds = new Set(catalog.packs.map((pack) => pack.id));
    if (state.allowedPackIds.some((id) => !availableIds.has(id))) {
      reasons.push("ALLOWED_PACK_UNAVAILABLE");
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
    "reconcile",
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

  if (command.type === "reconcile") {
    return accepted(state, { ...state });
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
  const intervalMinutes = configuration.intervalMinutes ?? 20;
  if (!Number.isSafeInteger(intervalMinutes) || intervalMinutes < 5 || intervalMinutes > 1440) {
    throw new OperatorPolicyError("CYCLE_INTERVAL_INVALID");
  }
  validateLimits(configuration, hardCaps);
  validateAllowedPackIds(configuration, catalog, nowMs);
  return {
    ...structuredClone(configuration),
    intervalMinutes,
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
  if (!Number.isSafeInteger(boosters) || boosters < 1 || boosters > 1000) {
    throw new OperatorPolicyError("MAX_BOOSTERS_INVALID");
  }
  if (boosters > (hardCaps.maxBoostersPerCycle ?? 100)) {
    throw new OperatorPolicyError("MAX_BOOSTERS_HARD_CAP_EXCEEDED");
  }
  const requestedOrders = configuration.requestedOrders ?? 0;
  if (!Number.isSafeInteger(requestedOrders) || requestedOrders < 0) {
    throw new OperatorPolicyError("REQUESTED_ORDERS_INVALID");
  }
  if (requestedOrders > boosters) {
    throw new OperatorPolicyError("REQUESTED_ORDERS_EXCEEDS_MAX_BOOSTERS");
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

function validateAllowedPackIds(configuration, catalog, nowMs) {
  const ids = configuration.allowedPackIds;
  let previous = null;
  for (const id of ids) {
    if (previous !== null && id <= previous) throw new OperatorPolicyError("ALLOWED_PACK_IDS_UNSORTED_OR_DUPLICATE");
    previous = id;
  }
  if (ids.length === 0) return;
  if (!catalogIsFresh(catalog, nowMs)) throw new OperatorPolicyError("CATALOG_STALE");
  const availableIds = new Set(catalog.packs.map((pack) => pack.id));
  if (ids.some((id) => !availableIds.has(id))) {
    throw new OperatorPolicyError("ALLOWED_PACK_UNAVAILABLE");
  }
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
    "allowedPackIds",
    "requestedOrders",
    "maxUnitPriceMicroUsdc",
    "maxCycleBudgetMicroUsdc",
    "max24HourBudgetMicroUsdc",
  ];
  if (!plainObject(configuration)) return false;
  const optionalKeys = new Set([
    "maxBoostersPerCycle",
    "intervalMinutes",
  ]);
  const actualKeys = Object.keys(configuration);
  return (
    requiredKeys.every((key) => actualKeys.includes(key)) &&
    actualKeys.every((key) => requiredKeys.includes(key) || optionalKeys.has(key)) &&
    Array.isArray(configuration.allowedPackIds) &&
    configuration.allowedPackIds.every((packId) => typeof packId === "string" && packCodePattern.test(packId)) &&
    Number.isSafeInteger(configuration.requestedOrders)
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
