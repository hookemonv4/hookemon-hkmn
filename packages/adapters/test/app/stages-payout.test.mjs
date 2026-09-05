import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  encodeFunctionData,
  keccak256,
  TransactionNotFoundError,
  TransactionReceiptNotFoundError,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  compileDirectPayoutPlan,
  createUsdgPayoutAmount,
  directPayoutPlanDigest,
} from '../../../runner/src/distribution/payout-plan.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { ERC20_TRANSFER_TOPIC } from '../../src/robinhood-rpc.mjs';
import { wrapSignerClient, wrapTransactionPolicySignerClient } from '../../src/signing/signer-client.mjs';
import {
  advanceDirectPayout,
  assertPayoutManifestUnchanged,
  buildDirectPayoutTransaction,
  createCycleRepositoryPayoutStore,
  createDirectPayoutState,
  DirectPayoutNonceInterferenceError,
  initializeDirectPayout,
  isDirectPayoutComplete,
  mutatePayout,
  preparePayoutRequest,
  reconcileLivePayout,
  replaceDirectPayout,
} from '../../src/app/stages/payout.mjs';
import * as payoutStage from '../../src/app/stages/payout.mjs';
import { digest as canonicalDigest } from '../../../runner/src/cycle/journal.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';

const TOKEN = `0x${'a'.repeat(40)}`;
const PRIVATE_KEY = `0x${'1'.repeat(64)}`;
const ACCOUNT = privateKeyToAccount(PRIVATE_KEY);
const OPERATIONS = ACCOUNT.address.toLowerCase();
const RECIPIENT_A = `0x${'2'.repeat(40)}`;
const RECIPIENT_B = `0x${'3'.repeat(40)}`;
const RETURN_BINDING = Object.freeze({
  operations: OPERATIONS,
  usdgAddress: TOKEN,
  evidenceDigest: `sha256:${'9'.repeat(64)}`,
});
const ERC20_TRANSFER_ABI = [{
  type: 'function',
  name: 'transfer',
  stateMutability: 'nonpayable',
  inputs: [
    { name: 'to', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  outputs: [{ name: 'ok', type: 'bool' }],
}];
const TOKEN_METADATA = Object.freeze({ [TOKEN]: Object.freeze({ assetId: TOKEN, decimals: 6 }) });
const FIXTURE_SIGNER_OPTIONS = Object.freeze({ preflightAuthority: createTestProfileMutationAuthority() });

function policyTransaction({ recipient, amountAtomic, nonce = '0', gasPriceWei = '2' }) {
  return {
    chainId: 4663,
    nonce: BigInt(nonce),
    from: OPERATIONS,
    to: TOKEN,
    data: encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: 'transfer',
      args: [recipient, BigInt(amountAtomic)],
    }),
    value: 0n,
    gas: 50_000n,
    gasPrice: BigInt(gasPriceWei),
  };
}

function usdg(amountAtomic) {
  return createUsdgPayoutAmount({ assetId: TOKEN, amountAtomic: String(amountAtomic) });
}

function addressTopic(address) {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function payoutManifest(entries = [
  { recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '2' } },
  { recipient: RECIPIENT_B, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } },
], cycleId = 'cycle-direct-payout-1') {
  const total = entries.reduce((sum, entry) => sum + BigInt(entry.hkmnBalance.amountAtomic), 0n).toString();
  const estimatedNativeFee = (BigInt(entries.length) * 250_000n).toString();
  const requiredNativeAmount = (BigInt(estimatedNativeFee) + 10n).toString();
  const manifest = {
    schema: 'hookemon.eligibility-payout-manifest.v1',
    cycleId,
    snapshotBlock: '12',
    snapshotHash: `0x${'b'.repeat(64)}`,
    finality: { policyId: 'robinhood-stage-finality-v1', depth: '2' },
    supply: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: total },
    entries,
    exclusions: [],
    feasibility: {
      recipientCount: entries.length,
      transactionCount: entries.length,
      maxRecipientCount: entries.length,
      maxTransactionCount: entries.length,
      measuredTransferGas: '50000',
      maxGasPriceWei: '5',
      estimatedNativeFee: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: estimatedNativeFee },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '10' },
      nativeBalance: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: requiredNativeAmount },
      requiredNativeAmount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: requiredNativeAmount },
      feasible: true,
      reason: null,
    },
    logCompleteness: {
      mode: 'single-source-explicitly-allowed',
      primary: { sourceId: 'primary', transferLogDigest: `sha256:${'c'.repeat(64)}`, logCount: entries.length },
      secondary: null,
    },
    holderSnapshotDigest: `sha256:${'d'.repeat(64)}`,
    launchManifestDigest: `sha256:${'e'.repeat(64)}`,
  };
  return manifest;
}

function payoutPlan(entries, returnAmountAtomic = '9', cycleId = 'cycle-direct-payout-1') {
  const manifest = payoutManifest(entries, cycleId);
  return compileDirectPayoutPlan({
    cycleId: manifest.cycleId,
    eligibilityManifest: manifest,
    finalizedReturn: usdg(returnAmountAtomic),
    previousDust: usdg('0'),
    returnBinding: RETURN_BINDING,
  });
}

async function durableCycle(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-direct-payout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  return { directory, repository, cycleId };
}

function custodyLedger(cycleId, returnReceived) {
  return {
    schema: 'hookemon.custody-ledger.v1',
    cycleId,
    chainId: '4663',
    assetId: TOKEN,
    decimals: 6,
    claimed: '0',
    bridgeOut: '0',
    bridgeIn: '0',
    packCost: '0',
    buybackProceeds: '0',
    returnInput: '0',
    returnReceived,
    refunds: '0',
    residual: '0',
    heldAssets: '0',
    payoutLiability: '0',
    dust: '0',
    unattributed: '0',
  };
}

function repository(initial = null) {
  let current = initial === null ? null : structuredClone(initial);
  let throwAfterPersist = false;
  let throwBeforePersistWhen = null;
  const writes = [];
  return {
    writes,
    failAfterNextPersist() { throwAfterPersist = true; },
    failBeforePersistWhen(predicate) { throwBeforePersistWhen = predicate; },
    async load() { return current === null ? null : structuredClone(current); },
    async persist(value) {
      if (throwBeforePersistWhen?.(value)) {
        throwBeforePersistWhen = null;
        throw new Error('injected crash before durable persist');
      }
      current = structuredClone(value);
      writes.push(structuredClone(value));
      if (throwAfterPersist) {
        throwAfterPersist = false;
        throw new Error('injected crash after durable persist');
      }
    },
  };
}

function custodyRepository(reservations = []) {
  return {
    reservations,
    async reservePayoutQuarantine(cycleId, input) {
      reservations.push({ cycleId, input });
    },
  };
}

function transferLog({ recipient, amountAtomic }) {
  return {
    address: TOKEN,
    topics: [ERC20_TRANSFER_TOPIC, addressTopic(OPERATIONS), addressTopic(recipient)],
    data: `0x${BigInt(amountAtomic).toString(16).padStart(64, '0')}`,
    logIndex: '0',
  };
}

function rpc({ frozen = new Set(), nonce = 0n, balance = 1_000_000n, receiptForHash = null } = {}) {
  const broadcasts = [];
  let observedReceipt = null;
  let receiptResolver = receiptForHash;
  let observedNonce = nonce;
  const client = {
    broadcasts,
    async readContract({ functionName, args }) {
      assert.equal(functionName, 'isFrozen');
      return frozen.has(args[0].toLowerCase());
    },
    async getTransactionCount() { return observedNonce; },
    async getBalance() { return balance; },
    async sendRawTransaction({ serializedTransaction }) {
      broadcasts.push(serializedTransaction);
      return { transactionHash: `0x${'0'.repeat(64)}` };
    },
    setReceiptResolver(resolver) { receiptResolver = resolver; },
    setNonce(value) { observedNonce = BigInt(value); },
    async getTransactionReceipt({ hash }) {
      const value = await receiptResolver?.(hash);
      if (!value) throw new TransactionReceiptNotFoundError({ hash });
      observedReceipt = {
        ...value,
        blockHash: value.blockHash ?? `0x${'f'.repeat(64)}`,
      };
      return observedReceipt;
    },
    async getBlock({ blockNumber } = {}) {
      if (blockNumber === 99n) return { number: 99n, hash: `0x${'e'.repeat(64)}`, timestamp: 1_700_000_000n };
      if (blockNumber === 100n) return { number: 100n, hash: `0x${'f'.repeat(64)}`, parentHash: `0x${'e'.repeat(64)}`, timestamp: 1_700_000_012n };
      return { number: 100n, hash: `0x${'f'.repeat(64)}`, parentHash: `0x${'e'.repeat(64)}`, timestamp: 1_700_000_012n };
    },
  };
  client.historicalEvidenceClient = {
    async readErc20BalanceAtBlock({ account, blockNumber, blockHash }) {
      const transfer = observedReceipt?.logs?.[0] ?? null;
      const amountAtomic = transfer ? BigInt(transfer.data) : 0n;
      const value = account.toLowerCase() === OPERATIONS
        ? (blockNumber === 99n ? 1_000_000n : 1_000_000n - amountAtomic)
        : (blockNumber === 99n ? 0n : amountAtomic);
      return { value, blockNumber, blockHash };
    },
  };
  return client;
}

function signer(counter, { uppercaseRawBytes = false, policy = null } = {}) {
  if (counter.signerClient) return counter.signerClient;
  const client = wrapSignerClient({
    role: 'operator-evm',
    liveMode: true,
    ...FIXTURE_SIGNER_OPTIONS,
    inner: {
      async sign({ transaction }) {
        counter.sign += 1;
        const signingTransaction = { ...transaction };
        for (const field of ['nonce', 'value', 'gas', 'gasPrice']) {
          signingTransaction[field] = BigInt(signingTransaction[field]);
        }
        const signedTx = await ACCOUNT.signTransaction(signingTransaction);
        counter.signedTransactions ??= [];
        counter.signedTransactions.push(signedTx);
        return {
          signedTx: uppercaseRawBytes
            ? `0x${signedTx.slice(2).toUpperCase()}`
            : signedTx,
        };
      },
      async broadcast({ signedTx }) {
        counter.broadcasts ??= [];
        counter.broadcasts.push(signedTx);
        return { transactionHash: keccak256(signedTx) };
      },
    },
  });
  const evm = policy === null
    ? client
    : wrapTransactionPolicySignerClient({
      client,
      policy,
      decodeOptions: { family: 'evm', tokenMetadata: TOKEN_METADATA },
      async broadcast({ signedTx }) {
        counter.broadcasts ??= [];
        counter.broadcasts.push(signedTx);
        return { transactionHash: keccak256(signedTx) };
      },
    });
  counter.signerClient = { evm };
  return counter.signerClient;
}

function rawOperationsSigner(counter) {
  return {
    evm: wrapSignerClient({
      role: 'operator-evm',
      liveMode: true,
      ...FIXTURE_SIGNER_OPTIONS,
      inner: {
        async sign({ transaction }) {
          counter.sign += 1;
          const signingTransaction = { ...transaction };
          for (const field of ['nonce', 'value', 'gas', 'gasPrice']) {
            signingTransaction[field] = BigInt(signingTransaction[field]);
          }
          return { signedTx: await ACCOUNT.signTransaction(signingTransaction) };
        },
        async broadcast({ signedTx }) {
          counter.broadcasts ??= [];
          counter.broadcasts.push(signedTx);
          return { transactionHash: keccak256(signedTx) };
        },
      },
    }),
  };
}

function config() {
  const usdg = { chainId: '4663', assetId: TOKEN, decimals: 6 };
  const solanaStablecoin = {
    chainId: '792703809',
    assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
  };
  return {
    chainId: 4663,
    accounts: { evm: OPERATIONS },
    contracts: { usdg: TOKEN },
    moneyConfiguration: {
      schema: 'hookemon.money-configuration.v1',
      assets: { usdg, solanaStablecoin },
      minimums: {
        robinhoodReceive: { ...usdg, amountAtomic: '0' },
        solanaReceive: { ...solanaStablecoin, amountAtomic: '0' },
        returnUsdg: { ...usdg, amountAtomic: '0' },
      },
      evm: {
        perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '5' },
        nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '10' },
      },
      solana: {
        priorityFeeCap: { chainId: '792703809', assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '2' },
        lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '2' },
      },
    },
  };
}

function productionPayoutConfig() {
  const usdg = { chainId: '4663', assetId: TOKEN, decimals: 6 };
  const solanaStablecoin = {
    chainId: '792703809',
    assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
  };
  return {
    ...config(),
    moneyConfiguration: {
      schema: 'hookemon.money-configuration.v1',
      assets: { usdg, solanaStablecoin },
      minimums: {
        robinhoodReceive: { ...usdg, amountAtomic: '0' },
        solanaReceive: { ...solanaStablecoin, amountAtomic: '0' },
        returnUsdg: { ...usdg, amountAtomic: '0' },
      },
      evm: {
        perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '5' },
        nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '10' },
      },
      solana: {
        priorityFeeCap: {
          chainId: '792703809',
          assetId: 'microlamports-per-compute-unit',
          decimals: 0,
          amountAtomic: '2',
        },
        lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '2' },
      },
    },
  };
}

async function initialized({ plan = payoutPlan(), store = repository() } = {}) {
  await initializeDirectPayout({
    payoutStore: store,
    plan,
    operations: OPERATIONS,
    usdgAddress: TOKEN,
    firstNonce: '0',
    gasPriceWei: '2',
  });
  return { plan, store };
}

test('stores payout state through the repository paged-payout API', async () => {
  let stored = null;
  const reads = [];
  const writes = [];
  const cycleRepository = {
    async readPagedPayoutState(cycleId, stage) {
      reads.push({ cycleId, stage });
      return stored === null ? null : structuredClone(stored);
    },
    async persistPagedPayoutState(cycleId, stage, state) {
      writes.push({ cycleId, stage, state: structuredClone(state) });
      stored = structuredClone(state);
    },
  };
  const payoutStore = createCycleRepositoryPayoutStore({
    cycleRepository,
    cycleId: 'cycle-direct-payout-1',
  });
  const state = createDirectPayoutState({
    plan: payoutPlan(),
    operations: OPERATIONS,
    usdgAddress: TOKEN,
    firstNonce: '0',
    gasPriceWei: '2',
  });

  await payoutStore.persist(state);
  assert.deepEqual(await payoutStore.load(), state);
  assert.deepEqual(reads, [{ cycleId: 'cycle-direct-payout-1', stage: 'payout' }]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].cycleId, 'cycle-direct-payout-1');
  assert.equal(writes[0].stage, 'payout');
});

test('initializes direct payout through atomic paged dust persistence', async () => {
  const plan = payoutPlan();
  const context = {
    cycleId: plan.cycleId,
    requestDigest: `sha256:${'b'.repeat(64)}`,
    fencingToken: 'payout-fence-atomic-1',
  };
  let stored = null;
  const custodyLedgers = new Map();
  const atomicWrites = [];
  const recoveryContexts = [];
  const walletReservations = [];
  const cycleRepository = {
    async readPagedPayoutState() { return stored === null ? null : structuredClone(stored); },
    async persistPagedPayoutState(_cycleId, _stage, state) { stored = structuredClone(state); },
    async consumePayoutDustAndPersistPagedPayoutState(cycleId, input) {
      atomicWrites.push({ cycleId, input: structuredClone(input) });
      stored = structuredClone(input.evidence);
      return { evidence: structuredClone(stored), consumption: null };
    },
    async describeCycle() { return { custodyLedgers: new Map(custodyLedgers) }; },
    async recordCustodyLedger(_cycleId, ledger) {
      custodyLedgers.set(`${ledger.chainId}\u0000${ledger.assetId}`, ledger);
    },
    async persistChainAttemptRecoveryContext(_cycleId, recoveryContext) {
      recoveryContexts.push(structuredClone(recoveryContext));
    },
    async readChainAttemptRecoveryContext(_cycleId, selector) {
      return structuredClone(recoveryContexts.find(context => context.requestDigest === selector.requestDigest
        && context.rawSignedBytesHash === selector.rawSignedBytesHash) ?? null);
    },
    async reserveWalletNonce(cycleId, reservation) {
      walletReservations.push(['reserve', cycleId, structuredClone(reservation)]);
    },
    async assertWalletNonce(cycleId, reservation) {
      walletReservations.push(['assert', cycleId, structuredClone(reservation)]);
    },
  };
  const counter = { sign: 0 };
  const result = await mutatePayout({
    liveMode: true,
    config: productionPayoutConfig(),
    cycleRepository,
    context,
    request: { plan },
    adapters: { robinhood: { client: rpc() } },
    signerClient: signer(counter),
  });

  assert.equal(result, undefined);
  assert.equal(atomicWrites.length, 1);
  assert.equal(atomicWrites[0].cycleId, plan.cycleId);
  assert.equal(atomicWrites[0].input.stage, 'payout');
  assert.equal(atomicWrites[0].input.planDigest, plan.planDigest);
  assert.equal(recoveryContexts.length, 0);
  assert.notEqual(stored.recipients[0].approvalContext, null);
  assert.equal(walletReservations.length > 0, true);
  assert.equal(walletReservations[0][0], 'reserve');
  assert.equal(walletReservations[0][1], plan.cycleId);
  assert.deepEqual(walletReservations[0][2], {
    chainId: '4663',
    wallet: OPERATIONS,
    stage: 'payout',
    fencingToken: context.fencingToken,
    leaseAcquiredAtMs: 0,
    leaseExpiresAtMs: Number.MAX_SAFE_INTEGER,
  });
  assert.equal(walletReservations.some(([kind]) => kind === 'assert'), true);
});

test('repairs a reopened paged payout published before predecessor dust consumption before signing', async () => {
  const plan = payoutPlan();
  const context = {
    cycleId: plan.cycleId,
    requestDigest: `sha256:${'b'.repeat(64)}`,
    fencingToken: 'payout-fence-recover-pages-1',
  };
  const events = [];
  let stored = createDirectPayoutState({
    plan,
    operations: OPERATIONS,
    usdgAddress: TOKEN,
    firstNonce: '0',
    gasPriceWei: '2',
  });
  let attempt = null;
  const custodyLedgers = new Map();
  const recoveryContexts = [];
  const cycleRepository = {
    async readPagedPayoutState() { return structuredClone(stored); },
    async persistPagedPayoutState(_cycleId, _stage, state) { stored = structuredClone(state); },
    async readStageAttempt() { return attempt === null ? null : structuredClone(attempt); },
    async consumePayoutDustAndPersistPagedPayoutState(_cycleId, input) {
      events.push('recover-predecessor-dust');
      stored = structuredClone(input.evidence);
      attempt = {
        schema: 'hookemon.paged-payout-state-reference.v1',
        stage: 'payout',
        planDigest: input.planDigest,
      };
      return { evidence: structuredClone(stored), consumption: null };
    },
    async describeCycle() { return { custodyLedgers: new Map(custodyLedgers) }; },
    async recordCustodyLedger(_cycleId, ledger) {
      custodyLedgers.set(`${ledger.chainId}\u0000${ledger.assetId}`, ledger);
    },
    async persistChainAttemptRecoveryContext(_cycleId, recoveryContext) {
      recoveryContexts.push(structuredClone(recoveryContext));
    },
    async readChainAttemptRecoveryContext(_cycleId, selector) {
      return structuredClone(recoveryContexts.find(value => value.requestDigest === selector.requestDigest
        && value.rawSignedBytesHash === selector.rawSignedBytesHash) ?? null);
    },
    async reserveWalletNonce() {},
    async assertWalletNonce() {},
  };
  let signCount = 0;
  const counter = { broadcasts: [] };
  Object.defineProperty(counter, 'sign', {
    enumerable: true,
    get: () => signCount,
    set: value => {
      signCount = value;
      events.push('sign');
    },
  });

  await mutatePayout({
    liveMode: true,
    config: productionPayoutConfig(),
    cycleRepository,
    context,
    request: { plan },
    adapters: { robinhood: { client: rpc() } },
    signerClient: signer(counter),
  });

  assert.deepEqual(events.slice(0, 2), ['recover-predecessor-dust', 'sign']);
  assert.deepEqual(attempt, {
    schema: 'hookemon.paged-payout-state-reference.v1',
    stage: 'payout',
    planDigest: plan.planDigest,
  });
});

test('composes a direct payout policy signer from the durable recipient transaction', async () => {
  assert.equal(typeof payoutStage.createDirectPayoutPolicySigner, 'function');
  const plan = payoutPlan();
  const context = {
    cycleId: plan.cycleId,
    requestDigest: `sha256:${'b'.repeat(64)}`,
    fencingToken: 'payout-fence-policy-composition-1',
  };
  let stored = null;
  const custodyLedgers = new Map();
  const recoveryContexts = [];
  const cycleRepository = {
    async readPagedPayoutState() { return stored === null ? null : structuredClone(stored); },
    async persistPagedPayoutState(_cycleId, _stage, state) { stored = structuredClone(state); },
    async consumePayoutDustAndPersistPagedPayoutState(_cycleId, input) {
      stored = structuredClone(input.evidence);
      return { evidence: structuredClone(stored), consumption: null };
    },
    async describeCycle() { return { custodyLedgers: new Map(custodyLedgers) }; },
    async recordCustodyLedger(_cycleId, ledger) {
      custodyLedgers.set(`${ledger.chainId}\u0000${ledger.assetId}`, ledger);
    },
    async persistChainAttemptRecoveryContext(_cycleId, recoveryContext) {
      recoveryContexts.push(structuredClone(recoveryContext));
    },
    async readChainAttemptRecoveryContext() {
      return recoveryContexts.length === 0 ? null : structuredClone(recoveryContexts.at(-1));
    },
    async reserveWalletNonce() {},
    async assertWalletNonce() {},
  };
  const counter = { sign: 0 };

  const result = await mutatePayout({
    liveMode: true,
    config: productionPayoutConfig(),
    cycleRepository,
    context,
    request: { plan },
    adapters: { robinhood: { client: rpc() } },
    signerClient: rawOperationsSigner(counter),
  });

  assert.equal(result, undefined);
  assert.equal(counter.sign, 1);
  assert.equal(counter.broadcasts.length, 1);
  const state = await cycleRepository.readPagedPayoutState();
  assert.equal(state.recipients[0].state, 'BROADCAST');
  assert.equal(recoveryContexts.length, 0);
  assert.notEqual(state.recipients[0].approvalContext, null);
  const transaction = buildDirectPayoutTransaction({ state, recipient: RECIPIENT_A });
  assert.equal(transaction.chainId, 4663);
  assert.equal(transaction.nonce, '0');
  assert.equal(transaction.from, OPERATIONS);
  assert.equal(transaction.to, TOKEN);
  assert.equal(transaction.gasPrice, '5');
});

test('derives the exact payout policy instead of trusting an injected branded signer', async () => {
  const plan = payoutPlan();
  const context = {
    cycleId: plan.cycleId,
    requestDigest: `sha256:${'b'.repeat(64)}`,
    fencingToken: 'payout-fence-local-policy-1',
  };
  let stored = null;
  const recoveryContexts = [];
  const custodyLedgers = new Map();
  const cycleRepository = {
    async readPagedPayoutState() { return stored === null ? null : structuredClone(stored); },
    async persistPagedPayoutState(_cycleId, _stage, state) { stored = structuredClone(state); },
    async consumePayoutDustAndPersistPagedPayoutState(_cycleId, input) {
      stored = structuredClone(input.evidence);
      return { evidence: structuredClone(stored), consumption: null };
    },
    async describeCycle() { return { custodyLedgers: new Map(custodyLedgers) }; },
    async recordCustodyLedger(_cycleId, ledger) {
      custodyLedgers.set(`${ledger.chainId}\u0000${ledger.assetId}`, ledger);
    },
    async persistChainAttemptRecoveryContext(_cycleId, recoveryContext) {
      recoveryContexts.push(structuredClone(recoveryContext));
    },
    async readChainAttemptRecoveryContext() {
      return recoveryContexts.length === 0 ? null : structuredClone(recoveryContexts.at(-1));
    },
    async reserveWalletNonce() {},
    async assertWalletNonce() {},
  };
  const rawCounter = { sign: 0 };
  const injectedCounter = { sign: 0 };

  const result = await mutatePayout({
    liveMode: true,
    config: productionPayoutConfig(),
    cycleRepository,
    context,
    request: { plan },
    adapters: { robinhood: { client: rpc() } },
    signerClient: rawOperationsSigner(rawCounter),
    policySignerClient: signer(injectedCounter),
  });

  assert.equal(result, undefined);
  assert.equal(rawCounter.sign, 1);
  assert.equal(rawCounter.broadcasts.length, 1);
  assert.equal(injectedCounter.sign, 0);
  assert.equal(injectedCounter.broadcasts?.length ?? 0, 0);
});

test('derives local policy for a production-capable direct advance', async () => {
  const plan = payoutPlan([{ recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } }]);
  const { store } = await initialized({ plan });
  const rawCounter = { sign: 0 };
  const injectedCounter = { sign: 0 };
  const liveConfig = {
    ...productionPayoutConfig(),
    execution: { profile: 'production', providerMode: 'live' },
  };
  const client = rpc();

  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: rawOperationsSigner(rawCounter),
    policySignerClient: signer(injectedCounter),
    config: liveConfig,
  });
  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: rawOperationsSigner(rawCounter),
    policySignerClient: signer(injectedCounter),
    config: liveConfig,
  });

  assert.equal(rawCounter.sign, 1);
  assert.equal(injectedCounter.sign, 0);
  assert.equal((await store.load()).recipients[0].state, 'SIGNED');
});

test('ignores an injected broad policy signer factory for a production direct advance', async () => {
  const plan = payoutPlan([{ recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } }]);
  const { store } = await initialized({ plan });
  const rawCounter = { sign: 0 };
  const injectedCounter = { sign: 0 };
  let broadFactoryCalls = 0;
  const liveConfig = {
    ...productionPayoutConfig(),
    execution: { profile: 'production', providerMode: 'live' },
  };
  const client = rpc();
  const broadPolicySignerFactory = async () => {
    broadFactoryCalls += 1;
    return signer(injectedCounter).evm;
  };

  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: rawOperationsSigner(rawCounter),
    policySignerFactory: broadPolicySignerFactory,
    config: liveConfig,
  });
  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: rawOperationsSigner(rawCounter),
    policySignerFactory: broadPolicySignerFactory,
    config: liveConfig,
  });

  assert.equal(broadFactoryCalls, 0);
  assert.equal(rawCounter.sign, 1);
  assert.equal(injectedCounter.sign, 0);
  assert.equal((await store.load()).recipients[0].state, 'SIGNED');
});

async function finalizeRecipient({ store, client, counter, recipient }) {
  const payoutSigner = signer(counter);
  for (let boundary = 0; boundary < 3; boundary += 1) {
    await advanceDirectPayout({
      payoutStore: store,
      recipient,
      adapters: { robinhood: { client } },
      signerClient: payoutSigner,
      config: config(),
    });
  }
  const attempt = (await store.load()).recipients.find(entry => entry.recipient === recipient);
  client.setReceiptResolver(async hash => {
    if (hash !== attempt.txHash) throw new TransactionReceiptNotFoundError({ hash });
    return {
      transactionHash: attempt.txHash,
      blockNumber: 100n,
      blockHash: `0x${'f'.repeat(64)}`,
      status: 'success',
      logs: [transferLog({ recipient, amountAtomic: attempt.amount.amountAtomic })],
    };
  });
  await advanceDirectPayout({
    payoutStore: store,
    recipient,
    adapters: { robinhood: { client } },
    signerClient: payoutSigner,
    config: config(),
  });
  client.setNonce(BigInt(attempt.nonce) + 1n);
}

test('persists PREPARED, SIGNED, BROADCAST, and FINALIZED before the next payout boundary', async () => {
  const { store } = await initialized();
  const counter = { sign: 0 };
  const client = rpc();

  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  let state = await store.load();
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_A).state, 'PREPARED');
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_A).nonce, '0');
  assert.equal(counter.sign, 0);

  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  state = await store.load();
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_A).state, 'SIGNED');
  assert.equal(counter.sign, 1);

  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  state = await store.load();
  assert.equal(state.manifestFrozen, true);
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_A).state, 'BROADCAST');
  assert.equal(counter.broadcasts.length, 1);

  const attempt = state.recipients.find(entry => entry.recipient === RECIPIENT_A);
  client.setReceiptResolver(async () => ({
    transactionHash: attempt.txHash,
    blockNumber: 100n,
    blockHash: `0x${'f'.repeat(64)}`,
    status: 'success',
    logs: [transferLog({ recipient: RECIPIENT_A, amountAtomic: attempt.amount.amountAtomic })],
  }));
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  state = await store.load();
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_A).state, 'FINALIZED');
  assert.equal(counter.sign, 1);
});

test('requires payout state identities to match the finalized return binding', () => {
  const plan = payoutPlan();
  assert.throws(
    () => createDirectPayoutState({
      plan,
      operations: RECIPIENT_A,
      usdgAddress: TOKEN,
      firstNonce: '0',
    }),
    /bound finalized return identities/,
  );
  assert.throws(
    () => createDirectPayoutState({
      plan,
      operations: OPERATIONS,
      usdgAddress: RECIPIENT_A,
      firstNonce: '0',
    }),
    /bound finalized return identities/,
  );
});

test('rejects a recovered payout state whose identities diverge from its return binding', async () => {
  const { store } = await initialized();
  const corrupted = await store.load();
  corrupted.operations = RECIPIENT_A;
  await store.persist(corrupted);

  await assert.rejects(
    () => advanceDirectPayout({
      payoutStore: store,
      recipient: RECIPIENT_A,
      adapters: { robinhood: { client: rpc() } },
      signerClient: signer({ sign: 0 }),
      config: { chainId: 4663, accounts: { evm: RECIPIENT_A }, contracts: { usdg: TOKEN } },
    }),
    /bound finalized return identities/,
  );
});

test('prepares a plan bound to the finalized cycle return evidence', async () => {
  const snapshot = payoutManifest();
  const returnEvidence = {
    finalized: true,
    destinationAccount: OPERATIONS,
    destinationAsset: TOKEN,
    destinationCreditAmount: '9',
  };
  const cycleRepository = {
    async readStage(cycleId, stage) {
      assert.equal(cycleId, snapshot.cycleId);
      if (stage === 'eligibility-snapshot') return { status: 'COMPLETE', evidence: snapshot };
      if (stage === 'return') return { status: 'COMPLETE', evidence: returnEvidence };
      throw new Error(`unexpected stage ${stage}`);
    },
    async readPayoutDust(cycleId) {
      assert.equal(cycleId, snapshot.cycleId);
      return usdg('0');
    },
  };

  const request = await preparePayoutRequest({
    config: config(),
    cycleRepository,
    context: { cycleId: snapshot.cycleId },
  });

  assert.deepEqual(request.plan.returnEvidence, {
    operations: OPERATIONS,
    usdgAddress: TOKEN,
    evidenceDigest: canonicalDigest({
      schema: 'hookemon.direct-payout-finalized-return.v1',
      cycleId: snapshot.cycleId,
      returnEvidence,
    }),
  });
});

test('reconstructs an interrupted dust-consumption plan before initializing payout state', async () => {
  const snapshot = payoutManifest();
  const returnEvidence = {
    finalized: true,
    destinationAccount: OPERATIONS,
    destinationAsset: TOKEN,
    destinationCreditAmount: '9',
  };
  const source = {
    cycleId: 'cycle-prior-dust',
    digest: `sha256:${'7'.repeat(64)}`,
    planDigest: `sha256:${'8'.repeat(64)}`,
  };
  const expected = compileDirectPayoutPlan({
    cycleId: snapshot.cycleId,
    eligibilityManifest: snapshot,
    finalizedReturn: usdg('9'),
    previousDust: usdg('1'),
    previousDustSource: source,
    returnBinding: {
      operations: OPERATIONS,
      usdgAddress: TOKEN,
      evidenceDigest: canonicalDigest({
        schema: 'hookemon.direct-payout-finalized-return.v1',
        cycleId: snapshot.cycleId,
        returnEvidence,
      }),
    },
  });
  const cycleRepository = {
    async readStage(_cycleId, stage) {
      if (stage === 'eligibility-snapshot') return { status: 'COMPLETE', evidence: snapshot };
      if (stage === 'return') return { status: 'COMPLETE', evidence: returnEvidence };
      throw new Error(`unexpected stage ${stage}`);
    },
    async readStageAttempt() { return null; },
    async recordStageAttempt() {},
    async readPayoutDustConsumption() {
      return {
        sourceCycleId: source.cycleId,
        sourceDigest: source.digest,
        sourcePlanDigest: source.planDigest,
        amount: usdg('1'),
        planDigest: expected.planDigest,
      };
    },
    async readPayoutDust() { throw new Error('an interrupted consumption must not discard its carried dust'); },
  };

  const request = await preparePayoutRequest({
    config: config(),
    cycleRepository,
    context: { cycleId: snapshot.cycleId },
  });

  assert.equal(request.planDigest, expected.planDigest);
  assert.equal(request.plan.previousDust.amountAtomic, '1');
  assert.deepEqual(request.plan.previousDustSource, source);
});

test('reuses a carried-dust plan after a broadcast instead of rebuilding it from consumed dust', async () => {
  const plan = compileDirectPayoutPlan({
    cycleId: 'cycle-direct-payout-1',
    eligibilityManifest: payoutManifest(),
    finalizedReturn: usdg('9'),
    previousDust: usdg('1'),
    previousDustSource: {
      cycleId: 'cycle-prior-dust',
      digest: `sha256:${'7'.repeat(64)}`,
      planDigest: `sha256:${'8'.repeat(64)}`,
    },
    returnBinding: RETURN_BINDING,
  });
  const { store } = await initialized({ plan });
  const client = rpc();
  const counter = { sign: 0 };
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  const persisted = await store.load();
  assert.equal(persisted.manifestFrozen, true);
  const snapshot = payoutManifest();
  const returnEvidence = {
    finalized: true,
    destinationAccount: OPERATIONS,
    destinationAsset: TOKEN,
    destinationCreditAmount: '9',
  };
  const cycleRepository = {
    async readStage(_cycleId, stage) {
      if (stage === 'eligibility-snapshot') return { status: 'COMPLETE', evidence: snapshot };
      if (stage === 'return') return { status: 'COMPLETE', evidence: returnEvidence };
      throw new Error(`unexpected stage ${stage}`);
    },
    async readStageAttempt() { return persisted; },
    async recordStageAttempt() {},
    async readPayoutDust() { throw new Error('consumed dust must not rebuild an existing payout plan'); },
  };

  const request = await preparePayoutRequest({
    config: config(),
    cycleRepository,
    context: { cycleId: snapshot.cycleId },
  });

  assert.equal(request.planDigest, plan.planDigest);
  assert.equal(request.plan.previousDust.amountAtomic, '1');
  assert.deepEqual(request.plan.previousDustSource, plan.previousDustSource);
});

test('reconciliation records terminal successor dust after a crash before the mutation response', async () => {
  const { store } = await initialized({ plan: payoutPlan(undefined, '10') });
  const client = rpc();
  const counter = { sign: 0 };
  await finalizeRecipient({ store, client, counter, recipient: RECIPIENT_A });
  await finalizeRecipient({ store, client, counter, recipient: RECIPIENT_B });
  const terminal = await store.load();
  assert.equal(terminal.dust.amountAtomic, '1');
  assert.equal(isDirectPayoutComplete(terminal), true);

  const dustWrites = [];
  const evidence = await reconcileLivePayout({
    config: config(),
    context: { cycleId: terminal.cycleId },
    cycleRepository: {
      async readPagedPayoutState() { return terminal; },
      async persistPagedPayoutState() {},
      async recordPayoutDust(cycleId, input) { dustWrites.push({ cycleId, input }); },
    },
  });

  assert.equal(evidence.dust.amountAtomic, '1');
  assert.deepEqual(dustWrites, [{
    cycleId: terminal.cycleId,
    input: { amount: { ...usdg('1'), chainId: '4663' }, planDigest: terminal.planDigest },
  }]);
});

test('reconciliation replaces and releases a stranded terminal payout nonce fence after a crash', async () => {
  const { store } = await initialized({ plan: payoutPlan(undefined, '10') });
  const client = rpc();
  const counter = { sign: 0 };
  await finalizeRecipient({ store, client, counter, recipient: RECIPIENT_A });
  await finalizeRecipient({ store, client, counter, recipient: RECIPIENT_B });
  const terminal = await store.load();
  const nonceCalls = [];
  const mutationCalls = [];

  const evidence = await reconcileLivePayout({
    config: config(),
    context: {
      cycleId: terminal.cycleId,
      stage: 'payout',
      fencingToken: '12345678-1234-4123-8123-123456789abc',
      async assertMutationAllowed(input) { mutationCalls.push(input); },
    },
    cycleRepository: {
      async readPagedPayoutState() { return terminal; },
      async persistPagedPayoutState() {},
      async recordPayoutDust() {},
      async reserveWalletNonce(cycleId, input) { nonceCalls.push(['reserve', cycleId, input]); },
      async assertWalletNonce(cycleId, input) { nonceCalls.push(['assert', cycleId, input]); },
      async releaseWalletNonce(cycleId, input) {
        nonceCalls.push(['release', cycleId, input]);
        if (nonceCalls.length === 1) throw new Error('cycle-repository releaseWalletNonce: stale fencing token');
      },
    },
  });

  assert.equal(evidence.planDigest, terminal.planDigest);
  assert.equal(mutationCalls.length, 1);
  assert.equal(mutationCalls[0].boundary, 'mutation');
  assert.deepEqual(nonceCalls.map(([kind]) => kind), ['release', 'reserve', 'assert', 'release']);
  for (const [, cycleId, input] of nonceCalls) {
    assert.equal(cycleId, terminal.cycleId);
    assert.equal(input.fencingToken, '12345678-1234-4123-8123-123456789abc');
  }
});

test('a restart after every persisted boundary never signs a second transaction for the same recipient and nonce', async () => {
  const store = repository();
  const plan = payoutPlan([{ recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } }]);
  store.failAfterNextPersist();
  await assert.rejects(
    () => initializeDirectPayout({ payoutStore: store, plan, operations: OPERATIONS, usdgAddress: TOKEN, firstNonce: '0' }),
    /injected crash/,
  );
  const counter = { sign: 0 };
  const client = rpc();

  store.failAfterNextPersist();
  await assert.rejects(
    () => advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() }),
    /injected crash/,
  );
  assert.equal((await store.load()).recipients[0].state, 'PREPARED');
  assert.equal((await store.load()).recipients[0].nonce, '0');
  assert.equal(counter.sign, 0);

  store.failAfterNextPersist();
  await assert.rejects(
    () => advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() }),
    /injected crash/,
  );
  assert.equal((await store.load()).recipients[0].state, 'SIGNED');
  assert.equal(counter.sign, 1);

  let state = await store.load();
  store.failAfterNextPersist();
  await assert.rejects(
    () => advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() }),
    /injected crash/,
  );
  state = await store.load();
  assert.equal(state.recipients[0].state, 'SIGNED');
  assert.equal(state.manifestFrozen, true);
  assert.equal(counter.sign, 1);
  assert.equal(counter.broadcasts?.length ?? 0, 0);

  store.failAfterNextPersist();
  await assert.rejects(
    () => advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() }),
    /injected crash/,
  );
  state = await store.load();
  assert.equal(state.recipients[0].state, 'BROADCAST');
  assert.equal(counter.broadcasts.length, 1);

  client.setReceiptResolver(async () => ({
    transactionHash: state.recipients[0].txHash,
    blockNumber: 100n,
    blockHash: `0x${'f'.repeat(64)}`,
    status: 'success',
    logs: [transferLog({ recipient: RECIPIENT_A, amountAtomic: state.recipients[0].amount.amountAtomic })],
  }));
  store.failAfterNextPersist();
  await assert.rejects(
    () => advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() }),
    /injected crash/,
  );
  assert.equal((await store.load()).recipients[0].state, 'FINALIZED');
  assert.equal(counter.sign, 1);
});

test('quarantines a USDG-frozen recipient without treating its liability as paid', async () => {
  const plan = payoutPlan([{ recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } }]);
  const { store } = await initialized({ plan });
  const counter = { sign: 0 };
  const client = rpc({ frozen: new Set([RECIPIENT_A]) });
  const cycleRepository = custodyRepository();

  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config(), cycleRepository });
  const state = await store.load();
  assert.equal(state.recipients[0].state, 'REFUSED');
  assert.equal(state.quarantine[0].amount.amountAtomic, state.recipients[0].amount.amountAtomic);
  assert.equal(cycleRepository.reservations.length, 1);
  assert.equal(counter.sign, 0);
  assert.equal(isDirectPayoutComplete(state), true);
});

test('refuses a frozen recipient before changing payout state when custody quarantine is unavailable', async () => {
  const plan = payoutPlan([{ recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } }]);
  const { store } = await initialized({ plan });
  const before = await store.load();

  await assert.rejects(
    () => advanceDirectPayout({
      payoutStore: store,
      recipient: RECIPIENT_A,
      adapters: { robinhood: { client: rpc({ frozen: new Set([RECIPIENT_A]) }) } },
      signerClient: signer({ sign: 0 }),
      config: config(),
    }),
    /custody-backed quarantine repository/,
  );

  assert.deepEqual(await store.load(), before);
});

test('does not reserve a nonce for a frozen recipient before advancing the next payable recipient', async () => {
  const { store } = await initialized();
  const counter = { sign: 0 };
  const client = rpc({ frozen: new Set([RECIPIENT_A]) });
  const cycleRepository = custodyRepository();

  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config(), cycleRepository });
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_B, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config(), cycleRepository });
  let state = await store.load();
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_A).state, 'REFUSED');
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_B).nonce, '0');

  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_B, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config(), cycleRepository });
  state = await store.load();
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_B).state, 'SIGNED');
  assert.equal(counter.sign, 1);
});

test('releases a reserved nonce when USDG freezes a recipient before signing', async () => {
  const { store } = await initialized();
  const counter = { sign: 0 };
  const frozen = new Set();
  const client = rpc({ frozen });
  const cycleRepository = custodyRepository();

  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config(), cycleRepository });
  frozen.add(RECIPIENT_A);
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config(), cycleRepository });

  let state = await store.load();
  const first = state.recipients.find(entry => entry.recipient === RECIPIENT_A);
  assert.equal(first.state, 'REFUSED');
  assert.equal(first.nonce, null);
  assert.equal(state.nextNonce, '0');

  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_B, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config(), cycleRepository });
  state = await store.load();
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_B).nonce, '0');
});

test('requires a current native-balance read before the first payout signature', async () => {
  const plan = payoutPlan([{ recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } }]);
  const { store } = await initialized({ plan });
  const counter = { sign: 0 };
  const client = rpc();
  delete client.getBalance;

  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  await assert.rejects(
    () => advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() }),
    /requires getBalance before the first payout signature/,
  );
  assert.equal(counter.sign, 0);
  assert.equal((await store.load()).recipients[0].state, 'PREPARED');
});

test('broadcasts direct payouts through the transaction-policy signer', async () => {
  const plan = payoutPlan([{ recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } }]);
  const { store } = await initialized({ plan });
  const counter = { sign: 0 };
  const client = rpc();
  let rawRpcBroadcasts = 0;

  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  client.sendRawTransaction = async ({ serializedTransaction }) => {
    rawRpcBroadcasts += 1;
    return { transactionHash: keccak256(serializedTransaction) };
  };

  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });

  assert.equal(counter.broadcasts.length, 1);
  assert.equal(rawRpcBroadcasts, 0);
});

test('uses the guarded payout signer facade with the original transaction-policy authority', async () => {
  const plan = payoutPlan([{ recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } }]);
  const { store } = await initialized({ plan });
  const counter = { sign: 0 };
  const client = rpc();
  const policySignerClient = signer(counter);
  const boundaries = [];
  const guardedSignerClient = {
    evm: {
      role: policySignerClient.evm.role,
      async sign(input) {
        boundaries.push('signature');
        return policySignerClient.evm.sign(input);
      },
      async broadcast(input) {
        boundaries.push('broadcast');
        return policySignerClient.evm.broadcast(input);
      },
    },
  };

  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: guardedSignerClient,
    policySignerClient,
    config: config(),
  });
  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: guardedSignerClient,
    policySignerClient,
    config: config(),
  });
  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: guardedSignerClient,
    policySignerClient,
    config: config(),
  });

  assert.deepEqual(boundaries, ['signature', 'broadcast']);
  assert.equal(counter.sign, 1);
  assert.equal(counter.broadcasts.length, 1);
});

test('preserves exact signer bytes for policy-approved rebroadcast', async () => {
  const plan = payoutPlan([{ recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } }]);
  const { store } = await initialized({ plan });
  const counter = { sign: 0 };
  const client = rpc();
  const policySigner = signer(counter, { uppercaseRawBytes: true });

  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: policySigner, config: config() });
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: policySigner, config: config() });
  const signedBytes = (await store.load()).recipients[0].rawSignedBytes;
  assert.match(signedBytes, /^0x[0-9A-F]+$/);

  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: policySigner, config: config() });
  assert.deepEqual(counter.broadcasts, [signedBytes]);
});

test('freezes the plan before broadcast transport survives a pre-persist crash', async () => {
  const plan = payoutPlan([{ recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } }]);
  const { store } = await initialized({ plan });
  const counter = { sign: 0 };
  const client = rpc();

  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  store.failBeforePersistWhen(value => value.recipients[0].state === 'BROADCAST');
  await assert.rejects(
    () => advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() }),
    /injected crash before durable persist/,
  );

  const state = await store.load();
  assert.equal(counter.broadcasts.length, 1);
  assert.equal(state.recipients[0].state, 'SIGNED');
  assert.equal(state.manifestFrozen, true);
  assert.throws(
    () => assertPayoutManifestUnchanged(state, payoutPlan([{ recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '2' } }])),
    /immutable/,
  );
});

test('quarantines a signed frozen recipient after its original transaction finalizes reverted, then advances', async () => {
  const { store } = await initialized();
  const counter = { sign: 0 };
  const frozen = new Set();
  const client = rpc({ frozen });
  const reservations = [];
  const cycleRepository = {
    async reservePayoutQuarantine(cycleId, input) { reservations.push({ cycleId, input }); },
  };

  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  frozen.add(RECIPIENT_A);
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  assert.equal(counter.broadcasts?.length ?? 0, 1);
  const broadcast = await store.load();
  const first = broadcast.recipients.find(entry => entry.recipient === RECIPIENT_A);
  client.setReceiptResolver(async hash => {
    if (hash !== first.txHash) throw new TransactionReceiptNotFoundError({ hash });
    return {
      transactionHash: first.txHash,
      blockNumber: 100n,
      blockHash: `0x${'f'.repeat(64)}`,
      status: 'reverted',
      logs: [],
    };
  });
  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: signer(counter),
    config: config(),
    cycleRepository,
  });

  let state = await store.load();
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_A).state, 'REFUSED');
  assert.equal(reservations.length, 1);
  assert.equal(reservations[0].input.reason, 'TRANSACTION_REVERTED');

  client.getTransactionCount = async () => 1n;
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_B, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  state = await store.load();
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_B).nonce, '1');
});

test('requires a transaction-policy signer before requesting a payout signature', async () => {
  const plan = payoutPlan([{ recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } }]);
  const { store } = await initialized({ plan });
  const client = rpc();
  let bareSignerCalls = 0;
  const bareSigner = {
    evm: {
      async sign() {
        bareSignerCalls += 1;
        throw new Error('bare signer was invoked');
      },
    },
  };

  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: bareSigner, config: config() });
  await assert.rejects(
    () => advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: bareSigner, config: config() }),
    /transaction-policy signer/,
  );
  assert.equal(bareSignerCalls, 0);
});

test('recovers a dropped broadcast with exact persisted bytes and no fresh signature', async () => {
  const plan = payoutPlan([{ recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } }]);
  const { store } = await initialized({ plan });
  const initialCounter = { sign: 0 };
  const restartedCounter = { sign: 0 };
  const client = rpc();
  const recoveryContexts = [];
  const reservationChecks = [];
  const cycleRepository = {
    async persistChainAttemptRecoveryContext(cycleId, context) {
      recoveryContexts.push({ cycleId, context: structuredClone(context) });
    },
    async readChainAttemptRecoveryContext(_cycleId, input) {
      return recoveryContexts.find(entry => entry.context.requestDigest === input.requestDigest
        && entry.context.rawSignedBytesHash === input.rawSignedBytesHash)?.context ?? null;
    },
    async readPagedPayoutState() { return store.load(); },
    async assertWalletNonce(cycleId, input) {
      reservationChecks.push({ cycleId, input: structuredClone(input) });
    },
  };
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const fencingToken = 'payout-fence-1';

  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: signer(initialCounter),
    config: config(),
    cycleRepository,
    requestDigest,
    fencingToken,
  });
  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: signer(initialCounter),
    config: config(),
    cycleRepository,
    requestDigest,
    fencingToken,
  });
  const signedBytes = (await store.load()).recipients[0].rawSignedBytes;
  const restartedPolicySignerClient = signer(restartedCounter);
  let guardedRecoveryBroadcasts = 0;
  const guardedRestartedSignerClient = {
    evm: {
      role: restartedPolicySignerClient.evm.role,
      async sign() {
        throw new Error('dropped-broadcast recovery must not request a new signature');
      },
      async broadcast(input) {
        guardedRecoveryBroadcasts += 1;
        return restartedPolicySignerClient.evm.broadcast(input);
      },
    },
  };
  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: guardedRestartedSignerClient,
    policySignerClient: restartedPolicySignerClient,
    config: config(),
    cycleRepository,
    requestDigest,
    fencingToken,
  });

  assert.equal(restartedCounter.sign, 0);
  assert.equal(restartedCounter.broadcasts?.length ?? 0, 1);
  assert.equal(guardedRecoveryBroadcasts, 1);
  assert.deepEqual(restartedCounter.broadcasts, [signedBytes]);
  assert.equal(recoveryContexts.length, 0, 'the signed payout page is the only recovery record');
  const persistedAttempt = (await store.load()).recipients[0];
  assert.match(persistedAttempt.approvalContext.policyDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(persistedAttempt.approvalContext.approvalDigest, /^sha256:[0-9a-f]{64}$/);
  assert.match(persistedAttempt.approvalContext.approvedSemanticsDigest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(persistedAttempt.approvalContext.fencingToken, fencingToken);
  assert.equal(reservationChecks.length, 1);
  assert.equal(reservationChecks[0].input.fencingToken, fencingToken);
  assert.equal(reservationChecks[0].input.stage, 'payout');
});

test('rejects a stale signed snapshot after a replacement becomes durable', async () => {
  const { store } = await initialized();
  const contexts = [];
  const cycleRepository = {
    async persistChainAttemptRecoveryContext(_cycleId, context) {
      contexts.push(structuredClone(context));
    },
    async readChainAttemptRecoveryContext(_cycleId, selector) {
      return structuredClone(contexts.find(context => context.requestDigest === selector.requestDigest
        && context.rawSignedBytesHash === selector.rawSignedBytesHash) ?? null);
    },
    async readPagedPayoutState() { return store.load(); },
    async assertWalletNonce() {},
  };
  const initialCounter = { sign: 0 };
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const fencingToken = 'payout-fence-stale-replacement-1';
  const client = rpc();

  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: signer(initialCounter),
    config: config(),
    cycleRepository,
    requestDigest,
    fencingToken,
  });
  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: signer(initialCounter),
    config: config(),
    cycleRepository,
    requestDigest,
    fencingToken,
  });
  const staleState = await store.load();
  const staleAttempt = staleState.recipients[0];
  await replaceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    replacementGasPriceWei: '3',
    signerClient: signer(initialCounter),
    config: productionPayoutConfig(),
    evmNonceFence: async () => {},
    cycleRepository,
  });
  const currentAttempt = (await store.load()).recipients[0];
  assert.notEqual(currentAttempt.rawSignedBytesHash, staleAttempt.rawSignedBytesHash);
  const restartedCounter = { sign: 0 };
  const restartedSigner = signer(restartedCounter);

  await assert.rejects(
    () => payoutStage.recoverDroppedBroadcast({
      signerClient: restartedSigner,
      policySignerClient: restartedSigner,
      cycleRepository,
      state: staleState,
      attempt: staleAttempt,
    }),
    /does not match the durable signed recipient/,
  );
  assert.equal(restartedCounter.sign, 0);
  assert.equal(restartedCounter.broadcasts?.length ?? 0, 0);
});

test('persists signed payout bytes and policy approval in one recoverable page record', async () => {
  const plan = payoutPlan([{ recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } }]);
  let state = null;
  const events = [];
  const payoutStore = {
    async load() { return state === null ? null : structuredClone(state); },
    async persist(value) {
      state = structuredClone(value);
      if (state.recipients[0].state === 'SIGNED') events.push('signed-state');
    },
  };
  await initializeDirectPayout({
    payoutStore,
    plan,
    operations: OPERATIONS,
    usdgAddress: TOKEN,
    firstNonce: '0',
    gasPriceWei: '2',
  });
  const cycleRepository = {};
  const counter = { sign: 0 };
  const client = rpc();
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const fencingToken = 'payout-fence-write-order-1';

  await advanceDirectPayout({
    payoutStore,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: signer(counter),
    config: config(),
    cycleRepository,
    requestDigest,
    fencingToken,
  });
  events.length = 0;
  await advanceDirectPayout({
    payoutStore,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: signer(counter),
    config: config(),
    cycleRepository,
    requestDigest,
    fencingToken,
  });

  assert.deepEqual(events, ['signed-state']);
  assert.notEqual(state.recipients[0].approvalContext, null);
  assert.equal(state.recipients[0].approvalContext.requestDigest, requestDigest);
  assert.equal(state.recipients[0].approvalContext.fencingToken, fencingToken);
});

test('rebroadcasts a durable SIGNED recipient without a second recovery-context write', async () => {
  const plan = payoutPlan([{ recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } }]);
  const { store } = await initialized({ plan });
  const cycleRepository = { async assertWalletNonce() {} };
  const counter = { sign: 0 };
  const client = rpc();
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const fencingToken = 'payout-fence-recovery-context-crash-1';

  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: signer(counter),
    config: config(),
    cycleRepository,
    requestDigest,
    fencingToken,
  });
  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: signer(counter),
    config: config(),
    cycleRepository,
    requestDigest,
    fencingToken,
  });
  assert.equal((await store.load()).recipients[0].state, 'SIGNED');
  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: signer(counter),
    config: config(),
    cycleRepository,
    requestDigest,
    fencingToken,
  });
  assert.equal(counter.sign, 1);
  assert.equal(counter.broadcasts?.length ?? 0, 1);
  assert.equal((await store.load()).recipients[0].state, 'BROADCAST');
});

test('refuses a recovery context that has no durable SIGNED or BROADCAST recipient', async () => {
  const plan = payoutPlan([{ recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } }]);
  const { store } = await initialized({ plan });
  const contexts = [];
  const cycleRepository = {
    async persistChainAttemptRecoveryContext(_cycleId, context) {
      contexts.push(structuredClone(context));
    },
    async readChainAttemptRecoveryContext() {
      return structuredClone(contexts[0] ?? null);
    },
    async assertWalletNonce() {},
  };
  const initialCounter = { sign: 0 };
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const fencingToken = 'payout-fence-orphan-context-1';
  const client = rpc();

  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: signer(initialCounter),
    config: config(),
    cycleRepository,
    requestDigest,
    fencingToken,
  });
  const preparedState = await store.load();
  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: signer(initialCounter),
    config: config(),
    cycleRepository,
    requestDigest,
    fencingToken,
  });
  const signedAttempt = (await store.load()).recipients[0];
  const restartedCounter = { sign: 0 };

  await assert.rejects(
    () => payoutStage.recoverDroppedBroadcast({
      signerClient: signer(restartedCounter),
      policySignerClient: signer(restartedCounter),
      cycleRepository,
      state: preparedState,
      attempt: signedAttempt,
    }),
    /durably persisted SIGNED or BROADCAST recipient/,
  );
  assert.equal(restartedCounter.sign, 0);
  assert.equal(restartedCounter.broadcasts?.length ?? 0, 0);
});

test('rebroadcasts exact durable bytes only after receipt and transaction absence are both observed', async () => {
  const plan = payoutPlan([{ recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } }]);
  const { store } = await initialized({ plan });
  const counter = { sign: 0 };
  const client = rpc();
  const cycleRepository = {
    async readPagedPayoutState() { return store.load(); },
  };
  client.getTransaction = async () => null;

  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config(), cycleRepository });
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config(), cycleRepository });
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config(), cycleRepository });
  const signedBytes = (await store.load()).recipients[0].rawSignedBytes;

  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config(), cycleRepository });

  assert.deepEqual(counter.broadcasts, [signedBytes, signedBytes]);
  assert.equal((await store.load()).recipients[0].state, 'BROADCAST');
});

test('quarantines nonce interference instead of rebroadcasting when the latest nonce was consumed', async () => {
  const plan = payoutPlan([{ recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } }]);
  const { store } = await initialized({ plan });
  const counter = { sign: 0 };
  const client = rpc();
  const cycleRepository = custodyRepository();
  const observedTags = [];
  client.getTransaction = async () => null;
  client.getTransactionCount = async ({ blockTag }) => {
    observedTags.push(blockTag);
    return blockTag === 'latest' ? 1n : 0n;
  };

  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });

  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: signer(counter),
    config: config(),
    cycleRepository,
  });
  assert.deepEqual(observedTags.slice(-2), ['pending', 'latest']);
  assert.equal(counter.broadcasts.length, 1);
  const state = await store.load();
  assert.equal(state.recipients[0].state, 'NONCE_INTERFERENCE');
  assert.deepEqual(state.quarantine, [{ recipient: RECIPIENT_A, amount: state.recipients[0].amount, reason: 'NONCE_INTERFERENCE' }]);
  assert.equal(cycleRepository.reservations.length, 1);
  assert.equal(cycleRepository.reservations[0].input.reason, 'NONCE_INTERFERENCE');
});

test('continues later recipients then holds reopened payout custody for nonce interference', async t => {
  const { directory, repository: cycleRepository, cycleId } = await durableCycle(t);
  const plan = payoutPlan(undefined, '9', cycleId);
  const payoutStore = createCycleRepositoryPayoutStore({ cycleRepository, cycleId });
  await initializeDirectPayout({
    payoutStore,
    plan,
    operations: OPERATIONS,
    usdgAddress: TOKEN,
    firstNonce: '0',
    gasPriceWei: '2',
  });
  await cycleRepository.recordCustodyLedger(cycleId, custodyLedger(cycleId, '9'));

  const frozen = new Set();
  const client = rpc({ frozen });
  const counter = { sign: 0 };
  const advance = recipient => advanceDirectPayout({
    payoutStore,
    recipient,
    adapters: { robinhood: { client } },
    signerClient: signer(counter),
    config: config(),
    cycleRepository,
  });

  await advance(RECIPIENT_A);
  await advance(RECIPIENT_A);
  await advance(RECIPIENT_A);
  client.getTransaction = async () => null;
  client.setNonce('1');
  await advance(RECIPIENT_A);

  frozen.add(RECIPIENT_B);
  await advance(RECIPIENT_B);
  let state = await payoutStore.load();
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_A).state, 'NONCE_INTERFERENCE');
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_B).state, 'REFUSED');
  assert.equal(isDirectPayoutComplete(state), true);

  await mutatePayout({
    liveMode: true,
    config: config(),
    cycleRepository,
    context: {
      cycleId,
      requestDigest: `sha256:${'a'.repeat(64)}`,
      fencingToken: '11111111-1111-4111-8111-111111111111',
      async assertMutationAllowed() {},
    },
    request: { plan },
    adapters: { robinhood: { client } },
    signerClient: signer(counter),
  });

  const reopened = await CycleRepository.open(directory);
  const reopenedState = await reopened.readPagedPayoutState(cycleId, 'payout');
  assert.equal(reopenedState.recipients.find(entry => entry.recipient === RECIPIENT_A).state, 'NONCE_INTERFERENCE');
  assert.equal(reopenedState.recipients.find(entry => entry.recipient === RECIPIENT_B).state, 'REFUSED');
  assert.equal((await reopened.describeCycle(cycleId)).terminalState, 'HELD_OWNER_DECISION');
  await assert.rejects(() => reopened.prepareStage(cycleId, 'payout'), /terminal as HELD_OWNER_DECISION/);
});

test('continues a later recipient after isolated nonce interference and holds reopened payout custody', async t => {
  const { directory, repository: cycleRepository, cycleId } = await durableCycle(t);
  const plan = payoutPlan(undefined, '9', cycleId);
  const payoutStore = createCycleRepositoryPayoutStore({ cycleRepository, cycleId });
  await initializeDirectPayout({
    payoutStore,
    plan,
    operations: OPERATIONS,
    usdgAddress: TOKEN,
    firstNonce: '0',
    gasPriceWei: '2',
  });
  await cycleRepository.recordCustodyLedger(cycleId, custodyLedger(cycleId, '9'));

  const client = rpc();
  const counter = { sign: 0 };
  const advance = recipient => advanceDirectPayout({
    payoutStore,
    recipient,
    adapters: { robinhood: { client } },
    signerClient: signer(counter),
    config: config(),
    cycleRepository,
  });

  await advance(RECIPIENT_A);
  await advance(RECIPIENT_A);
  await advance(RECIPIENT_A);
  client.getTransaction = async () => null;
  client.setNonce('1');
  await advance(RECIPIENT_A);

  await advance(RECIPIENT_B);
  await advance(RECIPIENT_B);
  await advance(RECIPIENT_B);
  const broadcast = await payoutStore.load();
  const recipientB = broadcast.recipients.find(entry => entry.recipient === RECIPIENT_B);
  client.setReceiptResolver(async hash => {
    if (hash !== recipientB.txHash) throw new TransactionReceiptNotFoundError({ hash });
    return {
      transactionHash: recipientB.txHash,
      blockNumber: 100n,
      blockHash: `0x${'f'.repeat(64)}`,
      status: 'success',
      logs: [transferLog({ recipient: RECIPIENT_B, amountAtomic: recipientB.amount.amountAtomic })],
    };
  });
  await advance(RECIPIENT_B);

  let state = await payoutStore.load();
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_A).state, 'NONCE_INTERFERENCE');
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_B).state, 'FINALIZED');
  assert.equal(isDirectPayoutComplete(state), true);
  assert.equal((await cycleRepository.describeCycle(cycleId)).terminalState, null);

  await mutatePayout({
    liveMode: true,
    config: config(),
    cycleRepository,
    context: {
      cycleId,
      requestDigest: `sha256:${'d'.repeat(64)}`,
      fencingToken: '44444444-4444-4444-8444-444444444444',
      async assertMutationAllowed() {},
    },
    request: { plan },
    adapters: { robinhood: { client } },
    signerClient: signer(counter),
  });

  const reopened = await CycleRepository.open(directory);
  state = await reopened.readPagedPayoutState(cycleId, 'payout');
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_A).state, 'NONCE_INTERFERENCE');
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_B).state, 'FINALIZED');
  assert.equal((await reopened.describeCycle(cycleId)).terminalState, 'HELD_OWNER_DECISION');
  await assert.rejects(() => reopened.prepareStage(cycleId, 'payout'), /terminal as HELD_OWNER_DECISION/);
});

test('quarantines a frozen recipient, finalizes a later recipient, then holds reopened custody', async t => {
  const { directory, repository: cycleRepository, cycleId } = await durableCycle(t);
  const plan = payoutPlan(undefined, '9', cycleId);
  const payoutStore = createCycleRepositoryPayoutStore({ cycleRepository, cycleId });
  await initializeDirectPayout({
    payoutStore,
    plan,
    operations: OPERATIONS,
    usdgAddress: TOKEN,
    firstNonce: '0',
    gasPriceWei: '2',
  });
  await cycleRepository.recordCustodyLedger(cycleId, custodyLedger(cycleId, '9'));

  const frozen = new Set([RECIPIENT_A]);
  const client = rpc({ frozen });
  const counter = { sign: 0 };
  const advance = recipient => advanceDirectPayout({
    payoutStore,
    recipient,
    adapters: { robinhood: { client } },
    signerClient: signer(counter),
    config: config(),
    cycleRepository,
  });

  await advance(RECIPIENT_A);
  await advance(RECIPIENT_B);
  await advance(RECIPIENT_B);
  await advance(RECIPIENT_B);
  const broadcast = await payoutStore.load();
  const recipientB = broadcast.recipients.find(entry => entry.recipient === RECIPIENT_B);
  client.setReceiptResolver(async hash => {
    if (hash !== recipientB.txHash) throw new TransactionReceiptNotFoundError({ hash });
    return {
      transactionHash: recipientB.txHash,
      blockNumber: 100n,
      blockHash: `0x${'f'.repeat(64)}`,
      status: 'success',
      logs: [transferLog({ recipient: RECIPIENT_B, amountAtomic: recipientB.amount.amountAtomic })],
    };
  });
  await advance(RECIPIENT_B);

  let state = await payoutStore.load();
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_A).state, 'REFUSED');
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_B).state, 'FINALIZED');
  assert.equal(isDirectPayoutComplete(state), true);
  assert.equal((await cycleRepository.describeCycle(cycleId)).terminalState, null);

  await mutatePayout({
    liveMode: true,
    config: config(),
    cycleRepository,
    context: {
      cycleId,
      requestDigest: `sha256:${'b'.repeat(64)}`,
      fencingToken: '22222222-2222-4222-8222-222222222222',
      async assertMutationAllowed() {},
    },
    request: { plan },
    adapters: { robinhood: { client } },
    signerClient: signer(counter),
  });

  const reopened = await CycleRepository.open(directory);
  state = await reopened.readPagedPayoutState(cycleId, 'payout');
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_A).state, 'REFUSED');
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_B).state, 'FINALIZED');
  assert.equal((await reopened.describeCycle(cycleId)).terminalState, 'HELD_OWNER_DECISION');
  assert.equal(counter.sign, 1);
});

test('rebroadcasts dropped bytes from a reopened payout repository without signing or holding', async t => {
  const { directory, repository: cycleRepository, cycleId } = await durableCycle(t);
  const plan = payoutPlan(undefined, '9', cycleId);
  const payoutStore = createCycleRepositoryPayoutStore({ cycleRepository, cycleId });
  await initializeDirectPayout({
    payoutStore,
    plan,
    operations: OPERATIONS,
    usdgAddress: TOKEN,
    firstNonce: '0',
    gasPriceWei: '2',
  });
  const requestDigest = `sha256:${'c'.repeat(64)}`;
  const fencingToken = '33333333-3333-4333-8333-333333333333';
  await cycleRepository.reserveWalletNonce(cycleId, {
    chainId: '4663',
    wallet: OPERATIONS,
    stage: 'payout',
    fencingToken,
    leaseAcquiredAtMs: 0,
    leaseExpiresAtMs: Number.MAX_SAFE_INTEGER,
  });
  const client = rpc();
  const initialCounter = { sign: 0 };
  const advance = signerClient => advanceDirectPayout({
    payoutStore,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient,
    config: config(),
    cycleRepository,
    requestDigest,
    fencingToken,
  });

  const initialSigner = signer(initialCounter);
  await advance(initialSigner);
  await advance(initialSigner);
  await advance(initialSigner);
  const signedBytes = (await payoutStore.load()).recipients[0].rawSignedBytes;

  client.getTransaction = async () => null;
  const reopened = await CycleRepository.open(directory);
  const reopenedStore = createCycleRepositoryPayoutStore({ cycleRepository: reopened, cycleId });
  const restartCounter = { sign: 0 };
  const restartPolicySigner = signer(restartCounter);
  const noSigningRestart = {
    evm: {
      role: restartPolicySigner.evm.role,
      async sign() { throw new Error('dropped recovery must not sign fresh bytes'); },
      async broadcast(input) { return restartPolicySigner.evm.broadcast(input); },
    },
  };
  await advanceDirectPayout({
    payoutStore: reopenedStore,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: noSigningRestart,
    policySignerClient: restartPolicySigner,
    config: config(),
    cycleRepository: reopened,
    requestDigest,
    fencingToken,
  });

  const recovered = await reopenedStore.load();
  assert.equal(restartCounter.sign, 0);
  assert.deepEqual(restartCounter.broadcasts, [signedBytes]);
  assert.equal(recovered.recipients[0].state, 'BROADCAST');
  assert.equal((await reopened.describeCycle(cycleId)).terminalState, null);
});

test('keeps a broadcast unresolved when a missing transaction has a lower pending and latest nonce', async () => {
  const { store } = await initialized();
  const counter = { sign: 0 };
  const client = rpc();
  let observedNonce = 0n;
  client.getTransactionCount = async () => observedNonce;
  await finalizeRecipient({ store, client, counter, recipient: RECIPIENT_A });

  observedNonce = 1n;
  client.getTransaction = async ({ hash }) => { throw new TransactionNotFoundError({ hash }); };
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_B, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_B, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_B, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  const broadcastsBeforeRecovery = counter.broadcasts.length;

  observedNonce = 0n;
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_B, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });

  assert.equal(counter.broadcasts.length, broadcastsBeforeRecovery);
  assert.equal((await store.load()).recipients.find(entry => entry.recipient === RECIPIENT_B).state, 'BROADCAST');
});

test('does not rebroadcast when receipt reconciliation reports malformed evidence', async () => {
  const plan = payoutPlan([{ recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } }]);
  const { store } = await initialized({ plan });
  const counter = { sign: 0 };
  const client = rpc();
  let rawRpcBroadcasts = 0;

  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  client.setReceiptResolver(async () => { throw new Error('malformed receipt evidence'); });
  client.sendRawTransaction = async ({ serializedTransaction }) => {
    rawRpcBroadcasts += 1;
    return { transactionHash: keccak256(serializedTransaction) };
  };

  await assert.rejects(
    () => advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() }),
    /malformed receipt evidence/,
  );
  assert.equal(rawRpcBroadcasts, 0);
});

test('refuses nonce interference before requesting a signature', async () => {
  const { store } = await initialized();
  const counter = { sign: 0 };
  await assert.rejects(
    () => advanceDirectPayout({
      payoutStore: store,
      recipient: RECIPIENT_A,
      adapters: { robinhood: { client: rpc({ nonce: 1n }) } },
      signerClient: signer(counter),
      config: config(),
    }),
    DirectPayoutNonceInterferenceError,
  );
  assert.equal(counter.sign, 0);
  assert.equal((await store.load()).recipients.find(entry => entry.recipient === RECIPIENT_A).state, 'PREPARED');
});

test('rejects a plan with a stale digest and a replacement outside the signed transaction envelope', async () => {
  const tamperedPlan = structuredClone(payoutPlan());
  tamperedPlan.allocations[0].amount.amountAtomic = '8';
  assert.throws(
    () => createDirectPayoutState({
      plan: tamperedPlan,
      operations: OPERATIONS,
      usdgAddress: TOKEN,
      firstNonce: '0',
    }),
    /does not authenticate/,
  );

  const forgedPlan = structuredClone(payoutPlan());
  forgedPlan.allocations[0].hkmnBalance.amountAtomic = '1';
  forgedPlan.planDigest = directPayoutPlanDigest(forgedPlan);
  assert.throws(
    () => createDirectPayoutState({
      plan: forgedPlan,
      operations: OPERATIONS,
      usdgAddress: TOKEN,
      firstNonce: '0',
    }),
    /does not reconstruct from its frozen eligibility evidence/,
  );

  const { store } = await initialized();
  const counter = { sign: 0 };
  const client = rpc();
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  await assert.rejects(
    () => replaceDirectPayout({
      payoutStore: store,
      recipient: RECIPIENT_A,
      replacementGasPriceWei: '3',
      signerClient: { evm: { async sign() { throw new Error('must not sign'); } } },
      config: productionPayoutConfig(),
      evmNonceFence: async () => {},
    }),
    /guarded Operations EVM signer/,
  );
});

test('permits a replacement only when nonce and calldata are unchanged', async () => {
  const { store } = await initialized();
  const counter = { sign: 0 };
  const client = rpc();
  const recoveryContexts = [];
  const cycleRepository = {
    async persistChainAttemptRecoveryContext(_cycleId, context) {
      recoveryContexts.push(structuredClone(context));
    },
  };
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const fencingToken = 'payout-fence-replacement-1';
  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: signer(counter),
    config: config(),
    cycleRepository,
    requestDigest,
    fencingToken,
  });
  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: signer(counter),
    config: config(),
    cycleRepository,
    requestDigest,
    fencingToken,
  });
  const signed = (await store.load()).recipients.find(entry => entry.recipient === RECIPIENT_A);
  await replaceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    replacementGasPriceWei: '3',
    signerClient: signer(counter),
    config: productionPayoutConfig(),
    evmNonceFence: async () => {},
    cycleRepository,
  });
  const replaced = (await store.load()).recipients.find(entry => entry.recipient === RECIPIENT_A);
  assert.equal(replaced.state, 'SIGNED');
  assert.equal(replaced.nonce, signed.nonce);
  assert.equal(replaced.calldataDigest, signed.calldataDigest);
  assert.notEqual(replaced.rawSignedBytesHash, signed.rawSignedBytesHash);
  assert.equal(recoveryContexts.length, 0);
  assert.equal(replaced.approvalContext.requestDigest, signed.approvalContext.requestDigest);
  assert.equal(replaced.approvalContext.fencingToken, signed.approvalContext.fencingToken);
  assert.notEqual(replaced.rawSignedBytesHash, signed.rawSignedBytesHash);

  await assert.rejects(
    () => replaceDirectPayout({
      payoutStore: store,
      recipient: RECIPIENT_A,
      replacementGasPriceWei: '2',
      signerClient: signer(counter),
      config: productionPayoutConfig(),
      evmNonceFence: async () => {},
    }),
    /increase the persisted transaction fee/,
  );
});

test('requires a wallet-wide nonce fence before replacement signing', async () => {
  const { store } = await initialized();
  const counter = { sign: 0 };
  const client = rpc();
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  const signedBeforeReplacement = counter.sign;

  await assert.rejects(
    () => replaceDirectPayout({
      payoutStore: store,
      recipient: RECIPIENT_A,
      replacementGasPriceWei: '3',
      signerClient: signer(counter),
      config: productionPayoutConfig(),
    }),
    /wallet-wide nonce fence/,
  );
  assert.equal(counter.sign, signedBeforeReplacement);

  let fenceCalls = 0;
  await replaceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    replacementGasPriceWei: '3',
    signerClient: signer(counter),
    config: productionPayoutConfig(),
    evmNonceFence: async () => { fenceCalls += 1; },
  });
  assert.equal(fenceCalls, 1);
});

test('reopens an earlier same-nonce finalized transaction with matching approval context after replacement', async t => {
  const { directory, repository: cycleRepository, cycleId } = await durableCycle(t);
  const plan = payoutPlan([
    { recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } },
  ], '9', cycleId);
  const store = createCycleRepositoryPayoutStore({ cycleRepository, cycleId });
  await initializeDirectPayout({
    payoutStore: store,
    plan,
    operations: OPERATIONS,
    usdgAddress: TOKEN,
    firstNonce: '0',
    gasPriceWei: '2',
  });
  const requestDigest = `sha256:${'a'.repeat(64)}`;
  const fencingToken = '11111111-1111-4111-8111-111111111111';
  await cycleRepository.reserveWalletNonce(cycleId, {
    chainId: '4663',
    wallet: OPERATIONS,
    stage: 'payout',
    fencingToken,
    leaseAcquiredAtMs: 0,
    leaseExpiresAtMs: Number.MAX_SAFE_INTEGER,
  });
  const counter = { sign: 0 };
  const client = rpc();
  const advance = () => advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: signer(counter),
    config: config(),
    cycleRepository,
    requestDigest,
    fencingToken,
  });
  await advance();
  await advance();
  let state = await store.load();
  const original = state.recipients.find(entry => entry.recipient === RECIPIENT_A);
  assert.equal(original.amount.amountAtomic, '9');
  await advance();

  await replaceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    replacementGasPriceWei: '5',
    signerClient: signer(counter),
    config: productionPayoutConfig(),
    evmNonceFence: async () => {},
    cycleRepository,
  });
  client.setReceiptResolver(async hash => {
    if (hash !== original.txHash) throw new TransactionReceiptNotFoundError({ hash });
    return {
      transactionHash: original.txHash,
      blockNumber: 100n,
      blockHash: `0x${'f'.repeat(64)}`,
      status: 'success',
      logs: [transferLog({ recipient: RECIPIENT_A, amountAtomic: original.amount.amountAtomic })],
    };
  });

  await advance();
  state = await store.load();
  const finalized = state.recipients.find(entry => entry.recipient === RECIPIENT_A);
  assert.equal(finalized.state, 'FINALIZED');
  assert.equal(finalized.txHash, original.txHash);
  assert.equal(finalized.approvalContext, null);
  assert.equal(counter.broadcasts.length, 1);

  const reopened = await CycleRepository.open(directory);
  const reopenedState = await reopened.readPagedPayoutState(cycleId, 'payout');
  const reopenedAttempt = reopenedState.recipients.find(entry => entry.recipient === RECIPIENT_A);
  assert.equal(reopenedAttempt.state, 'FINALIZED');
  assert.equal(reopenedAttempt.txHash, original.txHash);
  assert.equal(reopenedAttempt.approvalContext, null);
});

test('rejects a changed plan after the first broadcast and requires an exact finalized transfer delta', async () => {
  const { store } = await initialized();
  const counter = { sign: 0 };
  const client = rpc();
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  let state = await store.load();
  await advanceDirectPayout({ payoutStore: store, recipient: RECIPIENT_A, adapters: { robinhood: { client } }, signerClient: signer(counter), config: config() });
  state = await store.load();
  const attempt = state.recipients.find(entry => entry.recipient === RECIPIENT_A);
  assert.throws(
    () => assertPayoutManifestUnchanged(state, payoutPlan([
      { recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '3' } },
      { recipient: RECIPIENT_B, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } },
    ])),
    /immutable/,
  );
  await assert.rejects(
    () => initializeDirectPayout({
      payoutStore: store,
      plan: payoutPlan([
        { recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '3' } },
        { recipient: RECIPIENT_B, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } },
      ]),
      operations: OPERATIONS,
      usdgAddress: TOKEN,
      firstNonce: '0',
    }),
    /refuses to replace/,
  );

  client.setReceiptResolver(async () => ({
    transactionHash: attempt.txHash,
    blockNumber: 100n,
    blockHash: `0x${'f'.repeat(64)}`,
    status: 'success',
    logs: [transferLog({ recipient: RECIPIENT_A, amountAtomic: BigInt(attempt.amount.amountAtomic) - 1n })],
  }));
  await advanceDirectPayout({
    payoutStore: store,
    recipient: RECIPIENT_A,
    adapters: { robinhood: { client } },
    signerClient: signer(counter),
    config: config(),
  });
  assert.equal((await store.load()).recipients.find(entry => entry.recipient === RECIPIENT_A).state, 'BROADCAST');
});
