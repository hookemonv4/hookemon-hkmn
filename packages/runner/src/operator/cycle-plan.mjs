import { validateBinding } from '../cycle/bindings.mjs';
import { canonicalJson, digest } from '../cycle/journal.mjs';
import {
  PRODUCTION_CYCLE_ESCROW_OBSERVATION_SCHEMA,
  assertProductionCycleEscrowObservationShape,
  verifyFixtureCycleEscrowObservation,
  verifyProductionCycleEscrowObservation,
} from './cycle-escrow-observation.mjs';
import { assertPackSnapshot, selectPack } from './pack-selection.mjs';

const draftInputFields = [
  'cycleId',
  'failedCycleId',
  'failureReceiptDigest',
  'authorizationNonce',
  'packSnapshotDigest',
  'pack',
  'quantity',
  'turbo',
  'amount',
  'minimumRobinhoodReceive',
  'minimumSolanaReceive',
  'minimumReturnUsdg',
  'robinhoodNativeGasCap',
  'solanaNativeGasCap',
  'expiresAt',
  'bindingManifestDigest',
  'outboundActionDigest',
  'returnActionDigest',
  'operationsTrigger',
  'cycleVaultAccount',
  'returnAccount',
];
const draftFields = ['schema', ...draftInputFields];
const frozenFields = ['schema', ...draftInputFields, 'planDigest'];
const requiredDraftInputFields = draftInputFields.filter(field => !['failedCycleId', 'failureReceiptDigest'].includes(field));
const frozenControlFields = ['schema', 'plan', 'packSnapshot', 'binding', 'escrowObservation', 'controlDigest'];
const editableFields = new Set([
  'packSnapshotDigest',
  'pack',
  'amount',
  'minimumRobinhoodReceive',
  'minimumSolanaReceive',
  'minimumReturnUsdg',
  'robinhoodNativeGasCap',
  'solanaNativeGasCap',
  'expiresAt',
  'bindingManifestDigest',
  'outboundActionDigest',
  'returnActionDigest',
]);
const identifier = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;
const positiveDecimal = /^[1-9][0-9]*$/;
const nonnegativeDecimal = /^(?:0|[1-9][0-9]*)$/;
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const bytes32Pattern = /^0x[0-9a-f]{64}$/;
const zeroDigest = `sha256:${'0'.repeat(64)}`;
const zeroBytes32 = `0x${'0'.repeat(64)}`;
const maximumUint256 = (1n << 256n) - 1n;
const packCodePattern = /^[a-z0-9][a-z0-9-]{1,63}$/;
const evmAddress = /^0x[0-9a-f]{40}$/;
const zeroAddress = `0x${'0'.repeat(40)}`;

function assertExactPlainObject(value, fields, label) {
  canonicalJson(value);
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== fields.length
    || !fields.every(field => Object.hasOwn(value, field))
  ) throw new Error(`${label} must use the exact schema`);
}

function assertCycleDraftInput(value) {
  canonicalJson(value);
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) throw new Error('cycle draft input must use the exact schema');
  const keys = Object.keys(value);
  if (
    !requiredDraftInputFields.every(field => Object.hasOwn(value, field))
    || !keys.every(field => draftInputFields.includes(field))
  ) throw new Error('cycle draft input must use the exact schema');
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function isDeepFrozen(value) {
  if (!value || typeof value !== 'object') return true;
  return Object.isFrozen(value) && Object.values(value).every(isDeepFrozen);
}

function assertPositiveUint256(value, label) {
  if (typeof value !== 'string' || !positiveDecimal.test(value) || BigInt(value) > maximumUint256) throw new Error(`${label} must be a positive uint256`);
}

function assertUint256(value, label) {
  if (typeof value !== 'string' || !nonnegativeDecimal.test(value) || BigInt(value) > maximumUint256) throw new Error(`${label} must be a uint256`);
}

function assertDraftBody(value) {
  if (typeof value.cycleId !== 'string' || !identifier.test(value.cycleId)) throw new Error('cycle draft cycleId is invalid');
  if ((value.failedCycleId === null) !== (value.failureReceiptDigest === null)) throw new Error('cycle draft failed predecessor and failure receipt must be supplied together');
  if (value.failedCycleId !== null) {
    if (!bytes32Pattern.test(value.failedCycleId) || value.failedCycleId === zeroBytes32) throw new Error('cycle draft failed predecessor identifier is invalid or zero');
    if (!bytes32Pattern.test(value.failureReceiptDigest) || value.failureReceiptDigest === zeroBytes32) throw new Error('cycle draft failure receipt digest is invalid or zero');
  }
  assertPositiveUint256(value.authorizationNonce, 'cycle draft authorization nonce');
  for (const field of ['packSnapshotDigest', 'bindingManifestDigest', 'outboundActionDigest', 'returnActionDigest']) {
    if (typeof value[field] !== 'string' || !digestPattern.test(value[field]) || value[field] === zeroDigest) throw new Error(`cycle draft ${field} digest is invalid or zero`);
  }
  if (typeof value.pack !== 'string' || !packCodePattern.test(value.pack)) throw new Error('cycle draft pack is invalid');
  if (value.quantity !== 1) throw new Error('cycle draft quantity must equal one');
  if (value.turbo !== false) throw new Error('cycle draft turbo must be false');
  for (const field of [
    'amount',
    'minimumRobinhoodReceive',
    'minimumSolanaReceive',
    'robinhoodNativeGasCap',
    'solanaNativeGasCap',
  ]) {
    assertPositiveUint256(value[field], `cycle draft ${field} amount`);
  }
  assertUint256(value.minimumReturnUsdg, 'cycle draft minimumReturnUsdg amount');
  if (typeof value.expiresAt !== 'string' || new Date(value.expiresAt).toISOString() !== value.expiresAt) throw new Error('cycle draft expiresAt is invalid');
  for (const field of ['operationsTrigger', 'cycleVaultAccount', 'returnAccount']) {
    if (typeof value[field] !== 'string' || !evmAddress.test(value[field]) || value[field] === zeroAddress) throw new Error(`cycle draft ${field} is invalid`);
  }
  if (new Set([value.operationsTrigger, value.cycleVaultAccount, value.returnAccount]).size !== 3) throw new Error('cycle return escrow must differ from Operations and coordinator');
}

function assertFutureExpiry(value) {
  if (Date.parse(value.expiresAt) <= Date.now()) throw new Error('cycle draft expiresAt must be in the future');
}

export function createCycleDraft(input) {
  assertCycleDraftInput(input);
  const candidate = {
    failedCycleId: null,
    failureReceiptDigest: null,
    ...structuredClone(input),
  };
  assertExactPlainObject(candidate, draftInputFields, 'cycle draft input');
  assertDraftBody(candidate);
  assertFutureExpiry(candidate);
  return deepFreeze({ schema: 'hookemon.cycle-draft.v1', ...candidate });
}

export function assertCycleDraft(value) {
  assertExactPlainObject(value, draftFields, 'cycle draft');
  if (value.schema !== 'hookemon.cycle-draft.v1') throw new Error('cycle draft schema is invalid');
  if (!isDeepFrozen(value)) throw new Error('cycle draft must be immutable');
  assertDraftBody(value);
  return value;
}

export function reviseCycleDraft(draftValue, patch) {
  if (draftValue?.schema === 'hookemon.frozen-cycle-plan.v1') throw new Error('frozen cycle plan cannot be revised');
  const draft = assertCycleDraft(draftValue);
  canonicalJson(patch);
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.getPrototypeOf(patch) !== Object.prototype || Object.keys(patch).length === 0) throw new Error('cycle draft patch must use the exact schema');
  for (const field of Object.keys(patch)) if (!editableFields.has(field)) throw new Error(`cycle draft field ${field} is not editable`);
  const { schema: _schema, ...body } = structuredClone(draft);
  return createCycleDraft({ ...body, ...structuredClone(patch) });
}

export function freezeCycleDraft(draftValue, snapshotValue) {
  const draft = assertCycleDraft(draftValue);
  assertFutureExpiry(draft);
  const snapshot = assertPackSnapshot(snapshotValue);
  if (draft.packSnapshotDigest !== snapshot.snapshotDigest) throw new Error('cycle draft pack snapshot mismatch');
  selectPack(snapshot, draft.pack);
  const { schema: _schema, ...draftBody } = structuredClone(draft);
  const body = { schema: 'hookemon.frozen-cycle-plan.v1', ...draftBody };
  return deepFreeze({ ...body, planDigest: digest({ domain: body.schema, plan: body }) });
}

export function assertFrozenCyclePlan(value) {
  assertExactPlainObject(value, frozenFields, 'frozen cycle plan');
  if (value.schema !== 'hookemon.frozen-cycle-plan.v1') throw new Error('frozen cycle plan schema is invalid');
  if (!isDeepFrozen(value)) throw new Error('frozen cycle plan must be immutable');
  assertDraftBody(value);
  if (typeof value.planDigest !== 'string' || !digestPattern.test(value.planDigest)) throw new Error('frozen cycle plan digest is invalid');
  const { planDigest, ...body } = value;
  if (planDigest !== digest({ domain: body.schema, plan: body })) throw new Error('frozen cycle plan digest mismatch');
  return value;
}

export function assertFrozenPlanBinding(planValue, bindingValue) {
  const plan = assertFrozenCyclePlan(planValue);
  const binding = validateBinding(bindingValue);
  if (binding.pack !== plan.pack) throw new Error('binding pack differs from frozen cycle plan');
  if (binding.quantity !== plan.quantity || binding.turbo !== plan.turbo) throw new Error('binding pack mode differs from frozen cycle plan');
  if ([binding.executionWallet, binding.refundTokenAccount, binding.refundTokenAccountOwner].includes(plan.returnAccount)) throw new Error('cycle return escrow conflicts with policy custody');
  return deepFreeze({ plan, binding });
}

// Dispatches by the escrow observation's own `schema` field: the fixture observation is fully
// self-verifying (a bundled Ed25519 signature checked every time, deps-free); the production observation
// has no bundled signature (see cycle-escrow-observation.mjs's module comment) and this deps-free shape
// check alone re-validates only its structural/self-consistency invariants — it is what runs on every
// journal replay (via assertFrozenCycleControl, called with no deps from reducer.mjs and CycleRunner's own
// constructor) and, together with the frozen control's own content-addressed `controlDigest`, is what
// makes replay safe without a live network dependency. The one-time, deps-carrying, chain-observer-
// anchored authenticity check (verifyProductionCycleEscrowObservation) runs only where a live observer was
// actually injected — see createFrozenCycleControl below.
function assertEscrowObservationShape(value) {
  if (value && typeof value === 'object' && !Array.isArray(value) && value.schema === PRODUCTION_CYCLE_ESCROW_OBSERVATION_SCHEMA) {
    return assertProductionCycleEscrowObservationShape(value);
  }
  return verifyFixtureCycleEscrowObservation(value);
}

function validatedFrozenControlParts(value) {
  const plan = assertFrozenCyclePlan(deepFreeze(structuredClone(value.plan)));
  const packSnapshot = assertPackSnapshot(deepFreeze(structuredClone(value.packSnapshot)));
  const binding = validateBinding(value.binding);
  const escrowObservation = assertEscrowObservationShape(value.escrowObservation);
  assertFrozenPlanBinding(plan, binding);
  if (plan.packSnapshotDigest !== packSnapshot.snapshotDigest) throw new Error('frozen cycle control snapshot differs from the frozen plan');
  selectPack(packSnapshot, plan.pack);
  if (escrowObservation.runnerCycleId !== plan.cycleId) throw new Error('cycle escrow observation runner cycle differs from the frozen plan');
  if (escrowObservation.cycleVaultAccount !== plan.cycleVaultAccount) throw new Error('cycle escrow observation coordinator differs from the frozen plan');
  if (escrowObservation.returnAccount !== plan.returnAccount) throw new Error('cycle return escrow differs from authenticated computeCycleEscrow output');
  if (
    escrowObservation.schema === PRODUCTION_CYCLE_ESCROW_OBSERVATION_SCHEMA
    && BigInt(escrowObservation.usdgBalance) < BigInt(plan.minimumRobinhoodReceive)
  ) throw new Error('cycle escrow observation USDG balance is below the frozen minimum Robinhood receive');
  return { plan, packSnapshot, binding, escrowObservation };
}

// `deps` is optional and used only to independently re-confirm a *production* escrow observation against
// a live-injected Robinhood (EVM) chain observer (`deps.observers.evm`, see
// verifyProductionCycleEscrowObservation) — never required for a fixture observation, and never required
// at all when `deps.observers.evm` is not supplied (every existing deps-free caller — state-file.mjs's
// read-time re-validation, control.mjs's start/recoverActiveRunner rebuilds, and every fixture test —
// keeps working unchanged; a caller with genuine live chain access, e.g. the operator freezing a new
// production cycle, opts into the stronger chain-anchored check by supplying it). See this file's own
// module notes and docs/modules/cycle-runner.md for the full trust-boundary rationale.
export function createFrozenCycleControl(input, deps = {}) {
  assertExactPlainObject(input, ['plan', 'packSnapshot', 'binding', 'escrowObservation'], 'frozen cycle control input');
  const parts = validatedFrozenControlParts(input);
  if (parts.escrowObservation.schema === PRODUCTION_CYCLE_ESCROW_OBSERVATION_SCHEMA && deps?.observers?.evm) {
    verifyProductionCycleEscrowObservation(input.escrowObservation, deps);
  }
  const body = { schema: 'hookemon.frozen-cycle-control.v1', ...structuredClone(parts) };
  return deepFreeze({ ...body, controlDigest: digest({ domain: body.schema, control: body }) });
}

export function assertFrozenCycleControl(value) {
  assertExactPlainObject(value, frozenControlFields, 'frozen cycle control');
  if (value.schema !== 'hookemon.frozen-cycle-control.v1') throw new Error('frozen cycle control schema is invalid');
  const parts = validatedFrozenControlParts(value);
  if (typeof value.controlDigest !== 'string' || !digestPattern.test(value.controlDigest)) throw new Error('frozen cycle control digest is invalid');
  const body = { schema: value.schema, ...structuredClone(parts) };
  if (value.controlDigest !== digest({ domain: body.schema, control: body })) throw new Error('frozen cycle control digest mismatch');
  return deepFreeze({ ...body, controlDigest: value.controlDigest });
}
