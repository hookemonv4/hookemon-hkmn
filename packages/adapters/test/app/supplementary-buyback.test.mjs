import assert from 'node:assert/strict';
import test from 'node:test';

import { Keypair, PublicKey, Transaction } from '@solana/web3.js';

import {
  CIRCLE_USD_DECIMALS,
  CIRCLE_USD_MINT,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  buildTransferCheckedInstruction,
  buildUnsignedTransaction,
  createSolanaRpcClient,
  deriveAssociatedTokenAddress,
  signedSolanaTransactionSignature,
} from '../../src/solana-rpc.mjs';
import {
  createSupplementaryBuybackHandler,
  reconcileSupplementaryBuybackSale,
} from '../../src/app/stages/supplementary-buyback.mjs';

const CYCLE_ID = 'cycle-supplementary-buyback';
const CHAIN_ID = 'solana-mainnet';
const OPERATOR_KEYPAIR = Keypair.fromSeed(Uint8Array.from(Array(32).fill(3)));
const OPERATOR = OPERATOR_KEYPAIR.publicKey.toBase58();
const CARD_ASSET = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const SETTLEMENT_ASSET = CIRCLE_USD_MINT;
const COLLECTOR_RECIPIENT = '8SFqwqnq4whPhs8icwHA2hQg3hUoN1qrCLK1SBx3WKwe';
const MEMO = 'memo-supplementary-buyback';
const BUYBACK_SIGNATURE = 'S9'.repeat(44);
const POSITION_ID = `held:${'a'.repeat(64)}`;
const POSITION_EVIDENCE_DIGEST = `sha256:${'b'.repeat(64)}`;

function settlementAsset() {
  return { chainId: CHAIN_ID, assetId: SETTLEMENT_ASSET, decimals: CIRCLE_USD_DECIMALS };
}

function jsonRpc(result, id = 1) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function tokenAccountResponse({ owner = OPERATOR, mint = SETTLEMENT_ASSET, amount = '100', decimals = CIRCLE_USD_DECIMALS } = {}) {
  return {
    value: {
      owner: TOKEN_PROGRAM_ID,
      data: { program: 'spl-token', parsed: { type: 'account', info: { owner, mint, tokenAmount: { amount, decimals } } } },
    },
  };
}

function transactionResponse(entries) {
  const accountKeys = entries.map(entry => ({ pubkey: entry.tokenAccount, signer: false, writable: true }));
  const preTokenBalances = entries.map((entry, accountIndex) => ({
    accountIndex, mint: entry.mint, owner: entry.owner,
    uiTokenAmount: { amount: entry.preAmount, decimals: entry.decimals ?? CIRCLE_USD_DECIMALS, uiAmountString: entry.preAmount },
  }));
  const postTokenBalances = entries.map((entry, accountIndex) => ({
    accountIndex, mint: entry.mint, owner: entry.owner,
    uiTokenAmount: { amount: entry.postAmount, decimals: entry.decimals ?? CIRCLE_USD_DECIMALS, uiAmountString: entry.postAmount },
  }));
  return {
    transaction: { message: { accountKeys, instructions: [] } },
    meta: { preTokenBalances, postTokenBalances, innerInstructions: [] },
  };
}

function rpcClient({ tokenAccount = tokenAccountResponse(), entries = [], finalized = true, balance = 1_000_000 } = {}) {
  return createSolanaRpcClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'getAccountInfo') return jsonRpc(tokenAccount, body.id);
      if (body.method === 'getBalance') return jsonRpc({ value: balance }, body.id);
      if (body.method === 'isBlockhashValid') return jsonRpc({ value: true }, body.id);
      if (body.method === 'getBlockHeight') return jsonRpc(99, body.id);
      if (body.method === 'getSignatureStatuses') {
        return jsonRpc({ value: [{ err: null, confirmationStatus: finalized ? 'finalized' : 'confirmed' }] }, body.id);
      }
      if (body.method === 'getTransaction') return jsonRpc(transactionResponse(entries), body.id);
      throw new Error(`unexpected RPC method ${body.method}`);
    },
  });
}

/** A minimal fake Collector buyback transaction: a real transferChecked instruction moving the
 *  settlement asset to the Collector recipient, with the held card's mint appended as an extra
 *  read-only account so `decodedBindsResale`'s card-identity binding check has something to find --
 *  the real provider transaction's own exact shape is not published and is out of scope here; C's
 *  own `buyback.mjs` tests carry the same limitation (see stages-collector-lifecycle.test.mjs). */
function resaleTransaction({ amount = 85n } = {}) {
  const source = deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58();
  const instruction = buildTransferCheckedInstruction({
    source, destination: COLLECTOR_RECIPIENT, owner: OPERATOR, mint: SETTLEMENT_ASSET, amount, decimals: CIRCLE_USD_DECIMALS,
  });
  instruction.keys.push({ pubkey: new PublicKey(CARD_ASSET), isSigner: false, isWritable: false });
  return buildUnsignedTransaction({ feePayer: OPERATOR, recentBlockhash: SYSTEM_PROGRAM_ID, instructions: [instruction] });
}

function signTransaction(transactionBase64) {
  const transaction = Transaction.from(Buffer.from(transactionBase64, 'base64'));
  transaction.partialSign(OPERATOR_KEYPAIR);
  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

function collectorMoneyConfiguration() {
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
      priorityFeeCap: { chainId: CHAIN_ID, assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '2' },
      lamportReserve: { chainId: CHAIN_ID, assetId: 'native', decimals: 9, amountAtomic: '2' },
    },
  };
}

/** A fully authorized live collector-only rehearsal config -- the only config shape under which
 *  `requireCollectorOnlyMutationAuthority` grants a real mutation boundary without reading the real
 *  (currently PROVISIONAL, not FROZEN) architecture/interfaces.json. */
function config(overrides = {}) {
  return {
    execution: { profile: 'rehearsal', providerMode: 'live' },
    accounts: { evm: null, solana: OPERATOR },
    signer: { backend: 'keychain', liveMode: true, roles: ['operator-solana'], keychain: { solanaAccount: 'operator-solana' } },
    pack: { code: 'pokemon_50' },
    solana: { chainId: CHAIN_ID, blockhashContextResolver: async blockhash => ({ blockhash, lastValidBlockHeight: 100 }) },
    collectorCrypt: {
      settlementAsset: settlementAsset(),
      packPrice: { ...settlementAsset(), amountAtomic: '25000000' },
      buyback: {
        collectorProgramId: TOKEN_PROGRAM_ID,
        collectorRecipient: COLLECTOR_RECIPIENT,
        policy: null, // filled in per-test once the exact decoded transaction is known
      },
    },
    moneyConfiguration: collectorMoneyConfiguration(),
    rehearsal: {
      mode: 'collector-only',
      proceedsAccount: deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58(),
      payoutRecipients: ['GfFAJnHnSgP7C2FQZLz6ogpdTV6Y7259f83qFFm9wxKm'],
    },
    ...overrides,
  };
}

function heldPosition(overrides = {}) {
  return {
    positionId: POSITION_ID,
    cycleId: CYCLE_ID,
    packId: 'pokemon_50',
    memo: MEMO,
    mint: CARD_ASSET,
    cardRef: CARD_ASSET,
    costMicroUsdg: '25',
    valueMicroUsdg: '25',
    insuredValue: null,
    reason: 'EPIC_THRESHOLD',
    terminalState: 'HELD_OWNER_DECISION',
    evidenceDigest: POSITION_EVIDENCE_DIGEST,
    openedAtMs: 1_000,
    positionRevision: 1,
    ownerDecision: { choice: 'sell' },
    resolution: null,
    ...overrides,
  };
}

function settlementFixture(overrides = {}) {
  return {
    positionId: POSITION_ID,
    cycleId: CYCLE_ID,
    manifestId: `${CYCLE_ID}:supplementary:1`,
    state: 'PREPARED',
    positionEvidenceDigest: POSITION_EVIDENCE_DIGEST,
    eligibilitySnapshotEvidenceDigest: `sha256:${'c'.repeat(64)}`,
    payoutSourceDigest: null,
    ...overrides,
  };
}

function repository({ openPacks = [{ packIndex: 0, memo: MEMO, decision: 'opened', mint: CARD_ASSET, assetKind: 'spl' }] } = {}) {
  const advances = [];
  return {
    advances,
    async readStage(_cycleId, stage) {
      return stage === 'open' ? { status: 'COMPLETE', evidence: { packs: openPacks } } : { status: 'PENDING' };
    },
    async advanceSupplementarySettlement(positionId, input) {
      advances.push({ positionId, ...input });
      return { positionId, cycleId: CYCLE_ID, manifestId: `${CYCLE_ID}:supplementary:1`, state: input.nextState };
    },
  };
}

async function decodedPolicyFor(transactionBase64) {
  const { TRANSACTION_POLICY_SCHEMA, decodeProviderTransaction } = await import('../../src/signing/transaction-policy.mjs');
  const { policyFor } = await import('../signing/policy-fixture.mjs');
  const decoded = await decodeProviderTransaction({
    family: 'solana',
    chainId: CHAIN_ID,
    transaction: transactionBase64,
    currentBlockHeight: '99',
    blockhashContextResolver: async blockhash => ({ blockhash, lastValidBlockHeight: 100 }),
  });
  return policyFor(decoded, TRANSACTION_POLICY_SCHEMA);
}

// --- assertHeldPositionForResale guard ----------------------------------------------------------

test('reconcile refuses a position without an owner sell decision, before any provider call', async () => {
  const collectorCrypt = { async getBuybackAvailable() { throw new Error('must not be called'); } };
  const handler = createSupplementaryBuybackHandler({
    adapters: { collectorCrypt, solana: { client: rpcClient() } },
    signerClient: { solana: { role: 'operator-solana', sign: async () => { throw new Error('must not sign'); } } },
  });
  await assert.rejects(
    handler.reconcile({
      config: config(),
      cycleRepository: repository(),
      position: heldPosition({ ownerDecision: { choice: 'keep-holding' } }),
      settlement: settlementFixture(),
    }),
    /owner sell decision/,
  );
});

test('reconcile requires the settlement to be PREPARED', async () => {
  const handler = createSupplementaryBuybackHandler({
    adapters: { collectorCrypt: {}, solana: { client: rpcClient() } },
    signerClient: { solana: { role: 'operator-solana', sign: async () => { throw new Error('must not sign'); } } },
  });
  await assert.rejects(
    handler.reconcile({
      config: config(),
      cycleRepository: repository(),
      position: heldPosition(),
      settlement: settlementFixture({ state: 'BUYBACK_SENT_UNKNOWN' }),
    }),
    /requires a PREPARED settlement/,
  );
});

// --- truthful pending/held: never fabricates progress -------------------------------------------

test('reconcile stays PREPARED when the offer is unavailable, and never advances the settlement', async () => {
  const cycleRepository = repository();
  let buybackCalls = 0;
  const collectorCrypt = {
    async getBuybackCheck() { return { exists: false }; },
    async getBuybackAvailable() { return { available: false }; },
    async buyback() { buybackCalls += 1; throw new Error('must not be called'); },
  };
  const handler = createSupplementaryBuybackHandler({
    adapters: { collectorCrypt, solana: { client: rpcClient() } },
    signerClient: { solana: { role: 'operator-solana', sign: async () => { throw new Error('must not sign'); } } },
  });
  const result = await handler.reconcile({ config: config(), cycleRepository, position: heldPosition(), settlement: settlementFixture() });
  assert.equal(result, undefined);
  assert.equal(cycleRepository.advances.length, 0);
  assert.equal(buybackCalls, 0);
});

test('reconcile stays PREPARED when the operator settlement token account cannot be verified', async () => {
  const cycleRepository = repository();
  const collectorCrypt = {
    async getBuybackCheck() { return { exists: false }; },
    async getBuybackAvailable() { throw new Error('must not be reached before the account check'); },
  };
  const rpc = rpcClient({ tokenAccount: { value: null } });
  const handler = createSupplementaryBuybackHandler({
    adapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: { solana: { role: 'operator-solana', sign: async () => { throw new Error('must not sign'); } } },
  });
  const result = await handler.reconcile({ config: config(), cycleRepository, position: heldPosition(), settlement: settlementFixture() });
  assert.equal(result, undefined);
  assert.equal(cycleRepository.advances.length, 0);
});

// --- no duplicate resale across restart: check-first before any provider mutation ----------------

test('reconcile recovers an already-confirmed Collector sale without ever calling getBuybackAvailable or buyback again', async () => {
  const cycleRepository = repository();
  const proceedsTokenAccount = deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58();
  const rpc = rpcClient({
    entries: [
      { tokenAccount: deriveAssociatedTokenAddress(OPERATOR, CARD_ASSET).toBase58(), owner: OPERATOR, mint: CARD_ASSET, preAmount: '1', postAmount: '0' },
      { tokenAccount: proceedsTokenAccount, owner: OPERATOR, mint: SETTLEMENT_ASSET, preAmount: '7', postAmount: '92' },
    ],
  });
  let availableCalls = 0;
  let buybackCalls = 0;
  const collectorCrypt = {
    async getBuybackCheck({ memo }) {
      assert.equal(memo, MEMO);
      return {
        exists: true, status: 'complete', buybackAmount: '85',
        playerWallet: OPERATOR, nft: CARD_ASSET, transactionSignature: BUYBACK_SIGNATURE, createdAt: '2026-01-01T00:00:00.000Z',
      };
    },
    async getBuybackAvailable() { availableCalls += 1; return { available: true, amount: { ...settlementAsset(), amountAtomic: '85' } }; },
    async buyback() { buybackCalls += 1; throw new Error('must not resell an already-confirmed card'); },
  };
  const handler = createSupplementaryBuybackHandler({
    adapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: { solana: { role: 'operator-solana', sign: async () => { throw new Error('must not sign'); } } },
  });
  const result = await handler.reconcile({ config: config(), cycleRepository, position: heldPosition(), settlement: settlementFixture() });
  assert.equal(availableCalls, 0);
  assert.equal(buybackCalls, 0);
  assert.equal(cycleRepository.advances.length, 1);
  const [advance] = cycleRepository.advances;
  assert.equal(advance.positionId, POSITION_ID);
  assert.equal(advance.expectedState, 'PREPARED');
  assert.equal(advance.nextState, 'BUYBACK_SENT_UNKNOWN');
  assert.equal(advance.evidence.decision, 'sold');
  assert.equal(advance.evidence.memo, MEMO);
  assert.equal(advance.evidence.mint, CARD_ASSET);
  assert.equal(advance.evidence.signature, BUYBACK_SIGNATURE);
  assert.deepEqual(advance.evidence.proceeds, { ...settlementAsset(), amountAtomic: '85' });
  assert.equal(result.state, 'BUYBACK_SENT_UNKNOWN');
});

test('reconcileSupplementaryBuybackSale stays PENDING, read-only, while Collector has no record yet', async () => {
  const cycleRepository = repository();
  const collectorCrypt = { async getBuybackCheck() { return { exists: false }; } };
  const result = await reconcileSupplementaryBuybackSale({
    adapters: { collectorCrypt, solana: { client: rpcClient() } },
    config: config(),
    cycleRepository,
    position: heldPosition(),
  });
  assert.deepEqual(result, { status: 'PENDING' });
});

test('reconcileSupplementaryBuybackSale reports DATA_UNVERIFIED, never invents a sale, for a check that does not bind the wallet', async () => {
  const cycleRepository = repository();
  const collectorCrypt = {
    async getBuybackCheck() {
      return {
        exists: true, status: 'complete', buybackAmount: '85',
        playerWallet: 'someone-else', nft: CARD_ASSET, transactionSignature: BUYBACK_SIGNATURE, createdAt: '2026-01-01T00:00:00.000Z',
      };
    },
  };
  const result = await reconcileSupplementaryBuybackSale({
    adapters: { collectorCrypt, solana: { client: rpcClient() } },
    config: config(),
    cycleRepository,
    position: heldPosition(),
  });
  assert.equal(result.status, 'DATA_UNVERIFIED');
});

// --- the ambiguous boundary: sign + broadcast --------------------------------------------------

test('reconcile advances to BUYBACK_SENT_UNKNOWN with a submitted signature after a real sign and broadcast', async () => {
  const cycleRepository = repository();
  const transaction = resaleTransaction({ amount: 85n });
  const policy = await decodedPolicyFor(transaction);
  const proceedsSource = deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58();
  const rpc = rpcClient({ entries: [{ tokenAccount: proceedsSource, owner: OPERATOR, mint: SETTLEMENT_ASSET, preAmount: '100', postAmount: '15' }] });
  let submitCalls = 0;
  const collectorCrypt = {
    async getBuybackCheck() { return { exists: false }; },
    async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: '85' } }; },
    async buyback() { return { memo: MEMO, refundAmount: { ...settlementAsset(), amountAtomic: '85' }, serializedTransaction: transaction }; },
    async submitTransaction({ signedTransaction }) {
      submitCalls += 1;
      assert.equal(typeof signedTransaction, 'string');
      return { success: true, signature: signedSolanaTransactionSignature(signedTransaction), confirmationStatus: 'finalized' };
    },
  };
  const handler = createSupplementaryBuybackHandler({
    adapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: { solana: { role: 'operator-solana', async sign(request) { return signTransaction(request); } } },
  });
  const testConfig = config({ collectorCrypt: { ...config().collectorCrypt, buyback: { ...config().collectorCrypt.buyback, policy } } });
  const result = await handler.reconcile({ config: testConfig, cycleRepository, position: heldPosition(), settlement: settlementFixture() });

  assert.equal(submitCalls, 1);
  assert.equal(cycleRepository.advances.length, 1);
  const [advance] = cycleRepository.advances;
  assert.equal(advance.expectedState, 'PREPARED');
  assert.equal(advance.nextState, 'BUYBACK_SENT_UNKNOWN');
  assert.equal(advance.evidence.decision, 'submitted');
  assert.equal(advance.evidence.memo, MEMO);
  assert.equal(advance.evidence.mint, CARD_ASSET);
  assert.equal(typeof advance.evidence.signature, 'string');
  assert.equal(advance.evidence.signature.length > 0, true);
  assert.deepEqual(advance.evidence.offer, { ...settlementAsset(), amountAtomic: '85' });
  assert.equal(result.state, 'BUYBACK_SENT_UNKNOWN');
});

test('reconcile marks the sale unknown (never held) when the provider mutation is ambiguous, and never calls buyback twice', async () => {
  const cycleRepository = repository();
  let buybackCalls = 0;
  const collectorCrypt = {
    async getBuybackCheck() { return { exists: false }; },
    async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: '85' } }; },
    async buyback() { buybackCalls += 1; throw new Error('provider connection reset'); },
  };
  const handler = createSupplementaryBuybackHandler({
    adapters: { collectorCrypt, solana: { client: rpcClient() } },
    signerClient: { solana: { role: 'operator-solana', sign: async () => { throw new Error('must not sign'); } } },
  });
  const result = await handler.reconcile({ config: config(), cycleRepository, position: heldPosition(), settlement: settlementFixture() });

  assert.equal(buybackCalls, 1);
  assert.equal(cycleRepository.advances.length, 1);
  const [advance] = cycleRepository.advances;
  assert.equal(advance.evidence.decision, 'unknown');
  assert.equal(advance.evidence.memo, MEMO);
  assert.equal(advance.evidence.reason, 'provider connection reset');
  assert.equal(result.state, 'BUYBACK_SENT_UNKNOWN');
});

test('reconcile marks the sale data_unverified when the provider response does not bind the held card memo', async () => {
  const cycleRepository = repository();
  const collectorCrypt = {
    async getBuybackCheck() { return { exists: false }; },
    async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: '85' } }; },
    async buyback() { return { memo: 'a-different-memo', refundAmount: { ...settlementAsset(), amountAtomic: '85' }, serializedTransaction: 'unused' }; },
  };
  const handler = createSupplementaryBuybackHandler({
    adapters: { collectorCrypt, solana: { client: rpcClient() } },
    signerClient: { solana: { role: 'operator-solana', sign: async () => { throw new Error('must not sign'); } } },
  });
  const result = await handler.reconcile({ config: config(), cycleRepository, position: heldPosition(), settlement: settlementFixture() });

  assert.equal(cycleRepository.advances.length, 1);
  assert.equal(cycleRepository.advances[0].evidence.decision, 'data_unverified');
  assert.equal(result.state, 'BUYBACK_SENT_UNKNOWN');
});
