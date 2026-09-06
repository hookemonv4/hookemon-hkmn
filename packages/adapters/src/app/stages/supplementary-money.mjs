import {
  advanceDirectPayout,
  createDirectPayoutState,
  evaluateDirectPayoutNativeGasAdmission,
  isDirectPayoutComplete,
} from './payout.mjs';
import {
  assertReturnBoundaryEvidence,
  assertSettlement,
  createSupplementaryPayoutStore,
  prepareSupplementaryPayoutRequest,
  SUPPLEMENTARY_FINALIZED_RETURN_SCHEMA,
  SUPPLEMENTARY_RETURN_BOUNDARY_SCHEMA,
} from './supplementary-payout.mjs';

const CONFIRMED_SALE_SCHEMA = 'hookemon.supplementary-confirmed-sale.v1';
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOLANA_SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,88}$/;
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/;
const ATOMIC = /^(?:0|[1-9][0-9]*)$/;

export class SupplementaryMoneyError extends Error {}

function fail(message) {
  throw new SupplementaryMoneyError(message);
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

/**
 * CS's confirmed held-card resale evidence: the Solana-side sale proceeds attributable to exactly
 * one held position, already finalized on Solana. This is the sole permitted source for the
 * amount a supplementary return leg may bridge -- never a wallet-wide Solana balance, and never
 * the main cycle's custody ledger.
 */
export function assertConfirmedSale(value, settlement) {
  exactObject(value, [
    'schema',
    'positionId',
    'cycleId',
    'manifestId',
    'sourceWallet',
    'mint',
    'decimals',
    'amountAtomic',
    'transactionSignature',
    'memo',
    'sourceFinality',
  ], 'supplementary confirmed sale');
  if (value.schema !== CONFIRMED_SALE_SCHEMA
    || value.positionId !== settlement.positionId
    || value.cycleId !== settlement.cycleId
    || value.manifestId !== settlement.manifestId) {
    fail('supplementary confirmed sale does not bind its settlement');
  }
  if (typeof value.sourceWallet !== 'string' || !SOLANA_ADDRESS.test(value.sourceWallet)) {
    fail('supplementary confirmed sale sourceWallet is invalid');
  }
  if (typeof value.mint !== 'string' || !SOLANA_ADDRESS.test(value.mint)) {
    fail('supplementary confirmed sale mint is invalid');
  }
  if (!Number.isInteger(value.decimals) || value.decimals < 0 || value.decimals > 255) {
    fail('supplementary confirmed sale decimals is invalid');
  }
  if (typeof value.amountAtomic !== 'string' || !ATOMIC.test(value.amountAtomic) || value.amountAtomic === '0') {
    fail('supplementary confirmed sale amountAtomic is invalid');
  }
  if (typeof value.transactionSignature !== 'string' || !SOLANA_SIGNATURE.test(value.transactionSignature)) {
    fail('supplementary confirmed sale transactionSignature is invalid');
  }
  if (typeof value.memo !== 'string' || value.memo.length === 0) {
    fail('supplementary confirmed sale memo is invalid');
  }
  if (!value.sourceFinality || typeof value.sourceFinality !== 'object' || Array.isArray(value.sourceFinality)) {
    fail('supplementary confirmed sale sourceFinality is invalid');
  }
  return Object.freeze(structuredClone(value));
}

/**
 * Builds the immutable, position-attributed request a live return-bridge executor must consume:
 * exactly CS's confirmed Solana proceeds for this position, bound to the durable settlement, with
 * the configured Operations EVM identity the bridged USDG must land on. Pure: does not call any
 * adapter, sign anything, or touch the repository. The actual Relay bridge execution (quote,
 * source-leg signing/broadcast, destination-leg proof reading) is an explicit dependency on the
 * real signing/relay/reconciliation machinery -- see docs/modules/supplementary-money.md for the
 * exact open item.
 */
export function prepareSupplementaryReturnRequest({ settlement, confirmedSale, config }) {
  const normalizedSettlement = assertSettlement(settlement);
  if (normalizedSettlement.state !== 'BUYBACK_SENT_UNKNOWN') {
    fail('supplementary return requires a buyback-sent-unknown settlement');
  }
  const normalizedSale = assertConfirmedSale(confirmedSale, normalizedSettlement);
  const operations = config?.accounts?.evm;
  const usdgAddress = config?.contracts?.usdg;
  if (typeof operations !== 'string' || !EVM_ADDRESS.test(operations.toLowerCase())) {
    fail('supplementary return requires a configured Operations EVM account');
  }
  if (typeof usdgAddress !== 'string' || !EVM_ADDRESS.test(usdgAddress.toLowerCase())) {
    fail('supplementary return requires a configured USDG address');
  }
  return Object.freeze({
    schema: 'hookemon.supplementary-return-request.v1',
    positionId: normalizedSettlement.positionId,
    cycleId: normalizedSettlement.cycleId,
    manifestId: normalizedSettlement.manifestId,
    confirmedSale: normalizedSale,
    operations: operations.toLowerCase(),
    usdgAddress: usdgAddress.toLowerCase(),
  });
}

/**
 * Durably records a proven return boundary and advances the settlement to `RETURN_BROADCAST`.
 * `finalizedReturnEvidence` must already carry a real, independently verifiable EVM destination
 * proof for the bridged USDG credit -- this function only binds and persists it, it does not
 * originate or verify the cross-chain transfer itself. Idempotent: replaying the identical
 * evidence for a settlement already at `RETURN_BROADCAST` is a no-op (enforced by
 * `cycleRepository.advanceSupplementarySettlement`).
 */
export async function recordSupplementaryReturnBroadcast({ cycleRepository, settlement, finalizedReturnEvidence }) {
  const normalizedSettlement = assertSettlement(settlement);
  if (typeof cycleRepository?.advanceSupplementarySettlement !== 'function') {
    fail('supplementary return requires cycleRepository.advanceSupplementarySettlement');
  }
  if (!finalizedReturnEvidence || typeof finalizedReturnEvidence !== 'object' || Array.isArray(finalizedReturnEvidence)) {
    fail('supplementary return requires finalized return evidence');
  }
  const evidence = {
    schema: SUPPLEMENTARY_RETURN_BOUNDARY_SCHEMA,
    positionId: normalizedSettlement.positionId,
    cycleId: normalizedSettlement.cycleId,
    manifestId: normalizedSettlement.manifestId,
    finalizedReturnEvidence: {
      schema: SUPPLEMENTARY_FINALIZED_RETURN_SCHEMA,
      positionId: normalizedSettlement.positionId,
      cycleId: normalizedSettlement.cycleId,
      manifestId: normalizedSettlement.manifestId,
      ...finalizedReturnEvidence,
    },
  };
  assertReturnBoundaryEvidence(evidence, normalizedSettlement, 'supplementary return broadcast evidence');
  return cycleRepository.advanceSupplementarySettlement(normalizedSettlement.positionId, {
    expectedState: 'BUYBACK_SENT_UNKNOWN',
    nextState: 'RETURN_BROADCAST',
    evidence,
  });
}

function directPayoutStoreAdapter(supplementaryStore, request) {
  return Object.freeze({
    load: () => supplementaryStore.load(request),
    persist: state => supplementaryStore.persist(request, state),
  });
}

/**
 * Drives one held position's supplementary payout to completion through the real direct-payout
 * engine (`advanceDirectPayout`/`isDirectPayoutComplete`), reusing the exact same recipient
 * lifecycle, signed-byte durability, and restart-without-re-signing guarantees as the main cycle's
 * payout -- through `createSupplementaryPayoutStore`'s separate paged namespace, never the main
 * payout's store. Always fully serial (`inFlightWindow` 1): a supplementary settlement's recipient
 * count is small and bounded by one held position, so the main cycle's bounded in-flight window is
 * not needed here.
 */
export async function mutateSupplementaryPayout({
  liveMode,
  adapters,
  config,
  signerClient,
  cycleRepository,
  context,
}) {
  if (liveMode !== true) fail('supplementary payout mutation requires liveMode');
  if (typeof cycleRepository?.readSupplementarySettlement !== 'function'
    || typeof cycleRepository?.advanceSupplementarySettlement !== 'function') {
    fail('supplementary payout mutation requires cycleRepository supplementary settlement methods');
  }
  const rawSettlement = await cycleRepository.readSupplementarySettlement(context.positionId);
  if (!rawSettlement) fail('supplementary payout mutation requires a known settlement');
  const settlement = assertSettlement(rawSettlement);
  if (!['RETURN_BROADCAST', 'PAYOUT_BROADCAST'].includes(settlement.state)) {
    fail('supplementary payout mutation requires a return-broadcast settlement');
  }
  const request = prepareSupplementaryPayoutRequest({
    settlement: rawSettlement,
    eligibilityManifest: context.eligibilityManifest,
    returnBoundary: context.returnBoundary,
  });
  const supplementaryStore = createSupplementaryPayoutStore({ cycleRepository, settlement: rawSettlement });
  const payoutStore = directPayoutStoreAdapter(supplementaryStore, request);
  let state = await payoutStore.load();
  if (state === null || state === undefined) {
    const plan = request.plan.payoutPlan;
    const operations = plan.returnEvidence.operations;
    const usdgAddress = plan.returnEvidence.usdgAddress;
    const firstNonce = plan.payableRecipientCount === 0
      ? '0'
      : await (async () => {
        const client = adapters?.robinhood?.client;
        if (!client || typeof client.getTransactionCount !== 'function') {
          fail('supplementary payout requires getTransactionCount before initializing recipient state');
        }
        return client.getTransactionCount({ address: operations, blockTag: 'pending' });
      })();
    state = createDirectPayoutState({
      plan,
      operations,
      usdgAddress,
      firstNonce: String(firstNonce),
    });
    await payoutStore.persist(state);
  }
  if (state.recipients.length > 0) {
    const client = adapters?.robinhood?.client;
    if (client && typeof client.getBalance === 'function') {
      const required = BigInt(state.plan.feasibility.requiredNativeAmount.amountAtomic);
      const observedRaw = await client.getBalance({ address: request.operations });
      const observed = typeof observedRaw === 'bigint' ? observedRaw : BigInt(observedRaw);
      const admission = evaluateDirectPayoutNativeGasAdmission({
        requiredNativeAmount: required.toString(),
        observedNativeBalance: observed.toString(),
      });
      if (admission.outcome !== 'OK') {
        fail(`supplementary payout native gas balance is below the required feasibility envelope by ${admission.deficit} wei`);
      }
    }
  }
  while (!isDirectPayoutComplete(state)) {
    const target = state.recipients.find(entry => entry.state !== 'FINALIZED' && entry.state !== 'REFUSED');
    if (!target) fail('supplementary payout has no unresolved recipient before terminal conservation');
    const before = JSON.stringify(state);
    state = await advanceDirectPayout({
      payoutStore,
      recipient: target.recipient,
      adapters,
      signerClient,
      config,
      cycleRepository,
    });
    // Waiting on an external confirmation (a not-yet-mined receipt, a not-yet-observed nonce) is
    // not an error: it just means this pass is done until the next scheduled retry, exactly like
    // the main cycle's payout dispatch loop.
    if (JSON.stringify(state) === before) return state;
  }
  if (settlement.state === 'RETURN_BROADCAST') {
    await cycleRepository.advanceSupplementarySettlement(settlement.positionId, {
      expectedState: 'RETURN_BROADCAST',
      nextState: 'PAYOUT_BROADCAST',
      evidence: { schema: 'hookemon.supplementary-payout-broadcast-evidence.v1', planDigest: state.planDigest },
    });
  }
  await cycleRepository.advanceSupplementarySettlement(settlement.positionId, {
    expectedState: 'PAYOUT_BROADCAST',
    nextState: 'COMPLETE',
    evidence: { schema: 'hookemon.supplementary-payout-complete-evidence.v1', planDigest: state.planDigest },
  });
  return state;
}
