import { assertTypedAmount } from '../../../../runner/src/cycle/money-schemas.mjs';
import { COLLECTOR_CRYPT_SETTLEMENT_ASSET } from '../../collector-crypt.mjs';
import { heldPackIdForMemo } from './held-pack.mjs';

const DOCUMENTED_PRIZE_TIER_RARITIES = Object.freeze({
  1: 'epic',
  2: 'rare',
  3: 'uncommon',
  4: 'common',
});
const canonicalUnsignedInteger = /^(0|[1-9][0-9]*)$/;
const INSURED_VALUE_UNITS = new Set(['whole-usd', 'atomic']);
const WHOLE_USD_ATOMIC_SCALE = 1_000_000n;
const MINIMUM_INSTANT_BUYBACK_PERCENT = 85;
const MAXIMUM_INSTANT_BUYBACK_PERCENT = 94;

class InsuredValueReconciliationError extends Error {}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function atomicString(value, label) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  throw new Error(`${label} must be a documented non-negative integer number`);
}

function prizeTierString(value, label) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'string' && canonicalUnsignedInteger.test(value)) return value;
  throw new Error(`${label} must be a documented numeric prize tier`);
}

function documentedRarity(value, label) {
  if (typeof value !== 'string' || !Object.values(DOCUMENTED_PRIZE_TIER_RARITIES).includes(value)) {
    throw new Error(`${label} must be a documented rarity`);
  }
  return value;
}

function sameAsset(left, right) {
  return left?.chainId === right?.chainId
    && left?.assetId === right?.assetId
    && left?.decimals === right?.decimals;
}

function configuredEpicGate(config) {
  const value = config?.collectorCrypt?.epicGate;
  if (!plainObject(value)) throw new Error('epic gate requires explicit Collector field configuration');
  for (const field of ['nftAddressField', 'insuredValueField', 'prizeTierField', 'rarityField']) {
    if (typeof value[field] !== 'string' || value[field].length === 0) throw new Error(`epic gate ${field} must be configured`);
  }
  if (!plainObject(value.asset)
    || typeof value.asset.chainId !== 'string' || value.asset.chainId.length === 0
    || typeof value.asset.assetId !== 'string' || value.asset.assetId.length === 0
    || !Number.isInteger(value.asset.decimals) || value.asset.decimals < 0 || value.asset.decimals > 255) {
    throw new Error('epic gate asset must be configured with chainId, assetId, and decimals');
  }
  if (value.asset.chainId !== config?.solana?.chainId) throw new Error('epic gate asset chainId must match config.solana.chainId');
  const settlementAsset = config?.collectorCrypt?.settlementAsset;
  if (!plainObject(settlementAsset)
    || typeof settlementAsset.chainId !== 'string' || settlementAsset.chainId.length === 0
    || typeof settlementAsset.assetId !== 'string' || settlementAsset.assetId.length === 0
    || !Number.isInteger(settlementAsset.decimals) || settlementAsset.decimals < 0 || settlementAsset.decimals > 255) {
    throw new Error('epic gate requires a configured settlementAsset');
  }
  if (value.asset.chainId !== settlementAsset.chainId
    || value.asset.assetId !== settlementAsset.assetId
    || value.asset.decimals !== settlementAsset.decimals) {
    throw new Error('epic gate insured-value asset must match the configured settlementAsset');
  }
  if (!sameAsset(value.asset, COLLECTOR_CRYPT_SETTLEMENT_ASSET)) {
    throw new Error('epic gate settlement asset must match the documented Solana buyback asset');
  }
  return value;
}

function typedBuybackAmount(value, label) {
  const amount = assertTypedAmount(value, label);
  if (!sameAsset(amount, COLLECTOR_CRYPT_SETTLEMENT_ASSET)) {
    throw new Error(`${label} must use the documented Solana buyback asset`);
  }
  return amount;
}

function instantBuybackPercent(machine) {
  const value = machine?.instantBuyback;
  if (!Number.isSafeInteger(value)
    || value < MINIMUM_INSTANT_BUYBACK_PERCENT
    || value > MAXIMUM_INSTANT_BUYBACK_PERCENT) {
    throw new Error('Collector machine instantBuyback must be a documented percentage');
  }
  return value;
}

async function findPackMachine({ collectorCrypt, packCode }) {
  const catalog = await collectorCrypt.getMachines();
  if (!plainObject(catalog) || !Array.isArray(catalog.machines)) {
    throw new Error('Collector machines response does not match the configured provider shape');
  }
  const matches = catalog.machines.filter(machine => plainObject(machine) && machine.code === packCode);
  if (matches.length !== 1) throw new Error('Collector pack machine is missing or ambiguous');
  return { instantBuybackPercent: instantBuybackPercent(matches[0]) };
}

function matchingBuybackPercent({ offerAtomic, insuredAtomic, instantBuyback }) {
  const matches = [];
  for (let percent = instantBuyback - 1; percent <= instantBuyback + 1; percent += 1) {
    if (percent < 0 || percent > 100) continue;
    if ((insuredAtomic * BigInt(percent)) / 100n === offerAtomic) matches.push(percent);
  }
  return matches;
}

function reconcileInsuredValueUnit({ asset, rawInsuredValue, offer, instantBuyback }) {
  const raw = BigInt(rawInsuredValue);
  const candidates = [
    { unit: 'whole-usd', amountAtomic: raw * WHOLE_USD_ATOMIC_SCALE },
    { unit: 'atomic', amountAtomic: raw },
  ].map(candidate => ({
    ...candidate,
    matchingPercentages: matchingBuybackPercent({
      offerAtomic: BigInt(offer.amountAtomic),
      insuredAtomic: candidate.amountAtomic,
      instantBuyback,
    }),
  })).filter(candidate => candidate.matchingPercentages.length > 0);
  if (candidates.length !== 1) {
    throw new InsuredValueReconciliationError('Collector insured-value unit does not reconcile to exactly one documented candidate');
  }
  const candidate = candidates[0];
  return {
    insuredValue: assertTypedAmount({ ...asset, amountAtomic: candidate.amountAtomic.toString() }, 'reconciled epic insured value'),
    insuredValueUnit: candidate.unit,
    matchedBuybackPercent: candidate.matchingPercentages.includes(instantBuyback)
      ? instantBuyback
      : candidate.matchingPercentages[0],
  };
}

function heldPositionReason(terminalState) {
  if (terminalState === 'HELD_UNAVAILABLE') return 'BUYBACK_UNAVAILABLE';
  return 'DATA_UNVERIFIED';
}

function heldPositionValueMicroUsd(costMicroUsd) { return costMicroUsd; }



function optionalTypedAmount(value) {
  try {
    return assertTypedAmount(value, 'held epic insured value');
  } catch {
    return null;
  }
}

async function recordHeldEpicPosition({ cycleRepository, config, context, packIndex, memo, mint, terminalState, reason, insuredValue = null, evidence }) {
  if (typeof cycleRepository?.recordHeldPosition !== 'function') {
    throw new Error('epic gate requires cycleRepository.recordHeldPosition');
  }
  if (typeof cycleRepository.describeCycle !== 'function') {
    throw new Error('epic gate requires cycleRepository.describeCycle for held-card attribution');
  }
  const description = await cycleRepository.describeCycle(context.cycleId);
  const costMicroUsd = description?.admission?.aggregateFundingUsd?.amountMicroUsd;
  if (typeof costMicroUsd !== 'string' || !canonicalUnsignedInteger.test(costMicroUsd)) {
    throw new Error('epic gate cannot attribute a held card without the committed USD purchase cost');
  }
  const packId = await heldPackIdForMemo({ cycleRepository, cycleId: context.cycleId, memo, config });
  if (typeof packId !== 'string' || packId.length === 0) {
    throw new Error('epic gate cannot attribute a held card without a pack identifier');
  }
  const verifiedInsuredValue = optionalTypedAmount(insuredValue);
  const position = await cycleRepository.recordHeldPosition(context.cycleId, {
    packId,
    memo,
    mint,
    cardRef: mint,
    costMicroUsd,
    valueMicroUsd: heldPositionValueMicroUsd(costMicroUsd, verifiedInsuredValue, config),
    insuredValue: verifiedInsuredValue,
    reason,
    terminalState,
    evidence,
  });
  return {
    packIndex,
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

async function findMintCard({ collectorCrypt, packCode, mint, gate }) {
  const candidates = [];
  const limit = 50;
  for (let page = 1; ; page += 1) {
    const listed = await collectorCrypt.getNfts({
      ...(packCode === undefined ? {} : { code: packCode }),
      page,
      limit,
    });
    if (!plainObject(listed) || !Array.isArray(listed.nfts)
      || listed.page !== page || listed.limit !== limit || typeof listed.hasMore !== 'boolean') {
      throw new Error('Collector getNfts pagination response does not match the configured provider shape');
    }
    for (const card of listed.nfts) {
      if (plainObject(card) && card[gate.nftAddressField] === mint) candidates.push(card);
    }
    if (!listed.hasMore) return candidates;
    if (page >= Number.MAX_SAFE_INTEGER) throw new Error('Collector getNfts pagination exceeded the safe page range');
  }
}

async function evaluateLiveGate({ adapters, config, memo, mint }) {
  const gate = configuredEpicGate(config);
  if (!adapters?.collectorCrypt) throw new Error('epic gate requires a configured collector-crypt client');
  const packStatus = await adapters.collectorCrypt.getPackStatus({ memo });
  if (packStatus.memo !== memo || !plainObject(packStatus.send) || packStatus.send[gate.nftAddressField] !== mint) {
    return { held: true, terminalState: 'HELD_DATA_UNVERIFIED', evidence: { stage: 'epic-gate', memo, mint, packStatus, reason: 'pack status does not bind the opened card asset' } };
  }
  if (!plainObject(packStatus.pack) || typeof packStatus.pack.pack_type !== 'string' || packStatus.pack.pack_type.length === 0) {
    throw new Error('Collector pack status does not include a documented pack type');
  }
  const packCode = packStatus.pack.pack_type;
  const candidates = await findMintCard({ collectorCrypt: adapters.collectorCrypt, packCode, mint, gate });
  if (candidates.length !== 1) {
    return { held: true, terminalState: 'HELD_DATA_UNVERIFIED', evidence: { stage: 'epic-gate', memo, mint, reason: 'card record is missing or ambiguous', candidateCount: candidates.length } };
  }
  const card = candidates[0];
  const prizeTier = prizeTierString(packStatus.send[gate.prizeTierField], 'epic gate prize tier');
  const expectedRarity = DOCUMENTED_PRIZE_TIER_RARITIES[prizeTier];
  const cardRarity = documentedRarity(card[gate.rarityField], 'epic gate card rarity');
  const sendRarity = packStatus.send[gate.rarityField] === undefined
    ? null
    : documentedRarity(packStatus.send[gate.rarityField], 'epic gate status rarity');
  if (expectedRarity === undefined || cardRarity !== expectedRarity || (sendRarity !== null && sendRarity !== expectedRarity)) {
    return {
      held: true,
      terminalState: 'HELD_DATA_UNVERIFIED',
      evidence: {
        stage: 'epic-gate', memo, mint, prizeTier, rarity: cardRarity, statusRarity: sendRarity,
        reason: 'documented prize-tier mapping does not match the card rarity',
      },
    };
  }
  const rawInsuredValue = atomicString(packStatus.send[gate.insuredValueField], 'epic insured value');
  const cardRawInsuredValue = atomicString(card[gate.insuredValueField], 'card insured value');
  if (rawInsuredValue !== cardRawInsuredValue) {
    return { held: true, terminalState: 'HELD_DATA_UNVERIFIED', evidence: { stage: 'epic-gate', memo, mint, rawInsuredValue, cardRawInsuredValue, reason: 'memo status and card insured values disagree' } };
  }
  const machine = await findPackMachine({ collectorCrypt: adapters.collectorCrypt, packCode });
  const quote = await adapters.collectorCrypt.getBuybackAvailable({ nft: mint, wallet: config.accounts.solana });
  if (!plainObject(quote) || typeof quote.available !== 'boolean') {
    throw new Error('Collector buyback availability response does not match the configured provider shape');
  }
  if (!quote.available) {
    return { held: true, terminalState: 'HELD_UNAVAILABLE', evidence: { stage: 'epic-gate', memo, mint, rawInsuredValue, reason: 'buyback is unavailable' } };
  }
  const offer = typedBuybackAmount(quote.amount, 'epic buyback offer');
  if (!sameAsset(offer, gate.asset)) throw new Error('epic buyback offer does not match the configured settlement asset');
  const reconciliation = reconcileInsuredValueUnit({
    asset: gate.asset,
    rawInsuredValue,
    offer,
    instantBuyback: machine.instantBuybackPercent,
  });
  const belowFortyPercent = prizeTier === '1'
    && BigInt(offer.amountAtomic) * 100n < BigInt(reconciliation.insuredValue.amountAtomic) * 40n;
  return {
    held: false,
    evidence: {
      memo,
      mint,
      offer,
      rawInsuredValue,
      insuredValue: reconciliation.insuredValue,
      insuredValueUnit: reconciliation.insuredValueUnit,
      instantBuybackPercent: machine.instantBuybackPercent,
      matchedBuybackPercent: reconciliation.matchedBuybackPercent,
      prizeTier,
      rarity: expectedRarity,
      decision: belowFortyPercent ? 'hold' : 'sell',
    },
  };
}

function sameQuote(left, right) {
  return left?.chainId === right?.chainId
    && left?.assetId === right?.assetId
    && left?.decimals === right?.decimals
    && left?.amountAtomic === right?.amountAtomic;
}

/** Every open-stage pack, normalized to what epic-gate needs: a pass-through held entry, or a card to gate. */
function openPacks(open) {
  if (open?.status !== 'COMPLETE' || !plainObject(open.evidence) || !Array.isArray(open.evidence.packs)) {
    throw new Error('epic gate requires a completed open stage with a pack ledger');
  }
  return open.evidence.packs;
}

export async function prepareEpicGateRequest({ cycleRepository, context }) {
  const open = await cycleRepository.readStage(context.cycleId, 'open');
  return { provider: 'collector-crypt', operation: 'epic-gate', packs: openPacks(open) };
}

function readComparableAmounts(evidence) {
  try {
    const offer = assertTypedAmount(evidence?.offer, 'open offer');
    const insuredValue = assertTypedAmount(evidence?.insuredValue, 'open insured value');
    if (offer.chainId !== insuredValue.chainId || offer.assetId !== insuredValue.assetId || offer.decimals !== insuredValue.decimals) return null;
    return { offer, insuredValue };
  } catch {
    return null;
  }
}

/** The threshold is strict: equality follows the sell path. */
export async function probeEpicGate({ cycleRepository, context }) {
  const open = await cycleRepository.readStage(context.cycleId, 'open');
  if (open.status === 'COMPLETE' && plainObject(open.evidence) && !Array.isArray(open.evidence.packs)) {
    // A dry-run/rehearsal open evidence fixture may carry a projected single-pack offer and
    // insured value directly, so a probe can preview the sell/hold threshold with no provider call.
    const amounts = readComparableAmounts(open.evidence);
    if (amounts === null) {
      return { wouldEvaluateEpicGate: true, configured: false, reason: 'open evidence does not contain comparable typed offer and insured-value amounts' };
    }
    const belowFortyPercent = BigInt(amounts.offer.amountAtomic) * 100n < BigInt(amounts.insuredValue.amountAtomic) * 40n;
    return {
      wouldEvaluateEpicGate: true,
      configured: true,
      offer: amounts.offer,
      insuredValue: amounts.insuredValue,
      belowFortyPercent,
      nextAction: belowFortyPercent ? 'hold' : 'sell',
    };
  }
  try {
    if (open.status !== 'COMPLETE') throw new Error('open stage has not completed');
    return { wouldEvaluateEpicGate: true, configured: true, packs: openPacks(open) };
  } catch (error) {
    return { wouldEvaluateEpicGate: true, configured: false, reason: error.message };
  }
}

/** Evaluates one already-opened card; a pass-through held pack requires no new evaluation. */
async function gatePack({ adapters, config, cycleRepository, context, pack }) {
  if (pack.decision === 'held') return pack;
  try {
    const result = await evaluateLiveGate({ adapters, config, memo: pack.memo, mint: pack.mint });
    if (result.held) {
      return recordHeldEpicPosition({
        cycleRepository, config, context,
        packIndex: pack.packIndex, memo: pack.memo, mint: pack.mint,
        terminalState: result.terminalState,
        reason: heldPositionReason(result.terminalState),
        insuredValue: result.evidence.insuredValue ?? null,
        evidence: result.evidence,
      });
    }
    if (result.evidence.decision === 'hold') {
      return recordHeldEpicPosition({
        cycleRepository, config, context,
        packIndex: pack.packIndex, memo: pack.memo, mint: pack.mint,
        terminalState: 'HELD_OWNER_DECISION',
        reason: 'EPIC_THRESHOLD',
        insuredValue: result.evidence.insuredValue,
        evidence: { stage: 'epic-gate', ...result.evidence },
      });
    }
    return { packIndex: pack.packIndex, ...result.evidence };
  } catch (error) {
    return recordHeldEpicPosition({
      cycleRepository, config, context,
      packIndex: pack.packIndex, memo: pack.memo, mint: pack.mint,
      terminalState: 'HELD_DATA_UNVERIFIED',
      reason: 'DATA_UNVERIFIED',
      evidence: { stage: 'epic-gate', memo: pack.memo, mint: pack.mint, reason: error.message },
    });
  }
}

export async function mutateEpicGate({ liveMode, adapters, config, cycleRepository, context, request }) {
  if (liveMode !== true) throw new Error('epic-gate mutate reached without live mode');
  const prepared = request ?? context?.request ?? await prepareEpicGateRequest({ cycleRepository, context });
  const outcomes = [];
  for (const pack of prepared.packs) outcomes.push(await gatePack({ adapters, config, cycleRepository, context, pack }));
  return { packs: outcomes };
}

/** Re-verifies a recorded sell decision; a held pack (pass-through or newly carved) is final. */
async function reconcilePack({ adapters, config, cycleRepository, context, recorded }) {
  if (recorded.decision === 'held') return recorded;
  if (recorded.decision === 'hold') {
    return recordHeldEpicPosition({
      cycleRepository, config, context,
      packIndex: recorded.packIndex, memo: recorded.memo, mint: recorded.mint,
      terminalState: 'HELD_OWNER_DECISION',
      reason: 'EPIC_THRESHOLD',
      insuredValue: recorded.insuredValue,
      evidence: { stage: 'epic-gate', ...recorded },
    });
  }
  if (recorded.decision !== 'sell') {
    return recordHeldEpicPosition({
      cycleRepository, config, context,
      packIndex: recorded.packIndex, memo: recorded.memo, mint: recorded.mint,
      terminalState: 'HELD_DATA_UNVERIFIED',
      reason: 'DATA_UNVERIFIED',
      evidence: { stage: 'epic-gate', ...recorded, reason: 'unknown epic decision' },
    });
  }
  let refreshed;
  try {
    refreshed = await evaluateLiveGate({ adapters, config, memo: recorded.memo, mint: recorded.mint });
  } catch (error) {
    return recordHeldEpicPosition({
      cycleRepository, config, context,
      packIndex: recorded.packIndex, memo: recorded.memo, mint: recorded.mint,
      terminalState: 'HELD_DATA_UNVERIFIED',
      reason: 'DATA_UNVERIFIED',
      evidence: { stage: 'epic-gate', memo: recorded.memo, mint: recorded.mint, recorded, reason: error.message },
    });
  }
  if (refreshed.held) {
    return recordHeldEpicPosition({
      cycleRepository, config, context,
      packIndex: recorded.packIndex, memo: recorded.memo, mint: recorded.mint,
      terminalState: refreshed.terminalState,
      reason: heldPositionReason(refreshed.terminalState),
      insuredValue: refreshed.evidence.insuredValue ?? null,
      evidence: refreshed.evidence,
    });
  }
  if (refreshed.evidence.decision !== 'sell' || !sameQuote(recorded.offer, refreshed.evidence.offer)
    || !sameQuote(recorded.insuredValue, refreshed.evidence.insuredValue)
    || recorded.rawInsuredValue !== refreshed.evidence.rawInsuredValue
    || recorded.insuredValueUnit !== refreshed.evidence.insuredValueUnit
    || recorded.instantBuybackPercent !== refreshed.evidence.instantBuybackPercent
    || recorded.matchedBuybackPercent !== refreshed.evidence.matchedBuybackPercent
    || recorded.prizeTier !== refreshed.evidence.prizeTier || recorded.rarity !== refreshed.evidence.rarity) {
    return recordHeldEpicPosition({
      cycleRepository, config, context,
      packIndex: recorded.packIndex, memo: recorded.memo, mint: recorded.mint,
      terminalState: 'HELD_DATA_UNVERIFIED',
      reason: 'DATA_UNVERIFIED',
      evidence: {
        stage: 'epic-gate', memo: recorded.memo, mint: recorded.mint, recorded, refreshed: refreshed.evidence, reason: 'buyback quote or card facts changed',
      },
    });
  }
  return recorded;
}

export async function reconcileLiveEpicGate({ adapters, config, cycleRepository, context }) {
  const record = await cycleRepository.readOperationalStageAttempt(context.cycleId, 'epic-gate');
  const evidence = record?.responseEvidence;
  if (!plainObject(evidence) || !Array.isArray(evidence.packs)) return null;
  const outcomes = [];
  for (const recorded of evidence.packs) outcomes.push(await reconcilePack({ adapters, config, cycleRepository, context, recorded }));
  return { packs: outcomes };
}
