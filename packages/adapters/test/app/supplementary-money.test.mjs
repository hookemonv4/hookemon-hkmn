import { prepareReturnRequest } from '../../src/app/stages/return.mjs';
import { createRelayClient } from '../../src/relay-client.mjs';
import { createProductionSupplementaryStageHandlers } from '../../src/app/compose.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, TransactionReceiptNotFoundError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Keypair, Transaction } from '@solana/web3.js';

import { createNativePayoutAmount } from '../../../runner/src/distribution/payout-plan.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { ERC20_TRANSFER_TOPIC } from '../../src/robinhood-rpc.mjs';
import { TOKEN_PROGRAM_ID, createSolanaRpcClient, signedSolanaTransactionSignature } from '../../src/solana-rpc.mjs';
import { DIRECTIONS, RELAY_CONSTANTS } from '../../src/relay-client.mjs';
import { wrapSignerClient } from '../../src/signing/signer-client.mjs';
import { isDirectPayoutComplete } from '../../src/app/stages/payout.mjs';
import {
  mutateSupplementaryReturn,
  mutateSupplementaryPayout,
  prepareSupplementaryReturnRequest,
  reconcileSupplementaryReturn,
  SupplementaryMoneyError,
  supplementaryReturnStageId,
} from '../../src/app/stages/supplementary-money.mjs';
import { supplementaryPayoutStageId } from '../../src/app/stages/supplementary-payout.mjs';
import { digest } from '../../../runner/src/cycle/journal.mjs';

const signedFixtures = new Map();
const TOKEN = `0x${'a'.repeat(40)}`;
const RECIPIENT_A = `0x${'c'.repeat(40)}`;
const RECIPIENT_B = `0x${'d'.repeat(40)}`;
const POSITION_ID = `held:${'e'.repeat(64)}`;
const POSITION_EVIDENCE_DIGEST = `sha256:${'f'.repeat(64)}`;
const PAYOUT_ACCOUNT = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const PAYOUT_OPERATIONS = PAYOUT_ACCOUNT.address.toLowerCase();
const SOLANA_MINT = RELAY_CONSTANTS.CIRCLE_USD_MINT ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDG_ADDRESS = 'native';

function settlementIdentity(cycleId = 'cycle-supplementary-money') {
  return { positionId: POSITION_ID, cycleId, manifestId: `${cycleId}:supplementary:1` };
}

function settlement(cycleId, state, payoutSourceDigest = null) {
  const identity = settlementIdentity(cycleId);
  return {
    ...identity,
    state,
    positionEvidenceDigest: POSITION_EVIDENCE_DIGEST,
    eligibilitySnapshotEvidenceDigest: `sha256:${'3'.repeat(64)}`,
    payoutSourceDigest,
  };
}

function moneyConfiguration() {
  return {
    schema: 'hookemon.money-configuration.v2',
    assets: {
      eth: { chainId: '4663', assetId: 'native', decimals: 18 },
      solanaStablecoin: { chainId: '792703809', assetId: SOLANA_MINT, decimals: 6 },
    },
    minimums: {
      robinhoodReceive: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '0' },
      solanaReceive: { chainId: '792703809', assetId: SOLANA_MINT, decimals: 6, amountAtomic: '0' },
      returnEth: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '0' },
    },
    evm: {
      perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '100' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '1000' },
    },
    solana: {
      priorityFeeCap: { chainId: '792703809', assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '100' },
      lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '1000' },
    },
  };
}

function returnConfig(operator) {
  return {
    chainId: 4663,
    accounts: { evm: PAYOUT_OPERATIONS, solana: operator },
    contracts: { usdg: USDG_ADDRESS },
    relay: { solanaMint: SOLANA_MINT, maxSettlementWindowSeconds: '600' },
    moneyConfiguration: moneyConfiguration(),
  };
}

function confirmedSale(overrides = {}) {
  return {
    status: 'CONFIRMED',
    memo: `hookemon:${POSITION_ID}`,
    mint: SOLANA_MINT,
    signature: `${'g'.repeat(88)}`,
    proceeds: { chainId: 'solana-mainnet', assetId: SOLANA_MINT, decimals: 6, amountAtomic: '17' },
    createdAt: '1700000000',
    ...overrides,
  };
}

function splTransferCheckedPlan({ owner, source, destination, amountAtomic }) {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(BigInt(amountAtomic), 1);
  data.writeUInt8(6, 9);
  return {
    instructions: [{
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: SOLANA_MINT, isSigner: false, isWritable: false },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      data: data.toString('hex'),
    }],
    addressLookupTableAddresses: [],
  };
}

function fakeRelayAdapter({ requestId, instructionPlan, destinationAmountAtomic = '16', pointer = null, now = () => 1_700_000_000_000, onResponse = () => {}, onQuote = () => {} }) {
  const zero = '0x0000000000000000000000000000000000000000';
  const client = createRelayClient({ now, quoteValidityMs: 60000,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const raw = { requestId, details: { sender: request.user, recipient: request.recipient,
        currencyIn: { currency: { chainId: 792703809, address: request.originCurrency, decimals: 6 }, amount: request.amount, amountUsd: '17' },
        currencyOut: { currency: { chainId: 4663, address: zero, decimals: 18 }, amount: destinationAmountAtomic, minimumAmount: destinationAmountAtomic, amountUsd: '16.0000009' } },
        protocol: { v2: { orderId: `0x${'44'.repeat(32)}`, orderData: { inputs: [{ payment: { chainId: 'solana', currency: request.originCurrency, amount: request.amount },
          refunds: [{ chainId: 'solana', currency: request.originCurrency, recipient: request.user, deadline: 2_000_000_000 }] }],
          output: { chainId: 'robinhood', deadline: 2_000_000_000, calls: [], payments: [{ recipient: request.recipient, currency: zero, expectedAmount: destinationAmountAtomic, minimumAmount: destinationAmountAtomic }] } } } },
        steps: [{ kind: 'transaction', requestId, items: [{ data: instructionPlan }] }] };
      onResponse();
      return { ok: true, status: 200, text: async () => JSON.stringify(raw) };
    } });
  return { ...client, quoteReturnBridge: async params => { const quote = await client.quoteReturnBridge({ ...params, skipRouteCheck: true }); onQuote(); return quote; },
    restoreIntent() {}, async getTerminalDestinationTransactionPointer({ intentDigest }) { assert.equal(intentDigest, requestId); return pointer; } };
}

function returnSolanaClient(blockhash, state = { blockHeight: 10, balance: 10_000 }) {
  return createSolanaRpcClient({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const resultByMethod = {
        getBalance: { context: { slot: 9 }, value: state.balance ?? 10_000 },
        getLatestBlockhash: { context: { slot: 10 }, value: { blockhash, lastValidBlockHeight: 100 } },
        isBlockhashValid: { context: { slot: 10 }, value: true },
        getBlockHeight: state.blockHeight,
      };
      if (!Object.hasOwn(resultByMethod, body.method)) throw new Error(`unexpected Solana RPC ${body.method}`);
      return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: resultByMethod[body.method] }) };
    },
  });
}

function returnSourceFinalityClient({ owner, amountAtomic }) {
  return createSolanaRpcClient({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.method, 'getTransaction');
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          jsonrpc: '2.0',
          id: body.id,
          result: {
            slot: 52,
            blockTime: 1_700_000_080,
            transaction: { message: { accountKeys: [{ pubkey: owner, signer: false, writable: true }], instructions: [] } },
            meta: {
              err: null,
              preTokenBalances: [{ accountIndex: 0, mint: SOLANA_MINT, owner, uiTokenAmount: { amount: amountAtomic, decimals: 6, uiAmountString: '0' } }],
              postTokenBalances: [{ accountIndex: 0, mint: SOLANA_MINT, owner, uiTokenAmount: { amount: '0', decimals: 6, uiAmountString: '0' } }],
            },
          },
        }),
      };
    },
  });
}

function addressTopic(address) {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function returnDestinationReceiptClient({ transactionHash, observedAmountAtomic = '16' }) {
  const receiptBlockHash = `0x${'a'.repeat(64)}`;
  return {
    async getTransactionReceipt() {
      return {
        transactionHash,
        blockNumber: 100n,
        blockHash: receiptBlockHash,
        status: 'success',
        logs: [{
          address: USDG_ADDRESS,
          topics: [ERC20_TRANSFER_TOPIC, addressTopic(`0x${'1'.repeat(40)}`), addressTopic(PAYOUT_OPERATIONS)],
          data: `0x${BigInt(observedAmountAtomic).toString(16).padStart(64, '0')}`,
          logIndex: '0',
        }],
      };
    },
    async getBlock({ blockTag, blockNumber } = {}) {
      if (blockTag === 'finalized') return { number: 100n, hash: receiptBlockHash, timestamp: 1_700_000_100n };
      if (blockNumber === 100n) return { number: 100n, hash: receiptBlockHash, timestamp: 1_700_000_100n };
      throw new Error(`unexpected getBlock ${JSON.stringify({ blockTag, blockNumber })}`);
    },
  };
}

function fakeRepository({ initialSettlementState = 'BUYBACK_SENT_UNKNOWN', durableSale = confirmedSale() } = {}) {
  const cycleId = 'cycle-supplementary-money';
  let settlementRecord = settlement(cycleId, initialSettlementState);
  const pagedState = new Map();
  const advances = [];
  return {
    cycleId,
    get settlementRecord() { return settlementRecord; },
    get advances() { return advances; },
    async readSupplementarySettlement(positionId) {
      assert.equal(positionId, POSITION_ID);
      return settlementRecord;
    },
    async readSupplementarySettlementEvidence(positionId) {
      assert.equal(positionId, POSITION_ID);
      return { state: initialSettlementState, evidence: structuredClone(durableSale) };
    },
    async readPagedPayoutState(id, stage) {
      return structuredClone(pagedState.get(`${id} ${stage}`) ?? null);
    },
    async persistPagedPayoutState(id, stage, value) {
      pagedState.set(`${id} ${stage}`, structuredClone(value));
    },
    async advanceSupplementarySettlement(positionId, input) {
      advances.push({ positionId, ...structuredClone(input) });
      settlementRecord = {
        ...settlementRecord,
        state: input.nextState,
        payoutSourceDigest: input.nextState === 'BUYBACK_SENT_UNKNOWN' ? null : digest(input.evidence),
      };
      return settlementRecord;
    },
    _dumpStages() { return [...pagedState.keys()]; },
  };
}

test('prepareSupplementaryReturnRequest rejects a proceeds mint outside the configured Solana settlement asset', () => {
  const operator = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_unused, i) => i + 11)).publicKey.toBase58();
  assert.throws(
    () => prepareSupplementaryReturnRequest({
      settlement: settlement('cycle-x', 'BUYBACK_SENT_UNKNOWN'),
      confirmedSale: confirmedSale({ mint: 'So11111111111111111111111111111111111111112', proceeds: { chainId: 'solana-mainnet', assetId: 'So11111111111111111111111111111111111111112', decimals: 6, amountAtomic: '17' } }),
      config: returnConfig(operator),
    }),
    error => error instanceof SupplementaryMoneyError && /configured Solana settlement asset/.test(error.message),
  );
});

test('supplementaryReturnStageId never collides with the payout-leg stage id for the same position', () => {
  const returnStage = supplementaryReturnStageId(POSITION_ID);
  const payoutStage = supplementaryPayoutStageId(POSITION_ID);
  assert.notEqual(returnStage, payoutStage);
  assert.match(returnStage, /^supplementary-[0-9a-f]{48}$/);
});

test('mutateSupplementaryReturn signs durably before broadcast, resumes after a lost broadcast response, and refuses legacy token evidence at native reconciliation', async () => {
  const operator = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_unused, i) => i + 11));
  const source = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_unused, i) => i + 43));
  const destination = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_unused, i) => i + 75));
  const blockhash = '11111111111111111111111111111111';
  const operatorAddress = operator.publicKey.toBase58();
  const config = returnConfig(operatorAddress);
  const repository = fakeRepository();
  const requestId = 'relay-supplementary-return-1';
  const instructionPlan = splTransferCheckedPlan({
    owner: operatorAddress,
    source: source.publicKey.toBase58(),
    destination: destination.publicKey.toBase58(),
    amountAtomic: '17',
  });
  const rpcState = { blockHeight: 10 };
  const solanaClient = returnSolanaClient(blockhash, rpcState);
  let signCalls = 0;
  let broadcastCalls = 0;
  let persistedBytes = null;
  let sourceTransactionHash = null;
  const signerClient = {
    solana: {
      role: 'operator-solana',
      async sign({ transaction }) {
        signCalls += 1;
        const signed = Transaction.from(Buffer.from(transaction, 'base64'));
        signed.sign(operator);
        const signedTxBase64 = signed.serialize().toString('base64');
        sourceTransactionHash = signedSolanaTransactionSignature(signedTxBase64);
        return { signedTxBase64 };
      },
      async broadcast({ signedTxBase64 }) {
        broadcastCalls += 1;
        if (persistedBytes === null) {
          persistedBytes = signedTxBase64;
          throw new Error('broadcast interrupted after durable signature');
        }
        assert.equal(signedTxBase64, persistedBytes);
        return { signature: sourceTransactionHash };
      },
    },
  };
  const adapters = {
    solana: { client: solanaClient },
    relay: fakeRelayAdapter({ requestId, instructionPlan }),
  };
  const context = { cycleId: repository.cycleId, positionId: POSITION_ID, fencingToken: '22222222-2222-4222-8222-222222222222' };

  await assert.rejects(
    () => mutateSupplementaryReturn({
      liveMode: true, adapters, config, signerClient, cycleRepository: repository, context,
      confirmedSale: confirmedSale(), now: () => 1_700_000_000_000, preflightAuthority: createTestProfileMutationAuthority(),
    }),
    /broadcast interrupted after durable signature/,
  );
  assert.equal(signCalls, 1);
  let attempt = await repository.readPagedPayoutState(repository.cycleId, supplementaryReturnStageId(POSITION_ID));
  assert.equal(attempt.state, 'SIGNED');
  assert.equal(attempt.rawSignedBytes, persistedBytes);

  // Restart resumes the SAME persisted signed bytes -- never re-signs.
  await mutateSupplementaryReturn({
    liveMode: true, adapters, config, signerClient, cycleRepository: repository, context,
    confirmedSale: confirmedSale(), now: () => 1_700_000_000_000, preflightAuthority: createTestProfileMutationAuthority(),
  });
  assert.equal(signCalls, 1, 'restart must not re-sign already-durable bytes');
  assert.equal(broadcastCalls, 2);
  attempt = await repository.readPagedPayoutState(repository.cycleId, supplementaryReturnStageId(POSITION_ID));
  assert.equal(attempt.state, 'BROADCAST');
  assert.match(attempt.sourceTransactionHash, /^[1-9A-HJ-NP-Za-km-z]{80,88}$/);

  // A second call after BROADCAST is a real no-op: no further sign or broadcast.
  await mutateSupplementaryReturn({
    liveMode: true, adapters, config, signerClient, cycleRepository: repository, context,
    confirmedSale: confirmedSale(), now: () => 1_700_000_000_000, preflightAuthority: createTestProfileMutationAuthority(),
  });
  assert.equal(signCalls, 1);
  assert.equal(broadcastCalls, 2);

  const pointer = {
    schema: 'hookemon.relay-terminal-destination-pointer.v1',
    relayRequestId: requestId,
    status: 'SUCCESS',
    destinationTxHash: `0x${'9'.repeat(64)}`,
  };
  const reconcileAdapters = {
    solana: { client: returnSourceFinalityClient({ owner: operatorAddress, amountAtomic: '17' }) },
    relay: fakeRelayAdapter({ requestId, instructionPlan, pointer }),
    robinhood: { client: returnDestinationReceiptClient({ transactionHash: pointer.destinationTxHash, observedAmountAtomic: '16' }) },
  };
  const reconciled = await reconcileSupplementaryReturn({
    adapters: reconcileAdapters, config, cycleRepository: repository, context,
  });

  assert.equal(reconciled, null, 'ERC20 logs and balance deltas cannot supply native payment authority');
  assert.equal(repository.advances.length, 0);
});

test('mutateSupplementaryReturn rejects a caller sale that is absent from its durable position settlement', async () => {
  const operator = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_unused, i) => i + 11));
  const repository = fakeRepository({ durableSale: confirmedSale({ signature: `${'h'.repeat(88)}` }) });
  await assert.rejects(
    () => mutateSupplementaryReturn({
      liveMode: true,
      adapters: {},
      config: returnConfig(operator.publicKey.toBase58()),
      signerClient: {},
      cycleRepository: repository,
      context: { cycleId: repository.cycleId, positionId: POSITION_ID },
      confirmedSale: confirmedSale(),
      preflightAuthority: createTestProfileMutationAuthority(),
    }),
    /does not match durable settlement evidence/,
  );
});

test('a position\'s return-leg attempt never touches the payout-leg paged state for the same position', async () => {
  const repository = fakeRepository();
  const returnStage = supplementaryReturnStageId(POSITION_ID);
  const payoutStage = supplementaryPayoutStageId(POSITION_ID);
  await repository.persistPagedPayoutState(repository.cycleId, returnStage, { schema: 'hookemon.supplementary-return-attempt.v2', marker: 'return-leg', recipients: [] });
  assert.equal(await repository.readPagedPayoutState(repository.cycleId, payoutStage), null);
  const stored = await repository.readPagedPayoutState(repository.cycleId, returnStage);
  assert.equal(stored.marker, 'return-leg');
});

function usdg(amountAtomic) {
  return createNativePayoutAmount({ assetId: 'native', amountAtomic });
}

function payoutFinalizedReturnEvidence(identity, overrides = {}) {
  return {
    operations: PAYOUT_OPERATIONS,
    assetId: 'native',
    amountAtomic: '9',
    finalityEvidence: { transactionHash: `0x${'5'.repeat(64)}`, finalized: true },
    ...overrides,
  };
}

function payoutReturnBinding(identity, finalized) {
  return {
    operations: PAYOUT_OPERATIONS,
    assetId: 'native',
    evidenceDigest: digest({
      schema: 'hookemon.supplementary-finalized-return-binding.v2',
      positionId: identity.positionId,
      cycleId: identity.cycleId,
      manifestId: identity.manifestId,
      finalizedReturnEvidence: { schema: 'hookemon.supplementary-finalized-return.v2', positionId: identity.positionId, cycleId: identity.cycleId, manifestId: identity.manifestId, ...finalized },
    }),
  };
}

function payoutSource(identity, finalized = payoutFinalizedReturnEvidence(identity)) {
  return {
    schema: 'hookemon.supplementary-payout-source.v2',
    positionId: identity.positionId,
    cycleId: identity.cycleId,
    manifestId: identity.manifestId,
    finalizedReturn: usdg(finalized.amountAtomic),
    previousDust: usdg('0'),
    previousDustSource: null,
    returnBinding: payoutReturnBinding(identity, finalized),
  };
}

function payoutReturnBoundary(identity, finalized = payoutFinalizedReturnEvidence(identity)) {
  const evidence = {
    schema: 'hookemon.supplementary-return-boundary.v2',
    positionId: identity.positionId,
    cycleId: identity.cycleId,
    manifestId: identity.manifestId,
    finalizedReturnEvidence: { schema: 'hookemon.supplementary-finalized-return.v2', positionId: identity.positionId, cycleId: identity.cycleId, manifestId: identity.manifestId, ...finalized },
  };
  const source = payoutSource(identity, finalized);
  return {
    state: 'RETURN_BROADCAST',
    evidenceDigest: digest({
      schema: 'hookemon.supplementary-settlement-evidence.v2',
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

function payoutEligibilityManifest(cycleId) {
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
      recipientCount: 2, transactionCount: 2, maxRecipientCount: 2, maxTransactionCount: 2,
      measuredTransferGas: '50000', maxGasPriceWei: '5',
      estimatedNativeFee: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '500000' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '10' },
      nativeBalance: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '500010' },
      requiredNativeAmount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '500010' },
      feasible: true, reason: null,
    },
    logCompleteness: { mode: 'single-source-explicitly-allowed', primary: { sourceId: 'primary', transferLogDigest: `sha256:${'2'.repeat(64)}`, logCount: 2 }, secondary: null },
    holderSnapshotDigest: `sha256:${'3'.repeat(64)}`,
    launchManifestDigest: `sha256:${'4'.repeat(64)}`,
  };
}

function payoutSettlement(cycleId, state, source = payoutSource(settlementIdentity(cycleId))) {
  const identity = settlementIdentity(cycleId);
  return {
    ...identity,
    state,
    positionEvidenceDigest: POSITION_EVIDENCE_DIGEST,
    eligibilitySnapshotEvidenceDigest: digest(payoutEligibilityManifest(cycleId)),
    payoutSourceDigest: digest(source),
  };
}

function payoutLifecycleRpc() {
  let nonce = 0n;
  const receipts = new Map();
  let observedReceipt = null;
  const client = {
    async readContract({ functionName }) { assert.equal(functionName, 'isFrozen'); return false; },
    async getChainId() { return 4663; },
    async getTransaction({hash}) { return {...signedFixtures.get(hash),blockNumber:100n,blockHash:`0x${'9'.repeat(64)}`}; },
    async getTransactionCount() { return nonce; },
    async getBalance() { return 1_000_000n; },
    async getTransactionReceipt({ hash }) {
      const receipt = receipts.get(hash);
      if (!receipt) throw new TransactionReceiptNotFoundError({ hash });
      observedReceipt = receipt;
      return {...receipt,gasUsed:50000n,effectiveGasPrice:2n};
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

function payoutLifecycleSigner(counter) {
  return {
    evm: wrapSignerClient({
      role: 'operator-evm',
      liveMode: true,
      preflightAuthority: createTestProfileMutationAuthority(),
      inner: {
        async sign({ transaction }) {
          counter.sign += 1;
          const signingTransaction = { ...transaction };
          for (const field of ['nonce', 'value', 'gas', 'gasPrice']) signingTransaction[field] = BigInt(signingTransaction[field]);
          const signedTx=await PAYOUT_ACCOUNT.signTransaction(signingTransaction);
          signedFixtures.set(keccak256(signedTx),{...signingTransaction,hash:keccak256(signedTx),from:PAYOUT_OPERATIONS});
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

function payoutLifecycleConfig() {
  const usdgAsset = { chainId: '4663', assetId: 'native', decimals: 18 };
  const solanaStablecoin = { chainId: '792703809', assetId: SOLANA_MINT, decimals: 6 };
  return {
    chainId: 4663,
    accounts: { evm: PAYOUT_OPERATIONS },
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

test('production supplementary payout preserves the return boundary and resumes after the durable broadcast checkpoint', async () => {
  const cycleId = 'cycle-supplementary-money-payout';
  const identity = settlementIdentity(cycleId);
  let sourceSettlement = payoutSettlement(cycleId, 'RETURN_BROADCAST');
  const durableBoundary = payoutReturnBoundary(identity);
  let storedBoundary = durableBoundary;
  let interruptCompletion = true;
  const records = new Map();
  const advances = [];
  const cycleRepository = {
    async readStage(id, stage) { assert.equal(id, cycleId); assert.equal(stage, 'eligibility-snapshot'); return { status: 'COMPLETE', evidence: payoutEligibilityManifest(cycleId) }; },
    async readSupplementarySettlement(positionId) { assert.equal(positionId, identity.positionId); return sourceSettlement; },
    async readPagedPayoutState(id, stage) { return structuredClone(records.get(`${id} ${stage}`) ?? null); },
    async persistPagedPayoutState(id, stage, value) { records.set(`${id} ${stage}`, structuredClone(value)); },
    async readSupplementarySettlementEvidence(positionId) { assert.equal(positionId, identity.positionId); return structuredClone(storedBoundary); },
    async advanceSupplementarySettlement(positionId, input) {
      if (input.nextState === 'COMPLETE' && interruptCompletion) throw new Error('synthetic interruption before completion');
      advances.push({ positionId, ...input });
      sourceSettlement = { ...sourceSettlement, state: input.nextState };
      storedBoundary = { state: input.nextState, evidenceDigest: digest(input.evidence), evidence: input.evidence, payoutSource: durableBoundary.payoutSource, returnBoundary: durableBoundary };
      return sourceSettlement;
    },
  };
  const client = payoutLifecycleRpc();
  const balanceChecks = [];
  client.getBalance = async () => {
    const recipients = [...records.values()][0]?.recipients ?? [];
    const finalized = recipients.filter(entry => entry.state === 'FINALIZED');
    const paid = finalized.reduce((sum, entry) => sum + BigInt(entry.amount.amountAtomic), 0n);
    const exact = 9n - paid + BigInt(2 - finalized.length) * 250000n + 10n;
    balanceChecks.push(exact);
    return exact;
  };
  const counter = { sign: 0 };

  const reconcile = () => createProductionSupplementaryStageHandlers({ assertCanary: async () => {} })[sourceSettlement.state].reconcile({
    adapters: { robinhood: { client } }, config: payoutLifecycleConfig(), signerClient: payoutLifecycleSigner(counter),
    cycleRepository, context: { cycleId, positionId: identity.positionId, stage: 'supplementary-payout' }, position: identity,
  });
  let state = await reconcile();
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_A).state, 'BROADCAST');

  client.finalize(state.recipients[0].txHash, {
    transactionHash: state.recipients[0].txHash, blockNumber: 100n, blockHash: `0x${'9'.repeat(64)}`, status: 'success',
    logs: [{ address: TOKEN, topics: [ERC20_TRANSFER_TOPIC, addressTopic(PAYOUT_OPERATIONS), addressTopic(state.recipients[0].recipient)], data: `0x${BigInt(state.recipients[0].amount.amountAtomic).toString(16).padStart(64, '0')}`, logIndex: '0' }],
  });
  client.setNonce('1');
  state = await reconcile();
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_B).state, 'BROADCAST');
  // The persisted first payment has signed identity and native finality; corrupting its proof
  // must refuse before the remaining-balance calculation can subtract that payment.
  const [storedKey, validStored] = [...records.entries()][0];
  const forgedStored = structuredClone(validStored);
  forgedStored.recipients[0].finalizedTransfer.evidenceDigest = `sha256:${'0'.repeat(64)}`;
  records.set(storedKey, forgedStored);
  const checksBeforeForgery = balanceChecks.length;
  await assert.rejects(reconcile, /native proof evidence digest is invalid/);
  assert.equal(balanceChecks.length, checksBeforeForgery);
  records.set(storedKey, validStored);

  client.finalize(state.recipients[1].txHash, {
    transactionHash: state.recipients[1].txHash, blockNumber: 100n, blockHash: `0x${'9'.repeat(64)}`, status: 'success',
    logs: [{ address: TOKEN, topics: [ERC20_TRANSFER_TOPIC, addressTopic(PAYOUT_OPERATIONS), addressTopic(state.recipients[1].recipient)], data: `0x${BigInt(state.recipients[1].amount.amountAtomic).toString(16).padStart(64, '0')}`, logIndex: '0' }],
  });
  await assert.rejects(reconcile, /synthetic interruption before completion/);
  assert.equal(sourceSettlement.state, 'PAYOUT_BROADCAST');
  assert.ok(balanceChecks.includes(250013n), 'resume admits exactly unpaid principal plus one transaction gas and reserve');
  const signedAtCheckpoint = counter.sign;
  const checksAtCheckpoint = balanceChecks.length;
  const broadcastAtCheckpoint = counter.broadcasts.length;
  const validBoundary = storedBoundary;
  storedBoundary = { ...validBoundary, returnBoundary: { ...durableBoundary, evidenceDigest: `sha256:${'0'.repeat(64)}` } };
  await assert.rejects(reconcile, /return boundary evidence digest/);
  storedBoundary = { ...validBoundary, returnBoundary: { ...durableBoundary, extra: true } };
  await assert.rejects(reconcile, /return boundary must use the exact schema/);
  storedBoundary = validBoundary;
  interruptCompletion = false;
  state = await reconcile();
  assert.equal(balanceChecks.length, checksAtCheckpoint, 'terminal retry performs no fresh spending admission');
  assert.equal(counter.sign, signedAtCheckpoint);
  assert.equal(counter.broadcasts.length, broadcastAtCheckpoint);

  assert.equal(isDirectPayoutComplete(state), true);
  assert.deepEqual(state.recipients.map(entry => entry.state), ['FINALIZED', 'FINALIZED']);
  assert.equal(state.recipients.reduce((sum, entry) => sum + BigInt(entry.amount.amountAtomic), 0n).toString(), durableBoundary.payoutSource.finalizedReturn.amountAtomic);
  assert.ok(state.recipients.every(entry => BigInt(entry.amount.amountAtomic) > 0n));
  assert.equal(advances.length, 2);
  assert.equal(advances[0].nextState, 'PAYOUT_BROADCAST');
  assert.equal(advances[1].nextState, 'COMPLETE');
});


test('supplementary return accepts native sale namespace and refuses aliases or invalid proceeds', () => {
  const operator = Keypair.generate().publicKey.toBase58();
  const input = { settlement: settlement('cycle-x', 'BUYBACK_SENT_UNKNOWN'), confirmedSale: confirmedSale(), config: returnConfig(operator) };
  const request = prepareSupplementaryReturnRequest(input);
  assert.equal(request.solanaAmountAtomic, '17');
  assert.equal(request.solanaMint, SOLANA_MINT);
  for (const chainId of ['792703809', 792703809, 'solana:mainnet']) {
    assert.throws(() => prepareSupplementaryReturnRequest({ ...input, confirmedSale: confirmedSale({ proceeds: { ...confirmedSale().proceeds, chainId } }) }), /chainId is invalid/);
  }
  for (const patch of [{ decimals: 9 }, { amountAtomic: '0' }, { amountAtomic: '-1' }, { amountAtomic: '1.5' }]) {
    assert.throws(() => prepareSupplementaryReturnRequest({ ...input, confirmedSale: confirmedSale({ proceeds: { ...confirmedSale().proceeds, ...patch } }) }), /decimals|amountAtomic/);
  }
});


test('production supplementary return composition preserves the supplied authority before signing', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_700_000_000_000 });
  for (const preflightAuthority of [createTestProfileMutationAuthority(), undefined, Object.freeze({})]) {
    const operator = Keypair.generate();
    const owner = operator.publicKey.toBase58();
    const repository = fakeRepository();
    const instructionPlan = splTransferCheckedPlan({ owner, source: Keypair.generate().publicKey.toBase58(), destination: Keypair.generate().publicKey.toBase58(), amountAtomic: '17' });
    let signs = 0;
    let canaries = 0;
    const handler = createProductionSupplementaryStageHandlers({ async assertCanary() { canaries += 1; } }).BUYBACK_SENT_UNKNOWN;
    await assert.rejects(() => handler.reconcile({
      adapters: { solana: { client: returnSolanaClient('11111111111111111111111111111111', { blockHeight: 10 }) }, relay: fakeRelayAdapter({ requestId: 'relay-authority', instructionPlan }) },
      signerClient: { solana: { role: 'operator-solana', async sign() { signs += 1; throw new Error('sign boundary reached'); }, async broadcast() { throw new Error('must not broadcast'); } } },
      config: returnConfig(owner), cycleRepository: repository,
      position: { positionId: POSITION_ID }, context: { cycleId: repository.cycleId, positionId: POSITION_ID, fencingToken: '22222222-2222-4222-8222-222222222222' }, preflightAuthority,
    }), preflightAuthority === createTestProfileMutationAuthority() ? /sign boundary reached/ : /authority/);
    assert.equal(canaries, 1);
    assert.equal(signs, preflightAuthority === createTestProfileMutationAuthority() ? 1 : 0);
  }
});

for (const supplementary of [false, true]) {
  for (const expired of [false, true]) {
    test(`return quote clock ${supplementary ? 'supplementary' : 'ordinary'} ${expired ? 'expired' : 'advancing'} preserves original validity`, async () => {
      const startedAt = 1_700_000_000_000;
      let timestamp = startedAt;
      const now = () => timestamp;
      const owner = Keypair.fromSeed(new Uint8Array(32).fill(7)).publicKey.toBase58();
      const config = { ...returnConfig(owner), now, solana: { chainId: 'solana-mainnet' },
        collectorCrypt: { settlementAsset: { chainId: 'solana-mainnet', assetId: SOLANA_MINT, decimals: 6 } } };
      const instructionPlan = splTransferCheckedPlan({ owner, source: owner, destination: owner, amountAtomic: '17' });
      const relay = fakeRelayAdapter({ requestId: 'clock-return', instructionPlan, now,
        onResponse: () => { timestamp += 2; }, onQuote: () => { if (expired) timestamp += 60_000; } });
      let prepared = null;
      if (supplementary) {
        const repository = fakeRepository();
        repository.persistPagedPayoutState = async (_cycle, _stage, value) => { prepared = value; throw new Error('clock fixture prepared before signing'); };
        await assert.rejects(mutateSupplementaryReturn({ liveMode: true, adapters: { relay }, config, signerClient: {},
          cycleRepository: repository, context: { cycleId: repository.cycleId, positionId: POSITION_ID },
          confirmedSale: confirmedSale(), now, preflightAuthority: createTestProfileMutationAuthority() }),
        expired ? /quote is stale/ : /clock fixture prepared before signing/);
      } else {
        const cycleId = 'clock-return-cycle';
        const repository = { async describeCycle() { return { admission: { schema: 'hookemon.policy-admission.v3' },
          custodyLedgers: new Map([['settlement', { chainId: 'solana-mainnet', assetId: SOLANA_MINT, decimals: 6,
            buybackProceeds: '17', returnInput: '0' }]]) }; } };
        const operation = prepareReturnRequest({ adapters: { relay }, config, cycleRepository: repository, context: { cycleId }, nowMs: startedAt });
        if (expired) await assert.rejects(operation, /quote is stale/);
        else prepared = await operation;
      }
      if (expired) assert.equal(prepared, null, 'expired evidence cannot prepare a return or renew its TTL');
      else {
        assert.equal(prepared.destinationUsd.amountMicroUsd, '16000000');
        assert.equal(prepared.destinationUsd.observedAtMs, startedAt + 2);
        assert.equal(prepared.destinationUsd.validUntilMs, startedAt + 60_002);
      }
    });
  }
}

for (const [label, balance] of [['gas-only', 500010n], ['one-wei-short', 500018n], ['missing', null], ['malformed', -1n], ['exact', 500019n]]) {
  test(`supplementary payout initial native balance ${label} is checked before persistence`, async () => {
    const cycleId = 'synthetic-supplementary-balance';
    const identity = settlementIdentity(cycleId);
    const boundary = payoutReturnBoundary(identity);
    let persisted = 0, signed = 0;
    const repository = {
      async readSupplementarySettlement() { return payoutSettlement(cycleId, 'RETURN_BROADCAST'); },
      async advanceSupplementarySettlement() { throw new Error('unexpected settlement advance'); },
      async readPagedPayoutState() { return null; },
      async persistPagedPayoutState() { persisted += 1; throw new Error('synthetic verified balance persistence boundary'); },
      async readSupplementarySettlementEvidence() { return boundary; },
    };
    const client = { async getTransactionCount() { return 0n; }, ...(balance === null ? {} : { async getBalance() { return balance; } }) };
    await assert.rejects(mutateSupplementaryPayout({ liveMode: true, config: payoutLifecycleConfig(),
      adapters: { robinhood: { client } }, signerClient: { evm: { async sign() { signed += 1; } } },
      cycleRepository: repository, context: { cycleId, positionId: identity.positionId, eligibilityManifest: payoutEligibilityManifest(cycleId), returnBoundary: boundary },
    }), label === 'exact' ? /synthetic verified balance persistence boundary/ : label === 'missing' ? /requires getBalance/ : label === 'malformed' ? /balance is invalid/ : /remaining principal plus gas and reserve/);
    assert.equal(persisted, label === 'exact' ? 1 : 0);
    assert.equal(signed, 0);
  });
}
