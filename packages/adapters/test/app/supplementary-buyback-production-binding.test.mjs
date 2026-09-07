// Focused stage-level coverage for the missing connection the launch review flagged
// (held-positive-runtime-path-audit.md): a later held sale must be able to reuse the same
// Collector production purchase/buyback binding loader ordinary buyback.mjs uses, not the legacy
// static policy only. These tests exercise `createSupplementaryBuybackHandler` end to end against
// a real, schema/digest-validated production binding registry and the real offline execution
// boundary (`assertCollectorOfflineExecutionBoundary`), using only synthetic local fixtures --
// never network, credentials, or live signing/broadcast.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import bs58 from 'bs58';
import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';

import {
  CIRCLE_USD_DECIMALS,
  CIRCLE_USD_MINT,
  MPL_CORE_PROGRAM_ID,
  SOLANA_RELAY_CHAIN_ID,
  TOKEN_PROGRAM_ID,
  buildTransferCheckedInstruction,
  createSolanaRpcClient,
  deriveAssociatedTokenAddress,
  signedSolanaTransactionSignature,
} from '../../src/solana-rpc.mjs';
import { createSupplementaryBuybackHandler } from '../../src/app/stages/supplementary-buyback.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { digest } from '../../../runner/src/cycle/journal.mjs';
import {
  COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE,
  COLLECTOR_PRODUCTION_BINDING_ENTRY_SCHEMA,
  COLLECTOR_PRODUCTION_BINDING_REGISTRY_SCHEMA,
  createIsolatedKeychainChildSetup,
  loadCollectorProductionBindingRegistry,
} from '../../src/signing/collector-production-binding.mjs';
import { COLLECTOR_BUYBACK_BINDING_SCHEMA } from '../../src/signing/collector-buyback-policy.mjs';

const CYCLE_ID = 'cycle-supplementary-buyback-production';
const CHAIN_ID = 'solana-mainnet';
const OPERATOR_KEYPAIR = Keypair.fromSeed(Uint8Array.from(Array(32).fill(7)));
const OPERATOR = OPERATOR_KEYPAIR.publicKey.toBase58();
const AUTHORITY_KEYPAIR = Keypair.fromSeed(Uint8Array.from(Array(32).fill(9)));
const BUYER_KEYPAIR = Keypair.fromSeed(Uint8Array.from(Array(32).fill(11)));
const CARD_ASSET = Keypair.fromSeed(Uint8Array.from(Array(32).fill(13))).publicKey.toBase58();
const PROCEEDS_SOURCE = Keypair.fromSeed(Uint8Array.from(Array(32).fill(15))).publicKey.toBase58();
const COLLECTOR_RECIPIENT = Keypair.fromSeed(Uint8Array.from(Array(32).fill(17))).publicKey.toBase58();
const COLLECTOR_PROGRAM_ID = Keypair.fromSeed(Uint8Array.from(Array(32).fill(19))).publicKey.toBase58();
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const SETTLEMENT_ASSET = CIRCLE_USD_MINT;
const DISCRIMINATOR_HEX = 'a1b2c3d4e5f60718';
const MEMO = 'memo-supplementary-buyback-production';
const OFFER_ATOMIC = '85';
const POSITION_ID = `held:${'d'.repeat(64)}`;
const POSITION_EVIDENCE_DIGEST = `sha256:${'e'.repeat(64)}`;
const FENCING_TOKEN = '22222222-2222-4222-8222-222222222222';
const PRODUCTION_BLOCKHASH = Keypair.fromSeed(Uint8Array.from(Array(32).fill(21))).publicKey.toBase58();
const LAST_VALID_BLOCK_HEIGHT = 1000;
const CURRENT_BLOCK_HEIGHT = 99;
const PROCEEDS_DESTINATION = deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58();
const TEST_AUTHORITY = createTestProfileMutationAuthority();

// A real isolated Keychain child setup (`collector-production-binding.mjs`'s own real, non-fake
// isolated fixture), built once for every test in this file that must satisfy the full offline
// execution boundary -- `resolveCollectorProductionBinding` refuses to resolve any registry entry
// without one, and refuses a hand-built lookalike object (WeakSet membership, not a value/shape
// match). It talks only to the isolated synthetic-mode fake Keychain backend the setup itself wires
// up (`HOOKEMON_TEST_KEYCHAIN_MODE: 'success'`); it never touches a real macOS Keychain, secret,
// network, or credential. Independent of, and never used by, this file's own injected fake
// `signerClient.solana.sign` -- that stays exactly the local in-memory operator/authority keypair
// signing already used throughout these tests, and never runs through this wrapper.
let productionBindingSyntheticRoot;
let productionBindingIsolatedSetup;
before(async () => {
  productionBindingSyntheticRoot = await mkdtemp(join(tmpdir(), 'hookemon-supplementary-buyback-binding-'));
  productionBindingIsolatedSetup = await createIsolatedKeychainChildSetup({ directory: productionBindingSyntheticRoot });
});
after(async () => {
  await rm(productionBindingSyntheticRoot, { recursive: true, force: true });
});

function settlementAsset() {
  return { chainId: CHAIN_ID, assetId: SETTLEMENT_ASSET, decimals: CIRCLE_USD_DECIMALS };
}

function buybackBinding({ proceedsMint = SETTLEMENT_ASSET, proceedsDecimals = CIRCLE_USD_DECIMALS, discriminatorHex = DISCRIMINATOR_HEX } = {}) {
  return {
    schema: COLLECTOR_BUYBACK_BINDING_SCHEMA,
    version: 1,
    provider: 'collector-crypt',
    chainId: CHAIN_ID,
    format: 'legacy',
    addressLookupTables: [],
    proceeds: { source: PROCEEDS_SOURCE, mint: proceedsMint, decimals: proceedsDecimals },
    collectorAuthority: AUTHORITY_KEYPAIR.publicKey.toBase58(),
    collectorRecipient: COLLECTOR_RECIPIENT,
    instructions: [
      {
        kind: 'compute-budget-set-unit-limit', programId: COMPUTE_BUDGET_PROGRAM_ID, accounts: [],
        computeUnitLimit: 40000, priorityFeeCapAtomic: null, discriminatorHex: null,
      },
      {
        kind: 'compute-budget-set-unit-price', programId: COMPUTE_BUDGET_PROGRAM_ID, accounts: [],
        computeUnitLimit: null, priorityFeeCapAtomic: '5000', discriminatorHex: null,
      },
      {
        kind: 'unknown',
        programId: COLLECTOR_PROGRAM_ID,
        accounts: [
          { role: 'operator-fee-payer', isSigner: true, isWritable: true },
          { role: 'collector-authority', isSigner: true, isWritable: false },
          { role: 'opened-asset-mint', isSigner: false, isWritable: true },
          { role: 'collector-recipient', isSigner: false, isWritable: true },
        ],
        computeUnitLimit: null,
        priorityFeeCapAtomic: null,
        discriminatorHex,
      },
      {
        kind: 'spl-transfer-checked',
        programId: TOKEN_PROGRAM_ID,
        accounts: [
          { role: 'proceeds-source', isSigner: false, isWritable: true },
          { role: 'proceeds-mint', isSigner: false, isWritable: false },
          { role: 'proceeds-destination', isSigner: false, isWritable: true },
          { role: 'collector-authority', isSigner: true, isWritable: false },
        ],
        computeUnitLimit: null,
        priorityFeeCapAtomic: null,
        discriminatorHex: null,
      },
    ],
  };
}

function registryEntry(binding) {
  return {
    schema: COLLECTOR_PRODUCTION_BINDING_ENTRY_SCHEMA,
    version: 1,
    authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE,
    stage: 'buyback',
    chainId: CHAIN_ID,
    provider: 'collector-crypt',
    binding,
    expectedDigest: digest(binding),
  };
}

function registry(binding = buybackBinding()) {
  return {
    schema: COLLECTOR_PRODUCTION_BINDING_REGISTRY_SCHEMA,
    version: 1,
    entries: [registryEntry(binding)],
  };
}

/**
 * MoneyConfigurationV1's Solana stablecoin identity is necessarily typed in Relay's own chain
 * namespace (`792703809`) whenever `execution.profile === 'production'` -- never
 * `solana-mainnet`, which is reserved for the native Collector/signing identity
 * (`assertSolanaSignerMoneyConfiguration`, docs/modules/composition-root.md:99-106). Both name the
 * same mint and decimals.
 */
function collectorMoneyConfiguration() {
  const usdg = { chainId: '4663', assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 };
  return {
    schema: 'hookemon.money-configuration.v1',
    assets: { usdg, solanaStablecoin: { ...settlementAsset(), chainId: String(SOLANA_RELAY_CHAIN_ID) } },
    minimums: {
      robinhoodReceive: { ...usdg, amountAtomic: '0' },
      solanaReceive: { ...settlementAsset(), chainId: String(SOLANA_RELAY_CHAIN_ID), amountAtomic: '0' },
      returnUsdg: { ...usdg, amountAtomic: '0' },
    },
    evm: {
      perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '2' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '2' },
    },
    solana: {
      priorityFeeCap: { chainId: String(SOLANA_RELAY_CHAIN_ID), assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '10000' },
      lamportReserve: { chainId: String(SOLANA_RELAY_CHAIN_ID), assetId: 'native', decimals: 9, amountAtomic: '2' },
    },
  };
}

/** A real production-profile config that passes `assertCollectorOfflineExecutionBoundary` exactly:
 *  every actually-transport-read endpoint pinned to loopback, and the real, authenticated isolated
 *  Keychain child setup (`productionBindingIsolatedSetup`, built once in `before()` above) as
 *  `config.signer.keychain.isolatedChildSetup`, with `command` set to that exact setup's own
 *  `command` -- never a caller-chosen path or a hand-built lookalike object. Never a rehearsal
 *  configuration -- the production binding path and the collector-only rehearsal path are mutually
 *  exclusive by design (`assertCollectorOfflineExecutionBoundary` refuses any `rehearsal` key at
 *  all), so this config never sets one. */
function productionConfig({ bindingRegistry = registry(), overrides = {} } = {}) {
  return {
    execution: { profile: 'production', providerMode: 'live' },
    accounts: { evm: null, solana: OPERATOR },
    signer: {
      backend: 'keychain',
      liveMode: true,
      keychain: {
        command: productionBindingIsolatedSetup.command,
        isolatedChildSetup: productionBindingIsolatedSetup,
      },
    },
    pack: { code: 'pokemon_50' },
    solana: {
      chainId: CHAIN_ID,
      rpcUrl: 'https://127.0.0.1:4103',
      blockhashContextResolver: async blockhash => ({ blockhash, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT }),
    },
    collectorCrypt: {
      settlementAsset: settlementAsset(),
      baseUrl: 'https://127.0.0.1:4105',
      productionBindingRegistry: loadCollectorProductionBindingRegistry(bindingRegistry),
      productionBindingAuthority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE,
    },
    robinhood: { rpcUrl: 'https://127.0.0.1:4101', archiveRpcUrl: 'https://127.0.0.1:4102' },
    relay: { baseUrl: 'https://127.0.0.1:4104' },
    moneyConfiguration: collectorMoneyConfiguration(),
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

// NUL-joined (not a space) to mirror the real repository's own Map key exactly, matching
// `readSupplementaryChainAttemptRecoveryContext`'s own NUL-terminated prefix search below.
function chainAttemptKey(stage, requestDigest) {
  return `${stage}\0${requestDigest}`;
}

/** Mirrors the existing `supplementary-buyback.test.mjs` fixture exactly, except the default open
 *  evidence declares `assetKind: 'mpl-core'` -- the production binding path refuses any other kind
 *  (see the "wrong memo/mint" tests below for the mismatched-identity cases). */
function fakeChainAttemptRepository({ openPacks = [{ packIndex: 0, memo: MEMO, decision: 'opened', mint: CARD_ASSET, assetKind: 'mpl-core' }] } = {}) {
  const attempts = new Map();
  const recoveryContexts = new Map();
  const advances = [];
  const calls = [];
  const repository = {
    advances,
    calls,
    attempts,
    async readStage(_cycleId, stage) {
      return stage === 'open' ? { status: 'COMPLETE', evidence: { packs: openPacks } } : { status: 'PENDING' };
    },
    async advanceSupplementarySettlement(positionId, input) {
      calls.push('advanceSupplementarySettlement');
      advances.push({ positionId, ...input });
      return { positionId, cycleId: CYCLE_ID, manifestId: `${CYCLE_ID}:supplementary:1`, state: input.nextState };
    },
    async readChainTransactionAttempt(_cycleId, stage, requestDigest) {
      const found = attempts.get(chainAttemptKey(stage, requestDigest));
      return found ? structuredClone(found) : null;
    },
    async prepareChainTransactionAttempt(_cycleId, stage, attemptValue) {
      calls.push('prepareChainTransactionAttempt');
      const key = chainAttemptKey(stage, attemptValue.requestDigest);
      if (attempts.has(key)) return structuredClone(attempts.get(key));
      const record = { attempt: attemptValue, broadcastEvidence: null, finalityEvidence: null };
      attempts.set(key, record);
      return structuredClone(record);
    },
    async recordSignedTransactionWithRecoveryContext(_cycleId, stage, requestDigest, signingMaterial, contextValue) {
      calls.push('recordSignedTransactionWithRecoveryContext');
      const key = chainAttemptKey(stage, requestDigest);
      const current = attempts.get(key);
      if (!current) throw new Error('no prepared chain attempt');
      const attempt = { ...current.attempt, ...signingMaterial, state: 'SIGNED' };
      const record = { ...current, attempt };
      attempts.set(key, record);
      recoveryContexts.set(`${key}\0${signingMaterial.hash}`, contextValue);
      return structuredClone(record);
    },
    async readChainAttemptRecoveryContext(_cycleId, { stage, requestDigest, rawSignedBytesHash }) {
      calls.push('readChainAttemptRecoveryContext');
      const found = recoveryContexts.get(`${chainAttemptKey(stage, requestDigest)}\0${rawSignedBytesHash}`);
      return found ? structuredClone(found) : null;
    },
    async recordBroadcast(_cycleId, stage, requestDigest, evidence) {
      calls.push('recordBroadcast');
      const key = chainAttemptKey(stage, requestDigest);
      const current = attempts.get(key);
      if (!current) throw new Error('no signed chain attempt');
      const attempt = { ...current.attempt, state: 'BROADCAST' };
      const record = { ...current, attempt, broadcastEvidence: evidence };
      attempts.set(key, record);
      return structuredClone(record);
    },
  };
  repository.readSupplementaryChainTransactionAttempt = (_positionId, requestDigest) => repository.readChainTransactionAttempt(CYCLE_ID, 'buyback', requestDigest);
  repository.prepareSupplementaryChainTransactionAttempt = async (_positionId, attempt) => repository.prepareChainTransactionAttempt(CYCLE_ID, 'buyback', attempt);
  repository.recordSupplementarySignedTransactionWithRecoveryContext = async (_positionId, requestDigest, signingMaterial, value) => {
    assert.equal(value.requestDigest, requestDigest);
    assert.equal(value.rawSignedBytesHash, signingMaterial.hash);
    return repository.recordSignedTransactionWithRecoveryContext(CYCLE_ID, 'buyback', requestDigest, signingMaterial, value);
  };
  repository.readSupplementaryChainAttemptRecoveryContext = async (_positionId, requestDigest) => {
    const prefix = `${chainAttemptKey('buyback', requestDigest)}\0`;
    const entry = [...recoveryContexts.entries()].find(([key]) => key.startsWith(prefix));
    return entry ? structuredClone(entry[1]) : null;
  };
  repository.recordSupplementaryBroadcast = (_positionId, requestDigest, evidence) => repository.recordBroadcast(CYCLE_ID, 'buyback', requestDigest, evidence);
  return repository;
}

function reconcileInput({ adapters, signerClient, config, cycleRepository, position, settlement, fencingToken = FENCING_TOKEN, preflightAuthority = TEST_AUTHORITY }) {
  return {
    adapters,
    signerClient,
    config,
    cycleRepository,
    context: { cycleId: CYCLE_ID, stage: 'supplementary-buyback', positionId: position.positionId, manifestId: settlement.manifestId, settlementState: settlement.state, fencingToken },
    position,
    settlement,
    preflightAuthority,
  };
}

function settleInstructionData(discriminatorHex, minimumAtomic, refundAtomic) {
  const buffer = Buffer.alloc(24);
  Buffer.from(discriminatorHex, 'hex').copy(buffer, 0);
  buffer.writeBigUInt64LE(BigInt(minimumAtomic), 8);
  buffer.writeBigUInt64LE(BigInt(refundAtomic), 16);
  return buffer;
}

/** Builds the exact fixed instruction sequence `buybackBinding()` declares, pre-signed only by the
 *  Collector co-signer (`authorityKey`) -- exactly the shape the real provider would return before
 *  the operator ever signs, matching `collector-buyback-policy.test.mjs`'s own already-passing
 *  candidate construction. The operator's own fee-payer signature slot stays zero until this
 *  module's own `sign()` step fills it. */
function resaleTransaction({
  offerAtomic = OFFER_ATOMIC, feePayer = OPERATOR_KEYPAIR, authorityKey = AUTHORITY_KEYPAIR,
  discriminatorHex = DISCRIMINATOR_HEX, blockhash = PRODUCTION_BLOCKHASH,
  minimumAtomic = offerAtomic, refundAtomic = offerAtomic, cardAsset = CARD_ASSET,
} = {}) {
  const limitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 40000 });
  const priceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 5000n });
  const settleIx = new TransactionInstruction({
    programId: new PublicKey(COLLECTOR_PROGRAM_ID),
    keys: [
      { pubkey: feePayer.publicKey, isSigner: true, isWritable: true },
      { pubkey: authorityKey.publicKey, isSigner: true, isWritable: false },
      { pubkey: new PublicKey(cardAsset), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(COLLECTOR_RECIPIENT), isSigner: false, isWritable: true },
    ],
    data: settleInstructionData(discriminatorHex, minimumAtomic, refundAtomic),
  });
  const transferIx = buildTransferCheckedInstruction({
    source: PROCEEDS_SOURCE,
    destination: PROCEEDS_DESTINATION,
    owner: authorityKey.publicKey.toBase58(),
    mint: SETTLEMENT_ASSET,
    amount: BigInt(offerAtomic),
    decimals: CIRCLE_USD_DECIMALS,
  });
  const transaction = new Transaction({ feePayer: feePayer.publicKey, recentBlockhash: blockhash });
  transaction.add(limitIx, priceIx, settleIx, transferIx);
  transaction.partialSign(authorityKey);
  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

function signTransaction(transactionBase64) {
  const transaction = Transaction.from(Buffer.from(transactionBase64, 'base64'));
  transaction.partialSign(OPERATOR_KEYPAIR);
  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
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

function mplCoreAccountInfo(ownerBase58) {
  const bytes = Buffer.concat([Buffer.from([1]), new PublicKey(ownerBase58).toBytes()]);
  return { value: { owner: MPL_CORE_PROGRAM_ID, data: [bytes.toString('base64'), 'base64'] } };
}

function transferV1InstructionJsonParsed(assetAddress) {
  return { programId: MPL_CORE_PROGRAM_ID, accounts: [assetAddress], data: bs58.encode(Buffer.from([14])) };
}

function transactionResponse({ entries, mplCoreTransferAsset = null }) {
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
    transaction: {
      message: {
        accountKeys,
        instructions: mplCoreTransferAsset === null ? [] : [transferV1InstructionJsonParsed(mplCoreTransferAsset)],
      },
    },
    meta: { preTokenBalances, postTokenBalances, innerInstructions: [] },
  };
}

/**
 * `state.sold` flips from `false` to `true` exactly when the fixture wants the on-chain owner to
 * appear changed (the "ownership change before sign" test flips it inside the mocked provider's
 * `buyback()` call, simulating a transfer landing during that real await; the happy-path test flips
 * it only after a successful `submitTransaction`, simulating the real on-chain effect of the sale).
 * `readMplCoreAssetOwner` and `getTransactionMplCoreTransfers` both read this same flag, so the
 * finality check the stage runs after broadcast sees a genuinely left-operator asset.
 */
function rpcClient({ state = { sold: false }, tokenAccount = tokenAccountResponse(), signatureFinalized = true } = {}) {
  return { client: createSolanaRpcClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'getAccountInfo') {
        const [, opts] = body.params;
        if (opts?.encoding === 'base64') return jsonRpc(mplCoreAccountInfo(state.sold ? BUYER_KEYPAIR.publicKey.toBase58() : OPERATOR), body.id);
        return jsonRpc(tokenAccount, body.id);
      }
      if (body.method === 'getBalance') return jsonRpc({ value: 1_000_000 }, body.id);
      if (body.method === 'isBlockhashValid') return jsonRpc({ value: true }, body.id);
      if (body.method === 'getBlockHeight') return jsonRpc(CURRENT_BLOCK_HEIGHT, body.id);
      if (body.method === 'getLatestBlockhash') {
        return jsonRpc({ value: { blockhash: PRODUCTION_BLOCKHASH, lastValidBlockHeight: LAST_VALID_BLOCK_HEIGHT } }, body.id);
      }
      if (body.method === 'getSignatureStatuses') {
        return jsonRpc({ value: [signatureFinalized ? { err: null, confirmationStatus: 'finalized', slot: 100 } : null] }, body.id);
      }
      if (body.method === 'getTransaction') {
        const entries = [{ tokenAccount: PROCEEDS_DESTINATION, owner: OPERATOR, mint: SETTLEMENT_ASSET, preAmount: '7', postAmount: '92' }];
        return jsonRpc(transactionResponse({ entries, mplCoreTransferAsset: state.sold ? CARD_ASSET : null }), body.id);
      }
      throw new Error(`unexpected RPC method ${body.method}`);
    },
  }), state };
}

// --- positive: a later held sale reaches BUYBACK_SENT_UNKNOWN through the production binding ----

test('reconcile signs, broadcasts, and confirms a held resale through the production binding, then advances to BUYBACK_SENT_UNKNOWN', async () => {
  const cycleRepository = fakeChainAttemptRepository();
  const config = productionConfig();
  const { client: rpc, state } = rpcClient();
  let submittedSignature = null;
  let buybackChecks = 0;
  const collectorCrypt = {
    async getBuybackCheck() {
      buybackChecks += 1;
      if (buybackChecks === 1) return { exists: false };
      return {
        exists: true, status: 'complete', buybackAmount: OFFER_ATOMIC, playerWallet: OPERATOR,
        nft: CARD_ASSET, transactionSignature: submittedSignature, createdAt: '2026-01-01T00:00:00.000Z',
      };
    },
    async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: OFFER_ATOMIC } }; },
    async buyback() { return { memo: MEMO, refundAmount: { ...settlementAsset(), amountAtomic: OFFER_ATOMIC }, serializedTransaction: resaleTransaction() }; },
    async submitTransaction({ signedTransaction }) {
      submittedSignature = signedSolanaTransactionSignature(signedTransaction);
      state.sold = true; // the sale is now finalized on chain; the held card has left the operator.
      return { success: true, signature: submittedSignature, confirmationStatus: 'finalized' };
    },
  };
  const handler = createSupplementaryBuybackHandler();
  const result = await handler.reconcile(reconcileInput({
    adapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: { solana: { role: 'operator-solana', async sign(request) { return signTransaction(request); } } },
    config,
    cycleRepository,
    position: heldPosition(),
    settlement: settlementFixture(),
  }));

  assert.equal(cycleRepository.advances.length, 1);
  const [advance] = cycleRepository.advances;
  assert.equal(advance.expectedState, 'PREPARED');
  assert.equal(advance.nextState, 'BUYBACK_SENT_UNKNOWN');
  assert.equal(advance.evidence.memo, MEMO);
  assert.deepEqual(advance.evidence.proceeds, { ...settlementAsset(), amountAtomic: OFFER_ATOMIC });
  assert.equal(result.state, 'BUYBACK_SENT_UNKNOWN');
});

// --- refusals, all before any provider mutation -------------------------------------------------

test('reconcile refuses before any provider call when the operator does not currently hold the finalized on-chain asset', async () => {
  const cycleRepository = fakeChainAttemptRepository();
  const config = productionConfig();
  // A pre-sold state: the RPC fixture already reports the asset owned by someone else, before the
  // stage ever calls the provider.
  const { client: rpc } = rpcClient({ state: { sold: true } });
  const collectorCrypt = {
    async getBuybackCheck() { return { exists: false }; },
    async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: OFFER_ATOMIC } }; },
    async buyback() { throw new Error('must not be called: ownership refuses before any provider mutation'); },
  };
  const handler = createSupplementaryBuybackHandler();
  const result = await handler.reconcile(reconcileInput({
    adapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: { solana: { role: 'operator-solana', sign: async () => { throw new Error('must not sign'); } } },
    config,
    cycleRepository,
    position: heldPosition(),
    settlement: settlementFixture(),
  }));
  assert.equal(result, undefined);
  assert.equal(cycleRepository.advances.length, 0);
  assert.equal(cycleRepository.attempts.size, 0);
});

test('reconcile refuses a held position whose mint does not match the finalized original open evidence', async () => {
  const cycleRepository = fakeChainAttemptRepository({
    openPacks: [{ packIndex: 0, memo: MEMO, decision: 'opened', mint: Keypair.generate().publicKey.toBase58(), assetKind: 'mpl-core' }],
  });
  const config = productionConfig();
  const { client: rpc } = rpcClient();
  const collectorCrypt = {
    async getBuybackCheck() { return { exists: false }; },
    async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: OFFER_ATOMIC } }; },
    async buyback() { throw new Error('must not be called: identity mismatch refuses before any provider mutation'); },
  };
  const handler = createSupplementaryBuybackHandler();
  const result = await handler.reconcile(reconcileInput({
    adapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: { solana: { role: 'operator-solana', sign: async () => { throw new Error('must not sign'); } } },
    config,
    cycleRepository,
    position: heldPosition(),
    settlement: settlementFixture(),
  }));
  assert.equal(result, undefined);
  assert.equal(cycleRepository.advances.length, 0);
  assert.equal(cycleRepository.attempts.size, 0);
});

test('reconcile refuses a held position with no finalized original open stage at all', async () => {
  const cycleRepository = fakeChainAttemptRepository();
  cycleRepository.readStage = async (_cycleId, _stage) => ({ status: 'PENDING' });
  const config = productionConfig();
  const { client: rpc } = rpcClient();
  const collectorCrypt = {
    async getBuybackCheck() { return { exists: false }; },
    async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: OFFER_ATOMIC } }; },
    async buyback() { throw new Error('must not be called: absent finalized open refuses before any provider mutation'); },
  };
  const handler = createSupplementaryBuybackHandler();
  const result = await handler.reconcile(reconcileInput({
    adapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: { solana: { role: 'operator-solana', sign: async () => { throw new Error('must not sign'); } } },
    config,
    cycleRepository,
    position: heldPosition(),
    settlement: settlementFixture(),
  }));
  assert.equal(result, undefined);
  assert.equal(cycleRepository.advances.length, 0);
});

test('reconcile refuses a production binding whose proceeds asset does not match the configured settlement asset', async () => {
  const cycleRepository = fakeChainAttemptRepository();
  const mismatchedBinding = buybackBinding({ proceedsMint: Keypair.generate().publicKey.toBase58() });
  const config = productionConfig({ bindingRegistry: registry(mismatchedBinding) });
  const { client: rpc } = rpcClient();
  const collectorCrypt = {
    async getBuybackCheck() { return { exists: false }; },
    async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: OFFER_ATOMIC } }; },
    async buyback() { throw new Error('must not be called: mismatched settlement asset refuses before any provider mutation'); },
  };
  const handler = createSupplementaryBuybackHandler();
  const result = await handler.reconcile(reconcileInput({
    adapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: { solana: { role: 'operator-solana', sign: async () => { throw new Error('must not sign'); } } },
    config,
    cycleRepository,
    position: heldPosition(),
    settlement: settlementFixture(),
  }));
  assert.equal(result, undefined);
  assert.equal(cycleRepository.advances.length, 0);
});

// --- ownership change during the ambiguous provider round-trip ----------------------------------

test('reconcile refuses to sign when the on-chain owner changes after the provider call returns, and never re-signs afterward', async () => {
  const cycleRepository = fakeChainAttemptRepository();
  const config = productionConfig();
  const { client: rpc, state } = rpcClient();
  let signCalls = 0;
  const collectorCrypt = {
    async getBuybackCheck() { return { exists: false }; },
    async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: OFFER_ATOMIC } }; },
    async buyback() {
      // Simulates a transfer landing during this real await, discovered by the second on-chain
      // ownership check `signAndRecordBuyback` runs immediately after this call returns.
      state.sold = true;
      return { memo: MEMO, refundAmount: { ...settlementAsset(), amountAtomic: OFFER_ATOMIC }, serializedTransaction: resaleTransaction() };
    },
  };
  const handler = createSupplementaryBuybackHandler();
  const result = await handler.reconcile(reconcileInput({
    adapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: { solana: { role: 'operator-solana', async sign(request) { signCalls += 1; return signTransaction(request); } } },
    config,
    cycleRepository,
    position: heldPosition(),
    settlement: settlementFixture(),
  }));
  assert.equal(result, undefined);
  assert.equal(signCalls, 0);
  assert.equal(cycleRepository.advances.length, 0);
  const [key] = cycleRepository.attempts.keys();
  assert.equal(cycleRepository.attempts.get(key).attempt.state, 'PREPARED');
});

// --- durable signed-byte replay is bound to the exact approved binding digest it was signed under

test('reconcile refuses to rebroadcast durably-signed bytes when the production binding no longer matches the one this attempt was signed under', async () => {
  const cycleRepository = fakeChainAttemptRepository();
  const config = productionConfig();
  const { client: rpc } = rpcClient();
  const collectorCrypt = {
    async getBuybackCheck() { return { exists: false }; },
    async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: OFFER_ATOMIC } }; },
    async buyback() { return { memo: MEMO, refundAmount: { ...settlementAsset(), amountAtomic: OFFER_ATOMIC }, serializedTransaction: resaleTransaction() }; },
    async submitTransaction() { throw new Error('simulated crash: process dies after signing, before a successful broadcast'); },
  };
  const handler = createSupplementaryBuybackHandler();
  let signCalls = 0;
  const firstAttempt = await handler.reconcile(reconcileInput({
    adapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: { solana: { role: 'operator-solana', async sign(request) { signCalls += 1; return signTransaction(request); } } },
    config,
    cycleRepository,
    position: heldPosition(),
    settlement: settlementFixture(),
  }));
  assert.equal(firstAttempt, undefined);
  assert.equal(signCalls, 1);
  const [key] = cycleRepository.attempts.keys();
  assert.equal(cycleRepository.attempts.get(key).attempt.state, 'SIGNED');

  // "Restart" against a config whose registry now resolves a *different* buyback binding (a
  // changed discriminator changes the binding's own content-addressed digest) -- the durable
  // signed bytes were approved under the original binding's digest and must never be reauthorized
  // under a different one, even though the raw signed bytes themselves are unchanged.
  const driftedConfig = productionConfig({ bindingRegistry: registry(buybackBinding({ discriminatorHex: 'ffeeddccbbaa9988' })) });
  const restartCollectorCrypt = {
    async getBuybackCheck() { return { exists: false }; },
    async buyback() { throw new Error('must not resend: signed bytes already exist durably'); },
    async submitTransaction() { throw new Error('must not broadcast: the recorded binding no longer resolves'); },
  };
  const secondAttempt = await handler.reconcile(reconcileInput({
    adapters: { collectorCrypt: restartCollectorCrypt, solana: { client: rpc } },
    signerClient: { solana: { role: 'operator-solana', async sign() { signCalls += 1; throw new Error('must not re-sign'); } } },
    config: driftedConfig,
    cycleRepository,
    position: heldPosition(),
    settlement: settlementFixture(),
  }));
  assert.equal(secondAttempt, undefined);
  assert.equal(signCalls, 1); // unchanged: no re-sign, and no broadcast
  assert.equal(cycleRepository.advances.length, 0);
  assert.equal(cycleRepository.attempts.get(key).attempt.state, 'SIGNED'); // still SIGNED, never advanced
});
