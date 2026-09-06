import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256, TransactionReceiptNotFoundError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Keypair, Transaction } from '@solana/web3.js';

import { createUsdgPayoutAmount } from '../../../runner/src/distribution/payout-plan.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { ERC20_TRANSFER_TOPIC } from '../../src/robinhood-rpc.mjs';
import { TOKEN_PROGRAM_ID, createSolanaRpcClient, signedSolanaTransactionSignature } from '../../src/solana-rpc.mjs';
import { DIRECTIONS, RELAY_CONSTANTS } from '../../src/relay-client.mjs';
import { wrapSignerClient } from '../../src/signing/signer-client.mjs';
import { isDirectPayoutComplete } from '../../src/app/stages/payout.mjs';
import {
  mutateSupplementaryPayout,
  mutateSupplementaryReturn,
  prepareSupplementaryReturnRequest,
  reconcileSupplementaryReturn,
  SupplementaryMoneyError,
  supplementaryReturnStageId,
} from '../../src/app/stages/supplementary-money.mjs';
import { supplementaryPayoutStageId } from '../../src/app/stages/supplementary-payout.mjs';
import { digest } from '../../../runner/src/cycle/journal.mjs';

const TOKEN = `0x${'a'.repeat(40)}`;
const RECIPIENT_A = `0x${'c'.repeat(40)}`;
const RECIPIENT_B = `0x${'d'.repeat(40)}`;
const POSITION_ID = `held:${'e'.repeat(64)}`;
const POSITION_EVIDENCE_DIGEST = `sha256:${'f'.repeat(64)}`;
const PAYOUT_ACCOUNT = privateKeyToAccount(`0x${'1'.repeat(64)}`);
const PAYOUT_OPERATIONS = PAYOUT_ACCOUNT.address.toLowerCase();
const SOLANA_MINT = RELAY_CONSTANTS.CIRCLE_USD_MINT ?? 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDG_ADDRESS = RELAY_CONSTANTS.USDG_ADDRESS.toLowerCase();

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
    schema: 'hookemon.money-configuration.v1',
    assets: {
      usdg: { chainId: '4663', assetId: USDG_ADDRESS, decimals: 6 },
      solanaStablecoin: { chainId: '792703809', assetId: SOLANA_MINT, decimals: 6 },
    },
    minimums: {
      robinhoodReceive: { chainId: '4663', assetId: USDG_ADDRESS, decimals: 6, amountAtomic: '0' },
      solanaReceive: { chainId: '792703809', assetId: SOLANA_MINT, decimals: 6, amountAtomic: '0' },
      returnUsdg: { chainId: '4663', assetId: USDG_ADDRESS, decimals: 6, amountAtomic: '0' },
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
    proceeds: { chainId: '792703809', assetId: SOLANA_MINT, decimals: 6, amountAtomic: '17' },
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

function fakeRelayAdapter({ requestId, instructionPlan, destinationAmountAtomic = '16', pointer = null }) {
  return {
    async quoteReturnBridge({ user, recipient, amount, originCurrency }) {
      return {
        direction: DIRECTIONS.RETURN,
        requestId,
        deadlineUnixSeconds: 2_000_000_000,
        origin: { chainId: RELAY_CONSTANTS.SOLANA_CHAIN_ID, address: originCurrency, decimals: 6, amount },
        destination: { chainId: RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID, address: USDG_ADDRESS, decimals: 6, amount: destinationAmountAtomic },
        sender: user,
        recipient,
      };
    },
    prepareExecution({ quote }) {
      return {
        intent: {
          schema: 'hookemon.relay-intent.v1',
          requestId: quote.requestId,
          orderId: `order-${quote.requestId}`,
          direction: 'RETURN',
          originChainId: quote.origin.chainId,
          destinationChainId: quote.destination.chainId,
          originAssetId: quote.origin.address,
          originDecimals: quote.origin.decimals,
          destinationAssetId: quote.destination.address,
          destinationDecimals: quote.destination.decimals,
          originAmount: quote.origin.amount,
          quotedDestinationAmount: quote.destination.amount,
          quotedDestinationMinimumAmount: quote.destination.amount,
          sender: quote.sender,
          recipient: quote.recipient,
          deadlineUnixSeconds: 2_000_000_000,
        },
        steps: [{ kind: 'transaction', requestId: quote.requestId, items: [{ data: instructionPlan }] }],
      };
    },
    restoreIntent() {},
    async getTerminalDestinationTransactionPointer({ intentDigest }) {
      assert.equal(intentDigest, requestId);
      return pointer;
    },
  };
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
      confirmedSale: confirmedSale({ mint: 'So11111111111111111111111111111111111111112', proceeds: { chainId: '792703809', assetId: 'So11111111111111111111111111111111111111112', decimals: 6, amountAtomic: '17' } }),
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

test('mutateSupplementaryReturn signs durably before broadcast, resumes after a lost broadcast response, then reconciles to a real destination proof', async () => {
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

  assert.equal(reconciled.state, 'RETURN_BROADCAST');
  assert.equal(repository.advances.length, 1);
  assert.equal(repository.advances[0].expectedState, 'BUYBACK_SENT_UNKNOWN');
  assert.equal(repository.advances[0].nextState, 'RETURN_BROADCAST');
  assert.equal(repository.advances[0].evidence.finalizedReturnEvidence.amountAtomic, '16');
  assert.equal(repository.advances[0].evidence.finalizedReturnEvidence.operations, PAYOUT_OPERATIONS);

  // Calling reconcile again on an already-RETURN_BROADCAST settlement is a safe replay, not a
  // double-advance (advanceSupplementarySettlement itself enforces the {expectedState} guard;
  // this proves the caller side never skips that check).
  const secondReconcile = await reconcileSupplementaryReturn({
    adapters: reconcileAdapters, config, cycleRepository: repository, context,
  });
  assert.equal(secondReconcile.state, 'RETURN_BROADCAST');
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
  await repository.persistPagedPayoutState(repository.cycleId, returnStage, { schema: 'hookemon.supplementary-return-attempt.v1', marker: 'return-leg', recipients: [] });
  assert.equal(await repository.readPagedPayoutState(repository.cycleId, payoutStage), null);
  const stored = await repository.readPagedPayoutState(repository.cycleId, returnStage);
  assert.equal(stored.marker, 'return-leg');
});

function usdg(amountAtomic) {
  return createUsdgPayoutAmount({ assetId: TOKEN, amountAtomic });
}

function payoutFinalizedReturnEvidence(identity, overrides = {}) {
  return {
    operations: PAYOUT_OPERATIONS,
    usdgAddress: TOKEN,
    amountAtomic: '9',
    finalityEvidence: { transactionHash: `0x${'5'.repeat(64)}`, finalized: true },
    ...overrides,
  };
}

function payoutReturnBinding(identity, finalized) {
  return {
    operations: PAYOUT_OPERATIONS,
    usdgAddress: TOKEN,
    evidenceDigest: digest({
      schema: 'hookemon.supplementary-finalized-return-binding.v1',
      positionId: identity.positionId,
      cycleId: identity.cycleId,
      manifestId: identity.manifestId,
      finalizedReturnEvidence: { schema: 'hookemon.supplementary-finalized-return.v1', positionId: identity.positionId, cycleId: identity.cycleId, manifestId: identity.manifestId, ...finalized },
    }),
  };
}

function payoutSource(identity, finalized = payoutFinalizedReturnEvidence(identity)) {
  return {
    schema: 'hookemon.supplementary-payout-source.v1',
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
    schema: 'hookemon.supplementary-return-boundary.v1',
    positionId: identity.positionId,
    cycleId: identity.cycleId,
    manifestId: identity.manifestId,
    finalizedReturnEvidence: { schema: 'hookemon.supplementary-finalized-return.v1', positionId: identity.positionId, cycleId: identity.cycleId, manifestId: identity.manifestId, ...finalized },
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
          return { signedTx: await PAYOUT_ACCOUNT.signTransaction(signingTransaction) };
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

test('mutateSupplementaryPayout drives a return-broadcast settlement through the real direct-payout engine to COMPLETE', async () => {
  const cycleId = 'cycle-supplementary-money-payout';
  const identity = settlementIdentity(cycleId);
  const sourceSettlement = payoutSettlement(cycleId, 'RETURN_BROADCAST');
  const durableBoundary = payoutReturnBoundary(identity);
  const records = new Map();
  const advances = [];
  const cycleRepository = {
    async readSupplementarySettlement(positionId) { assert.equal(positionId, identity.positionId); return sourceSettlement; },
    async readPagedPayoutState(id, stage) { return structuredClone(records.get(`${id} ${stage}`) ?? null); },
    async persistPagedPayoutState(id, stage, value) { records.set(`${id} ${stage}`, structuredClone(value)); },
    async readSupplementarySettlementEvidence(positionId) { assert.equal(positionId, identity.positionId); return structuredClone(durableBoundary); },
    async advanceSupplementarySettlement(positionId, input) { advances.push({ positionId, ...input }); return { ...sourceSettlement, state: input.nextState }; },
  };
  const client = payoutLifecycleRpc();
  const counter = { sign: 0 };

  let state = await mutateSupplementaryPayout({
    liveMode: true, adapters: { robinhood: { client } }, config: payoutLifecycleConfig(), signerClient: payoutLifecycleSigner(counter),
    cycleRepository, context: { positionId: identity.positionId, eligibilityManifest: payoutEligibilityManifest(cycleId), returnBoundary: durableBoundary },
  });
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_A).state, 'BROADCAST');

  client.finalize(state.recipients[0].txHash, {
    transactionHash: state.recipients[0].txHash, blockNumber: 100n, blockHash: `0x${'9'.repeat(64)}`, status: 'success',
    logs: [{ address: TOKEN, topics: [ERC20_TRANSFER_TOPIC, addressTopic(PAYOUT_OPERATIONS), addressTopic(state.recipients[0].recipient)], data: `0x${BigInt(state.recipients[0].amount.amountAtomic).toString(16).padStart(64, '0')}`, logIndex: '0' }],
  });
  client.setNonce('1');
  state = await mutateSupplementaryPayout({
    liveMode: true, adapters: { robinhood: { client } }, config: payoutLifecycleConfig(), signerClient: payoutLifecycleSigner(counter),
    cycleRepository, context: { positionId: identity.positionId, eligibilityManifest: payoutEligibilityManifest(cycleId), returnBoundary: durableBoundary },
  });
  assert.equal(state.recipients.find(entry => entry.recipient === RECIPIENT_B).state, 'BROADCAST');

  client.finalize(state.recipients[1].txHash, {
    transactionHash: state.recipients[1].txHash, blockNumber: 100n, blockHash: `0x${'9'.repeat(64)}`, status: 'success',
    logs: [{ address: TOKEN, topics: [ERC20_TRANSFER_TOPIC, addressTopic(PAYOUT_OPERATIONS), addressTopic(state.recipients[1].recipient)], data: `0x${BigInt(state.recipients[1].amount.amountAtomic).toString(16).padStart(64, '0')}`, logIndex: '0' }],
  });
  state = await mutateSupplementaryPayout({
    liveMode: true, adapters: { robinhood: { client } }, config: payoutLifecycleConfig(), signerClient: payoutLifecycleSigner(counter),
    cycleRepository, context: { positionId: identity.positionId, eligibilityManifest: payoutEligibilityManifest(cycleId), returnBoundary: durableBoundary },
  });

  assert.equal(isDirectPayoutComplete(state), true);
  assert.deepEqual(state.recipients.map(entry => entry.state), ['FINALIZED', 'FINALIZED']);
  assert.equal(advances.length, 2);
  assert.equal(advances[0].nextState, 'PAYOUT_BROADCAST');
  assert.equal(advances[1].nextState, 'COMPLETE');
});
