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
import { OPERATOR_SOLANA_ROLE, wrapTransactionPolicySignerClient } from '../../signing/signer-client.mjs';
import { digest } from '../../../../runner/src/cycle/journal.mjs';
import { requireLiveMutationAuthority } from '../../../../runner/src/cycle/preflight.mjs';
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
const CUSTODY_BUCKETS = Object.freeze([
  'claimed', 'bridgeOut', 'bridgeIn', 'packCost', 'buybackProceeds', 'returnInput', 'returnReceived',
  'refunds', 'residual', 'heldAssets', 'payoutLiability', 'dust', 'unattributed',
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

function configuredBuyback(config) {
  const value = config?.collectorCrypt?.buyback;
  if (!plainObject(value) || !plainObject(value.policy)
    || typeof value.collectorProgramId !== 'string' || value.collectorProgramId.length === 0
    || typeof value.collectorRecipient !== 'string' || value.collectorRecipient.length === 0) {
    throw new Error('buyback requires a pinned policy, Collector program id, and Collector recipient');
  }
  return value;
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

async function hold(cycleRepository, context, terminalState, evidence) {
  if (typeof cycleRepository?.holdCycle !== 'function') throw new Error('buyback requires cycleRepository.holdCycle');
  await cycleRepository.holdCycle(context.cycleId, terminalState, evidence);
}

function responseEvidence(record) {
  const evidence = record?.responseEvidence;
  if (!plainObject(evidence) || typeof evidence.memo !== 'string' || typeof evidence.mint !== 'string'
    || typeof evidence.signature !== 'string' || !plainObject(evidence.quote) || !plainObject(evidence.refundAmount)) return null;
  try {
    const quote = typedBuybackAmount(evidence.quote, 'recorded buyback quote');
    const refundAmount = typedBuybackAmount(evidence.refundAmount, 'recorded buyback refund amount');
    if (!sameAmount(quote, refundAmount)) return null;
  } catch {
    return null;
  }
  return evidence;
}

function decodedBindsBuyback({ decoded, owner, mint, buyback }) {
  const hasOwner = decoded.feePayer === owner && decoded.requiredSigners.includes(owner);
  const hasProgram = decoded.programIds.includes(buyback.collectorProgramId);
  const hasRecipient = decoded.destination === buyback.collectorRecipient
    || decoded.instructions.some(instruction => instruction.accounts.some(account => account.address === buyback.collectorRecipient));
  const hasMint = decoded.mint === mint
    || decoded.instructions.some(instruction => instruction.mint === mint || instruction.accounts.some(account => account.address === mint));
  if (!hasOwner) throw new Error('buyback provider transaction does not bind the operator wallet as fee payer and signer');
  if (!hasProgram || !hasRecipient) throw new Error('buyback provider transaction does not bind the configured Collector program and recipient');
  if (!hasMint) throw new Error('buyback provider transaction does not bind the opened asset');
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
  decodedBindsBuyback({ decoded, owner: config.accounts.solana, mint, buyback });
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
        requireLiveMutationAuthority();
        return signerClient.solana.sign(request);
      },
    },
    policy: buyback.policy,
    decodeOptions,
    broadcast: async signed => {
      if (!(await readBlockhashValidity(adapters.solana.client, decoded.blockhash))) {
        throw new Error('buyback provider transaction blockhash expired before submission');
      }
      requireLiveMutationAuthority();
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

function exactPositiveDelta(entries, owner, asset) {
  const credits = entries.filter(entry => entry.owner === owner && entry.mint === asset.assetId && BigInt(entry.postAmount) > BigInt(entry.preAmount));
  if (credits.length !== 1) return null;
  return typedAmount(asset, BigInt(credits[0].postAmount) - BigInt(credits[0].preAmount), 'buyback proceeds');
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
  const evidence = openEvidence(open);
  let epicDecision = null;
  try {
    epicDecision = await readCompletedSellDecision({ cycleRepository, context, open: evidence });
  } catch (error) {
    if (!(error instanceof EpicDecisionRefusal)) throw error;
  }
  return { provider: 'collector-crypt', operation: 'buyback', memo: evidence.memo, mint: evidence.mint, epicDecision };
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
  if (!adapters?.collectorCrypt) throw new Error('buyback requires a configured collector-crypt client');
  let prepared;
  try {
    prepared = request ?? context?.request ?? await prepareBuybackRequest({ cycleRepository, context });
    const asset = configuredSettlementAsset(config);
    const money = assertSolanaSignerMoneyConfiguration({ config, asset, stage: 'buyback' });
    const open = openEvidence(await cycleRepository.readStage(context.cycleId, 'open'));
    const epicDecision = await readCompletedSellDecision({ cycleRepository, context, open });
    assertPreparedBuybackRequest(prepared, epicDecision);
    if (!sameAsset(epicDecision.offer, asset) || !sameAsset(epicDecision.insuredValue, asset)) {
      refuseEpicDecision('HELD_DATA_UNVERIFIED', { memo: prepared.memo, mint: prepared.mint }, 'completed epic-gate amounts use an unexpected settlement asset');
    }
    const account = await readAssociatedTokenAccount(adapters.solana.client, config.accounts.solana, asset.assetId);
    if (!account.exists || account.decimals !== asset.decimals) throw new Error('buyback requires a matching operator settlement token account');
    const available = await adapters.collectorCrypt.getBuybackAvailable({ nft: prepared.mint, wallet: config.accounts.solana });
    if (!available.available) {
      await hold(cycleRepository, context, 'HELD_UNAVAILABLE', { stage: 'buyback', memo: prepared.memo, mint: prepared.mint, reason: 'buyback is unavailable' });
      return { memo: prepared.memo, mint: prepared.mint, decision: 'held', terminalState: 'HELD_UNAVAILABLE' };
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
    requireLiveMutationAuthority();
    const built = await adapters.collectorCrypt.buyback({ playerAddress: config.accounts.solana, nftAddress: prepared.mint });
    let refundAmount;
    try {
      refundAmount = typedBuybackAmount(built.refundAmount, 'buyback refund amount');
    } catch {
      await hold(cycleRepository, context, 'HELD_DATA_UNVERIFIED', { stage: 'buyback', memo: prepared.memo, mint: prepared.mint, quote, built, reason: 'provider buyback response has an invalid refund amount' });
      return { memo: prepared.memo, mint: prepared.mint, decision: 'held', terminalState: 'HELD_DATA_UNVERIFIED' };
    }
    if (built.memo !== prepared.memo || !sameAmount(refundAmount, quote)) {
      await hold(cycleRepository, context, 'HELD_DATA_UNVERIFIED', { stage: 'buyback', memo: prepared.memo, mint: prepared.mint, quote, built, reason: 'provider buyback response did not bind the quote and memo' });
      return { memo: prepared.memo, mint: prepared.mint, decision: 'held', terminalState: 'HELD_DATA_UNVERIFIED' };
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
    return { memo: prepared.memo, mint: prepared.mint, signature: submitted.signature, quote, refundAmount };
  } catch (error) {
    if (!(error instanceof EpicDecisionRefusal)) throw error;
    const memo = error.evidence.memo ?? prepared?.memo;
    const mint = error.evidence.mint ?? prepared?.mint;
    await hold(cycleRepository, context, error.terminalState, error.evidence);
    return { memo, mint, decision: 'held', terminalState: error.terminalState };
  }
}

export async function reconcileLiveBuyback({ adapters, config, cycleRepository, context }) {
  const evidence = responseEvidence(await cycleRepository.readOperationalStageAttempt(context.cycleId, 'buyback'));
  if (!evidence || !adapters?.collectorCrypt || !adapters?.solana?.client) return null;
  const asset = configuredSettlementAsset(config);
  let quote;
  let refundAmount;
  try {
    quote = typedBuybackAmount(evidence.quote, 'recorded buyback quote');
    refundAmount = typedBuybackAmount(evidence.refundAmount, 'recorded buyback refund amount');
  } catch {
    await hold(cycleRepository, context, 'HELD_DATA_UNVERIFIED', { stage: 'buyback', ...evidence, reason: 'recorded buyback amount is invalid' });
    return null;
  }
  if (!sameAsset(quote, asset) || !sameAmount(quote, refundAmount)) {
    await hold(cycleRepository, context, 'HELD_DATA_UNVERIFIED', { stage: 'buyback', ...evidence, reason: 'recorded buyback amounts do not bind the settlement quote' });
    return null;
  }
  if (typeof adapters.collectorCrypt.getBuybackCheck !== 'function') return null;
  let check;
  try {
    check = await adapters.collectorCrypt.getBuybackCheck({ memo: evidence.memo });
  } catch {
    return null;
  }
  if (!plainObject(check) || typeof check.exists !== 'boolean') {
    await hold(cycleRepository, context, 'HELD_DATA_UNVERIFIED', { stage: 'buyback', ...evidence, check, reason: 'buyback check response is invalid' });
    return null;
  }
  if (!check.exists) return null;
  if (typeof check.status !== 'string') {
    await hold(cycleRepository, context, 'HELD_DATA_UNVERIFIED', { stage: 'buyback', ...evidence, check, reason: 'buyback check status is invalid' });
    return null;
  }
  if (check.status === '') return null;
  if (check.status !== 'complete') {
    await hold(cycleRepository, context, 'HELD_DATA_UNVERIFIED', { stage: 'buyback', ...evidence, check, reason: 'buyback check status is not a documented pending or complete value' });
    return null;
  }
  let checkedQuote;
  try {
    checkedQuote = typedAmount(asset, check.buybackAmount, 'completed buyback amount');
  } catch {
    await hold(cycleRepository, context, 'HELD_DATA_UNVERIFIED', { stage: 'buyback', ...evidence, check, reason: 'completed buyback amount is invalid' });
    return null;
  }
  if (check.playerWallet !== config.accounts.solana || check.nft !== evidence.mint
    || check.transactionSignature !== evidence.signature || typeof check.createdAt !== 'string' || check.createdAt.length === 0
    || !sameAmount(checkedQuote, quote)) {
    await hold(cycleRepository, context, 'HELD_DATA_UNVERIFIED', { stage: 'buyback', ...evidence, check, checkedQuote, reason: 'completed buyback check does not bind the memo, signature, card, and quote' });
    return null;
  }
  let status;
  try {
    status = await readFinalizedSignatureStatus(adapters.solana.client, evidence.signature);
  } catch {
    return null;
  }
  if (status === null) return null;
  if (status.err) {
    await hold(cycleRepository, context, 'HELD_DATA_UNVERIFIED', { stage: 'buyback', ...evidence, signatureStatus: status });
    return null;
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
  const proceeds = exactPositiveDelta(entries, config.accounts.solana, asset);
  if (!leftOperator || proceeds === null || !sameAmount(proceeds, quote)) {
    await hold(cycleRepository, context, 'HELD_DATA_UNVERIFIED', { stage: 'buyback', ...evidence, leftOperator, proceeds, reason: 'finalized card and settlement deltas did not match' });
    return null;
  }
  await recordProceedsLedger(cycleRepository, context.cycleId, asset, proceeds);
  return { ...evidence, proceeds };
}
