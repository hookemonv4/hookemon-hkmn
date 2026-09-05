import { assertOperatorConfiguration } from '../config/state-schema.mjs';
import { canonicalJson, digest } from '../cycle/journal.mjs';
import { assertStandingAuthorityDecision } from '../cycle/money-schemas.mjs';
import { OPERATOR_HARD_CAPS } from '../operator/state-file.mjs';

export const POLICY_WINDOW_MS = 86_400_000;
const LEGACY_POLICY_DIGEST_REVISION_SEARCH_LIMIT = 10_000;

const decimalPattern = /^(0|[1-9][0-9]*)$/;
const cycleIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const mutationBoundaries = new Set(['claim-process', 'purchase', 'signature', 'broadcast', 'mutation']);
const executionBoundaries = new Set(['signature', 'broadcast', 'mutation']);

export class PolicyRefusalError extends Error {
  constructor(reason) {
    super(`policy refused mutation: ${reason}`);
    this.name = 'PolicyRefusalError';
    this.reason = reason;
  }
}

function assertClock(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('policy clock is invalid');
  return value;
}

function assertExpectedRevision(value) {
  if (value !== undefined && value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error('policy approval expectedRevision is invalid');
  }
  return value;
}

function assertAmount(value, label, { positive = false } = {}) {
  if (typeof value !== 'string' || !decimalPattern.test(value)) throw new Error(`${label} must be a canonical unsigned decimal string`);
  const amount = BigInt(value);
  if (positive && amount === 0n) throw new Error(`${label} must be positive`);
  return amount;
}

function assertCycleId(value) {
  if (typeof value !== 'string' || !cycleIdPattern.test(value)) throw new Error('policy cycleId is invalid');
  return value;
}

/**
 * Delegates the standing-authority first-use reservation to CycleRepository. The repository owns
 * the atomic day-cap and nonce mutation; the policy engine only validates the authority-derived
 * cap passed alongside the immutable decision.
 */
export async function reserveStandingAuthorityDecision({ cycleRepository, cycleId, decision, maxCyclesPerDay }) {
  assertCycleId(cycleId);
  if (!Number.isInteger(maxCyclesPerDay) || maxCyclesPerDay < 1) {
    throw new Error('standing authority maxCyclesPerDay is invalid');
  }
  if (!cycleRepository || typeof cycleRepository.recordStandingAuthorityDecision !== 'function') {
    throw new Error('standing authority cycle repository is required');
  }
  const proposed = assertStandingAuthorityDecision(decision);
  const stored = await cycleRepository.recordStandingAuthorityDecision(cycleId, proposed, { maxCyclesPerDay });
  const persisted = assertStandingAuthorityDecision(stored, 'persisted standing authority decision');
  if (canonicalJson(proposed) !== canonicalJson(persisted)) {
    throw new Error('standing authority repository returned a conflicting decision');
  }
  return Object.freeze(persisted);
}

function assertPackId(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('policy packId is invalid');
  return value;
}

function assertBoundary(value) {
  if (!['cycle-start', 'claim-process', 'purchase', 'signature', 'broadcast', 'mutation'].includes(value)) {
    throw new Error('policy boundary is invalid');
  }
  return value;
}

function normalizeCustody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('policy custody projection is invalid');
  const normalized = {
    realizedLossMicroUsdg: assertAmount(value.realizedLossMicroUsdg, 'policy custody realizedLossMicroUsdg'),
    atRiskMicroUsdg: assertAmount(value.atRiskMicroUsdg, 'policy custody atRiskMicroUsdg'),
    outstandingMicroUsdg: assertAmount(value.outstandingMicroUsdg, 'policy custody outstandingMicroUsdg'),
    heldAssets: value.heldAssets,
    unattributed: value.unattributed,
    unvaluedExposure: value.unvaluedExposure,
  };
  for (const field of ['heldAssets', 'unattributed', 'unvaluedExposure']) {
    if (typeof normalized[field] !== 'boolean') throw new Error(`policy custody ${field} is invalid`);
  }
  return normalized;
}

function zeroCustody() {
  return {
    realizedLossMicroUsdg: '0',
    atRiskMicroUsdg: '0',
    outstandingMicroUsdg: '0',
    heldAssets: false,
    unattributed: false,
    unvaluedExposure: false,
  };
}

function withinTrailingWindow(events, field, now) {
  return events.filter(event => now >= event[field] && now - event[field] < POLICY_WINDOW_MS);
}

function cycleMode(liveMode, explicitMode = undefined) {
  if (typeof liveMode !== 'boolean') throw new Error('policy liveMode is invalid');
  if (explicitMode !== undefined) {
    if (explicitMode !== 'production' && explicitMode !== 'rehearsal') throw new Error('policy mode is invalid');
    return explicitMode;
  }
  return liveMode ? 'production' : 'rehearsal';
}

function policyMaterial(configuration) {
  return {
    allowedPackIds: [...configuration.allowedPackIds],
    requestedOrders: configuration.requestedOrders,
    maxBoostersPerCycle: configuration.maxBoostersPerCycle,
    maxUnitPriceMicroUsdg: configuration.maxUnitPriceMicroUsdg,
    perCycleCapMicroUsdg: configuration.perCycleCapMicroUsdg,
    max24HourBudgetMicroUsdg: configuration.max24HourBudgetMicroUsdg,
    maxCyclesPerDay: configuration.maxCyclesPerDay,
    lossCapMicroUsdg: configuration.lossCapMicroUsdg,
    maxOutstandingCustodyMicroUsdg: configuration.maxOutstandingCustodyMicroUsdg,
    manualApprovalCycles: configuration.manualApprovalCycles,
  };
}

function assertOperatorHardCaps(configuration) {
  for (const [field, ceiling] of Object.entries(OPERATOR_HARD_CAPS)) {
    if (BigInt(configuration[field]) > BigInt(ceiling)) {
      throw new Error(`policy configuration ${field} exceeds the fixed hard cap`);
    }
  }
  return configuration;
}

function legacyPolicyMaterial(configuration, configurationRevision) {
  return {
    configurationRevision,
    ...policyMaterial(configuration),
  };
}

function digestCyclePolicy({ schema, policy, cycleId, releaseAmountMicroUsdg, packId, liveMode, mode }) {
  return digest({
    schema,
    cycleId,
    releaseAmountMicroUsdg,
    packId,
    mode: cycleMode(liveMode, mode),
    policy,
  });
}

export function deriveCyclePolicyDigest({ configuration, cycleId, releaseAmountMicroUsdg, packId, liveMode, mode }) {
  const normalized = assertOperatorHardCaps(assertOperatorConfiguration(configuration));
  assertCycleId(cycleId);
  assertAmount(releaseAmountMicroUsdg, 'policy releaseAmountMicroUsdg', { positive: true });
  assertPackId(packId);
  return digestCyclePolicy({
    schema: 'hookemon.policy-cycle.v2',
    policy: policyMaterial(normalized),
    cycleId,
    releaseAmountMicroUsdg,
    packId,
    liveMode,
    mode,
  });
}

function deriveLegacyCyclePolicyDigest({ configuration, cycleId, releaseAmountMicroUsdg, packId, liveMode, mode, configurationRevision }) {
  return digestCyclePolicy({
    schema: 'hookemon.policy-cycle.v1',
    policy: legacyPolicyMaterial(configuration, configurationRevision),
    cycleId,
    releaseAmountMicroUsdg,
    packId,
    liveMode,
    mode,
  });
}

function matchingExistingCycleDigest({ configuration, existing, cycleId, releaseAmountMicroUsdg, packId, liveMode, mode }) {
  const current = deriveCyclePolicyDigest({ configuration, cycleId, releaseAmountMicroUsdg, packId, liveMode, mode });
  if (existing.cycleDigest === current) return current;
  if (configuration.configurationRevision > LEGACY_POLICY_DIGEST_REVISION_SEARCH_LIMIT) return null;
  for (let revision = 0; revision <= configuration.configurationRevision; revision += 1) {
    const legacy = deriveLegacyCyclePolicyDigest({
      configuration,
      cycleId,
      releaseAmountMicroUsdg,
      packId,
      liveMode,
      mode,
      configurationRevision: revision,
    });
    if (existing.cycleDigest === legacy) return legacy;
  }
  return null;
}

function existingCycle(configuration, cycleId) {
  return configuration.cycleLedger.find(entry => entry.cycleId === cycleId) ?? null;
}

function hasAnyCycleExecutionContext(context) {
  return context.cycleId !== null || context.packId !== null || context.releaseAmount !== 0n;
}

function hasCompleteCycleExecutionContext(context) {
  return context.cycleId !== null && context.packId !== null && context.releaseAmount > 0n;
}

function effectiveCycleCap(configuration, context) {
  const configuredCap = BigInt(configuration.perCycleCapMicroUsdg);
  if (context.capUsdg === null) return configuredCap;
  return context.capUsdg < configuredCap ? context.capUsdg : configuredCap;
}

function evaluateExistingCycleExecution({ configuration, custodyState, context }) {
  if (!context.cycleId || !context.packId || context.releaseAmount === 0n) {
    throw new Error('policy execution guard requires cycleId, packId, and a positive release amount');
  }
  if (!configuration.allowedPackIds.includes(context.packId)) return refused('PACK_NOT_ALLOWED');
  if (context.releaseAmount > effectiveCycleCap(configuration, context)
    || context.releaseAmount > BigInt(configuration.maxCycleBudgetMicroUsdg)) {
    return refused('PER_CYCLE_CAP');
  }

  const existing = existingCycle(configuration, context.cycleId);
  if (!existing || existing.releaseAmountMicroUsdg !== context.releaseAmount.toString()) return refused('CYCLE_POLICY_MISSING');
  const cycleDigest = matchingExistingCycleDigest({
    configuration,
    existing,
    cycleId: context.cycleId,
    releaseAmountMicroUsdg: context.releaseAmount.toString(),
    packId: context.packId,
    liveMode: context.liveMode,
    mode: context.mode,
  });
  if (cycleDigest === null) return refused('CYCLE_POLICY_DIGEST_CHANGED');
  const reservation = configuration.spendLedger.find(entry => entry.cycleDigest === cycleDigest);
  if (!reservation || reservation.amountMicroUsdg !== existing.releaseAmountMicroUsdg) return refused('SPEND_RESERVATION_MISSING');

  const modeCycles = configuration.cycleLedger.filter(entry => entry.mode === context.mode);
  const ordinal = modeCycles.findIndex(entry => entry.cycleDigest === cycleDigest) + 1;
  if (ordinal > 0 && ordinal <= configuration.manualApprovalCycles) {
    const approval = configuration.approvalsByCycleDigest[cycleDigest];
    if (!approval || approval.cycleId !== context.cycleId) return refused('MANUAL_APPROVAL_REQUIRED');
  }
  if (custodyState.realizedLossMicroUsdg + custodyState.atRiskMicroUsdg > BigInt(configuration.lossCapMicroUsdg)) {
    return refused('LOSS_CAP');
  }
  if (custodyState.outstandingMicroUsdg > BigInt(configuration.maxOutstandingCustodyMicroUsdg)) {
    return refused('OUTSTANDING_CUSTODY_CAP');
  }
  return allowed(cycleDigest);
}

function evaluateAdmittedClaimExecution({ configuration, custody, ...input }) {
  const decision = evaluateConfiguredPolicy({ configuration, custody, ...input, boundary: 'claim-process' });
  if (!decision.allowed) return decision;
  const context = admissionContext({ ...input, boundary: 'claim-process' });
  const existing = existingCycle(configuration, context.cycleId);
  if (!existing || existing.releaseAmountMicroUsdg !== context.releaseAmount.toString()) {
    return refused('CYCLE_POLICY_MISSING');
  }
  return decision;
}

function refused(reason) {
  return Object.freeze({ allowed: false, reason });
}

function allowed(cycleDigest = null) {
  return Object.freeze(cycleDigest === null ? { allowed: true } : { allowed: true, cycleDigest });
}

function admissionContext(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('policy admission input is invalid');
  const boundary = assertBoundary(input.boundary);
  const liveMode = input.liveMode;
  const mode = cycleMode(liveMode, input.mode);
  const now = assertClock(input.now);
  const releaseAmount = input.releaseAmountMicroUsdg === undefined
    ? 0n
    : assertAmount(input.releaseAmountMicroUsdg, 'policy releaseAmountMicroUsdg');
  if (['claim-process', 'purchase'].includes(boundary) && releaseAmount === 0n) {
    throw new Error('policy releaseAmountMicroUsdg must be positive for a money boundary');
  }
  if (input.cycleId !== undefined && input.cycleId !== null) assertCycleId(input.cycleId);
  if (input.packId !== undefined && input.packId !== null) assertPackId(input.packId);
  const capUsdg = input.capUsdg === undefined ? null : assertAmount(input.capUsdg, 'policy capUsdg');
  return { boundary, liveMode, mode, now, releaseAmount, capUsdg, cycleId: input.cycleId ?? null, packId: input.packId ?? null };
}

function evaluateConfiguredPolicy({ configuration, custody, ...input }) {
  const context = admissionContext(input);
  const normalized = assertOperatorHardCaps(assertOperatorConfiguration(configuration));
  const custodyState = normalizeCustody(custody);
  if (normalized.liveMode !== context.liveMode) return refused('EXECUTION_MODE_MISMATCH');

  const requiresImmediateExecutionGate = context.boundary === 'cycle-start' || mutationBoundaries.has(context.boundary);
  if (requiresImmediateExecutionGate && normalized.killSwitch) return refused('KILL_SWITCH');
  if (requiresImmediateExecutionGate && normalized.executionPaused) return refused('EXECUTION_PAUSED');
  if (context.boundary === 'cycle-start' && normalized.paused) return refused('SCHEDULING_PAUSED');
  if (executionBoundaries.has(context.boundary) && hasAnyCycleExecutionContext(context)) {
    if (!hasCompleteCycleExecutionContext(context)) {
      throw new Error('policy execution guard requires cycleId, packId, and a positive release amount');
    }
    if (input.stage === 'claim-process') {
      return evaluateAdmittedClaimExecution({ configuration: normalized, custody, ...input });
    }
    if (input.stage === 'purchase') {
      return evaluateConfiguredPolicy({ configuration: normalized, custody, ...input, boundary: 'purchase' });
    }
    if (context.boundary === 'mutation' && input.stage === 'eligibility-snapshot'
      && existingCycle(normalized, context.cycleId) === null) {
      return allowed();
    }
    return evaluateExistingCycleExecution({ configuration: normalized, custodyState, context });
  }

  if (context.boundary === 'cycle-start') {
    const cyclesInWindow = withinTrailingWindow(
      normalized.cycleLedger.filter(entry => entry.mode === context.mode),
      'openedAtMs',
      context.now,
    );
    if (cyclesInWindow.length >= normalized.maxCyclesPerDay) return refused('MAX_CYCLES_PER_DAY');
    if (context.releaseAmount > effectiveCycleCap(normalized, context)) return refused('PER_CYCLE_CAP');
    return allowed();
  }

  if (context.boundary === 'claim-process') {
    if (context.cycleId === null || context.packId === null) throw new Error('policy claim-process requires cycleId and packId');
    if (normalized.pendingEpicDecisions.length > 0 || custodyState.heldAssets) return refused('HELD_CUSTODY');
    if (custodyState.unattributed) return refused('UNATTRIBUTED_CUSTODY');
    if (custodyState.unvaluedExposure) return refused('UNVALUED_CUSTODY');
    if (!normalized.allowedPackIds.includes(context.packId)) return refused('PACK_NOT_ALLOWED');
    if (normalized.requestedOrders === 0) return refused('NO_ORDERS_REQUESTED');
    if (context.releaseAmount > effectiveCycleCap(normalized, context)) return refused('PER_CYCLE_CAP');
    if (context.releaseAmount > BigInt(normalized.maxCycleBudgetMicroUsdg)) return refused('PER_CYCLE_CAP');

    const existing = existingCycle(normalized, context.cycleId);
    const modeCyclesInWindow = withinTrailingWindow(
      normalized.cycleLedger.filter(entry => entry.mode === context.mode),
      'openedAtMs',
      context.now,
    );
    if (!existing && modeCyclesInWindow.length >= normalized.maxCyclesPerDay) return refused('MAX_CYCLES_PER_DAY');

    const derivedCycleDigest = deriveCyclePolicyDigest({
      configuration: normalized,
      cycleId: context.cycleId,
      releaseAmountMicroUsdg: context.releaseAmount.toString(),
      packId: context.packId,
      liveMode: context.liveMode,
      mode: context.mode,
    });
    const cycleDigest = existing
      ? matchingExistingCycleDigest({
        configuration: normalized,
        existing,
        cycleId: context.cycleId,
        releaseAmountMicroUsdg: context.releaseAmount.toString(),
        packId: context.packId,
        liveMode: context.liveMode,
        mode: context.mode,
      })
      : derivedCycleDigest;
    if (cycleDigest === null) return refused('CYCLE_POLICY_DIGEST_CHANGED');

    const spendInWindow = withinTrailingWindow(normalized.spendLedger, 'reservedAtMs', context.now)
      .reduce((sum, entry) => sum + BigInt(entry.amountMicroUsdg), 0n);
    const alreadyReserved = normalized.spendLedger.find(entry => entry.cycleDigest === cycleDigest);
    if (existing && (!alreadyReserved || alreadyReserved.amountMicroUsdg !== context.releaseAmount.toString())) {
      return refused('SPEND_RESERVATION_MISSING');
    }
    if (alreadyReserved && !withinTrailingWindow([alreadyReserved], 'reservedAtMs', context.now).length) {
      return refused('SPEND_RESERVATION_EXPIRED');
    }
    const additionalSpend = alreadyReserved ? 0n : context.releaseAmount;
    const pendingPrincipal = alreadyReserved ? BigInt(alreadyReserved.amountMicroUsdg) : context.releaseAmount;
    if (spendInWindow + additionalSpend > BigInt(normalized.max24HourBudgetMicroUsdg)) return refused('ROLLING_24H_CAP');

    const modeCycles = normalized.cycleLedger.filter(entry => entry.mode === context.mode);
    const ordinal = existing
      ? modeCycles.findIndex(entry => entry.cycleDigest === cycleDigest) + 1
      : modeCycles.length + 1;
    if (ordinal > 0 && ordinal <= normalized.manualApprovalCycles) {
      const approval = normalized.approvalsByCycleDigest[cycleDigest];
      if (!approval || approval.cycleId !== context.cycleId) return refused('MANUAL_APPROVAL_REQUIRED');
    }

    if (custodyState.realizedLossMicroUsdg + custodyState.atRiskMicroUsdg + pendingPrincipal > BigInt(normalized.lossCapMicroUsdg)) {
      return refused('LOSS_CAP');
    }
    if (custodyState.outstandingMicroUsdg + pendingPrincipal > BigInt(normalized.maxOutstandingCustodyMicroUsdg)) {
      return refused('OUTSTANDING_CUSTODY_CAP');
    }
    return allowed(cycleDigest);
  }

  if (context.boundary === 'purchase') {
    if (context.cycleId === null || context.packId === null) throw new Error('policy purchase requires cycleId and packId');
    if (normalized.pendingEpicDecisions.length > 0 || custodyState.heldAssets) return refused('HELD_CUSTODY');
    if (custodyState.unattributed) return refused('UNATTRIBUTED_CUSTODY');
    if (custodyState.unvaluedExposure) return refused('UNVALUED_CUSTODY');
    if (!normalized.allowedPackIds.includes(context.packId)) return refused('PACK_NOT_ALLOWED');
    if (context.releaseAmount > BigInt(normalized.maxUnitPriceMicroUsdg)) return refused('UNIT_PRICE_CAP');
    const existing = existingCycle(normalized, context.cycleId);
    if (!existing) return refused('CYCLE_POLICY_MISSING');
    const expectedDigest = matchingExistingCycleDigest({
      configuration: normalized,
      existing,
      cycleId: context.cycleId,
      releaseAmountMicroUsdg: existing.releaseAmountMicroUsdg,
      packId: context.packId,
      liveMode: context.liveMode,
      mode: context.mode,
    });
    if (expectedDigest === null) return refused('CYCLE_POLICY_DIGEST_CHANGED');
    const reservation = normalized.spendLedger.find(entry => entry.cycleDigest === expectedDigest);
    if (!reservation || context.releaseAmount > BigInt(reservation.amountMicroUsdg)) return refused('SPEND_RESERVATION_MISSING');
    if (context.releaseAmount > effectiveCycleCap(normalized, context)) return refused('PER_CYCLE_CAP');
    if (custodyState.realizedLossMicroUsdg + custodyState.atRiskMicroUsdg > BigInt(normalized.lossCapMicroUsdg)) {
      return refused('LOSS_CAP');
    }
    if (custodyState.outstandingMicroUsdg > BigInt(normalized.maxOutstandingCustodyMicroUsdg)) {
      return refused('OUTSTANDING_CUSTODY_CAP');
    }
    return allowed(expectedDigest);
  }

  return allowed();
}

export function evaluateClaim(input) {
  return evaluateConfiguredPolicy({ ...input, boundary: 'claim-process' });
}

export function evaluatePurchase(input) {
  return evaluateConfiguredPolicy({ ...input, boundary: 'purchase' });
}

export function evaluateSignature(input) {
  return evaluateConfiguredPolicy({ ...input, boundary: 'signature' });
}

function reservationConfiguration(configuration, { cycleId, cycleDigest, releaseAmountMicroUsdg, liveMode, mode, now }) {
  const existing = existingCycle(configuration, cycleId);
  if (existing) return configuration;
  const resolvedMode = cycleMode(liveMode, mode);
  const cycleLedger = [
    ...configuration.cycleLedger,
    {
      cycleId,
      cycleDigest,
      mode: resolvedMode,
      openedAtMs: now,
      releaseAmountMicroUsdg,
    },
  ];
  const spendLedger = [
    ...configuration.spendLedger,
    {
      cycleId,
      cycleDigest,
      amountMicroUsdg: releaseAmountMicroUsdg,
      reservedAtMs: now,
    },
  ];
  return assertOperatorConfiguration({ ...configuration, cycleLedger, spendLedger });
}

function assertEngineDependency(value, name) {
  if (typeof value !== 'function') throw new Error(`policy engine ${name} is required`);
  return value;
}

export function createPolicyEngine({ now = () => Date.now(), readConfiguration, readCustody = async () => zeroCustody(), mutateConfiguration }) {
  assertEngineDependency(now, 'now');
  assertEngineDependency(readConfiguration, 'readConfiguration');
  assertEngineDependency(readCustody, 'readCustody');
  assertEngineDependency(mutateConfiguration, 'mutateConfiguration');

  async function evaluate(input) {
    const liveMode = input?.liveMode;
    if (typeof liveMode !== 'boolean') throw new Error('policy liveMode is invalid');
    const configuration = await readConfiguration();
    if (configuration === null) return liveMode ? refused('CONFIGURATION_MISSING') : allowed();
    const custody = await readCustody();
    return evaluateConfiguredPolicy({ ...input, configuration, custody, now: now() });
  }

  return Object.freeze({
    async evaluate(input) {
      return evaluate(input);
    },
    async evaluateClaim(input) {
      return evaluate({ ...input, boundary: 'claim-process' });
    },
    async evaluatePurchase(input) {
      return evaluate({ ...input, boundary: 'purchase' });
    },
    async admit(input) {
      const initial = await evaluate(input);
      if (!initial.allowed || input.boundary !== 'claim-process' || input.reservePolicy === false) return initial;
      return mutateConfiguration(async configuration => {
        const custody = await readCustody();
        const decision = evaluateConfiguredPolicy({ ...input, configuration, custody, now: now() });
        if (!decision.allowed) return { configuration, result: decision };
        const next = reservationConfiguration(configuration, {
          cycleId: input.cycleId,
          cycleDigest: decision.cycleDigest,
          releaseAmountMicroUsdg: input.releaseAmountMicroUsdg,
          liveMode: input.liveMode,
          mode: input.mode,
          now: now(),
        });
        return { configuration: next, result: decision };
      });
    },
    async recordManualApproval({ cycleDigest, cycleId, approvedAtMs, expectedRevision = undefined }) {
      if (typeof cycleDigest !== 'string' || !digestPattern.test(cycleDigest)) throw new Error('policy approval cycleDigest is invalid');
      assertCycleId(cycleId);
      if (approvedAtMs !== undefined) assertClock(approvedAtMs);
      const revision = assertExpectedRevision(expectedRevision);
      const mutationOptions = revision === undefined ? undefined : { expectedRevision: revision };
      return mutateConfiguration(configuration => {
        const existing = configuration.approvalsByCycleDigest[cycleDigest];
        if (existing) {
          if (existing.cycleId !== cycleId || (approvedAtMs !== undefined && existing.approvedAtMs !== approvedAtMs)) {
            throw new Error('policy approval conflicts with the existing cycle digest approval');
          }
          return { configuration, result: Object.freeze({ cycleDigest, ...existing }) };
        }
        const resolvedApprovedAtMs = approvedAtMs ?? assertClock(now());
        const next = assertOperatorConfiguration({
          ...configuration,
          approvalsByCycleDigest: {
            ...configuration.approvalsByCycleDigest,
            [cycleDigest]: { cycleId, approvedAtMs: resolvedApprovedAtMs },
          },
        });
        return { configuration: next, result: Object.freeze({ cycleDigest, cycleId, approvedAtMs: resolvedApprovedAtMs }) };
      }, mutationOptions);
    },
    async assertExecutionAllowed(input) {
      const { boundary, liveMode } = input ?? {};
      const hasCycleContext = input?.cycleId !== undefined
        || input?.releaseAmountMicroUsdg !== undefined
        || input?.packId !== undefined;
      if ((boundary === 'signature' || boundary === 'broadcast') && hasCycleContext
        && (typeof input.requestDigest !== 'string' || !digestPattern.test(input.requestDigest))) {
        throw new Error('policy execution requestDigest is invalid');
      }
      const decision = await evaluate({ ...input, boundary, liveMode });
      if (!decision.allowed) throw new PolicyRefusalError(decision.reason);
      return decision;
    },
  });
}
