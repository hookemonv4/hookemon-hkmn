import {
  getTransactionMplCoreTransfers,
  getTransactionTokenBalanceChanges,
  readFinalizedSignatureStatus,
  readMplCoreAssetOwner,
} from '../../solana-rpc.mjs';
import { requireCollectorOnlyMutationAuthority } from '../../../rehearsal/collector-only-authorization.mjs';
import { assertTypedAmount } from '../../../../runner/src/cycle/money-schemas.mjs';
import { existingHeldPackOutcome, heldPackIdForMemo } from './held-pack.mjs';
import { AmbiguousCardMintError } from './errors.mjs';

const DEFAULT_UNRESOLVED_CARD_DEADLINE_MINUTES = 30;
const MINIMUM_UNRESOLVED_CARD_DEADLINE_MINUTES = 5;
const MAXIMUM_UNRESOLVED_CARD_DEADLINE_MINUTES = 1440;
const canonicalUnsignedInteger = /^(0|[1-9][0-9]*)$/;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Purchased packs (see purchase.mjs) are the only packs that ever reach open. */
function purchasedPacks(purchase) {
  if (purchase?.status !== 'COMPLETE' || !plainObject(purchase.evidence) || !Array.isArray(purchase.evidence.packs)) {
    throw new Error('open requires a completed purchase stage with a pack ledger');
  }
  return purchase.evidence.packs.filter(pack => pack.status === 'purchased').map(pack => {
    if (typeof pack.memo !== 'string' || pack.memo.length === 0 || !Number.isSafeInteger(pack.expectedCardCount) || pack.expectedCardCount < 1) {
      throw new Error('open requires a purchased pack with a memo and a positive expected card count');
    }
    if (pack.expectedCardCount !== 1) throw new Error('open requires exactly one expected card per pack');
    return { packIndex: pack.packIndex, memo: pack.memo, expectedCardCount: pack.expectedCardCount };
  });
}

function heldPositionReason(terminalState) {
  if (terminalState === 'HELD_UNRESOLVED') return 'SENT_UNKNOWN_DEADLINE';
  return 'DATA_UNVERIFIED';
}

function heldMint(evidence) {
  if (typeof evidence?.mint === 'string' && evidence.mint.length > 0) return evidence.mint;
  if (typeof evidence?.send?.nft_address === 'string' && evidence.send.nft_address.length > 0) {
    return evidence.send.nft_address;
  }
  return null;
}



/** Carves one unresolved card out without touching the cycle's terminal state or other packs. */
async function holdPack(cycleRepository, config, context, evidence, { terminalState = 'HELD_DATA_UNVERIFIED', reason = heldPositionReason(terminalState) } = {}) {
  const memo = evidence?.memo;
  const mint = heldMint(evidence);
  if (typeof memo !== 'string' || memo.length === 0) {
    throw new Error('open cannot record a held card without its durable purchase memo');
  }
  const existing = await existingHeldPackOutcome({
    cycleRepository,
    cycleId: context.cycleId,
    memo,
    packIndex: evidence.packIndex,
  });
  if (existing !== null) return existing;
  if (typeof cycleRepository?.recordHeldPosition !== 'function' || typeof cycleRepository.describeCycle !== 'function') {
    throw new Error('open requires held-position attribution capabilities');
  }
  const description = await cycleRepository.describeCycle(context.cycleId);
  const costMicroUsd = description?.admission?.aggregateFundingUsd?.amountMicroUsd;
  const packId = await heldPackIdForMemo({ cycleRepository, cycleId: context.cycleId, memo, config });
  if (typeof costMicroUsd !== 'string' || !canonicalUnsignedInteger.test(costMicroUsd)
    || typeof packId !== 'string' || packId.length === 0) {
    throw new Error('open cannot attribute a held card without a committed USD purchase cost and pack identifier');
  }
  const position = await cycleRepository.recordHeldPosition(context.cycleId, {
    packId,
    memo,
    mint,
    cardRef: mint ?? memo,
    costMicroUsd,
    valueMicroUsd: costMicroUsd,
    insuredValue: null,
    reason,
    terminalState,
    evidence,
  });
  return {
    packIndex: evidence.packIndex,
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
    throw new Error('open unresolvedCardDeadlineMinutes is invalid');
  }
  return value;
}

function pastDeadline(sinceMs, config, context) {
  const nowMs = context?.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('open reconciliation clock is invalid');
  if (!Number.isSafeInteger(sinceMs) || sinceMs < 0) return false;
  return nowMs >= sinceMs + unresolvedCardDeadlineMinutes(config) * 60_000;
}

function memoBoundSend(packStatus) {
  const send = packStatus?.send;
  if (!plainObject(send)
    || typeof send.transaction_signature !== 'string' || send.transaction_signature.length === 0
    || typeof send.nft_address !== 'string' || send.nft_address.length === 0
    || typeof send.to_wallet !== 'string' || send.to_wallet.length === 0) {
    return null;
  }
  return {
    signature: send.transaction_signature,
    mint: send.nft_address,
    destination: send.to_wallet,
  };
}

export async function deriveCardAssetFromOpenTransaction({ adapters, playerAddress, signature }) {
  if (!adapters.solana?.client) throw new Error('open reconciliation requires a configured Solana RPC client');
  const balanceChanges = await getTransactionTokenBalanceChanges(adapters.solana.client, signature, { commitment: 'finalized' });
  const candidates = balanceChanges.filter(
    entry => entry.owner === playerAddress && entry.preAmount === '0' && entry.postAmount === '1',
  );
  if (candidates.length === 1) return { mint: candidates[0].mint, assetKind: 'spl' };
  if (candidates.length > 1) {
    throw new AmbiguousCardMintError('open', signature, candidates.map(entry => entry.mint));
  }
  const transferred = await getTransactionMplCoreTransfers(adapters.solana.client, signature, { commitment: 'finalized' });
  const coreCandidates = [];
  for (const asset of [...new Set(transferred)]) {
    const owner = await readMplCoreAssetOwner(adapters.solana.client, asset, { commitment: 'finalized' });
    if (owner === playerAddress) coreCandidates.push(asset);
  }
  if (coreCandidates.length !== 1) throw new AmbiguousCardMintError('open', signature, coreCandidates);
  return { mint: coreCandidates[0], assetKind: 'mpl-core' };
}

/**
 * Reconciles one purchased pack against the provider's memo-bound status. Returns either an
 * opened-card evidence entry or a held-position evidence entry; never blocks another pack.
 */
async function reconcilePack({
  adapters,
  config,
  cycleRepository,
  context,
  pack,
  playerAddress,
  immediateHoldOnMissingSend,
  missingSendReason,
  missingSendTerminal,
  pastDeadline: deadlinePassed,
  deadlineTerminal,
}) {
  const holdFailureAtDeadline = ({ failure, packStatus, send, signature }) => {
    if (!deadlinePassed) return null;
    return holdPack(cycleRepository, config, context, {
      stage: 'open',
      packIndex: pack.packIndex,
      memo: pack.memo,
      reason: 'open reconciliation could not verify the card before the unresolved-card deadline',
      failure,
      ...(send ? { send: packStatus.send, signature } : {}),
    }, deadlineTerminal);
  };

  let packStatus;
  try {
    packStatus = await adapters.collectorCrypt.getPackStatus({ memo: pack.memo });
  } catch (error) {
    return holdFailureAtDeadline({
      failure: { kind: 'pack-status', message: error?.message ?? String(error) },
    });
  }
  if (packStatus.memo !== pack.memo) {
    return holdPack(cycleRepository, config, context, { stage: 'open', packIndex: pack.packIndex, memo: pack.memo, reason: 'pack status memo did not match' });
  }
  const send = memoBoundSend(packStatus);
  if (send === null) {
    // A confirmed openPack response, or any sent-unknown attempt whose status Collector actually
    // answered, with no memo-bound send is an immediate provider contradiction — not evidence
    // this pack is still processing. Only a not-yet-confirmed, not-yet-sent-unknown pack (no
    // durable signal at all) keeps waiting.
    if (!immediateHoldOnMissingSend) return null;
    return holdPack(cycleRepository, config, context, {
      stage: 'open', packIndex: pack.packIndex, memo: pack.memo, send: packStatus.send ?? null,
      reason: missingSendReason,
    }, missingSendTerminal);
  }
  if (send.destination !== playerAddress) {
    return holdPack(cycleRepository, config, context, { stage: 'open', packIndex: pack.packIndex, memo: pack.memo, send: packStatus.send, reason: 'memo-bound send destination does not match the operator wallet' });
  }
  const signature = send.signature;
  let status;
  try {
    status = await readFinalizedSignatureStatus(adapters.solana.client, signature);
  } catch (error) {
    return holdFailureAtDeadline({
      failure: { kind: 'signature-status', message: error?.message ?? String(error) },
      packStatus,
      send,
      signature,
    });
  }
  if (status === null) {
    return holdFailureAtDeadline({
      failure: { kind: 'signature-pending' },
      packStatus,
      send,
      signature,
    });
  }
  if (status.err) {
    return holdPack(cycleRepository, config, context, { stage: 'open', packIndex: pack.packIndex, memo: pack.memo, mint: send.mint, signature, signatureStatus: status });
  }
  let asset;
  try {
    asset = await deriveCardAssetFromOpenTransaction({ adapters, playerAddress, signature });
  } catch (error) {
    if (error instanceof AmbiguousCardMintError) {
      return holdPack(cycleRepository, config, context, { stage: 'open', packIndex: pack.packIndex, memo: pack.memo, signature, candidateMints: error.candidateMints });
    }
    return holdFailureAtDeadline({
      failure: { kind: 'card-asset', message: error?.message ?? String(error) },
      packStatus,
      send,
      signature,
    });
  }
  if (send.mint !== asset.mint) {
    return holdPack(cycleRepository, config, context, { stage: 'open', packIndex: pack.packIndex, memo: pack.memo, mint: send.mint, signature, reportedAsset: send.mint, observedAsset: asset.mint });
  }
  return { packIndex: pack.packIndex, memo: pack.memo, decision: 'opened', signature, mint: asset.mint, assetKind: asset.assetKind };
}

function openRequest({ packs }) {
  return { provider: 'collector-crypt', operation: 'open', packs };
}

export async function prepareOpenRequest({ cycleRepository, context }) {
  const purchase = await cycleRepository.readStage(context.cycleId, 'purchase');
  return openRequest({ packs: purchasedPacks(purchase) });
}

export async function probeOpen({ adapters, cycleRepository, context }) {
  const purchase = await cycleRepository.readStage(context.cycleId, 'purchase');
  let packs;
  try {
    packs = purchase.status === 'COMPLETE' ? purchasedPacks(purchase) : null;
  } catch {
    packs = null;
  }
  if (!adapters.collectorCrypt || packs === null) {
    return { wouldOpen: true, configured: false, reason: 'collector-crypt client is not configured, or purchase has not recorded a durable pack ledger yet' };
  }
  const statuses = await Promise.all(packs.map(pack => adapters.collectorCrypt.getPackStatus({ memo: pack.memo })));
  return { wouldOpen: true, configured: true, packs, packStatuses: statuses };
}

export async function mutateOpen({ liveMode, adapters, config, cycleRepository, context, request, preflightAuthority }) {
  if (liveMode !== true) throw new Error('stage-driver internal error: mutateOpen reached without liveMode');
  if (!adapters?.collectorCrypt) throw new Error('open mutate requires a configured collector-crypt client');
  const prepared = request ?? context?.request ?? await prepareOpenRequest({ cycleRepository, context });
  requireCollectorOnlyMutationAuthority(config, preflightAuthority);
  const opened = [];
  for (const pack of prepared.packs) {
    const result = await adapters.collectorCrypt.openPack({ memo: pack.memo });
    opened.push({ packIndex: pack.packIndex, memo: pack.memo, opened: result });
  }
  return { packs: opened };
}

export async function reconcileLiveOpen({ adapters, config, cycleRepository, context }) {
  if (!adapters?.collectorCrypt || !adapters?.solana?.client) return null;
  const purchase = await cycleRepository.readStage(context.cycleId, 'purchase');
  const packs = purchasedPacks(purchase);
  if (packs.length === 0) return { packs: [] };
  // The wallet that actually received these cards is bound durably at purchase's pre-call intent,
  // not re-derived from the live operator config -- see purchase.mjs's identical fix. A
  // purchase-completed cycle with packs to open always has this record.
  const intentRecord = await cycleRepository.readPackBatchIntent(context.cycleId, 'purchase');
  if (intentRecord === null) throw new Error('open reconciliation requires the purchase stage pre-call intent that must exist alongside any completed purchase');
  const playerAddress = intentRecord.intent.playerAddress;

  let record = await cycleRepository.readOperationalStageAttempt(context.cycleId, 'open');
  const sentUnknown = record?.attempt?.state === 'SENT_UNKNOWN';
  const responseRecorded = record?.attempt?.state === 'RESPONSE_RECORDED';
  const nowMs = context?.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('open reconciliation clock is invalid');
  const deadlineContext = context?.nowMs === undefined ? { ...context, nowMs } : context;
  const sinceMs = () => responseRecorded
    ? record.respondedAtMs ?? record.sentAtMs ?? record.deadlineAnchorMs ?? null
    : record.sentAtMs ?? record.deadlineAnchorMs ?? null;
  if ((sentUnknown || responseRecorded) && sinceMs() === null
    && typeof cycleRepository.anchorOperationalStageDeadline === 'function') {
    record = await cycleRepository.anchorOperationalStageDeadline(context.cycleId, 'open', { nowMs });
  }
  const sentUnknownPastDeadline = sentUnknown && pastDeadline(sinceMs(), config, deadlineContext);
  const responseRecordedPastDeadline = responseRecorded
    && pastDeadline(sinceMs(), config, deadlineContext);
  const deadlinePassed = sentUnknownPastDeadline || responseRecordedPastDeadline;
  const confirmedMemos = new Set(
    plainObject(record?.responseEvidence) && Array.isArray(record.responseEvidence.packs)
      ? record.responseEvidence.packs.map(entry => entry.memo)
      : [],
  );

  const outcomes = [];
  for (const pack of packs) {
    const confirmed = confirmedMemos.has(pack.memo);
    const outcome = await reconcilePack({
      adapters, config, cycleRepository, context, pack, playerAddress,
      immediateHoldOnMissingSend: confirmed || sentUnknown,
      missingSendReason: confirmed
        ? 'response-recorded open is missing memo-bound mint evidence'
        : sentUnknownPastDeadline
          ? 'open provider mutation remained sent-unknown past the reconcile deadline'
          : 'sent-unknown open is missing memo-bound mint evidence',
      missingSendTerminal: !confirmed && sentUnknownPastDeadline
        ? { terminalState: 'HELD_UNRESOLVED', reason: 'SENT_UNKNOWN_DEADLINE' }
        : undefined,
      pastDeadline: deadlinePassed,
      deadlineTerminal: sentUnknownPastDeadline
        ? { terminalState: 'HELD_UNRESOLVED', reason: 'SENT_UNKNOWN_DEADLINE' }
        : undefined,
    });
    outcomes.push(outcome);
  }
  return outcomes.some(outcome => outcome === null) ? null : { packs: outcomes };
}
