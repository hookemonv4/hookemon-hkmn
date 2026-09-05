import { isAbsolute } from 'node:path';

import { applyOperatorConfiguration, createDefaultOperatorConfiguration } from '../config/state-schema.mjs';
import {
  CUSTODY_LEDGER_BUCKETS,
  OPERATIONAL_CYCLE_STAGES,
  assertChainTransactionAttempt,
  assertProviderMutationAttempt,
  assertTypedAmount,
} from '../cycle/money-schemas.mjs';
import { POLICY_WINDOW_MS } from '../automation/policy-engine.mjs';
import {
  createEmptyOperatorState,
  mutateOperatorState,
  readOperatorState,
} from './state-file.mjs';

const missingStateFileMessage = 'operator state file does not exist';
const cycleIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const atomicAmountPattern = /^(0|[1-9][0-9]*)$/;
const heldOwnerDecisionChoices = new Set(['sell', 'keep-holding']);
const operationalStageOrder = new Map(OPERATIONAL_CYCLE_STAGES.map((stage, index) => [stage, index]));
const durableStageStatuses = new Set(['UNKNOWN', 'PENDING', 'COMPLETE']);
const commandTypes = new Set([
  'pause',
  'resume',
  'kill',
  'update-configuration',
  'manual-approval',
  'held-owner-decision',
  'reconcile',
  'resume-cycle',
  'run-cycle-now',
]);
const protectedConfigurationFields = new Set(['paused', 'executionPaused', 'killSwitch']);

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function exactObject(value, fields, label) {
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== fields.length
    || !fields.every(field => Object.hasOwn(value, field))
  ) throw new Error(`${label} must use the exact schema`);
  return value;
}

function assertExpectedRevision(value) {
  if (value !== null && (!Number.isSafeInteger(value) || value < 0)) {
    throw new Error('expected operator state revision is invalid');
  }
  return value;
}

function assertCycleId(value) {
  if (typeof value !== 'string' || !cycleIdPattern.test(value)) throw new Error('operator control cycleId is invalid');
  return value;
}

function assertDigest(value) {
  if (typeof value !== 'string' || !digestPattern.test(value)) throw new Error('operator control cycleDigest is invalid');
  return value;
}

function assertRequestId(value) {
  if (typeof value !== 'string' || !requestIdPattern.test(value)) throw new Error('operator control requestId is invalid');
  return value;
}

function assertCycleRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('operator control expectedCycleRevision is invalid');
  return value;
}

function projectCycleVersion(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('operator control repository cycle version is invalid');
  return value;
}

function projectHeldEvidenceDigest(value) {
  if (value === null) return null;
  if (typeof value !== 'string' || !digestPattern.test(value)) {
    throw new Error('operator control repository held evidence digest is invalid');
  }
  return value;
}

function projectHeldOwnerDecision(cycleId, heldEvidenceDigest, value) {
  if (value === null) return null;
  const source = exactObject(
    value,
    ['cycleId', 'heldEvidenceDigest', 'requestId', 'expectedRevision', 'choice'],
    'operator control repository held owner decision',
  );
  if (source.cycleId !== cycleId || source.heldEvidenceDigest !== heldEvidenceDigest) {
    throw new Error('operator control repository held owner decision does not bind the cycle hold');
  }
  assertRequestId(source.requestId);
  assertCycleRevision(source.expectedRevision);
  if (!heldOwnerDecisionChoices.has(source.choice)) {
    throw new Error('operator control repository held owner decision choice is invalid');
  }
  return deepFreeze(structuredClone(source));
}

function assertCommand(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error('operator control command is invalid');
  }
  if (!commandTypes.has(value.type)) throw new Error('operator control command type is invalid');
  switch (value.type) {
    case 'pause':
    case 'resume':
    case 'kill':
    case 'reconcile':
    case 'resume-cycle':
    case 'run-cycle-now':
      exactObject(value, ['type'], 'operator control command');
      return { type: value.type };
    case 'update-configuration': {
      exactObject(value, ['type', 'configuration'], 'operator control command');
      if (!value.configuration || typeof value.configuration !== 'object' || Array.isArray(value.configuration)
        || Object.getPrototypeOf(value.configuration) !== Object.prototype || Object.keys(value.configuration).length === 0) {
        throw new Error('operator control configuration patch is invalid');
      }
      for (const field of Object.keys(value.configuration)) {
        if (protectedConfigurationFields.has(field)) throw new Error(`operator control configuration patch must use ${field === 'killSwitch' ? 'kill' : field === 'paused' ? 'pause or resume' : 'pause, resume, or kill'}`);
      }
      return { type: value.type, configuration: structuredClone(value.configuration) };
    }
    case 'manual-approval':
      exactObject(value, ['type', 'cycleId', 'cycleDigest'], 'operator control command');
      return { type: value.type, cycleId: assertCycleId(value.cycleId), cycleDigest: assertDigest(value.cycleDigest) };
    case 'held-owner-decision':
      exactObject(value, ['type', 'cycleId', 'heldEvidenceDigest', 'expectedCycleRevision', 'choice'], 'operator control command');
      if (!heldOwnerDecisionChoices.has(value.choice)) throw new Error('operator control held owner decision choice is invalid');
      return {
        type: value.type,
        cycleId: assertCycleId(value.cycleId),
        heldEvidenceDigest: assertDigest(value.heldEvidenceDigest),
        expectedCycleRevision: assertCycleRevision(value.expectedCycleRevision),
        choice: value.choice,
      };
    default:
      throw new Error('operator control command type is invalid');
  }
}

function requireRepository(value) {
  for (const method of ['peekActiveCycle', 'listKnownCycleIds', 'describeCycle']) {
    if (!value || typeof value[method] !== 'function') throw new Error(`operator control cycleRepository.${method} is required`);
  }
  return value;
}

function requirePolicyEngine(value) {
  if (!value || typeof value.recordManualApproval !== 'function') {
    throw new Error('operator control policyEngine.recordManualApproval is required');
  }
  return value;
}

function activeCycleId(value) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value) || !cycleIdPattern.test(value.cycleId)) {
    throw new Error('operator control cycleRepository.peekActiveCycle returned invalid data');
  }
  return value.cycleId;
}

function mapEntries(value) {
  if (value instanceof Map) return [...value.entries()];
  if (Array.isArray(value)) return value.map((entry, index) => [String(index), entry]);
  if (value && typeof value === 'object') return Object.entries(value);
  return [];
}

function compareStages(left, right) {
  const leftOrder = operationalStageOrder.get(left);
  const rightOrder = operationalStageOrder.get(right);
  if (leftOrder !== undefined && rightOrder !== undefined) return leftOrder - rightOrder;
  if (leftOrder !== undefined) return -1;
  if (rightOrder !== undefined) return 1;
  return left.localeCompare(right);
}

function assertOperationalStage(value, label) {
  if (typeof value !== 'string' || !operationalStageOrder.has(value)) throw new Error(`${label} is invalid`);
  return value;
}

function stageStatePriority(status) {
  return new Map([
    ['UNKNOWN', 0],
    ['PENDING', 1],
    ['PREPARED', 2],
    ['SIGNED', 3],
    ['RESPONSE_RECORDED', 4],
    ['RECONCILED', 5],
    ['FINALIZED', 6],
    ['BROADCAST', 7],
    ['SENT_UNKNOWN', 8],
    ['COMPLETE', 9],
  ]).get(status) ?? 0;
}

function recordStageState(states, stage, status) {
  const previous = states.get(stage);
  if (previous === undefined || stageStatePriority(status) > stageStatePriority(previous)) {
    states.set(stage, status);
  }
}

function projectProviderAttempt(cycleId, record) {
  const attempt = assertProviderMutationAttempt(record?.attempt ?? record, 'operator control provider attempt');
  if (attempt.cycleId !== cycleId) throw new Error('operator control provider attempt cycleId is invalid');
  return deepFreeze({
    stage: attempt.stage,
    state: attempt.state,
    requestDigest: attempt.requestDigest,
  });
}

function projectChainTransaction(cycleId, record) {
  const attempt = assertChainTransactionAttempt(record?.attempt ?? record, 'operator control chain transaction attempt');
  if (attempt.cycleId !== cycleId) throw new Error('operator control chain transaction attempt cycleId is invalid');
  return deepFreeze({
    stage: attempt.stage,
    state: attempt.state,
    requestDigest: attempt.requestDigest,
    transactionId: attempt.hash,
  });
}

function projectCustodyBucket(cycleId, ledger) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)
    || ledger.cycleId !== cycleId || typeof ledger.chainId !== 'string'
    || typeof ledger.assetId !== 'string' || !Number.isInteger(ledger.decimals)) {
    throw new Error('operator control repository custody ledger is invalid');
  }
  const identity = { chainId: ledger.chainId, assetId: ledger.assetId, decimals: ledger.decimals };
  const buckets = {};
  for (const name of CUSTODY_LEDGER_BUCKETS) {
    buckets[name] = assertTypedAmount({ ...identity, amountAtomic: ledger[name] }, `operator control custody ${name}`);
  }
  return deepFreeze({ cycleId, ...identity, buckets });
}

function projectCycle(cycleId, description) {
  if (!description || typeof description !== 'object' || Array.isArray(description)) {
    throw new Error('operator control repository cycle description is invalid');
  }
  const terminalState = typeof description.terminalState === 'string' ? description.terminalState : null;
  const stageStates = new Map();
  for (const [stage, state] of mapEntries(description.stages)) {
    assertOperationalStage(stage, 'operator control repository stage');
    if (!durableStageStatuses.has(state?.status)) {
      throw new Error('operator control repository stage status is invalid');
    }
    recordStageState(stageStates, stage, state.status);
  }
  for (const [stage] of mapEntries(description.preparedStages)) {
    assertOperationalStage(stage, 'operator control repository prepared stage');
    recordStageState(stageStates, stage, 'PREPARED');
  }
  const requests = mapEntries(description.operationalAttempts)
    .map(([, record]) => projectProviderAttempt(cycleId, record))
    .sort((left, right) => compareStages(left.stage, right.stage) || left.requestDigest.localeCompare(right.requestDigest));
  for (const request of requests) recordStageState(stageStates, request.stage, request.state);
  const transactions = mapEntries(description.chainAttempts)
    .map(([, record]) => projectChainTransaction(cycleId, record))
    .sort((left, right) => compareStages(left.stage, right.stage) || left.requestDigest.localeCompare(right.requestDigest));
  for (const transaction of transactions) recordStageState(stageStates, transaction.stage, transaction.state);
  if (terminalState === null) {
    const nextStage = OPERATIONAL_CYCLE_STAGES.find(stage => stageStates.get(stage) !== 'COMPLETE');
    if (nextStage !== undefined && !stageStates.has(nextStage)) recordStageState(stageStates, nextStage, 'PENDING');
  }
  const stages = [...stageStates.entries()]
    .map(([stage, status]) => ({ stage, status }))
    .sort((left, right) => compareStages(left.stage, right.stage));
  const custodyBuckets = mapEntries(description.custodyLedgers)
    .map(([, ledger]) => projectCustodyBucket(cycleId, ledger))
    .sort((left, right) => `${left.chainId}\u0000${left.assetId}`.localeCompare(`${right.chainId}\u0000${right.assetId}`));
  const transactionIds = [...new Set(transactions.map(transaction => transaction.transactionId).filter(Boolean))];
  const version = projectCycleVersion(description.version);
  const heldEvidenceDigest = projectHeldEvidenceDigest(description.heldEvidenceDigest);
  const ownerDecision = projectHeldOwnerDecision(cycleId, heldEvidenceDigest, description.ownerDecision);
  const payoutStage = terminalState !== null && terminalState !== 'COMPLETED'
    ? null
    : stages.find(entry => entry.stage === 'payout') ?? null;
  const payoutTransactionIds = [...new Set(transactions
    .filter(transaction => transaction.stage === 'payout' && transaction.transactionId !== null)
    .map(transaction => transaction.transactionId))];
  return deepFreeze({
    cycleId,
    releaseAmount: typeof description.releaseAmount === 'string' ? description.releaseAmount : null,
    terminalState,
    version,
    heldEvidenceDigest,
    ownerDecision,
    stages,
    requests,
    transactions,
    transactionIds: transactionIds.length > 0 ? transactionIds : null,
    custodyBuckets,
    payout: payoutStage === null
      ? null
      : { status: payoutStage.status, transactionIds: payoutTransactionIds.length > 0 ? payoutTransactionIds : null },
  });
}

function projectOffChainCap(configuration, now) {
  if (configuration === null) return null;
  const used = configuration.spendLedger
    .filter(entry => now >= entry.reservedAtMs && now - entry.reservedAtMs < POLICY_WINDOW_MS)
    .reduce((sum, entry) => sum + BigInt(entry.amountMicroUsdg), 0n);
  const limit = BigInt(configuration.max24HourBudgetMicroUsdg);
  return deepFreeze({
    usedMicroUsdg: used.toString(),
    limitMicroUsdg: limit.toString(),
    remainingMicroUsdg: (limit > used ? limit - used : 0n).toString(),
  });
}

function projectCapacity(used, limit) {
  return deepFreeze({
    usedMicroUsdg: used.toString(),
    limitMicroUsdg: limit.toString(),
    remainingMicroUsdg: (limit > used ? limit - used : 0n).toString(),
  });
}

function projectPolicyTelemetry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  for (const field of ['realizedLossMicroUsdg', 'atRiskMicroUsdg', 'outstandingMicroUsdg']) {
    if (typeof value[field] !== 'string' || !atomicAmountPattern.test(value[field])) return null;
  }
  for (const field of ['heldAssets', 'unattributed', 'unvaluedExposure']) {
    if (typeof value[field] !== 'boolean') return null;
  }
  return deepFreeze({
    realizedLossMicroUsdg: value.realizedLossMicroUsdg,
    atRiskMicroUsdg: value.atRiskMicroUsdg,
    outstandingMicroUsdg: value.outstandingMicroUsdg,
    heldAssets: value.heldAssets,
    unattributed: value.unattributed,
    unvaluedExposure: value.unvaluedExposure,
  });
}

async function readSafetyTelemetry(readCustody) {
  if (readCustody === undefined) return deepFreeze({ available: false, telemetry: null, onChainRemainingCapacity: null });
  let custody;
  try {
    custody = await readCustody();
  } catch {
    return deepFreeze({ available: false, telemetry: null, onChainRemainingCapacity: null });
  }
  const onChainRemainingCapacity = custody?.onChainRemainingCapacity === undefined || custody?.onChainRemainingCapacity === null
    ? null
    : assertTypedAmount(custody.onChainRemainingCapacity, 'operator control on-chain remaining capacity');
  const telemetry = projectPolicyTelemetry(custody);
  return deepFreeze({ available: telemetry !== null, telemetry, onChainRemainingCapacity });
}

function projectLossCap(configuration, telemetry) {
  if (configuration === null || telemetry === null) return null;
  const realized = BigInt(telemetry.realizedLossMicroUsdg);
  const atRisk = BigInt(telemetry.atRiskMicroUsdg);
  const limit = BigInt(configuration.lossCapMicroUsdg);
  return deepFreeze({
    realizedLossMicroUsdg: realized.toString(),
    atRiskMicroUsdg: atRisk.toString(),
    ...projectCapacity(realized + atRisk, limit),
  });
}

function projectOutstandingCustodyCap(configuration, telemetry) {
  if (configuration === null || telemetry === null) return null;
  return projectCapacity(
    BigInt(telemetry.outstandingMicroUsdg),
    BigInt(configuration.maxOutstandingCustodyMicroUsdg),
  );
}

function safetyTelemetryAlerts(available) {
  return available
    ? []
    : [deepFreeze({
      source: 'operator-control',
      code: 'SAFETY_TELEMETRY_UNAVAILABLE',
      severity: 'critical',
      message: 'Required safety telemetry is unavailable',
    })];
}

function hasNewAllowedPack(current, next) {
  const existing = new Set(current.allowedPackIds);
  return next.allowedPackIds.some(packId => !existing.has(packId));
}

function configurationIncreasesExposure(current, next) {
  if (!current.liveMode && next.liveMode) return true;
  if (next.intervalMinutes < current.intervalMinutes || next.requestedOrders > current.requestedOrders
    || next.maxBoostersPerCycle > current.maxBoostersPerCycle || next.maxCyclesPerDay > current.maxCyclesPerDay
    || next.manualApprovalCycles < current.manualApprovalCycles || hasNewAllowedPack(current, next)) {
    return true;
  }
  for (const field of [
    'maxUnitPriceMicroUsdg',
    'maxCycleBudgetMicroUsdg',
    'max24HourBudgetMicroUsdg',
    'perCycleCapMicroUsdg',
    'lossCapMicroUsdg',
    'maxOutstandingCustodyMicroUsdg',
  ]) {
    if (BigInt(next[field]) > BigInt(current[field])) return true;
  }
  return false;
}

async function readStateOrNull(statePath) {
  try {
    return await readOperatorState(statePath);
  } catch (error) {
    if (error?.message === missingStateFileMessage) return null;
    throw error;
  }
}

async function requireExpectedRevision(statePath, expectedRevision) {
  const state = await readStateOrNull(statePath);
  if (state === null ? expectedRevision !== null : expectedRevision !== state.revision) {
    throw new Error('stale operator state revision');
  }
  return state;
}

function recoveryResultCode(result) {
  if (!result || typeof result.status !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(result.status)) {
    throw new Error('operator resume-cycle authority returned an invalid status');
  }
  return `RECOVERY_${result.status}`;
}

export function createOperatorControl({
  statePath,
  cycleRepository,
  policyEngine,
  now = () => Date.now(),
  triggerTick = undefined,
  resumeActiveCycle = undefined,
  readCustody = undefined,
  recordHeldOwnerDecision = undefined,
} = {}) {
  if (typeof statePath !== 'string' || !isAbsolute(statePath)) throw new Error('operator control statePath must be absolute');
  requireRepository(cycleRepository);
  requirePolicyEngine(policyEngine);
  if (typeof now !== 'function') throw new Error('operator control now is required');
  if (triggerTick !== undefined && typeof triggerTick !== 'function') throw new Error('operator control triggerTick must be a function');
  if (resumeActiveCycle !== undefined && typeof resumeActiveCycle !== 'function') throw new Error('operator control resumeActiveCycle must be a function');
  if (readCustody !== undefined && typeof readCustody !== 'function') throw new Error('operator control readCustody must be a function');
  if (recordHeldOwnerDecision !== undefined && typeof recordHeldOwnerDecision !== 'function') {
    throw new Error('operator control recordHeldOwnerDecision must be a function');
  }

  async function status() {
    const timestamp = now();
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw new Error('operator control clock is invalid');
    const state = await readStateOrNull(statePath);
    const activeCycle = activeCycleId(await cycleRepository.peekActiveCycle());
    const knownCycleIds = await cycleRepository.listKnownCycleIds();
    if (!Array.isArray(knownCycleIds) || knownCycleIds.some(cycleId => typeof cycleId !== 'string' || !cycleIdPattern.test(cycleId))) {
      throw new Error('operator control cycleRepository.listKnownCycleIds returned invalid data');
    }
    const cycleIds = [...new Set([
      ...knownCycleIds,
      ...(activeCycle === null ? [] : [activeCycle]),
    ])].sort();
    const cycles = await Promise.all(cycleIds.map(async cycleId => projectCycle(cycleId, await cycleRepository.describeCycle(cycleId))));
    const custodyBuckets = cycles.flatMap(cycle => cycle.custodyBuckets);
    const safetyTelemetry = await readSafetyTelemetry(readCustody);
    return deepFreeze({
      schema: 'hookemon.operator-control-status.v1',
      revision: state?.revision ?? null,
      configuration: state?.configuration === null || state === null ? null : structuredClone(state.configuration),
      activeCycleId: activeCycle,
      cycles,
      cap: {
        offChain24Hour: projectOffChainCap(state?.configuration ?? null, timestamp),
        loss: projectLossCap(state?.configuration ?? null, safetyTelemetry.telemetry),
        outstandingCustody: projectOutstandingCustodyCap(state?.configuration ?? null, safetyTelemetry.telemetry),
        onChainRemainingCapacity: safetyTelemetry.onChainRemainingCapacity,
      },
      custody: { buckets: custodyBuckets },
      alertSources: { safetyTelemetry: safetyTelemetry.available },
      alerts: safetyTelemetryAlerts(safetyTelemetry.available),
    });
  }

  async function mutateConfiguration(expectedRevision, patch) {
    return mutateOperatorState(statePath, expectedRevision, current => {
      const base = current ?? createEmptyOperatorState();
      return { ...base, configuration: applyOperatorConfiguration(base.configuration, patch) };
    });
  }

  async function execute({ expectedRevision, requestId = undefined, command } = {}) {
    const revision = assertExpectedRevision(expectedRevision);
    const normalized = assertCommand(command);
    switch (normalized.type) {
      case 'pause': {
        const state = await mutateConfiguration(revision, { paused: true, executionPaused: true });
        return deepFreeze({ action: 'pause', revision: state.revision, configuration: structuredClone(state.configuration) });
      }
      case 'resume': {
        const safetyTelemetry = await readSafetyTelemetry(readCustody);
        if (!safetyTelemetry.available) throw new Error('operator control safety telemetry is unavailable');
        const state = await mutateConfiguration(revision, { paused: false, executionPaused: false });
        return deepFreeze({ action: 'resume', revision: state.revision, configuration: structuredClone(state.configuration) });
      }
      case 'kill': {
        const state = await mutateConfiguration(revision, { paused: true, executionPaused: true, killSwitch: true });
        return deepFreeze({ action: 'kill', revision: state.revision, configuration: structuredClone(state.configuration) });
      }
      case 'update-configuration': {
        const current = await requireExpectedRevision(statePath, revision);
        const base = current ?? createEmptyOperatorState();
        const next = applyOperatorConfiguration(base.configuration, normalized.configuration);
        if (configurationIncreasesExposure(base.configuration ?? createDefaultOperatorConfiguration(), next)) {
          const safetyTelemetry = await readSafetyTelemetry(readCustody);
          if (!safetyTelemetry.available) throw new Error('operator control safety telemetry is unavailable');
        }
        const state = await mutateConfiguration(revision, normalized.configuration);
        return deepFreeze({ action: 'update-configuration', revision: state.revision, configuration: structuredClone(state.configuration) });
      }
      case 'manual-approval': {
        const safetyTelemetry = await readSafetyTelemetry(readCustody);
        if (!safetyTelemetry.available) throw new Error('operator control safety telemetry is unavailable');
        const approval = await policyEngine.recordManualApproval({
          cycleId: normalized.cycleId,
          cycleDigest: normalized.cycleDigest,
          expectedRevision: revision,
        });
        const state = await readStateOrNull(statePath);
        return deepFreeze({
          action: 'manual-approval',
          revision: state?.revision ?? null,
          approval: structuredClone(approval),
        });
      }
      case 'held-owner-decision': {
        const state = await requireExpectedRevision(statePath, revision);
        if (recordHeldOwnerDecision === undefined) throw new Error('operator held owner decision authority is unavailable');
        const decision = await recordHeldOwnerDecision({
          cycleId: normalized.cycleId,
          heldEvidenceDigest: normalized.heldEvidenceDigest,
          expectedRevision: normalized.expectedCycleRevision,
          requestId: assertRequestId(requestId),
          choice: normalized.choice,
        });
        return deepFreeze({
          action: 'held-owner-decision',
          revision: state?.revision ?? null,
          decision: structuredClone(decision),
        });
      }
      case 'reconcile': {
        await requireExpectedRevision(statePath, revision);
        return deepFreeze({ action: 'reconcile', inspection: await status() });
      }
      case 'resume-cycle': {
        const state = await requireExpectedRevision(statePath, revision);
        if (resumeActiveCycle === undefined) throw new Error('operator resume-cycle authority is unavailable');
        const safetyTelemetry = await readSafetyTelemetry(readCustody);
        if (!safetyTelemetry.available) throw new Error('operator control safety telemetry is unavailable');
        const result = await resumeActiveCycle();
        return deepFreeze({
          action: 'resume-cycle',
          resultCode: recoveryResultCode(result),
          result: structuredClone(result),
          revision: state?.revision ?? null,
        });
      }
      case 'run-cycle-now': {
        const state = await requireExpectedRevision(statePath, revision);
        if (triggerTick === undefined) throw new Error('operator run-cycle-now authority is unavailable');
        const safetyTelemetry = await readSafetyTelemetry(readCustody);
        if (!safetyTelemetry.available) throw new Error('operator control safety telemetry is unavailable');
        const result = await triggerTick();
        return deepFreeze({
          action: 'run-cycle-now',
          resultCode: 'TICK_TRIGGERED',
          result: structuredClone(result),
          revision: state?.revision ?? null,
        });
      }
      default:
        throw new Error('operator control command type is invalid');
    }
  }

  return Object.freeze({ status, execute });
}
