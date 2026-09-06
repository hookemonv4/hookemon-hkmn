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
import { requireCollectorOnlyMutationAuthority } from '../../../rehearsal/collector-only-authorization.mjs';
import { assertTypedAmount } from '../../../../runner/src/cycle/money-schemas.mjs';
import { RehearsalProceedsUnobservableError, RehearsalRecipientAccountMissingError, StageMutationRevertedError } from './errors.mjs';

const REHEARSAL_MODE = 'collector-only';

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isLiveCollectorOnlyRehearsal(config) {
  return config?.execution?.profile === 'rehearsal'
    && config.execution?.providerMode === 'live'
    && config.rehearsal?.mode === REHEARSAL_MODE;
}

function typedCircleAmount(config, amountAtomic, label) {
  if (typeof config?.solana?.chainId !== 'string' || config.solana.chainId.length === 0) {
    throw new Error(`${label} requires config.solana.chainId`);
  }
  return assertTypedAmount({
    chainId: config.solana.chainId,
    assetId: CIRCLE_USD_MINT,
    decimals: CIRCLE_USD_DECIMALS,
    amountAtomic: String(amountAtomic),
  }, label);
}

function dedicatedProceedsAccount(config) {
  if (!isLiveCollectorOnlyRehearsal(config)) return null;
  const operator = config.accounts?.solana;
  const proceedsAccount = config.rehearsal?.proceedsAccount;
  if (typeof operator !== 'string' || operator.length === 0 || typeof proceedsAccount !== 'string' || proceedsAccount.length === 0) {
    throw new Error('live collector-only rehearsal requires a dedicated proceeds account');
  }
  const conflictsWithRecipient = config.rehearsal.payoutRecipients?.some(recipient => {
    if (recipient === operator || recipient === proceedsAccount) return true;
    return deriveAssociatedTokenAddress(recipient, CIRCLE_USD_MINT).toBase58() === proceedsAccount;
  });
  if (proceedsAccount === operator || conflictsWithRecipient) {
    throw new Error('live collector-only rehearsal proceeds account must be distinct from the operator wallet and every recipient');
  }
  const canonical = deriveAssociatedTokenAddress(operator, CIRCLE_USD_MINT).toBase58();
  if (proceedsAccount !== canonical) {
    throw new Error('live collector-only rehearsal proceeds account must be the operator canonical Circle token account');
  }
  return proceedsAccount;
}

async function readDedicatedProceedsAccount({ adapters, config }) {
  const proceedsAccount = dedicatedProceedsAccount(config);
  if (proceedsAccount === null) return null;
  const account = await readAssociatedTokenAccount(adapters.solana.client, config.accounts.solana, CIRCLE_USD_MINT);
  if (!account.exists || account.decimals !== CIRCLE_USD_DECIMALS || account.address !== proceedsAccount) {
    throw new RehearsalProceedsUnobservableError('configured proceeds account is not a verified canonical Circle token account', {
      proceedsAccount,
    });
  }
  return account;
}

export function createRehearsalSkipHandler(stage) {
  const request = () => Object.freeze({ provider: REHEARSAL_MODE, operation: 'no-effect', stage });
  const reason = stage === 'outbound' || stage === 'return'
    ? 'Robinhood-chain leg is out of scope for the collector-only rehearsal'
    : 'stage is out of scope for the collector-only rehearsal';
  const evidence = () => ({
    skipped: true,
    rehearsalMode: REHEARSAL_MODE,
    stage,
    reason,
  });
  return Object.freeze({
    prepareRequest: request,
    probe: evidence,
    mutate({ request: supplied } = {}) {
      if (supplied !== undefined
        && (!plainObject(supplied) || supplied.provider !== REHEARSAL_MODE || supplied.operation !== 'no-effect' || supplied.stage !== stage)) {
        throw new Error('rehearsal skip handler received a non-canonical no-effect request');
      }
      return evidence();
    },
    reconcileLive: evidence,
  });
}

async function readRehearsalProceeds({ adapters, config, cycleRepository, context }) {
  const buyback = await cycleRepository.readStage(context.cycleId, 'buyback');
  if (buyback?.status !== 'COMPLETE' || typeof buyback.evidence?.signature !== 'string' || buyback.evidence.signature.length === 0) {
    throw new RehearsalProceedsUnobservableError('buyback stage is not complete with a signature', { cycleId: context.cycleId });
  }
  const dedicated = await readDedicatedProceedsAccount({ adapters, config });
  const entries = await getTransactionTokenBalanceChanges(adapters.solana.client, buyback.evidence.signature, { commitment: 'finalized' });
  const settlementEntries = entries.filter(entry => entry.owner === config.accounts.solana && entry.mint === CIRCLE_USD_MINT);
  if (dedicated === null) {
    if (settlementEntries.length === 0) {
      throw new RehearsalProceedsUnobservableError('buyback transaction has no operator Circle USD balance change', {
        cycleId: context.cycleId,
        buybackSignature: buyback.evidence.signature,
      });
    }
    const proceeds = settlementEntries.reduce((sum, entry) => sum + BigInt(entry.postAmount) - BigInt(entry.preAmount), 0n);
    if (proceeds <= 0n) {
      throw new RehearsalProceedsUnobservableError('buyback transaction has no positive operator Circle USD proceeds', {
        cycleId: context.cycleId,
        buybackSignature: buyback.evidence.signature,
      });
    }
    const [entry] = settlementEntries;
    return {
      buyback,
      proceeds,
      proceedsAccount: settlementEntries.length === 1 ? entry.tokenAccount : null,
      proceedsProjection: settlementEntries.length === 1 ? {
        account: entry.tokenAccount,
        beforeAtomic: entry.preAmount,
        afterAtomic: entry.postAmount,
        delta: typedCircleAmount(config, proceeds, 'rehearsal buyback proceeds'),
      } : null,
    };
  }
  const proceedsEntries = settlementEntries.filter(entry => entry.tokenAccount === dedicated.address);
  if (proceedsEntries.length !== 1) {
    throw new RehearsalProceedsUnobservableError('buyback transaction does not expose exactly one configured proceeds account balance delta', {
      cycleId: context.cycleId,
      buybackSignature: buyback.evidence.signature,
      proceedsAccount: dedicated?.address ?? null,
    });
  }
  const [entry] = proceedsEntries;
  const before = BigInt(entry.preAmount);
  const after = BigInt(entry.postAmount);
  const proceeds = after - before;
  if (proceeds <= 0n) {
    throw new RehearsalProceedsUnobservableError('buyback transaction has no positive configured proceeds account balance delta', {
      cycleId: context.cycleId,
      buybackSignature: buyback.evidence.signature,
      proceedsAccount: dedicated?.address ?? entry.tokenAccount,
    });
  }
  return {
    buyback,
    proceeds,
    proceedsAccount: dedicated?.address ?? entry.tokenAccount,
    proceedsProjection: {
      account: dedicated?.address ?? entry.tokenAccount,
      beforeAtomic: before.toString(),
      afterAtomic: after.toString(),
      delta: typedCircleAmount(config, proceeds, 'rehearsal buyback proceeds'),
    },
  };
}

function buildPlan(config, proceeds, recipients) {
  if (!Array.isArray(recipients) || recipients.length === 0 || new Set(recipients).size !== recipients.length) {
    throw new Error('rehearsal payout requires distinct recipients');
  }
  const perRecipient = proceeds / BigInt(recipients.length);
  const remainder = proceeds % BigInt(recipients.length);
  return recipients.map((recipient, index) => ({
    recipient,
    amountMicroSolanaStable: (perRecipient + (index === 0 ? remainder : 0n)).toString(),
    amount: typedCircleAmount(config, perRecipient + (index === 0 ? remainder : 0n), 'rehearsal payout recipient amount'),
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
  const { proceeds, proceedsAccount, proceedsProjection } = await readRehearsalProceeds({ adapters, config, cycleRepository, context });
  const plan = buildPlan(config, proceeds, config.rehearsal.payoutRecipients);
  const missingRecipientAccounts = await findMissingRecipientAccounts({
    adapters,
    recipients: config.rehearsal.payoutRecipients,
  });
  return {
    wouldPayout: true,
    configured: true,
    proceedsMicroSolanaStable: proceeds.toString(),
    proceeds: proceedsProjection?.delta ?? typedCircleAmount(config, proceeds, 'rehearsal buyback proceeds'),
    proceedsAccount,
    proceedsProjection,
    plan,
    missingRecipientAccounts,
  };
}

function recipientPlanEvidence(plan) {
  return plan.map(({ recipient, amountMicroSolanaStable, amount }) => ({
    recipient,
    tokenAccount: deriveAssociatedTokenAddress(recipient, CIRCLE_USD_MINT).toBase58(),
    amountMicroSolanaStable,
    amount,
  }));
}

function sameTypedAmount(left, right) {
  return plainObject(left) && plainObject(right)
    && left.chainId === right.chainId
    && left.assetId === right.assetId
    && left.decimals === right.decimals
    && left.amountAtomic === right.amountAtomic;
}

function payoutRequest({ buyback, proceedsAccount, proceedsProjection, plan }) {
  if (!plainObject(proceedsProjection) || typeof proceedsAccount !== 'string' || proceedsAccount.length === 0) {
    throw new RehearsalProceedsUnobservableError('payout requires one finalized dedicated proceeds account projection');
  }
  return Object.freeze({
    provider: 'solana',
    operation: 'collector-only-payout',
    buybackSignature: buyback.evidence.signature,
    proceedsAccount,
    proceeds: proceedsProjection.delta,
    proceedsProjection,
    allocated: proceedsProjection.delta,
    recipients: recipientPlanEvidence(plan),
  });
}

function assertPreparedPayoutRequest(request, expected) {
  if (!plainObject(request) || request.provider !== expected.provider || request.operation !== expected.operation
    || request.buybackSignature !== expected.buybackSignature || request.proceedsAccount !== expected.proceedsAccount
    || !sameTypedAmount(request.proceeds, expected.proceeds) || !sameTypedAmount(request.allocated, expected.allocated) || !Array.isArray(request.recipients)
    || request.recipients.length !== expected.recipients.length) {
    throw new RehearsalProceedsUnobservableError('prepared payout request does not bind the finalized dedicated proceeds projection');
  }
  for (let index = 0; index < expected.recipients.length; index += 1) {
    const received = request.recipients[index];
    const planned = expected.recipients[index];
    if (!plainObject(received) || received.recipient !== planned.recipient || received.tokenAccount !== planned.tokenAccount
      || received.amountMicroSolanaStable !== planned.amountMicroSolanaStable || !sameTypedAmount(received.amount, planned.amount)) {
      throw new RehearsalProceedsUnobservableError('prepared payout recipients do not bind the finalized dedicated proceeds projection');
    }
  }
}

export async function prepareRehearsalPayoutRequest({ adapters, config, cycleRepository, context }) {
  if (!adapters?.solana?.client) throw new Error('rehearsal payout preparation requires a Solana RPC client');
  const { buyback, proceeds, proceedsAccount, proceedsProjection } = await readRehearsalProceeds({ adapters, config, cycleRepository, context });
  const recipients = config.rehearsal?.payoutRecipients ?? [];
  const missing = await findMissingRecipientAccounts({ adapters, recipients });
  if (missing.length > 0) throw new RehearsalRecipientAccountMissingError(missing);
  return payoutRequest({
    buyback,
    proceedsAccount,
    proceedsProjection,
    plan: buildPlan(config, proceeds, recipients),
  });
}

export async function mutateRehearsalPayout({ liveMode, adapters, config, signerClient, cycleRepository, context, request }) {
  if (liveMode !== true) throw new Error('stage-driver internal error: mutateRehearsalPayout reached without liveMode');
  const existingAttempt = typeof cycleRepository.readStageAttempt === 'function'
    ? await cycleRepository.readStageAttempt(context.cycleId, 'payout')
    : null;
  if (existingAttempt) return existingAttempt;
  if (!adapters.solana?.client || !config.accounts?.solana || !signerClient?.solana) {
    throw new Error('rehearsal payout mutate requires a Solana RPC client, HOOKEMON_SOLANA_ACCOUNT, and signerClient.solana');
  }
  const { buyback, proceeds, proceedsAccount, proceedsProjection } = await readRehearsalProceeds({ adapters, config, cycleRepository, context });
  const recipients = config.rehearsal?.payoutRecipients ?? [];
  const missing = await findMissingRecipientAccounts({ adapters, recipients });
  if (missing.length > 0) throw new RehearsalRecipientAccountMissingError(missing);
  const plan = buildPlan(config, proceeds, recipients);
  const expectedRequest = payoutRequest({ buyback, proceedsAccount, proceedsProjection, plan });
  if (request !== undefined) assertPreparedPayoutRequest(request, expectedRequest);
  const source = await readDedicatedProceedsAccount({ adapters, config });
  let sourceTokenAccount = source?.address;
  if (sourceTokenAccount === undefined) {
    const account = await readAssociatedTokenAccount(adapters.solana.client, config.accounts.solana, CIRCLE_USD_MINT);
    if (!account.exists || account.decimals !== CIRCLE_USD_DECIMALS) throw new Error('rehearsal payout requires a matching operator token account');
    sourceTokenAccount = account.address;
  }
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
        requireCollectorOnlyMutationAuthority(config);
        return signerClient.solana.sign(request);
      },
    },
    policy: rehearsalPayoutPolicy(config),
    decodeOptions: trustedRehearsalDecodeOptions({ client: adapters.solana.client, config, latest }),
    broadcast: async signed => {
      if (!(await readBlockhashValidity(adapters.solana.client, latest.blockhash))) {
        throw new Error('rehearsal payout blockhash expired before submission');
      }
      requireCollectorOnlyMutationAuthority(config);
      return { signature: await submitSignedTransaction(adapters.solana.client, signed.signedTxBase64) };
    },
  });
  const signed = await signer.sign(unsignedBase64);
  const { signature } = await signer.broadcast(signed);
  return {
    signature,
    mint: CIRCLE_USD_MINT,
    proceedsMicroSolanaStable: proceeds.toString(),
    proceeds: proceedsProjection.delta,
    allocated: proceedsProjection.delta,
    proceedsAccount,
    proceedsProjection,
    recipients: recipientPlanEvidence(plan),
    sourceTokenAccount,
    buybackSignature: buyback.evidence.signature,
  };
}

async function readPayoutAttempt(cycleRepository, cycleId) {
  const record = typeof cycleRepository.readOperationalStageAttempt === 'function'
    ? await cycleRepository.readOperationalStageAttempt(cycleId, 'payout')
    : await cycleRepository.readStageAttempt?.(cycleId, 'payout');
  if (!record) return null;
  return record.responseEvidence ?? record;
}

function hasExactTokenDelta(entries, { tokenAccount, owner, amountAtomic }) {
  const matching = entries.filter(entry => entry.tokenAccount === tokenAccount && entry.owner === owner && entry.mint === CIRCLE_USD_MINT);
  return matching.length === 1 && BigInt(matching[0].postAmount) - BigInt(matching[0].preAmount) === BigInt(amountAtomic);
}

function sameProceedsProjection(left, right) {
  return plainObject(left) && plainObject(right)
    && left.account === right.account
    && left.beforeAtomic === right.beforeAtomic
    && left.afterAtomic === right.afterAtomic
    && sameTypedAmount(left.delta, right.delta);
}

function assertFinalizedPayoutDeltas({ entries, attempt, expected, config }) {
  if (attempt.sourceTokenAccount !== expected.proceedsAccount || attempt.proceedsAccount !== expected.proceedsAccount
    || attempt.buybackSignature !== expected.buybackSignature || !sameTypedAmount(attempt.proceeds, expected.proceeds)
    || !sameTypedAmount(attempt.allocated, expected.allocated)
    || !sameProceedsProjection(attempt.proceedsProjection, {
      account: expected.proceedsAccount,
      beforeAtomic: expected.proceedsProjection.beforeAtomic,
      afterAtomic: expected.proceedsProjection.afterAtomic,
      delta: expected.proceeds,
    })
    || !Array.isArray(attempt.recipients) || attempt.recipients.length !== expected.recipients.length
    || !hasExactTokenDelta(entries, {
      tokenAccount: expected.proceedsAccount,
      owner: config.accounts.solana,
      amountAtomic: `-${expected.proceeds.amountAtomic}`,
    })) {
    throw new RehearsalProceedsUnobservableError('finalized payout deltas do not match the dedicated proceeds plan', {
      signature: attempt.signature,
      proceedsAccount: expected.proceedsAccount,
    });
  }
  for (let index = 0; index < expected.recipients.length; index += 1) {
    const attempted = attempt.recipients[index];
    const planned = expected.recipients[index];
    if (!plainObject(attempted) || attempted.recipient !== planned.recipient || attempted.tokenAccount !== planned.tokenAccount
      || attempted.amountMicroSolanaStable !== planned.amountMicroSolanaStable || !sameTypedAmount(attempted.amount, planned.amount)
      || !hasExactTokenDelta(entries, {
        tokenAccount: planned.tokenAccount,
        owner: planned.recipient,
        amountAtomic: planned.amount.amountAtomic,
      })) {
      throw new RehearsalProceedsUnobservableError('finalized payout deltas do not match the dedicated proceeds plan', {
        signature: attempt.signature,
        proceedsAccount: expected.proceedsAccount,
        recipient: planned.recipient,
      });
    }
  }
}

export async function reconcileLiveRehearsalPayout({ adapters, config, cycleRepository, context }) {
  const attempt = await readPayoutAttempt(cycleRepository, context.cycleId);
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
    await cycleRepository.recordStageAttemptFailure?.(context.cycleId, 'payout', { signature: attempt.signature, err: status.err });
    throw new StageMutationRevertedError('payout', `rehearsal payout signature ${attempt.signature} failed on-chain`, {
      signature: attempt.signature,
      err: status.err,
    });
  }
  if (status.confirmationStatus !== 'finalized') return null;
  const { buyback, proceeds, proceedsAccount, proceedsProjection } = await readRehearsalProceeds({ adapters, config, cycleRepository, context });
  const plan = buildPlan(config, proceeds, config.rehearsal?.payoutRecipients ?? []);
  const expected = payoutRequest({ buyback, proceedsAccount, proceedsProjection, plan });
  const entries = await getTransactionTokenBalanceChanges(adapters.solana.client, attempt.signature, { commitment: 'finalized' });
  assertFinalizedPayoutDeltas({ entries, attempt, expected, config });
  return { ...attempt, confirmationStatus: 'finalized' };
}
