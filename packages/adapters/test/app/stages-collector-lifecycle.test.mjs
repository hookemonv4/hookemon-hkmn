import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { ComputeBudgetProgram, Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';

import {
  CIRCLE_USD_DECIMALS,
  CIRCLE_USD_MINT,
  MPL_CORE_PROGRAM_ID,
  SOLANA_RELAY_CHAIN_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  buildTransferCheckedInstruction,
  buildUnsignedTransaction,
  createSolanaRpcClient,
  deriveAssociatedTokenAddress,
} from '../../src/solana-rpc.mjs';
import { TRANSACTION_POLICY_SCHEMA, decodeProviderTransaction } from '../../src/signing/transaction-policy.mjs';
import { policyFor } from '../signing/policy-fixture.mjs';
import {
  mutatePurchase,
  preparePurchaseRequest,
  probePurchase,
  reconcileLivePurchase,
} from '../../src/app/stages/purchase.mjs';
import {
  mutateOpen,
  prepareOpenRequest,
  reconcileLiveOpen,
} from '../../src/app/stages/open.mjs';
import {
  mutateEpicGate,
  prepareEpicGateRequest,
  probeEpicGate,
  reconcileLiveEpicGate,
} from '../../src/app/stages/epic-gate.mjs';
import {
  buildCollectorBuybackRequest,
  mutateBuyback,
  prepareBuybackRequest,
  reconcileLiveBuyback,
} from '../../src/app/stages/buyback.mjs';
import { COLLECTOR_BUYBACK_BINDING_SCHEMA } from '../../src/signing/collector-buyback-policy.mjs';
import {
  COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE,
  COLLECTOR_PRODUCTION_BINDING_ENTRY_SCHEMA,
  COLLECTOR_PRODUCTION_BINDING_REGISTRY_SCHEMA,
  createIsolatedKeychainChildSetup,
  loadCollectorProductionBindingRegistry,
} from '../../src/signing/collector-production-binding.mjs';
import { digest } from '../../../runner/src/cycle/journal.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { LeaseLostError } from '../../../runner/src/automation/exclusive-lease.mjs';
import { MAXIMUM_PACK_BATCH_SIZE, createPreparedProviderMutationAttempt } from '../../../runner/src/cycle/money-schemas.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { createStageDriver } from '../../src/app/stage-driver.mjs';

const TEST_PROFILE_MUTATION_AUTHORITY = createTestProfileMutationAuthority();

const CYCLE_ID = 'cycle-collector-lifecycle';
const CHAIN_ID = 'solana-mainnet';
const OPERATOR = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const CARD_ASSET = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const SETTLEMENT_ASSET = CIRCLE_USD_MINT;
const COLLECTOR_RECIPIENT = '8SFqwqnq4whPhs8icwHA2hQg3hUoN1qrCLK1SBx3WKwe';
const MEMO = 'memo-collector-lifecycle';
// Not-all-digit placeholders: a real Solana signature is base58, and the durable journal treats
// an all-digit string as a decimal value with its own (shorter) length bound.
const PURCHASE_SIGNATURE = 'P5'.repeat(44);
const OPEN_SIGNATURE = 'O4'.repeat(44);
const BUYBACK_SIGNATURE = 'B3'.repeat(44);
const OPERATOR_KEYPAIR = Keypair.fromSeed(Uint8Array.from(Array(32).fill(1)));

function jsonRpc(result, id = 1) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id, result }) };
}

function tokenAccountResponse({ owner = OPERATOR, mint = SETTLEMENT_ASSET, amount = '100', decimals = CIRCLE_USD_DECIMALS } = {}) {
  return {
    value: {
      owner: TOKEN_PROGRAM_ID,
      data: {
        program: 'spl-token',
        parsed: { type: 'account', info: { owner, mint, tokenAmount: { amount, decimals } } },
      },
    },
  };
}

/** A minimal, correctly shaped Metaplex Core AssetV1 account (`readMplCoreAssetOwner`'s own
 * parsing: owner === MPL_CORE_PROGRAM_ID, first data byte the AssetV1 discriminator, next 32 bytes
 * the current owner's public key) so buyback's finalized-ownership check resolves against the
 * configured operator by default. */
function mplCoreAssetResponse({ owner = OPERATOR } = {}) {
  const bytes = Buffer.concat([Buffer.from([1]), Buffer.from(new PublicKey(owner).toBytes())]);
  return { value: { owner: MPL_CORE_PROGRAM_ID, data: [bytes.toString('base64'), 'base64'] } };
}

function transactionResponse(entries) {
  const accountKeys = entries.map(entry => ({ pubkey: entry.tokenAccount, signer: false, writable: true }));
  const preTokenBalances = entries.map((entry, accountIndex) => ({
    accountIndex,
    mint: entry.mint,
    owner: entry.owner,
    uiTokenAmount: { amount: entry.preAmount, decimals: entry.decimals ?? 0, uiAmountString: entry.preAmount },
  }));
  const postTokenBalances = entries.map((entry, accountIndex) => ({
    accountIndex,
    mint: entry.mint,
    owner: entry.owner,
    uiTokenAmount: { amount: entry.postAmount, decimals: entry.decimals ?? 0, uiAmountString: entry.postAmount },
  }));
  return {
    transaction: { message: { accountKeys, instructions: [] } },
    meta: { preTokenBalances, postTokenBalances, innerInstructions: [] },
  };
}

function rpcClient({
  tokenAccount = tokenAccountResponse(), entries = [], finalized = true, balance = 1_000_000,
  cardOwner = OPERATOR, cardAssetId = CARD_ASSET,
} = {}) {
  const cardAta = deriveAssociatedTokenAddress(OPERATOR, cardAssetId).toBase58();
  // `cardOwner` may be a plain value (the same owner every read) or a function (called fresh on
  // every ownership read, so a test can simulate the card's owner actually changing between the
  // pre-provider-call read and the beforeSign refresh).
  const currentCardOwner = () => (typeof cardOwner === 'function' ? cardOwner() : cardOwner);
  return createSolanaRpcClient({
    fetchImpl: async (_url, init) => {
      const body = JSON.parse(init.body);
      if (body.method === 'getAccountInfo') {
        const [address] = body.params;
        // Buyback's finalized-ownership check reads the opened card's own account (mpl-core) or
        // the operator's associated token account for it (spl) -- distinct addresses from the
        // settlement asset's own ATA that `tokenAccount` below already covers.
        if (address === cardAssetId) return jsonRpc(mplCoreAssetResponse({ owner: currentCardOwner() }), body.id);
        if (address === cardAta) {
          const owner = currentCardOwner();
          return jsonRpc(tokenAccountResponse({ owner: OPERATOR, mint: cardAssetId, amount: owner === OPERATOR ? '1' : '0', decimals: 0 }), body.id);
        }
        return jsonRpc(tokenAccount, body.id);
      }
      if (body.method === 'getBalance') return jsonRpc({ value: balance }, body.id);
      if (body.method === 'isBlockhashValid') return jsonRpc({ value: true }, body.id);
      if (body.method === 'getBlockHeight') return jsonRpc(99, body.id);
      // Only the production-binding buyback path reads a fresh blockhash (for the policy's own
      // deadline fact, independent of the candidate transaction's own already-decoded blockhash);
      // fixed to the same SYSTEM_PROGRAM_ID placeholder every candidate transaction in this file
      // already embeds as its own recentBlockhash, and the same lastValidBlockHeight ('100') every
      // config's own `blockhashContextResolver` above already fixes the decoded deadline bound to.
      if (body.method === 'getLatestBlockhash') return jsonRpc({ value: { blockhash: SYSTEM_PROGRAM_ID, lastValidBlockHeight: 100 } }, body.id);
      if (body.method === 'getSignatureStatuses') {
        return jsonRpc({ value: [{ err: null, confirmationStatus: finalized ? 'finalized' : 'confirmed' }] }, body.id);
      }
      if (body.method === 'getTransaction') return jsonRpc(transactionResponse(entries), body.id);
      throw new Error(`unexpected RPC method ${body.method}`);
    },
  });
}

function transactionFor({ mint = SETTLEMENT_ASSET, amount = 1n, destination = COLLECTOR_RECIPIENT } = {}) {
  const source = deriveAssociatedTokenAddress(OPERATOR, mint).toBase58();
  const instruction = buildTransferCheckedInstruction({
    source,
    destination,
    owner: OPERATOR,
    mint,
    amount,
    decimals: CIRCLE_USD_DECIMALS,
  });
  return buildUnsignedTransaction({ feePayer: OPERATOR, recentBlockhash: SYSTEM_PROGRAM_ID, instructions: [instruction] });
}

async function policyForTransaction(transaction) {
  const decoded = await decodeProviderTransaction({
    family: 'solana',
    chainId: CHAIN_ID,
    transaction,
    currentBlockHeight: '99',
    blockhashContextResolver: async blockhash => ({ blockhash, lastValidBlockHeight: '100' }),
  });
  return policyFor(decoded, TRANSACTION_POLICY_SCHEMA);
}

function signTransaction(transactionBase64) {
  const transaction = Transaction.from(Buffer.from(transactionBase64, 'base64'));
  transaction.partialSign(OPERATOR_KEYPAIR);
  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

function settlementAsset(assetId = SETTLEMENT_ASSET) {
  return { chainId: CHAIN_ID, assetId, decimals: CIRCLE_USD_DECIMALS };
}

function collectorMoneyConfiguration() {
  const usdg = { chainId: '4663', assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 };
  const solanaStablecoin = settlementAsset();
  return {
    schema: 'hookemon.money-configuration.v1',
    assets: { usdg, solanaStablecoin },
    minimums: {
      robinhoodReceive: { ...usdg, amountAtomic: '0' },
      solanaReceive: { ...solanaStablecoin, amountAtomic: '0' },
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

// A real isolated Keychain child setup, built once for the one test below that must satisfy the
// full offline execution boundary (`resolveCollectorProductionBinding` refuses to resolve any
// registry entry without it) -- never a hand-built lookalike object.
let productionBindingSyntheticRoot;
let productionBindingIsolatedSetup;
before(async () => {
  productionBindingSyntheticRoot = await mkdtemp(join(tmpdir(), 'hookemon-buyback-binding-'));
  productionBindingIsolatedSetup = await createIsolatedKeychainChildSetup({ directory: productionBindingSyntheticRoot });
});
after(async () => {
  await rm(productionBindingSyntheticRoot, { recursive: true, force: true });
});

/** A buyback registry binding whose declared proceeds mint/decimals deliberately disagree with
 * `settlementAsset()`, for the one regression that proves this mismatch refuses before any
 * provider mutation. */
function mismatchedProceedsBuybackBinding() {
  return {
    schema: COLLECTOR_BUYBACK_BINDING_SCHEMA,
    version: 1,
    provider: 'collector-crypt',
    chainId: CHAIN_ID,
    format: 'legacy',
    addressLookupTables: [],
    proceeds: { source: Keypair.generate().publicKey.toBase58(), mint: Keypair.generate().publicKey.toBase58(), decimals: 9 },
    collectorAuthority: Keypair.generate().publicKey.toBase58(),
    collectorRecipient: COLLECTOR_RECIPIENT,
    instructions: [
      { kind: 'compute-budget-set-unit-limit', programId: 'ComputeBudget111111111111111111111111111111', accounts: [], computeUnitLimit: 40000, priorityFeeCapAtomic: null, discriminatorHex: null },
      { kind: 'compute-budget-set-unit-price', programId: 'ComputeBudget111111111111111111111111111111', accounts: [], computeUnitLimit: null, priorityFeeCapAtomic: '5000', discriminatorHex: null },
      {
        kind: 'unknown',
        programId: Keypair.generate().publicKey.toBase58(),
        accounts: [
          { role: 'operator-fee-payer', isSigner: true, isWritable: true },
          { role: 'collector-authority', isSigner: true, isWritable: false },
          { role: 'opened-asset-mint', isSigner: false, isWritable: true },
          { role: 'collector-recipient', isSigner: false, isWritable: true },
        ],
        computeUnitLimit: null,
        priorityFeeCapAtomic: null,
        discriminatorHex: 'a1b2c3d4e5f60718',
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

function mismatchedProceedsRegistry() {
  const binding = mismatchedProceedsBuybackBinding();
  return {
    schema: COLLECTOR_PRODUCTION_BINDING_REGISTRY_SCHEMA,
    version: 1,
    entries: [{
      schema: COLLECTOR_PRODUCTION_BINDING_ENTRY_SCHEMA,
      version: 1,
      authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE,
      stage: 'buyback',
      chainId: CHAIN_ID,
      provider: 'collector-crypt',
      binding,
      expectedDigest: digest(binding),
    }],
  };
}

/** A full, real offline-execution-boundary config: every endpoint pinned to loopback, the real
 * isolated Keychain child setup above, and the mismatched-proceeds registry -- exactly what
 * `assertCollectorOfflineExecutionBoundary` (called from inside `resolveCollectorProductionBinding`)
 * requires before it will even look up the registry entry this test's assertion depends on. */
/** `assertSolanaSignerMoneyConfiguration` requires `moneyConfiguration.assets.solanaStablecoin` to
 * carry Relay's own Solana chain id (never `solana-mainnet`) whenever `execution.profile ===
 * 'production'` -- see `reconcileLivePurchase normalizes a production Relay-namespaced admitted
 * unitPurchase...` above for the same override against the same underlying rule. */
function productionMoneyConfiguration() {
  const money = collectorMoneyConfiguration();
  money.assets.solanaStablecoin = { chainId: String(SOLANA_RELAY_CHAIN_ID), assetId: SETTLEMENT_ASSET, decimals: CIRCLE_USD_DECIMALS };
  money.minimums.solanaReceive = { ...money.assets.solanaStablecoin, amountAtomic: '0' };
  // Large enough to cover this file's own real production-binding candidate transactions' compute
  // price (4000 microlamports/unit), unlike the tiny '2' baseline `collectorMoneyConfiguration()`
  // uses for its other, much smaller fixtures.
  money.solana.priorityFeeCap = { ...money.solana.priorityFeeCap, chainId: String(SOLANA_RELAY_CHAIN_ID), amountAtomic: '1000000' };
  money.solana.lamportReserve = { ...money.solana.lamportReserve, chainId: String(SOLANA_RELAY_CHAIN_ID) };
  return money;
}

function offlineBoundaryConfig(registry = mismatchedProceedsRegistry()) {
  return {
    accounts: { solana: OPERATOR },
    pack: { code: 'pokemon_50' },
    execution: { profile: 'production' },
    solana: {
      chainId: CHAIN_ID,
      blockhashContextResolver: async blockhash => ({ blockhash, lastValidBlockHeight: '100' }),
      rpcUrl: 'https://127.0.0.1:4103',
    },
    collectorCrypt: {
      settlementAsset: settlementAsset(),
      baseUrl: 'https://127.0.0.1:4105',
      productionBindingAuthority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE,
      productionBindingRegistry: loadCollectorProductionBindingRegistry(registry),
    },
    robinhood: { rpcUrl: 'https://127.0.0.1:4101', archiveRpcUrl: 'https://127.0.0.1:4102' },
    relay: { baseUrl: 'https://127.0.0.1:4104' },
    signer: {
      backend: 'keychain',
      liveMode: true,
      keychain: { command: productionBindingIsolatedSetup.command, isolatedChildSetup: productionBindingIsolatedSetup },
    },
    moneyConfiguration: productionMoneyConfiguration(),
  };
}

/** A buyback registry binding whose proceeds mint/decimals genuinely match `settlementAsset()`,
 * and whose declared program/recipient/opened-asset-mint accounts match a real candidate
 * transaction this file builds against it -- for the two ownership-refresh regressions that must
 * actually reach `sellPack`'s production-binding sign path, not merely resolve the registry entry. */
function matchingBuybackBinding({ collectorProgramId, collectorRecipient, collectorAuthority, proceedsSource }) {
  return {
    schema: COLLECTOR_BUYBACK_BINDING_SCHEMA,
    version: 1,
    provider: 'collector-crypt',
    chainId: CHAIN_ID,
    format: 'legacy',
    addressLookupTables: [],
    proceeds: { source: proceedsSource, mint: SETTLEMENT_ASSET, decimals: CIRCLE_USD_DECIMALS },
    collectorAuthority,
    collectorRecipient,
    instructions: [
      { kind: 'compute-budget-set-unit-limit', programId: 'ComputeBudget111111111111111111111111111111', accounts: [], computeUnitLimit: 40000, priorityFeeCapAtomic: null, discriminatorHex: null },
      { kind: 'compute-budget-set-unit-price', programId: 'ComputeBudget111111111111111111111111111111', accounts: [], computeUnitLimit: null, priorityFeeCapAtomic: '5000', discriminatorHex: null },
      {
        kind: 'unknown',
        programId: collectorProgramId,
        accounts: [
          { role: 'operator-fee-payer', isSigner: true, isWritable: true },
          { role: 'collector-authority', isSigner: true, isWritable: false },
          { role: 'opened-asset-mint', isSigner: false, isWritable: true },
          { role: 'collector-recipient', isSigner: false, isWritable: true },
        ],
        computeUnitLimit: null,
        priorityFeeCapAtomic: null,
        discriminatorHex: 'a1b2c3d4e5f60718',
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

function matchingBuybackRegistry(binding) {
  return {
    schema: COLLECTOR_PRODUCTION_BINDING_REGISTRY_SCHEMA,
    version: 1,
    entries: [{
      schema: COLLECTOR_PRODUCTION_BINDING_ENTRY_SCHEMA,
      version: 1,
      authority: COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE,
      stage: 'buyback',
      chainId: CHAIN_ID,
      provider: 'collector-crypt',
      binding,
      expectedDigest: digest(binding),
    }],
  };
}

/** Builds a real candidate buyback transaction that satisfies `matchingBuybackBinding`'s own
 * template exactly -- the same account roles, instruction order, and settle/transfer data layout
 * `collector-buyback-policy.mjs`'s factory resolves from the binding, mirroring
 * `collector-buyback-policy.test.mjs`'s own `buildCandidateTransaction` helper but against this
 * file's own pack/settlement-asset identities. */
function buildMatchingBuybackTransaction({ collectorProgramId, collectorAuthority, collectorRecipient, proceedsSource, amountAtomic }) {
  const settleData = Buffer.alloc(24);
  Buffer.from('a1b2c3d4e5f60718', 'hex').copy(settleData, 0);
  settleData.writeBigUInt64LE(BigInt(amountAtomic), 8);
  settleData.writeBigUInt64LE(BigInt(amountAtomic), 16);
  const transferData = Buffer.alloc(10);
  transferData.writeUInt8(12, 0);
  transferData.writeBigUInt64LE(BigInt(amountAtomic), 1);
  transferData.writeUInt8(CIRCLE_USD_DECIMALS, 9);

  const proceedsDestination = new PublicKey(deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58());
  const transaction = new Transaction({ feePayer: OPERATOR_KEYPAIR.publicKey, recentBlockhash: SYSTEM_PROGRAM_ID });
  transaction.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 40000 }));
  transaction.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 4000 }));
  transaction.add(new TransactionInstruction({
    programId: new PublicKey(collectorProgramId),
    keys: [
      { pubkey: OPERATOR_KEYPAIR.publicKey, isSigner: true, isWritable: true },
      { pubkey: collectorAuthority.publicKey, isSigner: true, isWritable: false },
      { pubkey: new PublicKey(CARD_ASSET), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(collectorRecipient), isSigner: false, isWritable: true },
    ],
    data: settleData,
  }));
  transaction.add(new TransactionInstruction({
    programId: new PublicKey(TOKEN_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(proceedsSource), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(SETTLEMENT_ASSET), isSigner: false, isWritable: false },
      { pubkey: proceedsDestination, isSigner: false, isWritable: true },
      { pubkey: collectorAuthority.publicKey, isSigner: true, isWritable: false },
    ],
    data: transferData,
  }));
  transaction.partialSign(OPERATOR_KEYPAIR, collectorAuthority);
  return Buffer.from(transaction.serialize()).toString('base64');
}

function baseConfig(overrides = {}) {
  return {
    accounts: { solana: OPERATOR },
    pack: { code: 'pokemon_50' },
    solana: {
      chainId: CHAIN_ID,
      blockhashContextResolver: async blockhash => ({ blockhash, lastValidBlockHeight: '100' }),
    },
    collectorCrypt: { settlementAsset: settlementAsset() },
    moneyConfiguration: collectorMoneyConfiguration(),
    ...overrides,
  };
}

/** In-memory fake covering the exact repository surface every stage module reads or writes. */
function repository({ stages = {}, attempts = {}, batches = {}, intents = {}, admission = { unitPurchase: { ...settlementAsset(), amountAtomic: '40' } } } = {}) {
  const held = [];
  const heldPositions = [];
  const ledgers = [];
  const batchState = { ...batches };
  const intentState = { ...intents };
  return {
    held,
    heldPositions,
    ledgers,
    batchState,
    intentState,
    async readStage(_cycleId, stage) { return stages[stage] ?? { status: 'PENDING' }; },
    async readOperationalStageAttempt(_cycleId, stage) { return attempts[stage] ?? null; },
    async describeCycle() {
      return {
        releaseAmount: '40',
        admission,
        heldPositions: new Map(heldPositions.map(position => [position.positionId, position])),
        custodyLedgers: new Map(ledgers.map(({ ledger }) => [`${ledger.chainId}\u0000${ledger.assetId}`, ledger])),
      };
    },
    async holdCycle(cycleId, terminalState, evidence) { held.push({ cycleId, terminalState, evidence }); },
    async recordHeldPosition(cycleId, input) {
      const position = {
        positionId: `held:test:${heldPositions.length + 1}`,
        cycleId,
        ...input,
        evidenceDigest: `sha256:${'a'.repeat(64)}`,
        openedAtMs: 1,
        positionRevision: 0,
        ownerDecision: null,
        resolution: null,
      };
      heldPositions.push(position);
      held.push({ cycleId, terminalState: input.terminalState, evidence: input.evidence });
      return position;
    },
    async recordCustodyLedger(cycleId, ledger) { ledgers.push({ cycleId, ledger }); },
    async readPackBatchRequest(_cycleId, stage) { return batchState[stage] ?? null; },
    async recordPackBatchRequest(_cycleId, stage, packs) {
      if (batchState[stage]) return batchState[stage];
      const record = { requestedAtMs: 1_000, packs };
      batchState[stage] = record;
      return record;
    },
    async readPackBatchIntent(_cycleId, stage) { return intentState[stage] ?? null; },
    async recordPackBatchIntent(_cycleId, stage, intent) {
      if (intentState[stage]) return intentState[stage];
      const record = { recordedAtMs: 1_000, intent };
      intentState[stage] = record;
      return record;
    },
  };
}

function generateYoloPacksFixture({ memo = MEMO, transaction } = {}) {
  return { packs: [{ memo, transaction }] };
}

async function durableCycle(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-collector-lifecycle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repo = await CycleRepository.open(directory);
  const { cycleId } = await repo.createCycle({ releaseAmount: '1', mode: 'production' });
  return { directory, repository: repo, cycleId };
}

async function completeThroughOpen(repo, cycleId, openPacks) {
  for (const [stage, evidence] of [
    ['eligibility-snapshot', { source: 'durable-test' }],
    ['claim-process', { source: 'durable-test' }],
    ['outbound', { source: 'durable-test' }],
    ['purchase', { quantity: 1, packs: [{ packIndex: 0, memo: MEMO, status: 'purchased', signature: PURCHASE_SIGNATURE, expectedCardCount: 1, packCost: { ...settlementAsset(), amountAtomic: '40' } }], purchasedCount: 1 }],
    ['open', { packs: openPacks }],
  ]) {
    await repo.prepareStage(cycleId, stage);
    await repo.completeStage(cycleId, stage, evidence);
  }
}

function openedPack(overrides = {}) {
  return { packIndex: 0, memo: MEMO, decision: 'opened', signature: OPEN_SIGNATURE, mint: CARD_ASSET, assetKind: 'spl', ...overrides };
}

function sellDecisionPack(overrides = {}) {
  const rawInsuredValue = overrides.rawInsuredValue ?? '100';
  const instantBuybackPercent = overrides.instantBuybackPercent ?? 85;
  const matchedBuybackPercent = overrides.matchedBuybackPercent ?? instantBuybackPercent;
  const offerAtomic = overrides.offerAtomic ?? (BigInt(rawInsuredValue) * BigInt(matchedBuybackPercent) / 100n).toString();
  return {
    packIndex: 0,
    memo: MEMO,
    mint: CARD_ASSET,
    decision: 'sell',
    offer: { ...settlementAsset(), amountAtomic: offerAtomic },
    rawInsuredValue,
    insuredValue: { ...settlementAsset(), amountAtomic: rawInsuredValue },
    insuredValueUnit: 'atomic',
    instantBuybackPercent,
    matchedBuybackPercent,
    prizeTier: '1',
    rarity: 'epic',
    ...overrides,
  };
}

// --- purchase --------------------------------------------------------------------------------

test('preparePurchaseRequest defaults to a single pack and reads the expected per-pack card count from the catalog', async () => {
  const collectorCrypt = { async getMachines() { return { machines: [{ code: 'pokemon_50', contains: '01' }] }; } };
  assert.deepEqual(
    await preparePurchaseRequest({ adapters: { collectorCrypt }, config: baseConfig({ pack: { code: 'pokemon_50' } }) }),
    { provider: 'collector-crypt', operation: 'purchase', playerAddress: OPERATOR, quantity: 1, packType: 'pokemon_50', expectedCardCountPerPack: 1 },
  );
});

test('preparePurchaseRequest rejects a catalog pack needing an unsupported multi-card fan-out, before any spend', async () => {
  const collectorCrypt = { async getMachines() { return { machines: [{ code: 'pokemon_50', contains: 2 }] }; } };
  await assert.rejects(
    preparePurchaseRequest({ adapters: { collectorCrypt }, config: baseConfig({ pack: { code: 'pokemon_50' } }) }),
    /unsupported 2-card fan-out/,
  );
});

function heldPositionFixture(valueMicroUsdg = '10') {
  return { positionId: `held:test:${Math.random()}`, valueMicroUsdg };
}

test('preparePurchaseRequest refuses admission when the batch would exceed the configured held-position count, before any spend', async () => {
  const collectorCrypt = { async getMachines() { throw new Error('must not be called'); } };
  const cycleRepository = {
    async listHeldPositions() { return [heldPositionFixture(), heldPositionFixture()]; },
    async describeCycle() { return { releaseAmount: '100' }; },
  };
  await assert.rejects(
    preparePurchaseRequest({
      adapters: { collectorCrypt },
      config: baseConfig({ pack: { code: 'pokemon_50', quantity: 2 }, maxHeldPositions: 3 }),
      cycleRepository,
      context: { cycleId: CYCLE_ID },
    }),
    /HELD_LIMIT would exceed maxHeldPositions by 1 position/,
  );
});

test('preparePurchaseRequest refuses admission when the batch would exceed the configured held value, before any spend', async () => {
  const collectorCrypt = { async getMachines() { throw new Error('must not be called'); } };
  const cycleRepository = {
    async listHeldPositions() { return [heldPositionFixture('60')]; },
    async describeCycle() { return { releaseAmount: '80' }; },
  };
  // Existing held value 60 + worst case (releaseAmount 80 / quantity 2 = 40 per pack * 2) = 140 > 100.
  await assert.rejects(
    preparePurchaseRequest({
      adapters: { collectorCrypt },
      config: baseConfig({ pack: { code: 'pokemon_50', quantity: 2 }, maxHeldValueMicroUsdg: '100' }),
      cycleRepository,
      context: { cycleId: CYCLE_ID },
    }),
    /HELD_LIMIT would exceed maxHeldValueMicroUsdg/,
  );
});

test('preparePurchaseRequest admits a batch exactly at configured held-position headroom', async () => {
  const collectorCrypt = { async getMachines() { return { machines: [{ code: 'pokemon_50', contains: 1 }] }; } };
  const cycleRepository = {
    async listHeldPositions() { return [heldPositionFixture()]; },
    async describeCycle() { return { releaseAmount: '100' }; },
  };
  const request = await preparePurchaseRequest({
    adapters: { collectorCrypt },
    config: baseConfig({ pack: { code: 'pokemon_50', quantity: 2 }, maxHeldPositions: 3 }),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
  });
  assert.equal(request.quantity, 2);
});

test('preparePurchaseRequest skips the held-headroom check when the caller has no held-position read access', async () => {
  const collectorCrypt = { async getMachines() { return { machines: [{ code: 'pokemon_50', contains: 1 }] }; } };
  const request = await preparePurchaseRequest({
    adapters: { collectorCrypt },
    config: baseConfig({ pack: { code: 'pokemon_50', quantity: 2 }, maxHeldPositions: 0 }),
  });
  assert.equal(request.quantity, 2);
});

test('preparePurchaseRequest accepts a configured quantity within the shared batch bound', async () => {
  const collectorCrypt = { async getMachines() { return { machines: [{ code: 'pokemon_50', contains: 1 }] }; } };
  const request = await preparePurchaseRequest({ adapters: { collectorCrypt }, config: baseConfig({ pack: { code: 'pokemon_50', quantity: 5 } }) });
  assert.equal(request.quantity, 5);
});

test('preparePurchaseRequest rejects an out-of-range quantity at admission time, before any spend', async () => {
  const collectorCrypt = { async getMachines() { throw new Error('must not be called before quantity validation'); } };
  await assert.rejects(
    preparePurchaseRequest({ adapters: { collectorCrypt }, config: baseConfig({ pack: { code: 'pokemon_50', quantity: MAXIMUM_PACK_BATCH_SIZE + 1 } }) }),
    /quantity must be an integer/,
  );
  await assert.rejects(
    preparePurchaseRequest({ adapters: { collectorCrypt }, config: baseConfig({ pack: { code: 'pokemon_50', quantity: 0 } }) }),
    /quantity must be an integer/,
  );
});

test('probePurchase reports the configured quantity without spending', async () => {
  const collectorCrypt = {
    async getMachines() { return { machines: [{ code: 'pokemon_50', contains: 1 }] }; },
    async getStatus() { return { machineStatus: 'running', gachas: [] }; },
  };
  const evidence = await probePurchase({ adapters: { collectorCrypt }, config: baseConfig({ pack: { code: 'pokemon_50', quantity: 3 } }) });
  assert.equal(evidence.quantity, 3);
  assert.equal(evidence.expectedCardCountPerPack, 1);
});

test('mutatePurchase refuses the provisional authority before requesting a fresh batch', async () => {
  const transaction = transactionFor({ amount: 40n });
  const source = deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58();
  const cycleRepository = repository();
  let generateCalls = 0;
  const collectorCrypt = { async generateYoloPacks() { generateCalls += 1; return generateYoloPacksFixture({ transaction }); } };
  const rpc = rpcClient({ entries: [{ tokenAccount: source, owner: OPERATOR, mint: SETTLEMENT_ASSET, preAmount: '100', postAmount: '60', decimals: CIRCLE_USD_DECIMALS }] });

  await assert.rejects(
    () => mutatePurchase({
      liveMode: true,
      adapters: { collectorCrypt, solana: { client: rpc } },
      signerClient: { solana: { async sign() { throw new Error('must not sign'); } } },
      config: baseConfig(),
      cycleRepository,
      context: { cycleId: CYCLE_ID, request: { provider: 'collector-crypt', operation: 'purchase', playerAddress: OPERATOR, quantity: 1, expectedCardCountPerPack: 1 } },
    }),
    /active frozen interface authority is invalid/,
  );
  assert.equal(generateCalls, 0);
  assert.equal(cycleRepository.batchState.purchase, undefined);
});

test('mutatePurchase admits the exact Node-test-profile capability to reach provider generation', async () => {
  const source = deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58();
  const cycleRepository = repository();
  let generateCalls = 0;
  const collectorCrypt = { async generateYoloPacks() { generateCalls += 1; throw new Error('reached provider generation'); } };
  const rpc = rpcClient({ entries: [{ tokenAccount: source, owner: OPERATOR, mint: SETTLEMENT_ASSET, preAmount: '100', postAmount: '60', decimals: CIRCLE_USD_DECIMALS }] });

  await assert.rejects(
    () => mutatePurchase({
      liveMode: true,
      adapters: { collectorCrypt, solana: { client: rpc } },
      signerClient: { solana: { async sign() { throw new Error('must not sign'); } } },
      // Reaching generateYoloPacks also requires an admitted unitPurchase amount and a pinned
      // policy (both otherwise irrelevant to this test, since the provider call throws first).
      config: baseConfig({ collectorCrypt: { settlementAsset: settlementAsset(), purchase: { policy: {} } } }),
      cycleRepository,
      context: {
        cycleId: CYCLE_ID,
        request: {
          provider: 'collector-crypt', operation: 'purchase', playerAddress: OPERATOR, quantity: 1, expectedCardCountPerPack: 1,
          unitPurchase: { ...settlementAsset(), amountAtomic: '40' },
        },
      },
      preflightAuthority: TEST_PROFILE_MUTATION_AUTHORITY,
    }),
    /reached provider generation/,
  );
  assert.equal(generateCalls, 1);
});

test('mutatePurchase refuses a structural clone, an arbitrary object, and a serialized capability before any provider call', async () => {
  for (const badCapability of [{ ...TEST_PROFILE_MUTATION_AUTHORITY }, { anything: true }, 'test-profile']) {
    const source = deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58();
    const cycleRepository = repository();
    let generateCalls = 0;
    const collectorCrypt = { async generateYoloPacks() { generateCalls += 1; throw new Error('must not be called'); } };
    const rpc = rpcClient({ entries: [{ tokenAccount: source, owner: OPERATOR, mint: SETTLEMENT_ASSET, preAmount: '100', postAmount: '60', decimals: CIRCLE_USD_DECIMALS }] });

    await assert.rejects(
      () => mutatePurchase({
        liveMode: true,
        adapters: { collectorCrypt, solana: { client: rpc } },
        signerClient: { solana: { async sign() { throw new Error('must not sign'); } } },
        config: baseConfig(),
        cycleRepository,
        context: { cycleId: CYCLE_ID, request: { provider: 'collector-crypt', operation: 'purchase', playerAddress: OPERATOR, quantity: 1, expectedCardCountPerPack: 1 } },
        preflightAuthority: badCapability,
      }),
      /fixture authority is invalid/,
    );
    assert.equal(generateCalls, 0);
  }
});

test('mutatePurchase refuses the exact capability outside the Node test runner', async () => {
  const previous = process.env.NODE_TEST_CONTEXT;
  try {
    delete process.env.NODE_TEST_CONTEXT;
    const source = deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58();
    const cycleRepository = repository();
    let generateCalls = 0;
    const collectorCrypt = { async generateYoloPacks() { generateCalls += 1; throw new Error('must not be called'); } };
    const rpc = rpcClient({ entries: [{ tokenAccount: source, owner: OPERATOR, mint: SETTLEMENT_ASSET, preAmount: '100', postAmount: '60', decimals: CIRCLE_USD_DECIMALS }] });

    await assert.rejects(
      () => mutatePurchase({
        liveMode: true,
        adapters: { collectorCrypt, solana: { client: rpc } },
        signerClient: { solana: { async sign() { throw new Error('must not sign'); } } },
        config: baseConfig(),
        cycleRepository,
        context: { cycleId: CYCLE_ID, request: { provider: 'collector-crypt', operation: 'purchase', playerAddress: OPERATOR, quantity: 1, expectedCardCountPerPack: 1 } },
        preflightAuthority: TEST_PROFILE_MUTATION_AUTHORITY,
      }),
      /available only from the Node test runner/,
    );
    assert.equal(generateCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previous;
  }
});

test('mutatePurchase reuses an already-recorded batch and returns without ever requesting live-mutation authority', async () => {
  const cycleRepository = repository({
    batches: { purchase: { requestedAtMs: 1_000, packs: [{ packIndex: 0, memo: MEMO, expectedCardCount: 1, packType: null }] } },
    intents: { purchase: { recordedAtMs: 1_000, intent: { quantity: 1, packType: null, expectedCardCountPerPack: 1, playerAddress: OPERATOR } } },
  });
  let generateCalls = 0;
  const source = deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58();
  const collectorCrypt = { async generateYoloPacks() { generateCalls += 1; throw new Error('must not regenerate an already-recorded batch'); } };
  const rpc = rpcClient({ entries: [{ tokenAccount: source, owner: OPERATOR, mint: SETTLEMENT_ASSET, preAmount: '100', postAmount: '60', decimals: CIRCLE_USD_DECIMALS }] });

  // No cached unsigned transaction bytes survive a restart, so there is nothing left to sign
  // either: this call reaches neither generateYoloPacks nor the signer, and therefore never
  // needs the (otherwise always-denied in this test profile) live-mutation authority.
  const evidence = await mutatePurchase({
    liveMode: true,
    adapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: { solana: { async sign() { throw new Error('must not sign'); } } },
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: CYCLE_ID, request: { provider: 'collector-crypt', operation: 'purchase', playerAddress: OPERATOR, quantity: 1, expectedCardCountPerPack: 1 } },
  });

  assert.deepEqual(evidence, { quantity: 1, expectedCardCountPerPack: 1 });
  assert.equal(generateCalls, 0);

  const reconciled = await reconcileLivePurchase({
    adapters: { collectorCrypt: { async getPackStatus() { return { memo: MEMO, pack: { transaction_signature: PURCHASE_SIGNATURE, token_mint: SETTLEMENT_ASSET }, send: null, buyback: [] }; } }, solana: { client: rpc } },
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
  });
  assert.equal(reconciled.purchasedCount, 1);
  assert.deepEqual(reconciled.packs[0], {
    packIndex: 0, memo: MEMO, status: 'purchased', signature: PURCHASE_SIGNATURE, expectedCardCount: 1,
    packCost: { ...settlementAsset(), amountAtomic: '40' },
  });
});

test('reconcileLivePurchase holds the whole cycle when a pack status conflicts with its durable memo', async () => {
  const cycleRepository = repository({
    batches: { purchase: { requestedAtMs: 1_000, packs: [{ packIndex: 0, memo: MEMO, expectedCardCount: 1, packType: null }] } },
    intents: { purchase: { recordedAtMs: 1_000, intent: { quantity: 1, packType: null, expectedCardCountPerPack: 1, playerAddress: OPERATOR } } },
  });
  const result = await reconcileLivePurchase({
    adapters: {
      collectorCrypt: { async getPackStatus() { return { memo: 'different-memo', pack: null, send: null, buyback: [] }; } },
      solana: { client: rpcClient() },
    },
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
  });
  assert.equal(result, null);
  assert.equal(cycleRepository.held.length, 1);
  assert.equal(cycleRepository.held[0].terminalState, 'HELD_DATA_UNVERIFIED');
});

test('reconcileLivePurchase resolves a pack with no provider evidence as not_purchased once its deadline passes', async () => {
  const cycleRepository = repository({
    batches: { purchase: { requestedAtMs: 0, packs: [{ packIndex: 0, memo: MEMO, expectedCardCount: 1, packType: null }] } },
    intents: { purchase: { recordedAtMs: 0, intent: { quantity: 1, packType: null, expectedCardCountPerPack: 1, playerAddress: OPERATOR } } },
  });
  const beforeDeadline = await reconcileLivePurchase({
    adapters: { collectorCrypt: { async getPackStatus() { return { memo: MEMO, pack: null, send: null, buyback: [] }; } }, solana: { client: rpcClient() } },
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: CYCLE_ID, nowMs: 1000 },
  });
  assert.equal(beforeDeadline, null);

  const afterDeadline = await reconcileLivePurchase({
    adapters: { collectorCrypt: { async getPackStatus() { return { memo: MEMO, pack: null, send: null, buyback: [] }; } }, solana: { client: rpcClient() } },
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: CYCLE_ID, nowMs: 31 * 60 * 1000 },
  });
  assert.deepEqual(afterDeadline, { quantity: 1, packs: [{ packIndex: 0, memo: MEMO, status: 'not_purchased' }], purchasedCount: 0 });
  assert.equal(cycleRepository.held.length, 0);
});

test('reconcileLivePurchase holds the whole cycle when the batch call itself remained sent-unknown past the deadline', async () => {
  const cycleRepository = repository({ attempts: { purchase: { attempt: { state: 'SENT_UNKNOWN' }, sentAtMs: 0, responseEvidence: null, reconciliationEvidence: null } } });
  const result = await reconcileLivePurchase({
    adapters: { collectorCrypt: {}, solana: { client: rpcClient() } },
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: CYCLE_ID, nowMs: 31 * 60 * 1000 },
  });
  assert.equal(result, null);
  assert.equal(cycleRepository.held.length, 1);
  assert.equal(cycleRepository.held[0].terminalState, 'HELD_DATA_UNVERIFIED');
  assert.match(cycleRepository.held[0].evidence.reason, /no durably generated pack/);
});

function purchaseRepositoryFixture({ admission } = {}) {
  return repository({
    batches: { purchase: { requestedAtMs: 1_000, packs: [{ packIndex: 0, memo: MEMO, expectedCardCount: 1, packType: null }] } },
    intents: { purchase: { recordedAtMs: 1_000, intent: { quantity: 1, packType: null, expectedCardCountPerPack: 1, playerAddress: OPERATOR } } },
    ...(admission !== undefined ? { admission } : {}),
  });
}

function forbiddenCollectorCrypt() {
  return {
    async getPackStatus() { throw new Error('must not call getPackStatus'); },
    async generateYoloPacks() { throw new Error('must not call generateYoloPacks'); },
  };
}

function forbiddenRpcClient() {
  return createSolanaRpcClient({ fetchImpl: async () => { throw new Error('must not make an RPC read'); } });
}

test('reconcileLivePurchase normalizes a production Relay-namespaced admitted unitPurchase onto the native asset and reconciles a finalized matching debit', async () => {
  const source = deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58();
  const relayUnitPurchase = { chainId: String(SOLANA_RELAY_CHAIN_ID), assetId: SETTLEMENT_ASSET, decimals: CIRCLE_USD_DECIMALS, amountAtomic: '40' };
  const cycleRepository = purchaseRepositoryFixture({ admission: { unitPurchase: relayUnitPurchase } });
  const money = collectorMoneyConfiguration();
  money.assets.solanaStablecoin = { chainId: String(SOLANA_RELAY_CHAIN_ID), assetId: SETTLEMENT_ASSET, decimals: CIRCLE_USD_DECIMALS };
  money.minimums.solanaReceive = { ...money.assets.solanaStablecoin, amountAtomic: '0' };
  money.solana.priorityFeeCap = { ...money.solana.priorityFeeCap, chainId: String(SOLANA_RELAY_CHAIN_ID) };
  money.solana.lamportReserve = { ...money.solana.lamportReserve, chainId: String(SOLANA_RELAY_CHAIN_ID) };
  const config = baseConfig({ execution: { profile: 'production' }, moneyConfiguration: money });
  const rpc = rpcClient({ entries: [{ tokenAccount: source, owner: OPERATOR, mint: SETTLEMENT_ASSET, preAmount: '100', postAmount: '60', decimals: CIRCLE_USD_DECIMALS }] });

  const reconciled = await reconcileLivePurchase({
    adapters: {
      collectorCrypt: { async getPackStatus() { return { memo: MEMO, pack: { transaction_signature: PURCHASE_SIGNATURE, token_mint: SETTLEMENT_ASSET }, send: null, buyback: [] }; } },
      solana: { client: rpc },
    },
    config,
    cycleRepository,
    context: { cycleId: CYCLE_ID },
  });

  assert.equal(reconciled.purchasedCount, 1);
  assert.deepEqual(reconciled.packs[0], {
    packIndex: 0, memo: MEMO, status: 'purchased', signature: PURCHASE_SIGNATURE, expectedCardCount: 1,
    packCost: { ...settlementAsset(), amountAtomic: '40' },
  });
});

test('reconcileLivePurchase refuses before any provider or RPC read when the cycle or its admission is absent', async () => {
  const missingAdmission = purchaseRepositoryFixture({ admission: null });
  const missingCycle = { ...purchaseRepositoryFixture(), async describeCycle() { return null; } };
  for (const cycleRepository of [missingAdmission, missingCycle]) {
    await assert.rejects(
      () => reconcileLivePurchase({
        adapters: { collectorCrypt: forbiddenCollectorCrypt(), solana: { client: forbiddenRpcClient() } },
        config: baseConfig(),
        cycleRepository,
        context: { cycleId: CYCLE_ID },
      }),
      /requires a durable admission carrying the immutable admitted per-pack amount/,
    );
    assert.equal(cycleRepository.held.length, 0);
  }
});

test('reconcileLivePurchase refuses before any provider or RPC read when the repository cannot describe the cycle at all', async () => {
  const cycleRepository = purchaseRepositoryFixture();
  delete cycleRepository.describeCycle;
  await assert.rejects(
    () => reconcileLivePurchase({
      adapters: { collectorCrypt: forbiddenCollectorCrypt(), solana: { client: forbiddenRpcClient() } },
      config: baseConfig(),
      cycleRepository,
      context: { cycleId: CYCLE_ID },
    }),
    /requires cycleRepository\.describeCycle to read the immutable admitted per-pack amount/,
  );
  assert.equal(cycleRepository.held.length, 0);
});

test('reconcileLivePurchase refuses before any provider or RPC read when the admitted unitPurchase is missing, malformed, or names the wrong chain/mint/decimals', async () => {
  const badUnitPurchases = [
    undefined,
    { ...settlementAsset(), chainId: '999', amountAtomic: '40' },
    { ...settlementAsset(), assetId: CARD_ASSET, amountAtomic: '40' },
    { ...settlementAsset(), decimals: CIRCLE_USD_DECIMALS + 1, amountAtomic: '40' },
    { ...settlementAsset(), amountAtomic: '040' },
    { ...settlementAsset(), amountAtomic: 'not-a-number' },
  ];
  for (const unitPurchase of badUnitPurchases) {
    const cycleRepository = purchaseRepositoryFixture({ admission: { unitPurchase } });
    await assert.rejects(() => reconcileLivePurchase({
      adapters: { collectorCrypt: forbiddenCollectorCrypt(), solana: { client: forbiddenRpcClient() } },
      config: baseConfig(),
      cycleRepository,
      context: { cycleId: CYCLE_ID },
    }), /purchase reconciliation admitted unitPurchase/);
    assert.equal(cycleRepository.held.length, 0);
  }
});

// --- open ------------------------------------------------------------------------------------

test('prepareOpenRequest filters the durable purchase ledger to purchased packs only', async () => {
  const cycleRepository = repository({
    stages: {
      purchase: {
        status: 'COMPLETE',
        evidence: {
          quantity: 2,
          packs: [
            { packIndex: 0, memo: MEMO, status: 'purchased', expectedCardCount: 1 },
            { packIndex: 1, memo: 'memo-not-purchased', status: 'not_purchased' },
          ],
        },
      },
    },
  });
  assert.deepEqual(await prepareOpenRequest({ cycleRepository, context: { cycleId: CYCLE_ID } }), {
    provider: 'collector-crypt', operation: 'open', packs: [{ packIndex: 0, memo: MEMO, expectedCardCount: 1 }],
  });
});

test('mutateOpen refuses the provisional authority before opening any purchased pack', async () => {
  const cycleRepository = repository({
    stages: { purchase: { status: 'COMPLETE', evidence: { quantity: 1, packs: [{ packIndex: 0, memo: MEMO, status: 'purchased', expectedCardCount: 1 }] } } },
  });
  let openCalls = 0;
  await assert.rejects(
    () => mutateOpen({
      liveMode: true,
      adapters: { collectorCrypt: { async openPack() { openCalls += 1; return { success: true }; } } },
      config: baseConfig(),
      cycleRepository,
      context: { cycleId: CYCLE_ID },
    }),
    /active frozen interface authority is invalid/,
  );
  assert.equal(openCalls, 0);
});

test('mutateOpen admits the exact Node-test-profile capability to reach the provider open call', async () => {
  const cycleRepository = repository({
    stages: { purchase: { status: 'COMPLETE', evidence: { quantity: 1, packs: [{ packIndex: 0, memo: MEMO, status: 'purchased', expectedCardCount: 1 }] } } },
  });
  let openCalls = 0;
  await assert.rejects(
    () => mutateOpen({
      liveMode: true,
      adapters: { collectorCrypt: { async openPack() { openCalls += 1; throw new Error('reached provider open'); } } },
      config: baseConfig(),
      cycleRepository,
      context: { cycleId: CYCLE_ID },
      preflightAuthority: TEST_PROFILE_MUTATION_AUTHORITY,
    }),
    /reached provider open/,
  );
  assert.equal(openCalls, 1);
});

test('mutateOpen refuses a structural clone, an arbitrary object, and a serialized capability before opening any pack', async () => {
  for (const badCapability of [{ ...TEST_PROFILE_MUTATION_AUTHORITY }, { anything: true }, 'test-profile']) {
    const cycleRepository = repository({
      stages: { purchase: { status: 'COMPLETE', evidence: { quantity: 1, packs: [{ packIndex: 0, memo: MEMO, status: 'purchased', expectedCardCount: 1 }] } } },
    });
    let openCalls = 0;
    await assert.rejects(
      () => mutateOpen({
        liveMode: true,
        adapters: { collectorCrypt: { async openPack() { openCalls += 1; throw new Error('must not be called'); } } },
        config: baseConfig(),
        cycleRepository,
        context: { cycleId: CYCLE_ID },
        preflightAuthority: badCapability,
      }),
      /fixture authority is invalid/,
    );
    assert.equal(openCalls, 0);
  }
});

test('mutateOpen refuses the exact capability outside the Node test runner', async () => {
  const previous = process.env.NODE_TEST_CONTEXT;
  try {
    delete process.env.NODE_TEST_CONTEXT;
    const cycleRepository = repository({
      stages: { purchase: { status: 'COMPLETE', evidence: { quantity: 1, packs: [{ packIndex: 0, memo: MEMO, status: 'purchased', expectedCardCount: 1 }] } } },
    });
    let openCalls = 0;
    await assert.rejects(
      () => mutateOpen({
        liveMode: true,
        adapters: { collectorCrypt: { async openPack() { openCalls += 1; throw new Error('must not be called'); } } },
        config: baseConfig(),
        cycleRepository,
        context: { cycleId: CYCLE_ID },
        preflightAuthority: TEST_PROFILE_MUTATION_AUTHORITY,
      }),
      /available only from the Node test runner/,
    );
    assert.equal(openCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previous;
  }
});

test('reconcileLiveOpen resolves an opened pack from memo-bound status and finalized mint derivation', async () => {
  const cycleRepository = repository({
    stages: { purchase: { status: 'COMPLETE', evidence: { quantity: 1, packs: [{ packIndex: 0, memo: MEMO, status: 'purchased', expectedCardCount: 1 }] } } },
    intents: { purchase: { recordedAtMs: 0, intent: { quantity: 1, packType: null, expectedCardCountPerPack: 1, playerAddress: OPERATOR } } },
  });
  const cardTokenAccount = deriveAssociatedTokenAddress(OPERATOR, CARD_ASSET).toBase58();
  const collectorCrypt = {
    async getPackStatus() {
      return { memo: MEMO, pack: { transaction_signature: PURCHASE_SIGNATURE }, send: { nft_address: CARD_ASSET, transaction_signature: OPEN_SIGNATURE, to_wallet: OPERATOR }, buyback: [] };
    },
  };
  const rpc = rpcClient({ entries: [{ tokenAccount: cardTokenAccount, owner: OPERATOR, mint: CARD_ASSET, preAmount: '0', postAmount: '1' }] });
  const result = await reconcileLiveOpen({ adapters: { collectorCrypt, solana: { client: rpc } }, config: baseConfig(), cycleRepository, context: { cycleId: CYCLE_ID } });
  assert.deepEqual(result, { packs: [openedPack()] });
});

test('reconcileLiveOpen carves an unverified pack into a held position while another pack in the same batch still resolves', async () => {
  const cycleRepository = repository({
    stages: {
      purchase: {
        status: 'COMPLETE',
        evidence: {
          quantity: 2,
          packs: [
            { packIndex: 0, memo: MEMO, status: 'purchased', expectedCardCount: 1 },
            { packIndex: 1, memo: 'memo-two', status: 'purchased', expectedCardCount: 1 },
          ],
        },
      },
    },
    attempts: {
      open: {
        attempt: { state: 'RESPONSE_RECORDED' },
        responseEvidence: { packs: [{ packIndex: 0, memo: MEMO, opened: { success: true } }, { packIndex: 1, memo: 'memo-two', opened: { success: true } }] },
        reconciliationEvidence: null,
      },
    },
    intents: { purchase: { recordedAtMs: 0, intent: { quantity: 2, packType: null, expectedCardCountPerPack: 1, playerAddress: OPERATOR } } },
  });
  const cardTokenAccount = deriveAssociatedTokenAddress(OPERATOR, CARD_ASSET).toBase58();
  const collectorCrypt = {
    async getPackStatus({ memo }) {
      if (memo === MEMO) return { memo, pack: {}, send: null, buyback: [] };
      return { memo, pack: { transaction_signature: PURCHASE_SIGNATURE }, send: { nft_address: CARD_ASSET, transaction_signature: OPEN_SIGNATURE, to_wallet: OPERATOR }, buyback: [] };
    },
  };
  const rpc = rpcClient({ entries: [{ tokenAccount: cardTokenAccount, owner: OPERATOR, mint: CARD_ASSET, preAmount: '0', postAmount: '1' }] });
  const result = await reconcileLiveOpen({ adapters: { collectorCrypt, solana: { client: rpc } }, config: baseConfig(), cycleRepository, context: { cycleId: CYCLE_ID } });

  assert.equal(result.packs.length, 2);
  assert.equal(result.packs[0].decision, 'held');
  assert.equal(result.packs[0].terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(result.packs[1].decision, 'opened');
  assert.equal(result.packs[1].mint, CARD_ASSET);
  assert.equal(cycleRepository.heldPositions.length, 1);
});

test('reconcileLiveOpen holds a SENT_UNKNOWN pack past its deadline as HELD_UNRESOLVED without resubmitting', async () => {
  const cycleRepository = repository({
    stages: { purchase: { status: 'COMPLETE', evidence: { quantity: 1, packs: [{ packIndex: 0, memo: MEMO, status: 'purchased', expectedCardCount: 1 }] } } },
    attempts: { open: { attempt: { state: 'SENT_UNKNOWN' }, sentAtMs: 0, responseEvidence: null, reconciliationEvidence: null } },
    intents: { purchase: { recordedAtMs: 0, intent: { quantity: 1, packType: null, expectedCardCountPerPack: 1, playerAddress: OPERATOR } } },
  });
  let openCalls = 0;
  const collectorCrypt = {
    async getPackStatus() { return { memo: MEMO, pack: null, send: null, buyback: [] }; },
    async openPack() { openCalls += 1; throw new Error('must not resubmit'); },
  };
  const result = await reconcileLiveOpen({ adapters: { collectorCrypt, solana: { client: rpcClient() } }, config: baseConfig(), cycleRepository, context: { cycleId: CYCLE_ID, nowMs: 31 * 60 * 1000 } });
  assert.equal(result.packs[0].decision, 'held');
  assert.equal(result.packs[0].terminalState, 'HELD_UNRESOLVED');
  assert.equal(result.packs[0].reason, 'SENT_UNKNOWN_DEADLINE');
  assert.equal(openCalls, 0);
});

// --- epic-gate ---------------------------------------------------------------------------------

test('mutateEpicGate passes a held open pack through without a second held-position write', async () => {
  const heldPack = { packIndex: 0, memo: MEMO, mint: null, decision: 'held', terminalState: 'HELD_DATA_UNVERIFIED', reason: 'DATA_UNVERIFIED', heldPosition: { positionId: 'held:test:1', evidenceDigest: `sha256:${'a'.repeat(64)}`, terminalState: 'HELD_DATA_UNVERIFIED', reason: 'DATA_UNVERIFIED' } };
  const cycleRepository = repository({ stages: { open: { status: 'COMPLETE', evidence: { packs: [heldPack] } } } });
  const evidence = await mutateEpicGate({ liveMode: true, adapters: {}, config: baseConfig(), cycleRepository, context: { cycleId: CYCLE_ID } });
  assert.deepEqual(evidence, { packs: [heldPack] });
  assert.equal(cycleRepository.heldPositions.length, 0);
});

test('mutateEpicGate records a sell decision for an eligible card', async () => {
  const cycleRepository = repository({ stages: { open: { status: 'COMPLETE', evidence: { packs: [openedPack()] } } } });
  const collectorCrypt = {
    async getPackStatus() {
      return { memo: MEMO, pack: { pack_type: 'pokemon_50' }, send: { nft_address: CARD_ASSET, prize_tier: 1, insured_value: 100 }, buyback: [] };
    },
    async getNfts() { return { nfts: [{ nft_address: CARD_ASSET, rarity: 'epic', insured_value: 100 }], page: 1, limit: 50, hasMore: false }; },
    async getMachines() { return { machines: [{ code: 'pokemon_50', instantBuyback: 85 }] }; },
    async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: '85' } }; },
  };
  const config = baseConfig({
    collectorCrypt: {
      settlementAsset: settlementAsset(),
      epicGate: { nftAddressField: 'nft_address', insuredValueField: 'insured_value', prizeTierField: 'prize_tier', rarityField: 'rarity', asset: settlementAsset() },
    },
  });
  const evidence = await mutateEpicGate({ liveMode: true, adapters: { collectorCrypt }, config, cycleRepository, context: { cycleId: CYCLE_ID } });
  assert.equal(evidence.packs[0].decision, 'sell');
  assert.equal(evidence.packs[0].packIndex, 0);
});

test('reconcileLiveEpicGate carves a recorded below-forty-percent hold decision into HELD_OWNER_DECISION', async () => {
  const cycleRepository = repository({
    attempts: { 'epic-gate': { attempt: { state: 'RESPONSE_RECORDED' }, responseEvidence: { packs: [sellDecisionPack({ offerAtomic: '39', decision: 'hold' })] }, reconciliationEvidence: null } },
  });
  const evidence = await reconcileLiveEpicGate({ adapters: {}, config: baseConfig(), cycleRepository, context: { cycleId: CYCLE_ID } });
  assert.equal(evidence.packs[0].decision, 'held');
  assert.equal(evidence.packs[0].terminalState, 'HELD_OWNER_DECISION');
  assert.equal(evidence.packs[0].reason, 'EPIC_THRESHOLD');
  assert.equal(cycleRepository.heldPositions.length, 1);
});

test('reconcileLiveEpicGate holds a pack whose buyback quote changed since mutation', async () => {
  const cycleRepository = repository({ attempts: { 'epic-gate': { attempt: { state: 'RESPONSE_RECORDED' }, responseEvidence: { packs: [sellDecisionPack()] }, reconciliationEvidence: null } } });
  const collectorCrypt = {
    async getPackStatus() {
      return { memo: MEMO, pack: { pack_type: 'pokemon_50' }, send: { nft_address: CARD_ASSET, prize_tier: 1, insured_value: 100 }, buyback: [] };
    },
    async getNfts() { return { nfts: [{ nft_address: CARD_ASSET, rarity: 'epic', insured_value: 100 }], page: 1, limit: 50, hasMore: false }; },
    async getMachines() { return { machines: [{ code: 'pokemon_50', instantBuyback: 85 }] }; },
    async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: '84' } }; },
  };
  const config = baseConfig({
    collectorCrypt: {
      settlementAsset: settlementAsset(),
      epicGate: { nftAddressField: 'nft_address', insuredValueField: 'insured_value', prizeTierField: 'prize_tier', rarityField: 'rarity', asset: settlementAsset() },
    },
  });
  const result = await reconcileLiveEpicGate({ adapters: { collectorCrypt }, config, cycleRepository, context: { cycleId: CYCLE_ID } });
  assert.equal(result.packs[0].decision, 'held');
  assert.equal(result.packs[0].terminalState, 'HELD_DATA_UNVERIFIED');
});

// --- buyback -----------------------------------------------------------------------------------

test('mutateBuyback passes a held epic-gate pack through without touching the provider', async () => {
  const heldPack = { packIndex: 0, memo: MEMO, mint: CARD_ASSET, decision: 'held', terminalState: 'HELD_OWNER_DECISION', reason: 'EPIC_THRESHOLD', heldPosition: { positionId: 'held:test:1', evidenceDigest: `sha256:${'a'.repeat(64)}`, terminalState: 'HELD_OWNER_DECISION', reason: 'EPIC_THRESHOLD' } };
  const cycleRepository = repository({ stages: { 'epic-gate': { status: 'COMPLETE', evidence: { packs: [heldPack] } } } });
  const collectorCrypt = { async getBuybackAvailable() { throw new Error('must not query a held pack'); } };
  const evidence = await mutateBuyback({ liveMode: true, adapters: { collectorCrypt }, signerClient: {}, config: baseConfig(), cycleRepository, context: { cycleId: CYCLE_ID } });
  assert.deepEqual(evidence, { packs: [heldPack] });
});

test('mutateBuyback holds a pack as unavailable before it can request or sign a provider transaction', async () => {
  const cycleRepository = repository({ stages: {
    'epic-gate': { status: 'COMPLETE', evidence: { packs: [sellDecisionPack()] } },
    open: { status: 'COMPLETE', evidence: { packs: [openedPack()] } },
  } });
  const collectorCrypt = { async getBuybackAvailable() { return { available: false }; } };
  const rpc = rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) });
  const evidence = await mutateBuyback({ liveMode: true, adapters: { collectorCrypt, solana: { client: rpc } }, signerClient: {}, config: baseConfig(), cycleRepository, context: { cycleId: CYCLE_ID } });
  assert.equal(evidence.packs[0].decision, 'held');
  assert.equal(evidence.packs[0].terminalState, 'HELD_UNAVAILABLE');
  assert.equal(cycleRepository.heldPositions.length, 1);
});

test('mutateBuyback marks a pack unknown (not held) when the provisional authority denies it after a matching quote', async () => {
  // Nothing has been sent to the provider yet at this boundary, but a denial here is the same
  // guard that also protects a real post-send failure; treating it as "unknown" (never "held")
  // keeps the two indistinguishable paths from ever double-holding a pack the provider may have
  // actually processed.
  const cycleRepository = repository({ stages: {
    'epic-gate': { status: 'COMPLETE', evidence: { packs: [sellDecisionPack()] } },
    open: { status: 'COMPLETE', evidence: { packs: [openedPack()] } },
  } });
  const rpc = rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) });
  let buybackCalls = 0;
  const collectorCrypt = {
    async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: '85' } }; },
    async buyback() { buybackCalls += 1; throw new Error('must not be called'); },
  };
  const evidence = await mutateBuyback({ liveMode: true, adapters: { collectorCrypt, solana: { client: rpc } }, signerClient: {}, config: baseConfig(), cycleRepository, context: { cycleId: CYCLE_ID } });
  assert.equal(evidence.packs[0].decision, 'unknown');
  assert.equal(evidence.packs[0].memo, MEMO);
  assert.equal(cycleRepository.held.length, 0);
  assert.equal(buybackCalls, 0);
});

test('mutateBuyback admits the exact Node-test-profile capability to reach the provider buyback call', async () => {
  const cycleRepository = repository({ stages: {
    'epic-gate': { status: 'COMPLETE', evidence: { packs: [sellDecisionPack()] } },
    open: { status: 'COMPLETE', evidence: { packs: [openedPack()] } },
  } });
  const rpc = rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) });
  let buybackCalls = 0;
  const collectorCrypt = {
    async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: '85' } }; },
    async buyback() { buybackCalls += 1; throw new Error('reached provider buyback'); },
  };
  // A thrown provider error inside sellPack's own try/catch resolves to "unknown" rather than a
  // rejection, exactly like the (otherwise-denied) provisional-authority case above -- what this
  // proves is that the provider was actually reached, via the incremented counter.
  const evidence = await mutateBuyback({
    liveMode: true,
    adapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: {},
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
    preflightAuthority: TEST_PROFILE_MUTATION_AUTHORITY,
  });
  assert.equal(evidence.packs[0].decision, 'unknown');
  assert.equal(buybackCalls, 1);
});

test('mutateBuyback refuses a structural clone, an arbitrary object, and a serialized capability before any provider call', async () => {
  for (const badCapability of [{ ...TEST_PROFILE_MUTATION_AUTHORITY }, { anything: true }, 'test-profile']) {
    const cycleRepository = repository({ stages: {
    'epic-gate': { status: 'COMPLETE', evidence: { packs: [sellDecisionPack()] } },
    open: { status: 'COMPLETE', evidence: { packs: [openedPack()] } },
  } });
    const rpc = rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) });
    let buybackCalls = 0;
    const collectorCrypt = {
      async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: '85' } }; },
      async buyback() { buybackCalls += 1; throw new Error('must not be called'); },
    };
    const evidence = await mutateBuyback({
      liveMode: true,
      adapters: { collectorCrypt, solana: { client: rpc } },
      signerClient: {},
      config: baseConfig(),
      cycleRepository,
      context: { cycleId: CYCLE_ID },
      preflightAuthority: badCapability,
    });
    assert.equal(evidence.packs[0].decision, 'unknown');
    assert.equal(buybackCalls, 0);
  }
});

test('mutateBuyback refuses the exact capability outside the Node test runner', async () => {
  const previous = process.env.NODE_TEST_CONTEXT;
  try {
    delete process.env.NODE_TEST_CONTEXT;
    const cycleRepository = repository({ stages: {
    'epic-gate': { status: 'COMPLETE', evidence: { packs: [sellDecisionPack()] } },
    open: { status: 'COMPLETE', evidence: { packs: [openedPack()] } },
  } });
    const rpc = rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) });
    let buybackCalls = 0;
    const collectorCrypt = {
      async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: '85' } }; },
      async buyback() { buybackCalls += 1; throw new Error('must not be called'); },
    };
    const evidence = await mutateBuyback({
      liveMode: true,
      adapters: { collectorCrypt, solana: { client: rpc } },
      signerClient: {},
      config: baseConfig(),
      cycleRepository,
      context: { cycleId: CYCLE_ID },
      preflightAuthority: TEST_PROFILE_MUTATION_AUTHORITY,
    });
    assert.equal(evidence.packs[0].decision, 'unknown');
    assert.equal(buybackCalls, 0);
  } finally {
    if (previous === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = previous;
  }
});

test('mutateBuyback holds a pack whose finalized owner is not the configured operator, with zero provider or signer effects', async () => {
  const outsider = Keypair.generate().publicKey.toBase58();
  const cycleRepository = repository({ stages: {
    'epic-gate': { status: 'COMPLETE', evidence: { packs: [sellDecisionPack()] } },
    open: { status: 'COMPLETE', evidence: { packs: [openedPack({ assetKind: 'mpl-core' })] } },
  } });
  let buybackCalls = 0;
  let availableCalls = 0;
  const collectorCrypt = {
    async getBuybackAvailable() { availableCalls += 1; return { available: true, amount: { ...settlementAsset(), amountAtomic: '85' } }; },
    async buyback() { buybackCalls += 1; throw new Error('must not be called'); },
  };
  const rpc = rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }), cardOwner: outsider });
  const evidence = await mutateBuyback({
    liveMode: true,
    adapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: { solana: { async sign() { throw new Error('must not sign'); } } },
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
    preflightAuthority: TEST_PROFILE_MUTATION_AUTHORITY,
  });
  assert.equal(evidence.packs[0].decision, 'held');
  assert.equal(evidence.packs[0].terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(cycleRepository.heldPositions.length, 1);
  assert.equal(availableCalls, 0, 'the provider availability read must never be reached for an unowned card');
  assert.equal(buybackCalls, 0, 'the provider mutation must never be reached for an unowned card');
});

test('mutateBuyback holds a pack with no completed open-stage record, with zero provider or signer effects', async () => {
  const cycleRepository = repository({ stages: {
    'epic-gate': { status: 'COMPLETE', evidence: { packs: [sellDecisionPack()] } },
  } });
  let buybackCalls = 0;
  const collectorCrypt = {
    async getBuybackAvailable() { throw new Error('must not be called'); },
    async buyback() { buybackCalls += 1; throw new Error('must not be called'); },
  };
  const rpc = rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) });
  const evidence = await mutateBuyback({
    liveMode: true,
    adapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: { solana: { async sign() { throw new Error('must not sign'); } } },
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
    preflightAuthority: TEST_PROFILE_MUTATION_AUTHORITY,
  });
  assert.equal(evidence.packs[0].decision, 'held');
  assert.equal(evidence.packs[0].terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(cycleRepository.heldPositions.length, 1);
  assert.equal(buybackCalls, 0, 'the provider mutation must never be reached without a completed open-stage record');
});

test('mutateBuyback holds a pack whose open-stage record exists but is not COMPLETE, with zero provider or signer effects', async () => {
  const cycleRepository = repository({ stages: {
    'epic-gate': { status: 'COMPLETE', evidence: { packs: [sellDecisionPack()] } },
    // A PREPARED record carrying a plausible-looking pack ledger is not a completed one: it must
    // still refuse, exactly like a genuinely absent open-stage record.
    open: { status: 'PREPARED', evidence: { packs: [openedPack()] } },
  } });
  let buybackCalls = 0;
  const collectorCrypt = {
    async getBuybackAvailable() { throw new Error('must not be called'); },
    async buyback() { buybackCalls += 1; throw new Error('must not be called'); },
  };
  const rpc = rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) });
  const evidence = await mutateBuyback({
    liveMode: true,
    adapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: { solana: { async sign() { throw new Error('must not sign'); } } },
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
    preflightAuthority: TEST_PROFILE_MUTATION_AUTHORITY,
  });
  assert.equal(evidence.packs[0].decision, 'held');
  assert.equal(evidence.packs[0].terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(buybackCalls, 0, 'the provider mutation must never be reached for a non-COMPLETE open stage');
});

test('mutateBuyback holds a pack whose open-stage record names a different mint, with zero provider or signer effects', async () => {
  const wrongMint = Keypair.generate().publicKey.toBase58();
  const cycleRepository = repository({ stages: {
    'epic-gate': { status: 'COMPLETE', evidence: { packs: [sellDecisionPack()] } },
    open: { status: 'COMPLETE', evidence: { packs: [openedPack({ mint: wrongMint })] } },
  } });
  let buybackCalls = 0;
  const collectorCrypt = {
    async getBuybackAvailable() { throw new Error('must not be called'); },
    async buyback() { buybackCalls += 1; throw new Error('must not be called'); },
  };
  const rpc = rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }), cardAssetId: wrongMint });
  const evidence = await mutateBuyback({
    liveMode: true,
    adapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: { solana: { async sign() { throw new Error('must not sign'); } } },
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
    preflightAuthority: TEST_PROFILE_MUTATION_AUTHORITY,
  });
  assert.equal(evidence.packs[0].decision, 'held');
  assert.equal(evidence.packs[0].terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(buybackCalls, 0, 'the provider mutation must never be reached when the open-stage mint does not match the pack being sold');
});

test('mutateBuyback holds a pack whose open-stage record names a different memo, with zero provider or signer effects', async () => {
  const cycleRepository = repository({ stages: {
    'epic-gate': { status: 'COMPLETE', evidence: { packs: [sellDecisionPack()] } },
    open: { status: 'COMPLETE', evidence: { packs: [openedPack({ memo: 'a-different-memo' })] } },
  } });
  let buybackCalls = 0;
  const collectorCrypt = {
    async getBuybackAvailable() { throw new Error('must not be called'); },
    async buyback() { buybackCalls += 1; throw new Error('must not be called'); },
  };
  const rpc = rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) });
  const evidence = await mutateBuyback({
    liveMode: true,
    adapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: { solana: { async sign() { throw new Error('must not sign'); } } },
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
    preflightAuthority: TEST_PROFILE_MUTATION_AUTHORITY,
  });
  assert.equal(evidence.packs[0].decision, 'held');
  assert.equal(evidence.packs[0].terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(buybackCalls, 0, 'the provider mutation must never be reached when the open-stage memo does not match the pack being sold');
});

// `baseConfig()` alone never resolves a production binding (no `productionBindingRegistry`), so
// `resolvedBinding` stays `null` and the owner-refresh check inside `beforeSign` -- gated on
// `resolvedBinding !== null` -- is skipped entirely. A prior version of this regression used
// `baseConfig()` with a signer mock that unconditionally threw, so it only ever proved that any
// thrown sign/policy error resolves to "unknown" (already covered by the provisional-authority
// denial tests above), never that the refresh itself ran or observed the change. Both tests below
// instead resolve a real matching production binding (real isolated child setup, real candidate
// transaction built to that binding's own template) so the refresh path in `buyback.mjs` actually
// executes, and assert the exact reads/calls/non-calls it should produce.
test('mutateBuyback refuses to sign once the finalized owner refresh (bound to a real resolved production binding) observes a changed owner, with zero sign and zero submission calls', async () => {
  const outsider = Keypair.generate().publicKey.toBase58();
  const collectorProgramId = Keypair.generate().publicKey.toBase58();
  const collectorAuthority = Keypair.generate();
  const collectorRecipient = Keypair.generate().publicKey.toBase58();
  const proceedsSource = Keypair.generate().publicKey.toBase58();
  const binding = matchingBuybackBinding({ collectorProgramId, collectorRecipient, collectorAuthority: collectorAuthority.publicKey.toBase58(), proceedsSource });
  const registry = matchingBuybackRegistry(binding);
  const candidateTransactionBase64 = buildMatchingBuybackTransaction({
    collectorProgramId, collectorAuthority, collectorRecipient, proceedsSource, amountAtomic: '85',
  });

  const cycleRepository = repository({ stages: {
    'epic-gate': { status: 'COMPLETE', evidence: { packs: [sellDecisionPack()] } },
    open: { status: 'COMPLETE', evidence: { packs: [openedPack({ assetKind: 'mpl-core' })] } },
  } });
  // The first ownership read (before the provider call, inside `verifyFinalizedOwnership`) sees
  // the operator; every read after that -- the refresh inside `beforeSign`, which only runs once a
  // production binding actually resolved -- sees a changed owner, simulating the card moving away
  // during the provider/quote awaits.
  let ownershipReads = 0;
  const rpc = rpcClient({
    tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }),
    cardOwner: () => { ownershipReads += 1; return ownershipReads === 1 ? OPERATOR : outsider; },
  });
  const quote = { ...settlementAsset(), amountAtomic: '85' };
  let availableCalls = 0;
  let buybackCalls = 0;
  const collectorCrypt = {
    async getBuybackAvailable() { availableCalls += 1; return { available: true, amount: quote }; },
    async buyback() { buybackCalls += 1; return { memo: MEMO, refundAmount: quote, serializedTransaction: candidateTransactionBase64 }; },
    async submitTransaction() { throw new Error('must not submit once ownership changed'); },
  };
  let signCalls = 0;
  const evidence = await mutateBuyback({
    liveMode: true,
    adapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: { solana: { async sign() { signCalls += 1; throw new Error('must not sign once ownership changed'); } } },
    config: offlineBoundaryConfig(registry),
    cycleRepository,
    context: { cycleId: CYCLE_ID, assertLease: async () => {} },
    preflightAuthority: TEST_PROFILE_MUTATION_AUTHORITY,
  });
  assert.equal(evidence.packs[0].decision, 'unknown', 'an ownership change discovered only inside beforeSign is provider-ambiguous, not a definite hold');
  assert.equal(cycleRepository.heldPositions.length, 0);
  assert.equal(ownershipReads, 2, 'both the initial and the refreshed finalized-owner reads must actually happen');
  assert.equal(availableCalls, 2, 'the initial availability read and beforeSign\'s own quote refresh must both still happen before the owner refresh is reached');
  assert.equal(buybackCalls, 1, 'the provider buyback() mutation must still happen before the refresh can even be reached');
  assert.equal(signCalls, 0, 'signing must never be reached once the refreshed owner disagrees with the initial observation');
});

test('mutateBuyback reaches signing for the identical resolved production binding and candidate transaction when the finalized owner never changes', async () => {
  const collectorProgramId = Keypair.generate().publicKey.toBase58();
  const collectorAuthority = Keypair.generate();
  const collectorRecipient = Keypair.generate().publicKey.toBase58();
  const proceedsSource = Keypair.generate().publicKey.toBase58();
  const binding = matchingBuybackBinding({ collectorProgramId, collectorRecipient, collectorAuthority: collectorAuthority.publicKey.toBase58(), proceedsSource });
  const registry = matchingBuybackRegistry(binding);
  const candidateTransactionBase64 = buildMatchingBuybackTransaction({
    collectorProgramId, collectorAuthority, collectorRecipient, proceedsSource, amountAtomic: '85',
  });

  const cycleRepository = repository({ stages: {
    'epic-gate': { status: 'COMPLETE', evidence: { packs: [sellDecisionPack()] } },
    open: { status: 'COMPLETE', evidence: { packs: [openedPack({ assetKind: 'mpl-core' })] } },
  } });
  // Positive control for the regression above: the identical binding/setup/candidate transaction,
  // with the finalized owner reading the operator on every read (never changing), must actually
  // reach the signer -- proving the prior test's refusal comes from the ownership change, not from
  // some other mismatch in the binding/candidate/config this test reuses unchanged.
  const rpc = rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }), cardOwner: OPERATOR });
  const quote = { ...settlementAsset(), amountAtomic: '85' };
  let buybackCalls = 0;
  const collectorCrypt = {
    async getBuybackAvailable() { return { available: true, amount: quote }; },
    async buyback() { buybackCalls += 1; return { memo: MEMO, refundAmount: quote, serializedTransaction: candidateTransactionBase64 }; },
  };
  let signCalls = 0;
  const evidence = await mutateBuyback({
    liveMode: true,
    adapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: { solana: { async sign() { signCalls += 1; throw new Error('reached signing'); } } },
    config: offlineBoundaryConfig(registry),
    cycleRepository,
    context: { cycleId: CYCLE_ID, assertLease: async () => {} },
    preflightAuthority: TEST_PROFILE_MUTATION_AUTHORITY,
  });
  assert.equal(buybackCalls, 1);
  assert.equal(signCalls, 1, 'an unchanged finalized owner must let the identical candidate reach the signer');
  assert.equal(evidence.packs[0].decision, 'unknown', 'the deliberately thrown sign error still resolves as provider-ambiguous, not held');
});

test('mutateBuyback holds a pack whose resolved production binding proceeds asset does not match the configured settlement asset, with zero provider calls', async () => {
  const cycleRepository = repository({ stages: {
    'epic-gate': { status: 'COMPLETE', evidence: { packs: [sellDecisionPack()] } },
    open: { status: 'COMPLETE', evidence: { packs: [openedPack()] } },
  } });
  const rpc = rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) });
  let buybackCalls = 0;
  const collectorCrypt = {
    async getBuybackAvailable() { return { available: true, amount: { ...settlementAsset(), amountAtomic: '85' } }; },
    async buyback() { buybackCalls += 1; throw new Error('must not be called'); },
  };
  const evidence = await mutateBuyback({
    liveMode: true,
    adapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: { solana: { async sign() { throw new Error('must not sign'); } } },
    config: offlineBoundaryConfig(),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
    preflightAuthority: TEST_PROFILE_MUTATION_AUTHORITY,
  });
  assert.equal(evidence.packs[0].decision, 'held');
  assert.equal(evidence.packs[0].terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(cycleRepository.heldPositions.length, 1);
  assert.equal(buybackCalls, 0, 'the provider mutation must never be reached when the resolved binding proceeds asset disagrees with the configured settlement asset');
});

test('reconcileLiveBuyback confirms proceeds for a submitted sale and records the summed custody ledger', async () => {
  const submitted = { packIndex: 0, decision: 'submitted', memo: MEMO, mint: CARD_ASSET, signature: BUYBACK_SIGNATURE, quote: { ...settlementAsset(), amountAtomic: '85' }, refundAmount: { ...settlementAsset(), amountAtomic: '85' } };
  const cycleRepository = repository({
    stages: { open: { status: 'COMPLETE', evidence: { packs: [openedPack()] } } },
    attempts: { buyback: { attempt: { state: 'RESPONSE_RECORDED' }, responseEvidence: { packs: [submitted] }, reconciliationEvidence: null } },
  });
  const proceedsTokenAccount = deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58();
  const collectorCrypt = {
    async getBuybackCheck() {
      return { exists: true, status: 'complete', buybackAmount: 85, playerWallet: OPERATOR, nft: CARD_ASSET, transactionSignature: BUYBACK_SIGNATURE, createdAt: '2026-01-01T00:00:00.000Z' };
    },
  };
  const rpc = rpcClient({
    entries: [
      { tokenAccount: deriveAssociatedTokenAddress(OPERATOR, CARD_ASSET).toBase58(), owner: OPERATOR, mint: CARD_ASSET, preAmount: '1', postAmount: '0' },
      { tokenAccount: proceedsTokenAccount, owner: OPERATOR, mint: SETTLEMENT_ASSET, preAmount: '7', postAmount: '92' },
    ],
  });
  const reconciled = await reconcileLiveBuyback({
    adapters: { collectorCrypt, solana: { client: rpc } },
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
  });
  assert.equal(reconciled.soldCount, 1);
  assert.equal(reconciled.packs[0].decision, 'sold');
  assert.deepEqual(reconciled.packs[0].proceeds, { ...settlementAsset(), amountAtomic: '85' });
  assert.equal(cycleRepository.ledgers.length, 1);
  assert.equal(cycleRepository.ledgers[0].ledger.buybackProceeds, '85');
});

function seededCustodyLedger(cycleId) {
  return {
    schema: 'hookemon.custody-ledger.v1',
    cycleId,
    chainId: CHAIN_ID,
    assetId: SETTLEMENT_ASSET,
    decimals: CIRCLE_USD_DECIMALS,
    claimed: '500',
    bridgeOut: '12',
    bridgeIn: '0',
    packCost: '40',
    buybackProceeds: '0',
    returnInput: '0',
    returnReceived: '0',
    refunds: '0',
    residual: '3',
    heldAssets: '0',
    heldPositions: '0',
    payoutLiability: '0',
    dust: '0',
    unattributed: '0',
  };
}

async function seedRealSubmittedBuyback(repo, cycleId, submitted) {
  const attempt = createPreparedProviderMutationAttempt({
    cycleId,
    stage: 'buyback',
    requestDigest: `sha256:${'a'.repeat(64)}`,
  });
  await repo.prepareStageAttempt(cycleId, 'buyback', attempt);
  await repo.recordStageAttemptResponse(cycleId, 'buyback', { packs: [submitted] });
}

test('the real built-in buyback stage sums proceeds into an existing custody ledger row through the real stage-driver facade and repository, without erasing its other buckets', async t => {
  const { repository: repo, cycleId } = await durableCycle(t);
  await repo.recordCustodyLedger(cycleId, seededCustodyLedger(cycleId));

  const submitted = { packIndex: 0, decision: 'submitted', memo: MEMO, mint: CARD_ASSET, signature: BUYBACK_SIGNATURE, quote: { ...settlementAsset(), amountAtomic: '85' }, refundAmount: { ...settlementAsset(), amountAtomic: '85' } };
  await seedRealSubmittedBuyback(repo, cycleId, submitted);

  const proceedsTokenAccount = deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58();
  const collectorCrypt = {
    async getBuybackCheck() {
      return { exists: true, status: 'complete', buybackAmount: 85, playerWallet: OPERATOR, nft: CARD_ASSET, transactionSignature: BUYBACK_SIGNATURE, createdAt: '2026-01-01T00:00:00.000Z' };
    },
  };
  const rpc = rpcClient({
    entries: [
      { tokenAccount: deriveAssociatedTokenAddress(OPERATOR, CARD_ASSET).toBase58(), owner: OPERATOR, mint: CARD_ASSET, preAmount: '1', postAmount: '0' },
      { tokenAccount: proceedsTokenAccount, owner: OPERATOR, mint: SETTLEMENT_ASSET, preAmount: '7', postAmount: '92' },
    ],
  });

  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    reconciliationAdapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository: repo,
  });

  const reconciled = await driver.reconcile({ cycleId, stage: 'buyback' });
  assert.equal(reconciled.soldCount, 1);
  assert.equal(reconciled.packs[0].decision, 'sold');

  const state = await repo.describeCycle(cycleId);
  const [ledger] = [...state.custodyLedgers.values()];
  assert.equal(ledger.chainId, CHAIN_ID);
  assert.equal(ledger.assetId, SETTLEMENT_ASSET);
  // The proceeds bucket increments from its seeded value...
  assert.equal(ledger.buybackProceeds, '85');
  // ...while every other bucket this cycle already carried survives untouched.
  assert.equal(ledger.claimed, '500');
  assert.equal(ledger.bridgeOut, '12');
  assert.equal(ledger.packCost, '40');
  assert.equal(ledger.residual, '3');
  assert.equal((await repo.readOperationalStageAttempt(cycleId, 'buyback')).attempt.state, 'RECONCILED');
});

test('a lease lost immediately before the buyback custody-ledger write leaves the seeded ledger and attempt untouched', async t => {
  const { repository: repo, cycleId } = await durableCycle(t);
  await repo.recordCustodyLedger(cycleId, seededCustodyLedger(cycleId));

  const submitted = { packIndex: 0, decision: 'submitted', memo: MEMO, mint: CARD_ASSET, signature: BUYBACK_SIGNATURE, quote: { ...settlementAsset(), amountAtomic: '85' }, refundAmount: { ...settlementAsset(), amountAtomic: '85' } };
  await seedRealSubmittedBuyback(repo, cycleId, submitted);

  const proceedsTokenAccount = deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58();
  const collectorCrypt = {
    async getBuybackCheck() {
      return { exists: true, status: 'complete', buybackAmount: 85, playerWallet: OPERATOR, nft: CARD_ASSET, transactionSignature: BUYBACK_SIGNATURE, createdAt: '2026-01-01T00:00:00.000Z' };
    },
  };
  const rpc = rpcClient({
    entries: [
      { tokenAccount: deriveAssociatedTokenAddress(OPERATOR, CARD_ASSET).toBase58(), owner: OPERATOR, mint: CARD_ASSET, preAmount: '1', postAmount: '0' },
      { tokenAccount: proceedsTokenAccount, owner: OPERATOR, mint: SETTLEMENT_ASSET, preAmount: '7', postAmount: '92' },
    ],
  });

  const driver = createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    reconciliationAdapters: { collectorCrypt, solana: { client: rpc } },
    signerClient: null,
    config: baseConfig(),
    cycleRepository: repo,
  });

  const lost = new LeaseLostError('expired', { owner: 'cycle-runner', version: 1 });
  await assert.rejects(
    () => driver.reconcile({ cycleId, stage: 'buyback', assertLease() { throw lost; } }),
    LeaseLostError,
  );

  const state = await repo.describeCycle(cycleId);
  const [ledger] = [...state.custodyLedgers.values()];
  assert.equal(ledger.chainId, CHAIN_ID);
  assert.equal(ledger.assetId, SETTLEMENT_ASSET);
  assert.equal(ledger.buybackProceeds, '0');
  assert.equal(ledger.claimed, '500');
  assert.equal(ledger.bridgeOut, '12');
  assert.equal(ledger.packCost, '40');
  assert.equal(ledger.residual, '3');
  assert.equal((await repo.readOperationalStageAttempt(cycleId, 'buyback')).attempt.state, 'RESPONSE_RECORDED');
});

test('reconcileLiveBuyback resolves an "unknown" (ambiguous-mutation) pack to sold once Collector confirms it, and waits while Collector shows nothing yet', async () => {
  const unknown = { packIndex: 0, decision: 'unknown', memo: MEMO, mint: CARD_ASSET, quote: { ...settlementAsset(), amountAtomic: '85' } };
  const cycleRepository = repository({
    stages: { open: { status: 'COMPLETE', evidence: { packs: [openedPack()] } } },
    attempts: { buyback: { attempt: { state: 'RESPONSE_RECORDED' }, responseEvidence: { packs: [unknown] }, reconciliationEvidence: null } },
  });
  const proceedsTokenAccount = deriveAssociatedTokenAddress(OPERATOR, SETTLEMENT_ASSET).toBase58();
  const rpc = rpcClient({
    entries: [
      { tokenAccount: deriveAssociatedTokenAddress(OPERATOR, CARD_ASSET).toBase58(), owner: OPERATOR, mint: CARD_ASSET, preAmount: '1', postAmount: '0' },
      { tokenAccount: proceedsTokenAccount, owner: OPERATOR, mint: SETTLEMENT_ASSET, preAmount: '7', postAmount: '92' },
    ],
  });

  const stillPending = await reconcileLiveBuyback({
    adapters: { collectorCrypt: { async getBuybackCheck() { return { exists: false }; } }, solana: { client: rpc } },
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
  });
  assert.equal(stillPending, null);

  const reconciled = await reconcileLiveBuyback({
    adapters: {
      collectorCrypt: {
        async getBuybackCheck() {
          return { exists: true, status: 'complete', buybackAmount: 85, playerWallet: OPERATOR, nft: CARD_ASSET, transactionSignature: BUYBACK_SIGNATURE, createdAt: '2026-01-01T00:00:00.000Z' };
        },
      },
      solana: { client: rpc },
    },
    config: baseConfig(),
    cycleRepository,
    context: { cycleId: CYCLE_ID },
  });
  assert.equal(reconciled.soldCount, 1);
  assert.equal(reconciled.packs[0].decision, 'sold');
  assert.equal(reconciled.packs[0].signature, BUYBACK_SIGNATURE);
});

// --- durable, end-to-end restart safety ---------------------------------------------------------

test('a held open pack survives a repository reopen without terminalizing the cycle', async t => {
  const { directory, repository: repo, cycleId } = await durableCycle(t);
  await completeThroughOpen(repo, cycleId, [{ packIndex: 0, memo: MEMO, mint: null, decision: 'held', terminalState: 'HELD_DATA_UNVERIFIED', reason: 'DATA_UNVERIFIED', heldPosition: { positionId: 'held:1', evidenceDigest: `sha256:${'a'.repeat(64)}`, terminalState: 'HELD_DATA_UNVERIFIED', reason: 'DATA_UNVERIFIED' } }]);

  const reopened = await CycleRepository.open(directory);
  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.terminalState, null);
  assert.equal(state.stages.get('open').status, 'COMPLETE');
});

// --- governance failure-matrix citations (docs/audit/2026-09-04/failure-matrix.json) -----------
// These five scenarios are cited by name from the documented failure matrix; renaming them
// breaks packages/runner/test/cycle/failure-matrix.test.mjs's binding to an executed test.

test('open response missing its memo-bound mint holds durably without a retry', async t => {
  const { directory, repository: repo, cycleId } = await durableCycle(t);
  for (const [stage, evidence] of [
    ['eligibility-snapshot', { source: 'durable-test' }],
    ['claim-process', { source: 'durable-test' }],
    ['outbound', { source: 'durable-test' }],
    ['purchase', { quantity: 1, packs: [{ packIndex: 0, memo: MEMO, status: 'purchased', expectedCardCount: 1 }], purchasedCount: 1 }],
  ]) {
    await repo.prepareStage(cycleId, stage);
    await repo.completeStage(cycleId, stage, evidence);
  }
  await repo.recordPackBatchIntent(cycleId, 'purchase', { quantity: 1, packType: null, expectedCardCountPerPack: 1, playerAddress: OPERATOR });

  const request = { provider: 'collector-crypt', operation: 'open', packs: [{ packIndex: 0, memo: MEMO, expectedCardCount: 1 }] };
  await repo.prepareStageAttempt(cycleId, 'open', createPreparedProviderMutationAttempt({
    cycleId, stage: 'open',
    requestDigest: digest({ schema: 'hookemon.operational-stage-request.v1', cycleId, stage: 'open', request }),
  }));
  await repo.recordStageAttemptResponse(cycleId, 'open', {
    packs: [{ packIndex: 0, memo: MEMO, opened: { transactionSignature: 'open-signature-recorded', nft_address: CARD_ASSET } }],
  });
  let statusReads = 0;

  const result = await reconcileLiveOpen({
    adapters: {
      collectorCrypt: { async getPackStatus() { statusReads += 1; return { memo: MEMO, pack: {}, send: null, buyback: [] }; } },
      solana: { client: rpcClient() },
    },
    config: baseConfig(),
    cycleRepository: repo,
    context: { cycleId },
  });
  assert.equal(result.packs[0].decision, 'held');
  assert.equal(statusReads, 1);

  const reopened = await CycleRepository.open(directory);
  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.terminalState, null);
  assert.equal(state.heldPositions.size, 1);
  assert.equal((await reopened.readOperationalStageAttempt(cycleId, 'open')).attempt.state, 'RESPONSE_RECORDED');
  await assert.doesNotReject(() => reopened.prepareStage(cycleId, 'open'));
});

test('open SENT_UNKNOWN retry missing mint holds durably after reopen', async t => {
  const { directory, repository: repo, cycleId } = await durableCycle(t);
  for (const [stage, evidence] of [
    ['eligibility-snapshot', { source: 'durable-test' }],
    ['claim-process', { source: 'durable-test' }],
    ['outbound', { source: 'durable-test' }],
    ['purchase', { quantity: 1, packs: [{ packIndex: 0, memo: MEMO, status: 'purchased', expectedCardCount: 1 }], purchasedCount: 1 }],
  ]) {
    await repo.prepareStage(cycleId, stage);
    await repo.completeStage(cycleId, stage, evidence);
  }
  await repo.recordPackBatchIntent(cycleId, 'purchase', { quantity: 1, packType: null, expectedCardCountPerPack: 1, playerAddress: OPERATOR });
  const request = { provider: 'collector-crypt', operation: 'open', packs: [{ packIndex: 0, memo: MEMO, expectedCardCount: 1 }] };
  await repo.prepareStageAttempt(cycleId, 'open', createPreparedProviderMutationAttempt({
    cycleId, stage: 'open',
    requestDigest: digest({ schema: 'hookemon.operational-stage-request.v1', cycleId, stage: 'open', request }),
  }));
  await repo.markStageAttemptSentUnknown(cycleId, 'open');
  let openCalls = 0;

  const result = await reconcileLiveOpen({
    adapters: {
      collectorCrypt: {
        async getPackStatus() {
          return { memo: MEMO, pack: {}, send: { transaction_signature: 'open-sig', to_wallet: OPERATOR }, buyback: [] };
        },
        async openPack() { openCalls += 1; throw new Error('SENT_UNKNOWN reconciliation must not resubmit openPack'); },
      },
      solana: { client: rpcClient() },
    },
    config: baseConfig(),
    cycleRepository: repo,
    context: { cycleId, fencingToken: 'fence-1', assertLease() {}, async assertMutationAllowed() {} },
  });
  assert.equal(result.packs[0].decision, 'held');
  assert.equal(openCalls, 0);

  const reopened = await CycleRepository.open(directory);
  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.terminalState, null);
  assert.equal(state.heldPositions.size, 1);
  assert.equal((await reopened.readOperationalStageAttempt(cycleId, 'open')).attempt.state, 'SENT_UNKNOWN');
  await assert.doesNotReject(() => reopened.prepareStage(cycleId, 'open'));
});

test('keeps a forty-percent epic equality sellable after a real repository reopen', async t => {
  const { directory, repository: repo, cycleId } = await durableCycle(t);
  const offer = { ...settlementAsset(), amountAtomic: '40' };
  const insuredValue = { ...settlementAsset(), amountAtomic: '100' };
  for (const [stage, evidence] of [
    ['eligibility-snapshot', { source: 'durable-test' }],
    ['claim-process', { source: 'durable-test' }],
    ['outbound', { source: 'durable-test' }],
    ['purchase', { quantity: 1, packs: [{ packIndex: 0, memo: MEMO, status: 'purchased', expectedCardCount: 1, packCost: { ...settlementAsset(), amountAtomic: '40' } }], purchasedCount: 1 }],
    ['open', { memo: MEMO, mint: CARD_ASSET, offer, insuredValue }],
  ]) {
    await repo.prepareStage(cycleId, stage);
    await repo.completeStage(cycleId, stage, evidence);
  }

  const outcome = await probeEpicGate({ cycleRepository: repo, context: { cycleId } });
  assert.equal(outcome.belowFortyPercent, false);
  assert.equal(outcome.nextAction, 'sell');

  const reopened = await CycleRepository.open(directory);
  assert.equal((await reopened.describeCycle(cycleId)).terminalState, null);
  assert.deepEqual(await reopened.readStage(cycleId, 'open'), {
    status: 'COMPLETE',
    evidence: { memo: MEMO, mint: CARD_ASSET, offer, insuredValue },
  });
  assert.equal((await reopened.prepareStage(cycleId, 'epic-gate')).status, 'PREPARED');
});

test('records unavailable buyback as a durable held position without terminalizing the cycle', async t => {
  const { directory, repository: cycleRepository, cycleId } = await durableCycle(t);
  for (const [stage, evidence] of [
    ['eligibility-snapshot', { source: 'durable-test' }],
    ['claim-process', { source: 'durable-test' }],
    ['outbound', { source: 'durable-test' }],
    ['purchase', { quantity: 1, packs: [{ packIndex: 0, memo: MEMO, status: 'purchased', expectedCardCount: 1, packCost: { ...settlementAsset(), amountAtomic: '40' } }], purchasedCount: 1 }],
    ['open', { packs: [openedPack()] }],
    ['epic-gate', { packs: [sellDecisionPack()] }],
  ]) {
    await cycleRepository.prepareStage(cycleId, stage);
    await cycleRepository.completeStage(cycleId, stage, evidence);
  }
  let buybackCalls = 0;
  let signCalls = 0;
  const result = await mutateBuyback({
    liveMode: true,
    adapters: {
      collectorCrypt: {
        async getBuybackAvailable() { return { available: false }; },
        async buyback() { buybackCalls += 1; throw new Error('buyback provider must not run'); },
      },
      solana: { client: rpcClient({ tokenAccount: tokenAccountResponse({ mint: SETTLEMENT_ASSET }) }) },
    },
    signerClient: { solana: { async sign() { signCalls += 1; throw new Error('signer must not run'); } } },
    config: baseConfig({ collectorCrypt: { settlementAsset: settlementAsset() } }),
    cycleRepository,
    context: { cycleId },
  });

  assert.equal(result.packs[0].terminalState, 'HELD_UNAVAILABLE');
  assert.equal(buybackCalls, 0);
  assert.equal(signCalls, 0);
  const reopened = await CycleRepository.open(directory);
  const state = await reopened.describeCycle(cycleId);
  assert.equal(state.terminalState, null);
  assert.equal(state.heldPositions.size, 1);
  assert.equal([...state.heldPositions.values()][0].terminalState, 'HELD_UNAVAILABLE');
  assert.equal(await reopened.readOperationalStageAttempt(cycleId, 'buyback'), null);
  assert.equal((await reopened.prepareStage(cycleId, 'buyback')).status, 'PREPARED');
});

test('carves an overdue SENT_UNKNOWN buyback into a held position without another provider call', async () => {
  const cycleRepository = repository({
    stages: { open: { status: 'COMPLETE', evidence: { mint: CARD_ASSET, memo: MEMO } } },
    attempts: {
      buyback: { attempt: { state: 'SENT_UNKNOWN' }, sentAtMs: 1_700_000_000_000, responseEvidence: null, reconciliationEvidence: null },
    },
  });

  const evidence = await reconcileLiveBuyback({
    adapters: {},
    config: baseConfig({ unresolvedCardDeadlineMinutes: 30 }),
    cycleRepository,
    context: { cycleId: CYCLE_ID, nowMs: 1_700_001_800_000 },
  });

  assert.deepEqual(evidence, {
    memo: MEMO,
    expectedCardCount: 1,
    mint: CARD_ASSET,
    decision: 'held',
    terminalState: 'HELD_UNRESOLVED',
    reason: 'SENT_UNKNOWN_DEADLINE',
    heldPosition: {
      positionId: 'held:test:1',
      evidenceDigest: `sha256:${'a'.repeat(64)}`,
      terminalState: 'HELD_UNRESOLVED',
      reason: 'SENT_UNKNOWN_DEADLINE',
    },
  });
  assert.equal(cycleRepository.held.length, 1);
  assert.equal(cycleRepository.heldPositions[0].costMicroUsdg, '40');
});
