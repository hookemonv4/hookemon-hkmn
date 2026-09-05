// Collector-only rehearsal stages. The four Robinhood-chain legs are represented by durable,
// auditable skip evidence, while payout sends the buyback's independently observed Circle USD
// proceeds directly to pre-funded Solana recipient wallets.
import {
  CIRCLE_USD_DECIMALS,
  CIRCLE_USD_MINT,
  buildPriorityFeeInstructions,
  buildTransferCheckedInstruction,
  buildUnsignedTransaction,
  deriveAssociatedTokenAddress,
  getTransactionTokenBalanceChanges,
  readAssociatedTokenAccount,
  readBlockhashValidity,
  readBlockHeight,
  readSignatureStatus,
  readUsableLatestBlockhash,
  submitSignedTransaction,
} from '../../solana-rpc.mjs';
import { OPERATOR_SOLANA_ROLE, wrapTransactionPolicySignerClient } from '../../signing/signer-client.mjs';
import { requireLiveMutationAuthority } from '../../../../runner/src/cycle/preflight.mjs';
import { RehearsalProceedsUnobservableError, RehearsalRecipientAccountMissingError, StageMutationRevertedError } from './errors.mjs';

const REHEARSAL_MODE = 'collector-only';

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function createRehearsalSkipHandler(stage) {
  const evidence = () => ({
    skipped: true,
    rehearsalMode: REHEARSAL_MODE,
    stage,
    reason: 'Robinhood-chain leg is out of scope for the collector-only rehearsal',
  });
  return Object.freeze({
    probe: evidence,
    mutate() {
      throw new Error('rehearsal skip handler mutate must never be reached');
    },
    reconcileLive: evidence,
  });
}

async function readRehearsalProceeds({ adapters, config, cycleRepository, context }) {
  const buyback = await cycleRepository.readStage(context.cycleId, 'buyback');
  if (buyback?.status !== 'COMPLETE' || typeof buyback.evidence?.signature !== 'string' || buyback.evidence.signature.length === 0) {
    throw new RehearsalProceedsUnobservableError('buyback stage is not complete with a signature', { cycleId: context.cycleId });
  }
  const entries = await getTransactionTokenBalanceChanges(adapters.solana.client, buyback.evidence.signature, { commitment: 'finalized' });
  const proceedsEntries = entries.filter(
    entry => entry.owner === config.accounts.solana && entry.mint === CIRCLE_USD_MINT,
  );
  if (proceedsEntries.length === 0) {
    throw new RehearsalProceedsUnobservableError('buyback transaction has no operator Circle USD balance change', {
      cycleId: context.cycleId,
      buybackSignature: buyback.evidence.signature,
    });
  }
  const proceeds = proceedsEntries.reduce((sum, entry) => sum + BigInt(entry.postAmount) - BigInt(entry.preAmount), 0n);
  if (proceeds <= 0n) {
    throw new RehearsalProceedsUnobservableError('buyback transaction has no positive operator Circle USD proceeds', {
      cycleId: context.cycleId,
      buybackSignature: buyback.evidence.signature,
    });
  }
  return { buyback, proceeds };
}

function buildPlan(proceeds, recipients) {
  const perRecipient = proceeds / BigInt(recipients.length);
  const remainder = proceeds % BigInt(recipients.length);
  return recipients.map((recipient, index) => ({
    recipient,
    amountMicroSolanaStable: (perRecipient + (index === 0 ? remainder : 0n)).toString(),
  }));
}

async function findMissingRecipientAccounts({ adapters, recipients }) {
  const missing = [];
  for (const recipient of recipients) {
    try {
      const account = await readAssociatedTokenAccount(adapters.solana.client, recipient, CIRCLE_USD_MINT);
      if (!account.exists || account.decimals !== CIRCLE_USD_DECIMALS) missing.push(recipient);
    } catch {
      missing.push(recipient);
    }
  }
  return missing;
}

async function freshBlockhashBeforeSigning(client) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await readUsableLatestBlockhash(client);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function priorityFeeInstructions(config) {
  const priorityFee = config.rehearsal?.priorityFee ?? config.solana?.priorityFee ?? null;
  return priorityFee === null ? [] : buildPriorityFeeInstructions(priorityFee);
}

function rehearsalPayoutPolicy(config) {
  const policy = config?.rehearsal?.payoutPolicy;
  if (!plainObject(policy)) throw new Error('rehearsal payout requires a pinned transaction policy');
  return policy;
}

function trustedRehearsalDecodeOptions({ client, config, latest }) {
  if (typeof config?.solana?.chainId !== 'string' || config.solana.chainId.length === 0) {
    throw new Error('rehearsal payout requires config.solana.chainId for transaction-policy decoding');
  }
  return Object.freeze({
    family: 'solana',
    chainId: config.solana.chainId,
    blockhashContextResolver: async blockhash => {
      if (blockhash !== latest.blockhash) throw new Error('rehearsal payout blockhash context did not match the prepared transaction');
      return latest;
    },
    currentBlockHeightResolver: async () => readBlockHeight(client),
  });
}

export async function probeRehearsalPayout({ adapters, config, cycleRepository, context }) {
  const buyback = await cycleRepository.readStage(context.cycleId, 'buyback');
  // A dry-run completes the buyback stage with `configured: false` evidence and no signature, so
  // the signature check (not just the stage status) decides whether proceeds are observable.
  const buybackSignature = buyback?.status === 'COMPLETE' ? buyback.evidence?.signature : undefined;
  if (typeof buybackSignature !== 'string' || buybackSignature.length === 0 || !adapters.solana?.client) {
    return { wouldPayout: true, configured: false, reason: 'buyback is not complete with a signature, or solana RPC client is not configured' };
  }
  const { buyback: completedBuyback, proceeds } = await readRehearsalProceeds({ adapters, config, cycleRepository, context });
  const plan = buildPlan(proceeds, config.rehearsal.payoutRecipients);
  const missingRecipientAccounts = await findMissingRecipientAccounts({
    adapters,
    recipients: config.rehearsal.payoutRecipients,
  });
  return {
    wouldPayout: true,
    configured: true,
    proceedsMicroSolanaStable: proceeds.toString(),
    plan,
    missingRecipientAccounts,
  };
}

export async function mutateRehearsalPayout({ liveMode, adapters, config, signerClient, cycleRepository, context }) {
  if (liveMode !== true) throw new Error('stage-driver internal error: mutateRehearsalPayout reached without liveMode');
  const existingAttempt = await cycleRepository.readStageAttempt(context.cycleId, 'payout');
  if (existingAttempt) return existingAttempt;
  if (!adapters.solana?.client || !config.accounts?.solana || !signerClient?.solana) {
    throw new Error('rehearsal payout mutate requires a Solana RPC client, HOOKEMON_SOLANA_ACCOUNT, and signerClient.solana');
  }
  const { buyback, proceeds } = await readRehearsalProceeds({ adapters, config, cycleRepository, context });
  const recipients = config.rehearsal?.payoutRecipients ?? [];
  const missing = await findMissingRecipientAccounts({ adapters, recipients });
  if (missing.length > 0) throw new RehearsalRecipientAccountMissingError(missing);
  const plan = buildPlan(proceeds, recipients);
  const source = await readAssociatedTokenAccount(adapters.solana.client, config.accounts.solana, CIRCLE_USD_MINT);
  if (!source.exists || source.decimals !== CIRCLE_USD_DECIMALS) {
    throw new Error('rehearsal payout requires a matching operator token account');
  }
  const sourceTokenAccount = source.address;
  const instructions = [
    ...priorityFeeInstructions(config),
    ...plan.map(({ recipient, amountMicroSolanaStable }) => buildTransferCheckedInstruction({
    source: sourceTokenAccount,
    destination: deriveAssociatedTokenAddress(recipient, CIRCLE_USD_MINT),
    owner: config.accounts.solana,
    mint: CIRCLE_USD_MINT,
    amount: BigInt(amountMicroSolanaStable),
    decimals: CIRCLE_USD_DECIMALS,
    })),
  ];
  const latest = await freshBlockhashBeforeSigning(adapters.solana.client);
  const unsignedBase64 = buildUnsignedTransaction({
    feePayer: config.accounts.solana,
    recentBlockhash: latest.blockhash,
    instructions,
  });
  const signer = wrapTransactionPolicySignerClient({
    client: {
      role: signerClient.solana.role ?? OPERATOR_SOLANA_ROLE,
      async sign(request) {
        requireLiveMutationAuthority();
        return signerClient.solana.sign(request);
      },
    },
    policy: rehearsalPayoutPolicy(config),
    decodeOptions: trustedRehearsalDecodeOptions({ client: adapters.solana.client, config, latest }),
    broadcast: async signed => {
      if (!(await readBlockhashValidity(adapters.solana.client, latest.blockhash))) {
        throw new Error('rehearsal payout blockhash expired before submission');
      }
      requireLiveMutationAuthority();
      return { signature: await submitSignedTransaction(adapters.solana.client, signed.signedTxBase64) };
    },
  });
  const signed = await signer.sign(unsignedBase64);
  const { signature } = await signer.broadcast(signed);
  return {
    signature,
    mint: CIRCLE_USD_MINT,
    proceedsMicroSolanaStable: proceeds.toString(),
    recipients: plan.map(({ recipient, amountMicroSolanaStable }) => ({
      recipient,
      tokenAccount: deriveAssociatedTokenAddress(recipient, CIRCLE_USD_MINT).toBase58(),
      amountMicroSolanaStable,
    })),
    sourceTokenAccount,
    buybackSignature: buyback.evidence.signature,
  };
}

export async function reconcileLiveRehearsalPayout({ adapters, cycleRepository, context }) {
  const attempt = await cycleRepository.readStageAttempt(context.cycleId, 'payout');
  if (!attempt) return null;
  if (!adapters.solana?.client || !attempt.signature) return null;
  let status;
  try {
    status = await readSignatureStatus(adapters.solana.client, attempt.signature);
  } catch {
    return null;
  }
  if (!status) return null;
  if (status.err) {
    await cycleRepository.recordStageAttemptFailure(context.cycleId, 'payout', { signature: attempt.signature, err: status.err });
    throw new StageMutationRevertedError('payout', `rehearsal payout signature ${attempt.signature} failed on-chain`, {
      signature: attempt.signature,
      err: status.err,
    });
  }
  if (status.confirmationStatus !== 'finalized') return null;
  return { ...attempt, confirmationStatus: 'finalized' };
}
