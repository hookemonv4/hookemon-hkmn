import { digest } from '../../../runner/src/cycle/journal.mjs';
import { createPreparedProviderMutationAttempt } from '../../../runner/src/cycle/money-schemas.mjs';
import { isStandingAuthorityProvider } from '../../../runner/src/cycle/authorization-provider.mjs';
import { LeaseLostError } from '../../../runner/src/automation/exclusive-lease.mjs';
import { SignerClientError } from '../signing/signer-client.mjs';
import { TransactionPolicyError } from '../signing/transaction-policy.mjs';
import { RelayQuoteExpiredError } from '../relay-client.mjs';
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
import { probePurchase, mutatePurchase, reconcileLivePurchase } from './stages/purchase.mjs';
import { probeOpen, mutateOpen, reconcileLiveOpen } from './stages/open.mjs';
import { probeEpicGate, mutateEpicGate, reconcileLiveEpicGate } from './stages/epic-gate.mjs';
import { probeBuyback, mutateBuyback, reconcileLiveBuyback } from './stages/buyback.mjs';
import {
  ReturnRecoveryRequiredError,
  prepareReturnRequest,
  probeReturn,
  mutateReturn,
  reconcileLiveReturn,
} from './stages/return.mjs';
import { preparePayoutRequest, probePayout, mutatePayout, reconcileLivePayout } from './stages/payout.mjs';
import {
  createRehearsalSkipHandler,
  probeRehearsalPayout,
  mutateRehearsalPayout,
  reconcileLiveRehearsalPayout,
} from './stages/rehearsal.mjs';

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
  purchase: { probe: probePurchase, mutate: mutatePurchase, reconcileLive: reconcileLivePurchase },
  open: { probe: probeOpen, mutate: mutateOpen, reconcileLive: reconcileLiveOpen },
  'epic-gate': { probe: probeEpicGate, mutate: mutateEpicGate, reconcileLive: reconcileLiveEpicGate },
  buyback: { probe: probeBuyback, mutate: mutateBuyback, reconcileLive: reconcileLiveBuyback },
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

// Legacy provider handlers remain available for direct module tests and historical journal reads.
// Their live entrypoints stay closed until the named work package replaces the handler.
const LIVE_MUTATION_PENDING = Object.freeze({
  purchase: 'collector idempotency, transaction policy, and finalized-delta reconciliation are pending WP08b',
  open: 'collector status, mint custody, and finality reconciliation are pending WP08b',
  'epic-gate': 'insured-value evidence and owner decision handling are pending WP08b',
  buyback: 'buyback policy and finalized proceeds reconciliation are pending WP08b',
});
const FAIL_CLOSED_UNJOURNALED_STAGES = new Set();
const TEST_PROFILE_MUTATION_AUTHORITY = createTestProfileMutationAuthority();

function requireStageMutationAuthority(preflightAuthority) {
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
  'listKnownCycleIds',
]);

const READ_ONLY_LIVE_RECONCILIATION_STAGES = new Set(['eligibility-snapshot']);
const CHAIN_JOURNAL_REPOSITORY_METHODS = Object.freeze([
  'readChainTransactionAttempt',
  'prepareChainTransactionAttempt',
  'recordSignedTransaction',
  'recordBroadcast',
  'recordCustodyLedger',
  'recordFinality',
]);

function stageHandlersForConfig(config) {
  if (config.rehearsal?.mode !== 'collector-only') return STAGE_HANDLERS;
  return Object.freeze({
    ...STAGE_HANDLERS,
    outbound: createRehearsalSkipHandler('outbound'),
    return: createRehearsalSkipHandler('return'),
    payout: {
      probe: probeRehearsalPayout,
      mutate: mutateRehearsalPayout,
      reconcileLive: reconcileLiveRehearsalPayout,
    },
  });
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

function keychainInteractionDenied(error) {
  return error instanceof SignerClientError
    && /keychain command/i.test(error.message)
    && /user interaction is not allowed/i.test(error.message);
}

async function holdKnownFailure({ cycleRepository, context, error }) {
  let evidence;
  let terminalState = 'HELD_UNAVAILABLE';
  if (error instanceof RelayQuoteExpiredError) {
    evidence = {
      stage: context.stage,
      reason: 'RELAY_QUOTE_EXPIRED',
      error: error.message,
    };
  } else if (keychainInteractionDenied(error)) {
    evidence = {
      stage: context.stage,
      reason: 'KEYCHAIN_INTERACTION_DENIED',
      error: error.message,
    };
  } else if (error instanceof LeaseLostError && error.code === 'LEASE_LOST') {
    evidence = {
      stage: context.stage,
      reason: 'LEASE_LOST',
      lease: error.lease,
    };
  } else if (error instanceof ReturnRecoveryRequiredError
    && error.recoveryState === 'RETURN_SIGNED_BLOCKHASH_EXPIRED') {
    evidence = {
      stage: context.stage,
      reason: 'RETURN_SIGNED_BLOCKHASH_EXPIRED',
      error: error.message,
    };
  } else if (error instanceof TransactionPolicyError) {
    terminalState = 'HELD_DATA_UNVERIFIED';
    evidence = {
      stage: context.stage,
      reason: 'TRANSACTION_POLICY_REFUSED',
      error: error.message,
    };
  } else {
    return false;
  }
  if (typeof cycleRepository?.holdCycle !== 'function') {
    throw new Error('stage-driver terminal conversion requires cycleRepository.holdCycle');
  }
  await cycleRepository.holdCycle(context.cycleId, terminalState, evidence);
  return true;
}

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

async function authorizeMutation(context, stageRequestDigest, preflightAuthority) {
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
    requireStageMutationAuthority(preflightAuthority);
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

function reconciliationInput(context, config, reconciliationAdapters, cycleRepository) {
  return Object.freeze({
    adapters: createLeaseFencedCapability(reconciliationAdapters, context.assertLease, () => {}),
    config: frozenCanonicalValue(config),
    cycleRepository: createLeaseFencedReadRepository(cycleRepository, context.assertLease),
    context: frozenCanonicalValue({
      cycleId: context.cycleId,
      stage: context.stage,
      intent: context.intent,
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
  if (usesBuiltInHandlers && LIVE_MUTATION_PENDING[context.stage]) return pendingIntegrationRequest(context);
  if (typeof handler.prepareRequest !== 'function') {
    throw new Error(`stage-driver: handler "${context.stage}" is missing prepareRequest`);
  }
  if (usesBuiltInHandlers && context.stage === 'payout') {
    return assertPreparedRequest(
      await handler.prepareRequest({ config, cycleRepository, context }),
      context.stage,
    );
  }
  return assertPreparedRequest(
    await handler.prepareRequest(isChainJournalHandler(handler)
      ? chainPreparationInput(context, config, adapters, cycleRepository)
      : preparationInput(context, config)),
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
}) {
  if (typeof liveMode !== 'boolean') throw new Error('stage-driver liveMode must be a boolean');
  if (!adapters || typeof adapters !== 'object') throw new Error('stage-driver adapters must be an object');
  if (reconciliationAdapters !== null && typeof reconciliationAdapters !== 'object') {
    throw new Error('stage-driver reconciliationAdapters must be an object or null');
  }
  if (!config || typeof config !== 'object') throw new Error('stage-driver config must be an object');
  if (!cycleRepository) throw new Error('stage-driver cycleRepository is required');
  assertWriteAheadJournal(cycleRepository);
  const usesBuiltInHandlers = stageHandlers === null;
  const handlers = stageHandlers ?? stageHandlersForConfig(config);
  const handlerConfig = stageConfiguration(config);

  return Object.freeze({
    async reconcile(context) {
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
        return toEvidenceValue(await handler.probe({ adapters, config: handlerConfig, cycleRepository, context }));
      }
      if (usesBuiltInHandlers && READ_ONLY_LIVE_RECONCILIATION_STAGES.has(context.stage)) {
        const evidence = await handler.reconcileLive({ adapters, config: handlerConfig, cycleRepository, context });
        return evidence === null ? null : toEvidenceValue(evidence);
      }
      if (usesBuiltInHandlers && context.stage === 'payout') {
        // Payout owns a recipient-level write-ahead journal. It has no single provider request
        // whose response can represent every transfer, so its terminal evidence is reconciled
        // directly from that journal instead of the generic provider-attempt wrapper.
        const evidence = await handler.reconcileLive({
          adapters: reconciliationAdapters ?? adapters,
          config: handlerConfig,
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
            chainReconciliationInput(context, handlerConfig, reconciliationAdapters ?? adapters, cycleRepository),
          );
        } catch (error) {
          await holdKnownFailure({ cycleRepository, context, error });
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
        && LIVE_MUTATION_PENDING[context.stage]
        && !FAIL_CLOSED_UNJOURNALED_STAGES.has(context.stage)) return null;

      let evidence;
      try {
        evidence = await handler.reconcileLive(
          reconciliationInput(context, handlerConfig, reconciliationAdapters, cycleRepository),
        );
      } catch (error) {
        await holdKnownFailure({ cycleRepository, context, error });
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
      const handler = handlerFor(handlers, context);
      if (!liveMode) return;
      const chainJournal = usesBuiltInHandlers && isChainJournalHandler(handler);

      if (usesBuiltInHandlers && READ_ONLY_LIVE_RECONCILIATION_STAGES.has(context.stage)) {
        throw new Error(`stage-driver: "${context.stage}" completes only through read-only reconciliation`);
      }

      if (usesBuiltInHandlers && context.stage === 'payout') {
        try {
          context.assertLease?.();
        } catch (error) {
          await holdKnownFailure({ cycleRepository, context, error });
          throw error;
        }
        let request;
        try {
          request = await prepareRequestForMutation({
            handler,
            usesBuiltInHandlers,
            context,
            config: handlerConfig,
            cycleRepository,
          });
        } catch (error) {
          await holdKnownFailure({ cycleRepository, context, error });
          throw error;
        }
        const preparedRequestDigest = requestDigest(context, request);
        try {
          context.assertLease?.();
        } catch (error) {
          await holdKnownFailure({ cycleRepository, context, error });
          throw error;
        }
        const guard = await authorizeMutation(context, preparedRequestDigest, preflightAuthority);
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
            config: handlerConfig,
            cycleRepository,
            evmNonceFence: nonceFence,
            context: Object.freeze({ ...context, request, requestDigest: preparedRequestDigest }),
            request,
          });
        } catch (error) {
          // Direct payout writes each recipient boundary before it reaches a signer or RPC
          // transport. Its own durable state is therefore the recovery authority.
          await holdKnownFailure({ cycleRepository, context, error });
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
        && LIVE_MUTATION_PENDING[context.stage]) {
        throw new LiveModeIntegrationPendingError(context.stage, LIVE_MUTATION_PENDING[context.stage]);
      }
      let request;
      try {
        request = await prepareRequestForMutation({
          handler,
          usesBuiltInHandlers,
          context,
          config: handlerConfig,
          adapters,
          cycleRepository,
        });
      } catch (error) {
        await holdKnownFailure({ cycleRepository, context, error });
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
      }

      // The service fences the lease before calling the driver. The journal write above can await
      // disk I/O, so fence once more at the last safe point before a handler can reach a provider.
      try {
        context.assertLease?.();
      } catch (error) {
        await holdKnownFailure({ cycleRepository, context, error });
        if (!chainJournal) await cycleRepository.markStageAttemptNotSent(context.cycleId, context.stage);
        throw error;
      }
      if (usesBuiltInHandlers && LIVE_MUTATION_PENDING[context.stage]) {
        throw new LiveModeIntegrationPendingError(context.stage, LIVE_MUTATION_PENDING[context.stage]);
      }
      let guard;
      try {
        guard = await authorizeMutation(context, preparedRequestDigest, preflightAuthority);
      } catch (error) {
        await holdKnownFailure({ cycleRepository, context, error });
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
          config: handlerConfig,
          cycleRepository,
          context: Object.freeze({ ...context, request, requestDigest: preparedRequestDigest }),
          request,
          preflightAuthority,
        });
      } catch (error) {
        await holdKnownFailure({ cycleRepository, context, error });
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
