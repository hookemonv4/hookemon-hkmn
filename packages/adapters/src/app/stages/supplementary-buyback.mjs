/**
 * Production held-card resale handler (LAUNCH-CS, item 5 of the C-brief). Reconciles a supplementary
 * settlement's PREPARED state: an owner has chosen `sell` for a held card and the durable
 * settlement machine (`cycle-repository.mjs#advanceSupplementarySettlement`) is waiting to move it
 * to `BUYBACK_SENT_UNKNOWN`. This module owns exactly that one transition; the return-bridge
 * (`BUYBACK_SENT_UNKNOWN -> RETURN_BROADCAST`, `supplementary-money.mjs`, D-owned) and everything
 * after it is D's territory (see `docs/modules/supplementary-buyback.md` for the exact handoff).
 *
 * Registered as `productionSupplementaryStageHandlers.PREPARED` (C-supplementary-handler-contract.md,
 * commit e3ae4db9) -- the capability-bound production seam, never the Node-test-only
 * `supplementaryStageHandlers` observation-only seam. `reconcile()` consumes the exact `adapters`/
 * `signerClient` the driver passes through from `createStageDriver`'s `supplementaryAdapters`/
 * `supplementarySignerClient`, unexamined -- this module does not close over or substitute its own
 * capabilities.
 *
 * Durable safety model: a pre-send intent (a `PREPARED` chain-transaction-attempt, keyed by a
 * position-scoped `requestDigest` under the existing `'buyback'` stage -- see
 * `chainAttemptKey(stage, requestDigest)` in cycle-repository.mjs, which keys by the *pair*, so this
 * never collides with the original cycle's own buyback chain attempts) is written *before* the
 * provider mutation is ever attempted. Signed bytes and their transaction-policy recovery context
 * are durably recorded *before* broadcast. A restart that finds an already-`PREPARED` (not freshly
 * created) attempt never calls the provider again -- it is provider-ambiguous and resolved only by
 * a later authoritative check, never resent. A restart that finds a `SIGNED` attempt reauthorizes
 * and rebroadcasts the exact recorded bytes, never re-signs. This mirrors `return.mjs`'s own
 * reviewed `mutateReturn` durability pattern exactly (same primitives, same sequence), applied to
 * Collector's buyback endpoint instead of a Relay leg.
 */
import {
  getFinalizedTokenBalanceChanges,
  getTransactionMplCoreTransfers,
  readAssociatedTokenAccount,
  readBlockHeight,
  readBlockhashValidity,
  readFinalizedSignatureStatus,
  readMplCoreAssetOwner,
  signedSolanaTransactionSignature,
} from '../../solana-rpc.mjs';
import { assertTypedAmount, createPreparedChainTransactionAttempt } from '../../../../runner/src/cycle/money-schemas.mjs';
import { digest } from '../../../../runner/src/cycle/journal.mjs';
import {
  decodeProviderTransaction,
  evaluate as evaluateTransactionPolicy,
} from '../../signing/transaction-policy.mjs';
import { collectorPolicyForStage } from '../../signing/collector-policy-loader.mjs';
import {
  OPERATOR_SOLANA_ROLE,
  createPolicySigner,
  readTransactionPolicyApprovalContext,
  recoverTransactionPolicyBroadcast,
} from '../../signing/signer-client.mjs';
import {
  isLiveCollectorOnlyRehearsal,
  requireCollectorOnlyMutationAuthority,
} from '../../../rehearsal/collector-only-authorization.mjs';
import { COLLECTOR_CRYPT_SETTLEMENT_ASSET } from '../../collector-crypt.mjs';
import { assertSolanaSignerFeeEnvelope, assertSolanaSignerMoneyConfiguration } from './solana-money-controls.mjs';
import { buildCollectorBuybackRequest } from './buyback.mjs';
import { assertConfirmedSale } from './supplementary-money.mjs';

export const SUPPLEMENTARY_BUYBACK_STAGE = 'supplementary-buyback';
const CONFIRMED_SALE_SCHEMA = 'hookemon.supplementary-confirmed-sale.v1';
const SOURCE_FINALITY_SCHEMA = 'hookemon.supplementary-buyback-source-finality.v1';
const ATTEMPT_REQUEST_SCHEMA = 'hookemon.supplementary-buyback-attempt-request.v1';
const HELD_POSITION_ID = /^held:[0-9a-f]{64}$/;
const FENCING_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CHAIN_ATTEMPT_STAGE = 'buyback';

/**
 * Durable primitives this handler requires beyond the read-only set
 * `C-supplementary-handler-contract.md` already documents (`readChainTransactionAttempt`,
 * `readChainAttemptRecoveryContext`, `advanceSupplementarySettlement`). Not yet exposed on the
 * production supplementary-settlement facade as of that contract's commit (e3ae4db9) -- requested
 * in `C-inbox.md`. This handler fails closed (throws, does not degrade to a weaker guarantee) when
 * any of them is missing, so it never silently ships without durable pre-send intent or
 * signed-bytes-before-broadcast recovery.
 */
const REQUIRED_DURABLE_ATTEMPT_METHODS = Object.freeze([
  'readChainTransactionAttempt',
  'prepareChainTransactionAttempt',
  'recordBroadcast',
  'readChainAttemptRecoveryContext',
]);

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sameAsset(left, right) {
  return left?.chainId === right?.chainId && left?.assetId === right?.assetId && left?.decimals === right?.decimals;
}

function sameAmount(left, right) {
  return sameAsset(left, right) && left?.amountAtomic === right?.amountAtomic;
}

function typedAmount(asset, amountAtomic, label) {
  return assertTypedAmount({ ...asset, amountAtomic }, label);
}

function typedBuybackAmount(value, label) {
  const amount = assertTypedAmount(value, label);
  if (!sameAsset(amount, COLLECTOR_CRYPT_SETTLEMENT_ASSET)) {
    throw new Error(`${label} must use the documented Solana buyback asset`);
  }
  return amount;
}

function configuredSettlementAsset(config) {
  const asset = config?.collectorCrypt?.settlementAsset;
  if (!plainObject(asset)
    || typeof asset.chainId !== 'string' || asset.chainId.length === 0
    || typeof asset.assetId !== 'string' || asset.assetId.length === 0
    || !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 255
    || asset.chainId !== config?.solana?.chainId) {
    throw new Error('supplementary buyback requires a settlementAsset matching config.solana.chainId');
  }
  if (!sameAsset(asset, COLLECTOR_CRYPT_SETTLEMENT_ASSET)) {
    throw new Error('supplementary buyback settlementAsset must match the documented Solana buyback asset');
  }
  return Object.freeze({ chainId: asset.chainId, assetId: asset.assetId, decimals: asset.decimals });
}

function configuredBuybackPolicy(config) {
  const value = config?.collectorCrypt?.buyback;
  const bundlePolicy = collectorPolicyForStage(config, 'buyback');
  const policy = bundlePolicy ?? value?.policy;
  if (!plainObject(value) || !plainObject(policy)
    || typeof value.collectorProgramId !== 'string' || value.collectorProgramId.length === 0
    || typeof value.collectorRecipient !== 'string' || value.collectorRecipient.length === 0) {
    throw new Error('supplementary buyback requires a pinned policy, Collector program id, and Collector recipient');
  }
  return { ...value, policy };
}

/** Reads the already-validated dedicated proceeds account. `buildCollectorBuybackRequest` (below) is
 *  the source of truth for whether this config is actually consistent; this is a plain read of the
 *  same value, not a second validation. */
function configuredProceedsAccount(config) {
  if (!isLiveCollectorOnlyRehearsal(config)) return null;
  const account = config.rehearsal?.proceedsAccount;
  return typeof account === 'string' && account.length > 0 ? account : null;
}

function trustedSolanaDecodeOptions({ adapters, config }) {
  if (typeof config?.solana?.blockhashContextResolver !== 'function') {
    throw new Error('supplementary buyback requires a trusted Solana blockhashContextResolver');
  }
  return Object.freeze({
    family: 'solana',
    chainId: config.solana.chainId,
    lookupTableResolver: config.solana.lookupTableResolver,
    blockhashContextResolver: config.solana.blockhashContextResolver,
    currentBlockHeightResolver: async () => readBlockHeight(adapters.solana.client),
  });
}

function decodedBindsResale({ decoded, owner, mint, buyback, proceedsAccount }) {
  const hasOwner = decoded.feePayer === owner && decoded.requiredSigners.includes(owner);
  const hasProgram = decoded.programIds.includes(buyback.collectorProgramId);
  const hasRecipient = decoded.destination === buyback.collectorRecipient
    || decoded.instructions.some(instruction => instruction.accounts.some(account => account.address === buyback.collectorRecipient));
  const hasMint = decoded.mint === mint
    || decoded.instructions.some(instruction => instruction.mint === mint || instruction.accounts.some(account => account.address === mint));
  const hasProceedsAccount = proceedsAccount === null || decoded.destination === proceedsAccount
    || decoded.instructions.some(instruction => instruction.accounts.some(account => account.address === proceedsAccount));
  if (!hasOwner) throw new Error('supplementary buyback provider transaction does not bind the operator wallet as fee payer and signer');
  if (!hasProgram || !hasRecipient) throw new Error('supplementary buyback provider transaction does not bind the configured Collector program and recipient');
  if (!hasMint) throw new Error('supplementary buyback provider transaction does not bind the held card');
  if (!hasProceedsAccount) throw new Error('supplementary buyback provider transaction does not bind the dedicated proceeds account');
}

function assertHeldPositionForResale(position) {
  if (!plainObject(position) || typeof position.positionId !== 'string' || !HELD_POSITION_ID.test(position.positionId)) {
    throw new Error('supplementary buyback requires a valid held position');
  }
  if (position.ownerDecision?.choice !== 'sell') throw new Error('supplementary buyback requires an owner sell decision');
  if (position.resolution !== null) throw new Error('supplementary buyback position is already resolved');
  if (typeof position.memo !== 'string' || position.memo.length === 0) {
    throw new Error('supplementary buyback requires an immutable memo identity');
  }
  if (typeof position.mint !== 'string' || position.mint.length === 0) {
    throw new Error('supplementary buyback requires an immutable card mint identity');
  }
  return position;
}

function assertFencingToken(value) {
  if (typeof value !== 'string' || !FENCING_TOKEN.test(value)) {
    throw new Error('supplementary buyback requires context.fencingToken for durable signed-bytes recovery binding');
  }
  return value;
}

/** Fails closed rather than degrading to a weaker (memo-lookup-only) guarantee. */
function assertProductionSupplementaryBuybackRepository(cycleRepository) {
  for (const method of REQUIRED_DURABLE_ATTEMPT_METHODS) {
    if (typeof cycleRepository?.[method] !== 'function') {
      throw new Error(`supplementary buyback requires cycleRepository.${method} for durable pre-send intent and signed-bytes recovery (see CS-inbox.md / C-inbox.md)`);
    }
  }
  if (typeof cycleRepository.recordSignedTransactionWithRecoveryContext !== 'function'
    && (typeof cycleRepository.recordSignedTransaction !== 'function'
      || typeof cycleRepository.persistChainAttemptRecoveryContext !== 'function')) {
    throw new Error('supplementary buyback requires cycleRepository.recordSignedTransactionWithRecoveryContext (or recordSignedTransaction + persistChainAttemptRecoveryContext) for durable signed-bytes recovery');
  }
  if (typeof cycleRepository.advanceSupplementarySettlement !== 'function') {
    throw new Error('supplementary buyback requires cycleRepository.advanceSupplementarySettlement');
  }
}

/** One held position is sold at most once; the request digest is stable across every retry. */
function buybackAttemptRequestDigest(position) {
  return digest({ schema: ATTEMPT_REQUEST_SCHEMA, positionId: position.positionId, cycleId: position.cycleId, memo: position.memo });
}

/** The held card's asset kind is not stored on the position record; it is re-derived, read-only,
 *  from the original cycle's own open-stage evidence, keyed by the position's immutable memo. */
async function assetKindForPosition(cycleRepository, position) {
  const open = await cycleRepository.readStage(position.cycleId, 'open').catch(() => null);
  const packs = plainObject(open?.evidence) && Array.isArray(open.evidence.packs) ? open.evidence.packs : [];
  return packs.find(entry => entry.memo === position.memo)?.assetKind ?? 'spl';
}

function sourceFinalityFromStatus(signature, status) {
  return Object.freeze({
    schema: SOURCE_FINALITY_SCHEMA,
    signature,
    slot: typeof status.slot === 'bigint' ? status.slot.toString() : String(status.slot),
    confirmationStatus: status.confirmationStatus,
  });
}

/**
 * Read-only. Independently verifies one already-known Solana signature's finality and exact
 * settlement-asset proceeds delta to the operator wallet -- the shared verification core used both
 * by `reconcileSupplementaryBuybackSale` (signature discovered via Collector's memo-keyed lookup)
 * and by this handler's own post-broadcast confirmation (signature already known from the durable
 * chain attempt). Never invents a result: still-pending stays `PENDING`; a mismatch is
 * `DATA_UNVERIFIED`, never silently adopted.
 */
async function verifiedSaleForSignature({ adapters, config, cycleRepository, position, signature, expectedAmount = null }) {
  let status;
  try {
    status = await readFinalizedSignatureStatus(adapters.solana.client, signature);
  } catch {
    return { status: 'PENDING' };
  }
  if (status === null) return { status: 'PENDING' };
  if (status.err) return { status: 'DATA_UNVERIFIED', reason: 'buyback transaction finalized with an error', signature };

  const asset = configuredSettlementAsset(config);
  const assetKind = await assetKindForPosition(cycleRepository, position);
  const proceedsAccount = configuredProceedsAccount(config);
  let leftOperator;
  let entries;
  try {
    entries = await getFinalizedTokenBalanceChanges(adapters.solana.client, signature);
    if (assetKind === 'mpl-core') {
      const transfers = await getTransactionMplCoreTransfers(adapters.solana.client, signature, { commitment: 'finalized' });
      leftOperator = transfers.includes(position.mint)
        && (await readMplCoreAssetOwner(adapters.solana.client, position.mint, { commitment: 'finalized' })) !== config.accounts.solana;
    } else {
      leftOperator = entries.filter(entry => entry.owner === config.accounts.solana && entry.mint === position.mint
        && BigInt(entry.postAmount) < BigInt(entry.preAmount)).length === 1;
    }
  } catch {
    return { status: 'PENDING' };
  }

  const credits = entries.filter(entry => entry.owner === config.accounts.solana && entry.mint === asset.assetId
    && (proceedsAccount === null || entry.tokenAccount === proceedsAccount)
    && BigInt(entry.postAmount) > BigInt(entry.preAmount));
  const proceeds = credits.length === 1
    ? typedAmount(asset, (BigInt(credits[0].postAmount) - BigInt(credits[0].preAmount)).toString(), 'supplementary buyback proceeds')
    : null;

  if (!leftOperator || proceeds === null || (expectedAmount !== null && !sameAmount(proceeds, expectedAmount))) {
    return { status: 'DATA_UNVERIFIED', reason: 'finalized card and settlement deltas did not match the expected sale', signature };
  }
  return { status: 'CONFIRMED', signature, proceeds, sourceFinality: sourceFinalityFromStatus(signature, status) };
}

/**
 * Read-only. Resolves Collector's own memo-keyed record for a held position's resale, verified
 * against Solana finality exactly like `buyback.mjs`'s own reconciliation. Makes no provider
 * mutation and no durable write; safe to call at any time, including from D's own return-bridge
 * handler once this module hands off durable evidence, or on every restart before ever attempting
 * a new sale. Never invents success: a still-pending provider result stays `PENDING`, and a
 * confirmed-but-conflicting result is `DATA_UNVERIFIED`, never silently resolved.
 */
export async function reconcileSupplementaryBuybackSale({ adapters, config, cycleRepository, position }) {
  assertHeldPositionForResale(position);
  if (typeof adapters?.collectorCrypt?.getBuybackCheck !== 'function' || !adapters?.solana?.client) {
    return { status: 'PENDING' };
  }
  let check;
  try {
    check = await adapters.collectorCrypt.getBuybackCheck({ memo: position.memo });
  } catch {
    return { status: 'PENDING' };
  }
  if (!plainObject(check) || typeof check.exists !== 'boolean' || !check.exists) return { status: 'PENDING' };
  if (typeof check.status !== 'string' || check.status === '') return { status: 'PENDING' };
  if (check.status !== 'complete') return { status: 'PENDING' };

  const asset = configuredSettlementAsset(config);
  let checkedAmount;
  try {
    checkedAmount = typedAmount(asset, check.buybackAmount, 'supplementary buyback completed amount');
  } catch {
    return { status: 'DATA_UNVERIFIED', reason: 'completed buyback amount is invalid', check };
  }
  if (check.playerWallet !== config.accounts.solana || check.nft !== position.mint
    || typeof check.transactionSignature !== 'string' || check.transactionSignature.length === 0
    || typeof check.createdAt !== 'string' || check.createdAt.length === 0) {
    return { status: 'DATA_UNVERIFIED', reason: 'completed buyback check does not bind the memo, wallet, and card', check };
  }
  return verifiedSaleForSignature({
    adapters, config, cycleRepository, position, signature: check.transactionSignature, expectedAmount: checkedAmount,
  });
}

async function prepareResale({ adapters, config, position }) {
  const asset = configuredSettlementAsset(config);
  const money = assertSolanaSignerMoneyConfiguration({ config, asset, stage: 'buyback' });
  const proceedsAccount = configuredProceedsAccount(config);
  const account = await readAssociatedTokenAccount(adapters.solana.client, config.accounts.solana, asset.assetId);
  if (!account.exists || account.decimals !== asset.decimals) {
    throw new Error('supplementary buyback requires a matching operator settlement token account');
  }
  if (proceedsAccount !== null && account.address !== proceedsAccount) {
    throw new Error('supplementary buyback dedicated proceeds account is not the verified operator settlement token account');
  }
  const available = await adapters.collectorCrypt.getBuybackAvailable({ nft: position.mint, wallet: config.accounts.solana });
  if (!available?.available) return { unavailable: true };
  const offer = typedBuybackAmount(available.amount, 'supplementary buyback offer');
  const request = buildCollectorBuybackRequest({ config, mint: position.mint });
  return { unavailable: false, money, proceedsAccount, offer, request };
}

function walletFencingContext({ config, context, stage }) {
  const fencingToken = assertFencingToken(context?.fencingToken);
  return Object.freeze({
    fencingToken,
    fencingTokenDigest: digest({
      schema: 'hookemon.wallet-nonce-reservation.v1',
      chainId: config.solana.chainId,
      stage,
      fencingToken,
    }),
  });
}

/**
 * The ambiguous provider boundary: Collector's `buyback()` call, decode/policy/binding, and sign.
 * Called only when this reconcile() call itself just durably prepared the chain attempt (never on
 * a recovered stale intent -- see the caller). Any failure here leaves the durable attempt at
 * `PREPARED`; it is never retried automatically, only resolved via `reconcileSupplementaryBuybackSale`.
 */
async function signAndRecordBuyback({ adapters, config, signerClient, cycleRepository, context, position, prepared, requestDigest }) {
  const { money, proceedsAccount, offer, request } = prepared;
  requireCollectorOnlyMutationAuthority(config);
  const built = await adapters.collectorCrypt.buyback(request);
  const refundAmount = typedBuybackAmount(built.refundAmount, 'supplementary buyback refund amount');
  if (built.memo !== position.memo || !sameAmount(refundAmount, offer)) {
    throw new Error('supplementary buyback provider response did not bind the held card memo and offer');
  }
  const buyback = configuredBuybackPolicy(config);
  const decodeOptions = trustedSolanaDecodeOptions({ adapters, config });
  const decoded = await decodeProviderTransaction({ ...decodeOptions, transaction: built.serializedTransaction });
  if (!decoded.blockhash || !(await readBlockhashValidity(adapters.solana.client, decoded.blockhash))) {
    throw new Error('supplementary buyback provider transaction blockhash is not valid before signing');
  }
  evaluateTransactionPolicy(buyback.policy, decoded);
  decodedBindsResale({ decoded, owner: config.accounts.solana, mint: position.mint, buyback, proceedsAccount });
  await assertSolanaSignerFeeEnvelope({ client: adapters.solana.client, owner: config.accounts.solana, money, decoded, stage: 'buyback' });

  const signer = createPolicySigner({
    backend: {
      role: signerClient.solana.role ?? OPERATOR_SOLANA_ROLE,
      async sign(signRequest) {
        requireCollectorOnlyMutationAuthority(config);
        const refreshed = await adapters.collectorCrypt.getBuybackAvailable({ nft: position.mint, wallet: config.accounts.solana });
        const refreshedOffer = typedBuybackAmount(refreshed.amount, 'supplementary buyback offer');
        if (!sameAmount(refreshedOffer, offer)) throw new Error('supplementary buyback offer changed before signing');
        return signerClient.solana.sign(signRequest);
      },
    },
    policy: buyback.policy,
    decodeOptions,
    broadcast: async () => { throw new Error('supplementary buyback sign-phase signer must not broadcast'); },
  });
  const signed = await signer.sign(built.serializedTransaction);
  const approval = readTransactionPolicyApprovalContext(signer, signed);
  const rawSignedBytesHash = approval.signedMessageDigest;
  const { fencingToken, fencingTokenDigest } = walletFencingContext({ config, context, stage: CHAIN_ATTEMPT_STAGE });
  const recoveryContext = Object.freeze({
    stage: CHAIN_ATTEMPT_STAGE,
    recipient: null,
    requestDigest,
    policyDigest: approval.policyDigest,
    approvalDigest: approval.approvalDigest,
    fencingToken,
    fencingTokenDigest,
    approvedSemanticsDigest: approval.approvedSemanticsDigest,
    rawSignedBytesHash,
    signedMessageDigest: approval.signedMessageDigest,
  });
  const signingMaterial = {
    rawBytes: signed.signedTxBase64,
    nonce: null,
    blockhash: decoded.blockhash,
    hash: rawSignedBytesHash,
  };
  if (typeof cycleRepository.recordSignedTransactionWithRecoveryContext === 'function') {
    return cycleRepository.recordSignedTransactionWithRecoveryContext(
      position.cycleId, CHAIN_ATTEMPT_STAGE, requestDigest, signingMaterial, recoveryContext, null,
    );
  }
  const record = await cycleRepository.recordSignedTransaction(position.cycleId, CHAIN_ATTEMPT_STAGE, requestDigest, signingMaterial);
  await cycleRepository.persistChainAttemptRecoveryContext(position.cycleId, recoveryContext);
  return record;
}

/**
 * Reauthorizes and broadcasts the exact durably-recorded signed bytes -- never re-signs. Runs
 * whether the attempt was just signed this call or recovered `SIGNED` from a prior crash.
 */
async function broadcastRecordedBuyback({ adapters, config, cycleRepository, position, record, requestDigest }) {
  const recoveryContext = await cycleRepository.readChainAttemptRecoveryContext(position.cycleId, {
    stage: CHAIN_ATTEMPT_STAGE,
    recipient: null,
    requestDigest,
    rawSignedBytesHash: record.attempt.hash,
  });
  if (!recoveryContext) throw new Error('supplementary buyback signed bytes have no durable policy recovery context');
  const buyback = configuredBuybackPolicy(config);
  const decodeOptions = trustedSolanaDecodeOptions({ adapters, config });
  const policySigner = createPolicySigner({
    backend: {
      role: OPERATOR_SOLANA_ROLE,
      async sign() { throw new Error('supplementary buyback recovery must not re-sign'); },
    },
    policy: buyback.policy,
    decodeOptions,
    broadcast: async signed => {
      if (!(await readBlockhashValidity(adapters.solana.client, record.attempt.blockhash))) {
        throw new Error('supplementary buyback provider transaction blockhash expired before submission');
      }
      requireCollectorOnlyMutationAuthority(config);
      return adapters.collectorCrypt.submitTransaction({ signedTransaction: signed.signedTxBase64 });
    },
  });
  const policyRecovery = Object.freeze({
    schema: 'hookemon.transaction-policy-approval.v1',
    family: 'solana',
    policyDigest: recoveryContext.policyDigest,
    approvalDigest: recoveryContext.approvalDigest,
    approvedSemanticsDigest: recoveryContext.approvedSemanticsDigest,
    signedMessageDigest: recoveryContext.signedMessageDigest,
  });
  const result = await recoverTransactionPolicyBroadcast({
    client: policySigner,
    signed: { signedTxBase64: record.attempt.rawBytes },
    recoveryContext: policyRecovery,
  });
  const sourceTransactionHash = signedSolanaTransactionSignature(record.attempt.rawBytes);
  const returnedHash = typeof result === 'string' ? result : (result?.signature ?? result?.transactionHash);
  if (returnedHash !== sourceTransactionHash) {
    throw new Error('supplementary buyback broadcaster returned a hash that does not match the persisted signed bytes');
  }
  return cycleRepository.recordBroadcast(
    position.cycleId, CHAIN_ATTEMPT_STAGE, requestDigest, Object.freeze({ transactionHash: sourceTransactionHash }),
  );
}

function buildConfirmedSaleEvidence({ position, settlement, config, signature, proceeds, sourceFinality }) {
  const value = {
    schema: CONFIRMED_SALE_SCHEMA,
    positionId: position.positionId,
    cycleId: position.cycleId,
    manifestId: settlement.manifestId,
    sourceWallet: config.accounts.solana,
    mint: proceeds.assetId,
    decimals: proceeds.decimals,
    amountAtomic: proceeds.amountAtomic,
    transactionSignature: signature,
    memo: position.memo,
    sourceFinality,
  };
  // Self-validates against D's own hookemon.supplementary-confirmed-sale.v1 assertion
  // (supplementary-money.mjs) so a schema drift fails loudly here rather than downstream.
  return assertConfirmedSale(value, settlement);
}

async function advanceToBuybackSentUnknown(cycleRepository, position, confirmedSale) {
  return cycleRepository.advanceSupplementarySettlement(position.positionId, {
    expectedState: 'PREPARED',
    nextState: 'BUYBACK_SENT_UNKNOWN',
    evidence: confirmedSale,
  });
}

/**
 * Builds the handler shipped as `productionSupplementaryStageHandlers.PREPARED`
 * (C-supplementary-handler-contract.md, commit e3ae4db9). Takes no capabilities itself: `reconcile`
 * consumes exactly the `adapters`/`signerClient` the driver passes through from
 * `createStageDriver({supplementaryAdapters, supplementarySignerClient, productionSupplementaryStageHandlers})`
 * -- the same lease-fenced, canary-gated production capabilities every other stage uses, never a
 * closure-captured substitute.
 */
export function createSupplementaryBuybackHandler() {
  return Object.freeze({
    stage: SUPPLEMENTARY_BUYBACK_STAGE,
    async reconcile({ adapters, signerClient, config, cycleRepository, context, position, settlement }) {
      assertHeldPositionForResale(position);
      if (settlement.state !== 'PREPARED') {
        throw new Error('supplementary buyback handler requires a PREPARED settlement');
      }
      if (!adapters || typeof adapters !== 'object') throw new Error('supplementary buyback handler requires real adapters');
      if (!signerClient?.solana || typeof signerClient.solana.sign !== 'function') {
        throw new Error('supplementary buyback handler requires signerClient.solana.sign');
      }
      assertProductionSupplementaryBuybackRepository(cycleRepository);

      // Recovery-first: never attempt a new sale before checking whether Collector already has a
      // record for this position's immutable memo -- covers a resale resolved outside this
      // handler's own durable chain attempt entirely (e.g. an operator-side reconciliation).
      const existing = await reconcileSupplementaryBuybackSale({ adapters, config, cycleRepository, position });
      if (existing.status === 'CONFIRMED') {
        return advanceToBuybackSentUnknown(cycleRepository, position, buildConfirmedSaleEvidence({
          position, settlement, config, signature: existing.signature, proceeds: existing.proceeds, sourceFinality: existing.sourceFinality,
        }));
      }
      if (existing.status === 'DATA_UNVERIFIED') {
        // A conflicting provider record exists; neither safe to adopt nor safe to resend against.
        // No hold primitive is exposed on this facade (see docs/modules/supplementary-buyback.md) --
        // stays truthfully PREPARED, discoverable by an operator via this same read-only check.
        return undefined;
      }

      const requestDigest = buybackAttemptRequestDigest(position);
      let record = await cycleRepository.readChainTransactionAttempt(position.cycleId, CHAIN_ATTEMPT_STAGE, requestDigest);
      let freshlyPrepared = false;

      if (record === null) {
        if (typeof adapters.collectorCrypt?.getBuybackAvailable !== 'function' || !adapters.solana?.client) {
          return undefined; // capabilities unavailable; the settlement stays truthfully PREPARED.
        }
        let prepared;
        try {
          prepared = await prepareResale({ adapters, config, position });
        } catch {
          return undefined; // preflight failure is money-safe: nothing was sent to the provider.
        }
        if (prepared.unavailable) return undefined; // truthful pending/held; never fabricated.

        // Durable intent BEFORE the ambiguous provider boundary: this write happens before
        // buyback() is ever called, so a crash between here and a signed attempt leaves a
        // discoverable PREPARED intent that is never blindly retried (see the branch below).
        await cycleRepository.prepareChainTransactionAttempt(
          position.cycleId, CHAIN_ATTEMPT_STAGE,
          createPreparedChainTransactionAttempt({ cycleId: position.cycleId, stage: CHAIN_ATTEMPT_STAGE, requestDigest }),
        );
        record = await cycleRepository.readChainTransactionAttempt(position.cycleId, CHAIN_ATTEMPT_STAGE, requestDigest);
        freshlyPrepared = true;

        if (record.attempt.state === 'PREPARED') {
          try {
            record = await signAndRecordBuyback({ adapters, config, signerClient, cycleRepository, context, position, prepared, requestDigest });
          } catch {
            // The provider mutation (or decode/policy/sign) may or may not have landed. The
            // durable attempt stays PREPARED; never resent automatically -- only
            // reconcileSupplementaryBuybackSale (checked first on every call) can resolve it.
            return undefined;
          }
        }
      }

      if (record.attempt.state === 'PREPARED' && !freshlyPrepared) {
        // A prior tick already durably intended this sale and we do not know whether the provider
        // mutation was ever sent. Never call it again; resolved only via the memo-based check above.
        return undefined;
      }

      if (record.attempt.state === 'SIGNED') {
        try {
          record = await broadcastRecordedBuyback({ adapters, config, cycleRepository, position, record, requestDigest });
        } catch {
          // Broadcast is itself ambiguous; the exact same signed bytes remain durably recoverable
          // for the next reconcile() call via readChainAttemptRecoveryContext -- never re-signed.
          return undefined;
        }
      }

      if (!['BROADCAST', 'FINALIZED'].includes(record.attempt.state)) return undefined;

      const signature = signedSolanaTransactionSignature(record.attempt.rawBytes);
      const confirmed = await verifiedSaleForSignature({ adapters, config, cycleRepository, position, signature });
      if (confirmed.status !== 'CONFIRMED') return undefined; // still pending finality, or conflicting; never fabricated.

      return advanceToBuybackSentUnknown(cycleRepository, position, buildConfirmedSaleEvidence({
        position, settlement, config, signature: confirmed.signature, proceeds: confirmed.proceeds, sourceFinality: confirmed.sourceFinality,
      }));
    },
  });
}
