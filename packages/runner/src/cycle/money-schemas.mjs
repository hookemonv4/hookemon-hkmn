const canonicalUnsignedInteger = /^(0|[1-9][0-9]*)$/;
const canonicalSignedInteger = /^(?:0|[1-9][0-9]*|-[1-9][0-9]*)$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;

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

export function assertCustodyLedger(value, label = 'custody ledger') {
  assertPlainObject(value, ['schema', 'cycleId', 'chainId', 'assetId', 'decimals', ...CUSTODY_LEDGER_BUCKETS], label);
  if (value.schema !== 'hookemon.custody-ledger.v1') throw new Error(`${label} schema is invalid`);
  assertNonEmptyString(value.cycleId, `${label} cycleId`);
  assertNonEmptyString(value.chainId, `${label} chainId`);
  assertNonEmptyString(value.assetId, `${label} assetId`);
  if (!Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255) throw new Error(`${label} decimals is invalid`);
  for (const bucket of CUSTODY_LEDGER_BUCKETS) assertAtomic(value[bucket], `${label} ${bucket}`);
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
  assertPlainObject(value, RETURN_RELAY_INTENT_FIELDS, label);
  if (value.schema !== 'hookemon.relay-intent.v1') throw new Error(`${label} schema is invalid`);
  if (value.requestId !== relayRequestId) throw new Error(`${label} requestId does not match its Relay leg`);
  if (value.direction !== 'RETURN') throw new Error(`${label} direction is invalid`);
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
  if (value.schema !== 'hookemon.relay-leg.v1') throw new Error(`${label} schema is invalid`);
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
    schema: 'hookemon.relay-leg.v1',
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
  assertPlainObject(value, RETURN_LEG_DESTINATION_PROOF_FIELDS, label);
  if (value.schema !== 'hookemon.return-leg-destination-proof.v1') throw new Error(`${label} schema is invalid`);
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
  if (typeof value.observedToken !== 'string' || !evmAddressPattern.test(value.observedToken)) {
    throw new Error(`${label} observedToken is invalid`);
  }
  if (typeof value.observedRecipient !== 'string' || !evmAddressPattern.test(value.observedRecipient)) {
    throw new Error(`${label} observedRecipient is invalid`);
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

export const MONEY_CONFIGURATION_SCHEMA = 'hookemon.money-configuration.v1';

/**
 * MoneyConfigurationV1: every money minimum and gas cap is an explicit TypedAmount. A missing field
 * or the literal atomic value 1 is a configuration error rather than a default.
 */
export function assertMoneyConfiguration(value, label = 'money configuration') {
  assertPlainObject(value, ['schema', 'assets', 'minimums', 'evm', 'solana'], label);
  if (value.schema !== MONEY_CONFIGURATION_SCHEMA) throw new Error(`${label} schema is invalid`);
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
    schema: MONEY_CONFIGURATION_SCHEMA,
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
