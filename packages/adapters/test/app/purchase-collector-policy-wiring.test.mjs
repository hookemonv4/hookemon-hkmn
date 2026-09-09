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
  SOLANA_RELAY_CHAIN_ID,
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
  const eth = { chainId: '4663', assetId: 'native', decimals: 18 };
  return {
    schema: 'hookemon.money-configuration.v2',
    assets: { eth, solanaStablecoin: settlementAsset() },
    minimums: {
      robinhoodReceive: { ...eth, amountAtomic: '0' },
      solanaReceive: { ...settlementAsset(), amountAtomic: '0' },
      returnEth: { ...eth, amountAtomic: '0' },
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

function config({ fixtureBinding = null, legacyPolicy = undefined, blockhashHeights = null } = {}) {
  return {
    execution: { profile: 'rehearsal', providerMode: 'live' },
    rehearsal: { mode: 'collector-only', proceedsAccount: PROCEEDS_ACCOUNT, payoutRecipients: [RECIPIENT] },
    accounts: { solana: OPERATOR_ADDRESS, evm: null },
    pack: { code: PACK_TYPE },
    solana: {
      chainId: CHAIN_ID,
      // Per-candidate lookup so a positive fixture with two independently pinned blockhash/height
      // pairs (one per pack) decodes each candidate against its own actual chain state, not a
      // single fixed height shared by every pack.
      blockhashContextResolver: async blockhash => ({
        blockhash,
        lastValidBlockHeight: String(blockhashHeights?.[blockhash] ?? LAST_VALID_BLOCK_HEIGHT),
      }),
    },
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

function requestFor(quantity, unitPurchaseOverride = null) {
  return {
    provider: 'collector-crypt',
    operation: 'purchase',
    playerAddress: OPERATOR_ADDRESS,
    quantity,
    unitPurchase: unitPurchaseOverride ?? { ...settlementAsset(), amountAtomic: PACK_PRICE_ATOMIC },
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

function noIntentOrBatchRecorded(repo) {
  return Object.keys(repo.intentState).length === 0 && Object.keys(repo.batchState).length === 0;
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

function rpcClient({
  blockhashSequence = [{ blockhash: FIXED_BLOCKHASH, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT }],
  latestBlockhashSpy = { calls: 0 },
} = {}) {
  return createSolanaRpcClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'getAccountInfo') return jsonRpc(tokenAccountResponse(), body.id);
      if (body.method === 'getBalance') return jsonRpc({ value: 10_000_000_000 }, body.id);
      if (body.method === 'isBlockhashValid') return jsonRpc({ value: true }, body.id);
      if (body.method === 'getBlockHeight') return jsonRpc(CURRENT_BLOCK_HEIGHT, body.id);
      if (body.method === 'getLatestBlockhash') {
        // Consumed only by mutatePurchase's own per-pack fresh-context read (never by decode,
        // which is wired through config.solana.blockhashContextResolver instead), so each call
        // proves one independent read immediately before that pack's policy/decode.
        const index = Math.min(latestBlockhashSpy.calls, blockhashSequence.length - 1);
        latestBlockhashSpy.calls += 1;
        const pair = blockhashSequence[index];
        return jsonRpc({ value: { blockhash: pair.blockhash, lastValidBlockHeight: pair.lastValidBlockHeight } }, body.id);
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

function baseArgs({
  collectorCrypt,
  signSpy,
  cfg = config({ fixtureBinding: FIXTURE_BINDING }),
  cycleId = 'cycle-n2',
  quantity = 1,
  repo = repository(),
  blockhashSequence,
  latestBlockhashSpy,
  unitPurchaseOverride = null,
}) {
  return {
    liveMode: true,
    adapters: { collectorCrypt, solana: { client: rpcClient({ blockhashSequence, latestBlockhashSpy }) } },
    signerClient: signerClientFixture(signSpy),
    config: cfg,
    cycleRepository: repo,
    context: { cycleId, requestDigest: REQUEST_DIGEST },
    request: requestFor(quantity, unitPurchaseOverride),
  };
}

// --- positive: N=2 --------------------------------------------------------------------------

test('N=2: one generation call, two distinct memo-bound policies, exactly two signs and two submits, no other transport', async () => {
  // Two independently pinned blockhash/height pairs -- one per pack -- so this test proves each
  // durably recorded pack gets its own fresh context read immediately before its own policy and
  // decode, not one context inferred for the whole batch.
  const BLOCKHASH_PACK_0 = Keypair.generate().publicKey.toBase58();
  const BLOCKHASH_PACK_1 = Keypair.generate().publicKey.toBase58();
  const blockhashSequence = [
    { blockhash: BLOCKHASH_PACK_0, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT },
    { blockhash: BLOCKHASH_PACK_1, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT + 1000 },
  ];
  const cfg = config({
    fixtureBinding: FIXTURE_BINDING,
    blockhashHeights: {
      [BLOCKHASH_PACK_0]: LAST_VALID_BLOCK_HEIGHT,
      [BLOCKHASH_PACK_1]: LAST_VALID_BLOCK_HEIGHT + 1000,
    },
  });
  const packs = [
    { memo: PACK_MEMO_0, transaction: buildCandidateTransaction({ memoValue: PACK_MEMO_0, blockhash: BLOCKHASH_PACK_0 }) },
    { memo: PACK_MEMO_1, transaction: buildCandidateTransaction({ memoValue: PACK_MEMO_1, blockhash: BLOCKHASH_PACK_1 }) },
  ];
  let generateCalls = 0;
  const submitSpy = { calls: 0 };
  const signSpy = { calls: 0 };
  const latestBlockhashSpy = { calls: 0 };
  const repo = repository();
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

  const evidence = await mutatePurchase(baseArgs({
    collectorCrypt, signSpy, cfg, quantity: 2, repo, blockhashSequence, latestBlockhashSpy,
  }));

  assert.deepEqual(evidence, { quantity: 2, expectedCardCountPerPack: 1 });
  assert.equal(generateCalls, 1, 'purchase must call generateYoloPacks exactly once for the whole batch');
  assert.equal(signSpy.calls, 2, 'purchase must sign each of the two packs exactly once');
  assert.equal(submitSpy.calls, 2, 'purchase must submit each of the two signed packs exactly once');
  assert.equal(latestBlockhashSpy.calls, 2, 'purchase must read one fresh blockhash context per durably recorded pack');
  assert.equal(Object.keys(repo.intentState).length, 1, 'purchase must durably record exactly one batch intent');
});

// --- negative: missing binding/policy -------------------------------------------------------

test('missing binding/policy: neither a fixture binding nor a legacy policy refuses before generation, sign, or submit', async () => {
  let generateCalls = 0;
  const signSpy = { calls: 0 };
  const repo = repository();
  const collectorCrypt = {
    async generateYoloPacks() { generateCalls += 1; throw new Error('must not be called'); },
    async submitTransaction() { throw new Error('must not be called'); },
  };

  await assert.rejects(
    () => mutatePurchase(baseArgs({ collectorCrypt, signSpy, cfg: config(), repo })),
    /Collector purchase requires a pinned transaction policy/,
  );
  assert.equal(generateCalls, 0);
  assert.equal(signSpy.calls, 0);
  assert.ok(noIntentOrBatchRecorded(repo), 'refusal must leave zero durable intent and zero durable batch');
});

// --- negative: bad binding digest/settlement identity ----------------------------------------

test('bad binding digest: a fixture binding whose bytes do not match its expected digest refuses before generation, sign, or submit', async () => {
  let generateCalls = 0;
  const signSpy = { calls: 0 };
  const repo = repository();
  const collectorCrypt = {
    async generateYoloPacks() { generateCalls += 1; throw new Error('must not be called'); },
    async submitTransaction() { throw new Error('must not be called'); },
  };
  const badFixture = { binding: RAW_BINDING, expectedDigest: `sha256:${'0'.repeat(64)}` };

  await assert.rejects(
    () => mutatePurchase(baseArgs({ collectorCrypt, signSpy, cfg: config({ fixtureBinding: badFixture }), repo })),
    /digest does not match/,
  );
  assert.equal(generateCalls, 0);
  assert.equal(signSpy.calls, 0);
  assert.ok(noIntentOrBatchRecorded(repo), 'refusal must leave zero durable intent and zero durable batch');
});

test('bad binding settlement identity: a fixture binding whose settlement mint disagrees with the configured settlement asset refuses before generation', async () => {
  let generateCalls = 0;
  const signSpy = { calls: 0 };
  const repo = repository();
  const collectorCrypt = {
    async generateYoloPacks() { generateCalls += 1; throw new Error('must not be called'); },
    async submitTransaction() { throw new Error('must not be called'); },
  };
  const otherMint = Keypair.generate().publicKey.toBase58();
  const binding = rawBinding({ settlement: { destination: destination.publicKey.toBase58(), mint: otherMint, decimals: CIRCLE_USD_DECIMALS } });
  const fixture = { binding, expectedDigest: digest(binding) };

  await assert.rejects(
    () => mutatePurchase(baseArgs({ collectorCrypt, signSpy, cfg: config({ fixtureBinding: fixture }), repo })),
    /settlement mint does not match/,
  );
  assert.equal(generateCalls, 0);
  assert.equal(signSpy.calls, 0);
  assert.ok(noIntentOrBatchRecorded(repo), 'refusal must leave zero durable intent and zero durable batch');
});

test('unknown fixture wrapper field: a fixture wrapper with an extra key beyond binding/expectedDigest refuses before generation', async () => {
  let generateCalls = 0;
  const signSpy = { calls: 0 };
  const repo = repository();
  const collectorCrypt = {
    async generateYoloPacks() { generateCalls += 1; throw new Error('must not be called'); },
    async submitTransaction() { throw new Error('must not be called'); },
  };
  const fixtureWithExtraField = { binding: RAW_BINDING, expectedDigest: digest(RAW_BINDING), extra: 'unexpected' };

  await assert.rejects(
    () => mutatePurchase(baseArgs({ collectorCrypt, signSpy, cfg: config({ fixtureBinding: fixtureWithExtraField }), repo })),
    /must supply exactly binding and expectedDigest/,
  );
  assert.equal(generateCalls, 0);
  assert.equal(signSpy.calls, 0);
  assert.ok(noIntentOrBatchRecorded(repo), 'refusal must leave zero durable intent and zero durable batch');
});

test('wrong unit asset: an admitted unitPurchase whose asset identity disagrees with the configured settlement asset refuses before generation', async () => {
  let generateCalls = 0;
  const signSpy = { calls: 0 };
  const repo = repository();
  const collectorCrypt = {
    async generateYoloPacks() { generateCalls += 1; throw new Error('must not be called'); },
    async submitTransaction() { throw new Error('must not be called'); },
  };
  const wrongUnitPurchase = { chainId: CHAIN_ID, assetId: Keypair.generate().publicKey.toBase58(), decimals: CIRCLE_USD_DECIMALS, amountAtomic: PACK_PRICE_ATOMIC };

  await assert.rejects(
    () => mutatePurchase(baseArgs({ collectorCrypt, signSpy, repo, unitPurchaseOverride: wrongUnitPurchase })),
    /admitted unitPurchase does not match the configured MoneyConfigurationV1 Solana settlement asset/,
  );
  assert.equal(generateCalls, 0);
  assert.equal(signSpy.calls, 0);
  assert.ok(noIntentOrBatchRecorded(repo), 'refusal must leave zero durable intent and zero durable batch');
});

test('wrong unit namespace: an admitted unitPurchase carrying the Relay chain id in this native-namespace execution profile refuses before generation', async () => {
  // This is the exact production admission shape (MoneyConfigurationV1's Relay-namespaced
  // amount, docs/modules/composition-root.md:99-106) misapplied to a config whose validated
  // MoneyConfigurationV1 Solana asset is native -- the assertSolanaAdmittedPurchaseAmount mapping
  // must refuse it here rather than silently accepting a cross-namespace amount.
  let generateCalls = 0;
  const signSpy = { calls: 0 };
  const repo = repository();
  const collectorCrypt = {
    async generateYoloPacks() { generateCalls += 1; throw new Error('must not be called'); },
    async submitTransaction() { throw new Error('must not be called'); },
  };
  const relayLabelledUnitPurchase = { chainId: String(SOLANA_RELAY_CHAIN_ID), assetId: CIRCLE_USD_MINT, decimals: CIRCLE_USD_DECIMALS, amountAtomic: PACK_PRICE_ATOMIC };

  await assert.rejects(
    () => mutatePurchase(baseArgs({ collectorCrypt, signSpy, repo, unitPurchaseOverride: relayLabelledUnitPurchase })),
    /admitted unitPurchase does not match the configured MoneyConfigurationV1 Solana settlement asset/,
  );
  assert.equal(generateCalls, 0);
  assert.equal(signSpy.calls, 0);
  assert.ok(noIntentOrBatchRecorded(repo), 'refusal must leave zero durable intent and zero durable batch');
});

test('wrong unit decimals: an admitted unitPurchase whose decimals disagree with the configured settlement asset refuses before generation', async () => {
  let generateCalls = 0;
  const signSpy = { calls: 0 };
  const repo = repository();
  const collectorCrypt = {
    async generateYoloPacks() { generateCalls += 1; throw new Error('must not be called'); },
    async submitTransaction() { throw new Error('must not be called'); },
  };
  const wrongDecimalsUnitPurchase = { chainId: CHAIN_ID, assetId: CIRCLE_USD_MINT, decimals: CIRCLE_USD_DECIMALS + 1, amountAtomic: PACK_PRICE_ATOMIC };

  await assert.rejects(
    () => mutatePurchase(baseArgs({ collectorCrypt, signSpy, repo, unitPurchaseOverride: wrongDecimalsUnitPurchase })),
    /admitted unitPurchase does not match the configured MoneyConfigurationV1 Solana settlement asset/,
  );
  assert.equal(generateCalls, 0);
  assert.equal(signSpy.calls, 0);
  assert.ok(noIntentOrBatchRecorded(repo), 'refusal must leave zero durable intent and zero durable batch');
});

test('malformed unit amount: a noncanonical admitted unitPurchase amountAtomic refuses before generation', async () => {
  let generateCalls = 0;
  const signSpy = { calls: 0 };
  const repo = repository();
  const collectorCrypt = {
    async generateYoloPacks() { generateCalls += 1; throw new Error('must not be called'); },
    async submitTransaction() { throw new Error('must not be called'); },
  };
  const malformedUnitPurchase = { chainId: CHAIN_ID, assetId: CIRCLE_USD_MINT, decimals: CIRCLE_USD_DECIMALS, amountAtomic: '007' };

  await assert.rejects(
    () => mutatePurchase(baseArgs({ collectorCrypt, signSpy, repo, unitPurchaseOverride: malformedUnitPurchase })),
    /admitted unitPurchase amountAtomic is invalid/,
  );
  assert.equal(generateCalls, 0);
  assert.equal(signSpy.calls, 0);
  assert.ok(noIntentOrBatchRecorded(repo), 'refusal must leave zero durable intent and zero durable batch');
});

test('provider-callback mutation cannot splice a different binding/digest into an already-validated fixture', async () => {
  // A mutable (unfrozen) fixture, distinct from the shared frozen FIXTURE_BINDING, so the
  // provider callback below can mutate it in place during the generateYoloPacks await -- after
  // mutatePurchase has already validated it and captured its own immutable trusted snapshot.
  const mutableBinding = structuredClone(RAW_BINDING);
  const mutableFixture = { binding: mutableBinding, expectedDigest: digest(mutableBinding) };
  const hijackDestination = Keypair.generate();
  const packs = [{
    memo: PACK_MEMO_0,
    transaction: buildCandidateTransaction({ memoValue: PACK_MEMO_0, destinationKey: hijackDestination.publicKey }),
  }];
  let generateCalls = 0;
  const submitSpy = { calls: 0 };
  const signSpy = { calls: 0 };
  const collectorCrypt = {
    async generateYoloPacks({ quantity }) {
      generateCalls += 1;
      assert.equal(quantity, 1);
      // Splice attempt: rewrite the raw fixture's binding destination and expected digest, during
      // the await, to describe a binding that matches this call's own (hijacked) candidate.
      mutableFixture.binding.settlement.destination = hijackDestination.publicKey.toBase58();
      mutableFixture.expectedDigest = digest(mutableFixture.binding);
      return { packs };
    },
    async submitTransaction() { submitSpy.calls += 1; throw new Error('must not be called'); },
  };

  await assert.rejects(
    () => mutatePurchase(baseArgs({ collectorCrypt, signSpy, cfg: config({ fixtureBinding: mutableFixture }) })),
    TransactionPolicyError,
  );
  assert.equal(generateCalls, 1, 'the binding was valid at preflight, so generation still proceeds');
  assert.equal(signSpy.calls, 0);
  assert.equal(submitSpy.calls, 0);
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

test('purchase preserves an older provider message with fresh original-hash observations', async () => {
  const cfg = config({ fixtureBinding: FIXTURE_BINDING });
  let observations = 0;
  cfg.solana.originalBlockhashContextResolver = async blockhash => {
    assert.equal(blockhash, FIXED_BLOCKHASH);
    return { type: 'rpc-blockhash-validity', blockhash, valid: true, observedSlot: String(200 + observations++) };
  };
  const candidate = buildCandidateTransaction({ memoValue: PACK_MEMO_0 });
  let submitted = null;
  const latestBlockhashSpy = { calls: 0 };
  const signSpy = { calls: 0 };
  const collectorCrypt = {
    async generateYoloPacks() { return { packs: [{ memo: PACK_MEMO_0, transaction: candidate }] }; },
    async submitTransaction({ signedTransaction }) {
      submitted = signedTransaction;
      return { signature: signedSolanaTransactionSignature(signedTransaction) };
    },
  };
  await mutatePurchase(baseArgs({ collectorCrypt, signSpy, cfg, latestBlockhashSpy,
    blockhashSequence: [{ blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT }] }));
  assert.equal(latestBlockhashSpy.calls, 0);
  assert.ok(observations >= 3, 'each validation must obtain a fresh observation');
  assert.deepEqual(Transaction.from(Buffer.from(submitted, 'base64')).serializeMessage(), Transaction.from(Buffer.from(candidate, 'base64')).serializeMessage());
});

test('bound single-pack request uses generatePack after intent and reuses the durable memo on restart', async () => {
  const repo = repository();
  const signSpy = { calls: 0 };
  let generated = 0, submitted = 0;
  const collectorCrypt = {
    async generatePack(request) {
      generated++;
      assert.deepEqual(request, { playerAddress: OPERATOR_ADDRESS, turbo: false });
      assert.equal(repo.intentState.purchase.intent.quantity, 1);
      return { memo: PACK_MEMO_0, transaction: buildCandidateTransaction({ memoValue: PACK_MEMO_0 }) };
    },
    async generateYoloPacks() { assert.fail('single-pack request must not use the batch endpoint'); },
    async submitTransaction({ signedTransaction }) {
      submitted++;
      return { signature: signedSolanaTransactionSignature(signedTransaction) };
    },
  };
  const args = baseArgs({ collectorCrypt, signSpy, repo });
  args.request.generation = { endpoint: 'generatePack', turbo: false };
  await mutatePurchase(args);
  await mutatePurchase(args);
  assert.equal(generated, 1);
  assert.equal(signSpy.calls, 1);
  assert.equal(submitted, 1);
  assert.equal(repo.batchState.purchase.packs[0].memo, PACK_MEMO_0);
});

for (const generation of [
  { endpoint: 'generatePack', turbo: true },
  { endpoint: 'generateYoloPacks', turbo: false },
  { endpoint: 'generatePack', turbo: false, altFundsRecipient: OPERATOR_ADDRESS },
]) test(`invalid bound generation refuses before intent: ${JSON.stringify(generation)}`, async () => {
  const repo = repository(), signSpy = { calls: 0 };
  const collectorCrypt = {
    async generatePack() { assert.fail('invalid request must not contact provider'); },
    async generateYoloPacks() { assert.fail('invalid request must not contact provider'); },
  };
  const args = baseArgs({ collectorCrypt, signSpy, repo });
  args.request.generation = generation;
  await assert.rejects(mutatePurchase(args), /generation must bind one non-turbo/);
  assert.ok(noIntentOrBatchRecorded(repo));
  assert.equal(signSpy.calls, 0);
});

test('single-pack endpoint refuses a batch quantity or missing transport before intent', async () => {
  for (const quantity of [1, 2]) {
    const repo = repository(), signSpy = { calls: 0 };
    const args = baseArgs({ collectorCrypt: {}, signSpy, repo, quantity });
    args.request.generation = { endpoint: 'generatePack', turbo: false };
    await assert.rejects(mutatePurchase(args), quantity === 1 ? /bound generatePack transport/ : /generation must bind one non-turbo/);
    assert.ok(noIntentOrBatchRecorded(repo));
    assert.equal(signSpy.calls, 0);
  }
});
