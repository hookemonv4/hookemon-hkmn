import {
  getTransactionMplCoreTransfers,
  getTransactionTokenBalanceChanges,
  readFinalizedSignatureStatus,
  readMplCoreAssetOwner,
} from '../../solana-rpc.mjs';
import { requireLiveMutationAuthority } from '../../../../runner/src/cycle/preflight.mjs';
import { digest } from '../../../../runner/src/cycle/journal.mjs';
import { AmbiguousCardMintError } from './errors.mjs';

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function purchaseOpenEvidence(purchase) {
  const evidence = purchase?.status === 'COMPLETE' ? purchase.evidence : null;
  const memo = evidence?.memo;
  if (typeof memo !== 'string' || memo.length === 0) throw new Error('open requires a completed purchase stage with a memo');
  if (!Number.isSafeInteger(evidence.expectedCardCount) || evidence.expectedCardCount !== 1) {
    throw new Error('open requires exactly one expected card from the completed purchase stage');
  }
  return { memo, expectedCardCount: evidence.expectedCardCount };
}

async function holdDataUnverified(cycleRepository, context, evidence) {
  if (typeof cycleRepository?.holdCycle !== 'function') throw new Error('open reconciliation requires cycleRepository.holdCycle');
  await cycleRepository.holdCycle(context.cycleId, 'HELD_DATA_UNVERIFIED', evidence);
}

function responseEvidence(record) {
  const evidence = record?.responseEvidence;
  if (!plainObject(evidence) || typeof evidence.memo !== 'string' || evidence.memo.length === 0
    || evidence.expectedCardCount !== 1 || !plainObject(evidence.opened)) return null;
  return evidence;
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

function responseAgreesWithMemoBoundSend(opened, send) {
  const signature = opened.transactionSignature ?? opened.transaction_signature;
  if ((opened.transactionSignature !== undefined && opened.transaction_signature !== undefined
      && opened.transactionSignature !== opened.transaction_signature)
    || (signature !== undefined && (typeof signature !== 'string' || signature !== send.signature))) {
    return false;
  }
  if (opened.nft_address !== undefined
    && (typeof opened.nft_address !== 'string' || opened.nft_address !== send.mint)) {
    return false;
  }
  return true;
}

function openRequest({ memo, expectedCardCount }) {
  return { provider: 'collector-crypt', operation: 'open', memo, expectedCardCount };
}

function requestMatchesSentUnknownAttempt({ attempt, context, memo, expectedCardCount }) {
  if (attempt?.state !== 'SENT_UNKNOWN' || typeof attempt.requestDigest !== 'string') return false;
  const expectedDigest = digest({
    schema: 'hookemon.operational-stage-request.v1',
    cycleId: context.cycleId,
    stage: 'open',
    request: openRequest({ memo, expectedCardCount }),
  });
  return attempt.requestDigest === expectedDigest;
}

async function deriveCardAssetFromOpenTransaction({ adapters, config, signature }) {
  if (!adapters.solana?.client) throw new Error('open reconciliation requires a configured Solana RPC client');
  if (typeof config.accounts?.solana !== 'string' || config.accounts.solana.length === 0) {
    throw new Error('open reconciliation requires HOOKEMON_SOLANA_ACCOUNT');
  }
  const balanceChanges = await getTransactionTokenBalanceChanges(adapters.solana.client, signature, { commitment: 'finalized' });
  const candidates = balanceChanges.filter(
    entry => entry.owner === config.accounts.solana && entry.preAmount === '0' && entry.postAmount === '1',
  );
  if (candidates.length === 1) return { mint: candidates[0].mint, assetKind: 'spl' };
  if (candidates.length > 1) {
    throw new AmbiguousCardMintError('open', signature, candidates.map(entry => entry.mint));
  }
  const transferred = await getTransactionMplCoreTransfers(adapters.solana.client, signature, { commitment: 'finalized' });
  const coreCandidates = [];
  for (const asset of [...new Set(transferred)]) {
    const owner = await readMplCoreAssetOwner(adapters.solana.client, asset, { commitment: 'finalized' });
    if (owner === config.accounts.solana) coreCandidates.push(asset);
  }
  if (coreCandidates.length !== 1) throw new AmbiguousCardMintError('open', signature, coreCandidates);
  return { mint: coreCandidates[0], assetKind: 'mpl-core' };
}

export async function prepareOpenRequest({ cycleRepository, context }) {
  const purchase = await cycleRepository.readStage(context.cycleId, 'purchase');
  return openRequest(purchaseOpenEvidence(purchase));
}

export async function probeOpen({ adapters, cycleRepository, context }) {
  const purchase = await cycleRepository.readStage(context.cycleId, 'purchase');
  if (!adapters.collectorCrypt || purchase.status !== 'COMPLETE' || !purchase.evidence?.memo) {
    return { wouldOpen: true, configured: false, reason: 'collector-crypt client is not configured, or purchase has no completed memo yet' };
  }
  const prepared = purchaseOpenEvidence(purchase);
  const status = await adapters.collectorCrypt.getPackStatus({ memo: prepared.memo });
  return { wouldOpen: true, configured: true, ...prepared, packStatus: status };
}

export async function mutateOpen({ liveMode, adapters, cycleRepository, context, request }) {
  if (liveMode !== true) throw new Error('stage-driver internal error: mutateOpen reached without liveMode');
  if (!adapters?.collectorCrypt) throw new Error('open mutate requires a configured collector-crypt client');
  const prepared = request ?? context?.request ?? await prepareOpenRequest({ cycleRepository, context });
  if (prepared.expectedCardCount !== 1) throw new Error('open mutation requires exactly one expected card');
  requireLiveMutationAuthority();
  const opened = await adapters.collectorCrypt.openPack({ memo: prepared.memo });
  return { memo: prepared.memo, expectedCardCount: prepared.expectedCardCount, opened };
}

async function reconcileMemoBoundOpen({ adapters, config, cycleRepository, context, evidence, packStatus }) {
  if (packStatus.memo !== evidence.memo) {
    await holdDataUnverified(cycleRepository, context, { stage: 'open', memo: evidence.memo, reason: 'pack status memo did not match' });
    return null;
  }
  const send = memoBoundSend(packStatus);
  if (send === null) {
    await holdDataUnverified(cycleRepository, context, {
      stage: 'open',
      memo: evidence.memo,
      opened: evidence.opened,
      send: packStatus.send ?? null,
      reason: 'response-recorded open is missing memo-bound mint evidence',
    });
    return null;
  }
  if (!responseAgreesWithMemoBoundSend(evidence.opened, send)) {
    await holdDataUnverified(cycleRepository, context, {
      stage: 'open', memo: evidence.memo, opened: evidence.opened, send: packStatus.send, reason: 'open response does not match memo-bound send evidence',
    });
    return null;
  }
  if (send.destination !== config.accounts?.solana) {
    await holdDataUnverified(cycleRepository, context, {
      stage: 'open', memo: evidence.memo, send: packStatus.send, reason: 'memo-bound send destination does not match the operator wallet',
    });
    return null;
  }
  const signature = send.signature;
  let status;
  try {
    status = await readFinalizedSignatureStatus(adapters.solana.client, signature);
  } catch {
    return null;
  }
  if (status === null) return null;
  if (status.err) {
    await holdDataUnverified(cycleRepository, context, { stage: 'open', memo: evidence.memo, signature, signatureStatus: status });
    return null;
  }
  let asset;
  try {
    asset = await deriveCardAssetFromOpenTransaction({ adapters, config, signature });
  } catch (error) {
    if (error instanceof AmbiguousCardMintError) {
      await holdDataUnverified(cycleRepository, context, {
        stage: 'open', memo: evidence.memo, signature, candidateMints: error.candidateMints,
      });
      return null;
    }
    return null;
  }
  if (send.mint !== asset.mint) {
    await holdDataUnverified(cycleRepository, context, { stage: 'open', memo: evidence.memo, signature, reportedAsset: send.mint, observedAsset: asset.mint });
    return null;
  }
  return { memo: evidence.memo, signature, mint: asset.mint, assetKind: asset.assetKind };
}

async function reconcileSentUnknownOpen({ adapters, config, cycleRepository, context, record }) {
  if (record?.attempt?.state !== 'SENT_UNKNOWN') return null;
  let purchase;
  try {
    purchase = purchaseOpenEvidence(await cycleRepository.readStage(context.cycleId, 'purchase'));
  } catch (error) {
    await holdDataUnverified(cycleRepository, context, { stage: 'open', reason: error.message });
    return null;
  }
  if (!requestMatchesSentUnknownAttempt({ attempt: record.attempt, context, ...purchase })) {
    await holdDataUnverified(cycleRepository, context, { stage: 'open', memo: purchase.memo, reason: 'sent-unknown open attempt does not bind the completed purchase memo' });
    return null;
  }
  let packStatus;
  try {
    packStatus = await adapters.collectorCrypt.getPackStatus({ memo: purchase.memo });
  } catch {
    return null;
  }
  if (packStatus.memo !== purchase.memo) {
    await holdDataUnverified(cycleRepository, context, { stage: 'open', memo: purchase.memo, reason: 'pack status memo did not match' });
    return null;
  }
  if (memoBoundSend(packStatus) !== null) {
    return reconcileMemoBoundOpen({
      adapters,
      config,
      cycleRepository,
      context,
      evidence: { ...purchase, opened: {} },
      packStatus,
    });
  }
  if (typeof context.assertLease !== 'function' || typeof context.assertMutationAllowed !== 'function') return null;
  await context.assertLease();
  await context.assertMutationAllowed({
    boundary: 'mutation',
    cycleId: context.cycleId,
    stage: 'open',
    requestDigest: record.attempt.requestDigest,
    fencingToken: context.fencingToken ?? null,
  });
  let opened;
  try {
    opened = await adapters.collectorCrypt.openPack({ memo: purchase.memo });
  } catch {
    return null;
  }
  if (!plainObject(opened) || typeof opened.nft_address !== 'string' || opened.nft_address.length === 0) {
    await holdDataUnverified(cycleRepository, context, { stage: 'open', memo: purchase.memo, opened, reason: 'sent-unknown open retry did not return a card address' });
    return null;
  }
  try {
    packStatus = await adapters.collectorCrypt.getPackStatus({ memo: purchase.memo });
  } catch {
    return null;
  }
  const send = memoBoundSend(packStatus);
  if (packStatus.memo !== purchase.memo || send === null || opened.nft_address !== send.mint) {
    await holdDataUnverified(cycleRepository, context, {
      stage: 'open', memo: purchase.memo, opened, send: packStatus?.send, reason: 'sent-unknown open retry did not agree with memo-bound card evidence',
    });
    return null;
  }
  return reconcileMemoBoundOpen({
    adapters,
    config,
    cycleRepository,
    context,
    evidence: { ...purchase, opened },
    packStatus,
  });
}

export async function reconcileLiveOpen({ adapters, config, cycleRepository, context }) {
  const record = await cycleRepository.readOperationalStageAttempt(context.cycleId, 'open');
  const evidence = responseEvidence(record);
  if (!adapters?.collectorCrypt || !adapters?.solana?.client) return null;
  if (evidence === null) {
    return reconcileSentUnknownOpen({ adapters, config, cycleRepository, context, record });
  }
  let packStatus;
  try {
    packStatus = await adapters.collectorCrypt.getPackStatus({ memo: evidence.memo });
  } catch {
    return null;
  }
  return reconcileMemoBoundOpen({ adapters, config, cycleRepository, context, evidence, packStatus });
}
