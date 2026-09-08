import { createHash } from 'node:crypto';

import { assertOperatorConfiguration } from '../config/state-schema.mjs';
import { canonicalJson, digest } from '../cycle/journal.mjs';
import { MAXIMUM_PACK_BATCH_SIZE, assertStandingAuthorityDecision } from '../cycle/money-schemas.mjs';
import { OPERATOR_HARD_CAPS } from '../operator/state-file.mjs';

export const POLICY_WINDOW_MS = 86_400_000;

const decimalPattern = /^(0|[1-9][0-9]*)$/;
const cycleIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const ETH_ROUTE = Object.freeze({ chainId: '4663', assetId: 'native', decimals: 18 });
const COLLECTOR_SETTLEMENT_ROUTE = Object.freeze({ chainId: '792703809', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 });
// The recorded Operations identities, not fixture placeholders. Same pair as
// decisions/owner-inputs/launch-inputs-owner.json, release/phase3/launch-inputs.json,
// RobinhoodBindings.sol's OPERATIONS_WALLET, and environment.mjs's pinned Solana key, so admission
// is checked against the deployment the hook constructor and live execution already enforce.
const OPERATIONS_EVM = '0xb54aaf746eb1e80afdb5eb0992a75b08db2e4384';
const OPERATIONS_SOLANA = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';
/**
 * The owner-approved deployment identity an admission may route funds to and be denominated in.
 *
 * These are frozen contract, not runtime configuration. Deriving them from the same environment that
 * builds the admission would make the check tautological -- a consistently wrong deployment would
 * validate against itself -- so nothing a composition, environment variable or operator state can
 * set is able to move them. Rotating an account or asset is a spec decision that has to mint a new
 * independently approved deployment-identity revision and policy digest; it cannot be enabled here.
 *
 * A test that must exercise isolated keys uses the separate test-only profile below, which
 * production composition has no way to construct and which refuses to describe itself as live.
 */
const PRODUCTION_ADMISSION_IDENTITY = Object.freeze({
  evm: OPERATIONS_EVM, solana: OPERATIONS_SOLANA,
  fundingRoute: ETH_ROUTE, settlementRoute: COLLECTOR_SETTLEMENT_ROUTE,
});

// Only identities minted by createTestOnlyAdmissionIdentity are honoured. Membership of this set is
// the sole way an override is accepted, and the factory is never imported by production code, so an
// ordinary object -- however well shaped -- cannot stand in for the approved deployment identity.
const testOnlyAdmissionIdentities = new WeakSet();

function assertAdmissionRouteIdentity(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.chainId !== 'string' || value.chainId.length === 0
    || typeof value.assetId !== 'string' || value.assetId.length === 0
    || !Number.isInteger(value.decimals) || value.decimals < 0) {
    throw new Error(`policy ${label} route is invalid`);
  }
  return Object.freeze({ chainId: value.chainId, assetId: value.assetId, decimals: value.decimals });
}

/**
 * Mints a deployment identity for tests that need isolated keys and fixture assets.
 *
 * Deliberately not reachable from production: composition never imports this, and the value it
 * returns is recognised only by object identity, so it cannot be reconstructed from configuration or
 * from a serialized copy that crossed a process boundary.
 */
export function createTestOnlyAdmissionIdentity({ evm, solana, fundingRoute, settlementRoute } = {}) {
  if (typeof evm !== 'string' || evm.length === 0 || typeof solana !== 'string' || solana.length === 0) {
    throw new Error('test-only admission identity requires evm and solana accounts');
  }
  const identity = Object.freeze({
    evm: evm.toLowerCase(),
    solana,
    fundingRoute: assertAdmissionRouteIdentity(fundingRoute, 'funding'),
    settlementRoute: assertAdmissionRouteIdentity(settlementRoute, 'settlement'),
  });
  testOnlyAdmissionIdentities.add(identity);
  return identity;
}

/** The approved production identity unless a caller presents a genuine test-only one. */
function assertOperationsAccounts(value) {
  // The pinned object itself is accepted so a resolved identity can be threaded on through the
  // evaluation without being re-approved; equality is by object identity, so a lookalike literal
  // still cannot pass.
  if (value === undefined || value === null || value === PRODUCTION_ADMISSION_IDENTITY) {
    return PRODUCTION_ADMISSION_IDENTITY;
  }
  if (!testOnlyAdmissionIdentities.has(value)) {
    throw new Error('policy admission deployment identity is not the approved production identity');
  }
  return value;
}

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

function assertPolicyAdmissionAmount(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} is invalid`);
  if (typeof value.chainId !== 'string' || value.chainId.length === 0
    || typeof value.assetId !== 'string' || value.assetId.length === 0
    || !Number.isInteger(value.decimals) || value.decimals < 0) {
    throw new Error(`${label} asset identity is invalid`);
  }
  return Object.freeze({
    chainId: value.chainId,
    assetId: value.assetId,
    decimals: value.decimals,
    amountAtomic: assertAmount(value.amountAtomic, `${label} amountAtomic`, { positive: true }).toString(),
  });
}

function assertAdmissionRoute(amount, expected, label) {
  if (amount.chainId !== expected.chainId || amount.assetId.toLowerCase() !== expected.assetId.toLowerCase() || amount.decimals !== expected.decimals) {
    throw new Error(`${label} does not match the canonical asset route`);
  }
}

function immutableCanonicalValue(value, label) {
  try {
    return JSON.parse(canonicalJson(value));
  } catch (error) {
    throw new Error(`${label} is not canonical immutable data: ${error.message}`);
  }
}

function freezeRecursively(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeRecursively(child);
    Object.freeze(value);
  }
  return value;
}

function relayQuoteEvidenceDigest(quote) {
  return digest({
    schema: 'hookemon.relay-quote.v1',
    direction: quote.direction,
    tradeType: quote.tradeType,
    requestId: quote.requestId,
    orderId: quote.orderId,
    sender: quote.sender,
    recipient: quote.recipient,
    deadlineUnixSeconds: quote.deadlineUnixSeconds,
    origin: quote.origin,
    destination: quote.destination,
    raw: quote.raw,
  });
}

function assertQuoteRouteLeg(value, expected, label, { destination = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || String(value.chainId) !== expected.chainId
    || typeof value.address !== 'string' || value.address.toLowerCase() !== (expected.assetId === 'native' ? '0x0000000000000000000000000000000000000000' : expected.assetId.toLowerCase())
    || value.decimals !== expected.decimals
    || assertAmount(value.amount, `${label} amount`, { positive: true }).toString() !== expected.amountAtomic
    || (destination && assertAmount(value.minimumAmount, `${label} minimumAmount`, { positive: true }).toString() !== expected.amountAtomic)) {
    throw new Error(`${label} does not bind the admitted asset amount`);
  }
}

function assertRawRelayLeg(value, expected, label, { destination = false } = {}) {
  const currency = value?.currency;
  if (!currency || String(currency.chainId) !== expected.chainId
    || typeof currency.address !== 'string' || currency.address.toLowerCase() !== (expected.assetId === 'native' ? '0x0000000000000000000000000000000000000000' : expected.assetId.toLowerCase())
    || currency.decimals !== expected.decimals
    || value.amount !== expected.amountAtomic
    || (destination && value.minimumAmount !== expected.amountAtomic)) {
    throw new Error(`${label} does not bind the admitted asset amount`);
  }
}

function normalizeUnitRelayQuote(value, { unitFundingQuote, unitPurchase, unitRelay, operations, label = 'unitRelayQuote' }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`policy admission ${label} must be a parsed Relay quote`);
  }
  const raw = immutableCanonicalValue(value.raw, `policy admission ${label} raw response`);
  const quote = {
    direction: value.direction,
    tradeType: value.tradeType,
    requestId: value.requestId,
    orderId: value.orderId,
    sender: value.sender,
    recipient: value.recipient,
    deadlineUnixSeconds: value.deadlineUnixSeconds,
    origin: immutableCanonicalValue(value.origin, `policy admission ${label} origin`),
    destination: immutableCanonicalValue(value.destination, `policy admission ${label} destination`),
    stepCount: value.stepCount,
    raw,
    quoteDigest: value.quoteDigest,
  };
  if (quote.direction !== 'OUTBOUND' || quote.tradeType !== 'EXACT_OUTPUT'
    || quote.requestId !== unitRelay.requestId || quote.orderId !== unitRelay.orderId
    || quote.sender?.toLowerCase() !== operations.evm || quote.recipient !== operations.solana
    || quote.deadlineUnixSeconds !== unitRelay.deadlineUnixSeconds
    || !Number.isSafeInteger(quote.stepCount) || quote.stepCount < 0
    || typeof quote.quoteDigest !== 'string' || !digestPattern.test(quote.quoteDigest)) {
    throw new Error(`policy admission ${label} identity is invalid`);
  }
  assertQuoteRouteLeg(quote.origin, unitFundingQuote, `policy admission ${label} origin`);
  assertQuoteRouteLeg(quote.destination, unitPurchase, `policy admission ${label} destination`, { destination: true });
  if (!raw || raw.requestId !== quote.requestId || !Array.isArray(raw.steps) || raw.steps.length !== quote.stepCount
    || raw.details?.sender?.toLowerCase() !== quote.sender.toLowerCase() || raw.details?.recipient !== quote.recipient
    || raw.protocol?.v2?.orderId !== quote.orderId || raw.protocol.v2.orderData?.output?.deadline !== quote.deadlineUnixSeconds
    || raw.protocol.v2.orderData.output?.chainId !== 'solana' || !Array.isArray(raw.protocol.v2.orderData.output.calls)
    || raw.protocol.v2.orderData.output.calls.length !== 0) {
    throw new Error(`policy admission ${label} raw identity is invalid`);
  }
  assertRawRelayLeg(raw.details.currencyIn, unitFundingQuote, `policy admission ${label} raw origin`);
  assertRawRelayLeg(raw.details.currencyOut, unitPurchase, `policy admission ${label} raw destination`, { destination: true });
  const payments = raw.protocol.v2.orderData.output.payments;
  const inputs = raw.protocol.v2.orderData.inputs;
  if (!Array.isArray(payments) || payments.length !== 1
    || payments[0]?.recipient !== quote.recipient || payments[0]?.currency !== quote.destination.address
    || payments[0]?.expectedAmount !== unitPurchase.amountAtomic || payments[0]?.minimumAmount !== unitPurchase.amountAtomic
    || !Array.isArray(inputs) || inputs.length !== 1
    || inputs[0]?.payment?.chainId !== 'robinhood' || inputs[0]?.payment?.currency?.toLowerCase() !== quote.origin.address.toLowerCase()
    || inputs[0]?.payment?.amount !== unitFundingQuote.amountAtomic) {
    throw new Error(`policy admission ${label} raw order does not bind the admitted amounts`);
  }
  // The recomputed value is named in the refusal so a caller can see which digest the engine derived
  // from the evidence, rather than having to trust or re-implement the derivation.
  const recomputed = relayQuoteEvidenceDigest(quote);
  if (quote.quoteDigest !== unitRelay.quoteDigest || quote.quoteDigest !== recomputed) {
    throw new Error(`policy admission ${label} digest does not match its immutable parsed evidence; recomputed ${recomputed}`);
  }
  return freezeRecursively(quote);
}

/**
 * Deliberately duplicated from `deriveOnchainCycleId` in
 * `packages/adapters/src/app/stages/action-builder.mjs` rather than imported: adapters already
 * imports this module, so importing back would cycle the two packages. Both compute the identical
 * sha256 of the plain cycleId string; a change to one must change the other.
 */
function deriveOnchainCycleIdForEvidence(cycleId) {
  return `0x${createHash('sha256').update(cycleId, 'utf8').digest('hex')}`;
}

const UNSIGNED_DECIMAL_STRING = /^(0|[1-9][0-9]*)$/;

/**
 * The exact and only fields a normalized `processLiabilityEvidence` record may carry. Rejecting any
 * other key means "normalized exact shape" cannot smuggle an unvalidated field through to the
 * digest -- the returned object below is built field by field from this list, never by spreading
 * the input.
 */
const PROCESS_LIABILITY_EVIDENCE_FIELDS = Object.freeze([
  'schema', 'chainId', 'assetId', 'decimals', 'hook', 'cycleId', 'onchainCycleId', 'blockNumber',
  'blockHash', 'finalized', 'processLiability', 'remainingProcessClaimCapacity',
  'processClaimsPaused', 'processClaimCycleUsed', 'activeProcessClaimLimit', 'totalLiability',
  'hookNativeBalance', 'isSolvent', 'operations', 'ceilingAtomic',
]);

/**
 * Normalizes the finalized hook process-liability evidence a quote-bound admission must carry.
 *
 * Every quote-bound `hookemon.policy-admission.v3` admission binds a live hook read -- there is no
 * evidence-free equivalent for one. Accepting this schema without evidence would let an old
 * or hand-built admission resume as though it still
 * proved a hook observation. Every getter and control flag is re-validated against the resolved
 * deployment identity's funding route -- independent of however the caller produced it -- including
 * the three relationships the hook's own accounting guarantees
 * (`remainingProcessClaimCapacity <= activeProcessClaimLimit`, `processLiability <= totalLiability`,
 * and `isSolvent` exactly tracking `hookNativeBalance >= totalLiability`), so a fake reader cannot
 * hand the planner or a replayed record a combination the real hook could never produce. The
 * aggregate funding quote it accompanies must not exceed its ceiling. A one-field mutation to a
 * validated record either fails one of these checks or survives into the returned object, which
 * durable replay persists and the cycle policy digest covers.
 */
function normalizeProcessLiabilityEvidence(value, { cycleId, fundingRoute, operations, historical = false }) {
  if (historical) {
    if (value?.schema !== 'hookemon.process-liability-evidence.v1' || Object.hasOwn(value, 'hookNativeBalance')) throw new Error('historical process liability evidence schema is invalid');
    const { hookUsdgBalance, ...rest } = value;
    const normalized = normalizeProcessLiabilityEvidence({ ...rest, schema: 'hookemon.process-liability-evidence.v2', hookNativeBalance: hookUsdgBalance }, { cycleId, fundingRoute, operations });
    const { hookNativeBalance, ...fields } = normalized;
    return Object.freeze({ ...fields, schema: 'hookemon.process-liability-evidence.v1', hookUsdgBalance: hookNativeBalance });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('policy admission processLiabilityEvidence is required and must be a plain object');
  }
  for (const key of Object.keys(value)) {
    if (!PROCESS_LIABILITY_EVIDENCE_FIELDS.includes(key)) {
      throw new Error(`policy admission processLiabilityEvidence has an unrecognized field "${key}"`);
    }
  }
  if (value.schema !== 'hookemon.process-liability-evidence.v2') {
    throw new Error('policy admission processLiabilityEvidence must use hookemon.process-liability-evidence.v2');
  }
  if (value.finalized !== true) throw new Error('policy admission processLiabilityEvidence must be finalized');
  if (value.chainId !== fundingRoute.chainId || value.assetId?.toLowerCase() !== fundingRoute.assetId.toLowerCase()
    || value.decimals !== fundingRoute.decimals) {
    throw new Error('policy admission processLiabilityEvidence is not denominated in the configured funding asset');
  }
  if (typeof value.hook !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(value.hook)) {
    throw new Error('policy admission processLiabilityEvidence hook is invalid');
  }
  if (value.cycleId !== cycleId) throw new Error('policy admission processLiabilityEvidence cycleId does not match the admitted cycle');
  if (typeof value.onchainCycleId !== 'string' || value.onchainCycleId !== deriveOnchainCycleIdForEvidence(cycleId)) {
    throw new Error('policy admission processLiabilityEvidence onchainCycleId does not match its cycleId');
  }
  if (typeof value.blockNumber !== 'string' || !UNSIGNED_DECIMAL_STRING.test(value.blockNumber)
    || typeof value.blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value.blockHash)) {
    throw new Error('policy admission processLiabilityEvidence must bind the exact finalized block number and hash');
  }
  for (const field of [
    'processLiability', 'remainingProcessClaimCapacity', 'activeProcessClaimLimit',
    'totalLiability', 'hookNativeBalance', 'ceilingAtomic',
  ]) {
    if (typeof value[field] !== 'string' || !UNSIGNED_DECIMAL_STRING.test(value[field])) {
      throw new Error(`policy admission processLiabilityEvidence ${field} is invalid`);
    }
  }
  if (typeof value.processClaimsPaused !== 'boolean' || typeof value.processClaimCycleUsed !== 'boolean'
    || typeof value.isSolvent !== 'boolean') {
    throw new Error('policy admission processLiabilityEvidence has a non-boolean control flag');
  }
  // These three relationships hold for any real hook read (FeeAccounting.sol/HookemonHook.sol);
  // a value combination outside them cannot have come from the contract, real reader or not.
  if (BigInt(value.remainingProcessClaimCapacity) > BigInt(value.activeProcessClaimLimit)) {
    throw new Error('policy admission processLiabilityEvidence remainingProcessClaimCapacity exceeds activeProcessClaimLimit');
  }
  if (BigInt(value.processLiability) > BigInt(value.totalLiability)) {
    throw new Error('policy admission processLiabilityEvidence processLiability exceeds totalLiability');
  }
  if (value.isSolvent !== (BigInt(value.hookNativeBalance) >= BigInt(value.totalLiability))) {
    throw new Error('policy admission processLiabilityEvidence isSolvent does not match hookNativeBalance and totalLiability');
  }
  if (value.processClaimsPaused !== false) {
    throw new Error('policy admission processLiabilityEvidence refuses while hook process claims are paused');
  }
  if (value.processClaimCycleUsed !== false) {
    throw new Error('policy admission processLiabilityEvidence refuses a cycle id the hook already used');
  }
  if (value.isSolvent !== true) throw new Error('policy admission processLiabilityEvidence refuses while the hook is not solvent');
  if (typeof value.operations !== 'string' || value.operations !== operations.evm) {
    throw new Error('policy admission processLiabilityEvidence Operations role does not match the approved deployment identity');
  }
  const ceiling = BigInt(value.processLiability) < BigInt(value.remainingProcessClaimCapacity)
    ? BigInt(value.processLiability)
    : BigInt(value.remainingProcessClaimCapacity);
  if (ceiling.toString() !== value.ceilingAtomic) {
    throw new Error('policy admission processLiabilityEvidence ceilingAtomic does not equal min(processLiability, remainingProcessClaimCapacity)');
  }
  return Object.freeze({
    schema: value.schema,
    chainId: value.chainId,
    assetId: value.assetId,
    decimals: value.decimals,
    hook: value.hook,
    cycleId: value.cycleId,
    onchainCycleId: value.onchainCycleId,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
    finalized: value.finalized,
    processLiability: value.processLiability,
    remainingProcessClaimCapacity: value.remainingProcessClaimCapacity,
    processClaimsPaused: value.processClaimsPaused,
    processClaimCycleUsed: value.processClaimCycleUsed,
    activeProcessClaimLimit: value.activeProcessClaimLimit,
    totalLiability: value.totalLiability,
    hookNativeBalance: value.hookNativeBalance,
    isSolvent: value.isSolvent,
    operations: value.operations,
    ceilingAtomic: value.ceilingAtomic,
  });
}

/**
 * Normalizes the quote-bound monetary record produced before a live cycle exists. The policy
 * engine deliberately does not infer a unit quote from an aggregate quote: they are separate
 * source-asset facts, while purchase targets remain separately typed destination-asset facts.
 *
 * Exported as `assertPolicyAdmission` so the durable cycle repository validates exactly the record
 * this engine will later digest, instead of keeping a second copy of these monetary rules. The
 * returned value is the normalized subset the policy digest covers; a persisting caller keeps its
 * own full record (which additionally carries the parsed aggregate `relayQuote` outbound replays).
 */
function normalizeFundingUsd(value, amount, quote) {
  const fields = ['schema', 'quoteDigest', 'requestDigest', 'quoteRequestId', 'sourcePath', 'amount', 'amountMicroUsd', 'rounding', 'observedAtMs', 'validUntilMs'];
  if (!value || Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))
    || value.schema !== 'hookemon.quote-usd-valuation.v1' || value.quoteDigest !== quote.quoteDigest
    || value.quoteRequestId !== quote.requestId || !digestPattern.test(value.requestDigest ?? '')
    || value.sourcePath !== 'details.currencyIn.amountUsd' || value.rounding !== 'up'
    || canonicalJson(value.amount) !== canonicalJson(amount)
    || !Number.isSafeInteger(value.observedAtMs) || value.observedAtMs < 0
    || !Number.isSafeInteger(value.validUntilMs) || value.validUntilMs <= value.observedAtMs
    || value.validUntilMs > quote.deadlineUnixSeconds * 1000) throw new Error('policy funding USD valuation binding is invalid');
  assertAmount(value.amountMicroUsd, 'policy funding amountMicroUsd', { positive: true });
  return immutableCanonicalValue(value, 'policy funding USD valuation');
}

function hasFreshFundingUsd(admission, verify, now) {
  if (!admission || typeof verify !== 'function') return false;
  return [['unitFundingUsd', 'unitFundingQuote', 'unitRelay'], ['aggregateFundingUsd', 'aggregateFundingQuote', 'relay']].every(([field, amount, quote]) => {
    const valuation = admission[field];
    return valuation && now >= valuation.observedAtMs && now < valuation.validUntilMs
      && verify(valuation, { amount: admission[amount], quoteDigest: admission[quote].quoteDigest,
        quoteRequestId: admission[quote].requestId, sourcePath: 'details.currencyIn.amountUsd', rounding: 'up' }) === true;
  });
}

function normalizePolicyAdmission(value, operationsAccounts, { historical = false } = {}) {
  const resolvedOperations = assertOperationsAccounts(operationsAccounts);
  const operations = historical ? { ...resolvedOperations, fundingRoute: { chainId: '4663', assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 } } : resolvedOperations;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schema !== (historical ? 'hookemon.policy-admission.v2' : 'hookemon.policy-admission.v3')) {
    throw new Error('policy admission must use hookemon.policy-admission.v3');
  }
  assertCycleId(value.cycleId);
  assertPackId(value.packId);
  // Pre-cycle ceiling (BOT-PACK-QUANTITY / pack-quantity-review.md P1): this is the durable cycle
  // repository's own persist-time normalizer (`CycleRepository`'s admission open path calls
  // `assertPolicyAdmission`, i.e. this function, before claim-process or any spend), so a
  // quantity above the shared batch/catalog ceiling is refused here before a cycle exists at all.
  // `buildAdmissionPlanner.plan` (packages/adapters/src/app/compose.mjs) can still quote and admit
  // a >64 request before reaching this normalizer; that planner-side ceiling remains a separate,
  // not-yet-fixed gap outside this file's write-set (compose.mjs is owned by another worker) --
  // see pack-quantity-corrected-report.md.
  if (!Number.isInteger(value.quantity) || value.quantity < 1 || value.quantity > MAXIMUM_PACK_BATCH_SIZE) {
    throw new Error(`policy admission quantity must be an integer from 1 through ${MAXIMUM_PACK_BATCH_SIZE}`);
  }
  if (typeof value.quoteDigest !== 'string' || !digestPattern.test(value.quoteDigest)) throw new Error('policy admission quoteDigest is invalid');
  const unitPurchase = assertPolicyAdmissionAmount(value.unitPurchase, 'policy admission unitPurchase');
  const aggregatePurchase = assertPolicyAdmissionAmount(value.aggregatePurchase, 'policy admission aggregatePurchase');
  const unitFundingQuote = assertPolicyAdmissionAmount(value.unitFundingQuote, 'policy admission unitFundingQuote');
  const aggregateFundingQuote = assertPolicyAdmissionAmount(value.aggregateFundingQuote, 'policy admission aggregateFundingQuote');
  assertAdmissionRoute(unitPurchase, operations.settlementRoute, 'policy admission unitPurchase');
  assertAdmissionRoute(aggregatePurchase, operations.settlementRoute, 'policy admission aggregatePurchase');
  assertAdmissionRoute(unitFundingQuote, operations.fundingRoute, 'policy admission unitFundingQuote');
  assertAdmissionRoute(aggregateFundingQuote, operations.fundingRoute, 'policy admission aggregateFundingQuote');
  if (unitPurchase.chainId !== aggregatePurchase.chainId || unitPurchase.assetId !== aggregatePurchase.assetId
    || unitPurchase.decimals !== aggregatePurchase.decimals
    || BigInt(unitPurchase.amountAtomic) * BigInt(value.quantity) !== BigInt(aggregatePurchase.amountAtomic)) {
    throw new Error('policy admission aggregatePurchase does not exactly equal unitPurchase times quantity');
  }
  if (unitFundingQuote.chainId !== aggregateFundingQuote.chainId || unitFundingQuote.assetId !== aggregateFundingQuote.assetId
    || unitFundingQuote.decimals !== aggregateFundingQuote.decimals) {
    throw new Error('policy admission funding quotes do not share one source asset identity');
  }
  const processLiabilityEvidence = normalizeProcessLiabilityEvidence(value.processLiabilityEvidence, {
    cycleId: value.cycleId, fundingRoute: operations.fundingRoute, operations, historical,
  });
  if (BigInt(aggregateFundingQuote.amountAtomic) > BigInt(processLiabilityEvidence.ceilingAtomic)) {
    throw new Error('policy admission aggregateFundingQuote exceeds the persisted process liability ceiling');
  }
  const relay = value.relay;
  if (!relay || relay.tradeType !== 'EXACT_OUTPUT' || typeof relay.requestId !== 'string' || relay.requestId.length === 0
    || typeof relay.orderId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(relay.orderId)
    || !Number.isSafeInteger(relay.deadlineUnixSeconds) || relay.deadlineUnixSeconds <= 0
    || typeof relay.sender !== 'string' || relay.sender.toLowerCase() !== operations.evm || relay.recipient !== operations.solana
    || assertAmount(relay.destinationAmount, 'policy admission relay destinationAmount', { positive: true }).toString() !== aggregatePurchase.amountAtomic
    || assertAmount(relay.destinationMinimumAmount, 'policy admission relay destinationMinimumAmount', { positive: true }).toString() !== aggregatePurchase.amountAtomic) {
    throw new Error('policy admission Relay exact-output identity is invalid');
  }
  const unitRelay = value.unitRelay;
  if (!unitRelay || unitRelay.tradeType !== 'EXACT_OUTPUT' || typeof unitRelay.requestId !== 'string' || unitRelay.requestId.length === 0
    || !/^0x[0-9a-fA-F]{64}$/.test(unitRelay.orderId ?? '') || !Number.isSafeInteger(unitRelay.deadlineUnixSeconds)
    || unitRelay.deadlineUnixSeconds <= 0 || unitRelay.sender?.toLowerCase() !== operations.evm || unitRelay.recipient !== operations.solana
    || assertAmount(unitRelay.destinationAmount, 'policy admission unitRelay destinationAmount', { positive: true }).toString() !== unitPurchase.amountAtomic
    || assertAmount(unitRelay.destinationMinimumAmount, 'policy admission unitRelay destinationMinimumAmount', { positive: true }).toString() !== unitPurchase.amountAtomic
    || typeof unitRelay.quoteDigest !== 'string' || !digestPattern.test(unitRelay.quoteDigest)) {
    throw new Error('policy admission unit exact-output Relay evidence is invalid');
  }
  if (typeof relay.quoteDigest !== 'string' || relay.quoteDigest !== value.quoteDigest) {
    throw new Error('policy admission aggregate Relay quote digest is invalid');
  }
  const unitRelayQuote = normalizeUnitRelayQuote(value.unitRelayQuote, {
    unitFundingQuote, unitPurchase, unitRelay, operations, label: 'unitRelayQuote',
  });
  // The aggregate quote is the one restart and outbound actually execute, so it gets exactly the
  // same treatment: deep normalization of its parsed and raw evidence, and its digest recomputed
  // from that evidence rather than trusted as supplied. Checking only that a supplied digest string
  // matched another supplied string would let a self-consistent record accompany entirely different
  // executable raw steps.
  const relayQuote = normalizeUnitRelayQuote(value.relayQuote, {
    unitFundingQuote: aggregateFundingQuote,
    unitPurchase: aggregatePurchase,
    unitRelay: relay,
    operations,
    label: 'relayQuote',
  });
  if (relayQuote.quoteDigest !== value.quoteDigest) {
    throw new Error('policy admission relayQuote digest does not match the admitted quote digest');
  }
  return Object.freeze({
    schema: value.schema,
    cycleId: value.cycleId,
    packId: value.packId,
    quantity: value.quantity,
    quoteDigest: value.quoteDigest,
    unitPurchase,
    aggregatePurchase,
    unitFundingQuote,
    aggregateFundingQuote,
    ...(historical ? {} : {
      unitFundingUsd: normalizeFundingUsd(value.unitFundingUsd, unitFundingQuote, unitRelay),
      aggregateFundingUsd: normalizeFundingUsd(value.aggregateFundingUsd, aggregateFundingQuote, relay),
    }),
    relay: Object.freeze({ ...relay }),
    unitRelay: Object.freeze({ ...unitRelay }),
    unitRelayQuote,
    relayQuote,
    processLiabilityEvidence,
  });
}

function assertBoundary(value) {
  if (!['cycle-start', 'claim-process', 'purchase', 'signature', 'broadcast', 'mutation'].includes(value)) {
    throw new Error('policy boundary is invalid');
  }
  return value;
}

function normalizeHeldPositions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('policy custody heldPositions is invalid');
  }
  if (!Number.isSafeInteger(value.count) || value.count < 0) {
    throw new Error('policy custody heldPositions count is invalid');
  }
  if (!Array.isArray(value.positions) || value.positions.length !== value.count) {
    throw new Error('policy custody heldPositions count does not match positions');
  }
  const reportedValue = assertAmount(value.valueMicroUsd, 'policy custody heldPositions valueMicroUsd');
  const positionValue = value.positions.reduce((total, position, index) => {
    if (!position || typeof position !== 'object' || Array.isArray(position)) {
      throw new Error(`policy custody heldPositions positions[${index}] is invalid`);
    }
    return total + assertAmount(
      position.costMicroUsd,
      `policy custody heldPositions positions[${index}] costMicroUsd`,
    );
  }, 0n);
  if (positionValue !== reportedValue) {
    throw new Error('policy custody heldPositions value does not match positions');
  }
  return { count: value.count, valueMicroUsd: reportedValue };
}

function normalizeCustody(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('policy custody projection is invalid');
  const normalized = {
    realizedLossMicroUsd: assertAmount(value.realizedLossMicroUsd, 'policy custody realizedLossMicroUsd'),
    atRiskMicroUsd: assertAmount(value.atRiskMicroUsd, 'policy custody atRiskMicroUsd'),
    outstandingMicroUsd: assertAmount(value.outstandingMicroUsd, 'policy custody outstandingMicroUsd'),
    heldAssets: value.heldAssets,
    heldPositions: normalizeHeldPositions(value.heldPositions),
    unattributed: value.unattributed,
    unvaluedExposure: value.unvaluedExposure,
    cycleExposureMicroUsd: value.cycleExposureMicroUsd ?? {},
  };
  if (!normalized.cycleExposureMicroUsd || typeof normalized.cycleExposureMicroUsd !== 'object' || Array.isArray(normalized.cycleExposureMicroUsd)) throw new Error('policy per-cycle exposure map is invalid');
  const totalCycleExposure = Object.entries(normalized.cycleExposureMicroUsd).reduce((total, [cycleId, amount]) => {
    assertCycleId(cycleId);
    return total + assertAmount(amount, 'policy per-cycle exposure');
  }, 0n);
  if (totalCycleExposure > normalized.atRiskMicroUsd || totalCycleExposure > normalized.outstandingMicroUsd) throw new Error('policy per-cycle exposure exceeds aggregate custody');
  for (const field of ['heldAssets', 'unattributed', 'unvaluedExposure']) {
    if (typeof normalized[field] !== 'boolean') throw new Error(`policy custody ${field} is invalid`);
  }
  return normalized;
}

function zeroCustody() {
  return {
    realizedLossMicroUsd: '0',
    atRiskMicroUsd: '0',
    outstandingMicroUsd: '0',
    heldAssets: false,
    heldPositions: { count: 0, valueMicroUsd: '0', positions: [] },
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
    maxUnitPriceMicroUsd: configuration.maxUnitPriceMicroUsd,
    perCycleCapMicroUsd: configuration.perCycleCapMicroUsd,
    max24HourBudgetMicroUsd: configuration.max24HourBudgetMicroUsd,
    maxCyclesPerDay: configuration.maxCyclesPerDay,
    lossCapMicroUsd: configuration.lossCapMicroUsd,
    maxOutstandingCustodyMicroUsd: configuration.maxOutstandingCustodyMicroUsd,
    maxHeldPositions: configuration.maxHeldPositions,
    maxHeldValueMicroUsd: configuration.maxHeldValueMicroUsd,
    unresolvedCardDeadlineMinutes: configuration.unresolvedCardDeadlineMinutes,
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

/**
 * Narrows the general operator policy to the single permitted live Collector-only rehearsal.
 * The caller supplies the immutable pack and typed atomic spend from its environment boundary;
 * this helper only validates the persisted, owner-controlled policy document.
 */
export function assertCollectorOnlyRehearsalPolicy(configuration, { packCode, packPriceAtomic, packCostMicroUsd } = {}) {
  const normalized = assertOperatorHardCaps(assertOperatorConfiguration(configuration));
  assertPackId(packCode);
  assertAmount(packPriceAtomic, 'collector-only rehearsal packPriceAtomic', { positive: true });
  assertAmount(packCostMicroUsd, 'collector-only rehearsal packCostMicroUsd', { positive: true });
  if (normalized.liveMode !== true) throw new Error('collector-only rehearsal policy requires liveMode=true');
  if (normalized.allowedPackIds.length !== 1 || normalized.allowedPackIds[0] !== packCode) {
    throw new Error('collector-only rehearsal policy must allow exactly the selected pack');
  }
  if (normalized.requestedOrders !== 1) throw new Error('collector-only rehearsal policy requestedOrders must equal 1');
  if (normalized.maxBoostersPerCycle !== 1) throw new Error('collector-only rehearsal policy maxBoostersPerCycle must equal 1');
  if (normalized.manualApprovalCycles < 1) {
    throw new Error('collector-only rehearsal policy requires at least one manual approval cycle');
  }
  for (const field of [
    'maxUnitPriceMicroUsd',
    'maxCycleBudgetMicroUsd',
    'max24HourBudgetMicroUsd',
    'perCycleCapMicroUsd',
  ]) {
    if (normalized[field] !== packCostMicroUsd) {
      throw new Error(`collector-only rehearsal policy ${field} must equal the configured pack price`);
    }
  }
  if (normalized.maxCyclesPerDay !== 1) throw new Error('collector-only rehearsal policy maxCyclesPerDay must equal 1');
  return normalized;
}

function digestCyclePolicy({ schema, policy, cycleId, releaseCostMicroUsd, releaseAmountWei, packId, liveMode, mode, admission = null }) {
  return digest({
    schema,
    cycleId,
    releaseCostMicroUsd,
    releaseAmountWei,
    packId,
    mode: cycleMode(liveMode, mode),
    policy,
    ...(admission === null ? {} : { admission }),
  });
}

export function deriveCyclePolicyDigest({ configuration, cycleId, releaseCostMicroUsd, releaseAmountWei, packId, liveMode, mode, admission = undefined, operations = undefined }) {
  const normalized = assertOperatorHardCaps(assertOperatorConfiguration(configuration));
  assertCycleId(cycleId);
  assertAmount(releaseCostMicroUsd, 'policy releaseCostMicroUsd', { positive: true });
  assertAmount(releaseAmountWei, 'policy releaseAmountWei', { positive: true });
  assertPackId(packId);
  const normalizedAdmission = admission === undefined ? null : normalizePolicyAdmission(admission, operations);
  if (normalizedAdmission !== null && normalizedAdmission.cycleId !== cycleId) throw new Error('policy admission cycleId does not match cycle digest');
  return digestCyclePolicy({
    schema: 'hookemon.policy-cycle.v5',
    policy: policyMaterial(normalized),
    cycleId,
    releaseCostMicroUsd,
    releaseAmountWei,
    packId,
    liveMode,
    mode,
    admission: normalizedAdmission,
  });
}

function matchingExistingCycleDigest(input) {
  const current = deriveCyclePolicyDigest(input);
  return input.existing.cycleDigest === current ? current : null;
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
  const configuredCap = BigInt(configuration.perCycleCapMicroUsd);
  if (context.capMicroUsd === null) return configuredCap;
  return context.capMicroUsd < configuredCap ? context.capMicroUsd : configuredCap;
}

function evaluateExistingCycleExecution({ configuration, custodyState, context }) {
  if (!context.cycleId || !context.packId || (context.releaseAmount === 0n || context.releaseAmountWei === 0n)) {
    throw new Error('policy execution guard requires cycleId, packId, and a positive release amount');
  }
  if (!configuration.allowedPackIds.includes(context.packId)) return refused('PACK_NOT_ALLOWED');
  if (context.releaseAmount > effectiveCycleCap(configuration, context)
    || context.releaseAmount > BigInt(configuration.maxCycleBudgetMicroUsd)) {
    return refused('PER_CYCLE_CAP');
  }

  const existing = existingCycle(configuration, context.cycleId);
  if (!existing || (existing.releaseCostMicroUsd !== context.releaseAmount.toString() || existing.releaseAmountWei !== context.releaseAmountWei.toString())) return refused('CYCLE_POLICY_MISSING');
  // The admission is part of the recorded digest, so every later boundary must re-present it.
  // Omitting it here derived an admission-free digest that could never match what claim-process
  // reserved, and refused every execution boundary of an admitted cycle as CYCLE_POLICY_DIGEST_CHANGED.
  const cycleDigest = matchingExistingCycleDigest({
    configuration,
    existing,
    cycleId: context.cycleId,
    releaseCostMicroUsd: context.releaseAmount.toString(),
    releaseAmountWei: context.releaseAmountWei.toString(),
    packId: context.packId,
    liveMode: context.liveMode,
    mode: context.mode,
    admission: context.admission ?? undefined,
    operations: context.operations,
  });
  if (cycleDigest === null) return refused('CYCLE_POLICY_DIGEST_CHANGED');
  const reservation = configuration.spendLedger.find(entry => entry.cycleDigest === cycleDigest);
  if (!reservation || reservation.amountMicroUsd !== existing.releaseCostMicroUsd) return refused('SPEND_RESERVATION_MISSING');

  const modeCycles = configuration.cycleLedger.filter(entry => entry.mode === context.mode);
  const ordinal = modeCycles.findIndex(entry => entry.cycleDigest === cycleDigest) + 1;
  if (ordinal > 0 && ordinal <= configuration.manualApprovalCycles) {
    const approval = configuration.approvalsByCycleDigest[cycleDigest];
    if (!approval || approval.cycleId !== context.cycleId) return refused('MANUAL_APPROVAL_REQUIRED');
  }
  if (custodyState.realizedLossMicroUsd + custodyState.atRiskMicroUsd > BigInt(configuration.lossCapMicroUsd)) {
    return refused('LOSS_CAP');
  }
  if (custodyState.outstandingMicroUsd > BigInt(configuration.maxOutstandingCustodyMicroUsd)) {
    return refused('OUTSTANDING_CUSTODY_CAP');
  }
  return allowed(cycleDigest);
}

function evaluateAdmittedClaimExecution({ configuration, custody, ...input }) {
  const decision = evaluateConfiguredPolicy({ configuration, custody, ...input, boundary: 'claim-process' });
  if (!decision.allowed) return decision;
  const context = admissionContext({ ...input, boundary: 'claim-process' });
  const existing = existingCycle(configuration, context.cycleId);
  if (!existing || (existing.releaseCostMicroUsd !== context.releaseAmount.toString() || existing.releaseAmountWei !== context.releaseAmountWei.toString())) {
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
  if (input.releaseAmountMicroUsdg !== undefined || input.capUsdg !== undefined) throw new Error('historical USDG policy input is not executable');
  const releaseAmountWei = input.releaseAmountWei === undefined ? 0n : assertAmount(input.releaseAmountWei, 'policy releaseAmountWei');
  const releaseAmount = input.releaseCostMicroUsd === undefined
    ? 0n
    : assertAmount(input.releaseCostMicroUsd, 'policy releaseCostMicroUsd');
  if (['claim-process', 'purchase'].includes(boundary) && (releaseAmount === 0n || releaseAmountWei === 0n)) {
    throw new Error('policy releaseCostMicroUsd must be positive for a money boundary');
  }
  if (input.cycleId !== undefined && input.cycleId !== null) assertCycleId(input.cycleId);
  if (input.packId !== undefined && input.packId !== null) assertPackId(input.packId);
  const capMicroUsd = input.capMicroUsd === undefined ? null : assertAmount(input.capMicroUsd, 'policy capMicroUsd');
  const operations = assertOperationsAccounts(input.operations);
  const admission = input.admission === undefined ? null : normalizePolicyAdmission(input.admission, operations);
  if (admission !== null) {
    if (input.cycleId !== undefined && input.cycleId !== null && input.cycleId !== admission.cycleId) {
      throw new Error('policy admission cycleId does not match policy context');
    }
    if (releaseAmountWei !== BigInt(admission.aggregateFundingQuote.amountAtomic) || releaseAmount !== BigInt(admission.aggregateFundingUsd.amountMicroUsd)) {
      throw new Error('policy release amount does not match admitted aggregate funding quote');
    }
    if (input.packId !== undefined && input.packId !== admission.packId) {
      throw new Error('policy admission packId does not match policy context');
    }
    if (input.requestedOrders !== undefined && input.requestedOrders !== admission.quantity) {
      throw new Error('policy admission quantity does not match requested orders');
    }
    if (['cycle-start', 'claim-process', 'purchase'].includes(boundary) && (now >= admission.relay.deadlineUnixSeconds * 1000 || now >= admission.unitRelay.deadlineUnixSeconds * 1000)) {
      return { boundary, liveMode, mode, now, releaseAmount, releaseAmountWei, capMicroUsd, cycleId: input.cycleId ?? admission.cycleId, packId: input.packId ?? admission.packId, admission, operations, expiredAdmission: true };
    }
  }
  return { boundary, liveMode, mode, now, releaseAmount, releaseAmountWei, capMicroUsd, cycleId: input.cycleId ?? admission?.cycleId ?? null, packId: input.packId ?? null, admission, operations };
}

function evaluateConfiguredPolicy({ configuration, custody, ...input }) {
  const context = admissionContext(input);
  const normalized = assertOperatorHardCaps(assertOperatorConfiguration(configuration));
  const custodyState = normalizeCustody(custody);
  if (['claim-process', 'purchase'].includes(context.boundary) && !hasFreshFundingUsd(input.admission, input.verifyQuoteUsdValuation, context.now)) return refused('USD_VALUATION_UNVERIFIED');
  if (context.expiredAdmission) return refused('QUOTE_EXPIRED');
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
    if (custodyState.unattributed) return refused('UNATTRIBUTED_CUSTODY');
    if (custodyState.unvaluedExposure) return refused('UNVALUED_CUSTODY');
    if (custodyState.heldPositions.count >= normalized.maxHeldPositions
      || custodyState.heldPositions.valueMicroUsd > BigInt(normalized.maxHeldValueMicroUsd)) {
      return refused('HELD_LIMIT');
    }
    if (!normalized.allowedPackIds.includes(context.packId)) return refused('PACK_NOT_ALLOWED');
    if (normalized.requestedOrders === 0) return refused('NO_ORDERS_REQUESTED');
    if (context.admission !== null && context.admission.quantity !== normalized.requestedOrders) return refused('QUANTITY_MISMATCH');
    if (context.releaseAmount > effectiveCycleCap(normalized, context)) return refused('PER_CYCLE_CAP');
    if (context.releaseAmount > BigInt(normalized.maxCycleBudgetMicroUsd)) return refused('PER_CYCLE_CAP');

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
      releaseCostMicroUsd: context.releaseAmount.toString(),
    releaseAmountWei: context.releaseAmountWei.toString(),
      packId: context.packId,
      liveMode: context.liveMode,
      mode: context.mode,
      admission: context.admission ?? undefined,
      operations: context.operations,
    });
    const cycleDigest = existing
      ? matchingExistingCycleDigest({
        configuration: normalized,
        existing,
        cycleId: context.cycleId,
        releaseCostMicroUsd: context.releaseAmount.toString(),
        releaseAmountWei: context.releaseAmountWei.toString(),
        packId: context.packId,
        liveMode: context.liveMode,
        mode: context.mode,
        admission: context.admission ?? undefined,
        operations: context.operations,
      })
      : derivedCycleDigest;
    if (cycleDigest === null) return refused('CYCLE_POLICY_DIGEST_CHANGED');

    const spendInWindow = withinTrailingWindow(normalized.spendLedger, 'reservedAtMs', context.now)
      .reduce((sum, entry) => sum + BigInt(entry.amountMicroUsd), 0n);
    const alreadyReserved = normalized.spendLedger.find(entry => entry.cycleDigest === cycleDigest);
    if (existing && (!alreadyReserved || alreadyReserved.amountMicroUsd !== context.releaseAmount.toString())) {
      return refused('SPEND_RESERVATION_MISSING');
    }
    if (alreadyReserved && !withinTrailingWindow([alreadyReserved], 'reservedAtMs', context.now).length) {
      return refused('SPEND_RESERVATION_EXPIRED');
    }
    const additionalSpend = alreadyReserved ? 0n : context.releaseAmount;
    const accounted = custodyState.cycleExposureMicroUsd[context.cycleId];
    if (alreadyReserved && accounted === undefined) return refused('UNVALUED_CUSTODY');
    const accountedCost = accounted === undefined ? 0n : assertAmount(accounted, 'policy cycle exposure MicroUsd');
    if (accountedCost > custodyState.atRiskMicroUsd || accountedCost > custodyState.outstandingMicroUsd) throw new Error('policy cycle exposure exceeds total custody');
    const reservedCost = alreadyReserved ? BigInt(alreadyReserved.amountMicroUsd) : context.releaseAmount;
    const pendingPrincipal = reservedCost > accountedCost ? reservedCost - accountedCost : 0n;
    if (spendInWindow + additionalSpend > BigInt(normalized.max24HourBudgetMicroUsd)) return refused('ROLLING_24H_CAP');

    const modeCycles = normalized.cycleLedger.filter(entry => entry.mode === context.mode);
    const ordinal = existing
      ? modeCycles.findIndex(entry => entry.cycleDigest === cycleDigest) + 1
      : modeCycles.length + 1;
    if (ordinal > 0 && ordinal <= normalized.manualApprovalCycles) {
      const approval = normalized.approvalsByCycleDigest[cycleDigest];
      if (!approval || approval.cycleId !== context.cycleId) return refused('MANUAL_APPROVAL_REQUIRED');
    }

    if (custodyState.realizedLossMicroUsd + custodyState.atRiskMicroUsd + pendingPrincipal > BigInt(normalized.lossCapMicroUsd)) {
      return refused('LOSS_CAP');
    }
    if (custodyState.outstandingMicroUsd + pendingPrincipal > BigInt(normalized.maxOutstandingCustodyMicroUsd)) {
      return refused('OUTSTANDING_CUSTODY_CAP');
    }
    return allowed(cycleDigest);
  }

  if (context.boundary === 'purchase') {
    if (context.cycleId === null || context.packId === null) throw new Error('policy purchase requires cycleId and packId');
    if (custodyState.unattributed) return refused('UNATTRIBUTED_CUSTODY');
    if (custodyState.unvaluedExposure) return refused('UNVALUED_CUSTODY');
    if (!normalized.allowedPackIds.includes(context.packId)) return refused('PACK_NOT_ALLOWED');
    const unitFundingAmount = context.admission === null ? context.releaseAmount : BigInt(context.admission.unitFundingUsd.amountMicroUsd);
    if (unitFundingAmount > BigInt(normalized.maxUnitPriceMicroUsd)) return refused('UNIT_PRICE_CAP');
    const existing = existingCycle(normalized, context.cycleId);
    if (!existing) return refused('CYCLE_POLICY_MISSING');
    const expectedDigest = matchingExistingCycleDigest({
      configuration: normalized,
      existing,
      cycleId: context.cycleId,
      releaseCostMicroUsd: existing.releaseCostMicroUsd,
      releaseAmountWei: existing.releaseAmountWei,
      packId: context.packId,
      liveMode: context.liveMode,
      mode: context.mode,
      admission: context.admission ?? undefined,
      operations: context.operations,
    });
    if (expectedDigest === null) return refused('CYCLE_POLICY_DIGEST_CHANGED');
    const reservation = normalized.spendLedger.find(entry => entry.cycleDigest === expectedDigest);
    if (!reservation || context.releaseAmount > BigInt(reservation.amountMicroUsd)) return refused('SPEND_RESERVATION_MISSING');
    if (!withinTrailingWindow([reservation], 'reservedAtMs', context.now).length) return refused('SPEND_RESERVATION_EXPIRED');
    if (context.releaseAmount > effectiveCycleCap(normalized, context)) return refused('PER_CYCLE_CAP');
    if (custodyState.realizedLossMicroUsd + custodyState.atRiskMicroUsd > BigInt(normalized.lossCapMicroUsd)) {
      return refused('LOSS_CAP');
    }
    if (custodyState.outstandingMicroUsd > BigInt(normalized.maxOutstandingCustodyMicroUsd)) {
      return refused('OUTSTANDING_CUSTODY_CAP');
    }
    return allowed(expectedDigest);
  }

  return allowed();
}

export function decodeHistoricalPolicyAdmission(value, operations) {
  return normalizePolicyAdmission(value, operations, { historical: true });
}

export function assertPolicyAdmission(value, operations) {
  return normalizePolicyAdmission(value, operations);
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

/**
 * REQ-cycle-repository-2 / ADR-0025 `refresh-after-readmission`'s policy boundary. Re-admits a
 * selected replacement quote against *current* configuration and caps while proving the immutable
 * original admission's already-reserved principal is still recognized -- never a second
 * reservation, and never `admissionContext`'s ordinary quote-deadline gate, which every other
 * boundary enforces and which a refresh exists precisely to route around (the original admission is
 * expired by definition here). The returned digest binds the original admission and the complete
 * replacement together; it is never the cycle-policy digest itself, so a refresh decision can never
 * be presented in place of -- or mistaken for -- the original admission's own digest.
 */
export function evaluateQuoteRefresh(input) {
  const {
    configuration, custody, cycleId, releaseCostMicroUsd, releaseAmountWei, packId, liveMode, mode, capMicroUsd,
    admission, replacement, operations, now,
  } = input ?? {};
  if (admission === undefined || admission === null) {
    throw new Error('policy quote refresh requires the immutable original admission');
  }
  if (replacement === undefined || replacement === null) {
    throw new Error('policy quote refresh requires the complete replacement admission');
  }
  assertCycleId(cycleId);
  assertPackId(packId);
  assertClock(now);
  const resolvedOperations = assertOperationsAccounts(operations);
  const normalizedAdmission = normalizePolicyAdmission(admission, resolvedOperations);
  const normalizedReplacement = normalizePolicyAdmission(replacement, resolvedOperations);
  if (normalizedAdmission.cycleId !== cycleId || normalizedReplacement.cycleId !== cycleId) {
    throw new Error('policy quote refresh admission/replacement does not name this cycle');
  }
  const releaseAmount = assertAmount(releaseCostMicroUsd, 'policy releaseCostMicroUsd', { positive: true });
  if (releaseAmountWei !== normalizedAdmission.aggregateFundingQuote.amountAtomic
    || releaseAmountWei !== normalizedReplacement.aggregateFundingQuote.amountAtomic) {
    throw new Error('policy quote refresh release amount does not match the immutable admitted principal');
  }
  if (!hasFreshFundingUsd(replacement, input.verifyQuoteUsdValuation, now)) return refused('USD_VALUATION_UNVERIFIED');
  if (BigInt(normalizedReplacement.aggregateFundingUsd.amountMicroUsd) > releaseAmount) return refused('PER_CYCLE_CAP');
  const normalized = assertOperatorHardCaps(assertOperatorConfiguration(configuration));
  if (normalized.liveMode !== liveMode) return refused('EXECUTION_MODE_MISMATCH');
  if (normalized.killSwitch) return refused('KILL_SWITCH');
  if (normalized.executionPaused) return refused('EXECUTION_PAUSED');
  if (BigInt(normalizedReplacement.unitFundingUsd.amountMicroUsd) > BigInt(normalized.maxUnitPriceMicroUsd)) {
    return refused('UNIT_PRICE_CAP');
  }
  const resolvedCapMicroUsd = capMicroUsd === undefined ? null : assertAmount(capMicroUsd, 'policy capMicroUsd');
  const decision = evaluateExistingCycleExecution({
    configuration: normalized,
    custodyState: normalizeCustody(custody),
    context: {
      cycleId, packId, releaseAmount, releaseAmountWei: BigInt(releaseAmountWei), capMicroUsd: resolvedCapMicroUsd, liveMode, mode,
      admission: normalizedAdmission, operations: resolvedOperations,
    },
  });
  if (!decision.allowed) return decision;
  const refreshPolicyDecisionDigest = digest({
    schema: 'hookemon.outbound-quote-refresh-decision.v1',
    cycleId,
    cycleDigest: decision.cycleDigest,
    admission: normalizedAdmission,
    replacement: normalizedReplacement,
  });
  return Object.freeze({ allowed: true, refreshPolicyDecisionDigest });
}

function reservationConfiguration(configuration, { cycleId, cycleDigest, releaseCostMicroUsd, releaseAmountWei, liveMode, mode, now }) {
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
      releaseCostMicroUsd,
      releaseAmountWei,
    },
  ];
  const spendLedger = [
    ...configuration.spendLedger,
    {
      cycleId,
      cycleDigest,
      amountMicroUsd: releaseCostMicroUsd,
      reservedAtMs: now,
    },
  ];
  return assertOperatorConfiguration({ ...configuration, cycleLedger, spendLedger });
}

function assertEngineDependency(value, name) {
  if (typeof value !== 'function') throw new Error(`policy engine ${name} is required`);
  return value;
}

export function createPolicyEngine({ now = () => Date.now(), readConfiguration, readCustody = async () => zeroCustody(), mutateConfiguration, verifyQuoteUsdValuation = () => false }) {
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
    return evaluateConfiguredPolicy({ ...input, configuration, custody, verifyQuoteUsdValuation, now: now() });
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
        const decision = evaluateConfiguredPolicy({ ...input, configuration, custody, verifyQuoteUsdValuation, now: now() });
        if (!decision.allowed) return { configuration, result: decision };
        const next = reservationConfiguration(configuration, {
          cycleId: input.cycleId,
          cycleDigest: decision.cycleDigest,
          releaseCostMicroUsd: input.releaseCostMicroUsd,
          releaseAmountWei: input.releaseAmountWei,
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
        || input?.releaseCostMicroUsd !== undefined
        || input?.packId !== undefined;
      if ((boundary === 'signature' || boundary === 'broadcast') && hasCycleContext
        && (typeof input.requestDigest !== 'string' || !digestPattern.test(input.requestDigest))) {
        throw new Error('policy execution requestDigest is invalid');
      }
      const decision = await evaluate({ ...input, boundary, liveMode });
      if (!decision.allowed) throw new PolicyRefusalError(decision.reason);
      return decision;
    },
    async evaluateQuoteRefresh(input) {
      const configuration = await readConfiguration();
      if (configuration === null) return refused('CONFIGURATION_MISSING');
      const custody = await readCustody();
      return evaluateQuoteRefresh({ ...input, configuration, custody, verifyQuoteUsdValuation, now: now() });
    },
  });
}
