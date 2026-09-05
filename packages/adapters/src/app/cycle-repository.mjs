// The durable authority for one operational cycle. `compose.mjs` injects this same instance into
// the scheduler, CLI service, and in-process dashboard so they observe one append-only journal
// rather than a placeholder runner or a second store. The exported client facade gives future
// standalone consumers only read access. It tracks fixed stage progress, provider write-ahead
// attempts, terminal holds, and custody ledgers; `CycleRunner` remains a separate domain engine.
import { lstat, open } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

import { DurableCycleStore, StateDirectoryLossError } from '../../../runner/src/cycle/durable-store.mjs';
import { canonicalJson, CycleJournal, digest } from '../../../runner/src/cycle/journal.mjs';
import { isProcessRpcFinalizedErc20TransferProof } from '../robinhood-rpc.mjs';
import { isProcessRpcRelayDestinationObservation } from '../solana-rpc.mjs';
import { isProcessRpcOutboundRefundProof } from './stages/outbound.mjs';
import { isProcessRpcReturnLegDestinationProof } from './stages/return.mjs';
import {
  assertRelayLeg,
  assertStandingAuthorityDecision,
  assertWalletNonceReservation,
  attributeRelayLegSource,
  assertChainTransactionAttempt,
  assertCustodyLedger,
  assertCycleTerminalState,
  assertProviderMutationAttempt,
  assertRelayFinality,
  assertTypedAmount,
  assertReturnLegDestinationProof,
  OPERATIONAL_CYCLE_STAGES,
  RELAY_LEG_TERMINAL_STATES,
  transitionChainTransactionAttempt,
  transitionRelayLeg,
  transitionProviderMutationAttempt,
} from '../../../runner/src/cycle/money-schemas.mjs';

// The scheduler dispatches only OPERATIONAL_CYCLE_STAGES. These retired names remain readable for
// historical accounting journals while their projection moves in a dedicated accounting migration.
// New operational writes never accept either name.
const LEGACY_ACCOUNTING_STAGES = Object.freeze(['funding', 'distribution']);
const OPERATIONAL_STAGE_SET = new Set(OPERATIONAL_CYCLE_STAGES);
const LEGACY_ACCOUNTING_STAGE_SET = new Set(LEGACY_ACCOUNTING_STAGES);
const POST_TERMINAL_RECORD_KINDS = new Set([
  'stage-attempted',
  'stage-attempt-failed',
  'stage-attempt-sent-unknown',
  'stage-attempt-not-sent',
  'stage-attempt-reprepared',
  'stage-attempt-response-recorded',
  'stage-attempt-reconciled',
  'chain-attempt-broadcast',
  'chain-attempt-finalized',
  'relay-leg-settled',
  'custody-ledger-recorded',
  'held-owner-decision-recorded',
]);
const decimalPattern = /^(0|[1-9][0-9]*)$/;
const signedDecimalPattern = /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const requestIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HELD_OWNER_DECISION = 'HELD_OWNER_DECISION';
const HELD_OWNER_DECISION_CHOICES = new Set(['sell', 'keep-holding']);
const evmAddressPattern = /^0x[0-9a-fA-F]{40}$/;
const evmTransactionHashPattern = /^0x[0-9a-fA-F]{64}$/;
const fencingTokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const quarantineReasonPattern = /^[A-Z][A-Z0-9_]{2,63}$/;
const payoutDustRecordSchema = 'hookemon.payout-dust-record.v1';
const payoutDustConsumptionSchema = 'hookemon.payout-dust-consumption.v1';
const payoutQuarantineSchema = 'hookemon.payout-quarantine-reservation.v1';
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
  'listKnownCycleIds',
]);

export const CYCLE_REPOSITORY_INTERFACE = Object.freeze([
  ...CYCLE_REPOSITORY_CLIENT_INTERFACE,
  'createCycle',
  'prepareStage',
  'completeStage',
  'completeCycle',
  'holdCycle',
  'prepareStageAttempt',
  'markStageAttemptSentUnknown',
  'markStageAttemptNotSent',
  'recordStageAttemptResponse',
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
  'reserveWalletNonce',
  'assertWalletNonce',
  'releaseWalletNonce',
  'persistChainAttemptRecoveryContext',
  'readChainAttemptRecoveryContext',
  'readPagedPayoutState',
  'persistPagedPayoutState',
  'consumePayoutDustAndPersistPagedPayoutState',
  'recordCustodyLedger',
  'readPayoutDust',
  'readPayoutDustConsumption',
  'recordPayoutDust',
  'consumePayoutDust',
  'consumePayoutDustAndRecordStageAttempt',
  'readPayoutQuarantine',
  'reservePayoutQuarantine',
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
        custodyLedgers: new Map(),
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
      return Object.freeze({ heldAssets: true, unattributed: true, unresolvedObligations: true });
    },
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

function custodyLedgerKey(ledger) {
  return `${ledger.chainId}\u0000${ledger.assetId}`;
}

function chainAttemptKey(stage, requestDigest) {
  return `${stage}\u0000${requestDigest}`;
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
  if (!isProcessRpcFinalizedErc20TransferProof(sourceProof, {
    hash: leg.sourceTxHash,
    token: leg.sourceAssetId,
    source: route.sourceSender,
    recipient: route.sourceRecipient,
    amountAtomic: leg.sourceAmountAtomic,
  })) {
    throw new Error('relay settlement requires an own process RPC source proof');
  }
  if (sourceProof.finalized !== true || sourceProof.successful !== true || sourceProof.proofAvailable !== true
    || sourceProof.amountAtomic !== leg.sourceAmountAtomic
    || sourceProof.sourceBalanceDeltaAtomic !== leg.sourceAmountAtomic
    || sourceProof.recipientBalanceDeltaAtomic !== leg.sourceAmountAtomic) {
    throw new Error('relay settlement source proof does not prove the exact finalized source delta');
  }
  if (typeof sourceProof.receiptBlockHash !== 'string' || sourceProof.receiptBlockHash.length === 0) {
    throw new Error('relay settlement source proof has no finalized block hash');
  }
  return Object.freeze({
    height: canonicalFinalityInteger(sourceProof.receiptBlockNumber, 'relay settlement source proof block number'),
    hash: sourceProof.receiptBlockHash,
    timestampUnixSeconds: canonicalFinalityInteger(
      sourceProof.receiptBlockTimestampUnixSeconds,
      'relay settlement source proof timestamp',
    ),
  });
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
  if (intent.requestId !== leg.relayRequestId
    || String(intent.originChainId) !== leg.sourceChainId
    || intent.originAssetId !== assertEvmAddress(leg.sourceAssetId, 'relay settlement source asset')
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
    observedSource: route.sourceRecipient,
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
    'observedRecipient',
    'observedAmountAtomic',
  ], 'relay refund proof');
  assertPlainExactObject(refundProof.terminalStatus, ['status', 'refundTxHash'], 'relay refund terminal status');
  if (refundProof.schema !== 'hookemon.outbound-relay-origin-refund-proof.v1'
    || refundProof.relayRequestId !== leg.relayRequestId
    || refundProof.terminalStatus.status !== 'REFUND'
    || !sameRelayTransactionHash(leg.sourceChainId, refundProof.sourceTxHash, leg.sourceChainId, leg.sourceTxHash)
    || !sameRelayTransactionHash(leg.sourceChainId, refundProof.refundTxHash, leg.sourceChainId, refundProof.terminalStatus.refundTxHash)
    || refundProof.transferCount !== 1
    || refundProof.observedToken !== assertEvmAddress(leg.sourceAssetId, 'relay refund source asset')
    || refundProof.observedSource !== route.sourceRecipient
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

function returnSettlementCustodyLedger(state, leg) {
  const key = `${leg.destinationChainId}\u0000${leg.destinationAssetId}`;
  const previous = state.custodyLedgers.get(key) ?? null;
  const received = BigInt(leg.netDeltaAtomic);
  if (received <= 0n) throw new Error('relay settlement exact return custody must be positive');
  if (previous) {
    return {
      ...previous,
      returnReceived: (BigInt(previous.returnReceived) + received).toString(),
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
    payoutLiability: '0',
    dust: '0',
    unattributed: '0',
  };
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
  } else if (value.custodyLedger !== null) {
    throw new Error('return relay settlement hold cannot create payout custody');
  }
  return { leg: transitioned, settlement: structuredClone(value) };
}

function assertRelaySettlementInput(leg, value, state) {
  if (leg.direction === 'outbound') return assertOutboundRelaySettlementInput(leg, value);
  if (leg.direction === 'return') return assertReturnRelaySettlementInput(leg, value, state);
  throw new Error('relay settlement direction is invalid');
}

function observedReturnRelaySettlement(state, leg, value) {
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
    custodyLedger: terminalState === 'SETTLED' ? returnSettlementCustodyLedger(state, provisional) : null,
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
]);

function assertOutboundRelayIntent(value, label) {
  assertPlainExactObject(value, OUTBOUND_RELAY_INTENT_FIELDS, label);
  if (value.schema !== 'hookemon.relay-intent.v1' || value.direction !== 'OUTBOUND') {
    throw new Error(`${label} identity is invalid`);
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
  return Object.freeze({
    ...structuredClone(value),
    originAssetId: isEvmRelayChain(value.originChainId) ? assertEvmAddress(value.originAssetId, `${label} originAssetId`) : value.originAssetId,
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

function assertChainAttemptRecoveryContextInput(cycleId, value) {
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
  return assertChainAttemptRecoveryContextInput(cycleId, input);
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

function assertPayoutQuarantineReservation(value, label = 'payout quarantine reservation') {
  assertPlainExactObject(value, [
    'schema', 'cycleId', 'planDigest', 'recipient', 'amount', 'reason', 'evidence', 'ledger',
  ], label);
  if (value.schema !== payoutQuarantineSchema) throw new Error(`${label} schema is invalid`);
  if (typeof value.cycleId !== 'string' || value.cycleId.length === 0) throw new Error(`${label} cycleId is invalid`);
  assertDigest(value.planDigest, `${label} planDigest`);
  const recipient = assertEvmAddress(value.recipient, `${label} recipient`);
  if (recipient !== value.recipient) throw new Error(`${label} recipient must be lower-case`);
  const amount = assertPayoutAmount(value.amount, `${label} amount`, { positive: true });
  const reason = assertQuarantineReason(value.reason, `${label} reason`);
  const evidence = cloneChainObservationEvidence(value.evidence, `${label} evidence`);
  const ledger = assertCustodyLedger(value.ledger, `${label} custody ledger`);
  if (ledger.cycleId !== value.cycleId || ledger.chainId !== amount.chainId
    || ledger.assetId !== amount.assetId || ledger.decimals !== amount.decimals) {
    throw new Error(`${label} custody ledger does not match the quarantined amount`);
  }
  return {
    schema: payoutQuarantineSchema,
    cycleId: value.cycleId,
    planDigest: value.planDigest,
    recipient,
    amount,
    reason,
    evidence,
    ledger,
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

export class CycleRepository {
  #store;
  #now;

  constructor(guard, store, now) {
    if (guard !== CycleRepository) throw new Error('CycleRepository must be constructed with CycleRepository.open(directory)');
    this.#store = store;
    this.#now = now;
  }

  /** @param {string} directory absolute path @param {() => number} [now] */
  static async open(directory, now = () => Date.now()) {
    const persistedRecovery = await readStateDirectoryRecoveryHold(directory);
    if (persistedRecovery !== null) return createStateDirectoryRecoveryRepository(persistedRecovery);
    try {
      const store = await DurableCycleStore.open(directory);
      return new CycleRepository(CycleRepository, store, now);
    } catch (error) {
      if (!(error instanceof StateDirectoryLossError)) throw error;
      return createStateDirectoryRecoveryRepository(await persistStateDirectoryRecoveryHold(error.recovery, now));
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

  #replayStored(cycleId, stored, archived) {
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
    const relayLegs = new Map();
    const standingAuthorityDecisions = new Map();
    const walletNonceReservations = new Map();
    const chainAttemptRecoveryContexts = new Map();
    const custodyLedgers = new Map();
    const payoutDustRecords = new Map();
    const payoutDustConsumptions = new Map();
    const payoutQuarantines = new Map();
    const evmNonceLocks = new Map();
    const replayState = {
      stages,
      preparedStages,
      operationalAttempts,
      chainAttempts,
      relayLegs,
      standingAuthorityDecisions,
      walletNonceReservations,
      chainAttemptRecoveryContexts,
      custodyLedgers,
      payoutDustRecords,
      payoutDustConsumptions,
      payoutQuarantines,
      evmNonceLocks,
    };
    let completed = false;
    let terminalState = null;
    let heldEvidenceDigest = null;
    let ownerDecision = null;
    let terminalEvidence = null;
    let releaseAmount = null;
    let mode = null;
    let providerMode = null;
    let dryRun = false;
    let rehearsalSessionId = null;
    for (const entry of stored.entries) {
      if (terminalState !== null && (completed || !POST_TERMINAL_RECORD_KINDS.has(entry.kind))) {
        if (entry.kind === 'cycle-terminal' || entry.kind === 'cycle-completed') {
          throw new Error('stored cycle has a second terminal event');
        }
        throw new Error('stored cycle has a non-observational event after terminal state');
      }
      if (entry.kind === 'cycle-opened') {
        if (releaseAmount !== null) throw new Error('stored cycle has a second cycle-opened event');
        assertReleaseAmount(entry.payload.releaseAmount);
        releaseAmount = entry.payload.releaseAmount;
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
          failed: false,
        });
      } else if (entry.kind === 'stage-attempt-sent-unknown') {
        const previous = operationalAttempts.get(entry.payload.stage);
        const attempt = assertProviderMutationAttempt(entry.payload.attempt, 'stored provider mutation attempt');
        if (!previous || previous.attempt.state !== 'PREPARED' || attempt.state !== 'SENT_UNKNOWN'
          || attempt.cycleId !== cycleId || attempt.stage !== entry.payload.stage
          || attempt.requestDigest !== previous.attempt.requestDigest) {
          throw new Error('stored provider mutation sent-unknown transition is invalid');
        }
        operationalAttempts.set(attempt.stage, { ...previous, attempt });
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
          failed: false,
        });
      } else if (entry.kind === 'stage-attempt-response-recorded') {
        const previous = operationalAttempts.get(entry.payload.stage);
        const attempt = assertProviderMutationAttempt(entry.payload.attempt, 'stored provider mutation attempt');
        if (!previous || !['PREPARED', 'SENT_UNKNOWN'].includes(previous.attempt.state)
          || attempt.state !== 'RESPONSE_RECORDED' || attempt.cycleId !== cycleId
          || attempt.stage !== entry.payload.stage || attempt.requestDigest !== previous.attempt.requestDigest) {
          throw new Error('stored provider mutation response transition is invalid');
        }
        operationalAttempts.set(attempt.stage, {
          ...previous,
          attempt,
          responseEvidence: cloneEvidence(entry.payload.evidence, 'stored provider response evidence'),
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
      } else if (entry.kind === 'relay-leg-recorded') {
        const leg = assertRelayLeg(entry.payload.leg, 'stored Relay leg');
        const key = relayLegKey(leg.relayRequestId);
        if (leg.cycleId !== cycleId || leg.state !== 'RECORDED' || leg.sourceTxHash !== null || relayLegs.has(key)) {
          throw new Error('stored Relay leg recording is invalid');
        }
        relayLegs.set(key, leg);
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
      } else if (entry.kind === 'standing-authority-decision-recorded') {
        const decision = assertStandingAuthorityDecision(entry.payload.decision, 'stored standing authority decision');
        const previous = standingAuthorityDecisions.get(decision.intentDigest);
        if (previous && canonicalJson(previous) !== canonicalJson(decision)) {
          throw new Error('stored standing authority decision conflicts with prior decision');
        }
        standingAuthorityDecisions.set(decision.intentDigest, decision);
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
      } else if (entry.kind === 'custody-ledger-recorded') {
        const ledger = assertCustodyLedger(entry.payload.ledger, 'stored custody ledger');
        if (ledger.cycleId !== cycleId) throw new Error('stored custody ledger cycleId is invalid');
        const key = custodyLedgerKey(ledger);
        const previous = custodyLedgers.get(key);
        if (previous && previous.decimals !== ledger.decimals) {
          throw new Error('stored custody ledger decimals are inconsistent for this cycle, chain, and asset');
        }
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
        exactObject(entry.payload, ['terminalState', 'evidence'], 'stored cycle terminal state');
        terminalState = assertCycleTerminalState(entry.payload.terminalState, 'stored cycle terminal state');
        terminalEvidence = cloneEvidence(entry.payload.evidence, 'stored cycle terminal evidence');
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
        assertCycleClosure(replayState);
        completed = true;
        terminalState = 'COMPLETED';
      }
    }
    return {
      cycleId,
      releaseAmount,
      mode,
      providerMode,
      dryRun,
      rehearsalSessionId,
      stages,
      preparedStages,
      attempts,
      attemptCounts,
      operationalAttempts,
      chainAttempts,
      relayLegs,
      standingAuthorityDecisions,
      walletNonceReservations,
      chainAttemptRecoveryContexts,
      custodyLedgers,
      payoutDustRecords,
      payoutDustConsumptions,
      payoutQuarantines,
      evmNonceLocks,
      completed,
      terminalState,
      heldEvidenceDigest,
      ownerDecision,
      terminalEvidence,
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
    const state = this.#replayStored(cycleId, stored, false);
    if (operation && state.terminalState) {
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

  /** @returns {Promise<{cycleId: string, releaseAmount: string, mode: 'production'|'rehearsal'|null, providerMode?: 'live'|'fake', terminalState?: string}|null>} */
  async readActiveCycle() {
    for (const cycleId of this.#store.activeCycleIds) {
      const state = await this.#replay(cycleId);
      if (state.completed) {
        // Crash recovery: the 'cycle-completed' event committed but the archive step never ran.
        // Finish it now (idempotent — archiveCycle() only fails if already archived, which cannot
        // be true here since activeCycleIds just listed this id) rather than surfacing a completed
        // cycle as still "active".
        await this.#store.archiveCycle(cycleId);
        continue;
      }
      const profile = {
        ...(state.providerMode === null ? {} : { providerMode: state.providerMode }),
        ...(state.dryRun ? { dryRun: true } : {}),
        ...(state.rehearsalSessionId === null ? {} : { rehearsalSessionId: state.rehearsalSessionId }),
      };
      return state.terminalState
        ? { cycleId, releaseAmount: state.releaseAmount, mode: state.mode, ...profile, terminalState: state.terminalState }
        : { cycleId, releaseAmount: state.releaseAmount, mode: state.mode, ...profile };
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
      return state.terminalState
        ? { cycleId, releaseAmount: state.releaseAmount, terminalState: state.terminalState }
        : { cycleId, releaseAmount: state.releaseAmount };
    }
    return null;
  }

  /** @param {{releaseAmount: string, mode: 'production'|'rehearsal', providerMode?: 'live'|'fake', dryRun?: boolean, rehearsalSessionId?: string}} input @returns {Promise<{cycleId: string, releaseAmount: string, mode: 'production'|'rehearsal', providerMode: 'live'|'fake'|null, dryRun: boolean, rehearsalSessionId: string|null}>} */
  async createCycle({ releaseAmount, mode, providerMode = null, dryRun = false, rehearsalSessionId = null }) {
    assertReleaseAmount(releaseAmount);
    assertCycleMode(mode);
    assertDryRun(dryRun, mode, providerMode);
    if (providerMode !== null) assertProviderMode(providerMode, mode, { dryRun });
    if (rehearsalSessionId !== null) assertRehearsalSessionId(rehearsalSessionId, mode, providerMode);
    const active = await this.readActiveCycle();
    if (active) throw new Error('cycle-repository createCycle: a cycle is already active');
    const cycleId = generateCycleId(this.#now());
    await this.#append(cycleId, 'cycle-opened', {
      releaseAmount,
      mode,
      ...(providerMode === null ? {} : { providerMode }),
      ...(dryRun ? { dryRun: true } : {}),
      ...(rehearsalSessionId === null ? {} : { rehearsalSessionId }),
      openedAtMs: this.#now(),
    });
    return { cycleId, releaseAmount, mode, providerMode, dryRun, rehearsalSessionId };
  }

  /** @returns {Promise<{status: 'COMPLETE', evidence: unknown}|{status: 'PENDING'}>} */
  async readStage(cycleId, stage) {
    assertStageName(stage, { allowLegacyRead: true });
    const state = await this.#replay(cycleId);
    return state.stages.get(stage) ?? { status: 'PENDING' };
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
      if (canonicalJson(current.evidence) !== canonicalJson(evidence)) {
        throw new Error(`cycle-repository completeStage: stage "${stage}" was already completed with different evidence`);
      }
      return; // idempotent retry
    }
    assertPreparedOrderedCompletion(state, stage);
    assertReconciledCompletion(state, stage, evidence);
    await this.#append(cycleId, 'stage-completed', { stage, evidence }, {
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
      await this.#append(cycleId, 'cycle-completed', {}, {
        operation: 'completeCycle',
        assertState: assertCycleClosure,
      });
    }
    try {
      await this.#store.archiveCycle(cycleId);
    } catch (error) {
      if (!/already archived/.test(error.message)) throw error;
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
    }, {
      assertState: currentState => {
        if (currentState.terminalState) throw new Error('cycle-repository holdCycle terminal state changed while recording hold');
      },
      assertLease,
    });
  }

  /**
   * Persist an owner choice for a HELD_OWNER_DECISION cycle without resuming any effect.
   * A follow-up control path must consume the durable record before it can sell or retain custody.
   */
  async recordHeldOwnerDecision(cycleId, input) {
    const decision = heldOwnerDecisionInput(cycleId, input);
    const state = await this.#replay(cycleId);
    const existing = assertHeldOwnerDecisionTransition(state, decision);
    if (existing !== null) return existing;

    try {
      await this.#append(cycleId, 'held-owner-decision-recorded', decision, {
        assertState: currentState => {
          if (assertHeldOwnerDecisionTransition(currentState, decision) !== null) {
            throw new Error('cycle-repository recordHeldOwnerDecision: held owner decision changed while recording');
          }
        },
      });
    } catch (error) {
      if (!/stale cycle journal (?:version|head)/.test(error?.message)) throw error;
      const latest = await this.#replay(cycleId);
      const persisted = assertHeldOwnerDecisionTransition(latest, decision);
      if (persisted !== null) return persisted;
      throw error;
    }
    return decision;
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
    const ledgerKey = custodyLedgerKey(amount);
    const previousLedger = state.custodyLedgers.get(ledgerKey);
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
    const cycleIds = cycleId === undefined ? this.#store.activeCycleIds : [cycleId];
    let heldAssets = false;
    let unattributed = false;
    let unresolvedObligations = false;
    for (const candidateCycleId of cycleIds) {
      const state = await this.#replay(candidateCycleId);
      for (const ledger of state.custodyLedgers.values()) {
        heldAssets ||= BigInt(ledger.heldAssets) > 0n;
        unattributed ||= BigInt(ledger.unattributed) > 0n;
        unresolvedObligations ||= BigInt(ledger.payoutLiability) > 0n
          || BigInt(ledger.refunds) > 0n
          || BigInt(ledger.residual) > 0n;
      }
    }
    return { heldAssets, unattributed, unresolvedObligations };
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
        return { attempt, responseEvidence: null, reconciliationEvidence: null, failed: false };
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
    return { attempt, responseEvidence: null, reconciliationEvidence: null, failed: false };
  }

  /** @returns {Promise<{attempt: object, responseEvidence: unknown, reconciliationEvidence: unknown, failed: boolean}|null>} */
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
    const events = [{ kind: 'relay-leg-settled', payload: { relayRequestId, leg, settlement } }];
    if (settlement.custodyLedger !== undefined && settlement.custodyLedger !== null) {
      events.push({ kind: 'custody-ledger-recorded', payload: { ledger: settlement.custodyLedger } });
    }
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

  async reserveWalletNonce(cycleId, reservationValue) {
    const reservation = assertWalletNonceReservationInput(cycleId, reservationValue);
    const now = currentRepositoryTime(this.#now);
    if (reservation.leaseAcquiredAtMs > now || walletNonceReservationExpired(reservation, now)) {
      throw new Error('cycle-repository reserveWalletNonce: reservation lease is not active');
    }
    const state = await this.#replay(cycleId);
    if (state.terminalState) throw new Error(`cycle-repository reserveWalletNonce: cycle is terminal as ${state.terminalState}`);
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

  /** Reads a recipient-paged payout snapshot that is deliberately outside the 64-item journal limit. */
  async readPagedPayoutState(cycleId, stage) {
    assertStageName(stage);
    if (stage !== 'payout') throw new Error('cycle-repository paged payout state is available only for the payout stage');
    return this.#store.readPagedPayoutState(cycleId, stage);
  }

  /** Persists recipient-keyed payout pages before their compact journal reference is recorded. */
  async persistPagedPayoutState(cycleId, stage, state) {
    assertStageName(stage);
    if (stage !== 'payout') throw new Error('cycle-repository paged payout state is available only for the payout stage');
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      throw new Error('cycle-repository paged payout state must be an object');
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
    await this.#append(cycleId, 'stage-attempt-sent-unknown', { stage, attempt }, {
      assertState: currentState => {
        const latest = currentState.operationalAttempts.get(stage);
        if (!latest || canonicalJson(latest.attempt) !== canonicalJson(current.attempt)) {
          throw new Error(`cycle-repository markStageAttemptSentUnknown: "${stage}" changed while recording observation`);
        }
      },
    });
    return { ...current, attempt };
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
    await this.#append(cycleId, 'stage-attempt-response-recorded', { stage, attempt, evidence: responseEvidence }, {
      assertState: currentState => {
        const latest = currentState.operationalAttempts.get(stage);
        if (!latest || canonicalJson(latest.attempt) !== canonicalJson(current.attempt)) {
          throw new Error(`cycle-repository recordStageAttemptResponse: "${stage}" changed while recording observation`);
        }
      },
    });
    return { ...current, attempt, responseEvidence };
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

  async recordCustodyLedger(cycleId, ledgerValue) {
    const ledger = assertCustodyLedger(ledgerValue);
    if (ledger.cycleId !== cycleId) throw new Error('cycle-repository custody ledger cycleId does not match');
    const key = custodyLedgerKey(ledger);
    await this.#append(cycleId, 'custody-ledger-recorded', { ledger }, {
      assertState: state => {
        const previous = state.custodyLedgers.get(key);
        if (previous && previous.decimals !== ledger.decimals) {
          throw new Error('cycle-repository custody ledger decimals are immutable for this cycle, chain, and asset');
        }
      },
    });
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
