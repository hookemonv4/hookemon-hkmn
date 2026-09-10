import { createRewardSelectionSnapshot, assertRewardSelectionSnapshot } from '../../../runner/src/automation/reward-selection-snapshot.mjs';
import { createEligibilityPayoutManifest } from '../../../runner/src/distribution/pro-rata.mjs';
import { assertPackPlanSnapshot, createPackPlanSnapshot } from '../../../runner/src/automation/pack-plan-snapshot.mjs';
import { isProcessQuoteUsdValuation, readProcessQuoteUsdProvenance, relayQuoteDigest, parseQuoteResponse } from '../relay-client.mjs';
import { requireLiveMutationAuthority, createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { createHash } from 'node:crypto';
import { isProcessNativePaymentProof, applyNativeCustodyGasPayment } from '../native-payment-proof.mjs';
// The durable authority for one operational cycle. `compose.mjs` injects this same instance into
// the scheduler, CLI service, and in-process dashboard so they observe one append-only journal
// rather than a placeholder runner or a second store. The exported client facade gives future
// standalone consumers only read access. It tracks fixed stage progress, provider write-ahead
// attempts, terminal holds, and custody ledgers; `CycleRunner` remains a separate domain engine.
import { lstat, open } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { DurableCycleStore, StateDirectoryLossError } from '../../../runner/src/cycle/durable-store.mjs';
import {
  assertBoundedCanonicalValue,
  canonicalJson,
  CycleJournal,
  digest,
  RECOVERY_LIMITS,
} from '../../../runner/src/cycle/journal.mjs';
import { isProcessRpcFinalizedErc20TransferProof } from '../robinhood-rpc.mjs';
import { isProcessRpcRelayDestinationObservation } from '../solana-rpc.mjs';
import { isProcessRpcOutboundRefundProof } from './stages/outbound.mjs';
import { isProcessRpcReturnLegDestinationProof } from './stages/return.mjs';
import { assertPolicyAdmission, decodeHistoricalPolicyAdmission } from '../../../runner/src/automation/policy-engine.mjs';
import {
  assertRelayLeg,
  assertStandingAuthorityDecision,
  assertWalletNonceReservation,
  attributeRelayLegSource,
  assertChainTransactionAttempt,
  assertCustodyLedger,
  assertPackBatchRequest,
  CUSTODY_LEDGER_BUCKETS,
  assertCycleTerminalState,
  assertProviderMutationAttempt,
  assertRelayFinality,
  assertTypedAmount,
  assertReturnLegDestinationProof,
  assertSignOnlyInvocationLedger,
  assertSignOnlyPreSignBinding,
  createReservedSignOnlyInvocationLedger,
  OPERATIONAL_CYCLE_STAGES,
  PACK_OPERATION_STAGES,
  RELAY_LEG_TERMINAL_STATES,
  transitionChainTransactionAttempt,
  transitionRelayLeg,
  transitionProviderMutationAttempt,
  transitionSignOnlyInvocationLedger,
} from '../../../runner/src/cycle/money-schemas.mjs';

// The scheduler dispatches only OPERATIONAL_CYCLE_STAGES. These retired names remain readable for
// historical accounting journals while their projection moves in a dedicated accounting migration.
// New operational writes never accept either name.
const LEGACY_ACCOUNTING_STAGES = Object.freeze(['funding', 'distribution']);
const OPERATIONAL_STAGE_SET = new Set(OPERATIONAL_CYCLE_STAGES);
const LEGACY_ACCOUNTING_STAGE_SET = new Set(LEGACY_ACCOUNTING_STAGES);
const POST_TERMINAL_RECORD_KINDS = new Set([
  'process-usd-claim-finalized',
  'stage-attempted',
  'stage-attempt-failed',
  'stage-attempt-sent-unknown',
  'stage-attempt-not-sent',
  'stage-attempt-reprepared',
  'stage-attempt-response-recorded',
  'stage-attempt-deadline-anchored',
  'stage-attempt-reconciled',
  'chain-attempt-broadcast',
  'chain-attempt-finalized',
  'relay-leg-settled',
  'custody-ledger-recorded',
  'payout-quarantine-retry-requested',
  'payout-quarantine-retry-refused',
  'payout-quarantine-settled',
  'wallet-nonce-reserved',
  'wallet-nonce-released',
  'held-owner-decision-recorded',
  'held-position-owner-decision-recorded',
  'held-position-identity-verified',
  'held-position-resolved',
  'supplementary-settlement-advanced',
  'supplementary-payout-gas-recorded',
  'supplementary-chain-attempt-prepared',
  'supplementary-chain-attempt-signed',
  'supplementary-chain-attempt-signed-with-recovery-context',
  'supplementary-chain-attempt-broadcast',
  'supplementary-chain-attempt-recovery-context-recorded',
]);
const POST_COMPLETION_RECORD_KINDS = new Set([
  'process-usd-claim-finalized',
  'held-position-owner-decision-recorded',
  'held-position-identity-verified',
  'held-position-resolved',
  'supplementary-settlement-advanced',
  'supplementary-payout-gas-recorded',
  'supplementary-chain-attempt-prepared',
  'supplementary-chain-attempt-signed',
  'supplementary-chain-attempt-signed-with-recovery-context',
  'supplementary-chain-attempt-broadcast',
  'supplementary-chain-attempt-recovery-context-recorded',
]);
function payoutRetryMayUseHeldCycle(state) {
  return state?.terminalState === HELD_OWNER_DECISION
    && state.terminalEvidence?.reason === 'PAYOUT_QUARANTINED_LIABILITY'
    && [...(state.payoutQuarantines?.values?.() ?? [])].some(reservation => (
      reservation.retries ?? []
    ).some(retry => retry.resolution === null
      && reservation.settlement?.retryId !== retry.retryId));
}
function payoutRetryMayReleaseHeldCycle(state) {
  return state?.terminalState === HELD_OWNER_DECISION
    && state.terminalEvidence?.reason === 'PAYOUT_QUARANTINED_LIABILITY'
    && [...(state.payoutQuarantines?.values?.() ?? [])].some(reservation => (
      reservation.retries ?? []
    ).some(retry => retry.resolution === null || reservation.settlement?.retryId === retry.retryId));
}
const decimalPattern = /^(0|[1-9][0-9]*)$/;
const signedDecimalPattern = /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HELD_OWNER_DECISION = 'HELD_OWNER_DECISION';
const HELD_OWNER_DECISION_CHOICES = new Set(['sell', 'keep-holding']);
const HELD_POSITION_TERMINAL_STATES = new Set([
  'HELD_DATA_UNVERIFIED',
  'HELD_OWNER_DECISION',
  'HELD_UNAVAILABLE',
  'HELD_UNRESOLVED',
]);
const HELD_POSITION_RESOLUTION_TERMINAL_STATES = new Set(['SOLD', 'REFUNDED', 'NEVER_SENT']);
const SUPPLEMENTARY_SETTLEMENT_STATES = new Set(['PREPARED', 'BUYBACK_SENT_UNKNOWN', 'RETURN_BROADCAST', 'PAYOUT_BROADCAST', 'COMPLETE']);
const SUPPLEMENTARY_SETTLEMENT_TRANSITIONS = new Map([
  ['PREPARED', new Set(['BUYBACK_SENT_UNKNOWN'])],
  ['BUYBACK_SENT_UNKNOWN', new Set(['RETURN_BROADCAST'])],
  ['RETURN_BROADCAST', new Set(['PAYOUT_BROADCAST'])],
  ['PAYOUT_BROADCAST', new Set(['COMPLETE'])],
]);
const heldPositionIdPattern = /^held:[0-9a-f]{64}$/;
const supplementaryPayoutPagedStagePattern = /^supplementary-[0-9a-f]{48}$/;
const evmAddressPattern = /^0x[0-9a-fA-F]{40}$/;
const evmTransactionHashPattern = /^0x[0-9a-fA-F]{64}$/;
const fencingTokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const quarantineReasonPattern = /^[A-Z][A-Z0-9_]{2,63}$/;
const payoutDustRecordSchema = 'hookemon.payout-dust-record.v1';
const payoutDustConsumptionSchema = 'hookemon.payout-dust-consumption.v1';
const payoutQuarantineSchema = 'hookemon.payout-quarantine-reservation.v1';
const payoutQuarantineRetrySchema = 'hookemon.payout-quarantine-retry.v1';
const payoutQuarantineSettlementSchema = 'hookemon.payout-quarantine-settlement.v1';
const supplementaryPayoutSourceSchema = 'hookemon.supplementary-payout-source.v2';
const supplementaryReturnBoundarySchema = 'hookemon.supplementary-return-boundary.v2';
const supplementaryFinalizedReturnSchema = 'hookemon.supplementary-finalized-return.v2';
const supplementarySettlementEvidenceSchema = 'hookemon.supplementary-settlement-evidence.v2';
const evmNonceLockSchema = 'hookemon.evm-nonce-lock.v1';
const relayAttributionSchema = 'hookemon.relay-attribution.v1';
const chainAttemptRecoveryContextSchema = 'hookemon.chain-attempt-recovery-context.v1';
const stateDirectoryRecoveryHoldSchema = 'hookemon.cycle-repository-state-directory-recovery-hold.v1';
const CYCLE_MODES = new Set(['production', 'rehearsal']);
const PROVIDER_MODES = new Set(['live', 'fake']);
const stateDirectoryRecoveryReasons = new Set([
  'missing',
  'unavailable',
  'missing-identity',
  'identity-marker-missing',
  'identity-marker-mismatch',
  'identity-directory-mismatch',
]);
const recoveryRecordMaximumBytes = 16_384;
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export const CYCLE_REPOSITORY_CLIENT_INTERFACE = Object.freeze([
  'readActiveCycle',
  'peekActiveCycle',
  'readStage',
  'describeCycle',
  'readOperationalStageAttempt',
  'readChainTransactionAttempt',
  'readClaimPreconditions',
  'readHeldPosition',
  'readHeldPositionEvidence',
  'listHeldPositions',
  'readSupplementarySettlement',
  'listKnownCycleIds',
  'readOutboundQuoteRefresh',
  'readFinalizedClaimCustodyEvidence',
  'readPagedPayoutState',
]);

export const CYCLE_REPOSITORY_INTERFACE = Object.freeze([
  ...CYCLE_REPOSITORY_CLIENT_INTERFACE,
  'createCycle',
  'recordOutboundQuoteExpired',
  'selectOutboundQuoteRefresh',
  'prepareStage',
  'completeStage',
  'completeCycle',
  'holdCycle',
  'recordPackOrderReconciliation',
  'readPackOrderReconciliation',
  'recordPackOrderIntent',
  'recordPackOrderRequest',
  'readPackOrderIntent',
  'readPackOrderRequest',
  'recordPackBatchIntent',
  'readPackBatchIntent',
  'recordPackBatchRequest',
  'readPackBatchRequest',
  'recordHeldPosition',
  'recordHeldPositionIdentity',
  'recordHeldOwnerDecision',
  'resolveHeldPosition',
  'advanceSupplementarySettlement',
  'prepareStageAttempt',
  'markStageAttemptSentUnknown',
  'markStageAttemptNotSent',
  'recordStageAttemptResponse',
  'anchorOperationalStageDeadline',
  'reconcileStageAttempt',
  'prepareChainTransactionAttempt',
  'recordSignedTransaction',
  'recordSignedTransactionWithRecoveryContext',
  'recordBroadcast',
  'recordFinality',
  'recordRelayLeg',
  'recordRelayLegSource',
  'readRelayLeg',
  'settleRelayLeg',
  'readStandingAuthorityDecision',
  'recordStandingAuthorityDecision',
  'reserveProcessClaimUsd',
  'finalizeProcessClaimUsd',
  'reserveWalletNonce',
  'assertWalletNonce',
  'releaseWalletNonce',
  'persistChainAttemptRecoveryContext',
  'readChainAttemptRecoveryContext',
  'persistSignOnlyPreSignBinding',
  'readSignOnlyPreSignBinding',
  'reserveSignOnlyInvocation',
  'recordSignOnlyInvocationTimeout',
  'readSignOnlyInvocationLedger',
  'readPagedPayoutState',
  'persistPagedPayoutState',
  'consumePayoutDustAndPersistPagedPayoutState',
  'recordCustodyLedger',
  'recordSupplementaryPayoutGas',
  'readPayoutDust',
  'readPayoutDustConsumption',
  'recordPayoutDust',
  'consumePayoutDust',
  'consumePayoutDustAndRecordStageAttempt',
  'readPayoutQuarantine',
  'reservePayoutQuarantine',
  'requestPayoutQuarantineRetry',
  'recordPayoutQuarantineRetryRefusal',
  'settlePayoutQuarantine',
  'listPayoutObligations',
  'listOpenPayoutRetries',
  'acquireEvmNonceLock',
  'assertEvmNonceLock',
  'releaseEvmNonceLock',
]);

export function assertCycleRepositoryClientInterface(value, label = 'cycleRepository client') {
  for (const method of CYCLE_REPOSITORY_CLIENT_INTERFACE) {
    if (!value || typeof value[method] !== 'function') throw new Error(`${label}.${method} is required`);
  }
  return value;
}

export function assertCycleRepositoryInterface(value, label = 'cycleRepository') {
  for (const method of CYCLE_REPOSITORY_INTERFACE) {
    if (!value || typeof value[method] !== 'function') throw new Error(`${label}.${method} is required`);
  }
  return value;
}

export function createCycleRepositoryClient(cycleRepository) {
  assertCycleRepositoryClientInterface(cycleRepository);
  const client = {};
  for (const method of CYCLE_REPOSITORY_CLIENT_INTERFACE) {
    client[method] = cycleRepository[method].bind(cycleRepository);
  }
  return Object.freeze(client);
}

export function createCycleRepositoryRunner(cycleRepository, cycleId) {
  assertCycleRepositoryClientInterface(cycleRepository);
  if (typeof cycleId !== 'string' || cycleId.length === 0) throw new Error('cycle repository runner cycleId is invalid');
  const repository = createCycleRepositoryClient(cycleRepository);
  return Object.freeze({
    schema: 'hookemon.cycle-repository-runner.v1',
    cycleId,
    repository,
    readStage: stage => repository.readStage(cycleId, stage),
    readOperationalStageAttempt: stage => repository.readOperationalStageAttempt(cycleId, stage),
    readChainTransactionAttempt: (stage, requestDigest) => repository.readChainTransactionAttempt(cycleId, stage, requestDigest),
    describe: () => repository.describeCycle(cycleId),
  });
}

function stateDirectoryRecoveryHoldPath(directory) {
  return join(dirname(directory), `${basename(directory)}.recovery.json`);
}

function assertStateDirectoryRecoveryHold(value, label = 'state-directory recovery hold') {
  assertPlainExactObject(value, [
    'schema',
    'cycleId',
    'stateDirectory',
    'storeIdentity',
    'detectedAt',
    'terminalState',
    'nextAction',
    'reason',
  ], label);
  if (value.schema !== stateDirectoryRecoveryHoldSchema) throw new Error(`${label} schema is invalid`);
  if (typeof value.cycleId !== 'string' || !/^state-directory-loss-[0-9a-f-]{36}$/.test(value.cycleId)) {
    throw new Error(`${label} cycle id is invalid`);
  }
  if (typeof value.stateDirectory !== 'string' || value.stateDirectory.length === 0) {
    throw new Error(`${label} state directory is invalid`);
  }
  if (value.storeIdentity !== null) {
    assertPlainExactObject(value.storeIdentity, ['schema', 'storeId', 'createdAt'], `${label} store identity`);
    if (value.storeIdentity.schema !== 'hookemon.durable-cycle-store.identity.v1'
      || typeof value.storeIdentity.storeId !== 'string'
      || !fencingTokenPattern.test(value.storeIdentity.storeId)
      || typeof value.storeIdentity.createdAt !== 'string'
      || !isoTimestampPattern.test(value.storeIdentity.createdAt)) {
      throw new Error(`${label} store identity is invalid`);
    }
  }
  if (typeof value.detectedAt !== 'string' || !isoTimestampPattern.test(value.detectedAt)) {
    throw new Error(`${label} detected-at is invalid`);
  }
  if (value.terminalState !== 'HELD_DATA_UNVERIFIED' || value.nextAction !== 'owner-decision') {
    throw new Error(`${label} terminal contract is invalid`);
  }
  if (!stateDirectoryRecoveryReasons.has(value.reason)) throw new Error(`${label} reason is invalid`);
  return Object.freeze(structuredClone(value));
}

async function readPrivateCanonicalRecord(path, label) {
  let before;
  try {
    before = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || (before.mode & 0o777) !== 0o600) {
    throw new Error(`${label} must be a private regular file`);
  }
  const handle = await open(path, 'r');
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || (opened.mode & 0o777) !== 0o600) {
      throw new Error(`${label} changed while opening`);
    }
    if (opened.size > recoveryRecordMaximumBytes) throw new Error(`${label} exceeds the byte limit`);
    return await handle.readFile({ encoding: 'utf8' });
  } finally {
    await handle.close();
  }
}

async function readStateDirectoryRecoveryHold(directory) {
  const path = stateDirectoryRecoveryHoldPath(directory);
  const text = await readPrivateCanonicalRecord(path, 'state-directory recovery hold');
  if (text === null) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('state-directory recovery hold contains corrupt JSON');
  }
  if (`${canonicalJson(parsed)}\n` !== text) {
    throw new Error('state-directory recovery hold bytes are not canonical JSON plus one newline');
  }
  return assertStateDirectoryRecoveryHold(parsed);
}

async function persistStateDirectoryRecoveryHold(recovery, now) {
  if (!recovery?.detected || recovery.terminalState !== 'HELD_DATA_UNVERIFIED'
    || recovery.nextAction !== 'owner-decision' || !stateDirectoryRecoveryReasons.has(recovery.reason)) {
    throw new Error('state-directory recovery metadata is invalid');
  }
  const path = stateDirectoryRecoveryHoldPath(recovery.stateDirectory);
  const existing = await readStateDirectoryRecoveryHold(recovery.stateDirectory);
  if (existing !== null) {
    const sameIdentity = canonicalJson(existing.storeIdentity) === canonicalJson(recovery.identity);
    if (existing.stateDirectory !== recovery.stateDirectory || !sameIdentity || existing.reason !== recovery.reason) {
      throw new Error('state-directory recovery hold conflicts with the detected store identity');
    }
    return existing;
  }
  const hold = assertStateDirectoryRecoveryHold({
    schema: stateDirectoryRecoveryHoldSchema,
    cycleId: `state-directory-loss-${globalThis.crypto.randomUUID()}`,
    stateDirectory: recovery.stateDirectory,
    storeIdentity: recovery.identity,
    detectedAt: new Date(now()).toISOString(),
    terminalState: 'HELD_DATA_UNVERIFIED',
    nextAction: 'owner-decision',
    reason: recovery.reason,
  });
  const text = `${canonicalJson(hold)}\n`;
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const raced = await readStateDirectoryRecoveryHold(recovery.stateDirectory);
    if (raced === null) throw new Error('state-directory recovery hold disappeared during creation');
    const sameIdentity = canonicalJson(raced.storeIdentity) === canonicalJson(recovery.identity);
    if (raced.stateDirectory !== recovery.stateDirectory || !sameIdentity || raced.reason !== recovery.reason) {
      throw new Error('state-directory recovery hold conflicts with the detected store identity');
    }
    return raced;
  }
  try {
    await handle.chmod(0o600);
    await handle.writeFile(text, { encoding: 'utf8' });
    await handle.sync();
  } finally {
    await handle.close();
  }
  const parent = await open(dirname(path), 'r');
  try {
    await parent.sync();
  } finally {
    await parent.close();
  }
  return hold;
}

function createStateDirectoryRecoveryRepository(hold) {
  const recovery = assertStateDirectoryRecoveryHold(hold);
  const terminalEvidence = Object.freeze({
    schema: 'hookemon.state-directory-loss-evidence.v1',
    reason: recovery.reason,
    stateDirectory: recovery.stateDirectory,
    storeIdentity: recovery.storeIdentity,
    detectedAt: recovery.detectedAt,
    nextAction: recovery.nextAction,
  });
  const assertCycle = cycleId => {
    if (cycleId !== recovery.cycleId) throw new Error('cycle-repository state-directory recovery cycle id is invalid');
  };
  const terminalError = operation => new Error(`cycle-repository ${operation}: cycle is terminal as HELD_DATA_UNVERIFIED`);
  const repository = Object.fromEntries(CYCLE_REPOSITORY_INTERFACE.map(method => [method, async () => {
    throw terminalError(method);
  }]));
  Object.assign(repository, {
    async readActiveCycle() {
      return {
        cycleId: recovery.cycleId,
        releaseAmount: '0',
        mode: null,
        terminalState: 'HELD_DATA_UNVERIFIED',
      };
    },
    async peekActiveCycle() {
      return {
        cycleId: recovery.cycleId,
        releaseAmount: '0',
        terminalState: 'HELD_DATA_UNVERIFIED',
      };
    },
    async readStage(cycleId) {
      assertCycle(cycleId);
      return { status: 'PENDING' };
    },
    async describeCycle(cycleId) {
      assertCycle(cycleId);
      return {
        cycleId: recovery.cycleId,
        releaseAmount: '0',
        mode: null,
        providerMode: null,
        dryRun: false,
        rehearsalSessionId: null,
        stages: new Map(),
        preparedStages: new Map(),
        attempts: new Map(),
        attemptCounts: new Map(),
        operationalAttempts: new Map(),
        chainAttempts: new Map(),
        relayLegs: new Map(),
        standingAuthorityDecisions: new Map(),
        walletNonceReservations: new Map(),
        chainAttemptRecoveryContexts: new Map(),
        signOnlyPreSignBindings: new Map(),
        signOnlyInvocationLedgers: new Map(),
        custodyLedgers: new Map(),
        heldPositions: new Map(),
        heldPositionLedgerKeys: new Map(),
        returnLegLedgerKeys: new Map(),
        supplementarySettlements: new Map(),
        supplementarySettlementEvidence: new Map(),
        payoutDustRecords: new Map(),
        payoutDustConsumptions: new Map(),
        payoutQuarantines: new Map(),
        evmNonceLocks: new Map(),
        completed: false,
        terminalState: 'HELD_DATA_UNVERIFIED',
        heldEvidenceDigest: null,
        ownerDecision: null,
        terminalEvidence,
        archived: false,
      };
    },
    async readOperationalStageAttempt(cycleId) {
      assertCycle(cycleId);
      return null;
    },
    async readChainTransactionAttempt(cycleId) {
      assertCycle(cycleId);
      return null;
    },
    async readClaimPreconditions(cycleId) {
      assertCycle(cycleId);
      return Object.freeze({
        heldAssets: true,
        unattributed: true,
        unresolvedObligations: true,
        heldPositions: Object.freeze({ count: 0, valueMicroUsd: '0', positions: Object.freeze([]) }),
      });
    },
    async readHeldPosition() { return null; },
    async readHeldPositionEvidence() { return null; },
    async listHeldPositions() { return []; },
    async readSupplementarySettlement() { return null; },
    async readSupplementarySettlementEvidence() { return null; },
    async listKnownCycleIds() {
      return [recovery.cycleId];
    },
    async holdCycle(cycleId, terminalState) {
      assertCycle(cycleId);
      if (terminalState !== 'HELD_DATA_UNVERIFIED') throw terminalError('holdCycle');
    },
    async createCycle() {
      throw new Error('cycle-repository state-directory loss requires owner decision');
    },
    async prepareStage(cycleId) {
      assertCycle(cycleId);
      throw terminalError('prepareStage');
    },
  });
  return Object.freeze(repository);
}

function assertStageName(stage, { allowLegacyRead = false } = {}) {
  if (OPERATIONAL_STAGE_SET.has(stage)) return;
  if (allowLegacyRead && LEGACY_ACCOUNTING_STAGE_SET.has(stage)) return;
  if (LEGACY_ACCOUNTING_STAGE_SET.has(stage)) throw new Error(`cycle-repository: retired stage "${stage}" is read-only`);
  throw new Error(`cycle-repository: unknown stage "${stage}"`);
}

const PACK_OPERATION_STAGE_SET = new Set(PACK_OPERATION_STAGES);
const packTypeFieldPattern = /^[a-z0-9][a-z0-9_-]{1,63}$/;

function assertPackOperationStageName(stage) {
  if (!PACK_OPERATION_STAGE_SET.has(stage)) throw new Error(`cycle-repository: "${stage}" is not a pack-operation stage`);
}

// Mirrors durable-store.mjs's own (module-private) paged-stage-evidence handle schema string --
// the wire-format tag `persistPagedStageEvidence` stamps on the immutable handle it returns, which
// this module journals verbatim in place of oversized stage evidence. Duplicated as a literal
// because the handle is a versioned cross-module contract, not an implementation detail reached
// into from here.
const STAGE_EVIDENCE_PAGE_REFERENCE_SCHEMA = 'hookemon.durable-cycle-store.paged-stage-evidence-handle.v1';

/** True only for the exact immutable handle completeStage journals in place of oversized evidence. */
function isStageEvidencePageReference(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype
    && value.schema === STAGE_EVIDENCE_PAGE_REFERENCE_SCHEMA;
}

/** Whether `value` fits one bounded journal-event payload unchanged (the journal's own limits). */
function fitsBoundedJournalPayload(value) {
  try {
    assertBoundedCanonicalValue(value, 'stage evidence', {
      objects: RECOVERY_LIMITS.payloadObjects,
      arrays: RECOVERY_LIMITS.payloadArrays,
      arrayItems: RECOVERY_LIMITS.payloadArrayItems,
      aggregateBytes: RECOVERY_LIMITS.payloadAggregateBytes,
    });
    return true;
  } catch {
    return false;
  }
}

function assertPackBatchIntent(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 4
    || !Object.hasOwn(value, 'quantity') || !Object.hasOwn(value, 'packType') || !Object.hasOwn(value, 'expectedCardCountPerPack')
    || !Object.hasOwn(value, 'playerAddress')) {
    throw new Error(`${label} must use the exact schema`);
  }
  if (!Number.isInteger(value.quantity) || value.quantity < 1) throw new Error(`${label} quantity is invalid`);
  if (value.packType !== null && (typeof value.packType !== 'string' || !packTypeFieldPattern.test(value.packType))) {
    throw new Error(`${label} packType is invalid`);
  }
  if (!Number.isInteger(value.expectedCardCountPerPack) || value.expectedCardCountPerPack < 1) {
    throw new Error(`${label} expectedCardCountPerPack is invalid`);
  }
  const playerAddress = assertHeldPositionText(value.playerAddress, `${label}.playerAddress`);
  return { quantity: value.quantity, packType: value.packType, expectedCardCountPerPack: value.expectedCardCountPerPack, playerAddress };
}

function assertPagedPayoutStage(stage) {
  if (stage === 'payout' || (typeof stage === 'string' && supplementaryPayoutPagedStagePattern.test(stage))) {
    return stage;
  }
  throw new Error('cycle-repository paged payout state is available only for the payout or a supplementary payout stage');
}

function assertReleaseAmount(value) {
  if (typeof value !== 'string' || !decimalPattern.test(value)) {
    throw new Error('cycle-repository createCycle releaseAmount must be a canonical unsigned decimal string');
  }
}

function assertCycleMode(value, label = 'cycle-repository createCycle mode') {
  if (!CYCLE_MODES.has(value)) throw new Error(`${label} must be "production" or "rehearsal"`);
  return value;
}

function assertProviderMode(value, mode, { dryRun = false } = {}, label = 'cycle-repository createCycle providerMode') {
  if (!PROVIDER_MODES.has(value)) throw new Error(`${label} must be "live" or "fake"`);
  if (mode === 'production' && value !== 'live' && !(dryRun === true && value === 'fake')) {
    throw new Error(`${label} must be "live" for production`);
  }
  return value;
}

function assertDryRun(value, mode, providerMode, label = 'cycle-repository createCycle dryRun') {
  if (typeof value !== 'boolean') throw new Error(`${label} must be a boolean`);
  if (value && (mode !== 'production' || providerMode !== 'fake')) {
    throw new Error(`${label} requires production mode with fake providers`);
  }
  return value;
}

function assertRehearsalSessionId(value, mode, providerMode, label = 'cycle-repository createCycle rehearsalSessionId') {
  if (typeof value !== 'string' || !/^rehearsal-[0-9a-f-]{36}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  if (mode !== 'rehearsal' || providerMode !== 'fake') {
    throw new Error(`${label} requires fake rehearsal execution`);
  }
  return value;
}

function generateCycleId(now) {
  return `cycle-${now.toString(36)}-${globalThis.crypto.randomUUID()}`;
}

const reservedCycleIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;

/** Accepts only an identifier `nextCycleId` could have produced; the store re-validates on append. */
function assertReservedCycleId(value) {
  if (typeof value !== 'string' || !reservedCycleIdPattern.test(value)) {
    throw new Error('cycle-repository createCycle: reserved cycleId is invalid');
  }
  return value;
}

/**
 * Validates the quote-bound policy admission this cycle is opened under. Monetary rules are not
 * restated here: `assertPolicyAdmission` is the policy engine's own normalizer, so the record this
 * store accepts is exactly the record that engine will digest and that outbound will replay. What
 * this adds is the persistence-boundary obligation that the record names this cycle.
 */
function assertDurableCycleAdmission(value, cycleId, operations, label = 'cycle-repository admission', { historicalRead = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  // The policy engine's own normalizer authenticates both quotes deeply -- parsed and raw evidence,
  // route legs, order binding, and each quote digest recomputed from that evidence rather than
  // trusted as supplied. What is persisted is that normalized result, so the stored record cannot
  // contain executable raw steps the checks never saw.
  const normalized = historicalRead && value.schema === 'hookemon.policy-admission.v2'
    ? decodeHistoricalPolicyAdmission(value, operations ?? undefined) : assertPolicyAdmission(value, operations);
  if (normalized.cycleId !== cycleId) throw new Error(`${label} does not name this cycle`);
  canonicalJson(normalized);
  return Object.freeze(structuredClone(normalized));
}

/**
 * REQ-cycle-repository-2 / ADR-0025 `refresh-after-readmission`: durable evidence that a Relay
 * quote expired before any outbound request or signature existed. Deliberately narrow -- only the
 * identities and deadlines the policy engine already normalized into the durable admission, plus
 * the observation itself -- so this record can never carry executable Relay steps a check never
 * saw.
 */
const OUTBOUND_QUOTE_EXPIRY_EVIDENCE_SCHEMA = 'hookemon.outbound-quote-expiry-evidence.v1';

function assertOutboundQuoteIdentity(value, label) {
  exactObject(value, ['requestId', 'deadlineUnixSeconds', 'quoteDigest'], label);
  if (typeof value.requestId !== 'string' || value.requestId.length === 0) throw new Error(`${label} requestId is invalid`);
  if (!Number.isSafeInteger(value.deadlineUnixSeconds) || value.deadlineUnixSeconds <= 0) {
    throw new Error(`${label} deadlineUnixSeconds is invalid`);
  }
  assertDigest(value.quoteDigest, `${label} quoteDigest`);
  return Object.freeze({ requestId: value.requestId, deadlineUnixSeconds: value.deadlineUnixSeconds, quoteDigest: value.quoteDigest });
}

function assertOutboundQuoteExpiryEvidence(value, cycleId) {
  const label = 'cycle-repository outbound quote expiry evidence';
  const plan = value?.schema === 'hookemon.outbound-quote-expiry-evidence.v2';
  exactObject(value, ['schema', 'cycleId', 'admissionDigest', 'aggregateQuote', plan ? 'unitQuotes' : 'unitQuote', 'observedAtMs'], label);
  if (!plan && value.schema !== OUTBOUND_QUOTE_EXPIRY_EVIDENCE_SCHEMA) throw new Error(`${label} schema is invalid`);
  if (value.cycleId !== cycleId) throw new Error(`${label} does not name this cycle`);
  assertDigest(value.admissionDigest, `${label} admissionDigest`);
  const aggregateQuote = assertOutboundQuoteIdentity(value.aggregateQuote, `${label} aggregateQuote`);
  const rawUnits = plan ? value.unitQuotes : [value.unitQuote];
  if (!Array.isArray(rawUnits) || !rawUnits.length || rawUnits.length > 64) throw new Error(`${label} unit quotes are invalid`);
  const units = rawUnits.map(unit => assertOutboundQuoteIdentity(unit, `${label} unit quote`));
  if (!Number.isSafeInteger(value.observedAtMs) || value.observedAtMs <= 0) throw new Error(`${label} observedAtMs is invalid`);
  const observed = Math.floor(value.observedAtMs / 1000);
  if ([aggregateQuote, ...units].every(quote => observed < quote.deadlineUnixSeconds)) throw new Error(`${label} requires the aggregate or unit quote to actually be expired at the observed time`);
  return Object.freeze({ schema: value.schema, cycleId, admissionDigest: value.admissionDigest, aggregateQuote,
    ...(plan ? { unitQuotes: units } : { unitQuote: units[0] }), observedAtMs: value.observedAtMs });
}

/**
 * The expiry evidence must name *this cycle's actual* admission and quotes -- never an arbitrary
 * or stale digest a caller happens to supply -- so a fabricated or mismatched expiry record can
 * never open the door to refresh for a quote this cycle was never bound to.
 */
function assertOutboundQuoteExpiryEvidenceMatchesAdmission(evidence, admission) {
  if (!admission) throw new Error('cycle-repository outbound quote expiry evidence: this cycle has no original durable admission to bind against');
  if (evidence.admissionDigest !== digest(admission)) {
    throw new Error('cycle-repository outbound quote expiry evidence: admissionDigest does not match this cycle\'s admission');
  }
  if (evidence.aggregateQuote.requestId !== admission.relay.requestId
    || evidence.aggregateQuote.deadlineUnixSeconds !== admission.relay.deadlineUnixSeconds
    || evidence.aggregateQuote.quoteDigest !== admission.relay.quoteDigest) {
    throw new Error('cycle-repository outbound quote expiry evidence: aggregateQuote does not match this cycle\'s admitted aggregate quote');
  }
  const units = admissionUnitRows(admission);
  const evidenceUnits = admission.schema === 'hookemon.policy-admission.v4' ? evidence.unitQuotes : [evidence.unitQuote];
  if (!Array.isArray(evidenceUnits) || evidenceUnits.length !== units.length || units.some((unit, i) => {
    const quote = evidenceUnits[i];
    return quote.requestId !== unit.unitRelay.requestId || quote.deadlineUnixSeconds !== unit.unitRelay.deadlineUnixSeconds || quote.quoteDigest !== unit.unitRelay.quoteDigest;
  })) throw new Error('cycle-repository outbound quote expiry evidence: unitQuote does not match this cycle\'s admitted unit quote');
}

/** Any outbound stage request digest, Relay leg, or chain attempt of any state blocks refresh. */
function hasOutboundEffectRecords(state) {
  const requestDigests = state.stageRequestDigests.get('outbound') ?? [];
  if (requestDigests.length > 0) return true;
  for (const record of state.chainAttempts.values()) {
    if (record?.attempt?.stage === 'outbound') return true;
  }
  for (const leg of state.relayLegs.values()) {
    if (leg.direction === 'outbound') return true;
  }
  return false;
}

/**
 * The single replacement-vs-original validator write and replay both call: pack/quantity, the
 * typed destination target, and the exact immutable claimed principal must match the original
 * durable admission -- only request/order IDs, quote digests/deadlines, and normalized raw quote
 * material may differ between the original and its replacement.
 */
function assertOutboundQuoteReplacementIdentity(normalized, admission, releaseAmount, label) {
  if (!admission) throw new Error(`${label}: this cycle has no original durable admission to bind against`);
  if (normalized.schema !== admission.schema || normalized.quantity !== admission.quantity
    || (admission.schema === 'hookemon.policy-admission.v4'
      ? canonicalJson(normalized.packPlan) !== canonicalJson(admission.packPlan)
      : normalized.packId !== admission.packId)) throw new Error(`${label}: replacement pack/quantity does not match the original admission`);
  if (canonicalJson(normalized.aggregatePurchase) !== canonicalJson(admission.aggregatePurchase)
    || canonicalJson(admissionUnitRows(normalized).map(unit => unit.unitPurchase)) !== canonicalJson(admissionUnitRows(admission).map(unit => unit.unitPurchase))) {
    throw new Error(`${label}: replacement destination target does not match the original admission`);
  }
  if (normalized.aggregateFundingQuote.amountAtomic !== releaseAmount) {
    throw new Error(`${label}: replacement source amount does not exactly equal the immutable release amount`);
  }
}

/**
 * REQ-cycle-repository-2's one-replacement contract: equality and past both refuse, only a
 * replacement whose deadlines are strictly later than the selection time may be selected.
 */
function assertOutboundQuoteReplacementFreshness(replacement, selectedAtMs, label) {
  const selectedUnixSeconds = Math.floor(selectedAtMs / 1000);
  if (replacement.relay.deadlineUnixSeconds <= selectedUnixSeconds
    || admissionUnitRows(replacement).some(unit => unit.unitRelay.deadlineUnixSeconds <= selectedUnixSeconds)) {
    throw new Error(`${label}: replacement quote deadlines must be strictly later than the selection time`);
  }
}

function assertCustodyLedgerTransition(previous, next, label = 'cycle-repository custody ledger') {
  if (!previous) return;
  if (previous.decimals !== next.decimals) {
    throw new Error(`${label} decimals are immutable for this cycle, chain, and asset`);
  }
  if (previous.schema === 'hookemon.custody-ledger.v3' && next.schema !== previous.schema) throw new Error(`${label} cannot downgrade native custody`);
  if (next.schema === 'hookemon.custody-ledger.v3' && previous.schema !== next.schema) throw new Error(`${label} cannot reinterpret historical custody as native`);
  if (next.schema === 'hookemon.custody-ledger.v3' && BigInt(next.gasSpent.amountAtomic) < BigInt(previous.gasSpent.amountAtomic)) throw new Error(`${label} cannot erase native gas costs`);
  if (next.schema === 'hookemon.custody-ledger.v3' && (next.gasPayments.length < previous.gasPayments.length
    || previous.gasPayments.some((payment, index) => canonicalJson(payment) !== canonicalJson(next.gasPayments[index])))) {
    throw new Error(`${label} native gas payment history is append-only`);
  }
  if (previous.schema === 'hookemon.custody-ledger.v2' && next.schema !== 'hookemon.custody-ledger.v2') {
    throw new Error(`${label} cannot downgrade from hookemon.custody-ledger.v2 to v1 for this key`);
  }
  const previousBalance = ['hookemon.custody-ledger.v2', 'hookemon.custody-ledger.v3'].includes(previous.schema) ? previous.verifiedCurrentBalance : null;
  const nextBalance = ['hookemon.custody-ledger.v2', 'hookemon.custody-ledger.v3'].includes(next.schema) ? next.verifiedCurrentBalance : null;
  // A key already exists (`previous` is non-null here): interfaces.json permits a null
  // verifiedCurrentBalance only on a key's genuine first-ever write, never on any later write to
  // that same key -- including a v1 row's first-ever v2 write, and including a v2 row that itself
  // rested at null carrying forward another null.
  if (previousBalance !== null && nextBalance === null) {
    throw new Error(`${label} cannot erase a previously recorded verifiedCurrentBalance`);
  }
  if (['hookemon.custody-ledger.v2', 'hookemon.custody-ledger.v3'].includes(next.schema) && nextBalance === null) {
    throw new Error(`${label} verifiedCurrentBalance may be null only on a key's first-ever write`);
  }
  if (previousBalance === null) return;
  if (canonicalJson(nextBalance) === canonicalJson(previousBalance)) return;
  const previousHeight = BigInt(previousBalance.finality.height);
  const nextHeight = BigInt(nextBalance.finality.height);
  if (nextHeight < previousHeight) {
    throw new Error(`${label} verifiedCurrentBalance finality height cannot go backward`);
  }
  if (nextHeight === previousHeight) {
    throw new Error(`${label} verifiedCurrentBalance conflicts with prior evidence at the same finality height`);
  }
}

/**
 * ADR-0026: `expectedCycleAsset` may be populated or cleared only by the dedicated atomic
 * return-leg creation and settlement/held-terminal writers, which each embed their ledger mutation
 * in their own journal event and never call this. The generic `custody-ledger-recorded` writer
 * (`recordCustodyLedger`, live and replayed) must always carry the field forward unchanged, so a
 * caller cannot manufacture or erase an expectation without its Relay leg.
 */
function assertCustodyLedgerExpectedAssetUnchanged(previous, next, label = 'cycle-repository custody ledger') {
  const previousExpected = ['hookemon.custody-ledger.v2', 'hookemon.custody-ledger.v3'].includes(previous?.schema) ? previous.expectedCycleAsset : null;
  const nextExpected = ['hookemon.custody-ledger.v2', 'hookemon.custody-ledger.v3'].includes(next.schema) ? next.expectedCycleAsset : null;
  if (canonicalJson(nextExpected) !== canonicalJson(previousExpected)) {
    throw new Error(`${label} expectedCycleAsset can only be populated or cleared by the dedicated return-leg expectation and settlement/held-clearing writers`);
  }
}

function custodyLedgerKey(ledger) {
  return `${ledger.chainId}\u0000${ledger.assetId}`;
}

function signOnlyPreSignBindingKey(stage, requestDigest) {
  return chainAttemptKey(stage, requestDigest);
}

function signOnlyInvocationLedgerKey(stage, requestDigest) {
  return chainAttemptKey(stage, requestDigest);
}

function chainAttemptKey(stage, requestDigest) {
  return `${stage}\u0000${requestDigest}`;
}

const SUPPLEMENTARY_CHAIN_ATTEMPT_SCHEMA = 'hookemon.supplementary-chain-attempt.v1';
const SUPPLEMENTARY_CHAIN_ATTEMPT_STATE_SET = new Set(['PREPARED', 'SIGNED', 'BROADCAST']);

function supplementaryChainAttemptKey(positionId, requestDigest) {
  return positionId + '|' + requestDigest;
}

/**
 * A position-scoped analogue of the ordinary chainAttempts (prepareChainTransactionAttempt /
 * recordSignedTransaction / recordBroadcast) state machine, for a supplementary settlement's own
 * resale/return/payout transactions. Deliberately a separate schema and a separate keyspace
 * (positionId, never a cycle's stage name) rather than reusing hookemon.chain-transaction-attempt.v1
 * -- that frozen contract's `stage` field is validated against the fixed OPERATIONAL_CYCLE_STAGES
 * enum everywhere it is consumed (money-schemas.mjs, dashboard, runner), so it structurally cannot
 * accept a per-position identifier without loosening a much more central contract. Reusing the
 * *transition rules* (PREPARED -> SIGNED -> BROADCAST) while keying by positionId instead avoids
 * any collision with a main cycle's own buyback/return chain attempts under the same cycleId.
 */
function assertSupplementaryChainAttempt(value, label) {
  exactObject(value, ['schema', 'positionId', 'requestDigest', 'state', 'rawBytes', 'nonce', 'blockhash', 'hash'], label);
  if (value.schema !== SUPPLEMENTARY_CHAIN_ATTEMPT_SCHEMA) throw new Error(label + ' schema is invalid');
  if (typeof value.positionId !== 'string' || !heldPositionIdPattern.test(value.positionId)) {
    throw new Error(label + ' positionId is invalid');
  }
  if (typeof value.requestDigest !== 'string' || !digestPattern.test(value.requestDigest)) {
    throw new Error(label + ' requestDigest is invalid');
  }
  if (!SUPPLEMENTARY_CHAIN_ATTEMPT_STATE_SET.has(value.state)) throw new Error(label + ' state is invalid');
  if (value.state === 'PREPARED') {
    if (value.rawBytes !== null || value.nonce !== null || value.blockhash !== null || value.hash !== null) {
      throw new Error(label + ' prepared state cannot contain signing material');
    }
  } else {
    if (typeof value.rawBytes !== 'string' || value.rawBytes.length === 0) throw new Error(label + ' rawBytes is invalid');
    if ((value.nonce === null) === (value.blockhash === null)) throw new Error(label + ' requires exactly one nonce or blockhash');
    if (value.nonce !== null && (typeof value.nonce !== 'string' || !decimalPattern.test(value.nonce))) throw new Error(label + ' nonce is invalid');
    if (value.blockhash !== null && (typeof value.blockhash !== 'string' || value.blockhash.length === 0)) throw new Error(label + ' blockhash is invalid');
    if (typeof value.hash !== 'string' || value.hash.length === 0) throw new Error(label + ' hash is invalid');
  }
  return structuredClone(value);
}

function transitionSupplementaryChainAttempt(value, nextState, evidence) {
  if (evidence === undefined) evidence = {};
  const permitted = { PREPARED: new Set(['SIGNED']), SIGNED: new Set(['BROADCAST']), BROADCAST: new Set() };
  if (!permitted[value.state].has(nextState)) throw new Error('supplementary chain transaction attempt transition is invalid');
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('supplementary chain transaction attempt transition evidence is invalid');
  }
  const evidenceKeys = Object.keys(evidence).sort();
  if (value.state === 'PREPARED') {
    const signingKeys = ['blockhash', 'hash', 'nonce', 'rawBytes'];
    if (evidenceKeys.length !== signingKeys.length || evidenceKeys.some((key, index) => key !== signingKeys[index])) {
      throw new Error('supplementary chain transaction attempt signing evidence is invalid');
    }
  } else if (evidenceKeys.length !== 0) {
    throw new Error('supplementary chain transaction attempt transition evidence is immutable after signing');
  }
  return assertSupplementaryChainAttempt(Object.assign({}, value, evidence, { state: nextState }), 'supplementary chain transaction attempt');
}

/**
 * Minimal recovery binding for a supplementary chain attempt's signed bytes: proves which exact
 * signed-bytes hash a durable, caller-defined recovery blob belongs to, so a restart can recover
 * (or refuse to recover) the same signed attempt rather than re-signing. Unlike the ordinary
 * chain-attempt recovery context, this does not itself model B's transaction-policy fencing/
 * approval fields -- a supplementary handler that needs those uses B's own
 * recoverTransactionPolicyApproval/Broadcast API directly and stores whatever it needs to recover
 * that call inside `context`, which this store treats as an opaque bounded value.
 */
function assertSupplementaryChainAttemptRecoveryContext(value, label) {
  exactObject(value, ['positionId', 'requestDigest', 'rawSignedBytesHash', 'context'], label);
  if (typeof value.positionId !== 'string' || !heldPositionIdPattern.test(value.positionId)) {
    throw new Error(label + ' positionId is invalid');
  }
  if (typeof value.requestDigest !== 'string' || !digestPattern.test(value.requestDigest)) {
    throw new Error(label + ' requestDigest is invalid');
  }
  if (typeof value.rawSignedBytesHash !== 'string' || value.rawSignedBytesHash.length === 0 || value.rawSignedBytesHash.length > 512) {
    throw new Error(label + ' rawSignedBytesHash is invalid');
  }
  assertBoundedCanonicalValue(value.context, label + ' context', {
    objects: RECOVERY_LIMITS.payloadObjects,
    arrays: RECOVERY_LIMITS.payloadArrays,
    arrayItems: RECOVERY_LIMITS.payloadArrayItems,
    aggregateBytes: RECOVERY_LIMITS.payloadAggregateBytes,
  });
  return structuredClone(value);
}

function payoutAssetKey(amount) {
  return `${amount.chainId}\u0000${amount.assetId}\u0000${amount.decimals}`;
}

function payoutDustSourceKey(sourceCycleId, sourceDigest) {
  return `${sourceCycleId}\u0000${sourceDigest}`;
}

function payoutQuarantineKey(planDigest, recipient) {
  return `${planDigest}\u0000${recipient}`;
}

function evmNonceLockKey(chainId, wallet) {
  return `${chainId}\u0000${wallet}`;
}

function relayLegKey(relayRequestId) {
  return relayRequestId;
}

/**
 * ADR-0026: a row can never durably hold more than one unresolved expectation. True when a
 * different RECORDED return-direction leg already targets the same resolved destination
 * chain/asset as `leg` -- a distinct destination is unaffected and independent.
 */
function unresolvedReturnLegConflict(state, leg) {
  for (const existing of state.relayLegs.values()) {
    if (existing.relayRequestId === leg.relayRequestId) continue;
    if (existing.direction === 'return' && existing.state === 'RECORDED'
      && existing.destinationChainId === leg.destinationChainId
      && existing.destinationAssetId === leg.destinationAssetId) {
      return true;
    }
  }
  return false;
}

function isEvmRelayChain(chainId) {
  return String(chainId) === '4663';
}

function canonicalRelayTransactionHash(chainId, transactionHash, label = 'Relay transaction hash') {
  if (typeof transactionHash !== 'string' || transactionHash.length === 0) {
    throw new Error(`${label} is invalid`);
  }
  if (!isEvmRelayChain(chainId)) return transactionHash;
  if (!evmTransactionHashPattern.test(transactionHash)) {
    throw new Error(`${label} must be a 32-byte EVM transaction hash`);
  }
  return transactionHash.toLowerCase();
}

function sameRelayTransactionHash(leftChainId, leftHash, rightChainId, rightHash) {
  if (leftHash === null || rightHash === null || String(leftChainId) !== String(rightChainId)) return false;
  return canonicalRelayTransactionHash(leftChainId, leftHash) === canonicalRelayTransactionHash(rightChainId, rightHash);
}

function relayTransactionReservationKey(chainId, transactionHash) {
  return `relay-transaction:${chainId}:${canonicalRelayTransactionHash(chainId, transactionHash)}`;
}

function walletNonceReservationKey(chainId, wallet) {
  return `${chainId}\u0000${wallet}`;
}

function chainAttemptRecoveryContextKey(stage, recipient, requestDigest, rawSignedBytesHash) {
  return `${stage}\u0000${recipient ?? ''}\u0000${requestDigest}\u0000${rawSignedBytesHash}`;
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !digestPattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function assertRelaySettlementAttribution(value, relayRequestId, label = 'relay settlement attribution') {
  assertPlainExactObject(value, ['schema', 'observer', 'requestId', 'memo', 'observedAmountAtomic'], label);
  if (value.schema !== relayAttributionSchema) throw new Error(`${label} schema is invalid`);
  if (value.observer !== 'process-rpc') throw new Error(`${label} must come from this process's RPC clients`);
  if (value.requestId !== relayRequestId || value.memo !== relayRequestId) {
    throw new Error(`${label} does not bind the Relay request id and memo`);
  }
  if (typeof value.observedAmountAtomic !== 'string' || !signedDecimalPattern.test(value.observedAmountAtomic)) {
    throw new Error(`${label} observed amount is invalid`);
  }
  return structuredClone(value);
}

function assertOutboundRelaySettlementInput(leg, value) {
  assertPlainObjectWithOptionalFields(value, [
    'sourceFinality',
    'destinationTxHash',
    'destinationFinality',
    'netDeltaAtomic',
    'attribution',
    'terminalState',
  ], ['refundProof'], 'relay settlement');
  if (value.terminalState !== 'SETTLED' && !RELAY_LEG_TERMINAL_STATES.includes(value.terminalState)) {
    throw new Error('relay settlement terminalState is invalid');
  }
  if (typeof value.destinationTxHash !== 'string' || value.destinationTxHash.length === 0) {
    throw new Error('relay settlement destinationTxHash is invalid');
  }
  if (typeof value.netDeltaAtomic !== 'string' || !signedDecimalPattern.test(value.netDeltaAtomic)) {
    throw new Error('relay settlement netDeltaAtomic is invalid');
  }
  const attribution = assertRelaySettlementAttribution(value.attribution, leg.relayRequestId);
  if (attribution.observedAmountAtomic !== value.netDeltaAtomic) {
    throw new Error('relay settlement attribution amount does not match its observed delta');
  }
  const transitioned = transitionRelayLeg(leg, value.terminalState, {
    finalizedAtSource: value.sourceFinality,
    destinationTxHash: value.destinationTxHash,
    finalizedAtDestination: value.destinationFinality,
    netDeltaAtomic: value.netDeltaAtomic,
  });
  if (value.terminalState === 'SETTLED' && transitioned.netDeltaAtomic !== transitioned.destinationAmountAtomic) {
    throw new Error('relay settlement delta does not equal the attributed destination amount');
  }
  if (value.terminalState === 'HELD_RELAY_REFUND' && value.refundProof === undefined) {
    throw new Error('relay refund settlement must retain its process-RPC origin credit proof');
  }
  if (value.terminalState !== 'HELD_RELAY_REFUND' && value.refundProof !== undefined) {
    throw new Error('only a Relay refund settlement may retain an origin credit proof');
  }
  return { leg: transitioned, settlement: structuredClone(value) };
}

function canonicalFinalityInteger(value, label) {
  if (typeof value === 'bigint' && value >= 0n) return value.toString();
  if (typeof value === 'string' && decimalPattern.test(value)) return value;
  throw new Error(`${label} is invalid`);
}

function observedOutboundSourceFinality(leg, sourceProof, route) {
  if (leg.schema !== 'hookemon.relay-leg.v2' || leg.sourceAssetId !== 'native' || leg.sourceDecimals !== 18
    || !isProcessNativePaymentProof(sourceProof, { kind: 'direct', chainId: '4663', assetId: 'native', decimals: 18,
      transactionHash: leg.sourceTxHash.toLowerCase(), source: route.sourceSender.toLowerCase(),
      recipient: route.sourceRecipient.toLowerCase(), amountWei: leg.sourceAmountAtomic })) {
    throw new Error('relay settlement requires an own process finalized native source proof');
  }
  return Object.freeze({ height: sourceProof.blockNumber, hash: sourceProof.blockHash, timestampUnixSeconds: sourceProof.timestampUnixSeconds });
}

function observedOutboundDestination(leg, destinationObservation, route) {
  if (!isProcessRpcRelayDestinationObservation(destinationObservation, {
    owner: route.destinationOwner,
    relayRequestId: leg.relayRequestId,
  })) {
    throw new Error('relay settlement requires an own process RPC destination observation');
  }
  if (typeof destinationObservation.transactionHash !== 'string' || destinationObservation.transactionHash.length === 0
    || typeof destinationObservation.mint !== 'string' || destinationObservation.mint.length === 0
    || typeof destinationObservation.netDeltaAtomic !== 'string' || !signedDecimalPattern.test(destinationObservation.netDeltaAtomic)) {
    throw new Error('relay settlement destination observation is invalid');
  }
  return Object.freeze({
    transactionHash: destinationObservation.transactionHash,
    mint: destinationObservation.mint,
    netDeltaAtomic: destinationObservation.netDeltaAtomic,
    finality: structuredClone(destinationObservation.finality),
    attribution: structuredClone(destinationObservation.attribution),
  });
}

function outboundRelayRecoveryContext(state, leg) {
  const attempts = [...state.chainAttempts.values()].filter(record => record?.attempt?.stage === 'outbound'
    && typeof record.attempt.hash === 'string'
    && sameRelayTransactionHash(leg.sourceChainId, record.attempt.hash, leg.sourceChainId, leg.sourceTxHash));
  if (attempts.length !== 1) {
    throw new Error('relay settlement cannot bind the source hash to one durable outbound attempt');
  }
  const attempt = attempts[0].attempt;
  const contexts = [...state.chainAttemptRecoveryContexts.values()].filter(context => context.stage === 'outbound'
    && context.recipient === null
    && context.requestDigest === attempt.requestDigest
    && context.rawSignedBytesHash === attempt.hash);
  if (contexts.length !== 1) {
    throw new Error('relay settlement has no durable signed outbound recovery context');
  }
  return contexts[0];
}

function outboundRelayQuoteDeadline(state, leg) {
  const deadline = outboundRelayRecoveryContext(state, leg).relayQuoteDeadlineUnixSeconds;
  if (typeof deadline !== 'string' || !decimalPattern.test(deadline) || BigInt(deadline) <= 0n) {
    throw new Error('relay settlement durable outbound quote deadline is invalid');
  }
  return deadline;
}

function outboundRelayRoute(state, leg) {
  const context = outboundRelayRecoveryContext(state, leg);
  const intent = context.relayIntent;
  const route = context.relayRoute;
  if (intent === null || intent === undefined || route === null || route === undefined) {
    throw new Error('relay settlement has no durable persisted outbound route accounts');
  }
  const sourceCurrency = leg.schema === 'hookemon.relay-leg.v2' && leg.sourceChainId === '4663'
    && leg.sourceAssetId === 'native' && leg.sourceDecimals === 18
    ? 'native'
    : assertEvmAddress(leg.sourceAssetId, 'relay settlement source asset');
  if (intent.requestId !== leg.relayRequestId
    || String(intent.originChainId) !== leg.sourceChainId
    || intent.originAssetId !== sourceCurrency
    || intent.originDecimals !== leg.sourceDecimals
    || intent.originAmount !== leg.sourceAmountAtomic
    || String(intent.destinationChainId) !== leg.destinationChainId
    || intent.destinationAssetId !== leg.destinationAssetId
    || intent.destinationDecimals !== leg.destinationDecimals
    || intent.quotedDestinationAmount !== leg.destinationAmountAtomic
    || intent.sender !== route.sourceSender
    || intent.recipient !== route.destinationOwner
    || String(intent.deadlineUnixSeconds) !== context.relayQuoteDeadlineUnixSeconds) {
    throw new Error('relay settlement durable outbound route does not match its recorded Relay leg');
  }
  return route;
}

function outboundRelayTerminalState(leg, { sourceFinality, destination, relayQuoteDeadlineUnixSeconds }) {
  if (destination.mint !== leg.destinationAssetId) return 'HELD_RELAY_WRONG_ASSET';
  const observedDelta = BigInt(destination.netDeltaAtomic);
  if (observedDelta <= 0n) {
    throw new Error('a destination-side debit or zero delta never proves an origin-chain Relay refund');
  }
  if (observedDelta !== BigInt(leg.destinationAmountAtomic)) return 'HELD_RELAY_PARTIAL';
  if (relayQuoteDeadlineUnixSeconds === null) {
    throw new Error('relay settlement has no durable signed outbound quote deadline');
  }
  const sourceTimestamp = BigInt(sourceFinality.timestampUnixSeconds);
  const destinationTimestamp = BigInt(destination.finality.timestampUnixSeconds);
  const deadline = BigInt(relayQuoteDeadlineUnixSeconds);
  if (destinationTimestamp < sourceTimestamp || destinationTimestamp > deadline) return 'HELD_RELAY_LATE';
  return 'SETTLED';
}

function observedOutboundRefundSettlement(state, leg, sourceFinality, refundProof, route) {
  if (!isProcessRpcOutboundRefundProof(refundProof, {
    relayRequestId: leg.relayRequestId,
    sourceTxHash: leg.sourceTxHash,
    sourceDepository: route.sourceRecipient,
  })) {
    throw new Error('relay refund settlement requires an own process RPC origin credit proof');
  }
  assertRuntimeExactObject(refundProof, [
    'schema',
    'relayRequestId',
    'terminalStatus',
    'sourceTxHash',
    'sourceFinality',
    'refundTxHash',
    'refundFinality',
    'transferCount',
    'observedToken',
    'observedSource',
    'sourceDepository',
    'nativePaymentProof',
    'observedRecipient',
    'observedAmountAtomic',
  ], 'relay refund proof');
  assertPlainExactObject(refundProof.terminalStatus, ['status', 'refundTxHash'], 'relay refund terminal status');
  if (refundProof.schema !== 'hookemon.outbound-relay-origin-refund-proof.v2'
    || leg.schema !== 'hookemon.relay-leg.v2'
    || !isProcessNativePaymentProof(refundProof.nativePaymentProof, { kind: 'relay-refund', transactionHash: refundProof.refundTxHash,
      source: refundProof.observedSource, recipient: refundProof.observedRecipient, amountWei: refundProof.observedAmountAtomic })
    || refundProof.relayRequestId !== leg.relayRequestId
    || refundProof.terminalStatus.status !== 'REFUND'
    || !sameRelayTransactionHash(leg.sourceChainId, refundProof.sourceTxHash, leg.sourceChainId, leg.sourceTxHash)
    || !sameRelayTransactionHash(leg.sourceChainId, refundProof.refundTxHash, leg.sourceChainId, refundProof.terminalStatus.refundTxHash)
    || refundProof.transferCount !== 1
    || refundProof.observedToken !== 'native'
    || refundProof.sourceDepository !== route.sourceRecipient
    || refundProof.observedRecipient !== route.sourceSender
    || typeof refundProof.observedAmountAtomic !== 'string'
    || !decimalPattern.test(refundProof.observedAmountAtomic)
    || BigInt(refundProof.observedAmountAtomic) === 0n
    || BigInt(refundProof.observedAmountAtomic) > BigInt(leg.sourceAmountAtomic)
    || canonicalJson(refundProof.sourceFinality) !== canonicalJson(sourceFinality)) {
    throw new Error('relay refund proof does not bind the durable source route and amount');
  }
  const refundFinality = assertRelayFinality(refundProof.refundFinality, 'relay refund finality');
  const deadline = BigInt(outboundRelayQuoteDeadline(state, leg));
  if (BigInt(refundFinality.timestampUnixSeconds) < BigInt(sourceFinality.timestampUnixSeconds)
    || BigInt(refundFinality.timestampUnixSeconds) > deadline) {
    throw new Error('relay refund proof is outside the durable settlement window');
  }
  return assertOutboundRelaySettlementInput(leg, {
    sourceFinality,
    destinationTxHash: refundProof.refundTxHash,
    destinationFinality: refundFinality,
    netDeltaAtomic: refundProof.observedAmountAtomic,
    attribution: {
      schema: relayAttributionSchema,
      observer: 'process-rpc',
      requestId: leg.relayRequestId,
      memo: leg.relayRequestId,
      observedAmountAtomic: refundProof.observedAmountAtomic,
    },
    terminalState: 'HELD_RELAY_REFUND',
    refundProof: structuredClone(refundProof),
  });
}

function observedOutboundRelaySettlement(state, leg, value) {
  if (leg.direction !== 'outbound') {
    throw new Error('relay settlement requires documented destination attribution for this direction');
  }
  const route = outboundRelayRoute(state, leg);
  if (Object.hasOwn(value ?? {}, 'refundProof')) {
    assertRuntimeExactObject(value, ['sourceProof', 'refundProof'], 'relay refund settlement observation');
    const sourceFinality = observedOutboundSourceFinality(leg, value.sourceProof, route);
    return observedOutboundRefundSettlement(state, leg, sourceFinality, value.refundProof, route);
  }
  assertRuntimeExactObject(value, ['sourceProof', 'destinationObservation'], 'relay settlement observation');
  const sourceFinality = observedOutboundSourceFinality(leg, value.sourceProof, route);
  const destination = observedOutboundDestination(leg, value.destinationObservation, route);
  const exactDestinationCredit = destination.mint === leg.destinationAssetId
    && BigInt(destination.netDeltaAtomic) === BigInt(leg.destinationAmountAtomic);
  const settlement = {
    sourceFinality,
    destinationTxHash: destination.transactionHash,
    destinationFinality: destination.finality,
    netDeltaAtomic: destination.netDeltaAtomic,
    attribution: destination.attribution,
    terminalState: outboundRelayTerminalState(leg, {
      sourceFinality,
      destination,
      relayQuoteDeadlineUnixSeconds: exactDestinationCredit ? outboundRelayQuoteDeadline(state, leg) : null,
    }),
  };
  return assertOutboundRelaySettlementInput(leg, settlement);
}

function finalizedReturnSource(state, leg) {
  const records = [...state.chainAttempts.values()].filter(record => record?.attempt?.stage === 'return'
    && record.attempt.state === 'FINALIZED'
    && record.finalityEvidence?.transactionHash === leg.sourceTxHash);
  if (records.length !== 1) {
    throw new Error('relay settlement requires one finalized return source attempt');
  }
  const evidence = records[0].finalityEvidence;
  if (evidence?.debitedAmountAtomic !== leg.sourceAmountAtomic) {
    throw new Error('relay settlement finalized return source amount does not match its Relay leg');
  }
  return assertRelayFinality(evidence.finalizedAtSource, 'relay settlement finalized return source finality');
}

function returnRelayTerminalState(leg, proof) {
  const expectedToken = leg.destinationAssetId.toLowerCase();
  const expectedRecipient = leg.returnAttribution.intent.recipient.toLowerCase();
  if (proof.observedToken !== expectedToken || proof.observedRecipient !== expectedRecipient) {
    return 'HELD_RELAY_WRONG_ASSET';
  }
  if (proof.observedAmountAtomic !== leg.destinationAmountAtomic) return 'HELD_RELAY_PARTIAL';
  const createdAt = BigInt(leg.returnAttribution.requestCreatedAtUnixSeconds);
  const latest = createdAt + BigInt(leg.returnAttribution.maxSettlementWindowSeconds);
  const observedAt = BigInt(proof.destinationFinality.timestampUnixSeconds);
  if (observedAt < createdAt || observedAt > latest) return 'HELD_RELAY_LATE';
  return 'SETTLED';
}

function supplementaryGasReservation(cycleId, positionId, manifestId, planDigest, proof) {
  return { cycleId, positionId, manifestId, planDigest, transactionHash: proof.transactionHash,
    transactionDigest: proof.transactionDigest, proofEvidenceDigest: proof.evidenceDigest };
}

function supplementaryGasLedger(previous, proof) {
  const { evidenceDigest, ...facts } = proof ?? {};
  if (!previous || previous.schema !== 'hookemon.custody-ledger.v3'
    || !['hookemon.native-payment-proof.v1', 'hookemon.native-transaction-gas-proof.v1'].includes(proof?.schema)
    || proof.chainId !== '4663' || proof.assetId !== 'native' || proof.decimals !== 18
    || !['success', 'reverted'].includes(proof.receiptStatus)
    || !evmTransactionHashPattern.test(proof.transactionHash) || !digestPattern.test(proof.transactionDigest)
    || typeof proof.gasSpentWei !== 'string' || !decimalPattern.test(proof.gasSpentWei)
    || digest(facts) !== evidenceDigest) throw new Error('supplementary payout gas evidence is invalid');
  const existing = previous.gasPayments.find(item => item.transactionHash === proof.transactionHash);
  if (existing && existing.amountWei !== proof.gasSpentWei) throw new Error('supplementary payout gas cost changed');
  return assertCustodyLedger({ ...previous,
    gasPayments: existing ? previous.gasPayments : [...previous.gasPayments, { transactionHash: proof.transactionHash, amountWei: proof.gasSpentWei }],
    gasSpent: { ...previous.gasSpent, amountAtomic: (BigInt(previous.gasSpent.amountAtomic) + (existing ? 0n : BigInt(proof.gasSpentWei))).toString() },
  });
}

function supplementaryNativeReturnCustody(state, amountAtomic) {
  const key = custodyLedgerKey({ chainId: '4663', assetId: 'native' });
  const previous = state.custodyLedgers.get(key);
  if (previous?.schema !== 'hookemon.custody-ledger.v3') {
    throw new Error('native supplementary return requires the existing native custody and gas reservation');
  }
  const received = BigInt(amountAtomic);
  if (received <= 0n) throw new Error('native supplementary return amount must be positive');
  return assertCustodyLedger({ ...previous, returnReceived: (BigInt(previous.returnReceived) + received).toString() });
}

function returnSettlementCustodyLedger(state, leg) {
  const key = `${leg.destinationChainId}\u0000${leg.destinationAssetId}`;
  // ADR-0026: `key` is the leg's raw destination pair (today's unchanged legacy behavior). A leg
  // recorded through `recordReturnRelayLegExpectation` is durably associated with its actual
  // caller-resolved canonical ledger key instead, which is never equal to that raw pair -- this
  // repository never treats the two as interchangeable, so it always prefers the association.
  const associatedKey = state.returnLegLedgerKeys.get(leg.relayRequestId) ?? null;
  const previous = state.custodyLedgers.get(associatedKey ?? key) ?? null;
  if (associatedKey !== null && previous === null) {
    throw new Error('relay settlement cannot locate the custody ledger durably associated with this return leg');
  }
  const received = BigInt(leg.netDeltaAtomic);
  if (received <= 0n) throw new Error('relay settlement exact return custody must be positive');
  if (previous) {
    return {
      ...previous,
      returnReceived: (BigInt(previous.returnReceived) + received).toString(),
      ...(['hookemon.custody-ledger.v2', 'hookemon.custody-ledger.v3'].includes(previous.schema) ? { expectedCycleAsset: null } : {}),
    };
  }
  return {
    schema: 'hookemon.custody-ledger.v1',
    cycleId: leg.cycleId,
    chainId: leg.destinationChainId,
    assetId: leg.destinationAssetId,
    decimals: leg.destinationDecimals,
    claimed: '0',
    bridgeOut: '0',
    bridgeIn: '0',
    packCost: '0',
    buybackProceeds: '0',
    returnInput: '0',
    returnReceived: received.toString(),
    refunds: '0',
    residual: '0',
    heldAssets: '0',
    heldPositions: '0',
    payoutLiability: '0',
    dust: '0',
    unattributed: '0',
  };
}

/**
 * ADR-0026: a HELD_RELAY_* terminal return leg clears its row's `expectedCycleAsset` to `null` in
 * its own atomic write -- current behavior otherwise writes no ledger row for a hold at all, so
 * this returns `null` (no ledger write, unchanged from today) unless a v2 row with a populated
 * expectation already exists for this leg's destination.
 */
function clearedReturnExpectationLedger(state, leg) {
  const key = state.returnLegLedgerKeys.get(leg.relayRequestId)
    ?? custodyLedgerKey({ chainId: leg.destinationChainId, assetId: leg.destinationAssetId });
  const previous = state.custodyLedgers.get(key) ?? null;
  if (previous === null || !['hookemon.custody-ledger.v2', 'hookemon.custody-ledger.v3'].includes(previous.schema) || previous.expectedCycleAsset === null) {
    return null;
  }
  return { ...previous, expectedCycleAsset: null };
}

function assertReturnRelaySettlementInput(leg, value, state) {
  assertPlainExactObject(value, [
    'sourceFinality',
    'destinationTxHash',
    'destinationFinality',
    'netDeltaAtomic',
    'returnDestinationProof',
    'terminalState',
    'custodyLedger',
  ], 'return relay settlement');
  const proof = assertReturnLegDestinationProof(value.returnDestinationProof, 'return relay settlement proof');
  if (proof.relayRequestId !== leg.relayRequestId || proof.sourceTxHash !== leg.sourceTxHash
    || proof.destinationTxHash !== value.destinationTxHash
    || canonicalJson(proof.sourceFinality) !== canonicalJson(value.sourceFinality)
    || canonicalJson(proof.destinationFinality) !== canonicalJson(value.destinationFinality)
    || proof.observedAmountAtomic !== value.netDeltaAtomic) {
    throw new Error('return relay settlement does not match its process-RPC destination proof');
  }
  const finalizedSource = finalizedReturnSource(state, leg);
  if (canonicalJson(finalizedSource) !== canonicalJson(proof.sourceFinality)) {
    throw new Error('return relay settlement source finality does not match its durable chain attempt');
  }
  const terminalState = returnRelayTerminalState(leg, proof);
  if (value.terminalState !== terminalState) {
    throw new Error('return relay settlement terminalState does not match its proof');
  }
  const transitioned = transitionRelayLeg(leg, terminalState, {
    finalizedAtSource: proof.sourceFinality,
    destinationTxHash: proof.destinationTxHash,
    finalizedAtDestination: proof.destinationFinality,
    netDeltaAtomic: proof.observedAmountAtomic,
  });
  if (terminalState === 'SETTLED') {
    const expectedLedger = returnSettlementCustodyLedger(state, transitioned);
    const ledger = assertCustodyLedger(value.custodyLedger, 'return relay settlement custody ledger');
    if (canonicalJson(ledger) !== canonicalJson(expectedLedger)) {
      throw new Error('return relay settlement custody ledger does not bind the attributed net delta');
    }
  } else {
    const expectedClearing = clearedReturnExpectationLedger(state, transitioned);
    if (expectedClearing === null) {
      if (value.custodyLedger !== null) throw new Error('return relay settlement hold cannot create payout custody');
    } else {
      const ledger = assertCustodyLedger(value.custodyLedger, 'return relay hold custody ledger');
      if (canonicalJson(ledger) !== canonicalJson(expectedClearing)) {
        throw new Error('return relay settlement hold does not clear its custody ledger expectation exactly');
      }
    }
  }
  return { leg: transitioned, settlement: structuredClone(value) };
}

function assertRelaySettlementInput(leg, value, state) {
  if (leg.direction === 'outbound') return assertOutboundRelaySettlementInput(leg, value);
  if (leg.direction === 'return') return assertReturnRelaySettlementInput(leg, value, state);
  throw new Error('relay settlement direction is invalid');
}

function observedReturnRelaySettlement(state, leg, value) {
  if (leg.schema !== 'hookemon.relay-leg.v2' || value?.returnDestinationProof?.schema !== 'hookemon.return-leg-destination-proof.v2') {
    throw new Error('native return settlement refuses historical token legs and proofs');
  }
  assertRuntimeExactObject(value, ['returnDestinationProof'], 'return relay settlement observation');
  if (leg.direction !== 'return') {
    throw new Error('return relay settlement requires a return Relay leg');
  }
  if (!isProcessRpcReturnLegDestinationProof(value.returnDestinationProof, {
    relayRequestId: leg.relayRequestId,
    sourceTxHash: leg.sourceTxHash,
  })) {
    throw new Error('relay settlement requires an own process RPC return destination proof');
  }
  const proof = assertReturnLegDestinationProof(value.returnDestinationProof, 'return relay settlement proof');
  const terminalState = returnRelayTerminalState(leg, proof);
  const provisional = transitionRelayLeg(leg, terminalState, {
    finalizedAtSource: proof.sourceFinality,
    destinationTxHash: proof.destinationTxHash,
    finalizedAtDestination: proof.destinationFinality,
    netDeltaAtomic: proof.observedAmountAtomic,
  });
  const settlement = {
    sourceFinality: proof.sourceFinality,
    destinationTxHash: proof.destinationTxHash,
    destinationFinality: proof.destinationFinality,
    netDeltaAtomic: proof.observedAmountAtomic,
    returnDestinationProof: proof,
    terminalState,
    custodyLedger: terminalState === 'SETTLED'
      ? returnSettlementCustodyLedger(state, provisional)
      : clearedReturnExpectationLedger(state, provisional),
  };
  return assertRelaySettlementInput(leg, settlement, state);
}

function assertMaxCyclesPerDay(value) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 10_000) {
    throw new Error('standing authority maxCyclesPerDay is invalid');
  }
  return value;
}

function assertWalletNonceReservationInput(cycleId, value) {
  assertPlainExactObject(value, [
    'chainId',
    'wallet',
    'stage',
    'fencingToken',
    'leaseAcquiredAtMs',
    'leaseExpiresAtMs',
  ], 'wallet nonce reservation input');
  const reservation = assertWalletNonceReservation({
    schema: 'hookemon.wallet-nonce-reservation.v1',
    chainId: canonicalChainId(value.chainId, 'wallet nonce reservation'),
    wallet: value.wallet,
    cycleId,
    stage: value.stage,
    fencingToken: value.fencingToken,
    leaseAcquiredAtMs: value.leaseAcquiredAtMs,
    leaseExpiresAtMs: value.leaseExpiresAtMs,
    state: 'HELD',
  }, 'wallet nonce reservation');
  return reservation;
}

function walletNonceReservationExpired(reservation, now) {
  return reservation.leaseExpiresAtMs <= now;
}

function validWalletNonceTakeover(previous, replacement) {
  return previous?.state === 'HELD'
    && replacement?.state === 'HELD'
    && replacement.leaseAcquiredAtMs >= previous.leaseExpiresAtMs;
}

function currentRepositoryTime(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('cycle-repository clock returned an invalid lease time');
  return value;
}

const OUTBOUND_RELAY_INTENT_FIELDS = Object.freeze([
  'schema',
  'requestId',
  'orderId',
  'direction',
  'originChainId',
  'destinationChainId',
  'originAssetId',
  'originDecimals',
  'destinationAssetId',
  'destinationDecimals',
  'originAmount',
  'quotedDestinationAmount',
  'quotedDestinationMinimumAmount',
  'sender',
  'recipient',
  'deadlineUnixSeconds',
  // The canonical Relay intent carries which trade type was quoted and the digest of the quote it
  // came from. Both are settlement identity: without them a restarted outbound cannot show that the
  // intent it is resuming belongs to the quote the cycle was admitted under, which is exactly what
  // stops a replacement quote inheriting an old authorization.
  'tradeType',
  'quoteDigest',
]);

const OUTBOUND_RELAY_TRADE_TYPES = new Set(['EXACT_INPUT', 'EXACT_OUTPUT', 'EXPECTED_OUTPUT']);

/**
 * Recovery contexts written before the intent carried its trade type and quote digest have neither
 * field. Replay completes them with null rather than a guessed value: a consumer comparing them
 * against an admitted quote then refuses, which is the correct outcome for a record that cannot
 * prove which quote it belongs to. Writes always supply both.
 */
function completeLegacyRelayIntent(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const missing = ['tradeType', 'quoteDigest'].filter(field => !Object.hasOwn(value, field));
  if (missing.length === 0) return value;
  return { ...value, ...Object.fromEntries(missing.map(field => [field, null])) };
}

function assertOutboundRelayIntent(value, label, { allowLegacyIntent = false } = {}) {
  const candidate = allowLegacyIntent ? completeLegacyRelayIntent(value) : value;
  assertPlainExactObject(candidate, OUTBOUND_RELAY_INTENT_FIELDS, label);
  value = candidate;
  if (value.schema !== 'hookemon.relay-intent.v2' || value.direction !== 'OUTBOUND') {
    throw new Error(`${label} identity is invalid`);
  }
  const legacyIdentity = allowLegacyIntent && value.tradeType === null && value.quoteDigest === null;
  if (!legacyIdentity && (!OUTBOUND_RELAY_TRADE_TYPES.has(value.tradeType)
    || typeof value.quoteDigest !== 'string' || !digestPattern.test(value.quoteDigest))) {
    throw new Error(`${label} does not bind its trade type and quote digest`);
  }
  if (typeof value.requestId !== 'string' || value.requestId.length === 0
    || typeof value.orderId !== 'string' || !evmTransactionHashPattern.test(value.orderId)
    || !Number.isSafeInteger(value.originChainId) || value.originChainId <= 0
    || !Number.isSafeInteger(value.destinationChainId) || value.destinationChainId <= 0
    || typeof value.originAssetId !== 'string' || value.originAssetId.length === 0
    || typeof value.destinationAssetId !== 'string' || value.destinationAssetId.length === 0
    || !Number.isInteger(value.originDecimals) || value.originDecimals < 0 || value.originDecimals > 255
    || !Number.isInteger(value.destinationDecimals) || value.destinationDecimals < 0 || value.destinationDecimals > 255
    || typeof value.originAmount !== 'string' || !decimalPattern.test(value.originAmount)
    || typeof value.quotedDestinationAmount !== 'string' || !decimalPattern.test(value.quotedDestinationAmount)
    || (value.quotedDestinationMinimumAmount !== null
      && (typeof value.quotedDestinationMinimumAmount !== 'string' || !decimalPattern.test(value.quotedDestinationMinimumAmount)))
    || typeof value.recipient !== 'string' || value.recipient.length === 0
    || !Number.isSafeInteger(value.deadlineUnixSeconds) || value.deadlineUnixSeconds <= 0) {
    throw new Error(`${label} is invalid`);
  }
  const nativeOrigin = value.originAssetId === 'native';
  if (nativeOrigin && (legacyIdentity || value.originChainId !== 4663 || value.originDecimals !== 18)) {
    throw new Error(`${label} native origin identity is invalid`);
  }
  return Object.freeze({
    ...structuredClone(value),
    originAssetId: nativeOrigin ? 'native' : isEvmRelayChain(value.originChainId) ? assertEvmAddress(value.originAssetId, `${label} originAssetId`) : value.originAssetId,
    sender: isEvmRelayChain(value.originChainId) ? assertEvmAddress(value.sender, `${label} sender`) : value.sender,
  });
}

function assertOutboundRelayRoute(value, label) {
  assertPlainExactObject(value, ['sourceSender', 'sourceRecipient', 'destinationOwner'], label);
  if (typeof value.destinationOwner !== 'string' || value.destinationOwner.length === 0 || value.destinationOwner.length > 512) {
    throw new Error(`${label} destinationOwner is invalid`);
  }
  return Object.freeze({
    sourceSender: assertEvmAddress(value.sourceSender, `${label} sourceSender`),
    sourceRecipient: assertEvmAddress(value.sourceRecipient, `${label} sourceRecipient`),
    destinationOwner: value.destinationOwner,
  });
}

function assertChainAttemptRecoveryContextInput(cycleId, value, { allowLegacyIntent = false } = {}) {
  const requiredFields = [
    'stage',
    'recipient',
    'requestDigest',
    'policyDigest',
    'approvalDigest',
    'fencingToken',
    'fencingTokenDigest',
    'approvedSemanticsDigest',
    'rawSignedBytesHash',
    'signedMessageDigest',
  ];
  assertPlainObjectWithOptionalFields(
    value,
    requiredFields,
    ['blockhashLastValidHeight', 'relayQuoteDeadlineUnixSeconds', 'relayIntent', 'relayRoute'],
    'chain attempt recovery context input',
  );
  assertStageName(value.stage);
  if (value.recipient !== null && (typeof value.recipient !== 'string' || value.recipient.length === 0 || value.recipient.length > 512)) {
    throw new Error('chain attempt recovery context recipient is invalid');
  }
  for (const field of [
    'requestDigest',
    'policyDigest',
    'approvalDigest',
    'fencingTokenDigest',
    'approvedSemanticsDigest',
    'signedMessageDigest',
  ]) {
    assertDigest(value[field], `chain attempt recovery context ${field}`);
  }
  assertFencingToken(value.fencingToken, 'chain attempt recovery context fencingToken');
  if (typeof value.rawSignedBytesHash !== 'string' || value.rawSignedBytesHash.length === 0 || value.rawSignedBytesHash.length > 512) {
    throw new Error('chain attempt recovery context rawSignedBytesHash is invalid');
  }
  const blockhashLastValidHeight = value.blockhashLastValidHeight === undefined ? null : value.blockhashLastValidHeight;
  if (blockhashLastValidHeight !== null && (typeof blockhashLastValidHeight !== 'string' || !decimalPattern.test(blockhashLastValidHeight))) {
    throw new Error('chain attempt recovery context blockhashLastValidHeight is invalid');
  }
  const relayQuoteDeadlineUnixSeconds = value.relayQuoteDeadlineUnixSeconds === undefined ? null : value.relayQuoteDeadlineUnixSeconds;
  if (relayQuoteDeadlineUnixSeconds !== null
    && (typeof relayQuoteDeadlineUnixSeconds !== 'string' || !decimalPattern.test(relayQuoteDeadlineUnixSeconds) || BigInt(relayQuoteDeadlineUnixSeconds) <= 0n)) {
    throw new Error('chain attempt recovery context relayQuoteDeadlineUnixSeconds is invalid');
  }
  if (relayQuoteDeadlineUnixSeconds !== null && (value.stage !== 'outbound' || value.recipient !== null)) {
    throw new Error('chain attempt recovery context relayQuoteDeadlineUnixSeconds is available only for outbound Relay attempts');
  }
  const relayIntent = value.relayIntent === undefined || value.relayIntent === null ? null : assertOutboundRelayIntent(
    value.relayIntent,
    'chain attempt recovery context relayIntent',
    { allowLegacyIntent },
  );
  const relayRoute = value.relayRoute === undefined || value.relayRoute === null ? null : assertOutboundRelayRoute(
    value.relayRoute,
    'chain attempt recovery context relayRoute',
  );
  if ((relayIntent === null) !== (relayRoute === null)) {
    throw new Error('chain attempt recovery context Relay intent and route must be persisted together');
  }
  if (relayIntent !== null && (value.stage !== 'outbound' || value.recipient !== null)) {
    throw new Error('chain attempt recovery context Relay route is available only for outbound Relay attempts');
  }
  return {
    schema: chainAttemptRecoveryContextSchema,
    cycleId,
    ...structuredClone(value),
    blockhashLastValidHeight,
    relayQuoteDeadlineUnixSeconds,
    relayIntent,
    relayRoute,
  };
}

function assertChainAttemptRecoveryContextSelector(value) {
  assertPlainExactObject(value, [
    'stage',
    'recipient',
    'requestDigest',
    'rawSignedBytesHash',
  ], 'chain attempt recovery context selector');
  assertStageName(value.stage);
  if (value.recipient !== null && (typeof value.recipient !== 'string' || value.recipient.length === 0 || value.recipient.length > 512)) {
    throw new Error('chain attempt recovery context selector recipient is invalid');
  }
  assertDigest(value.requestDigest, 'chain attempt recovery context selector requestDigest');
  if (typeof value.rawSignedBytesHash !== 'string' || value.rawSignedBytesHash.length === 0 || value.rawSignedBytesHash.length > 512) {
    throw new Error('chain attempt recovery context selector rawSignedBytesHash is invalid');
  }
  return structuredClone(value);
}

function assertStoredChainAttemptRecoveryContext(cycleId, value) {
  const requiredFields = [
    'schema',
    'cycleId',
    'stage',
    'recipient',
    'requestDigest',
    'policyDigest',
    'approvalDigest',
    'fencingToken',
    'fencingTokenDigest',
    'approvedSemanticsDigest',
    'rawSignedBytesHash',
    'signedMessageDigest',
  ];
  assertPlainObjectWithOptionalFields(
    value,
    requiredFields,
    ['blockhashLastValidHeight', 'relayQuoteDeadlineUnixSeconds', 'relayIntent', 'relayRoute'],
    'stored chain attempt recovery context',
  );
  if (value.schema !== chainAttemptRecoveryContextSchema || value.cycleId !== cycleId) {
    throw new Error('stored chain attempt recovery context identity is invalid');
  }
  const { schema, cycleId: storedCycleId, ...input } = value;
  // Replay path: a context journaled before the intent carried its trade type and quote digest is
  // still readable, with both left null rather than guessed.
  return assertChainAttemptRecoveryContextInput(cycleId, input, { allowLegacyIntent: true });
}

function recoveryContextPublicValue(context) {
  const {
    schema,
    cycleId,
    blockhashLastValidHeight,
    relayQuoteDeadlineUnixSeconds,
    relayIntent,
    relayRoute,
    ...value
  } = context;
  return structuredClone({
    ...value,
    ...(blockhashLastValidHeight === null || blockhashLastValidHeight === undefined
      ? {}
      : { blockhashLastValidHeight }),
    ...(relayQuoteDeadlineUnixSeconds === null || relayQuoteDeadlineUnixSeconds === undefined
      ? {}
      : { relayQuoteDeadlineUnixSeconds }),
    ...(relayIntent === null || relayIntent === undefined ? {} : { relayIntent }),
    ...(relayRoute === null || relayRoute === undefined ? {} : { relayRoute }),
  });
}

function isRecipientPagedRecoveryContext(context) {
  return context.stage === 'payout' && context.recipient !== null;
}

function assertPlainExactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  canonicalJson(value);
  if (Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) {
    throw new Error(`${label} must use the exact schema`);
  }
  return value;
}

/** Runtime RPC capabilities can carry bigint fields, so validate their envelope without serializing it. */
function assertRuntimeExactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  if (Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) {
    throw new Error(`${label} must use the exact schema`);
  }
  return value;
}

function assertPlainObjectWithOptionalFields(value, requiredFields, optionalFields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  canonicalJson(value);
  const keys = Object.keys(value);
  if (!requiredFields.every(field => Object.hasOwn(value, field))
    || keys.some(field => !requiredFields.includes(field) && !optionalFields.includes(field))) {
    throw new Error(`${label} must use the exact schema`);
  }
  return value;
}

function canonicalChainId(value, label) {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error(`${label} chainId is invalid`);
}

function assertPayoutAsset(value, label) {
  assertPlainExactObject(value, ['chainId', 'assetId', 'decimals'], label);
  const amount = assertTypedAmount({ ...value, chainId: canonicalChainId(value.chainId, label), amountAtomic: '0' }, label);
  return { chainId: amount.chainId, assetId: amount.assetId, decimals: amount.decimals };
}

function assertPayoutAmount(value, label, { positive = false } = {}) {
  const amount = assertTypedAmount({ ...value, chainId: canonicalChainId(value?.chainId, label) }, label);
  if (positive && BigInt(amount.amountAtomic) === 0n) throw new Error(`${label} must be positive`);
  return amount;
}

function assertEvmAddress(value, label) {
  if (typeof value !== 'string' || !evmAddressPattern.test(value)) throw new Error(`${label} is invalid`);
  return value.toLowerCase();
}

function assertFencingToken(value, label) {
  if (typeof value !== 'string' || !fencingTokenPattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function assertQuarantineReason(value, label) {
  if (typeof value !== 'string' || !quarantineReasonPattern.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function cloneEvidence(value, label) {
  canonicalJson(value);
  try {
    return structuredClone(value);
  } catch {
    throw new Error(`${label} must be cloneable`);
  }
}

function cloneChainObservationEvidence(value, label) {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a canonical object`);
  }
  return cloneEvidence(value, label);
}

function assertPayoutDustRecord(value, label = 'payout dust record') {
  assertPlainExactObject(value, ['schema', 'cycleId', 'planDigest', 'amount'], label);
  if (value.schema !== payoutDustRecordSchema) throw new Error(`${label} schema is invalid`);
  if (typeof value.cycleId !== 'string' || value.cycleId.length === 0) throw new Error(`${label} cycleId is invalid`);
  assertDigest(value.planDigest, `${label} planDigest`);
  const amount = assertPayoutAmount(value.amount, `${label} amount`, { positive: true });
  return { schema: payoutDustRecordSchema, cycleId: value.cycleId, planDigest: value.planDigest, amount };
}

function assertPayoutDustSource(value, label = 'payout dust source') {
  assertPlainExactObject(value, ['cycleId', 'digest', 'planDigest'], label);
  if (typeof value.cycleId !== 'string' || value.cycleId.length === 0) throw new Error(`${label} cycleId is invalid`);
  assertDigest(value.digest, `${label} digest`);
  assertDigest(value.planDigest, `${label} planDigest`);
  return { cycleId: value.cycleId, digest: value.digest, planDigest: value.planDigest };
}

function assertPayoutDustConsumption(value, label = 'payout dust consumption') {
  assertPlainExactObject(value, [
    'schema', 'cycleId', 'sourceCycleId', 'sourceDigest', 'sourcePlanDigest', 'amount', 'planDigest', 'authorizationKey',
  ], label);
  if (value.schema !== payoutDustConsumptionSchema) throw new Error(`${label} schema is invalid`);
  if (typeof value.cycleId !== 'string' || value.cycleId.length === 0) throw new Error(`${label} cycleId is invalid`);
  if (typeof value.sourceCycleId !== 'string' || value.sourceCycleId.length === 0) throw new Error(`${label} sourceCycleId is invalid`);
  assertDigest(value.sourceDigest, `${label} sourceDigest`);
  assertDigest(value.sourcePlanDigest, `${label} sourcePlanDigest`);
  const amount = assertPayoutAmount(value.amount, `${label} amount`, { positive: true });
  assertDigest(value.planDigest, `${label} planDigest`);
  assertDigest(value.authorizationKey, `${label} authorizationKey`);
  const consumption = {
    schema: payoutDustConsumptionSchema,
    cycleId: value.cycleId,
    sourceCycleId: value.sourceCycleId,
    sourceDigest: value.sourceDigest,
    sourcePlanDigest: value.sourcePlanDigest,
    amount,
    planDigest: value.planDigest,
    authorizationKey: value.authorizationKey,
  };
  if (payoutDustConsumptionAuthorization(consumption).key !== consumption.authorizationKey) {
    throw new Error(`${label} authorizationKey does not match its source and successor plan`);
  }
  return consumption;
}

/**
 * ADR-0026: the sole raw-to-canonical relation this repository independently recognizes for a
 * payout quarantine reservation -- chain 4663, six decimals, and a normalized (lower-case) 20-byte
 * EVM token -- matching the exact formula payout's `canonicalEvmUsdgCustodyIdentity` derives from
 * `MoneyConfigurationV1.assets.usdg`. Never a generic alias: any other chain, decimals, or
 * malformed/mixed-case token returns null and only the raw identity applies.
 */
function evmUsdgCanonicalCustodyIdentity(amount) {
  if (amount.chainId !== '4663' || amount.decimals !== 6) return null;
  if (typeof amount.assetId !== 'string' || !evmAddressPattern.test(amount.assetId)
    || amount.assetId !== amount.assetId.toLowerCase()) {
    return null;
  }
  const chainId = 'eip155:4663';
  return { chainId, assetId: `${chainId}/erc20:${amount.assetId}`, decimals: amount.decimals };
}

function assertPayoutQuarantineReservation(value, label = 'payout quarantine reservation') {
  const legacyFields = ['schema', 'cycleId', 'planDigest', 'recipient', 'amount', 'reason', 'evidence', 'ledger'];
  const currentFields = [...legacyFields, 'retries', 'settlement'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !(Object.keys(value).length === legacyFields.length || Object.keys(value).length === currentFields.length)
    || !legacyFields.every(field => Object.hasOwn(value, field))
    || (Object.keys(value).length === currentFields.length
      && !['retries', 'settlement'].every(field => Object.hasOwn(value, field)))) {
    throw new Error(`${label} must use the exact schema`);
  }
  if (value.schema !== payoutQuarantineSchema) throw new Error(`${label} schema is invalid`);
  if (typeof value.cycleId !== 'string' || value.cycleId.length === 0) throw new Error(`${label} cycleId is invalid`);
  assertDigest(value.planDigest, `${label} planDigest`);
  const recipient = assertEvmAddress(value.recipient, `${label} recipient`);
  if (recipient !== value.recipient) throw new Error(`${label} recipient must be lower-case`);
  const amount = assertPayoutAmount(value.amount, `${label} amount`, { positive: true });
  const reason = assertQuarantineReason(value.reason, `${label} reason`);
  const evidence = cloneChainObservationEvidence(value.evidence, `${label} evidence`);
  const ledger = assertCustodyLedger(value.ledger, `${label} custody ledger`);
  // The old rule required the embedded custody row to sit at the exact raw amount identity; a
  // canonical-v2 reservation instead sits at the independently recomputed canonical identity for
  // the one recognized USDG relation. Both are checked here so historical raw-identity journal
  // entries keep replaying under the original rule while new reservations validate against the
  // canonical row they actually reserved against -- never a caller-supplied identity taken on trust.
  const canonical = evmUsdgCanonicalCustodyIdentity(amount);
  const identityMatches = (ledger.chainId === amount.chainId && ledger.assetId === amount.assetId)
    || (canonical !== null && ledger.chainId === canonical.chainId && ledger.assetId === canonical.assetId);
  if (ledger.cycleId !== value.cycleId || !identityMatches || ledger.decimals !== amount.decimals) {
    throw new Error(`${label} custody ledger does not match the quarantined amount`);
  }
  const retries = value.retries === undefined ? [] : assertPayoutQuarantineRetries(value.retries, `${label} retries`);
  const settlement = value.settlement === undefined || value.settlement === null
    ? null
    : assertPayoutQuarantineSettlement(value.settlement, `${label} settlement`, { cycleId: value.cycleId, planDigest: value.planDigest, recipient });
  return {
    schema: payoutQuarantineSchema,
    cycleId: value.cycleId,
    planDigest: value.planDigest,
    recipient,
    amount,
    reason,
    evidence,
    ledger,
    retries,
    settlement,
  };
}

function assertPayoutQuarantineRetry(value, label = 'payout quarantine retry') {
  assertPlainObjectWithOptionalFields(value, [
    'retryId', 'requestId', 'requestedAtMs', 'originalTransactionHash', 'resolution',
  ], ['refusalEvidence', 'processProof'], label);
  assertDigest(value.retryId, `${label} retryId`);
  if (typeof value.requestId !== 'string' || !requestIdPattern.test(value.requestId)) throw new Error(`${label} requestId is invalid`);
  if (!Number.isSafeInteger(value.requestedAtMs) || value.requestedAtMs < 0) throw new Error(`${label} requestedAtMs is invalid`);
  if (typeof value.originalTransactionHash !== 'string' || !evmTransactionHashPattern.test(value.originalTransactionHash)) {
    throw new Error(`${label} originalTransactionHash is invalid`);
  }
  if (value.resolution !== null) {
    assertPlainExactObject(value.resolution, ['state', 'transactionHash'], `${label} resolution`);
    if (value.resolution.state !== 'REFUSED'
      || typeof value.resolution.transactionHash !== 'string'
      || !evmTransactionHashPattern.test(value.resolution.transactionHash)) {
      throw new Error(`${label} resolution is invalid`);
    }
  }
  return {
    retryId: value.retryId,
    requestId: value.requestId,
    requestedAtMs: value.requestedAtMs,
    originalTransactionHash: value.originalTransactionHash.toLowerCase(),
    resolution: value.resolution === null ? null : {
      state: 'REFUSED',
      transactionHash: value.resolution.transactionHash.toLowerCase(),
    },
    refusalEvidence: value.refusalEvidence === undefined || value.refusalEvidence === null
      ? null
      : cloneChainObservationEvidence(value.refusalEvidence, `${label} refusalEvidence`),
    processProof: value.processProof === undefined || value.processProof === null
      ? null
      : cloneChainObservationEvidence(value.processProof, `${label} processProof`),
  };
}

function assertPayoutQuarantineRetries(value, label = 'payout quarantine retries') {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((retry, index) => assertPayoutQuarantineRetry(retry, `${label}[${index}]`));
}

function assertPayoutQuarantineSettlement(value, label = 'payout quarantine settlement', binding = {}) {
  assertPlainObjectWithOptionalFields(
    value,
    ['retryId', 'transactionHash', 'amount', 'settledAtMs', 'proofDigest'],
    ['finalizedTransfer', 'payoutRetry'],
    label,
  );
  if (value.retryId !== null) assertDigest(value.retryId, `${label} retryId`);
  if (typeof value.transactionHash !== 'string' || !evmTransactionHashPattern.test(value.transactionHash)) {
    throw new Error(`${label} transactionHash is invalid`);
  }
  const amount = assertPayoutAmount(value.amount, `${label} amount`, { positive: true });
  if (!Number.isSafeInteger(value.settledAtMs) || value.settledAtMs < 0) throw new Error(`${label} settledAtMs is invalid`);
  assertDigest(value.proofDigest, `${label} proofDigest`);
  const finalizedTransfer = value.finalizedTransfer === undefined
    ? null
    : cloneChainObservationEvidence(value.finalizedTransfer, `${label} finalizedTransfer`);
  const payoutRetry = value.payoutRetry === undefined || value.payoutRetry === null
    ? null
    : cloneChainObservationEvidence(value.payoutRetry, `${label} payoutRetry`);
  if (binding.cycleId !== undefined && typeof binding.cycleId !== 'string') throw new Error(`${label} cycleId binding is invalid`);
  if (binding.planDigest !== undefined && value.retryId !== null) assertDigest(binding.planDigest, `${label} planDigest binding`);
  if (binding.recipient !== undefined && typeof binding.recipient !== 'string') throw new Error(`${label} recipient binding is invalid`);
  return {
    retryId: value.retryId,
    transactionHash: value.transactionHash.toLowerCase(),
    amount,
    settledAtMs: value.settledAtMs,
    proofDigest: value.proofDigest,
    payoutRetry,
    finalizedTransfer,
  };
}

function assertEvmNonceLock(value, label = 'EVM nonce lock') {
  assertPlainExactObject(value, ['schema', 'cycleId', 'chainId', 'wallet', 'fencingToken', 'previousFencingToken'], label);
  if (value.schema !== evmNonceLockSchema) throw new Error(`${label} schema is invalid`);
  if (typeof value.cycleId !== 'string' || value.cycleId.length === 0) throw new Error(`${label} cycleId is invalid`);
  if (typeof value.chainId !== 'string' || value.chainId.length === 0) throw new Error(`${label} chainId is invalid`);
  const wallet = assertEvmAddress(value.wallet, `${label} wallet`);
  if (wallet !== value.wallet) throw new Error(`${label} wallet must be lower-case`);
  const fencingToken = assertFencingToken(value.fencingToken, `${label} fencingToken`);
  if (value.previousFencingToken !== null) assertFencingToken(value.previousFencingToken, `${label} previousFencingToken`);
  return {
    schema: evmNonceLockSchema,
    cycleId: value.cycleId,
    chainId: value.chainId,
    wallet,
    fencingToken,
    previousFencingToken: value.previousFencingToken,
  };
}

function assertEvmNonceLockRelease(value, label = 'EVM nonce lock release') {
  assertPlainExactObject(value, ['schema', 'cycleId', 'chainId', 'wallet', 'fencingToken'], label);
  if (value.schema !== evmNonceLockSchema) throw new Error(`${label} schema is invalid`);
  if (typeof value.cycleId !== 'string' || value.cycleId.length === 0) throw new Error(`${label} cycleId is invalid`);
  if (typeof value.chainId !== 'string' || value.chainId.length === 0) throw new Error(`${label} chainId is invalid`);
  const wallet = assertEvmAddress(value.wallet, `${label} wallet`);
  if (wallet !== value.wallet) throw new Error(`${label} wallet must be lower-case`);
  return {
    schema: evmNonceLockSchema,
    cycleId: value.cycleId,
    chainId: value.chainId,
    wallet,
    fencingToken: assertFencingToken(value.fencingToken, `${label} fencingToken`),
  };
}

function payoutDustConsumptionAuthorization(consumption) {
  const source = {
    cycleId: consumption.sourceCycleId,
    digest: consumption.sourceDigest,
    planDigest: consumption.sourcePlanDigest,
    amount: consumption.amount,
  };
  const actionDigest = digest({
    domain: 'hookemon.payout-dust-consumption-action.v1',
    cycleId: consumption.cycleId,
    planDigest: consumption.planDigest,
    source,
  });
  return {
    key: consumption.authorizationKey,
    nonceKey: digest({ domain: 'hookemon.payout-dust-consumption-source.v1', source }),
    cycleId: consumption.cycleId,
    actionKind: 'payout',
    authorizationKind: 'asset-spend',
    actionDigest,
    subjectDigest: consumption.sourceDigest,
    commitment: digest({ domain: 'hookemon.payout-dust-consumption-commitment.v1', actionDigest, source }),
    // This anti-replay index records a deterministic custody fact rather than a wall-clock approval.
    // A stable value makes an interrupted commit retry byte-identical.
    validatedAt: '1970-01-01T00:00:00.000Z',
  };
}

function payoutDustConsumptionFor(cycleId, { source: sourceValue, amount: amountValue, planDigest }) {
  const amount = assertPayoutAmount(amountValue, 'payout dust consumption amount');
  assertDigest(planDigest, 'payout dust consumption planDigest');
  if (sourceValue === null) {
    if (amount.amountAtomic !== '0') throw new Error('cycle-repository consumePayoutDust: a nonzero amount requires provenance');
    return null;
  }
  const source = assertPayoutDustSource(sourceValue, 'payout dust consumption source');
  if (source.cycleId === cycleId) throw new Error('cycle-repository consumePayoutDust: a cycle cannot consume its own successor dust');
  if (amount.amountAtomic === '0') throw new Error('cycle-repository consumePayoutDust: provenance must carry a positive amount');
  const sourceKey = payoutDustSourceKey(source.cycleId, source.digest);
  const authorizationKey = digest({
    domain: 'hookemon.payout-dust-consumption.v1',
    cycleId,
    source,
    amount,
    planDigest,
  });
  const consumption = {
    schema: payoutDustConsumptionSchema,
    cycleId,
    sourceCycleId: source.cycleId,
    sourceDigest: source.digest,
    sourcePlanDigest: source.planDigest,
    amount,
    planDigest,
    authorizationKey,
  };
  return {
    source,
    sourceKey,
    amount,
    consumption,
    authorization: payoutDustConsumptionAuthorization(consumption),
  };
}

function chainAttemptFor(state, stage, requestDigest, operation) {
  if (typeof requestDigest !== 'string' || requestDigest.length === 0) {
    throw new Error(`cycle-repository ${operation}: requestDigest is required`);
  }
  return state.chainAttempts.get(chainAttemptKey(stage, requestDigest)) ?? null;
}

function evidenceDigest(domain, cycleId, stage, evidence) {
  return digest({ domain, cycleId, stage, evidence: cloneEvidence(evidence, `${domain} evidence`) });
}

/**
 * `terminalAtMs`/`completedAtMs` were added after this event kind shipped. A stored entry from
 * before that change legitimately omits it; a new one always carries it. Never fabricated from an
 * HTTP request time -- only from this repository's own clock at the moment of the durable write.
 */
function assertOptionalTerminalAtMs(value, label) {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} terminalAtMs is invalid`);
  return value;
}

function assertTerminalPayloadShape(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  canonicalJson(value);
  const keys = Object.keys(value);
  const required = ['terminalState', 'evidence'];
  const hasRequired = required.every(field => Object.hasOwn(value, field));
  const extra = keys.filter(key => !required.includes(key));
  if (!hasRequired || (extra.length > 0 && (extra.length > 1 || extra[0] !== 'terminalAtMs'))) {
    throw new Error(`${label} must use the exact schema`);
  }
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  canonicalJson(value);
  if (Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) {
    throw new Error(`${label} must use the exact schema`);
  }
  return value;
}

function assertHeldPositionText(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertHeldPositionAtomic(value, label) {
  if (typeof value !== 'string' || !decimalPattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function assertHeldPositionLedgerAsset(value, label) {
  exactObject(value, ['chainId', 'assetId', 'decimals'], label);
  const amount = assertTypedAmount({ ...value, amountAtomic: '0' }, label);
  return {
    chainId: amount.chainId,
    assetId: amount.assetId,
    decimals: amount.decimals,
  };
}

function heldPositionId({ cycleId, memo, mint, cardRef }) {
  return `held:${digest({
    schema: 'hookemon.held-position-identity.v1',
    cycleId,
    memo,
    mint,
    cardRef,
  }).slice('sha256:'.length)}`;
}

function heldPositionEvidenceDigest(position, evidence) {
  return digest({
    schema: Object.hasOwn(position, 'costMicroUsd') ? 'hookemon.held-position-evidence.v2' : 'hookemon.held-position-evidence.v1',
    cycleId: position.cycleId,
    packId: position.packId,
    memo: position.memo,
    mint: position.mint,
    cardRef: position.cardRef,
    ...(Object.hasOwn(position, 'costMicroUsd') ? { costMicroUsd: position.costMicroUsd, valueMicroUsd: position.valueMicroUsd } : { costMicroUsdg: position.costMicroUsdg, valueMicroUsdg: position.valueMicroUsdg }),
    insuredValue: position.insuredValue,
    reason: position.reason,
    terminalState: position.terminalState,
    evidence: cloneEvidence(evidence, 'held position evidence'),
  });
}

function heldPositionIdentityEvidenceDigest(positionId, positionEvidenceDigest, mint, provenance) {
  return digest({
    schema: 'hookemon.held-position-identity.v1',
    positionId,
    positionEvidenceDigest,
    mint,
    provenance,
  });
}

function assertHeldPositionIdentity(value, position, label = 'held position identity') {
  if (value === null) return null;
  exactObject(value, ['mint', 'verifiedAtMs', 'evidenceDigest', 'provenance'], label);
  const mint = assertHeldPositionText(value.mint, `${label}.mint`);
  if (!Number.isSafeInteger(value.verifiedAtMs) || value.verifiedAtMs < 0) {
    throw new Error(`${label}.verifiedAtMs is invalid`);
  }
  const provenance = value.provenance;
  const legacyProvenance = ['memo', 'openSignature', 'packStatusMint', 'derivedMint', 'custodyOwner'];
  const currentProvenance = [...legacyProvenance, 'openSignatureSource', 'assetKind'];
  const provenanceKeys = Object.keys(provenance ?? {});
  const isLegacy = provenanceKeys.length === legacyProvenance.length
    && legacyProvenance.every(field => provenanceKeys.includes(field));
  exactObject(provenance, isLegacy ? legacyProvenance : currentProvenance, `${label}.provenance`);
  for (const field of ['memo', 'openSignature', 'packStatusMint', 'derivedMint', 'custodyOwner']) {
    if (typeof provenance[field] !== 'string' || provenance[field].length === 0) {
      throw new Error(`${label}.provenance.${field} is invalid`);
    }
  }
  if (!isLegacy && !['held-evidence', 'open-evidence', 'collector-finalized-send'].includes(provenance.openSignatureSource)) {
    throw new Error(`${label}.provenance.openSignatureSource is invalid`);
  }
  if (!isLegacy && !['spl', 'mpl-core'].includes(provenance.assetKind)) {
    throw new Error(`${label}.provenance.assetKind is invalid`);
  }
  if (position !== undefined) {
    if (provenance.memo !== position.memo) throw new Error(`${label}.provenance.memo does not match the held position`);
    if (provenance.packStatusMint !== mint || provenance.derivedMint !== mint) {
      throw new Error(`${label}.provenance mint does not match the verified identity`);
    }
  }
  if (typeof value.evidenceDigest !== 'string' || !digestPattern.test(value.evidenceDigest)) {
    throw new Error(`${label}.evidenceDigest is invalid`);
  }
  return {
    mint,
    verifiedAtMs: value.verifiedAtMs,
    evidenceDigest: value.evidenceDigest,
    provenance: cloneEvidence(provenance, `${label}.provenance`),
  };
}

function assertHeldPositionOwnerDecision(value, label = 'held position owner decision') {
  exactObject(value, ['positionId', 'heldEvidenceDigest', 'requestId', 'expectedRevision', 'choice'], label);
  if (typeof value.positionId !== 'string' || !heldPositionIdPattern.test(value.positionId)) {
    throw new Error(`${label}.positionId is invalid`);
  }
  if (typeof value.heldEvidenceDigest !== 'string' || !digestPattern.test(value.heldEvidenceDigest)) {
    throw new Error(`${label}.heldEvidenceDigest is invalid`);
  }
  if (typeof value.requestId !== 'string' || !requestIdPattern.test(value.requestId)) {
    throw new Error(`${label}.requestId is invalid`);
  }
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) {
    throw new Error(`${label}.expectedRevision is invalid`);
  }
  if (!HELD_OWNER_DECISION_CHOICES.has(value.choice)) throw new Error(`${label}.choice is invalid`);
  return cloneEvidence(value, label);
}

function heldPositionOwnerDecisionInput(positionId, value) {
  exactObject(value, ['heldEvidenceDigest', 'requestId', 'expectedRevision', 'choice'], 'held position owner decision input');
  return assertHeldPositionOwnerDecision({ positionId, ...value }, 'held position owner decision input');
}

function heldPositionResolutionEvidenceDigest(position, terminalState, evidence) {
  return digest({
    schema: 'hookemon.held-position-resolution-evidence.v1',
    positionId: position.positionId,
    cycleId: position.cycleId,
    heldEvidenceDigest: position.evidenceDigest,
    terminalState,
    evidence: cloneEvidence(evidence, 'held position resolution evidence'),
  });
}

function assertHeldPositionResolution(value, label = 'held position resolution') {
  exactObject(value, ['terminalState', 'evidenceDigest', 'resolvedAtMs', 'evidence'], label);
  if (!HELD_POSITION_RESOLUTION_TERMINAL_STATES.has(value.terminalState)) {
    throw new Error(`${label}.terminalState is invalid`);
  }
  if (typeof value.evidenceDigest !== 'string' || !digestPattern.test(value.evidenceDigest)) {
    throw new Error(`${label}.evidenceDigest is invalid`);
  }
  if (!Number.isSafeInteger(value.resolvedAtMs) || value.resolvedAtMs < 0) {
    throw new Error(`${label}.resolvedAtMs is invalid`);
  }
  return {
    terminalState: value.terminalState,
    evidenceDigest: value.evidenceDigest,
    resolvedAtMs: value.resolvedAtMs,
    evidence: cloneEvidence(value.evidence, `${label}.evidence`),
  };
}

function heldPositionResolutionInput(position, value, nowMs) {
  exactObject(value, ['heldEvidenceDigest', 'expectedRevision', 'terminalState', 'evidence'], 'held position resolution input');
  if (value.heldEvidenceDigest !== position.evidenceDigest) {
    throw new Error('held position resolution input does not bind the held evidence digest');
  }
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) {
    throw new Error('held position resolution input expectedRevision is invalid');
  }
  if (value.expectedRevision !== position.positionRevision) {
    throw new Error('held position resolution input has a stale position revision');
  }
  const evidence = cloneEvidence(value.evidence, 'held position resolution input evidence');
  return assertHeldPositionResolution({
    terminalState: value.terminalState,
    evidenceDigest: heldPositionResolutionEvidenceDigest(position, value.terminalState, evidence),
    resolvedAtMs: nowMs,
    evidence,
  }, 'held position resolution input');
}

function completedEligibilitySnapshotEvidenceDigest(state, cycleId) {
  const snapshot = state.stages.get('eligibility-snapshot') ?? null;
  if (snapshot?.status !== 'COMPLETE') {
    throw new Error('supplementary settlement requires the original completed eligibility snapshot');
  }
  return digest(snapshot.evidence);
}

function assertNativeAssetId(value, label) { if (value !== 'native') throw new Error(`${label} must be native`); return value; }

function assertSupplementaryPayoutSourceAmountHistorical(value, label, usdgAddress) {
  const amount = assertPayoutAmount(value, label);
  const assetId = assertEvmAddress(amount.assetId, `${label}.assetId`);
  if (amount.chainId !== '4663' || amount.decimals !== 6 || assetId !== usdgAddress) {
    throw new Error(`${label} must identify the bound chain 4663 six-decimal USDG asset`);
  }
  return {
    chainId: 4663,
    assetId,
    decimals: 6,
    amountAtomic: amount.amountAtomic,
  };
}

function assertSupplementaryReturnBindingHistorical(value, label) {
  exactObject(value, ['operations', 'usdgAddress', 'evidenceDigest'], label);
  return {
    operations: assertEvmAddress(value.operations, `${label}.operations`),
    usdgAddress: assertEvmAddress(value.usdgAddress, `${label}.usdgAddress`),
    evidenceDigest: assertDigest(value.evidenceDigest, `${label}.evidenceDigest`),
  };
}

function assertSupplementaryFinalizedReturnEvidenceHistorical(value, settlement, label) {
  exactObject(value, [
    'schema',
    'positionId',
    'cycleId',
    'manifestId',
    'operations',
    'usdgAddress',
    'amountAtomic',
    'finalityEvidence',
  ], label);
  if (value.schema !== 'hookemon.supplementary-finalized-return.v1') throw new Error(`${label}.schema is invalid`);
  if (value.positionId !== settlement.positionId || value.cycleId !== settlement.cycleId
    || value.manifestId !== settlement.manifestId) {
    throw new Error(`${label} does not bind its supplementary settlement`);
  }
  const operations = assertEvmAddress(value.operations, `${label}.operations`);
  const usdgAddress = assertEvmAddress(value.usdgAddress, `${label}.usdgAddress`);
  const amountAtomic = assertHeldPositionAtomic(value.amountAtomic, `${label}.amountAtomic`);
  const finalityEvidence = cloneChainObservationEvidence(value.finalityEvidence, `${label}.finalityEvidence`);
  const normalized = {
    schema: 'hookemon.supplementary-finalized-return.v1',
    positionId: settlement.positionId,
    cycleId: settlement.cycleId,
    manifestId: settlement.manifestId,
    operations,
    usdgAddress,
    amountAtomic,
    finalityEvidence,
  };
  return {
    evidence: normalized,
    finalizedReturn: {
      chainId: 4663,
      assetId: usdgAddress,
      decimals: 6,
      amountAtomic,
    },
    returnBinding: {
      operations,
      usdgAddress,
      evidenceDigest: digest({
        schema: 'hookemon.supplementary-finalized-return-binding.v1',
        positionId: settlement.positionId,
        cycleId: settlement.cycleId,
        manifestId: settlement.manifestId,
        finalizedReturnEvidence: normalized,
      }),
    },
  };
}

function assertSupplementaryReturnBoundaryEvidenceHistorical(value, settlement, label) {
  exactObject(value, ['schema', 'positionId', 'cycleId', 'manifestId', 'finalizedReturnEvidence'], label);
  if (value.schema !== 'hookemon.supplementary-return-boundary.v1') throw new Error(`${label}.schema is invalid`);
  if (value.positionId !== settlement.positionId || value.cycleId !== settlement.cycleId
    || value.manifestId !== settlement.manifestId) {
    throw new Error(`${label} does not bind its supplementary settlement`);
  }
  const finalized = assertSupplementaryFinalizedReturnEvidenceHistorical(
    value.finalizedReturnEvidence,
    settlement,
    `${label}.finalizedReturnEvidence`,
  );
  return {
    schema: 'hookemon.supplementary-return-boundary.v1',
    positionId: settlement.positionId,
    cycleId: settlement.cycleId,
    manifestId: settlement.manifestId,
    finalizedReturnEvidence: finalized.evidence,
    finalizedReturn: finalized.finalizedReturn,
    returnBinding: finalized.returnBinding,
  };
}

function assertSupplementaryPayoutSourceHistorical(value, settlement, label = 'supplementary payout source') {
  exactObject(value, [
    'schema',
    'positionId',
    'cycleId',
    'manifestId',
    'finalizedReturn',
    'previousDust',
    'previousDustSource',
    'returnBinding',
  ], label);
  if (value.schema !== 'hookemon.supplementary-payout-source.v1') throw new Error(`${label}.schema is invalid`);
  if (value.positionId !== settlement.positionId || value.cycleId !== settlement.cycleId
    || value.manifestId !== settlement.manifestId) {
    throw new Error(`${label} does not bind its supplementary settlement`);
  }
  const returnBinding = assertSupplementaryReturnBindingHistorical(value.returnBinding, `${label}.returnBinding`);
  const finalizedReturn = assertSupplementaryPayoutSourceAmountHistorical(
    value.finalizedReturn,
    `${label}.finalizedReturn`,
    returnBinding.usdgAddress,
  );
  const previousDust = assertSupplementaryPayoutSourceAmountHistorical(
    value.previousDust,
    `${label}.previousDust`,
    returnBinding.usdgAddress,
  );
  const previousDustSource = value.previousDustSource === null
    ? null
    : assertPayoutDustSource(value.previousDustSource, `${label}.previousDustSource`);
  if ((previousDust.amountAtomic === '0') !== (previousDustSource === null)) {
    throw new Error(`${label} previous dust provenance is invalid`);
  }
  if (previousDustSource !== null && previousDustSource.cycleId !== settlement.cycleId) {
    throw new Error(`${label} must use the original cycle's normal payout dust source`);
  }
  return {
    schema: 'hookemon.supplementary-payout-source.v1',
    positionId: settlement.positionId,
    cycleId: settlement.cycleId,
    manifestId: settlement.manifestId,
    finalizedReturn,
    previousDust,
    previousDustSource,
    returnBinding,
  };
}

function assertSupplementaryPayoutSourceAmount(value, label, expectedAssetId) {
  const amount = assertPayoutAmount(value, label);
  const assetId = amount.assetId;
  if (amount.chainId !== '4663' || amount.decimals !== 18 || assetId !== 'native' || expectedAssetId !== 'native') {
    throw new Error(`${label} must identify the bound chain 4663 native ETH asset`);
  }
  return {
    chainId: '4663',
    assetId,
    decimals: 18,
    amountAtomic: amount.amountAtomic,
  };
}

function assertSupplementaryReturnBinding(value, label) {
  exactObject(value, ['operations', 'assetId', 'evidenceDigest'], label);
  return {
    operations: assertEvmAddress(value.operations, `${label}.operations`),
    assetId: assertNativeAssetId(value.assetId, `${label}.assetId`),
    evidenceDigest: assertDigest(value.evidenceDigest, `${label}.evidenceDigest`),
  };
}

function assertSupplementaryFinalizedReturnEvidence(value, settlement, label) {
  exactObject(value, [
    'schema',
    'positionId',
    'cycleId',
    'manifestId',
    'operations',
    'assetId',
    'amountAtomic',
    'finalityEvidence',
  ], label);
  if (value.schema !== supplementaryFinalizedReturnSchema) throw new Error(`${label}.schema is invalid`);
  if (value.positionId !== settlement.positionId || value.cycleId !== settlement.cycleId
    || value.manifestId !== settlement.manifestId) {
    throw new Error(`${label} does not bind its supplementary settlement`);
  }
  const operations = assertEvmAddress(value.operations, `${label}.operations`);
  const assetId = assertNativeAssetId(value.assetId, `${label}.assetId`);
  const amountAtomic = assertHeldPositionAtomic(value.amountAtomic, `${label}.amountAtomic`);
  const finalityEvidence = cloneChainObservationEvidence(value.finalityEvidence, `${label}.finalityEvidence`);
  const normalized = {
    schema: supplementaryFinalizedReturnSchema,
    positionId: settlement.positionId,
    cycleId: settlement.cycleId,
    manifestId: settlement.manifestId,
    operations,
    assetId,
    amountAtomic,
    finalityEvidence,
  };
  return {
    evidence: normalized,
    finalizedReturn: {
      chainId: '4663',
      assetId: assetId,
      decimals: 18,
      amountAtomic,
    },
    returnBinding: {
      operations,
      assetId,
      evidenceDigest: digest({
        schema: 'hookemon.supplementary-finalized-return-binding.v2',
        positionId: settlement.positionId,
        cycleId: settlement.cycleId,
        manifestId: settlement.manifestId,
        finalizedReturnEvidence: normalized,
      }),
    },
  };
}

function assertSupplementaryReturnBoundaryEvidence(value, settlement, label) {
  exactObject(value, ['schema', 'positionId', 'cycleId', 'manifestId', 'finalizedReturnEvidence'], label);
  if (value.schema !== supplementaryReturnBoundarySchema) throw new Error(`${label}.schema is invalid`);
  if (value.positionId !== settlement.positionId || value.cycleId !== settlement.cycleId
    || value.manifestId !== settlement.manifestId) {
    throw new Error(`${label} does not bind its supplementary settlement`);
  }
  const finalized = assertSupplementaryFinalizedReturnEvidence(
    value.finalizedReturnEvidence,
    settlement,
    `${label}.finalizedReturnEvidence`,
  );
  return {
    schema: supplementaryReturnBoundarySchema,
    positionId: settlement.positionId,
    cycleId: settlement.cycleId,
    manifestId: settlement.manifestId,
    finalizedReturnEvidence: finalized.evidence,
    finalizedReturn: finalized.finalizedReturn,
    returnBinding: finalized.returnBinding,
  };
}

function assertSupplementaryPayoutSource(value, settlement, label = 'supplementary payout source') {
  exactObject(value, [
    'schema',
    'positionId',
    'cycleId',
    'manifestId',
    'finalizedReturn',
    'previousDust',
    'previousDustSource',
    'returnBinding',
  ], label);
  if (value.schema !== supplementaryPayoutSourceSchema) throw new Error(`${label}.schema is invalid`);
  if (value.positionId !== settlement.positionId || value.cycleId !== settlement.cycleId
    || value.manifestId !== settlement.manifestId) {
    throw new Error(`${label} does not bind its supplementary settlement`);
  }
  const returnBinding = assertSupplementaryReturnBinding(value.returnBinding, `${label}.returnBinding`);
  const finalizedReturn = assertSupplementaryPayoutSourceAmount(
    value.finalizedReturn,
    `${label}.finalizedReturn`,
    returnBinding.assetId,
  );
  const previousDust = assertSupplementaryPayoutSourceAmount(
    value.previousDust,
    `${label}.previousDust`,
    returnBinding.assetId,
  );
  const previousDustSource = value.previousDustSource === null
    ? null
    : assertPayoutDustSource(value.previousDustSource, `${label}.previousDustSource`);
  if ((previousDust.amountAtomic === '0') !== (previousDustSource === null)) {
    throw new Error(`${label} previous dust provenance is invalid`);
  }
  if (previousDustSource !== null && previousDustSource.cycleId !== settlement.cycleId) {
    throw new Error(`${label} must use the original cycle's normal payout dust source`);
  }
  return {
    schema: supplementaryPayoutSourceSchema,
    positionId: settlement.positionId,
    cycleId: settlement.cycleId,
    manifestId: settlement.manifestId,
    finalizedReturn,
    previousDust,
    previousDustSource,
    returnBinding,
  };
}

function supplementaryPayoutSourceWithoutDustHistorical(settlement, returnBoundary, label) {
  return assertSupplementaryPayoutSourceHistorical({
    schema: 'hookemon.supplementary-payout-source.v1',
    positionId: settlement.positionId,
    cycleId: settlement.cycleId,
    manifestId: settlement.manifestId,
    finalizedReturn: returnBoundary.finalizedReturn,
    previousDust: {
      chainId: 4663,
      assetId: returnBoundary.returnBinding.usdgAddress,
      decimals: 6,
      amountAtomic: '0',
    },
    previousDustSource: null,
    returnBinding: returnBoundary.returnBinding,
  }, settlement, label);
}

function supplementaryPayoutSourceWithoutDust(settlement, returnBoundary, label) {
  return assertSupplementaryPayoutSource({
    schema: supplementaryPayoutSourceSchema,
    positionId: settlement.positionId,
    cycleId: settlement.cycleId,
    manifestId: settlement.manifestId,
    finalizedReturn: returnBoundary.finalizedReturn,
    previousDust: {
      chainId: '4663',
      assetId: returnBoundary.returnBinding.assetId,
      decimals: 18,
      amountAtomic: '0',
    },
    previousDustSource: null,
    returnBinding: returnBoundary.returnBinding,
  }, settlement, label);
}

function supplementaryPayoutSourceForReturnBoundary(settlement, returnBoundary, label) {
  // Main-cycle dust is not supplementary proceeds. The generic dust consumer identifies a
  // successor by cycleId and therefore cannot atomically reserve a same-cycle position. Until a
  // position-aware reservation exists, omitting that dust is the only safe outcome.
  return returnBoundary.schema === 'hookemon.supplementary-return-boundary.v1'
    ? supplementaryPayoutSourceWithoutDustHistorical(settlement, returnBoundary, label)
    : supplementaryPayoutSourceWithoutDust(settlement, returnBoundary, label);
}

function supplementarySettlementEvidenceFor(settlement, state, evidence, payoutSource = null, returnBoundary = null, evidenceSchema = supplementarySettlementEvidenceSchema) {
  const record = {
    state,
    evidenceDigest: digest({
      schema: evidenceSchema,
      positionId: settlement.positionId,
      manifestId: settlement.manifestId,
      state,
      evidence,
      ...(payoutSource === null ? {} : { payoutSourceDigest: settlement.payoutSourceDigest }),
    }),
    evidence,
  };
  if (payoutSource !== null) record.payoutSource = payoutSource;
  if (returnBoundary !== null) record.returnBoundary = returnBoundary;
  return record;
}

function durableSupplementaryReturnBoundary(settlement, evidenceRecord, label) {
  const returnBoundary = evidenceRecord?.state === 'RETURN_BROADCAST'
    ? evidenceRecord
    : evidenceRecord?.returnBoundary ?? null;
  if (returnBoundary === null || typeof returnBoundary !== 'object') {
    throw new Error(`${label} is missing the durable return boundary`);
  }
  if (returnBoundary.state !== 'RETURN_BROADCAST') {
    throw new Error(`${label} has an invalid durable return boundary state`);
  }
  const payoutSource = (returnBoundary.payoutSource?.schema === 'hookemon.supplementary-payout-source.v1'
    ? assertSupplementaryPayoutSourceHistorical : assertSupplementaryPayoutSource)(
    returnBoundary.payoutSource,
    settlement,
    `${label} payout source`,
  );
  if (digest(payoutSource) !== settlement.payoutSourceDigest) {
    throw new Error(`${label} does not match the settlement payout source digest`);
  }
  return {
    state: 'RETURN_BROADCAST',
    evidenceDigest: assertDigest(returnBoundary.evidenceDigest, `${label} evidence digest`),
    evidence: cloneEvidence(returnBoundary.evidence, `${label} evidence`),
    payoutSource,
  };
}

function supplementarySettlementFor(position, index, eligibilitySnapshotEvidenceDigest) {
  if (!Number.isSafeInteger(index) || index < 1) throw new Error('supplementary settlement index is invalid');
  assertDigest(eligibilitySnapshotEvidenceDigest, 'supplementary settlement eligibility snapshot evidence digest');
  return Object.freeze({
    positionId: position.positionId,
    cycleId: position.cycleId,
    manifestId: `${position.cycleId}:supplementary:${index}`,
    state: 'PREPARED',
    positionEvidenceDigest: position.evidenceDigest,
    eligibilitySnapshotEvidenceDigest,
    payoutSourceDigest: null,
  });
}

function assertSupplementarySettlement(value, label = 'supplementary settlement') {
  exactObject(value, [
    'positionId',
    'cycleId',
    'manifestId',
    'state',
    'positionEvidenceDigest',
    'eligibilitySnapshotEvidenceDigest',
    'payoutSourceDigest',
  ], label);
  if (typeof value.positionId !== 'string' || !heldPositionIdPattern.test(value.positionId)) {
    throw new Error(`${label}.positionId is invalid`);
  }
  if (typeof value.cycleId !== 'string' || value.cycleId.length === 0) throw new Error(`${label}.cycleId is invalid`);
  if (typeof value.manifestId !== 'string' || !value.manifestId.startsWith(`${value.cycleId}:supplementary:`)) {
    throw new Error(`${label}.manifestId is invalid`);
  }
  if (!SUPPLEMENTARY_SETTLEMENT_STATES.has(value.state)) throw new Error(`${label}.state is invalid`);
  if (typeof value.positionEvidenceDigest !== 'string' || !digestPattern.test(value.positionEvidenceDigest)) {
    throw new Error(`${label}.positionEvidenceDigest is invalid`);
  }
  if (typeof value.eligibilitySnapshotEvidenceDigest !== 'string' || !digestPattern.test(value.eligibilitySnapshotEvidenceDigest)) {
    throw new Error(`${label}.eligibilitySnapshotEvidenceDigest is invalid`);
  }
  if (['RETURN_BROADCAST', 'PAYOUT_BROADCAST', 'COMPLETE'].includes(value.state)) {
    if (typeof value.payoutSourceDigest !== 'string' || !digestPattern.test(value.payoutSourceDigest)) {
      throw new Error(`${label}.payoutSourceDigest is required after the supplementary return boundary`);
    }
  } else if (value.payoutSourceDigest !== null) {
    throw new Error(`${label}.payoutSourceDigest is invalid before the supplementary return boundary`);
  }
  return structuredClone(value);
}

function assertHeldPosition(value, label = 'held position') {
  const native = Object.hasOwn(value ?? {}, 'costMicroUsd');
  const costKey = native ? 'costMicroUsd' : 'costMicroUsdg';
  const valueKey = native ? 'valueMicroUsd' : 'valueMicroUsdg';
  const fields = [
    'positionId',
    'cycleId',
    'packId',
    'memo',
    'mint',
    'cardRef',
    costKey,
    valueKey,
    'insuredValue',
    'reason',
    'terminalState',
    'evidenceDigest',
    'openedAtMs',
    'positionRevision',
    'ownerDecision',
    'resolution',
  ];
  const legacy = !Object.hasOwn(value ?? {}, 'identity');
  exactObject(value, legacy ? fields : [...fields, 'identity'], label);
  if (typeof value.positionId !== 'string' || !heldPositionIdPattern.test(value.positionId)) {
    throw new Error(`${label}.positionId is invalid`);
  }
  const cycleId = assertHeldPositionText(value.cycleId, `${label}.cycleId`);
  const packId = assertHeldPositionText(value.packId, `${label}.packId`);
  const memo = assertHeldPositionText(value.memo, `${label}.memo`);
  const mint = assertHeldPositionText(value.mint, `${label}.mint`, { nullable: true });
  const cardRef = assertHeldPositionText(value.cardRef, `${label}.cardRef`);
  if (value.positionId !== heldPositionId({ cycleId, memo, mint, cardRef })) {
    throw new Error(`${label}.positionId does not bind its card identity`);
  }
  const costMicroUsdg = assertHeldPositionAtomic(value[costKey], `${label}.costMicroUsdg`);
  const valueMicroUsdg = assertHeldPositionAtomic(value[valueKey], `${label}.valueMicroUsdg`);
  if (native && costMicroUsdg !== valueMicroUsdg) throw new Error(`${label} native held value must equal purchase cost`);
  const insuredValue = value.insuredValue === null ? null : assertTypedAmount(value.insuredValue, `${label}.insuredValue`);
  if (typeof value.reason !== 'string' || !quarantineReasonPattern.test(value.reason)) {
    throw new Error(`${label}.reason is invalid`);
  }
  if (!HELD_POSITION_TERMINAL_STATES.has(value.terminalState)) {
    throw new Error(`${label}.terminalState is invalid`);
  }
  if (typeof value.evidenceDigest !== 'string' || !digestPattern.test(value.evidenceDigest)) {
    throw new Error(`${label}.evidenceDigest is invalid`);
  }
  if (!Number.isSafeInteger(value.openedAtMs) || value.openedAtMs < 0) {
    throw new Error(`${label}.openedAtMs is invalid`);
  }
  if (!Number.isSafeInteger(value.positionRevision) || value.positionRevision < 0) {
    throw new Error(`${label}.positionRevision is invalid`);
  }
  const ownerDecision = value.ownerDecision === null
    ? null
    : assertHeldPositionOwnerDecision(value.ownerDecision, `${label}.ownerDecision`);
  if (ownerDecision !== null) {
    if (ownerDecision.positionId !== value.positionId || ownerDecision.heldEvidenceDigest !== value.evidenceDigest) {
      throw new Error(`${label}.ownerDecision does not bind the held position`);
    }
    if (ownerDecision.expectedRevision + 1 > value.positionRevision) {
      throw new Error(`${label}.ownerDecision revision transition is invalid`);
    }
  } else if (value.positionRevision !== 0 && value.resolution === null) {
    throw new Error(`${label}.positionRevision requires an owner decision`);
  }
  const resolution = value.resolution === null
    ? null
    : assertHeldPositionResolution(value.resolution, `${label}.resolution`);
  if (resolution !== null) {
    const minimumRevision = ownerDecision === null ? 1 : ownerDecision.expectedRevision + 2;
    if (value.positionRevision !== minimumRevision) {
      throw new Error(`${label}.resolution revision transition is invalid`);
    }
    if (resolution.evidenceDigest !== heldPositionResolutionEvidenceDigest({
      positionId: value.positionId,
      cycleId,
      evidenceDigest: value.evidenceDigest,
    }, resolution.terminalState, resolution.evidence)) {
      throw new Error(`${label}.resolution evidence digest does not bind the position`);
    }
  }
  const identity = legacy ? null : assertHeldPositionIdentity(value.identity, {
    memo,
  }, `${label}.identity`);
  return {
    positionId: value.positionId,
    cycleId,
    packId,
    memo,
    mint,
    cardRef,
    [costKey]: costMicroUsdg,
    [valueKey]: valueMicroUsdg,
    insuredValue,
    reason: value.reason,
    terminalState: value.terminalState,
    evidenceDigest: value.evidenceDigest,
    openedAtMs: value.openedAtMs,
    positionRevision: value.positionRevision,
    ownerDecision,
    resolution,
    identity,
  };
}

function heldPositionInput(cycleId, value, openedAtMs) {
  const fields = [
    'packId',
    'memo',
    'mint',
    'cardRef',
    'costMicroUsd',
    'valueMicroUsd',
    'insuredValue',
    'reason',
    'terminalState',
    'evidence',
  ];
  if (Object.hasOwn(value ?? {}, 'ledgerAsset')) fields.push('ledgerAsset');
  exactObject(value, fields, 'held position input');
  const evidence = cloneEvidence(value.evidence, 'held position input evidence');
  if (value.ledgerAsset !== undefined) throw new Error('native held USD cost cannot be written into an asset principal ledger');
  const ledgerAsset = value.ledgerAsset === undefined
    ? null
    : assertHeldPositionLedgerAsset(value.ledgerAsset, 'held position input ledgerAsset');
  const base = {
    cycleId,
    packId: value.packId,
    memo: value.memo,
    mint: value.mint,
    cardRef: value.cardRef,
    costMicroUsd: value.costMicroUsd,
    valueMicroUsd: value.valueMicroUsd,
    insuredValue: value.insuredValue,
    reason: value.reason,
    terminalState: value.terminalState,
  };
  const position = assertHeldPosition({
    positionId: heldPositionId(base),
    ...base,
    evidenceDigest: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    openedAtMs,
    positionRevision: 0,
    ownerDecision: null,
    resolution: null,
    identity: null,
  }, 'held position input');
  return {
    position: assertHeldPosition({
      ...position,
      evidenceDigest: heldPositionEvidenceDigest(position, evidence),
    }, 'held position input'),
    evidence,
    ledgerAsset,
  };
}

const HELD_POSITION_CANONICAL_CHAIN_ID = 'eip155:4663';
const HELD_POSITION_CANONICAL_ASSET_PREFIX = `${HELD_POSITION_CANONICAL_CHAIN_ID}/erc20:`;
const HELD_POSITION_CANONICAL_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

/**
 * ADR-0026's one recognized raw-to-canonical USDG relation, mirrored exactly from
 * evmUsdgCanonicalCustodyIdentity: chain 4663, six decimals, a normalized lower-case 20-byte EVM
 * token. Anything else -- wrong chain, wrong decimals, or an eip155:4663/erc20:-prefixed suffix
 * that is not itself a normalized 20-byte address -- is not this relation and returns null, so
 * it is never treated as an authoritative canonical row.
 */
function heldPositionCanonicalRawKey(asset) {
  if (asset.chainId !== HELD_POSITION_CANONICAL_CHAIN_ID || asset.decimals !== 6) return null;
  if (typeof asset.assetId !== 'string' || !asset.assetId.startsWith(HELD_POSITION_CANONICAL_ASSET_PREFIX)) return null;
  const address = asset.assetId.slice(HELD_POSITION_CANONICAL_ASSET_PREFIX.length);
  if (!HELD_POSITION_CANONICAL_ADDRESS_PATTERN.test(address)) return null;
  return `4663\u0000${address}`;
}

/**
 * ADR-0026: a live write -- asset is the caller-resolved {chainId, assetId, decimals} triple from
 * heldPositionInput, never a stored ledger -- against the recognized canonical identity lands on
 * the exact row claim and payout already maintain for it: verifiedCurrentBalance and
 * expectedCycleAsset carry forward byte-for-byte on an existing v2 row, a hypothetical canonical
 * v1 predecessor upgrades to v2 with an honest null observation (never fabricated), and the write
 * refuses outright if the legacy raw identity for this same asset is also durable, before any
 * append.
 *
 * Replay instead passes the event's own already-validated stored ledger (assertCustodyLedger
 * output, which always carries schema); that stored schema, taken as targetSchema directly rather
 * than re-derived from the identity shape, is exactly what a live write would have computed at the
 * moment this event was originally appended, so a previously durable row -- raw or canonical, v1 or
 * v2 -- always replays back to itself byte-for-byte. The raw-predecessor coexistence refusal only
 * ever runs for a live write: replay must never reject an event that was valid when it was appended
 * just because a later rule would have refused it today.
 */
function heldPositionCustodyLedger(custodyLedgers, cycleId, asset, position) {
  const key = `${asset.chainId}\u0000${asset.assetId}`;
  const storedSchema = Object.hasOwn(asset, 'schema') ? asset.schema : null;
  const isLiveWrite = storedSchema === null;
  const canonicalRawKey = isLiveWrite ? heldPositionCanonicalRawKey(asset) : null;
  if (isLiveWrite && canonicalRawKey !== null && custodyLedgers.has(canonicalRawKey)) {
    throw new Error('held position custody ledger refuses: a legacy raw-identity custody row exists for this asset');
  }
  const targetSchema = storedSchema ?? (canonicalRawKey === null ? 'hookemon.custody-ledger.v1' : 'hookemon.custody-ledger.v2');
  const previous = custodyLedgers.get(key) ?? null;
  if (previous !== null) {
    if (previous.decimals !== asset.decimals) {
      throw new Error('held position custody ledger decimals are immutable for this cycle and asset');
    }
    const base = previous.schema !== targetSchema
      ? { ...previous, schema: targetSchema, verifiedCurrentBalance: null, expectedCycleAsset: null }
      : previous;
    return assertCustodyLedger({
      ...base,
      heldPositions: (BigInt(previous.heldPositions) + BigInt(position.valueMicroUsdg)).toString(),
    }, 'held position custody ledger');
  }
  const buckets = Object.fromEntries(CUSTODY_LEDGER_BUCKETS.map(bucket => [
    bucket,
    bucket === 'heldPositions' ? position.valueMicroUsdg : '0',
  ]));
  return assertCustodyLedger({
    schema: targetSchema,
    cycleId,
    chainId: asset.chainId,
    assetId: asset.assetId,
    decimals: asset.decimals,
    ...buckets,
    ...(targetSchema === 'hookemon.custody-ledger.v2' ? { verifiedCurrentBalance: null, expectedCycleAsset: null } : {}),
  }, 'held position custody ledger');
}

/**
 * A retry that matches an already-recorded position's evidence digest still names a candidate
 * ledger identity; silently returning the existing position without checking it would let identity
 * drift (a since-changed configured asset, or a raw row that has since appeared) through unnoticed.
 * ledgerAsset === null retries a position that was never attributed to a custody row and always
 * matches.
 */
function assertHeldPositionLedgerAssociation(state, positionId, ledgerAsset) {
  const recordedKey = state.heldPositionLedgerKeys.get(positionId) ?? null;
  if (ledgerAsset === null) {
    if (recordedKey !== null) {
      throw new Error('cycle-repository recordHeldPosition: retry omits the custody ledger identity the position was actually recorded with');
    }
    return;
  }
  const expectedKey = `${ledgerAsset.chainId}\u0000${ledgerAsset.assetId}`;
  if (recordedKey !== expectedKey) {
    throw new Error('cycle-repository recordHeldPosition: retry supplies a custody ledger identity that does not match the position\'s recorded row');
  }
  const recordedLedger = state.custodyLedgers.get(recordedKey) ?? null;
  if (recordedLedger === null || recordedLedger.decimals !== ledgerAsset.decimals) {
    throw new Error('cycle-repository recordHeldPosition: retry supplies custody ledger decimals that do not match the position\'s recorded row');
  }
  const rawKey = heldPositionCanonicalRawKey(ledgerAsset);
  if (rawKey !== null && state.custodyLedgers.has(rawKey)) {
    throw new Error('cycle-repository recordHeldPosition: retry cannot be validated while a legacy raw-identity custody row exists for this asset');
  }
}

function resolvedHeldPositionCustodyLedger(custodyLedgers, key, position) {
  const previous = custodyLedgers.get(key) ?? null;
  if (previous === null || BigInt(previous.heldPositions) < BigInt(position.valueMicroUsdg)) {
    throw new Error('held position resolution has no attributable held custody ledger');
  }
  return assertCustodyLedger({
    ...previous,
    heldPositions: (BigInt(previous.heldPositions) - BigInt(position.valueMicroUsdg)).toString(),
  }, 'resolved held position custody ledger');
}

function hasOpenHeldPositions(state) {
  return [...state.heldPositions.values()].some(position => position.resolution === null);
}

function heldPositionOwnerDecisionTransition(position, decision) {
  if (decision.heldEvidenceDigest !== position.evidenceDigest) {
    throw new Error('cycle-repository recordHeldOwnerDecision: held evidence digest does not match the position');
  }
  if (position.resolution !== null) {
    throw new Error('cycle-repository recordHeldOwnerDecision: held position is already resolved');
  }
  const existing = position.ownerDecision;
  if (existing !== null) {
    if (existing.requestId === decision.requestId) {
      if (canonicalJson(existing) === canonicalJson(decision)) return { position, decision: existing };
      throw new Error('cycle-repository recordHeldOwnerDecision: requestId conflict');
    }
    if (existing.choice === 'keep-holding' && decision.choice === 'keep-holding') {
      return { position, decision: existing };
    }
    if (existing.choice === 'sell') {
      throw new Error('cycle-repository recordHeldOwnerDecision: held position already has a sell decision');
    }
  }
  if (decision.expectedRevision !== position.positionRevision) {
    throw new Error('cycle-repository recordHeldOwnerDecision: stale position revision');
  }
  const updated = assertHeldPosition({
    ...position,
    positionRevision: position.positionRevision + 1,
    ownerDecision: decision,
  }, 'held position owner decision transition');
  return { position: updated, decision };
}

function heldOwnerDecisionEvidenceDigest(cycleId, evidence) {
  return digest({
    schema: 'hookemon.cycle-held-owner-decision.v1',
    cycleId,
    terminalState: HELD_OWNER_DECISION,
    evidence: cloneEvidence(evidence, 'held owner decision evidence'),
  });
}

function assertHeldOwnerDecision(value, label = 'held owner decision') {
  exactObject(value, ['cycleId', 'heldEvidenceDigest', 'requestId', 'expectedRevision', 'choice'], label);
  if (typeof value.cycleId !== 'string' || value.cycleId.length === 0) throw new Error(`${label}.cycleId is invalid`);
  if (typeof value.heldEvidenceDigest !== 'string' || !digestPattern.test(value.heldEvidenceDigest)) {
    throw new Error(`${label}.heldEvidenceDigest is invalid`);
  }
  if (typeof value.requestId !== 'string' || !requestIdPattern.test(value.requestId)) {
    throw new Error(`${label}.requestId is invalid`);
  }
  if (!Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) {
    throw new Error(`${label}.expectedRevision is invalid`);
  }
  if (!HELD_OWNER_DECISION_CHOICES.has(value.choice)) throw new Error(`${label}.choice is invalid`);
  return cloneEvidence(value, label);
}

function heldOwnerDecisionInput(cycleId, value) {
  exactObject(value, ['heldEvidenceDigest', 'requestId', 'expectedRevision', 'choice'], 'held owner decision input');
  return assertHeldOwnerDecision({ cycleId, ...value }, 'held owner decision input');
}

function assertHeldOwnerDecisionTransition(state, decision) {
  if (state.terminalState !== HELD_OWNER_DECISION || state.heldEvidenceDigest === null) {
    throw new Error('cycle-repository recordHeldOwnerDecision: cycle is not held for an owner decision');
  }
  if (decision.heldEvidenceDigest !== state.heldEvidenceDigest) {
    throw new Error('cycle-repository recordHeldOwnerDecision: held evidence digest does not match the cycle hold');
  }
  if (state.ownerDecision !== null) {
    if (canonicalJson(state.ownerDecision) === canonicalJson(decision)) return structuredClone(state.ownerDecision);
    throw new Error('cycle-repository recordHeldOwnerDecision: held owner decision conflict');
  }
  if (decision.expectedRevision !== state.version) {
    throw new Error('cycle-repository recordHeldOwnerDecision: stale cycle revision');
  }
  return null;
}

function assertReconciledCompletion(state, stage, evidence) {
  if (stage === 'purchase' && state.admission?.schema === 'hookemon.policy-admission.v4') {
    const batch = state.packBatchRequests.get('purchase');
    if (batch?.generationComplete !== true || !Array.isArray(evidence?.packs) || evidence.packs.length !== state.admission.quantity
      || evidence.packs.some((pack, i) => pack.packIndex !== i || pack.memo !== batch.packs[i].memo)) {
      throw new Error('plan purchase requires reconciliation of every admitted order');
    }
  }
  const operational = state.operationalAttempts.get(stage);
  if (operational) {
    if (operational.attempt.state !== 'RECONCILED') {
      throw new Error(`cycle-repository completeStage: "${stage}" requires reconciled operational evidence`);
    }
    if (canonicalJson(operational.reconciliationEvidence) !== canonicalJson(evidence)) {
      throw new Error(`cycle-repository completeStage: "${stage}" evidence must match reconciled operational evidence`);
    }
  }
  for (const chain of state.chainAttempts.values()) {
    if (chain.attempt.stage === stage && chain.attempt.state !== 'FINALIZED') {
      throw new Error(`cycle-repository completeStage: "${stage}" requires finalized chain evidence`);
    }
  }
}

function assertPreparedOrderedCompletion(state, stage) {
  if (!state.preparedStages.has(stage)) {
    throw new Error(`cycle-repository completeStage: stage "${stage}" was not prepared`);
  }
  const stageIndex = OPERATIONAL_CYCLE_STAGES.indexOf(stage);
  for (const predecessor of OPERATIONAL_CYCLE_STAGES.slice(0, stageIndex)) {
    if (state.stages.get(predecessor)?.status !== 'COMPLETE') {
      throw new Error(`cycle-repository completeStage: "${stage}" requires completed predecessor "${predecessor}"`);
    }
  }
}

function assertCycleClosure(state) {
  for (const stage of OPERATIONAL_CYCLE_STAGES) {
    if (state.stages.get(stage)?.status !== 'COMPLETE') {
      throw new Error(`cycle-repository completeCycle: requires every operational stage complete; "${stage}" is pending`);
    }
  }
  for (const [stage, operational] of state.operationalAttempts) {
    if (operational.attempt.state !== 'RECONCILED') {
      throw new Error(`cycle-repository completeCycle: unresolved provider attempt for "${stage}"`);
    }
  }
  for (const [stage, chain] of state.chainAttempts) {
    if (chain.attempt.state !== 'FINALIZED') {
      throw new Error(`cycle-repository completeCycle: unfinalized chain attempt for "${stage}"`);
    }
  }
  for (const ledger of state.custodyLedgers.values()) {
    for (const bucket of ['heldAssets', 'payoutLiability', 'refunds', 'residual', 'dust', 'unattributed']) {
      if (BigInt(ledger[bucket]) > 0n) {
        throw new Error(`cycle-repository completeCycle: unclosed custody ${bucket} for ${ledger.chainId}/${ledger.assetId}`);
      }
    }
  }
}

function supplementaryValuationLeg(source) {
  return { relayRequestId: source.relayRequestId, returnAttribution: { schema: 'hookemon.return-leg-attribution-context.v2',
    intent: source.intent, destinationUsd: source.destinationUsd, destinationUsdEvidence: source.destinationUsdEvidence } };
}
function supplementaryRealizedProceeds(source, proof) {
  if (!source?.destinationUsd || !source?.destinationUsdEvidence) return null;
  validateNativeReturnValuation(supplementaryValuationLeg(source));
  const usd = source.destinationUsd;
  const settledAt = Number(proof.destinationFinality.timestampUnixSeconds) * 1000;
  if (usd.amount?.chainId !== '4663' || usd.amount.assetId !== 'native' || usd.amount.decimals !== 18
    || usd.amount.amountAtomic !== proof.observedAmountAtomic || usd.rounding !== 'down'
    || usd.sourcePath !== 'details.currencyOut.amountUsd' || usd.quoteRequestId !== proof.relayRequestId
    || !Number.isSafeInteger(settledAt) || settledAt < usd.observedAtMs || settledAt >= usd.validUntilMs) return null;
  return { destinationUsd: structuredClone(usd), destinationUsdEvidence: structuredClone(source.destinationUsdEvidence),
    relayRequestId: source.relayRequestId, intent: structuredClone(source.intent) };
}

function validateNativeReturnValuation(leg) {
  const attribution = leg.returnAttribution;
  if (attribution?.schema !== 'hookemon.return-leg-attribution-context.v2') throw new Error('native return requires frozen destination USD provenance');
  const value = attribution.destinationUsd, evidence = attribution.destinationUsdEvidence, quote = evidence.quote;
  if (evidence.valuationDigest !== digest(value) || evidence.rawDigest !== digest(quote.raw) || digest(evidence.request) !== value.requestDigest
    || relayQuoteDigest(quote) !== value.quoteDigest || quote.quoteDigest !== value.quoteDigest
    || quote.requestId !== leg.relayRequestId || quote.orderId !== attribution.intent.orderId) throw new Error('native return valuation evidence differs from the exact quote');
  if (evidence.request.destinationCurrency !== '0x0000000000000000000000000000000000000000' || evidence.request.destinationChainId !== 4663) throw new Error('native return valuation request destination is invalid');
  const parsed = parseQuoteResponse(quote.raw, { direction: 'RETURN', ...evidence.request, destinationCurrency: undefined });
  if (parsed.quoteDigest !== quote.quoteDigest) throw new Error('native return valuation response does not match its request');
  const [whole, fraction = ''] = quote.raw.details.currencyOut.amountUsd.split('.');
  if (!/^(0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(quote.raw.details.currencyOut.amountUsd)
    || (BigInt(whole) * 1000000n + BigInt(fraction.slice(0, 6).padEnd(6, '0'))).toString() !== value.amountMicroUsd) throw new Error('native return USD proceeds must round down from the exact response');
}

function isNativeAdmission(value) {
  return value?.schema === 'hookemon.policy-admission.v3' || value?.schema === 'hookemon.policy-admission.v4';
}
function admissionUnitRows(admission) {
  return admission.schema === 'hookemon.policy-admission.v4' ? admission.orders : [admission];
}
function validateNativeAdmissionProvenance(provenance, admission, cycleId) {
  const plan = admission.schema === 'hookemon.policy-admission.v4';
  exactObject(provenance, ['schema', 'cycleId', 'authority', 'admissionDigest', plan ? 'units' : 'unit', 'aggregate'], 'native admission provenance');
  if (provenance.schema !== (plan ? 'hookemon.native-admission-provenance.v2' : 'hookemon.native-admission-provenance.v1')
    || provenance.cycleId !== cycleId || provenance.admissionDigest !== digest(admission)) {
    throw new Error('native admission provenance differs from its immutable cycle admission');
  }
  const units = plan ? provenance.units : [provenance.unit];
  if (!Array.isArray(units) || units.length !== admissionUnitRows(admission).length) throw new Error('native admission unit provenance mismatch');
  const legs = admissionUnitRows(admission).map((unit, i) => [units[i], unit.unitFundingUsd, unit.unitRelayQuote]);
  legs.push([provenance.aggregate, admission.aggregateFundingUsd, admission.relayQuote]);
  for (const [evidence, value, quote] of legs) {
    exactObject(evidence, ['request', 'rawDigest', 'valuationDigest'], 'native valuation provenance');
    if (evidence.valuationDigest !== digest(value) || evidence.rawDigest !== digest(quote.raw)
      || digest(evidence.request) !== value.requestDigest || quote.quoteDigest !== value.quoteDigest
      || quote.requestId !== value.quoteRequestId) throw new Error('native valuation provenance request or response mismatch');
  }
  return provenance;
}

function assertPackOrderReconciliation(admission, batch, orderIndex, outcomes) {
  const order = admission?.schema === 'hookemon.policy-admission.v4' ? admission.orders[orderIndex] : null;
  if (!order || !batch || !Array.isArray(outcomes) || outcomes.length !== order.quantity) throw new Error('pack order reconciliation requires the complete generated order');
  return outcomes.map((outcome, i) => {
    const pack = batch.packs[i];
    if (!outcome || outcome.packIndex !== pack.packIndex || outcome.memo !== pack.memo || !['purchased', 'not_purchased'].includes(outcome.status)) throw new Error('pack order reconciliation identity is invalid');
    if (outcome.status === 'purchased') {
      const cost = assertTypedAmount(outcome.packCost, 'pack order observed debit');
      if (typeof outcome.signature !== 'string' || !outcome.signature || outcome.expectedCardCount !== pack.expectedCardCount
        || ![order.unitPurchase.chainId, 'solana-mainnet'].includes(cost.chainId) || cost.assetId !== order.unitPurchase.assetId
        || cost.decimals !== order.unitPurchase.decimals || BigInt(cost.amountAtomic) <= 0n
        || BigInt(cost.amountAtomic) > BigInt(order.unitPurchase.amountAtomic)) throw new Error('pack order reconciliation exceeds its admitted debit or identity');
    }
    return structuredClone(outcome);
  });
}

function applyPackOrderEvent({ admission, cycleId, payload, kind, intents, requests, requestDigests }) {
  const order = admission?.schema === 'hookemon.policy-admission.v4' ? admission.orders[payload.orderIndex] : null;
  if (!order || !Number.isSafeInteger(payload.orderIndex) || payload.orderIndex < 0 || payload.stage !== 'purchase') {
    throw new Error('pack order event requires an admitted plan order');
  }
  const key = `purchase:${payload.orderIndex}`;
  if (kind === 'pack-order-intent-recorded') {
    const intent = assertPackBatchIntent(payload.intent, 'pack order intent');
    if (!(requestDigests.get('purchase') ?? []).includes(payload.requestDigest)) throw new Error('pack order intent requires the recorded parent request digest');
    if (intent.packType !== order.packId || intent.quantity !== order.quantity || payload.admissionDigest !== digest(admission)
      || !digestPattern.test(payload.requestDigest ?? '') || !Number.isSafeInteger(payload.recordedAtMs) || payload.recordedAtMs < 0) {
      throw new Error('pack order intent does not bind its admission');
    }
    if (intents.has('purchase') && intents.get('purchase').intent.playerAddress !== intent.playerAddress) throw new Error('pack order player differs from the cycle purchase');
    if (payload.orderIndex > 0 && !requests.has(`purchase:${payload.orderIndex - 1}`)) throw new Error('pack orders must generate in sequence');
    const record = { intent, admissionDigest: payload.admissionDigest, requestDigest: payload.requestDigest, recordedAtMs: payload.recordedAtMs };
    const old = intents.get(key);
    if (old && canonicalJson({ ...old, recordedAtMs: 0 }) !== canonicalJson({ ...record, recordedAtMs: 0 })) throw new Error('pack order intent conflicts with prior intent');
    if (!old) intents.set(key, record);
    if (!intents.has('purchase')) intents.set('purchase', record);
  } else {
    const intent = intents.get(key);
    if (!intent) throw new Error('pack order response has no durable intent');
    const offset = admission.orders.slice(0, payload.orderIndex).reduce((sum, item) => sum + item.quantity, 0);
    if (!Array.isArray(payload.packs) || payload.packs.length !== order.quantity) throw new Error('pack order response quantity mismatch');
    const local = assertPackBatchRequest(payload.packs.map((pack, i) => {
      if (pack.packIndex !== offset + i || pack.packType !== order.packId || pack.expectedCardCount !== intent.intent.expectedCardCountPerPack) throw new Error('pack order response identity mismatch');
      return { ...pack, packIndex: i };
    }));
    if (!Number.isSafeInteger(payload.requestedAtMs) || payload.requestedAtMs < intent.recordedAtMs) throw new Error('pack order response time is invalid');
    const packs = local.map((pack, i) => ({ ...pack, packIndex: offset + i }));
    const old = requests.get(key);
    if (old && canonicalJson(old.packs) !== canonicalJson(packs)) throw new Error('pack order response conflicts with prior response');
    if (!old) requests.set(key, { packs, requestedAtMs: payload.requestedAtMs });
    const generated = admission.orders.flatMap((_, i) => requests.get(`purchase:${i}`)?.packs ?? []);
    assertPackBatchRequest(generated); // Includes cross-order duplicate memo and global index checks.
    requests.set('purchase', { packs: generated, requestedAtMs: requests.get('purchase:0').requestedAtMs,
      generationComplete: generated.length === admission.quantity });
  }
}

function assertCycleRewardSelectionEvidence(cycleId, rewardSelection, evidence) {
  if (rewardSelection === null && evidence?.schema !== 'hookemon.eligibility-payout-manifest.v2') return;
  if (rewardSelection === null || evidence?.schema !== 'hookemon.eligibility-payout-manifest.v2'
    || evidence.cycleId !== cycleId
    || canonicalJson(evidence.selection?.rewardSelection ?? null) !== canonicalJson(rewardSelection)) {
    throw new Error('eligibility selection does not match the frozen cycle policy');
  }
  const { schema, ...input } = evidence;
  createEligibilityPayoutManifest(input);
}

const PROCESS_USD_WINDOW_MS = 21_600_000;
const PROCESS_USD_HARD_MAX_MICRO = 50_000_000_000n;
const PROCESS_USD_DEFAULT_MICRO = '25000000000';

function processUsdBudgetKey(hook) {
  if (typeof hook !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(hook) || /^0x0{40}$/i.test(hook)) {
    throw new Error('process USD budget requires the canonical hook');
  }
  return `process-usd-claims:4663:${hook.toLowerCase()}`;
}

function validateProcessUsdBudget(value) {
  exactObject(value, ['schema', 'entries'], 'process USD budget');
  if (value.schema !== 'hookemon.process-usd-budget.v1' || !Array.isArray(value.entries)) throw new Error('invalid process USD budget');
  const ids = new Set();
  for (const entry of value.entries) {
    exactObject(entry, ['cycleId', 'amountWei', 'amountMicroUsd', 'valuationDigest', 'state', 'confirmedAtMs', 'transactionHash'], 'process USD reservation');
    if (typeof entry.cycleId !== 'string' || ids.has(entry.cycleId)
      || typeof entry.amountWei !== 'string' || !/^[1-9][0-9]*$/.test(entry.amountWei)
      || typeof entry.amountMicroUsd !== 'string' || !/^[1-9][0-9]*$/.test(entry.amountMicroUsd)
      || BigInt(entry.amountMicroUsd) > PROCESS_USD_HARD_MAX_MICRO || !digestPattern.test(entry.valuationDigest)
      || !['RESERVED', 'CONFIRMED', 'REVERTED'].includes(entry.state)
      || (entry.state === 'RESERVED' ? entry.confirmedAtMs !== null || entry.transactionHash !== null
        : !Number.isSafeInteger(entry.confirmedAtMs) || entry.confirmedAtMs < 0 || !/^0x[0-9a-f]{64}$/.test(entry.transactionHash))) {
      throw new Error('invalid process USD reservation');
    }
    ids.add(entry.cycleId);
  }
  return value;
}

export class CycleRepository {
  #store;
  #now;
  #testAuthority;
  #durableValuations = new WeakMap();

  constructor(guard, store, now, testAuthority = null) {
    if (guard !== CycleRepository) throw new Error('CycleRepository must be constructed with CycleRepository.open(directory)');
    this.#store = store;
    this.#now = now;
    this.#testAuthority = testAuthority;
  }

  /** @param {string} directory absolute path @param {() => number} [now] */
  static async open(directory, now = () => Date.now(), { testAuthority = null } = {}) {
    if (testAuthority !== null && testAuthority !== createTestProfileMutationAuthority()) throw new Error('repository test authority must be the explicit process test profile');
    const persistedRecovery = await readStateDirectoryRecoveryHold(directory);
    if (persistedRecovery !== null) return createStateDirectoryRecoveryRepository(persistedRecovery);
    try {
      const store = await DurableCycleStore.open(directory);
      return new CycleRepository(CycleRepository, store, now, testAuthority);
    } catch (error) {
      if (!(error instanceof StateDirectoryLossError)) throw error;
      return createStateDirectoryRecoveryRepository(await persistStateDirectoryRecoveryHold(error.recovery, now));
    }
  }

  #valuationAuthority() {
    if (this.#testAuthority !== null) return this.#testAuthority;
    const authority = requireLiveMutationAuthority();
    if (authority.requirementsRevision !== 71) throw new Error('native valuation requires revision 71 authority');
    return authority;
  }

  isDurableQuoteUsdValuation(value, expected = {}) {
    const record = value && this.#durableValuations.get(value);
    if (!record) return false;
    try {
      return digest(record.authority) === digest(this.#valuationAuthority()) && digest(value) === record.digest
        && this.#now() >= value.observedAtMs && this.#now() < value.validUntilMs
        && Object.entries(expected).every(([key, wanted]) => digest(value[key]) === digest(wanted));
    } catch { return false; }
  }

  #restoreAdmissionValuations(admission, provenance) {
    if (!admission || !provenance) return;
    let authority;
    try { authority = this.#valuationAuthority(); } catch { return; }
    if (digest(authority) !== digest(provenance.authority)) return;
    for (const value of [...admissionUnitRows(admission).map(unit => unit.unitFundingUsd), admission.aggregateFundingUsd]) {
      if (this.#now() < value.observedAtMs || this.#now() >= value.validUntilMs) continue;
      this.#durableValuations.set(value, { authority, digest: digest(value) });
    }
  }

  // Async (not the synchronous `#store.readCycle` DurableCycleStore itself exposes) because an
  // already-archived cycle can only be read back via `readArchivedCycle`, which is async — and
  // callers of this repository (a `status` command, a post-hoc audit, this package's own tests)
  // legitimately want to inspect a cycle's stage history *after* `completeCycle` has archived it,
  // not only while it is still active.
  async #replay(cycleId) {
    const archived = this.#store.archivedCycleIds.includes(cycleId);
    const stored = archived ? (await this.#store.readArchivedCycle(cycleId)).cycle : this.#store.readCycle(cycleId);
    return this.#replayStored(cycleId, stored, archived);
  }

  async #knownStates() {
    const cycleIds = [...new Set([...this.#store.activeCycleIds, ...this.#store.archivedCycleIds])];
    return Promise.all(cycleIds.map(async cycleId => ({ cycleId, state: await this.#replay(cycleId) })));
  }

  async #relayTransactionHashOwner(chainId, transactionHash, { exceptCycleId = null, exceptRelayRequestId = null } = {}) {
    if (transactionHash === null) return null;
    const canonical = canonicalRelayTransactionHash(chainId, transactionHash);
    for (const { cycleId, state } of await this.#knownStates()) {
      for (const [relayRequestId, leg] of state.relayLegs) {
        if (cycleId === exceptCycleId && relayRequestId === exceptRelayRequestId) continue;
        if (sameRelayTransactionHash(leg.sourceChainId, leg.sourceTxHash, chainId, canonical)
          || sameRelayTransactionHash(leg.destinationChainId, leg.destinationTxHash, chainId, canonical)) {
          return { cycleId, relayRequestId, leg: structuredClone(leg) };
        }
      }
    }
    return null;
  }

  async #heldWalletNonceReservationInAnotherCycle(cycleId, reservation, now) {
    const key = walletNonceReservationKey(reservation.chainId, reservation.wallet);
    for (const { cycleId: candidateCycleId, state } of await this.#knownStates()) {
      if (candidateCycleId === cycleId) continue;
      const current = state.walletNonceReservations.get(key);
      if (current?.state === 'HELD' && !walletNonceReservationExpired(current, now)) {
        return { cycleId: candidateCycleId, reservation: structuredClone(current) };
      }
    }
    return null;
  }

  async #standingAuthorityDecisions() {
    const decisions = [];
    for (const { cycleId, state } of await this.#knownStates()) {
      for (const decision of state.standingAuthorityDecisions.values()) {
        decisions.push({ cycleId, decision: structuredClone(decision) });
      }
    }
    return decisions;
  }

  async #replayStored(cycleId, stored, archived) {
    const stages = new Map();
    const preparedStages = new Map();
    // `attempts`: stage -> { evidence, attemptIndex, failed }. `attemptCounts`: stage -> the
    // attempt index a NEXT fresh attempt should use (== how many attempts have ever been
    // durably recorded for that stage, successful or since-marked-failed). See
    // `recordStageAttempt`/`recordStageAttemptFailure`/`nextStageAttemptIndex` below for the
    // WP-36 nonce-collision fix this bookkeeping exists for.
    const attempts = new Map();
    const attemptCounts = new Map();
    const operationalAttempts = new Map();
    const chainAttempts = new Map();
    const stageRequestDigests = new Map();
    const relayLegs = new Map();
    const standingAuthorityDecisions = new Map();
    const walletNonceReservations = new Map();
    const chainAttemptRecoveryContexts = new Map();
    const signOnlyPreSignBindings = new Map();
    const signOnlyInvocationLedgers = new Map();
    const custodyLedgers = new Map();
    const heldPositions = new Map();
    const heldPositionEvidence = new Map();
    const heldPositionLedgerKeys = new Map();
    const returnLegLedgerKeys = new Map();
    const supplementarySettlements = new Map();
    const supplementarySettlementEvidence = new Map();
    const supplementaryRealizedProceedsUsd = new Map();
    const payoutDustRecords = new Map();
    const payoutDustConsumptions = new Map();
    const payoutQuarantines = new Map();
    const evmNonceLocks = new Map();
    const packBatchRequests = new Map();
    const packOrderReconciliations = new Map();
    const packBatchIntents = new Map();
    const supplementaryChainAttempts = new Map();
    const supplementaryChainAttemptRecoveryContexts = new Map();
    // REQ-cycle-repository-2 `refresh-after-readmission`: a single per-cycle projection, never a
    // map, because the approved scope permits exactly one durable expiry record and at most one
    // selected replacement for the cycle's whole lifetime.
    let outboundQuoteRefresh = null;
    const replayState = {
      stages,
      preparedStages,
      operationalAttempts,
      chainAttempts,
      stageRequestDigests,
      supplementaryChainAttempts,
      supplementaryChainAttemptRecoveryContexts,
      relayLegs,
      standingAuthorityDecisions,
      walletNonceReservations,
      chainAttemptRecoveryContexts,
      signOnlyPreSignBindings,
      signOnlyInvocationLedgers,
      custodyLedgers,
      heldPositions,
      heldPositionEvidence,
      heldPositionLedgerKeys,
      returnLegLedgerKeys,
      supplementarySettlements,
      supplementarySettlementEvidence,
      supplementaryRealizedProceedsUsd,
      payoutDustRecords,
      payoutDustConsumptions,
      payoutQuarantines,
      evmNonceLocks,
      packBatchRequests,
      packOrderReconciliations,
      packBatchIntents,
    };
    let completed = false;
    let terminalState = null;
    let heldEvidenceDigest = null;
    let ownerDecision = null;
    let terminalEvidence = null;
    let terminalAtMs = null;
    let releaseAmount = null;
    let admission = null;
    let packPlanSnapshot = null;
    let rewardSelection = null;
    let nativeAdmissionProvenance = null;
    let mode = null;
    let providerMode = null;
    let dryRun = false;
    let rehearsalSessionId = null;
    for (const entry of stored.entries) {
      if (terminalState !== null
        && (!POST_TERMINAL_RECORD_KINDS.has(entry.kind)
          || (completed && !POST_COMPLETION_RECORD_KINDS.has(entry.kind)))) {
        if (entry.kind === 'cycle-terminal' || entry.kind === 'cycle-completed') {
          throw new Error('stored cycle has a second terminal event');
        }
        throw new Error('stored cycle has a non-observational event after terminal state');
      }
      if (entry.kind === 'cycle-opened') {
        if (releaseAmount !== null) throw new Error('stored cycle has a second cycle-opened event');
        if (Object.hasOwn(entry.payload, 'rewardSelection')) {
          rewardSelection = assertRewardSelectionSnapshot(entry.payload.rewardSelection, { cycleId });
        }
        if (Object.hasOwn(entry.payload, 'packPlanSnapshot')) {
          packPlanSnapshot = assertPackPlanSnapshot(entry.payload.packPlanSnapshot, { cycleId });
        }
        assertReleaseAmount(entry.payload.releaseAmount);
        releaseAmount = entry.payload.releaseAmount;
        if (Object.hasOwn(entry.payload, 'admission')) {
          // Replay re-validates against the approved deployment identity, never against values
          // taken from the stored record. Deriving the expectation from the record would let a
          // stored admission certify its own accounts and assets, which is exactly the check this
          // is here to perform.
          admission = assertDurableCycleAdmission(entry.payload.admission, cycleId, null, 'stored cycle admission', { historicalRead: true });
          replayState.admission = admission;
          if (admission.schema === 'hookemon.policy-admission.v4' && canonicalJson(packPlanSnapshot?.plan ?? null) !== canonicalJson(admission.packPlan)) throw new Error('cycle plan snapshot differs from admitted plan');
          if (entry.payload.nativeAdmissionProvenance !== undefined) nativeAdmissionProvenance = validateNativeAdmissionProvenance(entry.payload.nativeAdmissionProvenance, admission, cycleId);
        }
        if (Object.hasOwn(entry.payload, 'mode')) {
          mode = assertCycleMode(entry.payload.mode, 'stored cycle mode');
        }
        const storedDryRun = Object.hasOwn(entry.payload, 'dryRun')
          ? entry.payload.dryRun
          : false;
        if (Object.hasOwn(entry.payload, 'providerMode')) {
          if (mode === null) throw new Error('stored cycle providerMode requires a cycle mode');
          providerMode = assertProviderMode(
            entry.payload.providerMode,
            mode,
            { dryRun: storedDryRun === true },
            'stored cycle providerMode',
          );
        }
        dryRun = assertDryRun(storedDryRun, mode, providerMode, 'stored cycle dryRun');
        if (Object.hasOwn(entry.payload, 'rehearsalSessionId')) {
          rehearsalSessionId = assertRehearsalSessionId(
            entry.payload.rehearsalSessionId,
            mode,
            providerMode,
            'stored cycle rehearsalSessionId',
          );
        }
      }
      else if (entry.kind === 'stage-prepared') {
        assertStageName(entry.payload.stage);
        if (!preparedStages.has(entry.payload.stage)) {
          preparedStages.set(entry.payload.stage, { journalHead: entry.digest });
        }
      } else if (entry.kind === 'stage-completed') {
        assertStageName(entry.payload.stage, { allowLegacyRead: true });
        if (OPERATIONAL_STAGE_SET.has(entry.payload.stage)) {
          assertPreparedOrderedCompletion(replayState, entry.payload.stage);
          assertReconciledCompletion(replayState, entry.payload.stage, entry.payload.evidence);
        }
        const previous = stages.get(entry.payload.stage);
        if (previous && canonicalJson(previous.evidence) !== canonicalJson(entry.payload.evidence)) {
          throw new Error(`stored stage "${entry.payload.stage}" has conflicting completion evidence`);
        }
        stages.set(entry.payload.stage, { status: 'COMPLETE', evidence: entry.payload.evidence });
      } else if (entry.kind === 'pack-order-reconciled') {
        const { orderIndex, outcomes, admissionDigest, responseDigest } = entry.payload;
        const batch = packBatchRequests.get(`purchase:${orderIndex}`);
        if (admissionDigest !== digest(admission) || responseDigest !== digest(batch)) throw new Error('pack order reconciliation binding mismatch');
        const checked = assertPackOrderReconciliation(admission, batch, orderIndex, outcomes);
        const old = packOrderReconciliations.get(orderIndex);
        if (old && canonicalJson(old) !== canonicalJson(checked)) throw new Error('pack order reconciliation conflicts with prior outcome');
        packOrderReconciliations.set(orderIndex, checked);
      } else if (['pack-order-intent-recorded', 'pack-order-request-recorded'].includes(entry.kind)) {
        applyPackOrderEvent({ admission, cycleId, payload: entry.payload, kind: entry.kind, intents: packBatchIntents, requests: packBatchRequests, requestDigests: stageRequestDigests });
      } else if (entry.kind === 'pack-batch-intent-recorded') {
        if (admission?.schema === 'hookemon.policy-admission.v4') throw new Error('plan admission refuses legacy batch events');
        assertPackOperationStageName(entry.payload.stage);
        const intent = assertPackBatchIntent(entry.payload.intent, 'stored pack batch intent');
        if (!Number.isSafeInteger(entry.payload.recordedAtMs) || entry.payload.recordedAtMs < 0) {
          throw new Error('stored pack batch intent recordedAtMs is invalid');
        }
        const record = { recordedAtMs: entry.payload.recordedAtMs, intent };
        const previous = packBatchIntents.get(entry.payload.stage);
        if (previous && canonicalJson(previous.intent) !== canonicalJson(intent)) {
          throw new Error(`stored pack batch intent for "${entry.payload.stage}" has conflicting fields`);
        }
        if (!previous) packBatchIntents.set(entry.payload.stage, record);
      } else if (entry.kind === 'pack-batch-request-recorded') {
        if (admission?.schema === 'hookemon.policy-admission.v4') throw new Error('plan admission refuses legacy batch events');
        assertPackOperationStageName(entry.payload.stage);
        const packs = assertPackBatchRequest(entry.payload.packs, 'stored pack batch request');
        if (!Number.isSafeInteger(entry.payload.requestedAtMs) || entry.payload.requestedAtMs < 0) {
          throw new Error('stored pack batch request requestedAtMs is invalid');
        }
        const record = { requestedAtMs: entry.payload.requestedAtMs, packs };
        const previous = packBatchRequests.get(entry.payload.stage);
        if (previous && canonicalJson(previous.packs) !== canonicalJson(packs)) {
          throw new Error(`stored pack batch request for "${entry.payload.stage}" has conflicting packs`);
        }
        if (!previous) packBatchRequests.set(entry.payload.stage, record);
      } else if (entry.kind === 'stage-attempted') {
        const attemptIndex = attemptCounts.get(entry.payload.stage) ?? 0;
        attempts.set(entry.payload.stage, { evidence: entry.payload.evidence, attemptIndex, failed: false });
        attemptCounts.set(entry.payload.stage, attemptIndex + 1);
      } else if (entry.kind === 'stage-attempt-failed') {
        const current = attempts.get(entry.payload.stage);
        if (current) attempts.set(entry.payload.stage, { ...current, failed: true });
        const operational = operationalAttempts.get(entry.payload.stage);
        if (operational) operationalAttempts.set(entry.payload.stage, { ...operational, failed: true });
      } else if (entry.kind === 'stage-attempt-prepared') {
        const attempt = assertProviderMutationAttempt(entry.payload.attempt, 'stored provider mutation attempt');
        if (attempt.cycleId !== cycleId || attempt.stage !== entry.payload.stage || attempt.state !== 'PREPARED') {
          throw new Error('stored provider mutation preparation is invalid');
        }
        operationalAttempts.set(attempt.stage, {
          attempt,
          responseEvidence: null,
          reconciliationEvidence: null,
          sentAtMs: null,
          respondedAtMs: null,
          deadlineAnchorMs: null,
          failed: false,
        });
      } else if (entry.kind === 'stage-attempt-sent-unknown') {
        const previous = operationalAttempts.get(entry.payload.stage);
        const attempt = assertProviderMutationAttempt(entry.payload.attempt, 'stored provider mutation attempt');
        const sentAtMs = Object.hasOwn(entry.payload, 'sentAtMs') ? entry.payload.sentAtMs : null;
        if (!previous || previous.attempt.state !== 'PREPARED' || attempt.state !== 'SENT_UNKNOWN'
          || attempt.cycleId !== cycleId || attempt.stage !== entry.payload.stage
          || attempt.requestDigest !== previous.attempt.requestDigest) {
          throw new Error('stored provider mutation sent-unknown transition is invalid');
        }
        if (sentAtMs !== null && (!Number.isSafeInteger(sentAtMs) || sentAtMs < 0)) {
          throw new Error('stored provider mutation sent-unknown timestamp is invalid');
        }
        operationalAttempts.set(attempt.stage, { ...previous, attempt, sentAtMs });
      } else if (entry.kind === 'stage-attempt-not-sent') {
        const previous = operationalAttempts.get(entry.payload.stage);
        const attempt = assertProviderMutationAttempt(entry.payload.attempt, 'stored provider mutation attempt');
        if (!previous || previous.attempt.state !== 'PREPARED' || attempt.state !== 'NOT_SENT'
          || attempt.cycleId !== cycleId || attempt.stage !== entry.payload.stage
          || attempt.requestDigest !== previous.attempt.requestDigest) {
          throw new Error('stored provider mutation not-sent transition is invalid');
        }
        operationalAttempts.set(attempt.stage, { ...previous, attempt });
      } else if (entry.kind === 'stage-attempt-reprepared') {
        const previous = operationalAttempts.get(entry.payload.stage);
        const attempt = assertProviderMutationAttempt(entry.payload.attempt, 'stored provider mutation attempt');
        if (!previous || previous.attempt.state !== 'NOT_SENT' || attempt.state !== 'PREPARED'
          || attempt.cycleId !== cycleId || attempt.stage !== entry.payload.stage
          || canonicalJson(attempt) !== canonicalJson(transitionProviderMutationAttempt(previous.attempt, 'PREPARED'))) {
          throw new Error('stored provider mutation repreparation transition is invalid');
        }
        operationalAttempts.set(attempt.stage, {
          attempt,
          responseEvidence: null,
          reconciliationEvidence: null,
          sentAtMs: null,
          respondedAtMs: null,
          deadlineAnchorMs: null,
          failed: false,
        });
      } else if (entry.kind === 'stage-attempt-response-recorded') {
        const previous = operationalAttempts.get(entry.payload.stage);
        const attempt = assertProviderMutationAttempt(entry.payload.attempt, 'stored provider mutation attempt');
        const respondedAtMs = Object.hasOwn(entry.payload, 'respondedAtMs') ? entry.payload.respondedAtMs : null;
        if (!previous || !['PREPARED', 'SENT_UNKNOWN'].includes(previous.attempt.state)
          || attempt.state !== 'RESPONSE_RECORDED' || attempt.cycleId !== cycleId
          || attempt.stage !== entry.payload.stage || attempt.requestDigest !== previous.attempt.requestDigest) {
          throw new Error('stored provider mutation response transition is invalid');
        }
        if (respondedAtMs !== null && (!Number.isSafeInteger(respondedAtMs) || respondedAtMs < 0)) {
          throw new Error('stored provider mutation response timestamp is invalid');
        }
        operationalAttempts.set(attempt.stage, {
          ...previous,
          attempt,
          respondedAtMs,
          responseEvidence: cloneEvidence(entry.payload.evidence, 'stored provider response evidence'),
        });
      } else if (entry.kind === 'stage-attempt-deadline-anchored') {
        const previous = operationalAttempts.get(entry.payload.stage);
        const attempt = assertProviderMutationAttempt(entry.payload.attempt, 'stored provider mutation attempt');
        const { requestDigest, anchoredAtMs } = entry.payload;
        if (!previous || !['SENT_UNKNOWN', 'RESPONSE_RECORDED'].includes(previous.attempt.state)
          || attempt.state !== previous.attempt.state || attempt.cycleId !== cycleId
          || attempt.stage !== entry.payload.stage
          || canonicalJson(attempt) !== canonicalJson(previous.attempt)
          || requestDigest !== previous.attempt.requestDigest
          || previous.sentAtMs !== null || previous.respondedAtMs !== null
          || previous.deadlineAnchorMs !== null
          || !Number.isSafeInteger(anchoredAtMs) || anchoredAtMs < 0) {
          throw new Error('stored provider mutation deadline anchor is invalid');
        }
        operationalAttempts.set(attempt.stage, {
          ...previous,
          attempt,
          deadlineAnchorMs: anchoredAtMs,
        });
      } else if (entry.kind === 'stage-attempt-reconciled') {
        const previous = operationalAttempts.get(entry.payload.stage);
        const attempt = assertProviderMutationAttempt(entry.payload.attempt, 'stored provider mutation attempt');
        if (!previous || !['SENT_UNKNOWN', 'RESPONSE_RECORDED'].includes(previous.attempt.state)
          || attempt.state !== 'RECONCILED' || attempt.cycleId !== cycleId
          || attempt.stage !== entry.payload.stage || attempt.requestDigest !== previous.attempt.requestDigest) {
          throw new Error('stored provider mutation reconciliation transition is invalid');
        }
        operationalAttempts.set(attempt.stage, {
          ...previous,
          attempt,
          reconciliationEvidence: cloneEvidence(entry.payload.evidence, 'stored provider reconciliation evidence'),
        });
      } else if (entry.kind === 'chain-attempt-prepared') {
        const attempt = assertChainTransactionAttempt(entry.payload.attempt, 'stored chain transaction attempt');
        const key = chainAttemptKey(attempt.stage, attempt.requestDigest);
        if (attempt.cycleId !== cycleId || attempt.stage !== entry.payload.stage || attempt.state !== 'PREPARED'
          || chainAttempts.has(key)) {
          throw new Error('stored chain transaction preparation is invalid');
        }
        chainAttempts.set(key, { attempt, broadcastEvidence: null, finalityEvidence: null });
      } else if (entry.kind === 'chain-attempt-signed') {
        const attempt = assertChainTransactionAttempt(entry.payload.attempt, 'stored chain transaction attempt');
        const key = chainAttemptKey(attempt.stage, attempt.requestDigest);
        const previous = chainAttempts.get(key);
        if (!previous || previous.attempt.state !== 'PREPARED' || attempt.state !== 'SIGNED'
          || attempt.cycleId !== cycleId || attempt.stage !== entry.payload.stage
          || attempt.requestDigest !== previous.attempt.requestDigest) {
          throw new Error('stored chain transaction signing transition is invalid');
        }
        const expected = transitionChainTransactionAttempt(previous.attempt, 'SIGNED', {
          rawBytes: attempt.rawBytes,
          nonce: attempt.nonce,
          blockhash: attempt.blockhash,
          hash: attempt.hash,
        });
        if (canonicalJson(attempt) !== canonicalJson(expected)) {
          throw new Error('stored chain transaction signing material is invalid');
        }
        chainAttempts.set(key, { ...previous, attempt });
      } else if (entry.kind === 'chain-attempt-broadcast') {
        const attempt = assertChainTransactionAttempt(entry.payload.attempt, 'stored chain transaction attempt');
        const key = chainAttemptKey(attempt.stage, attempt.requestDigest);
        const previous = chainAttempts.get(key);
        const broadcastEvidence = cloneChainObservationEvidence(entry.payload.evidence, 'stored chain transaction broadcast evidence');
        if (!previous || previous.attempt.state !== 'SIGNED' || attempt.state !== 'BROADCAST'
          || attempt.cycleId !== cycleId || attempt.stage !== entry.payload.stage
          || attempt.requestDigest !== previous.attempt.requestDigest
          || canonicalJson(attempt) !== canonicalJson(transitionChainTransactionAttempt(previous.attempt, 'BROADCAST'))) {
          throw new Error('stored chain transaction broadcast transition is invalid');
        }
        chainAttempts.set(key, { ...previous, attempt, broadcastEvidence });
      } else if (entry.kind === 'chain-attempt-finalized') {
        const attempt = assertChainTransactionAttempt(entry.payload.attempt, 'stored chain transaction attempt');
        const key = chainAttemptKey(attempt.stage, attempt.requestDigest);
        const previous = chainAttempts.get(key);
        const finalityEvidence = cloneChainObservationEvidence(entry.payload.evidence, 'stored chain transaction finality evidence');
        if (!previous || previous.attempt.state !== 'BROADCAST' || attempt.state !== 'FINALIZED'
          || attempt.cycleId !== cycleId || attempt.stage !== entry.payload.stage
          || attempt.requestDigest !== previous.attempt.requestDigest
          || canonicalJson(attempt) !== canonicalJson(transitionChainTransactionAttempt(previous.attempt, 'FINALIZED'))) {
          throw new Error('stored chain transaction finality transition is invalid');
        }
        chainAttempts.set(key, { ...previous, attempt, finalityEvidence });
      } else if (entry.kind === 'chain-attempt-recovery-context-recorded') {
        const context = assertStoredChainAttemptRecoveryContext(cycleId, entry.payload.context);
        const key = chainAttemptRecoveryContextKey(
          context.stage,
          context.recipient,
          context.requestDigest,
          context.rawSignedBytesHash,
        );
        const chain = chainAttempts.get(chainAttemptKey(context.stage, context.requestDigest));
        if (!isRecipientPagedRecoveryContext(context) && (!chain || !['SIGNED', 'BROADCAST', 'FINALIZED'].includes(chain.attempt.state)
          || chain.attempt.hash !== context.rawSignedBytesHash)) {
          throw new Error('stored chain attempt recovery context does not bind signed bytes');
        }
        const previous = chainAttemptRecoveryContexts.get(key);
        if (previous && canonicalJson(previous) !== canonicalJson(context)) {
          throw new Error('stored chain attempt recovery context conflicts with prior context');
        }
        chainAttemptRecoveryContexts.set(key, context);
      } else if (entry.kind === 'sign-only-pre-sign-binding-persisted') {
        const binding = assertSignOnlyPreSignBinding(entry.payload.binding, 'stored sign-only pre-sign binding');
        if (binding.cycleId !== cycleId) throw new Error('stored sign-only pre-sign binding cycleId is invalid');
        const chain = chainAttempts.get(chainAttemptKey(binding.stage, binding.requestDigest));
        if (!chain || chain.attempt.state !== 'PREPARED') {
          throw new Error('stored sign-only pre-sign binding does not bind a PREPARED chain attempt');
        }
        const key = signOnlyPreSignBindingKey(binding.stage, binding.requestDigest);
        if (signOnlyPreSignBindings.has(key)) {
          throw new Error('stored sign-only pre-sign binding already exists');
        }
        signOnlyPreSignBindings.set(key, binding);
      } else if (entry.kind === 'sign-only-invocation-reserved') {
        const ledger = assertSignOnlyInvocationLedger(entry.payload.ledger, 'stored sign-only invocation ledger');
        if (ledger.cycleId !== cycleId) throw new Error('stored sign-only invocation ledger cycleId is invalid');
        const chain = chainAttempts.get(chainAttemptKey(ledger.stage, ledger.requestDigest));
        if (!chain || chain.attempt.state !== 'PREPARED') {
          throw new Error('stored sign-only invocation ledger reservation does not bind a PREPARED chain attempt');
        }
        const key = signOnlyInvocationLedgerKey(ledger.stage, ledger.requestDigest);
        const previous = signOnlyInvocationLedgers.get(key) ?? null;
        if (ledger.state === 'ORDINAL_1_ALLOCATED') {
          if (previous || !signOnlyPreSignBindings.has(signOnlyPreSignBindingKey(ledger.stage, ledger.requestDigest))) {
            throw new Error('stored sign-only invocation ledger ordinal 1 reservation is invalid');
          }
        } else if (ledger.state === 'ORDINAL_2_ALLOCATED') {
          if (!previous || previous.state !== 'ORDINAL_1_TIMED_OUT') {
            throw new Error('stored sign-only invocation ledger ordinal 2 reservation is invalid');
          }
          if (canonicalJson(ledger) !== canonicalJson(transitionSignOnlyInvocationLedger(previous, 'ORDINAL_2_ALLOCATED'))) {
            throw new Error('stored sign-only invocation ledger ordinal 2 reservation is invalid');
          }
        } else {
          throw new Error('stored sign-only invocation ledger reservation state is invalid');
        }
        signOnlyInvocationLedgers.set(key, ledger);
      } else if (entry.kind === 'sign-only-invocation-timed-out') {
        const ledger = assertSignOnlyInvocationLedger(entry.payload.ledger, 'stored sign-only invocation ledger');
        if (ledger.cycleId !== cycleId) throw new Error('stored sign-only invocation ledger cycleId is invalid');
        const key = signOnlyInvocationLedgerKey(ledger.stage, ledger.requestDigest);
        const previous = signOnlyInvocationLedgers.get(key) ?? null;
        const expectedPredecessor = ledger.state === 'ORDINAL_1_TIMED_OUT' ? 'ORDINAL_1_ALLOCATED' : 'ORDINAL_2_ALLOCATED';
        if (!previous || previous.state !== expectedPredecessor) {
          throw new Error('stored sign-only invocation ledger timeout transition is invalid');
        }
        if (canonicalJson(ledger) !== canonicalJson(transitionSignOnlyInvocationLedger(previous, ledger.state))) {
          throw new Error('stored sign-only invocation ledger timeout transition is invalid');
        }
        signOnlyInvocationLedgers.set(key, ledger);
      } else if (entry.kind === 'supplementary-chain-attempt-prepared') {
        const attempt = assertSupplementaryChainAttempt(entry.payload.attempt, 'stored supplementary chain transaction attempt');
        const key = supplementaryChainAttemptKey(attempt.positionId, attempt.requestDigest);
        if (attempt.state !== 'PREPARED' || supplementaryChainAttempts.has(key)) {
          throw new Error('stored supplementary chain transaction preparation is invalid');
        }
        supplementaryChainAttempts.set(key, { attempt, broadcastEvidence: null });
      } else if (entry.kind === 'supplementary-chain-attempt-signed') {
        const attempt = assertSupplementaryChainAttempt(entry.payload.attempt, 'stored supplementary chain transaction attempt');
        const key = supplementaryChainAttemptKey(attempt.positionId, attempt.requestDigest);
        const previous = supplementaryChainAttempts.get(key);
        if (!previous || previous.attempt.state !== 'PREPARED' || attempt.state !== 'SIGNED') {
          throw new Error('stored supplementary chain transaction signing transition is invalid');
        }
        const expected = transitionSupplementaryChainAttempt(previous.attempt, 'SIGNED', {
          rawBytes: attempt.rawBytes, nonce: attempt.nonce, blockhash: attempt.blockhash, hash: attempt.hash,
        });
        if (canonicalJson(attempt) !== canonicalJson(expected)) {
          throw new Error('stored supplementary chain transaction signing material is invalid');
        }
        supplementaryChainAttempts.set(key, Object.assign({}, previous, { attempt }));
      } else if (entry.kind === 'supplementary-chain-attempt-signed-with-recovery-context') {
        const attempt = assertSupplementaryChainAttempt(entry.payload.attempt, 'stored supplementary chain transaction attempt');
        const context = assertSupplementaryChainAttemptRecoveryContext(entry.payload.context, 'stored supplementary chain attempt recovery context');
        const key = supplementaryChainAttemptKey(attempt.positionId, attempt.requestDigest);
        const previous = supplementaryChainAttempts.get(key);
        if (!previous || previous.attempt.state !== 'PREPARED' || attempt.state !== 'SIGNED') {
          throw new Error('stored atomic supplementary chain transaction signing transition is invalid');
        }
        const expected = transitionSupplementaryChainAttempt(previous.attempt, 'SIGNED', {
          rawBytes: attempt.rawBytes, nonce: attempt.nonce, blockhash: attempt.blockhash, hash: attempt.hash,
        });
        if (canonicalJson(attempt) !== canonicalJson(expected)
          || context.positionId !== attempt.positionId
          || context.requestDigest !== attempt.requestDigest
          || context.rawSignedBytesHash !== attempt.hash) {
          throw new Error('stored atomic supplementary chain signing recovery context does not bind signed bytes');
        }
        if (supplementaryChainAttemptRecoveryContexts.has(key)) {
          throw new Error('stored atomic supplementary chain signing recovery context already exists');
        }
        supplementaryChainAttempts.set(key, Object.assign({}, previous, { attempt }));
        supplementaryChainAttemptRecoveryContexts.set(key, context);
      } else if (entry.kind === 'supplementary-chain-attempt-broadcast') {
        const attempt = assertSupplementaryChainAttempt(entry.payload.attempt, 'stored supplementary chain transaction attempt');
        const key = supplementaryChainAttemptKey(attempt.positionId, attempt.requestDigest);
        const previous = supplementaryChainAttempts.get(key);
        const broadcastEvidence = cloneChainObservationEvidence(entry.payload.evidence, 'stored supplementary chain transaction broadcast evidence');
        if (!previous || previous.attempt.state !== 'SIGNED' || attempt.state !== 'BROADCAST'
          || canonicalJson(attempt) !== canonicalJson(transitionSupplementaryChainAttempt(previous.attempt, 'BROADCAST'))) {
          throw new Error('stored supplementary chain transaction broadcast transition is invalid');
        }
        supplementaryChainAttempts.set(key, Object.assign({}, previous, { attempt, broadcastEvidence }));
      } else if (entry.kind === 'supplementary-chain-attempt-recovery-context-recorded') {
        const context = assertSupplementaryChainAttemptRecoveryContext(entry.payload.context, 'stored supplementary chain attempt recovery context');
        const key = supplementaryChainAttemptKey(context.positionId, context.requestDigest);
        const chain = supplementaryChainAttempts.get(key);
        if (!chain || !['SIGNED', 'BROADCAST'].includes(chain.attempt.state) || chain.attempt.hash !== context.rawSignedBytesHash) {
          throw new Error('stored supplementary chain attempt recovery context does not bind signed bytes');
        }
        const previous = supplementaryChainAttemptRecoveryContexts.get(key);
        if (previous && canonicalJson(previous) !== canonicalJson(context)) {
          throw new Error('stored supplementary chain attempt recovery context conflicts with prior context');
        }
        supplementaryChainAttemptRecoveryContexts.set(key, context);
      } else if (entry.kind === 'relay-leg-recorded') {
        const leg = assertRelayLeg(entry.payload.leg, 'stored Relay leg');
        const key = relayLegKey(leg.relayRequestId);
        if (leg.cycleId !== cycleId || leg.state !== 'RECORDED' || leg.sourceTxHash !== null || relayLegs.has(key)) {
          throw new Error('stored Relay leg recording is invalid');
        }
        relayLegs.set(key, leg);
      } else if (entry.kind === 'return-relay-leg-expectation-recorded') {
        exactObject(entry.payload, ['leg', 'ledger'], 'stored return relay leg expectation');
        const leg = assertRelayLeg(entry.payload.leg, 'stored return relay leg expectation leg');
        if (leg.returnAttribution?.schema === 'hookemon.return-leg-attribution-context.v2') validateNativeReturnValuation(leg);
        const legKey = relayLegKey(leg.relayRequestId);
        if (leg.cycleId !== cycleId || leg.direction !== 'return' || leg.state !== 'RECORDED'
          || leg.sourceTxHash !== null || relayLegs.has(legKey)) {
          throw new Error('stored return relay leg expectation leg is invalid');
        }
        if (unresolvedReturnLegConflict(replayState, leg)) {
          throw new Error('stored return relay leg expectation conflicts with an existing unresolved return leg for this destination');
        }
        const ledger = assertCustodyLedger(entry.payload.ledger, 'stored return relay leg expectation custody ledger', { allowLegacyBuckets: true });
        if (ledger.cycleId !== cycleId) throw new Error('stored return relay leg expectation custody ledger cycleId is invalid');
        if (!['hookemon.custody-ledger.v2', 'hookemon.custody-ledger.v3'].includes(ledger.schema) || ledger.expectedCycleAsset === null) {
          throw new Error('stored return relay leg expectation requires a v2 custody ledger with a populated expectedCycleAsset');
        }
        if (ledger.decimals !== leg.destinationDecimals || ledger.expectedCycleAsset.amountAtomic !== leg.destinationAmountAtomic) {
          throw new Error('stored return relay leg expectation custody ledger does not bind the Relay leg');
        }
        const ledgerKey = custodyLedgerKey(ledger);
        const previousLedger = custodyLedgers.get(ledgerKey) ?? null;
        assertCustodyLedgerTransition(previousLedger, ledger, 'stored return relay leg expectation custody ledger');
        if (previousLedger !== null) {
          if (previousLedger.expectedCycleAsset !== null) {
            throw new Error('stored return relay leg expectation custody ledger already carries an unresolved expectedCycleAsset');
          }
          const previousBaseline = { ...previousLedger, expectedCycleAsset: null };
          const nextBaseline = { ...ledger, expectedCycleAsset: null };
          if (canonicalJson(previousBaseline) !== canonicalJson(nextBaseline)) {
            throw new Error('stored return relay leg expectation custody ledger buckets changed unexpectedly');
          }
        }
        relayLegs.set(legKey, leg);
        custodyLedgers.set(ledgerKey, ledger);
        returnLegLedgerKeys.set(leg.relayRequestId, ledgerKey);
      } else if (entry.kind === 'relay-leg-source-recorded') {
        const previous = relayLegs.get(entry.payload.relayRequestId);
        const leg = assertRelayLeg(entry.payload.leg, 'stored Relay leg');
        if (!previous || previous.state !== 'RECORDED' || leg.cycleId !== cycleId
          || leg.relayRequestId !== entry.payload.relayRequestId
          || canonicalJson(leg) !== canonicalJson(attributeRelayLegSource(previous, { sourceTxHash: leg.sourceTxHash }))) {
          throw new Error('stored Relay source attribution is invalid');
        }
        relayLegs.set(relayLegKey(leg.relayRequestId), leg);
      } else if (entry.kind === 'relay-leg-settled') {
        const previous = relayLegs.get(entry.payload.relayRequestId);
        if (!previous || previous.state !== 'RECORDED') throw new Error('stored Relay settlement has no recorded leg');
        const { leg, settlement } = assertRelaySettlementInput(previous, entry.payload.settlement, replayState);
        if (leg.relayRequestId !== entry.payload.relayRequestId || canonicalJson(entry.payload.leg) !== canonicalJson(leg)) {
          throw new Error('stored Relay settlement leg is invalid');
        }
        relayLegs.set(relayLegKey(leg.relayRequestId), leg);
        // ADR-0026: the return-direction credit-and-clear (SETTLED) or clearing-only (HELD_RELAY_*)
        // ledger update is embedded in this same event, already fully validated above against
        // `replayState` (via `assertReturnRelaySettlementInput`'s own recompute-and-compare), so it
        // is applied directly here rather than through a separate, unauthenticated
        // `custody-ledger-recorded` event -- the only two paths ever allowed to change
        // `expectedCycleAsset`, alongside the dedicated return-leg expectation creation above.
        if (settlement.custodyLedger !== undefined && settlement.custodyLedger !== null) {
          custodyLedgers.set(custodyLedgerKey(settlement.custodyLedger), settlement.custodyLedger);
        }
      } else if (entry.kind === 'standing-authority-decision-recorded') {
        const decision = assertStandingAuthorityDecision(entry.payload.decision, 'stored standing authority decision');
        const previous = standingAuthorityDecisions.get(decision.intentDigest);
        if (previous && canonicalJson(previous) !== canonicalJson(decision)) {
          throw new Error('stored standing authority decision conflicts with prior decision');
        }
        standingAuthorityDecisions.set(decision.intentDigest, decision);
      } else if (['process-usd-claim-reserved', 'process-usd-claim-finalized'].includes(entry.kind)) {
        exactObject(entry.payload, ['hook', 'reservation'], 'stored process USD claim');
        processUsdBudgetKey(entry.payload.hook);
        validateProcessUsdBudget({ schema: 'hookemon.process-usd-budget.v1', entries: [entry.payload.reservation] });
        if (entry.payload.reservation.cycleId !== cycleId) throw new Error('stored process USD cycle mismatch');
      } else if (entry.kind === 'wallet-nonce-reserved') {
        const reservation = assertWalletNonceReservation(entry.payload.reservation, 'stored wallet nonce reservation');
        if (reservation.cycleId !== cycleId || reservation.state !== 'HELD') {
          throw new Error('stored wallet nonce reservation is invalid');
        }
        const key = walletNonceReservationKey(reservation.chainId, reservation.wallet);
        const previous = walletNonceReservations.get(key);
        if (previous?.state === 'HELD'
          && canonicalJson(previous) !== canonicalJson(reservation)
          && !validWalletNonceTakeover(previous, reservation)) {
          throw new Error('stored wallet nonce reservation conflicts with prior reservation');
        }
        walletNonceReservations.set(key, reservation);
      } else if (entry.kind === 'wallet-nonce-released') {
        const release = assertWalletNonceReservation(entry.payload.reservation, 'stored wallet nonce release');
        const key = walletNonceReservationKey(release.chainId, release.wallet);
        const previous = walletNonceReservations.get(key);
        if (!previous || previous.state !== 'HELD' || previous.cycleId !== cycleId
          || previous.stage !== release.stage || previous.fencingToken !== release.fencingToken
          || release.state !== 'RELEASED') {
          throw new Error('stored wallet nonce release is invalid');
        }
        walletNonceReservations.set(key, release);
      } else if (entry.kind === 'held-position-recorded') {
        const fields = Object.hasOwn(entry.payload ?? {}, 'ledger')
          ? ['position', 'evidence', 'ledger']
          : ['position', 'evidence'];
        exactObject(entry.payload, fields, 'stored held position');
        const position = assertHeldPosition(entry.payload.position, 'stored held position');
        if (position.cycleId !== cycleId) throw new Error('stored held position cycleId is invalid');
        if (position.evidenceDigest !== heldPositionEvidenceDigest(position, entry.payload.evidence)) {
          throw new Error('stored held position evidence digest does not match its evidence');
        }
        const previous = heldPositions.get(position.positionId);
        if (previous && canonicalJson(previous) !== canonicalJson(position)) {
          throw new Error('stored held position conflicts with prior card custody');
        }
        if (entry.payload.ledger !== undefined) {
          const ledger = assertCustodyLedger(entry.payload.ledger, 'stored held position custody ledger', { allowLegacyBuckets: true });
          if (ledger.cycleId !== cycleId) throw new Error('stored held position custody ledger cycleId is invalid');
          const expected = heldPositionCustodyLedger(custodyLedgers, cycleId, ledger, position);
          if (canonicalJson(ledger) !== canonicalJson(expected)) {
            throw new Error('stored held position custody ledger does not bind the held position value');
          }
          custodyLedgers.set(custodyLedgerKey(ledger), ledger);
          heldPositionLedgerKeys.set(position.positionId, custodyLedgerKey(ledger));
        }
        heldPositions.set(position.positionId, position);
        const previousEvidence = heldPositionEvidence.get(position.positionId);
        if (previousEvidence !== undefined && canonicalJson(previousEvidence) !== canonicalJson(entry.payload.evidence)) {
          throw new Error('stored held position evidence conflicts with prior card custody');
        }
        heldPositionEvidence.set(position.positionId, cloneEvidence(entry.payload.evidence, 'stored held position evidence'));
      } else if (entry.kind === 'held-position-identity-verified') {
        exactObject(entry.payload, ['positionId', 'identity', 'evidence'], 'stored held position identity');
        const previous = heldPositions.get(entry.payload.positionId) ?? null;
        if (previous === null || previous.resolution !== null || previous.mint !== null) {
          throw new Error('stored held position identity does not bind an unresolved null-mint position');
        }
        const identity = assertHeldPositionIdentity(entry.payload.identity, previous, 'stored held position identity');
        const evidence = cloneEvidence(entry.payload.evidence, 'stored held position identity evidence');
        if (identity.evidenceDigest !== heldPositionIdentityEvidenceDigest(
          previous.positionId,
          previous.evidenceDigest,
          identity.mint,
          identity.provenance,
        )) {
          throw new Error('stored held position identity evidence digest does not bind the held position');
        }
        if (previous.identity !== null) {
          if (previous.identity.mint !== identity.mint || canonicalJson(previous.identity) !== canonicalJson(identity)) {
            throw new Error('stored held position identity conflicts with prior verified identity');
          }
          continue;
        }
        const position = assertHeldPosition({
          ...previous,
          identity,
        }, 'stored held position identity position');
        heldPositions.set(position.positionId, position);
      } else if (entry.kind === 'held-position-owner-decision-recorded') {
        const fields = Object.hasOwn(entry.payload ?? {}, 'settlement')
          ? ['positionId', 'decision', 'position', 'settlement']
          : ['positionId', 'decision', 'position'];
        exactObject(entry.payload, fields, 'stored held position owner decision');
        const previous = heldPositions.get(entry.payload.positionId) ?? null;
        const decision = assertHeldPositionOwnerDecision(entry.payload.decision, 'stored held position owner decision');
        const position = assertHeldPosition(entry.payload.position, 'stored held position owner decision position');
        if (previous === null || decision.positionId !== entry.payload.positionId
          || decision.heldEvidenceDigest !== previous.evidenceDigest
          || decision.expectedRevision !== previous.positionRevision) {
          throw new Error('stored held position owner decision does not bind the current position');
        }
        const expected = {
          ...previous,
          positionRevision: previous.positionRevision + 1,
          ownerDecision: decision,
        };
        if (canonicalJson(position) !== canonicalJson(expected)) {
          throw new Error('stored held position owner decision transition is invalid');
        }
        if (entry.payload.settlement !== undefined) {
          const settlement = assertSupplementarySettlement(entry.payload.settlement, 'stored supplementary settlement');
          if (decision.choice !== 'sell'
            || settlement.positionId !== position.positionId
            || settlement.cycleId !== cycleId
            || settlement.positionEvidenceDigest !== position.evidenceDigest
            || settlement.state !== 'PREPARED'
            || supplementarySettlements.has(settlement.positionId)) {
            throw new Error('stored supplementary settlement does not bind the sell decision');
          }
          const expectedSettlement = supplementarySettlementFor(
            position,
            supplementarySettlements.size + 1,
            completedEligibilitySnapshotEvidenceDigest(replayState, cycleId),
          );
          if (canonicalJson(settlement) !== canonicalJson(expectedSettlement)) {
            throw new Error('stored supplementary settlement manifest is invalid');
          }
          supplementarySettlements.set(settlement.positionId, settlement);
          supplementarySettlementEvidence.set(settlement.positionId, null);
        } else if (decision.choice === 'sell') {
          throw new Error('stored sell decision requires a supplementary settlement');
        }
        heldPositions.set(position.positionId, position);
      } else if (entry.kind === 'supplementary-settlement-advanced') {
        const fields = entry.payload?.nextState === 'RETURN_BROADCAST'
          ? ['positionId', 'expectedState', 'nextState', 'evidence', 'payoutSource', ...(Object.hasOwn(entry.payload, 'realizedProceedsUsd') ? ['realizedProceedsUsd'] : [])]
          : ['positionId', 'expectedState', 'nextState', 'evidence'];
        exactObject(entry.payload, fields, 'stored supplementary settlement advance');
        if (typeof entry.payload.positionId !== 'string' || !heldPositionIdPattern.test(entry.payload.positionId)) {
          throw new Error('stored supplementary settlement position id is invalid');
        }
        if (!SUPPLEMENTARY_SETTLEMENT_STATES.has(entry.payload.expectedState)
          || !SUPPLEMENTARY_SETTLEMENT_STATES.has(entry.payload.nextState)) {
          throw new Error('stored supplementary settlement state is invalid');
        }
        const previous = supplementarySettlements.get(entry.payload.positionId) ?? null;
        if (previous === null || previous.state !== entry.payload.expectedState
          || !SUPPLEMENTARY_SETTLEMENT_TRANSITIONS.get(entry.payload.expectedState)?.has(entry.payload.nextState)) {
          throw new Error('stored supplementary settlement transition is invalid');
        }
        const returnBoundary = entry.payload.nextState === 'RETURN_BROADCAST'
          ? (isNativeAdmission(admission) ? assertSupplementaryReturnBoundaryEvidence : assertSupplementaryReturnBoundaryEvidenceHistorical)(
            entry.payload.evidence,
            previous,
            'stored supplementary settlement return boundary',
          )
          : null;
        const evidence = returnBoundary === null
          ? cloneEvidence(entry.payload.evidence, 'stored supplementary settlement evidence')
          : {
            schema: returnBoundary.schema,
            positionId: returnBoundary.positionId,
            cycleId: returnBoundary.cycleId,
            manifestId: returnBoundary.manifestId,
            finalizedReturnEvidence: returnBoundary.finalizedReturnEvidence,
          };
        const priorEvidence = supplementarySettlementEvidence.get(entry.payload.positionId) ?? null;
        const carriedReturnBoundary = returnBoundary === null && previous.payoutSourceDigest !== null
          ? durableSupplementaryReturnBoundary(
            previous,
            priorEvidence,
            'stored supplementary settlement advance',
          )
          : null;
        const payoutSource = returnBoundary === null
          ? (carriedReturnBoundary?.payoutSource ?? null)
          : (isNativeAdmission(admission) ? assertSupplementaryPayoutSource : assertSupplementaryPayoutSourceHistorical)(
            entry.payload.payoutSource,
            previous,
            'stored supplementary payout source',
          );
        if (returnBoundary !== null) {
          const expectedPayoutSource = supplementaryPayoutSourceForReturnBoundary(
            previous,
            returnBoundary,
            'stored supplementary payout source',
          );
          if (canonicalJson(payoutSource) !== canonicalJson(expectedPayoutSource)) {
            throw new Error('stored supplementary payout source is not derived from the position return boundary');
          }
        }
        if (returnBoundary !== null && isNativeAdmission(admission)) {
          const realized = entry.payload.realizedProceedsUsd ?? null;
          if (realized !== null) {
            const expected = supplementaryRealizedProceeds(realized, returnBoundary.finalizedReturnEvidence.finalityEvidence);
            if (canonicalJson(expected) !== canonicalJson(realized)) throw new Error('stored supplementary realized proceeds do not match payment evidence');
            supplementaryRealizedProceedsUsd.set(entry.payload.positionId, realized);
          }
          const ledger = supplementaryNativeReturnCustody({ custodyLedgers }, returnBoundary.finalizedReturnEvidence.amountAtomic);
          custodyLedgers.set(custodyLedgerKey(ledger), ledger);
        }
        const settlement = assertSupplementarySettlement({
          ...previous,
          state: entry.payload.nextState,
          ...(payoutSource === null ? {} : { payoutSourceDigest: digest(payoutSource) }),
        }, 'stored advanced supplementary settlement');
        supplementarySettlements.set(settlement.positionId, settlement);
        supplementarySettlementEvidence.set(
          settlement.positionId,
          supplementarySettlementEvidenceFor(
            settlement,
            settlement.state,
            evidence,
            payoutSource,
            carriedReturnBoundary,
            isNativeAdmission(admission) ? supplementarySettlementEvidenceSchema : 'hookemon.supplementary-settlement-evidence.v1',
          ),
        );
      } else if (entry.kind === 'held-position-resolved') {
        const fields = Object.hasOwn(entry.payload ?? {}, 'ledger')
          ? ['positionId', 'resolution', 'position', 'ledger']
          : ['positionId', 'resolution', 'position'];
        exactObject(entry.payload, fields, 'stored held position resolution');
        const previous = heldPositions.get(entry.payload.positionId) ?? null;
        const resolution = assertHeldPositionResolution(entry.payload.resolution, 'stored held position resolution');
        const position = assertHeldPosition(entry.payload.position, 'stored held position resolution position');
        if (previous === null || previous.resolution !== null || position.positionId !== entry.payload.positionId
          || resolution.evidenceDigest !== heldPositionResolutionEvidenceDigest(previous, resolution.terminalState, resolution.evidence)) {
          throw new Error('stored held position resolution does not bind the current position');
        }
        const expected = assertHeldPosition({
          ...previous,
          positionRevision: previous.positionRevision + 1,
          resolution,
        }, 'stored held position resolution transition');
        if (canonicalJson(position) !== canonicalJson(expected)) {
          throw new Error('stored held position resolution transition is invalid');
        }
        if (entry.payload.ledger !== undefined) {
          const key = heldPositionLedgerKeys.get(position.positionId) ?? null;
          if (key === null) throw new Error('stored held position resolution has no attributable held custody ledger');
          const ledger = assertCustodyLedger(entry.payload.ledger, 'stored resolved held position custody ledger', { allowLegacyBuckets: true });
          const expectedLedger = resolvedHeldPositionCustodyLedger(custodyLedgers, key, previous);
          if (canonicalJson(ledger) !== canonicalJson(expectedLedger)) {
            throw new Error('stored held position resolution custody ledger does not bind the held position');
          }
          custodyLedgers.set(key, ledger);
        }
        heldPositions.set(position.positionId, position);
      } else if (entry.kind === 'supplementary-payout-gas-recorded') {
        const { positionId, manifestId, planDigest, proof } = entry.payload;
        if (Object.keys(entry.payload).sort().join(',') !== 'manifestId,planDigest,positionId,proof') {
          throw new Error('stored supplementary gas payload fields are invalid');
        }
        const settlement = supplementarySettlements.get(positionId);
        if (!isNativeAdmission(admission) || !settlement
          || settlement.manifestId !== manifestId || !digestPattern.test(planDigest)) {
          throw new Error('stored supplementary gas does not bind its original position manifest');
        }
        const reservation = await this.#store.readGlobalKey(`native-supplementary-gas:${proof?.transactionHash}`);
        if (!reservation || canonicalJson(reservation) !== canonicalJson(supplementaryGasReservation(cycleId, positionId, manifestId, planDigest, proof))) {
          throw new Error('stored supplementary gas differs from its atomic signed payment reservation');
        }
        const key = custodyLedgerKey({ chainId: '4663', assetId: 'native' });
        custodyLedgers.set(key, supplementaryGasLedger(custodyLedgers.get(key), proof));
      } else if (entry.kind === 'custody-ledger-recorded') {
        const ledger = assertCustodyLedger(entry.payload.ledger, 'stored custody ledger', { allowLegacyBuckets: true });
        if (ledger.cycleId !== cycleId) throw new Error('stored custody ledger cycleId is invalid');
        const key = custodyLedgerKey(ledger);
        const previous = custodyLedgers.get(key) ?? null;
        assertCustodyLedgerTransition(previous, ledger, 'stored custody ledger');
        assertCustodyLedgerExpectedAssetUnchanged(previous, ledger, 'stored custody ledger');
        custodyLedgers.set(key, ledger);
      } else if (entry.kind === 'payout-dust-recorded') {
        const record = assertPayoutDustRecord(entry.payload.record, 'stored payout dust record');
        if (record.cycleId !== cycleId) throw new Error('stored payout dust record cycleId is invalid');
        const key = payoutAssetKey(record.amount);
        if (payoutDustRecords.has(key)) throw new Error('stored cycle has multiple payout dust records for one asset');
        payoutDustRecords.set(key, {
          amount: record.amount,
          source: { cycleId, digest: entry.digest, planDigest: record.planDigest },
        });
      } else if (entry.kind === 'payout-dust-consumed') {
        const consumption = assertPayoutDustConsumption(entry.payload.consumption, 'stored payout dust consumption');
        if (consumption.cycleId !== cycleId) throw new Error('stored payout dust consumption cycleId is invalid');
        const key = payoutDustSourceKey(consumption.sourceCycleId, consumption.sourceDigest);
        const previous = payoutDustConsumptions.get(key);
        if (previous && canonicalJson(previous) !== canonicalJson(consumption)) {
          throw new Error('stored cycle has conflicting payout dust consumption evidence');
        }
        payoutDustConsumptions.set(key, consumption);
      } else if (entry.kind === 'payout-quarantine-reserved') {
        const reservation = assertPayoutQuarantineReservation(entry.payload.reservation, 'stored payout quarantine reservation');
        if (reservation.cycleId !== cycleId) throw new Error('stored payout quarantine reservation cycleId is invalid');
        const reservationKey = payoutQuarantineKey(reservation.planDigest, reservation.recipient);
        if (payoutQuarantines.has(reservationKey)) throw new Error('stored cycle has duplicate payout quarantine evidence');
        const ledgerKey = custodyLedgerKey(reservation.ledger);
        const previousLedger = custodyLedgers.get(ledgerKey);
        if (!previousLedger) throw new Error('stored payout quarantine reservation has no prior custody ledger');
        if (BigInt(previousLedger.returnReceived) - BigInt(previousLedger.payoutLiability) < BigInt(reservation.amount.amountAtomic)) {
          throw new Error('stored payout quarantine reservation is not backed by recorded returned custody');
        }
        const expectedLedger = {
          ...previousLedger,
          payoutLiability: (BigInt(previousLedger.payoutLiability) + BigInt(reservation.amount.amountAtomic)).toString(),
        };
        if (canonicalJson(reservation.ledger) !== canonicalJson(expectedLedger)) {
          throw new Error('stored payout quarantine reservation does not atomically reserve the matching custody liability');
        }
        payoutQuarantines.set(reservationKey, reservation);
        custodyLedgers.set(ledgerKey, reservation.ledger);
      } else if (entry.kind === 'payout-quarantine-retry-requested') {
        if (entry.payload.schema !== payoutQuarantineRetrySchema) {
          throw new Error('stored payout quarantine retry request schema is invalid');
        }
        const reservationKey = payoutQuarantineKey(entry.payload.planDigest, entry.payload.recipient);
        const reservation = payoutQuarantines.get(reservationKey);
        if (!reservation || reservation.cycleId !== cycleId) throw new Error('stored payout quarantine retry has no reservation');
        const retry = assertPayoutQuarantineRetry(entry.payload.retry, 'stored payout quarantine retry');
        if (typeof reservation.evidence.transactionHash !== 'string'
          || retry.originalTransactionHash !== reservation.evidence.transactionHash.toLowerCase()) {
          throw new Error('stored payout quarantine retry original transaction does not match reservation evidence');
        }
        if (reservation.settlement !== null) throw new Error('stored payout quarantine retry follows a settled reservation');
        if (reservation.retries.some(existing => existing.requestId === retry.requestId
          || existing.retryId === retry.retryId)) {
          throw new Error('stored payout quarantine retry duplicates prior retry identity');
        }
        if (reservation.retries.some(existing => existing.resolution === null)) {
          throw new Error('stored payout quarantine retry overlaps an unresolved retry');
        }
        reservation.retries.push(retry);
      } else if (entry.kind === 'payout-quarantine-retry-refused') {
        if (entry.payload.schema !== payoutQuarantineRetrySchema) {
          throw new Error('stored payout quarantine retry refusal schema is invalid');
        }
        const reservationKey = payoutQuarantineKey(entry.payload.planDigest, entry.payload.recipient);
        const reservation = payoutQuarantines.get(reservationKey);
        if (!reservation || reservation.cycleId !== cycleId) throw new Error('stored payout quarantine retry refusal has no reservation');
        const retry = reservation.retries.find(candidate => candidate.retryId === entry.payload.retryId);
        if (!retry) throw new Error('stored payout quarantine retry refusal has no retry');
        const refusalEvidence = cloneChainObservationEvidence(entry.payload.refusalEvidence, 'stored payout quarantine retry refusal evidence');
        if (refusalEvidence.reason !== 'TRANSACTION_REVERTED'
          || typeof refusalEvidence.finalizedBlockNumber !== 'string'
          || typeof refusalEvidence.finalizedBlockHash !== 'string') {
          throw new Error('stored payout quarantine retry refusal evidence is not finalized');
        }
        if (retry.resolution !== null
          && canonicalJson(retry.resolution) !== canonicalJson({ state: 'REFUSED', transactionHash: refusalEvidence.transactionHash })) {
          throw new Error('stored payout quarantine retry refusal conflicts with prior resolution');
        }
        retry.resolution = { state: 'REFUSED', transactionHash: refusalEvidence.transactionHash };
        retry.refusalEvidence = refusalEvidence;
        retry.processProof = entry.payload.processProof === undefined || entry.payload.processProof === null
          ? null
          : cloneChainObservationEvidence(entry.payload.processProof, 'stored payout quarantine retry refusal process proof');
        retry.payoutRetry = entry.payload.payoutRetry === undefined || entry.payload.payoutRetry === null
          ? null
          : cloneChainObservationEvidence(entry.payload.payoutRetry, 'stored payout quarantine retry refusal payout retry');
      } else if (entry.kind === 'payout-quarantine-settled') {
        if (entry.payload.schema !== payoutQuarantineSettlementSchema) {
          throw new Error('stored payout quarantine settlement schema is invalid');
        }
        const reservationKey = payoutQuarantineKey(entry.payload.planDigest, entry.payload.recipient);
        const reservation = payoutQuarantines.get(reservationKey);
        if (!reservation || reservation.cycleId !== cycleId) throw new Error('stored payout quarantine settlement has no reservation');
        const settlement = assertPayoutQuarantineSettlement(entry.payload.settlement, 'stored payout quarantine settlement', {
          cycleId, planDigest: reservation.planDigest, recipient: reservation.recipient,
        });
        if (reservation.settlement !== null) throw new Error('stored payout quarantine reservation has duplicate settlement');
        if (settlement.amount.amountAtomic !== reservation.amount.amountAtomic) {
          throw new Error('stored payout quarantine settlement amount does not match reservation');
        }
        if (settlement.retryId !== null) {
          const retry = reservation.retries.find(candidate => candidate.retryId === settlement.retryId);
          if (!retry || retry.resolution !== null) throw new Error('stored payout quarantine settlement retry is invalid');
        } else if (settlement.transactionHash !== reservation.evidence.transactionHash.toLowerCase()) {
          throw new Error('stored payout quarantine original settlement transaction does not match reservation');
        }
        const ledgerKey = custodyLedgerKey(reservation.ledger);
        const previousLedger = custodyLedgers.get(ledgerKey);
        if (!previousLedger) throw new Error('stored payout quarantine settlement has no prior custody ledger');
        if (BigInt(previousLedger.payoutLiability) < BigInt(reservation.amount.amountAtomic)) {
          throw new Error('stored payout quarantine settlement underflows payout liability');
        }
        const storedLedger = assertCustodyLedger(entry.payload.ledger, 'stored payout quarantine settlement ledger');
        const expectedLedger = {
          ...previousLedger,
          payoutLiability: (BigInt(previousLedger.payoutLiability) - BigInt(reservation.amount.amountAtomic)).toString(),
        };
        if (canonicalJson(storedLedger) !== canonicalJson(expectedLedger)) {
          throw new Error('stored payout quarantine settlement does not atomically release the matching custody liability');
        }
        reservation.settlement = settlement;
        custodyLedgers.set(ledgerKey, storedLedger);
      } else if (entry.kind === 'stage-request-prepared') {
        assertStageName(entry.payload.stage);
        if (typeof entry.payload.requestDigest !== 'string' || !digestPattern.test(entry.payload.requestDigest)) {
          throw new Error('stored stage request digest is invalid');
        }
        const digests = stageRequestDigests.get(entry.payload.stage) ?? [];
        if (!digests.includes(entry.payload.requestDigest)) digests.push(entry.payload.requestDigest);
        stageRequestDigests.set(entry.payload.stage, digests);
      } else if (entry.kind === 'outbound-quote-expired') {
        const evidence = assertOutboundQuoteExpiryEvidence(entry.payload.evidence, cycleId);
        assertOutboundQuoteExpiryEvidenceMatchesAdmission(evidence, admission);
        if (hasOutboundEffectRecords(replayState)) {
          throw new Error('stored cycle recorded outbound quote expiry evidence after an outbound effect record');
        }
        if (outboundQuoteRefresh) {
          if (outboundQuoteRefresh.state !== 'REFRESH_REQUIRED'
            || canonicalJson(outboundQuoteRefresh.expiry) !== canonicalJson(evidence)) {
            throw new Error('stored cycle has conflicting outbound quote expiry evidence');
          }
        } else {
          outboundQuoteRefresh = Object.freeze({ state: 'REFRESH_REQUIRED', expiry: evidence, expiryDigest: entry.digest });
        }
      } else if (entry.kind === 'outbound-quote-refresh-selected') {
        if (!outboundQuoteRefresh || outboundQuoteRefresh.state !== 'REFRESH_REQUIRED') {
          throw new Error('stored cycle has a replacement selection without an exact REFRESH_REQUIRED predecessor');
        }
        if (entry.payload.predecessorExpiryDigest !== outboundQuoteRefresh.expiryDigest) {
          throw new Error('stored cycle replacement selection does not bind the exact expiry predecessor');
        }
        if (hasOutboundEffectRecords(replayState)) {
          throw new Error('stored cycle selected an outbound quote refresh replacement after an outbound effect record');
        }
        assertDigest(entry.payload.replacementDigest, 'stored outbound quote refresh replacementDigest');
        assertDigest(entry.payload.refreshPolicyDecisionDigest, 'stored outbound quote refresh refreshPolicyDecisionDigest');
        const replacement = assertDurableCycleAdmission(entry.payload.replacement, cycleId, null, 'stored outbound quote refresh replacement admission');
        if (digest(replacement) !== entry.payload.replacementDigest) {
          throw new Error('stored outbound quote refresh replacementDigest does not match the replacement admission');
        }
        if (!Number.isSafeInteger(entry.payload.selectedAtMs) || entry.payload.selectedAtMs <= 0) {
          throw new Error('stored outbound quote refresh selectedAtMs is invalid');
        }
        assertOutboundQuoteReplacementIdentity(
          replacement, admission, releaseAmount, 'stored outbound quote refresh replacement',
        );
        assertOutboundQuoteReplacementFreshness(replacement, entry.payload.selectedAtMs, 'stored outbound quote refresh replacement');
        outboundQuoteRefresh = Object.freeze({
          state: 'ACTIVE',
          expiry: outboundQuoteRefresh.expiry,
          expiryDigest: outboundQuoteRefresh.expiryDigest,
          replacement,
          replacementDigest: entry.payload.replacementDigest,
          refreshPolicyDecisionDigest: entry.payload.refreshPolicyDecisionDigest,
          selectedAtMs: entry.payload.selectedAtMs,
        });
      } else if (entry.kind === 'evm-nonce-lock-acquired') {
        const lock = assertEvmNonceLock(entry.payload.lock, 'stored EVM nonce lock');
        if (lock.cycleId !== cycleId) throw new Error('stored EVM nonce lock cycleId is invalid');
        const key = evmNonceLockKey(lock.chainId, lock.wallet);
        const previous = evmNonceLocks.get(key) ?? null;
        if (lock.previousFencingToken !== (previous?.fencingToken ?? null)) {
          throw new Error('stored EVM nonce lock fencing transition is invalid');
        }
        evmNonceLocks.set(key, { ...lock, state: 'HELD', journalHead: entry.digest });
      } else if (entry.kind === 'evm-nonce-lock-released') {
        const release = assertEvmNonceLockRelease(entry.payload.lock, 'stored EVM nonce lock release');
        if (release.cycleId !== cycleId) throw new Error('stored EVM nonce lock release cycleId is invalid');
        const key = evmNonceLockKey(release.chainId, release.wallet);
        const previous = evmNonceLocks.get(key);
        if (!previous || previous.state !== 'HELD' || previous.fencingToken !== release.fencingToken) {
          throw new Error('stored EVM nonce lock release does not match a held lock');
        }
        evmNonceLocks.set(key, { ...previous, state: 'RELEASED', journalHead: entry.digest });
      } else if (entry.kind === 'cycle-terminal') {
        assertTerminalPayloadShape(entry.payload, 'stored cycle terminal state');
        terminalState = assertCycleTerminalState(entry.payload.terminalState, 'stored cycle terminal state');
        terminalEvidence = cloneEvidence(entry.payload.evidence, 'stored cycle terminal evidence');
        terminalAtMs = assertOptionalTerminalAtMs(entry.payload.terminalAtMs, 'stored cycle terminal state');
        if (terminalState === HELD_OWNER_DECISION) {
          heldEvidenceDigest = heldOwnerDecisionEvidenceDigest(cycleId, entry.payload.evidence);
        }
      } else if (entry.kind === 'held-owner-decision-recorded') {
        const decision = assertHeldOwnerDecision(entry.payload, 'stored held owner decision');
        if (terminalState !== HELD_OWNER_DECISION || heldEvidenceDigest === null) {
          throw new Error('stored held owner decision does not follow an owner-decision hold');
        }
        if (decision.cycleId !== cycleId || decision.heldEvidenceDigest !== heldEvidenceDigest) {
          throw new Error('stored held owner decision does not bind the held cycle evidence');
        }
        if (decision.expectedRevision !== entry.index) {
          throw new Error('stored held owner decision has a stale cycle revision');
        }
        if (ownerDecision !== null) throw new Error('stored cycle has a second held owner decision');
        ownerDecision = decision;
      } else if (entry.kind === 'cycle-completed') {
        if (Object.keys(entry.payload).length > 1 || (Object.keys(entry.payload).length === 1 && !Object.hasOwn(entry.payload, 'completedAtMs'))) {
          throw new Error('stored cycle-completed event must use the exact schema');
        }
        assertCycleClosure(replayState);
        completed = true;
        terminalState = 'COMPLETED';
        terminalAtMs = assertOptionalTerminalAtMs(entry.payload.completedAtMs, 'stored cycle-completed event');
      }
    }
    const frozenEligibility = stages.get('eligibility-snapshot');
    if (frozenEligibility?.status === 'COMPLETE') {
      assertCycleRewardSelectionEvidence(cycleId, rewardSelection,
        await this.#resolveStageEvidence(cycleId, 'eligibility-snapshot', frozenEligibility.evidence));
    }
    this.#restoreAdmissionValuations(admission, nativeAdmissionProvenance);
    return {
      cycleId,
      releaseAmount,
      mode,
      providerMode,
      dryRun,
      rehearsalSessionId,
      admission,
      packPlanSnapshot,
      rewardSelection,
      stages,
      preparedStages,
      attempts,
      attemptCounts,
      operationalAttempts,
      chainAttempts,
      stageRequestDigests,
      supplementaryChainAttempts,
      supplementaryChainAttemptRecoveryContexts,
      relayLegs,
      standingAuthorityDecisions,
      walletNonceReservations,
      chainAttemptRecoveryContexts,
      signOnlyPreSignBindings,
      signOnlyInvocationLedgers,
      custodyLedgers,
      heldPositions,
      heldPositionEvidence,
      heldPositionLedgerKeys,
      returnLegLedgerKeys,
      supplementarySettlements,
      supplementarySettlementEvidence,
      supplementaryRealizedProceedsUsd,
      payoutDustRecords,
      payoutDustConsumptions,
      payoutQuarantines,
      evmNonceLocks,
      packBatchRequests,
      packOrderReconciliations,
      packBatchIntents,
      outboundQuoteRefresh,
      completed,
      terminalState,
      heldEvidenceDigest,
      ownerDecision,
      terminalEvidence,
      terminalAtMs,
      archived,
      version: stored.version,
      journalHead: stored.journalHead,
    };
  }

  async #appendEvents(cycleId, events, {
    operation = null,
    assertState = null,
    authorizationRecords = [],
    globalKeyReservations = [],
    globalKeyReplacements = [],
    globalKeyReleases = [],
    assertLease = null,
  } = {}) {
    if (!Array.isArray(events) || events.length === 0) throw new Error('cycle-repository append requires journal events');
    if (!Array.isArray(globalKeyReservations)) throw new Error('cycle-repository append global key reservations must be an array');
    if (!Array.isArray(globalKeyReplacements)) throw new Error('cycle-repository append global key replacements must be an array');
    if (!Array.isArray(globalKeyReleases)) throw new Error('cycle-repository append global key releases must be an array');
    if (assertLease !== null && typeof assertLease !== 'function') {
      throw new Error('cycle-repository append assertLease must be a function or null');
    }
    const stored = this.#store.readCycle(cycleId);
    const state = await this.#replayStored(cycleId, stored, false);
    const heldRetryNonceException = operation === 'reserveWalletNonce'
      ? payoutRetryMayUseHeldCycle(state)
      : operation === 'releaseWalletNonce'
        ? payoutRetryMayReleaseHeldCycle(state)
        : false;
    if (operation && state.terminalState && !heldRetryNonceException) {
      throw new Error(`cycle-repository ${operation}: cycle is terminal as ${state.terminalState}`);
    }
    assertState?.(state);
    assertLease?.();
    const journal = new CycleJournal(cycleId, stored.entries);
    const entries = [];
    for (const event of events) {
      const entry = journal.propose(event.kind, event.payload);
      journal.appendEvent(entry);
      entries.push(entry);
    }
    const transaction = this.#store.begin(cycleId, { expectedVersion: stored.version, expectedJournalHead: stored.journalHead });
    for (const entry of entries) transaction.stageEvent(entry);
    for (const authorization of authorizationRecords) transaction.consumeAuthorization(authorization);
    for (const reservation of globalKeyReservations) {
      if (!reservation || typeof reservation !== 'object' || Array.isArray(reservation)
        || Object.keys(reservation).length !== 2 || !Object.hasOwn(reservation, 'key') || !Object.hasOwn(reservation, 'value')) {
        throw new Error('cycle-repository append global key reservation is invalid');
      }
      transaction.stageGlobalKey(reservation.key, reservation.value);
    }
    for (const replacement of globalKeyReplacements) {
      if (!replacement || typeof replacement !== 'object' || Array.isArray(replacement)
        || Object.keys(replacement).length !== 3
        || !Object.hasOwn(replacement, 'key')
        || !Object.hasOwn(replacement, 'expectedValue')
        || !Object.hasOwn(replacement, 'value')) {
        throw new Error('cycle-repository append global key replacement is invalid');
      }
      transaction.stageGlobalKeyReplacement(replacement.key, replacement.expectedValue, replacement.value);
    }
    for (const release of globalKeyReleases) {
      if (!release || typeof release !== 'object' || Array.isArray(release)
        || Object.keys(release).length !== 2
        || !Object.hasOwn(release, 'key')
        || !Object.hasOwn(release, 'expectedValue')) {
        throw new Error('cycle-repository append global key release is invalid');
      }
      transaction.stageGlobalKeyRelease(release.key, release.expectedValue);
    }
    await this.#store.commit(transaction);
    assertLease?.();
    return entries;
  }

  async #append(cycleId, kind, payload, options = {}) {
    const [entry] = await this.#appendEvents(cycleId, [{ kind, payload }], options);
    return entry;
  }

  /** @returns {Promise<{cycleId: string, releaseAmount: string, mode: 'production'|'rehearsal'|null, providerMode?: 'live'|'fake', admission?: object, terminalState?: string}|null>} */
  async readActiveCycle() {
    for (const cycleId of this.#store.activeCycleIds) {
      const state = await this.#replay(cycleId);
      if (state.completed) {
        if (hasOpenHeldPositions(state)) continue;
        // Crash recovery: the 'cycle-completed' event committed but the archive step never ran.
        // Finish it now (idempotent — archiveCycle() only fails if already archived, which cannot
        // be true here since activeCycleIds just listed this id) rather than surfacing a completed
        // cycle as still "active".
        await this.#store.archiveCycle(cycleId);
        continue;
      }
      const profile = {
        ...(state.packPlanSnapshot === null ? {} : { packPlanSnapshot: state.packPlanSnapshot }),
        ...(state.rewardSelection === null ? {} : { rewardSelection: structuredClone(state.rewardSelection) }),
        ...(state.providerMode === null ? {} : { providerMode: state.providerMode }),
        ...(state.dryRun ? { dryRun: true } : {}),
        ...(state.rehearsalSessionId === null ? {} : { rehearsalSessionId: state.rehearsalSessionId }),
      };
      // The admission travels with the active cycle, not only with describeCycle: a resumed cycle
      // must re-present the same authorization to the policy engine, or its digest changes and the
      // spend reservation it already made stops matching.
      const admitted = state.admission === null ? {} : { admission: state.admission };
      return state.terminalState
        ? { cycleId, releaseAmount: state.releaseAmount, mode: state.mode, ...profile, ...admitted, terminalState: state.terminalState, terminalAtMs: state.terminalAtMs }
        : { cycleId, releaseAmount: state.releaseAmount, mode: state.mode, ...profile, ...admitted };
    }
    return null;
  }

  /**
   * Read the active cycle without archival repair. Status and reconciliation use this accessor so
   * an observation cannot release the active slot or change durable lifecycle state.
   * @returns {Promise<{cycleId: string, releaseAmount: string, terminalState?: string}|null>}
   */
  async peekActiveCycle() {
    for (const cycleId of this.#store.activeCycleIds) {
      const state = await this.#replay(cycleId);
      if (state.completed) continue;
      return state.terminalState
        ? { cycleId, releaseAmount: state.releaseAmount, terminalState: state.terminalState }
        : { cycleId, releaseAmount: state.releaseAmount };
    }
    return null;
  }

  /** @param {{releaseAmount: string, mode: 'production'|'rehearsal', providerMode?: 'live'|'fake', dryRun?: boolean, rehearsalSessionId?: string}} input @returns {Promise<{cycleId: string, releaseAmount: string, mode: 'production'|'rehearsal', providerMode: 'live'|'fake'|null, dryRun: boolean, rehearsalSessionId: string|null}>} */
  /**
   * Reserves the identifier a subsequent `createCycle` will open under, so a caller that must bind
   * money evidence to this cycle before it exists -- the quote-bound policy admission, whose
   * `cycleId` the policy digest and outbound both check -- has one identifier to bind. Reserving is
   * pure: nothing is journaled, and an unused reservation leaves no state behind.
   */
  nextCycleId() {
    return generateCycleId(this.#now());
  }

  async createCycle({
    releaseAmount, mode, providerMode = null, dryRun = false, rehearsalSessionId = null,
    cycleId = null, admission = null, operations = null, packPlan, rewardRecipientLimit, configurationRevision,
  }) {
    assertReleaseAmount(releaseAmount);
    assertCycleMode(mode);
    assertDryRun(dryRun, mode, providerMode);
    if (providerMode !== null) assertProviderMode(providerMode, mode, { dryRun });
    if (rehearsalSessionId !== null) assertRehearsalSessionId(rehearsalSessionId, mode, providerMode);
    const active = await this.readActiveCycle();
    if (active) throw new Error('cycle-repository createCycle: a cycle is already active');
    const openedCycleId = cycleId === null ? generateCycleId(this.#now()) : assertReservedCycleId(cycleId);
    if (rewardRecipientLimit === undefined && configurationRevision !== undefined) throw new Error('cycle reward configuration revision requires a recipient limit');
    const rewardSelection = rewardRecipientLimit === undefined ? null : createRewardSelectionSnapshot({
      cycleId: openedCycleId, rewardRecipientLimit, configurationRevision,
    });
    const packPlanSnapshot = packPlan === undefined
      ? null
      : createPackPlanSnapshot({ cycleId: openedCycleId, plan: packPlan });
    // The admission rides in `cycle-opened` itself rather than a following event. Replay already
    // refuses a second `cycle-opened`, so one atomic write makes the record immutable for the life
    // of the cycle: there is no window in which a cycle exists whose admission could still be
    // replaced, and a replacement quote cannot inherit this cycle's authorization.
    const admitted = admission === null
      ? null
      : assertDurableCycleAdmission(admission, openedCycleId, operations, 'cycle-repository createCycle admission');
    if (admitted !== null && admitted.aggregateFundingQuote.amountAtomic !== releaseAmount) {
      throw new Error('cycle-repository createCycle: release amount does not equal the admitted aggregate funding quote');
    }
    if (admitted?.schema === 'hookemon.policy-admission.v4' && canonicalJson(packPlanSnapshot?.plan ?? null) !== canonicalJson(admitted.packPlan)) throw new Error('cycle plan snapshot differs from admitted plan');
    let nativeAdmissionProvenance = null;
    if (['hookemon.policy-admission.v3', 'hookemon.policy-admission.v4'].includes(admitted?.schema)) {
      const legs = admissionUnitRows(admission).map(unit => [unit.unitFundingUsd, unit.unitFundingQuote, unit.unitRelay]);
      legs.push([admission.aggregateFundingUsd, admitted.aggregateFundingQuote, admitted.relay]);
      for (const [value, amount, quote] of legs) {
        if (!isProcessQuoteUsdValuation(value, { amount, quoteDigest: quote.quoteDigest,
          quoteRequestId: quote.requestId, sourcePath: 'details.currencyIn.amountUsd', rounding: 'up' })
          || this.#now() < value.observedAtMs || this.#now() >= value.validUntilMs) throw new Error('native cycle creation requires fresh original producer valuation capabilities');
      }
      const plan = admitted.schema === 'hookemon.policy-admission.v4';
      nativeAdmissionProvenance = validateNativeAdmissionProvenance({ schema: plan ? 'hookemon.native-admission-provenance.v2' : 'hookemon.native-admission-provenance.v1',
        cycleId: openedCycleId, authority: this.#valuationAuthority(), admissionDigest: digest(admitted),
        ...(plan ? { units: admission.orders.map(unit => readProcessQuoteUsdProvenance(unit.unitFundingUsd)) } : { unit: readProcessQuoteUsdProvenance(admission.unitFundingUsd) }),
        aggregate: readProcessQuoteUsdProvenance(admission.aggregateFundingUsd) }, admitted, openedCycleId);
    }
    await this.#append(openedCycleId, 'cycle-opened', {
      releaseAmount,
      mode,
      ...(providerMode === null ? {} : { providerMode }),
      ...(dryRun ? { dryRun: true } : {}),
      ...(rehearsalSessionId === null ? {} : { rehearsalSessionId }),
      ...(admitted === null ? {} : { admission: admitted }),
      ...(packPlanSnapshot === null ? {} : { packPlanSnapshot }),
      ...(rewardSelection === null ? {} : { rewardSelection: structuredClone(rewardSelection) }),
      ...(nativeAdmissionProvenance === null ? {} : { nativeAdmissionProvenance }),
      openedAtMs: this.#now(),
    });
    return {
      cycleId: openedCycleId, releaseAmount, mode, providerMode, dryRun, rehearsalSessionId,
      admission: (await this.#replay(openedCycleId)).admission,
      ...(packPlanSnapshot === null ? {} : { packPlanSnapshot }),
      ...(rewardSelection === null ? {} : { rewardSelection: structuredClone(rewardSelection) }),
    };
  }

  /**
   * Durably records the stage-level request digest a signing boundary will demand.
   *
   * Chain-journal stages record their per-transaction attempts under per-plan digests, but the
   * standing-authority guard resolves against the *stage* request digest. Without this that digest
   * existed only inside one tick, so an external policy service had nothing to authorize against and
   * every live signing attempt for such a stage failed closed. Recording it grants nothing on its
   * own -- the artifact still has to carry a policy-signed intent for it.
   *
   * Idempotent for a repeated identical digest; a genuinely different prepared request adds its own.
   */
  async recordStageRequestDigest(cycleId, stage, requestDigest) {
    assertStageName(stage);
    if (typeof requestDigest !== 'string' || !digestPattern.test(requestDigest)) {
      throw new Error('cycle-repository recordStageRequestDigest: request digest is invalid');
    }
    const state = await this.#replay(cycleId);
    if ((state.stageRequestDigests.get(stage) ?? []).includes(requestDigest)) return;
    await this.#append(cycleId, 'stage-request-prepared', { stage, requestDigest });
  }

  /**
   * REQ-cycle-repository-2 `refresh-after-readmission` projection accessor. Returns `null` before
   * any expiry is recorded, `{ state: 'REFRESH_REQUIRED', expiry, expiryDigest }` after the first
   * event, or `{ state: 'ACTIVE', expiry, expiryDigest, replacement, replacementDigest,
   * refreshPolicyDecisionDigest, selectedAtMs }` once exactly one replacement has been selected.
   */
  async readOutboundQuoteRefresh(cycleId) {
    const state = await this.#replay(cycleId);
    return state.outboundQuoteRefresh ? structuredClone(state.outboundQuoteRefresh) : null;
  }

  /**
   * ADR-0025 proven-pre-effect-transient recovery for a Relay quote that expired before any
   * outbound request or signature existed. Allowed only while outbound has zero effect records of
   * any kind (no stage request digest, Relay leg, or chain attempt in any state -- PREPARED,
   * SIGNED, BROADCAST, and FINALIZED all block it identically). Idempotent for byte-identical
   * evidence; conflicts the moment any field differs, including the admission digest, either
   * quote's requestId/deadline/digest, or the observed time.
   */
  async recordOutboundQuoteExpired(cycleId, evidenceValue) {
    let lastContention = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const state = await this.#replay(cycleId);
      if (state.terminalState) throw new Error(`cycle-repository recordOutboundQuoteExpired: cycle is terminal as ${state.terminalState}`);
      const evidence = assertOutboundQuoteExpiryEvidence(evidenceValue, cycleId);
      assertOutboundQuoteExpiryEvidenceMatchesAdmission(evidence, state.admission);
      if (evidence.observedAtMs > currentRepositoryTime(this.#now)) {
        throw new Error('cycle-repository recordOutboundQuoteExpired: observedAtMs is later than the repository\'s trusted current time');
      }
      if (hasOutboundEffectRecords(state)) {
        throw new Error('cycle-repository recordOutboundQuoteExpired: an outbound stage request, Relay leg, or chain attempt already exists');
      }
      if (state.outboundQuoteRefresh) {
        if (canonicalJson(state.outboundQuoteRefresh.expiry) === canonicalJson(evidence)) {
          return structuredClone(state.outboundQuoteRefresh);
        }
        throw new Error('cycle-repository recordOutboundQuoteExpired: conflicting expiry evidence is already recorded');
      }
      try {
        await this.#append(cycleId, 'outbound-quote-expired', { evidence }, {
          operation: 'recordOutboundQuoteExpired',
          assertState: currentState => {
            if (hasOutboundEffectRecords(currentState)) {
              throw new Error('cycle-repository recordOutboundQuoteExpired: an outbound effect record appeared while recording expiry');
            }
            if (currentState.outboundQuoteRefresh) {
              throw new Error('cycle-repository recordOutboundQuoteExpired: expiry evidence was recorded concurrently');
            }
          },
        });
        const after = await this.#replay(cycleId);
        return structuredClone(after.outboundQuoteRefresh);
      } catch (error) {
        if (!/was recorded concurrently|effect record appeared while recording|expected version|journal head|durable cycle store lock contention/.test(error?.message ?? '')) {
          throw error;
        }
        lastContention = error;
      }
    }
    throw lastContention ?? new Error('cycle-repository recordOutboundQuoteExpired: contention did not resolve');
  }

  /**
   * ADR-0025 `refresh-after-readmission`'s single atomic replacement selection. The compare-and-set
   * re-proves the exact `REFRESH_REQUIRED` predecessor (by expiry digest), that no outbound effect
   * record exists, and that no competing replacement is already active -- a race between two
   * selectors leaves exactly one winner and the loser observes the predecessor failure directly,
   * never a silent overwrite. The replacement must preserve this cycle's identity, pack, quantity,
   * route/asset targets, and exactly the original claimed principal (`cycle.releaseAmount`): the
   * minimal compatible version refuses both a greater and a smaller replacement source amount.
   */
  async selectOutboundQuoteRefresh(cycleId, {
    predecessorExpiryDigest, replacement, refreshPolicyDecisionDigest, operations = null, assertLease = null,
  }) {
    assertDigest(predecessorExpiryDigest, 'cycle-repository selectOutboundQuoteRefresh predecessorExpiryDigest');
    assertDigest(refreshPolicyDecisionDigest, 'cycle-repository selectOutboundQuoteRefresh refreshPolicyDecisionDigest');
    if (assertLease !== null && typeof assertLease !== 'function') {
      throw new Error('cycle-repository selectOutboundQuoteRefresh assertLease must be a function or null');
    }
    assertLease?.();
    let lastContention = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const state = await this.#replay(cycleId);
      if (state.terminalState) throw new Error(`cycle-repository selectOutboundQuoteRefresh: cycle is terminal as ${state.terminalState}`);
      if (!state.outboundQuoteRefresh || state.outboundQuoteRefresh.state !== 'REFRESH_REQUIRED') {
        throw new Error('cycle-repository selectOutboundQuoteRefresh: requires an exact REFRESH_REQUIRED predecessor');
      }
      if (state.outboundQuoteRefresh.expiryDigest !== predecessorExpiryDigest) {
        throw new Error('cycle-repository selectOutboundQuoteRefresh: predecessor expiry digest does not match');
      }
      if (hasOutboundEffectRecords(state)) {
        throw new Error('cycle-repository selectOutboundQuoteRefresh: an outbound stage request, Relay leg, or chain attempt already exists');
      }
      const normalized = assertDurableCycleAdmission(
        replacement,
        cycleId,
        operations,
        'cycle-repository selectOutboundQuoteRefresh replacement admission',
      );
      assertOutboundQuoteReplacementIdentity(
        normalized, state.admission, state.releaseAmount, 'cycle-repository selectOutboundQuoteRefresh',
      );
      const replacementDigest = digest(normalized);
      try {
        const selectedAtMs = currentRepositoryTime(this.#now);
        assertOutboundQuoteReplacementFreshness(normalized, selectedAtMs, 'cycle-repository selectOutboundQuoteRefresh');
        await this.#append(cycleId, 'outbound-quote-refresh-selected', {
          predecessorExpiryDigest,
          replacement: normalized,
          replacementDigest,
          refreshPolicyDecisionDigest,
          selectedAtMs,
        }, {
          operation: 'selectOutboundQuoteRefresh',
          assertState: currentState => {
            if (!currentState.outboundQuoteRefresh || currentState.outboundQuoteRefresh.state !== 'REFRESH_REQUIRED') {
              throw new Error('cycle-repository selectOutboundQuoteRefresh: a replacement was already selected concurrently');
            }
            if (currentState.outboundQuoteRefresh.expiryDigest !== predecessorExpiryDigest) {
              throw new Error('cycle-repository selectOutboundQuoteRefresh: predecessor changed concurrently');
            }
            if (hasOutboundEffectRecords(currentState)) {
              throw new Error('cycle-repository selectOutboundQuoteRefresh: an outbound effect record appeared while selecting');
            }
          },
          assertLease,
        });
        const after = await this.#replay(cycleId);
        return structuredClone(after.outboundQuoteRefresh);
      } catch (error) {
        if (!/already selected concurrently|predecessor changed concurrently|effect record appeared while selecting|expected version|journal head|durable cycle store lock contention/.test(error?.message ?? '')) {
          throw error;
        }
        lastContention = error;
      }
    }
    throw lastContention ?? new Error('cycle-repository selectOutboundQuoteRefresh: contention did not resolve');
  }

  /**
   * Repository-owned finalized claim/custody evidence for this exact cycle -- never a wallet
   * balance, and never the pre-claim hook liability re-read as though it were still claimable.
   * Returns `null` until this cycle's own `claim-process` stage is durably COMPLETE behind exactly
   * one cycle-owned `claim-process` chain attempt in `FINALIZED`, the completed stage evidence is
   * canonically that attempt's own finality evidence, that finality evidence's `transactionHash`,
   * `claimedAmountAtomic`, and `destination` match the finalized attempt hash, the immutable
   * `releaseAmount`, and the admitted Operations identity respectively, and this cycle's custody
   * ledger for the admitted funding chain/asset carries exactly that claimed amount. V1 proves
   * only that these exact durable claim-attempt/finality fields and the exact amount/asset ledger
   * row coexist for this cycle -- it never accepts an unrelated chain/asset row, a zero or
   * mismatched claimed bucket, or event-level ledger provenance V1 cannot carry. Missing, multiple,
   * nonfinal, or any mismatched field returns `null`, never a partial or best-effort result.
   */
  async readFinalizedClaimCustodyEvidence(cycleId) {
    const state = await this.#replay(cycleId);
    const claimStage = state.stages.get('claim-process');
    if (!claimStage || claimStage.status !== 'COMPLETE') return null;
    const finalizedAttempts = [...state.chainAttempts.values()]
      .filter(record => record.attempt.stage === 'claim-process' && record.attempt.state === 'FINALIZED');
    if (finalizedAttempts.length !== 1) return null;
    const [finalized] = finalizedAttempts;
    if (canonicalJson(claimStage.evidence) !== canonicalJson(finalized.finalityEvidence)) return null;
    if (!state.admission) return null;
    const evidence = finalized.finalityEvidence;
    if (typeof evidence.transactionHash !== 'string' || typeof finalized.attempt.hash !== 'string'
      || evidence.transactionHash.toLowerCase() !== finalized.attempt.hash.toLowerCase()) {
      return null;
    }
    if (evidence.claimedAmountAtomic !== state.releaseAmount) return null;
    const operations = state.admission.processLiabilityEvidence.operations;
    if (typeof evidence.destination !== 'string' || typeof operations !== 'string'
      || evidence.destination.toLowerCase() !== operations.toLowerCase()) {
      return null;
    }
    const funding = state.admission.aggregateFundingQuote;
    if (funding.chainId !== '4663' || funding.assetId !== 'native' || funding.decimals !== 18) return null;
    const chainId = '4663';
    const assetId = 'native';
    const ledger = state.custodyLedgers.get(custodyLedgerKey({ chainId, assetId }));
    if (!ledger || ledger.decimals !== funding.decimals || ledger.claimed !== state.releaseAmount) return null;
    return Object.freeze({
      cycleId,
      claimEvidence: structuredClone(claimStage.evidence),
      custodyLedgers: Object.freeze([...state.custodyLedgers.values()].map(ledger => structuredClone(ledger))),
    });
  }

  /** @returns {Promise<{status: 'COMPLETE', evidence: unknown}|{status: 'PENDING'}>} */
  async readStage(cycleId, stage) {
    assertStageName(stage, { allowLegacyRead: true });
    const state = await this.#replay(cycleId);
    const stored = state.stages.get(stage) ?? { status: 'PENDING' };
    if (stored.status !== 'COMPLETE') return stored;
    const evidence = await this.#resolveStageEvidence(cycleId, stage, stored.evidence);
    return evidence === stored.evidence ? stored : { status: 'COMPLETE', evidence };
  }

  /**
   * Reconstructs oversized stage evidence from durable paged storage when `storedEvidence` is the
   * immutable handle `persistPagedStageEvidence` returned at completion time; returns
   * `storedEvidence` unchanged otherwise. Passing the handle back in as `readPagedStageEvidence`'s
   * `expected` argument makes a missing blob, an identity mismatch, or a manifest that no longer
   * matches this exact handle a hard failure there -- never a silent `null` -- so absence and
   * corruption stay distinct recovery facts.
   */
  async #resolveStageEvidence(cycleId, stage, storedEvidence) {
    if (!isStageEvidencePageReference(storedEvidence)) return storedEvidence;
    const wrapped = await this.#store.readPagedStageEvidence(cycleId, stage, storedEvidence);
    return wrapped.evidence;
  }

  /**
   * Evidence that fits one bounded journal payload is returned unchanged. Oversized evidence (for
   * example a real eligibility-snapshot manifest with more holders than the journal's 64-item
   * array bound admits) is persisted through the durable paged-stage-evidence store first, wrapped
   * as `{cycleId, evidence}` to satisfy that store's own cycleId-binding requirement without
   * altering the evidence shape callers of readStage/completeStage see back. Only the immutable,
   * content-addressed handle `persistPagedStageEvidence` returns is journaled -- the handle commits
   * only after the blob is durable, a same-payload retry reuses it, and a differently-shaped retry
   * for the same (cycleId, stage) is rejected by the store itself before any reference is journaled.
   */
  async #preparePagedStageEvidence(cycleId, stage, evidence) {
    if (fitsBoundedJournalPayload(evidence)) return evidence;
    if (typeof this.#store.persistPagedStageEvidence !== 'function' || typeof this.#store.readPagedStageEvidence !== 'function') {
      throw new Error(`cycle-repository completeStage: stage "${stage}" evidence exceeds the bounded journal payload and this store has no paged-stage-evidence support`);
    }
    return this.#store.persistPagedStageEvidence(cycleId, stage, { cycleId, evidence: structuredClone(evidence) });
  }

  async prepareStage(cycleId, stage) {
    assertStageName(stage);
    const state = await this.#replay(cycleId);
    if (state.terminalState) {
      throw new Error(`cycle-repository prepareStage: cycle is terminal as ${state.terminalState}`);
    }
    const previous = state.preparedStages.get(stage);
    if (previous) {
      return { status: 'PREPARED', stage, journalHead: previous.journalHead };
    }
    const entry = await this.#append(cycleId, 'stage-prepared', { stage }, { operation: 'prepareStage' });
    return { status: 'PREPARED', stage, journalHead: entry.digest };
  }

  async completeStage(cycleId, stage, evidence) {
    assertStageName(stage);
    const state = await this.#replay(cycleId);
    if (state.terminalState) {
      throw new Error(`cycle-repository completeStage: cycle is terminally held as ${state.terminalState}`);
    }
    const current = state.stages.get(stage) ?? { status: 'PENDING' };
    if (current.status === 'COMPLETE') {
      const currentEvidence = await this.#resolveStageEvidence(cycleId, stage, current.evidence);
      if (canonicalJson(currentEvidence) !== canonicalJson(evidence)) {
        throw new Error(`cycle-repository completeStage: stage "${stage}" was already completed with different evidence`);
      }
      return; // idempotent retry
    }
    if (stage === 'eligibility-snapshot') assertCycleRewardSelectionEvidence(cycleId, state.rewardSelection, evidence);
    assertPreparedOrderedCompletion(state, stage);
    assertReconciledCompletion(state, stage, evidence);
    const storedEvidence = await this.#preparePagedStageEvidence(cycleId, stage, evidence);
    await this.#append(cycleId, 'stage-completed', { stage, evidence: storedEvidence }, {
      operation: 'completeStage',
      assertState: currentState => {
        const latest = currentState.stages.get(stage) ?? { status: 'PENDING' };
        if (latest.status === 'COMPLETE') {
          throw new Error(`cycle-repository completeStage: stage "${stage}" changed while completing`);
        }
        assertPreparedOrderedCompletion(currentState, stage);
        assertReconciledCompletion(currentState, stage, evidence);
      },
    });
  }

  async completeCycle(cycleId) {
    const state = await this.#replay(cycleId);
    if (state.terminalState && state.terminalState !== 'COMPLETED') {
      throw new Error(`cycle-repository completeCycle: cycle is terminally held as ${state.terminalState}`);
    }
    if (!state.completed) {
      assertCycleClosure(state);
      await this.#append(cycleId, 'cycle-completed', { completedAtMs: currentRepositoryTime(this.#now) }, {
        operation: 'completeCycle',
        assertState: assertCycleClosure,
      });
    }
    const completed = await this.#replay(cycleId);
    if (!hasOpenHeldPositions(completed)) {
      try {
        await this.#store.archiveCycle(cycleId);
      } catch (error) {
        if (!/already archived/.test(error.message)) throw error;
      }
    }
  }

  /** Read-only accessor for `bin/hookemon-runner.mjs status` and tests. */
  async describeCycle(cycleId) {
    return this.#replay(cycleId);
  }

  createCycleRunner(cycleId) {
    return createCycleRepositoryRunner(this, cycleId);
  }

  /** Record an explicit terminal hold. Held cycles remain active until an owner recovery decision. */
  async holdCycle(cycleId, terminalState, evidence = {}, { assertLease = null } = {}) {
    assertCycleTerminalState(terminalState);
    if (!terminalState.startsWith('HELD_')) throw new Error('cycle-repository holdCycle requires a held terminal state');
    if (assertLease !== null && typeof assertLease !== 'function') {
      throw new Error('cycle-repository holdCycle assertLease must be a function or null');
    }
    assertLease?.();
    const state = await this.#replay(cycleId);
    if (state.terminalState) {
      if (state.terminalState !== terminalState) throw new Error('cycle-repository holdCycle terminal state conflict');
      if (canonicalJson(state.terminalEvidence) !== canonicalJson(evidence)) {
        throw new Error('cycle-repository holdCycle terminal evidence conflict');
      }
      return;
    }
    await this.#append(cycleId, 'cycle-terminal', {
      terminalState,
      evidence: cloneEvidence(evidence, 'cycle terminal evidence'),
      terminalAtMs: currentRepositoryTime(this.#now),
    }, {
      assertState: currentState => {
        if (currentState.terminalState) throw new Error('cycle-repository holdCycle terminal state changed while recording hold');
      },
      assertLease,
    });
  }

  /** Terminal per-memo outcomes authorize resuming a known generated plan prefix. */
  async readPackOrderReconciliation(cycleId, orderIndex) {
    return structuredClone((await this.#replay(cycleId)).packOrderReconciliations.get(orderIndex) ?? null);
  }
  async recordPackOrderReconciliation(cycleId, orderIndex, outcomes) {
    const state = await this.#replay(cycleId);
    const batch = state.packBatchRequests.get(`purchase:${orderIndex}`);
    const checked = assertPackOrderReconciliation(state.admission, batch, orderIndex, outcomes);
    const existing = state.packOrderReconciliations.get(orderIndex);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(checked)) throw new Error('pack order reconciliation conflicts with prior outcome');
      return structuredClone(existing);
    }
    await this.#append(cycleId, 'pack-order-reconciled', { orderIndex, outcomes: checked,
      admissionDigest: digest(state.admission), responseDigest: digest(batch) }, { operation: 'recordPackOrderReconciliation', assertState: current => {
      if (current.terminalState || canonicalJson(current.packBatchRequests.get(`purchase:${orderIndex}`)) !== canonicalJson(batch)) throw new Error('pack order changed during reconciliation');
    } });
    return checked;
  }

  async readPackOrderIntent(cycleId, orderIndex) {
    return structuredClone((await this.#replay(cycleId)).packBatchIntents.get(`purchase:${orderIndex}`) ?? null);
  }
  async readPackOrderRequest(cycleId, orderIndex) {
    return structuredClone((await this.#replay(cycleId)).packBatchRequests.get(`purchase:${orderIndex}`) ?? null);
  }
  async recordPackOrderIntent(cycleId, orderIndex, intent, requestDigest) {
    const state = await this.#replay(cycleId);
    const payload = { stage: 'purchase', orderIndex, intent, requestDigest, admissionDigest: digest(state.admission), recordedAtMs: this.#now() };
    return this.#recordPackOrder(cycleId, state, 'pack-order-intent-recorded', payload);
  }
  async recordPackOrderRequest(cycleId, orderIndex, packs) {
    const state = await this.#replay(cycleId);
    return this.#recordPackOrder(cycleId, state, 'pack-order-request-recorded', { stage: 'purchase', orderIndex, packs, requestedAtMs: this.#now() });
  }
  async #recordPackOrder(cycleId, state, kind, payload) {
    const apply = current => {
      if (current.terminalState) throw new Error('terminal cycle refuses pack order mutation');
      applyPackOrderEvent({ admission: current.admission, cycleId, payload, kind,
        intents: new Map(current.packBatchIntents), requests: new Map(current.packBatchRequests), requestDigests: current.stageRequestDigests });
    };
    apply(state);
    const key = `purchase:${payload.orderIndex}`;
    const existing = (kind === 'pack-order-intent-recorded' ? state.packBatchIntents : state.packBatchRequests).get(key);
    if (!existing) await this.#append(cycleId, kind, payload, { operation: kind === 'pack-order-intent-recorded' ? 'recordPackOrderIntent' : 'recordPackOrderRequest', assertState: apply });
    return kind === 'pack-order-intent-recorded' ? this.readPackOrderIntent(cycleId, payload.orderIndex) : this.readPackOrderRequest(cycleId, payload.orderIndex);
  }

  async recordPackBatchIntent(cycleId, stage, intentValue) {
    assertPackOperationStageName(stage);
    const intent = assertPackBatchIntent(intentValue, `${stage} pack batch intent`);
    const state = await this.#replay(cycleId);
    if (state.admission?.schema === 'hookemon.policy-admission.v4') throw new Error('plan admission refuses legacy batch mutation');
    if (state.terminalState) {
      throw new Error(`cycle-repository recordPackBatchIntent: cycle is terminal as ${state.terminalState}`);
    }
    const existing = state.packBatchIntents.get(stage);
    if (existing) {
      if (canonicalJson(existing.intent) === canonicalJson(intent)) return structuredClone(existing);
      throw new Error(`cycle-repository recordPackBatchIntent: stage "${stage}" already has a different pack batch intent`);
    }
    const recordedAtMs = currentRepositoryTime(this.#now);
    await this.#append(cycleId, 'pack-batch-intent-recorded', { stage, intent, recordedAtMs }, {
      operation: 'recordPackBatchIntent',
      assertState: currentState => {
        const latest = currentState.packBatchIntents.get(stage);
        if (latest && canonicalJson(latest.intent) !== canonicalJson(intent)) {
          throw new Error(`cycle-repository recordPackBatchIntent: stage "${stage}" changed while recording the pack batch intent`);
        }
      },
    });
    const latest = await this.#replay(cycleId);
    return structuredClone(latest.packBatchIntents.get(stage));
  }

  /** @returns {Promise<{recordedAtMs: number, intent: {quantity: number, packType: string|null, expectedCardCountPerPack: number, playerAddress: string}}|null>} */
  async readPackBatchIntent(cycleId, stage) {
    assertPackOperationStageName(stage);
    const state = await this.#replay(cycleId);
    const record = state.packBatchIntents.get(stage);
    return record ? structuredClone(record) : null;
  }

  /**
   * Durably persists every pack a single batch provider call generated (memo, expected card
   * count, pack type) before any transaction is signed. Idempotent for the exact same batch:
   * this is the sole guard against re-issuing a batch purchase whose response was lost after the
   * provider already committed it. A stage may record at most one batch (bounded to
   * `MAXIMUM_PACK_BATCH_SIZE` packs by the shared journal payload limit).
   */
  async recordPackBatchRequest(cycleId, stage, packsValue) {
    assertPackOperationStageName(stage);
    const packs = assertPackBatchRequest(packsValue, `${stage} pack batch request`);
    const state = await this.#replay(cycleId);
    if (state.admission?.schema === 'hookemon.policy-admission.v4') throw new Error('plan admission refuses legacy batch mutation');
    if (state.terminalState) {
      throw new Error(`cycle-repository recordPackBatchRequest: cycle is terminal as ${state.terminalState}`);
    }
    const existing = state.packBatchRequests.get(stage);
    if (existing) {
      if (canonicalJson(existing.packs) === canonicalJson(packs)) return structuredClone(existing);
      throw new Error(`cycle-repository recordPackBatchRequest: stage "${stage}" already has a different pack batch`);
    }
    const requestedAtMs = currentRepositoryTime(this.#now);
    await this.#append(cycleId, 'pack-batch-request-recorded', { stage, packs, requestedAtMs }, {
      operation: 'recordPackBatchRequest',
      assertState: currentState => {
        const latest = currentState.packBatchRequests.get(stage);
        if (latest && canonicalJson(latest.packs) !== canonicalJson(packs)) {
          throw new Error(`cycle-repository recordPackBatchRequest: stage "${stage}" changed while recording the pack batch`);
        }
      },
    });
    const latest = await this.#replay(cycleId);
    return structuredClone(latest.packBatchRequests.get(stage));
  }

  /** @returns {Promise<{requestedAtMs: number, packs: Array<{packIndex: number, memo: string, expectedCardCount: number, packType: string|null}>}|null>} */
  async readPackBatchRequest(cycleId, stage) {
    assertPackOperationStageName(stage);
    const state = await this.#replay(cycleId);
    const record = state.packBatchRequests.get(stage);
    return record ? structuredClone(record) : null;
  }

  /**
   * Carve one card out of the cycle without changing the cycle's terminal state. The record is
   * append-only and binds the card identity, attributed cost, valuation basis, and observed
   * evidence together so later stages cannot quietly move it into another cycle.
   */
  async recordHeldPosition(cycleId, input) {
    const { position, evidence, ledgerAsset } = heldPositionInput(cycleId, input, currentRepositoryTime(this.#now));
    const state = await this.#replay(cycleId);
    if (!isNativeAdmission(state.admission) || position.costMicroUsd !== state.admission.aggregateFundingUsd?.amountMicroUsd) throw new Error('held USD cost is not the committed admission basis');
    const existing = state.heldPositions.get(position.positionId) ?? null;
    if (existing !== null) {
      if (existing.evidenceDigest === position.evidenceDigest) {
        assertHeldPositionLedgerAssociation(state, position.positionId, ledgerAsset);
        return structuredClone(existing);
      }
      throw new Error('cycle-repository recordHeldPosition: card already has conflicting held custody');
    }
    if (state.terminalState) {
      throw new Error(`cycle-repository recordHeldPosition: cycle is terminal as ${state.terminalState}`);
    }
    const ledger = ledgerAsset === null
      ? null
      : heldPositionCustodyLedger(state.custodyLedgers, cycleId, ledgerAsset, position);

    try {
      await this.#append(cycleId, 'held-position-recorded', {
        position,
        evidence,
        ...(ledger === null ? {} : { ledger }),
      }, {
        operation: 'recordHeldPosition',
        assertState: currentState => {
          const latest = currentState.heldPositions.get(position.positionId) ?? null;
          if (latest !== null && canonicalJson(latest) !== canonicalJson(position)) {
            throw new Error('cycle-repository recordHeldPosition: card changed while recording custody');
          }
          if (ledger !== null) {
            const expected = heldPositionCustodyLedger(currentState.custodyLedgers, cycleId, ledgerAsset, position);
            if (canonicalJson(expected) !== canonicalJson(ledger)) {
              throw new Error('cycle-repository recordHeldPosition: custody ledger changed while recording custody');
            }
          }
        },
      });
    } catch (error) {
      if (!/stale cycle journal (?:version|head)/.test(error?.message ?? '')) throw error;
      const latest = await this.#replay(cycleId);
      const persisted = latest.heldPositions.get(position.positionId) ?? null;
      if (persisted !== null && persisted.evidenceDigest === position.evidenceDigest) {
        assertHeldPositionLedgerAssociation(latest, position.positionId, ledgerAsset);
        return structuredClone(persisted);
      }
      throw error;
    }
    return structuredClone(position);
  }

  async readHeldPosition(positionId) {
    if (typeof positionId !== 'string' || !heldPositionIdPattern.test(positionId)) {
      throw new Error('cycle-repository readHeldPosition: positionId is invalid');
    }
    for (const { state } of await this.#knownStates()) {
      const position = state.heldPositions.get(positionId) ?? null;
      if (position !== null) return structuredClone(position);
    }
    return null;
  }

  async readHeldPositionEvidence(positionId) {
    if (typeof positionId !== 'string' || !heldPositionIdPattern.test(positionId)) {
      throw new Error('cycle-repository readHeldPositionEvidence: positionId is invalid');
    }
    for (const { state } of await this.#knownStates()) {
      const evidence = state.heldPositionEvidence.get(positionId);
      if (evidence !== undefined) return structuredClone(evidence);
    }
    return null;
  }

  async recordHeldPositionIdentity(positionId, input) {
    if (typeof positionId !== 'string' || !heldPositionIdPattern.test(positionId)) {
      throw new Error('cycle-repository recordHeldPositionIdentity: positionId is invalid');
    }
    exactObject(input, ['mint', 'provenance', 'evidence'], 'held position identity input');
    const locations = await this.#knownStates();
    const location = locations.find(({ state }) => state.heldPositions.has(positionId)) ?? null;
    if (location === null) throw new Error('cycle-repository recordHeldPositionIdentity: held position is unknown');
    const current = location.state.heldPositions.get(positionId);
    if (current.resolution !== null) {
      throw new Error('cycle-repository recordHeldPositionIdentity: held position is already resolved');
    }
    if (current.mint !== null) {
      throw new Error('cycle-repository recordHeldPositionIdentity: held position already has an immutable mint');
    }
    if (current.identity !== null) {
      if (current.identity.mint === input.mint) return structuredClone(current);
      throw new Error('held position identity conflicts with a previously verified identity');
    }
    const mint = assertHeldPositionText(input.mint, 'held position identity input.mint');
    const provenance = input.provenance;
    exactObject(provenance, [
      'memo', 'openSignature', 'packStatusMint', 'derivedMint', 'custodyOwner',
      'openSignatureSource', 'assetKind',
    ], 'held position identity input provenance');
    for (const field of ['memo', 'openSignature', 'packStatusMint', 'derivedMint', 'custodyOwner']) {
      if (typeof provenance[field] !== 'string' || provenance[field].length === 0) {
        throw new Error(`held position identity input provenance.${field} is invalid`);
      }
    }
    if (!['held-evidence', 'open-evidence', 'collector-finalized-send'].includes(provenance.openSignatureSource)) {
      throw new Error('held position identity input provenance.openSignatureSource is invalid');
    }
    if (!['spl', 'mpl-core'].includes(provenance.assetKind)) {
      throw new Error('held position identity input provenance.assetKind is invalid');
    }
    if (provenance.memo !== current.memo) {
      throw new Error('held position identity input provenance.memo does not match the held position');
    }
    if (provenance.packStatusMint !== mint || provenance.derivedMint !== mint) {
      throw new Error('held position identity input provenance mint does not match the verified identity');
    }
    const evidence = cloneEvidence(input.evidence, 'held position identity input evidence');
    const identity = assertHeldPositionIdentity({
      mint,
      verifiedAtMs: currentRepositoryTime(this.#now),
      evidenceDigest: heldPositionIdentityEvidenceDigest(
        current.positionId,
        current.evidenceDigest,
        mint,
        provenance,
      ),
      provenance,
    }, current, 'held position identity');
    try {
      await this.#append(location.cycleId, 'held-position-identity-verified', {
        positionId,
        identity,
        evidence,
      }, {
        // Held-card recovery outlives the original cycle; the checks below fence its identity.
        assertState: state => {
          const latest = state.heldPositions.get(positionId) ?? null;
          if (latest === null || latest.resolution !== null || latest.mint !== null) {
            throw new Error('cycle-repository recordHeldPositionIdentity: held position changed while recording identity');
          }
          if (latest.identity !== null) {
            if (latest.identity.mint !== mint) {
              throw new Error('held position identity conflicts with a previously verified identity');
            }
            if (canonicalJson(latest.identity) !== canonicalJson(identity)) {
              throw new Error('cycle-repository recordHeldPositionIdentity: identity changed while recording');
            }
          }
        },
      });
    } catch (error) {
      if (!/stale cycle journal (?:version|head)/.test(error?.message ?? '')) throw error;
      const latest = await this.#replay(location.cycleId);
      const persisted = latest.heldPositions.get(positionId) ?? null;
      if (persisted?.identity?.mint === mint) return structuredClone(persisted);
      throw error;
    }
    return structuredClone({
      ...current,
      identity,
    });
  }

  async listHeldPositions({ cycleId = undefined, includeResolved = false } = {}) {
    if (cycleId !== undefined && (typeof cycleId !== 'string' || cycleId.length === 0)) {
      throw new Error('cycle-repository listHeldPositions: cycleId is invalid');
    }
    if (typeof includeResolved !== 'boolean') {
      throw new Error('cycle-repository listHeldPositions: includeResolved is invalid');
    }
    const positions = [];
    for (const { cycleId: candidateCycleId, state } of await this.#knownStates()) {
      if (cycleId !== undefined && candidateCycleId !== cycleId) continue;
      for (const position of state.heldPositions.values()) {
        if (includeResolved || position.resolution === null) positions.push(structuredClone(position));
      }
    }
    return positions.sort((left, right) => left.openedAtMs - right.openedAtMs || left.positionId.localeCompare(right.positionId));
  }

  /**
   * Persist an owner choice for one held position. `keep-holding` is intentionally repeatable;
   * a later `sell` advances that position revision exactly once and leaves the cycle runnable.
   */
  async recordHeldOwnerDecision(positionId, input) {
    if (typeof positionId !== 'string' || !heldPositionIdPattern.test(positionId)) {
      throw new Error('cycle-repository recordHeldOwnerDecision: positionId is invalid');
    }
    const decision = heldPositionOwnerDecisionInput(positionId, input);
    const locations = await this.#knownStates();
    const location = locations.find(({ state }) => state.heldPositions.has(positionId)) ?? null;
    if (location === null) throw new Error('cycle-repository recordHeldOwnerDecision: held position is unknown');
    if (location.state.archived) {
      throw new Error('cycle-repository recordHeldOwnerDecision: archived held positions require supplementary settlement recovery');
    }
    const current = location.state.heldPositions.get(positionId);
    const transition = heldPositionOwnerDecisionTransition(current, decision);
    if (transition.position === current) return structuredClone(transition.decision);
    const settlement = decision.choice === 'sell'
      ? supplementarySettlementFor(
        transition.position,
        location.state.supplementarySettlements.size + 1,
        completedEligibilitySnapshotEvidenceDigest(location.state, location.cycleId),
      )
      : null;

    try {
      await this.#append(location.cycleId, 'held-position-owner-decision-recorded', {
        positionId,
        decision,
        position: transition.position,
        ...(settlement === null ? {} : { settlement }),
      }, {
        assertState: state => {
          const latest = state.heldPositions.get(positionId) ?? null;
          if (latest === null) throw new Error('cycle-repository recordHeldOwnerDecision: held position disappeared');
          const latestTransition = heldPositionOwnerDecisionTransition(latest, decision);
          if (canonicalJson(latestTransition.position) !== canonicalJson(transition.position)) {
            throw new Error('cycle-repository recordHeldOwnerDecision: held position changed while recording decision');
          }
          if (settlement !== null) {
            if (state.supplementarySettlements.has(positionId)) {
              throw new Error('cycle-repository recordHeldOwnerDecision: supplementary settlement already exists');
            }
            const currentSnapshotDigest = completedEligibilitySnapshotEvidenceDigest(state, location.cycleId);
            if (settlement.eligibilitySnapshotEvidenceDigest !== currentSnapshotDigest) {
              throw new Error('cycle-repository recordHeldOwnerDecision: eligibility snapshot changed while recording decision');
            }
          }
        },
      });
    } catch (error) {
      if (!/stale cycle journal (?:version|head)/.test(error?.message ?? '')) throw error;
      const latest = await this.#replay(location.cycleId);
      const persisted = latest.heldPositions.get(positionId) ?? null;
      if (persisted?.ownerDecision !== null && canonicalJson(persisted.ownerDecision) === canonicalJson(decision)) {
        return structuredClone(persisted.ownerDecision);
      }
      throw error;
    }
    return structuredClone(decision);
  }

  async readSupplementarySettlement(positionId) {
    if (typeof positionId !== 'string' || !heldPositionIdPattern.test(positionId)) {
      throw new Error('cycle-repository readSupplementarySettlement: positionId is invalid');
    }
    for (const { state } of await this.#knownStates()) {
      const settlement = state.supplementarySettlements.get(positionId) ?? null;
      if (settlement !== null) return structuredClone(settlement);
    }
    return null;
  }

  /**
   * Returns the latest durable supplementary boundary evidence for recovery. It is deliberately
   * unavailable from the narrow repository client because it can contain provider transaction
   * facts; the stage driver uses the full repository only while reconciling a held position.
   */
  async readSupplementarySettlementEvidence(positionId) {
    if (typeof positionId !== 'string' || !heldPositionIdPattern.test(positionId)) {
      throw new Error('cycle-repository readSupplementarySettlementEvidence: positionId is invalid');
    }
    for (const { state } of await this.#knownStates()) {
      const evidence = state.supplementarySettlementEvidence.get(positionId) ?? null;
      if (evidence !== null) return structuredClone(evidence);
    }
    return null;
  }

  async #supplementarySettlementLocation(positionId, operation) {
    if (typeof positionId !== 'string' || !heldPositionIdPattern.test(positionId)) {
      throw new Error(`cycle-repository ${operation}: positionId is invalid`);
    }
    const locations = await this.#knownStates();
    const location = locations.find(({ state }) => state.supplementarySettlements.has(positionId)) ?? null;
    if (location === null) throw new Error(`cycle-repository ${operation}: settlement is unknown`);
    if (location.state.archived) throw new Error(`cycle-repository ${operation}: archived settlement requires recovery`);
    return location;
  }

  /**
   * Position-scoped pre-send write-ahead record for a supplementary settlement's own resale/
   * return/payout transaction -- the same "durable before the provider call" guarantee
   * prepareChainTransactionAttempt gives an ordinary stage, keyed by positionId instead so it can
   * never collide with the main cycle's own chain attempts for the identical cycleId.
   */
  async prepareSupplementaryChainTransactionAttempt(positionId, attemptValue) {
    const location = await this.#supplementarySettlementLocation(positionId, 'prepareSupplementaryChainTransactionAttempt');
    const attempt = assertSupplementaryChainAttempt(attemptValue, 'supplementary chain transaction attempt');
    if (attempt.positionId !== positionId || attempt.state !== 'PREPARED') {
      throw new Error('cycle-repository prepareSupplementaryChainTransactionAttempt attempt does not match its position');
    }
    const key = supplementaryChainAttemptKey(positionId, attempt.requestDigest);
    const current = location.state.supplementaryChainAttempts.get(key);
    if (current) {
      if (canonicalJson(current.attempt) !== canonicalJson(attempt)) {
        throw new Error(`cycle-repository prepareSupplementaryChainTransactionAttempt: request "${attempt.requestDigest}" already has an attempt`);
      }
      return structuredClone(current);
    }
    await this.#append(location.cycleId, 'supplementary-chain-attempt-prepared', { attempt }, {
      assertState: currentState => {
        if (currentState.supplementaryChainAttempts.has(key)) {
          throw new Error(`cycle-repository prepareSupplementaryChainTransactionAttempt: request "${attempt.requestDigest}" already has an attempt`);
        }
      },
    });
    return { attempt, broadcastEvidence: null };
  }

  /** @returns {Promise<{attempt: object, broadcastEvidence: object|null}|null>} */
  async readSupplementaryChainTransactionAttempt(positionId, requestDigest) {
    if (typeof positionId !== 'string' || !heldPositionIdPattern.test(positionId)) {
      throw new Error('cycle-repository readSupplementaryChainTransactionAttempt: positionId is invalid');
    }
    const key = supplementaryChainAttemptKey(positionId, requestDigest);
    for (const { state } of await this.#knownStates()) {
      const current = state.supplementaryChainAttempts.get(key);
      if (current) return structuredClone(current);
    }
    return null;
  }

  async recordSupplementarySignedTransaction(positionId, requestDigest, signingMaterial) {
    const location = await this.#supplementarySettlementLocation(positionId, 'recordSupplementarySignedTransaction');
    const key = supplementaryChainAttemptKey(positionId, requestDigest);
    const current = location.state.supplementaryChainAttempts.get(key);
    if (!current) throw new Error(`cycle-repository recordSupplementarySignedTransaction: no prepared attempt for "${requestDigest}"`);
    const prepared = { ...current.attempt, state: 'PREPARED', rawBytes: null, nonce: null, blockhash: null, hash: null };
    const signed = transitionSupplementaryChainAttempt(prepared, 'SIGNED', signingMaterial);
    if (current.attempt.state === 'SIGNED') {
      if (canonicalJson(current.attempt) !== canonicalJson(signed)) {
        throw new Error(`cycle-repository recordSupplementarySignedTransaction: "${requestDigest}" already has different signing material`);
      }
      return structuredClone(current);
    }
    if (current.attempt.state !== 'PREPARED') {
      throw new Error(`cycle-repository recordSupplementarySignedTransaction: "${requestDigest}" is already broadcast and cannot be re-signed`);
    }
    await this.#append(location.cycleId, 'supplementary-chain-attempt-signed', { attempt: signed }, {
      assertState: currentState => {
        const latest = currentState.supplementaryChainAttempts.get(key);
        if (!latest || canonicalJson(latest.attempt) !== canonicalJson(current.attempt)) {
          throw new Error(`cycle-repository recordSupplementarySignedTransaction: "${requestDigest}" changed while recording signing material`);
        }
      },
    });
    return { ...current, attempt: signed };
  }

  /**
   * Atomically records the only signed bytes a supplementary effect may broadcast and the exact
   * policy-recovery material needed to resume them. A process crash can therefore expose either
   * the PREPARED attempt or both values, never an unrecoverable signed attempt.
   */
  async recordSupplementarySignedTransactionWithRecoveryContext(positionId, requestDigest, signingMaterial, contextValue) {
    const location = await this.#supplementarySettlementLocation(positionId, 'recordSupplementarySignedTransactionWithRecoveryContext');
    const context = assertSupplementaryChainAttemptRecoveryContext(contextValue, 'supplementary chain attempt recovery context');
    if (context.positionId !== positionId || context.requestDigest !== requestDigest) {
      throw new Error('cycle-repository recordSupplementarySignedTransactionWithRecoveryContext context does not match its attempt');
    }
    const key = supplementaryChainAttemptKey(positionId, requestDigest);
    const current = location.state.supplementaryChainAttempts.get(key);
    if (!current) throw new Error(`cycle-repository recordSupplementarySignedTransactionWithRecoveryContext: no prepared attempt for "${requestDigest}"`);
    const prepared = { ...current.attempt, state: 'PREPARED', rawBytes: null, nonce: null, blockhash: null, hash: null };
    const signed = transitionSupplementaryChainAttempt(prepared, 'SIGNED', signingMaterial);
    if (context.rawSignedBytesHash !== signed.hash) {
      throw new Error('cycle-repository recordSupplementarySignedTransactionWithRecoveryContext context does not bind signed bytes');
    }
    const existingContext = location.state.supplementaryChainAttemptRecoveryContexts.get(key);
    if (current.attempt.state === 'SIGNED') {
      if (canonicalJson(current.attempt) !== canonicalJson(signed) || canonicalJson(existingContext) !== canonicalJson(context)) {
        throw new Error(`cycle-repository recordSupplementarySignedTransactionWithRecoveryContext: "${requestDigest}" already has different signing material or recovery context`);
      }
      return structuredClone(current);
    }
    if (current.attempt.state !== 'PREPARED' || existingContext) {
      throw new Error(`cycle-repository recordSupplementarySignedTransactionWithRecoveryContext: "${requestDigest}" cannot be re-signed`);
    }
    await this.#append(location.cycleId, 'supplementary-chain-attempt-signed-with-recovery-context', { attempt: signed, context }, {
      assertState: currentState => {
        const latest = currentState.supplementaryChainAttempts.get(key);
        if (!latest || canonicalJson(latest.attempt) !== canonicalJson(current.attempt)
          || currentState.supplementaryChainAttemptRecoveryContexts.has(key)) {
          throw new Error(`cycle-repository recordSupplementarySignedTransactionWithRecoveryContext: "${requestDigest}" changed while recording signing material`);
        }
      },
    });
    return { ...current, attempt: signed };
  }

  async recordSupplementaryBroadcast(positionId, requestDigest, evidence) {
    const location = await this.#supplementarySettlementLocation(positionId, 'recordSupplementaryBroadcast');
    const key = supplementaryChainAttemptKey(positionId, requestDigest);
    const current = location.state.supplementaryChainAttempts.get(key);
    if (!current) throw new Error(`cycle-repository recordSupplementaryBroadcast: no signed attempt for "${requestDigest}"`);
    const broadcastEvidence = cloneChainObservationEvidence(evidence, 'supplementary chain transaction broadcast evidence');
    if (current.attempt.state === 'BROADCAST') {
      if (canonicalJson(current.broadcastEvidence) !== canonicalJson(broadcastEvidence)) {
        throw new Error(`cycle-repository recordSupplementaryBroadcast: "${requestDigest}" already has different broadcast evidence`);
      }
      return structuredClone(current);
    }
    const attempt = transitionSupplementaryChainAttempt(current.attempt, 'BROADCAST');
    await this.#append(location.cycleId, 'supplementary-chain-attempt-broadcast', { attempt, evidence: broadcastEvidence }, {
      assertState: currentState => {
        const latest = currentState.supplementaryChainAttempts.get(key);
        if (!latest || latest.attempt.state !== 'SIGNED') {
          throw new Error(`cycle-repository recordSupplementaryBroadcast: "${requestDigest}" changed while recording the broadcast`);
        }
      },
    });
    return { attempt, broadcastEvidence };
  }

  /**
   * Durably binds a caller-defined, bounded recovery blob to the exact signed-bytes hash of a
   * SIGNED or BROADCAST supplementary chain attempt -- the position-scoped counterpart to
   * persistChainAttemptRecoveryContext, for a handler (e.g. supplementary-buyback.mjs) that needs
   * to recover its own provider-specific approval/recovery state after a restart rather than
   * re-signing. Idempotent for an identical retry; rejects a conflicting one.
   */
  async persistSupplementaryChainAttemptRecoveryContext(positionId, contextValue) {
    const location = await this.#supplementarySettlementLocation(positionId, 'persistSupplementaryChainAttemptRecoveryContext');
    const context = assertSupplementaryChainAttemptRecoveryContext(contextValue, 'supplementary chain attempt recovery context');
    if (context.positionId !== positionId) {
      throw new Error('cycle-repository persistSupplementaryChainAttemptRecoveryContext context does not match its position');
    }
    const attemptKey = supplementaryChainAttemptKey(positionId, context.requestDigest);
    const chain = location.state.supplementaryChainAttempts.get(attemptKey);
    if (!chain || !['SIGNED', 'BROADCAST'].includes(chain.attempt.state) || chain.attempt.hash !== context.rawSignedBytesHash) {
      throw new Error('cycle-repository persistSupplementaryChainAttemptRecoveryContext: context does not bind signed bytes');
    }
    const key = attemptKey;
    const existing = location.state.supplementaryChainAttemptRecoveryContexts.get(key);
    if (existing) {
      if (canonicalJson(existing) !== canonicalJson(context)) {
        throw new Error('cycle-repository persistSupplementaryChainAttemptRecoveryContext: conflicts with prior context');
      }
      return structuredClone(existing);
    }
    await this.#append(location.cycleId, 'supplementary-chain-attempt-recovery-context-recorded', { context }, {
      assertState: currentState => {
        const latest = currentState.supplementaryChainAttemptRecoveryContexts.get(key);
        if (latest && canonicalJson(latest) !== canonicalJson(context)) {
          throw new Error('cycle-repository persistSupplementaryChainAttemptRecoveryContext: conflicts with prior context');
        }
      },
    });
    return structuredClone(context);
  }

  async readSupplementaryChainAttemptRecoveryContext(positionId, requestDigest) {
    if (typeof positionId !== 'string' || !heldPositionIdPattern.test(positionId)) {
      throw new Error('cycle-repository readSupplementaryChainAttemptRecoveryContext: positionId is invalid');
    }
    const key = supplementaryChainAttemptKey(positionId, requestDigest);
    for (const { state } of await this.#knownStates()) {
      const context = state.supplementaryChainAttemptRecoveryContexts.get(key);
      if (context) return structuredClone(context);
    }
    return null;
  }

  /**
   * Record one write-ahead supplementary-settlement boundary. The event is deliberately allowed
   * after the main cycle is COMPLETE: its payload remains bound to the original position and
   * immutable manifest, so it cannot become proceeds for another cycle.
   */
  async advanceSupplementarySettlement(positionId, input) {
    if (typeof positionId !== 'string' || !heldPositionIdPattern.test(positionId)) {
      throw new Error('cycle-repository advanceSupplementarySettlement: positionId is invalid');
    }
    exactObject(input, ['expectedState', 'nextState', 'evidence'], 'supplementary settlement advance input');
    if (!SUPPLEMENTARY_SETTLEMENT_STATES.has(input.expectedState)
      || !SUPPLEMENTARY_SETTLEMENT_STATES.has(input.nextState)
      || !SUPPLEMENTARY_SETTLEMENT_TRANSITIONS.get(input.expectedState)?.has(input.nextState)) {
      throw new Error('cycle-repository advanceSupplementarySettlement: state transition is invalid');
    }
    const locations = await this.#knownStates();
    const location = locations.find(({ state }) => state.supplementarySettlements.has(positionId)) ?? null;
    if (location === null) throw new Error('cycle-repository advanceSupplementarySettlement: settlement is unknown');
    if (location.state.archived) {
      throw new Error('cycle-repository advanceSupplementarySettlement: archived settlement requires recovery');
    }
    if (!isNativeAdmission(location.state.admission)) throw new Error('native supplementary settlement refuses historical cycle resume');
    const current = location.state.supplementarySettlements.get(positionId);
    let nativeReturnReservations = [];
    let realizedProceedsUsd = null;
    if (input.nextState === 'RETURN_BROADCAST') {
      const stage = `supplementary-${digest({ schema: 'hookemon.supplementary-return-stage.v1', positionId }).slice(7, 55)}`;
      const source = await this.#store.readPagedPayoutState(location.cycleId, stage);
      const proof = input.evidence?.finalizedReturnEvidence?.finalityEvidence;
      if (!source || source.schema !== 'hookemon.supplementary-return-attempt.v2'
        || typeof source.rawSignedBytes !== 'string' || !source.intent
        || !isProcessRpcReturnLegDestinationProof(proof, { relayRequestId: source.relayRequestId })) {
        throw new Error('native supplementary return requires its persisted source and process payment proof');
      }
      const payment = proof.nativePaymentProof;
      if (payment?.sourceTransactionDigest !== `sha256:${createHash('sha256').update(source.rawSignedBytes).digest('hex')}`
        || payment.orderId !== source.intent.orderId || payment.recipient !== source.intent.recipient.toLowerCase()
        || proof.observedAmountAtomic !== source.destinationAmount?.amountAtomic
        || proof.observedRecipient !== input.evidence.finalizedReturnEvidence.operations.toLowerCase()
        || proof.observedAmountAtomic !== input.evidence.finalizedReturnEvidence.amountAtomic
        || input.evidence.finalizedReturnEvidence.assetId !== 'native') {
        throw new Error('native supplementary return differs from its original position source and destination');
      }
      supplementaryNativeReturnCustody(location.state, proof.observedAmountAtomic);
      realizedProceedsUsd = supplementaryRealizedProceeds(source, proof);
      const owner = { cycleId: location.cycleId, relayRequestId: source.relayRequestId, positionId };
      nativeReturnReservations = [
        { key: relayTransactionReservationKey('4663', proof.destinationTxHash), value: { ...owner, transactionHash: proof.destinationTxHash } },
        { key: relayTransactionReservationKey('792703809', proof.sourceTxHash), value: { ...owner, transactionHash: proof.sourceTxHash } },
        { key: `relay-order:${payment.orderId.toLowerCase()}`, value: { ...owner, orderId: payment.orderId.toLowerCase() } },
      ];
    }

    const returnBoundary = input.nextState === 'RETURN_BROADCAST'
      ? assertSupplementaryReturnBoundaryEvidence(
        input.evidence,
        current,
        'supplementary settlement advance return boundary',
      )
      : null;
    const evidence = returnBoundary === null
      ? cloneEvidence(input.evidence, 'supplementary settlement advance evidence')
      : {
        schema: returnBoundary.schema,
        positionId: returnBoundary.positionId,
        cycleId: returnBoundary.cycleId,
        manifestId: returnBoundary.manifestId,
        finalizedReturnEvidence: returnBoundary.finalizedReturnEvidence,
      };
    const payoutSource = returnBoundary === null
      ? (current.payoutSourceDigest === null
        ? null
        : durableSupplementaryReturnBoundary(
          current,
          location.state.supplementarySettlementEvidence.get(positionId) ?? null,
          'supplementary settlement advance',
        ).payoutSource)
      : supplementaryPayoutSourceForReturnBoundary(
        current,
        returnBoundary,
        'supplementary settlement advance payout source',
      );
    const next = assertSupplementarySettlement({
      ...current,
      state: input.nextState,
      ...(payoutSource === null ? {} : { payoutSourceDigest: digest(payoutSource) }),
    }, 'advanced supplementary settlement');
    const carriedReturnBoundary = returnBoundary === null && current.payoutSourceDigest !== null
      ? durableSupplementaryReturnBoundary(
        current,
        location.state.supplementarySettlementEvidence.get(positionId) ?? null,
        'supplementary settlement advance',
      )
      : null;
    const evidenceRecord = supplementarySettlementEvidenceFor(
      next,
      input.nextState,
      evidence,
      payoutSource,
      carriedReturnBoundary,
    );
    if (current.state === input.nextState) {
      const existing = location.state.supplementarySettlementEvidence.get(positionId) ?? null;
      if (canonicalJson(current) !== canonicalJson(next) || canonicalJson(existing) !== canonicalJson(evidenceRecord)) {
        throw new Error('cycle-repository advanceSupplementarySettlement: settled boundary evidence conflicts');
      }
      return structuredClone(current);
    }
    if (current.state !== input.expectedState) {
      throw new Error('cycle-repository advanceSupplementarySettlement: settlement changed while advancing');
    }

    try {
      await this.#append(location.cycleId, 'supplementary-settlement-advanced', {
        positionId,
        expectedState: input.expectedState,
        nextState: input.nextState,
        evidence,
        ...(returnBoundary === null ? {} : { payoutSource, realizedProceedsUsd }),
      }, {
        globalKeyReservations: nativeReturnReservations,
        assertState: state => {
          const latest = state.supplementarySettlements.get(positionId) ?? null;
          if (latest === null || canonicalJson(latest) !== canonicalJson(current)) {
            throw new Error('cycle-repository advanceSupplementarySettlement: settlement changed while advancing');
          }
        },
      });
    } catch (error) {
      if (!/stale cycle journal (?:version|head)/.test(error?.message ?? '')) throw error;
      const latest = await this.#replay(location.cycleId);
      const persisted = latest.supplementarySettlements.get(positionId) ?? null;
      const persistedEvidence = latest.supplementarySettlementEvidence.get(positionId) ?? null;
      if (persisted !== null && canonicalJson(persisted) === canonicalJson(next)
        && canonicalJson(persistedEvidence) === canonicalJson(evidenceRecord)) {
        return structuredClone(persisted);
      }
      throw error;
    }
    return structuredClone(next);
  }

  async resolveHeldPosition(positionId, input) {
    if (typeof positionId !== 'string' || !heldPositionIdPattern.test(positionId)) {
      throw new Error('cycle-repository resolveHeldPosition: positionId is invalid');
    }
    const locations = await this.#knownStates();
    const location = locations.find(({ state }) => state.heldPositions.has(positionId)) ?? null;
    if (location === null) throw new Error('cycle-repository resolveHeldPosition: held position is unknown');
    if (location.state.archived) {
      throw new Error('cycle-repository resolveHeldPosition: archived held positions require supplementary settlement recovery');
    }
    const current = location.state.heldPositions.get(positionId);
    if (input?.terminalState === 'SOLD') {
      const settlement = location.state.supplementarySettlements.get(positionId) ?? null;
      if (settlement?.state !== 'COMPLETE') {
        throw new Error('cycle-repository resolveHeldPosition: sold resolution requires its supplementary settlement to be complete');
      }
    }
    if (current.resolution !== null) {
      const resolution = heldPositionResolutionInput(current, input, current.resolution.resolvedAtMs);
      if (canonicalJson(resolution) !== canonicalJson(current.resolution)) {
        throw new Error('cycle-repository resolveHeldPosition: resolution conflict');
      }
      return structuredClone(current);
    }
    const resolution = heldPositionResolutionInput(current, input, currentRepositoryTime(this.#now));
    const position = assertHeldPosition({
      ...current,
      positionRevision: current.positionRevision + 1,
      resolution,
    }, 'held position resolution transition');
    const ledgerKey = location.state.heldPositionLedgerKeys.get(positionId) ?? null;
    const ledger = ledgerKey === null
      ? null
      : resolvedHeldPositionCustodyLedger(location.state.custodyLedgers, ledgerKey, current);

    try {
      await this.#append(location.cycleId, 'held-position-resolved', {
        positionId,
        resolution,
        position,
        ...(ledger === null ? {} : { ledger }),
      }, {
        assertState: state => {
          const latest = state.heldPositions.get(positionId) ?? null;
          if (latest === null || latest.resolution !== null || canonicalJson(latest) !== canonicalJson(current)) {
            throw new Error('cycle-repository resolveHeldPosition: held position changed while resolving');
          }
          if (ledger !== null) {
            const latestLedgerKey = state.heldPositionLedgerKeys.get(positionId) ?? null;
            if (latestLedgerKey !== ledgerKey
              || canonicalJson(resolvedHeldPositionCustodyLedger(state.custodyLedgers, latestLedgerKey, latest)) !== canonicalJson(ledger)) {
              throw new Error('cycle-repository resolveHeldPosition: custody ledger changed while resolving');
            }
          }
        },
      });
    } catch (error) {
      if (!/stale cycle journal (?:version|head)/.test(error?.message ?? '')) throw error;
      const latest = await this.#replay(location.cycleId);
      const persisted = latest.heldPositions.get(positionId) ?? null;
      if (persisted?.resolution !== null && canonicalJson(persisted.resolution) === canonicalJson(resolution)) {
        return structuredClone(persisted);
      }
      throw error;
    }
    return structuredClone(position);
  }

  /**
   * WP-37: every cycle id this repository has ever durably recorded — archived (closed) cycles
   * first, in lexicographic order, then any still-active cycle. Read-only, and deliberately not
   * part of the `AutomatedCycleService` seam: the only consumer is `distribution.mjs`'s own
   * `buildHolderExclusionSet`, which uses this list to derive every prior cycle's own return
   * escrow address deterministically (via the vault's own `computeCycleEscrow` view, one read per
   * id) — never to reconstruct cycle state, and never storing the derived escrow addresses
   * anywhere. `DurableCycleStore`'s own `archivedCycleIds`/`activeCycleIds` getters are already
   * sorted and de-duplicated (a cycle id is either active or archived, never both), so this is a
   * plain concatenation, not a merge.
   * @returns {Promise<string[]>}
   */
  async listKnownCycleIds() {
    return [...this.#store.archivedCycleIds, ...this.#store.activeCycleIds];
  }

  async #collectPayoutDust() {
    const records = new Map();
    const consumptions = new Map();
    for (const candidateCycleId of await this.listKnownCycleIds()) {
      const state = await this.#replay(candidateCycleId);
      for (const record of state.payoutDustRecords.values()) {
        const key = payoutDustSourceKey(record.source.cycleId, record.source.digest);
        if (records.has(key)) throw new Error('cycle-repository payout dust source appears more than once');
        records.set(key, structuredClone(record));
      }
      for (const consumption of state.payoutDustConsumptions.values()) {
        const key = payoutDustSourceKey(consumption.sourceCycleId, consumption.sourceDigest);
        const existing = consumptions.get(key);
        if (existing && canonicalJson(existing) !== canonicalJson(consumption)) {
          throw new Error('cycle-repository payout dust source has conflicting consumption records');
        }
        if (existing) throw new Error('cycle-repository payout dust source was consumed more than once');
        consumptions.set(key, structuredClone(consumption));
      }
    }
    for (const [key, consumption] of consumptions) {
      const record = records.get(key);
      if (!record
        || record.source.planDigest !== consumption.sourcePlanDigest
        || canonicalJson(record.amount) !== canonicalJson(consumption.amount)) {
        throw new Error('cycle-repository payout dust consumption does not match its provenance record');
      }
    }
    return { records, consumptions };
  }

  /**
   * Returns the one unconsumed prior dust record for an asset, or an explicit zero amount when no
   * predecessor carries dust. The caller binds `source` into its immutable payout plan before it
   * calls `consumePayoutDust` at the first durable payout boundary.
   */
  async readPayoutDust(cycleId, assetValue) {
    const asset = assertPayoutAsset(assetValue, 'payout dust asset');
    await this.#replay(cycleId);
    const { records, consumptions } = await this.#collectPayoutDust();
    const available = [...records.entries()]
      .filter(([key, record]) => !consumptions.has(key)
        && record.source.cycleId !== cycleId
        && payoutAssetKey(record.amount) === payoutAssetKey(asset))
      .map(([, record]) => record);
    if (available.length > 1) {
      throw new Error('cycle-repository payout dust has more than one unconsumed predecessor for this asset');
    }
    if (available.length === 0) return { amount: { ...asset, amountAtomic: '0' }, source: null };
    return structuredClone(available[0]);
  }

  /**
   * Returns this cycle's already-bound predecessor dust, if an older process committed the
   * consumption before it recorded the initial payout state. Callers use it to reconstruct the
   * same immutable plan rather than silently dropping the carried amount during recovery.
   */
  async readPayoutDustConsumption(cycleId, assetValue) {
    const asset = assertPayoutAsset(assetValue, 'payout dust asset');
    const state = await this.#replay(cycleId);
    const matches = [...state.payoutDustConsumptions.values()]
      .filter(consumption => payoutAssetKey(consumption.amount) === payoutAssetKey(asset));
    if (matches.length > 1) {
      throw new Error('cycle-repository payout dust has more than one consumed predecessor for this asset');
    }
    return matches.length === 0 ? null : structuredClone(matches[0]);
  }

  /**
   * Records positive floor-and-carry dust after a payout plan reaches terminal conservation. A
   * successor cannot consume it until this journal entry is durable and archived history remains
   * readable through `readPayoutDust`.
   */
  async recordPayoutDust(cycleId, { amount: amountValue, planDigest }) {
    const amount = assertPayoutAmount(amountValue, 'payout dust amount', { positive: true });
    assertDigest(planDigest, 'payout dust planDigest');
    const state = await this.#replay(cycleId);
    if (state.terminalState) throw new Error(`cycle-repository recordPayoutDust: cycle is terminal as ${state.terminalState}`);
    const key = payoutAssetKey(amount);
    const existing = state.payoutDustRecords.get(key);
    const record = { schema: payoutDustRecordSchema, cycleId, planDigest, amount };
    if (existing) {
      if (existing.source.planDigest !== planDigest || canonicalJson(existing.amount) !== canonicalJson(amount)) {
        throw new Error('cycle-repository recordPayoutDust: asset already has different dust evidence');
      }
      return structuredClone(existing);
    }
    const prior = await this.readPayoutDust(cycleId, {
      chainId: amount.chainId,
      assetId: amount.assetId,
      decimals: amount.decimals,
    });
    if (prior.source !== null) {
      throw new Error('cycle-repository recordPayoutDust: prior dust must be consumed before successor dust is recorded');
    }
    const entry = await this.#append(cycleId, 'payout-dust-recorded', { record }, {
      operation: 'recordPayoutDust',
      assertState: currentState => {
        if (currentState.payoutDustRecords.has(key)) {
          throw new Error('cycle-repository recordPayoutDust: asset changed while recording dust');
        }
      },
    });
    return {
      amount,
      source: { cycleId, digest: entry.digest, planDigest },
    };
  }

  /**
   * Atomically binds one predecessor dust record to one successor plan. The durable store's
   * anti-replay index keys the source journal digest, so a concurrent or post-archive second
   * consumer cannot commit a different successor.
   */
  async consumePayoutDust(cycleId, { source: sourceValue, amount: amountValue, planDigest }) {
    const prepared = payoutDustConsumptionFor(cycleId, { source: sourceValue, amount: amountValue, planDigest });
    if (prepared === null) return null;
    const {
      source,
      sourceKey,
      amount,
      consumption,
      authorization,
    } = prepared;
    const current = await this.#replay(cycleId);
    const currentConsumption = current.payoutDustConsumptions.get(sourceKey);
    if (currentConsumption) {
      if (canonicalJson(currentConsumption) !== canonicalJson(consumption)) {
        throw new Error('cycle-repository consumePayoutDust: source dust is already consumed by a different payout plan');
      }
      return structuredClone(currentConsumption);
    }
    const all = await this.#collectPayoutDust();
    const record = all.records.get(sourceKey);
    if (!record || canonicalJson(record.source) !== canonicalJson(source)
      || canonicalJson(record.amount) !== canonicalJson(amount)) {
      throw new Error('cycle-repository consumePayoutDust: source dust provenance does not match a durable record');
    }
    if (all.consumptions.has(sourceKey)) {
      throw new Error('cycle-repository consumePayoutDust: source dust is already consumed by a different payout plan');
    }
    try {
      await this.#appendEvents(cycleId, [{ kind: 'payout-dust-consumed', payload: { consumption } }], {
        operation: 'consumePayoutDust',
        authorizationRecords: [authorization],
        assertState: state => {
          if (state.payoutDustConsumptions.has(sourceKey)) {
            throw new Error('cycle-repository consumePayoutDust: source changed while consuming dust');
          }
        },
      });
    } catch (error) {
      if (/authorization nonce already consumed/.test(error?.message ?? '')) {
        throw new Error('cycle-repository consumePayoutDust: source dust is already consumed by a different payout plan');
      }
      throw error;
    }
    return structuredClone(consumption);
  }

  /**
   * Persists the initial direct-payout state in the same journal commit that binds predecessor
   * dust. No signer is reached before this operation, so a crash can recover either the complete
   * pair or neither fact. It also completes an older consume-only record with the exact matching
   * state, which repairs the former two-commit recovery window without reusing the dust source.
   */
  async consumePayoutDustAndRecordStageAttempt(cycleId, {
    source,
    amount,
    planDigest,
    stage,
    evidence,
  }) {
    assertStageName(stage);
    if (stage !== 'payout') throw new Error('cycle-repository atomic payout initialization requires the payout stage');
    const payoutState = cloneEvidence(evidence, 'initial payout state');
    const prepared = payoutDustConsumptionFor(cycleId, { source, amount, planDigest });
    const current = await this.#replay(cycleId);
    if (current.terminalState) {
      throw new Error(`cycle-repository atomic payout initialization: cycle is terminal as ${current.terminalState}`);
    }
    const existingAttempt = current.attempts.get(stage) ?? null;
    if (existingAttempt) {
      if (existingAttempt.failed || canonicalJson(existingAttempt.evidence) !== canonicalJson(payoutState)) {
        throw new Error('cycle-repository atomic payout initialization: payout state already differs');
      }
      if (prepared === null) return { evidence: structuredClone(existingAttempt.evidence), consumption: null };
      const existingConsumption = current.payoutDustConsumptions.get(prepared.sourceKey);
      if (!existingConsumption || canonicalJson(existingConsumption) !== canonicalJson(prepared.consumption)) {
        throw new Error('cycle-repository atomic payout initialization: payout state is missing its matching dust consumption');
      }
      return { evidence: structuredClone(existingAttempt.evidence), consumption: structuredClone(existingConsumption) };
    }

    let events = [{ kind: 'stage-attempted', payload: { stage, evidence: payoutState } }];
    let authorizationRecords = [];
    let priorConsumption = null;
    if (prepared !== null) {
      priorConsumption = current.payoutDustConsumptions.get(prepared.sourceKey) ?? null;
      if (priorConsumption) {
        if (canonicalJson(priorConsumption) !== canonicalJson(prepared.consumption)) {
          throw new Error('cycle-repository atomic payout initialization: source dust is already consumed by a different payout plan');
        }
      } else {
        const all = await this.#collectPayoutDust();
        const record = all.records.get(prepared.sourceKey);
        if (!record || canonicalJson(record.source) !== canonicalJson(prepared.source)
          || canonicalJson(record.amount) !== canonicalJson(prepared.amount)) {
          throw new Error('cycle-repository atomic payout initialization: source dust provenance does not match a durable record');
        }
        if (all.consumptions.has(prepared.sourceKey)) {
          throw new Error('cycle-repository atomic payout initialization: source dust is already consumed by a different payout plan');
        }
        events = [
          { kind: 'payout-dust-consumed', payload: { consumption: prepared.consumption } },
          ...events,
        ];
        authorizationRecords = [prepared.authorization];
      }
    }
    try {
      await this.#appendEvents(cycleId, events, {
        operation: 'atomic payout initialization',
        authorizationRecords,
        assertState: state => {
          if (state.attempts.has(stage)) {
            throw new Error('cycle-repository atomic payout initialization: payout state changed while recording');
          }
          if (prepared !== null) {
            const latest = state.payoutDustConsumptions.get(prepared.sourceKey) ?? null;
            if (priorConsumption === null && latest !== null) {
              throw new Error('cycle-repository atomic payout initialization: source dust changed while consuming');
            }
            if (priorConsumption !== null && canonicalJson(latest) !== canonicalJson(priorConsumption)) {
              throw new Error('cycle-repository atomic payout initialization: consumed dust changed while recording');
            }
          }
        },
      });
    } catch (error) {
      if (/authorization nonce already consumed/.test(error?.message ?? '')) {
        throw new Error('cycle-repository atomic payout initialization: source dust is already consumed by a different payout plan');
      }
      throw error;
    }
    return {
      evidence: structuredClone(payoutState),
      consumption: prepared === null ? null : structuredClone(priorConsumption ?? prepared.consumption),
    };
  }

  async readPayoutQuarantine(cycleId, planDigest, recipientValue) {
    assertDigest(planDigest, 'payout quarantine planDigest');
    const recipient = assertEvmAddress(recipientValue, 'payout quarantine recipient');
    const state = await this.#replay(cycleId);
    const value = state.payoutQuarantines.get(payoutQuarantineKey(planDigest, recipient));
    return value ? structuredClone(value) : null;
  }

  /**
   * Moves a recipient's value into a durable payout liability in the same journal commit as the
   * quarantine evidence. The pre-existing custody ledger is required as the backing source; this
   * method never creates a synthetic balance from a recipient record.
   */
  async reservePayoutQuarantine(cycleId, {
    planDigest,
    recipient: recipientValue,
    amount: amountValue,
    reason,
    evidence,
  }) {
    assertDigest(planDigest, 'payout quarantine planDigest');
    const recipient = assertEvmAddress(recipientValue, 'payout quarantine recipient');
    const amount = assertPayoutAmount(amountValue, 'payout quarantine amount', { positive: true });
    const reservationReason = assertQuarantineReason(reason, 'payout quarantine reason');
    const reservationEvidence = cloneChainObservationEvidence(evidence, 'payout quarantine evidence');
    const state = await this.#replay(cycleId);
    if (state.terminalState) throw new Error(`cycle-repository reservePayoutQuarantine: cycle is terminal as ${state.terminalState}`);
    const key = payoutQuarantineKey(planDigest, recipient);
    const existing = state.payoutQuarantines.get(key);
    if (existing) {
      if (canonicalJson({
        planDigest: existing.planDigest,
        recipient: existing.recipient,
        amount: existing.amount,
        reason: existing.reason,
        evidence: existing.evidence,
      }) !== canonicalJson({
        planDigest,
        recipient,
        amount,
        reason: reservationReason,
        evidence: reservationEvidence,
      })) {
        throw new Error('cycle-repository reservePayoutQuarantine: recipient already has different evidence');
      }
      return structuredClone(existing);
    }
    // New payout admissions only ever write the canonical-v2 row (ADR-0026); a raw row still
    // reachable from before that migration must remain usable so a legacy cycle's quarantine keeps
    // working. Prefer the canonical row when the recognized USDG relation applies, but refuse
    // outright if both rows exist for the same underlying asset -- reserving against either one
    // silently would leave the other stale, which is exactly the competing-row state this repository
    // must never produce on its own.
    const rawKey = custodyLedgerKey(amount);
    const rawLedger = state.custodyLedgers.get(rawKey) ?? null;
    const canonicalIdentity = evmUsdgCanonicalCustodyIdentity(amount);
    const canonicalKey = canonicalIdentity ? custodyLedgerKey(canonicalIdentity) : null;
    const canonicalLedger = canonicalKey ? (state.custodyLedgers.get(canonicalKey) ?? null) : null;
    if (rawLedger && canonicalLedger) {
      throw new Error('cycle-repository reservePayoutQuarantine: raw and canonical custody ledgers coexist for this asset');
    }
    const ledgerKey = canonicalLedger ? canonicalKey : rawKey;
    const previousLedger = canonicalLedger ?? rawLedger;
    if (!previousLedger) {
      throw new Error('cycle-repository reservePayoutQuarantine: a matching custody ledger is required before reservation');
    }
    const available = BigInt(previousLedger.returnReceived) - BigInt(previousLedger.payoutLiability);
    if (available < BigInt(amount.amountAtomic)) {
      throw new Error('cycle-repository reservePayoutQuarantine: recorded returned custody cannot back this liability');
    }
    const ledger = {
      ...previousLedger,
      payoutLiability: (BigInt(previousLedger.payoutLiability) + BigInt(amount.amountAtomic)).toString(),
    };
    const reservation = {
      schema: payoutQuarantineSchema,
      cycleId,
      planDigest,
      recipient,
      amount,
      reason: reservationReason,
      evidence: reservationEvidence,
      ledger,
      retries: [],
      settlement: null,
    };
    await this.#append(cycleId, 'payout-quarantine-reserved', { reservation }, {
      operation: 'reservePayoutQuarantine',
      assertState: currentState => {
        if (currentState.payoutQuarantines.has(key)) {
          throw new Error('cycle-repository reservePayoutQuarantine: recipient changed while reserving custody');
        }
        const latest = currentState.custodyLedgers.get(ledgerKey);
        if (!latest || canonicalJson(latest) !== canonicalJson(previousLedger)) {
          throw new Error('cycle-repository reservePayoutQuarantine: custody ledger changed while reserving liability');
        }
      },
    });
    return structuredClone(reservation);
  }

  async requestPayoutQuarantineRetry(cycleId, {
    planDigest,
    recipient: recipientValue,
    amount: amountValue,
    requestId,
    originalTransactionHash: originalTransactionHashValue,
  }) {
    assertDigest(planDigest, 'payout quarantine retry planDigest');
    const recipient = assertEvmAddress(recipientValue, 'payout quarantine retry recipient');
    const amount = assertPayoutAmount(amountValue, 'payout quarantine retry amount', { positive: true });
    if (typeof requestId !== 'string' || !requestIdPattern.test(requestId)) {
      throw new Error('cycle-repository requestPayoutQuarantineRetry: requestId is invalid');
    }
    if (typeof originalTransactionHashValue !== 'string' || !evmTransactionHashPattern.test(originalTransactionHashValue)) {
      throw new Error('cycle-repository requestPayoutQuarantineRetry: originalTransactionHash is invalid');
    }
    const originalTransactionHash = originalTransactionHashValue.toLowerCase();
    const state = await this.#replay(cycleId);
    if (state.terminalState !== null && state.terminalState !== HELD_OWNER_DECISION) {
      throw new Error(`cycle-repository requestPayoutQuarantineRetry: cycle is terminal as ${state.terminalState}`);
    }
    const key = payoutQuarantineKey(planDigest, recipient);
    const reservation = state.payoutQuarantines.get(key);
    if (!reservation) throw new Error('cycle-repository requestPayoutQuarantineRetry: payout quarantine reservation does not exist');
    if (typeof reservation.evidence.transactionHash !== 'string'
      || !evmTransactionHashPattern.test(reservation.evidence.transactionHash)) {
      throw new Error('cycle-repository requestPayoutQuarantineRetry: reservation evidence has no original transaction hash');
    }
    if (canonicalJson(reservation.amount) !== canonicalJson(amount)) {
      throw new Error('cycle-repository requestPayoutQuarantineRetry: amount does not match the reserved liability');
    }
    if (reservation.evidence.transactionHash.toLowerCase() !== originalTransactionHash) {
      throw new Error('cycle-repository requestPayoutQuarantineRetry: original transaction does not match reservation evidence');
    }
    if (reservation.settlement !== null) {
      throw new Error('cycle-repository requestPayoutQuarantineRetry: payout quarantine is already settled');
    }
    const existing = reservation.retries.find(retry => retry.requestId === requestId);
    if (existing) {
      if (canonicalJson({
        planDigest, recipient, amount, requestId, originalTransactionHash,
      }) !== canonicalJson({
        planDigest, recipient, amount: reservation.amount, requestId: existing.requestId,
        originalTransactionHash: existing.originalTransactionHash,
      })) {
        throw new Error('cycle-repository requestPayoutQuarantineRetry: requestId conflict');
      }
      return structuredClone(existing);
    }
    const previous = reservation.retries.at(-1);
    if (previous?.resolution === null) {
      throw new Error('cycle-repository requestPayoutQuarantineRetry: previous retry is unresolved');
    }
    const retry = {
      retryId: digest({
        cycleId,
        planDigest,
        recipient,
        requestId,
        sequence: reservation.retries.length,
      }),
      requestId,
      requestedAtMs: currentRepositoryTime(this.#now),
      originalTransactionHash,
      resolution: null,
    };
    try {
      await this.#append(cycleId, 'payout-quarantine-retry-requested', {
        schema: payoutQuarantineRetrySchema,
        planDigest,
        recipient,
        retry,
      }, {
        assertState: currentState => {
          const current = currentState.payoutQuarantines.get(key);
          if (!current || current.settlement !== null) {
            throw new Error('cycle-repository requestPayoutQuarantineRetry: reservation changed while requesting retry');
          }
          if (current.retries.some(candidate => candidate.requestId === requestId)) {
            throw new Error('cycle-repository requestPayoutQuarantineRetry: request became durable concurrently');
          }
          if (current.retries.at(-1)?.resolution === null) {
            throw new Error('cycle-repository requestPayoutQuarantineRetry: previous retry became unresolved');
          }
        },
      });
    } catch (error) {
      const latest = await this.#replay(cycleId);
      const current = latest.payoutQuarantines.get(key);
      const concurrent = current?.retries.find(candidate => candidate.requestId === requestId);
      if (concurrent && canonicalJson(concurrent) === canonicalJson(retry)) return structuredClone(concurrent);
      throw error;
    }
    return structuredClone(retry);
  }

  async recordPayoutQuarantineRetryRefusal(cycleId, {
    planDigest,
    recipient: recipientValue,
    retryId,
    refusalEvidence,
    processProof = null,
    payoutRetry = null,
  }) {
    assertDigest(planDigest, 'payout quarantine retry refusal planDigest');
    const recipient = assertEvmAddress(recipientValue, 'payout quarantine retry refusal recipient');
    assertDigest(retryId, 'payout quarantine retry refusal retryId');
    const evidence = cloneChainObservationEvidence(refusalEvidence, 'payout quarantine retry refusal evidence');
    if (typeof evidence.transactionHash !== 'string' || !evmTransactionHashPattern.test(evidence.transactionHash)) {
      throw new Error('cycle-repository recordPayoutQuarantineRetryRefusal: transactionHash is required');
    }
    if (evidence.reason !== 'TRANSACTION_REVERTED'
      || typeof evidence.finalizedBlockNumber !== 'string'
      || typeof evidence.finalizedBlockHash !== 'string') {
      throw new Error('cycle-repository recordPayoutQuarantineRetryRefusal: refusal evidence is not finalized');
    }
    const state = await this.#replay(cycleId);
    const key = payoutQuarantineKey(planDigest, recipient);
    const reservation = state.payoutQuarantines.get(key);
    if (!reservation) throw new Error('cycle-repository recordPayoutQuarantineRetryRefusal: payout quarantine reservation does not exist');
    if (reservation.settlement !== null) {
      throw new Error('cycle-repository recordPayoutQuarantineRetryRefusal: payout quarantine is already settled');
    }
    const retry = reservation.retries.find(candidate => candidate.retryId === retryId);
    if (!retry) throw new Error('cycle-repository recordPayoutQuarantineRetryRefusal: retry does not exist');
    const resolution = { state: 'REFUSED', transactionHash: evidence.transactionHash.toLowerCase() };
    if (retry.resolution !== null) {
      if (canonicalJson(retry.resolution) !== canonicalJson(resolution)) {
        throw new Error('cycle-repository recordPayoutQuarantineRetryRefusal: retry resolution conflicts');
      }
      return structuredClone(retry);
    }
    try {
      await this.#append(cycleId, 'payout-quarantine-retry-refused', {
        schema: payoutQuarantineRetrySchema,
        planDigest,
        recipient,
        retryId,
        refusalEvidence: evidence,
        processProof: processProof === null ? null : cloneChainObservationEvidence(processProof, 'payout quarantine retry refusal process proof'),
        payoutRetry: payoutRetry === null ? null : cloneChainObservationEvidence(payoutRetry, 'payout quarantine retry refusal payout retry'),
      }, {
        assertState: currentState => {
          const current = currentState.payoutQuarantines.get(key);
          const currentRetry = current?.retries.find(candidate => candidate.retryId === retryId);
          if (!currentRetry || (currentRetry.resolution !== null
            && canonicalJson(currentRetry.resolution) !== canonicalJson(resolution))) {
            throw new Error('cycle-repository recordPayoutQuarantineRetryRefusal: retry changed while recording refusal');
          }
          if (currentRetry.resolution !== null) {
            throw new Error('cycle-repository recordPayoutQuarantineRetryRefusal: refusal became durable concurrently');
          }
        },
      });
    } catch (error) {
      const latest = await this.#replay(cycleId);
      const current = latest.payoutQuarantines.get(key);
      const concurrent = current?.retries.find(candidate => candidate.retryId === retryId);
      if (concurrent?.resolution
        && canonicalJson(concurrent.resolution) === canonicalJson(resolution)) return structuredClone(concurrent);
      throw error;
    }
    return structuredClone(resolution);
  }

  async settlePayoutQuarantine(cycleId, {
    planDigest,
    recipient: recipientValue,
    retryId = null,
    proof,
    operations,
    payoutRetry = null,
  }) {
    assertDigest(planDigest, 'payout quarantine settlement planDigest');
    const recipient = assertEvmAddress(recipientValue, 'payout quarantine settlement recipient');
    if (retryId !== null) assertDigest(retryId, 'payout quarantine settlement retryId');
    const source = assertEvmAddress(operations, 'payout quarantine settlement Operations address');
    const state = await this.#replay(cycleId);
    const key = payoutQuarantineKey(planDigest, recipient);
    const reservation = state.payoutQuarantines.get(key);
    if (!reservation) throw new Error('cycle-repository settlePayoutQuarantine: payout quarantine reservation does not exist');
    if (reservation.settlement !== null) {
      const existing = reservation.settlement;
      if (existing.retryId === retryId && existing.transactionHash === proof?.transactionHash
        && existing.amount.amountAtomic === reservation.amount.amountAtomic
        && existing.proofDigest === digest(proof)) return structuredClone(existing);
      throw new Error('cycle-repository settlePayoutQuarantine: settlement conflicts with existing settlement');
    }
    if (!isProcessNativePaymentProof(proof, {
      kind: 'direct',
      chainId: '4663',
      assetId: 'native',
      decimals: 18,
      source,
      recipient,
      amountWei: reservation.amount.amountAtomic,
      transactionHash: proof?.transactionHash,
    })) {
      throw new Error('cycle-repository settlePayoutQuarantine: proof is not an authenticated direct native payment');
    }
    if (retryId === null) {
      if (typeof reservation.evidence.transactionHash !== 'string'
        || proof.transactionHash.toLowerCase() !== reservation.evidence.transactionHash.toLowerCase()) {
        throw new Error('cycle-repository settlePayoutQuarantine: original settlement transaction does not match reservation evidence');
      }
    } else {
      const retry = reservation.retries.find(candidate => candidate.retryId === retryId);
      if (!retry || retry.resolution !== null) {
        throw new Error('cycle-repository settlePayoutQuarantine: retry is not open for settlement');
      }
    }
    const ledgerKey = custodyLedgerKey({ chainId: '4663', assetId: 'native' });
    const previousLedger = state.custodyLedgers.get(ledgerKey);
    if (!previousLedger) throw new Error('cycle-repository settlePayoutQuarantine: native custody ledger does not exist');
    if (BigInt(previousLedger.payoutLiability) < BigInt(reservation.amount.amountAtomic)) {
      throw new Error('cycle-repository settlePayoutQuarantine: payout liability underflow');
    }
    const ledger = {
      ...previousLedger,
      payoutLiability: (BigInt(previousLedger.payoutLiability) - BigInt(reservation.amount.amountAtomic)).toString(),
    };
    const settlement = {
      retryId,
      transactionHash: proof.transactionHash.toLowerCase(),
      amount: reservation.amount,
      settledAtMs: currentRepositoryTime(this.#now),
      proofDigest: digest(proof),
      finalizedTransfer: structuredClone(proof),
      payoutRetry: payoutRetry === null ? null : structuredClone(payoutRetry),
    };
    try {
      await this.#append(cycleId, 'payout-quarantine-settled', {
        schema: payoutQuarantineSettlementSchema,
        planDigest,
        recipient,
        settlement,
        ledger,
      }, {
        assertState: currentState => {
          const current = currentState.payoutQuarantines.get(key);
          const currentLedger = currentState.custodyLedgers.get(ledgerKey);
          if (!current || current.settlement !== null || !currentLedger
            || canonicalJson(currentLedger) !== canonicalJson(previousLedger)) {
            throw new Error('cycle-repository settlePayoutQuarantine: reservation or custody changed while settling');
          }
        },
      });
    } catch (error) {
      const latest = await this.#replay(cycleId);
      const current = latest.payoutQuarantines.get(key);
      if (current?.settlement
        && current.settlement.retryId === settlement.retryId
        && current.settlement.transactionHash === settlement.transactionHash
        && current.settlement.amount.amountAtomic === settlement.amount.amountAtomic
        && current.settlement.proofDigest === settlement.proofDigest) {
        return structuredClone(current.settlement);
      }
      throw error;
    }
    return structuredClone(settlement);
  }

  async listPayoutObligations(cycleId) {
    const state = await this.#replay(cycleId);
    return [...state.payoutQuarantines.values()].map(reservation => ({
      planDigest: reservation.planDigest,
      recipient: reservation.recipient,
      amount: structuredClone(reservation.amount),
      reason: reservation.reason,
      originalTransactionHash: reservation.evidence.transactionHash,
      retries: structuredClone(reservation.retries),
      settlement: structuredClone(reservation.settlement),
    }));
  }

  async listOpenPayoutRetries() {
    const open = [];
    for (const cycleId of await this.listKnownCycleIds()) {
      const state = await this.#replay(cycleId);
      const payoutState = await this.#store.readPagedPayoutState(cycleId, 'payout');
      const payoutRetries = new Map(
        Array.isArray(payoutState?.recipients)
          ? payoutState.recipients.flatMap(attempt => (attempt.retries ?? [])
            .map(retry => [`${attempt.recipient.toLowerCase()}:${retry.retryId}`, retry]))
          : [],
      );
      for (const reservation of state.payoutQuarantines.values()) {
        for (const retry of reservation.retries) {
          const payoutRetry = payoutRetries.get(`${reservation.recipient.toLowerCase()}:${retry.retryId}`);
          const payoutProjectionUnresolved = payoutState !== null
            && (payoutRetry === undefined || !['FINALIZED', 'REFUSED'].includes(payoutRetry.state));
          const projectionGap = retry.resolution !== null
            && payoutProjectionUnresolved
            && (reservation.settlement?.retryId === retry.retryId || retry.resolution.state === 'REFUSED');
          const unresolvedRetry = retry.resolution === null
            && reservation.settlement?.retryId !== retry.retryId;
          if (unresolvedRetry || projectionGap) {
            open.push({
              cycleId,
              planDigest: reservation.planDigest,
              recipient: reservation.recipient,
              retryId: retry.retryId,
            });
          }
        }
      }
    }
    return open;
  }

  async #heldEvmNonceLockInAnotherActiveCycle(cycleId, chainId, wallet) {
    const key = evmNonceLockKey(chainId, wallet);
    for (const candidateCycleId of this.#store.activeCycleIds) {
      if (candidateCycleId === cycleId) continue;
      const state = await this.#replay(candidateCycleId);
      const lock = state.evmNonceLocks.get(key);
      if (lock?.state === 'HELD') return { cycleId: candidateCycleId, lock: structuredClone(lock) };
    }
    return null;
  }

  /**
   * Acquires the one wallet-wide EVM nonce fence shared by every Operations signer stage. A newer
   * lease fence for the same active cycle replaces the prior fence, making stale callers fail at
   * `assertEvmNonceLock` immediately before they sign or broadcast.
   */
  async acquireEvmNonceLock(cycleId, { chainId, wallet: walletValue, fencingToken }) {
    if (typeof chainId !== 'string' || chainId.length === 0) throw new Error('EVM nonce lock chainId is invalid');
    const wallet = assertEvmAddress(walletValue, 'EVM nonce lock wallet');
    const token = assertFencingToken(fencingToken, 'EVM nonce lock fencingToken');
    const competing = await this.#heldEvmNonceLockInAnotherActiveCycle(cycleId, chainId, wallet);
    if (competing) {
      throw new Error(`cycle-repository acquireEvmNonceLock: wallet is locked by active cycle ${competing.cycleId}`);
    }
    const state = await this.#replay(cycleId);
    if (state.terminalState) throw new Error(`cycle-repository acquireEvmNonceLock: cycle is terminal as ${state.terminalState}`);
    const key = evmNonceLockKey(chainId, wallet);
    const current = state.evmNonceLocks.get(key) ?? null;
    if (current?.state === 'HELD' && current.fencingToken === token) return structuredClone(current);
    const lock = {
      schema: evmNonceLockSchema,
      cycleId,
      chainId,
      wallet,
      fencingToken: token,
      previousFencingToken: current?.fencingToken ?? null,
    };
    const entry = await this.#append(cycleId, 'evm-nonce-lock-acquired', { lock }, {
      operation: 'acquireEvmNonceLock',
      assertState: currentState => {
        const latest = currentState.evmNonceLocks.get(key) ?? null;
        if (canonicalJson(latest) !== canonicalJson(current)) {
          throw new Error('cycle-repository acquireEvmNonceLock: lock changed while acquiring');
        }
      },
    });
    return { ...lock, state: 'HELD', journalHead: entry.digest };
  }

  /** Returns true only while this exact fence still owns the wallet nonce lock. */
  async assertEvmNonceLock(cycleId, { chainId, wallet: walletValue, fencingToken }) {
    if (typeof chainId !== 'string' || chainId.length === 0) throw new Error('EVM nonce lock chainId is invalid');
    const wallet = assertEvmAddress(walletValue, 'EVM nonce lock wallet');
    const token = assertFencingToken(fencingToken, 'EVM nonce lock fencingToken');
    const competing = await this.#heldEvmNonceLockInAnotherActiveCycle(cycleId, chainId, wallet);
    if (competing) {
      throw new Error(`cycle-repository assertEvmNonceLock: wallet is locked by active cycle ${competing.cycleId}`);
    }
    const state = await this.#replay(cycleId);
    const current = state.evmNonceLocks.get(evmNonceLockKey(chainId, wallet));
    if (!current || current.state !== 'HELD') throw new Error('cycle-repository assertEvmNonceLock: wallet nonce lock is not held');
    if (current.fencingToken !== token) throw new Error('cycle-repository assertEvmNonceLock: stale fencing token');
    return true;
  }

  async releaseEvmNonceLock(cycleId, { chainId, wallet: walletValue, fencingToken }) {
    if (typeof chainId !== 'string' || chainId.length === 0) throw new Error('EVM nonce lock chainId is invalid');
    const wallet = assertEvmAddress(walletValue, 'EVM nonce lock wallet');
    const token = assertFencingToken(fencingToken, 'EVM nonce lock fencingToken');
    const state = await this.#replay(cycleId);
    const key = evmNonceLockKey(chainId, wallet);
    const current = state.evmNonceLocks.get(key);
    if (current?.state === 'RELEASED') {
      if (current.fencingToken !== token) throw new Error('cycle-repository releaseEvmNonceLock: stale fencing token');
      return true;
    }
    if (!current || current.state !== 'HELD') throw new Error('cycle-repository releaseEvmNonceLock: wallet nonce lock is not held');
    if (current.fencingToken !== token) throw new Error('cycle-repository releaseEvmNonceLock: stale fencing token');
    const lock = { schema: evmNonceLockSchema, cycleId, chainId, wallet, fencingToken: token };
    await this.#append(cycleId, 'evm-nonce-lock-released', { lock }, {
      operation: 'releaseEvmNonceLock',
      assertState: currentState => {
        const latest = currentState.evmNonceLocks.get(key);
        if (!latest || canonicalJson(latest) !== canonicalJson(current)) {
          throw new Error('cycle-repository releaseEvmNonceLock: lock changed while releasing');
        }
      },
    });
    return true;
  }

  /**
   * Return the current cycle's custody gates without deriving a balance from floating-point values.
   * A caller can only proceed to a claim when no recorded ledger marks assets or obligations held.
   */
  async readClaimPreconditions(cycleId) {
    const states = cycleId === undefined
      ? await this.#knownStates()
      : [{ cycleId, state: await this.#replay(cycleId) }];
    let heldAssets = false;
    let unattributed = false;
    let unresolvedObligations = false;
    const positions = [];
    let heldPositionValue = 0n;
    for (const { state } of states) {
      for (const ledger of state.custodyLedgers.values()) {
        heldAssets ||= BigInt(ledger.heldAssets) > 0n;
        unattributed ||= BigInt(ledger.unattributed) > 0n;
        unresolvedObligations ||= BigInt(ledger.payoutLiability) > 0n
          || BigInt(ledger.refunds) > 0n
          || BigInt(ledger.residual) > 0n;
      }
      for (const position of state.heldPositions.values()) {
        if (position.resolution !== null) continue;
        positions.push(structuredClone(position));
        if (!Object.hasOwn(position, 'costMicroUsd')) throw new Error('historical USDG held position cannot authorize native risk');
        heldPositionValue += BigInt(position.costMicroUsd);
      }
    }
    positions.sort((left, right) => left.openedAtMs - right.openedAtMs || left.positionId.localeCompare(right.positionId));
    return {
      heldAssets,
      unattributed,
      unresolvedObligations,
      heldPositions: {
        count: positions.length,
        valueMicroUsd: heldPositionValue.toString(),
        positions,
      },
    };
  }

  /** @param {string} cycleId @param {string} stage @param {unknown} attemptValue */
  async prepareStageAttempt(cycleId, stage, attemptValue) {
    assertStageName(stage);
    const attempt = assertProviderMutationAttempt(attemptValue);
    if (attempt.cycleId !== cycleId || attempt.stage !== stage || attempt.state !== 'PREPARED') {
      throw new Error('cycle-repository prepareStageAttempt attempt does not match cycle or stage');
    }
    const state = await this.#replay(cycleId);
    if (state.terminalState) {
      throw new Error(`cycle-repository prepareStageAttempt: cycle is terminal as ${state.terminalState}`);
    }
    const current = state.operationalAttempts.get(stage);
    if (current) {
      if (current.attempt.state === 'NOT_SENT') {
        if (canonicalJson(current.attempt) !== canonicalJson(transitionProviderMutationAttempt(attempt, 'NOT_SENT'))) {
          throw new Error(`cycle-repository prepareStageAttempt: stage "${stage}" already has a different pre-call attempt`);
        }
        await this.#append(cycleId, 'stage-attempt-reprepared', { stage, attempt }, {
          operation: 'prepareStageAttempt',
          assertState: currentState => {
            const latest = currentState.operationalAttempts.get(stage);
            if (!latest || canonicalJson(latest.attempt) !== canonicalJson(current.attempt)) {
              throw new Error(`cycle-repository prepareStageAttempt: stage "${stage}" changed while resetting a pre-call attempt`);
            }
          },
        });
        return {
          attempt,
          responseEvidence: null,
          reconciliationEvidence: null,
          sentAtMs: null,
          respondedAtMs: null,
          deadlineAnchorMs: null,
          failed: false,
        };
      }
      if (canonicalJson(current.attempt) !== canonicalJson(attempt)) {
        throw new Error(`cycle-repository prepareStageAttempt: stage "${stage}" already has an operational attempt`);
      }
      return structuredClone(current);
    }
    await this.#append(cycleId, 'stage-attempt-prepared', { stage, attempt }, {
      operation: 'prepareStageAttempt',
      assertState: currentState => {
        if (currentState.operationalAttempts.has(stage)) {
          throw new Error(`cycle-repository prepareStageAttempt: stage "${stage}" already has an operational attempt`);
        }
      },
    });
    return {
      attempt,
      responseEvidence: null,
      reconciliationEvidence: null,
      sentAtMs: null,
      respondedAtMs: null,
      deadlineAnchorMs: null,
      failed: false,
    };
  }

  /** @returns {Promise<{attempt: object, responseEvidence: unknown, reconciliationEvidence: unknown, sentAtMs: number|null, respondedAtMs: number|null, deadlineAnchorMs: number|null, failed: boolean}|null>} */
  async readOperationalStageAttempt(cycleId, stage) {
    assertStageName(stage);
    const state = await this.#replay(cycleId);
    const current = state.operationalAttempts.get(stage);
    return current ? structuredClone(current) : null;
  }

  /** @param {string} cycleId @param {string} stage @param {unknown} attemptValue */
  async prepareChainTransactionAttempt(cycleId, stage, attemptValue) {
    assertStageName(stage);
    const attempt = assertChainTransactionAttempt(attemptValue);
    if (attempt.cycleId !== cycleId || attempt.stage !== stage || attempt.state !== 'PREPARED') {
      throw new Error('cycle-repository prepareChainTransactionAttempt attempt does not match cycle or stage');
    }
    const state = await this.#replay(cycleId);
    if (state.terminalState) {
      throw new Error(`cycle-repository prepareChainTransactionAttempt: cycle is terminal as ${state.terminalState}`);
    }
    const key = chainAttemptKey(stage, attempt.requestDigest);
    const current = state.chainAttempts.get(key);
    if (current) {
      if (canonicalJson(current.attempt) !== canonicalJson(attempt)) {
        throw new Error(`cycle-repository prepareChainTransactionAttempt: request "${attempt.requestDigest}" already has a chain attempt`);
      }
      return structuredClone(current);
    }
    await this.#append(cycleId, 'chain-attempt-prepared', { stage, attempt }, {
      operation: 'prepareChainTransactionAttempt',
      assertState: currentState => {
        if (currentState.chainAttempts.has(key)) {
          throw new Error(`cycle-repository prepareChainTransactionAttempt: request "${attempt.requestDigest}" already has a chain attempt`);
        }
      },
    });
    return { attempt, broadcastEvidence: null, finalityEvidence: null };
  }

  /** @returns {Promise<{attempt: object, broadcastEvidence: object|null, finalityEvidence: object|null}|null>} */
  async readChainTransactionAttempt(cycleId, stage, requestDigest) {
    assertStageName(stage);
    const state = await this.#replay(cycleId);
    const current = chainAttemptFor(state, stage, requestDigest, 'readChainTransactionAttempt');
    return current ? structuredClone(current) : null;
  }

  async recordSignedTransaction(cycleId, stage, requestDigest, signingMaterial) {
    assertStageName(stage);
    const state = await this.#replay(cycleId);
    if (state.terminalState) {
      throw new Error(`cycle-repository recordSignedTransaction: cycle is terminal as ${state.terminalState}`);
    }
    const current = chainAttemptFor(state, stage, requestDigest, 'recordSignedTransaction');
    if (!current) throw new Error(`cycle-repository recordSignedTransaction: no prepared chain attempt for "${requestDigest}"`);
    const prepared = {
      ...current.attempt,
      state: 'PREPARED',
      rawBytes: null,
      nonce: null,
      blockhash: null,
      hash: null,
    };
    const signed = transitionChainTransactionAttempt(prepared, 'SIGNED', signingMaterial);
    if (current.attempt.state === 'SIGNED') {
      if (canonicalJson(current.attempt) !== canonicalJson(signed)) {
        throw new Error(`cycle-repository recordSignedTransaction: "${stage}" already has different signing material`);
      }
      return structuredClone(current);
    }
    if (current.attempt.state !== 'PREPARED') {
      throw new Error(`cycle-repository recordSignedTransaction: "${stage}" is already broadcast and cannot be re-signed`);
    }
    await this.#append(cycleId, 'chain-attempt-signed', { stage, attempt: signed }, {
      operation: 'recordSignedTransaction',
      assertState: currentState => {
        const latest = currentState.chainAttempts.get(chainAttemptKey(stage, requestDigest));
        if (!latest || canonicalJson(latest.attempt) !== canonicalJson(current.attempt)) {
          throw new Error(`cycle-repository recordSignedTransaction: "${requestDigest}" changed while recording signing material`);
        }
      },
    });
    return { ...current, attempt: signed };
  }

  /**
   * Commits signed transaction bytes, their approval/recovery authority, and an optional Relay
   * source attribution in one journal transaction. A restart therefore observes all signing facts
   * together or retries the exact same transaction without a new signature.
   */
  async recordSignedTransactionWithRecoveryContext(cycleId, stage, requestDigest, signingMaterial, contextValue, relaySourceValue = null) {
    assertStageName(stage);
    const context = assertChainAttemptRecoveryContextInput(cycleId, contextValue);
    if (context.stage !== stage || context.requestDigest !== requestDigest) {
      throw new Error('cycle-repository atomic signed transaction recovery context does not match its chain attempt');
    }
    let relaySource = null;
    if (relaySourceValue !== null) {
      assertPlainExactObject(relaySourceValue, ['relayRequestId', 'sourceTxHash'], 'Relay source reservation');
      if (typeof relaySourceValue.relayRequestId !== 'string' || relaySourceValue.relayRequestId.length === 0
        || typeof relaySourceValue.sourceTxHash !== 'string' || relaySourceValue.sourceTxHash.length === 0) {
        throw new Error('cycle-repository atomic Relay source reservation is invalid');
      }
      relaySource = structuredClone(relaySourceValue);
    }
    const state = await this.#replay(cycleId);
    if (state.terminalState) {
      throw new Error(`cycle-repository recordSignedTransactionWithRecoveryContext: cycle is terminal as ${state.terminalState}`);
    }
    const current = chainAttemptFor(state, stage, requestDigest, 'recordSignedTransactionWithRecoveryContext');
    if (!current) throw new Error(`cycle-repository recordSignedTransactionWithRecoveryContext: no prepared chain attempt for "${requestDigest}"`);
    const prepared = {
      ...current.attempt,
      state: 'PREPARED',
      rawBytes: null,
      nonce: null,
      blockhash: null,
      hash: null,
    };
    const signed = transitionChainTransactionAttempt(prepared, 'SIGNED', signingMaterial);
    if (context.rawSignedBytesHash !== signed.hash) {
      throw new Error('cycle-repository atomic signed transaction recovery context does not bind the signed bytes');
    }
    const recoveryKey = chainAttemptRecoveryContextKey(
      context.stage,
      context.recipient,
      context.requestDigest,
      context.rawSignedBytesHash,
    );
    const existingRecovery = state.chainAttemptRecoveryContexts.get(recoveryKey) ?? null;

    let relayLeg = null;
    let relaySourceReservation = null;
    if (relaySource !== null) {
      const currentLeg = state.relayLegs.get(relayLegKey(relaySource.relayRequestId));
      if (!currentLeg) throw new Error('cycle-repository atomic signed transaction has no recorded Relay leg');
      if (currentLeg.state === 'RECORDED') {
        relayLeg = attributeRelayLegSource(currentLeg, { sourceTxHash: relaySource.sourceTxHash });
        const owner = await this.#relayTransactionHashOwner(currentLeg.sourceChainId, relaySource.sourceTxHash, {
          exceptCycleId: cycleId,
          exceptRelayRequestId: relaySource.relayRequestId,
        });
        if (owner) throw new Error(`cycle-repository atomic signed transaction: Relay hash is already attributed to ${owner.cycleId}`);
        relaySourceReservation = {
          key: relayTransactionReservationKey(currentLeg.sourceChainId, relaySource.sourceTxHash),
          value: { cycleId, relayRequestId: relaySource.relayRequestId, transactionHash: relaySource.sourceTxHash },
        };
      } else if (currentLeg.sourceTxHash !== relaySource.sourceTxHash) {
        throw new Error('cycle-repository atomic signed transaction Relay source differs from durable attribution');
      }
    }

    if (current.attempt.state === 'SIGNED') {
      if (canonicalJson(current.attempt) !== canonicalJson(signed)) {
        throw new Error(`cycle-repository recordSignedTransactionWithRecoveryContext: "${stage}" already has different signing material`);
      }
      if (!existingRecovery || canonicalJson(existingRecovery) !== canonicalJson(context)) {
        throw new Error('cycle-repository atomic signed transaction is missing its matching recovery authority');
      }
      if (relayLeg !== null) {
        throw new Error('cycle-repository atomic signed transaction Relay source was not committed with its signed bytes');
      }
      return structuredClone(current);
    }
    if (current.attempt.state !== 'PREPARED') {
      throw new Error(`cycle-repository recordSignedTransactionWithRecoveryContext: "${stage}" is already broadcast and cannot be re-signed`);
    }
    if (existingRecovery !== null) {
      throw new Error('cycle-repository atomic signed transaction has recovery authority without signed bytes');
    }

    const events = [
      { kind: 'chain-attempt-signed', payload: { stage, attempt: signed } },
      { kind: 'chain-attempt-recovery-context-recorded', payload: { context } },
      ...(relayLeg === null ? [] : [{ kind: 'relay-leg-source-recorded', payload: { relayRequestId: relaySource.relayRequestId, leg: relayLeg } }]),
    ];
    await this.#appendEvents(cycleId, events, {
      operation: 'recordSignedTransactionWithRecoveryContext',
      globalKeyReservations: relaySourceReservation === null ? [] : [relaySourceReservation],
      assertState: currentState => {
        const latest = currentState.chainAttempts.get(chainAttemptKey(stage, requestDigest));
        if (!latest || canonicalJson(latest.attempt) !== canonicalJson(current.attempt)) {
          throw new Error(`cycle-repository recordSignedTransactionWithRecoveryContext: "${requestDigest}" changed while recording signing material`);
        }
        if (currentState.chainAttemptRecoveryContexts.has(recoveryKey)) {
          throw new Error('cycle-repository atomic signed transaction recovery authority changed while recording');
        }
        if (relayLeg !== null) {
          const latestLeg = currentState.relayLegs.get(relayLegKey(relaySource.relayRequestId));
          const originalLeg = state.relayLegs.get(relayLegKey(relaySource.relayRequestId));
          if (!latestLeg || canonicalJson(latestLeg) !== canonicalJson(originalLeg)) {
            throw new Error('cycle-repository atomic signed transaction Relay source changed while recording');
          }
        }
      },
    });
    return { ...current, attempt: signed };
  }

  async recordBroadcast(cycleId, stage, requestDigest, evidence) {
    assertStageName(stage);
    const broadcastEvidence = cloneChainObservationEvidence(evidence, 'chain transaction broadcast evidence');
    const state = await this.#replay(cycleId);
    const current = chainAttemptFor(state, stage, requestDigest, 'recordBroadcast');
    if (!current) throw new Error(`cycle-repository recordBroadcast: no signed chain attempt for "${requestDigest}"`);
    if (['BROADCAST', 'FINALIZED'].includes(current.attempt.state)) {
      if (canonicalJson(current.broadcastEvidence) !== canonicalJson(broadcastEvidence)) {
        throw new Error(`cycle-repository recordBroadcast: "${requestDigest}" already has different broadcast evidence`);
      }
      return structuredClone(current);
    }
    if (current.attempt.state !== 'SIGNED') {
      throw new Error(`cycle-repository recordBroadcast: "${stage}" must be signed before broadcast`);
    }
    const attempt = transitionChainTransactionAttempt(current.attempt, 'BROADCAST');
    await this.#append(cycleId, 'chain-attempt-broadcast', { stage, attempt, evidence: broadcastEvidence }, {
      assertState: currentState => {
        const latest = currentState.chainAttempts.get(chainAttemptKey(stage, requestDigest));
        if (!latest || canonicalJson(latest.attempt) !== canonicalJson(current.attempt)) {
          throw new Error(`cycle-repository recordBroadcast: "${requestDigest}" changed while recording broadcast`);
        }
      },
    });
    return { ...current, attempt, broadcastEvidence };
  }

  async recordFinality(cycleId, stage, requestDigest, evidence) {
    assertStageName(stage);
    const finalityEvidence = cloneChainObservationEvidence(evidence, 'chain transaction finality evidence');
    const state = await this.#replay(cycleId);
    const current = chainAttemptFor(state, stage, requestDigest, 'recordFinality');
    if (!current) throw new Error(`cycle-repository recordFinality: no broadcast chain attempt for "${requestDigest}"`);
    if (current.attempt.state === 'FINALIZED') {
      if (canonicalJson(current.finalityEvidence) !== canonicalJson(finalityEvidence)) {
        throw new Error(`cycle-repository recordFinality: "${requestDigest}" already has different finality evidence`);
      }
      return structuredClone(current);
    }
    if (current.attempt.state !== 'BROADCAST') {
      throw new Error(`cycle-repository recordFinality: "${stage}" must be broadcast before finality`);
    }
    const attempt = transitionChainTransactionAttempt(current.attempt, 'FINALIZED');
    await this.#append(cycleId, 'chain-attempt-finalized', { stage, attempt, evidence: finalityEvidence }, {
      assertState: currentState => {
        const latest = currentState.chainAttempts.get(chainAttemptKey(stage, requestDigest));
        if (!latest || canonicalJson(latest.attempt) !== canonicalJson(current.attempt)) {
          throw new Error(`cycle-repository recordFinality: "${requestDigest}" changed while recording finality`);
        }
      },
    });
    return { ...current, attempt, finalityEvidence };
  }

  /** Records an immutable RelayLegV1 before any source transaction is signed. */
  async recordRelayLeg(cycleId, legValue) {
    const leg = assertRelayLeg(legValue, 'Relay leg');
    if (leg.cycleId !== cycleId || leg.state !== 'RECORDED' || leg.sourceTxHash !== null) {
      throw new Error('cycle-repository recordRelayLeg requires an unsigned recorded Relay leg for this cycle');
    }
    const state = await this.#replay(cycleId);
    if (state.terminalState) throw new Error(`cycle-repository recordRelayLeg: cycle is terminal as ${state.terminalState}`);
    const key = relayLegKey(leg.relayRequestId);
    const current = state.relayLegs.get(key);
    if (current) {
      if (canonicalJson(current) !== canonicalJson(leg)) throw new Error('cycle-repository recordRelayLeg: Relay request id already has different evidence');
      return structuredClone(current);
    }
    await this.#append(cycleId, 'relay-leg-recorded', { leg }, {
      operation: 'recordRelayLeg',
      assertState: currentState => {
        if (currentState.relayLegs.has(key)) throw new Error('cycle-repository recordRelayLeg: Relay leg changed while recording');
      },
    });
    return structuredClone(leg);
  }

  async readRelayLeg(cycleId, relayRequestId) {
    if (typeof relayRequestId !== 'string' || relayRequestId.length === 0) throw new Error('cycle-repository readRelayLeg: relayRequestId is invalid');
    const state = await this.#replay(cycleId);
    const leg = state.relayLegs.get(relayLegKey(relayRequestId));
    return leg ? structuredClone(leg) : null;
  }

  /** Binds the source hash only after exact signed bytes have been persisted. */
  async recordRelayLegSource(cycleId, relayRequestId, sourceTxHash) {
    if (typeof relayRequestId !== 'string' || relayRequestId.length === 0) throw new Error('cycle-repository recordRelayLegSource: relayRequestId is invalid');
    if (typeof sourceTxHash !== 'string' || sourceTxHash.length === 0) throw new Error('cycle-repository recordRelayLegSource: sourceTxHash is invalid');
    const state = await this.#replay(cycleId);
    if (state.terminalState) throw new Error(`cycle-repository recordRelayLegSource: cycle is terminal as ${state.terminalState}`);
    const current = state.relayLegs.get(relayLegKey(relayRequestId));
    if (!current) throw new Error('cycle-repository recordRelayLegSource: no recorded Relay leg exists');
    const leg = attributeRelayLegSource(current, { sourceTxHash });
    if (canonicalJson(current) === canonicalJson(leg)) return structuredClone(current);
    canonicalRelayTransactionHash(current.sourceChainId, sourceTxHash, 'cycle-repository recordRelayLegSource sourceTxHash');
    const owner = await this.#relayTransactionHashOwner(current.sourceChainId, sourceTxHash, {
      exceptCycleId: cycleId,
      exceptRelayRequestId: relayRequestId,
    });
    if (owner) throw new Error(`cycle-repository recordRelayLegSource: transaction hash is already attributed to ${owner.cycleId}`);
    const reservationKey = relayTransactionReservationKey(current.sourceChainId, sourceTxHash);
    const reservation = { cycleId, relayRequestId, transactionHash: sourceTxHash };
    await this.#append(cycleId, 'relay-leg-source-recorded', { relayRequestId, leg }, {
      operation: 'recordRelayLegSource',
      globalKeyReservations: [{ key: reservationKey, value: reservation }],
      assertState: currentState => {
        const latest = currentState.relayLegs.get(relayLegKey(relayRequestId));
        if (!latest || canonicalJson(latest) !== canonicalJson(current)) {
          throw new Error('cycle-repository recordRelayLegSource: Relay leg changed while recording source hash');
        }
      },
    });
    return structuredClone(leg);
  }

  /**
   * Settles only an already-attributed Relay leg. Outbound uses a memo-bound Solana observation;
   * return uses a Relay terminal-status transaction pointer plus this process's finalized EVM
   * receipt proof. Relay status alone is deliberately not an accepted input field.
   */
  async settleRelayLeg(cycleId, relayRequestId, settlementValue) {
    if (typeof relayRequestId !== 'string' || relayRequestId.length === 0) throw new Error('cycle-repository settleRelayLeg: relayRequestId is invalid');
    const state = await this.#replay(cycleId);
    if (state.terminalState) throw new Error(`cycle-repository settleRelayLeg: cycle is terminal as ${state.terminalState}`);
    const current = state.relayLegs.get(relayLegKey(relayRequestId));
    if (!current) throw new Error('cycle-repository settleRelayLeg: no recorded Relay leg exists');
    const { leg, settlement } = current.direction === 'outbound'
      ? observedOutboundRelaySettlement(state, current, settlementValue)
      : observedReturnRelaySettlement(state, current, settlementValue);
    if (sameRelayTransactionHash(leg.destinationChainId, leg.destinationTxHash, leg.sourceChainId, leg.sourceTxHash)) {
      throw new Error('cycle-repository settleRelayLeg: source and destination transaction hashes must be globally distinct');
    }
    const owner = await this.#relayTransactionHashOwner(leg.destinationChainId, leg.destinationTxHash, {
      exceptCycleId: cycleId,
      exceptRelayRequestId: relayRequestId,
    });
    if (owner) throw new Error(`cycle-repository settleRelayLeg: transaction hash is already attributed to ${owner.cycleId}`);
    const destinationReservationKey = relayTransactionReservationKey(leg.destinationChainId, leg.destinationTxHash);
    const destinationReservation = { cycleId, relayRequestId, transactionHash: leg.destinationTxHash };
    // ADR-0026: the return-direction credit-and-clear or clearing-only ledger update travels inside
    // `settlement.custodyLedger`, already part of this one event's payload -- no separate
    // `custody-ledger-recorded` event, so only this dedicated settlement path (and the dedicated
    // return-leg expectation creation) can ever move `expectedCycleAsset`.
    const events = [{ kind: 'relay-leg-settled', payload: { relayRequestId, leg, settlement } }];
    if (RELAY_LEG_TERMINAL_STATES.includes(leg.state)) {
      events.push({
        kind: 'cycle-terminal',
        payload: {
          terminalState: leg.state,
          evidence: {
            relayRequestId,
            sourceTxHash: leg.sourceTxHash,
            destinationTxHash: leg.destinationTxHash,
            settlement,
          },
        },
      });
    }
    await this.#appendEvents(cycleId, events, {
      operation: 'settleRelayLeg',
      globalKeyReservations: [{ key: destinationReservationKey, value: destinationReservation }],
      assertState: currentState => {
        const latest = currentState.relayLegs.get(relayLegKey(relayRequestId));
        if (!latest || canonicalJson(latest) !== canonicalJson(current)) {
          throw new Error('cycle-repository settleRelayLeg: Relay leg changed while recording settlement');
        }
        if (settlement.custodyLedger !== undefined && settlement.custodyLedger !== null) {
          const ledgerKey = custodyLedgerKey(settlement.custodyLedger);
          const previousLedger = state.custodyLedgers.get(ledgerKey) ?? null;
          const latestLedger = currentState.custodyLedgers.get(ledgerKey) ?? null;
          if (canonicalJson(latestLedger) !== canonicalJson(previousLedger)) {
            throw new Error('cycle-repository settleRelayLeg: return custody changed while recording settlement');
          }
        }
      },
    });
    return structuredClone(leg);
  }

  async readStandingAuthorityDecision(cycleId, intentDigest) {
    assertDigest(intentDigest, 'cycle-repository readStandingAuthorityDecision intentDigest');
    const state = await this.#replay(cycleId);
    const decision = state.standingAuthorityDecisions.get(intentDigest);
    return decision ? structuredClone(decision) : null;
  }

  /** Persists first-use authority evidence with its day-cap and nonce reservations. */
  async recordStandingAuthorityDecision(cycleId, decisionValue, { maxCyclesPerDay } = {}) {
    const decision = assertStandingAuthorityDecision(decisionValue, 'standing authority decision');
    const cap = assertMaxCyclesPerDay(maxCyclesPerDay);
    const owner = { cycleId, intentDigest: decision.intentDigest, authorityDigest: decision.authorityDigest };
    const nonceKey = `standing-authority-nonce:${decision.nonceReservation.reservationKey}`;
    let lastContention = null;
    for (let retry = 0; retry < cap * 4; retry += 1) {
      try {
        const state = await this.#replay(cycleId);
        if (state.terminalState) throw new Error(`cycle-repository recordStandingAuthorityDecision: cycle is terminal as ${state.terminalState}`);
        const current = state.standingAuthorityDecisions.get(decision.intentDigest);
        if (current) {
          if (canonicalJson(current) !== canonicalJson(decision)) throw new Error('cycle-repository recordStandingAuthorityDecision: authority decision conflict');
          return structuredClone(current);
        }
        const decisions = await this.#standingAuthorityDecisions();
        for (const known of decisions) {
          if (known.decision.intentDigest === decision.intentDigest) {
            throw new Error('cycle-repository recordStandingAuthorityDecision: intent is already reserved by another cycle');
          }
          if (known.decision.nonceReservation.reservationKey === decision.nonceReservation.reservationKey) {
            throw new Error('cycle-repository recordStandingAuthorityDecision: authority nonce reservation is already used');
          }
        }
        const usedToday = decisions.filter(known => known.decision.authorityDigest === decision.authorityDigest
          && known.decision.dayCapReservation.day === decision.dayCapReservation.day).length;
        if (usedToday >= cap) throw new Error('cycle-repository recordStandingAuthorityDecision: authority day cap reservation is exhausted');
        const nonceOwner = await this.#store.readGlobalKey(nonceKey);
        if (nonceOwner !== null && canonicalJson(nonceOwner) !== canonicalJson(owner)) {
          throw new Error('cycle-repository recordStandingAuthorityDecision: authority nonce reservation is already used');
        }
        let dayKey = null;
        for (let slot = 0; slot < cap; slot += 1) {
          const candidate = `standing-authority-day:${decision.authorityDigest}:${decision.dayCapReservation.day}:${slot}`;
          const existing = await this.#store.readGlobalKey(candidate);
          if (existing === null || canonicalJson(existing) === canonicalJson(owner)) {
            dayKey = candidate;
            break;
          }
        }
        if (dayKey === null) throw new Error('cycle-repository recordStandingAuthorityDecision: authority day cap reservation is exhausted');
        await this.#append(cycleId, 'standing-authority-decision-recorded', { decision }, {
          operation: 'recordStandingAuthorityDecision',
          globalKeyReservations: [
            { key: nonceKey, value: owner },
            { key: dayKey, value: owner },
          ],
          assertState: currentState => {
            if (currentState.standingAuthorityDecisions.has(decision.intentDigest)) {
              throw new Error('cycle-repository recordStandingAuthorityDecision: decision changed while reserving');
            }
          },
        });
        return structuredClone(decision);
      } catch (error) {
        if (!/durable cycle store lock contention|durable global reservation key|expected version|journal head|decision changed while reserving/.test(error?.message ?? '')) {
          throw error;
        }
        lastContention = error;
        await new Promise(resolve => setTimeout(resolve, Math.min(32, 2 ** retry)));
      }
    }
    throw lastContention ?? new Error('cycle-repository recordStandingAuthorityDecision: authority reservation contention did not resolve');
  }

  /** Owner-configured USD policy for the managed claim path; the hook itself still enforces wei. */
  async reserveProcessClaimUsd(cycleId, { hook, amountWei, limitMicroUsd = PROCESS_USD_DEFAULT_MICRO }) {
    if (typeof limitMicroUsd !== 'string' || !/^(0|[1-9][0-9]*)$/.test(limitMicroUsd)
      || BigInt(limitMicroUsd) > PROCESS_USD_HARD_MAX_MICRO) throw new Error('process USD claim limit exceeds the hard maximum or is invalid');
    const state = await this.#replay(cycleId);
    if (state.terminalState) throw new Error('process USD claim cannot reserve a terminal cycle');
    const key = processUsdBudgetKey(hook);
    const valuation = state.admission?.aggregateFundingUsd;
    const asset = { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: amountWei };
    if (state.releaseAmount !== amountWei || state.admission?.processLiabilityEvidence?.hook?.toLowerCase() !== hook.toLowerCase()
      || !this.isDurableQuoteUsdValuation(valuation, { amount: asset, rounding: 'up' })) {
      throw new Error('process USD claim requires fresh authenticated exact-amount admission valuation');
    }
    const now = currentRepositoryTime(this.#now);
    const existing = await this.#store.readGlobalKey(key);
    const budget = validateProcessUsdBudget(existing ?? { schema: 'hookemon.process-usd-budget.v1', entries: [] });
    const reservation = { cycleId, amountWei, amountMicroUsd: valuation.amountMicroUsd,
      valuationDigest: digest(valuation), state: 'RESERVED', confirmedAtMs: null, transactionHash: null };
    const previous = budget.entries.find(entry => entry.cycleId === cycleId);
    if (previous && canonicalJson(previous) !== canonicalJson(reservation)) throw new Error('process USD claim reservation differs or is already finalized');
    const used = budget.entries.reduce((total, entry) => total + (
      entry.state === 'RESERVED' || (entry.state === 'CONFIRMED' && now - entry.confirmedAtMs < PROCESS_USD_WINDOW_MS)
        ? BigInt(entry.amountMicroUsd) : 0n), 0n);
    if (BigInt(limitMicroUsd) === 0n || used + (previous ? 0n : BigInt(reservation.amountMicroUsd)) > BigInt(limitMicroUsd)) {
      throw new Error('process USD rolling six-hour limit exceeded');
    }
    if (previous) return structuredClone(previous);
    const value = { ...budget, entries: [...budget.entries, reservation] };
    await this.#append(cycleId, 'process-usd-claim-reserved', { hook: hook.toLowerCase(), reservation }, {
      operation: 'reserveProcessClaimUsd',
      ...(existing === null ? { globalKeyReservations: [{ key, value }] }
        : { globalKeyReplacements: [{ key, expectedValue: existing, value }] }),
    });
    return structuredClone(reservation);
  }

  /** Only a live native payment/gas capability can settle a durable reservation. */
  async finalizeProcessClaimUsd(cycleId, { hook, proof }) {
    const key = processUsdBudgetKey(hook);
    const existing = await this.#store.readGlobalKey(key);
    if (existing === null) throw new Error('process USD claim has no durable reservation');
    const budget = validateProcessUsdBudget(existing);
    const previous = budget.entries.find(entry => entry.cycleId === cycleId);
    if (!previous) throw new Error('process USD claim has no durable reservation');
    const state = await this.#replay(cycleId);
    const onchainCycleId = `0x${createHash('sha256').update(cycleId, 'utf8').digest('hex')}`;
    const confirmed = isProcessNativePaymentProof(proof, { kind: 'hook-claim', source: hook.toLowerCase(),
      amountWei: previous.amountWei, cycleId: onchainCycleId });
    if (!confirmed) {
      const attempts = [...state.chainAttempts.values()].filter(record => record.attempt.stage === 'claim-process'
        && record.attempt.hash === proof?.transactionHash && digest(record.attempt.rawBytes) === proof.transactionDigest);
      if (proof?.receiptStatus !== 'reverted' || attempts.length !== 1) throw new Error('process USD claim finality is unverified');
      // Reuse the native gas capability validator against the already recorded custody ledger.
      // JSON receipt lookalikes cannot release capacity.
      applyNativeCustodyGasPayment(state.custodyLedgers.get('4663\u0000native'), proof);
    }
    const confirmedAtMs = Number(BigInt(proof.timestampUnixSeconds) * 1000n);
    if (!Number.isSafeInteger(confirmedAtMs) || confirmedAtMs < 0 || confirmedAtMs > currentRepositoryTime(this.#now)) {
      throw new Error('process USD claim finality timestamp is invalid');
    }
    const reservation = { ...previous, state: confirmed ? 'CONFIRMED' : 'REVERTED', confirmedAtMs,
      transactionHash: proof.transactionHash };
    if (previous.state !== 'RESERVED') {
      if (canonicalJson(previous) !== canonicalJson(reservation)) throw new Error('process USD claim finality conflicts');
      return structuredClone(previous);
    }
    const value = { ...budget, entries: budget.entries.map(entry => entry.cycleId === cycleId ? reservation : entry) };
    await this.#append(cycleId, 'process-usd-claim-finalized', { hook: hook.toLowerCase(), reservation }, {
      globalKeyReplacements: [{ key, expectedValue: existing, value }],
    });
    return structuredClone(reservation);
  }

  async reserveWalletNonce(cycleId, reservationValue) {
    const reservation = assertWalletNonceReservationInput(cycleId, reservationValue);
    const now = currentRepositoryTime(this.#now);
    if (reservation.leaseAcquiredAtMs > now || walletNonceReservationExpired(reservation, now)) {
      throw new Error('cycle-repository reserveWalletNonce: reservation lease is not active');
    }
    const state = await this.#replay(cycleId);
    if (state.terminalState && !payoutRetryMayUseHeldCycle(state)) {
      throw new Error(`cycle-repository reserveWalletNonce: cycle is terminal as ${state.terminalState}`);
    }
    const key = walletNonceReservationKey(reservation.chainId, reservation.wallet);
    const current = state.walletNonceReservations.get(key);
    if (current?.state === 'HELD') {
      if (canonicalJson(current) === canonicalJson(reservation)) return structuredClone(current);
      if (!walletNonceReservationExpired(current, now) || !validWalletNonceTakeover(current, reservation)) {
        throw new Error('cycle-repository reserveWalletNonce: wallet is already reserved with different fence');
      }
    }
    if (current && current.state !== 'RELEASED'
      && !(current.state === 'HELD'
        && walletNonceReservationExpired(current, now)
        && validWalletNonceTakeover(current, reservation))) {
      throw new Error('cycle-repository reserveWalletNonce: wallet reservation has an invalid state');
    }
    const competing = await this.#heldWalletNonceReservationInAnotherCycle(cycleId, reservation, now);
    if (competing) throw new Error(`cycle-repository reserveWalletNonce: wallet is reserved by active cycle ${competing.cycleId}`);
    const globalKey = `wallet-nonce:${reservation.chainId}:${reservation.wallet.toLowerCase()}`;
    const existingGlobal = await this.#store.readGlobalKey(globalKey);
    let globalKeyReservations = [];
    let globalKeyReplacements = [];
    if (existingGlobal === null) {
      globalKeyReservations = [{ key: globalKey, value: reservation }];
    } else if (canonicalJson(existingGlobal) !== canonicalJson(reservation)) {
      let existingReservation;
      try {
        existingReservation = assertWalletNonceReservation(existingGlobal, 'durable wallet nonce reservation');
      } catch {
        throw new Error('cycle-repository reserveWalletNonce: durable wallet nonce reservation is invalid');
      }
      if (!walletNonceReservationExpired(existingReservation, now)
        || !validWalletNonceTakeover(existingReservation, reservation)) {
        throw new Error('cycle-repository reserveWalletNonce: wallet is already reserved with different fence');
      }
      globalKeyReplacements = [{ key: globalKey, expectedValue: existingGlobal, value: reservation }];
    }
    await this.#append(cycleId, 'wallet-nonce-reserved', { reservation }, {
      operation: 'reserveWalletNonce',
      globalKeyReservations,
      globalKeyReplacements,
      assertState: currentState => {
        const latest = currentState.walletNonceReservations.get(key);
        if (latest?.state === 'HELD'
          && canonicalJson(latest) !== canonicalJson(reservation)
          && (!walletNonceReservationExpired(latest, now) || !validWalletNonceTakeover(latest, reservation))) {
          throw new Error('cycle-repository reserveWalletNonce: reservation changed while acquiring');
        }
        if (latest && latest.state !== 'HELD' && latest.state !== 'RELEASED') {
          throw new Error('cycle-repository reserveWalletNonce: wallet reservation has an invalid state');
        }
      },
    });
    return structuredClone(reservation);
  }

  async assertWalletNonce(cycleId, reservationValue) {
    const expected = assertWalletNonceReservationInput(cycleId, reservationValue);
    const now = currentRepositoryTime(this.#now);
    if (walletNonceReservationExpired(expected, now)) {
      throw new Error('cycle-repository assertWalletNonce: wallet nonce reservation lease has expired');
    }
    const competing = await this.#heldWalletNonceReservationInAnotherCycle(cycleId, expected, now);
    if (competing) throw new Error(`cycle-repository assertWalletNonce: wallet is reserved by active cycle ${competing.cycleId}`);
    const state = await this.#replay(cycleId);
    const current = state.walletNonceReservations.get(walletNonceReservationKey(expected.chainId, expected.wallet));
    if (!current || current.state !== 'HELD') throw new Error('cycle-repository assertWalletNonce: wallet nonce reservation is not held');
    if (walletNonceReservationExpired(current, now)) {
      throw new Error('cycle-repository assertWalletNonce: wallet nonce reservation lease has expired');
    }
    if (canonicalJson(current) !== canonicalJson(expected)) throw new Error('cycle-repository assertWalletNonce: stale wallet nonce fencing token');
    return true;
  }

  async releaseWalletNonce(cycleId, reservationValue) {
    const expected = assertWalletNonceReservationInput(cycleId, reservationValue);
    const state = await this.#replay(cycleId);
    const key = walletNonceReservationKey(expected.chainId, expected.wallet);
    const current = state.walletNonceReservations.get(key);
    const globalKey = `wallet-nonce:${expected.chainId}:${expected.wallet.toLowerCase()}`;
    if (current?.state === 'RELEASED') {
      if (current.fencingToken !== expected.fencingToken || current.stage !== expected.stage
        || current.leaseAcquiredAtMs !== expected.leaseAcquiredAtMs
        || current.leaseExpiresAtMs !== expected.leaseExpiresAtMs) {
        throw new Error('cycle-repository releaseWalletNonce: stale wallet nonce fencing token');
      }
      const strandedGlobal = await this.#store.readGlobalKey(globalKey);
      if (strandedGlobal !== null) {
        if (canonicalJson(strandedGlobal) !== canonicalJson(expected)) {
          throw new Error('cycle-repository releaseWalletNonce: durable wallet nonce reservation has a newer fence');
        }
        await this.#store.releaseGlobalKey(globalKey, expected);
      }
      return true;
    }
    if (!current || canonicalJson(current) !== canonicalJson(expected)) throw new Error('cycle-repository releaseWalletNonce: stale wallet nonce fencing token');
    const released = { ...expected, state: 'RELEASED' };
    const existingGlobal = await this.#store.readGlobalKey(globalKey);
    if (existingGlobal !== null && canonicalJson(existingGlobal) !== canonicalJson(expected)) {
      throw new Error('cycle-repository releaseWalletNonce: durable wallet nonce reservation has a newer fence');
    }
    await this.#append(cycleId, 'wallet-nonce-released', { reservation: released }, {
      operation: 'releaseWalletNonce',
      globalKeyReleases: existingGlobal === null ? [] : [{ key: globalKey, expectedValue: expected }],
      assertState: currentState => {
        const latest = currentState.walletNonceReservations.get(key);
        if (!latest || canonicalJson(latest) !== canonicalJson(current)) {
          throw new Error('cycle-repository releaseWalletNonce: reservation changed while releasing');
        }
      },
    });
    return true;
  }

  async persistChainAttemptRecoveryContext(cycleId, contextValue) {
    const context = assertChainAttemptRecoveryContextInput(cycleId, contextValue);
    const state = await this.#replay(cycleId);
    if (state.terminalState) throw new Error(`cycle-repository persistChainAttemptRecoveryContext: cycle is terminal as ${state.terminalState}`);
    const chain = chainAttemptFor(state, context.stage, context.requestDigest, 'persistChainAttemptRecoveryContext');
    if (!isRecipientPagedRecoveryContext(context) && (!chain || !['SIGNED', 'BROADCAST', 'FINALIZED'].includes(chain.attempt.state)
      || chain.attempt.hash !== context.rawSignedBytesHash)) {
      throw new Error('cycle-repository persistChainAttemptRecoveryContext: signed bytes are not durably recorded');
    }
    const key = chainAttemptRecoveryContextKey(
      context.stage,
      context.recipient,
      context.requestDigest,
      context.rawSignedBytesHash,
    );
    const current = state.chainAttemptRecoveryContexts.get(key);
    if (current) {
      if (canonicalJson(current) !== canonicalJson(context)) throw new Error('cycle-repository persistChainAttemptRecoveryContext: recovery context conflict');
      return recoveryContextPublicValue(current);
    }
    await this.#append(cycleId, 'chain-attempt-recovery-context-recorded', { context }, {
      operation: 'persistChainAttemptRecoveryContext',
      assertState: currentState => {
        if (currentState.chainAttemptRecoveryContexts.has(key)) {
          throw new Error('cycle-repository persistChainAttemptRecoveryContext: context changed while recording');
        }
      },
    });
    return recoveryContextPublicValue(context);
  }

  async readChainAttemptRecoveryContext(cycleId, contextValue) {
    const context = Object.keys(contextValue ?? {}).length === 4
      ? assertChainAttemptRecoveryContextSelector(contextValue)
      : assertChainAttemptRecoveryContextInput(cycleId, contextValue);
    const state = await this.#replay(cycleId);
    const stored = state.chainAttemptRecoveryContexts.get(
      chainAttemptRecoveryContextKey(
        context.stage,
        context.recipient,
        context.requestDigest,
        context.rawSignedBytesHash,
      ),
    );
    if (!stored) return null;
    return recoveryContextPublicValue(stored);
  }

  /**
   * REQ-cycle-repository-2 `retry-sign-only-with-durable-binding`: commits the exact unsigned
   * wire bytes, signer role/account identity, request digest, policy/authorization digest, and
   * chain validity context a bounded Keychain sign-only retry may reuse, before the first
   * sign-only invocation. A CAS-like write: byte-identical replay is idempotent, and a changed
   * field, a concurrent conflicting binding, or a chain attempt that is not (still) PREPARED all
   * refuse before any binding is durable.
   */
  async persistSignOnlyPreSignBinding(cycleId, stage, requestDigest, bindingValue) {
    assertStageName(stage);
    const binding = assertSignOnlyPreSignBinding(bindingValue);
    if (binding.cycleId !== cycleId || binding.stage !== stage || binding.requestDigest !== requestDigest) {
      throw new Error('cycle-repository persistSignOnlyPreSignBinding: binding does not match cycle, stage, or request');
    }
    const state = await this.#replay(cycleId);
    if (state.terminalState) {
      throw new Error(`cycle-repository persistSignOnlyPreSignBinding: cycle is terminal as ${state.terminalState}`);
    }
    const chain = chainAttemptFor(state, stage, requestDigest, 'persistSignOnlyPreSignBinding');
    if (!chain || chain.attempt.state !== 'PREPARED') {
      throw new Error('cycle-repository persistSignOnlyPreSignBinding: chain attempt is not PREPARED');
    }
    const key = signOnlyPreSignBindingKey(stage, requestDigest);
    const current = state.signOnlyPreSignBindings.get(key);
    if (current) {
      if (canonicalJson(current) !== canonicalJson(binding)) {
        throw new Error('cycle-repository persistSignOnlyPreSignBinding: request already has a different pre-sign binding');
      }
      return structuredClone(current);
    }
    await this.#append(cycleId, 'sign-only-pre-sign-binding-persisted', { binding }, {
      operation: 'persistSignOnlyPreSignBinding',
      assertState: currentState => {
        if (currentState.signOnlyPreSignBindings.has(key)) {
          throw new Error('cycle-repository persistSignOnlyPreSignBinding: a concurrent binding was already recorded');
        }
        const latestChain = chainAttemptFor(currentState, stage, requestDigest, 'persistSignOnlyPreSignBinding');
        if (!latestChain || latestChain.attempt.state !== 'PREPARED') {
          throw new Error('cycle-repository persistSignOnlyPreSignBinding: chain attempt changed while recording');
        }
      },
    });
    return structuredClone(binding);
  }

  /** @returns {Promise<object|null>} */
  async readSignOnlyPreSignBinding(cycleId, stage, requestDigest) {
    assertStageName(stage);
    const state = await this.#replay(cycleId);
    const current = state.signOnlyPreSignBindings.get(signOnlyPreSignBindingKey(stage, requestDigest));
    return current ? structuredClone(current) : null;
  }

  /**
   * REQ-cycle-repository-2 `retry-sign-only-with-durable-binding`: atomically reserves the durable
   * invocation budget's next ordinal (1 or 2) for a sign-only pre-sign binding, immediately before
   * a caller may invoke Keychain. Ordinal 1 is permitted only when no invocation ledger exists yet
   * for this binding; ordinal 2 is permitted only when the ledger's current state is exactly
   * `ORDINAL_1_TIMED_OUT`. Both require the bound chain attempt to still be PREPARED, re-verified
   * atomically at the moment of reservation. Unlike the binding itself, this reservation is never
   * idempotent-on-match: a concurrent second caller racing for the same ordinal, or a caller that
   * arrives after the ordinal was already reserved, always refuses -- exactly one caller ever wins
   * the right to make that invocation.
   */
  async reserveSignOnlyInvocation(cycleId, stage, requestDigest, ordinal) {
    assertStageName(stage);
    if (ordinal !== 1 && ordinal !== 2) throw new Error('cycle-repository reserveSignOnlyInvocation: ordinal must be 1 or 2');
    const state = await this.#replay(cycleId);
    if (state.terminalState) {
      throw new Error(`cycle-repository reserveSignOnlyInvocation: cycle is terminal as ${state.terminalState}`);
    }
    if (!state.signOnlyPreSignBindings.has(signOnlyPreSignBindingKey(stage, requestDigest))) {
      throw new Error('cycle-repository reserveSignOnlyInvocation: no durable pre-sign binding for this request');
    }
    const chain = chainAttemptFor(state, stage, requestDigest, 'reserveSignOnlyInvocation');
    if (!chain || chain.attempt.state !== 'PREPARED') {
      throw new Error('cycle-repository reserveSignOnlyInvocation: chain attempt is not PREPARED');
    }
    const ledgerKey = signOnlyInvocationLedgerKey(stage, requestDigest);
    const currentLedger = state.signOnlyInvocationLedgers.get(ledgerKey) ?? null;
    let ledger;
    if (ordinal === 1) {
      if (currentLedger) throw new Error('cycle-repository reserveSignOnlyInvocation: ordinal 1 was already reserved');
      ledger = createReservedSignOnlyInvocationLedger({ cycleId, stage, requestDigest });
    } else {
      if (!currentLedger || currentLedger.state !== 'ORDINAL_1_TIMED_OUT') {
        throw new Error('cycle-repository reserveSignOnlyInvocation: ordinal 2 requires a recorded ordinal 1 timeout');
      }
      ledger = transitionSignOnlyInvocationLedger(currentLedger, 'ORDINAL_2_ALLOCATED');
    }
    await this.#append(cycleId, 'sign-only-invocation-reserved', { ledger }, {
      operation: 'reserveSignOnlyInvocation',
      assertState: currentState => {
        const latestChain = chainAttemptFor(currentState, stage, requestDigest, 'reserveSignOnlyInvocation');
        if (!latestChain || latestChain.attempt.state !== 'PREPARED') {
          throw new Error('cycle-repository reserveSignOnlyInvocation: chain attempt changed while reserving');
        }
        const latestLedger = currentState.signOnlyInvocationLedgers.get(ledgerKey) ?? null;
        if (ordinal === 1) {
          if (latestLedger) throw new Error('cycle-repository reserveSignOnlyInvocation: ordinal 1 was already reserved');
        } else if (!latestLedger || canonicalJson(latestLedger) !== canonicalJson(currentLedger)) {
          throw new Error('cycle-repository reserveSignOnlyInvocation: ordinal 1 outcome changed while reserving ordinal 2');
        }
      },
    });
    return structuredClone(ledger);
  }

  /**
   * Durably records that a reserved ordinal's Keychain invocation was classified as a sign-only
   * timeout -- the only outcome this repository ever records for an invocation, and the only fact
   * that ever makes ordinal 2 eligible. A generic error, a proven pre-invocation denial, or a crash
   * with no observed outcome never calls this method, so the ledger simply never advances past
   * `ORDINAL_{ordinal}_ALLOCATED` for that case, permanently refusing any further ordinal.
   */
  async recordSignOnlyInvocationTimeout(cycleId, stage, requestDigest, ordinal) {
    assertStageName(stage);
    if (ordinal !== 1 && ordinal !== 2) throw new Error('cycle-repository recordSignOnlyInvocationTimeout: ordinal must be 1 or 2');
    const state = await this.#replay(cycleId);
    if (state.terminalState) {
      throw new Error(`cycle-repository recordSignOnlyInvocationTimeout: cycle is terminal as ${state.terminalState}`);
    }
    const ledgerKey = signOnlyInvocationLedgerKey(stage, requestDigest);
    const currentLedger = state.signOnlyInvocationLedgers.get(ledgerKey) ?? null;
    const expectedCurrentState = ordinal === 1 ? 'ORDINAL_1_ALLOCATED' : 'ORDINAL_2_ALLOCATED';
    const nextState = ordinal === 1 ? 'ORDINAL_1_TIMED_OUT' : 'ORDINAL_2_TIMED_OUT';
    if (currentLedger?.state === nextState) {
      // Recording the same true outcome twice (e.g. a crash between commit and the in-memory catch
      // that would otherwise have observed it) is idempotent: unlike reservation, this documents a
      // fact that already happened exactly once, rather than granting new permission to invoke.
      return structuredClone(currentLedger);
    }
    if (!currentLedger || currentLedger.state !== expectedCurrentState) {
      throw new Error(`cycle-repository recordSignOnlyInvocationTimeout: ordinal ${ordinal} is not in the allocated state`);
    }
    const ledger = transitionSignOnlyInvocationLedger(currentLedger, nextState);
    await this.#append(cycleId, 'sign-only-invocation-timed-out', { ledger }, {
      operation: 'recordSignOnlyInvocationTimeout',
      assertState: currentState => {
        const latest = currentState.signOnlyInvocationLedgers.get(ledgerKey) ?? null;
        if (!latest || canonicalJson(latest) !== canonicalJson(currentLedger)) {
          throw new Error(`cycle-repository recordSignOnlyInvocationTimeout: ledger changed while recording ordinal ${ordinal} timeout`);
        }
      },
    });
    return structuredClone(ledger);
  }

  /** @returns {Promise<object|null>} */
  async readSignOnlyInvocationLedger(cycleId, stage, requestDigest) {
    assertStageName(stage);
    const state = await this.#replay(cycleId);
    const current = state.signOnlyInvocationLedgers.get(signOnlyInvocationLedgerKey(stage, requestDigest));
    return current ? structuredClone(current) : null;
  }

  /** Reads a recipient-paged payout snapshot that is deliberately outside the 64-item journal limit. */
  async readPagedPayoutState(cycleId, stage) {
    assertPagedPayoutStage(stage);
    return this.#store.readPagedPayoutState(cycleId, stage);
  }

  /** Persists recipient-keyed payout pages before their compact journal reference is recorded. */
  async persistPagedPayoutState(cycleId, stage, state) {
    assertPagedPayoutStage(stage);
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('cycle-repository paged payout state must be an object');
    }
    if (state.schema === 'hookemon.supplementary-return-attempt.v2') {
      if (state.cycleId !== cycleId || stage !== `supplementary-${digest({ schema: 'hookemon.supplementary-return-stage.v1', positionId: state.positionId }).slice(7, 55)}`) throw new Error('supplementary return must bind its exact position storage identity');
      const settlement = (await this.#replay(cycleId)).supplementarySettlements.get(state.positionId);
      if (!settlement || settlement.manifestId !== state.manifestId) throw new Error('supplementary return requires its original position manifest');
      const previous = await this.#store.readPagedPayoutState(cycleId, stage);
      if (previous?.rawSignedBytes && previous.rawSignedBytes !== state.rawSignedBytes) throw new Error('supplementary return signed source bytes are immutable');
      const identityFields = ['positionId', 'cycleId', 'manifestId', 'requestDigest', 'relayRequestId', 'inputAmount', 'destinationAmount', 'intent', 'solanaInstructionPlan', 'destinationUsd', 'destinationUsdEvidence'];
      if (previous) {
        if (previous.schema !== state.schema || identityFields.some(key => canonicalJson(previous[key] ?? null) !== canonicalJson(state[key] ?? null))) {
          throw new Error('supplementary return source, quote, and USD provenance are immutable');
        }
      } else {
        validateNativeReturnValuation(supplementaryValuationLeg(state));
        if (!isProcessQuoteUsdValuation(state.destinationUsd, { amount: state.destinationAmount, quoteRequestId: state.relayRequestId,
          sourcePath: 'details.currencyOut.amountUsd', rounding: 'down' })
          || this.#now() < state.destinationUsd.observedAtMs || this.#now() >= state.destinationUsd.validUntilMs) {
          throw new Error('supplementary return preparation requires its original fresh USD producer capability');
        }
      }
    }
    await this.#store.persistPagedPayoutState(cycleId, stage, structuredClone(state));
    return structuredClone(state);
  }

  /**
   * Persists recipient pages, then records only a compact page reference in the bounded journal
   * together with any dust consumption. The page manifest is immutable for a plan digest, so a
   * restart can recover the full state without replaying a 1,025-item journal payload.
   */
  async consumePayoutDustAndPersistPagedPayoutState(cycleId, {
    source,
    amount,
    planDigest,
    stage,
    evidence,
  }) {
    assertStageName(stage);
    if (stage !== 'payout') throw new Error('cycle-repository paged payout initialization requires the payout stage');
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence) || evidence.planDigest !== planDigest) {
      throw new Error('cycle-repository paged payout initialization evidence does not match the plan digest');
    }
    await this.persistPagedPayoutState(cycleId, stage, evidence);
    const reference = {
      schema: 'hookemon.paged-payout-state-reference.v1',
      stage,
      planDigest,
    };
    const persisted = await this.consumePayoutDustAndRecordStageAttempt(cycleId, {
      source,
      amount,
      planDigest,
      stage,
      evidence: reference,
    });
    return { evidence: structuredClone(evidence), consumption: persisted.consumption };
  }

  async markStageAttemptSentUnknown(cycleId, stage) {
    assertStageName(stage);
    const state = await this.#replay(cycleId);
    const current = state.operationalAttempts.get(stage);
    if (!current) throw new Error(`cycle-repository markStageAttemptSentUnknown: no prepared attempt for "${stage}"`);
    if (current.attempt.state === 'SENT_UNKNOWN') return structuredClone(current);
    if (current.attempt.state !== 'PREPARED') {
      throw new Error(`cycle-repository markStageAttemptSentUnknown: "${stage}" must be reconciled instead of re-sent`);
    }
    const attempt = transitionProviderMutationAttempt(current.attempt, 'SENT_UNKNOWN');
    const sentAtMs = currentRepositoryTime(this.#now);
    await this.#append(cycleId, 'stage-attempt-sent-unknown', { stage, attempt, sentAtMs }, {
      assertState: currentState => {
        const latest = currentState.operationalAttempts.get(stage);
        if (!latest || canonicalJson(latest.attempt) !== canonicalJson(current.attempt)) {
          throw new Error(`cycle-repository markStageAttemptSentUnknown: "${stage}" changed while recording observation`);
        }
      },
    });
    return { ...current, attempt, sentAtMs };
  }

  async anchorOperationalStageDeadline(cycleId, stage, { nowMs } = {}) {
    assertStageName(stage);
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new Error('cycle-repository anchorOperationalStageDeadline nowMs is invalid');
    }
    const state = await this.#replay(cycleId);
    const current = state.operationalAttempts.get(stage);
    if (!current) {
      throw new Error(`cycle-repository anchorOperationalStageDeadline: no attempt for "${stage}"`);
    }
    if (current.sentAtMs !== null || current.respondedAtMs !== null || current.deadlineAnchorMs !== null) {
      return structuredClone(current);
    }
    if (!['SENT_UNKNOWN', 'RESPONSE_RECORDED'].includes(current.attempt.state)) {
      throw new Error(`cycle-repository anchorOperationalStageDeadline: "${stage}" must be sent or response-recorded`);
    }
    await this.#append(cycleId, 'stage-attempt-deadline-anchored', {
      stage,
      attempt: current.attempt,
      requestDigest: current.attempt.requestDigest,
      anchoredAtMs: nowMs,
    }, {
      operation: 'anchorOperationalStageDeadline',
      assertState: currentState => {
        const latest = currentState.operationalAttempts.get(stage);
        if (!latest
          || canonicalJson(latest.attempt) !== canonicalJson(current.attempt)
          || latest.sentAtMs !== null
          || latest.respondedAtMs !== null
          || latest.deadlineAnchorMs !== null) {
          throw new Error(`cycle-repository anchorOperationalStageDeadline: "${stage}" changed while anchoring`);
        }
      },
    });
    return { ...current, deadlineAnchorMs: nowMs };
  }

  /** Records a pre-call failure; the identical request may be prepared again without reconciliation. */
  async markStageAttemptNotSent(cycleId, stage) {
    assertStageName(stage);
    const state = await this.#replay(cycleId);
    const current = state.operationalAttempts.get(stage);
    if (!current) throw new Error(`cycle-repository markStageAttemptNotSent: no prepared attempt for "${stage}"`);
    if (current.attempt.state === 'NOT_SENT') return structuredClone(current);
    if (current.attempt.state !== 'PREPARED') {
      throw new Error(`cycle-repository markStageAttemptNotSent: "${stage}" must be reconciled instead of retried`);
    }
    const attempt = transitionProviderMutationAttempt(current.attempt, 'NOT_SENT');
    await this.#append(cycleId, 'stage-attempt-not-sent', { stage, attempt }, {
      assertState: currentState => {
        const latest = currentState.operationalAttempts.get(stage);
        if (!latest || canonicalJson(latest.attempt) !== canonicalJson(current.attempt)) {
          throw new Error(`cycle-repository markStageAttemptNotSent: "${stage}" changed while recording observation`);
        }
      },
    });
    return { ...current, attempt };
  }

  async recordStageAttemptResponse(cycleId, stage, evidence) {
    assertStageName(stage);
    const responseEvidence = cloneEvidence(evidence, 'provider response evidence');
    const state = await this.#replay(cycleId);
    const current = state.operationalAttempts.get(stage);
    if (!current) throw new Error(`cycle-repository recordStageAttemptResponse: no prepared attempt for "${stage}"`);
    if (['RESPONSE_RECORDED', 'RECONCILED'].includes(current.attempt.state)) {
      if (canonicalJson(current.responseEvidence) !== canonicalJson(responseEvidence)) {
        throw new Error(`cycle-repository recordStageAttemptResponse: "${stage}" already has different response evidence`);
      }
      return structuredClone(current);
    }
    const responseDigest = evidenceDigest('hookemon.provider-mutation-response.v1', cycleId, stage, responseEvidence);
    const attempt = transitionProviderMutationAttempt(current.attempt, 'RESPONSE_RECORDED', { responseDigest });
    const respondedAtMs = currentRepositoryTime(this.#now);
    await this.#append(cycleId, 'stage-attempt-response-recorded', {
      stage, attempt, evidence: responseEvidence, respondedAtMs,
    }, {
      assertState: currentState => {
        const latest = currentState.operationalAttempts.get(stage);
        if (!latest || canonicalJson(latest.attempt) !== canonicalJson(current.attempt)) {
          throw new Error(`cycle-repository recordStageAttemptResponse: "${stage}" changed while recording observation`);
        }
      },
    });
    return { ...current, attempt, responseEvidence, respondedAtMs };
  }

  async reconcileStageAttempt(cycleId, stage, evidence) {
    assertStageName(stage);
    const reconciliationEvidence = cloneEvidence(evidence, 'provider reconciliation evidence');
    const state = await this.#replay(cycleId);
    const current = state.operationalAttempts.get(stage);
    if (!current) throw new Error(`cycle-repository reconcileStageAttempt: no prepared attempt for "${stage}"`);
    if (current.attempt.state === 'RECONCILED') {
      if (canonicalJson(current.reconciliationEvidence) !== canonicalJson(reconciliationEvidence)) {
        throw new Error(`cycle-repository reconcileStageAttempt: "${stage}" already has different reconciliation evidence`);
      }
      return structuredClone(current);
    }
    if (!['SENT_UNKNOWN', 'RESPONSE_RECORDED'].includes(current.attempt.state)) {
      throw new Error(`cycle-repository reconcileStageAttempt: "${stage}" must be sent or response-recorded first`);
    }
    const reconciliationDigest = evidenceDigest('hookemon.provider-mutation-reconciliation.v1', cycleId, stage, reconciliationEvidence);
    const attempt = transitionProviderMutationAttempt(current.attempt, 'RECONCILED', { reconciliationDigest });
    await this.#append(cycleId, 'stage-attempt-reconciled', { stage, attempt, evidence: reconciliationEvidence }, {
      assertState: currentState => {
        const latest = currentState.operationalAttempts.get(stage);
        if (!latest || canonicalJson(latest.attempt) !== canonicalJson(current.attempt)) {
          throw new Error(`cycle-repository reconcileStageAttempt: "${stage}" changed while recording observation`);
        }
      },
    });
    return { ...current, attempt, reconciliationEvidence };
  }

  /** Accounts for finalized gas only; completed-cycle principal buckets remain immutable. */
  async recordSupplementaryPayoutGas(cycleId, { planDigest, proof }) {
    const state = await this.#replay(cycleId);
    if (state.archived || !isNativeAdmission(state.admission) || !digestPattern.test(planDigest)) {
      throw new Error('supplementary payout gas requires an unarchived native cycle');
    }
    const key = custodyLedgerKey({ chainId: '4663', assetId: 'native' });
    const previous = state.custodyLedgers.get(key);
    // This private producer check also authenticates gas-only proofs from reverted transactions.
    const gas = applyNativeCustodyGasPayment(previous, proof);
    let matched = null;
    for (const settlement of state.supplementarySettlements.values()) {
      const stage = `supplementary-${settlement.positionId.slice(5, 53)}`;
      const stored = await this.#store.readPagedPayoutState(cycleId, stage);
      const payout = stored?.payoutState;
      if (stored?.schema !== 'hookemon.supplementary-payout-state.v2' || stored.cycleId !== cycleId
        || stored.positionId !== settlement.positionId || stored.manifestId !== settlement.manifestId
        || stored.positionEvidenceDigest !== settlement.positionEvidenceDigest
        || stored.eligibilitySnapshotEvidenceDigest !== settlement.eligibilitySnapshotEvidenceDigest
        || stored.payoutSourceDigest !== settlement.payoutSourceDigest
        || payout?.planDigest !== planDigest || payout.plan?.cycleId !== cycleId
        || payout.operations !== (proof.source ?? proof.sender) || payout.assetId !== 'native') continue;
      for (const recipient of stored.recipients ?? []) {
        for (const candidate of [recipient, ...(recipient.replacementHistory ?? [])]) {
          if (candidate.txHash !== proof.transactionHash || typeof candidate.rawSignedBytes !== 'string'
            || digest(candidate.rawSignedBytes) !== proof.transactionDigest) continue;
          if (proof.schema === 'hookemon.native-payment-proof.v1' && (proof.kind !== 'direct'
            || proof.recipient !== recipient.recipient || proof.amountWei !== recipient.amount?.amountAtomic
            || proof.nonce !== candidate.nonce || proof.receiptStatus !== 'success')) continue;
          if (matched) throw new Error('supplementary payout gas has an ambiguous signed payment');
          matched = settlement;
        }
      }
    }
    if (!matched) throw new Error('supplementary payout gas requires its persisted signed recipient payment');
    const reservationKey = `native-supplementary-gas:${proof.transactionHash}`;
    const owner = supplementaryGasReservation(cycleId, matched.positionId, matched.manifestId, planDigest, proof);
    const existing = await this.#store.readGlobalKey(reservationKey);
    if (existing && canonicalJson(existing) !== canonicalJson(owner)) throw new Error('supplementary gas transaction belongs to another payout');
    if (previous.gasPayments.some(item => item.transactionHash === proof.transactionHash)) {
      if (!existing) throw new Error('supplementary gas transaction is already attributed outside this payout');
      return previous;
    }
    const next = supplementaryGasLedger(previous, proof);
    if (canonicalJson(next.gasSpent) !== canonicalJson(gas.gasSpent)) throw new Error('supplementary gas projection differs');
    await this.#append(cycleId, 'supplementary-payout-gas-recorded', {
      positionId: matched.positionId, manifestId: matched.manifestId, planDigest, proof: structuredClone(proof),
    }, { globalKeyReservations: [{ key: reservationKey, value: owner }], assertState: current => {
      if (current.archived || canonicalJson(current.custodyLedgers.get(key)) !== canonicalJson(previous)
        || canonicalJson(current.supplementarySettlements.get(matched.positionId)) !== canonicalJson(matched)) {
        throw new Error('supplementary payout gas state changed before append');
      }
    } });
    return next;
  }

  async recordCustodyLedger(cycleId, ledgerValue) {
    const ledger = assertCustodyLedger(ledgerValue);
    if (ledger.cycleId !== cycleId) throw new Error('cycle-repository custody ledger cycleId does not match');
    const key = custodyLedgerKey(ledger);
    await this.#append(cycleId, 'custody-ledger-recorded', { ledger }, {
      assertState: state => {
        const previous = state.custodyLedgers.get(key) ?? null;
        assertCustodyLedgerTransition(previous, ledger, 'cycle-repository custody ledger');
        assertCustodyLedgerExpectedAssetUnchanged(previous, ledger, 'cycle-repository custody ledger');
      },
    });
  }

  /**
   * The only sanctioned way to record a return-direction RelayLegV1 from this revision forward
   * (ADR-0026): the unsigned RECORDED leg and its custody ledger row's newly populated singular
   * `expectedCycleAsset` are one atomic journal entry (`return-relay-leg-expectation-recorded`),
   * the same single-event shape `recordHeldPosition` already uses for a position plus its ledger.
   * `ledgerValue` is the caller-already-resolved canonical CAIP row (ADR-0026: this repository has
   * no money configuration or resolver and never treats the leg's raw destination chain/address as
   * if it equalled the canonical identity); only the values a canonical/raw pair must genuinely
   * share -- decimals and the atomic amount -- are bound against the leg here. The durable
   * association between this Relay request and the resolved ledger key is recorded in
   * `returnLegLedgerKeys` so settlement and held-clearing can find the same row again without ever
   * recomputing it from the leg's raw identity. A second unresolved (RECORDED) return-direction leg
   * for the same resolved destination chain/asset is refused before append, leaving the first leg's
   * row-level expectation exactly as it was.
   */
  async recordReturnRelayLegExpectation(cycleId, legValue, ledgerValue, { destinationUsd = null } = {}) {
    const leg = assertRelayLeg(legValue, 'return Relay leg expectation');
    if (leg.cycleId !== cycleId || leg.direction !== 'return' || leg.state !== 'RECORDED' || leg.sourceTxHash !== null) {
      throw new Error('cycle-repository recordReturnRelayLegExpectation requires an unsigned recorded return Relay leg for this cycle');
    }
    const ledger = assertCustodyLedger(ledgerValue, 'return relay leg expectation custody ledger');
    if (ledger.cycleId !== cycleId) {
      throw new Error('cycle-repository recordReturnRelayLegExpectation: custody ledger cycleId does not match');
    }
    if (!['hookemon.custody-ledger.v2', 'hookemon.custody-ledger.v3'].includes(ledger.schema) || ledger.expectedCycleAsset === null) {
      throw new Error('cycle-repository recordReturnRelayLegExpectation requires a v2 custody ledger with a populated expectedCycleAsset');
    }
    if (ledger.decimals !== leg.destinationDecimals) {
      throw new Error('cycle-repository recordReturnRelayLegExpectation: custody ledger decimals do not match the Relay leg destination');
    }
    if (ledger.expectedCycleAsset.amountAtomic !== leg.destinationAmountAtomic) {
      throw new Error('cycle-repository recordReturnRelayLegExpectation: expectedCycleAsset amount does not match the Relay leg');
    }

    const state = await this.#replay(cycleId);
    if (state.terminalState) {
      throw new Error(`cycle-repository recordReturnRelayLegExpectation: cycle is terminal as ${state.terminalState}`);
    }

    const legKey = relayLegKey(leg.relayRequestId);
    const currentLeg = state.relayLegs.get(legKey);
    const ledgerKey = custodyLedgerKey(ledger);
    if (currentLeg) {
      if (canonicalJson(currentLeg) !== canonicalJson(leg)) {
        throw new Error('cycle-repository recordReturnRelayLegExpectation: Relay request id already has different evidence');
      }
      const existingLedgerKey = state.returnLegLedgerKeys.get(leg.relayRequestId) ?? null;
      if (existingLedgerKey !== ledgerKey || canonicalJson(state.custodyLedgers.get(existingLedgerKey) ?? null) !== canonicalJson(ledger)) {
        throw new Error('cycle-repository recordReturnRelayLegExpectation: Relay request id already has a different custody ledger association');
      }
      return structuredClone(currentLeg);
    }
    if (leg.schema === 'hookemon.relay-leg.v2') {
      validateNativeReturnValuation(leg);
      if (!isProcessQuoteUsdValuation(destinationUsd, { amount: leg.returnAttribution.destinationUsd.amount, quoteDigest: leg.returnAttribution.destinationUsd.quoteDigest,
        quoteRequestId: leg.relayRequestId, sourcePath: 'details.currencyOut.amountUsd', rounding: 'down' })
        || digest(destinationUsd) !== digest(leg.returnAttribution.destinationUsd)
        || this.#now() < destinationUsd.observedAtMs || this.#now() >= destinationUsd.validUntilMs) throw new Error('native return expectation requires fresh producer USD proceeds capability');
    }
    if (unresolvedReturnLegConflict(state, leg)) {
      throw new Error('cycle-repository recordReturnRelayLegExpectation: an unresolved return leg for this destination already exists');
    }

    const previousLedger = state.custodyLedgers.get(ledgerKey) ?? null;
    assertCustodyLedgerTransition(previousLedger, ledger, 'cycle-repository recordReturnRelayLegExpectation custody ledger');
    if (previousLedger !== null) {
      if (previousLedger.expectedCycleAsset !== null) {
        throw new Error('cycle-repository recordReturnRelayLegExpectation: custody ledger already carries an unresolved expectedCycleAsset');
      }
      const previousBaseline = { ...previousLedger, expectedCycleAsset: null };
      const nextBaseline = { ...ledger, expectedCycleAsset: null };
      if (canonicalJson(previousBaseline) !== canonicalJson(nextBaseline)) {
        throw new Error('cycle-repository recordReturnRelayLegExpectation: custody ledger buckets must be unchanged when recording a return leg expectation');
      }
    }

    await this.#append(cycleId, 'return-relay-leg-expectation-recorded', { leg, ledger }, {
      operation: 'recordReturnRelayLegExpectation',
      assertState: currentState => {
        if (currentState.relayLegs.has(legKey)) {
          throw new Error('cycle-repository recordReturnRelayLegExpectation: Relay leg changed while recording');
        }
        if (unresolvedReturnLegConflict(currentState, leg)) {
          throw new Error('cycle-repository recordReturnRelayLegExpectation: an unresolved return leg for this destination already exists');
        }
        const latestLedger = currentState.custodyLedgers.get(ledgerKey) ?? null;
        if (canonicalJson(latestLedger) !== canonicalJson(previousLedger)) {
          throw new Error('cycle-repository recordReturnRelayLegExpectation: custody ledger changed while recording expectation');
        }
      },
    });
    return structuredClone(leg);
  }

  // Legacy attempt records remain readable for archived journals. New live paths use the typed
  // provider-attempt state machine above; they do not call these compatibility methods.

  /** @param {string} cycleId @param {string} stage @param {unknown} evidence */
  async recordStageAttempt(cycleId, stage, evidence) {
    assertStageName(stage);
    await this.#append(cycleId, 'stage-attempted', { stage, evidence });
  }

  /** @returns {Promise<unknown|null>} the most recently recorded `recordStageAttempt` evidence for
   * `stage` — `null` if this stage has no durably-recorded attempt yet, OR if the most recent
   * attempt has since been marked failed via `recordStageAttemptFailure` (WP-36: a
   * definitively-failed attempt is never "resumed" — see that method's own doc comment — so a
   * caller reading `null` here builds a genuinely fresh attempt via `nextStageAttemptIndex`,
   * exactly the same signal as "no attempt yet"). */
  async readStageAttempt(cycleId, stage) {
    assertStageName(stage);
    const state = await this.#replay(cycleId);
    const operational = state.operationalAttempts.get(stage);
    if (operational && !operational.failed) return operational.responseEvidence === null ? null : structuredClone(operational.responseEvidence);
    const record = state.attempts.get(stage);
    if (!record || record.failed) return null;
    return record.evidence;
  }

  /**
   * WP-36: the attempt index a NEW attempt for `stage` should use when building a fresh
   * authorization nonce (`action-builder.mjs`'s `deriveAuthorizationNonce`) — one more than
   * however many attempts (successful, or since marked failed) have ever been durably recorded
   * for this stage on this cycle. Never decreases, never reused: `readStageAttempt`'s own
   * `attemptIndex` bookkeeping only ever counts forward, so a nonce derived from this value can
   * never repeat a nonce already consumed on-chain by an earlier attempt for the same
   * cycle/stage. Callers read this only in the "build a fresh attempt" branch — i.e. exactly
   * when `readStageAttempt` returned `null` — never to recompute the nonce of an
   * already-recorded, still-resumable attempt (which reuses its own recorded nonce verbatim).
   * @returns {Promise<number>}
   */
  async nextStageAttemptIndex(cycleId, stage) {
    assertStageName(stage);
    const state = await this.#replay(cycleId);
    return state.attemptCounts.get(stage) ?? 0;
  }

  /**
   * WP-36: marks the current durably-recorded attempt for `stage` as failed — a durable fact
   * that `readStageAttempt` will never again report as resumable, and that
   * `nextStageAttemptIndex` already accounts for (the failed attempt's own index was already
   * consumed by `recordStageAttempt`, so the next fresh attempt gets the index after it).
   *
   * Why this exists: `PegCycleVault`'s on-chain replay protection consumes a nonce the moment
   * `authorizeFunding`/`authorizePayout` succeeds — including a call whose route/action data
   * later turns out to be unusable and whose cycle is recovered via
   * `cancelExpiredFundingAuthorization`/`authorizeFundingAfterFailure` (contract-level operator
   * recovery paths outside this package's write set). Once that recovery has happened on-chain,
   * a fresh, real authorization for the same cycle is legitimate — but re-signing the *same*
   * durably-recorded attempt (which `readStageAttempt` would otherwise keep returning forever,
   * matching a genuinely-still-pending broadcast) would carry the already-consumed nonce and
   * revert again. Calling this method durably records that the recorded attempt is done — never
   * to be resumed — so the next `mutate*` call reads `readStageAttempt() === null` and builds a
   * genuinely fresh one via `nextStageAttemptIndex`, exactly the "retry after a recorded
   * failure" case. This module records the failure fact only; it never itself decides whether an
   * on-chain revert justifies a retry — that decision belongs to `stages/errors.mjs`'s
   * `StageMutationRevertedError` callers (see funding.mjs/payout.mjs's `reconcileLive*`).
   * @param {string} cycleId @param {string} stage @param {unknown} [evidence] optional context
   *   (e.g. the failed transaction hash/reason) recorded alongside the failure fact.
   */
  async recordStageAttemptFailure(cycleId, stage, evidence = {}) {
    assertStageName(stage);
    await this.#append(cycleId, 'stage-attempt-failed', { stage, evidence });
  }
}
