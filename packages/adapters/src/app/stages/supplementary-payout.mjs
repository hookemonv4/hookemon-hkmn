import { compileSupplementaryDirectPayoutPlan } from '../../../../runner/src/distribution/payout-plan.mjs';
import { digest } from '../../../../runner/src/cycle/journal.mjs';
import { assertPayoutManifestUnchanged } from './payout.mjs';

const HELD_POSITION_ID = /^held:[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SETTLEMENT_STATES = new Set(['PREPARED', 'BUYBACK_SENT_UNKNOWN', 'RETURN_BROADCAST', 'PAYOUT_BROADCAST', 'COMPLETE']);
const STATE_SCHEMA = 'hookemon.supplementary-payout-state.v2';
const SOURCE_SCHEMA = 'hookemon.supplementary-payout-source.v2';
const RETURN_BOUNDARY_SCHEMA = 'hookemon.supplementary-return-boundary.v2';
const FINALIZED_RETURN_SCHEMA = 'hookemon.supplementary-finalized-return.v2';
const SETTLEMENT_EVIDENCE_SCHEMA = 'hookemon.supplementary-settlement-evidence.v2';
const ADDRESS = /^0x[0-9a-f]{40}$/;
const ATOMIC = /^(?:0|[1-9][0-9]*)$/;

export class SupplementaryPayoutError extends Error {}

function fail(message) {
  throw new SupplementaryPayoutError(message);
}

function exactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== fields.length
    || !fields.every(field => Object.hasOwn(value, field))) {
    fail(`${label} must use the exact schema`);
  }
  return value;
}

function freeze(value) {
  if (Array.isArray(value)) value.forEach(freeze);
  else if (value && typeof value === 'object') Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

export function assertSettlement(value) {
  exactObject(value, [
    'positionId',
    'cycleId',
    'manifestId',
    'state',
    'positionEvidenceDigest',
    'eligibilitySnapshotEvidenceDigest',
    'payoutSourceDigest',
  ], 'supplementary payout settlement');
  if (typeof value.positionId !== 'string' || !HELD_POSITION_ID.test(value.positionId)) {
    fail('supplementary payout settlement positionId is invalid');
  }
  if (typeof value.cycleId !== 'string' || value.cycleId.length === 0) {
    fail('supplementary payout settlement cycleId is invalid');
  }
  if (typeof value.manifestId !== 'string' || !value.manifestId.startsWith(`${value.cycleId}:supplementary:`)) {
    fail('supplementary payout settlement manifestId is invalid');
  }
  const suffix = value.manifestId.slice(`${value.cycleId}:supplementary:`.length);
  if (!/^[1-9][0-9]*$/.test(suffix) || !Number.isSafeInteger(Number(suffix))) {
    fail('supplementary payout settlement manifestId index is invalid');
  }
  if (!SETTLEMENT_STATES.has(value.state)) fail('supplementary payout settlement state is invalid');
  if (typeof value.positionEvidenceDigest !== 'string' || !DIGEST.test(value.positionEvidenceDigest)) {
    fail('supplementary payout settlement positionEvidenceDigest is invalid');
  }
  if (typeof value.eligibilitySnapshotEvidenceDigest !== 'string' || !DIGEST.test(value.eligibilitySnapshotEvidenceDigest)) {
    fail('supplementary payout settlement eligibilitySnapshotEvidenceDigest is invalid');
  }
  if (['RETURN_BROADCAST', 'PAYOUT_BROADCAST', 'COMPLETE'].includes(value.state)) {
    if (typeof value.payoutSourceDigest !== 'string' || !DIGEST.test(value.payoutSourceDigest)) {
      fail('supplementary payout settlement payoutSourceDigest is required after return broadcast');
    }
  } else if (value.payoutSourceDigest !== null) {
    fail('supplementary payout settlement payoutSourceDigest is invalid before return broadcast');
  }
  return Object.freeze({
    positionId: value.positionId,
    cycleId: value.cycleId,
    manifestId: value.manifestId,
    state: value.state,
    positionEvidenceDigest: value.positionEvidenceDigest,
    eligibilitySnapshotEvidenceDigest: value.eligibilitySnapshotEvidenceDigest,
    payoutSourceDigest: value.payoutSourceDigest,
    supplementaryIndex: Number(suffix),
  });
}

function assertNativeAsset(value) { if (value !== 'native') fail('supplementary payout asset must be native'); return value; }

function assertAddress(value, label) {
  if (typeof value !== 'string' || !ADDRESS.test(value) || value !== value.toLowerCase()) {
    fail(`${label} is invalid`);
  }
  return value;
}

function assertAmount(value, expectedAssetId, label) {
  exactObject(value, ['chainId', 'assetId', 'decimals', 'amountAtomic'], label);
  if (value.chainId !== '4663' || value.assetId !== expectedAssetId || value.decimals !== 18
    || typeof value.amountAtomic !== 'string' || !ATOMIC.test(value.amountAtomic)) {
    fail(`${label} does not identify the bound native ETH amount`);
  }
  return Object.freeze(structuredClone(value));
}

function assertDustSource(value, settlement, label) {
  if (value === null) return null;
  exactObject(value, ['cycleId', 'digest', 'planDigest'], label);
  if (value.cycleId !== settlement.cycleId || typeof value.digest !== 'string' || !DIGEST.test(value.digest)
    || typeof value.planDigest !== 'string' || !DIGEST.test(value.planDigest)) {
    fail(`${label} does not bind the original cycle normal dust`);
  }
  return Object.freeze(structuredClone(value));
}

function assertPayoutSource(value, settlement, label = 'supplementary payout source') {
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
  if (value.schema !== SOURCE_SCHEMA || value.positionId !== settlement.positionId
    || value.cycleId !== settlement.cycleId || value.manifestId !== settlement.manifestId) {
    fail(`${label} does not bind its supplementary settlement`);
  }
  exactObject(value.returnBinding, ['operations', 'assetId', 'evidenceDigest'], `${label} returnBinding`);
  const returnBinding = Object.freeze({
    operations: assertAddress(value.returnBinding.operations, `${label} Operations address`),
    assetId: assertNativeAsset(value.returnBinding.assetId),
    evidenceDigest: value.returnBinding.evidenceDigest,
  });
  if (!DIGEST.test(returnBinding.evidenceDigest)) fail(`${label} return evidence digest is invalid`);
  const finalizedReturn = assertAmount(value.finalizedReturn, returnBinding.assetId, `${label} finalized return`);
  const previousDust = assertAmount(value.previousDust, returnBinding.assetId, `${label} previous dust`);
  const previousDustSource = assertDustSource(value.previousDustSource, settlement, `${label} previous dust source`);
  if ((previousDust.amountAtomic === '0') !== (previousDustSource === null)) {
    fail(`${label} previous dust provenance is invalid`);
  }
  return Object.freeze({
    schema: SOURCE_SCHEMA,
    positionId: settlement.positionId,
    cycleId: settlement.cycleId,
    manifestId: settlement.manifestId,
    finalizedReturn,
    previousDust,
    previousDustSource,
    returnBinding,
  });
}

export function assertReturnBoundaryEvidence(value, settlement, label) {
  exactObject(value, ['schema', 'positionId', 'cycleId', 'manifestId', 'finalizedReturnEvidence'], label);
  if (value.schema !== RETURN_BOUNDARY_SCHEMA || value.positionId !== settlement.positionId
    || value.cycleId !== settlement.cycleId || value.manifestId !== settlement.manifestId) {
    fail(`${label} does not bind its supplementary settlement`);
  }
  const finalized = value.finalizedReturnEvidence;
  exactObject(finalized, [
    'schema',
    'positionId',
    'cycleId',
    'manifestId',
    'operations',
    'assetId',
    'amountAtomic',
    'finalityEvidence',
  ], `${label} finalized return evidence`);
  if (finalized.schema !== FINALIZED_RETURN_SCHEMA || finalized.positionId !== settlement.positionId
    || finalized.cycleId !== settlement.cycleId || finalized.manifestId !== settlement.manifestId) {
    fail(`${label} finalized return evidence does not bind its supplementary settlement`);
  }
  const operations = assertAddress(finalized.operations, `${label} finalized return Operations address`);
  const assetId = assertNativeAsset(finalized.assetId);
  if (typeof finalized.amountAtomic !== 'string' || !ATOMIC.test(finalized.amountAtomic)) {
    fail(`${label} finalized return amount is invalid`);
  }
  if (!finalized.finalityEvidence || typeof finalized.finalityEvidence !== 'object'
    || Array.isArray(finalized.finalityEvidence)) {
    fail(`${label} finalized return finality evidence is invalid`);
  }
  const finalizedReturnEvidence = Object.freeze(structuredClone({
    schema: FINALIZED_RETURN_SCHEMA,
    positionId: settlement.positionId,
    cycleId: settlement.cycleId,
    manifestId: settlement.manifestId,
    operations,
    assetId,
    amountAtomic: finalized.amountAtomic,
    finalityEvidence: finalized.finalityEvidence,
  }));
  return Object.freeze({
    schema: RETURN_BOUNDARY_SCHEMA,
    positionId: settlement.positionId,
    cycleId: settlement.cycleId,
    manifestId: settlement.manifestId,
    finalizedReturnEvidence,
    finalizedReturn: Object.freeze({
      chainId: '4663',
      assetId: assetId,
      decimals: 18,
      amountAtomic: finalized.amountAtomic,
    }),
    returnBinding: Object.freeze({
      operations,
      assetId,
      evidenceDigest: digest({
        schema: 'hookemon.supplementary-finalized-return-binding.v2',
        positionId: settlement.positionId,
        cycleId: settlement.cycleId,
        manifestId: settlement.manifestId,
        finalizedReturnEvidence,
      }),
    }),
  });
}

function assertReturnBoundary(value, settlement) {
  exactObject(value, ['state', 'evidenceDigest', 'evidence', 'payoutSource'], 'supplementary payout return boundary');
  if (value.state !== 'RETURN_BROADCAST' || typeof value.evidenceDigest !== 'string' || !DIGEST.test(value.evidenceDigest)) {
    fail('supplementary payout return boundary is invalid');
  }
  const evidence = assertReturnBoundaryEvidence(value.evidence, settlement, 'supplementary payout return boundary evidence');
  const payoutSource = assertPayoutSource(value.payoutSource, settlement, 'supplementary payout return boundary source');
  if (digest({ finalizedReturn: payoutSource.finalizedReturn, returnBinding: payoutSource.returnBinding })
    !== digest({ finalizedReturn: evidence.finalizedReturn, returnBinding: evidence.returnBinding })) {
    fail('supplementary payout return boundary source does not match its finalized return evidence');
  }
  if (digest(payoutSource) !== settlement.payoutSourceDigest) {
    fail('supplementary payout return boundary source does not match the durable settlement');
  }
  const evidenceDigest = digest({
    schema: SETTLEMENT_EVIDENCE_SCHEMA,
    positionId: settlement.positionId,
    manifestId: settlement.manifestId,
    state: 'RETURN_BROADCAST',
    evidence: {
      schema: evidence.schema,
      positionId: evidence.positionId,
      cycleId: evidence.cycleId,
      manifestId: evidence.manifestId,
      finalizedReturnEvidence: evidence.finalizedReturnEvidence,
    },
    payoutSourceDigest: settlement.payoutSourceDigest,
  });
  if (evidenceDigest !== value.evidenceDigest) {
    fail('supplementary payout return boundary evidence digest is invalid');
  }
  return Object.freeze({
    state: 'RETURN_BROADCAST',
    evidenceDigest,
    evidence: Object.freeze({
      schema: evidence.schema,
      positionId: evidence.positionId,
      cycleId: evidence.cycleId,
      manifestId: evidence.manifestId,
      finalizedReturnEvidence: evidence.finalizedReturnEvidence,
    }),
    payoutSource,
  });
}

function assertDurableReturnBoundary(value, settlement) {
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'returnBoundary')) {
    return assertReturnBoundary(value.returnBoundary, settlement);
  }
  return assertReturnBoundary(value, settlement);
}

function payoutSourceForPlan(plan, settlement) {
  return assertPayoutSource({
    schema: SOURCE_SCHEMA,
    positionId: settlement.positionId,
    cycleId: settlement.cycleId,
    manifestId: settlement.manifestId,
    finalizedReturn: plan.payoutPlan?.returnDelta,
    previousDust: plan.payoutPlan?.previousDust,
    previousDustSource: plan.payoutPlan?.previousDustSource,
    returnBinding: plan.payoutPlan?.returnEvidence,
  }, settlement, 'supplementary payout plan source');
}

function assertRequest(value) {
  exactObject(value, [
    'schema',
    'positionId',
    'cycleId',
    'manifestId',
    'positionEvidenceDigest',
    'eligibilitySnapshotEvidenceDigest',
    'payoutSourceDigest',
    'returnBoundaryEvidenceDigest',
    'supplementaryPlanDigest',
    'plan',
  ], 'supplementary payout request');
  if (value.schema !== 'hookemon.supplementary-payout-request.v2') fail('supplementary payout request schema is invalid');
  const settlement = assertSettlement({
    positionId: value.positionId,
    cycleId: value.cycleId,
    manifestId: value.manifestId,
    state: 'RETURN_BROADCAST',
    positionEvidenceDigest: value.positionEvidenceDigest,
    eligibilitySnapshotEvidenceDigest: value.eligibilitySnapshotEvidenceDigest,
    payoutSourceDigest: value.payoutSourceDigest,
  });
  if (!value.plan || typeof value.plan !== 'object' || Array.isArray(value.plan)
    || ![
      'hookemon.supplementary-direct-payout-plan.v2',
      'hookemon.supplementary-direct-payout-plan.v3',
      'hookemon.supplementary-direct-payout-plan.v4',
    ].includes(value.plan.schema)
    || value.plan.cycleId !== settlement.cycleId
    || value.plan.manifestId !== settlement.manifestId
    || value.plan.supplementaryIndex !== settlement.supplementaryIndex
    || value.plan.supplementaryPlanDigest !== value.supplementaryPlanDigest) {
    fail('supplementary payout request plan does not bind its settlement');
  }
  if (typeof value.supplementaryPlanDigest !== 'string' || !DIGEST.test(value.supplementaryPlanDigest)) {
    fail('supplementary payout request supplementaryPlanDigest is invalid');
  }
  if (typeof value.returnBoundaryEvidenceDigest !== 'string' || !DIGEST.test(value.returnBoundaryEvidenceDigest)) {
    fail('supplementary payout request returnBoundaryEvidenceDigest is invalid');
  }
  const planSource = payoutSourceForPlan(value.plan, settlement);
  if (digest(planSource) !== settlement.payoutSourceDigest) {
    fail('supplementary payout request plan does not match the durable payout source');
  }
  if (planSource.previousDust.amountAtomic !== '0') {
    fail('supplementary payout requires a position-aware atomic dust reservation before carrying normal-cycle dust');
  }
  return freeze(structuredClone(value));
}

function assertPayoutStateForRequest(value, request) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('supplementary payout state is invalid');
  try {
    assertPayoutManifestUnchanged(value, request.plan.payoutPlan);
  } catch (error) {
    fail(`supplementary payout state is invalid: ${error.message}`);
  }
  if (value.cycleId !== request.cycleId || value.planDigest !== request.plan.payoutPlan.planDigest) {
    fail('supplementary payout state does not bind the immutable supplementary plan');
  }
  return structuredClone(value);
}

function envelopeFor(request, payoutState) {
  const normalizedPayoutState = assertPayoutStateForRequest(payoutState, request);
  const { recipients, ...withoutRecipients } = normalizedPayoutState;
  return {
    schema: STATE_SCHEMA,
    positionId: request.positionId,
    cycleId: request.cycleId,
    manifestId: request.manifestId,
    positionEvidenceDigest: request.positionEvidenceDigest,
    eligibilitySnapshotEvidenceDigest: request.eligibilitySnapshotEvidenceDigest,
    payoutSourceDigest: request.payoutSourceDigest,
    returnBoundaryEvidenceDigest: request.returnBoundaryEvidenceDigest,
    supplementaryPlanDigest: request.supplementaryPlanDigest,
    // DurableCycleStore pages the outer recipient list. Keeping it here avoids duplicating a
    // 1,025-recipient direct-payout state inside the envelope on every durable generation.
    recipients,
    payoutState: withoutRecipients,
  };
}

function unwrapEnvelope(value, request) {
  if (value === null || value === undefined) return null;
  exactObject(value, [
    'schema',
    'positionId',
    'cycleId',
    'manifestId',
    'positionEvidenceDigest',
    'eligibilitySnapshotEvidenceDigest',
    'payoutSourceDigest',
    'returnBoundaryEvidenceDigest',
    'supplementaryPlanDigest',
    'recipients',
    'payoutState',
  ], 'supplementary payout state');
  for (const field of [
    'positionId',
    'cycleId',
    'manifestId',
    'positionEvidenceDigest',
    'eligibilitySnapshotEvidenceDigest',
    'payoutSourceDigest',
    'returnBoundaryEvidenceDigest',
    'supplementaryPlanDigest',
  ]) {
    if (value[field] !== request[field]) fail(`supplementary payout state ${field} does not match its settlement`);
  }
  if (value.schema !== STATE_SCHEMA) fail('supplementary payout state schema is invalid');
  if (!value.payoutState || typeof value.payoutState !== 'object' || Array.isArray(value.payoutState)) {
    fail('supplementary payout state payload is invalid');
  }
  return assertPayoutStateForRequest({ ...value.payoutState, recipients: value.recipients }, request);
}

function assertRequestForSettlement(request, settlement) {
  if (request.positionId !== settlement.positionId
    || request.cycleId !== settlement.cycleId
    || request.manifestId !== settlement.manifestId
    || request.positionEvidenceDigest !== settlement.positionEvidenceDigest
    || request.eligibilitySnapshotEvidenceDigest !== settlement.eligibilitySnapshotEvidenceDigest
    || request.payoutSourceDigest !== settlement.payoutSourceDigest) {
    fail('supplementary payout request does not match its durable store');
  }
}

/**
 * Schema tags for the immutable return-boundary evidence, exposed so `supplementary-money.mjs`
 * can build a durable `RETURN_BROADCAST` transition without a second, divergent copy of these
 * literal strings.
 */
export const SUPPLEMENTARY_RETURN_BOUNDARY_SCHEMA = RETURN_BOUNDARY_SCHEMA;
export const SUPPLEMENTARY_FINALIZED_RETURN_SCHEMA = FINALIZED_RETURN_SCHEMA;

/** Returns the durable paged-state namespace for one held-position payout. */
export function supplementaryPayoutStageId(positionId) {
  if (typeof positionId !== 'string' || !HELD_POSITION_ID.test(positionId)) {
    fail('supplementary payout positionId is invalid');
  }
  return `supplementary-${positionId.slice('held:'.length, 'held:'.length + 48)}`;
}

/**
 * Freezes the original cycle's eligibility snapshot into a new supplementary payout manifest.
 * The repository's return boundary is the sole source for attributed proceeds, return identities,
 * and the zero-value dust carry used until a position-aware atomic reservation exists. Callers
 * cannot supply alternate payout inputs.
 */
export function prepareSupplementaryPayoutRequest(value, { legacyPlanSchema = null } = {}) {
  if (legacyPlanSchema !== null && legacyPlanSchema !== 'hookemon.direct-payout-plan.v3') {
    fail('supplementary payout legacy plan schema is invalid');
  }
  exactObject(value, ['settlement', 'eligibilityManifest', 'returnBoundary'], 'supplementary payout preparation');
  const { settlement, eligibilityManifest, returnBoundary } = value;
  const normalizedSettlement = assertSettlement(settlement);
  if (!['RETURN_BROADCAST', 'PAYOUT_BROADCAST'].includes(normalizedSettlement.state)) {
    fail('supplementary payout requires a return-broadcast settlement');
  }
  if (digest(eligibilityManifest) !== normalizedSettlement.eligibilitySnapshotEvidenceDigest) {
    fail('supplementary payout eligibility snapshot evidence digest does not match the original cycle');
  }
  const normalizedReturnBoundary = assertReturnBoundary(returnBoundary, normalizedSettlement);
  const plan = compileSupplementaryDirectPayoutPlan({
    cycleId: normalizedSettlement.cycleId,
    supplementaryIndex: normalizedSettlement.supplementaryIndex,
    eligibilityManifest,
    finalizedReturn: normalizedReturnBoundary.payoutSource.finalizedReturn,
    previousDust: normalizedReturnBoundary.payoutSource.previousDust,
    previousDustSource: normalizedReturnBoundary.payoutSource.previousDustSource,
    returnBinding: normalizedReturnBoundary.payoutSource.returnBinding,
    legacyPlanSchema,
  });
  if (plan.manifestId !== normalizedSettlement.manifestId) {
    fail('supplementary payout plan manifestId does not match its settlement');
  }
  if (digest(payoutSourceForPlan(plan, normalizedSettlement)) !== normalizedSettlement.payoutSourceDigest) {
    fail('supplementary payout plan does not match the durable return boundary');
  }
  return assertRequest({
    schema: 'hookemon.supplementary-payout-request.v2',
    positionId: normalizedSettlement.positionId,
    cycleId: normalizedSettlement.cycleId,
    manifestId: normalizedSettlement.manifestId,
    positionEvidenceDigest: normalizedSettlement.positionEvidenceDigest,
    eligibilitySnapshotEvidenceDigest: normalizedSettlement.eligibilitySnapshotEvidenceDigest,
    payoutSourceDigest: normalizedSettlement.payoutSourceDigest,
    returnBoundaryEvidenceDigest: normalizedReturnBoundary.evidenceDigest,
    supplementaryPlanDigest: plan.supplementaryPlanDigest,
    plan,
  });
}

/**
 * Adapts the existing recipient-level direct-payout journal to one supplementary manifest. The
 * outer envelope prevents a process restart from loading a different held card's transfer state.
 */
export function createSupplementaryPayoutStore({ cycleRepository, settlement }) {
  if (!cycleRepository || typeof cycleRepository.readPagedPayoutState !== 'function'
    || typeof cycleRepository.persistPagedPayoutState !== 'function'
    || typeof cycleRepository.readSupplementarySettlementEvidence !== 'function') {
    fail('supplementary payout store requires repository paged payout state methods');
  }
  const normalizedSettlement = assertSettlement(settlement);
  const stage = supplementaryPayoutStageId(normalizedSettlement.positionId);
  return Object.freeze({
    async load(request) {
      const normalizedRequest = assertRequest(request);
      assertRequestForSettlement(normalizedRequest, normalizedSettlement);
      return unwrapEnvelope(await cycleRepository.readPagedPayoutState(normalizedSettlement.cycleId, stage), normalizedRequest);
    },
    async persist(request, payoutState) {
      const normalizedRequest = assertRequest(request);
      assertRequestForSettlement(normalizedRequest, normalizedSettlement);
      const durableBoundary = assertDurableReturnBoundary(
        await cycleRepository.readSupplementarySettlementEvidence(normalizedSettlement.positionId),
        normalizedSettlement,
      );
      if (durableBoundary.evidenceDigest !== normalizedRequest.returnBoundaryEvidenceDigest) {
        fail('supplementary payout request does not match the durable return boundary');
      }
      const normalizedPayoutState = assertPayoutStateForRequest(payoutState, normalizedRequest);
      const envelope = envelopeFor(normalizedRequest, normalizedPayoutState);
      await cycleRepository.persistPagedPayoutState(normalizedSettlement.cycleId, stage, envelope);
      return normalizedPayoutState;
    },
  });
}

/** Verifies that a recovered direct-payout state cannot switch supplementary manifests after broadcast. */
export function assertSupplementaryPayoutManifestUnchanged(payoutState, request) {
  const normalizedRequest = assertRequest(request);
  return assertPayoutStateForRequest(payoutState, normalizedRequest) && true;
}
