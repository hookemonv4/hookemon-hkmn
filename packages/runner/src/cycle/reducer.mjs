import { createPublicKey, verify as verifySignature } from 'node:crypto';

import {
  FIXTURE_AUTHORIZATION_VALIDATED_AT,
  fixtureAuthorizationStoreRecord,
  fixtureAuthorizationSlot,
  fixtureAuthorizationNonceKey,
  verifyFixturePostOpenBuybackAuthorization,
} from './authorization.mjs';
import { createFixtureAuthorizationProvider, stepAuthorizationNow } from './authorization-provider.mjs';
import { validateBinding } from './bindings.mjs';
import {
  assertFixtureCollectorRequest,
  fixtureCollectorMutationAuthorizationDigest,
  assertVerifiedFixtureCollectorOpenExecution,
  assertVerifiedFixtureCollectorOpenCustody,
  assertVerifiedFixtureCollectorRpcFinality,
  assertVerifiedFixtureCollectorStatus,
  fixtureCollectorRequestDigest,
  verifyFixtureCollectorMutationAuthorization,
} from './collector.mjs';
import { verifyFixtureBlockhashValidity } from './blockhash-validity.mjs';
import { decodeFixtureOnlyMessage, fixtureMessageForAction, verifyFixtureSignedTransaction } from './decoder.mjs';
import { verifyFixtureExecutionAccounting } from './execution-accounting.mjs';
import { digest } from './journal.mjs';
import { verifyFixtureCyclePreflight } from './preflight.mjs';
import { verifyDistributionVerificationReceipt } from '../distribution/manifest.mjs';
import { deriveClosedProceedsBasis } from '../distribution/reconcile.mjs';
import { assertFrozenCycleControl } from '../operator/cycle-plan.mjs';
import {
  contractBytes32FromDigest,
  validateVaultPayoutAuthorization,
  vaultPayoutAuthorizationDigest,
} from './vault-payout-authorization.mjs';
import {
  assertDigest,
  assertFixtureAction,
  assertPlainObject,
  assertReceiptRelationship,
  assertVerifiedProviderReceipt,
  BRIDGE_CHAIN_IDS,
  fixtureActionDigests,
  nativeGasChainForActionKind,
  receiptIdentityKey,
  receiptRegistryRecord,
  sameCanonical,
} from './schemas.mjs';

export { BRIDGE_CHAIN_IDS };

// Explicit CAIP-2-style chain identifiers for the two chains a cycle actually touches (defined in, and
// re-exported from, schemas.mjs — see FIXTURE_ACTION_CHAIN_IDENTITY there). The outbound and return
// actions are bridge legs (Relay: Robinhood Chain USDG <-> Solana Circle USD) and carry BRIDGE_CHAIN_IDS.
// robinhood; purchase and buyback are Collector Crypt operations that only ever happen on Solana and
// carry BRIDGE_CHAIN_IDS.solana. Every action/receipt kind is validated against its own explicit chain
// identity by assertFixtureAction/assertVerifiedProviderReceipt, so a Robinhood-chain leg's receipt can
// never masquerade as a Solana-chain leg's (or vice versa) — this is what chainKeyForReceipt below
// partitions block-height monotonicity by, so a Robinhood-chain leg's heights are never compared against
// a Solana-chain leg's heights, and what nativeGasChainForActionKind buckets native-gas accounting by,
// so the Robinhood native-gas cap (preflight.nativeGasCaps.robinhood) is actually reachable and consumed
// by the two actions that execute on that chain.
function chainKeyForReceipt(receipt) {
  return `${receipt.chain}:${receipt.cluster}`;
}

const transitionOrder = ['prepared', 'outbound-finalized', 'purchase-finalized', 'open-reconciled', 'buyback-finalized', 'return-finalized', 'closed'];
const actionStage = new Map([
  ['outbound', 'prepared'],
  ['purchase', 'outbound-finalized'],
  ['buyback', 'open-reconciled'],
  ['return', 'buyback-finalized'],
]);
const cycleActionKinds = Object.freeze(['outbound', 'purchase', 'buyback', 'return']);
const actionAuthorizationKinds = Object.freeze(['mutation', 'sign', 'broadcast', 'asset-spend', 'gas-spend']);
const digestPattern = /^sha256:[0-9a-f]{64}$/;
const bytes32Pattern = /^0x[0-9a-f]{64}$/;
const positiveDecimalPattern = /^(?:[1-9][0-9]*)$/;
const decimalPattern = /^(?:0|[1-9][0-9]*)$/;
const externalMutationActionKinds = Object.freeze(['outbound', 'purchase', 'buyback', 'return', 'collector-generate', 'collector-open']);

// The void path: an external-mutation-attempted record that was never observed as broadcast before its
// own last-valid boundary passed (a dropped RPC submission, an expired blockhash, a Collector mutation
// authorization that expired before it was ever sent) can be closed out as VOID given a signed proof
// that the boundary passed with nothing ever landing on chain. Voiding never retries the same signed
// bytes — it retires the stale intent/action entirely so a fresh one, with its own fresh digest, can be
// prepared for the same action kind. This is deliberately lighter than (and orthogonal to) the heavier,
// manual, dual-observer "supersede an unobserved intent" recovery path described in the design's
// recovery model (owner standing-authority key, 2-of-2) — this path is meant to be automatable, and is
// bounded to only the specific, narrow claim a single observer proof can support: "nothing was ever
// broadcast before the deadline," never "something was broadcast but should be superseded anyway."
const voidObserverPublicKey = createPublicKey({
  key: Buffer.from('302a300506032b6570032100d9f3899257e92c6078635f3a5d39a60e9ce6fefef962750b4dc93a8e8fa13854', 'hex'),
  format: 'der',
  type: 'spki',
});
const voidProofFields = ['schema', 'authority', 'cycleId', 'requestDigest', 'actionKind', 'boundaryKind', 'boundary', 'checkedAt', 'neverBroadcast', 'finalized', 'verificationDigest', 'verificationSignature'];

export function voidObserverProofDigest(value) {
  const { verificationDigest, verificationSignature, ...payload } = value ?? {};
  return digest({ domain: 'hookemon.external-mutation-void-proof.v1', payload });
}

export function assertVoidObserverProof(value) {
  const proof = assertPlainObject(value, voidProofFields, 'external mutation void observer proof');
  if (proof.schema !== 'hookemon.external-mutation-void-proof.v1' || proof.authority !== 'hookemon-fixture-void-observer') throw new Error('void observer proof authority is invalid');
  assertDigest(proof.requestDigest, 'void observer proof request digest');
  if (typeof proof.cycleId !== 'string' || proof.cycleId.length === 0) throw new Error('void observer proof cycle is invalid');
  if (!externalMutationActionKinds.includes(proof.actionKind)) throw new Error('void observer proof action kind is invalid');
  if (proof.boundaryKind !== 'height' && proof.boundaryKind !== 'time') throw new Error('void observer proof boundary kind is invalid');
  const assertBoundaryValue = (fieldValue, label) => {
    if (proof.boundaryKind === 'height') {
      if (typeof fieldValue !== 'string' || !decimalPattern.test(fieldValue)) throw new Error(`${label} is invalid`);
    } else if (typeof fieldValue !== 'string' || new Date(fieldValue).toISOString() !== fieldValue) throw new Error(`${label} is invalid`);
  };
  assertBoundaryValue(proof.boundary, 'void observer proof boundary');
  assertBoundaryValue(proof.checkedAt, 'void observer proof checked-at');
  const boundaryPassed = proof.boundaryKind === 'height'
    ? BigInt(proof.checkedAt) >= BigInt(proof.boundary)
    : Date.parse(proof.checkedAt) >= Date.parse(proof.boundary);
  if (!boundaryPassed) throw new Error('void observer proof was checked before its own boundary passed');
  if (proof.neverBroadcast !== true || proof.finalized !== true) throw new Error('void observer proof must attest a finalized, never-broadcast observation');
  assertDigest(proof.verificationDigest, 'void observer proof verification digest');
  const expectedDigest = voidObserverProofDigest(proof);
  if (proof.verificationDigest !== expectedDigest) throw new Error('void observer proof verification digest mismatch');
  if (typeof proof.verificationSignature !== 'string' || !/^[A-Za-z0-9_-]{80,128}$/.test(proof.verificationSignature)) throw new Error('void observer proof signature is invalid');
  if (!verifySignature(null, Buffer.from(expectedDigest, 'utf8'), voidObserverPublicKey, Buffer.from(proof.verificationSignature, 'base64url'))) throw new Error('void observer proof signature verification is invalid');
  return structuredClone(proof);
}

export function createCycleReducerState(cycleId) {
  return {
    cycleId,
    head: null,
    stage: 'prepared',
    version: 0,
    frozenControl: null,
    preflight: null,
    nativeGasReserved: new Map(),
    nativeGasUsed: new Map(),
    walletBinding: null,
    // Finalized block height is tracked per chain (keyed by `${chain}:${cluster}`), never as one
    // global scalar: outbound/return legs execute on a different chain from purchase/buyback, so a
    // height observed on one chain is never comparable to a height observed on another. See
    // verifyReceipt below and BRIDGE_CHAIN_IDS.
    finalizedBlockHeightByChain: new Map(),
    actions: new Map(),
    actionByKind: new Map(),
    approvals: new Map(),
    consumedApprovals: new Map(),
    decoded: new Map(),
    signed: new Map(),
    blockhashValidity: new Map(),
    broadcasts: new Map(),
    receipts: new Map(),
    receiptIdentities: new Set(),
    consumedReceipts: new Set(),
    consumedByAction: new Map(),
    executionAccounting: new Map(),
    externalMutations: new Map(),
    proceeds: new Map(),
    distributionVerification: null,
    payoutFundingPreparation: null,
    collector: {
      generateIntent: null,
      openIntent: null,
      authorizations: new Map(),
      generated: null,
      verifiedStatus: null,
      opened: null,
      openExecution: null,
      openCustody: null,
    },
    postOpenBuybackApproval: null,
    closedLedger: null,
  };
}

function collectorGenerateIntent(state, event, evidenceProfile) {
  const payload = exactPayload(event.payload, ['request', 'requestDigest'], event.kind);
  const request = evidenceProfile.collector.assertRequest(payload.request, 'generate');
  if (!state.preflight || state.stage !== 'prepared') throw new Error('prepared released-cycle preflight is required for Collector generation');
  if (request.cycleId !== state.cycleId || payload.requestDigest !== evidenceProfile.collector.requestDigest(request, 'generate')) throw new Error('Collector generate intent binding is invalid');
  if (state.collector.generateIntent) throw new Error('Collector generate intent already prepared');
  state.collector.generateIntent = { request, requestDigest: payload.requestDigest };
}

function collectorOpenIntent(state, event, evidenceProfile) {
  const payload = exactPayload(event.payload, ['request', 'requestDigest'], event.kind);
  const request = evidenceProfile.collector.assertRequest(payload.request, 'open');
  if (state.stage !== 'purchase-finalized' || !state.collector.verifiedStatus) throw new Error('verified ready Collector status is required before the open intent');
  if (request.cycleId !== state.cycleId || payload.requestDigest !== evidenceProfile.collector.requestDigest(request, 'open')) throw new Error('Collector open intent binding is invalid');
  if (request.wallet !== state.collector.verifiedStatus.wallet || request.prizeWallet !== state.collector.verifiedStatus.prizeWallet || request.pack !== state.collector.verifiedStatus.pack || request.quantity !== state.collector.verifiedStatus.quantity || request.turbo !== state.collector.verifiedStatus.turbo) throw new Error('Collector open intent status binding is invalid');
  if (state.collector.openIntent) throw new Error('Collector open intent already prepared');
  state.collector.openIntent = { request, requestDigest: payload.requestDigest };
}

function collectorMutationAuthorization(state, event, cycleTransaction, evidenceProfile) {
  const payload = exactPayload(event.payload, ['request', 'binding', 'authorization'], event.kind);
  const action = payload.authorization?.action ?? payload.authorization?.actionKind;
  const request = evidenceProfile.collector.assertRequest(payload.request, action);
  const binding = validateBinding(payload.binding);
  const authorization = evidenceProfile.collector.verifyMutationAuthorization(payload.authorization, request, action, binding);
  if (state.frozenControl && !sameCanonical(binding, state.frozenControl.binding)) throw new Error('Collector authorization binding differs from frozen cycle control');
  const intent = action === 'generate' ? state.collector.generateIntent : state.collector.openIntent;
  if (authorization.cycleId !== state.cycleId || !intent || intent.requestDigest !== authorization.requestDigest || !sameCanonical(intent.request, request)) throw new Error('Collector mutation authorization intent binding is invalid');
  if (state.collector.authorizations.has(action)) throw new Error('Collector mutation authorization already consumed');
  const key = evidenceProfile.collector.mutationAuthorizationDigest(authorization);
  const record = evidenceProfile.collector.mutationAuthorizationStoreRecord(authorization, action);
  if (record.key !== key || cycleTransaction.consumeAuthorization(record) !== key) throw new Error('Collector mutation authorization store consumption mismatch');
  state.collector.authorizations.set(action, authorization);
}

export function cloneCycleReducerState(state) {
  const cloneMap = map => new Map([...map].map(([key, value]) => [key, structuredClone(value)]));
  return {
    cycleId: state.cycleId,
    head: state.head,
    stage: state.stage,
    version: state.version,
    frozenControl: state.frozenControl ? structuredClone(state.frozenControl) : null,
    preflight: state.preflight ? structuredClone(state.preflight) : null,
    nativeGasReserved: cloneMap(state.nativeGasReserved),
    nativeGasUsed: cloneMap(state.nativeGasUsed),
    walletBinding: state.walletBinding ? structuredClone(state.walletBinding) : null,
    finalizedBlockHeightByChain: new Map(state.finalizedBlockHeightByChain),
    actions: cloneMap(state.actions),
    actionByKind: new Map(state.actionByKind),
    approvals: cloneMap(state.approvals),
    consumedApprovals: cloneMap(state.consumedApprovals),
    decoded: cloneMap(state.decoded),
    signed: cloneMap(state.signed),
    blockhashValidity: cloneMap(state.blockhashValidity),
    broadcasts: cloneMap(state.broadcasts),
    receipts: cloneMap(state.receipts),
    receiptIdentities: new Set(state.receiptIdentities),
    consumedReceipts: new Set(state.consumedReceipts),
    consumedByAction: new Map(state.consumedByAction),
    executionAccounting: cloneMap(state.executionAccounting),
    externalMutations: cloneMap(state.externalMutations),
    proceeds: cloneMap(state.proceeds),
    distributionVerification: state.distributionVerification
      ? structuredClone(state.distributionVerification)
      : null,
    payoutFundingPreparation: state.payoutFundingPreparation
      ? structuredClone(state.payoutFundingPreparation)
      : null,
    collector: structuredClone(state.collector),
    postOpenBuybackApproval: state.postOpenBuybackApproval ? structuredClone(state.postOpenBuybackApproval) : null,
    closedLedger: state.closedLedger ? structuredClone(state.closedLedger) : null,
  };
}

function bindCycleControl(state, event) {
  const payload = exactPayload(event.payload, ['control'], event.kind);
  if (state.head !== null || state.frozenControl !== null) throw new Error('frozen cycle control must be the first journal event');
  const control = assertFrozenCycleControl(payload.control);
  if (control.plan.cycleId !== state.cycleId) throw new Error('frozen cycle control cycle differs from the runner cycle');
  state.frozenControl = control;
}

export function assertFrozenControlBindings(state, expectedControlValue = null) {
  const expectedControl = expectedControlValue === null ? null : assertFrozenCycleControl(expectedControlValue);
  if (expectedControl && (!state.frozenControl || !sameCanonical(state.frozenControl, expectedControl))) throw new Error('journal frozen cycle control differs from operator state');
  const control = state.frozenControl;
  if (!control) return state;
  const { plan, binding } = control;

  if (state.preflight) {
    const preflight = state.preflight;
    if (
      preflight.cycleId !== plan.cycleId
      || preflight.operationsTrigger !== plan.operationsTrigger
      || preflight.cycleVaultAccount !== plan.cycleVaultAccount
      || preflight.returnAccount !== plan.returnAccount
      || preflight.policyAccount !== binding.executionWallet
      || preflight.authorizationNonce !== plan.authorizationNonce
      || preflight.authorizationExpiresAt !== plan.expiresAt
      || preflight.minimumRobinhoodReceive !== plan.minimumRobinhoodReceive
      || preflight.releasedAmount !== plan.amount
      || preflight.totalPrincipal !== plan.amount
      || preflight.nativeGasCaps.robinhood !== plan.robinhoodNativeGasCap
      || preflight.nativeGasCaps.solana !== plan.solanaNativeGasCap
      || preflight.minimumReceives.outbound !== plan.minimumSolanaReceive
      || preflight.minimumReceives.return !== plan.minimumReturnUsdg
      || preflight.bindingManifestDigest !== plan.bindingManifestDigest
    ) throw new Error('released-cycle preflight differs from frozen cycle control');
  }

  const collectorRequests = [
    state.collector.generateIntent?.request,
    state.collector.openIntent?.request,
  ].filter(Boolean);
  for (const request of collectorRequests) {
    if (
      request.cycleId !== plan.cycleId
      || request.pack !== binding.pack
      || request.quantity !== binding.quantity
      || request.turbo !== binding.turbo
      || request.wallet !== binding.executionWallet
    ) throw new Error('Collector request differs from frozen cycle control');
  }
  for (const authorization of state.collector.authorizations.values()) {
    if (
      authorization.cycleId !== plan.cycleId
      || authorization.pack !== binding.pack
      || authorization.quantity !== binding.quantity
      || authorization.turbo !== binding.turbo
      || authorization.wallet !== binding.executionWallet
    ) throw new Error('Collector authorization differs from frozen cycle control');
  }
  if (state.collector.generated && !sameCanonical(state.collector.generated.binding, binding)) throw new Error('Collector generation binding differs from frozen cycle control');
  for (const record of [state.collector.generated?.response, state.collector.verifiedStatus, state.collector.opened].filter(Boolean)) {
    if (
      record.cycleId !== plan.cycleId
      || record.pack !== binding.pack
      || record.quantity !== binding.quantity
      || record.turbo !== binding.turbo
      || record.wallet !== binding.executionWallet
    ) throw new Error('Collector record differs from frozen cycle control');
  }

  for (const [actionDigest, prepared] of state.actions) {
    const { action } = prepared;
    if (
      action.cycleId !== plan.cycleId
      || action.operationsTrigger !== plan.operationsTrigger
      || action.cycleVaultAccount !== plan.cycleVaultAccount
      || action.returnAccount !== plan.returnAccount
      || action.policyAccount !== binding.executionWallet
      || !sameCanonical(action.binding, binding)
    ) throw new Error('fixture action differs from frozen cycle control');
    if (action.actionKind === 'outbound') {
      if (actionDigest !== plan.outboundActionDigest || action.minimumReceive !== plan.minimumSolanaReceive) throw new Error('outbound action differs from frozen cycle control');
    }
    if (action.actionKind === 'return') {
      if (actionDigest !== plan.returnActionDigest || action.minimumReceive !== plan.minimumReturnUsdg) throw new Error('return action differs from frozen cycle control');
    }
  }
  const onchainCycleId = control.escrowObservation.onchainCycleId;
  if (state.distributionVerification && (
    state.distributionVerification.runnerCycleId !== plan.cycleId
    || state.distributionVerification.onchainCycleId !== onchainCycleId
  )) throw new Error('distribution verification differs from the observed onchain cycle');
  if (state.payoutFundingPreparation && (
    state.payoutFundingPreparation.onchainCycleId !== onchainCycleId
    || state.payoutFundingPreparation.vaultPayoutAuthorization.cycleId !== onchainCycleId
  )) throw new Error('payout funding differs from the observed onchain cycle');
  return state;
}

function collectorGenerate(state, event, evidenceProfile) {
  const payload = exactPayload(event.payload, ['binding', 'preflightDigest', 'response'], event.kind);
  const binding = validateBinding(payload.binding);
  assertDigest(payload.preflightDigest, 'Collector generate preflight digest');
  const response = assertPlainObject(payload.response, ['schema', 'responseId', 'cycleId', 'pack', 'quantity', 'turbo', 'wallet', 'prizeWallet'], 'Collector generate response');
  const intent = state.collector.generateIntent;
  const authorization = state.collector.authorizations.get('generate');
  if (!state.preflight || state.stage !== 'prepared' || payload.preflightDigest !== state.preflight.preflightDigest) throw new Error('prepared released-cycle preflight is required for Collector generation');
  if (!intent || !authorization || authorization.requestDigest !== intent.requestDigest) throw new Error('durable Collector generate intent and consumed mutation authorization are required');
  if (state.externalMutations.get(intent.requestDigest)?.status !== 'unresolved') throw new Error('durable unresolved Collector generate attempt is required');
  if (!evidenceProfile.collector.acceptsGenerateResponse(response, state.cycleId) || response.cycleId !== state.cycleId || response.pack !== binding.pack || response.pack !== intent.request.pack || response.quantity !== binding.quantity || response.quantity !== intent.request.quantity || response.turbo !== binding.turbo || response.turbo !== intent.request.turbo || response.wallet !== binding.executionWallet || response.wallet !== intent.request.wallet || response.prizeWallet !== authorization.prizeWallet) throw new Error('Collector generate response is invalid');
  if (state.collector.generated) throw new Error('Collector generate response already consumed');
  state.collector.generated = { binding, preflightDigest: payload.preflightDigest, response };
}

function verifiedCollectorStatus(state, event, evidenceProfile) {
  const payload = exactPayload(event.payload, ['status'], event.kind);
  const status = evidenceProfile.collector.assertVerifiedStatus(payload.status);
  const generated = state.collector.generated;
  if (!generated || state.stage !== 'purchase-finalized' || status.cycleId !== state.cycleId || status.wallet !== generated.binding.executionWallet || status.prizeWallet !== generated.response.prizeWallet || status.pack !== generated.response.pack || status.quantity !== generated.response.quantity || status.turbo !== generated.response.turbo || status.memo !== `${state.cycleId}:collector-status`) throw new Error('verified Collector status binding is invalid');
  if (state.collector.verifiedStatus) throw new Error('verified Collector status already consumed');
  state.collector.verifiedStatus = status;
}

function verifiedCollectorOpenCustody(state, event, evidenceProfile) {
  const payload = exactPayload(event.payload, ['custody', 'rpcFinality'], event.kind);
  const custody = evidenceProfile.collector.assertVerifiedOpenCustody(payload.custody);
  const rpcFinality = evidenceProfile.collector.assertVerifiedRpcFinality(payload.rpcFinality, custody);
  const status = state.collector.verifiedStatus;
  const openExecution = state.collector.openExecution;
  const purchaseActionDigest = state.actionByKind.get('purchase');
  const purchaseAction = purchaseActionDigest && state.actions.get(purchaseActionDigest)?.action;
  const purchaseReceiptDigest = state.consumedByAction.get('purchase');
  const purchaseReceipt = purchaseReceiptDigest && state.receipts.get(purchaseReceiptDigest);
  if (
    !state.collector.opened
    || !openExecution
    || !status
    || !purchaseAction
    || !purchaseReceipt
    || state.stage !== 'purchase-finalized'
    || custody.cycleId !== state.cycleId
    || custody.requestDigest !== openExecution.requestDigest
    || custody.authorizationDigest !== openExecution.authorizationDigest
    || custody.openExecutionDigest !== openExecution.executionDigest
    || custody.broadcastSignature !== openExecution.broadcastSignature
    || custody.wallet !== state.collector.opened.wallet
    || custody.prizeWallet !== state.collector.opened.prizeWallet
    || custody.packTokenMint !== status.packTokenMint
    || custody.packTokenMint !== purchaseReceipt.relation.nftMint
    || custody.packTokenAccount !== openExecution.packTokenAccount
    || custody.packTokenAccount !== purchaseReceipt.relation.nftCustodyAccount
    || custody.prePackBalance !== purchaseReceipt.relation.postNftBalance
    || custody.postPackBalance !== '0'
    || !evidenceProfile.collector.acceptsOpenCustodyNftMint(custody.nftMint)
    || custody.nftCustodyAccount !== custody.wallet
    || custody.preNftBalance !== '0'
    || BigInt(purchaseReceipt.blockHeight) >= BigInt(custody.blockHeight)
  ) throw new Error('verified Collector open custody binding or chronology is invalid');
  if (state.collector.openCustody) throw new Error('verified Collector open custody already consumed');
  state.collector.openCustody = { custody, rpcFinality };
}

function collectorOpen(state, event, evidenceProfile) {
  const payload = exactPayload(event.payload, ['open', 'execution'], event.kind);
  const open = evidenceProfile.collector.assertRequest(payload.open, 'open');
  const execution = evidenceProfile.collector.assertVerifiedOpenExecution(payload.execution);
  const intent = state.collector.openIntent;
  const authorization = state.collector.authorizations.get('open');
  const purchaseReceiptDigest = state.consumedByAction.get('purchase');
  const purchaseReceipt = purchaseReceiptDigest && state.receipts.get(purchaseReceiptDigest);
  if (!state.collector.verifiedStatus || !intent || !authorization || state.stage !== 'purchase-finalized') throw new Error('verified status, durable open intent, and consumed mutation authorization are required before Collector open');
  if (state.externalMutations.get(intent.requestDigest)?.status !== 'unresolved') throw new Error('durable unresolved Collector open attempt is required');
  if (
    !purchaseReceipt
    || !sameCanonical(open, intent.request)
    || authorization.requestDigest !== intent.requestDigest
    || open.cycleId !== state.cycleId
    || open.wallet !== state.collector.verifiedStatus.wallet
    || open.prizeWallet !== state.collector.verifiedStatus.prizeWallet
    || open.pack !== state.collector.verifiedStatus.pack
    || open.quantity !== state.collector.verifiedStatus.quantity
    || open.turbo !== state.collector.verifiedStatus.turbo
    || execution.cycleId !== state.cycleId
    || execution.requestDigest !== intent.requestDigest
    || execution.authorizationDigest !== evidenceProfile.collector.mutationAuthorizationDigest(authorization)
    || execution.wallet !== open.wallet
    || execution.prizeWallet !== open.prizeWallet
    || execution.packTokenMint !== state.collector.verifiedStatus.packTokenMint
    || execution.packTokenMint !== purchaseReceipt.relation.nftMint
    || execution.packTokenAccount !== purchaseReceipt.relation.nftCustodyAccount
    || execution.memo !== open.memo
  ) throw new Error('Collector open execution binding is invalid');
  if (state.collector.opened) throw new Error('Collector pack is already open');
  state.collector.opened = open;
  state.collector.openExecution = execution;
}

function postOpenBuybackApproval(state, event, cycleTransaction, evidenceProfile) {
  const payload = exactPayload(event.payload, ['approval'], event.kind);
  const approval = evidenceProfile.postOpenBuyback.verify(payload.approval);
  const actionDigest = evidenceProfile.postOpenBuyback.resolveActionDigest(state, approval);
  const prepared = actionDigest && state.actions.get(actionDigest);
  if (!prepared || prepared.action.actionKind !== 'buyback' || state.stage !== 'open-reconciled' || !state.collector.opened) throw new Error('post-open buyback action and open custody are required');
  // The refund is a Circle-USD-denominated amount (the negotiated post-open sale proceeds); it must
  // never be checked against action.amount, which is the NFT unit quantity being surrendered (exactly
  // '1', a completely different unit — see assertFixtureActionPolicy in schemas.mjs). The correct
  // binding is the Circle USD floor already carried on the action: the approved refund must be at least
  // action.minimumReceive. (The finalized on-chain receipt and independent execution accounting are
  // separately required, elsewhere, to match the actual refund exactly — this check only bounds what
  // the owner is authorizing before the fact.)
  evidenceProfile.postOpenBuyback.matchPolicy(approval, prepared, state);
  if (state.postOpenBuybackApproval) throw new Error('post-open buyback approval already consumed');
  const record = evidenceProfile.postOpenBuyback.storeRecord(approval, actionDigest);
  if (cycleTransaction.consumeAuthorization(record) !== record.key) throw new Error('post-open buyback authorization store consumption mismatch');
  state.postOpenBuybackApproval = approval;
}

function exactPayload(payload, fields, kind) {
  return assertPlainObject(payload, fields, `${kind} journal payload`);
}

export function externalMutationIdentity(state, requestDigest, evidenceProfile = FIXTURE_EVIDENCE_PROFILE) {
  assertDigest(requestDigest, 'external mutation request digest');
  const prepared = state.actions.get(requestDigest);
  if (prepared) {
    const slot = fixtureAuthorizationSlot(requestDigest, 'mutation');
    const approval = state.approvals.get(slot);
    const consumed = state.consumedApprovals.get(slot);
    const approvalKey = approval && evidenceProfile.authorization.approvalKey(approval);
    if (!approval || !consumed || approval.subjectDigest !== requestDigest || consumed.approvalKey !== approvalKey) {
      throw new Error('consumed owner mutation approval is required');
    }
    return {
      actionKind: prepared.action.actionKind,
      attempt: evidenceProfile.authorization.attempt(approval),
      authorizationKey: approvalKey,
    };
  }

  for (const action of ['generate', 'open']) {
    const intent = action === 'generate' ? state.collector.generateIntent : state.collector.openIntent;
    const authorization = state.collector.authorizations.get(action);
    if (intent?.requestDigest !== requestDigest) continue;
    if (!authorization || authorization.requestDigest !== requestDigest) throw new Error('consumed Collector mutation authorization is required');
    return {
      actionKind: `collector-${action}`,
      attempt: authorization.attempt,
      authorizationKey: evidenceProfile.collector.mutationAuthorizationDigest(authorization),
    };
  }
  throw new Error('external mutation intent is unknown');
}

function externalMutationAttempted(state, event, evidenceProfile) {
  const payload = exactPayload(event.payload, ['requestDigest', 'actionKind', 'attempt', 'authorizationKey'], event.kind);
  const expected = externalMutationIdentity(state, payload.requestDigest, evidenceProfile);
  if (!sameCanonical(payload, { requestDigest: payload.requestDigest, ...expected })) throw new Error('external mutation attempt binding is invalid');
  if ([...state.externalMutations.values()].some(value => value.status === 'unresolved')) throw new Error('an unresolved external mutation must be reconciled before another mutation');
  if (state.externalMutations.has(payload.requestDigest)) throw new Error('external mutation was already attempted; retry is prohibited');
  state.externalMutations.set(payload.requestDigest, { ...structuredClone(payload), status: 'unresolved' });
}

export function externalReconciliationEvidence(state, requestDigest) {
  assertDigest(requestDigest, 'external mutation request digest');
  const attempt = state.externalMutations.get(requestDigest);
  if (!attempt) throw new Error('durable external mutation attempt is required before reconciliation');
  if (attempt.status === 'externally-reconciled') return structuredClone(attempt.evidence);

  const prepared = state.actions.get(requestDigest);
  if (prepared) {
    const receiptDigest = state.consumedByAction.get(prepared.action.actionKind);
    const receipt = receiptDigest && state.receipts.get(receiptDigest);
    const accounting = state.executionAccounting.get(requestDigest);
    const hasRequiredCustody = Boolean(accounting?.sourceActivity)
      && (prepared.action.actionKind !== 'buyback' || Boolean(accounting.nftDestinationActivity));
    if (
      !receiptDigest
      || !state.consumedReceipts.has(receiptDigest)
      || receipt?.actionDigest !== requestDigest
      || accounting?.receiptDigest !== receiptDigest
      || !hasRequiredCustody
    ) return null;
    return { providerEvidenceDigest: receiptDigest, rpcEvidenceDigest: accounting.verificationDigest };
  }

  if (state.collector.generateIntent?.requestDigest === requestDigest) {
    const generated = state.collector.generated;
    if (!generated) return null;
    return {
      providerEvidenceDigest: digest({ domain: 'hookemon.fixture-collector-generate-response.v1', response: generated.response }),
      rpcEvidenceDigest: null,
    };
  }

  if (state.collector.openIntent?.requestDigest === requestDigest) {
    const openCustody = state.collector.openCustody;
    if (!openCustody) return null;
    // A locally-recomputed digest of the already-verified (fixture-signed or production
    // observer-confirmed) custody/RPC-finality records, used only as an opaque reconciliation
    // evidence pointer — never re-verified against anything else — so this is intentionally
    // profile-agnostic rather than reaching for an embedded fixture-only digest field.
    return {
      providerEvidenceDigest: digest({ domain: 'hookemon.collector-open-custody-evidence.v1', custody: openCustody.custody }),
      rpcEvidenceDigest: digest({ domain: 'hookemon.collector-open-rpc-finality-evidence.v1', rpcFinality: openCustody.rpcFinality }),
    };
  }
  throw new Error('external mutation intent is unknown');
}

function externalMutationReconciled(state, event) {
  const payload = exactPayload(event.payload, ['requestDigest', 'actionKind', 'evidence'], event.kind);
  const attempt = state.externalMutations.get(payload.requestDigest);
  if (!attempt || attempt.status !== 'unresolved' || attempt.actionKind !== payload.actionKind) throw new Error('unresolved external mutation attempt is required');
  const expected = externalReconciliationEvidence(state, payload.requestDigest);
  if (!expected || !sameCanonical(payload.evidence, expected)) throw new Error('verified provider and RPC reconciliation evidence is required');
  attempt.status = 'externally-reconciled';
  attempt.evidence = structuredClone(expected);
}

// The void boundary an observer proof must attest against: for an action-based mutation (outbound,
// purchase, buyback, return) this is the signed transaction's own last-valid block height; for a
// Collector generate/open mutation (no blockhash validity window of its own) this is the consumed
// mutation authorization's expiry timestamp. Either way it is read from durable, already-verified state
// — never trusted from the void proof itself, which only supplies what an independent observer measured
// against it.
function voidBoundaryForMutation(state, requestDigest, actionKind) {
  if (actionKind === 'collector-generate' || actionKind === 'collector-open') {
    const authorization = state.collector.authorizations.get(actionKind === 'collector-generate' ? 'generate' : 'open');
    if (!authorization) throw new Error('consumed Collector mutation authorization is required before voiding');
    return { boundaryKind: 'time', boundary: authorization.expiry };
  }
  const prepared = state.actions.get(requestDigest);
  if (!prepared) throw new Error('prepared fixture action is required before voiding');
  return { boundaryKind: 'height', boundary: prepared.action.validity.lastValidHeight };
}

// Retires every trace of the voided intent/action from the reducer's write-once bookkeeping so a fresh
// one (a new digest, from a new nonce/attempt/validity window) can be prepared for the same slot. The
// journal event that caused this retains the voided digest and the observer proof permanently — this
// only clears live reducer state, never history.
function retireVoidedExternalMutation(state, requestDigest, actionKind) {
  if (actionKind === 'collector-generate') {
    state.collector.generateIntent = null;
    state.collector.authorizations.delete('generate');
  } else if (actionKind === 'collector-open') {
    state.collector.openIntent = null;
    state.collector.authorizations.delete('open');
  } else {
    const prepared = state.actions.get(requestDigest);
    if (prepared) {
      const chain = nativeGasChainForActionKind(prepared.action.actionKind);
      const refunded = BigInt(state.nativeGasReserved.get(chain) ?? '0') - BigInt(prepared.action.nativeGasAmount);
      state.nativeGasReserved.set(chain, (refunded < 0n ? 0n : refunded).toString());
    }
    state.actions.delete(requestDigest);
    state.actionByKind.delete(actionKind);
    state.decoded.delete(requestDigest);
    state.signed.delete(requestDigest);
    state.blockhashValidity.delete(requestDigest);
    state.broadcasts.delete(requestDigest);
    for (const authorizationKind of actionAuthorizationKinds) {
      const slot = fixtureAuthorizationSlot(requestDigest, authorizationKind);
      state.approvals.delete(slot);
      state.consumedApprovals.delete(slot);
    }
  }
  state.externalMutations.delete(requestDigest);
}

function externalMutationVoided(state, event) {
  const payload = exactPayload(event.payload, ['requestDigest', 'proof'], event.kind);
  assertDigest(payload.requestDigest, 'voided external mutation request digest');
  const attempt = state.externalMutations.get(payload.requestDigest);
  if (!attempt || attempt.status !== 'unresolved') throw new Error('unresolved external mutation attempt is required before voiding');
  // Never voidable once our own broadcast-recorded event exists: the void path's whole claim is "this
  // was never broadcast" — an action this reducer itself recorded as broadcast must go through
  // reconciliation (or the heavier supersede path), never through this one.
  if (state.broadcasts.has(payload.requestDigest)) throw new Error('a recorded broadcast cannot be voided as never-broadcast');
  const proof = assertVoidObserverProof(payload.proof);
  if (proof.requestDigest !== payload.requestDigest || proof.cycleId !== state.cycleId || proof.actionKind !== attempt.actionKind) {
    throw new Error('void observer proof binding is invalid');
  }
  const expectedBoundary = voidBoundaryForMutation(state, payload.requestDigest, attempt.actionKind);
  if (proof.boundaryKind !== expectedBoundary.boundaryKind || proof.boundary !== expectedBoundary.boundary) {
    throw new Error('void observer proof boundary does not match the durable last-valid height or authorization expiry');
  }
  retireVoidedExternalMutation(state, payload.requestDigest, attempt.actionKind);
}

// The heavier, manual "supersede an unobserved intent" recovery path (design section 2.5's recovery
// table row "Broadcast succeeded but never observed (RPC dropped, node lag)"; owner standing-authority
// key, deliberately not a dashboard button — design section 5). This is orthogonal to, and heavier than,
// the void path above: void only ever proves "nothing was broadcast before the deadline" for a mutation
// this reducer never recorded as broadcast (and explicitly refuses to run once a broadcast IS recorded —
// see the comment in externalMutationVoided). Supersession is for the genuinely ambiguous case void
// structurally excludes: a mutation this reducer DID record as broadcast (RPC accepted the submission),
// but neither independent observer — the provider API and the chain's own RPC, each verified under its
// own fixed fixture key — can ever find it landed, even after its own blockhash-validity window closed.
// Two independently-keyed observers must each separately attest NOT_FOUND/finalized against the exact
// broadcast under dispute (same signedBytesDigest, same broadcastSignature, same lastValidHeight, and
// independently agreeing observedHeight), and a fresh, single-use, expiry-checked owner-signed
// authorization must approve retiring that specific stuck mutation. Scoped to the four action-based
// mutation kinds (outbound/purchase/buyback/return) — the only ones with a broadcast/blockhash concept
// at all; a Collector generate/open mutation has no on-chain broadcast to dispute and stays on the void
// path's time-boundary exclusively. Retirement itself reuses retireVoidedExternalMutation unchanged: it
// clears every trace of the stale intent/action from live reducer state (refunding reserved native gas)
// so a brand new intent — its own fresh digest — can be prepared afterward through the ordinary
// intent-prepared pipeline; the journal event that caused this keeps the superseded digest and both
// proofs permanently, exactly as the void path's own retirement does.
const supersedeProviderPublicKey = createPublicKey({
  key: Buffer.from('302a300506032b65700321000378aa0da09b0890aeaf8c5a34a64834ce852dca35722fcafc12d0fcf1dddfd1', 'hex'),
  format: 'der',
  type: 'spki',
});
const supersedeRpcPublicKey = createPublicKey({
  key: Buffer.from('302a300506032b6570032100d64a93bacc40d48ad76b9485eb78e2c0242d4ae1c7d31932cd1bcaeccd619f03', 'hex'),
  format: 'der',
  type: 'spki',
});
const supersedeOwnerPublicKey = createPublicKey({
  key: Buffer.from('302a300506032b657003210070b70676c75b964bbef8ec0a3bd5ab483aea0f28a4e07fb800f0bafe92ca34ca', 'hex'),
  format: 'der',
  type: 'spki',
});
const supersedeObserverFields = [
  'schema', 'observer', 'cycleId', 'requestDigest', 'actionKind', 'signedBytesDigest', 'broadcastSignature',
  'lastValidHeight', 'observedHeight', 'finalized', 'status', 'evidenceDigest', 'evidenceSignature',
];
const supersessionAuthorizationFields = [
  'schema', 'fixtureOwner', 'cycleId', 'requestDigest', 'actionKind', 'nonce', 'attempt', 'expiry',
  'fixtureApprovalDigest', 'fixtureApprovalSignature',
];
const supersessionNoncePattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;

export function supersedeObserverEvidenceDigest(value) {
  const { evidenceDigest, evidenceSignature, ...payload } = value ?? {};
  return digest({ domain: 'hookemon.fixture-supersede-observer-evidence.v1', payload });
}

export function fixtureSupersessionAuthorizationDigest(value) {
  const { fixtureApprovalDigest, fixtureApprovalSignature, ...payload } = value ?? {};
  return digest({ domain: 'hookemon.fixture-supersession-authorization.v1', fixtureOwner: 'fixture-owner', payload });
}

function verifySupersedeObserverEvidence(value, expectedObserver, publicKey, expected) {
  const evidence = exactPayload(value, supersedeObserverFields, `${expectedObserver} supersede observer evidence`);
  if (
    evidence.schema !== 'hookemon.fixture-supersede-observer-evidence.v1'
    || evidence.observer !== expectedObserver
    || evidence.cycleId !== expected.cycleId
    || evidence.requestDigest !== expected.requestDigest
    || evidence.actionKind !== expected.actionKind
    || evidence.signedBytesDigest !== expected.signedBytesDigest
    || evidence.broadcastSignature !== expected.broadcastSignature
    || evidence.lastValidHeight !== expected.lastValidHeight
    || evidence.finalized !== true
    || evidence.status !== 'NOT_FOUND'
    || evidence.evidenceDigest !== supersedeObserverEvidenceDigest(evidence)
  ) throw new Error(`${expectedObserver} supersede observer evidence is invalid`);
  if (
    !positiveDecimalPattern.test(evidence.lastValidHeight)
    || !positiveDecimalPattern.test(evidence.observedHeight)
    || BigInt(evidence.observedHeight) < BigInt(evidence.lastValidHeight)
  ) throw new Error(`${expectedObserver} supersede observed height is invalid`);
  if (
    !/^[A-Za-z0-9_-]{86}$/.test(evidence.evidenceSignature)
    || !verifySignature(null, Buffer.from(evidence.evidenceDigest, 'utf8'), publicKey, Buffer.from(evidence.evidenceSignature, 'base64url'))
  ) throw new Error(`${expectedObserver} supersede observer evidence signature is invalid`);
  return structuredClone(evidence);
}

function verifySupersessionAuthorization(value, state, requestDigest, actionKind, cycleTransaction) {
  const authorization = exactPayload(value, supersessionAuthorizationFields, 'supersession authorization');
  if (
    authorization.schema !== 'hookemon.fixture-supersession-authorization.v1'
    || authorization.fixtureOwner !== 'fixture-owner'
    || authorization.cycleId !== state.cycleId
    || authorization.requestDigest !== requestDigest
    || authorization.actionKind !== actionKind
    || authorization.attempt !== 1
    || !supersessionNoncePattern.test(authorization.nonce)
    || authorization.fixtureApprovalDigest !== fixtureSupersessionAuthorizationDigest(authorization)
  ) throw new Error('fresh exact supersession authorization is invalid');
  assertDigest(authorization.fixtureApprovalDigest, 'supersession authorization digest');
  if (
    typeof authorization.expiry !== 'string'
    || new Date(authorization.expiry).toISOString() !== authorization.expiry
    || Date.parse(FIXTURE_AUTHORIZATION_VALIDATED_AT) >= Date.parse(authorization.expiry)
  ) throw new Error('supersession authorization is expired');
  if (
    !/^[A-Za-z0-9_-]{86}$/.test(authorization.fixtureApprovalSignature)
    || !verifySignature(null, Buffer.from(authorization.fixtureApprovalDigest, 'utf8'), supersedeOwnerPublicKey, Buffer.from(authorization.fixtureApprovalSignature, 'base64url'))
  ) throw new Error('supersession authorization signature is invalid');
  const record = {
    key: authorization.fixtureApprovalDigest,
    nonceKey: digest({ domain: 'hookemon.fixture-supersession-authorization-nonce.v1', nonce: authorization.nonce }),
    cycleId: state.cycleId,
    actionKind,
    authorizationKind: 'mutation',
    actionDigest: requestDigest,
    subjectDigest: requestDigest,
    commitment: digest({ domain: 'hookemon.fixture-supersession-authorization-consumption.v1', authorization }),
    validatedAt: FIXTURE_AUTHORIZATION_VALIDATED_AT,
  };
  if (cycleTransaction.consumeAuthorization(record) !== record.key) throw new Error('supersession authorization store consumption mismatch');
  return structuredClone(authorization);
}

function externalMutationSuperseded(state, event, cycleTransaction) {
  const payload = exactPayload(event.payload, ['requestDigest', 'proof', 'authorization'], event.kind);
  assertDigest(payload.requestDigest, 'superseded mutation request digest');
  const attempt = state.externalMutations.get(payload.requestDigest);
  if (!attempt || attempt.status !== 'unresolved') throw new Error('only an unresolved external mutation can be superseded');
  if (!cycleActionKinds.includes(attempt.actionKind)) throw new Error('supersession is only available for broadcast-based action mutations');
  if (!state.broadcasts.has(payload.requestDigest)) throw new Error('a recorded broadcast is required before an unobserved mutation can be superseded');
  const prepared = state.actions.get(payload.requestDigest);
  const signed = state.signed.get(payload.requestDigest);
  const broadcast = state.broadcasts.get(payload.requestDigest);
  if (!prepared || !signed || !broadcast) throw new Error('durable prepared, signed, and broadcast evidence is required before supersession');
  const proof = assertPlainObject(payload.proof, ['provider', 'rpc'], 'dual supersede observer proof');
  const expected = {
    cycleId: state.cycleId,
    requestDigest: payload.requestDigest,
    actionKind: attempt.actionKind,
    signedBytesDigest: signed.signedBytesDigest,
    broadcastSignature: broadcast.broadcastSignature,
    lastValidHeight: prepared.action.validity.lastValidHeight,
  };
  const providerEvidence = verifySupersedeObserverEvidence(proof.provider, 'provider', supersedeProviderPublicKey, expected);
  const rpcEvidence = verifySupersedeObserverEvidence(proof.rpc, 'rpc', supersedeRpcPublicKey, expected);
  if (providerEvidence.observedHeight !== rpcEvidence.observedHeight) {
    throw new Error('dual supersede observer evidence must independently agree on the observed height');
  }
  verifySupersessionAuthorization(payload.authorization, state, payload.requestDigest, attempt.actionKind, cycleTransaction);
  retireVoidedExternalMutation(state, payload.requestDigest, attempt.actionKind);
}

function actionExecution(state, actionDigest) {
  const prepared = state.actions.get(actionDigest);
  const decoded = state.decoded.get(actionDigest);
  const signed = state.signed.get(actionDigest);
  const broadcast = state.broadcasts.get(actionDigest);
  if (!prepared || !decoded || !signed || !broadcast) throw new Error('fixture receipt requires decoded, signed, and broadcast evidence');
  return { ...prepared.digests, messageDigest: decoded.messageDigest, signedBytesDigest: signed.signedBytesDigest, broadcastSignature: broadcast.broadcastSignature };
}

export function requiredAuthorizationSubject(state, actionDigest, authorizationKind) {
  if (authorizationKind === 'mutation') return actionDigest;
  if (authorizationKind === 'sign') {
    const decoded = state.decoded.get(actionDigest);
    if (!decoded) throw new Error('decoded fixture message is required before sign authorization');
    return decoded.messageDigest;
  }
  const signed = state.signed.get(actionDigest);
  if (!signed) throw new Error(`signed fixture bytes are required before ${authorizationKind} authorization`);
  return signed.signedBytesDigest;
}

function consumedAuthorization(state, actionDigest, authorizationKind, subjectDigest) {
  const consumed = state.consumedApprovals.get(fixtureAuthorizationSlot(actionDigest, authorizationKind));
  if (!consumed || consumed.subjectDigest !== subjectDigest) throw new Error(`consumed ${authorizationKind} authorization is required`);
  return consumed;
}

export function evidenceForTransition(state, next, evidenceProfile = FIXTURE_EVIDENCE_PROFILE) {
  const required = {
    'outbound-finalized': ['outbound'],
    'purchase-finalized': ['outbound', 'purchase'],
    'open-reconciled': ['outbound', 'purchase'],
    'buyback-finalized': ['outbound', 'purchase', 'buyback'],
    'return-finalized': ['outbound', 'purchase', 'buyback', 'return'],
    closed: ['outbound', 'purchase', 'buyback', 'return'],
  }[next];
  if (!required) throw new Error('cycle transition is out of order');
  if (next === 'open-reconciled' && (
    !state.collector.generateIntent
    || !state.collector.openIntent
    || state.collector.authorizations.size !== 2
    || !state.collector.generated
    || !state.collector.verifiedStatus
    || !state.collector.opened
    || !state.collector.openExecution
    || !state.collector.openCustody
  )) throw new Error('complete authorized Collector generate, status, open, and finalized custody evidence is required');
  if (next === 'open-reconciled') {
    for (const [label, requestDigest] of [
      ['Collector generate', state.collector.generateIntent.requestDigest],
      ['Collector open', state.collector.openIntent.requestDigest],
    ]) {
      if (state.externalMutations.get(requestDigest)?.status !== 'externally-reconciled') throw new Error(`${label} mutation is unresolved`);
    }
  }
  if (next === 'closed') validateClosedLedger(state, null, evidenceProfile);
  return required.map(actionKind => {
    const receiptDigest = state.consumedByAction.get(actionKind);
    if (!receiptDigest) throw new Error('verified receipt evidence prefix is missing');
    const actionDigest = state.actionByKind.get(actionKind);
    if (state.externalMutations.get(actionDigest)?.status !== 'externally-reconciled') throw new Error(`external ${actionKind} mutation is unresolved`);
    const accounting = actionDigest && state.executionAccounting.get(actionDigest);
    if (!accounting || accounting.receiptDigest !== receiptDigest) throw new Error('independently verified execution accounting evidence prefix is missing');
    return receiptDigest;
  });
}

function actionReceipt(state, actionKind) {
  const actionDigest = state.actionByKind.get(actionKind);
  const receiptDigest = state.consumedByAction.get(actionKind);
  const prepared = actionDigest && state.actions.get(actionDigest);
  const receipt = receiptDigest && state.receipts.get(receiptDigest);
  const accounting = actionDigest && state.executionAccounting.get(actionDigest);
  if (!prepared || !receipt || receipt.actionDigest !== actionDigest || !state.consumedReceipts.has(receiptDigest)) throw new Error(`closed cycle ledger is missing ${actionKind} intent or receipt`);
  if (!accounting || accounting.receiptDigest !== receiptDigest) throw new Error(`closed cycle ledger is missing ${actionKind} execution accounting evidence`);
  if (!state.decoded.has(actionDigest) || !state.signed.has(actionDigest) || !state.broadcasts.has(actionDigest)) throw new Error(`closed cycle ledger has unresolved ${actionKind} execution evidence`);
  for (const authorizationKind of actionAuthorizationKinds) {
    const slot = fixtureAuthorizationSlot(actionDigest, authorizationKind);
    if (!state.approvals.has(slot) || !state.consumedApprovals.has(slot)) throw new Error(`closed cycle ledger has an unconsumed ${actionKind} authorization`);
  }
  return { actionDigest, receiptDigest, action: prepared.action, receipt, accounting };
}

function assertLedgerHandoff(left, right, label, { sameAsset = true } = {}) {
  const output = left.receipt.relation;
  const input = right.receipt.relation;
  if (
    output.destinationAccount !== input.sourceAccount
    || output.postDestinationBalance !== input.preSourceBalance
    || output.amountOut !== input.amountIn
    || (sameAsset && output.outputAsset !== input.inputAsset)
  ) throw new Error(`closed cycle ${label} ledger continuity is invalid`);
}

function validateClosedLedger(state, closedJournalHead = null, evidenceProfile = FIXTURE_EVIDENCE_PROFILE) {
  if (!state.preflight) throw new Error('closed cycle ledger requires the released-cycle preflight');
  if (!state.collector.generateIntent || !state.collector.openIntent || state.collector.authorizations.size !== 2 || !state.collector.generated || !state.collector.verifiedStatus || !state.collector.opened || !state.collector.openExecution || !state.collector.openCustody || !state.postOpenBuybackApproval) throw new Error('closed cycle ledger requires complete authorized Collector custody and buyback authorization');
  if (state.externalMutations.size !== 6 || [...state.externalMutations.values()].some(value => value.status !== 'externally-reconciled')) throw new Error('closed cycle ledger has unresolved external mutations');
  if (
    state.actions.size !== cycleActionKinds.length
    || state.actionByKind.size !== cycleActionKinds.length
    || state.decoded.size !== cycleActionKinds.length
    || state.signed.size !== cycleActionKinds.length
    || state.broadcasts.size !== cycleActionKinds.length
    || state.receipts.size !== cycleActionKinds.length
    || state.receiptIdentities.size !== cycleActionKinds.length
    || state.consumedReceipts.size !== cycleActionKinds.length
    || state.consumedByAction.size !== cycleActionKinds.length
    || state.executionAccounting.size !== cycleActionKinds.length
    || state.approvals.size !== cycleActionKinds.length * actionAuthorizationKinds.length
    || state.consumedApprovals.size !== cycleActionKinds.length * actionAuthorizationKinds.length
    || state.proceeds.size !== 0
  ) throw new Error('closed cycle ledger contains unmatched intents, receipts, authorizations, or proceeds');

  const orderedActions = cycleActionKinds.map(actionKind => actionReceipt(state, actionKind));
  const [outbound, purchase, buyback, returned] = orderedActions;
  const actualNativeGasUsed = Object.fromEntries(Object.keys(state.preflight.nativeGasCaps).map(chain => [chain, '0']));
  for (const item of orderedActions) {
    const chain = nativeGasChainForActionKind(item.action.actionKind);
    if (!Object.hasOwn(actualNativeGasUsed, chain)) throw new Error('closed cycle actual native gas chain is outside the preflight');
    actualNativeGasUsed[chain] = (BigInt(actualNativeGasUsed[chain]) + BigInt(item.accounting.nativeGas.actualDebit)).toString();
  }
  for (const [chain, amount] of Object.entries(actualNativeGasUsed)) {
    if (BigInt(amount) > BigInt(state.preflight.nativeGasCaps[chain])) throw new Error('closed cycle actual native gas exceeds the preflight cap');
    if (amount !== (state.nativeGasUsed.get(chain) ?? '0')) throw new Error('closed cycle actual native gas accounting does not reconcile');
  }
  if (orderedActions.some(({ action }) => (
    action.operationsTrigger !== state.preflight.operationsTrigger
    || action.cycleVaultAccount !== state.preflight.cycleVaultAccount
    || action.policyAccount !== state.preflight.policyAccount
    || action.returnAccount !== state.preflight.returnAccount
  ))) throw new Error('closed cycle ledger custody binding is invalid');
  assertLedgerHandoff(outbound, purchase, 'outbound-to-purchase');
  // purchase and buyback are never given a generic assertLedgerHandoff: purchase's output is a pack (an
  // unopened container) and buyback's input is the specific card the pack contained once opened — a
  // different asset identity by design, with the Collector "open" step's own custody evidence
  // (openCustody.prePackBalance/postPackBalance chained to purchaseRelation/buybackRelation below) as
  // the real, asset-correct continuity proof. A generic amountOut===amountIn handoff between them would
  // only ever hold by forcing both actions' generic "amount" fields to the same arbitrary literal
  // regardless of what each one actually denominates — exactly the NFT-unit/Circle-USD-amount conflation this
  // reducer now keeps separated (buyback's generic amount is the NFT unit quantity, '1'; purchase's is a
  // placeholder Circle-USD-shaped literal with no purchase-side security meaning of its own).
  assertLedgerHandoff(buyback, returned, 'buyback-to-return');

  const outboundRelation = outbound.receipt.relation;
  const purchaseRelation = purchase.receipt.relation;
  const buybackRelation = buyback.receipt.relation;
  const returnRelation = returned.receipt.relation;
  const openCustody = state.collector.openCustody.custody;
  const finalActivity = returned.accounting.accountActivity;
  const releasedAmount = BigInt(state.preflight.releasedAmount);
  const principal = BigInt(state.preflight.totalPrincipal);
  // The policy account (outbound's destination, purchase's source) is publicly fundable exactly like
  // the refund token account and the vault's return account below: a stray donation landing on it
  // before the bridge credit, or sitting there afterward as unspent dust, must never wedge the cycle.
  // outboundRelation.preDestinationBalance and purchaseRelation.postSourceBalance are therefore not
  // required to be literal zero — only the vault's own outbound debit (preSourceBalance/postSourceBalance
  // against the exact released/principal amounts, which the vault itself controls precisely) keeps its
  // exact-match requirement, since that is a spend-authorization check, not an isolation check.
  if (
    outboundRelation.inputAsset !== 'USDG'
    || outboundRelation.sourceAccount !== state.preflight.returnAccount
    || outboundRelation.destinationAccount !== state.preflight.policyAccount
    || outboundRelation.amountIn !== state.preflight.totalPrincipal
    || outboundRelation.preSourceBalance !== state.preflight.releasedAmount
    || BigInt(outboundRelation.postSourceBalance) !== releasedAmount - principal
    || outboundRelation.postSourceBalance !== '0'
  ) throw new Error('closed cycle vault debit or outbound ledger is invalid');
  if (
    purchaseRelation.sourceAccount !== state.preflight.policyAccount
    || state.collector.opened.wallet !== state.preflight.policyAccount
    || purchaseRelation.destinationAccount !== state.collector.opened.prizeWallet
    || buybackRelation.sourceAccount !== state.collector.opened.prizeWallet
    || purchaseRelation.preDestinationBalance !== '0'
    || buybackRelation.postSourceBalance !== '0'
    || purchaseRelation.nftMint !== openCustody.packTokenMint
    || purchaseRelation.nftCustodyAccount !== openCustody.packTokenAccount
    || purchaseRelation.postNftBalance !== openCustody.prePackBalance
    || openCustody.postPackBalance !== '0'
    || openCustody.nftMint !== buybackRelation.nftMint
    || openCustody.nftCustodyAccount !== buybackRelation.nftCustodyAccount
    || openCustody.nftCustodyAccount !== state.collector.opened.wallet
    || openCustody.nftCustodyAccount !== state.preflight.policyAccount
    || openCustody.postNftBalance !== buybackRelation.preNftBalance
    || buybackRelation.postNftBalance !== '0'
    || buybackRelation.nftDestinationAccount !== evidenceProfile.postOpenBuyback.prizeWallet(state.postOpenBuybackApproval, buyback.action)
    || buybackRelation.nftDestinationAccount !== buyback.action.sourceAccount
    || buybackRelation.preNftDestinationBalance !== '0'
    || buybackRelation.postNftDestinationBalance !== '1'
    || buyback.accounting.nftDestinationActivity.account !== buybackRelation.nftDestinationAccount
    || buyback.accounting.nftDestinationActivity.openingBalance !== buybackRelation.preNftDestinationBalance
    || buyback.accounting.nftDestinationActivity.closingBalance !== buybackRelation.postNftDestinationBalance
  ) throw new Error('closed cycle Collector NFT custody ledger is invalid');
  if (BigInt(purchase.receipt.blockHeight) >= BigInt(openCustody.blockHeight) || BigInt(openCustody.blockHeight) >= BigInt(buyback.receipt.blockHeight)) throw new Error('closed cycle purchase, Collector open, and buyback chronology is invalid');
  // The refund token account and the vault's return account are both publicly fundable (any external
  // party can send them a stray transfer). Rather than require their pre-credit balance to be exactly
  // zero — which a single unsolicited donation would violate, wedging the cycle forever — this enforces
  // exact expected-delta accounting instead: assertLedgerHandoff above already ties the buyback's exact
  // proceeds to the return leg's exact input (buyback.amountOut === return.amountIn), and
  // assertTransferRelation (schemas.mjs) already enforces every relation's pre/post delta equals its
  // amountIn/amountOut. What is dropped here is only the additional, unrelated requirement that the
  // account's balance happened to start at literal zero — a fact about donation history, not about
  // whether the cycle moved exactly the attributable amount it authorized.
  if (
    returnRelation.outputAsset !== 'USDG'
    || returnRelation.destinationAccount !== state.preflight.returnAccount
    || finalActivity.account !== state.preflight.returnAccount
    || finalActivity.asset !== 'USDG'
    || finalActivity.openingBalance !== returnRelation.preDestinationBalance
    || BigInt(returnRelation.postDestinationBalance) - BigInt(returnRelation.preDestinationBalance) !== BigInt(returnRelation.amountOut)
    || BigInt(returnRelation.amountOut) <= 0n
  ) throw new Error('closed cycle final vault USDG credit delta does not match the attributable return amount');
  if (
    finalActivity.fromBlockHeight !== buyback.receipt.blockHeight
    || finalActivity.fromBlockHash !== buyback.receipt.blockHash
    || finalActivity.toBlockHeight !== returned.receipt.blockHeight
    || finalActivity.toBlockHash !== returned.receipt.blockHash
  ) throw new Error('closed cycle final vault account activity window is not continuous and finalized');

  if (closedJournalHead === null) return null;
  assertDigest(closedJournalHead, 'closed cycle journal head');
  const ledger = {
    schema: 'hookemon.fixture-closed-cycle-ledger.v4',
    cycleId: state.cycleId,
    requirementsRevision: state.preflight.requirementsRevision,
    preflightDigest: state.preflight.preflightDigest,
    // Locally-recomputed digest of the already-verified (fixture-signed or production observer-
    // confirmed) release evidence — an immutable audit-trail pointer, never re-verified against
    // anything else, so this is intentionally profile-agnostic rather than an embedded fixture-only
    // digest field.
    fundingAuthorizationDigest: digest({ domain: 'hookemon.cycle-release-evidence-record.v1', releaseEvidence: state.preflight.releaseEvidence }),
    operationsTrigger: state.preflight.operationsTrigger,
    cycleVaultAccount: state.preflight.cycleVaultAccount,
    policyAccount: state.preflight.policyAccount,
    returnAccount: state.preflight.returnAccount,
    closedJournalHead,
    orderedReceiptDigests: [outbound.receiptDigest, purchase.receiptDigest, buyback.receiptDigest, returned.receiptDigest],
    orderedExecutionAccountingDigests: orderedActions.map(item => item.accounting.verificationDigest),
    actualNativeGasUsed,
    collectorOpen: structuredClone(state.collector.opened),
    collectorOpenExecutionDigest: state.collector.openExecution.executionDigest,
    // Locally-recomputed digests of the already-verified (fixture-signed or production
    // observer-confirmed) Collector status/custody/RPC-finality records, recorded here purely as an
    // immutable audit-trail pointer — never re-verified against anything else — so this is
    // intentionally profile-agnostic rather than reaching for an embedded fixture-only digest field.
    collectorStatusDigest: digest({ domain: 'hookemon.collector-status-record.v1', status: state.collector.verifiedStatus }),
    collectorOpenCustodyDigest: digest({ domain: 'hookemon.collector-open-custody-record.v1', custody: state.collector.openCustody.custody }),
    collectorRpcFinalityDigest: digest({ domain: 'hookemon.collector-rpc-finality-record.v1', rpcFinality: state.collector.openCustody.rpcFinality }),
    finalCredit: {
      receiptDigest: returned.receiptDigest,
      destinationAccount: returnRelation.destinationAccount,
      asset: returnRelation.outputAsset,
      preBalance: returnRelation.preDestinationBalance,
      postBalance: returnRelation.postDestinationBalance,
      amount: returnRelation.amountOut,
      transactionSignature: returned.receipt.transactionSignature,
      blockHeight: returned.receipt.blockHeight,
      blockHash: returned.receipt.blockHash,
    },
  };
  return { ...ledger, ledgerDigest: digest({ domain: 'hookemon.fixture-closed-cycle-ledger.v4', ledger }) };
}

export function deriveReturnedProceedsKey(state, receiptDigest) {
  assertDigest(receiptDigest, 'returned proceeds receipt digest');
  const ledger = state.closedLedger;
  if (state.stage !== 'closed' || !ledger || ledger.finalCredit.receiptDigest !== receiptDigest) throw new Error('closed activity-isolated return ledger is required for proceeds');
  return digest({
    domain: 'hookemon.cycle-runner.proceeds.v4',
    cycleId: state.cycleId,
    preflightDigest: ledger.preflightDigest,
    closedJournalHead: ledger.closedJournalHead,
    ledgerDigest: ledger.ledgerDigest,
    cycleVaultAccount: ledger.cycleVaultAccount,
    returnAccount: ledger.returnAccount,
    finalCredit: ledger.finalCredit,
  });
}

export function readClosedProceedsBasisHandoff(state, proceedsKey) {
  assertDigest(proceedsKey, 'closed proceeds basis key');
  const ledger = state.closedLedger;
  const proceeds = state.proceeds.get(proceedsKey);
  if (
    state.stage !== 'closed'
    || !ledger
    || !proceeds
    || proceeds.receiptDigest !== ledger.finalCredit.receiptDigest
    || proceeds.ledgerDigest !== ledger.ledgerDigest
  ) throw new Error('authenticated closed-cycle proceeds are required for a closed proceeds basis');
  return {
    schema: 'hookemon.closed-proceeds-basis-handoff.v1',
    authority: 'READ_ONLY_SELF_CONSISTENT_NOT_STORE_MEMBERSHIP_PROOF',
    cycleId: state.cycleId,
    proceedsKey,
    closedLedger: structuredClone(ledger),
  };
}

function verifyIntent(state, event, evidenceProfile) {
  const payload = exactPayload(event.payload, ['action', 'actionDigest', 'bindingDigest', 'instructionsDigest', 'signersDigest'], event.kind);
  const action = evidenceProfile.action.assert(payload.action);
  const digests = evidenceProfile.action.digests(action);
  if (action.cycleId !== state.cycleId) throw new Error('fixture action cycle mismatch');
  if (state.collector.generated && (!sameCanonical(action.binding, state.collector.generated.binding) || action.preflightDigest !== state.collector.generated.preflightDigest)) throw new Error('Collector action wallet or preflight binding is invalid');
  // Vault-debit ordering: a purchase intent moves real Circle USD out of the policy wallet toward whatever
  // `destination` it names. That destination is only meaningful once Collector's own generate response
  // has told the reducer which prize wallet the pack was actually generated against — without this
  // being mandatory, a purchase could be prepared (and its funds committed) with an unverified
  // destination, before the funding stage the money is actually meant to follow even exists.
  if (action.actionKind === 'purchase') {
    if (!state.collector.generated) throw new Error('a verified Collector generate response is required before a purchase intent');
    if (action.destination !== state.collector.generated.response.prizeWallet) throw new Error('Collector purchase prize-wallet binding is invalid');
  }
  if (!state.preflight) throw new Error('released-cycle spend preflight is required before fixture action intent');
  const nativeGasChain = nativeGasChainForActionKind(action.actionKind);
  const nativeGasCap = state.preflight.nativeGasCaps[nativeGasChain];
  const nextNativeGasReserved = BigInt(state.nativeGasReserved.get(nativeGasChain) ?? '0') + BigInt(action.nativeGasAmount);
  if (
    action.preflightDigest !== state.preflight.preflightDigest
    || action.operationsTrigger !== state.preflight.operationsTrigger
    || action.cycleVaultAccount !== state.preflight.cycleVaultAccount
    || action.policyAccount !== state.preflight.policyAccount
    || action.returnAccount !== state.preflight.returnAccount
    || action.minimumReceive !== state.preflight.minimumReceives[action.actionKind]
    || BigInt(action.principalAmount) > BigInt(state.preflight.totalPrincipal)
    || BigInt(action.principalAmount) > BigInt(state.preflight.releasedAmount)
    || BigInt(action.amount) > BigInt(state.preflight.spendCap)
    || BigInt(action.amount) > BigInt(state.preflight.releasedAmount)
    || nativeGasCap === undefined
    || nextNativeGasReserved > BigInt(nativeGasCap)
  ) throw new Error('fixture action exceeds or mismatches released-cycle spend preflight');
  if (state.stage !== actionStage.get(action.actionKind)) throw new Error('fixture action predecessor stage is invalid');
  for (const [field, expected] of Object.entries(digests)) if (payload[field] !== expected) throw new Error(`fixture action ${field} mismatch`);
  if (state.actions.has(payload.actionDigest) || state.actionByKind.has(action.actionKind)) throw new Error('duplicate fixture action intent');
  const walletBinding = {
    executionWallet: action.binding.executionWallet,
    refundTokenAccount: action.binding.refundTokenAccount,
    refundTokenAccountOwner: action.binding.refundTokenAccountOwner,
  };
  if (state.walletBinding && !sameCanonical(state.walletBinding, walletBinding)) throw new Error('fixture action cycle wallet binding is invalid');
  state.walletBinding ??= walletBinding;
  state.actions.set(payload.actionDigest, { action, digests });
  state.actionByKind.set(action.actionKind, payload.actionDigest);
  state.nativeGasReserved.set(nativeGasChain, nextNativeGasReserved.toString());
}

function verifyPreflight(state, event, evidenceProfile) {
  const payload = exactPayload(event.payload, ['preflight', 'preflightDigest'], event.kind);
  const preflight = evidenceProfile.preflight.verify(payload.preflight);
  assertDigest(payload.preflightDigest, 'fixture cycle spend preflight digest');
  if (payload.preflightDigest !== preflight.preflightDigest) throw new Error('fixture cycle spend preflight journal digest mismatch');
  if (preflight.cycleId !== state.cycleId) throw new Error('fixture cycle spend preflight cycle mismatch');
  if (state.preflight || state.actions.size !== 0 || state.stage !== 'prepared') throw new Error('fixture cycle spend preflight is duplicate or late');
  state.preflight = preflight;
}

function verifyApproval(state, event, evidenceProfile) {
  const payload = exactPayload(event.payload, ['approval'], event.kind);
  // The reducer does not know which AuthorizationProvider produced this record — it only knows the
  // provider verified it. The fixture evidence profile's provider is fixture-mode, so this call is a
  // byte-identical passthrough to the previous hardcoded verifyFixtureAuthorization call for every
  // existing fixture test. The standing-authority provider uses the current verification time for
  // both first use and replay; accepting a historical verification without rechecking expiry and
  // daily capacity needs a separately approved durable decision record.
  const approval = evidenceProfile.authorization.provider.verifyStepAuthorization(payload.approval, stepAuthorizationNow(payload.approval));
  // Eagerly validates the approval (including expiry — see authorization.mjs's
  // fixtureAuthorizationStoreRecord / evidence-profile.mjs's production storeRecord) before it is
  // allowed to occupy the action's authorization slot at all; the store record itself is recomputed
  // (and re-validated) again at actual consumption time in consumeApproval below.
  evidenceProfile.authorization.storeRecord(approval, FIXTURE_AUTHORIZATION_VALIDATED_AT);
  const actionDigest = evidenceProfile.authorization.resolveActionDigest(state, approval);
  const prepared = actionDigest && state.actions.get(actionDigest);
  if (!prepared) throw new Error('owner approval action is unknown');
  if (state.collector.generated && prepared.action.actionKind === 'buyback' && approval.authorizationKind === 'mutation' && !state.postOpenBuybackApproval) throw new Error('separate post-open buyback authorization is required');
  evidenceProfile.authorization.matchApproval(approval, prepared, actionDigest);
  const subjectDigest = requiredAuthorizationSubject(state, actionDigest, approval.authorizationKind);
  if (approval.subjectDigest !== subjectDigest) throw new Error(`owner approval ${approval.authorizationKind} subject digest mismatch`);
  const slot = fixtureAuthorizationSlot(actionDigest, approval.authorizationKind);
  if (state.approvals.has(slot)) throw new Error(`duplicate ${approval.authorizationKind} owner approval`);
  state.approvals.set(slot, approval);
}

function consumeApproval(state, event, cycleTransaction, evidenceProfile) {
  const payload = exactPayload(event.payload, ['actionDigest', 'authorizationKind', 'subjectDigest', 'approvalKey', 'validatedAt'], event.kind);
  assertDigest(payload.actionDigest, 'approval action digest');
  assertDigest(payload.subjectDigest, 'approval subject digest');
  assertDigest(payload.approvalKey, 'approval key');
  const slot = fixtureAuthorizationSlot(payload.actionDigest, payload.authorizationKind);
  const approval = state.approvals.get(slot);
  const approvalKey = approval && evidenceProfile.authorization.approvalKey(approval);
  if (!approval || approvalKey !== payload.approvalKey || approval.subjectDigest !== payload.subjectDigest) throw new Error('forged owner approval consumption binding');
  if (state.consumedApprovals.has(slot)) throw new Error(`${payload.authorizationKind} owner approval already consumed`);
  const record = evidenceProfile.authorization.storeRecord(approval, payload.validatedAt);
  if (record.key !== payload.approvalKey || record.authorizationKind !== payload.authorizationKind || record.subjectDigest !== payload.subjectDigest || cycleTransaction.consumeAuthorization(record) !== payload.approvalKey) throw new Error('authorization store consumption mismatch');
  state.consumedApprovals.set(slot, { approvalKey: payload.approvalKey, subjectDigest: payload.subjectDigest });
}

function verifyDecode(state, event, evidenceProfile) {
  const payload = exactPayload(event.payload, ['actionDigest', 'messageBytes', 'messageDigest'], event.kind);
  assertDigest(payload.actionDigest, 'decoded action digest');
  assertDigest(payload.messageDigest, 'decoded message digest');
  const prepared = state.actions.get(payload.actionDigest);
  if (!prepared) throw new Error('prepared action is required before decode');
  const mutation = state.externalMutations.get(payload.actionDigest);
  if (!mutation || mutation.status !== 'unresolved') throw new Error('durable unresolved external mutation attempt is required before decode');
  const approvalKey = consumedAuthorization(state, payload.actionDigest, 'mutation', payload.actionDigest).approvalKey;
  if (state.decoded.has(payload.actionDigest)) throw new Error('message decode already journaled');
  const decoded = evidenceProfile.message.decode(payload.messageBytes);
  const expected = evidenceProfile.message.forAction(prepared.action, { ...prepared.digests, approvalKey });
  if (!sameCanonical(decoded, expected)) throw new Error('decoded message is not bound to exact action and approval');
  const messageDigest = digest({ domain: evidenceProfile.message.digestDomain, message: decoded });
  if (payload.messageDigest !== messageDigest) throw new Error('decoded message digest mismatch');
  state.decoded.set(payload.actionDigest, { messageBytes: payload.messageBytes, messageDigest, decoded });
}

function verifySigned(state, event, evidenceProfile) {
  const payload = exactPayload(event.payload, ['actionDigest', 'messageDigest', 'signedBytes', 'signedBytesDigest', 'broadcastSignature'], event.kind);
  for (const field of ['actionDigest', 'messageDigest', 'signedBytesDigest']) assertDigest(payload[field], `signed evidence ${field}`);
  const decoded = state.decoded.get(payload.actionDigest);
  if (!decoded || decoded.messageDigest !== payload.messageDigest) throw new Error('decoded message is required before signed evidence');
  consumedAuthorization(state, payload.actionDigest, 'sign', payload.messageDigest);
  if (state.signed.has(payload.actionDigest)) throw new Error('signed bytes already journaled');
  const verified = evidenceProfile.signedTransaction.verify(payload.signedBytes, decoded);
  if (payload.broadcastSignature !== verified.broadcastSignature) throw new Error('signed broadcast signature mismatch');
  const expectedDigest = digest({ domain: evidenceProfile.signedTransaction.digestDomain, messageDigest: payload.messageDigest, signedBytes: payload.signedBytes });
  if (payload.signedBytesDigest !== expectedDigest) throw new Error('signed bytes digest mismatch');
  state.signed.set(payload.actionDigest, structuredClone(payload));
}

function verifyBlockhashValidity(state, event, evidenceProfile) {
  const payload = exactPayload(event.payload, ['evidence'], event.kind);
  const evidence = evidenceProfile.blockhashValidity.verify(payload.evidence);
  const prepared = state.actions.get(evidence.actionDigest);
  const signed = state.signed.get(evidence.actionDigest);
  if (!prepared || !signed) throw new Error('signed fixture action is required before blockhash validity evidence');
  if (state.broadcasts.has(evidence.actionDigest)) throw new Error('blockhash validity cannot be recorded after broadcast');
  if (
    evidence.cycleId !== state.cycleId
    || evidence.messageDigest !== signed.messageDigest
    || evidence.signedBytesDigest !== signed.signedBytesDigest
    || evidence.recentBlockhash !== prepared.action.validity.recentBlockhash
    || evidence.lastValidHeight !== prepared.action.validity.lastValidHeight
    || BigInt(evidence.observedHeight) < BigInt(prepared.action.validity.currentHeight)
  ) throw new Error('fixture blockhash validity does not bind the signed action window');
  const previous = state.blockhashValidity.get(evidence.actionDigest);
  if (previous && BigInt(evidence.observedHeight) <= BigInt(previous.evidence.observedHeight)) {
    throw new Error('fixture blockhash validity evidence is stale or replayed');
  }
  state.blockhashValidity.set(evidence.actionDigest, { evidence, eventDigest: event.digest });
}

function verifyBroadcast(state, event) {
  const payload = exactPayload(event.payload, ['actionDigest', 'messageDigest', 'signedBytesDigest', 'broadcastSignature'], event.kind);
  for (const field of ['actionDigest', 'messageDigest', 'signedBytesDigest']) assertDigest(payload[field], `broadcast evidence ${field}`);
  if (typeof payload.broadcastSignature !== 'string' || payload.broadcastSignature === '') throw new Error('broadcast signature is invalid');
  const signed = state.signed.get(payload.actionDigest);
  if (!signed || signed.messageDigest !== payload.messageDigest || signed.signedBytesDigest !== payload.signedBytesDigest || signed.broadcastSignature !== payload.broadcastSignature) throw new Error('broadcast evidence does not match signed bytes');
  for (const authorizationKind of ['broadcast', 'asset-spend', 'gas-spend']) consumedAuthorization(state, payload.actionDigest, authorizationKind, payload.signedBytesDigest);
  if (state.broadcasts.has(payload.actionDigest)) throw new Error('broadcast already journaled');
  const validity = state.blockhashValidity.get(payload.actionDigest);
  if (!validity || validity.eventDigest !== event.previousDigest) throw new Error('independently verified blockhash validity evidence is required immediately before broadcast');
  state.broadcasts.set(payload.actionDigest, structuredClone(payload));
}

function verifyReceipt(state, event, evidenceProfile) {
  const payload = exactPayload(event.payload, ['receipt', 'receiptDigest', 'registryKey'], event.kind);
  const receipt = evidenceProfile.providerReceipt.verify(payload.receipt);
  const receiptDigest = digest({ domain: evidenceProfile.providerReceipt.digestDomain, receipt });
  if (payload.receiptDigest !== receiptDigest) throw new Error('provider receipt digest mismatch');
  const prepared = state.actions.get(receipt.actionDigest);
  if (!prepared) throw new Error('provider receipt action is unknown');
  const execution = actionExecution(state, receipt.actionDigest);
  evidenceProfile.providerReceipt.relationship(receipt, prepared.action, execution);
  if (receipt.actionKind === 'buyback') {
    const decoded = state.decoded.get(receipt.actionDigest)?.decoded;
    if (
      !state.postOpenBuybackApproval
      || receipt.relation.nftDestinationAccount !== evidenceProfile.postOpenBuyback.prizeWallet(state.postOpenBuybackApproval, prepared.action)
      || receipt.relation.nftDestinationAccount !== decoded?.sourceAccount
    ) throw new Error('buyback NFT destination must match the post-open approval and signed transaction message');
  }
  // Monotonicity is enforced per chain, never globally: a bridge leg's receipt lands on a different
  // chain (and therefore a different, incomparable block-height numbering) from a Collector Crypt
  // leg's receipt. Comparing heights across chains is meaningless and was the source of a real
  // cross-chain-monotonicity bug; see BRIDGE_CHAIN_IDS and chainKeyForReceipt below.
  const chainKey = chainKeyForReceipt(receipt);
  const previousChainHeight = state.finalizedBlockHeightByChain.get(chainKey) ?? null;
  if (previousChainHeight !== null && BigInt(receipt.blockHeight) < BigInt(previousChainHeight)) throw new Error('fixture receipt finalized block height is not monotone on its own chain');
  const registryKey = evidenceProfile.providerReceipt.identityKey(receipt);
  if (payload.registryKey !== registryKey) throw new Error('provider receipt registry key mismatch');
  if (state.receipts.has(receiptDigest) || state.receiptIdentities.has(registryKey)) throw new Error('duplicate canonical provider receipt');
  state.receipts.set(receiptDigest, receipt);
  state.receiptIdentities.add(registryKey);
  state.finalizedBlockHeightByChain.set(chainKey, receipt.blockHeight);
}

function verifyExecutionAccounting(state, event, evidenceProfile) {
  const payload = exactPayload(event.payload, ['evidence'], event.kind);
  const evidence = evidenceProfile.executionAccounting.verify(payload.evidence);
  const prepared = state.actions.get(evidence.actionDigest);
  const receipt = state.receipts.get(evidence.receiptDigest);
  if (!prepared || !receipt) throw new Error('verified action and provider receipt are required before execution accounting');
  const action = prepared.action;
  const broadcast = state.broadcasts.get(evidence.actionDigest);
  if (
    evidence.cycleId !== state.cycleId
    || evidence.actionKind !== action.actionKind
    || receipt.actionDigest !== evidence.actionDigest
    || receipt.actionKind !== evidence.actionKind
    || evidence.transactionSignature !== receipt.transactionSignature
    || evidence.transactionSignature !== broadcast?.broadcastSignature
    || evidence.blockHeight !== receipt.blockHeight
    || evidence.blockHash !== receipt.blockHash
  ) throw new Error('execution accounting does not bind the finalized broadcast and provider receipt');
  if (evidence.nativeGas.account !== action.feePayer || evidence.nativeGas.asset !== 'SOL') throw new Error('fixture actual native gas does not bind the approved fee payer and chain asset');
  if (BigInt(evidence.nativeGas.actualDebit) > BigInt(action.nativeGasAmount)) throw new Error('fixture actual native gas exceeds the authorized action gas amount');

  const relation = receipt.relation;
  const sourceActivity = evidence.sourceActivity;
  const nftDestinationActivity = evidence.nftDestinationActivity;
  const activity = evidence.accountActivity;
  const sourceCustody = action.actionKind === 'buyback'
    ? {
        account: relation.nftCustodyAccount,
        asset: relation.nftMint,
        openingBalance: relation.preNftBalance,
        closingBalance: relation.postNftBalance,
        amount: (BigInt(relation.preNftBalance) - BigInt(relation.postNftBalance)).toString(),
      }
    : {
        account: relation.sourceAccount,
        asset: relation.inputAsset,
        openingBalance: relation.preSourceBalance,
        closingBalance: relation.postSourceBalance,
        amount: relation.amountIn,
      };
  const expectedSourceMovement = {
    transactionSignature: receipt.transactionSignature,
    receiptDigest: evidence.receiptDigest,
    blockHeight: receipt.blockHeight,
    blockHash: receipt.blockHash,
    direction: 'debit',
    asset: sourceCustody.asset,
    amount: sourceCustody.amount,
  };
  const expectedMovement = {
    transactionSignature: receipt.transactionSignature,
    receiptDigest: evidence.receiptDigest,
    blockHeight: receipt.blockHeight,
    blockHash: receipt.blockHash,
    direction: 'credit',
    asset: relation.outputAsset,
    amount: relation.amountOut,
  };
  if (
    sourceActivity.account !== sourceCustody.account
    || sourceActivity.asset !== sourceCustody.asset
    || sourceActivity.openingBalance !== sourceCustody.openingBalance
    || sourceActivity.closingBalance !== sourceCustody.closingBalance
    || sourceActivity.movements.length !== 1
    || !sameCanonical(sourceActivity.movements[0], expectedSourceMovement)
  ) throw new Error('fixture finalized source custody activity does not bind the exact independent debit');
  if (
    activity.account !== relation.destinationAccount
    || activity.asset !== relation.outputAsset
    || activity.openingBalance !== relation.preDestinationBalance
    || activity.closingBalance !== relation.postDestinationBalance
    || activity.movements.length !== 1
    || !sameCanonical(activity.movements[0], expectedMovement)
  ) throw new Error('fixture finalized account activity contains unrelated movements or is not activity-isolated');
  if (action.actionKind === 'buyback') {
    const approvedRefund = state.postOpenBuybackApproval && evidenceProfile.postOpenBuyback.refundAmount(state.postOpenBuybackApproval);
    const independentDestinationDelta = (BigInt(activity.closingBalance) - BigInt(activity.openingBalance)).toString();
    const expectedNftDestinationMovement = {
      transactionSignature: receipt.transactionSignature,
      receiptDigest: evidence.receiptDigest,
      blockHeight: receipt.blockHeight,
      blockHash: receipt.blockHash,
      direction: 'credit',
      asset: relation.nftMint,
      amount: '1',
    };
    if (
      !nftDestinationActivity
      || nftDestinationActivity.account !== relation.nftDestinationAccount
      || nftDestinationActivity.account !== (state.postOpenBuybackApproval && evidenceProfile.postOpenBuyback.prizeWallet(state.postOpenBuybackApproval, action))
      || nftDestinationActivity.asset !== relation.nftMint
      || nftDestinationActivity.openingBalance !== relation.preNftDestinationBalance
      || nftDestinationActivity.closingBalance !== relation.postNftDestinationBalance
      || nftDestinationActivity.movements.length !== 1
      || !sameCanonical(nftDestinationActivity.movements[0], expectedNftDestinationMovement)
    ) throw new Error('independent buyback NFT destination custody activity is invalid');
    if (
      approvedRefund === undefined
      || approvedRefund !== relation.amountOut
      || approvedRefund !== independentDestinationDelta
    ) throw new Error('fixture buyback refund amount must exactly equal the post-open approval, provider receipt, and independent destination delta');
  }
  if (
    state.executionAccounting.has(evidence.actionDigest)
    || [...state.executionAccounting.values()].some(value => value.receiptDigest === evidence.receiptDigest)
  ) throw new Error('fixture execution accounting evidence is already consumed');
  const nativeGasChain = nativeGasChainForActionKind(action.actionKind);
  const nativeGasCap = state.preflight?.nativeGasCaps[nativeGasChain];
  const nextNativeGasUsed = BigInt(state.nativeGasUsed.get(nativeGasChain) ?? '0') + BigInt(evidence.nativeGas.actualDebit);
  if (nativeGasCap === undefined || nextNativeGasUsed > BigInt(nativeGasCap)) throw new Error('fixture actual native gas exceeds the released-cycle cap');
  state.executionAccounting.set(evidence.actionDigest, evidence);
  state.nativeGasUsed.set(nativeGasChain, nextNativeGasUsed.toString());
}

function consumeReceipt(state, event, receiptTransaction, evidenceProfile) {
  const payload = exactPayload(event.payload, ['receiptDigest', 'registryKey'], event.kind);
  assertDigest(payload.receiptDigest, 'consumed receipt digest');
  assertDigest(payload.registryKey, 'consumed receipt registry key');
  const receipt = state.receipts.get(payload.receiptDigest);
  if (!receipt) throw new Error('verified provider receipt is required before consumption');
  if (state.executionAccounting.get(receipt.actionDigest)?.receiptDigest !== payload.receiptDigest) {
    throw new Error('independently verified execution accounting with source custody evidence is required before receipt consumption');
  }
  if (receipt.actionKind === 'buyback' && !state.executionAccounting.get(receipt.actionDigest)?.nftDestinationActivity) throw new Error('independently verified buyback NFT destination custody accounting is required before receipt consumption');
  if (state.consumedReceipts.has(payload.receiptDigest) || state.consumedByAction.has(receipt.actionKind)) throw new Error('receipt consumption is duplicate');
  const record = evidenceProfile.providerReceipt.registryRecord(receipt, payload.receiptDigest);
  if (payload.registryKey !== record.key || receiptTransaction.consume(record) !== payload.registryKey) throw new Error('receipt registry consumption mismatch');
  state.consumedReceipts.add(payload.receiptDigest);
  state.consumedByAction.set(receipt.actionKind, payload.receiptDigest);
}

function transition(state, event, evidenceProfile) {
  const payload = exactPayload(event.payload, ['expectedVersion', 'expectedJournalHead', 'from', 'next', 'evidence'], event.kind);
  if (!Number.isInteger(payload.expectedVersion) || payload.expectedVersion !== state.version) throw new Error('stale cycle version');
  if (payload.expectedJournalHead !== state.head || payload.expectedJournalHead !== event.previousDigest) throw new Error('stale cycle journal head');
  if (payload.from !== state.stage) throw new Error('cycle transition predecessor mismatch');
  const expectedNext = transitionOrder[transitionOrder.indexOf(state.stage) + 1];
  if (payload.next !== expectedNext) throw new Error('cycle transition is out of order');
  const evidence = evidenceForTransition(state, payload.next, evidenceProfile);
  if (!sameCanonical(payload.evidence, evidence)) throw new Error('cycle transition evidence prefix mismatch');
  if (payload.next === 'closed') state.closedLedger = validateClosedLedger(state, event.digest, evidenceProfile);
  state.stage = payload.next;
  state.version += 1;
}

function consumeProceeds(state, event) {
  const payload = exactPayload(event.payload, ['receiptDigest', 'proceedsKey'], event.kind);
  for (const field of ['receiptDigest', 'proceedsKey']) assertDigest(payload[field], `proceeds ${field}`);
  const expectedKey = deriveReturnedProceedsKey(state, payload.receiptDigest);
  if (payload.proceedsKey !== expectedKey) throw new Error('proceeds attribution key mismatch');
  if (
    state.proceeds.has(payload.proceedsKey)
    || [...state.proceeds.values()].some(value => value.receiptDigest === payload.receiptDigest || value.ledgerDigest === state.closedLedger.ledgerDigest)
  ) throw new Error('proceeds already consumed');
  state.proceeds.set(payload.proceedsKey, { receiptDigest: payload.receiptDigest, ledgerDigest: state.closedLedger.ledgerDigest });
}

function recordDistributionVerification(state, event) {
  const payload = exactPayload(event.payload, ['receipt'], event.kind);
  const receipt = verifyDistributionVerificationReceipt(payload.receipt);
  if (state.stage !== 'closed' || !state.closedLedger) {
    throw new Error('closed cycle is required before distribution verification');
  }
  if (state.distributionVerification) {
    throw new Error('distribution verification is already recorded');
  }
  const proceeds = state.proceeds.get(receipt.proceedsKey);
  if (!proceeds || proceeds.ledgerDigest !== state.closedLedger.ledgerDigest) {
    throw new Error('distribution verification proceeds are not authenticated');
  }
  const basis = deriveClosedProceedsBasis(
    readClosedProceedsBasisHandoff(state, receipt.proceedsKey),
  );
  const expectedOnchainCycleId = state.frozenControl?.escrowObservation.onchainCycleId ?? state.cycleId;
  if (
    receipt.runnerCycleId !== state.cycleId
    || receipt.onchainCycleId !== expectedOnchainCycleId
    || receipt.closedLedgerDigest !== state.closedLedger.ledgerDigest
    || receipt.closedProceedsBasisDigest !== basis.basisDigest
    || receipt.verificationJournalHead !== event.previousDigest
    || receipt.rootSum !== state.closedLedger.finalCredit.amount
  ) throw new Error('distribution verification cycle, ledger, head, or credit binding is invalid');
  state.distributionVerification = receipt;
}

export function deriveVaultPayoutAuthorization(state, receipt, { expiresAt, nonce }) {
  if (state.stage !== 'closed' || !state.closedLedger || !receipt) throw new Error('closed cycle and distribution verification are required for vault payout authorization');
  const returnActionDigest = state.actionByKind.get('return');
  if (!returnActionDigest) throw new Error('vault payout authorization requires the exact return action');
  const authorization = {
    requirementsRevision: state.closedLedger.requirementsRevision,
    chainId: state.preflight.releaseEvidence.chainId,
    cycleId: receipt.onchainCycleId,
    hook: state.preflight.hook,
    vault: state.closedLedger.cycleVaultAccount,
    usdg: state.preflight.usdg,
    operationsTrigger: state.closedLedger.operationsTrigger,
    bindingManifestDigest: contractBytes32FromDigest(state.preflight.bindingManifestDigest, 'vault payout binding manifest digest'),
    payoutId: receipt.payoutId,
    manifestDigest: receipt.manifestDigest,
    rootHash: receipt.rootHash,
    rootSum: receipt.rootSum,
    returnActionDigest: contractBytes32FromDigest(returnActionDigest, 'vault payout return action digest'),
    returnReceiptDigest: contractBytes32FromDigest(state.closedLedger.finalCredit.receiptDigest, 'vault payout return receipt digest'),
    expiresAt,
    nonce,
  };
  const verified = validateVaultPayoutAuthorization(authorization);
  return {
    authorization: verified,
    authorizationDigest: vaultPayoutAuthorizationDigest(verified),
  };
}

function prepareFunding(state, event, cycleTransaction) {
  const payload = exactPayload(
    event.payload,
    [
      'proceedsKey',
      'verificationReceiptDigest',
      'onchainCycleId',
      'payoutId',
      'manifestDigest',
      'rootHash',
      'rootSum',
      'vaultPayoutAuthorization',
      'vaultPayoutAuthorizationDigest',
      'replayKey',
      'intent',
    ],
    event.kind,
  );
  for (const field of ['proceedsKey', 'verificationReceiptDigest', 'replayKey', 'intent']) {
    assertDigest(payload[field], `payout funding ${field}`);
  }
  if (!bytes32Pattern.test(payload.vaultPayoutAuthorizationDigest)) throw new Error('payout funding vaultPayoutAuthorizationDigest is invalid');
  for (const field of ['onchainCycleId', 'payoutId', 'manifestDigest', 'rootHash']) {
    if (!bytes32Pattern.test(payload[field])) throw new Error(`payout funding ${field} is invalid`);
  }
  if (!positiveDecimalPattern.test(payload.rootSum)) throw new Error('payout funding rootSum is invalid');
  const receipt = state.distributionVerification;
  if (
    state.stage !== 'closed'
    || !state.proceeds.has(payload.proceedsKey)
    || !receipt
    || receipt.proceedsKey !== payload.proceedsKey
    || receipt.receiptDigest !== payload.verificationReceiptDigest
  ) throw new Error('recorded distribution verification is required before payout funding preparation');
  for (const field of ['onchainCycleId', 'payoutId', 'manifestDigest', 'rootHash', 'rootSum']) {
    if (payload[field] !== receipt[field]) throw new Error(`payout funding ${field} receipt binding mismatch`);
  }
  const suppliedAuthorization = validateVaultPayoutAuthorization(payload.vaultPayoutAuthorization);
  if (BigInt(suppliedAuthorization.expiresAt) <= BigInt(Date.parse(FIXTURE_AUTHORIZATION_VALIDATED_AT) / 1000)) throw new Error('vault payout authorization is expired');
  const expectedAuthorization = deriveVaultPayoutAuthorization(state, receipt, {
    expiresAt: suppliedAuthorization.expiresAt,
    nonce: suppliedAuthorization.nonce,
  });
  if (
    !sameCanonical(payload.vaultPayoutAuthorization, expectedAuthorization.authorization)
    || payload.vaultPayoutAuthorizationDigest !== expectedAuthorization.authorizationDigest
  ) throw new Error('payout funding vault authorization binding mismatch');
  const authorizationRecord = {
    key: digest({ domain: 'hookemon.fixture-vault-payout-authorization-key.v1', authorizationDigest: payload.vaultPayoutAuthorizationDigest }),
    nonceKey: digest({ domain: 'hookemon.fixture-vault-payout-authorization-nonce.v1', nonce: suppliedAuthorization.nonce }),
    cycleId: state.cycleId,
    actionKind: 'payout',
    authorizationKind: 'vault-payout',
    actionDigest: state.actionByKind.get('return'),
    subjectDigest: payload.verificationReceiptDigest,
    commitment: digest({ domain: 'hookemon.fixture-vault-payout-authorization-consumption.v1', authorization: suppliedAuthorization, authorizationDigest: payload.vaultPayoutAuthorizationDigest }),
    validatedAt: FIXTURE_AUTHORIZATION_VALIDATED_AT,
  };
  if (cycleTransaction.consumeAuthorization(authorizationRecord) !== authorizationRecord.key) throw new Error('vault payout authorization store consumption mismatch');
  const replayKey = digest({
    domain: 'hookemon.cycle-runner.payout-funding-once.v1',
    runnerCycleId: state.cycleId,
    proceedsKey: payload.proceedsKey,
    verificationReceiptDigest: payload.verificationReceiptDigest,
  });
  if (payload.replayKey !== replayKey) throw new Error('payout funding replay key mismatch');
  const expectedIntent = digest({
    domain: 'hookemon.cycle-runner.payout-funding.v4',
    replayKey,
    onchainCycleId: payload.onchainCycleId,
    payoutId: payload.payoutId,
    manifestDigest: payload.manifestDigest,
    rootHash: payload.rootHash,
    rootSum: payload.rootSum,
    vaultPayoutAuthorizationDigest: payload.vaultPayoutAuthorizationDigest,
    journalHead: event.previousDigest,
  });
  if (payload.intent !== expectedIntent) throw new Error('payout funding intent mismatch');
  if (state.payoutFundingPreparation) throw new Error('payout funding is already prepared');
  state.payoutFundingPreparation = structuredClone(payload);
}

const defaultAuthorizationProvider = createFixtureAuthorizationProvider();

// The fixture evidence profile (WP-31): every field here is a byte-identical passthrough to the
// hardcoded fixture functions this reducer called directly before the evidence-profile seam existed —
// this is reduceCycleEvent's default, so every existing (fixture) test's behavior is unchanged. Defined
// here, not in evidence-profile.mjs, specifically so reduceCycleEvent's default needs no import from
// evidence-profile.mjs (which itself imports from this module to build the production profile) — that
// would be a circular import. evidence-profile.mjs re-exports this exact object as FIXTURE_PROFILE.
export const FIXTURE_EVIDENCE_PROFILE = Object.freeze({
  name: 'fixture',
  action: Object.freeze({
    assert: assertFixtureAction,
    digests: fixtureActionDigests,
  }),
  preflight: Object.freeze({
    verify: verifyFixtureCyclePreflight,
  }),
  authorization: Object.freeze({
    provider: defaultAuthorizationProvider,
    resolveActionDigest(state, approval) { return approval.actionDigest; },
    matchApproval(approval, prepared) {
      const expected = {
        cycleId: prepared.action.cycleId,
        actionKind: prepared.action.actionKind,
        provider: prepared.action.provider,
        preflightDigest: prepared.action.preflightDigest,
        operationsTrigger: prepared.action.operationsTrigger,
        cycleVaultAccount: prepared.action.cycleVaultAccount,
        policyAccount: prepared.action.policyAccount,
        returnAccount: prepared.action.returnAccount,
        principalAmount: prepared.action.principalAmount,
        minimumReceive: prepared.action.minimumReceive,
        nativeGasAmount: prepared.action.nativeGasAmount,
        actionDigest: prepared.digests.actionDigest,
        bindingDigest: prepared.digests.bindingDigest,
        sourceAccount: prepared.action.sourceAccount,
        inputAsset: prepared.action.inputAsset,
        outputAsset: prepared.action.outputAsset,
        destination: prepared.action.destination,
        mint: prepared.action.mint,
        nftMint: prepared.action.nftMint,
        nftCustodyAccount: prepared.action.nftCustodyAccount,
        amount: prepared.action.amount,
        instructionsDigest: prepared.digests.instructionsDigest,
        signersDigest: prepared.digests.signersDigest,
      };
      for (const [field, value] of Object.entries(expected)) if (approval[field] !== value) throw new Error(`fixture owner approval ${field} mismatch`);
    },
    approvalKey(approval) { return approval.fixtureApprovalDigest; },
    attempt(approval) { return approval.attempt; },
    storeRecord: fixtureAuthorizationStoreRecord,
  }),
  message: Object.freeze({
    forAction: fixtureMessageForAction,
    decode: decodeFixtureOnlyMessage,
    digestDomain: 'hookemon.fixture-message.v1',
  }),
  signedTransaction: Object.freeze({
    verify: verifyFixtureSignedTransaction,
    digestDomain: 'hookemon.fixture-signed-transaction.v1',
  }),
  blockhashValidity: Object.freeze({
    verify: verifyFixtureBlockhashValidity,
  }),
  providerReceipt: Object.freeze({
    verify: assertVerifiedProviderReceipt,
    digestDomain: 'hookemon.fixture-provider-receipt.v1',
    identityKey: receiptIdentityKey,
    registryRecord: receiptRegistryRecord,
    relationship: assertReceiptRelationship,
  }),
  executionAccounting: Object.freeze({
    verify: verifyFixtureExecutionAccounting,
  }),
  collector: Object.freeze({
    assertRequest: assertFixtureCollectorRequest,
    requestDigest: fixtureCollectorRequestDigest,
    verifyMutationAuthorization: verifyFixtureCollectorMutationAuthorization,
    mutationAuthorizationDigest: fixtureCollectorMutationAuthorizationDigest,
    mutationAuthorizationStoreRecord(authorization, action) {
      const nonceKey = fixtureAuthorizationNonceKey(authorization.fixtureOwner, authorization.nonce);
      return {
        key: fixtureCollectorMutationAuthorizationDigest(authorization),
        nonceKey,
        cycleId: authorization.cycleId,
        actionKind: action,
        authorizationKind: 'mutation',
        actionDigest: authorization.requestDigest,
        subjectDigest: authorization.requestDigest,
        commitment: digest({ domain: 'hookemon.fixture-collector-mutation-authorization-consumption.v1', authorization }),
        validatedAt: FIXTURE_AUTHORIZATION_VALIDATED_AT,
      };
    },
    assertVerifiedStatus: assertVerifiedFixtureCollectorStatus,
    assertVerifiedOpenExecution: assertVerifiedFixtureCollectorOpenExecution,
    assertVerifiedOpenCustody: assertVerifiedFixtureCollectorOpenCustody,
    assertVerifiedRpcFinality: assertVerifiedFixtureCollectorRpcFinality,
    acceptsOpenCustodyNftMint(nftMint) { return nftMint === 'fixture-nft-mint'; },
    acceptsGenerateResponse(response, cycleId) { return response.schema === 'hookemon.fixture-collector-generate.v1' && response.responseId === `fixture-collector-generate-${cycleId}`; },
  }),
  postOpenBuyback: Object.freeze({
    verify: verifyFixturePostOpenBuybackAuthorization,
    resolveActionDigest(state, approval) { return approval.actionDigest; },
    prizeWallet(approval) { return approval.collectorPrizeWallet; },
    refundAmount(approval) { return approval.refundAmount; },
    matchPolicy(approval, prepared, state) {
      const action = prepared.action;
      if (approval.cycleId !== state.cycleId || approval.collectorPrizeWallet !== state.collector.opened.prizeWallet || approval.collectorPrizeWallet !== action.sourceAccount || approval.currentOwner !== action.binding.executionWallet || approval.mint !== action.mint || approval.tokenAccount !== action.tokenAccount || approval.destination !== action.destination || approval.destination !== action.binding.refundTokenAccount || BigInt(approval.refundAmount) < BigInt(action.minimumReceive) || approval.minimumReceive !== action.minimumReceive) throw new Error('post-open buyback policy binding is invalid');
    },
    storeRecord(approval) {
      return {
        key: approval.fixtureApprovalDigest,
        nonceKey: fixtureAuthorizationNonceKey(approval.fixtureOwner, approval.nonce),
        cycleId: approval.cycleId,
        actionKind: 'buyback',
        authorizationKind: 'buyback-policy',
        actionDigest: approval.actionDigest,
        subjectDigest: approval.actionDigest,
        commitment: digest({ domain: 'hookemon.fixture-post-open-buyback-consumption.v1', approval }),
        validatedAt: FIXTURE_AUTHORIZATION_VALIDATED_AT,
      };
    },
  }),
});

export function reduceCycleEvent(state, event, { cycleTransaction, evidenceProfile = FIXTURE_EVIDENCE_PROFILE } = {}) {
  if (!cycleTransaction || typeof cycleTransaction.consume !== 'function' || typeof cycleTransaction.consumeAuthorization !== 'function') throw new Error('cycle store transaction is required');
  if (!evidenceProfile?.authorization?.provider || typeof evidenceProfile.authorization.provider.verifyStepAuthorization !== 'function') throw new Error('evidence profile with an authorization provider is required');
  if (event.cycleId !== state.cycleId || event.previousDigest !== state.head) throw new Error('journal event does not extend current reducer head');
  switch (event.kind) {
    case 'cycle-control-bound': bindCycleControl(state, event); break;
    case 'cycle-preflight-recorded': verifyPreflight(state, event, evidenceProfile); break;
    case 'intent-prepared': verifyIntent(state, event, evidenceProfile); break;
    case 'owner-approval-recorded': verifyApproval(state, event, evidenceProfile); break;
    case 'owner-approval-consumed': consumeApproval(state, event, cycleTransaction, evidenceProfile); break;
    case 'fixture-message-decoded': verifyDecode(state, event, evidenceProfile); break;
    case 'signed-bytes-recorded': verifySigned(state, event, evidenceProfile); break;
    case 'blockhash-validity-verified': verifyBlockhashValidity(state, event, evidenceProfile); break;
    case 'broadcast-recorded': verifyBroadcast(state, event); break;
    case 'provider-receipt-verified': verifyReceipt(state, event, evidenceProfile); break;
    case 'execution-accounting-verified': verifyExecutionAccounting(state, event, evidenceProfile); break;
    case 'receipt-consumed': consumeReceipt(state, event, cycleTransaction, evidenceProfile); break;
    case 'cycle-transitioned': transition(state, event, evidenceProfile); break;
    case 'proceeds-consumed': consumeProceeds(state, event); break;
    case 'distribution-verification-recorded': recordDistributionVerification(state, event); break;
    case 'payout-funding-prepared': prepareFunding(state, event, cycleTransaction); break;
    case 'collector-generate-consumed': collectorGenerate(state, event, evidenceProfile); break;
    case 'collector-generate-intent-prepared': collectorGenerateIntent(state, event, evidenceProfile); break;
    case 'collector-open-intent-prepared': collectorOpenIntent(state, event, evidenceProfile); break;
    case 'collector-mutation-authorization-consumed': collectorMutationAuthorization(state, event, cycleTransaction, evidenceProfile); break;
    case 'collector-status-consumed': throw new Error('unauthenticated legacy Collector status journal events are rejected');
    case 'collector-status-verified': verifiedCollectorStatus(state, event, evidenceProfile); break;
    case 'collector-opened': collectorOpen(state, event, evidenceProfile); break;
    case 'collector-open-custody-verified': verifiedCollectorOpenCustody(state, event, evidenceProfile); break;
    case 'post-open-buyback-approval-consumed': postOpenBuybackApproval(state, event, cycleTransaction, evidenceProfile); break;
    case 'external-mutation-attempted': externalMutationAttempted(state, event, evidenceProfile); break;
    case 'external-mutation-reconciled': externalMutationReconciled(state, event); break;
    case 'external-mutation-voided': externalMutationVoided(state, event); break;
    case 'external-mutation-superseded': externalMutationSuperseded(state, event, cycleTransaction); break;
    default: throw new Error(`unknown journal event ${event.kind}`);
  }
  state.head = event.digest;
  return state;
}

export function signedBytesDigest({ messageDigest, signedBytes }, domain = 'hookemon.fixture-signed-transaction.v1') {
  if (!digestPattern.test(messageDigest)) throw new Error('message digest is invalid');
  return digest({ domain, messageDigest, signedBytes });
}
