import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, TransactionReceiptNotFoundError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createUsdgPayoutAmount } from '../../../runner/src/distribution/payout-plan.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { ERC20_TRANSFER_TOPIC } from '../../src/robinhood-rpc.mjs';
import { wrapSignerClient } from '../../src/signing/signer-client.mjs';
import { isDirectPayoutComplete } from '../../src/app/stages/payout.mjs';
import {
  assertConfirmedSale,
  mutateSupplementaryPayout,
  prepareSupplementaryReturnRequest,
  recordSupplementaryReturnBroadcast,
  SupplementaryMoneyError,
} from '../../src/app/stages/supplementary-money.mjs';
import { digest } from '../../../runner/src/cycle/journal.mjs';

const TOKEN = `0x${'a'.repeat(40)}`;
const OPERATIONS = `0x${'b'.repeat(40)}`;
const RECIPIENT_A = `0x${'c'.repeat(40)}`;
const RECIPIENT_B = `0x${'d'.repeat(40)}`;
const POSITION_ID = `held:${'e'.repeat(64)}`;
const POSITION_EVIDENCE_DIGEST = `sha256:${'f'.repeat(64)}`;
const PAYOUT_ACCOUNT = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const PAYOUT_OPERATIONS = PAYOUT_ACCOUNT.address.toLowerCase();
const SOLANA_WALLET = '11111111111111111111111111111112';
const SOLANA_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOLANA_SIGNATURE = `${'g'.repeat(88)}`;

function usdg(amountAtomic) {
  return createUsdgPayoutAmount({ assetId: TOKEN, amountAtomic });
}

function settlementIdentity(cycleId = 'cycle-supplementary-money') {
  return { positionId: POSITION_ID, cycleId, manifestId: `${cycleId}:supplementary:1` };
}

function confirmedSale(identity = settlementIdentity(), overrides = {}) {
  return {
    schema: 'hookemon.supplementary-confirmed-sale.v1',
    positionId: identity.positionId,
    cycleId: identity.cycleId,
    manifestId: identity.manifestId,
    sourceWallet: SOLANA_WALLET,
    mint: SOLANA_MINT,
    decimals: 6,
    amountAtomic: '9',
    transactionSignature: SOLANA_SIGNATURE,
    memo: `hookemon:${identity.positionId}`,
    sourceFinality: { slot: '100', blockTime: '1700000000' },
    ...overrides,
  };
}

function lifecycleConfig() {
  const usdgAsset = { chainId: '4663', assetId: TOKEN, decimals: 6 };
  const solanaStablecoin = { chainId: '792703809', assetId: SOLANA_MINT, decimals: 6 };
  return {
    chainId: 4663,
    accounts: { evm: PAYOUT_OPERATIONS },
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

function finalizedReturnEvidence(identity, overrides = {}) {
  return {
    operations: PAYOUT_OPERATIONS,
    usdgAddress: TOKEN,
    amountAtomic: '9',
    finalityEvidence: { transactionHash: `0x${'5'.repeat(64)}`, finalized: true },
    ...overrides,
  };
}

function returnBinding(identity, finalized) {
  return {
    operations: PAYOUT_OPERATIONS,
    usdgAddress: TOKEN,
    evidenceDigest: digest({
      schema: 'hookemon.supplementary-finalized-return-binding.v1',
      positionId: identity.positionId,
      cycleId: identity.cycleId,
      manifestId: identity.manifestId,
      finalizedReturnEvidence: {
        schema: 'hookemon.supplementary-finalized-return.v1',
        positionId: identity.positionId,
        cycleId: identity.cycleId,
        manifestId: identity.manifestId,
        ...finalized,
      },
    }),
  };
}

function payoutSource(identity, finalized = finalizedReturnEvidence(identity)) {
  return {
    schema: 'hookemon.supplementary-payout-source.v1',
    positionId: identity.positionId,
    cycleId: identity.cycleId,
    manifestId: identity.manifestId,
    finalizedReturn: usdg(finalized.amountAtomic),
    previousDust: usdg('0'),
    previousDustSource: null,
    returnBinding: returnBinding(identity, finalized),
  };
}

function returnBoundary(identity, finalized = finalizedReturnEvidence(identity)) {
  const evidence = {
    schema: 'hookemon.supplementary-return-boundary.v1',
    positionId: identity.positionId,
    cycleId: identity.cycleId,
    manifestId: identity.manifestId,
    finalizedReturnEvidence: {
      schema: 'hookemon.supplementary-finalized-return.v1',
      positionId: identity.positionId,
      cycleId: identity.cycleId,
      manifestId: identity.manifestId,
      ...finalized,
    },
  };
  const source = payoutSource(identity, finalized);
  return {
    state: 'RETURN_BROADCAST',
    evidenceDigest: digest({
      schema: 'hookemon.supplementary-settlement-evidence.v1',
      positionId: identity.positionId,
      manifestId: identity.manifestId,
      state: 'RETURN_BROADCAST',
      evidence,
      payoutSourceDigest: digest(source),
    }),
    evidence,
    payoutSource: source,
  };
}

function eligibilityManifest(cycleId) {
  return {
    schema: 'hookemon.eligibility-payout-manifest.v1',
    cycleId,
    snapshotBlock: '12',
    snapshotHash: `0x${'1'.repeat(64)}`,
    finality: { policyId: 'robinhood-stage-finality-v1', depth: '2' },
    supply: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '3' },
    entries: [
      { recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '2' } },
      { recipient: RECIPIENT_B, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } },
    ],
    exclusions: [],
    feasibility: {
      recipientCount: 2,
      transactionCount: 2,
      maxRecipientCount: 2,
      maxTransactionCount: 2,
      measuredTransferGas: '50000',
      maxGasPriceWei: '5',
      estimatedNativeFee: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '500000' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '10' },
      nativeBalance: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '500010' },
      requiredNativeAmount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '500010' },
      feasible: true,
      reason: null,
    },
    logCompleteness: {
      mode: 'single-source-explicitly-allowed',
      primary: { sourceId: 'primary', transferLogDigest: `sha256:${'2'.repeat(64)}`, logCount: 2 },
      secondary: null,
    },
    holderSnapshotDigest: `sha256:${'3'.repeat(64)}`,
    launchManifestDigest: `sha256:${'4'.repeat(64)}`,
  };
}

function settlement(cycleId, state, source = payoutSource(settlementIdentity(cycleId))) {
  const identity = settlementIdentity(cycleId);
  return {
    ...identity,
    state,
    positionEvidenceDigest: POSITION_EVIDENCE_DIGEST,
    eligibilitySnapshotEvidenceDigest: digest(eligibilityManifest(cycleId)),
    payoutSourceDigest: state === 'BUYBACK_SENT_UNKNOWN' ? null : digest(source),
  };
}

function addressTopic(address) {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function lifecycleReceipt({ transactionHash, recipient, amountAtomic }) {
  return {
    transactionHash,
    blockNumber: 100n,
    blockHash: `0x${'9'.repeat(64)}`,
    status: 'success',
    logs: [{
      address: TOKEN,
      topics: [ERC20_TRANSFER_TOPIC, addressTopic(PAYOUT_OPERATIONS), addressTopic(recipient)],
      data: `0x${BigInt(amountAtomic).toString(16).padStart(64, '0')}`,
      logIndex: '0',
    }],
  };
}

function lifecycleRpc() {
  let nonce = 0n;
  const receipts = new Map();
  let observedReceipt = null;
  const client = {
    async readContract({ functionName }) {
      assert.equal(functionName, 'isFrozen');
      return false;
    },
    async getTransactionCount() { return nonce; },
    async getBalance() { return 1_000_000n; },
    async getTransactionReceipt({ hash }) {
      const receipt = receipts.get(hash);
      if (!receipt) throw new TransactionReceiptNotFoundError({ hash });
      observedReceipt = receipt;
      return receipt;
    },
    async getBlock({ blockNumber } = {}) {
      if (blockNumber === 99n) return { number: 99n, hash: `0x${'8'.repeat(64)}`, timestamp: 1_700_000_000n };
      return { number: 100n, hash: `0x${'9'.repeat(64)}`, parentHash: `0x${'8'.repeat(64)}`, timestamp: 1_700_000_012n };
    },
    finalize(hash, receipt) { receipts.set(hash, receipt); },
    setNonce(value) { nonce = BigInt(value); },
  };
  client.historicalEvidenceClient = {
    async readErc20BalanceAtBlock({ account, blockNumber, blockHash }) {
      const transfer = observedReceipt?.logs?.[0] ?? null;
      const amount = transfer === null ? 0n : BigInt(transfer.data);
      const value = account.toLowerCase() === PAYOUT_OPERATIONS
        ? (blockNumber === 99n ? 1_000_000n : 1_000_000n - amount)
        : (blockNumber === 99n ? 0n : amount);
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
          const signedTx = await PAYOUT_ACCOUNT.signTransaction(signingTransaction);
          return { signedTx };
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

test('assertConfirmedSale accepts a full valid CS fixture and rejects a settlement mismatch', () => {
  const identity = settlementIdentity();
  const sale = confirmedSale(identity);
  const normalized = assertConfirmedSale(sale, identity);
  assert.equal(normalized.amountAtomic, '9');

  assert.throws(
    () => assertConfirmedSale(confirmedSale(identity, { positionId: `held:${'0'.repeat(64)}` }), identity),
    error => error instanceof SupplementaryMoneyError && /does not bind its settlement/.test(error.message),
  );
  assert.throws(
    () => assertConfirmedSale(confirmedSale(identity, { amountAtomic: '0' }), identity),
    /amountAtomic is invalid/,
  );
});

test('prepareSupplementaryReturnRequest binds the confirmed sale and requires a buyback-sent-unknown settlement', () => {
  const identity = settlementIdentity();
  const buybackSettlement = settlement(identity.cycleId, 'BUYBACK_SENT_UNKNOWN');
  const req = prepareSupplementaryReturnRequest({
    settlement: buybackSettlement,
    confirmedSale: confirmedSale(identity),
    config: lifecycleConfig(),
  });
  assert.equal(req.operations, PAYOUT_OPERATIONS);
  assert.equal(req.confirmedSale.amountAtomic, '9');

  assert.throws(
    () => prepareSupplementaryReturnRequest({
      settlement: settlement(identity.cycleId, 'RETURN_BROADCAST'),
      confirmedSale: confirmedSale(identity),
      config: lifecycleConfig(),
    }),
    /buyback-sent-unknown settlement/,
  );
});

test('recordSupplementaryReturnBroadcast durably advances the settlement with a proven finality record', async () => {
  const identity = settlementIdentity();
  const buybackSettlement = settlement(identity.cycleId, 'BUYBACK_SENT_UNKNOWN');
  const advances = [];
  const cycleRepository = {
    async advanceSupplementarySettlement(positionId, input) {
      advances.push({ positionId, ...input });
      return { ...buybackSettlement, state: input.nextState };
    },
  };
  const finalityEvidence = { transactionHash: `0x${'5'.repeat(64)}`, finalized: true };
  await recordSupplementaryReturnBroadcast({
    cycleRepository,
    settlement: buybackSettlement,
    finalizedReturnEvidence: { operations: OPERATIONS, usdgAddress: TOKEN, amountAtomic: '9', finalityEvidence },
  });

  assert.equal(advances.length, 1);
  assert.equal(advances[0].expectedState, 'BUYBACK_SENT_UNKNOWN');
  assert.equal(advances[0].nextState, 'RETURN_BROADCAST');
  assert.equal(advances[0].evidence.finalizedReturnEvidence.amountAtomic, '9');
  assert.equal(advances[0].evidence.positionId, identity.positionId);
});

test('mutateSupplementaryPayout drives a return-broadcast settlement through the real direct-payout engine to COMPLETE', async () => {
  const cycleId = 'cycle-supplementary-money-payout';
  const identity = settlementIdentity(cycleId);
  const sourceSettlement = settlement(cycleId, 'RETURN_BROADCAST');
  const durableBoundary = returnBoundary(identity);
  const records = new Map();
  const advances = [];
  const cycleRepository = {
    async readSupplementarySettlement(positionId) {
      assert.equal(positionId, identity.positionId);
      return sourceSettlement;
    },
    async readPagedPayoutState(id, stage) {
      return structuredClone(records.get(`${id} ${stage}`) ?? null);
    },
    async persistPagedPayoutState(id, stage, value) {
      records.set(`${id} ${stage}`, structuredClone(value));
    },
    async readSupplementarySettlementEvidence(positionId) {
      assert.equal(positionId, identity.positionId);
      return structuredClone(durableBoundary);
    },
    async advanceSupplementarySettlement(positionId, input) {
      advances.push({ positionId, ...input });
      return { ...sourceSettlement, state: input.nextState };
    },
  };
  const client = lifecycleRpc();
  const counter = { sign: 0 };

  let state = await mutateSupplementaryPayout({
    liveMode: true,
    adapters: { robinhood: { client } },
    config: lifecycleConfig(),
    signerClient: lifecycleSigner(counter),
    cycleRepository,
    context: { positionId: identity.positionId, eligibilityManifest: eligibilityManifest(cycleId), returnBoundary: durableBoundary },
  });
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_A).state, 'BROADCAST');

  client.finalize(state.recipients[0].txHash, lifecycleReceipt({
    transactionHash: state.recipients[0].txHash,
    recipient: state.recipients[0].recipient,
    amountAtomic: state.recipients[0].amount.amountAtomic,
  }));
  client.setNonce('1');
  state = await mutateSupplementaryPayout({
    liveMode: true,
    adapters: { robinhood: { client } },
    config: lifecycleConfig(),
    signerClient: lifecycleSigner(counter),
    cycleRepository,
    context: { positionId: identity.positionId, eligibilityManifest: eligibilityManifest(cycleId), returnBoundary: durableBoundary },
  });
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_B).state, 'BROADCAST');

  client.finalize(state.recipients[1].txHash, lifecycleReceipt({
    transactionHash: state.recipients[1].txHash,
    recipient: state.recipients[1].recipient,
    amountAtomic: state.recipients[1].amount.amountAtomic,
  }));
  state = await mutateSupplementaryPayout({
    liveMode: true,
    adapters: { robinhood: { client } },
    config: lifecycleConfig(),
    signerClient: lifecycleSigner(counter),
    cycleRepository,
    context: { positionId: identity.positionId, eligibilityManifest: eligibilityManifest(cycleId), returnBoundary: durableBoundary },
  });

  assert.equal(isDirectPayoutComplete(state), true);
  assert.deepEqual(state.recipients.map(entry => entry.state), ['FINALIZED', 'FINALIZED']);
  assert.equal(advances.length, 2);
  assert.equal(advances[0].expectedState, 'RETURN_BROADCAST');
  assert.equal(advances[0].nextState, 'PAYOUT_BROADCAST');
  assert.equal(advances[1].expectedState, 'PAYOUT_BROADCAST');
  assert.equal(advances[1].nextState, 'COMPLETE');
});
