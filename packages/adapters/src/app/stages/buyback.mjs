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
import { requireCollectorOnlyMutationAuthority } from '../../../rehearsal/collector-only-authorization.mjs';
import { COLLECTOR_CRYPT_SETTLEMENT_ASSET } from '../../collector-crypt.mjs';
import {
  assertSolanaSignerFeeEnvelope,
  assertSolanaSignerMoneyConfiguration,
} from './solana-money-controls.mjs';

const canonicalUnsignedInteger = /^(0|[1-9][0-9]*)$/;
const DEFAULT_UNRESOLVED_CARD_DEADLINE_MINUTES = 30;
const MINIMUM_UNRESOLVED_CARD_DEADLINE_MINUTES = 5;
const MAXIMUM_UNRESOLVED_CARD_DEADLINE_MINUTES = 1440;
const CUSTODY_BUCKETS = Object.freeze([
  'claimed', 'bridgeOut', 'bridgeIn', 'packCost', 'buybackProceeds', 'returnInput', 'returnReceived',
  'refunds', 'residual', 'heldAssets', 'heldPositions', 'payoutLiability', 'dust', 'unattributed',
]);

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

function sameAmount(left, right) {
  return left?.chainId === right?.chainId && left?.assetId === right?.assetId
    && left?.decimals === right?.decimals && left?.amountAtomic === right?.amountAtomic;
}

function sameAsset(left, right) {
  return left?.chainId === right?.chainId && left?.assetId === right?.assetId && left?.decimals === right?.decimals;
}

/** Every epic-gate pack: a pass-through held entry, or an approved sell decision to act on. */
function epicGatePacks(epicGate) {
  if (epicGate?.status !== 'COMPLETE' || !plainObject(epicGate.evidence) || !Array.isArray(epicGate.evidence.packs)) {
    throw new Error('buyback requires a completed epic-gate stage with a pack ledger');
  }
  return epicGate.evidence.packs;
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

const HELD_POSITION_EVM_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;

/**
 * ADR-0026: the sole raw-to-canonical relation this repository recognizes for the configured USDG
 * asset -- chain 4663, six decimals, a normalized lower-case 20-byte EVM token -- matching
 * `evmUsdgCanonicalCustodyIdentity` in cycle-repository.mjs exactly, so this held write lands on
 * the same custody row claim and payout already maintain instead of a competing raw identity.
 */
function heldPositionLedgerAsset(config) {
  const asset = config?.moneyConfiguration?.assets?.usdg;
  const typed = assertTypedAmount({ ...asset, amountAtomic: '0' }, 'held buyback USDG ledger asset');
  if (typed.chainId !== '4663' || typed.decimals !== 6 || !HELD_POSITION_EVM_ADDRESS_PATTERN.test(typed.assetId)) {
    throw new Error('held buyback USDG ledger asset must use the configured six-decimal normalized USDG asset');
  }
  const chainId = `eip155:${typed.chainId}`;
  return { chainId, assetId: `${chainId}/erc20:${typed.assetId}`, decimals: typed.decimals };
}

/** Carves one pack's card out as held. Never terminalizes the cycle or blocks another pack. */
async function holdPack(cycleRepository, config, context, packIndex, memo, mint, terminalState, evidence, reason = heldPositionReason(terminalState)) {
  if (typeof memo !== 'string' || memo.length === 0 || typeof mint !== 'string' || mint.length === 0) {
    throw new Error('buyback cannot record a held card without its durable memo and card identity');
  }
  if (typeof cycleRepository?.recordHeldPosition !== 'function' || typeof cycleRepository.describeCycle !== 'function') {
    throw new Error('buyback requires held-position attribution capabilities');
  }
  const description = await cycleRepository.describeCycle(context.cycleId);
  const costMicroUsdg = description?.releaseAmount;
  const packId = config?.pack?.code;
  if (typeof costMicroUsdg !== 'string' || !canonicalUnsignedInteger.test(costMicroUsdg)
    || typeof packId !== 'string' || packId.length === 0) {
    throw new Error('buyback cannot attribute a held card without attributable cycle purchase evidence');
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
    ...(packIndex === null ? {} : { packIndex }),
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

async function decodeAndSign({ transaction, mint, adapters, config, money, signerClient, beforeSign = null, preflightAuthority }) {
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
    nativeChainId: config.solana.chainId,
    stage: 'buyback',
  });
  const signer = wrapTransactionPolicySignerClient({
    client: {
      role: signerClient.solana.role ?? OPERATOR_SOLANA_ROLE,
      async sign(request) {
        if (beforeSign !== null) await beforeSign();
        requireCollectorOnlyMutationAuthority(config, preflightAuthority);
        return signerClient.solana.sign(request);
      },
    },
    policy: buyback.policy,
    decodeOptions,
    broadcast: async signed => {
      if (!(await readBlockhashValidity(adapters.solana.client, decoded.blockhash))) {
        throw new Error('buyback provider transaction blockhash expired before submission');
      }
      requireCollectorOnlyMutationAuthority(config, preflightAuthority);
      return adapters.collectorCrypt.submitTransaction({ signedTransaction: signed.signedTxBase64 });
    },
  });
  return { signer, signed: await signer.sign(transaction) };
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

function assetKindOf(openPacks, packIndex) {
  return openPacks.find(pack => pack.packIndex === packIndex)?.assetKind ?? 'spl';
}

export async function prepareBuybackRequest({ cycleRepository, context }) {
  const epicGate = await cycleRepository.readStage(context.cycleId, 'epic-gate');
  return { provider: 'collector-crypt', operation: 'buyback', packs: epicGatePacks(epicGate) };
}

export async function probeBuyback({ adapters, config, cycleRepository, context }) {
  const epicGate = await cycleRepository.readStage(context.cycleId, 'epic-gate');
  let packs;
  try {
    packs = epicGate.status === 'COMPLETE' ? epicGatePacks(epicGate) : null;
  } catch {
    packs = null;
  }
  if (!adapters.collectorCrypt || packs === null) {
    return { wouldBuyback: true, configured: false, reason: 'collector-crypt client is not configured, or the epic-gate stage has not recorded a durable pack ledger yet' };
  }
  const available = await Promise.all(packs
    .filter(pack => pack.decision === 'sell')
    .map(pack => adapters.collectorCrypt.getBuybackAvailable({ nft: pack.mint, wallet: config.accounts.solana ?? undefined })));
  return { wouldBuyback: true, configured: true, packs, available };
}

/** Requests and signs one pack's buyback. Any failure carves the pack out as held; never throws. */
/**
 * Everything up to and including the quote match is deterministic and money-safe to hold on:
 * nothing has been sent to the provider yet, so a thrown error here never leaves an ambiguous
 * mutation behind.
 */
async function prepareSale({ adapters, config, pack }) {
  const asset = configuredSettlementAsset(config);
  const money = assertSolanaSignerMoneyConfiguration({ config, asset, stage: 'buyback' });
  if (!sameAsset(pack.offer, asset) || !sameAsset(pack.insuredValue, asset)) {
    throw new Error('completed epic-gate amounts use an unexpected settlement asset');
  }
  const proceedsAccount = dedicatedProceedsAccount(config);
  const account = await readAssociatedTokenAccount(adapters.solana.client, config.accounts.solana, asset.assetId);
  if (!account.exists || account.decimals !== asset.decimals) throw new Error('buyback requires a matching operator settlement token account');
  if (proceedsAccount !== null && account.address !== proceedsAccount) {
    throw new Error('buyback dedicated proceeds account is not the verified operator settlement token account');
  }
  const available = await adapters.collectorCrypt.getBuybackAvailable({ nft: pack.mint, wallet: config.accounts.solana });
  if (!available.available) {
    return { unavailable: true };
  }
  const quote = typedBuybackAmount(available.amount, 'buyback quote');
  if (!sameAmount(quote, pack.offer)) {
    return { unavailable: false, quoteMismatch: quote };
  }
  return { unavailable: false, quoteMismatch: null, asset, money, proceedsAccount, quote };
}

/** Requests, signs, and broadcasts one pack's buyback. Any failure carves it out as held. */
async function sellPack({ adapters, config, signerClient, cycleRepository, context, pack, preflightAuthority }) {
  if (pack.decision === 'held') return pack;
  let prepared;
  try {
    prepared = await prepareSale({ adapters, config, pack });
  } catch (error) {
    return holdPack(cycleRepository, config, context, pack.packIndex, pack.memo, pack.mint, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', memo: pack.memo, mint: pack.mint, reason: error.message,
    });
  }
  if (prepared.unavailable) {
    return holdPack(cycleRepository, config, context, pack.packIndex, pack.memo, pack.mint, 'HELD_UNAVAILABLE', {
      stage: 'buyback', memo: pack.memo, mint: pack.mint, insuredValue: pack.insuredValue, reason: 'buyback is unavailable',
    });
  }
  if (prepared.quoteMismatch !== null) {
    return holdPack(cycleRepository, config, context, pack.packIndex, pack.memo, pack.mint, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', memo: pack.memo, mint: pack.mint, quote: prepared.quoteMismatch, epicDecision: pack, reason: 'buyback quote differs from the completed epic decision',
    });
  }
  const { asset, money, proceedsAccount, quote } = prepared;
  // From here on, a thrown error is provider-ambiguous: the mutation may or may not have landed
  // server-side. This pack is marked "unknown", not held — reconciliation resolves it from
  // durable provider state using its own already-known memo, holding only past its deadline.
  try {
    requireCollectorOnlyMutationAuthority(config, preflightAuthority);
    const built = await adapters.collectorCrypt.buyback(buildCollectorBuybackRequest({ config, mint: pack.mint }));
    const refundAmount = typedBuybackAmount(built.refundAmount, 'buyback refund amount');
    if (built.memo !== pack.memo || !sameAmount(refundAmount, quote)) {
      return holdPack(cycleRepository, config, context, pack.packIndex, pack.memo, pack.mint, 'HELD_DATA_UNVERIFIED', {
        stage: 'buyback', memo: pack.memo, mint: pack.mint, quote, built, insuredValue: pack.insuredValue, reason: 'provider buyback response did not bind the quote and memo',
      });
    }
    const { signer, signed } = await decodeAndSign({
      transaction: built.serializedTransaction,
      mint: pack.mint,
      adapters,
      config,
      money,
      signerClient,
      preflightAuthority,
      beforeSign: async () => {
        await context.assertLease?.();
        const refreshed = await adapters.collectorCrypt.getBuybackAvailable({ nft: pack.mint, wallet: config.accounts.solana });
        const refreshedQuote = typedBuybackAmount(refreshed.amount, 'buyback quote');
        if (!sameAmount(refreshedQuote, quote)) throw new Error('buyback quote changed before signing');
      },
    });
    const submitted = await signer.broadcast(signed);
    return {
      packIndex: pack.packIndex,
      decision: 'submitted',
      memo: pack.memo,
      mint: pack.mint,
      signature: submitted.signature,
      quote,
      refundAmount,
      ...(proceedsAccount === null ? {} : { proceedsAccount }),
    };
  } catch {
    return {
      packIndex: pack.packIndex,
      decision: 'unknown',
      memo: pack.memo,
      mint: pack.mint,
      quote,
      ...(proceedsAccount === null ? {} : { proceedsAccount }),
    };
  }
}

export async function mutateBuyback({ liveMode, adapters, config, signerClient, cycleRepository, context, request, preflightAuthority }) {
  if (liveMode !== true) throw new Error('stage-driver internal error: mutateBuyback reached without liveMode');
  if (!adapters?.collectorCrypt) throw new Error('buyback requires a configured collector-crypt client');
  const prepared = request ?? context?.request ?? await prepareBuybackRequest({ cycleRepository, context });
  const outcomes = [];
  for (const pack of prepared.packs) outcomes.push(await sellPack({ adapters, config, signerClient, cycleRepository, context, pack, preflightAuthority }));
  return { packs: outcomes };
}

/** Confirms one submitted pack's finality and proceeds; returns null while still pending. */
async function reconcilePack({ adapters, config, cycleRepository, context, submitted, assetKind }) {
  if (submitted.decision === 'held') return submitted;
  const asset = configuredSettlementAsset(config);
  const proceedsAccount = submitted.proceedsAccount ?? null;
  let quote;
  let refundAmount;
  try {
    quote = typedBuybackAmount(submitted.quote, 'recorded buyback quote');
    refundAmount = typedBuybackAmount(submitted.refundAmount, 'recorded buyback refund amount');
  } catch {
    return holdPack(cycleRepository, config, context, submitted.packIndex, submitted.memo, submitted.mint, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', ...submitted, reason: 'recorded buyback amount is invalid',
    });
  }
  if (!sameAsset(quote, asset) || !sameAmount(quote, refundAmount)) {
    return holdPack(cycleRepository, config, context, submitted.packIndex, submitted.memo, submitted.mint, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', ...submitted, reason: 'recorded buyback amounts do not bind the settlement quote',
    });
  }
  if (typeof adapters.collectorCrypt.getBuybackCheck !== 'function') return null;
  let check;
  try {
    check = await adapters.collectorCrypt.getBuybackCheck({ memo: submitted.memo });
  } catch {
    return null;
  }
  if (!plainObject(check) || typeof check.exists !== 'boolean') {
    return holdPack(cycleRepository, config, context, submitted.packIndex, submitted.memo, submitted.mint, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', ...submitted, check, reason: 'buyback check response is invalid',
    });
  }
  if (!check.exists) return null;
  if (typeof check.status !== 'string') {
    return holdPack(cycleRepository, config, context, submitted.packIndex, submitted.memo, submitted.mint, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', ...submitted, check, reason: 'buyback check status is invalid',
    });
  }
  if (check.status === '') return null;
  if (check.status !== 'complete') {
    return holdPack(cycleRepository, config, context, submitted.packIndex, submitted.memo, submitted.mint, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', ...submitted, check, reason: 'buyback check status is not a documented pending or complete value',
    });
  }
  let checkedQuote;
  try {
    checkedQuote = typedAmount(asset, check.buybackAmount, 'completed buyback amount');
  } catch {
    return holdPack(cycleRepository, config, context, submitted.packIndex, submitted.memo, submitted.mint, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', ...submitted, check, reason: 'completed buyback amount is invalid',
    });
  }
  if (check.playerWallet !== config.accounts.solana || check.nft !== submitted.mint
    || check.transactionSignature !== submitted.signature || typeof check.createdAt !== 'string' || check.createdAt.length === 0
    || !sameAmount(checkedQuote, quote)) {
    return holdPack(cycleRepository, config, context, submitted.packIndex, submitted.memo, submitted.mint, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', ...submitted, check, checkedQuote, reason: 'completed buyback check does not bind the memo, signature, card, and quote',
    });
  }
  let status;
  try {
    status = await readFinalizedSignatureStatus(adapters.solana.client, submitted.signature);
  } catch {
    return null;
  }
  if (status === null) return null;
  if (status.err) {
    return holdPack(cycleRepository, config, context, submitted.packIndex, submitted.memo, submitted.mint, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', ...submitted, signatureStatus: status, reason: 'buyback transaction finalized with an error',
    });
  }
  let leftOperator;
  let entries;
  try {
    leftOperator = await cardLeftOperator({ adapters, signature: submitted.signature, mint: submitted.mint, owner: config.accounts.solana, assetKind });
    entries = await getFinalizedTokenBalanceChanges(adapters.solana.client, submitted.signature);
  } catch {
    return null;
  }
  const proceedsEntry = exactPositiveDeltaEntry(entries, config.accounts.solana, asset, proceedsAccount);
  const proceeds = proceedsEntry?.proceeds ?? null;
  if (!leftOperator || proceeds === null || !sameAmount(proceeds, quote)) {
    return holdPack(cycleRepository, config, context, submitted.packIndex, submitted.memo, submitted.mint, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', ...submitted, leftOperator, proceeds, reason: 'finalized card and settlement deltas did not match',
    });
  }
  return {
    packIndex: submitted.packIndex,
    decision: 'sold',
    memo: submitted.memo,
    mint: submitted.mint,
    signature: submitted.signature,
    proceeds,
    ...(proceedsAccount === null ? {} : {
      proceedsProjection: {
        account: proceedsAccount,
        beforeAtomic: proceedsEntry.entry.preAmount,
        afterAtomic: proceedsEntry.entry.postAmount,
        delta: proceeds,
      },
    }),
  };
}

function emptyLedger(cycleId, asset, buybackProceedsAtomic) {
  return {
    schema: 'hookemon.custody-ledger.v1',
    cycleId,
    chainId: asset.chainId,
    assetId: asset.assetId,
    decimals: asset.decimals,
    ...Object.fromEntries(CUSTODY_BUCKETS.map(bucket => [bucket, bucket === 'buybackProceeds' ? buybackProceedsAtomic : '0'])),
  };
}

/** Records the cycle's total realized buyback proceeds exactly once, summed over sold packs only. */
async function recordTotalProceedsLedger(cycleRepository, cycleId, asset, soldPacks) {
  const total = soldPacks.reduce((sum, pack) => sum + BigInt(pack.proceeds.amountAtomic), 0n);
  let ledger = emptyLedger(cycleId, asset, total.toString());
  if (typeof cycleRepository.describeCycle === 'function') {
    const state = await cycleRepository.describeCycle(cycleId);
    // Must match cycle-repository.mjs's own custodyLedgerKey exactly (NUL-joined, not a
    // space): this looks up that repository's real Map key, not a freshly invented format.
    const existing = state?.custodyLedgers?.get?.(`${asset.chainId}\u0000${asset.assetId}`);
    if (existing) ledger = { ...existing, buybackProceeds: total.toString() };
  }
  await cycleRepository.recordCustodyLedger(cycleId, ledger);
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

function pastDeadline(sinceMs, config, context) {
  const nowMs = context?.nowMs ?? Date.now();
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('buyback reconciliation clock is invalid');
  return nowMs >= sinceMs + unresolvedCardDeadlineMinutes(config) * 60_000;
}

/** A legacy (pre-batch) single-card open completion: `{memo, mint}` with no pack ledger. */
function legacyOpenEvidence(open) {
  if (open?.status !== 'COMPLETE' || typeof open.evidence?.mint !== 'string' || open.evidence.mint.length === 0
    || typeof open.evidence?.memo !== 'string' || open.evidence.memo.length === 0) {
    return null;
  }
  return open.evidence;
}

async function holdWholeCycleForUnattributableCard(cycleRepository, context, evidence) {
  if (typeof cycleRepository?.holdCycle !== 'function') {
    throw new Error('buyback cannot record an unattributable held card without cycle hold authority');
  }
  await cycleRepository.holdCycle(context.cycleId, 'HELD_DATA_UNVERIFIED', evidence);
  return null;
}

/**
 * A buyback mutation attempt that never reached a per-pack outcome (the stage-level attempt
 * itself is sent-unknown, with no recorded response at all) resolves only from elapsed
 * wall-clock time, using whichever single legacy card the open stage completed with.
 */
async function holdLegacySentUnknownDeadline({ cycleRepository, config, context, record }) {
  const open = legacyOpenEvidence(await cycleRepository.readStage(context.cycleId, 'open'));
  if (open === null) {
    return holdWholeCycleForUnattributableCard(cycleRepository, context, {
      stage: 'buyback',
      attempt: record?.attempt ?? null,
      sentAtMs: record?.sentAtMs ?? null,
      reason: 'sent-unknown buyback lacks an attributable opened card at the reconcile deadline',
    });
  }
  return holdPack(cycleRepository, config, context, null, open.memo, open.mint, 'HELD_UNRESOLVED', {
    stage: 'buyback',
    memo: open.memo,
    mint: open.mint,
    attempt: record.attempt,
    sentAtMs: record.sentAtMs,
    deadlineMinutes: unresolvedCardDeadlineMinutes(config),
    reason: 'buyback provider mutation remained sent-unknown past the reconcile deadline',
  }, 'SENT_UNKNOWN_DEADLINE');
}

/** Resolves a pack whose own mutation call was ambiguous, using only its already-known memo. */
async function reconcileUnknownPack({ adapters, config, cycleRepository, context, unknown, assetKind }) {
  if (typeof adapters.collectorCrypt.getBuybackCheck !== 'function') return null;
  let check;
  try {
    check = await adapters.collectorCrypt.getBuybackCheck({ memo: unknown.memo });
  } catch {
    return null;
  }
  if (!plainObject(check) || typeof check.exists !== 'boolean' || !check.exists) return null;
  if (typeof check.status !== 'string' || check.status === '' || check.status !== 'complete') return null;
  const asset = configuredSettlementAsset(config);
  let checkedQuote;
  try {
    checkedQuote = typedAmount(asset, check.buybackAmount, 'completed buyback amount');
  } catch {
    return holdPack(cycleRepository, config, context, unknown.packIndex, unknown.memo, unknown.mint, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', ...unknown, check, reason: 'completed buyback amount is invalid',
    });
  }
  if (check.playerWallet !== config.accounts.solana || check.nft !== unknown.mint
    || typeof check.transactionSignature !== 'string' || check.transactionSignature.length === 0
    || typeof check.createdAt !== 'string' || check.createdAt.length === 0
    || (unknown.quote !== undefined && !sameAmount(checkedQuote, unknown.quote))) {
    return holdPack(cycleRepository, config, context, unknown.packIndex, unknown.memo, unknown.mint, 'HELD_DATA_UNVERIFIED', {
      stage: 'buyback', ...unknown, check, checkedQuote, reason: 'completed buyback check does not bind the memo, card, and quote',
    });
  }
  // The check just proved a signature exists for this memo; reuse the normal finality and
  // proceeds verification now that there is something concrete to verify.
  return reconcilePack({
    adapters, config, cycleRepository, context, assetKind,
    submitted: {
      packIndex: unknown.packIndex,
      memo: unknown.memo,
      mint: unknown.mint,
      signature: check.transactionSignature,
      quote: checkedQuote,
      refundAmount: checkedQuote,
      ...(unknown.proceedsAccount === undefined ? {} : { proceedsAccount: unknown.proceedsAccount }),
    },
  });
}

export async function reconcileLiveBuyback({ adapters, config, cycleRepository, context }) {
  const record = await cycleRepository.readOperationalStageAttempt(context.cycleId, 'buyback');
  const evidence = record?.responseEvidence;
  if (!plainObject(evidence) || !Array.isArray(evidence.packs)) {
    if (record?.attempt?.state === 'SENT_UNKNOWN' && Number.isSafeInteger(record.sentAtMs)
      && pastDeadline(record.sentAtMs, config, context)) {
      return holdLegacySentUnknownDeadline({ cycleRepository, config, context, record });
    }
    return null;
  }
  if (!adapters?.collectorCrypt || !adapters?.solana?.client) return null;

  const open = await cycleRepository.readStage(context.cycleId, 'open');
  const openEvidencePacks = plainObject(open.evidence) && Array.isArray(open.evidence.packs) ? open.evidence.packs : [];

  const outcomes = [];
  for (const submitted of evidence.packs) {
    const assetKind = assetKindOf(openEvidencePacks, submitted.packIndex);
    const outcome = submitted.decision === 'unknown'
      ? await reconcileUnknownPack({ adapters, config, cycleRepository, context, unknown: submitted, assetKind })
      : await reconcilePack({ adapters, config, cycleRepository, context, submitted, assetKind });
    if (outcome === null) return null;
    outcomes.push(outcome);
  }

  const soldPacks = outcomes.filter(outcome => outcome.decision === 'sold');
  if (soldPacks.length > 0) {
    await recordTotalProceedsLedger(cycleRepository, context.cycleId, configuredSettlementAsset(config), soldPacks);
  }
  return { packs: outcomes, soldCount: soldPacks.length };
}
