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
import { digest as canonicalDigest } from '../../../runner/src/cycle/journal.mjs';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { keccak256, TransactionReceiptNotFoundError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  compileDirectPayoutPlan,
  createNativePayoutAmount,
  DIRECT_PAYOUT_RECIPIENT_LIMIT,
} from '../../../runner/src/distribution/payout-plan.mjs';
import { DurableCycleStore } from '../../../runner/src/cycle/durable-store.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { ERC20_TRANSFER_TOPIC } from '../../src/robinhood-rpc.mjs';
import { wrapSignerClient } from '../../src/signing/signer-client.mjs';
import {
  advanceDirectPayout,
  assertPayoutManifestUnchanged,
  createDirectPayoutState,
  DirectPayoutBridgeAvailabilityUnknownError,
  DirectPayoutBridgeShortfallError,
  DirectPayoutFrozenAssetError,
  DirectPayoutNativeGasShortfallError,
  evaluateDirectPayoutBridgeAdmission,
  evaluateDirectPayoutFrozenAssetAdmission,
  evaluateDirectPayoutNativeGasAdmission,
  isDirectPayoutComplete,
  mutatePayout,
} from '../../src/app/stages/payout.mjs';

const signedFixtures = new Map();
const TOKEN = `0x${'a'.repeat(40)}`;
const ACCOUNT = privateKeyToAccount(`0x${'6'.repeat(64)}`);
const OPERATIONS = ACCOUNT.address.toLowerCase();
const RETURN_BINDING = Object.freeze({
  operations: OPERATIONS,
  assetId: 'native',
  evidenceDigest: `sha256:${'f'.repeat(64)}`,
});

function address(index) {
  return `0x${(index + 1).toString(16).padStart(40, '0')}`;
}

function usdg(amountAtomic) {
  return createNativePayoutAmount({ assetId: 'native', amountAtomic: String(amountAtomic) });
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

test('DIRECT_PAYOUT_RECIPIENT_LIMIT is exactly the literal 10,000 acceptance target these scale cases prove', () => {
  assert.equal(DIRECT_PAYOUT_RECIPIENT_LIMIT, 10_000);
});

const capacityCounts = [100, 200, 300, 400, 500, 600];

for (const count of [...capacityCounts, 1025, 1026, 10_000]) {
  test(`durable payout state scales to ${count} recipients without truncation or duplication`, () => {
    const plan = planFor(count);
    assert.equal(plan.allocations.length, count);
    assert.equal(plan.payableRecipientCount, count);
    assert.equal(plan.outcome, 'ALLOCATED');

    const state = createDirectPayoutState({ plan, operations: OPERATIONS, assetId: 'native', firstNonce: '0' });

    assert.equal(state.recipients.length, count);
    assert.equal(new Set(state.recipients.map(attempt => attempt.recipient)).size, count);
    const totalAllocated = state.recipients.reduce((sum, attempt) => sum + BigInt(attempt.amount.amountAtomic), 0n);
    assert.equal(totalAllocated + BigInt(state.dust.amountAtomic), BigInt(state.distributablePool.amountAtomic));
  });
}

for (const count of [...capacityCounts, 10_000]) {
  test(`prepared payout state for ${count} recipients persists and reopens through the actual durable paged store`, async t => {
    const plan = planFor(count);
    const state = createDirectPayoutState({ plan, operations: OPERATIONS, assetId: 'native', firstNonce: '0' });

    const directory = await mkdtemp(join(tmpdir(), 'hookemon-payout-resume-scale-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = await DurableCycleStore.open(directory);
    await store.persistPagedPayoutState(state.cycleId, 'payout', state);

    const reopened = await DurableCycleStore.open(directory);
    const read = await reopened.readPagedPayoutState(state.cycleId, 'payout');

    assert.deepEqual(read, state);
    assert.equal(read.recipients.length, count);
    assert.equal(new Set(read.recipients.map(attempt => attempt.recipient)).size, count);
    const totalAllocated = read.recipients.reduce((sum, attempt) => sum + BigInt(attempt.amount.amountAtomic), 0n);
    assert.equal(totalAllocated + BigInt(read.dust.amountAtomic), BigInt(read.distributablePool.amountAtomic));
  });
}

function sha256Digest(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function signedBytesDigest(rawSignedBytes) {
  return `sha256:${createHash('sha256').update(Buffer.from(rawSignedBytes.slice(2), 'hex')).digest('hex')}`;
}

const SOURCE_BALANCE_BEFORE = 999_999_999_999_999_999_999_999n;

/**
 * Upgrades a real PREPARED attempt (recipient/amount/calldata/calldataDigest/gasPriceWei already
 * computed by the production `createDirectPayoutState`) to a domain-valid FINALIZED attempt: every
 * field `normalizeAttempt` checks (typed amount, signed-byte/hash triple, 15-field finality
 * evidence, 7-field approval context, unique nonce) is populated with internally consistent, valid-
 * shaped fixture evidence -- not live-signed and not broadcast, but shaped exactly as the real
 * transition path would leave it.
 */
function finalizeRecipient(prepared, index, operations) {
  const nonce = String(index);
  const rawSignedBytes = `0x${(index + 1).toString(16).padStart(64, '0')}`;
  const rawSignedBytesHash = keccak256(rawSignedBytes).toLowerCase();
  const amount = prepared.amount;
  const finalizedBlockHash = `0x${'9'.repeat(64)}`;
  const previousBlockHash = `0x${'8'.repeat(64)}`;
  return {
    ...prepared,
    state: 'FINALIZED',
    nonce,
    rawSignedBytes,
    rawSignedBytesHash,
    txHash: rawSignedBytesHash,
    finalizedTransfer: (() => {
      const facts = {schema:'hookemon.native-payment-proof.v1',kind:'direct',chainId:'4663',assetId:'native',decimals:18,
        transactionHash:rawSignedBytesHash,transactionDigest:canonicalDigest(rawSignedBytes),blockNumber:'100',blockHash:finalizedBlockHash,
        timestampUnixSeconds:'1700000000',source:operations,recipient:prepared.recipient,amountWei:amount.amountAtomic,
        calldataDigest:keccak256('0x'),nonce,receiptStatus:'success',gasSpentWei:'100000'};
      return {...facts,evidenceDigest:canonicalDigest(facts)};
    })(),
    approvalContext: {
      requestDigest: null,
      fencingToken: null,
      fencingTokenDigest: null,
      policyDigest: sha256Digest(`policy-${index}`),
      approvalDigest: sha256Digest(`approval-${index}`),
      approvedSemanticsDigest: sha256Digest(`semantics-${index}`),
      signedMessageDigest: signedBytesDigest(rawSignedBytes),
    },
  };
}

// Independent review (scale-review.md) found the prior 10,000-recipient durable proof PREPARED-only,
// and the older durable-store.test.mjs:827 synthetic fixture domain-invalid (untyped amount, missing
// calldata/signature/finality/replacement fields, non-EVM recipients) -- so neither proves the real
// finalized shape survives paging. This test proves that shape specifically: fully FINALIZED, no
// replacement history, no quarantine, no held-position exclusions. It does not claim to cover the
// bounded replacement/quarantine/held-exclusion envelope's own worst-case overhead -- that is a
// narrower, separate claim this test does not make.
for (const count of [...capacityCounts, 10_000]) {
  test(`synthetic finalized payout state for ${count} recipients persists and reopens with valid manifest and conservation`, async t => {
    const plan = planFor(count);
    const initial = createDirectPayoutState({ plan, operations: OPERATIONS, assetId: 'native', firstNonce: '0' });

    const finalizedState = {
      ...initial,
      manifestFrozen: true,
      feasibilityChecked: true,
      nextNonce: String(count),
      recipients: initial.recipients.map((prepared, index) => finalizeRecipient(prepared, index, OPERATIONS)),
    };

    // Domain validity before persistence: both normalizers walk every recipient/evidence field.
    assert.equal(isDirectPayoutComplete(finalizedState), true);
    assert.equal(assertPayoutManifestUnchanged(finalizedState, plan), true);

    const directory = await mkdtemp(join(tmpdir(), 'hookemon-payout-resume-scale-finalized-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = await DurableCycleStore.open(directory);
    await store.persistPagedPayoutState(finalizedState.cycleId, 'payout', finalizedState);

    const reopened = await DurableCycleStore.open(directory);
    const read = await reopened.readPagedPayoutState(finalizedState.cycleId, 'payout');

    // Every recipient/evidence field, including nonces, signature hashes, and finality evidence,
    // survives the encode/page/decode round trip exactly.
    assert.deepEqual(read, finalizedState);

    // Domain validity after the round trip: proves resume normalization, not just raw byte equality.
    assert.equal(isDirectPayoutComplete(read), true);
    assert.equal(assertPayoutManifestUnchanged(read, plan), true);

    assert.equal(read.recipients.length, count);
    assert.equal(new Set(read.recipients.map(attempt => attempt.recipient)).size, count);
    assert.equal(read.recipients.every(attempt => attempt.state === 'FINALIZED'), true);
    assert.equal(new Set(read.recipients.map(attempt => attempt.nonce)).size, count);
    assert.equal(new Set(read.recipients.map(attempt => attempt.txHash)).size, count);
    const paid = read.recipients.reduce((sum, attempt) => sum + BigInt(attempt.amount.amountAtomic), 0n);
    assert.equal(paid + BigInt(read.dust.amountAtomic), BigInt(read.distributablePool.amountAtomic));
  });
}

for (const count of capacityCounts) {
  test(`payout plan for ${count} recipients rejects undersized recipient, transaction and fee envelopes`, () => {
    const compile = manifest => compileDirectPayoutPlan({
      cycleId: 'cycle-resume-scale', eligibilityManifest: manifest,
      finalizedReturn: usdg(count), previousDust: usdg('0'), returnBinding: RETURN_BINDING,
    });
    for (const field of ['maxRecipientCount', 'maxTransactionCount']) {
      const manifest = eligibilityManifest(count);
      manifest.feasibility[field] = count - 1;
      assert.throws(() => compile(manifest), /envelope cannot support every frozen recipient/);
    }
    const manifest = eligibilityManifest(count);
    manifest.feasibility.nativeBalance.amountAtomic = (BigInt(manifest.feasibility.requiredNativeAmount.amountAtomic) - 1n).toString();
    assert.throws(() => compile(manifest), /native-balance feasibility envelope is inconsistent/);
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
  const usdgAsset = { chainId: '4663', assetId: 'native', decimals: 18 };
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
      schema: 'hookemon.money-configuration.v2',
      assets: { eth: usdgAsset, solanaStablecoin },
      minimums: {
        robinhoodReceive: { ...usdgAsset, amountAtomic: '0' },
        solanaReceive: { ...solanaStablecoin, amountAtomic: '0' },
        returnEth: { ...usdgAsset, amountAtomic: '0' },
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
    status: 'success',gasUsed:50000n,effectiveGasPrice:2n,
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
    async getChainId() { return 4663; },
    async getTransaction({hash}) { return {...signedFixtures.get(hash),blockNumber:100n,blockHash:`0x${'9'.repeat(64)}`}; },
    async getTransactionCount() { return nonce; },
    async getBalance() { return 1_000_000_000n; },
    async readCycleAttributableFinalizedAvailable() {
      return { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '999999999999999999999999' };
    },
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
          const signedTx=await ACCOUNT.signTransaction(signingTransaction);
          signedFixtures.set(keccak256(signedTx),{...signingTransaction,hash:keccak256(signedTx),from:OPERATIONS});
          return {signedTx};
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
  const store = memoryStore(createDirectPayoutState({ plan, operations: OPERATIONS, assetId: 'native', firstNonce: '0' }));
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
    plan, operations: OPERATIONS, assetId: 'native', firstNonce: '0', inFlightWindow: 2,
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
    plan, operations: OPERATIONS, assetId: 'native', firstNonce: '0', inFlightWindow: 2,
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

test('native-gas admission reports the exact wei deficit and never claims OK when balance falls short', () => {
  const shortfall = evaluateDirectPayoutNativeGasAdmission({
    requiredNativeAmount: '100',
    observedNativeBalance: '90',
  });
  assert.equal(shortfall.outcome, 'NON_SPENDING_NATIVE_GAS_SHORTFALL');
  assert.equal(shortfall.deficit, '10');

  const ok = evaluateDirectPayoutNativeGasAdmission({
    requiredNativeAmount: '100',
    observedNativeBalance: '100',
  });
  assert.equal(ok.outcome, 'OK');
  assert.equal(ok.deficit, '0');
});

function shortfallPlan(finalizedReturnAtomic) {
  return compileDirectPayoutPlan({
    cycleId: 'cycle-resume-scale',
    eligibilityManifest: eligibilityManifest(1),
    finalizedReturn: usdg(finalizedReturnAtomic),
    previousDust: usdg('0'),
    returnBinding: RETURN_BINDING,
  });
}

function shortfallCycleRepository() {
  const holds = [];
  let stored = null;
  return {
    holds,
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
    getStored: () => stored,
  };
}

test('mutatePayout refuses a 100-required/99-available bridge shortfall before touching state or dust, even with unrelated wallet funds', async () => {
  const plan = shortfallPlan('100');
  assert.equal(plan.distributablePool.amountAtomic, '100');
  const context = {
    cycleId: plan.cycleId,
    requestDigest: `sha256:${'c'.repeat(64)}`,
    fencingToken: 'payout-fence-bridge-shortfall-1',
  };
  const cycleRepository = shortfallCycleRepository();
  const client = {
    ...windowRpc(),
    async getBalance() { return 999_999_999_999n; }, // unrelated wallet-wide funds; must never fund the shortfall
    async readCycleAttributableFinalizedAvailable() {
      return { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '99' };
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
      adapters: { robinhood: { client } },
      signerClient: lifecycleSigner(counter),
    }),
    error => error instanceof DirectPayoutBridgeShortfallError && error.deficit === '1',
  );

  assert.equal(counter.sign, 0);
  assert.equal(cycleRepository.getStored(), null, 'no recipient state is ever persisted for a bridge-shortfall admission refusal');
  assert.equal(cycleRepository.holds.length, 1);
  assert.equal(cycleRepository.holds[0].terminalState, 'HELD_UNAVAILABLE');
  assert.equal(cycleRepository.holds[0].evidence.admission.outcome, 'NON_SPENDING_BRIDGE_SHORTFALL');
  assert.equal(cycleRepository.holds[0].evidence.admission.deficit, '1');
});

test('mutatePayout fails closed when composition supplies no cycle-attributable finalized-available reader', async () => {
  const plan = shortfallPlan('100');
  const context = {
    cycleId: plan.cycleId,
    requestDigest: `sha256:${'d'.repeat(64)}`,
    fencingToken: 'payout-fence-bridge-unknown-1',
  };
  const cycleRepository = shortfallCycleRepository();
  const { readCycleAttributableFinalizedAvailable: _omit, ...clientWithoutReader } = windowRpc();
  const counter = { sign: 0 };

  await assert.rejects(
    mutatePayout({
      liveMode: true,
      config: lifecycleConfig(),
      cycleRepository,
      context,
      request: { plan },
      adapters: { robinhood: { client: clientWithoutReader } },
      signerClient: lifecycleSigner(counter),
    }),
    error => error instanceof DirectPayoutBridgeAvailabilityUnknownError,
  );

  assert.equal(counter.sign, 0);
  assert.equal(cycleRepository.getStored(), null, 'no recipient state is ever persisted while bridge availability is unknown');
  assert.equal(cycleRepository.holds.length, 1);
  assert.equal(cycleRepository.holds[0].terminalState, 'HELD_UNAVAILABLE');
  assert.equal(cycleRepository.holds[0].evidence.admission.outcome, 'NON_SPENDING_BRIDGE_AVAILABILITY_UNKNOWN');
});

test('mutatePayout rechecks native gas before durable admission and records the exact deficit', async () => {
  const plan = planFor(1);
  const required = BigInt(plan.feasibility.requiredNativeAmount.amountAtomic);
  const observed = required + BigInt(plan.distributablePool.amountAtomic) - 10n;
  const context = {
    cycleId: plan.cycleId,
    requestDigest: `sha256:${'e'.repeat(64)}`,
    fencingToken: 'payout-fence-native-gas-1',
  };
  const cycleRepository = shortfallCycleRepository();
  const client = {
    ...windowRpc(),
    async getBalance() { return observed; },
  };
  const counter = { sign: 0 };

  await assert.rejects(
    mutatePayout({
      liveMode: true,
      config: lifecycleConfig(),
      cycleRepository,
      context,
      request: { plan },
      adapters: { robinhood: { client } },
      signerClient: lifecycleSigner(counter),
    }),
    error => error instanceof DirectPayoutNativeGasShortfallError && error.deficit === '10',
  );

  assert.equal(counter.sign, 0);
  assert.equal(cycleRepository.getStored(), null, 'no recipient state is ever persisted for a native-gas admission refusal');
  assert.equal(cycleRepository.holds.length, 1);
  assert.equal(cycleRepository.holds[0].terminalState, 'HELD_UNAVAILABLE');
  assert.equal(cycleRepository.holds[0].evidence.admission.outcome, 'NON_SPENDING_NATIVE_GAS_SHORTFALL');
  assert.equal(cycleRepository.holds[0].evidence.admission.deficit, '10');
});


for (const [balance, admitted] of [[110n, false], [120n, true]]) {
  test(`native payout admission ${admitted ? 'accepts exact' : 'refuses insufficient'} combined principal and gas before dust consumption`, async () => {
    const manifest = eligibilityManifest(1);
    manifest.feasibility = {
      ...manifest.feasibility,
      measuredTransferGas: '2', maxGasPriceWei: '5',
      estimatedNativeFee: usdg('10'), nativeReserve: usdg('10'),
      nativeBalance: usdg('20'), requiredNativeAmount: usdg('20'),
    };
    const plan = compileDirectPayoutPlan({
      cycleId: manifest.cycleId, eligibilityManifest: manifest,
      finalizedReturn: usdg('90'), previousDust: usdg('10'),
      previousDustSource: { cycleId: 'prior-native', digest: `sha256:${'a'.repeat(64)}`, planDigest: `sha256:${'b'.repeat(64)}` },
      returnBinding: RETURN_BINDING,
    });
    const cycleRepository = shortfallCycleRepository();
    let dustConsumptions = 0;
    const initialize = cycleRepository.consumePayoutDustAndPersistPagedPayoutState;
    cycleRepository.consumePayoutDustAndPersistPagedPayoutState = async (...args) => {
      dustConsumptions += 1;
      await initialize(...args);
      throw new Error('admitted checkpoint reached');
    };
    const client = { ...windowRpc(), async getBalance() { return balance; }, async readCycleAttributableFinalizedAvailable() { return usdg('100'); } };
    const counter = { sign: 0 };
    await assert.rejects(() => mutatePayout({
      liveMode: true, config: lifecycleConfig(), cycleRepository,
      context: { cycleId: plan.cycleId, requestDigest: `sha256:${'c'.repeat(64)}`, fencingToken: 'native-combined-admission' },
      request: { plan }, adapters: { robinhood: { client } }, signerClient: lifecycleSigner(counter),
    }), admitted ? /admitted checkpoint reached/ : error => error instanceof DirectPayoutNativeGasShortfallError && error.deficit === '10');
    assert.equal(dustConsumptions, admitted ? 1 : 0);
    assert.equal(cycleRepository.getStored() !== null, admitted);
    assert.equal(counter.sign, 0);
    assert.equal(cycleRepository.holds.length, admitted ? 0 : 1);
  });
}
