const canonicalUnsignedInteger = /^(0|[1-9][0-9]*)$/;
const canonicalSignedInteger = /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;

// The durable journal bounds a single event payload to 64 array items / object fields
// (packages/runner/src/cycle/journal.mjs RECOVERY_LIMITS.payloadArrayItems /
// canonicalObjectFields). Collector's documented /api/generateYoloPacks accepts 1-100 packs per
// call, but a pack batch recorded in one journal event cannot exceed that shared bound. Until a
// paged/chunked pack ledger exists, 64 is the system-enforced ceiling, not the provider's.
export const MAXIMUM_PACK_BATCH_SIZE = 64;

export const PACK_OPERATION_STAGES = Object.freeze(['purchase', 'open', 'epic-gate', 'buyback']);

export const OPERATIONAL_CYCLE_STAGES = Object.freeze([
  'eligibility-snapshot',
  'claim-process',
  'outbound',
  'purchase',
  'open',
  'epic-gate',
  'buyback',
  'return',
  'payout',
]);

export const PROVIDER_MUTATION_ATTEMPT_STATES = Object.freeze([
  'PREPARED',
  'NOT_SENT',
  'SENT_UNKNOWN',
  'RESPONSE_RECORDED',
  'RECONCILED',
]);

export const CHAIN_TRANSACTION_ATTEMPT_STATES = Object.freeze([
  'PREPARED',
  'SIGNED',
  'BROADCAST',
  'FINALIZED',
]);

export const RELAY_LEG_DIRECTIONS = Object.freeze(['outbound', 'return']);

export const RELAY_LEG_TERMINAL_STATES = Object.freeze([
  'HELD_RELAY_PARTIAL',
  'HELD_RELAY_REFUND',
  'HELD_RELAY_LATE',
  'HELD_RELAY_WRONG_ASSET',
]);

export const RELAY_LEG_STATES = Object.freeze(['RECORDED', 'SETTLED', ...RELAY_LEG_TERMINAL_STATES]);

export const CYCLE_TERMINAL_STATES = Object.freeze([
  'COMPLETED',
  'FAILED',
  'HELD_DATA_UNVERIFIED',
  'HELD_UNAVAILABLE',
  'HELD_OWNER_DECISION',
  ...RELAY_LEG_TERMINAL_STATES,
]);

export const WALLET_NONCE_RESERVATION_STATES = Object.freeze(['HELD', 'RELEASED']);

export const CUSTODY_LEDGER_BUCKETS = Object.freeze([
  'claimed',
  'bridgeOut',
  'bridgeIn',
  'packCost',
  'buybackProceeds',
  'returnInput',
  'returnReceived',
  'refunds',
  'residual',
  'heldAssets',
  'heldPositions',
  'payoutLiability',
  'dust',
  'unattributed',
]);

const stageSet = new Set(OPERATIONAL_CYCLE_STAGES);
const providerStateSet = new Set(PROVIDER_MUTATION_ATTEMPT_STATES);
const chainStateSet = new Set(CHAIN_TRANSACTION_ATTEMPT_STATES);
const terminalStateSet = new Set(CYCLE_TERMINAL_STATES);

function assertPlainObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  const keys = Object.keys(value);
  if (keys.length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) {
    throw new Error(`${label} must use the exact schema`);
  }
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) throw new Error(`${label} is invalid`);
}

function assertDigest(value, label) {
  if (typeof value !== 'string' || !digestPattern.test(value)) throw new Error(`${label} is invalid`);
}

function assertAtomic(value, label) {
  if (typeof value !== 'string' || !canonicalUnsignedInteger.test(value)) throw new Error(`${label} is invalid`);
}

function assertSignedAtomic(value, label) {
  if (typeof value !== 'string' || !canonicalSignedInteger.test(value)) throw new Error(`${label} is invalid`);
}

function assertStage(value, label) {
  if (typeof value !== 'string' || !stageSet.has(value)) throw new Error(`${label} is invalid`);
}

function clone(value) {
  return structuredClone(value);
}

export function assertTypedAmount(value, label = 'amount') {
  assertPlainObject(value, ['chainId', 'assetId', 'decimals', 'amountAtomic'], label);
  assertNonEmptyString(value.chainId, `${label} chainId`);
  assertNonEmptyString(value.assetId, `${label} assetId`);
  if (!Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255) throw new Error(`${label} decimals is invalid`);
  assertAtomic(value.amountAtomic, `${label} amountAtomic`);
  return clone(value);
}

export function assertCycleTerminalState(value, label = 'cycle terminal state') {
  if (typeof value !== 'string' || !terminalStateSet.has(value)) throw new Error(`${label} is invalid`);
  return value;
}

export function assertProviderMutationAttempt(value, label = 'provider mutation attempt') {
  assertPlainObject(value, [
    'schema',
    'cycleId',
    'stage',
    'state',
    'requestDigest',
    'responseDigest',
    'reconciliationDigest',
  ], label);
  if (value.schema !== 'hookemon.provider-mutation-attempt.v1') throw new Error(`${label} schema is invalid`);
  assertNonEmptyString(value.cycleId, `${label} cycleId`);
  assertStage(value.stage, `${label} stage`);
  if (!providerStateSet.has(value.state)) throw new Error(`${label} state is invalid`);
  assertDigest(value.requestDigest, `${label} requestDigest`);
  if (value.responseDigest !== null) assertDigest(value.responseDigest, `${label} responseDigest`);
  if (value.reconciliationDigest !== null) assertDigest(value.reconciliationDigest, `${label} reconciliationDigest`);
  if ((value.state === 'PREPARED' || value.state === 'NOT_SENT' || value.state === 'SENT_UNKNOWN') && (value.responseDigest !== null || value.reconciliationDigest !== null)) {
    throw new Error(`${label} state cannot contain response or reconciliation evidence`);
  }
  if (value.state === 'RESPONSE_RECORDED' && (value.responseDigest === null || value.reconciliationDigest !== null)) {
    throw new Error(`${label} response-recorded state requires only a response digest`);
  }
  if (value.state === 'RECONCILED' && value.reconciliationDigest === null) {
    throw new Error(`${label} reconciled state requires a reconciliation digest`);
  }
  return clone(value);
}

export function createPreparedProviderMutationAttempt({ cycleId, stage, requestDigest }) {
  return assertProviderMutationAttempt({
    schema: 'hookemon.provider-mutation-attempt.v1',
    cycleId,
    stage,
    state: 'PREPARED',
    requestDigest,
    responseDigest: null,
    reconciliationDigest: null,
  });
}

export function transitionProviderMutationAttempt(value, nextState, evidence = {}) {
  const current = assertProviderMutationAttempt(value);
  const permitted = {
    PREPARED: new Set(['NOT_SENT', 'SENT_UNKNOWN', 'RESPONSE_RECORDED']),
    NOT_SENT: new Set(['PREPARED']),
    SENT_UNKNOWN: new Set(['RESPONSE_RECORDED', 'RECONCILED']),
    RESPONSE_RECORDED: new Set(['RECONCILED']),
    RECONCILED: new Set(),
  };
  if (!permitted[current.state].has(nextState)) throw new Error('provider mutation attempt transition is invalid');
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error('provider mutation attempt transition evidence is invalid');
  const permittedEvidence = new Set(['responseDigest', 'reconciliationDigest']);
  for (const key of Object.keys(evidence)) if (!permittedEvidence.has(key)) throw new Error('provider mutation attempt transition evidence is invalid');
  const next = { ...current, ...evidence, state: nextState };
  return assertProviderMutationAttempt(next);
}

function assertChainSigningMaterial(value, label) {
  assertNonEmptyString(value.rawBytes, `${label} rawBytes`);
  if ((value.nonce === null) === (value.blockhash === null)) throw new Error(`${label} requires exactly one nonce or blockhash`);
  if (value.nonce !== null) assertAtomic(value.nonce, `${label} nonce`);
  if (value.blockhash !== null) assertNonEmptyString(value.blockhash, `${label} blockhash`);
  assertNonEmptyString(value.hash, `${label} hash`);
}

export function assertChainTransactionAttempt(value, label = 'chain transaction attempt') {
  assertPlainObject(value, [
    'schema',
    'cycleId',
    'stage',
    'state',
    'requestDigest',
    'rawBytes',
    'nonce',
    'blockhash',
    'hash',
  ], label);
  if (value.schema !== 'hookemon.chain-transaction-attempt.v1') throw new Error(`${label} schema is invalid`);
  assertNonEmptyString(value.cycleId, `${label} cycleId`);
  assertStage(value.stage, `${label} stage`);
  if (!chainStateSet.has(value.state)) throw new Error(`${label} state is invalid`);
  assertDigest(value.requestDigest, `${label} requestDigest`);
  if (value.state === 'PREPARED') {
    if (value.rawBytes !== null || value.nonce !== null || value.blockhash !== null || value.hash !== null) {
      throw new Error(`${label} prepared state cannot contain signing material`);
    }
  } else {
    assertChainSigningMaterial(value, label);
  }
  return clone(value);
}

export function createPreparedChainTransactionAttempt({ cycleId, stage, requestDigest }) {
  return assertChainTransactionAttempt({
    schema: 'hookemon.chain-transaction-attempt.v1',
    cycleId,
    stage,
    state: 'PREPARED',
    requestDigest,
    rawBytes: null,
    nonce: null,
    blockhash: null,
    hash: null,
  });
}

export const SIGN_ONLY_PRE_SIGN_BINDING_SCHEMA = 'hookemon.sign-only-pre-sign-binding.v1';

/**
 * REQ-cycle-repository-2 `retry-sign-only-with-durable-binding`: the exact material a bounded
 * Keychain sign-only retry may reuse, durably bound before the first sign-only invocation for a
 * PREPARED chain attempt. `unsignedWireBytes` is the canonical encoding of the exact request the
 * signer receives -- not a digest -- so a restart can prove it never regenerated it;
 * `unsignedRequestDigest`, `policyDigest`, and `validityContextDigest` pin the request, the
 * approved policy, and the decoded chain-validity semantics (nonce/blockhash/deadline) a retry or
 * a restart must reproduce unchanged.
 */
export function assertSignOnlyPreSignBinding(value, label = 'sign-only pre-sign binding') {
  assertPlainObject(value, [
    'schema',
    'cycleId',
    'stage',
    'requestDigest',
    'role',
    'account',
    'unsignedWireBytes',
    'unsignedRequestDigest',
    'policyDigest',
    'validityContextDigest',
  ], label);
  if (value.schema !== SIGN_ONLY_PRE_SIGN_BINDING_SCHEMA) throw new Error(`${label} schema is invalid`);
  assertNonEmptyString(value.cycleId, `${label} cycleId`);
  assertStage(value.stage, `${label} stage`);
  assertDigest(value.requestDigest, `${label} requestDigest`);
  assertNonEmptyString(value.role, `${label} role`);
  assertNonEmptyString(value.account, `${label} account`);
  if (typeof value.unsignedWireBytes !== 'string' || value.unsignedWireBytes.length === 0) {
    throw new Error(`${label} unsignedWireBytes is invalid`);
  }
  assertDigest(value.unsignedRequestDigest, `${label} unsignedRequestDigest`);
  assertDigest(value.policyDigest, `${label} policyDigest`);
  assertDigest(value.validityContextDigest, `${label} validityContextDigest`);
  return clone(value);
}

export const SIGN_ONLY_INVOCATION_LEDGER_SCHEMA = 'hookemon.sign-only-invocation-ledger.v1';

export const SIGN_ONLY_INVOCATION_LEDGER_STATES = Object.freeze([
  'ORDINAL_1_ALLOCATED',
  'ORDINAL_1_TIMED_OUT',
  'ORDINAL_2_ALLOCATED',
  'ORDINAL_2_TIMED_OUT',
]);

const signOnlyInvocationLedgerStateSet = new Set(SIGN_ONLY_INVOCATION_LEDGER_STATES);

/**
 * REQ-cycle-repository-2 `retry-sign-only-with-durable-binding`: the durable invocation budget for
 * one sign-only pre-sign binding, independent of any single process's local retry logic. Exactly
 * two invocation ordinals ever exist for a binding. `ORDINAL_1_ALLOCATED` permits calling Keychain
 * once; a classified timeout durably advances to `ORDINAL_1_TIMED_OUT`, which is the only state
 * that ever permits allocating `ORDINAL_2_ALLOCATED`. `ORDINAL_2_TIMED_OUT` is terminal -- no third
 * ordinal exists. A crash, a generic error, or a proven pre-invocation denial after an allocation
 * never advances this record, so no later caller (a restart, a concurrent second wrapper, or the
 * same process) can ever treat that ambiguous outcome as eligible for another invocation.
 */
export function assertSignOnlyInvocationLedger(value, label = 'sign-only invocation ledger') {
  assertPlainObject(value, ['schema', 'cycleId', 'stage', 'requestDigest', 'state'], label);
  if (value.schema !== SIGN_ONLY_INVOCATION_LEDGER_SCHEMA) throw new Error(`${label} schema is invalid`);
  assertNonEmptyString(value.cycleId, `${label} cycleId`);
  assertStage(value.stage, `${label} stage`);
  assertDigest(value.requestDigest, `${label} requestDigest`);
  if (!signOnlyInvocationLedgerStateSet.has(value.state)) throw new Error(`${label} state is invalid`);
  return clone(value);
}

export function createReservedSignOnlyInvocationLedger({ cycleId, stage, requestDigest }) {
  return assertSignOnlyInvocationLedger({
    schema: SIGN_ONLY_INVOCATION_LEDGER_SCHEMA,
    cycleId,
    stage,
    requestDigest,
    state: 'ORDINAL_1_ALLOCATED',
  });
}

export function transitionSignOnlyInvocationLedger(value, nextState) {
  const current = assertSignOnlyInvocationLedger(value);
  const permitted = {
    ORDINAL_1_ALLOCATED: new Set(['ORDINAL_1_TIMED_OUT']),
    ORDINAL_1_TIMED_OUT: new Set(['ORDINAL_2_ALLOCATED']),
    ORDINAL_2_ALLOCATED: new Set(['ORDINAL_2_TIMED_OUT']),
    ORDINAL_2_TIMED_OUT: new Set(),
  };
  if (!permitted[current.state].has(nextState)) throw new Error('sign-only invocation ledger transition is invalid');
  return assertSignOnlyInvocationLedger({ ...current, state: nextState });
}

export function transitionChainTransactionAttempt(value, nextState, evidence = {}) {
  const current = assertChainTransactionAttempt(value);
  const permitted = {
    PREPARED: new Set(['SIGNED']),
    SIGNED: new Set(['BROADCAST']),
    BROADCAST: new Set(['FINALIZED']),
    FINALIZED: new Set(),
  };
  if (!permitted[current.state].has(nextState)) throw new Error('chain transaction attempt transition is invalid');
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error('chain transaction attempt transition evidence is invalid');
  const evidenceKeys = Object.keys(evidence).sort();
  if (current.state === 'PREPARED') {
    const signingKeys = ['blockhash', 'hash', 'nonce', 'rawBytes'];
    if (evidenceKeys.length !== signingKeys.length || evidenceKeys.some((key, index) => key !== signingKeys[index])) {
      throw new Error('chain transaction attempt signing evidence is invalid');
    }
  } else if (evidenceKeys.length !== 0) {
    throw new Error('chain transaction attempt transition evidence is immutable after signing');
  }
  return assertChainTransactionAttempt({ ...current, ...evidence, state: nextState });
}

/**
 * Custody ledgers written before `heldPositions` existed carry the other thirteen buckets and
 * nothing else. Replay must still be able to read them, so a stored value missing exactly that one
 * bucket is completed with '0' -- the truthful historical figure, since the bucket it stands for did
 * not exist when the record was written. Only reads opt into this; every write still has to supply
 * the full canonical set, so nothing new is ever persisted in the legacy shape.
 */
const LEGACY_OPTIONAL_CUSTODY_BUCKETS = Object.freeze(['heldPositions']);

function completeLegacyCustodyBuckets(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const missing = LEGACY_OPTIONAL_CUSTODY_BUCKETS.filter(bucket => !Object.hasOwn(value, bucket));
  if (missing.length === 0) return value;
  return { ...value, ...Object.fromEntries(missing.map(bucket => [bucket, '0'])) };
}

export const CUSTODY_BALANCE_OBSERVATION_FIELDS = Object.freeze(['schema', 'account', 'balance', 'finality']);

/** CustodyBalanceObservationV1 (ADR-0026): a finalized observed on-chain balance, not a valuation. */
export function assertCustodyBalanceObservation(value, label = 'custody balance observation') {
  assertPlainObject(value, CUSTODY_BALANCE_OBSERVATION_FIELDS, label);
  if (value.schema !== 'hookemon.custody-balance-observation.v1') throw new Error(`${label} schema is invalid`);
  assertNonEmptyString(value.account, `${label} account`);
  const balance = assertTypedAmount(value.balance, `${label} balance`);
  const finality = assertRelayFinality(value.finality, `${label} finality`);
  return { schema: value.schema, account: value.account, balance, finality };
}

const CUSTODY_LEDGER_V2_FIELDS = Object.freeze(['verifiedCurrentBalance', 'expectedCycleAsset']);

function assertCustodyRowIdentity(value, rowIdentity, label) {
  if (value.chainId !== rowIdentity.chainId || value.assetId !== rowIdentity.assetId || value.decimals !== rowIdentity.decimals) {
    throw new Error(`${label} identity must equal the custody ledger row's own chainId, assetId, and decimals`);
  }
}

/**
 * hookemon.custody-ledger.v1 or hookemon.custody-ledger.v2 (ADR-0026). v2 keeps every v1 field,
 * bucket, and key unchanged and adds exactly `verifiedCurrentBalance` and `expectedCycleAsset`; a
 * non-null value of either must carry the row's own canonical chainId/assetId/decimals exactly.
 */
export function assertCustodyLedger(value, label = 'custody ledger', { allowLegacyBuckets = false } = {}) {
  if (allowLegacyBuckets) value = completeLegacyCustodyBuckets(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be a plain object`);
  if (value.schema !== 'hookemon.custody-ledger.v1' && value.schema !== 'hookemon.custody-ledger.v2' && value.schema !== 'hookemon.custody-ledger.v3') {
    throw new Error(`${label} schema is invalid`);
  }
  const isV3 = value.schema === 'hookemon.custody-ledger.v3';
  const isV2 = value.schema === 'hookemon.custody-ledger.v2' || isV3;
  const fields = isV2
    ? ['schema', 'cycleId', 'chainId', 'assetId', 'decimals', ...CUSTODY_LEDGER_BUCKETS, ...CUSTODY_LEDGER_V2_FIELDS, ...(isV3 ? ['gasReserve', 'gasSpent'] : [])]
    : ['schema', 'cycleId', 'chainId', 'assetId', 'decimals', ...CUSTODY_LEDGER_BUCKETS];
  assertPlainObject(value, fields, label);
  assertNonEmptyString(value.cycleId, `${label} cycleId`);
  assertNonEmptyString(value.chainId, `${label} chainId`);
  assertNonEmptyString(value.assetId, `${label} assetId`);
  if (!Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255) throw new Error(`${label} decimals is invalid`);
  for (const bucket of CUSTODY_LEDGER_BUCKETS) assertAtomic(value[bucket], `${label} ${bucket}`);
  if (isV3) {
    if (value.chainId !== '4663' || value.assetId !== 'native' || value.decimals !== 18) throw new Error(`${label} v3 requires native ETH identity`);
    for (const name of ['gasReserve', 'gasSpent']) {
      const gas = assertTypedAmount(value[name], `${label} ${name}`);
      assertCustodyRowIdentity(gas, value, `${label} ${name}`);
    }
  }
  if (!isV2) return clone(value);
  const rowIdentity = { chainId: value.chainId, assetId: value.assetId, decimals: value.decimals };
  if (value.verifiedCurrentBalance !== null) {
    const observation = assertCustodyBalanceObservation(value.verifiedCurrentBalance, `${label} verifiedCurrentBalance`);
    assertCustodyRowIdentity(observation.balance, rowIdentity, `${label} verifiedCurrentBalance balance`);
  }
  if (value.expectedCycleAsset !== null) {
    const expected = assertTypedAmount(value.expectedCycleAsset, `${label} expectedCycleAsset`);
    assertCustodyRowIdentity(expected, rowIdentity, `${label} expectedCycleAsset`);
  }
  return clone(value);
}

export function assertTransactionPolicy(value, label = 'transaction policy') {
  assertPlainObject(value, [
    'schema',
    'chainId',
    'stage',
    'requestDigest',
    'expectedRecipient',
    'amount',
    'allowedTargets',
    'allowedPrograms',
  ], label);
  if (value.schema !== 'hookemon.transaction-policy.v1') throw new Error(`${label} schema is invalid`);
  assertNonEmptyString(value.chainId, `${label} chainId`);
  assertStage(value.stage, `${label} stage`);
  assertDigest(value.requestDigest, `${label} requestDigest`);
  assertNonEmptyString(value.expectedRecipient, `${label} expectedRecipient`);
  const amount = assertTypedAmount(value.amount, `${label} amount`);
  if (amount.chainId !== value.chainId) throw new Error(`${label} amount chainId is invalid`);
  for (const field of ['allowedTargets', 'allowedPrograms']) {
    if (!Array.isArray(value[field])) throw new Error(`${label} ${field} is invalid`);
    const seen = new Set();
    for (const entry of value[field]) {
      assertNonEmptyString(entry, `${label} ${field}`);
      if (seen.has(entry)) throw new Error(`${label} ${field} must be unique`);
      seen.add(entry);
    }
  }
  if (value.allowedTargets.length === 0 && value.allowedPrograms.length === 0) throw new Error(`${label} must allow a target or program`);
  return clone(value);
}

// ---------------------------------------------------------------------------------------------------
// Revision 63 money-path records. RelayLegV1, StandingAuthorityDecisionV1, WalletNonceReservationV1,
// and MoneyConfigurationV1 are validated here so the repository, the stages, and the configuration
// boundary share one canonical shape.

const relayLegStateSet = new Set(RELAY_LEG_STATES);
const relayLegDirectionSet = new Set(RELAY_LEG_DIRECTIONS);
const isoTimestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const fencingTokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;

export const RELAY_LEG_FIELDS = Object.freeze([
  'schema',
  'cycleId',
  'direction',
  'relayRequestId',
  'quoteDigest',
  'sourceChainId',
  'sourceTxHash',
  'sourceAssetId',
  'sourceDecimals',
  'sourceAmountAtomic',
  'destinationChainId',
  'destinationTxHash',
  'destinationAssetId',
  'destinationDecimals',
  'destinationAmountAtomic',
  'finalizedAtSource',
  'finalizedAtDestination',
  'netDeltaAtomic',
  'state',
]);

const RETURN_LEG_ATTRIBUTION_FIELDS = Object.freeze([
  'schema',
  'intent',
  'requestCreatedAtUnixSeconds',
  'maxSettlementWindowSeconds',
]);

const RETURN_RELAY_INTENT_FIELDS = Object.freeze([
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

// The Relay client (packages/adapters/src/relay-client.mjs RELAY_INTENT_KEYS) has carried
// tradeType and quoteDigest since revision67's Relay client; both fields are required together
// or not at all — a record predating that client has neither, one recorded with it has both.
const RETURN_RELAY_INTENT_FIELDS_WITH_TRADE_EVIDENCE = Object.freeze([
  'schema',
  'requestId',
  'orderId',
  'direction',
  'tradeType',
  'quoteDigest',
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

// Mirrors relay-client.mjs's own TRADE_TYPES exactly; this is the producer's enum, not a new one.
const RETURN_RELAY_INTENT_TRADE_TYPES = new Set(['EXACT_INPUT', 'EXACT_OUTPUT', 'EXPECTED_OUTPUT']);

export const RETURN_LEG_DESTINATION_PROOF_FIELDS = Object.freeze([
  'schema',
  'relayRequestId',
  'terminalStatus',
  'sourceTxHash',
  'sourceFinality',
  'destinationTxHash',
  'destinationFinality',
  'transferCount',
  'observedToken',
  'observedRecipient',
  'observedAmountAtomic',
]);

const evmAddressPattern = /^0x[0-9a-f]{40}$/;
const evmTransactionHashPattern = /^0x[0-9a-f]{64}$/;

function assertDecimals(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error(`${label} is invalid`);
}

function assertNullableString(value, label) {
  if (value !== null) assertNonEmptyString(value, label);
}

function assertReturnRelayIntent(value, relayRequestId, label) {
  const isPlainObject = value && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
  const hasTradeType = isPlainObject && Object.hasOwn(value, 'tradeType');
  const hasQuoteDigest = isPlainObject && Object.hasOwn(value, 'quoteDigest');
  if (hasTradeType !== hasQuoteDigest) {
    throw new Error(`${label} must carry tradeType and quoteDigest together or neither`);
  }
  const carriesTradeEvidence = hasTradeType;
  assertPlainObject(value, carriesTradeEvidence ? RETURN_RELAY_INTENT_FIELDS_WITH_TRADE_EVIDENCE : RETURN_RELAY_INTENT_FIELDS, label);
  if (value.schema !== 'hookemon.relay-intent.v1' && value.schema !== 'hookemon.relay-intent.v2') throw new Error(`${label} schema is invalid`);
  if (value.requestId !== relayRequestId) throw new Error(`${label} requestId does not match its Relay leg`);
  if (value.direction !== 'RETURN') throw new Error(`${label} direction is invalid`);
  if (carriesTradeEvidence) {
    if (typeof value.tradeType !== 'string' || !RETURN_RELAY_INTENT_TRADE_TYPES.has(value.tradeType)) {
      throw new Error(`${label} tradeType is invalid`);
    }
    assertDigest(value.quoteDigest, `${label} quoteDigest`);
  }
  if (!Number.isSafeInteger(value.originChainId) || value.originChainId <= 0
    || !Number.isSafeInteger(value.destinationChainId) || value.destinationChainId <= 0) {
    throw new Error(`${label} chain identity is invalid`);
  }
  for (const field of ['orderId', 'originAssetId', 'destinationAssetId', 'sender', 'recipient']) {
    assertNonEmptyString(value[field], `${label} ${field}`);
  }
  for (const field of ['originDecimals', 'destinationDecimals']) assertDecimals(value[field], `${label} ${field}`);
  assertAtomic(value.originAmount, `${label} originAmount`);
  assertAtomic(value.quotedDestinationAmount, `${label} quotedDestinationAmount`);
  if (value.quotedDestinationMinimumAmount !== null) {
    assertAtomic(value.quotedDestinationMinimumAmount, `${label} quotedDestinationMinimumAmount`);
  }
  if (!Number.isSafeInteger(value.deadlineUnixSeconds) || value.deadlineUnixSeconds <= 0) {
    throw new Error(`${label} deadlineUnixSeconds is invalid`);
  }
  return clone(value);
}

function assertReturnLegAttribution(value, leg, label) {
  assertPlainObject(value, RETURN_LEG_ATTRIBUTION_FIELDS, label);
  if (value.schema !== 'hookemon.return-leg-attribution-context.v1') throw new Error(`${label} schema is invalid`);
  const intent = assertReturnRelayIntent(value.intent, leg.relayRequestId, `${label} intent`);
  if (String(intent.originChainId) !== leg.sourceChainId
    || intent.originAssetId !== leg.sourceAssetId
    || intent.originDecimals !== leg.sourceDecimals
    || intent.originAmount !== leg.sourceAmountAtomic) {
    throw new Error(`${label} intent origin route and amount do not match its Relay leg`);
  }
  if (String(intent.destinationChainId) !== leg.destinationChainId
    || intent.destinationAssetId.toLowerCase() !== leg.destinationAssetId.toLowerCase()
    || intent.destinationDecimals !== leg.destinationDecimals
    || intent.quotedDestinationAmount !== leg.destinationAmountAtomic) {
    throw new Error(`${label} intent destination route and amount do not match its Relay leg`);
  }
  assertAtomic(value.requestCreatedAtUnixSeconds, `${label} requestCreatedAtUnixSeconds`);
  assertAtomic(value.maxSettlementWindowSeconds, `${label} maxSettlementWindowSeconds`);
  if (BigInt(value.maxSettlementWindowSeconds) === 0n) throw new Error(`${label} maxSettlementWindowSeconds must be positive`);
  return Object.freeze({
    schema: value.schema,
    intent,
    requestCreatedAtUnixSeconds: value.requestCreatedAtUnixSeconds,
    maxSettlementWindowSeconds: value.maxSettlementWindowSeconds,
  });
}

export function assertRelayFinality(value, label = 'relay finality') {
  assertPlainObject(value, ['height', 'hash', 'timestampUnixSeconds'], label);
  assertAtomic(value.height, `${label} height`);
  assertNonEmptyString(value.hash, `${label} hash`);
  if (value.timestampUnixSeconds !== null) assertAtomic(value.timestampUnixSeconds, `${label} timestampUnixSeconds`);
  return clone(value);
}

export function assertRelayLeg(value, label = 'relay leg') {
  const fields = value?.direction === 'return'
    ? [...RELAY_LEG_FIELDS, 'returnAttribution']
    : RELAY_LEG_FIELDS;
  assertPlainObject(value, fields, label);
  if (value.schema !== 'hookemon.relay-leg.v1' && value.schema !== 'hookemon.relay-leg.v2') throw new Error(`${label} schema is invalid`);
  assertNonEmptyString(value.cycleId, `${label} cycleId`);
  if (!relayLegDirectionSet.has(value.direction)) throw new Error(`${label} direction is invalid`);
  assertNonEmptyString(value.relayRequestId, `${label} relayRequestId`);
  assertDigest(value.quoteDigest, `${label} quoteDigest`);
  assertNonEmptyString(value.sourceChainId, `${label} sourceChainId`);
  assertNullableString(value.sourceTxHash, `${label} sourceTxHash`);
  assertNonEmptyString(value.sourceAssetId, `${label} sourceAssetId`);
  assertDecimals(value.sourceDecimals, `${label} sourceDecimals`);
  assertAtomic(value.sourceAmountAtomic, `${label} sourceAmountAtomic`);
  if (BigInt(value.sourceAmountAtomic) === 0n) throw new Error(`${label} sourceAmountAtomic must be positive`);
  assertNonEmptyString(value.destinationChainId, `${label} destinationChainId`);
  assertNullableString(value.destinationTxHash, `${label} destinationTxHash`);
  assertNonEmptyString(value.destinationAssetId, `${label} destinationAssetId`);
  assertDecimals(value.destinationDecimals, `${label} destinationDecimals`);
  assertAtomic(value.destinationAmountAtomic, `${label} destinationAmountAtomic`);
  if (value.sourceChainId === value.destinationChainId) throw new Error(`${label} must bridge between two chains`);
  if (value.direction === 'return') {
    assertReturnLegAttribution(value.returnAttribution, value, `${label} returnAttribution`);
  }
  if (value.finalizedAtSource !== null) assertRelayFinality(value.finalizedAtSource, `${label} finalizedAtSource`);
  if (value.finalizedAtDestination !== null) assertRelayFinality(value.finalizedAtDestination, `${label} finalizedAtDestination`);
  if (value.netDeltaAtomic !== null) assertSignedAtomic(value.netDeltaAtomic, `${label} netDeltaAtomic`);
  if (!relayLegStateSet.has(value.state)) throw new Error(`${label} state is invalid`);
  if (value.state === 'RECORDED') {
    if (value.destinationTxHash !== null || value.finalizedAtSource !== null || value.finalizedAtDestination !== null || value.netDeltaAtomic !== null) {
      throw new Error(`${label} recorded state cannot carry settlement evidence`);
    }
  } else {
    if (value.sourceTxHash === null) throw new Error(`${label} ${value.state} requires a sourceTxHash`);
    if (value.finalizedAtSource === null) throw new Error(`${label} ${value.state} requires finalizedAtSource`);
  }
  if (value.state === 'SETTLED') {
    if (value.destinationTxHash === null) throw new Error(`${label} SETTLED requires a destinationTxHash`);
    if (value.finalizedAtDestination === null) throw new Error(`${label} SETTLED requires finalizedAtDestination`);
    if (value.netDeltaAtomic === null || BigInt(value.netDeltaAtomic) <= 0n) throw new Error(`${label} SETTLED requires a positive netDeltaAtomic`);
  }
  if (value.destinationTxHash !== null && value.finalizedAtDestination === null && value.state !== 'RECORDED') {
    throw new Error(`${label} destinationTxHash requires finalizedAtDestination`);
  }
  return clone(value);
}

export function createRecordedRelayLeg({ cycleId, direction, relayRequestId, quoteDigest, source, destination, returnAttribution = undefined }) {
  const sourceAmount = assertTypedAmount(source, 'relay leg source');
  const destinationAmount = assertTypedAmount(destination, 'relay leg destination');
  const leg = {
    schema: [sourceAmount, destinationAmount].some(amount => amount.chainId === '4663' && amount.assetId === 'native' && amount.decimals === 18) ? 'hookemon.relay-leg.v2' : 'hookemon.relay-leg.v1',
    cycleId,
    direction,
    relayRequestId,
    quoteDigest,
    sourceChainId: sourceAmount.chainId,
    sourceTxHash: null,
    sourceAssetId: sourceAmount.assetId,
    sourceDecimals: sourceAmount.decimals,
    sourceAmountAtomic: sourceAmount.amountAtomic,
    destinationChainId: destinationAmount.chainId,
    destinationTxHash: null,
    destinationAssetId: destinationAmount.assetId,
    destinationDecimals: destinationAmount.decimals,
    destinationAmountAtomic: destinationAmount.amountAtomic,
    finalizedAtSource: null,
    finalizedAtDestination: null,
    netDeltaAtomic: null,
    state: 'RECORDED',
  };
  if (direction === 'return') leg.returnAttribution = returnAttribution;
  return assertRelayLeg(leg);
}

/** Binds the signed source transaction hash to a recorded leg exactly once. */
export function attributeRelayLegSource(value, { sourceTxHash }) {
  const current = assertRelayLeg(value);
  if (current.state !== 'RECORDED') throw new Error('relay leg source can be attributed only while RECORDED');
  assertNonEmptyString(sourceTxHash, 'relay leg sourceTxHash');
  if (current.sourceTxHash !== null && current.sourceTxHash !== sourceTxHash) {
    throw new Error('relay leg source transaction hash is already attributed');
  }
  return assertRelayLeg({ ...current, sourceTxHash });
}

const RELAY_LEG_SETTLEMENT_EVIDENCE = Object.freeze(['finalizedAtSource', 'destinationTxHash', 'finalizedAtDestination', 'netDeltaAtomic']);

/** RECORDED -> SETTLED or RECORDED -> HELD_RELAY_*; every terminal state is final. */
export function transitionRelayLeg(value, nextState, evidence = {}) {
  const current = assertRelayLeg(value);
  if (current.state !== 'RECORDED') throw new Error('relay leg transition is invalid');
  if (nextState !== 'SETTLED' && !RELAY_LEG_TERMINAL_STATES.includes(nextState)) throw new Error('relay leg transition is invalid');
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) throw new Error('relay leg transition evidence is invalid');
  const keys = Object.keys(evidence).sort();
  if (keys.length !== RELAY_LEG_SETTLEMENT_EVIDENCE.length || keys.some((key, index) => key !== [...RELAY_LEG_SETTLEMENT_EVIDENCE].sort()[index])) {
    throw new Error('relay leg transition evidence must name finalizedAtSource, destinationTxHash, finalizedAtDestination, and netDeltaAtomic');
  }
  if (current.sourceTxHash === null) throw new Error('relay leg transition requires an attributed sourceTxHash');
  return assertRelayLeg({ ...current, ...clone(evidence), state: nextState });
}

/**
 * A destination receipt proof is durable evidence, not a Relay-provider assertion. Its terminal
 * status contains only the provider-reported transaction-hash pointer; the receipt finality and
 * exact transfer facts are independently observed by this process before this value is created.
 */
export function assertReturnLegDestinationProof(value, label = 'return leg destination proof') {
  const native = value?.schema === 'hookemon.return-leg-destination-proof.v2';
  assertPlainObject(value, native ? [...RETURN_LEG_DESTINATION_PROOF_FIELDS, 'nativePaymentProof'] : RETURN_LEG_DESTINATION_PROOF_FIELDS, label);
  if (!native && value.schema !== 'hookemon.return-leg-destination-proof.v1') throw new Error(`${label} schema is invalid`);
  assertNonEmptyString(value.relayRequestId, `${label} relayRequestId`);
  assertPlainObject(value.terminalStatus, ['status', 'destinationTxHash'], `${label} terminalStatus`);
  if (value.terminalStatus.status !== 'SUCCESS') throw new Error(`${label} terminalStatus is invalid`);
  if (typeof value.destinationTxHash !== 'string' || !evmTransactionHashPattern.test(value.destinationTxHash)) {
    throw new Error(`${label} destinationTxHash is invalid`);
  }
  if (value.terminalStatus.destinationTxHash !== value.destinationTxHash) {
    throw new Error(`${label} terminalStatus does not point to its destinationTxHash`);
  }
  assertNonEmptyString(value.sourceTxHash, `${label} sourceTxHash`);
  assertRelayFinality(value.sourceFinality, `${label} sourceFinality`);
  assertRelayFinality(value.destinationFinality, `${label} destinationFinality`);
  if (!Number.isInteger(value.transferCount) || value.transferCount !== 1) {
    throw new Error(`${label} transferCount must equal one`);
  }
  if (native ? value.observedToken !== 'native' : (typeof value.observedToken !== 'string' || !evmAddressPattern.test(value.observedToken))) {
    throw new Error(`${label} observedToken is invalid`);
  }
  if (typeof value.observedRecipient !== 'string' || !evmAddressPattern.test(value.observedRecipient)) {
    throw new Error(`${label} observedRecipient is invalid`);
  }
  if (native) {
    const proof = value.nativePaymentProof;
    if (!proof || proof.schema !== 'hookemon.native-payment-proof.v1' || proof.kind !== 'relay-return'
      || proof.chainId !== '4663' || proof.assetId !== 'native' || proof.decimals !== 18
      || proof.transactionHash !== value.destinationTxHash || proof.sourceTransactionHash !== value.sourceTxHash
      || proof.relayRequestId !== value.relayRequestId || proof.recipient !== value.observedRecipient
      || proof.amountWei !== value.observedAmountAtomic || proof.blockNumber !== value.destinationFinality.height
      || proof.blockHash !== value.destinationFinality.hash || proof.timestampUnixSeconds !== value.destinationFinality.timestampUnixSeconds) {
      throw new Error(`${label} native payment evidence is inconsistent`);
    }
  }
  assertAtomic(value.observedAmountAtomic, `${label} observedAmountAtomic`);
  return clone(value);
}

export function assertStandingAuthorityDecision(value, label = 'standing authority decision') {
  assertPlainObject(value, ['schema', 'authorityDigest', 'verifiedAt', 'intentDigest', 'dayCapReservation', 'nonceReservation'], label);
  if (value.schema !== 'hookemon.standing-authority-decision.v1') throw new Error(`${label} schema is invalid`);
  assertDigest(value.authorityDigest, `${label} authorityDigest`);
  if (typeof value.verifiedAt !== 'string' || !isoTimestampPattern.test(value.verifiedAt) || new Date(value.verifiedAt).toISOString() !== value.verifiedAt) {
    throw new Error(`${label} verifiedAt is invalid`);
  }
  assertDigest(value.intentDigest, `${label} intentDigest`);
  assertPlainObject(value.dayCapReservation, ['day', 'reservationKey'], `${label} dayCapReservation`);
  if (typeof value.dayCapReservation.day !== 'string' || !dayPattern.test(value.dayCapReservation.day) || value.dayCapReservation.day !== value.verifiedAt.slice(0, 10)) {
    throw new Error(`${label} dayCapReservation day must equal the verifiedAt day`);
  }
  assertDigest(value.dayCapReservation.reservationKey, `${label} dayCapReservation reservationKey`);
  assertPlainObject(value.nonceReservation, ['nonce', 'reservationKey'], `${label} nonceReservation`);
  if (typeof value.nonceReservation.nonce !== 'string' || !identifierPattern.test(value.nonceReservation.nonce)) {
    throw new Error(`${label} nonceReservation nonce is invalid`);
  }
  assertDigest(value.nonceReservation.reservationKey, `${label} nonceReservation reservationKey`);
  return clone(value);
}

export function assertWalletNonceReservation(value, label = 'wallet nonce reservation') {
  assertPlainObject(value, [
    'schema',
    'chainId',
    'wallet',
    'cycleId',
    'stage',
    'fencingToken',
    'leaseAcquiredAtMs',
    'leaseExpiresAtMs',
    'state',
  ], label);
  if (value.schema !== 'hookemon.wallet-nonce-reservation.v1') throw new Error(`${label} schema is invalid`);
  assertNonEmptyString(value.chainId, `${label} chainId`);
  assertNonEmptyString(value.wallet, `${label} wallet`);
  assertNonEmptyString(value.cycleId, `${label} cycleId`);
  assertStage(value.stage, `${label} stage`);
  if (typeof value.fencingToken !== 'string' || !fencingTokenPattern.test(value.fencingToken)) throw new Error(`${label} fencingToken is invalid`);
  if (!Number.isSafeInteger(value.leaseAcquiredAtMs) || value.leaseAcquiredAtMs < 0) {
    throw new Error(`${label} leaseAcquiredAtMs is invalid`);
  }
  if (!Number.isSafeInteger(value.leaseExpiresAtMs) || value.leaseExpiresAtMs <= value.leaseAcquiredAtMs) {
    throw new Error(`${label} leaseExpiresAtMs is invalid`);
  }
  if (!WALLET_NONCE_RESERVATION_STATES.includes(value.state)) throw new Error(`${label} state is invalid`);
  return clone(value);
}

function assertConfiguredAsset(value, label) {
  assertPlainObject(value, ['chainId', 'assetId', 'decimals'], label);
  assertNonEmptyString(value.chainId, `${label} chainId`);
  assertNonEmptyString(value.assetId, `${label} assetId`);
  assertDecimals(value.decimals, `${label} decimals`);
  return clone(value);
}

function assertMoneyAmount(value, asset, label) {
  const amount = assertTypedAmount(value, label);
  if (amount.chainId !== asset.chainId || amount.assetId !== asset.assetId || amount.decimals !== asset.decimals) {
    throw new Error(`${label} must use the configured ${asset.assetId} asset on chain ${asset.chainId}`);
  }
  if (BigInt(amount.amountAtomic) === 1n) {
    throw new Error(`${label} atomic value 1 is a placeholder and is a configuration error`);
  }
  return amount;
}

export const MONEY_CONFIGURATION_SCHEMA = 'hookemon.money-configuration.v2';

/**
 * MoneyConfigurationV1: every money minimum and gas cap is an explicit TypedAmount. A missing field
 * or the literal atomic value 1 is a configuration error rather than a default.
 */
export function assertMoneyConfiguration(value, label = 'money configuration') {
  assertPlainObject(value, ['schema', 'assets', 'minimums', 'evm', 'solana'], label);
  if (value.schema !== MONEY_CONFIGURATION_SCHEMA) throw new Error(`${label} schema is invalid`);
  assertPlainObject(value.assets, ['eth', 'solanaStablecoin'], `${label} assets`);
  const eth = assertConfiguredAsset(value.assets.eth, `${label} assets eth`);
  if (eth.chainId !== '4663' || eth.assetId !== 'native' || eth.decimals !== 18) throw new Error(`${label} native ETH identity is invalid`);
  const solanaStablecoin = assertConfiguredAsset(value.assets.solanaStablecoin, `${label} assets solanaStablecoin`);
  if (eth.chainId === solanaStablecoin.chainId) throw new Error(`${label} assets must be distinct chains`);
  assertPlainObject(value.minimums, ['robinhoodReceive', 'solanaReceive', 'returnEth'], `${label} minimums`);
  if (!value.evm || typeof value.evm !== 'object' || Array.isArray(value.evm) || !Object.hasOwn(value.evm, 'perTransactionGasPriceCap')) {
    throw new Error(`${label} evm perTransactionGasPriceCap is required`);
  }
  if (!Object.hasOwn(value.evm, 'nativeReserve')) throw new Error(`${label} evm nativeReserve is required`);
  assertPlainObject(value.evm, ['perTransactionGasPriceCap', 'nativeReserve'], `${label} evm`);
  if (!value.solana || typeof value.solana !== 'object' || Array.isArray(value.solana) || !Object.hasOwn(value.solana, 'priorityFeeCap')) {
    throw new Error(`${label} solana priorityFeeCap is required`);
  }
  if (!Object.hasOwn(value.solana, 'lamportReserve')) throw new Error(`${label} solana lamportReserve is required`);
  assertPlainObject(value.solana, ['priorityFeeCap', 'lamportReserve'], `${label} solana`);
  const evmNative = { chainId: eth.chainId, assetId: 'native', decimals: 18 };
  const solanaNative = { chainId: solanaStablecoin.chainId, assetId: 'native', decimals: 9 };
  const computeUnitPrice = { chainId: solanaStablecoin.chainId, assetId: 'microlamports-per-compute-unit', decimals: 0 };
  const returnEth = assertMoneyAmount(value.minimums.returnEth, eth, `${label} minimums returnEth`);
  if (returnEth.amountAtomic !== '0') {
    throw new Error(`${label} minimums returnEth must be the revision-63 zero value`);
  }
  return {
    schema: MONEY_CONFIGURATION_SCHEMA,
    assets: { eth, solanaStablecoin },
    minimums: {
      robinhoodReceive: assertMoneyAmount(value.minimums.robinhoodReceive, eth, `${label} minimums robinhoodReceive`),
      solanaReceive: assertMoneyAmount(value.minimums.solanaReceive, solanaStablecoin, `${label} minimums solanaReceive`),
      returnEth,
    },
    evm: {
      perTransactionGasPriceCap: assertMoneyAmount(value.evm.perTransactionGasPriceCap, evmNative, `${label} evm perTransactionGasPriceCap`),
      nativeReserve: assertMoneyAmount(value.evm.nativeReserve, evmNative, `${label} evm nativeReserve`),
    },
    solana: {
      priorityFeeCap: assertMoneyAmount(value.solana.priorityFeeCap, computeUnitPrice, `${label} solana priorityFeeCap`),
      lamportReserve: assertMoneyAmount(value.solana.lamportReserve, solanaNative, `${label} solana lamportReserve`),
    },
  };
}

/** Read-only decoder for historical USDG configuration; never use for native admission. */
export function assertHistoricalMoneyConfiguration(value, label = 'money configuration') {
  assertPlainObject(value, ['schema', 'assets', 'minimums', 'evm', 'solana'], label);
  if (value.schema !== 'hookemon.money-configuration.v1') throw new Error(`${label} schema is invalid`);
  assertPlainObject(value.assets, ['usdg', 'solanaStablecoin'], `${label} assets`);
  const usdg = assertConfiguredAsset(value.assets.usdg, `${label} assets usdg`);
  const solanaStablecoin = assertConfiguredAsset(value.assets.solanaStablecoin, `${label} assets solanaStablecoin`);
  if (usdg.chainId === solanaStablecoin.chainId) throw new Error(`${label} assets must be distinct chains`);
  assertPlainObject(value.minimums, ['robinhoodReceive', 'solanaReceive', 'returnUsdg'], `${label} minimums`);
  if (!value.evm || typeof value.evm !== 'object' || Array.isArray(value.evm) || !Object.hasOwn(value.evm, 'perTransactionGasPriceCap')) {
    throw new Error(`${label} evm perTransactionGasPriceCap is required`);
  }
  if (!Object.hasOwn(value.evm, 'nativeReserve')) throw new Error(`${label} evm nativeReserve is required`);
  assertPlainObject(value.evm, ['perTransactionGasPriceCap', 'nativeReserve'], `${label} evm`);
  if (!value.solana || typeof value.solana !== 'object' || Array.isArray(value.solana) || !Object.hasOwn(value.solana, 'priorityFeeCap')) {
    throw new Error(`${label} solana priorityFeeCap is required`);
  }
  if (!Object.hasOwn(value.solana, 'lamportReserve')) throw new Error(`${label} solana lamportReserve is required`);
  assertPlainObject(value.solana, ['priorityFeeCap', 'lamportReserve'], `${label} solana`);
  const evmNative = { chainId: usdg.chainId, assetId: 'native', decimals: 18 };
  const solanaNative = { chainId: solanaStablecoin.chainId, assetId: 'native', decimals: 9 };
  const computeUnitPrice = { chainId: solanaStablecoin.chainId, assetId: 'microlamports-per-compute-unit', decimals: 0 };
  const returnUsdg = assertMoneyAmount(value.minimums.returnUsdg, usdg, `${label} minimums returnUsdg`);
  if (returnUsdg.amountAtomic !== '0') {
    throw new Error(`${label} minimums returnUsdg must be the revision-63 zero value`);
  }
  return {
    schema: 'hookemon.money-configuration.v1',
    assets: { usdg, solanaStablecoin },
    minimums: {
      robinhoodReceive: assertMoneyAmount(value.minimums.robinhoodReceive, usdg, `${label} minimums robinhoodReceive`),
      solanaReceive: assertMoneyAmount(value.minimums.solanaReceive, solanaStablecoin, `${label} minimums solanaReceive`),
      returnUsdg,
    },
    evm: {
      perTransactionGasPriceCap: assertMoneyAmount(value.evm.perTransactionGasPriceCap, evmNative, `${label} evm perTransactionGasPriceCap`),
      nativeReserve: assertMoneyAmount(value.evm.nativeReserve, evmNative, `${label} evm nativeReserve`),
    },
    solana: {
      priorityFeeCap: assertMoneyAmount(value.solana.priorityFeeCap, computeUnitPrice, `${label} solana priorityFeeCap`),
      lamportReserve: assertMoneyAmount(value.solana.lamportReserve, solanaNative, `${label} solana lamportReserve`),
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// Multiple-pack lifecycle records (Task C). One cycle can request several packs from a supported
// Collector batch operation; each pack keeps its own durable identity, memo, mint, and settlement
// evidence so several packs are never conflated with several cards returned by one operation.

const packMemoPattern = /^[\x21-\x7e]{1,255}$/;
const packTypeFieldPattern = /^[a-z0-9][a-z0-9_-]{1,63}$/;

/** One durably generated pack request within a batch, before any signing risk. */
export function assertPackBatchRequestEntry(value, label = 'pack batch request entry') {
  assertPlainObject(value, ['packIndex', 'memo', 'expectedCardCount', 'packType'], label);
  if (!Number.isInteger(value.packIndex) || value.packIndex < 0) throw new Error(`${label} packIndex is invalid`);
  if (typeof value.memo !== 'string' || !packMemoPattern.test(value.memo)) throw new Error(`${label} memo is invalid`);
  if (!Number.isInteger(value.expectedCardCount) || value.expectedCardCount < 1) throw new Error(`${label} expectedCardCount is invalid`);
  if (value.packType !== null && (typeof value.packType !== 'string' || !packTypeFieldPattern.test(value.packType))) {
    throw new Error(`${label} packType is invalid`);
  }
  return clone(value);
}

/** The full set of packs a batch purchase durably generated, indexed 0..n-1 with unique memos. */
export function assertPackBatchRequest(value, label = 'pack batch request') {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAXIMUM_PACK_BATCH_SIZE) {
    throw new Error(`${label} must be a non-empty array of at most ${MAXIMUM_PACK_BATCH_SIZE} packs`);
  }
  const seenMemos = new Set();
  return value.map((entry, index) => {
    const asserted = assertPackBatchRequestEntry(entry, `${label}[${index}]`);
    if (asserted.packIndex !== index) throw new Error(`${label}[${index}] packIndex must equal its array position`);
    if (seenMemos.has(asserted.memo)) throw new Error(`${label} memo values must be unique`);
    seenMemos.add(asserted.memo);
    return asserted;
  });
}

/** Frozen contract: durable identity shared by every lifecycle record for one pack operation. */
export function assertOperationIdentity(value, label = 'operation identity') {
  assertPlainObject(value, ['cycleId', 'operationId', 'packIndex', 'memo', 'mint'], label);
  assertNonEmptyString(value.cycleId, `${label} cycleId`);
  assertNonEmptyString(value.operationId, `${label} operationId`);
  if (!Number.isInteger(value.packIndex) || value.packIndex < 0) throw new Error(`${label} packIndex is invalid`);
  if (value.memo !== null) assertNonEmptyString(value.memo, `${label} memo`);
  if (value.mint !== null) assertNonEmptyString(value.mint, `${label} mint`);
  return clone(value);
}

/** Deterministic durable identity for one pack within a cycle; stable across every observation. */
export function packOperationId(cycleId, packIndex) {
  if (typeof cycleId !== 'string' || cycleId.length === 0) throw new Error('packOperationId cycleId is invalid');
  if (!Number.isInteger(packIndex) || packIndex < 0) throw new Error('packOperationId packIndex is invalid');
  return `pack:${cycleId}:${packIndex}`;
}

export const PUBLIC_CARD_EVENT_STATES = Object.freeze(['PURCHASED', 'OPENED', 'GATED', 'SOLD', 'HELD', 'REFUNDED']);
const publicCardEventStateSet = new Set(PUBLIC_CARD_EVENT_STATES);

/**
 * Frozen contract: one normalized observation of a pack/card's progress. Several observations of
 * the same operationId are idempotent updates to one card's public history, never distinct cards.
 */
export function assertPublicCardEvent(value, label = 'public card event') {
  assertPlainObject(value, [
    'cycleId', 'operationId', 'packIndex', 'memo', 'mint',
    'eventId', 'sequence', 'state', 'name', 'imageUrl',
    'observedAt', 'finalizedAt', 'transactionId', 'proceeds',
  ], label);
  assertOperationIdentity({
    cycleId: value.cycleId,
    operationId: value.operationId,
    packIndex: value.packIndex,
    memo: value.memo,
    mint: value.mint,
  }, label);
  assertNonEmptyString(value.eventId, `${label} eventId`);
  assertAtomic(value.sequence, `${label} sequence`);
  if (!publicCardEventStateSet.has(value.state)) throw new Error(`${label} state is invalid`);
  if (value.name !== null) assertNonEmptyString(value.name, `${label} name`);
  if (value.imageUrl !== null) assertNonEmptyString(value.imageUrl, `${label} imageUrl`);
  if (typeof value.observedAt !== 'string' || !isoTimestampPattern.test(value.observedAt)) {
    throw new Error(`${label} observedAt is invalid`);
  }
  if (value.finalizedAt !== null
    && (typeof value.finalizedAt !== 'string' || !isoTimestampPattern.test(value.finalizedAt))) {
    throw new Error(`${label} finalizedAt is invalid`);
  }
  if (value.transactionId !== null) assertNonEmptyString(value.transactionId, `${label} transactionId`);
  if (value.proceeds !== null) assertPublicAmount(value.proceeds, `${label} proceeds`);
  return clone(value);
}

/**
 * Frozen public contract: `{chainId, assetId, units, decimals}`. Every internal amount in this
 * codebase is `{chainId, assetId, decimals, amountAtomic}` (`assertTypedAmount`); `units` is that
 * same unsigned integer string renamed at the public boundary. The two are never interchangeable
 * field names on the same object.
 */
export function assertPublicAmount(value, label = 'public amount') {
  assertPlainObject(value, ['chainId', 'assetId', 'units', 'decimals'], label);
  assertNonEmptyString(value.chainId, `${label} chainId`);
  assertNonEmptyString(value.assetId, `${label} assetId`);
  if (!Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255) throw new Error(`${label} decimals is invalid`);
  assertAtomic(value.units, `${label} units`);
  return clone(value);
}

/** Converts one internal typed amount to the frozen public `Amount` shape. Null maps to null. */
export function toPublicAmount(value) {
  if (value === null) return null;
  const amount = assertTypedAmount(value, 'internal amount');
  return { chainId: amount.chainId, assetId: amount.assetId, decimals: amount.decimals, units: amount.amountAtomic };
}
