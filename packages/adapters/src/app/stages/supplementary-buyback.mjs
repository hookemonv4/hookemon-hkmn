/**
 * Production held-card resale handler (LAUNCH-CS, item 5 of the C-brief). Reconciles a supplementary
 * settlement's PREPARED state: an owner has chosen `sell` for a held card and the durable
 * settlement machine (`cycle-repository.mjs#advanceSupplementarySettlement`) is waiting to move it
 * to `BUYBACK_SENT_UNKNOWN`. This module owns exactly that one transition; the return-bridge
 * (`BUYBACK_SENT_UNKNOWN -> RETURN_BROADCAST`) and everything after it is D's territory (see
 * `docs/modules/supplementary-buyback.md` for the exact handoff contract).
 *
 * Mirrors `buyback.mjs`'s pre-flight/ambiguous-mutation split exactly: everything up to and
 * including the fresh offer match is money-safe to abandon (the settlement simply stays PREPARED,
 * a truthful pending/held result); the provider `buyback()` call, sign, and broadcast is the one
 * ambiguous boundary, and any outcome from it (confirmed, submitted, or unknown) is durably
 * recorded via the single `PREPARED -> BUYBACK_SENT_UNKNOWN` transition before this handler
 * returns, so it can never be reached again for the same position.
 */
import {
  getFinalizedTokenBalanceChanges,
  getTransactionMplCoreTransfers,
  readAssociatedTokenAccount,
  readBlockHeight,
  readBlockhashValidity,
  readFinalizedSignatureStatus,
  readMplCoreAssetOwner,
} from '../../solana-rpc.mjs';
import { assertTypedAmount } from '../../../../runner/src/cycle/money-schemas.mjs';
import {
  decodeProviderTransaction,
  evaluate as evaluateTransactionPolicy,
} from '../../signing/transaction-policy.mjs';
import { collectorPolicyForStage } from '../../signing/collector-policy-loader.mjs';
import { OPERATOR_SOLANA_ROLE, createPolicySigner } from '../../signing/signer-client.mjs';
import {
  isLiveCollectorOnlyRehearsal,
  requireCollectorOnlyMutationAuthority,
} from '../../../rehearsal/collector-only-authorization.mjs';
import { COLLECTOR_CRYPT_SETTLEMENT_ASSET } from '../../collector-crypt.mjs';
import { assertSolanaSignerFeeEnvelope, assertSolanaSignerMoneyConfiguration } from './solana-money-controls.mjs';
import { buildCollectorBuybackRequest } from './buyback.mjs';

export const SUPPLEMENTARY_BUYBACK_STAGE = 'supplementary-buyback';
const EVIDENCE_SCHEMA = 'hookemon.supplementary-buyback-evidence.v1';
const HELD_POSITION_ID = /^held:[0-9a-f]{64}$/;

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

/** The held card's asset kind is not stored on the position record; it is re-derived, read-only,
 *  from the original cycle's own open-stage evidence, keyed by the position's immutable memo. */
async function assetKindForPosition(cycleRepository, position) {
  const open = await cycleRepository.readStage(position.cycleId, 'open').catch(() => null);
  const packs = plainObject(open?.evidence) && Array.isArray(open.evidence.packs) ? open.evidence.packs : [];
  return packs.find(entry => entry.memo === position.memo)?.assetKind ?? 'spl';
}

function saleEvidence(position, fields) {
  return Object.freeze({
    schema: EVIDENCE_SCHEMA,
    positionId: position.positionId,
    cycleId: position.cycleId,
    memo: position.memo,
    mint: position.mint,
    ...fields,
  });
}

/**
 * Read-only. Resolves Collector's own memo-keyed record for a held position's resale, verified
 * against Solana finality exactly like `buyback.mjs`'s own reconciliation. Makes no provider
 * mutation and no durable write; safe to call at any time, including from D's own return-bridge
 * handler once this module hands off a `submitted`/`unknown` evidence record, or on every restart
 * before ever attempting a new sale. Never invents success: a still-pending provider result stays
 * `PENDING`, and a confirmed-but-conflicting result is `DATA_UNVERIFIED`, never silently resolved.
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

  let status;
  try {
    status = await readFinalizedSignatureStatus(adapters.solana.client, check.transactionSignature);
  } catch {
    return { status: 'PENDING' };
  }
  if (status === null) return { status: 'PENDING' };
  if (status.err) {
    return {
      status: 'DATA_UNVERIFIED',
      reason: 'buyback transaction finalized with an error',
      signature: check.transactionSignature,
    };
  }

  const assetKind = await assetKindForPosition(cycleRepository, position);
  const proceedsAccount = configuredProceedsAccount(config);
  let leftOperator;
  let entries;
  try {
    entries = await getFinalizedTokenBalanceChanges(adapters.solana.client, check.transactionSignature);
    if (assetKind === 'mpl-core') {
      const transfers = await getTransactionMplCoreTransfers(adapters.solana.client, check.transactionSignature, { commitment: 'finalized' });
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

  if (!leftOperator || proceeds === null || !sameAmount(proceeds, checkedAmount)) {
    return {
      status: 'DATA_UNVERIFIED',
      reason: 'finalized card and settlement deltas did not match the completed buyback check',
      signature: check.transactionSignature,
    };
  }

  return {
    status: 'CONFIRMED',
    memo: position.memo,
    mint: position.mint,
    signature: check.transactionSignature,
    proceeds,
    createdAt: check.createdAt,
  };
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
  return { unavailable: false, asset, money, proceedsAccount, offer, request };
}

/**
 * The one ambiguous boundary: Collector's buyback endpoint, sign, and broadcast. Everything from
 * the canary authorization check onward runs in one try/catch, exactly like `buyback.mjs`'s own
 * `sellPack`: once the provider mutation might have been reached, any failure (a denied canary, a
 * decode/policy/binding mismatch, a signer or broadcast error) is indistinguishable from "the
 * provider may have already processed this" and is recorded as `unknown`, never retried and never
 * held as though nothing happened.
 */
async function attemptResale({ adapters, config, signerClient, position, prepared }) {
  const { money, proceedsAccount, offer, request } = prepared;
  try {
    requireCollectorOnlyMutationAuthority(config);
    const built = await adapters.collectorCrypt.buyback(request);
    const refundAmount = typedBuybackAmount(built.refundAmount, 'supplementary buyback refund amount');
    if (built.memo !== position.memo || !sameAmount(refundAmount, offer)) {
      return saleEvidence(position, {
        decision: 'data_unverified',
        offer,
        built,
        reason: 'provider buyback response did not bind the held card memo and offer',
      });
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
      broadcast: async signed => {
        if (!(await readBlockhashValidity(adapters.solana.client, decoded.blockhash))) {
          throw new Error('supplementary buyback provider transaction blockhash expired before submission');
        }
        requireCollectorOnlyMutationAuthority(config);
        return adapters.collectorCrypt.submitTransaction({ signedTransaction: signed.signedTxBase64 });
      },
    });

    const signed = await signer.sign(built.serializedTransaction);
    const submitted = await signer.broadcast(signed);
    return saleEvidence(position, {
      decision: 'submitted',
      offer,
      refundAmount,
      signature: submitted.signature,
      ...(proceedsAccount === null ? {} : { proceedsAccount }),
    });
  } catch (error) {
    return saleEvidence(position, { decision: 'unknown', offer, reason: error.message });
  }
}

/**
 * Builds the PREPARED-state handler shipped as `supplementaryStageHandlers.PREPARED`. `adapters`
 * and `signerClient` are closed over at construction time by the caller (I's composition root)
 * rather than read from the driver's `reconcile()` call, because `stage-driver.mjs`'s
 * `runSupplementarySettlement` does not yet thread real capabilities into that call (tracked in
 * `C-supplementary-resale-design.md`; see this module's docs for the exact coordination note).
 * `config`/`cycleRepository`/`context`/`position`/`settlement` are read from the call as already
 * shipped today.
 */
export function createSupplementaryBuybackHandler({ adapters, signerClient }) {
  if (!adapters || typeof adapters !== 'object') throw new Error('supplementary buyback handler requires adapters');
  if (!signerClient?.solana || typeof signerClient.solana.sign !== 'function') {
    throw new Error('supplementary buyback handler requires signerClient.solana.sign');
  }
  return Object.freeze({
    stage: SUPPLEMENTARY_BUYBACK_STAGE,
    async reconcile({ config, cycleRepository, position, settlement }) {
      assertHeldPositionForResale(position);
      if (settlement.state !== 'PREPARED') {
        throw new Error('supplementary buyback handler requires a PREPARED settlement');
      }

      // Recovery-first: never attempt a new sale before checking whether Collector already has a
      // record for this position's immutable memo (a prior attempt in this process or an earlier
      // crashed one). This is the load-bearing no-double-resale check across restart.
      const existing = await reconcileSupplementaryBuybackSale({ adapters, config, cycleRepository, position });
      if (existing.status === 'CONFIRMED') {
        return cycleRepository.advanceSupplementarySettlement(position.positionId, {
          expectedState: 'PREPARED',
          nextState: 'BUYBACK_SENT_UNKNOWN',
          evidence: saleEvidence(position, {
            decision: 'sold',
            signature: existing.signature,
            proceeds: existing.proceeds,
            createdAt: existing.createdAt,
          }),
        });
      }
      if (existing.status === 'DATA_UNVERIFIED') {
        return cycleRepository.advanceSupplementarySettlement(position.positionId, {
          expectedState: 'PREPARED',
          nextState: 'BUYBACK_SENT_UNKNOWN',
          evidence: saleEvidence(position, { decision: 'data_unverified', reason: existing.reason }),
        });
      }

      if (typeof adapters.collectorCrypt?.getBuybackAvailable !== 'function' || !adapters.solana?.client) {
        return undefined; // capabilities unavailable; the settlement stays truthfully PREPARED.
      }

      let prepared;
      try {
        prepared = await prepareResale({ adapters, config, position });
      } catch {
        // Preflight failure is money-safe: nothing was sent to the provider. Stay PREPARED.
        return undefined;
      }
      if (prepared.unavailable) return undefined; // truthful pending/held; never fabricated.

      const evidence = await attemptResale({ adapters, config, signerClient, position, prepared });
      return cycleRepository.advanceSupplementarySettlement(position.positionId, {
        expectedState: 'PREPARED',
        nextState: 'BUYBACK_SENT_UNKNOWN',
        evidence,
      });
    },
  });
}
