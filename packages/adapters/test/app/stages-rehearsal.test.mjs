import assert from 'node:assert/strict';
import test from 'node:test';

import { Keypair, SystemProgram } from '@solana/web3.js';

import {
  CIRCLE_USD_DECIMALS,
  CIRCLE_USD_MINT,
  TOKEN_PROGRAM_ID,
  buildPriorityFeeInstructions,
  buildTransferCheckedInstruction,
  buildUnsignedTransaction,
  createSolanaRpcClient,
  deriveAssociatedTokenAddress,
} from '../../src/solana-rpc.mjs';
import { TRANSACTION_POLICY_SCHEMA, decodeProviderTransaction } from '../../src/signing/transaction-policy.mjs';
import { policyFor } from '../signing/policy-fixture.mjs';
import {
  mutateRehearsalPayout,
  probeRehearsalPayout,
  reconcileLiveRehearsalPayout,
} from '../../src/app/stages/rehearsal.mjs';

const OPERATOR_KEYPAIR = Keypair.fromSeed(Uint8Array.from(Array(32).fill(7)));
const OPERATOR = OPERATOR_KEYPAIR.publicKey.toBase58();
const RECIPIENTS = ['GfFAJnHnSgP7C2FQZLz6ogpdTV6Y7259f83qFFm9wxKm', 'H9ZXYkudxn6qhyp5S25jm5SrA8Vnu8naSfvymm9TptLA'];
const SIGNATURE = 'buyback-signature';
const PAYOUT_SIGNATURE = 'payout-signature';

function rpcResponse(result) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result }) };
}

function makeRpcClient({ missingRecipients = [], blockhashValidities = [true] } = {}) {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body.method);
    if (body.method === 'getTransaction') {
      return rpcResponse({
        transaction: { message: { accountKeys: [OPERATOR] } },
        meta: {
          preTokenBalances: [{ accountIndex: 0, mint: CIRCLE_USD_MINT, owner: OPERATOR, uiTokenAmount: { amount: '1000000' } }],
          postTokenBalances: [{ accountIndex: 0, mint: CIRCLE_USD_MINT, owner: OPERATOR, uiTokenAmount: { amount: '1123457' } }],
        },
      });
    }
    if (body.method === 'getAccountInfo') {
      const tokenAccount = body.params[0];
      const missing = missingRecipients.some(recipient => deriveAssociatedTokenAddress(recipient, CIRCLE_USD_MINT).toBase58() === tokenAccount);
      if (missing) return rpcResponse({ value: null });
      const owner = RECIPIENTS.find(recipient => deriveAssociatedTokenAddress(recipient, CIRCLE_USD_MINT).toBase58() === tokenAccount) ?? OPERATOR;
      return rpcResponse({
        value: {
          owner: TOKEN_PROGRAM_ID,
          data: {
            program: 'spl-token',
            parsed: { type: 'account', info: { owner, mint: CIRCLE_USD_MINT, tokenAmount: { amount: '1', decimals: 6 } } },
          },
        },
      });
    }
    if (body.method === 'getLatestBlockhash') return rpcResponse({ value: { blockhash: SystemProgram.programId.toBase58(), lastValidBlockHeight: 1 } });
    if (body.method === 'isBlockhashValid') return rpcResponse({ value: blockhashValidities.shift() ?? true });
    if (body.method === 'getBlockHeight') return rpcResponse(0);
    if (body.method === 'sendTransaction') return rpcResponse(PAYOUT_SIGNATURE);
    if (body.method === 'getSignatureStatuses') return rpcResponse({ value: [{ err: null, confirmationStatus: 'finalized' }] });
    throw new Error(`unexpected RPC method ${body.method}`);
  };
  return { client: createSolanaRpcClient({ fetchImpl }), calls };
}

function repository() {
  const attempts = new Map();
  return {
    attempts,
    async readStage(_cycleId, stage) {
      return stage === 'buyback' ? { status: 'COMPLETE', evidence: { signature: SIGNATURE } } : { status: 'PENDING' };
    },
    async readStageAttempt(_cycleId, stage) { return attempts.get(stage) ?? null; },
    async recordStageAttempt(_cycleId, stage, evidence) { attempts.set(stage, evidence); },
    async recordStageAttemptFailure() {},
  };
}

function config(overrides = {}) {
  return {
    accounts: { solana: OPERATOR },
    solana: { chainId: 'solana-rehearsal' },
    rehearsal: { mode: 'collector-only', payoutRecipients: RECIPIENTS, split: 'equal' },
    ...overrides,
  };
}

async function payoutPolicy(configuration) {
  const source = deriveAssociatedTokenAddress(OPERATOR, CIRCLE_USD_MINT).toBase58();
  const plan = ['61729', '61728'];
  const instructions = [
    ...(configuration.rehearsal.priorityFee === undefined
      ? []
      : buildPriorityFeeInstructions(configuration.rehearsal.priorityFee)),
    ...RECIPIENTS.map((recipient, index) => buildTransferCheckedInstruction({
      source,
      destination: deriveAssociatedTokenAddress(recipient, CIRCLE_USD_MINT),
      owner: OPERATOR,
      mint: CIRCLE_USD_MINT,
      amount: BigInt(plan[index]),
      decimals: CIRCLE_USD_DECIMALS,
    })),
  ];
  const transaction = buildUnsignedTransaction({
    feePayer: OPERATOR,
    recentBlockhash: SystemProgram.programId.toBase58(),
    instructions,
  });
  const decoded = await decodeProviderTransaction({
    family: 'solana',
    chainId: configuration.solana.chainId,
    transaction,
    blockhashContextResolver: async blockhash => ({ blockhash, lastValidBlockHeight: '1' }),
    currentBlockHeightResolver: async () => '0',
  });
  return policyFor(decoded, TRANSACTION_POLICY_SCHEMA);
}

async function configWithPayoutPolicy(overrides = {}) {
  const value = config(overrides);
  value.rehearsal.payoutPolicy = await payoutPolicy(value);
  return value;
}

test('rehearsal payout observes and plans proceeds but refuses the provisional authority before signing', async () => {
  const rpc = makeRpcClient();
  const cycleRepository = repository();
  const context = { cycleId: 'cycle-rehearsal-1', stage: 'payout' };
  const input = { adapters: { solana: { client: rpc.client } }, config: await configWithPayoutPolicy(), cycleRepository, context };
  const probe = await probeRehearsalPayout(input);
  assert.deepEqual(probe.plan, [
    { recipient: RECIPIENTS[0], amountMicroSolanaStable: '61729' },
    { recipient: RECIPIENTS[1], amountMicroSolanaStable: '61728' },
  ]);
  assert.equal(probe.proceedsMicroSolanaStable, '123457');
  let signed = 0;
  await assert.rejects(
    () => mutateRehearsalPayout({
      ...input,
      liveMode: true,
      signerClient: { solana: { async sign() { signed += 1; return { signedTxBase64: 'signed-transaction' }; } } },
    }),
    /active frozen interface authority is invalid/,
  );
  assert.equal(signed, 0);
  assert.deepEqual(rpc.calls.filter(method => method === 'sendTransaction'), []);
  await cycleRepository.recordStageAttempt(context.cycleId, 'payout', { signature: PAYOUT_SIGNATURE });
  assert.equal((await reconcileLiveRehearsalPayout(input)).confirmationStatus, 'finalized');
});

test('rehearsal payout probe reports missing recipient token accounts without throwing', async () => {
  const rpc = makeRpcClient({ missingRecipients: [RECIPIENTS[1]] });
  const result = await probeRehearsalPayout({
    adapters: { solana: { client: rpc.client } },
    config: config(),
    cycleRepository: repository(),
    context: { cycleId: 'cycle-rehearsal-2', stage: 'payout' },
  });
  assert.deepEqual(result.missingRecipientAccounts, [RECIPIENTS[1]]);
});

test('rehearsal payout requires a pinned transaction policy before reaching its signer', async () => {
  const rpc = makeRpcClient();
  let signCalls = 0;
  await assert.rejects(
    mutateRehearsalPayout({
      liveMode: true,
      adapters: { solana: { client: rpc.client } },
      config: config(),
      cycleRepository: repository(),
      context: { cycleId: 'cycle-rehearsal-policy', stage: 'payout' },
      signerClient: { solana: { async sign() { signCalls += 1; return { signedTxBase64: 'signed-transaction' }; } } },
    }),
    /requires a pinned transaction policy/,
  );
  assert.equal(signCalls, 0);
});

test('rehearsal payout retries a stale blockhash before refusing the provisional authority', async () => {
  const rpc = makeRpcClient({ blockhashValidities: [false, true] });
  const configuration = await configWithPayoutPolicy({ rehearsal: {
    mode: 'collector-only',
    payoutRecipients: RECIPIENTS,
    split: 'equal',
    priorityFee: { computeUnitLimit: 200_000, microLamports: '1234' },
  } });
  let signed = 0;
  await assert.rejects(
    () => mutateRehearsalPayout({
      liveMode: true,
      adapters: { solana: { client: rpc.client } },
      config: configuration,
      cycleRepository: repository(),
      context: { cycleId: 'cycle-rehearsal-priority', stage: 'payout' },
      signerClient: { solana: { async sign() { signed += 1; return { signedTxBase64: 'signed-transaction' }; } } },
    }),
    /active frozen interface authority is invalid/,
  );

  assert.equal(rpc.calls.filter(method => method === 'getLatestBlockhash').length, 2);
  assert.equal(signed, 0);
  assert.deepEqual(rpc.calls.filter(method => method === 'sendTransaction'), []);
});
