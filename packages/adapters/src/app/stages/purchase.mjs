import {
  getFinalizedTokenBalanceChanges,
  readAssociatedTokenAccount,
  readBlockHeight,
  readBlockhashValidity,
  readFinalizedSignatureStatus,
} from '../../solana-rpc.mjs';
import { assertTypedAmount } from '../../../../runner/src/cycle/money-schemas.mjs';
import {
  decodeProviderTransaction,
  evaluate as evaluateTransactionPolicy,
} from '../../signing/transaction-policy.mjs';
import { OPERATOR_SOLANA_ROLE, wrapTransactionPolicySignerClient } from '../../signing/signer-client.mjs';
import { requireLiveMutationAuthority } from '../../../../runner/src/cycle/preflight.mjs';
import { parseCollectorMachineContains } from '../../collector-crypt.mjs';
import {
  assertSolanaSignerFeeEnvelope,
  assertSolanaSignerMoneyConfiguration,
} from './solana-money-controls.mjs';

const canonicalUnsignedInteger = /^(0|[1-9][0-9]*)$/;

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function configuredSettlementAsset(config) {
  const asset = config?.collectorCrypt?.settlementAsset;
  if (!plainObject(asset)
    || typeof asset.chainId !== 'string' || asset.chainId.length === 0
    || typeof asset.assetId !== 'string' || asset.assetId.length === 0
    || !Number.isInteger(asset.decimals) || asset.decimals < 0 || asset.decimals > 255) {
    throw new Error('Collector purchase requires a configured settlementAsset with chainId, assetId, and decimals');
  }
  if (asset.chainId !== config?.solana?.chainId) throw new Error('Collector purchase settlementAsset chainId must match config.solana.chainId');
  return Object.freeze({ chainId: asset.chainId, assetId: asset.assetId, decimals: asset.decimals });
}

function atomicString(value, label) {
  if (typeof value === 'string' && canonicalUnsignedInteger.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  if (typeof value === 'bigint' && value >= 0n) return value.toString();
  throw new Error(`${label} must be a canonical non-negative atomic amount`);
}

function typedAmount(asset, value, label) {
  return assertTypedAmount({ ...asset, amountAtomic: atomicString(value, label) }, label);
}

function requirePolicy(config, stage) {
  const policy = config?.collectorCrypt?.[stage]?.policy;
  if (!plainObject(policy)) throw new Error(`Collector ${stage} requires a pinned transaction policy`);
  return policy;
}

function requireSolanaConfiguration({ adapters, config, signerClient, stage }) {
  if (!adapters?.solana?.client) throw new Error(`Collector ${stage} requires a configured Solana RPC client`);
  if (!signerClient?.solana || typeof signerClient.solana.sign !== 'function') {
    throw new Error(`Collector ${stage} requires signerClient.solana.sign`);
  }
  if (typeof config?.solana?.chainId !== 'string' || config.solana.chainId.length === 0) {
    throw new Error(`Collector ${stage} requires config.solana.chainId`);
  }
}

function trustedSolanaDecodeOptions({ adapters, config, stage }) {
  if (typeof config?.solana?.blockhashContextResolver !== 'function') {
    throw new Error(`Collector ${stage} requires a trusted Solana blockhashContextResolver`);
  }
  return Object.freeze({
    family: 'solana',
    chainId: config.solana.chainId,
    lookupTableResolver: config.solana.lookupTableResolver,
    blockhashContextResolver: config.solana.blockhashContextResolver,
    currentBlockHeightResolver: async () => readBlockHeight(adapters.solana.client),
  });
}

async function decodeAndSignProviderTransaction({ transaction, stage, adapters, config, money, signerClient }) {
  const decodeOptions = trustedSolanaDecodeOptions({ adapters, config, stage });
  const decoded = await decodeProviderTransaction({ ...decodeOptions, transaction });
  if (!decoded.blockhash || !(await readBlockhashValidity(adapters.solana.client, decoded.blockhash))) {
    throw new Error(`Collector ${stage} transaction blockhash is not valid before signing`);
  }
  evaluateTransactionPolicy(requirePolicy(config, stage), decoded);
  await assertSolanaSignerFeeEnvelope({
    client: adapters.solana.client,
    owner: config.accounts?.solana,
    money,
    decoded,
    stage: `Collector ${stage}`,
  });
  const signer = wrapTransactionPolicySignerClient({
    client: {
      role: signerClient.solana.role ?? OPERATOR_SOLANA_ROLE,
      async sign(request) {
        requireLiveMutationAuthority();
        return signerClient.solana.sign(request);
      },
    },
    policy: requirePolicy(config, stage),
    decodeOptions,
    broadcast: async signed => {
      if (!(await readBlockhashValidity(adapters.solana.client, decoded.blockhash))) {
        throw new Error(`Collector ${stage} transaction blockhash expired before submission`);
      }
      requireLiveMutationAuthority();
      return adapters.collectorCrypt.submitTransaction({ signedTransaction: signed.signedTxBase64 });
    },
  });
  return { signer, signed: await signer.sign(transaction) };
}

function responseEvidence(record) {
  const evidence = record?.responseEvidence;
  if (!plainObject(evidence) || typeof evidence.memo !== 'string' || evidence.memo.length === 0
    || typeof evidence.signature !== 'string' || evidence.signature.length === 0
    || !Number.isSafeInteger(evidence.expectedCardCount) || evidence.expectedCardCount < 1) return null;
  return evidence;
}

async function holdDataUnverified(cycleRepository, context, evidence) {
  if (typeof cycleRepository?.holdCycle !== 'function') throw new Error('Collector reconciliation requires cycleRepository.holdCycle');
  await cycleRepository.holdCycle(context.cycleId, 'HELD_DATA_UNVERIFIED', evidence);
}

function exactDebit(entries, owner, asset) {
  const debits = entries.filter(entry => entry.owner === owner && entry.mint === asset.assetId && BigInt(entry.postAmount) < BigInt(entry.preAmount));
  if (debits.length !== 1) return null;
  return typedAmount(asset, BigInt(debits[0].preAmount) - BigInt(debits[0].postAmount), 'purchase pack cost');
}

function expectedCardCountFromCatalog({ catalog, packType }) {
  if (!plainObject(catalog) || !Array.isArray(catalog.machines)) {
    throw new Error('purchase prepareRequest received an invalid Collector machine catalog');
  }
  const matches = catalog.machines.filter(machine => plainObject(machine) && machine.code === packType);
  if (matches.length !== 1) throw new Error('purchase prepareRequest requires exactly one configured Collector machine');
  return parseCollectorMachineContains(matches[0].contains);
}

async function expectedCardCount({ adapters, packType }) {
  if (typeof adapters?.collectorCrypt?.getMachines !== 'function') {
    throw new Error('purchase prepareRequest requires collector-crypt machine data');
  }
  return expectedCardCountFromCatalog({ catalog: await adapters.collectorCrypt.getMachines(), packType });
}

export async function preparePurchaseRequest({ adapters, config }) {
  const playerAddress = config?.accounts?.solana;
  if (typeof playerAddress !== 'string' || playerAddress.length === 0) throw new Error('purchase prepareRequest requires HOOKEMON_SOLANA_ACCOUNT');
  const packType = config?.pack?.code;
  const request = {
    provider: 'collector-crypt',
    operation: 'purchase',
    playerAddress,
  };
  if (typeof packType !== 'string' || packType.length === 0) return request;
  return { ...request, packType, expectedCardCount: await expectedCardCount({ adapters, packType }) };
}

export async function probePurchase({ adapters, config }) {
  if (!adapters.collectorCrypt) return { wouldPurchase: true, configured: false, reason: 'collector-crypt client is not configured' };
  const [catalog, status] = await Promise.all([adapters.collectorCrypt.getMachines(), adapters.collectorCrypt.getStatus()]);
  const evidence = {
    wouldPurchase: true,
    configured: true,
    machineCount: Array.isArray(catalog?.machines) ? catalog.machines.length : null,
    machineStatus: status.machineStatus,
  };
  const packType = config?.pack?.code;
  if (typeof packType !== 'string' || packType.length === 0) return evidence;
  try {
    return { ...evidence, packType, expectedCardCount: expectedCardCountFromCatalog({ catalog, packType }) };
  } catch (error) {
    return { ...evidence, configured: false, packType, reason: error.message };
  }
}

export async function mutatePurchase({ liveMode, adapters, signerClient, config, context, request }) {
  if (liveMode !== true) throw new Error('stage-driver internal error: mutatePurchase reached without liveMode');
  if (!adapters?.collectorCrypt) throw new Error('purchase mutate requires a configured collector-crypt client');
  requireSolanaConfiguration({ adapters, config, signerClient, stage: 'purchase' });
  const asset = configuredSettlementAsset(config);
  const money = assertSolanaSignerMoneyConfiguration({ config, asset, stage: 'purchase' });
  const prepared = request ?? context?.request ?? await preparePurchaseRequest({ adapters, config });
  if (!Number.isSafeInteger(prepared.expectedCardCount) || prepared.expectedCardCount < 1) {
    throw new Error('purchase mutation requires a positive prepared card-count expectation');
  }
  const account = await readAssociatedTokenAccount(adapters.solana.client, prepared.playerAddress, asset.assetId);
  if (!account.exists) throw new Error('purchase mutate requires the operator settlement token account to exist');
  if (account.decimals !== asset.decimals) throw new Error('purchase mutate settlement token account decimals do not match configured settlementAsset');

  requireLiveMutationAuthority();
  const generated = await adapters.collectorCrypt.generatePack({
    playerAddress: prepared.playerAddress,
    ...(prepared.packType ? { packType: prepared.packType } : {}),
  });
  const { signer, signed } = await decodeAndSignProviderTransaction({
    transaction: generated.transaction,
    stage: 'purchase',
    adapters,
    config,
    money,
    signerClient,
  });
  const submitted = await signer.broadcast(signed);
  return { memo: generated.memo, signature: submitted.signature, expectedCardCount: prepared.expectedCardCount };
}

export async function reconcileLivePurchase({ adapters, config, cycleRepository, context }) {
  const evidence = responseEvidence(await cycleRepository.readOperationalStageAttempt(context.cycleId, 'purchase'));
  if (!evidence || !adapters?.collectorCrypt || !adapters?.solana?.client) return null;
  const asset = configuredSettlementAsset(config);
  let packStatus;
  try {
    packStatus = await adapters.collectorCrypt.getPackStatus({ memo: evidence.memo });
  } catch {
    return null;
  }
  if (packStatus.memo !== evidence.memo || !plainObject(packStatus.pack)
    || packStatus.pack.transaction_signature !== evidence.signature
    || packStatus.pack.token_mint !== asset.assetId) {
    await holdDataUnverified(cycleRepository, context, { stage: 'purchase', memo: evidence.memo, signature: evidence.signature, packStatus });
    return null;
  }
  let signatureStatus;
  try {
    signatureStatus = await readFinalizedSignatureStatus(adapters.solana.client, evidence.signature);
  } catch {
    return null;
  }
  if (signatureStatus === null) return null;
  if (signatureStatus.err) {
    await holdDataUnverified(cycleRepository, context, { stage: 'purchase', memo: evidence.memo, signature: evidence.signature, signatureStatus });
    return null;
  }
  let entries;
  try {
    entries = await getFinalizedTokenBalanceChanges(adapters.solana.client, evidence.signature);
  } catch {
    return null;
  }
  const packCost = exactDebit(entries, config.accounts.solana, asset);
  if (packCost === null || packCost.amountAtomic === '0') {
    await holdDataUnverified(cycleRepository, context, { stage: 'purchase', memo: evidence.memo, signature: evidence.signature, reason: 'exact settlement debit was not observed' });
    return null;
  }
  return { memo: evidence.memo, signature: evidence.signature, expectedCardCount: evidence.expectedCardCount, packCost };
}
