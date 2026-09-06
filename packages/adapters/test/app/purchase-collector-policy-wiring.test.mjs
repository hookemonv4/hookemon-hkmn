// Focused coverage for the fixture-only Collector purchase policy wiring seam in
// mutatePurchase (packages/adapters/src/app/stages/purchase.mjs): a Node-test-only binding, plain
// data under config.collectorCrypt.purchase.testFixtureBinding, lets mutatePurchase construct one
// real createCollectorPurchasePolicy per pack from durable, trusted inputs -- never from the
// candidate transaction -- and pass that exact policy through canonical decode/evaluate and the
// signer wrapper. See collector-policy-wiring-scope.md (coordination directory) for the reviewed
// scope this closes.
//
// Every case here uses only generated ephemeral test keys, an in-memory repository, an injected
// fixture Solana RPC client (loopback, no network), a fake external signer, and a fake Collector
// provider client. No real chain RPC, credential, or broadcast is ever reached.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';

import { digest } from '../../../runner/src/cycle/journal.mjs';
import {
  CIRCLE_USD_DECIMALS,
  CIRCLE_USD_MINT,
  TOKEN_PROGRAM_ID,
  createSolanaRpcClient,
  deriveAssociatedTokenAddress,
  signedSolanaTransactionSignature,
} from '../../src/solana-rpc.mjs';
import { COLLECTOR_PURCHASE_BINDING_SCHEMA, COLLECTOR_PURCHASE_BINDING_VERSION } from '../../src/signing/collector-purchase-policy.mjs';
import { TransactionPolicyError } from '../../src/signing/transaction-policy.mjs';
import { mutatePurchase } from '../../src/app/stages/purchase.mjs';

const CHAIN_ID = 'solana-mainnet';
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const MEMO_PREFIX = 'collector-purchase:v1:';
const PACK_TYPE = 'pokemon_25';
const PACK_PRICE_ATOMIC = '25000000';
const FIXED_BLOCKHASH = Keypair.generate().publicKey.toBase58();
const CURRENT_BLOCK_HEIGHT = 50_000;
const LAST_VALID_BLOCK_HEIGHT = 100_000;

const operator = Keypair.generate();
const coSigner = Keypair.generate();
const destination = Keypair.generate();
const OPERATOR_ADDRESS = operator.publicKey.toBase58();
const SOURCE_ATA = deriveAssociatedTokenAddress(OPERATOR_ADDRESS, CIRCLE_USD_MINT).toBase58();
const PROCEEDS_ACCOUNT = SOURCE_ATA;
const RECIPIENT = Keypair.generate().publicKey.toBase58();
const REQUEST_DIGEST = digest({ schema: 'test.collector-purchase-request.v1', cycleId: 'cycle-n2' });

function settlementAsset() {
  return { chainId: CHAIN_ID, assetId: CIRCLE_USD_MINT, decimals: CIRCLE_USD_DECIMALS };
}

function rawBinding(overrides = {}) {
  return {
    schema: COLLECTOR_PURCHASE_BINDING_SCHEMA,
    version: COLLECTOR_PURCHASE_BINDING_VERSION,
    provider: 'collector-crypt',
    chainId: CHAIN_ID,
    format: 'legacy',
    addressLookupTables: [],
    settlement: { destination: destination.publicKey.toBase58(), mint: CIRCLE_USD_MINT, decimals: CIRCLE_USD_DECIMALS },
    providerCoSigner: coSigner.publicKey.toBase58(),
    instructions: [
      {
        kind: 'compute-budget-set-unit-limit',
        programId: ComputeBudgetProgram.programId.toBase58(),
        accounts: [],
        computeUnitLimit: 40000,
        priorityFeeCapAtomic: null,
        memoPrefix: null,
      },
      {
        kind: 'compute-budget-set-unit-price',
        programId: ComputeBudgetProgram.programId.toBase58(),
        accounts: [],
        computeUnitLimit: null,
        priorityFeeCapAtomic: '5000',
        memoPrefix: null,
      },
      {
        kind: 'spl-transfer-checked',
        programId: TOKEN_PROGRAM_ID,
        accounts: [
          { role: 'source-ata', isSigner: false, isWritable: true },
          { role: 'settlement-mint', isSigner: false, isWritable: false },
          { role: 'settlement-destination', isSigner: false, isWritable: true },
          { role: 'operator-fee-payer', isSigner: true, isWritable: true },
        ],
        computeUnitLimit: null,
        priorityFeeCapAtomic: null,
        memoPrefix: null,
      },
      {
        kind: 'unknown',
        programId: MEMO_PROGRAM_ID,
        accounts: [
          { role: 'provider-co-signer', isSigner: true, isWritable: false },
        ],
        computeUnitLimit: null,
        priorityFeeCapAtomic: null,
        memoPrefix: MEMO_PREFIX,
      },
    ],
    ...overrides,
  };
}

const RAW_BINDING = Object.freeze(rawBinding());
const FIXTURE_BINDING = Object.freeze({ binding: RAW_BINDING, expectedDigest: digest(RAW_BINDING) });

function moneyConfiguration() {
  const usdg = { chainId: '4663', assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 };
  return {
    schema: 'hookemon.money-configuration.v1',
    assets: { usdg, solanaStablecoin: settlementAsset() },
    minimums: {
      robinhoodReceive: { ...usdg, amountAtomic: '0' },
      solanaReceive: { ...settlementAsset(), amountAtomic: '0' },
      returnUsdg: { ...usdg, amountAtomic: '0' },
    },
    evm: {
      perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '2' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '2' },
    },
    solana: {
      priorityFeeCap: { chainId: CHAIN_ID, assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '10000' },
      lamportReserve: { chainId: CHAIN_ID, assetId: 'native', decimals: 9, amountAtomic: '2' },
    },
  };
}

function config({ fixtureBinding = null, legacyPolicy = undefined } = {}) {
  return {
    execution: { profile: 'rehearsal', providerMode: 'live' },
    rehearsal: { mode: 'collector-only', proceedsAccount: PROCEEDS_ACCOUNT, payoutRecipients: [RECIPIENT] },
    accounts: { solana: OPERATOR_ADDRESS, evm: null },
    pack: { code: PACK_TYPE },
    solana: { chainId: CHAIN_ID, blockhashContextResolver: async blockhash => ({ blockhash, lastValidBlockHeight: String(LAST_VALID_BLOCK_HEIGHT) }) },
    collectorCrypt: {
      settlementAsset: settlementAsset(),
      packPrice: { ...settlementAsset(), amountAtomic: PACK_PRICE_ATOMIC },
      purchase: {
        ...(fixtureBinding === null ? {} : { testFixtureBinding: fixtureBinding }),
        ...(legacyPolicy === undefined ? {} : { policy: legacyPolicy }),
      },
    },
    signer: { backend: 'keychain', liveMode: true, roles: ['operator-solana'], keychain: { solanaAccount: 'operator-solana' } },
    moneyConfiguration: moneyConfiguration(),
  };
}

function requestFor(quantity) {
  return {
    provider: 'collector-crypt',
    operation: 'purchase',
    playerAddress: OPERATOR_ADDRESS,
    quantity,
    unitPurchase: { ...settlementAsset(), amountAtomic: PACK_PRICE_ATOMIC },
    aggregatePurchase: { ...settlementAsset(), amountAtomic: (BigInt(PACK_PRICE_ATOMIC) * BigInt(quantity)).toString() },
    expectedCardCountPerPack: 1,
  };
}

function repository() {
  const batchState = {};
  const intentState = {};
  return {
    batchState,
    intentState,
    async readPackBatchRequest(_cycleId, stage) { return batchState[stage] ?? null; },
    async recordPackBatchRequest(_cycleId, stage, packs) {
      if (batchState[stage]) return batchState[stage];
      const record = { requestedAtMs: 1_000, packs };
      batchState[stage] = record;
      return record;
    },
    async recordPackBatchIntent(_cycleId, stage, intent) {
      if (intentState[stage]) return intentState[stage];
      const record = { recordedAtMs: 1_000, intent };
      intentState[stage] = record;
      return record;
    },
  };
}

function jsonRpc(result, id = 1) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function tokenAccountResponse() {
  return {
    value: {
      owner: TOKEN_PROGRAM_ID,
      data: {
        program: 'spl-token',
        parsed: { type: 'account', info: { owner: OPERATOR_ADDRESS, mint: CIRCLE_USD_MINT, tokenAmount: { amount: '1000000000', decimals: CIRCLE_USD_DECIMALS } } },
      },
    },
  };
}

function rpcClient() {
  return createSolanaRpcClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'getAccountInfo') return jsonRpc(tokenAccountResponse(), body.id);
      if (body.method === 'getBalance') return jsonRpc({ value: 10_000_000_000 }, body.id);
      if (body.method === 'isBlockhashValid') return jsonRpc({ value: true }, body.id);
      if (body.method === 'getBlockHeight') return jsonRpc(CURRENT_BLOCK_HEIGHT, body.id);
      if (body.method === 'getLatestBlockhash') {
        return jsonRpc({ value: { blockhash: FIXED_BLOCKHASH, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT } }, body.id);
      }
      throw new Error(`unexpected RPC method ${body.method}`);
    },
  });
}

function transferCheckedData(amountAtomic, decimals) {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(BigInt(amountAtomic), 1);
  data.writeUInt8(decimals, 9);
  return data;
}

function buildCandidateTransaction({
  memoValue,
  blockhash = FIXED_BLOCKHASH,
  amountAtomic = PACK_PRICE_ATOMIC,
  decimals = CIRCLE_USD_DECIMALS,
  computeUnitLimit = 40000,
  priorityFeeMicroLamports = 4000,
  destinationKey = destination.publicKey,
  mintKey = new PublicKey(CIRCLE_USD_MINT),
  sourceAtaKey = new PublicKey(SOURCE_ATA),
  coSignerKey = coSigner,
  memoPrefix = MEMO_PREFIX,
}) {
  const transaction = new Transaction({ feePayer: operator.publicKey, recentBlockhash: blockhash });
  transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports }));
  transaction.add(new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: sourceAtaKey, isSigner: false, isWritable: true },
      { pubkey: mintKey, isSigner: false, isWritable: false },
      { pubkey: destinationKey, isSigner: false, isWritable: true },
      { pubkey: operator.publicKey, isSigner: true, isWritable: true },
    ],
    data: transferCheckedData(amountAtomic, decimals),
  }));
  transaction.add(new TransactionInstruction({
    programId: new PublicKey(MEMO_PROGRAM_ID),
    keys: [{ pubkey: coSignerKey.publicKey, isSigner: true, isWritable: false }],
    data: Buffer.from(`${memoPrefix}${memoValue}`, 'utf8'),
  }));
  transaction.partialSign(coSignerKey);
  return Buffer.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64');
}

function signerClientFixture(signSpy) {
  return {
    solana: {
      async sign(transactionBase64) {
        signSpy.calls += 1;
        const transaction = Transaction.from(Buffer.from(transactionBase64, 'base64'));
        transaction.partialSign(operator);
        return { signedTxBase64: Buffer.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64') };
      },
    },
  };
}

const PACK_MEMO_0 = 'purchase-cycle2-pack-0';
const PACK_MEMO_1 = 'purchase-cycle2-pack-1';

function baseArgs({ collectorCrypt, signSpy, cfg = config({ fixtureBinding: FIXTURE_BINDING }), cycleId = 'cycle-n2', quantity = 1 }) {
  return {
    liveMode: true,
    adapters: { collectorCrypt, solana: { client: rpcClient() } },
    signerClient: signerClientFixture(signSpy),
    config: cfg,
    cycleRepository: repository(),
    context: { cycleId, requestDigest: REQUEST_DIGEST },
    request: requestFor(quantity),
  };
}

// --- positive: N=2 --------------------------------------------------------------------------

test('N=2: one generation call, two distinct memo-bound policies, exactly two signs and two submits, no other transport', async () => {
  const packs = [
    { memo: PACK_MEMO_0, transaction: buildCandidateTransaction({ memoValue: PACK_MEMO_0 }) },
    { memo: PACK_MEMO_1, transaction: buildCandidateTransaction({ memoValue: PACK_MEMO_1 }) },
  ];
  let generateCalls = 0;
  const submitSpy = { calls: 0 };
  const signSpy = { calls: 0 };
  const collectorCrypt = {
    async generateYoloPacks({ quantity }) {
      generateCalls += 1;
      assert.equal(quantity, 2);
      return { packs };
    },
    async submitTransaction({ signedTransaction }) {
      submitSpy.calls += 1;
      return { signature: signedSolanaTransactionSignature(signedTransaction) };
    },
  };

  const evidence = await mutatePurchase(baseArgs({ collectorCrypt, signSpy, quantity: 2 }));

  assert.deepEqual(evidence, { quantity: 2, expectedCardCountPerPack: 1 });
  assert.equal(generateCalls, 1, 'purchase must call generateYoloPacks exactly once for the whole batch');
  assert.equal(signSpy.calls, 2, 'purchase must sign each of the two packs exactly once');
  assert.equal(submitSpy.calls, 2, 'purchase must submit each of the two signed packs exactly once');
});

// --- negative: missing binding/policy -------------------------------------------------------

test('missing binding/policy: neither a fixture binding nor a legacy policy refuses before generation, sign, or submit', async () => {
  let generateCalls = 0;
  const signSpy = { calls: 0 };
  const collectorCrypt = {
    async generateYoloPacks() { generateCalls += 1; throw new Error('must not be called'); },
    async submitTransaction() { throw new Error('must not be called'); },
  };

  await assert.rejects(
    () => mutatePurchase(baseArgs({ collectorCrypt, signSpy, cfg: config() })),
    /Collector purchase requires a pinned transaction policy/,
  );
  assert.equal(generateCalls, 0);
  assert.equal(signSpy.calls, 0);
});

// --- negative: bad binding digest/settlement identity ----------------------------------------

test('bad binding digest: a fixture binding whose bytes do not match its expected digest refuses before generation, sign, or submit', async () => {
  let generateCalls = 0;
  const signSpy = { calls: 0 };
  const collectorCrypt = {
    async generateYoloPacks() { generateCalls += 1; throw new Error('must not be called'); },
    async submitTransaction() { throw new Error('must not be called'); },
  };
  const badFixture = { binding: RAW_BINDING, expectedDigest: `sha256:${'0'.repeat(64)}` };

  await assert.rejects(
    () => mutatePurchase(baseArgs({ collectorCrypt, signSpy, cfg: config({ fixtureBinding: badFixture }) })),
    /digest does not match/,
  );
  assert.equal(generateCalls, 0);
  assert.equal(signSpy.calls, 0);
});

test('bad binding settlement identity: a fixture binding whose settlement mint disagrees with the configured settlement asset refuses before generation', async () => {
  let generateCalls = 0;
  const signSpy = { calls: 0 };
  const collectorCrypt = {
    async generateYoloPacks() { generateCalls += 1; throw new Error('must not be called'); },
    async submitTransaction() { throw new Error('must not be called'); },
  };
  const otherMint = Keypair.generate().publicKey.toBase58();
  const binding = rawBinding({ settlement: { destination: destination.publicKey.toBase58(), mint: otherMint, decimals: CIRCLE_USD_DECIMALS } });
  const fixture = { binding, expectedDigest: digest(binding) };

  await assert.rejects(
    () => mutatePurchase(baseArgs({ collectorCrypt, signSpy, cfg: config({ fixtureBinding: fixture }) })),
    /settlement mint does not match/,
  );
  assert.equal(generateCalls, 0);
  assert.equal(signSpy.calls, 0);
});

// --- negative: candidate mismatches (generation already happened; refuse before sign/submit) --

test('candidate destination mismatch: refuses before sign or submit', async () => {
  const packs = [{ memo: PACK_MEMO_0, transaction: buildCandidateTransaction({ memoValue: PACK_MEMO_0, destinationKey: Keypair.generate().publicKey }) }];
  let generateCalls = 0;
  const submitSpy = { calls: 0 };
  const signSpy = { calls: 0 };
  const collectorCrypt = {
    async generateYoloPacks() { generateCalls += 1; return { packs }; },
    async submitTransaction() { submitSpy.calls += 1; throw new Error('must not be called'); },
  };

  await assert.rejects(() => mutatePurchase(baseArgs({ collectorCrypt, signSpy })), TransactionPolicyError);
  assert.equal(generateCalls, 1);
  assert.equal(signSpy.calls, 0);
  assert.equal(submitSpy.calls, 0);
});

test('candidate mint mismatch: refuses before sign or submit', async () => {
  const packs = [{ memo: PACK_MEMO_0, transaction: buildCandidateTransaction({ memoValue: PACK_MEMO_0, mintKey: Keypair.generate().publicKey }) }];
  let generateCalls = 0;
  const submitSpy = { calls: 0 };
  const signSpy = { calls: 0 };
  const collectorCrypt = {
    async generateYoloPacks() { generateCalls += 1; return { packs }; },
    async submitTransaction() { submitSpy.calls += 1; throw new Error('must not be called'); },
  };

  await assert.rejects(() => mutatePurchase(baseArgs({ collectorCrypt, signSpy })), TransactionPolicyError);
  assert.equal(generateCalls, 1);
  assert.equal(signSpy.calls, 0);
  assert.equal(submitSpy.calls, 0);
});

test('candidate memo cross-mismatch: a pack whose candidate carries a different pack\'s memo refuses before sign or submit, proving each pack is checked against its own policy', async () => {
  // This pack is durably recorded under PACK_MEMO_0, but the candidate bytes carry PACK_MEMO_1's
  // memo instead -- proving the per-pack policy built from PACK_MEMO_0 (this pack's own durable
  // memo) is the one actually evaluated against it, not a shared or swapped policy.
  const packs = [{ memo: PACK_MEMO_0, transaction: buildCandidateTransaction({ memoValue: PACK_MEMO_1 }) }];
  let generateCalls = 0;
  const submitSpy = { calls: 0 };
  const signSpy = { calls: 0 };
  const collectorCrypt = {
    async generateYoloPacks() { generateCalls += 1; return { packs }; },
    async submitTransaction() { submitSpy.calls += 1; throw new Error('must not be called'); },
  };

  await assert.rejects(() => mutatePurchase(baseArgs({ collectorCrypt, signSpy })), TransactionPolicyError);
  assert.equal(generateCalls, 1);
  assert.equal(signSpy.calls, 0);
  assert.equal(submitSpy.calls, 0);
});

test('candidate blockhash mismatch: refuses before sign or submit', async () => {
  const packs = [{ memo: PACK_MEMO_0, transaction: buildCandidateTransaction({ memoValue: PACK_MEMO_0, blockhash: Keypair.generate().publicKey.toBase58() }) }];
  let generateCalls = 0;
  const submitSpy = { calls: 0 };
  const signSpy = { calls: 0 };
  const collectorCrypt = {
    async generateYoloPacks() { generateCalls += 1; return { packs }; },
    async submitTransaction() { submitSpy.calls += 1; throw new Error('must not be called'); },
  };

  await assert.rejects(() => mutatePurchase(baseArgs({ collectorCrypt, signSpy })), TransactionPolicyError);
  assert.equal(generateCalls, 1);
  assert.equal(signSpy.calls, 0);
  assert.equal(submitSpy.calls, 0);
});

// --- negative: the fixture seam itself is Node-test-only --------------------------------------

test('the fixture binding is refused outside the Node test runner even when fully configured, before any generation', async () => {
  let generateCalls = 0;
  const signSpy = { calls: 0 };
  const collectorCrypt = {
    async generateYoloPacks() { generateCalls += 1; throw new Error('must not be called'); },
    async submitTransaction() { throw new Error('must not be called'); },
  };
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    await assert.rejects(
      () => mutatePurchase(baseArgs({ collectorCrypt, signSpy })),
      /Collector purchase fixture binding is available only from the Node test runner/,
    );
  } finally {
    process.env.NODE_TEST_CONTEXT = saved;
  }
  assert.equal(generateCalls, 0);
  assert.equal(signSpy.calls, 0);
});
