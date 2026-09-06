import { digest } from '../../../runner/src/cycle/journal.mjs';
import { createPreparedProviderMutationAttempt } from '../../../runner/src/cycle/money-schemas.mjs';
import { isStandingAuthorityProvider } from '../../../runner/src/cycle/authorization-provider.mjs';
import { assertCollectorPolicyBundleRuntimeReady } from '../signing/collector-policy-loader.mjs';
import { walletNonceLeaseWindow } from './wallet-nonce-lease.mjs';
import {
  createTestProfileMutationAuthority,
  requireLiveMutationAuthority,
} from '../../../runner/src/cycle/preflight.mjs';
import { LiveModeIntegrationPendingError } from './stages/errors.mjs';
import {
  probeEligibilitySnapshot,
  mutateEligibilitySnapshot,
  reconcileLiveEligibilitySnapshot,
} from './stages/eligibility-snapshot.mjs';
import {
  prepareClaimProcessRequest,
  probeClaimProcess,
  mutateClaimProcess,
  reconcileLiveClaimProcess,
} from './stages/claim-process.mjs';
import {
  OutboundRecoveryRequiredError,
  prepareOutboundRequest,
  probeOutbound,
  mutateOutbound,
  reconcileLiveOutbound,
} from './stages/outbound.mjs';
import {
  preparePurchaseRequest,
  probePurchase,
  mutatePurchase,
  reconcileLivePurchase,
} from './stages/purchase.mjs';
import {
  prepareOpenRequest,
  probeOpen,
  mutateOpen,
  reconcileLiveOpen,
} from './stages/open.mjs';
import {
  prepareEpicGateRequest,
  probeEpicGate,
  mutateEpicGate,
  reconcileLiveEpicGate,
} from './stages/epic-gate.mjs';
import {
  prepareBuybackRequest,
  probeBuyback,
  mutateBuyback,
  reconcileLiveBuyback,
} from './stages/buyback.mjs';
import {
  ReturnRecoveryRequiredError,
  prepareReturnRequest,
  probeReturn,
  mutateReturn,
  reconcileLiveReturn,
} from './stages/return.mjs';
import { preparePayoutRequest, probePayout, mutatePayout, reconcileLivePayout } from './stages/payout.mjs';
import { assertSupplementarySettlementDispatch } from './stages/supplementary-settlement.mjs';
import {
  createRehearsalSkipHandler,
  prepareRehearsalPayoutRequest,
  probeRehearsalPayout,
  mutateRehearsalPayout,
  reconcileLiveRehearsalPayout,
} from './stages/rehearsal.mjs';
import {
  isLiveCollectorOnlyRehearsal,
  requireCollectorOnlyMutationAuthority,
} from '../../rehearsal/collector-only-authorization.mjs';

export { LiveModeIntegrationPendingError };

const STAGE_HANDLERS = Object.freeze({
  'eligibility-snapshot': {
    probe: probeEligibilitySnapshot,
    mutate: mutateEligibilitySnapshot,
    reconcileLive: reconcileLiveEligibilitySnapshot,
  },
  'claim-process': {
    chainJournal: true,
    prepareRequest: prepareClaimProcessRequest,
    probe: probeClaimProcess,
    mutate: mutateClaimProcess,
    reconcileLive: reconcileLiveClaimProcess,
  },
  outbound: {
    chainJournal: true,
    prepareRequest: prepareOutboundRequest,
    probe: probeOutbound,
    mutate: mutateOutbound,
    reconcileLive: reconcileLiveOutbound,
  },
  purchase: {
    collectorCapable: true,
    prepareRequest: preparePurchaseRequest,
    probe: probePurchase,
    mutate: mutatePurchase,
    reconcileLive: reconcileLivePurchase,
  },
  open: {
    collectorCapable: true,
    prepareRequest: prepareOpenRequest,
    probe: probeOpen,
    mutate: mutateOpen,
    reconcileLive: reconcileLiveOpen,
  },
  'epic-gate': {
    collectorCapable: true,
    prepareRequest: prepareEpicGateRequest,
    probe: probeEpicGate,
    mutate: mutateEpicGate,
    reconcileLive: reconcileLiveEpicGate,
  },
  buyback: {
    collectorCapable: true,
    prepareRequest: prepareBuybackRequest,
    probe: probeBuyback,
    mutate: mutateBuyback,
    reconcileLive: reconcileLiveBuyback,
  },
  return: {
    chainJournal: true,
    prepareRequest: prepareReturnRequest,
    probe: probeReturn,
    mutate: mutateReturn,
    reconcileLive: reconcileLiveReturn,
  },
  payout: {
    probe: probePayout,
    prepareRequest: preparePayoutRequest,
    mutate: mutatePayout,
    reconcileLive: reconcileLivePayout,
  },
});

// The shipped lifecycle handlers are production-capable: each uses the write-ahead attempt,
// policy signer, and independent reconciliation paths imported in the integrated launch graph.
// Keep this map for historical journal compatibility, but do not mark a live stage pending when a
// real handler exists.
const LIVE_MUTATION_PENDING = Object.freeze({});
const FAIL_CLOSED_UNJOURNALED_STAGES = new Set();
const TEST_PROFILE_MUTATION_AUTHORITY = createTestProfileMutationAuthority();
const DEFAULT_UNRESOLVED_CARD_DEADLINE_MINUTES = 30;

function integrationPendingFor(config, stage) {
  return isLiveCollectorOnlyRehearsal(config) ? null : LIVE_MUTATION_PENDING[stage] ?? null;
}

function isDirectPayoutHandler(handler) {
  return handler === STAGE_HANDLERS.payout;
}

function requireStageMutationAuthority(preflightAuthority, config) {
  if (isLiveCollectorOnlyRehearsal(config)) return requireCollectorOnlyMutationAuthority(config);
  if (preflightAuthority === TEST_PROFILE_MUTATION_AUTHORITY) {
    if (process.env.NODE_TEST_CONTEXT === undefined) {
      throw new Error('stage-driver fixture authority is available only from the Node test runner');
    }
    return TEST_PROFILE_MUTATION_AUTHORITY;
  }
  if (preflightAuthority !== undefined) throw new Error('stage-driver fixture authority is invalid');
  return requireLiveMutationAuthority();
}

const RECONCILIATION_REPOSITORY_METHODS = Object.freeze([
  'readActiveCycle',
  'readStage',
  'describeCycle',
  'readStageAttempt',
  'readOperationalStageAttempt',
  'readChainTransactionAttempt',
  'readChainAttemptRecoveryContext',
  'readRelayLeg',
  'readClaimPreconditions',
  'readPackBatchIntent',
  'readPackBatchRequest',
  'listHeldPositions',
  'listKnownCycleIds',
]);

const READ_ONLY_LIVE_RECONCILIATION_STAGES = new Set(['eligibility-snapshot']);
// 'purchase' carves no card (none exists yet before a card mints), but a batch purchase can leave
// individual packs genuinely unattributable (lost response with no durable memo at all); it needs
// the same cycle-level hold authority as the card-bearing stages for that irreducible case.
const CARD_HELD_POSITION_RECONCILIATION_STAGES = new Set(['purchase', 'open', 'epic-gate', 'buyback']);
const CHAIN_JOURNAL_REPOSITORY_METHODS = Object.freeze([
  'readChainTransactionAttempt',
  'prepareChainTransactionAttempt',
  'recordSignedTransaction',
  'recordBroadcast',
  'recordCustodyLedger',
  'recordFinality',
]);
const SUPPLEMENTARY_SETTLEMENT_REPOSITORY_METHODS = Object.freeze([
  ...RECONCILIATION_REPOSITORY_METHODS,
  'readHeldPosition',
  'readSupplementarySettlement',
  'readSupplementarySettlementEvidence',
  'advanceSupplementarySettlement',
  'resolveHeldPosition',
  'readPagedPayoutState',
  'persistPagedPayoutState',
  'prepareSupplementaryChainTransactionAttempt',
  'readSupplementaryChainTransactionAttempt',
  'recordSupplementarySignedTransactionWithRecoveryContext',
  'recordSupplementaryBroadcast',
  'readSupplementaryChainAttemptRecoveryContext',
]);
const EMPTY_SUPPLEMENTARY_CAPABILITIES = Object.freeze({});

function stageHandlersForConfig(config) {
  if (config.rehearsal?.mode !== 'collector-only') return STAGE_HANDLERS;
  return Object.freeze({
    ...STAGE_HANDLERS,
    'eligibility-snapshot': createRehearsalSkipHandler('eligibility-snapshot'),
    'claim-process': createRehearsalSkipHandler('claim-process'),
    outbound: createRehearsalSkipHandler('outbound'),
    return: createRehearsalSkipHandler('return'),
    payout: {
      prepareRequest: prepareRehearsalPayoutRequest,
      probe: probeRehearsalPayout,
      mutate: mutateRehearsalPayout,
      reconcileLive: reconcileLiveRehearsalPayout,
    },
  });
}

function assertCollectorPolicyBundleBeforeMutation(config, stage) {
  if (!isLiveCollectorOnlyRehearsal(config) || !['purchase', 'open', 'buyback'].includes(stage)) return;
  const bundle = config?.collectorCrypt?.executionBundle;
  if (bundle === undefined) return;
  assertCollectorPolicyBundleRuntimeReady(bundle);
}

/** Convert adapter values to the canonical subset accepted by the durable journal. */
function toEvidenceValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.map(toEvidenceValue);
  if (typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) out[key] = toEvidenceValue(value[key]);
    return out;
  }
  return String(value);
}

function assertWriteAheadJournal(cycleRepository) {
  for (const method of [
    'readOperationalStageAttempt',
    'prepareStageAttempt',
    'markStageAttemptNotSent',
    'markStageAttemptSentUnknown',
    'recordStageAttemptResponse',
    'reconcileStageAttempt',
  ]) {
    if (typeof cycleRepository[method] !== 'function') {
      throw new Error(`stage-driver cycleRepository.${method} is required for write-ahead mutation safety`);
    }
  }
}

// The write-ahead attempt state is the recovery authority for signer, quote, lease, and
// transaction-policy failures. They remain retryable and never convert a recoverable stage error
// into a whole-cycle terminal hold. Stage handlers reserve whole-cycle holds for conditions that
// make the cycle itself unattributable, such as a missing predecessor or snapshot evidence.

function assertChainJournal(cycleRepository) {
  for (const method of CHAIN_JOURNAL_REPOSITORY_METHODS) {
    if (typeof cycleRepository[method] !== 'function') {
      throw new Error(`stage-driver cycleRepository.${method} is required for chain-attempt mutation safety`);
    }
  }
}

function isChainJournalHandler(handler) {
  return handler?.chainJournal === true;
}

function isCollectorCapableHandler(handler) {
  return handler?.collectorCapable === true;
}

function rejectLegacyRelayOperationalAttempt(stage, attemptRecord) {
  const state = attemptRecord?.attempt?.state;
  if (!['SENT_UNKNOWN', 'RESPONSE_RECORDED', 'RECONCILED'].includes(state)) return;
  const intent = attemptRecord.responseEvidence?.intent ?? attemptRecord.intent ?? null;
  const details = intent && typeof intent === 'object' ? { intent } : {};
  if (stage === 'outbound') {
    throw new OutboundRecoveryRequiredError(
      'OUTBOUND_SETTLEMENT_UNATTESTED',
      'a legacy outbound provider attempt cannot authenticate the source transfer, destination receipt, and one-time cycle settlement',
      details,
    );
  }
  if (stage === 'return') {
    throw new ReturnRecoveryRequiredError(
      'RETURN_SETTLEMENT_UNATTESTED',
      'a legacy return provider attempt cannot authenticate the source transfer, destination receipt, and one-time cycle settlement',
      details,
    );
  }
}

function requestDigest(context, request) {
  if (!context || typeof context.cycleId !== 'string' || typeof context.stage !== 'string') {
    throw new Error('stage-driver context must include cycleId and stage');
  }
  return digest({
    schema: 'hookemon.operational-stage-request.v1',
    cycleId: context.cycleId,
    stage: context.stage,
    request,
  });
}

function freezeRequest(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freezeRequest(item);
    Object.freeze(value);
  }
  return value;
}

function assertPreparedRequest(value, stage) {
  const request = toEvidenceValue(value);
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error(`stage-driver: handler "${stage}" prepareRequest must return a canonical object`);
  }
  return freezeRequest(request);
}

function createMutationGuard(context, stageRequestDigest) {
  if (typeof context.assertMutationAllowed !== 'function') {
    throw new Error('stage-driver: live mutation requires context.assertMutationAllowed');
  }
  const metadata = Object.freeze({
    cycleId: context.cycleId,
    stage: context.stage,
    releaseAmountMicroUsdg: context.releaseAmountMicroUsdg ?? null,
    packId: context.packId ?? null,
    requestDigest: stageRequestDigest,
    fencingToken: context.fencingToken ?? null,
  });
  return async boundary => context.assertMutationAllowed({ ...metadata, boundary });
}

async function authorizeMutation(context, stageRequestDigest, preflightAuthority, config) {
  let guard;
  let guardError;
  try {
    guard = createMutationGuard(context, stageRequestDigest);
    await guard('mutation');
  } catch (error) {
    guardError = error;
  }

  let authorityError;
  try {
    requireStageMutationAuthority(preflightAuthority, config);
  } catch (error) {
    authorityError = error;
  }

  if (guardError && authorityError) {
    throw new Error(`${guardError.message}; ${authorityError.message}`);
  }
  if (guardError) throw guardError;
  if (authorityError) throw authorityError;
  return guard;
}

function isEvmTransactionSigner(role) {
  return role?.role === 'operator-evm' || role?.role === 'operations-trigger';
}

function requiresStandingAuthority(config) {
  return config?.execution?.profile === 'production' && config.execution.providerMode === 'live';
}

function configuredStandingAuthority(config) {
  const authority = config?.standingAuthority;
  const provider = authority?.provider;
  if (!authority || typeof authority.documentDigest !== 'string' || authority.documentDigest.length === 0) {
    throw new Error('stage-driver production signing requires a verified standing authority document');
  }
  if (!isStandingAuthorityProvider(provider) || typeof provider.verifyAndRecordStepAuthorization !== 'function') {
    throw new Error('stage-driver production signing requires a verified standing authority provider');
  }
  if (provider.standingAuthorityDigest !== authority.documentDigest) {
    throw new Error('stage-driver production signing standing authority provider does not match its document');
  }
  if (typeof config.standingAuthorityStepAuthorization !== 'function') {
    throw new Error('stage-driver production signing requires an already-signed standing authority step authorization');
  }
  return Object.freeze({ provider, resolveStepAuthorization: config.standingAuthorityStepAuthorization });
}

function createStandingAuthoritySigningGuard({ config, cycleRepository, context, stageRequestDigest }) {
  if (!requiresStandingAuthority(config)) return null;
  return async ({ role }) => {
    const authority = configuredStandingAuthority(config);
    const intent = await authority.resolveStepAuthorization(Object.freeze({
      cycleId: context.cycleId,
      stage: context.stage,
      authorizationKind: 'sign',
      requestDigest: stageRequestDigest,
      signerRole: typeof role?.role === 'string' ? role.role : null,
    }));
    const authorization = await authority.provider.verifyAndRecordStepAuthorization(intent, {
      cycleRepository,
      expectedSubjectDigest: stageRequestDigest,
    });
    if (!authorization || authorization.cycleId !== context.cycleId
      || authorization.actionKind !== context.stage
      || authorization.authorizationKind !== 'sign'
      || authorization.subjectDigest !== stageRequestDigest) {
      throw new Error('stage-driver standing authority step authorization does not bind the signing boundary');
    }
    return authorization;
  };
}

function guardedSignerRole(role, guard, nonceFence = null, standingAuthorityGuard = null) {
  if (!role || typeof role !== 'object') return role;
  const guarded = { ...role };
  for (const [method, boundary] of [['sign', 'signature'], ['broadcast', 'broadcast']]) {
    if (typeof role[method] !== 'function') continue;
    guarded[method] = async (...args) => {
      await guard(boundary);
      if (nonceFence && isEvmTransactionSigner(role)) {
        await nonceFence(role);
        await guard(boundary);
      }
      if (method === 'sign' && standingAuthorityGuard !== null) {
        await standingAuthorityGuard({ role });
      }
      return role[method](...args);
    };
  }
  return guarded;
}

function guardedSignerClient(signerClient, guard, nonceFence = null, standingAuthorityGuard = null) {
  if (!signerClient || typeof signerClient !== 'object') return signerClient;
  const guarded = guardedSignerRole(signerClient, guard, nonceFence, standingAuthorityGuard);
  for (const [role, client] of Object.entries(signerClient)) {
    guarded[role] = guardedSignerRole(client, guard, nonceFence, standingAuthorityGuard);
  }
  return guarded;
}

function createEvmNonceFence({ cycleRepository, context, config }) {
  const fencingToken = context?.fencingToken;
  if (!fencingToken) return null;
  return async (role = null) => {
    const wallet = role?.role === 'operations-trigger'
      ? config?.accounts?.operationsTrigger
      : config?.accounts?.evm;
    if (!wallet) {
      const roleName = role?.role === 'operations-trigger' ? 'operations-trigger' : 'operator EVM';
      throw new Error(`stage-driver ${roleName} signing requires its configured wallet for the nonce fence`);
    }
    const genericInput = Object.freeze({
      chainId: String(config.chainId ?? 4663),
      wallet,
      stage: context.stage,
      fencingToken,
      ...walletNonceLeaseWindow(context, 'stage-driver wallet nonce reservation'),
    });
    if (typeof cycleRepository.reserveWalletNonce === 'function' && typeof cycleRepository.assertWalletNonce === 'function') {
      await cycleRepository.reserveWalletNonce(context.cycleId, genericInput);
      await cycleRepository.assertWalletNonce(context.cycleId, genericInput);
      return;
    }
    if (typeof cycleRepository.acquireEvmNonceLock !== 'function' || typeof cycleRepository.assertEvmNonceLock !== 'function') {
      throw new Error('stage-driver EVM signing requires a wallet-wide nonce lock repository');
    }
    const input = Object.freeze({
      chainId: String(config.chainId ?? 4663),
      wallet,
      fencingToken,
    });
    await cycleRepository.acquireEvmNonceLock(context.cycleId, input);
    await cycleRepository.assertEvmNonceLock(context.cycleId, input);
  };
}

function guardedAdapterMethods(value, boundaries, guard) {
  if (!value || typeof value !== 'object') return value;
  const methods = new Map();
  return new Proxy(Object.create(null), {
    get(_facade, property) {
      const member = Reflect.get(value, property, value);
      if (typeof member !== 'function') return member;
      const cached = methods.get(property);
      if (cached) return cached;
      const boundary = typeof property === 'string' ? boundaries[property] : null;
      const wrapped = boundary
        ? async (...args) => {
          await guard(boundary);
          return Reflect.apply(member, value, args);
        }
        : member.bind(value);
      methods.set(property, wrapped);
      return wrapped;
    },
  });
}

function guardedObjectProperty(value, property, replacement) {
  if (!value || typeof value !== 'object') return value;
  const methods = new Map();
  return new Proxy(Object.create(null), {
    get(_facade, key) {
      if (key === property) return replacement;
      const member = Reflect.get(value, key, value);
      if (typeof member !== 'function') return member;
      const cached = methods.get(key);
      if (cached) return cached;
      const bound = member.bind(value);
      methods.set(key, bound);
      return bound;
    },
  });
}

function isSolanaSendTransactionRequest(options) {
  if (!options || typeof options !== 'object' || typeof options.body !== 'string') return false;
  try {
    return JSON.parse(options.body)?.method === 'sendTransaction';
  } catch {
    return false;
  }
}

function guardedSolanaRpcClient(value, guard) {
  if (!value || typeof value !== 'object') return value;
  const methods = new Map();
  return new Proxy(Object.create(null), {
    get(_facade, property) {
      const member = Reflect.get(value, property, value);
      if (typeof member !== 'function') return member;
      const cached = methods.get(property);
      if (cached) return cached;
      let wrapped;
      if (property === 'fetchImpl') {
        wrapped = async (...args) => {
          if (isSolanaSendTransactionRequest(args[1])) await guard('broadcast');
          return member(...args);
        };
      } else if (property === 'sendTransaction') {
        wrapped = async (...args) => {
          await guard('broadcast');
          return Reflect.apply(member, value, args);
        };
      } else {
        wrapped = member.bind(value);
      }
      methods.set(property, wrapped);
      return wrapped;
    },
  });
}

function guardedAdapters(adapters, guard) {
  const collectorCrypt = guardedAdapterMethods(adapters.collectorCrypt, {
    generatePack: 'mutation',
    openPack: 'mutation',
    buyback: 'mutation',
    submitTransaction: 'broadcast',
  }, guard);
  const robinhoodClient = guardedAdapterMethods(adapters.robinhood?.client, {
    sendRawTransaction: 'broadcast',
  }, guard);
  const solanaClient = guardedSolanaRpcClient(adapters.solana?.client, guard);
  const methods = new Map();
  return new Proxy(Object.create(null), {
    get(_facade, property) {
      if (property === 'collectorCrypt') return collectorCrypt;
      if (property === 'robinhood') return guardedObjectProperty(adapters.robinhood, 'client', robinhoodClient);
      if (property === 'solana') return guardedObjectProperty(adapters.solana, 'client', solanaClient);
      const member = Reflect.get(adapters, property, adapters);
      if (typeof member !== 'function') return member;
      const cached = methods.get(property);
      if (cached) return cached;
      const bound = member.bind(adapters);
      methods.set(property, bound);
      return bound;
    },
  });
}

function pendingIntegrationRequest(context) {
  // This descriptor is only for a frozen built-in handler that stops before it can construct or
  // send a provider request. A future live integration must implement prepareRequest instead.
  return freezeRequest({
    schema: 'hookemon.pending-stage-request.v1',
    cycleId: context.cycleId,
    stage: context.stage,
    intent: toEvidenceValue(context.intent),
  });
}

function frozenCanonicalValue(value) {
  return freezeRequest(toEvidenceValue(value));
}

function stageConfiguration(config) {
  const {
    standingAuthorityStepAuthorization: _standingAuthorityStepAuthorization,
    stageHandlers: _stageHandlers,
    ...withoutCapabilities
  } = config;
  if (!withoutCapabilities.standingAuthority || typeof withoutCapabilities.standingAuthority !== 'object') {
    return withoutCapabilities;
  }
  const {
    provider: _provider,
    resolveStepAuthorization: _resolveStepAuthorization,
    ...document
  } = withoutCapabilities.standingAuthority;
  return { ...withoutCapabilities, standingAuthority: document };
}

function assertUnresolvedCardDeadlineMinutes(value) {
  if (!Number.isSafeInteger(value) || value < 5 || value > 1440) {
    throw new Error('stage-driver unresolvedCardDeadlineMinutes must be an integer from 5 through 1440');
  }
  return value;
}

async function stageConfigurationWithOperatorDeadline(config, readOperatorConfiguration) {
  const base = stageConfiguration(config);
  const operatorConfiguration = readOperatorConfiguration === null
    ? null
    : await readOperatorConfiguration();
  if (operatorConfiguration !== null && (typeof operatorConfiguration !== 'object' || Array.isArray(operatorConfiguration))) {
    throw new Error('stage-driver operator configuration is invalid');
  }
  const deadline = operatorConfiguration?.unresolvedCardDeadlineMinutes
    ?? base.unresolvedCardDeadlineMinutes
    ?? DEFAULT_UNRESOLVED_CARD_DEADLINE_MINUTES;
  const maxHeldPositions = operatorConfiguration?.maxHeldPositions ?? base.maxHeldPositions;
  const maxHeldValueMicroUsdg = operatorConfiguration?.maxHeldValueMicroUsdg ?? base.maxHeldValueMicroUsdg;
  return Object.freeze({
    ...base,
    unresolvedCardDeadlineMinutes: assertUnresolvedCardDeadlineMinutes(deadline),
    ...(maxHeldPositions === undefined ? {} : { maxHeldPositions }),
    ...(maxHeldValueMicroUsdg === undefined ? {} : { maxHeldValueMicroUsdg }),
  });
}

function preparationInput(context, config) {
  return Object.freeze({
    liveMode: true,
    config: frozenCanonicalValue(config),
    context: frozenCanonicalValue({
      cycleId: context.cycleId,
      stage: context.stage,
      intent: context.intent,
    }),
  });
}

function collectorOnlyPreparationAdapters(adapters, assertLease) {
  const collectorCrypt = {};
  const getMachines = leaseFencedReadMethod(adapters?.collectorCrypt, 'getMachines', assertLease);
  if (getMachines) collectorCrypt.getMachines = getMachines;
  const solanaClient = {};
  for (const method of ['getTransaction', 'getAccountInfo']) {
    const read = leaseFencedReadMethod(adapters?.solana?.client, method, assertLease);
    if (read) solanaClient[method] = read;
  }
  return Object.freeze({
    collectorCrypt: Object.freeze(collectorCrypt),
    solana: Object.freeze({ client: Object.freeze(solanaClient) }),
  });
}

function collectorOnlyPreparationInput(context, config, adapters, cycleRepository) {
  return Object.freeze({
    liveMode: true,
    adapters: collectorOnlyPreparationAdapters(adapters, context.assertLease),
    config: frozenCanonicalValue(config),
    cycleRepository: createLeaseFencedReadRepository(cycleRepository, context.assertLease),
    context: frozenCanonicalValue({
      cycleId: context.cycleId,
      stage: context.stage,
      intent: context.intent,
    }),
  });
}

function leaseFencedReadMethod(value, method, assertLease) {
  if (typeof value?.[method] !== 'function') return undefined;
  return (...args) => {
    assertLease?.();
    return value[method](...args);
  };
}

function chainPreparationAdapters(adapters, assertLease) {
  const client = adapters?.robinhood?.client;
  const robinhoodClient = {};
  for (const method of ['getChainId', 'getTransactionCount', 'estimateGas', 'estimateFeesPerGas']) {
    const read = leaseFencedReadMethod(client, method, assertLease);
    if (read) robinhoodClient[method] = read;
  }
  const relay = {};
  for (const method of ['quoteOutboundBridge', 'quoteReturnBridge', 'prepareExecution']) {
    const read = leaseFencedReadMethod(adapters?.relay, method, assertLease);
    if (read) relay[method] = read;
  }
  const solanaClient = {};
  for (const method of ['getLatestBlockhash', 'getBlockHeight', 'isBlockhashValid', 'getAddressLookupTable']) {
    const read = leaseFencedReadMethod(adapters?.solana?.client, method, assertLease);
    if (read) solanaClient[method] = read;
  }
  return Object.freeze({
    robinhood: Object.freeze({ client: Object.freeze(robinhoodClient) }),
    relay: Object.freeze(relay),
    solana: Object.freeze({ client: Object.freeze(solanaClient) }),
  });
}

// Purchase/open/epic-gate/buyback prepareRequest reads only the Collector machine catalog
// (purchase) and durable predecessor-stage evidence (open, epic-gate, buyback via
// cycleRepository.readStage); this stays as narrow as those real handlers actually need, never the
// writable repository, a signer, or any mutation capability.
function collectorProductionPreparationAdapters(adapters, assertLease) {
  const collectorCrypt = {};
  const getMachines = leaseFencedReadMethod(adapters?.collectorCrypt, 'getMachines', assertLease);
  if (getMachines) collectorCrypt.getMachines = getMachines;
  return Object.freeze({ collectorCrypt: Object.freeze(collectorCrypt) });
}

function collectorProductionPreparationInput(context, config, adapters, cycleRepository) {
  return Object.freeze({
    liveMode: true,
    adapters: collectorProductionPreparationAdapters(adapters, context.assertLease),
    config: frozenCanonicalValue(config),
    cycleRepository: createLeaseFencedReadRepository(cycleRepository, context.assertLease),
    context: frozenCanonicalValue({
      cycleId: context.cycleId,
      stage: context.stage,
      intent: context.intent,
    }),
  });
}

function chainPreparationInput(context, config, adapters, cycleRepository) {
  return Object.freeze({
    liveMode: true,
    adapters: chainPreparationAdapters(adapters, context.assertLease),
    config: frozenCanonicalValue(config),
    cycleRepository: createLeaseFencedReadRepository(cycleRepository, context.assertLease),
    context: frozenCanonicalValue({
      cycleId: context.cycleId,
      stage: context.stage,
      intent: context.intent,
      leaseAcquiredAtMs: context.lease?.acquiredAt ?? null,
      leaseExpiresAtMs: context.lease?.expiresAt ?? null,
    }),
  });
}

function createLeaseFencedCapability(value, assertLease, onInvocation, seen = new WeakMap()) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return value;
  const existing = seen.get(value);
  if (existing) return existing;
  if (typeof value === 'function') {
    const fenced = function leaseFencedCapabilityFunction(...args) {
      assertLease?.();
      onInvocation();
      return Reflect.apply(value, this, args);
    };
    seen.set(value, fenced);
    return fenced;
  }
  // The facade, rather than the injected object, is the proxy target. This preserves the
  // capability boundary even when a caller supplies a frozen adapter or signer object.
  const facade = {};
  const proxy = new Proxy(facade, {
    get(_target, property) {
      const member = Reflect.get(value, property, value);
      if (typeof member === 'function') {
        return function leaseFencedCapabilityMethod(...args) {
          assertLease?.();
          onInvocation();
          return Reflect.apply(member, value, args);
        };
      }
      return createLeaseFencedCapability(member, assertLease, onInvocation, seen);
    },
    has(_target, property) {
      return Reflect.has(value, property);
    },
    ownKeys() {
      return Reflect.ownKeys(value);
    },
    getOwnPropertyDescriptor(_target, property) {
      const descriptor = Reflect.getOwnPropertyDescriptor(value, property);
      if (!descriptor) return undefined;
      return {
        configurable: true,
        enumerable: descriptor.enumerable,
        writable: false,
        value: createLeaseFencedCapability(Reflect.get(value, property, value), assertLease, onInvocation, seen),
      };
    },
    set() {
      throw new Error('stage-driver injected capabilities are read-only');
    },
    defineProperty() {
      throw new Error('stage-driver injected capabilities are read-only');
    },
    deleteProperty() {
      throw new Error('stage-driver injected capabilities are read-only');
    },
  });
  seen.set(value, proxy);
  return proxy;
}

function createLeaseFencedReadRepository(cycleRepository, assertLease) {
  const readRepository = {};
  for (const method of RECONCILIATION_REPOSITORY_METHODS) {
    if (typeof cycleRepository[method] !== 'function') continue;
    readRepository[method] = (...args) => {
      assertLease?.();
      return cycleRepository[method](...args);
    };
  }
  return Object.freeze(readRepository);
}

function cardReconciliationRepository(cycleRepository, context) {
  const repository = { ...createLeaseFencedReadRepository(cycleRepository, context.assertLease) };
  if (CARD_HELD_POSITION_RECONCILIATION_STAGES.has(context.stage)) {
    const recordHeldPosition = leaseFencedReadMethod(cycleRepository, 'recordHeldPosition', context.assertLease);
    if (recordHeldPosition) repository.recordHeldPosition = recordHeldPosition;
    const holdCycle = leaseFencedReadMethod(cycleRepository, 'holdCycle', context.assertLease);
    if (holdCycle) repository.holdCycle = holdCycle;
  }
  return Object.freeze(repository);
}

function supplementarySettlementRepository(cycleRepository, assertLease) {
  const repository = {};
  for (const method of SUPPLEMENTARY_SETTLEMENT_REPOSITORY_METHODS) {
    const fenced = leaseFencedReadMethod(cycleRepository, method, assertLease);
    if (fenced) repository[method] = fenced;
  }
  return Object.freeze(repository);
}

function reconciliationInput(context, config, reconciliationAdapters, cycleRepository) {
  return Object.freeze({
    adapters: createLeaseFencedCapability(reconciliationAdapters, context.assertLease, () => {}),
    config: frozenCanonicalValue(config),
    cycleRepository: cardReconciliationRepository(cycleRepository, context),
    context: frozenCanonicalValue({
      cycleId: context.cycleId,
      stage: context.stage,
      intent: context.intent,
      nowMs: context.nowMs ?? null,
    }),
  });
}

function chainReconciliationRepository(cycleRepository, assertLease) {
  const repository = { ...createLeaseFencedReadRepository(cycleRepository, assertLease) };
  for (const method of [
    'recordBroadcast',
    'recordCustodyLedger',
    'recordFinality',
    'recordRelayLeg',
    'recordRelayLegSource',
    'settleRelayLeg',
    'persistChainAttemptRecoveryContext',
    'readChainAttemptRecoveryContext',
    'releaseWalletNonce',
  ]) {
    const fenced = leaseFencedReadMethod(cycleRepository, method, assertLease);
    if (fenced) repository[method] = fenced;
  }
  return Object.freeze(repository);
}

function chainReconciliationInput(context, config, reconciliationAdapters, cycleRepository) {
  return Object.freeze({
    adapters: createLeaseFencedCapability(reconciliationAdapters, context.assertLease, () => {}),
    config: frozenCanonicalValue(config),
    cycleRepository: chainReconciliationRepository(cycleRepository, context.assertLease),
    context: frozenCanonicalValue({
      cycleId: context.cycleId,
      stage: context.stage,
      intent: context.intent,
      fencingToken: context.fencingToken,
      leaseAcquiredAtMs: context.lease?.acquiredAt ?? null,
      leaseExpiresAtMs: context.lease?.expiresAt ?? null,
    }),
  });
}

async function prepareRequestForMutation({ handler, usesBuiltInHandlers, context, config, adapters, cycleRepository }) {
  if (usesBuiltInHandlers && integrationPendingFor(config, context.stage)) return pendingIntegrationRequest(context);
  if (typeof handler.prepareRequest !== 'function') {
    throw new Error(`stage-driver: handler "${context.stage}" is missing prepareRequest`);
  }
  if (usesBuiltInHandlers && context.stage === 'payout' && isDirectPayoutHandler(handler)) {
    return assertPreparedRequest(
      await handler.prepareRequest({ config, cycleRepository, context }),
      context.stage,
    );
  }
  if (usesBuiltInHandlers && isLiveCollectorOnlyRehearsal(config)) {
    return assertPreparedRequest(
      await handler.prepareRequest(collectorOnlyPreparationInput(context, config, adapters, cycleRepository)),
      context.stage,
    );
  }
  if (isChainJournalHandler(handler)) {
    return assertPreparedRequest(
      await handler.prepareRequest(chainPreparationInput(context, config, adapters, cycleRepository)),
      context.stage,
    );
  }
  if (isCollectorCapableHandler(handler)) {
    return assertPreparedRequest(
      await handler.prepareRequest(collectorProductionPreparationInput(context, config, adapters, cycleRepository)),
      context.stage,
    );
  }
  return assertPreparedRequest(
    await handler.prepareRequest(preparationInput(context, config)),
    context.stage,
  );
}

function handlerFor(handlers, context) {
  const handler = handlers[context?.stage];
  if (!handler) throw new Error(`stage-driver: unknown stage "${context?.stage}"`);
  for (const method of ['probe', 'mutate', 'reconcileLive']) {
    if (typeof handler[method] !== 'function') throw new Error(`stage-driver: handler "${context.stage}" is missing ${method}`);
  }
  return handler;
}

function supplementaryHandlerFor(handlers, settlement, { observationOnly }) {
  if (handlers === null) return null;
  const handler = handlers[settlement.state] ?? null;
  if (handler === null) return null;
  if (!handler || typeof handler !== 'object' || Array.isArray(handler)
    || typeof handler.stage !== 'string' || !handler.stage.startsWith('supplementary-')
    || typeof handler.reconcile !== 'function') {
    throw new Error(`stage-driver: supplementary handler for "${settlement.state}" is invalid`);
  }
  if (observationOnly && (Object.hasOwn(handler, 'mutation') || Object.hasOwn(handler, 'requestDigest'))) {
    throw new Error('stage-driver: supplementary handlers are observation-only');
  }
  return handler;
}

async function reconcileOperationalAttempt({ cycleRepository, context, evidence, allowMissingAttempt = false }) {
  const current = await cycleRepository.readOperationalStageAttempt(context.cycleId, context.stage);
  if (!current) return allowMissingAttempt ? evidence : null;
  if (current.attempt.state === 'RECONCILED') return current.reconciliationEvidence;
  if (current.attempt.state === 'PREPARED') {
    await cycleRepository.markStageAttemptSentUnknown(context.cycleId, context.stage);
  }
  await cycleRepository.reconcileStageAttempt(context.cycleId, context.stage, evidence);
  return evidence;
}

/**
 * The driver is the one mutation boundary for an automated cycle. In live mode it persists a
 * provider attempt in PREPARED state before invoking a provider. Request preparation receives only
 * frozen canonical data, never injected adapters, a signer, or a writable repository. The persisted
 * request is passed to mutate with lease-fenced, read-only adapter and signer views. A response only
 * becomes stage evidence when a subsequent reconcileLive call produces independently observed evidence.
 */
export function createStageDriver({
  liveMode,
  adapters,
  reconciliationAdapters = null,
  signerClient,
  config,
  cycleRepository,
  stageHandlers = null,
  preflightAuthority,
  readOperatorConfiguration = null,
  supplementaryStageHandlers = null,
  supplementaryAdapters = null,
  supplementarySignerClient = null,
  productionSupplementaryStageHandlers = null,
}) {
  if (typeof liveMode !== 'boolean') throw new Error('stage-driver liveMode must be a boolean');
  if (!adapters || typeof adapters !== 'object') throw new Error('stage-driver adapters must be an object');
  if (reconciliationAdapters !== null && typeof reconciliationAdapters !== 'object') {
    throw new Error('stage-driver reconciliationAdapters must be an object or null');
  }
  if (!config || typeof config !== 'object') throw new Error('stage-driver config must be an object');
  if (!cycleRepository) throw new Error('stage-driver cycleRepository is required');
  if (readOperatorConfiguration !== null && typeof readOperatorConfiguration !== 'function') {
    throw new Error('stage-driver readOperatorConfiguration must be a function or null');
  }
  if (supplementaryStageHandlers !== null
    && (!supplementaryStageHandlers || typeof supplementaryStageHandlers !== 'object' || Array.isArray(supplementaryStageHandlers))) {
    throw new Error('stage-driver supplementaryStageHandlers must be an object or null');
  }
  if (supplementaryStageHandlers !== null && process.env.NODE_TEST_CONTEXT === undefined) {
    throw new Error('stage-driver supplementaryStageHandlers are available only from the Node test runner');
  }
  // Distinct from supplementaryStageHandlers above, which stays exactly as it was: a
  // Node-test-only, observation-only injection seam with no capability access, guarded by
  // NODE_TEST_CONTEXT. This is the seam a real process uses instead -- explicit, capability-bound,
  // and never gated by a test-runner environment variable. A caller must supply real
  // supplementaryAdapters/supplementarySignerClient alongside it (production must choose shipped
  // handlers deliberately, with its own policy/canary/fencing at the call site that supplies this
  // constructor argument -- not by relaxing the arbitrary-injection guard above), and its handlers
  // are not restricted to observation-only, since a real resale/settlement handler must sign and
  // broadcast. The two seams are mutually exclusive: a driver instance is either a Node-test
  // instance exercising observation-only fixtures, or a production instance with its own real
  // handlers -- never both at once.
  if (productionSupplementaryStageHandlers !== null
    && (!productionSupplementaryStageHandlers || typeof productionSupplementaryStageHandlers !== 'object' || Array.isArray(productionSupplementaryStageHandlers))) {
    throw new Error('stage-driver productionSupplementaryStageHandlers must be an object or null');
  }
  if (productionSupplementaryStageHandlers !== null && supplementaryStageHandlers !== null) {
    throw new Error('stage-driver cannot combine productionSupplementaryStageHandlers with the Node-test-only supplementaryStageHandlers seam');
  }
  if (productionSupplementaryStageHandlers !== null && (!supplementaryAdapters || !supplementarySignerClient)) {
    throw new Error('stage-driver productionSupplementaryStageHandlers requires supplementaryAdapters and supplementarySignerClient');
  }
  assertWriteAheadJournal(cycleRepository);
  const usesBuiltInHandlers = stageHandlers === null;
  const handlers = stageHandlers ?? stageHandlersForConfig(config);
  const handlerConfig = () => stageConfigurationWithOperatorDeadline(config, readOperatorConfiguration);
  const activeSupplementaryHandlers = productionSupplementaryStageHandlers ?? supplementaryStageHandlers;
  const activeSupplementaryObservationOnly = productionSupplementaryStageHandlers === null;
  return Object.freeze({
    /**
     * Reconciles one owner-approved held-position settlement outside the normal cycle stage
     * sequence. With no production seam supplied, injected handlers are observation-only: they
     * receive a lease-fenced repository facade but no provider or signer capability -- this stays
     * the Node-test-only default. A caller that supplies productionSupplementaryStageHandlers with
     * its own supplementaryAdapters/supplementarySignerClient gets a real provider/signer capability
     * passed to its handlers instead, for a provider-specific implementation with its own documented
     * mutation boundary.
     */
    async runSupplementarySettlement(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        throw new Error('stage-driver supplementary settlement input is invalid');
      }
      if (input.assertLease !== undefined && typeof input.assertLease !== 'function') {
        throw new Error('stage-driver supplementary settlement assertLease is invalid');
      }
      const { position, settlement } = assertSupplementarySettlementDispatch(input.position, input.settlement);
      const handler = supplementaryHandlerFor(activeSupplementaryHandlers, settlement, { observationOnly: activeSupplementaryObservationOnly });
      const pending = Object.freeze({
        status: 'PENDING',
        positionId: position.positionId,
        cycleId: settlement.cycleId,
        manifestId: settlement.manifestId,
        stage: handler?.stage ?? null,
        state: settlement.state,
      });
      if (handler === null) return pending;

      input.assertLease?.();
      const currentHandlerConfig = await handlerConfig();
      const context = Object.freeze({
        cycleId: settlement.cycleId,
        stage: handler.stage,
        positionId: position.positionId,
        manifestId: settlement.manifestId,
        settlementState: settlement.state,
        ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
        ...(input.fencingToken === undefined ? {} : { fencingToken: input.fencingToken }),
      });
      // Supplementary effects run outside the normal stage sequence, but they are still money
      // effects. Bind both provider and signer capabilities to the current lease at invocation
      // time so a stale worker cannot sign, submit, or read a reconciliation result after losing
      // the position's cycle lease.
      const supplementaryCapabilities = productionSupplementaryStageHandlers !== null
        ? Object.freeze({
          adapters: createLeaseFencedCapability(supplementaryAdapters, input.assertLease, () => {}),
          signerClient: createLeaseFencedCapability(supplementarySignerClient, input.assertLease, () => {}),
        })
        : Object.freeze({ adapters: EMPTY_SUPPLEMENTARY_CAPABILITIES, signerClient: null });
      await handler.reconcile(Object.freeze({
        adapters: supplementaryCapabilities.adapters,
        signerClient: supplementaryCapabilities.signerClient,
        config: frozenCanonicalValue(currentHandlerConfig),
        cycleRepository: supplementarySettlementRepository(cycleRepository, input.assertLease),
        context: frozenCanonicalValue(context),
        assertLease: input.assertLease,
        position,
        settlement,
      }));
      input.assertLease?.();
      if (typeof cycleRepository.readSupplementarySettlement !== 'function') {
        throw new Error('stage-driver supplementary settlement requires cycleRepository.readSupplementarySettlement');
      }
      const refreshed = await cycleRepository.readSupplementarySettlement(position.positionId);
      if (refreshed === null) {
        throw new Error('stage-driver supplementary settlement disappeared during reconciliation');
      }
      const checked = assertSupplementarySettlementDispatch(position, refreshed).settlement;
      if (checked.state === settlement.state) return pending;
      return Object.freeze({
        status: 'ADVANCED',
        positionId: position.positionId,
        cycleId: checked.cycleId,
        manifestId: checked.manifestId,
        stage: handler.stage,
        state: checked.state,
      });
    },

    async reconcile(context) {
      const currentHandlerConfig = await handlerConfig();
      const handler = handlerFor(handlers, context);
      const current = await cycleRepository.readOperationalStageAttempt(context.cycleId, context.stage);
      if (usesBuiltInHandlers && isChainJournalHandler(handler)) {
        rejectLegacyRelayOperationalAttempt(context.stage, current);
      }
      if (current?.attempt.state === 'RECONCILED') return toEvidenceValue(current.reconciliationEvidence);
      if (!liveMode) {
        if (current) {
          throw new Error(`stage-driver: "${context.stage}" has an unresolved live attempt and requires live reconciliation`);
        }
        return toEvidenceValue(await handler.probe({ adapters, config: currentHandlerConfig, cycleRepository, context }));
      }
      if (usesBuiltInHandlers && READ_ONLY_LIVE_RECONCILIATION_STAGES.has(context.stage)) {
        const evidence = await handler.reconcileLive({ adapters, config: currentHandlerConfig, cycleRepository, context });
        return evidence === null ? null : toEvidenceValue(evidence);
      }
      if (usesBuiltInHandlers && context.stage === 'payout' && isDirectPayoutHandler(handler)) {
        // Payout owns a recipient-level write-ahead journal. It has no single provider request
        // whose response can represent every transfer, so its terminal evidence is reconciled
        // directly from that journal instead of the generic provider-attempt wrapper.
        const evidence = await handler.reconcileLive({
          adapters: reconciliationAdapters ?? adapters,
          config: currentHandlerConfig,
          cycleRepository,
          context,
        });
        return evidence === null ? null : toEvidenceValue(evidence);
      }
      if (usesBuiltInHandlers && isChainJournalHandler(handler)) {
        assertChainJournal(cycleRepository);
        let evidence;
        try {
          evidence = await handler.reconcileLive(
            chainReconciliationInput(context, currentHandlerConfig, reconciliationAdapters ?? adapters, cycleRepository),
          );
        } catch (error) {
          throw error;
        }
        if (evidence === null) return null;
        if (evidence === undefined) {
          throw new Error(`stage-driver: handler "${context.stage}" reconcileLive must return null or a canonical evidence value`);
        }
        const canonicalEvidence = toEvidenceValue(evidence);
        return toEvidenceValue(await reconcileOperationalAttempt({
          cycleRepository,
          context,
          evidence: canonicalEvidence,
          allowMissingAttempt: true,
        }));
      }
      if (usesBuiltInHandlers
        && integrationPendingFor(currentHandlerConfig, context.stage)
        && !FAIL_CLOSED_UNJOURNALED_STAGES.has(context.stage)) return null;

      let evidence;
      try {
        evidence = await handler.reconcileLive(
          reconciliationInput(
            context,
            currentHandlerConfig,
            isLiveCollectorOnlyRehearsal(currentHandlerConfig) ? reconciliationAdapters ?? adapters : reconciliationAdapters,
            cycleRepository,
          ),
        );
      } catch (error) {
        throw error;
      }
      if (evidence === null) return null;
      if (evidence === undefined) {
        throw new Error(`stage-driver: handler "${context.stage}" reconcileLive must return null or a canonical evidence value`);
      }
      const canonicalEvidence = toEvidenceValue(evidence);
      return toEvidenceValue(await reconcileOperationalAttempt({ cycleRepository, context, evidence: canonicalEvidence }));
    },

    async execute(context) {
      const currentHandlerConfig = await handlerConfig();
      const handler = handlerFor(handlers, context);
      if (!liveMode) return;
      if (usesBuiltInHandlers) assertCollectorPolicyBundleBeforeMutation(currentHandlerConfig, context.stage);
      const chainJournal = usesBuiltInHandlers && isChainJournalHandler(handler);

      if (usesBuiltInHandlers && READ_ONLY_LIVE_RECONCILIATION_STAGES.has(context.stage)) {
        throw new Error(`stage-driver: "${context.stage}" completes only through read-only reconciliation`);
      }

      if (usesBuiltInHandlers && context.stage === 'payout' && isDirectPayoutHandler(handler)) {
        try {
          context.assertLease?.();
        } catch (error) {
          throw error;
        }
        let request;
        try {
          request = await prepareRequestForMutation({
            handler,
            usesBuiltInHandlers,
            context,
            config: currentHandlerConfig,
            cycleRepository,
          });
        } catch (error) {
          throw error;
        }
        const preparedRequestDigest = requestDigest(context, request);
        try {
          context.assertLease?.();
        } catch (error) {
          throw error;
        }
        const guard = await authorizeMutation(context, preparedRequestDigest, preflightAuthority, currentHandlerConfig);
        let reachedProviderCapability = false;
        const markProviderCapability = () => { reachedProviderCapability = true; };
        const leaseFencedAdapters = createLeaseFencedCapability(
          adapters,
          context.assertLease,
          markProviderCapability,
        );
        const leaseFencedSignerClient = createLeaseFencedCapability(
          signerClient,
          context.assertLease,
          () => {},
        );
        const nonceFence = createEvmNonceFence({ cycleRepository, context, config });
        const standingAuthoritySigningGuard = createStandingAuthoritySigningGuard({
          config,
          cycleRepository,
          context,
          stageRequestDigest: preparedRequestDigest,
        });
        try {
          await handler.mutate({
            liveMode,
            adapters: guardedAdapters(leaseFencedAdapters, guard),
            signerClient: guardedSignerClient(leaseFencedSignerClient, guard, nonceFence, standingAuthoritySigningGuard),
            policySignerClient: signerClient,
            config: currentHandlerConfig,
            cycleRepository,
            evmNonceFence: nonceFence,
            context: Object.freeze({ ...context, request, requestDigest: preparedRequestDigest }),
            request,
          });
        } catch (error) {
          // Direct payout writes each recipient boundary before it reaches a signer or RPC
          // transport. Its own durable state is therefore the recovery authority.
          if (reachedProviderCapability) context.assertLease?.();
          throw error;
        }
        return;
      }

      const current = await cycleRepository.readOperationalStageAttempt(context.cycleId, context.stage);
      if (current && !chainJournal && current.attempt.state !== 'NOT_SENT') {
        throw new Error(`stage-driver: "${context.stage}" already has a prepared or sent attempt and requires reconciliation`);
      }
      if (current && chainJournal && current.attempt.state === 'SENT_UNKNOWN') {
        throw new Error(`stage-driver: "${context.stage}" legacy provider attempt is sent-unknown and requires reconciliation`);
      }
      if (current && chainJournal && current.attempt.state !== 'PREPARED') {
        throw new Error(`stage-driver: "${context.stage}" has a legacy provider response and requires reconciliation before a chain attempt`);
      }
      if (usesBuiltInHandlers
        && FAIL_CLOSED_UNJOURNALED_STAGES.has(context.stage)
        && integrationPendingFor(currentHandlerConfig, context.stage)) {
        throw new LiveModeIntegrationPendingError(context.stage, integrationPendingFor(currentHandlerConfig, context.stage));
      }
      let request;
      try {
        request = await prepareRequestForMutation({
          handler,
          usesBuiltInHandlers,
          context,
          config: currentHandlerConfig,
          adapters,
          cycleRepository,
        });
      } catch (error) {
        throw error;
      }
      const preparedRequestDigest = requestDigest(context, request);
      if (!chainJournal) {
        const prepared = createPreparedProviderMutationAttempt({
          cycleId: context.cycleId,
          stage: context.stage,
          requestDigest: preparedRequestDigest,
        });
        await cycleRepository.prepareStageAttempt(context.cycleId, context.stage, prepared);
      } else {
        assertChainJournal(cycleRepository);
        // A chain-journal stage records its attempts under per-transaction digests, but the
        // standing-authority guard below resolves against this stage-level digest. Publish it
        // durably so an external policy service can authorize the boundary that will actually be
        // reached; recording it authorizes nothing by itself.
        await cycleRepository.recordStageRequestDigest?.(context.cycleId, context.stage, preparedRequestDigest);
      }

      // The service fences the lease before calling the driver. The journal write above can await
      // disk I/O, so fence once more at the last safe point before a handler can reach a provider.
      try {
        context.assertLease?.();
      } catch (error) {
        if (!chainJournal) await cycleRepository.markStageAttemptNotSent(context.cycleId, context.stage);
        throw error;
      }
      if (usesBuiltInHandlers && integrationPendingFor(currentHandlerConfig, context.stage)) {
        throw new LiveModeIntegrationPendingError(context.stage, integrationPendingFor(currentHandlerConfig, context.stage));
      }
      let guard;
      try {
        guard = await authorizeMutation(context, preparedRequestDigest, preflightAuthority, currentHandlerConfig);
      } catch (error) {
        if (!chainJournal) await cycleRepository.markStageAttemptNotSent(context.cycleId, context.stage);
        throw error;
      }

      let evidence;
      let reachedProviderCapability = false;
      const markProviderCapability = () => { reachedProviderCapability = true; };
      const leaseFencedAdapters = createLeaseFencedCapability(
        adapters,
        context.assertLease,
        markProviderCapability,
      );
      const leaseFencedSignerClient = createLeaseFencedCapability(
        signerClient,
        context.assertLease,
        () => {},
      );
      const nonceFence = createEvmNonceFence({ cycleRepository, context, config });
      const standingAuthoritySigningGuard = createStandingAuthoritySigningGuard({
        config,
        cycleRepository,
        context,
        stageRequestDigest: preparedRequestDigest,
      });
      try {
        evidence = await handler.mutate({
          liveMode,
          // Policy guards wrap the lease-fenced capabilities so a refusal happens before the
          // underlying provider or signer is considered reached.
          adapters: guardedAdapters(leaseFencedAdapters, guard),
          signerClient: guardedSignerClient(leaseFencedSignerClient, guard, nonceFence, standingAuthoritySigningGuard),
          // `guardedSignerClient` deliberately returns facades so the mutation guard runs at each
          // effect boundary. The policy capability itself is branded by a private WeakSet, so
          // payout receives this original reference only to verify that the facade delegates to a
          // transaction-policy signer; it never invokes this unguarded reference.
          policySignerClient: signerClient,
          config: currentHandlerConfig,
          cycleRepository,
          context: Object.freeze({ ...context, request, requestDigest: preparedRequestDigest }),
          request,
          preflightAuthority,
        });
      } catch (error) {
        if (!chainJournal) {
          if (reachedProviderCapability) {
            await cycleRepository.markStageAttemptSentUnknown(context.cycleId, context.stage);
          } else {
            await cycleRepository.markStageAttemptNotSent(context.cycleId, context.stage);
          }
        }
        throw error;
      }
      if (chainJournal) return;
      if (evidence === undefined) {
        await cycleRepository.markStageAttemptSentUnknown(context.cycleId, context.stage);
        return;
      }
      await cycleRepository.recordStageAttemptResponse(context.cycleId, context.stage, toEvidenceValue(evidence));
    },

    async commit() {
      // `AutomatedCycleService` is the sole caller of completeStage. This hook intentionally has
      // no completion side effect; reconcile() supplies the evidence that allows that transition.
    },
  });
}
