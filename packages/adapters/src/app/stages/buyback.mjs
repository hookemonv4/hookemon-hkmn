import {
  getFinalizedTokenBalanceChanges,
  getTransactionMplCoreTransfers,
  deriveAssociatedTokenAddress,
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
import { OPERATOR_SOLANA_ROLE, wrapTransactionPolicySignerClient } from '../../signing/signer-client.mjs';
import { canonicalJson, digest } from '../../../../runner/src/cycle/journal.mjs';
import { requireCollectorOnlyMutationAuthority } from '../../../rehearsal/collector-only-authorization.mjs';
import { COLLECTOR_CRYPT_SETTLEMENT_ASSET } from '../../collector-crypt.mjs';
import {
  assertSolanaSignerFeeEnvelope,
  assertSolanaSignerMoneyConfiguration,
} from './solana-money-controls.mjs';

const canonicalUnsignedInteger = /^(0|[1-9][0-9]*)$/;
const DOCUMENTED_PRIZE_TIER_RARITIES = Object.freeze({
  1: 'epic',
  2: 'rare',
  3: 'uncommon',
  4: 'common',
});
const INSURED_VALUE_UNITS = new Set(['whole-usd', 'atomic']);
const WHOLE_USD_ATOMIC_SCALE = 1_000_000n;
const MINIMUM_INSTANT_BUYBACK_PERCENT = 85;
const MAXIMUM_INSTANT_BUYBACK_PERCENT = 94;
const DEFAULT_UNRESOLVED_CARD_DEADLINE_MINUTES = 30;
const MINIMUM_UNRESOLVED_CARD_DEADLINE_MINUTES = 5;
const MAXIMUM_UNRESOLVED_CARD_DEADLINE_MINUTES = 1440;
const CUSTODY_BUCKETS = Object.freeze([
  'claimed', 'bridgeOut', 'bridgeIn', 'packCost', 'buybackProceeds', 'returnInput', 'returnReceived',
  'refunds', 'residual', 'heldAssets', 'heldPositions', 'payoutLiability', 'dust', 'unattributed',
]);

class EpicDecisionRefusal extends Error {
  constructor(terminalState, evidence) {
    super(evidence.reason);
    this.name = 'EpicDecisionRefusal';
    this.terminalState = terminalState;
    this.evidence = evidence;
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function atomicString(value, label) {
  if (typeof value === 'string' && canonicalUnsignedInteger.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'bigint' && value >= 0n) return value.toString();
  throw new Error(`${label} must be a canonical non-negative atomic amount`);
}

function configuredSettlementAsset(config) {
  const asset = config?.collectorCrypt?.settlementAsset;
  if (!plainObject(asset)
    || typeof asset.chainId !== 'string' || asset.chainId.length === 0
    || typeof asset.assetId !== 'string' || asset.assetId.length === 0
    || !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 255
    || asset.chainId !== config?.solana?.chainId) {
    throw new Error('buyback requires a settlementAsset matching config.solana.chainId');
  }
  if (!sameAsset(asset, COLLECTOR_CRYPT_SETTLEMENT_ASSET)) {
    throw new Error('buyback settlementAsset must match the documented Solana buyback asset');
  }
  return Object.freeze({ chainId: asset.chainId, assetId: asset.assetId, decimals: asset.decimals });
}

function typedAmount(asset, value, label) {
  return assertTypedAmount({ ...asset, amountAtomic: atomicString(value, label) }, label);
}

function typedBuybackAmount(value, label) {
  const amount = assertTypedAmount(value, label);
  if (!sameAsset(amount, COLLECTOR_CRYPT_SETTLEMENT_ASSET)) {
    throw new Error(`${label} must use the documented Solana buyback asset`);
  }
  return amount;
}

function openEvidence(open) {
  if (open?.status !== 'COMPLETE' || typeof open.evidence?.mint !== 'string' || open.evidence.mint.length === 0
    || typeof open.evidence?.memo !== 'string' || open.evidence.memo.length === 0) {
    throw new Error('buyback requires a completed open stage with a card asset and memo');
  }
  return open.evidence;
}

function heldOpenPosition(open) {
  const evidence = open?.status === 'COMPLETE' ? open.evidence : null;
  if (!plainObject(evidence) || evidence.decision !== 'held') return null;
  if (typeof evidence.memo !== 'string' || evidence.memo.length === 0 || evidence.expectedCardCount !== 1
    || (evidence.mint !== null && (typeof evidence.mint !== 'string' || evidence.mint.length === 0))
    || typeof evidence.terminalState !== 'string' || evidence.terminalState.length === 0
    || typeof evidence.reason !== 'string' || evidence.reason.length === 0
    || !plainObject(evidence.heldPosition)
    || typeof evidence.heldPosition.positionId !== 'string' || evidence.heldPosition.positionId.length === 0
    || typeof evidence.heldPosition.evidenceDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(evidence.heldPosition.evidenceDigest)
    || evidence.heldPosition.terminalState !== evidence.terminalState
    || evidence.heldPosition.reason !== evidence.reason) {
    throw new Error('buyback held open evidence does not bind the original held position');
  }
  return evidence;
}

function purchaseEvidence(purchase, open) {
  if (purchase?.status !== 'COMPLETE' || typeof purchase.evidence?.memo !== 'string' || purchase.evidence.memo.length === 0
    || purchase.evidence.expectedCardCount !== 1) {
    throw new Error('sent-unknown buyback reconciliation requires a completed single-card purchase stage');
  }
  if (purchase.evidence.memo !== open.memo) {
    throw new Error('sent-unknown buyback reconciliation requires the completed purchase and open stages to share a memo');
  }
  return purchase.evidence;
}

function configuredBuyback(config) {
  const value = config?.collectorCrypt?.buyback;
  const bundlePolicy = collectorPolicyForStage(config, 'buyback');
  const policy = bundlePolicy ?? value?.policy;
  if (!plainObject(value) || !plainObject(policy)
    || typeof value.collectorProgramId !== 'string' || value.collectorProgramId.length === 0
    || typeof value.collectorRecipient !== 'string' || value.collectorRecipient.length === 0) {
    throw new Error('buyback requires a pinned policy, Collector program id, and Collector recipient');
  }
  return { ...value, policy };
}

function isLiveCollectorOnlyRehearsal(config) {
  return config?.execution?.profile === 'rehearsal'
    && config.execution?.providerMode === 'live'
    && config.rehearsal?.mode === 'collector-only';
}

function dedicatedProceedsAccount(config) {
  if (!isLiveCollectorOnlyRehearsal(config)) return null;
  const operator = config.accounts?.solana;
  const proceedsAccount = config.rehearsal?.proceedsAccount;
  if (typeof operator !== 'string' || operator.length === 0 || typeof proceedsAccount !== 'string' || proceedsAccount.length === 0) {
    throw new Error('live collector-only buyback requires a dedicated proceeds account');
  }
  const conflictsWithRecipient = config.rehearsal.payoutRecipients?.some(recipient => {
    if (recipient === operator || recipient === proceedsAccount) return true;
    return deriveAssociatedTokenAddress(recipient, COLLECTOR_CRYPT_SETTLEMENT_ASSET.assetId).toBase58() === proceedsAccount;
  });
  if (proceedsAccount === operator || conflictsWithRecipient) {
    throw new Error('live collector-only buyback proceeds account must be distinct from the operator wallet and every recipient');
  }
  const canonical = deriveAssociatedTokenAddress(operator, COLLECTOR_CRYPT_SETTLEMENT_ASSET.assetId).toBase58();
  if (proceedsAccount !== canonical) {
    throw new Error('live collector-only buyback proceeds account must be the operator canonical Circle token account');
  }
  return proceedsAccount;
}

export function buildCollectorBuybackRequest({ config, mint }) {
  if (typeof config?.accounts?.solana !== 'string' || config.accounts.solana.length === 0) {
    throw new Error('buyback requires a configured Solana operator account');
  }
  if (typeof mint !== 'string' || mint.length === 0) throw new Error('buyback requires an opened card asset');
  const request = {
    playerAddress: config.accounts.solana,
    nftAddress: mint,
  };
  // The documented API type accepts a wallet public key. Keep the dedicated account as a
  // finalized-delta check, but do not send an unverified token-account alternate recipient.
  dedicatedProceedsAccount(config);
  return Object.freeze(request);
}

function trustedSolanaDecodeOptions({ adapters, config }) {
  if (typeof config?.solana?.blockhashContextResolver !== 'function') {
    throw new Error('buyback requires a trusted Solana blockhashContextResolver');
  }
  return Object.freeze({
    family: 'solana',
    chainId: config.solana.chainId,
    lookupTableResolver: config.solana.lookupTableResolver,
    blockhashContextResolver: config.solana.blockhashContextResolver,
    currentBlockHeightResolver: async () => readBlockHeight(adapters.solana.client),
  });
}

function heldPositionReason(terminalState) {
  if (terminalState === 'HELD_UNAVAILABLE') return 'BUYBACK_UNAVAILABLE';
  if (terminalState === 'HELD_OWNER_DECISION') return 'EPIC_THRESHOLD';
  if (terminalState === 'HELD_UNRESOLVED') return 'SENT_UNKNOWN_DEADLINE';
  return 'DATA_UNVERIFIED';
}

function optionalTypedAmount(value) {
  try {
    return assertTypedAmount(value, 'held buyback insured value');
  } catch {
    return null;
  }
}

function heldPositionValueMicroUsdg(costMicroUsdg, insuredValue, config) {
  const usdg = config?.moneyConfiguration?.assets?.usdg;
  if (insuredValue !== null && sameAsset(insuredValue, usdg) && insuredValue.chainId === '4663' && insuredValue.decimals === 6) {
    return insuredValue.amountAtomic;
  }
  return costMicroUsdg;
}

function heldPositionLedgerAsset(config) {
  const asset = config?.moneyConfiguration?.assets?.usdg;
  const typed = assertTypedAmount({ ...asset, amountAtomic: '0' }, 'held buyback USDG ledger asset');
  if (typed.chainId !== '4663' || typed.decimals !== 6) {
    throw new Error('held buyback USDG ledger asset must use the configured six-decimal USDG asset');
  }
  return { chainId: typed.chainId, assetId: typed.assetId, decimals: typed.decimals };
}

async function holdWholeCycleForUnattributableCard(cycleRepository, context, evidence) {
  if (typeof cycleRepository?.holdCycle !== 'function') {
    throw new Error('buyback cannot record an unattributable held card without cycle hold authority');
  }
  await cycleRepository.holdCycle(context.cycleId, 'HELD_DATA_UNVERIFIED', evidence);
  return null;
}

async function hold(cycleRepository, config, context, terminalState, evidence, reason = heldPositionReason(terminalState)) {
  const memo = evidence?.memo;
  const mint = evidence?.mint;
  if (typeof memo !== 'string' || memo.length === 0 || typeof mint !== 'string' || mint.length === 0) {
    return holdWholeCycleForUnattributableCard(cycleRepository, context, {
      stage: 'buyback',
      ...evidence,
      reason: 'held card is missing its durable memo or card identity',
    });
  }
  if (typeof cycleRepository?.recordHeldPosition !== 'function' || typeof cycleRepository.describeCycle !== 'function') {
    throw new Error('buyback requires held-position attribution capabilities');
  }
  const description = await cycleRepository.describeCycle(context.cycleId);
  const costMicroUsdg = description?.releaseAmount;
  const packId = config?.pack?.code;
  if (typeof costMicroUsdg !== 'string' || !canonicalUnsignedInteger.test(costMicroUsdg)
    || typeof packId !== 'string' || packId.length === 0) {
    return holdWholeCycleForUnattributableCard(cycleRepository, context, {
      stage: 'buyback',
      ...evidence,
      reason: 'held card is missing attributable cycle purchase evidence',
    });
  }
  const insuredValue = optionalTypedAmount(evidence?.insuredValue ?? evidence?.epicDecision?.insuredValue ?? null);
  const position = await cycleRepository.recordHeldPosition(context.cycleId, {
    packId,
    memo,
    mint,
    cardRef: mint,
    costMicroUsdg,
    valueMicroUsdg: heldPositionValueMicroUsdg(costMicroUsdg, insuredValue, config),
    ledgerAsset: heldPositionLedgerAsset(config),
    insuredValue,
    reason,
    terminalState,
    evidence,
  });
  return {
    memo,
    expectedCardCount: 1,
    mint,
    decision: 'held',
    terminalState,
    reason,
    heldPosition: {
      positionId: position.positionId,
      evidenceDigest: position.evidenceDigest,
      terminalState: position.terminalState,
      reason: position.reason,
    },
  };
}

function unresolvedCardDeadlineMinutes(config) {
  const value = config?.unresolvedCardDeadlineMinutes ?? DEFAULT_UNRESOLVED_CARD_DEADLINE_MINUTES;
  if (!Number.isSafeInteger(value)
    || value < MINIMUM_UNRESOLVED_CARD_DEADLINE_MINUTES
    || value > MAXIMUM_UNRESOLVED_CARD_DEADLINE_MINUTES) {
    throw new Error('buyback unresolvedCardDeadlineMinutes is invalid');
  }
  return value;
}

function sentUnknownPastDeadline(record, config, context) {
  if (record?.attempt?.state !== 'SENT_UNKNOWN' || !Number.isSafeInteger(record.sentAtMs) || record.sentAtMs < 0) return false;
  const nowMs = context?.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('buyback reconciliation clock is invalid');
  return nowMs >= record.sentAtMs + unresolvedCardDeadlineMinutes(config) * 60_000;
}

async function holdPastDeadlineSentUnknown({ cycleRepository, config, context, record }) {
  let open;
  try {
    open = openEvidence(await cycleRepository.readStage(context.cycleId, 'open'));
  } catch {
    return holdWholeCycleForUnattributableCard(cycleRepository, context, {
      stage: 'buyback',
      attempt: record?.attempt ?? null,
      sentAtMs: record?.sentAtMs ?? null,
      reason: 'sent-unknown buyback lacks an attributable opened card at the reconcile deadline',
    });
  }
  return hold(cycleRepository, config, context, 'HELD_UNRESOLVED', {
    stage: 'buyback',
    memo: open.memo,
    mint: open.mint,
    attempt: record.attempt,
    sentAtMs: record.sentAtMs,
    deadlineMinutes: unresolvedCardDeadlineMinutes(config),
    reason: 'buyback provider mutation remained sent-unknown past the reconcile deadline',
  }, 'SENT_UNKNOWN_DEADLINE');
}

function responseEvidence(record, requiredProceedsAccount = null) {
  const evidence = record?.responseEvidence;
  if (!plainObject(evidence) || typeof evidence.memo !== 'string') return null;
  if (evidence.decision === 'held') {
    if ((evidence.mint !== null && typeof evidence.mint !== 'string') || evidence.expectedCardCount !== 1
      || typeof evidence.terminalState !== 'string' || evidence.terminalState.length === 0
      || typeof evidence.reason !== 'string' || evidence.reason.length === 0
      || !plainObject(evidence.heldPosition)) return null;
    return evidence;
  }
  if (typeof evidence.mint !== 'string') return null;
  if (typeof evidence.signature !== 'string' || !plainObject(evidence.quote) || !plainObject(evidence.refundAmount)) return null;
  if (requiredProceedsAccount !== null && evidence.proceedsAccount !== requiredProceedsAccount) return null;
  try {
    const quote = typedBuybackAmount(evidence.quote, 'recorded buyback quote');
    const refundAmount = typedBuybackAmount(evidence.refundAmount, 'recorded buyback refund amount');
    if (!sameAmount(quote, refundAmount)) return null;
  } catch {
    return null;
  }
  return evidence;
}

function decodedBindsBuyback({ decoded, owner, mint, buyback, proceedsAccount = null }) {
  const hasOwner = decoded.feePayer === owner && decoded.requiredSigners.includes(owner);
  const hasProgram = decoded.programIds.includes(buyback.collectorProgramId);
  const hasRecipient = decoded.destination === buyback.collectorRecipient
    || decoded.instructions.some(instruction => instruction.accounts.some(account => account.address === buyback.collectorRecipient));
  const hasMint = decoded.mint === mint
    || decoded.instructions.some(instruction => instruction.mint === mint || instruction.accounts.some(account => account.address === mint));
  const hasProceedsAccount = proceedsAccount === null || decoded.destination === proceedsAccount
    || decoded.instructions.some(instruction => instruction.accounts.some(account => account.address === proceedsAccount));
  if (!hasOwner) throw new Error('buyback provider transaction does not bind the operator wallet as fee payer and signer');
  if (!hasProgram || !hasRecipient) throw new Error('buyback provider transaction does not bind the configured Collector program and recipient');
  if (!hasMint) throw new Error('buyback provider transaction does not bind the opened asset');
  if (!hasProceedsAccount) throw new Error('buyback provider transaction does not bind the dedicated proceeds account');
}

async function decodeAndSign({ transaction, mint, adapters, config, money, signerClient, beforeSign = null }) {
  if (!adapters?.solana?.client || !signerClient?.solana || typeof signerClient.solana.sign !== 'function') {
    throw new Error('buyback requires a Solana RPC client and signerClient.solana.sign');
  }
  if (typeof config?.solana?.chainId !== 'string' || config.solana.chainId.length === 0) throw new Error('buyback requires config.solana.chainId');
  const buyback = configuredBuyback(config);
  const decodeOptions = trustedSolanaDecodeOptions({ adapters, config });
  const decoded = await decodeProviderTransaction({ ...decodeOptions, transaction });
  if (!decoded.blockhash || !(await readBlockhashValidity(adapters.solana.client, decoded.blockhash))) {
    throw new Error('buyback provider transaction blockhash is not valid before signing');
  }
  evaluateTransactionPolicy(buyback.policy, decoded);
  decodedBindsBuyback({
    decoded,
    owner: config.accounts.solana,
    mint,
    buyback,
    proceedsAccount: dedicatedProceedsAccount(config),
  });
  await assertSolanaSignerFeeEnvelope({
    client: adapters.solana.client,
    owner: config.accounts?.solana,
    money,
    decoded,
    stage: 'buyback',
  });
  const signer = wrapTransactionPolicySignerClient({
    client: {
      role: signerClient.solana.role ?? OPERATOR_SOLANA_ROLE,
      async sign(request) {
        if (beforeSign !== null) await beforeSign();
        requireCollectorOnlyMutationAuthority(config);
        return signerClient.solana.sign(request);
      },
    },
    policy: buyback.policy,
    decodeOptions,
    broadcast: async signed => {
      if (!(await readBlockhashValidity(adapters.solana.client, decoded.blockhash))) {
        throw new Error('buyback provider transaction blockhash expired before submission');
      }
      requireCollectorOnlyMutationAuthority(config);
      return adapters.collectorCrypt.submitTransaction({ signedTransaction: signed.signedTxBase64 });
    },
  });
  return { signer, signed: await signer.sign(transaction) };
}

function sameAmount(left, right) {
  return left?.chainId === right?.chainId && left?.assetId === right?.assetId
    && left?.decimals === right?.decimals && left?.amountAtomic === right?.amountAtomic;
}

function sameAsset(left, right) {
  return left?.chainId === right?.chainId && left?.assetId === right?.assetId && left?.decimals === right?.decimals;
}

function refuseEpicDecision(terminalState, evidence, reason) {
  throw new EpicDecisionRefusal(terminalState, { stage: 'buyback', ...evidence, reason });
}

function matchingBuybackPercentages({ offerAtomic, insuredAtomic, instantBuybackPercent }) {
  const matches = [];
  for (let percent = instantBuybackPercent - 1; percent <= instantBuybackPercent + 1; percent += 1) {
    if ((insuredAtomic * BigInt(percent)) / 100n === offerAtomic) matches.push(percent);
  }
  return matches;
}

function reconciledInsuredValue({ evidence, offer, insuredValue, baseEvidence }) {
  if (typeof evidence.rawInsuredValue !== 'string' || !canonicalUnsignedInteger.test(evidence.rawInsuredValue)
    || !INSURED_VALUE_UNITS.has(evidence.insuredValueUnit)
    || !Number.isSafeInteger(evidence.instantBuybackPercent)
    || evidence.instantBuybackPercent < MINIMUM_INSTANT_BUYBACK_PERCENT
    || evidence.instantBuybackPercent > MAXIMUM_INSTANT_BUYBACK_PERCENT
    || !Number.isSafeInteger(evidence.matchedBuybackPercent)
    || Math.abs(evidence.matchedBuybackPercent - evidence.instantBuybackPercent) > 1) {
    refuseEpicDecision('HELD_DATA_UNVERIFIED', baseEvidence, 'completed epic-gate unit reconciliation evidence is invalid');
  }
  const rawInsuredValue = BigInt(evidence.rawInsuredValue);
  const candidates = [
    { unit: 'whole-usd', amountAtomic: rawInsuredValue * WHOLE_USD_ATOMIC_SCALE },
    { unit: 'atomic', amountAtomic: rawInsuredValue },
  ].map(candidate => ({
    ...candidate,
    matchingPercentages: matchingBuybackPercentages({
      offerAtomic: BigInt(offer.amountAtomic),
      insuredAtomic: candidate.amountAtomic,
      instantBuybackPercent: evidence.instantBuybackPercent,
    }),
  })).filter(candidate => candidate.matchingPercentages.length > 0);
  if (candidates.length !== 1 || candidates[0].unit !== evidence.insuredValueUnit
    || candidates[0].amountAtomic.toString() !== insuredValue.amountAtomic
    || !candidates[0].matchingPercentages.includes(evidence.matchedBuybackPercent)) {
    refuseEpicDecision('HELD_DATA_UNVERIFIED', baseEvidence, 'completed epic-gate insured-value unit does not reconcile to the recorded quote');
  }
  return {
    rawInsuredValue: evidence.rawInsuredValue,
    insuredValueUnit: evidence.insuredValueUnit,
    instantBuybackPercent: evidence.instantBuybackPercent,
    matchedBuybackPercent: evidence.matchedBuybackPercent,
  };
}

function digestEpicDecision({
  cycleId,
  memo,
  mint,
  offer,
  rawInsuredValue,
  insuredValue,
  insuredValueUnit,
  instantBuybackPercent,
  matchedBuybackPercent,
  prizeTier,
  rarity,
}) {
  return digest({
    schema: 'hookemon.collector-crypt-epic-decision.v1',
    cycleId,
    memo,
    mint,
    decision: 'sell',
    offer,
    rawInsuredValue,
    insuredValue,
    insuredValueUnit,
    instantBuybackPercent,
    matchedBuybackPercent,
    prizeTier,
    rarity,
  });
}

function completedSellDecision({ stage, open, cycleId }) {
  const baseEvidence = { memo: open.memo, mint: open.mint };
  if (stage?.status !== 'COMPLETE') {
    refuseEpicDecision('HELD_OWNER_DECISION', baseEvidence, 'a completed epic-gate sell decision is required before buyback');
  }
  const evidence = stage.evidence;
  if (!plainObject(evidence)) {
    refuseEpicDecision('HELD_DATA_UNVERIFIED', baseEvidence, 'completed epic-gate evidence is invalid');
  }
  if (evidence.decision !== 'sell') {
    if (evidence.decision === 'hold') {
      refuseEpicDecision('HELD_OWNER_DECISION', baseEvidence, 'the completed epic-gate decision does not authorize a buyback');
    }
    refuseEpicDecision('HELD_DATA_UNVERIFIED', baseEvidence, 'completed epic-gate evidence has an unknown decision');
  }
  if (evidence.memo !== open.memo || evidence.mint !== open.mint) {
    refuseEpicDecision('HELD_DATA_UNVERIFIED', baseEvidence, 'completed epic-gate evidence does not bind the opened card and memo');
  }
  let offer;
  let insuredValue;
  try {
    offer = assertTypedAmount(evidence.offer, 'completed epic-gate offer');
    insuredValue = assertTypedAmount(evidence.insuredValue, 'completed epic-gate insured value');
  } catch {
    refuseEpicDecision('HELD_DATA_UNVERIFIED', baseEvidence, 'completed epic-gate amounts are invalid');
  }
  if (!sameAsset(offer, insuredValue) || !sameAsset(offer, COLLECTOR_CRYPT_SETTLEMENT_ASSET) || insuredValue.amountAtomic === '0') {
    refuseEpicDecision('HELD_DATA_UNVERIFIED', baseEvidence, 'completed epic-gate amounts are not comparable');
  }
  if (typeof evidence.prizeTier !== 'string' || !canonicalUnsignedInteger.test(evidence.prizeTier)
    || DOCUMENTED_PRIZE_TIER_RARITIES[evidence.prizeTier] !== evidence.rarity) {
    refuseEpicDecision('HELD_DATA_UNVERIFIED', baseEvidence, 'completed epic-gate prize tier and rarity are invalid');
  }
  const reconciliation = reconciledInsuredValue({ evidence, offer, insuredValue, baseEvidence });
  if (evidence.prizeTier === '1' && BigInt(offer.amountAtomic) * 100n < BigInt(insuredValue.amountAtomic) * 40n) {
    refuseEpicDecision('HELD_DATA_UNVERIFIED', baseEvidence, 'completed epic-gate sell decision fails the insured-value threshold');
  }
  const decision = {
    memo: open.memo,
    mint: open.mint,
    decision: 'sell',
    offer,
    ...reconciliation,
    insuredValue,
    prizeTier: evidence.prizeTier,
    rarity: evidence.rarity,
  };
  return { ...decision, decisionDigest: digestEpicDecision({ cycleId, ...decision }) };
}

async function readCompletedSellDecision({ cycleRepository, context, open }) {
  const stage = await cycleRepository.readStage(context.cycleId, 'epic-gate');
  return completedSellDecision({ stage, open, cycleId: context.cycleId });
}

function heldEpicPosition(stage, open) {
  const evidence = stage?.status === 'COMPLETE' ? stage.evidence : null;
  if (!plainObject(evidence) || evidence.decision !== 'held') return null;
  if (evidence.memo !== open.memo || evidence.mint !== open.mint
    || typeof evidence.terminalState !== 'string' || evidence.terminalState.length === 0
    || typeof evidence.reason !== 'string' || evidence.reason.length === 0
    || !plainObject(evidence.heldPosition)
    || typeof evidence.heldPosition.positionId !== 'string' || evidence.heldPosition.positionId.length === 0
    || typeof evidence.heldPosition.evidenceDigest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(evidence.heldPosition.evidenceDigest)) {
    throw new Error('buyback held epic evidence does not bind the opened card and position');
  }
  return evidence;
}

function heldBuybackRequest(open, heldPosition) {
  return {
    provider: 'collector-crypt',
    operation: 'buyback',
    memo: open.memo,
    mint: open.mint,
    decision: 'held',
    terminalState: heldPosition.terminalState,
    reason: heldPosition.reason,
    heldPosition: heldPosition.heldPosition,
  };
}

function heldBuybackEvidence(heldPosition) {
  return {
    memo: heldPosition.memo,
    expectedCardCount: heldPosition.expectedCardCount,
    mint: heldPosition.mint,
    decision: 'held',
    terminalState: heldPosition.terminalState,
    reason: heldPosition.reason,
    heldPosition: heldPosition.heldPosition,
  };
}

function assertHeldBuybackRequest(prepared, open, heldPosition) {
  const expected = heldBuybackRequest(open, heldPosition);
  if (canonicalJson(prepared) !== canonicalJson(expected)) {
    throw new Error('buyback prepared held request does not bind the completed epic held position');
  }
  return expected;
}

function assertPreparedBuybackRequest(prepared, decision) {
  const baseEvidence = { memo: decision.memo, mint: decision.mint };
  if (!plainObject(prepared) || prepared.provider !== 'collector-crypt' || prepared.operation !== 'buyback'
    || prepared.memo !== decision.memo || prepared.mint !== decision.mint || !plainObject(prepared.epicDecision)) {
    refuseEpicDecision('HELD_DATA_UNVERIFIED', baseEvidence, 'prepared buyback request does not bind the completed epic decision');
  }
  const bound = prepared.epicDecision;
  if (bound.memo !== decision.memo || bound.mint !== decision.mint || bound.decision !== 'sell'
    || !sameAmount(bound.offer, decision.offer) || !sameAmount(bound.insuredValue, decision.insuredValue)
    || bound.rawInsuredValue !== decision.rawInsuredValue
    || bound.insuredValueUnit !== decision.insuredValueUnit
    || bound.instantBuybackPercent !== decision.instantBuybackPercent
    || bound.matchedBuybackPercent !== decision.matchedBuybackPercent
    || bound.prizeTier !== decision.prizeTier || bound.rarity !== decision.rarity
    || bound.decisionDigest !== decision.decisionDigest) {
    refuseEpicDecision('HELD_DATA_UNVERIFIED', baseEvidence, 'prepared buyback request differs from the completed epic decision');
  }
}

function buybackRequest({ open, epicDecision }) {
  return {
    provider: 'collector-crypt',
    operation: 'buyback',
    memo: open.memo,
    mint: open.mint,
    epicDecision,
  };
}

function requestMatchesSentUnknownAttempt({ attempt, context, request }) {
  if (attempt?.state !== 'SENT_UNKNOWN' || typeof attempt.requestDigest !== 'string') return false;
  const expectedDigest = digest({
    schema: 'hookemon.operational-stage-request.v1',
    cycleId: context.cycleId,
    stage: 'buyback',
    request,
  });
  return attempt.requestDigest === expectedDigest;
}

async function readSentUnknownBuybackRequest({ cycleRepository, context }) {
  const open = openEvidence(await cycleRepository.readStage(context.cycleId, 'open'));
  purchaseEvidence(await cycleRepository.readStage(context.cycleId, 'purchase'), open);
  const epicDecision = await readCompletedSellDecision({ cycleRepository, context, open });
  return buybackRequest({ open, epicDecision });
}

function exactPositiveDeltaEntry(entries, owner, asset, tokenAccount = null) {
  const credits = entries.filter(entry => entry.owner === owner && entry.mint === asset.assetId
    && (tokenAccount === null || entry.tokenAccount === tokenAccount)
    && BigInt(entry.postAmount) > BigInt(entry.preAmount));
  if (credits.length !== 1) return null;
  const [entry] = credits;
  return {
    entry,
    proceeds: typedAmount(asset, BigInt(entry.postAmount) - BigInt(entry.preAmount), 'buyback proceeds'),
  };
}

async function cardLeftOperator({ adapters, signature, mint, owner, assetKind }) {
  if (assetKind === 'mpl-core') {
    const transfers = await getTransactionMplCoreTransfers(adapters.solana.client, signature, { commitment: 'finalized' });
    if (!transfers.includes(mint)) return false;
    const currentOwner = await readMplCoreAssetOwner(adapters.solana.client, mint, { commitment: 'finalized' });
    return currentOwner !== owner;
  }
  const entries = await getFinalizedTokenBalanceChanges(adapters.solana.client, signature);
  return entries.filter(entry => entry.owner === owner && entry.mint === mint && BigInt(entry.postAmount) < BigInt(entry.preAmount)).length === 1;
}

function emptyLedger(cycleId, asset, proceeds) {
  return {
    schema: 'hookemon.custody-ledger.v1',
    cycleId,
    chainId: asset.chainId,
    assetId: asset.assetId,
    decimals: asset.decimals,
    ...Object.fromEntries(CUSTODY_BUCKETS.map(bucket => [bucket, bucket === 'buybackProceeds' ? proceeds.amountAtomic : '0'])),
  };
}

async function recordProceedsLedger(cycleRepository, cycleId, asset, proceeds) {
  let ledger = emptyLedger(cycleId, asset, proceeds);
  if (typeof cycleRepository.describeCycle === 'function') {
    const state = await cycleRepository.describeCycle(cycleId);
    const existing = state?.custodyLedgers?.get?.(`${asset.chainId}\u0000${asset.assetId}`);
    if (existing) ledger = { ...existing, buybackProceeds: proceeds.amountAtomic };
  }
  await cycleRepository.recordCustodyLedger(cycleId, ledger);
}

export async function prepareBuybackRequest({ cycleRepository, context }) {
  const open = await cycleRepository.readStage(context.cycleId, 'open');
  const heldOpen = heldOpenPosition(open);
  if (heldOpen !== null) return heldBuybackRequest(heldOpen, heldOpen);
  const evidence = openEvidence(open);
  const epicStage = await cycleRepository.readStage(context.cycleId, 'epic-gate');
  const heldPosition = heldEpicPosition(epicStage, evidence);
  if (heldPosition !== null) return heldBuybackRequest(evidence, heldPosition);
  let epicDecision = null;
  try {
    epicDecision = completedSellDecision({ stage: epicStage, open: evidence, cycleId: context.cycleId });
  } catch (error) {
    if (!(error instanceof EpicDecisionRefusal)) throw error;
  }
  return buybackRequest({ open: evidence, epicDecision });
}

export async function probeBuyback({ adapters, config, cycleRepository, context }) {
  const open = await cycleRepository.readStage(context.cycleId, 'open');
  if (!adapters.collectorCrypt || open.status !== 'COMPLETE' || !open.evidence?.mint) {
    return { wouldBuyback: true, configured: false, reason: 'collector-crypt client is not configured, or the open stage has not recorded a card asset' };
  }
  const available = await adapters.collectorCrypt.getBuybackAvailable({ nft: open.evidence.mint, wallet: config.accounts.solana ?? undefined });
  return { wouldBuyback: true, configured: true, mint: open.evidence.mint, available };
}

export async function mutateBuyback({ liveMode, adapters, config, signerClient, cycleRepository, context, request }) {
  if (liveMode !== true) throw new Error('stage-driver internal error: mutateBuyback reached without liveMode');
  let prepared = request ?? context?.request ?? await prepareBuybackRequest({ cycleRepository, context });
  if (prepared?.decision === 'held') {
    const openStage = await cycleRepository.readStage(context.cycleId, 'open');
    const heldOpen = heldOpenPosition(openStage);
    if (heldOpen !== null) {
      assertHeldBuybackRequest(prepared, heldOpen, heldOpen);
      return heldBuybackEvidence(heldOpen);
    }
    const open = openEvidence(openStage);
    const heldPosition = heldEpicPosition(await cycleRepository.readStage(context.cycleId, 'epic-gate'), open);
    if (heldPosition === null) throw new Error('buyback prepared held request has no completed held epic position');
    assertHeldBuybackRequest(prepared, open, heldPosition);
    return heldBuybackEvidence(heldPosition);
  }
  if (!adapters?.collectorCrypt) throw new Error('buyback requires a configured collector-crypt client');
  try {
    const asset = configuredSettlementAsset(config);
    const money = assertSolanaSignerMoneyConfiguration({ config, asset, stage: 'buyback' });
    const open = openEvidence(await cycleRepository.readStage(context.cycleId, 'open'));
    const epicDecision = await readCompletedSellDecision({ cycleRepository, context, open });
    assertPreparedBuybackRequest(prepared, epicDecision);
    if (!sameAsset(epicDecision.offer, asset) || !sameAsset(epicDecision.insuredValue, asset)) {
      refuseEpicDecision('HELD_DATA_UNVERIFIED', { memo: prepared.memo, mint: prepared.mint }, 'completed epic-gate amounts use an unexpected settlement asset');
    }
    const proceedsAccount = dedicatedProceedsAccount(config);
    const account = await readAssociatedTokenAccount(adapters.solana.client, config.accounts.solana, asset.assetId);
    if (!account.exists || account.decimals !== asset.decimals) throw new Error('buyback requires a matching operator settlement token account');
    if (proceedsAccount !== null && account.address !== proceedsAccount) {
      throw new Error('buyback dedicated proceeds account is not the verified operator settlement token account');
    }
    const available = await adapters.collectorCrypt.getBuybackAvailable({ nft: prepared.mint, wallet: config.accounts.solana });
    if (!available.available) {
      return hold(cycleRepository, config, context, 'HELD_UNAVAILABLE', {
        stage: 'buyback', memo: prepared.memo, mint: prepared.mint, insuredValue: epicDecision.insuredValue, reason: 'buyback is unavailable',
      });
    }
    let quote;
    try {
      quote = typedBuybackAmount(available.amount, 'buyback quote');
    } catch {
      refuseEpicDecision('HELD_DATA_UNVERIFIED', { memo: prepared.memo, mint: prepared.mint }, 'buyback quote is invalid');
    }
    if (!sameAmount(quote, epicDecision.offer)) {
      refuseEpicDecision('HELD_DATA_UNVERIFIED', { memo: prepared.memo, mint: prepared.mint, quote, epicDecision }, 'buyback quote differs from the completed epic decision');
    }
    requireCollectorOnlyMutationAuthority(config);
    const built = await adapters.collectorCrypt.buyback(buildCollectorBuybackRequest({ config, mint: prepared.mint }));
    let refundAmount;
    try {
      refundAmount = typedBuybackAmount(built.refundAmount, 'buyback refund amount');
    } catch {
      return hold(cycleRepository, config, context, 'HELD_DATA_UNVERIFIED', {
        stage: 'buyback', memo: prepared.memo, mint: prepared.mint, quote, built, insuredValue: epicDecision.insuredValue, reason: 'provider buyback response has an invalid refund amount',
      });
    }
    if (built.memo !== prepared.memo || !sameAmount(refundAmount, quote)) {
      return hold(cycleRepository, config, context, 'HELD_DATA_UNVERIFIED', {
        stage: 'buyback', memo: prepared.memo, mint: prepared.mint, quote, built, insuredValue: epicDecision.insuredValue, reason: 'provider buyback response did not bind the quote and memo',
      });
    }
    const { signer, signed } = await decodeAndSign({
      transaction: built.serializedTransaction,
      mint: prepared.mint,
      adapters,
      config,
      money,
      signerClient,
      beforeSign: async () => {
        await context.assertLease?.();
        const currentOpen = openEvidence(await cycleRepository.readStage(context.cycleId, 'open'));
        const currentDecision = await readCompletedSellDecision({ cycleRepository, context, open: currentOpen });
        assertPreparedBuybackRequest(prepared, currentDecision);
        if (!sameAmount(quote, currentDecision.offer)) {
          refuseEpicDecision('HELD_DATA_UNVERIFIED', { memo: prepared.memo, mint: prepared.mint, quote, currentDecision }, 'buyback quote changed before signing');
        }
      },
    });
    const submitted = await signer.broadcast(signed);
    return {
      memo: prepared.memo,
      mint: prepared.mint,
      signature: submitted.signature,
      quote,
      refundAmount,
      ...(proceedsAccount === null ? {} : { proceedsAccount }),
    };
  } catch (error) {
    if (!(error instanceof EpicDecisionRefusal)) throw error;
    const memo = error.evidence.memo ?? prepared?.memo;
    const mint = error.evidence.mint ?? prepared?.mint;
    return hold(cycleRepository, config, context, error.terminalState, { ...error.evidence, memo, mint });
  }
}

async function reconcileBuybackEvidence({ adapters, config, cycleRepository, context, evidence, proceedsAccount, check: recordedCheck = undefined }) {
  const asset = configuredSettlementAsset(config);
  let quote;
  let refundAmount;
  try {
    quote = typedBuybackAmount(evidence.quote, 'recorded buyback quote');
    refundAmount = typedBuybackAmount(evidence.refundAmount, 'recorded buyback refund amount');
  } catch {
    return hold(cycleRepository, config, context, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', ...evidence, reason: 'recorded buyback amount is invalid',
    });
  }
  if (!sameAsset(quote, asset) || !sameAmount(quote, refundAmount)) {
    return hold(cycleRepository, config, context, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', ...evidence, reason: 'recorded buyback amounts do not bind the settlement quote',
    });
  }
  let check = recordedCheck;
  if (check === undefined) {
    if (typeof adapters.collectorCrypt.getBuybackCheck !== 'function') return null;
    try {
      check = await adapters.collectorCrypt.getBuybackCheck({ memo: evidence.memo });
    } catch {
      return null;
    }
  }
  if (!plainObject(check) || typeof check.exists !== 'boolean') {
    return hold(cycleRepository, config, context, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', ...evidence, check, reason: 'buyback check response is invalid',
    });
  }
  if (!check.exists) return null;
  if (typeof check.status !== 'string') {
    return hold(cycleRepository, config, context, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', ...evidence, check, reason: 'buyback check status is invalid',
    });
  }
  if (check.status === '') return null;
  if (check.status !== 'complete') {
    return hold(cycleRepository, config, context, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', ...evidence, check, reason: 'buyback check status is not a documented pending or complete value',
    });
  }
  let checkedQuote;
  try {
    checkedQuote = typedAmount(asset, check.buybackAmount, 'completed buyback amount');
  } catch {
    return hold(cycleRepository, config, context, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', ...evidence, check, reason: 'completed buyback amount is invalid',
    });
  }
  if (check.playerWallet !== config.accounts.solana || check.nft !== evidence.mint
    || check.transactionSignature !== evidence.signature || typeof check.createdAt !== 'string' || check.createdAt.length === 0
    || !sameAmount(checkedQuote, quote)) {
    return hold(cycleRepository, config, context, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', ...evidence, check, checkedQuote, reason: 'completed buyback check does not bind the memo, signature, card, and quote',
    });
  }
  let status;
  try {
    status = await readFinalizedSignatureStatus(adapters.solana.client, evidence.signature);
  } catch {
    return null;
  }
  if (status === null) return null;
  if (status.err) {
    return hold(cycleRepository, config, context, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', ...evidence, signatureStatus: status,
    });
  }
  const open = await cycleRepository.readStage(context.cycleId, 'open');
  const assetKind = open.evidence?.assetKind ?? 'spl';
  let leftOperator;
  let entries;
  try {
    leftOperator = await cardLeftOperator({ adapters, signature: evidence.signature, mint: evidence.mint, owner: config.accounts.solana, assetKind });
    entries = await getFinalizedTokenBalanceChanges(adapters.solana.client, evidence.signature);
  } catch {
    return null;
  }
  const proceedsEntry = exactPositiveDeltaEntry(entries, config.accounts.solana, asset, proceedsAccount);
  const proceeds = proceedsEntry?.proceeds ?? null;
  if (!leftOperator || proceeds === null || !sameAmount(proceeds, quote)) {
    return hold(cycleRepository, config, context, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', ...evidence, leftOperator, proceeds, reason: 'finalized card and settlement deltas did not match',
    });
  }
  await recordProceedsLedger(cycleRepository, context.cycleId, asset, proceeds);
  if (proceedsAccount === null) return { ...evidence, proceeds };
  return {
    ...evidence,
    proceeds,
    proceedsProjection: {
      account: proceedsAccount,
      beforeAtomic: proceedsEntry.entry.preAmount,
      afterAtomic: proceedsEntry.entry.postAmount,
      delta: proceeds,
    },
  };
}

async function reconcileSentUnknownBuyback({ adapters, config, cycleRepository, context, record, proceedsAccount }) {
  if (record?.attempt?.state !== 'SENT_UNKNOWN') return null;
  if (sentUnknownPastDeadline(record, config, context)) {
    return holdPastDeadlineSentUnknown({ cycleRepository, config, context, record });
  }
  let request;
  try {
    request = await readSentUnknownBuybackRequest({ cycleRepository, context });
  } catch (error) {
    const terminalState = error instanceof EpicDecisionRefusal ? error.terminalState : 'HELD_DATA_UNVERIFIED';
    return hold(cycleRepository, config, context, terminalState, {
      stage: 'buyback',
      reason: 'sent-unknown buyback does not have a complete durable purchase, open, and sell decision context',
      detail: error.message,
    });
  }
  if (!requestMatchesSentUnknownAttempt({ attempt: record.attempt, context, request })) {
    return hold(cycleRepository, config, context, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback',
      memo: request.memo,
      mint: request.mint,
      reason: 'sent-unknown buyback attempt does not bind the completed durable request',
    });
  }
  if (typeof adapters.collectorCrypt.getBuybackCheck !== 'function') return null;
  let check;
  try {
    check = await adapters.collectorCrypt.getBuybackCheck({ memo: request.memo });
  } catch {
    return null;
  }
  if (!plainObject(check) || typeof check.exists !== 'boolean') {
    return hold(cycleRepository, config, context, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback',
      memo: request.memo,
      mint: request.mint,
      check,
      reason: 'sent-unknown buyback check response is invalid',
    });
  }
  if (!check.exists) return null;
  if (typeof check.status !== 'string') {
    return hold(cycleRepository, config, context, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback',
      memo: request.memo,
      mint: request.mint,
      check,
      reason: 'sent-unknown buyback check status is invalid',
    });
  }
  if (check.status === '') return null;
  if (check.status !== 'complete') {
    return hold(cycleRepository, config, context, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback',
      memo: request.memo,
      mint: request.mint,
      check,
      reason: 'sent-unknown buyback check status is not a documented pending or complete value',
    });
  }
  const evidence = responseEvidence({
    responseEvidence: {
      memo: request.memo,
      mint: request.mint,
      signature: check.transactionSignature,
      quote: request.epicDecision.offer,
      refundAmount: request.epicDecision.offer,
      ...(proceedsAccount === null ? {} : { proceedsAccount }),
    },
  }, proceedsAccount);
  if (evidence === null) {
    return hold(cycleRepository, config, context, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback',
      memo: request.memo,
      mint: request.mint,
      check,
      reason: 'completed sent-unknown buyback check cannot produce canonical reconciliation evidence',
    });
  }
  return reconcileBuybackEvidence({ adapters, config, cycleRepository, context, evidence, proceedsAccount, check });
}

export async function reconcileLiveBuyback({ adapters, config, cycleRepository, context }) {
  const proceedsAccount = dedicatedProceedsAccount(config);
  const record = await cycleRepository.readOperationalStageAttempt(context.cycleId, 'buyback');
  const evidence = responseEvidence(record, proceedsAccount);
  if (evidence?.decision === 'held') return evidence;
  if (sentUnknownPastDeadline(record, config, context)) {
    return holdPastDeadlineSentUnknown({ cycleRepository, config, context, record });
  }
  if (!adapters?.collectorCrypt || !adapters?.solana?.client) return null;
  if (evidence === null) {
    return reconcileSentUnknownBuyback({ adapters, config, cycleRepository, context, record, proceedsAccount });
  }
  return reconcileBuybackEvidence({ adapters, config, cycleRepository, context, evidence, proceedsAccount });
}
