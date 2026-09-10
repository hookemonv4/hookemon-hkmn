import { REWARD_RECIPIENT_LIMITS, assertRewardRecipientLimit } from '../../../runner/src/config/reward-recipient-selection.mjs';
import { assertPackPlan, PACK_PLAN_SCHEMA } from '../../../runner/src/config/pack-plan.mjs';
import { nativeFieldName, nativeValidationSkeleton, requireNativeRound } from './native-accounting.mjs';
// Clean-room re-implementation of the private /operator/api/* contracts (readSet:
// apps/web/app/operator/OperatorControlPanel.tsx, operator-types.ts and the coordinator's own
// "CONTRACT FACTS extracted from the website source" note on this package's work order). These
// validators reproduce the exact key sets the website's `decodeBootstrap`/`decodeDashboard`/audit and
// card-history readers require, adapted for this service's actual configuration model
// (packages/runner/src/config/state-schema.mjs). Recipient options come from the runner's
// shared policy; active-cycle limits come from persisted cycle snapshots.
import {
  boundedArray,
  boundedText,
  ContractValidationError,
  exactKeys,
  invalidWith,
  isoTimestamp,
  money,
  nullableAmount,
  nullableMoney,
  nullableText,
  optionalTimestamp,
  requiredKeys,
  requiredRecord,
} from './primitives.mjs';

const invalid = invalidWith('OPERATOR_CONTRACT_INVALID');

export const DECISION_TYPES = Object.freeze([
  'pause',
  'resume',
  'kill',
  'manual-approval',
  'held-owner-decision',
  'retry-refused-payout',
  'run-cycle-now',
  'resume-cycle',
  'reconcile',
  'update-configuration',
]);

const DECISION_ENVELOPE_KEYS = new Set(['requestId', 'expectedVersion', 'command', 'note']);
const DECISION_ENVELOPE_REQUIRED = ['requestId', 'expectedVersion', 'command'];
const UPDATE_CONFIGURATION_KEYS = new Set([
  'intervalMinutes', 'allowedPackIds', 'requestedOrders', 'maxBoostersPerCycle',
  'maxUnitPriceMicroUsd', 'maxCycleBudgetMicroUsd', 'max24HourBudgetMicroUsd', 'liveMode',
  'maxCyclesPerDay', 'perCycleCapMicroUsd', 'lossCapMicroUsd', 'maxOutstandingCustodyMicroUsd',
  'manualApprovalCycles', 'packPlan', 'rewardRecipientLimit',
]);
const runnerCycleIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const packCodePattern = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const microUsdPattern = /^(0|[1-9][0-9]*)$/;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const cycleDigestPattern = /^sha256:[0-9a-f]{64}$/;
const commandAliases = Object.freeze({
  activate: 'resume',
  'restart-request': 'resume-cycle',
  'reconcile-request': 'reconcile',
});

/**
 * Validate the JSON body of `POST /operator/api/decisions`. Returns `{ requestId, expectedVersion,
 * command: { type, configuration? }, note }`. Throws `ContractValidationError` on any shape
 * violation; never partially trusts a malformed payload.
 */
export function readDecisionRequest(value) {
  const source = requiredRecord(value, invalid);
  exactKeys(source, DECISION_ENVELOPE_KEYS, invalid);
  requiredKeys(source, DECISION_ENVELOPE_REQUIRED, invalid);
  if (typeof source.requestId !== 'string' || !requestIdPattern.test(source.requestId)) invalid();
  if (source.expectedVersion !== null && (!Number.isSafeInteger(source.expectedVersion) || source.expectedVersion < 0)) invalid();
  const command = readCommand(source.command);
  const note = source.note === undefined ? null : boundedText(source.note, invalid);
  return { requestId: source.requestId, expectedVersion: source.expectedVersion, command, note };
}

function readCommand(value) {
  const source = requiredRecord(value, invalid);
  if (typeof source.type !== 'string') invalid();
  const type = commandAliases[source.type] ?? source.type;
  if (!DECISION_TYPES.includes(type)) invalid();
  if (type === 'update-configuration') {
    exactKeys(source, new Set(['type', 'configuration']), invalid);
    requiredKeys(source, ['type', 'configuration'], invalid);
    return { type, configuration: readConfigurationPatch(source.configuration) };
  }
  if (type === 'manual-approval') {
    exactKeys(source, new Set(['type', 'cycleId', 'cycleDigest']), invalid);
    requiredKeys(source, ['type', 'cycleId', 'cycleDigest'], invalid);
    if (typeof source.cycleId !== 'string' || !runnerCycleIdPattern.test(source.cycleId)) invalid();
    if (typeof source.cycleDigest !== 'string' || !cycleDigestPattern.test(source.cycleDigest)) invalid();
    return { type, cycleId: source.cycleId, cycleDigest: source.cycleDigest };
  }
  if (type === 'held-owner-decision') {
    exactKeys(source, new Set(['type', 'positionId', 'heldEvidenceDigest', 'expectedPositionRevision', 'choice']), invalid);
    requiredKeys(source, ['type', 'positionId', 'heldEvidenceDigest', 'expectedPositionRevision', 'choice'], invalid);
    if (typeof source.positionId !== 'string' || !/^held:[0-9a-f]{64}$/.test(source.positionId)) invalid();
    if (typeof source.heldEvidenceDigest !== 'string' || !cycleDigestPattern.test(source.heldEvidenceDigest)) invalid();
    if (!Number.isSafeInteger(source.expectedPositionRevision) || source.expectedPositionRevision < 0) invalid();
    if (source.choice !== 'sell' && source.choice !== 'keep-holding') invalid();
    return {
      type,
      positionId: source.positionId,
      heldEvidenceDigest: source.heldEvidenceDigest,
      expectedPositionRevision: source.expectedPositionRevision,
      choice: source.choice,
    };
  }
  if (type === 'retry-refused-payout') {
    exactKeys(source, new Set([
      'type', 'cycleId', 'planDigest', 'recipient', 'amountAtomic', 'originalTransactionHash',
    ]), invalid);
    requiredKeys(source, ['type', 'cycleId', 'planDigest', 'recipient', 'amountAtomic', 'originalTransactionHash'], invalid);
    if (typeof source.cycleId !== 'string' || !runnerCycleIdPattern.test(source.cycleId)
      || typeof source.planDigest !== 'string' || !cycleDigestPattern.test(source.planDigest)
      || typeof source.recipient !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(source.recipient)
      || typeof source.amountAtomic !== 'string' || !/^[1-9][0-9]*$/.test(source.amountAtomic)
      || typeof source.originalTransactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(source.originalTransactionHash)) invalid();
    return {
      type,
      cycleId: source.cycleId,
      planDigest: source.planDigest,
      recipient: source.recipient.toLowerCase(),
      amountAtomic: source.amountAtomic,
      originalTransactionHash: source.originalTransactionHash.toLowerCase(),
    };
  }
  exactKeys(source, new Set(['type']), invalid);
  return { type };
}

function readConfigurationPatch(value) {
  const source = requiredRecord(value, invalid);
  for (const key of Object.keys(source)) {
    if (!UPDATE_CONFIGURATION_KEYS.has(key)) invalid();
  }
  const patch = {};
  if (Object.hasOwn(source, 'rewardRecipientLimit')) {
    try { patch.rewardRecipientLimit = assertRewardRecipientLimit(source.rewardRecipientLimit); } catch { invalid(); }
  }
  if (Object.hasOwn(source, 'intervalMinutes')) {
    if (!Number.isInteger(source.intervalMinutes) || source.intervalMinutes < 5 || source.intervalMinutes > 1440) invalid();
    patch.intervalMinutes = source.intervalMinutes;
  }
  if (Object.hasOwn(source, 'allowedPackIds')) {
    const ids = boundedArray(source.allowedPackIds, 10_000, invalid);
    let previous = null;
    for (const id of ids) {
      if (typeof id !== 'string' || !packCodePattern.test(id)) invalid();
      if (previous !== null && id <= previous) invalid();
      previous = id;
    }
    patch.allowedPackIds = [...ids];
  }
  if (Object.hasOwn(source, 'packPlan')) {
    const plan = requiredRecord(source.packPlan, invalid);
    exactKeys(plan, new Set(['orders']), invalid);
    requiredKeys(plan, ['orders'], invalid);
    try {
      patch.packPlan = { orders: assertPackPlan({ schema: PACK_PLAN_SCHEMA, revision: 0, orders: plan.orders }).orders };
    } catch { invalid(); }
  }
  if (Object.hasOwn(source, 'requestedOrders')) {
    if (!Number.isInteger(source.requestedOrders) || source.requestedOrders < 0) invalid();
    patch.requestedOrders = source.requestedOrders;
  }
  if (Object.hasOwn(source, 'maxBoostersPerCycle')) {
    if (!Number.isInteger(source.maxBoostersPerCycle) || source.maxBoostersPerCycle < 1 || source.maxBoostersPerCycle > 1000) invalid();
    patch.maxBoostersPerCycle = source.maxBoostersPerCycle;
  }
  for (const key of [
    'maxUnitPriceMicroUsd', 'maxCycleBudgetMicroUsd', 'max24HourBudgetMicroUsd',
    'perCycleCapMicroUsd', 'lossCapMicroUsd', 'maxOutstandingCustodyMicroUsd',
  ]) {
    if (Object.hasOwn(source, key)) {
      if (typeof source[key] !== 'string' || !microUsdPattern.test(source[key])) invalid();
      patch[key] = source[key];
    }
  }
  if (Object.hasOwn(source, 'liveMode')) {
    if (typeof source.liveMode !== 'boolean') invalid();
    patch.liveMode = source.liveMode;
  }
  for (const key of ['maxCyclesPerDay', 'manualApprovalCycles']) {
    if (Object.hasOwn(source, key)) {
      if (!Number.isSafeInteger(source[key]) || source[key] < 0) invalid();
      patch[key] = source[key];
    }
  }
  if (Object.keys(patch).length === 0) invalid();
  return patch;
}

// ---------------------------------------------------------------------------------------------
// Read-model shapes (bootstrap / dashboard / cards / audit). These are exact-key contracts this
// service's own routes must produce; there is no client here to decode them (the legacy website's
// decodeBootstrap/decodeDashboard is the eventual consumer, ported for WP-18), so `assertBootstrap`
// etc. exist purely so this package's own tests can assert byte-exact shape discipline the same way
// the website would.
const BOOTSTRAP_KEYS = new Set([
  'identity', 'state', 'hardCaps', 'catalog', 'readiness', 'executionConnected', 'rewardRecipientLimits',
]);
const IDENTITY_KEYS = new Set(['subject', 'email', 'role']);
const OPERATOR_STATE_KEYS = new Set([
  'version', 'desiredStatus', 'allowedPackIds', 'requestedOrders', 'intervalMinutes', 'manualPackOrders', 'maxBoostersPerCycle',
  'rewardRecipientLimit', 'cycleIntervalMinutes', 'skipNextCycleSequence', 'runNowSequence',
  'maxUnitPriceMicroUsd', 'maxCycleBudgetMicroUsd', 'max24HourBudgetMicroUsd',
  'configurationComplete', 'executionConnected', 'liveMode',
]);
const HARD_CAPS_KEYS = new Set(['maxBoostersPerCycle', 'maxUnitPriceMicroUsd', 'maxCycleBudgetMicroUsd', 'max24HourBudgetMicroUsd']);
const READINESS_KEYS = new Set(['ready', 'reasons']);
const CATALOG_STATUSES = new Set(['LOADED', 'STALE', 'UNAVAILABLE', 'NOT_CONFIGURED']);
const CATALOG_PACK_KEYS = new Set(['id', 'name', 'priceMicroStablecoin', 'available']);

export function assertBootstrap(value) {
  const source = requiredRecord(value, invalid);
  exactKeys(source, BOOTSTRAP_KEYS, invalid);
  requiredKeys(source, BOOTSTRAP_KEYS, invalid);
  const identity = requiredRecord(source.identity, invalid);
  exactKeys(identity, IDENTITY_KEYS, invalid);
  requiredKeys(identity, IDENTITY_KEYS, invalid);
  if (identity.role !== 'viewer' && identity.role !== 'operator') invalid();
  const state = requiredRecord(source.state, invalid);
  // Older bootstrap payloads omit packPlan; when present its versioned contract is strict.
  exactKeys(state, Object.hasOwn(state, 'packPlan') ? new Set([...OPERATOR_STATE_KEYS, 'packPlan']) : OPERATOR_STATE_KEYS, invalid);
  if (Object.hasOwn(state, 'packPlan')) {
    try { assertPackPlan(state.packPlan); } catch { invalid(); }
  }
  requiredKeys(state, OPERATOR_STATE_KEYS, invalid);
  if (typeof state.liveMode !== 'boolean') invalid();
  const hardCaps = requiredRecord(source.hardCaps, invalid);
  exactKeys(hardCaps, HARD_CAPS_KEYS, invalid);
  requiredKeys(hardCaps, HARD_CAPS_KEYS, invalid);
  for (const key of Object.keys(hardCaps)) money(hardCaps[key], invalid);
  const readiness = requiredRecord(source.readiness, invalid);
  exactKeys(readiness, READINESS_KEYS, invalid);
  requiredKeys(readiness, READINESS_KEYS, invalid);
  if (typeof readiness.ready !== 'boolean') invalid();
  boundedArray(readiness.reasons, 128, invalid).forEach(reason => boundedText(reason, invalid));
  if (typeof source.executionConnected !== 'boolean') invalid();
  if (JSON.stringify(source.rewardRecipientLimits) !== JSON.stringify(REWARD_RECIPIENT_LIMITS)) invalid();
  if (state.rewardRecipientLimit !== null) { try { assertRewardRecipientLimit(state.rewardRecipientLimit); } catch { invalid(); } }
  if (source.catalog !== null) {
    const catalog = requiredRecord(source.catalog, invalid);
    exactKeys(catalog, new Set(['status', 'fetchedAtMs', 'packs']), invalid);
    requiredKeys(catalog, ['status', 'fetchedAtMs', 'packs'], invalid);
    boundedText(catalog.status, invalid);
    if (!CATALOG_STATUSES.has(catalog.status)) invalid();
    if (!Number.isSafeInteger(catalog.fetchedAtMs) || catalog.fetchedAtMs < 0) invalid();
    boundedArray(catalog.packs, 10_000, invalid).forEach(pack => {
      const record = requiredRecord(pack, invalid);
      exactKeys(record, CATALOG_PACK_KEYS, invalid);
      requiredKeys(record, CATALOG_PACK_KEYS, invalid);
      boundedText(record.id, invalid);
      boundedText(record.name, invalid);
      if (typeof record.priceMicroStablecoin !== 'string' || !microUsdPattern.test(record.priceMicroStablecoin)) invalid();
      if (record.available !== null
        && (!Number.isSafeInteger(record.available) || record.available < 0)) invalid();
    });
  }
  return source;
}

const CARDS_RESPONSE_KEYS = new Set(['cards', 'nextCursor', 'historyComplete']);
const HISTORY_CARD_KEYS = new Set([
  'cycleId', 'productId', 'rarity', 'nftAddress', 'cardName', 'setName', 'cardNumber', 'imageUrl',
  'packPriceMicroUsdg', 'buybackMicroUsdg', 'packIndex', 'observedAt',
]);

export function assertCardsResponse(value) {
  const source = requiredRecord(value, invalid);
  exactKeys(source, CARDS_RESPONSE_KEYS, invalid);
  requiredKeys(source, CARDS_RESPONSE_KEYS, invalid);
  boundedArray(source.cards, 50, invalid).forEach(card => {
    const record = requiredRecord(card, invalid);
    exactKeys(record, HISTORY_CARD_KEYS, invalid);
    requiredKeys(record, HISTORY_CARD_KEYS, invalid);
    boundedText(record.cycleId, invalid);
    boundedText(record.productId, invalid);
    boundedText(record.rarity, invalid);
    nullableText(record.nftAddress, invalid);
    nullableText(record.cardName, invalid);
    nullableText(record.setName, invalid);
    nullableText(record.cardNumber, invalid);
    nullableText(record.imageUrl, invalid);
    nullableMoney(record.packPriceMicroUsdg, invalid);
    nullableMoney(record.buybackMicroUsdg, invalid);
    if (!Number.isSafeInteger(record.packIndex) || record.packIndex < 0) invalid();
    isoTimestamp(record.observedAt, invalid);
  });
  if (source.nextCursor !== null) boundedText(source.nextCursor, invalid);
  if (typeof source.historyComplete !== 'boolean') invalid();
  return source;
}

const AUDIT_RESPONSE_KEYS = new Set(['decisions', 'nextCursor']);
const AUDIT_ENTRY_KEYS = new Set([
  'sequence', 'eventId', 'occurredAt', 'actor', 'actorRole', 'action', 'outcome', 'resultCode',
  'observedVersion', 'note', 'requestId', 'commandDigest',
]);

export function assertAuditResponse(value) {
  const source = requiredRecord(value, invalid);
  exactKeys(source, AUDIT_RESPONSE_KEYS, invalid);
  requiredKeys(source, AUDIT_RESPONSE_KEYS, invalid);
  boundedArray(source.decisions, 100, invalid).forEach(entry => {
    const record = requiredRecord(entry, invalid);
    exactKeys(record, AUDIT_ENTRY_KEYS, invalid);
    requiredKeys(record, AUDIT_ENTRY_KEYS, invalid);
    boundedText(record.sequence, invalid);
    boundedText(record.eventId, invalid);
    isoTimestamp(record.occurredAt, invalid);
    const actor = requiredRecord(record.actor, invalid);
    exactKeys(actor, new Set(['email']), invalid);
    boundedText(actor.email, invalid);
    if (record.actorRole !== 'viewer' && record.actorRole !== 'operator') invalid();
    boundedText(record.action, invalid);
    if (record.outcome !== 'accepted' && record.outcome !== 'rejected') invalid();
    boundedText(record.resultCode, invalid);
    if (!Number.isSafeInteger(record.observedVersion) || record.observedVersion < 0) invalid();
    if (record.note !== null) boundedText(record.note, invalid);
    nullableText(record.requestId, invalid);
    nullableText(record.commandDigest, invalid);
  });
  if (source.nextCursor !== null) boundedText(source.nextCursor, invalid);
  return source;
}

const DASHBOARD_KEYS = new Set([
  'schemaVersion', 'historyComplete', 'cardHistoryComplete', 'generatedAt', 'nextCycleAt',
  'cycleIntervalMinutes', 'execution', 'cycleStartProjectPoolObservedAt', 'latestCompletedAllocationCycleId',
  'metrics', 'latestCycleTopAllocations', 'cards', 'activeCycle', 'latestCycle', 'cycles',
  'cap', 'custody', 'alerts', 'payoutStatus',
]);
const DASHBOARD_V6_KEYS = new Set([...DASHBOARD_KEYS, 'alertSources']);
const DASHBOARD_V8_KEYS = new Set([
  ...DASHBOARD_KEYS,
  'completeness',
  'alertSources',
  'activeCycleId',
  'pendingReason',
  'heldPositions',
  'manualApprovals',
]);
const DASHBOARD_METRICS_KEYS = new Set([
  'cycleStartProjectPoolMicroUsdg', 'totalCycleFundingMicroUsdg', 'totalCollectorSpendMicroUsdg',
  'totalBuybacksReturnedMicroUsdg', 'totalBridgedBackMicroUsdg', 'totalRewardsPaidMicroUsdg',
  'totalRewardsDeferredMicroUsdg', 'totalQuotedOperatingCostsMicroUsdg', 'latestRetainedReserveMicroUsdg',
  'latestCycleReserveTargetMicroUsdg', 'completedCycles', 'skippedCycles', 'openedPacks',
]);
const DASHBOARD_NATIVE_METRICS_KEYS = new Set([
  ...[...DASHBOARD_METRICS_KEYS]
    .filter(key => key.endsWith('MicroUsdg'))
    .map(nativeFieldName),
  'completedCycles', 'skippedCycles', 'openedPacks',
]);
const ACTIVE_CYCLE_HISTORICAL_KEYS = new Set([
  'cycleId', 'status', 'updatedAt', 'configurationRevision', 'allowedPackIds', 'requestedOrders',
  'maxBoostersPerCycle', 'maxUnitPriceMicroUsdg', 'maxCycleBudgetMicroUsdg', 'max24HourBudgetMicroUsdg',
  'revealedCards', 'rewardRecipientLimit',
]);
const ACTIVE_CYCLE_NATIVE_KEYS = new Set([
  'cycleId', 'status', 'updatedAt', 'configurationRevision', 'allowedPackIds', 'requestedOrders',
  'maxBoostersPerCycle', 'maxUnitPriceMicroUsd', 'maxCycleBudgetMicroUsd', 'max24HourBudgetMicroUsd',
  'revealedCards', 'rewardRecipientLimit',
]);
const DASHBOARD_LATEST_CYCLE_KEYS = new Set([
  'cycleId', 'status', 'reason', 'updatedAt', 'payoutRecipientCount', 'rewardRecipientLimit',
  'selectedCount', 'paidCount', 'deferredCount', 'roundAccounting', 'transactions',
]);
const DASHBOARD_NATIVE_LATEST_CYCLE_KEYS = new Set([...DASHBOARD_LATEST_CYCLE_KEYS, 'paidWei']);
const DASHBOARD_HISTORICAL_LATEST_CYCLE_KEYS = new Set([...DASHBOARD_LATEST_CYCLE_KEYS, 'paidMicroUsdg']);
const HELD_OWNER_DECISION_KEYS = new Set([
  'positionId', 'heldEvidenceDigest', 'requestId', 'expectedRevision', 'choice',
]);

function assertHeldOwnerDecision(value) {
  const decision = requiredRecord(value, invalid);
  exactKeys(decision, HELD_OWNER_DECISION_KEYS, invalid);
  requiredKeys(decision, [...HELD_OWNER_DECISION_KEYS], invalid);
  if (typeof decision.positionId !== 'string' || !/^held:[0-9a-f]{64}$/.test(decision.positionId)) invalid();
  if (typeof decision.heldEvidenceDigest !== 'string' || !cycleDigestPattern.test(decision.heldEvidenceDigest)) invalid();
  if (typeof decision.requestId !== 'string' || !requestIdPattern.test(decision.requestId)) invalid();
  if (!Number.isSafeInteger(decision.expectedRevision) || decision.expectedRevision < 0) invalid();
  if (decision.choice !== 'sell' && decision.choice !== 'keep-holding') invalid();
}

function assertHeldPositions(value) {
  if (value === null) return;
  boundedArray(value, 10_000, invalid).forEach(position => {
    const record = requiredRecord(position, invalid);
    exactKeys(record, new Set([
      'positionId', 'cycleId', 'costMicroUsd', 'insuredValue', 'reason',
      'terminalState', 'evidenceDigest', 'openedAt', 'positionRevision', 'ownerDecision',
    ]), invalid);
    requiredKeys(record, [
      'positionId', 'cycleId', 'costMicroUsd', 'insuredValue', 'reason',
      'terminalState', 'evidenceDigest', 'openedAt', 'positionRevision', 'ownerDecision',
    ], invalid);
    if (typeof record.positionId !== 'string' || !/^held:[0-9a-f]{64}$/.test(record.positionId)) invalid();
    boundedText(record.cycleId, invalid);
    money(record.costMicroUsd, invalid);
    nullableAmount(record.insuredValue, invalid);
    boundedText(record.reason, invalid);
    boundedText(record.terminalState, invalid);
    if (typeof record.evidenceDigest !== 'string' || !cycleDigestPattern.test(record.evidenceDigest)) invalid();
    isoTimestamp(record.openedAt, invalid);
    if (!Number.isSafeInteger(record.positionRevision) || record.positionRevision < 0) invalid();
    if (record.ownerDecision !== null) assertHeldOwnerDecision(record.ownerDecision);
  });
}

function assertManualApprovals(value) {
  if (value === null) return;
  boundedArray(value, 10_000, invalid).forEach(approval => {
    const record = requiredRecord(approval, invalid);
    exactKeys(record, new Set([
      'cycleId', 'cycleDigest', 'mode', 'ordinal', 'releaseCostMicroUsd',
      'openedAt', 'approved', 'approvedAt',
    ]), invalid);
    requiredKeys(record, [
      'cycleId', 'cycleDigest', 'mode', 'ordinal', 'releaseCostMicroUsd',
      'openedAt', 'approved', 'approvedAt',
    ], invalid);
    boundedText(record.cycleId, invalid);
    if (typeof record.cycleDigest !== 'string' || !cycleDigestPattern.test(record.cycleDigest)) invalid();
    if (record.mode !== 'production' && record.mode !== 'rehearsal') invalid();
    if (!Number.isSafeInteger(record.ordinal) || record.ordinal < 1) invalid();
    money(record.releaseCostMicroUsd, invalid);
    isoTimestamp(record.openedAt, invalid);
    if (typeof record.approved !== 'boolean') invalid();
    if (record.approvedAt !== null) isoTimestamp(record.approvedAt, invalid);
  });
}

/** Validate `/operator/api/dashboard`'s response shape (readSet: apps/web/app/operator/
 * OperatorControlPanel.tsx's `Dashboard` type / `decodeDashboard`). Only checks key sets and basic
 * scalar types — the richer cross-field invariants (`decodeActiveCycle`'s total-vs-cap check, the
 * exclusive gain/loss pair, etc.) live in the public contract ports this dashboard shares data with
 * (contracts/public-cycle-status.mjs) and are not duplicated here. */
export function assertDashboardResponse(value) {
  if (value?.schemaVersion === 7) {
    requireNativeRound(value.latestCycle?.roundAccounting ?? null);
    const skeleton = nativeValidationSkeleton(value);
    skeleton.schemaVersion = 6;
    // Historical private aggregates were non-nullable; these zeroes exist only in shape validation.
    for (const key of Object.keys(skeleton.metrics ?? {})) {
      if (key.endsWith('MicroUsdg') && key !== 'cycleStartProjectPoolMicroUsdg') skeleton.metrics[key] = '0';
    }
    assertDashboardResponse(skeleton);
    return value;
  }

  const source = requiredRecord(value, invalid);
  if (![1, 2, 3, 4, 5, 6, 8].includes(source.schemaVersion)) invalid();
  const dashboardKeys = source.schemaVersion === 8
    ? DASHBOARD_V8_KEYS
    : source.schemaVersion === 6 ? DASHBOARD_V6_KEYS : DASHBOARD_KEYS;
  exactKeys(source, dashboardKeys, invalid);
  requiredKeys(source, dashboardKeys, invalid);
  if (typeof source.historyComplete !== 'boolean' || typeof source.cardHistoryComplete !== 'boolean') invalid();
  isoTimestamp(source.generatedAt, invalid);
  optionalTimestamp(source.nextCycleAt, invalid);
  if (!Number.isSafeInteger(source.cycleIntervalMinutes) || source.cycleIntervalMinutes < 5) invalid();
  const execution = requiredRecord(source.execution, invalid);
  exactKeys(execution, new Set(['connected', 'lastHeartbeatAt']), invalid);
  if (typeof execution.connected !== 'boolean') invalid();
  optionalTimestamp(execution.lastHeartbeatAt, invalid);
  if (source.cycleStartProjectPoolObservedAt !== null) isoTimestamp(source.cycleStartProjectPoolObservedAt, invalid);
  if (source.latestCompletedAllocationCycleId !== null) boundedText(source.latestCompletedAllocationCycleId, invalid);
  const metrics = requiredRecord(source.metrics, invalid);
  const native = source.latestCycle?.roundAccounting?.schema === 'hookemon.native-round-accounting.v1';
  if (native) requireNativeRound(source.latestCycle.roundAccounting);
  const metricKeys = native ? DASHBOARD_NATIVE_METRICS_KEYS : DASHBOARD_METRICS_KEYS;
  exactKeys(metrics, metricKeys, invalid);
  requiredKeys(metrics, metricKeys, invalid);
  const nullableMetricFields = source.schemaVersion === 8
    ? [...metricKeys].filter(key => key.endsWith('MicroUsdg') || key.endsWith('MicroUsd') || key.endsWith('Wei') || ['skippedCycles', 'openedPacks'].includes(key))
    : [];
  for (const key of nullableMetricFields) {
    if (metrics[key] !== null) {
      if (key.endsWith('MicroUsdg') || key.endsWith('MicroUsd') || key.endsWith('Wei')) money(metrics[key], invalid);
      else if (!Number.isSafeInteger(metrics[key]) || metrics[key] < 0) invalid();
    }
  }
  if (source.schemaVersion === 8) {
    const completeness = requiredRecord(source.completeness, invalid);
    if (!Number.isSafeInteger(completeness.cyclesScanned) || completeness.cyclesScanned < 0) invalid();
    for (const [key, value] of Object.entries(completeness)) {
      if (key !== 'cyclesScanned' && typeof value !== 'boolean') invalid();
    }
    if (source.activeCycleId !== null) boundedText(source.activeCycleId, invalid);
    if (source.pendingReason !== null) boundedText(source.pendingReason, invalid);
    assertHeldPositions(source.heldPositions);
    assertManualApprovals(source.manualApprovals);
    if (typeof completeness.heldPositions !== 'boolean' || typeof completeness.manualApprovals !== 'boolean') invalid();
  }
  boundedArray(source.latestCycleTopAllocations, 200, invalid).forEach(allocation => {
    const value = requiredRecord(allocation, invalid);
    const amountKey = native ? 'allocatedWei' : 'allocatedMicroUsdg';
    exactKeys(value, new Set(['rank', 'address', amountKey]), invalid);
    requiredKeys(value, ['rank', 'address', amountKey], invalid);
    if (!Number.isSafeInteger(value.rank) || value.rank < 1) invalid();
    boundedText(value.address, invalid);
    money(value[amountKey], invalid);
  });
  boundedArray(source.cards, 60, invalid);
  if (source.activeCycle !== null) {
    const activeCycle = requiredRecord(source.activeCycle, invalid);
    const nativeActiveCycle = Object.hasOwn(activeCycle, 'maxUnitPriceMicroUsd');
    const activeCycleKeys = nativeActiveCycle ? ACTIVE_CYCLE_NATIVE_KEYS : ACTIVE_CYCLE_HISTORICAL_KEYS;
    exactKeys(activeCycle, activeCycleKeys, invalid);
    requiredKeys(activeCycle, activeCycleKeys, invalid);
    boundedText(activeCycle.cycleId, invalid);
    boundedText(activeCycle.status, invalid);
  }
  if (source.latestCycle !== null) {
    const latestCycle = requiredRecord(source.latestCycle, invalid);
    const latestKeys = native ? DASHBOARD_NATIVE_LATEST_CYCLE_KEYS : DASHBOARD_HISTORICAL_LATEST_CYCLE_KEYS;
    exactKeys(latestCycle, latestKeys, invalid);
    requiredKeys(latestCycle, latestKeys, invalid);
    boundedText(latestCycle.cycleId, invalid);
    boundedText(latestCycle.status, invalid);
  }
  boundedArray(source.cycles, 10_000, invalid).forEach(cycle => requiredRecord(cycle, invalid));
  const cap = requiredRecord(source.cap, invalid);
  const capKeys = source.schemaVersion === 6
    ? new Set(['offChain24Hour', 'loss', 'outstandingCustody', 'onChainRemainingCapacity'])
    : new Set(['offChain24Hour', 'onChainRemainingCapacity']);
  exactKeys(cap, capKeys, invalid);
  requiredKeys(cap, [...capKeys], invalid);
  if (cap.offChain24Hour !== null) {
    const offChain = requiredRecord(cap.offChain24Hour, invalid);
    const capFields = source.schemaVersion === 8
      ? ['usedMicroUsd', 'limitMicroUsd', 'remainingMicroUsd']
      : ['usedMicroUsdg', 'limitMicroUsdg', 'remainingMicroUsdg'];
    exactKeys(offChain, new Set(capFields), invalid);
    requiredKeys(offChain, capFields, invalid);
    for (const field of capFields) money(offChain[field], invalid);
  }
  if (source.schemaVersion === 6 && cap.loss !== null) {
    const loss = requiredRecord(cap.loss, invalid);
    exactKeys(loss, new Set(['realizedLossMicroUsdg', 'atRiskMicroUsdg', 'usedMicroUsdg', 'limitMicroUsdg', 'remainingMicroUsdg']), invalid);
    requiredKeys(loss, ['realizedLossMicroUsdg', 'atRiskMicroUsdg', 'usedMicroUsdg', 'limitMicroUsdg', 'remainingMicroUsdg'], invalid);
    for (const field of ['realizedLossMicroUsdg', 'atRiskMicroUsdg', 'usedMicroUsdg', 'limitMicroUsdg', 'remainingMicroUsdg']) {
      money(loss[field], invalid);
    }
  }
  if (source.schemaVersion === 6 && cap.outstandingCustody !== null) {
    const outstanding = requiredRecord(cap.outstandingCustody, invalid);
    exactKeys(outstanding, new Set(['usedMicroUsdg', 'limitMicroUsdg', 'remainingMicroUsdg']), invalid);
    requiredKeys(outstanding, ['usedMicroUsdg', 'limitMicroUsdg', 'remainingMicroUsdg'], invalid);
    for (const field of ['usedMicroUsdg', 'limitMicroUsdg', 'remainingMicroUsdg']) money(outstanding[field], invalid);
  }
  if (cap.onChainRemainingCapacity !== null) requiredRecord(cap.onChainRemainingCapacity, invalid);
  const custody = requiredRecord(source.custody, invalid);
  exactKeys(custody, new Set(['buckets']), invalid);
  requiredKeys(custody, ['buckets'], invalid);
  boundedArray(custody.buckets, 10_000, invalid).forEach(bucket => requiredRecord(bucket, invalid));
  if (source.schemaVersion === 6) {
    const alertSources = requiredRecord(source.alertSources, invalid);
    exactKeys(alertSources, new Set(['safetyTelemetry']), invalid);
    if (typeof alertSources.safetyTelemetry !== 'boolean') invalid();
  }
  boundedArray(source.alerts, 10_000, invalid);
  if (source.payoutStatus !== null) {
    const payout = requiredRecord(source.payoutStatus, invalid);
    exactKeys(payout, new Set(['status', 'transactionIds']), invalid);
    requiredKeys(payout, ['status', 'transactionIds'], invalid);
    boundedText(payout.status, invalid);
    if (payout.transactionIds !== null) boundedArray(payout.transactionIds, 100, invalid);
  }
  return source;
}

export { ContractValidationError };
