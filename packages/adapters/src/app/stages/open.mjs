import {
  getTransactionMplCoreTransfers,
  getTransactionTokenBalanceChanges,
  readFinalizedSignatureStatus,
  readMplCoreAssetOwner,
} from '../../solana-rpc.mjs';
import { requireCollectorOnlyMutationAuthority } from '../../../rehearsal/collector-only-authorization.mjs';
import { digest } from '../../../../runner/src/cycle/journal.mjs';
import { assertTypedAmount } from '../../../../runner/src/cycle/money-schemas.mjs';
import { collectorPolicyForStage } from '../../signing/collector-policy-loader.mjs';
import { AmbiguousCardMintError } from './errors.mjs';

const canonicalUnsignedInteger = /^(0|[1-9][0-9]*)$/;
const DEFAULT_UNRESOLVED_CARD_DEADLINE_MINUTES = 30;
const MINIMUM_UNRESOLVED_CARD_DEADLINE_MINUTES = 5;
const MAXIMUM_UNRESOLVED_CARD_DEADLINE_MINUTES = 1440;

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

function heldPositionLedgerAsset(config) {
  const asset = config?.moneyConfiguration?.assets?.usdg;
  const typed = assertTypedAmount({ ...asset, amountAtomic: '0' }, 'held open USDG ledger asset');
  if (typed.chainId !== '4663' || typed.decimals !== 6) {
    throw new Error('held open USDG ledger asset must use the configured six-decimal USDG asset');
  }
  return { chainId: typed.chainId, assetId: typed.assetId, decimals: typed.decimals };
}

async function holdWholeCycleForUnattributableCard(cycleRepository, context, evidence) {
  if (typeof cycleRepository?.holdCycle !== 'function') {
    throw new Error('open cannot record an unattributable held card without cycle hold authority');
  }
  await cycleRepository.holdCycle(context.cycleId, 'HELD_DATA_UNVERIFIED', evidence);
  return null;
}

async function holdDataUnverified(
  cycleRepository,
  config,
  context,
  evidence,
  { terminalState = 'HELD_DATA_UNVERIFIED', reason = heldPositionReason(terminalState) } = {},
) {
  const memo = evidence?.memo;
  const mint = heldMint(evidence);
  if (typeof memo !== 'string' || memo.length === 0) {
    return holdWholeCycleForUnattributableCard(cycleRepository, context, {
      stage: 'open',
      ...evidence,
      reason: 'held card is missing its durable purchase memo',
    });
  }
  if (typeof cycleRepository?.recordHeldPosition !== 'function' || typeof cycleRepository.describeCycle !== 'function') {
    throw new Error('open requires held-position attribution capabilities');
  }
  const description = await cycleRepository.describeCycle(context.cycleId);
  const costMicroUsdg = description?.releaseAmount;
  const packId = config?.pack?.code;
  if (typeof costMicroUsdg !== 'string' || !canonicalUnsignedInteger.test(costMicroUsdg)
    || typeof packId !== 'string' || packId.length === 0) {
    return holdWholeCycleForUnattributableCard(cycleRepository, context, {
      stage: 'open',
      ...evidence,
      reason: 'held card is missing attributable cycle purchase evidence',
    });
  }
  const position = await cycleRepository.recordHeldPosition(context.cycleId, {
    packId,
    memo,
    mint,
    cardRef: mint ?? memo,
    costMicroUsdg,
    valueMicroUsdg: costMicroUsdg,
    ledgerAsset: heldPositionLedgerAsset(config),
    insuredValue: null,
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
    throw new Error('open unresolvedCardDeadlineMinutes is invalid');
  }
  return value;
}

function sentUnknownPastDeadline(record, config, context) {
  if (record?.attempt?.state !== 'SENT_UNKNOWN' || !Number.isSafeInteger(record.sentAtMs) || record.sentAtMs < 0) return false;
  const nowMs = context?.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('open reconciliation clock is invalid');
  return nowMs >= record.sentAtMs + unresolvedCardDeadlineMinutes(config) * 60_000;
}

function responseEvidence(record) {
  const evidence = record?.responseEvidence;
  if (!plainObject(evidence) || typeof evidence.memo !== 'string' || evidence.memo.length === 0
    || evidence.expectedCardCount !== 1) return null;
  if (evidence.decision === 'held') {
    if ((evidence.mint !== null && (typeof evidence.mint !== 'string' || evidence.mint.length === 0))
      || typeof evidence.terminalState !== 'string' || evidence.terminalState.length === 0
      || typeof evidence.reason !== 'string' || evidence.reason.length === 0
      || !plainObject(evidence.heldPosition)) return null;
    return evidence;
  }
  if (!plainObject(evidence.opened)) return null;
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

export async function mutateOpen({ liveMode, adapters, config, cycleRepository, context, request }) {
  if (liveMode !== true) throw new Error('stage-driver internal error: mutateOpen reached without liveMode');
  if (config?.collectorCrypt?.executionBundle !== undefined) collectorPolicyForStage(config, 'open');
  if (!adapters?.collectorCrypt) throw new Error('open mutate requires a configured collector-crypt client');
  const prepared = request ?? context?.request ?? await prepareOpenRequest({ cycleRepository, context });
  if (prepared.expectedCardCount !== 1) throw new Error('open mutation requires exactly one expected card');
  requireCollectorOnlyMutationAuthority(config);
  const opened = await adapters.collectorCrypt.openPack({ memo: prepared.memo });
  return { memo: prepared.memo, expectedCardCount: prepared.expectedCardCount, opened };
}

async function reconcileMemoBoundOpen({ adapters, config, cycleRepository, context, evidence, packStatus }) {
  if (packStatus.memo !== evidence.memo) {
    return holdDataUnverified(cycleRepository, config, context, {
      stage: 'open', memo: evidence.memo, reason: 'pack status memo did not match',
    });
  }
  const send = memoBoundSend(packStatus);
  if (send === null) {
    return holdDataUnverified(cycleRepository, config, context, {
      stage: 'open',
      memo: evidence.memo,
      opened: evidence.opened,
      send: packStatus.send ?? null,
      reason: 'response-recorded open is missing memo-bound mint evidence',
    });
  }
  if (!responseAgreesWithMemoBoundSend(evidence.opened, send)) {
    return holdDataUnverified(cycleRepository, config, context, {
      stage: 'open', memo: evidence.memo, opened: evidence.opened, send: packStatus.send, reason: 'open response does not match memo-bound send evidence',
    });
  }
  if (send.destination !== config.accounts?.solana) {
    return holdDataUnverified(cycleRepository, config, context, {
      stage: 'open', memo: evidence.memo, send: packStatus.send, reason: 'memo-bound send destination does not match the operator wallet',
    });
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
    return holdDataUnverified(cycleRepository, config, context, {
      stage: 'open', memo: evidence.memo, mint: send.mint, signature, signatureStatus: status,
    });
  }
  let asset;
  try {
    asset = await deriveCardAssetFromOpenTransaction({ adapters, config, signature });
  } catch (error) {
    if (error instanceof AmbiguousCardMintError) {
      return holdDataUnverified(cycleRepository, config, context, {
        stage: 'open', memo: evidence.memo, signature, candidateMints: error.candidateMints,
      });
    }
    return null;
  }
  if (send.mint !== asset.mint) {
    return holdDataUnverified(cycleRepository, config, context, {
      stage: 'open', memo: evidence.memo, mint: send.mint, signature, reportedAsset: send.mint, observedAsset: asset.mint,
    });
  }
  return { memo: evidence.memo, signature, mint: asset.mint, assetKind: asset.assetKind };
}

async function reconcileSentUnknownOpen({ adapters, config, cycleRepository, context, record }) {
  if (record?.attempt?.state !== 'SENT_UNKNOWN') return null;
  let purchase;
  try {
    purchase = purchaseOpenEvidence(await cycleRepository.readStage(context.cycleId, 'purchase'));
  } catch (error) {
    return holdDataUnverified(cycleRepository, config, context, { stage: 'open', reason: error.message });
  }
  if (!requestMatchesSentUnknownAttempt({ attempt: record.attempt, context, ...purchase })) {
    return holdDataUnverified(cycleRepository, config, context, {
      stage: 'open', memo: purchase.memo, reason: 'sent-unknown open attempt does not bind the completed purchase memo',
    });
  }
  if (sentUnknownPastDeadline(record, config, context)) {
    return holdDataUnverified(cycleRepository, config, context, {
      stage: 'open',
      memo: purchase.memo,
      attempt: record.attempt,
      sentAtMs: record.sentAtMs,
      deadlineMinutes: unresolvedCardDeadlineMinutes(config),
      reason: 'open provider mutation remained sent-unknown past the reconcile deadline',
    }, {
      terminalState: 'HELD_UNRESOLVED',
      reason: 'SENT_UNKNOWN_DEADLINE',
    });
  }
  let packStatus;
  try {
    packStatus = await adapters.collectorCrypt.getPackStatus({ memo: purchase.memo });
  } catch {
    return null;
  }
  if (packStatus.memo !== purchase.memo) {
    return holdDataUnverified(cycleRepository, config, context, {
      stage: 'open', memo: purchase.memo, reason: 'pack status memo did not match',
    });
  }
  const send = memoBoundSend(packStatus);
  if (send === null) {
    return holdDataUnverified(cycleRepository, config, context, {
      stage: 'open',
      memo: purchase.memo,
      send: packStatus.send ?? null,
      reason: 'sent-unknown open is missing memo-bound mint evidence',
    });
  }
  return reconcileMemoBoundOpen({
    adapters,
    config,
    cycleRepository,
    context,
    evidence: { ...purchase, opened: {} },
    packStatus,
  });
}

export async function reconcileLiveOpen({ adapters, config, cycleRepository, context }) {
  const record = await cycleRepository.readOperationalStageAttempt(context.cycleId, 'open');
  const evidence = responseEvidence(record);
  if (evidence?.decision === 'held') return evidence;
  if (evidence === null && sentUnknownPastDeadline(record, config, context)) {
    return reconcileSentUnknownOpen({ adapters, config, cycleRepository, context, record });
  }
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
