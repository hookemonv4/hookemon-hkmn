import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { keccak256, parseTransaction, TransactionReceiptNotFoundError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { compileDirectPayoutPlan, createNativePayoutAmount } from '../../../runner/src/distribution/payout-plan.mjs';
import { AutomatedCycleService } from '../../../runner/src/automation/automated-cycle-service.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { digest as journalDigest } from '../../../runner/src/cycle/journal.mjs';
import { wrapSignerClient } from '../../src/signing/signer-client.mjs';
import { createNativePaymentProof } from '../../src/native-payment-proof.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { createStageDriver } from '../../src/app/stage-driver.mjs';
import {
  createDirectPayoutState,
  isDirectPayoutComplete,
  isRecipientPaid,
  recoverDroppedBroadcast,
  retryRefusedPayoutRecipient,
  DirectPayoutNonceInterferenceError,
} from '../../src/app/stages/payout.mjs';

const ACCOUNT = privateKeyToAccount(`0x${'6'.repeat(64)}`);
const OPERATIONS = ACCOUNT.address.toLowerCase();
const TOKEN = `0x${'a'.repeat(40)}`;
const RECIPIENT = `0x${'1'.repeat(40)}`;
const ORIGINAL_BYTES = '0xf861800182c3509411111111111111111111111111111111111111110180822491a0833577311718dac271aa20257f1559334716633061668565425fd4d4929f98b6a027e95bbdebe90099497267028c1654c0631e425548506754f8acb9d6cb2cf976';
const RETRY_BYTES = '0xf861010182c3509411111111111111111111111111111111111111110180822492a037eb36989078e2e7987c0ff9ea221e334195509b611e6d56660f93720111adb2a0590c5fceb1fcd7a29a53033e3c67c31cb2eaa3823ca950cabd4e38df6e9232d1';
const ORIGINAL_HASH = keccak256(ORIGINAL_BYTES);
const RETRY_HASH = keccak256(RETRY_BYTES);

test('recoverDroppedBroadcast rejects invalid recovery input without referencing retry-only fields', async () => {
  await assert.rejects(
    () => recoverDroppedBroadcast({ state: null, attempt: null }),
    /recipient attempt/,
  );
});

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;
}

function plan() {
  const amount = createNativePayoutAmount({ assetId: 'native', amountAtomic: '1' });
  const manifest = {
    schema: 'hookemon.eligibility-payout-manifest.v1',
    cycleId: 'cycle-refused-retry',
    snapshotBlock: '10',
    snapshotHash: `0x${'b'.repeat(64)}`,
    finality: { policyId: 'robinhood-stage-finality-v1', depth: '2' },
    supply: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' },
    entries: [{
      recipient: RECIPIENT,
      hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' },
    }],
    exclusions: [],
    feasibility: {
      recipientCount: 1,
      transactionCount: 1,
      maxRecipientCount: 1,
      maxTransactionCount: 1,
      measuredTransferGas: '50000',
      maxGasPriceWei: '5',
      estimatedNativeFee: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '250000' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '10' },
      nativeBalance: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '250010' },
      requiredNativeAmount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '250010' },
      feasible: true,
      reason: null,
    },
    logCompleteness: {
      mode: 'single-source-explicitly-allowed',
      primary: { sourceId: 'primary', transferLogDigest: digest('transfers'), logCount: 1 },
      secondary: null,
    },
    holderSnapshotDigest: digest('holder'),
    launchManifestDigest: digest('launch'),
  };
  return compileDirectPayoutPlan({
    cycleId: 'cycle-refused-retry',
    eligibilityManifest: manifest,
    finalizedReturn: amount,
    previousDust: createNativePayoutAmount({ assetId: 'native', amountAtomic: '0' }),
    returnBinding: {
      operations: OPERATIONS,
      assetId: 'native',
      evidenceDigest: digest('return'),
    },
  });
}

function config() {
  const native = { chainId: '4663', assetId: 'native', decimals: 18 };
  const stablecoin = { chainId: '792703809', assetId: 'stablecoin', decimals: 6 };
  return {
    chainId: 4663,
    accounts: { evm: OPERATIONS },
    contracts: { usdg: TOKEN },
    moneyConfiguration: {
      schema: 'hookemon.money-configuration.v2',
      assets: { eth: native, solanaStablecoin: stablecoin },
      minimums: {
        robinhoodReceive: { ...native, amountAtomic: '0' },
        solanaReceive: { ...stablecoin, amountAtomic: '0' },
        returnEth: { ...native, amountAtomic: '0' },
      },
      evm: {
        perTransactionGasPriceCap: { ...native, amountAtomic: '5' },
        nativeReserve: { ...native, amountAtomic: '10' },
      },
      solana: {
        priorityFeeCap: { chainId: '792703809', assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '2' },
        lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '2' },
      },
    },
  };
}

function signedMaterial(rawSignedBytes) {
  const rawSignedBytesHash = keccak256(rawSignedBytes).toLowerCase();
  return { rawSignedBytes, rawSignedBytesHash, txHash: rawSignedBytesHash };
}

function refusalEvidence(transactionHash) {
  return {
    reason: 'TRANSACTION_REVERTED',
    transactionHash,
    receiptBlockNumber: '100',
    receiptBlockHash: `0x${'9'.repeat(64)}`,
    finalizedBlockNumber: '100',
    finalizedBlockHash: `0x${'9'.repeat(64)}`,
  };
}

function paymentReceipt(transactionHash, status = 'success') {
  return {
    transactionHash,
    blockNumber: 100n,
    blockHash: `0x${'9'.repeat(64)}`,
    status,
    gasUsed: 1n,
    effectiveGasPrice: 1n,
    logs: [],
  };
}

function fakeChain({ receipts = new Map(), nonce = 1n } = {}) {
  const signed = new Map([
    [ORIGINAL_HASH, ORIGINAL_BYTES],
    [RETRY_HASH, RETRY_BYTES],
  ]);
  const client = {
    async getTransactionCount() { return nonce; },
    async getTransaction({ hash }) {
      return {
        ...parseTransaction(signed.get(hash) ?? ORIGINAL_BYTES),
        hash,
        from: OPERATIONS,
        blockNumber: 100n,
        blockHash: `0x${'9'.repeat(64)}`,
      };
    },
    async getTransactionReceipt({ hash }) {
      const receipt = receipts.get(hash);
      if (!receipt) throw new TransactionReceiptNotFoundError({ hash });
      return receipt;
    },
    async getBlock() {
      return { number: 100n, hash: `0x${'9'.repeat(64)}`, timestamp: 1_700_000_000n };
    },
    async getChainId() { return 4663; },
  };
  return client;
}

function signer(counter, onBroadcast = null) {
  return {
    evm: wrapSignerClient({
      role: 'operator-evm',
      liveMode: true,
      preflightAuthority: createTestProfileMutationAuthority(),
      inner: {
        async sign({ transaction }) {
          counter.sign += 1;
          const signed = await ACCOUNT.signTransaction({
            ...transaction,
            nonce: BigInt(transaction.nonce),
            value: BigInt(transaction.value),
            gas: BigInt(transaction.gas),
            gasPrice: BigInt(transaction.gasPrice),
          });
          return { signedTx: signed };
        },
        async broadcast({ signedTx }) {
          counter.broadcast += 1;
          const transactionHash = keccak256(signedTx);
          onBroadcast?.(transactionHash);
          return { transactionHash };
        },
      },
    }),
  };
}

function store(initial) {
  let current = structuredClone(initial);
  return {
    async load() { return structuredClone(current); },
    async persist(next) { current = structuredClone(next); },
  };
}

function repository(counter) {
  return {
    async settlePayoutQuarantine(cycleId, input) {
      assert.equal(cycleId, 'cycle-refused-retry');
      assert.equal(input.recipient, RECIPIENT);
      assert.equal(input.operations, OPERATIONS);
      assert.equal(input.proof.transactionHash, input.retryId === null ? ORIGINAL_HASH : RETRY_HASH);
      if (input.proof.amountAtomic !== undefined) assert.equal(input.proof.amountAtomic, '1');
      if (input.proof.recipient !== undefined) assert.equal(input.proof.recipient, RECIPIENT);
      const proofKey = JSON.stringify({ retryId: input.retryId, proof: input.proof });
      if (counter.settlementProof !== null) {
        assert.equal(counter.settlementProof, proofKey);
        return;
      }
      if (BigInt(counter.ledger.payoutLiability) < 1n) {
        throw new Error('payout liability underflow');
      }
      counter.settlementProof = proofKey;
      counter.settled += 1;
      counter.ledger.payoutLiability = (BigInt(counter.ledger.payoutLiability) - 1n).toString();
    },
    async recordPayoutQuarantineRetryRefusal() {
      counter.refused += 1;
      counter.retryResolved = true;
    },
    async recordCustodyLedger() {
      counter.gas += 1;
    },
    async recordSupplementaryPayoutGas() {
      counter.gas += 1;
    },
    async requestPayoutQuarantineRetry(cycleId, input) {
      assert.equal(cycleId, 'cycle-refused-retry');
      assert.equal(input.planDigest, refusedState().planDigest);
      assert.equal(input.recipient, RECIPIENT);
      assert.equal(input.amount.amountAtomic, '1');
      assert.equal(input.originalTransactionHash, ORIGINAL_HASH);
      const payload = JSON.stringify({
        planDigest: input.planDigest,
        recipient: input.recipient,
        amount: input.amount,
        requestId: input.requestId,
        originalTransactionHash: input.originalTransactionHash,
      });
      const existing = counter.retryRequests.get(input.requestId);
      if (existing !== undefined) {
        assert.equal(existing.payload, payload);
        return existing.record;
      }
      if (counter.retryRequests.size > 0 && !counter.retryResolved) {
        throw new Error('retry request already open');
      }
      counter.requested += 1;
      const record = {
        retryId: digest(`retry-${counter.requested}`),
        requestId: input.requestId,
        requestedAtMs: 1,
        originalTransactionHash: ORIGINAL_HASH,
        resolution: null,
      };
      counter.retryRequests.set(input.requestId, { payload, record });
      return record;
    },
  };
}

function refusedState({ retryState = null, retryNonce = '1', originalReceipt = false } = {}) {
  const initial = createDirectPayoutState({
    plan: plan(),
    operations: OPERATIONS,
    assetId: 'native',
    firstNonce: '0',
    gasPriceWei: '1',
  });
  const attempt = initial.recipients[0];
  const original = signedMaterial(ORIGINAL_BYTES);
  const retry = retryState === null ? [] : [{
    retryId: digest('retry'),
    requestId: 'retry-request',
    state: retryState,
    nonce: retryNonce,
    gasPriceWei: '1',
    rawSignedBytes: null,
    rawSignedBytesHash: null,
    txHash: null,
    finalizedTransfer: null,
    refusalEvidence: null,
    approvalContext: null,
  }];
  const next = {
    ...initial,
    manifestFrozen: true,
    feasibilityChecked: true,
    nextNonce: retryState === null || retryNonce === null
      ? '1'
      : (BigInt(retryNonce) + 1n).toString(),
    recipients: [{
      ...attempt,
      state: 'REFUSED',
      nonce: originalReceipt ? '0' : '0',
      ...original,
      refusalEvidence: refusalEvidence(ORIGINAL_HASH),
      retries: retry,
      settlement: null,
    }],
    quarantine: [{ recipient: RECIPIENT, amount: attempt.amount, reason: 'TRANSACTION_REVERTED' }],
  };
  if (retryState === 'BROADCAST') {
    const material = signedMaterial(RETRY_BYTES);
    next.recipients[0].retries[0] = {
      ...next.recipients[0].retries[0],
      ...material,
      nonce: retryNonce,
    };
  }
  return next;
}

function makeCounter() {
  return {
    sign: 0,
    broadcast: 0,
    settled: 0,
    refused: 0,
    gas: 0,
    requested: 0,
    retryRequests: new Map(),
    retryResolved: false,
    settlementProof: null,
    ledger: {
      claimed: '10',
      payoutLiability: '1',
      dust: '0',
      returnReceived: '20',
    },
  };
}

function nativeLedger(cycleId, payoutLiability = '0', verifiedCurrentBalance = null) {
  return {
    schema: 'hookemon.custody-ledger.v3',
    cycleId,
    chainId: '4663',
    assetId: 'native',
    decimals: 18,
    claimed: '0',
    bridgeOut: '0',
    bridgeIn: '0',
    packCost: '0',
    buybackProceeds: '0',
    returnInput: '0',
    returnReceived: '10',
    refunds: '0',
    residual: '0',
    heldAssets: '0',
    heldPositions: '0',
    payoutLiability,
    dust: '0',
    unattributed: '0',
    expectedCycleAsset: null,
    verifiedCurrentBalance,
    gasReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '0' },
    gasSpent: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '0' },
    gasPayments: [],
  };
}

function nativeBalanceObservation() {
  return {
    schema: 'hookemon.custody-balance-observation.v1',
    account: OPERATIONS,
    balance: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '10' },
    finality: {
      height: '100',
      hash: `0x${'f'.repeat(64)}`,
      timestampUnixSeconds: '1700000012',
    },
  };
}

async function sqliteRetryCrashFixture(t, outcome) {
  const directory = await mkdtemp(join(tmpdir(), `hookemon-retry-crash-${outcome}-`));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = await CycleRepository.open(
    directory,
    () => 1_000,
    { testAuthority: createTestProfileMutationAuthority() },
  );
  const cycleId = 'cycle-refused-retry';
  await repository.createCycle({
    releaseAmount: '1',
    mode: 'rehearsal',
    providerMode: 'fake',
    cycleId,
  });
  await repository.recordCustodyLedger(cycleId, {
    ...nativeLedger(cycleId, '0'),
    verifiedCurrentBalance: nativeBalanceObservation(),
  });
  const { planDigest } = refusedState();
  await repository.reservePayoutQuarantine(cycleId, {
    planDigest,
    recipient: RECIPIENT,
    amount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '1' },
    reason: 'TRANSACTION_REVERTED',
    evidence: { reason: 'TRANSACTION_REVERTED', transactionHash: ORIGINAL_HASH },
  });
  await repository.holdCycle(cycleId, 'HELD_OWNER_DECISION', {
    reason: 'PAYOUT_QUARANTINED_LIABILITY',
    planDigest,
    liabilities: [{ recipient: RECIPIENT, amountAtomic: '1' }],
  });
  const request = await repository.requestPayoutQuarantineRetry(cycleId, retryRequestInput({
    planDigest,
    requestId: `crash-${outcome}`,
  }));
  const state = refusedState({ retryState: 'BROADCAST', retryNonce: '1' });
  state.recipients[0].retries[0] = {
    ...state.recipients[0].retries[0],
    retryId: request.retryId,
    requestId: request.requestId,
  };
  await repository.persistPagedPayoutState(cycleId, 'payout', state);
  const receipts = new Map([
    [ORIGINAL_HASH, paymentReceipt(ORIGINAL_HASH, 'reverted')],
    [RETRY_HASH, paymentReceipt(RETRY_HASH, outcome)],
  ]);
  return {
    directory,
    cycleId,
    planDigest,
    repository,
    request,
    state,
    receipts,
    client: fakeChain({ receipts }),
  };
}

async function nativeProof(client, signedTransaction, transactionHash = ORIGINAL_HASH) {
  return createNativePaymentProof({
    client,
    signedTransaction,
    expected: {
      kind: 'direct',
      chainId: '4663',
      assetId: 'native',
      decimals: 18,
      transactionHash,
      source: OPERATIONS,
      recipient: RECIPIENT,
      amountWei: '1',
      calldataDigest: keccak256('0x'),
      nonce: parseTransaction(signedTransaction).nonce.toString(),
    },
  });
}

async function durableRetryFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-refused-retry-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cycleId = `cycle-refused-retry-${Date.now()}`;
  const repository = await CycleRepository.open(directory);
  await repository.createCycle({ releaseAmount: '1', mode: 'production', cycleId });
  await repository.recordCustodyLedger(cycleId, nativeLedger(cycleId));
  const planDigest = digest({ schema: 'test-payout-plan.v1', cycleId });
  await repository.reservePayoutQuarantine(cycleId, {
    planDigest,
    recipient: RECIPIENT,
    amount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '1' },
    reason: 'TRANSACTION_REVERTED',
    evidence: { reason: 'TRANSACTION_REVERTED', transactionHash: ORIGINAL_HASH },
  });
  return { directory, cycleId, planDigest, repository };
}

function retryRequestInput(overrides = {}) {
  return {
    planDigest: refusedState().planDigest,
    recipient: RECIPIENT,
    amount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '1' },
    requestId: 'request-1',
    originalTransactionHash: ORIGINAL_HASH,
    ...overrides,
  };
}

test('D1 happy path settles a refused retry through signing and one fake broadcast', async () => {
  const counter = makeCounter();
  const originalAttempt = refusedState({ retryState: 'PREPARED' }).recipients[0];
  const ledgerBefore = structuredClone(counter.ledger);
  const stateStore = store(refusedState({ retryState: 'PREPARED' }));
  const receipts = new Map();
  const client = fakeChain({ receipts });
  const common = {
    payoutStore: stateStore,
    cycleRepository: repository(counter),
    recipient: RECIPIENT,
    requestId: 'retry-request',
    adapters: { robinhood: { client } },
    signerClient: signer(counter),
    config: config(),
  };
  const signed = await retryRefusedPayoutRecipient(common);
  assert.equal(counter.sign, 1);
  assert.equal(signed.recipients[0].retries[0].state, 'SIGNED');
  const broadcast = await retryRefusedPayoutRecipient(common);
  assert.equal(counter.broadcast, 1);
  assert.equal(broadcast.recipients[0].retries[0].state, 'BROADCAST');
  receipts.set(broadcast.recipients[0].retries[0].txHash, paymentReceipt(broadcast.recipients[0].retries[0].txHash));
  const next = await retryRefusedPayoutRecipient(common);
  assert.equal(counter.settled, 1);
  assert.equal(next.recipients[0].retries[0].state, 'FINALIZED');
  assert.equal(next.quarantine.length, 0);
  assert.equal(isRecipientPaid(next.recipients[0]), true);
  assert.equal(counter.ledger.payoutLiability, '0');
  for (const key of Object.keys(ledgerBefore)) {
    if (key !== 'payoutLiability') assert.equal(counter.ledger[key], ledgerBefore[key], key);
  }
  const withoutRetryMaterial = attempt => {
    const copy = structuredClone(attempt);
    delete copy.retries;
    delete copy.settlement;
    return copy;
  };
  assert.deepEqual(withoutRetryMaterial(next.recipients[0]), withoutRetryMaterial(originalAttempt));
});

test('D2 original-later-success settles without creating a retry or broadcasting', async () => {
  const counter = makeCounter();
  const state = refusedState();
  const receipts = new Map([[ORIGINAL_HASH, paymentReceipt(ORIGINAL_HASH)]]);
  const next = await retryRefusedPayoutRecipient({
    payoutStore: store(state),
    cycleRepository: repository(counter),
    recipient: RECIPIENT,
    requestId: 'retry-request',
    adapters: { robinhood: { client: fakeChain({ receipts }) } },
    signerClient: signer(counter),
    config: config(),
  });
  assert.equal(counter.broadcast, 0);
  assert.equal(counter.settled, 1);
  assert.equal(next.recipients[0].settlement.retryId, null);
  assert.equal(next.quarantine.length, 0);
});

test('D3 unknown original outcome refuses to change state', async () => {
  const counter = makeCounter();
  const state = refusedState();
  const before = JSON.stringify(state);
  await assert.rejects(() => retryRefusedPayoutRecipient({
    payoutStore: store(state),
    cycleRepository: repository(counter),
    recipient: RECIPIENT,
    requestId: 'retry-request',
    adapters: { robinhood: { client: fakeChain() } },
    signerClient: signer(counter),
    config: config(),
  }), /not finalized/);
  assert.equal(counter.broadcast, 0);
  assert.equal(JSON.stringify(state), before);
});

test('D4 rejects a FINALIZED original attempt', async () => {
  const state = refusedState();
  state.recipients[0].state = 'FINALIZED';
  await assert.rejects(() => retryRefusedPayoutRecipient({
    payoutStore: store(state),
    cycleRepository: repository(makeCounter()),
    recipient: RECIPIENT,
    requestId: 'retry-request',
    adapters: { robinhood: { client: fakeChain() } },
    signerClient: signer(makeCounter()),
    config: config(),
  }), /recipient attempt/);
});

test('D4 rejects a PREPARED original attempt', async () => {
  const state = refusedState();
  state.recipients[0].state = 'PREPARED';
  state.recipients[0].refusalEvidence = null;
  await assert.rejects(() => retryRefusedPayoutRecipient({
    payoutStore: store(state),
    cycleRepository: repository(makeCounter()),
    recipient: RECIPIENT,
    requestId: 'retry-request',
    adapters: { robinhood: { client: fakeChain() } },
    signerClient: signer(makeCounter()),
    config: config(),
  }), /recipient attempt/);
});

test('D4 rejects a REFUSED original attempt without a transaction hash', async () => {
  const state = refusedState();
  state.recipients[0].refusalEvidence = { ...state.recipients[0].refusalEvidence, transactionHash: null };
  await assert.rejects(() => retryRefusedPayoutRecipient({
    payoutStore: store(state),
    cycleRepository: repository(makeCounter()),
    recipient: RECIPIENT,
    requestId: 'retry-request',
    adapters: { robinhood: { client: fakeChain() } },
    signerClient: signer(makeCounter()),
    config: config(),
  }), /recipient attempt/);
});

test('D4 rejects a quarantined retry request with the wrong amount', async () => {
  await assert.rejects(() => repository(makeCounter()).requestPayoutQuarantineRetry(
    'cycle-refused-retry',
    retryRequestInput({ amount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '2' } }),
  ), /strictly equal/);
});

test('D4 rejects a quarantined retry request with the wrong recipient', async () => {
  await assert.rejects(() => repository(makeCounter()).requestPayoutQuarantineRetry(
    'cycle-refused-retry',
    retryRequestInput({ recipient: `0x${'2'.repeat(40)}` }),
  ), /strictly equal/);
});

test('D4 rejects a quarantined retry request with the wrong original transaction hash', async () => {
  await assert.rejects(() => repository(makeCounter()).requestPayoutQuarantineRetry(
    'cycle-refused-retry',
    retryRequestInput({ originalTransactionHash: `0x${'f'.repeat(64)}` }),
  ), /strictly equal/);
});

test('D4 rejects a quarantined retry request with the wrong plan digest', async () => {
  await assert.rejects(() => repository(makeCounter()).requestPayoutQuarantineRetry(
    'cycle-refused-retry',
    retryRequestInput({ planDigest: digest('wrong-plan') }),
  ), /strictly equal/);
});

test('D4 rejects non-refused and refusal-without-transaction attempts', async () => {
  const base = refusedState();
  for (const state of [
    {
      ...base,
      recipients: [{
        ...base.recipients[0],
        state: 'PREPARED',
        nonce: null,
        rawSignedBytes: null,
        rawSignedBytesHash: null,
        txHash: null,
        refusalEvidence: null,
      }],
      nextNonce: '0',
    },
    { ...base, recipients: [{ ...base.recipients[0], refusalEvidence: { ...base.recipients[0].refusalEvidence, transactionHash: null } }] },
  ]) {
    await assert.rejects(() => retryRefusedPayoutRecipient({
      payoutStore: store(state),
      cycleRepository: repository({ settled: 0 }),
      recipient: RECIPIENT,
      requestId: 'retry-request',
      adapters: { robinhood: { client: fakeChain() } },
      signerClient: signer({ sign: 0, broadcast: 0 }),
      config: config(),
    }));
  }
});

test('D5 settled retries are idempotent and complete payout conservation', async () => {
  const attempt = {
    state: 'REFUSED',
    retries: [{
      retryId: digest('retry'),
      requestId: 'retry-request',
      state: 'FINALIZED',
    }],
    settlement: null,
  };
  assert.equal(isRecipientPaid(attempt), true);
  assert.equal(isRecipientPaid(attempt), true);
});

test('D5 identical requestId is idempotent and creates one retry record', async () => {
  const counter = makeCounter();
  const repo = repository(counter);
  const first = await repo.requestPayoutQuarantineRetry('cycle-refused-retry', retryRequestInput());
  const second = await repo.requestPayoutQuarantineRetry('cycle-refused-retry', retryRequestInput());
  assert.equal(counter.requested, 1);
  assert.deepEqual(second, first);
});

test('D5 a new requestId is rejected while the previous retry is open', async () => {
  const counter = makeCounter();
  const repo = repository(counter);
  await repo.requestPayoutQuarantineRetry('cycle-refused-retry', retryRequestInput());
  await assert.rejects(
    () => repo.requestPayoutQuarantineRetry(
      'cycle-refused-retry',
      retryRequestInput({ requestId: 'request-2' }),
    ),
    /already open/,
  );
});

test('D5 concurrent different requestIds accept exactly one request', async () => {
  const counter = makeCounter();
  const repo = repository(counter);
  const results = await Promise.allSettled([
    repo.requestPayoutQuarantineRetry('cycle-refused-retry', retryRequestInput({ requestId: 'request-a' })),
    repo.requestPayoutQuarantineRetry('cycle-refused-retry', retryRequestInput({ requestId: 'request-b' })),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(counter.requested, 1);
});

test('D5 identical settlement proof is idempotent and decreases liability once', async () => {
  const counter = makeCounter();
  const repo = repository(counter);
  const input = {
    recipient: RECIPIENT,
    operations: OPERATIONS,
    retryId: null,
    proof: { transactionHash: ORIGINAL_HASH },
  };
  await repo.settlePayoutQuarantine('cycle-refused-retry', input);
  await repo.settlePayoutQuarantine('cycle-refused-retry', input);
  assert.equal(counter.settled, 1);
  assert.equal(counter.ledger.payoutLiability, '0');
});

test('D5 settlement rejects liability underflow', async () => {
  const counter = makeCounter();
  counter.ledger.payoutLiability = '0';
  await assert.rejects(
    () => repository(counter).settlePayoutQuarantine('cycle-refused-retry', {
      recipient: RECIPIENT,
      operations: OPERATIONS,
      retryId: null,
      proof: { transactionHash: ORIGINAL_HASH },
    }),
    /underflow/,
  );
});

test('D5 settlement rejects a proof for the wrong amount', async () => {
  await assert.rejects(
    () => repository(makeCounter()).settlePayoutQuarantine('cycle-refused-retry', {
      recipient: RECIPIENT,
      operations: OPERATIONS,
      retryId: null,
      proof: { transactionHash: ORIGINAL_HASH, amountAtomic: '2' },
    }),
    /strictly equal/,
  );
});

test('D5 settlement rejects a proof for the wrong recipient', async () => {
  await assert.rejects(
    () => repository(makeCounter()).settlePayoutQuarantine('cycle-refused-retry', {
      recipient: RECIPIENT,
      operations: OPERATIONS,
      retryId: null,
      proof: { transactionHash: ORIGINAL_HASH, recipient: `0x${'2'.repeat(40)}` },
    }),
    /strictly equal/,
  );
});

test('D6 retry refusal retains quarantine and permits a later request', async () => {
  const counter = makeCounter();
  const state = refusedState({ retryState: 'BROADCAST' });
  const payoutStore = store(state);
  const retry = state.recipients[0].retries[0];
  const receipts = new Map([
    [ORIGINAL_HASH, paymentReceipt(ORIGINAL_HASH, 'reverted')],
    [retry.txHash, paymentReceipt(retry.txHash, 'reverted')],
  ]);
  const next = await retryRefusedPayoutRecipient({
    payoutStore,
    cycleRepository: repository(counter),
    recipient: RECIPIENT,
    requestId: 'retry-request',
    adapters: { robinhood: { client: fakeChain({ receipts }) } },
    signerClient: signer(counter),
    config: config(),
  });
  assert.equal(counter.refused, 1);
  assert.equal(next.recipients[0].retries[0].state, 'REFUSED');
  assert.equal(next.quarantine.length, 1);
  assert.equal(counter.settled, 0);
  const later = await retryRefusedPayoutRecipient({
    payoutStore,
    cycleRepository: repository(counter),
    recipient: RECIPIENT,
    requestId: 'retry-request-2',
    adapters: { robinhood: { client: fakeChain({ receipts }) } },
    signerClient: signer(counter),
    config: config(),
  });
  assert.equal(counter.requested, 1);
  assert.equal(later.recipients[0].retries.length, 2);
  assert.equal(later.quarantine.length, 1);
});

test('retry nonce reservation compares decimal nonces numerically', async () => {
  for (const [nextNonce, observedNonce] of [['9', 10n], ['20', 100n]]) {
    const state = refusedState({ retryState: 'PREPARED', retryNonce: null });
    const originalBytes = await ACCOUNT.signTransaction({
      chainId: 4663,
      nonce: BigInt(nextNonce) - 1n,
      to: RECIPIENT,
      value: 1n,
      gas: 50000n,
      gasPrice: 1n,
      data: '0x',
    });
    const original = signedMaterial(originalBytes);
    state.firstNonce = (BigInt(nextNonce) - 1n).toString();
    state.nextNonce = nextNonce;
    state.recipients[0].nonce = state.firstNonce;
    state.recipients[0] = { ...state.recipients[0], ...original };
    const payoutStore = store(state);
    const counter = makeCounter();
    const common = {
      payoutStore,
      cycleRepository: repository(counter),
      recipient: RECIPIENT,
      requestId: 'retry-request',
      adapters: { robinhood: { client: fakeChain({ nonce: observedNonce }) } },
      signerClient: signer(counter),
      config: config(),
    };
    const next = await retryRefusedPayoutRecipient(common);
    assert.equal(next.recipients[0].retries[0].nonce, observedNonce.toString());
    assert.equal(next.nextNonce, (observedNonce + 1n).toString());
    const persisted = await payoutStore.load();
    assert.equal(persisted.nextNonce, (observedNonce + 1n).toString());
    assert.equal(persisted.recipients[0].retries[0].state, 'PREPARED');
    const signed = await retryRefusedPayoutRecipient(common);
    assert.equal(signed.recipients[0].retries[0].state, 'SIGNED');
    assert.equal((await payoutStore.load()).recipients[0].retries[0].state, 'SIGNED');
  }
});

test('retry state rejects a nonce cursor gap without a persisted retry nonce', async () => {
  const state = refusedState();
  state.nextNonce = '2';
  await assert.rejects(() => retryRefusedPayoutRecipient({
    payoutStore: store(state),
    cycleRepository: repository(makeCounter()),
    recipient: RECIPIENT,
    requestId: 'retry-request',
    adapters: { robinhood: { client: fakeChain() } },
    signerClient: signer(makeCounter()),
    config: config(),
  }), /nonce cursor is inconsistent/);
});

test('retry nonce reservation rejects a pending nonce below nextNonce', async () => {
  const state = refusedState({ retryState: 'PREPARED', retryNonce: null });
  const originalBytes = await ACCOUNT.signTransaction({
    chainId: 4663,
    nonce: 19n,
    to: RECIPIENT,
    value: 1n,
    gas: 50000n,
    gasPrice: 1n,
    data: '0x',
  });
  state.firstNonce = '19';
  state.nextNonce = '20';
  state.recipients[0].nonce = '19';
  state.recipients[0] = { ...state.recipients[0], ...signedMaterial(originalBytes) };
  await assert.rejects(() => retryRefusedPayoutRecipient({
    payoutStore: store(state),
    cycleRepository: repository(makeCounter()),
    recipient: RECIPIENT,
    requestId: 'retry-request',
    adapters: { robinhood: { client: fakeChain({ nonce: 3n }) } },
    signerClient: signer({ sign: 0, broadcast: 0 }),
    config: config(),
}), DirectPayoutNonceInterferenceError);
});

test('unknown durable retry is rejected before chain reads or side effects', async () => {
  const state = refusedState();
  const counter = makeCounter();
  const requestedRetryId = digest('missing-durable-retry');
  await assert.rejects(retryRefusedPayoutRecipient({
    payoutStore: {
      async load() { return structuredClone(state); },
      async persist() { assert.fail('unknown retry must not change payout state'); },
    },
    cycleRepository: {
      async readPayoutQuarantine() { return { retries: [], settlement: null }; },
      async requestPayoutQuarantineRetry() { assert.fail('unknown retry must not create a replacement request'); },
    },
    recipient: RECIPIENT,
    retryId: requestedRetryId,
    requestId: 'missing-retry-request',
    adapters: { robinhood: { client: new Proxy({}, {
      get() { assert.fail('unknown retry must not read the chain'); },
    }) } },
    signerClient: signer(counter),
    config: config(),
  }), error => {
    assert.equal(error.message, `direct payout retry ${requestedRetryId} is not durably requested`);
    return true;
  });
  assert.equal(counter.sign, 0);
  assert.equal(counter.broadcast, 0);
});

test('projection repair finalizes a journaled settlement without chain reads', async () => {
  const state = refusedState({ retryState: 'BROADCAST' });
  const retry = state.recipients[0].retries[0];
  const proof = {
    transactionHash: retry.txHash,
    recipient: RECIPIENT,
    amountWei: '1',
  };
  let persisted = null;
  const base = repository(makeCounter());
  const cycleRepository = {
    ...base,
    async readPayoutQuarantine() {
      return {
        settlement: {
          retryId: retry.retryId,
          finalizedTransfer: proof,
          payoutRetry: { ...retry, state: 'FINALIZED', finalizedTransfer: proof, refusalEvidence: null },
        },
        retries: [{ retryId: retry.retryId, resolution: null }],
      };
    },
    async settlePayoutQuarantine() { throw new Error('repair must not settle again'); },
  };
  const next = await retryRefusedPayoutRecipient({
    payoutStore: {
      async load() { return structuredClone(state); },
      async persist(value) { persisted = structuredClone(value); },
    },
    cycleRepository,
    recipient: RECIPIENT,
    retryId: retry.retryId,
    requestId: retry.requestId,
    adapters: { robinhood: { client: { getTransactionReceipt() { throw new Error('chain read'); } } } },
    signerClient: signer({ sign: 0, broadcast: 0 }),
    config: config(),
  });
  assert.equal(next.recipients[0].retries[0].state, 'FINALIZED');
  assert.equal(next.quarantine.length, 0);
  assert.equal(persisted.recipients[0].retries[0].state, 'FINALIZED');
});

test('projection repair refuses a journaled retry without chain reads', async () => {
  const state = refusedState({ retryState: 'BROADCAST' });
  const retry = state.recipients[0].retries[0];
  const refusal = refusalEvidence(retry.txHash);
  const base = repository(makeCounter());
  const cycleRepository = {
    ...base,
    async readPayoutQuarantine() {
      return {
        settlement: null,
        retries: [{
          retryId: retry.retryId,
          resolution: { state: 'REFUSED', transactionHash: retry.txHash },
          refusalEvidence: refusal,
          processProof: { transactionHash: retry.txHash },
          payoutRetry: { ...retry, state: 'REFUSED', refusalEvidence: refusal },
        }],
      };
    },
    async recordPayoutQuarantineRetryRefusal() { throw new Error('repair must not refuse again'); },
  };
  const next = await retryRefusedPayoutRecipient({
    payoutStore: store(state),
    cycleRepository,
    recipient: RECIPIENT,
    retryId: retry.retryId,
    requestId: retry.requestId,
    adapters: { robinhood: { client: { getTransactionReceipt() { throw new Error('chain read'); } } } },
    signerClient: signer({ sign: 0, broadcast: 0 }),
    config: config(),
  });
  assert.equal(next.recipients[0].retries[0].state, 'REFUSED');
  assert.equal(next.recipients[0].retries[0].refusalEvidence.transactionHash, retry.txHash);
});

test('SQLite retry crash boundaries repair journal, gas, and paged projections idempotently', async t => {
  const cases = [
    { outcome: 'success', boundary: 'settle-journal' },
    { outcome: 'reverted', boundary: 'refusal-journal' },
    { outcome: 'success', boundary: 'gas' },
    { outcome: 'success', boundary: 'state' },
  ];
  for (const { outcome, boundary } of cases) {
    const fixture = await sqliteRetryCrashFixture(t, outcome);
    const base = fixture.repository;
    const crashingRepository = new Proxy(base, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (boundary === 'settle-journal' && property === 'settlePayoutQuarantine') {
          return async (...args) => {
            await value.apply(target, args);
            throw new Error('injected crash after settlement journal');
          };
        }
        if (boundary === 'refusal-journal' && property === 'recordPayoutQuarantineRetryRefusal') {
          return async (...args) => {
            await value.apply(target, args);
            throw new Error('injected crash after refusal journal');
          };
        }
        if (boundary === 'gas' && property === 'recordCustodyLedger') {
          return async (...args) => {
            await value.apply(target, args);
            throw new Error('injected crash after payout gas');
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const crashingStore = {
      async load() {
        return base.readPagedPayoutState(fixture.cycleId, 'payout');
      },
      async persist(next) {
        if (boundary === 'state') throw new Error('injected crash before payout state');
        await base.persistPagedPayoutState(fixture.cycleId, 'payout', next);
      },
    };
    const input = {
      payoutStore: crashingStore,
      cycleRepository: crashingRepository,
      recipient: RECIPIENT,
      retryId: fixture.request.retryId,
      requestId: fixture.request.requestId,
      adapters: { robinhood: { client: fixture.client } },
      signerClient: signer(makeCounter()),
      config: config(),
    };
    await assert.rejects(() => retryRefusedPayoutRecipient(input), /injected crash/);

    const reopened = await CycleRepository.open(
      fixture.directory,
      () => 1_000,
      { testAuthority: createTestProfileMutationAuthority() },
    );
    const repaired = await retryRefusedPayoutRecipient({
      ...input,
      payoutStore: {
        async load() {
          return reopened.readPagedPayoutState(fixture.cycleId, 'payout');
        },
        async persist(next) {
          await reopened.persistPagedPayoutState(fixture.cycleId, 'payout', next);
        },
      },
      cycleRepository: reopened,
    });
    const durableReservation = await reopened.readPayoutQuarantine(
      fixture.cycleId,
      fixture.planDigest,
      RECIPIENT,
    );
    if (outcome === 'success') {
      assert.equal(Boolean(durableReservation?.settlement), true, `${outcome}/${boundary} settlement`);
    }
    const expectedState = outcome === 'success' ? 'FINALIZED' : 'REFUSED';
    assert.equal(
      repaired.recipients[0].retries.find(item => item.retryId === fixture.request.retryId).state,
      expectedState,
    );
    const ledger = (await reopened.describeCycle(fixture.cycleId)).custodyLedgers.get('4663\u0000native');
    assert.equal(ledger.payoutLiability, outcome === 'success' ? '0' : '1', `${outcome}/${boundary}`);
    assert.deepEqual(await reopened.listOpenPayoutRetries(), []);
    const replayed = await retryRefusedPayoutRecipient({
      ...input,
      payoutStore: {
        async load() {
          return reopened.readPagedPayoutState(fixture.cycleId, 'payout');
        },
        async persist(next) {
          await reopened.persistPagedPayoutState(fixture.cycleId, 'payout', next);
        },
      },
      cycleRepository: reopened,
    });
    assert.equal(
      replayed.recipients[0].retries.find(item => item.retryId === fixture.request.retryId).state,
      expectedState,
    );
    assert.equal(
      (await reopened.describeCycle(fixture.cycleId)).custodyLedgers.get('4663\u0000native').payoutLiability,
      outcome === 'success' ? '0' : '1',
    );
  }
});

test('D7 restart after BROADCAST reconciles without signing or broadcasting again', async () => {
  const counter = makeCounter();
  const state = refusedState({ retryState: 'BROADCAST' });
  const retry = state.recipients[0].retries[0];
  const receipts = new Map([[retry.txHash, paymentReceipt(retry.txHash)]]);
  const next = await retryRefusedPayoutRecipient({
    payoutStore: store(structuredClone(state)),
    cycleRepository: repository(counter),
    recipient: RECIPIENT,
    requestId: 'retry-request',
    adapters: { robinhood: { client: fakeChain({ receipts }) } },
    signerClient: signer(counter),
    config: config(),
  });
  assert.equal(counter.sign, 0);
  assert.equal(counter.broadcast, 0);
  assert.equal(next.recipients[0].retries[0].state, 'FINALIZED');
});

test('D7 sqlite repository reopen replays retry request, refusal, settlement, and ledger', async t => {
  const { directory, cycleId, planDigest, repository: first } = await durableRetryFixture(t);
  const request = await first.requestPayoutQuarantineRetry(cycleId, {
    planDigest,
    recipient: RECIPIENT,
    amount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '1' },
    requestId: 'sqlite-retry',
    originalTransactionHash: ORIGINAL_HASH,
  });
  await first.recordPayoutQuarantineRetryRefusal(cycleId, {
    planDigest,
    recipient: RECIPIENT,
    retryId: request.retryId,
    refusalEvidence: refusalEvidence(RETRY_HASH),
  });
  const client = fakeChain({ receipts: new Map([[ORIGINAL_HASH, paymentReceipt(ORIGINAL_HASH)]]) });
  const proof = await nativeProof(client, ORIGINAL_BYTES);
  await first.settlePayoutQuarantine(cycleId, {
    planDigest,
    recipient: RECIPIENT,
    retryId: null,
    proof,
    operations: OPERATIONS,
  });
  const reopened = await CycleRepository.open(directory);
  const obligation = (await reopened.listPayoutObligations(cycleId))[0];
  assert.equal(obligation.settlement.retryId, null);
  assert.equal(obligation.settlement.amount.amountAtomic, '1');
  const ledger = (await reopened.describeCycle(cycleId)).custodyLedgers.get('4663\u0000native');
  assert.equal(ledger.payoutLiability, '0');

  const activePath = join(directory, 'active', `${encodeURIComponent(cycleId)}.json`);
  const active = JSON.parse(await readFile(activePath, 'utf8'));
  const settlement = active.cycle.entries.find(entry => entry.kind === 'payout-quarantine-settled');
  settlement.payload.ledger.payoutLiability = '99';
  const unsignedSettlement = { ...settlement };
  delete unsignedSettlement.digest;
  settlement.digest = journalDigest(unsignedSettlement);
  active.cycle.journalHead = settlement.digest;
  await writeFile(activePath, `${JSON.stringify(active)}\n`);
  await assert.rejects(async () => {
    const tampered = await CycleRepository.open(directory);
    await tampered.describeCycle(cycleId);
  }, /ledger|liability/);
});

test('settled retry leaves the open-retry list once its journal is durable', async t => {
  const { directory, cycleId, planDigest, repository: first } = await durableRetryFixture(t);
  const request = await first.requestPayoutQuarantineRetry(cycleId, retryRequestInput({
    planDigest,
    requestId: 'settled-retry-list',
  }));
  const proof = await nativeProof(
    fakeChain({ receipts: new Map([[RETRY_HASH, paymentReceipt(RETRY_HASH)]]) }),
    RETRY_BYTES,
    RETRY_HASH,
  );
  await first.settlePayoutQuarantine(cycleId, {
    planDigest,
    recipient: RECIPIENT,
    retryId: request.retryId,
    proof,
    operations: OPERATIONS,
  });
  const reopened = await CycleRepository.open(directory);
  assert.deepEqual(await reopened.listOpenPayoutRetries(), []);
});

test('composed service settles a held-cycle retry through the real repository', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-refused-retry-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cycleId = 'cycle-refused-retry';
  const repository = await CycleRepository.open(
    directory,
    () => 1_000,
    { testAuthority: createTestProfileMutationAuthority() },
  );
  await repository.createCycle({
    releaseAmount: '1',
    mode: 'rehearsal',
    providerMode: 'fake',
    cycleId,
  });
  await repository.recordCustodyLedger(cycleId, {
    ...nativeLedger(cycleId, '1'),
    verifiedCurrentBalance: nativeBalanceObservation(),
  });
  const { planDigest } = refusedState();
  await repository.reservePayoutQuarantine(cycleId, {
    planDigest,
    recipient: RECIPIENT,
    amount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '1' },
    reason: 'TRANSACTION_REVERTED',
    evidence: { reason: 'TRANSACTION_REVERTED', transactionHash: ORIGINAL_HASH },
  });
  await repository.holdCycle(cycleId, 'HELD_OWNER_DECISION', {
    reason: 'PAYOUT_QUARANTINED_LIABILITY',
    planDigest,
    liabilities: [{ recipient: RECIPIENT, amountAtomic: '1' }],
  });
  const retry = await repository.requestPayoutQuarantineRetry(cycleId, retryRequestInput({
    planDigest,
    requestId: 'service-held-retry',
  }));
  const retryState = refusedState({ retryState: 'PREPARED', retryNonce: '1' });
  retryState.nextNonce = '1';
  retryState.recipients[0].retries[0] = {
    ...retryState.recipients[0].retries[0],
    retryId: retry.retryId,
    requestId: retry.requestId,
    nonce: null,
  };
  await repository.persistPagedPayoutState(cycleId, 'payout', retryState);
  assert.deepEqual(await repository.listOpenPayoutRetries(), [{
    cycleId,
    planDigest,
    recipient: RECIPIENT,
    retryId: retry.retryId,
  }]);
  const counter = makeCounter();
  const receipts = new Map([
    [ORIGINAL_HASH, paymentReceipt(ORIGINAL_HASH, 'reverted')],
  ]);
  const client = fakeChain({ receipts });
  const authority = createTestProfileMutationAuthority();
  const driver = createStageDriver({
    liveMode: true,
    adapters: { robinhood: { client } },
    signerClient: signer(counter, transactionHash => {
      receipts.set(transactionHash, paymentReceipt(transactionHash));
    }),
    config: config(),
    cycleRepository: repository,
    stageHandlers: {},
    preflightAuthority: authority,
  });
  const retryResults = [];
  const serviceDriver = {
    reconcile: driver.reconcile.bind(driver),
    execute: driver.execute.bind(driver),
    commit: driver.commit.bind(driver),
    runPayoutRetry: async input => {
      try {
        const value = await driver.runPayoutRetry(input);
        retryResults.push(value);
        return value;
      } catch (error) {
        retryResults.push({ status: 'THREW', error: error.message });
        throw error;
      }
    },
  };
  class LeaseStore {
    version = 0;
    lease = null;
    readLease() {
      return { version: this.version, lease: this.lease && structuredClone(this.lease) };
    }
    compareAndSwapLease(expectedVersion, nextLease) {
      if (expectedVersion !== this.version) return false;
      this.version += 1;
      this.lease = nextLease && structuredClone(nextLease);
      return true;
    }
  }
  const service = new AutomatedCycleService({
    owner: 'payout-retry-integration',
    liveMode: false,
    mode: 'rehearsal',
    providerMode: 'fake',
    leaseTtlMs: 60_000,
    now: () => 1_000,
    leaseStore: new LeaseStore(),
    budgetReader: { read: async () => ({ packPriceWei: '1', activeCycleId: cycleId }) },
    cycleRepository: repository,
    runnerFactory: activeCycleId => ({ cycleId: activeCycleId }),
    stageDriver: serviceDriver,
    feeSettlementObserver: { observe: async activeCycleId => ({ cycleId: activeCycleId, status: 'OBSERVED' }) },
  });
  const result = await service.recoverActiveCycle();
  assert.equal(result.status, 'HELD_OWNER_DECISION');
  assert.equal(retryResults.length, 1);
  assert.equal(retryResults[0].status, 'SETTLED', JSON.stringify(retryResults[0]));
  assert.equal(counter.broadcast, 1, JSON.stringify({
    counter: { sign: counter.sign, broadcast: counter.broadcast },
    retry: retryResults[0],
  }));
  const paged = await repository.readPagedPayoutState(cycleId, 'payout');
  const pagedRetry = paged.recipients[0].retries.find(item => item.retryId === retry.retryId);
  assert.equal(pagedRetry.state, 'FINALIZED');
  assert.deepEqual(await repository.listOpenPayoutRetries(), []);
});

test('D8 legacy attempts without retry fields normalize as complete', async () => {
  const state = refusedState();
  const legacyAttempt = { ...state.recipients[0], state: 'REFUSED' };
  delete legacyAttempt.retries;
  delete legacyAttempt.settlement;
  assert.equal(isRecipientPaid({ ...legacyAttempt, retries: [], settlement: null }), false);
  const proof = await nativeProof(
    fakeChain({ receipts: new Map([[ORIGINAL_HASH, paymentReceipt(ORIGINAL_HASH)]]) }),
    ORIGINAL_BYTES,
  );
  const finalized = {
    ...legacyAttempt,
    state: 'FINALIZED',
    finalizedTransfer: proof,
    refusalEvidence: null,
  };
  assert.equal(
    isDirectPayoutComplete({
      ...state,
      recipients: [finalized],
      quarantine: [],
    }),
    true,
  );
});
