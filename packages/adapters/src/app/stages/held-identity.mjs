import { deriveCardAssetFromOpenTransaction } from './open.mjs';
import { verifiedHeldAssetOwner } from './held-custody.mjs';
import { readFinalizedSignatureStatus } from '../../solana-rpc.mjs';

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is invalid`);
  return value;
}

function nftAddressField(config) {
  return config?.collectorCrypt?.epicGate?.nftAddressField ?? 'nft_address';
}

export async function recoverHeldCardIdentity({ adapters, config, cycleRepository, position }) {
  const open = await cycleRepository.readStage(position.cycleId, 'open');
  const packs = plainObject(open?.evidence) && Array.isArray(open.evidence.packs) ? open.evidence.packs : [];
  const pack = packs.find(entry => entry.memo === position.memo) ?? null;
  const heldEvidence = position.evidence
    ?? (typeof cycleRepository.readHeldPositionEvidence === 'function'
      ? await cycleRepository.readHeldPositionEvidence(position.positionId)
      : null);
  const evidenceSignature = typeof heldEvidence?.signature === 'string' && heldEvidence.signature.length > 0
    ? heldEvidence.signature
    : null;
  const openEvidenceSignature = typeof pack?.signature === 'string' && pack.signature.length > 0
    ? pack.signature
    : null;
  let openSignature = evidenceSignature ?? openEvidenceSignature;
  let openSignatureSource = evidenceSignature !== null
    ? 'held-evidence'
    : openEvidenceSignature !== null
      ? 'open-evidence'
      : 'collector-finalized-send';
  const intentRecord = typeof cycleRepository.readPackBatchIntent === 'function'
    ? await cycleRepository.readPackBatchIntent(position.cycleId, 'purchase')
    : null;
  const playerAddress = intentRecord?.intent?.playerAddress
    ?? (openSignatureSource === 'collector-finalized-send' ? null : config?.accounts?.solana);
  if (typeof playerAddress !== 'string' || playerAddress.length === 0) {
    throw new Error('held card identity recovery requires the durable purchase player address');
  }
  const packStatus = await adapters.collectorCrypt.getPackStatus({ memo: position.memo });
  if (!plainObject(packStatus) || packStatus.memo !== position.memo) {
    throw new Error('held card identity recovery requires Collector pack status bound to the held memo');
  }
  const send = packStatus.send;
  const packStatusMint = nonEmptyString(send?.[nftAddressField(config)], 'held card identity recovery requires a Collector pack status mint');
  if (openSignatureSource === 'collector-finalized-send') {
    const sendSignature = nonEmptyString(
      send?.transaction_signature,
      'held card identity recovery requires a finalized Collector send signature',
    );
    if (send?.to_wallet !== playerAddress) {
      throw new Error('held card identity recovery Collector send destination does not match the durable purchase player');
    }
    const status = await readFinalizedSignatureStatus(adapters.solana.client, sendSignature);
    if (status === null || status.err) {
      throw new Error('held card identity recovery requires a successful finalized Collector send');
    }
    openSignature = sendSignature;
  }
  const signatureStatus = await readFinalizedSignatureStatus(adapters.solana.client, openSignature);
  if (signatureStatus === null || signatureStatus.err) {
    throw new Error('held card identity recovery requires a successful finalized open transaction');
  }
  const derived = await deriveCardAssetFromOpenTransaction({
    adapters,
    playerAddress,
    signature: openSignature,
  });
  const derivedMint = nonEmptyString(derived?.mint, 'held card identity recovery requires a derived card mint');
  if (packStatusMint !== derivedMint) {
    throw new Error('held card identity recovery found conflicting Collector and transaction card mints');
  }
  for (const candidateSource of [heldEvidence, pack]) {
    if (Object.hasOwn(candidateSource ?? {}, 'candidateMints')
      && (!Array.isArray(candidateSource.candidateMints) || !candidateSource.candidateMints.includes(derivedMint))) {
      throw new Error('held card identity recovery derived mint is not among the recorded candidate mints');
    }
  }
  const custodyOwner = await verifiedHeldAssetOwner({
    adapters,
    config,
    mint: derivedMint,
    assetKind: derived.assetKind,
  });
  return cycleRepository.recordHeldPositionIdentity(position.positionId, {
    mint: derivedMint,
    provenance: {
      memo: position.memo,
      openSignature,
      packStatusMint,
      derivedMint,
      custodyOwner,
      openSignatureSource,
      assetKind: derived.assetKind,
    },
    evidence: {
      open: pack,
      packStatus,
      derived,
      custodyOwner,
      signatureStatus,
      playerAddress,
    },
  });
}
