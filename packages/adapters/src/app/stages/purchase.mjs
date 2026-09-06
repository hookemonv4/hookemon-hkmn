import {
  getFinalizedTokenBalanceChanges,
  readAssociatedTokenAccount,
  readBlockHeight,
  readBlockhashValidity,
  readFinalizedSignatureStatus,
} from '../../solana-rpc.mjs';
import { assertTypedAmount, MAXIMUM_PACK_BATCH_SIZE } from '../../../../runner/src/cycle/money-schemas.mjs';
import {
  decodeProviderTransaction,
  evaluate as evaluateTransactionPolicy,
} from '../../signing/transaction-policy.mjs';
import { collectorPolicyForStage } from '../../signing/collector-policy-loader.mjs';
import { OPERATOR_SOLANA_ROLE, wrapTransactionPolicySignerClient } from '../../signing/signer-client.mjs';
import { requireCollectorOnlyMutationAuthority } from '../../../rehearsal/collector-only-authorization.mjs';
import { parseCollectorMachineContains } from '../../collector-crypt.mjs';
import {
  assertSolanaSignerFeeEnvelope,
  assertSolanaSignerMoneyConfiguration,
} from './solana-money-controls.mjs';

const canonicalUnsignedInteger = /^(0|[1-9][0-9]*)$/;
const DEFAULT_UNRESOLVED_CARD_DEADLINE_MINUTES = 30;
const MINIMUM_UNRESOLVED_CARD_DEADLINE_MINUTES = 5;
const MAXIMUM_UNRESOLVED_CARD_DEADLINE_MINUTES = 1440;

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
  const bundlePolicy = collectorPolicyForStage(config, stage);
  if (bundlePolicy !== null) return bundlePolicy;
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
        requireCollectorOnlyMutationAuthority(config);
        return signerClient.solana.sign(request);
      },
    },
    policy: requirePolicy(config, stage),
    decodeOptions,
    broadcast: async signed => {
      if (!(await readBlockhashValidity(adapters.solana.client, decoded.blockhash))) {
        throw new Error(`Collector ${stage} transaction blockhash expired before submission`);
      }
      requireCollectorOnlyMutationAuthority(config);
      return adapters.collectorCrypt.submitTransaction({ signedTransaction: signed.signedTxBase64 });
    },
  });
  return { signer, signed: await signer.sign(transaction) };
}

function expectedCardCountFromCatalog({ catalog, packType }) {
  if (!plainObject(catalog) || !Array.isArray(catalog.machines)) {
    throw new Error('purchase prepareRequest received an invalid Collector machine catalog');
  }
  const matches = catalog.machines.filter(machine => plainObject(machine) && machine.code === packType);
  if (matches.length !== 1) throw new Error('purchase prepareRequest requires exactly one configured Collector machine');
  return parseCollectorMachineContains(matches[0].contains);
}

async function expectedCardCountPerPack({ adapters, packType }) {
  if (typeof adapters?.collectorCrypt?.getMachines !== 'function') {
    throw new Error('purchase prepareRequest requires collector-crypt machine data');
  }
  const count = expectedCardCountFromCatalog({ catalog: await adapters.collectorCrypt.getMachines(), packType });
  // open() supports exactly one card per pack (the documented openPack response carries a single
  // nft_address). A catalog entry needing more is rejected here, at admission, before any pack in
  // the batch is purchased.
  if (count !== 1) throw new Error(`Collector machine "${packType}" needs an unsupported ${count}-card fan-out per pack`);
  return count;
}

/**
 * Catalog/admission-time quantity validation. A configured quantity above the documented
 * provider batch ceiling, or above the shared durable-journal payload bound
 * (`MAXIMUM_PACK_BATCH_SIZE`, packages/runner/src/cycle/money-schemas.mjs), is rejected here —
 * before any spend — rather than discovered only after a purchase attempt.
 */
function assertConfiguredPackQuantity(value) {
  if (value === undefined) return 1;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_PACK_BATCH_SIZE) {
    throw new Error(`Collector purchase config.pack.quantity must be an integer from 1 through ${MAXIMUM_PACK_BATCH_SIZE}`);
  }
  return value;
}

/**
 * Refuses admission, before any spend, when purchasing `quantity` more packs could push the
 * outstanding held-position count or value past the operator's configured ceiling — even though
 * every individual position stays within limits at claim-process admission (a single multi-pack
 * batch can otherwise add several held positions in one already-admitted cycle). Silently does
 * nothing when the caller has no held-position read access (the current default, non-collector-only
 * preparation input) or the operator has not configured a ceiling.
 */
async function assertHeldHeadroom({ cycleRepository, context, config, quantity }) {
  if (typeof cycleRepository?.listHeldPositions !== 'function') return;
  const maxHeldPositions = config?.maxHeldPositions;
  const maxHeldValueMicroUsdg = config?.maxHeldValueMicroUsdg;
  const checksCount = Number.isSafeInteger(maxHeldPositions);
  const checksValue = typeof maxHeldValueMicroUsdg === 'string' && canonicalUnsignedInteger.test(maxHeldValueMicroUsdg);
  if (!checksCount && !checksValue) return;
  const positions = await cycleRepository.listHeldPositions({ includeResolved: false });
  if (checksCount) {
    const deficit = positions.length + quantity - maxHeldPositions;
    if (deficit > 0) {
      throw new Error(`purchase admission refused: HELD_LIMIT would exceed maxHeldPositions by ${deficit} position(s) (${positions.length} outstanding + ${quantity} requested > ${maxHeldPositions})`);
    }
  }
  if (checksValue) {
    const currentValue = positions.reduce((sum, position) => sum + BigInt(position.valueMicroUsdg ?? '0'), 0n);
    let worstCasePerPack = 0n;
    if (typeof context?.cycleId === 'string' && typeof cycleRepository.describeCycle === 'function') {
      const description = await cycleRepository.describeCycle(context.cycleId);
      if (typeof description?.releaseAmount === 'string' && canonicalUnsignedInteger.test(description.releaseAmount)) {
        worstCasePerPack = BigInt(description.releaseAmount) / BigInt(quantity);
      }
    }
    const projectedValue = currentValue + (worstCasePerPack * BigInt(quantity));
    const maximum = BigInt(maxHeldValueMicroUsdg);
    if (projectedValue > maximum) {
      throw new Error(`purchase admission refused: HELD_LIMIT would exceed maxHeldValueMicroUsdg by ${(projectedValue - maximum).toString()} (worst case ${projectedValue.toString()} > ${maximum.toString()})`);
    }
  }
}

export async function preparePurchaseRequest({ adapters, config, cycleRepository, context }) {
  const playerAddress = config?.accounts?.solana;
  if (typeof playerAddress !== 'string' || playerAddress.length === 0) throw new Error('purchase prepareRequest requires HOOKEMON_SOLANA_ACCOUNT');
  const packType = config?.pack?.code;
  const quantity = assertConfiguredPackQuantity(config?.pack?.quantity);
  await assertHeldHeadroom({ cycleRepository, context, config, quantity });
  const request = {
    provider: 'collector-crypt',
    operation: 'purchase',
    playerAddress,
    quantity,
  };
  if (typeof packType !== 'string' || packType.length === 0) return request;
  return { ...request, packType, expectedCardCountPerPack: await expectedCardCountPerPack({ adapters, packType }) };
}

export async function probePurchase({ adapters, config }) {
  if (!adapters.collectorCrypt) return { wouldPurchase: true, configured: false, reason: 'collector-crypt client is not configured' };
  const [catalog, status] = await Promise.all([adapters.collectorCrypt.getMachines(), adapters.collectorCrypt.getStatus()]);
  const evidence = {
    wouldPurchase: true,
    configured: true,
    machineCount: Array.isArray(catalog?.machines) ? catalog.machines.length : null,
    machineStatus: status.machineStatus,
    quantity: assertConfiguredPackQuantity(config?.pack?.quantity),
  };
  const packType = config?.pack?.code;
  if (typeof packType !== 'string' || packType.length === 0) return evidence;
  try {
    return { ...evidence, packType, expectedCardCountPerPack: expectedCardCountFromCatalog({ catalog, packType }) };
  } catch (error) {
    return { ...evidence, configured: false, packType, reason: error.message };
  }
}

function unresolvedCardDeadlineMinutes(config) {
  const value = config?.unresolvedCardDeadlineMinutes ?? DEFAULT_UNRESOLVED_CARD_DEADLINE_MINUTES;
  if (!Number.isSafeInteger(value)
    || value < MINIMUM_UNRESOLVED_CARD_DEADLINE_MINUTES
    || value > MAXIMUM_UNRESOLVED_CARD_DEADLINE_MINUTES) {
    throw new Error('purchase unresolvedCardDeadlineMinutes is invalid');
  }
  return value;
}

function pastDeadline(sinceMs, config, context) {
  const nowMs = context?.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('purchase reconciliation clock is invalid');
  return nowMs >= sinceMs + unresolvedCardDeadlineMinutes(config) * 60_000;
}

async function holdWholeCycle(cycleRepository, context, evidence) {
  if (typeof cycleRepository?.holdCycle !== 'function') throw new Error('purchase reconciliation requires cycleRepository.holdCycle');
  await cycleRepository.holdCycle(context.cycleId, 'HELD_DATA_UNVERIFIED', evidence);
  return null;
}

export async function mutatePurchase({ liveMode, adapters, signerClient, config, cycleRepository, context, request }) {
  if (liveMode !== true) throw new Error('stage-driver internal error: mutatePurchase reached without liveMode');
  if (!adapters?.collectorCrypt) throw new Error('purchase mutate requires a configured collector-crypt client');
  requireSolanaConfiguration({ adapters, config, signerClient, stage: 'purchase' });
  const asset = configuredSettlementAsset(config);
  const money = assertSolanaSignerMoneyConfiguration({ config, asset, stage: 'purchase' });
  const prepared = request ?? context?.request ?? await preparePurchaseRequest({ adapters, config });
  const quantity = assertConfiguredPackQuantity(prepared.quantity);
  if (!Number.isSafeInteger(prepared.expectedCardCountPerPack) || prepared.expectedCardCountPerPack < 1) {
    throw new Error('purchase mutation requires a positive prepared per-pack card-count expectation');
  }
  const account = await readAssociatedTokenAccount(adapters.solana.client, prepared.playerAddress, asset.assetId);
  if (!account.exists) throw new Error('purchase mutate requires the operator settlement token account to exist');
  if (account.decimals !== asset.decimals) throw new Error('purchase mutate settlement token account decimals do not match configured settlementAsset');

  // The batch may already be durably recorded from an interrupted prior attempt (crash after the
  // provider call returned, before every pack finished signing). Reuse it rather than requesting
  // a second batch under the same memo identity — a fresh generateYoloPacks call after the
  // provider already committed the first would be a genuine double purchase.
  let batch = await cycleRepository.readPackBatchRequest(context.cycleId, 'purchase');
  let unsignedTransactionsByMemo = null;
  if (batch === null) {
    // Persist exactly what is about to be requested -- cycle, quantity, and pack code -- before
    // the batch call itself. If the call's response is lost with no memo at all, this durable,
    // human-readable intent (not just the generic stage attempt's opaque request digest) is what
    // an operator correlates against provider support while the cycle stays held.
    await cycleRepository.recordPackBatchIntent(context.cycleId, 'purchase', {
      quantity,
      packType: prepared.packType ?? null,
      expectedCardCountPerPack: prepared.expectedCardCountPerPack,
      playerAddress: prepared.playerAddress,
    });
    requireCollectorOnlyMutationAuthority(config);
    const generated = await adapters.collectorCrypt.generateYoloPacks({
      playerAddress: prepared.playerAddress,
      quantity,
      ...(prepared.packType ? { packType: prepared.packType } : {}),
    });
    unsignedTransactionsByMemo = new Map(generated.packs.map(pack => [pack.memo, pack.transaction]));
    const packs = generated.packs.map((pack, packIndex) => ({
      packIndex,
      memo: pack.memo,
      expectedCardCount: prepared.expectedCardCountPerPack,
      packType: prepared.packType ?? null,
    }));
    batch = await cycleRepository.recordPackBatchRequest(context.cycleId, 'purchase', packs);
  }

  // Sign and broadcast every pack this invocation still holds unsigned bytes for. A pack whose
  // bytes were only ever in a crashed process's memory cannot be re-signed under its existing
  // memo; reconcileLivePurchase resolves it to "not purchased" once its deadline passes.
  if (unsignedTransactionsByMemo !== null) {
    for (const pack of batch.packs) {
      const transaction = unsignedTransactionsByMemo.get(pack.memo);
      if (transaction === undefined) continue;
      const { signer, signed } = await decodeAndSignProviderTransaction({
        transaction,
        stage: 'purchase',
        adapters,
        config,
        money,
        signerClient,
      });
      await signer.broadcast(signed);
    }
  }

  return { quantity, expectedCardCountPerPack: prepared.expectedCardCountPerPack };
}

async function reconcilePack({ adapters, config, context, asset, pack, playerAddress, deadlineSinceMs }) {
  let packStatus;
  try {
    packStatus = await adapters.collectorCrypt.getPackStatus({ memo: pack.memo });
  } catch {
    return { determined: false };
  }
  if (packStatus.memo !== pack.memo) {
    return { determined: true, outcome: 'anomaly', evidence: { reason: 'pack status memo did not match', packStatus } };
  }
  if (packStatus.pack === null) {
    if (!pastDeadline(deadlineSinceMs, config, context)) return { determined: false };
    return {
      determined: true,
      outcome: 'notPurchased',
      packIndex: pack.packIndex,
      memo: pack.memo,
      evidence: { reason: 'no provider purchase evidence before the reconcile deadline' },
    };
  }
  if (!plainObject(packStatus.pack) || typeof packStatus.pack.transaction_signature !== 'string'
    || packStatus.pack.transaction_signature.length === 0 || packStatus.pack.token_mint !== asset.assetId) {
    return { determined: true, outcome: 'anomaly', evidence: { reason: 'pack status does not carry a documented purchase record', packStatus } };
  }
  const signature = packStatus.pack.transaction_signature;
  let signatureStatus;
  try {
    signatureStatus = await readFinalizedSignatureStatus(adapters.solana.client, signature);
  } catch {
    return { determined: false };
  }
  if (signatureStatus === null) return { determined: false };
  if (signatureStatus.err) {
    return {
      determined: true,
      outcome: 'notPurchased',
      packIndex: pack.packIndex,
      memo: pack.memo,
      evidence: { reason: 'provider purchase transaction finalized with an error', signature, signatureStatus },
    };
  }
  let entries;
  try {
    entries = await getFinalizedTokenBalanceChanges(adapters.solana.client, signature);
  } catch {
    return { determined: false };
  }
  const debits = entries.filter(entry => entry.owner === playerAddress && entry.mint === asset.assetId && BigInt(entry.postAmount) < BigInt(entry.preAmount));
  if (debits.length !== 1) {
    return { determined: true, outcome: 'anomaly', evidence: { reason: 'exact settlement debit was not observed', signature } };
  }
  const packCost = typedAmount(asset, BigInt(debits[0].preAmount) - BigInt(debits[0].postAmount), 'purchase pack cost');
  if (packCost.amountAtomic === '0') {
    return { determined: true, outcome: 'anomaly', evidence: { reason: 'observed settlement debit was zero', signature } };
  }
  return {
    determined: true,
    outcome: 'purchased',
    packIndex: pack.packIndex,
    memo: pack.memo,
    signature,
    expectedCardCount: pack.expectedCardCount,
    packCost,
  };
}

export async function reconcileLivePurchase({ adapters, config, cycleRepository, context }) {
  const batch = await cycleRepository.readPackBatchRequest(context.cycleId, 'purchase');
  if (batch === null) {
    const record = await cycleRepository.readOperationalStageAttempt(context.cycleId, 'purchase');
    if (record?.attempt?.state !== 'SENT_UNKNOWN' || !Number.isSafeInteger(record.sentAtMs)) return null;
    if (!pastDeadline(record.sentAtMs, config, context)) return null;
    const intentRecord = await cycleRepository.readPackBatchIntent(context.cycleId, 'purchase');
    return holdWholeCycle(cycleRepository, context, {
      stage: 'purchase',
      attempt: record.attempt,
      sentAtMs: record.sentAtMs,
      deadlineMinutes: unresolvedCardDeadlineMinutes(config),
      // The pre-call intent (quantity, pack code) is the durable, human-readable record of what
      // was requested when no memo ever came back to check provider status against.
      intent: intentRecord?.intent ?? null,
      reason: 'purchase batch generation remained sent-unknown past the reconcile deadline with no durably generated pack',
    });
  }
  if (!adapters?.collectorCrypt || !adapters?.solana?.client) return null;
  const asset = configuredSettlementAsset(config);
  // The wallet that actually made this purchase is bound durably at the pre-call intent, not
  // re-derived from the live operator config -- a config change (wallet rotation, environment
  // swap) between purchase and a later restart/reconcile must never change which address this
  // cycle's settlement debit is attributed to.
  const intentRecord = await cycleRepository.readPackBatchIntent(context.cycleId, 'purchase');
  if (intentRecord === null) throw new Error('purchase reconciliation requires the pre-call intent that must exist alongside any recorded batch');
  const playerAddress = intentRecord.intent.playerAddress;

  const outcomes = [];
  for (const pack of batch.packs) {
    const result = await reconcilePack({ adapters, config, context, asset, pack, playerAddress, deadlineSinceMs: batch.requestedAtMs });
    if (!result.determined) return null;
    if (result.outcome === 'anomaly') {
      return holdWholeCycle(cycleRepository, context, {
        stage: 'purchase',
        packIndex: pack.packIndex,
        memo: pack.memo,
        ...result.evidence,
      });
    }
    outcomes.push(result);
  }

  const purchased = outcomes.filter(outcome => outcome.outcome === 'purchased');
  return {
    quantity: batch.packs.length,
    packs: outcomes.map(outcome => (outcome.outcome === 'purchased'
      ? {
        packIndex: outcome.packIndex,
        memo: outcome.memo,
        status: 'purchased',
        signature: outcome.signature,
        expectedCardCount: outcome.expectedCardCount,
        packCost: outcome.packCost,
      }
      : { packIndex: outcome.packIndex, memo: outcome.memo, status: 'not_purchased' })),
    purchasedCount: purchased.length,
  };
}
