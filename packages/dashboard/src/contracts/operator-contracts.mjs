// Clean-room re-implementation of the private /operator/api/* contracts (readSet:
// apps/web/app/operator/OperatorControlPanel.tsx, operator-types.ts and the coordinator's own
// "CONTRACT FACTS extracted from the website source" note on this package's work order). These
// validators reproduce the exact key sets the website's `decodeBootstrap`/`decodeDashboard`/audit and
// card-history readers require, adapted for this service's actual configuration model
// (packages/runner/src/config/state-schema.mjs) rather than the legacy site's richer
// mode/communityPackIds/rewardRecipientLimit model, which nothing in this integration head
// implements — see docs/modules/dashboard.md's "Known contract gaps" section.
import {
  boundedArray,
  boundedText,
  ContractValidationError,
  exactKeys,
  invalidWith,
  isoTimestamp,
  money,
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
  'run-cycle-now',
  'resume-cycle',
  'reconcile',
  'update-configuration',
]);

const DECISION_ENVELOPE_KEYS = new Set(['requestId', 'expectedVersion', 'command', 'note']);
const DECISION_ENVELOPE_REQUIRED = ['requestId', 'expectedVersion', 'command'];
const UPDATE_CONFIGURATION_KEYS = new Set([
  'intervalMinutes', 'allowedPackIds', 'requestedOrders', 'maxBoostersPerCycle',
  'maxUnitPriceMicroUsdg', 'maxCycleBudgetMicroUsdg', 'max24HourBudgetMicroUsdg', 'liveMode',
  'maxCyclesPerDay', 'perCycleCapMicroUsdg', 'lossCapMicroUsdg', 'maxOutstandingCustodyMicroUsdg',
  'manualApprovalCycles',
]);
const runnerCycleIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
const packCodePattern = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const microUsdgPattern = /^(0|[1-9][0-9]*)$/;
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
    exactKeys(source, new Set(['type', 'cycleId', 'heldEvidenceDigest', 'expectedCycleRevision', 'choice']), invalid);
    requiredKeys(source, ['type', 'cycleId', 'heldEvidenceDigest', 'expectedCycleRevision', 'choice'], invalid);
    if (typeof source.cycleId !== 'string' || !runnerCycleIdPattern.test(source.cycleId)) invalid();
    if (typeof source.heldEvidenceDigest !== 'string' || !cycleDigestPattern.test(source.heldEvidenceDigest)) invalid();
    if (!Number.isSafeInteger(source.expectedCycleRevision) || source.expectedCycleRevision < 0) invalid();
    if (source.choice !== 'sell' && source.choice !== 'keep-holding') invalid();
    return {
      type,
      cycleId: source.cycleId,
      heldEvidenceDigest: source.heldEvidenceDigest,
      expectedCycleRevision: source.expectedCycleRevision,
      choice: source.choice,
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
  if (Object.hasOwn(source, 'requestedOrders')) {
    if (!Number.isInteger(source.requestedOrders) || source.requestedOrders < 0) invalid();
    patch.requestedOrders = source.requestedOrders;
  }
  if (Object.hasOwn(source, 'maxBoostersPerCycle')) {
    if (!Number.isInteger(source.maxBoostersPerCycle) || source.maxBoostersPerCycle < 1 || source.maxBoostersPerCycle > 1000) invalid();
    patch.maxBoostersPerCycle = source.maxBoostersPerCycle;
  }
  for (const key of [
    'maxUnitPriceMicroUsdg', 'maxCycleBudgetMicroUsdg', 'max24HourBudgetMicroUsdg',
    'perCycleCapMicroUsdg', 'lossCapMicroUsdg', 'maxOutstandingCustodyMicroUsdg',
  ]) {
    if (Object.hasOwn(source, key)) {
      if (typeof source[key] !== 'string' || !microUsdgPattern.test(source[key])) invalid();
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
  'version', 'desiredStatus', 'mode', 'communityPackIds', 'manualPackOrders', 'maxBoostersPerCycle',
  'rewardRecipientLimit', 'cycleIntervalMinutes', 'skipNextCycleSequence', 'runNowSequence',
  'maxUnitPriceMicroUsdg', 'maxCycleBudgetMicroUsdg', 'max24HourBudgetMicroUsdg',
  'configurationComplete', 'executionConnected', 'liveMode',
]);
const HARD_CAPS_KEYS = new Set(['maxBoostersPerCycle', 'maxUnitPriceMicroUsdg', 'maxCycleBudgetMicroUsdg', 'max24HourBudgetMicroUsdg']);
const READINESS_KEYS = new Set(['ready', 'reasons']);

export function assertBootstrap(value) {
  const source = requiredRecord(value, invalid);
  exactKeys(source, BOOTSTRAP_KEYS, invalid);
  requiredKeys(source, BOOTSTRAP_KEYS, invalid);
  const identity = requiredRecord(source.identity, invalid);
  exactKeys(identity, IDENTITY_KEYS, invalid);
  requiredKeys(identity, IDENTITY_KEYS, invalid);
  if (identity.role !== 'viewer' && identity.role !== 'operator') invalid();
  const state = requiredRecord(source.state, invalid);
  exactKeys(state, OPERATOR_STATE_KEYS, invalid);
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
  boundedArray(source.rewardRecipientLimits, 16, invalid).forEach(limit => {
    if (!Number.isSafeInteger(limit) || limit < 100 || limit > 1000) invalid();
  });
  if (source.catalog !== null) {
    const catalog = requiredRecord(source.catalog, invalid);
    exactKeys(catalog, new Set(['status', 'fetchedAtMs', 'packs']), invalid);
    requiredKeys(catalog, ['status', 'fetchedAtMs', 'packs'], invalid);
    boundedText(catalog.status, invalid);
    if (!Number.isSafeInteger(catalog.fetchedAtMs) || catalog.fetchedAtMs < 0) invalid();
    boundedArray(catalog.packs, 10_000, invalid);
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
const DASHBOARD_METRICS_KEYS = new Set([
  'cycleStartProjectPoolMicroUsdg', 'totalCycleFundingMicroUsdg', 'totalCollectorSpendMicroUsdg',
  'totalBuybacksReturnedMicroUsdg', 'totalBridgedBackMicroUsdg', 'totalRewardsPaidMicroUsdg',
  'totalRewardsDeferredMicroUsdg', 'totalQuotedOperatingCostsMicroUsdg', 'latestRetainedReserveMicroUsdg',
  'latestCycleReserveTargetMicroUsdg', 'completedCycles', 'skippedCycles', 'openedPacks',
]);
const ACTIVE_CYCLE_KEYS = new Set([
  'cycleId', 'status', 'updatedAt', 'configurationRevision', 'allowedPackIds', 'requestedOrders',
  'maxBoostersPerCycle', 'maxUnitPriceMicroUsdg', 'maxCycleBudgetMicroUsdg', 'max24HourBudgetMicroUsdg',
  'revealedCards', 'rewardRecipientLimit',
]);
const DASHBOARD_LATEST_CYCLE_KEYS = new Set([
  'cycleId', 'status', 'reason', 'updatedAt', 'paidMicroUsdg', 'payoutRecipientCount', 'rewardRecipientLimit',
  'selectedCount', 'paidCount', 'deferredCount', 'roundAccounting', 'transactions',
]);

/** Validate `/operator/api/dashboard`'s response shape (readSet: apps/web/app/operator/
 * OperatorControlPanel.tsx's `Dashboard` type / `decodeDashboard`). Only checks key sets and basic
 * scalar types — the richer cross-field invariants (`decodeActiveCycle`'s total-vs-cap check, the
 * exclusive gain/loss pair, etc.) live in the public contract ports this dashboard shares data with
 * (contracts/public-cycle-status.mjs) and are not duplicated here. */
export function assertDashboardResponse(value) {
  const source = requiredRecord(value, invalid);
  if (![1, 2, 3, 4, 5, 6].includes(source.schemaVersion)) invalid();
  const dashboardKeys = source.schemaVersion === 6 ? DASHBOARD_V6_KEYS : DASHBOARD_KEYS;
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
  exactKeys(metrics, DASHBOARD_METRICS_KEYS, invalid);
  requiredKeys(metrics, DASHBOARD_METRICS_KEYS, invalid);
  boundedArray(source.latestCycleTopAllocations, 200, invalid);
  boundedArray(source.cards, 60, invalid);
  if (source.activeCycle !== null) {
    const activeCycle = requiredRecord(source.activeCycle, invalid);
    exactKeys(activeCycle, ACTIVE_CYCLE_KEYS, invalid);
    requiredKeys(activeCycle, ACTIVE_CYCLE_KEYS, invalid);
    boundedText(activeCycle.cycleId, invalid);
    boundedText(activeCycle.status, invalid);
  }
  if (source.latestCycle !== null) {
    const latestCycle = requiredRecord(source.latestCycle, invalid);
    exactKeys(latestCycle, DASHBOARD_LATEST_CYCLE_KEYS, invalid);
    requiredKeys(latestCycle, DASHBOARD_LATEST_CYCLE_KEYS, invalid);
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
    exactKeys(offChain, new Set(['usedMicroUsdg', 'limitMicroUsdg', 'remainingMicroUsdg']), invalid);
    requiredKeys(offChain, ['usedMicroUsdg', 'limitMicroUsdg', 'remainingMicroUsdg'], invalid);
    money(offChain.usedMicroUsdg, invalid);
    money(offChain.limitMicroUsdg, invalid);
    money(offChain.remainingMicroUsdg, invalid);
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
