// Focused scale and bounded-in-flight-window coverage for the direct-payout money path (task
// LAUNCH-D). These tests exist alongside stages-payout.test.mjs rather than duplicating its full
// broadcast/finality lifecycle suite; they isolate exactly the two behaviors D changed:
//
//   1. `compileDirectPayoutPlan`/`createDirectPayoutState` no longer truncate recipient counts
//      above the old 1,025 implementation ceiling (packages/runner/src/distribution/payout-plan.mjs).
//   2. `advanceDirectPayout`'s dispatch admits a bounded, durable, nonce-aware in-flight window of
//      concurrently BROADCAST-but-not-yet-finalized recipients, instead of requiring one recipient
//      to reach terminal state before the next may even be signed
//      (packages/adapters/src/app/stages/payout.mjs).
import assert from 'node:assert/strict';
import test from 'node:test';

import { keccak256, TransactionReceiptNotFoundError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { compileDirectPayoutPlan, createUsdgPayoutAmount } from '../../../runner/src/distribution/payout-plan.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { ERC20_TRANSFER_TOPIC } from '../../src/robinhood-rpc.mjs';
import { wrapSignerClient } from '../../src/signing/signer-client.mjs';
import {
  advanceDirectPayout,
  createDirectPayoutState,
  DirectPayoutFrozenAssetError,
  evaluateDirectPayoutBridgeAdmission,
  evaluateDirectPayoutFrozenAssetAdmission,
  isDirectPayoutComplete,
  mutatePayout,
} from '../../src/app/stages/payout.mjs';

const TOKEN = `0x${'a'.repeat(40)}`;
const ACCOUNT = privateKeyToAccount(`0x${'6'.repeat(64)}`);
const OPERATIONS = ACCOUNT.address.toLowerCase();
const RETURN_BINDING = Object.freeze({
  operations: OPERATIONS,
  usdgAddress: TOKEN,
  evidenceDigest: `sha256:${'f'.repeat(64)}`,
});

function address(index) {
  return `0x${(index + 1).toString(16).padStart(40, '0')}`;
}

function usdg(amountAtomic) {
  return createUsdgPayoutAmount({ assetId: TOKEN, amountAtomic: String(amountAtomic) });
}

function eligibilityManifest(count) {
  const entries = Array.from({ length: count }, (_, index) => ({
    recipient: address(index),
    hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' },
  })).sort((left, right) => (left.recipient < right.recipient ? -1 : 1));
  const estimatedNativeFee = (BigInt(count) * 100_000n).toString();
  const requiredNativeAmount = (BigInt(estimatedNativeFee) + 10n).toString();
  return {
    schema: 'hookemon.eligibility-payout-manifest.v1',
    cycleId: 'cycle-resume-scale',
    snapshotBlock: '10',
    snapshotHash: `0x${'b'.repeat(64)}`,
    finality: { policyId: 'robinhood-stage-finality-v1', depth: '2' },
    supply: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: String(count) },
    entries,
    exclusions: [],
    feasibility: {
      recipientCount: count,
      transactionCount: count,
      maxRecipientCount: count,
      maxTransactionCount: count,
      measuredTransferGas: '50000',
      maxGasPriceWei: '2',
      estimatedNativeFee: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: estimatedNativeFee },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '10' },
      nativeBalance: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: requiredNativeAmount },
      requiredNativeAmount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: requiredNativeAmount },
      feasible: true,
      reason: null,
    },
    logCompleteness: {
      mode: 'single-source-explicitly-allowed',
      primary: { sourceId: 'primary', transferLogDigest: `sha256:${'c'.repeat(64)}`, logCount: count },
      secondary: null,
    },
    holderSnapshotDigest: `sha256:${'d'.repeat(64)}`,
    launchManifestDigest: `sha256:${'e'.repeat(64)}`,
  };
}

function planFor(count) {
  return compileDirectPayoutPlan({
    cycleId: 'cycle-resume-scale',
    eligibilityManifest: eligibilityManifest(count),
    finalizedReturn: usdg(count),
    previousDust: usdg('0'),
    returnBinding: RETURN_BINDING,
  });
}

for (const count of [1025, 1026, 10_000]) {
  test(`durable payout state scales to ${count} recipients without truncation or duplication`, () => {
    const plan = planFor(count);
    assert.equal(plan.allocations.length, count);
    assert.equal(plan.payableRecipientCount, count);
    assert.equal(plan.outcome, 'ALLOCATED');

    const state = createDirectPayoutState({ plan, operations: OPERATIONS, usdgAddress: TOKEN, firstNonce: '0' });

    assert.equal(state.recipients.length, count);
    assert.equal(new Set(state.recipients.map(attempt => attempt.recipient)).size, count);
    const totalAllocated = state.recipients.reduce((sum, attempt) => sum + BigInt(attempt.amount.amountAtomic), 0n);
    assert.equal(totalAllocated + BigInt(state.dust.amountAtomic), BigInt(state.distributablePool.amountAtomic));
  });
}

function memoryStore(initial) {
  let current = structuredClone(initial);
  return {
    async load() { return structuredClone(current); },
    async persist(value) { current = structuredClone(value); },
  };
}

function lifecycleConfig() {
  const usdgAsset = { chainId: '4663', assetId: TOKEN, decimals: 6 };
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
      assets: { usdg: usdgAsset, solanaStablecoin },
      minimums: {
        robinhoodReceive: { ...usdgAsset, amountAtomic: '0' },
        solanaReceive: { ...solanaStablecoin, amountAtomic: '0' },
        returnUsdg: { ...usdgAsset, amountAtomic: '0' },
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

function addressTopic(value) {
  return `0x${'0'.repeat(24)}${value.slice(2).toLowerCase()}`;
}

function receiptFor({ transactionHash, recipient, amountAtomic }) {
  return {
    transactionHash,
    blockNumber: 100n,
    blockHash: `0x${'9'.repeat(64)}`,
    status: 'success',
    logs: [{
      address: TOKEN,
      topics: [ERC20_TRANSFER_TOPIC, addressTopic(OPERATIONS), addressTopic(recipient)],
      data: `0x${BigInt(amountAtomic).toString(16).padStart(64, '0')}`,
      logIndex: '0',
    }],
  };
}

/** A minimal chain fake supporting several independently-tracked pending/finalized receipts. */
function windowRpc() {
  let nonce = 0n;
  const receipts = new Map();
  let lastAppliedAmount = 0n;
  const client = {
    async readContract({ functionName }) {
      assert.equal(functionName, 'isFrozen');
      return false;
    },
    async getTransactionCount() { return nonce; },
    async getBalance() { return 1_000_000_000n; },
    async getTransactionReceipt({ hash }) {
      const receipt = receipts.get(hash);
      if (!receipt) throw new TransactionReceiptNotFoundError({ hash });
      lastAppliedAmount = BigInt(receipt.logs[0].data);
      return receipt;
    },
    async getBlock({ blockNumber } = {}) {
      if (blockNumber === 99n) return { number: 99n, hash: `0x${'8'.repeat(64)}`, timestamp: 1_700_000_000n };
      return { number: 100n, hash: `0x${'9'.repeat(64)}`, parentHash: `0x${'8'.repeat(64)}`, timestamp: 1_700_000_012n };
    },
    setNonce(value) { nonce = BigInt(value); },
    finalize(hash, receipt) { receipts.set(hash, receipt); },
  };
  client.historicalEvidenceClient = {
    async readErc20BalanceAtBlock({ account, blockNumber, blockHash }) {
      const value = account.toLowerCase() === OPERATIONS
        ? (blockNumber === 99n ? 1_000_000_000n : 1_000_000_000n - lastAppliedAmount)
        : (blockNumber === 99n ? 0n : lastAppliedAmount);
      return { value, blockNumber, blockHash };
    },
  };
  return client;
}

function lifecycleSigner(counter) {
  return {
    evm: wrapSignerClient({
      role: 'operator-evm',
      liveMode: true,
      preflightAuthority: createTestProfileMutationAuthority(),
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

async function advanceUntil({ store, recipient, adapters, signerClient, config, state }) {
  while (true) {
    const before = JSON.stringify(await store.load());
    const after = await advanceDirectPayout({ payoutStore: store, recipient, adapters, signerClient, config });
    if (after.recipients.find(a => a.recipient === recipient).state === state) return after;
    if (JSON.stringify(after) === before) return after;
  }
}

test('a window of 1 keeps the original fully-serial requirement: a later recipient cannot be touched before the earlier one is broadcast', async () => {
  const plan = planFor(3);
  const store = memoryStore(createDirectPayoutState({ plan, operations: OPERATIONS, usdgAddress: TOKEN, firstNonce: '0' }));
  const client = windowRpc();
  const counter = { sign: 0 };
  const signerClient = lifecycleSigner(counter);
  const adapters = { robinhood: { client } };

  await assert.rejects(
    advanceDirectPayout({ payoutStore: store, recipient: address(1), adapters, signerClient, config: lifecycleConfig() }),
    /must reconcile/,
  );
});

test('a wider in-flight window lets several recipients await finality concurrently, bounded by the window', async () => {
  const plan = planFor(4);
  const state = createDirectPayoutState({
    plan, operations: OPERATIONS, usdgAddress: TOKEN, firstNonce: '0', inFlightWindow: 2,
  });
  const store = memoryStore(state);
  const client = windowRpc();
  const counter = { sign: 0 };
  const signerClient = lifecycleSigner(counter);
  const adapters = { robinhood: { client } };
  const cfg = lifecycleConfig();

  // Recipient 0 reaches BROADCAST (its nonce is now live on-chain).
  await advanceUntil({ store, recipient: address(0), adapters, signerClient, config: cfg, state: 'BROADCAST' });
  client.setNonce('1');
  // With the earlier recipient no longer PREPARED, recipient 1 may now also reach BROADCAST --
  // *before* recipient 0 has finalized -- because the window (2) is not yet full.
  await advanceUntil({ store, recipient: address(1), adapters, signerClient, config: cfg, state: 'BROADCAST' });
  client.setNonce('2');

  const bothInFlight = await store.load();
  assert.deepEqual(
    bothInFlight.recipients.slice(0, 2).map(attempt => attempt.state),
    ['BROADCAST', 'BROADCAST'],
  );

  // The window (2) is now full: recipient 2 must wait even though recipient 1 was reachable.
  await assert.rejects(
    advanceDirectPayout({ payoutStore: store, recipient: address(2), adapters, signerClient, config: cfg }),
    /in-flight window \(2\) is full/,
  );

  // Finalizing recipient 0 first (not recipient 1) proves finality order is independent of
  // dispatch order: one slow confirmation does not block the recipient behind it.
  const beforeFinal = await store.load();
  const attempt0 = beforeFinal.recipients[0];
  client.finalize(attempt0.txHash, receiptFor({
    transactionHash: attempt0.txHash, recipient: attempt0.recipient, amountAtomic: attempt0.amount.amountAtomic,
  }));
  const afterFirstFinal = await advanceDirectPayout({ payoutStore: store, recipient: address(0), adapters, signerClient, config: cfg });
  assert.equal(afterFirstFinal.recipients[0].state, 'FINALIZED');
  assert.equal(afterFirstFinal.recipients[1].state, 'BROADCAST');

  // The window slid forward: recipient 2 can now start.
  client.setNonce('2');
  await advanceUntil({ store, recipient: address(2), adapters, signerClient, config: cfg, state: 'BROADCAST' });
  client.setNonce('3');

  const attempt1 = (await store.load()).recipients[1];
  client.finalize(attempt1.txHash, receiptFor({
    transactionHash: attempt1.txHash, recipient: attempt1.recipient, amountAtomic: attempt1.amount.amountAtomic,
  }));
  await advanceDirectPayout({ payoutStore: store, recipient: address(1), adapters, signerClient, config: cfg });
  const attempt2 = (await store.load()).recipients[2];
  client.finalize(attempt2.txHash, receiptFor({
    transactionHash: attempt2.txHash, recipient: attempt2.recipient, amountAtomic: attempt2.amount.amountAtomic,
  }));
  await advanceDirectPayout({ payoutStore: store, recipient: address(2), adapters, signerClient, config: cfg });
  await advanceUntil({ store, recipient: address(3), adapters, signerClient, config: cfg, state: 'BROADCAST' });
  const attempt3 = (await store.load()).recipients[3];
  client.finalize(attempt3.txHash, receiptFor({
    transactionHash: attempt3.txHash, recipient: attempt3.recipient, amountAtomic: attempt3.amount.amountAtomic,
  }));
  const final = await advanceDirectPayout({ payoutStore: store, recipient: address(3), adapters, signerClient, config: cfg });

  assert.equal(isDirectPayoutComplete(final), true);
  assert.deepEqual(final.recipients.map(attempt => attempt.state), ['FINALIZED', 'FINALIZED', 'FINALIZED', 'FINALIZED']);
  const paid = final.recipients.reduce((sum, attempt) => sum + BigInt(attempt.amount.amountAtomic), 0n);
  assert.equal(paid + BigInt(final.dust.amountAtomic), BigInt(final.distributablePool.amountAtomic));
  assert.equal(new Set(final.recipients.map(attempt => attempt.txHash)).size, 4);
});

test('an in-flight recipient resumes after a simulated restart without re-signing', async () => {
  const plan = planFor(2);
  const state = createDirectPayoutState({
    plan, operations: OPERATIONS, usdgAddress: TOKEN, firstNonce: '0', inFlightWindow: 2,
  });
  const store = memoryStore(state);
  const client = windowRpc();
  const counter = { sign: 0 };
  const signerClient = lifecycleSigner(counter);
  const adapters = { robinhood: { client } };
  const cfg = lifecycleConfig();

  const broadcastState = await advanceUntil({ store, recipient: address(0), adapters, signerClient, config: cfg, state: 'BROADCAST' });
  assert.equal(counter.sign, 1);

  // Simulate a process restart: a fresh store wrapping the same persisted snapshot.
  const restartedStore = memoryStore(broadcastState);
  const restartCounter = { sign: 0 };
  const restartSigner = lifecycleSigner(restartCounter);
  const reconciled = await advanceDirectPayout({
    payoutStore: restartedStore, recipient: address(0), adapters, signerClient: restartSigner, config: cfg,
  });
  assert.equal(reconciled.recipients[0].state, 'BROADCAST');
  assert.equal(restartCounter.sign, 0, 'recovery must not sign a second transaction for an already-broadcast recipient');
});

test('bridge admission reports the exact deficit and never claims OK when available proceeds fall short', () => {
  const shortfall = evaluateDirectPayoutBridgeAdmission({
    attributableDistributableAmount: '100',
    finalizedAvailableAmount: '99',
  });
  assert.equal(shortfall.outcome, 'NON_SPENDING_BRIDGE_SHORTFALL');
  assert.equal(shortfall.deficit, '1');

  const ok = evaluateDirectPayoutBridgeAdmission({
    attributableDistributableAmount: '100',
    finalizedAvailableAmount: '100',
  });
  assert.equal(ok.outcome, 'OK');
  assert.equal(ok.deficit, '0');
});

test('frozen-asset admission preserves the full pool as unsent liability plus dust, spending nothing', () => {
  const frozen = evaluateDirectPayoutFrozenAssetAdmission({
    frozen: true,
    attributableDistributableAmount: '101',
    dust: '1',
  });
  assert.equal(frozen.outcome, 'NON_SPENDING_FROZEN_ASSET');
  assert.equal(frozen.finalized, '0');
  assert.equal(frozen.pending, '0');
  assert.equal(frozen.unsentLiability, '100');
  assert.equal(frozen.remainingDust, '1');
  assert.equal(BigInt(frozen.unsentLiability) + BigInt(frozen.remainingDust), 101n);

  const notFrozen = evaluateDirectPayoutFrozenAssetAdmission({ frozen: false, attributableDistributableAmount: '101', dust: '1' });
  assert.equal(notFrozen.outcome, 'OK');
});

test('mutatePayout admits and signs nothing when USDG is frozen for the Operations sender, and holds the cycle', async () => {
  const plan = planFor(2);
  const context = {
    cycleId: plan.cycleId,
    requestDigest: `sha256:${'b'.repeat(64)}`,
    fencingToken: 'payout-fence-frozen-1',
  };
  let stored = null;
  const holds = [];
  const cycleRepository = {
    async readPagedPayoutState() { return stored === null ? null : structuredClone(stored); },
    async persistPagedPayoutState(_cycleId, _stage, state) { stored = structuredClone(state); },
    async consumePayoutDustAndPersistPagedPayoutState(_cycleId, input) {
      stored = structuredClone(input.evidence);
      return { evidence: structuredClone(stored), consumption: null };
    },
    async describeCycle() { return { custodyLedgers: new Map() }; },
    async recordCustodyLedger() {},
    async reserveWalletNonce() {},
    async assertWalletNonce() {},
    async holdCycle(cycleId, terminalState, evidence) { holds.push({ cycleId, terminalState, evidence }); },
  };
  const baseClient = windowRpc();
  const frozenClient = {
    ...baseClient,
    async readContract({ functionName, args }) {
      assert.equal(functionName, 'isFrozen');
      return args[0].toLowerCase() === OPERATIONS;
    },
  };
  const counter = { sign: 0 };

  await assert.rejects(
    mutatePayout({
      liveMode: true,
      config: lifecycleConfig(),
      cycleRepository,
      context,
      request: { plan },
      adapters: { robinhood: { client: frozenClient } },
      signerClient: lifecycleSigner(counter),
    }),
    error => error instanceof DirectPayoutFrozenAssetError,
  );

  assert.equal(counter.sign, 0);
  assert.equal(stored, null, 'no recipient state is ever persisted for a frozen-asset admission refusal');
  assert.equal(holds.length, 1);
  assert.equal(holds[0].terminalState, 'HELD_UNAVAILABLE');
  assert.equal(holds[0].evidence.admission.outcome, 'NON_SPENDING_FROZEN_ASSET');
  assert.equal(holds[0].evidence.admission.unsentLiability, plan.totalAllocated.amountAtomic);
  assert.equal(holds[0].evidence.admission.remainingDust, plan.dust.amountAtomic);
});
