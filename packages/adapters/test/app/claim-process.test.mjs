import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { ERC20_TRANSFER_TOPIC } from '../../src/robinhood-rpc.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import {
  mutateClaimProcess,
  prepareClaimProcessRequest,
  reconcileLiveClaimProcess,
} from '../../src/app/stages/claim-process.mjs';

const HOOK = `0x${'1'.repeat(40)}`;
const OPERATIONS = `0x${'2'.repeat(40)}`;
const CYCLE_ID = 'cycle-claim-process-1';
const CLAIM_EVENT_ABI = parseAbi([
  'event ProcessClaimed(bytes32 indexed cycleId, uint256 amountAtomicUsdg, address indexed destination, uint256 timestamp, uint256 cap, uint256 usedAfter)',
]);
const TEST_PREFLIGHT_AUTHORITY = createTestProfileMutationAuthority();

function claimMoneyConfiguration({ gasPriceCap = '2', nativeReserve = '100' } = {}) {
  const usdg = { chainId: '4663', assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 };
  const solanaStablecoin = { chainId: '792703809', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
  return {
    schema: 'hookemon.money-configuration.v1',
    assets: { usdg, solanaStablecoin },
    minimums: {
      robinhoodReceive: { ...usdg, amountAtomic: '0' },
      solanaReceive: { ...solanaStablecoin, amountAtomic: '0' },
      returnUsdg: { ...usdg, amountAtomic: '0' },
    },
    evm: {
      perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: gasPriceCap },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: nativeReserve },
    },
    solana: {
      priorityFeeCap: { chainId: '792703809', assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '2' },
      lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '2' },
    },
  };
}

function claimConfig(account, overrides = {}) {
  return {
    chainId: 4663,
    contracts: { hook: HOOK, usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' },
    accounts: { evm: account },
    nativeGasCaps: { robinhood: '999999' },
    moneyConfiguration: claimMoneyConfiguration(),
    ...overrides,
  };
}

function repository({ custody = { heldAssets: false, unattributed: false, unresolvedObligations: false }, attempt = null } = {}) {
  return {
    async readStage() { return { status: 'COMPLETE', evidence: { finalizedBlock: '123' } }; },
    async readClaimPreconditions() { return custody; },
    async describeCycle() { return { releaseAmount: '25000000' }; },
    async readOperationalStageAttempt() { return attempt; },
  };
}

function chainRepository() {
  let chainAttempt = null;
  const custodyLedgers = new Map();
  const writes = [];
  return {
    get chainAttempt() { return chainAttempt; },
    set chainAttempt(value) { chainAttempt = value; },
    get custodyLedgers() { return new Map(custodyLedgers); },
    get writes() { return [...writes]; },
    async readStage() { return { status: 'COMPLETE', evidence: { finalizedBlock: '123' } }; },
    async readClaimPreconditions() { return { heldAssets: false, unattributed: false, unresolvedObligations: false }; },
    async describeCycle() {
      return {
        releaseAmount: '25000000',
        chainAttempts: new Map(chainAttempt ? [[`claim-process\u0000${chainAttempt.attempt.requestDigest}`, chainAttempt]] : []),
        custodyLedgers: new Map(custodyLedgers),
      };
    },
    async readChainTransactionAttempt(_cycleId, stage, requestDigest) {
      if (chainAttempt?.attempt?.stage !== stage || chainAttempt?.attempt?.requestDigest !== requestDigest) return null;
      return chainAttempt;
    },
    async prepareChainTransactionAttempt(_cycleId, _stage, attempt) {
      chainAttempt = { attempt, broadcastEvidence: null, finalityEvidence: null };
      return chainAttempt;
    },
    async recordSignedTransaction(_cycleId, _stage, _requestDigest, material) {
      chainAttempt = {
        ...chainAttempt,
        attempt: { ...chainAttempt.attempt, state: 'SIGNED', ...material },
      };
      return chainAttempt;
    },
    async recordBroadcast(_cycleId, _stage, _requestDigest, evidence) {
      chainAttempt = {
        ...chainAttempt,
        attempt: { ...chainAttempt.attempt, state: 'BROADCAST' },
        broadcastEvidence: evidence,
      };
      return chainAttempt;
    },
    async recordFinality(_cycleId, _stage, _requestDigest, evidence) {
      writes.push('finality');
      chainAttempt = {
        ...chainAttempt,
        attempt: { ...chainAttempt.attempt, state: 'FINALIZED' },
        finalityEvidence: evidence,
      };
      return chainAttempt;
    },
    async recordCustodyLedger(_cycleId, ledger) {
      writes.push('custody-ledger');
      custodyLedgers.set(`${ledger.chainId}\u0000${ledger.assetId}`, ledger);
    },
  };
}

test('mutateClaimProcess persists signed raw bytes and replays those exact bytes after a broadcast interruption', async () => {
  const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
  const cycleRepository = chainRepository();
  const walletReservations = [];
  let reservationEstablished = false;
  cycleRepository.reserveWalletNonce = async (cycleId, reservation) => {
    reservationEstablished = true;
    walletReservations.push(['reserve', cycleId, structuredClone(reservation)]);
  };
  cycleRepository.assertWalletNonce = async (cycleId, reservation) => {
    walletReservations.push(['assert', cycleId, structuredClone(reservation)]);
  };
  const config = claimConfig(account.address);
  const request = await prepareClaimProcessRequest({
    config,
    cycleRepository,
    context: { cycleId: CYCLE_ID },
  });
  let signCalls = 0;
  let broadcastCalls = 0;
  const context = {
    cycleId: CYCLE_ID,
    stage: 'claim-process',
    requestDigest: `sha256:${'c'.repeat(64)}`,
    fencingToken: 'claim-fence-1',
  };

  await assert.rejects(
    () => mutateClaimProcess({
      liveMode: true,
      adapters: {
        robinhood: {
          client: {
            async getChainId() { return 4663; },
            async getTransactionCount() {
              assert.equal(reservationEstablished, true);
              return 7n;
            },
            async estimateGas() { return 120000n; },
            async estimateFeesPerGas() { return { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }; },
            async getBalance() { return 1_000_000n; },
            async sendRawTransaction({ serializedTransaction }) {
              broadcastCalls += 1;
              assert.match(serializedTransaction, /^0x[0-9a-f]+$/i);
              throw new Error('temporary RPC failure');
            },
          },
        },
      },
      signerClient: {
        evm: {
          async sign({ transaction }) {
            signCalls += 1;
            const { from, ...unsigned } = transaction;
            return {
              signedTx: await account.signTransaction({
                ...unsigned,
                value: BigInt(unsigned.value),
                nonce: BigInt(unsigned.nonce),
                gas: BigInt(unsigned.gas),
                maxFeePerGas: BigInt(unsigned.maxFeePerGas),
                maxPriorityFeePerGas: BigInt(unsigned.maxPriorityFeePerGas),
              }),
            };
          },
        },
      },
      config,
      cycleRepository,
      context,
      request,
      preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
    }),
    /temporary RPC failure/,
  );
  assert.equal(signCalls, 1);
  assert.equal(broadcastCalls, 1);
  assert.deepEqual(walletReservations[0], ['reserve', CYCLE_ID, {
    chainId: '4663',
    wallet: account.address.toLowerCase(),
    stage: 'claim-process',
    fencingToken: context.fencingToken,
    leaseAcquiredAtMs: 0,
    leaseExpiresAtMs: Number.MAX_SAFE_INTEGER,
  }]);
  assert.equal(walletReservations.some(([kind]) => kind === 'assert'), true);
  assert.equal(cycleRepository.chainAttempt.attempt.state, 'SIGNED');
  const signed = cycleRepository.chainAttempt.attempt.rawBytes;

  let invalidBroadcastCalls = 0;
  await assert.rejects(
    () => mutateClaimProcess({
      liveMode: true,
      adapters: {
        robinhood: {
          client: {
            async sendRawTransaction() {
              invalidBroadcastCalls += 1;
              throw new Error('broadcast must not be reached');
            },
          },
        },
      },
      signerClient: { evm: { async sign() { throw new Error('a signed claim must not be signed again'); } } },
      config,
      cycleRepository,
      context,
      request,
      preflightAuthority: {},
    }),
    /claim-process fixture authority is invalid/,
  );
  assert.equal(invalidBroadcastCalls, 0);
  assert.equal(cycleRepository.chainAttempt.attempt.state, 'SIGNED');

  const result = await mutateClaimProcess({
    liveMode: true,
    adapters: {
      robinhood: {
        client: {
          async getChainId() { throw new Error('a signed claim must not refresh the nonce or fees'); },
          async sendRawTransaction({ serializedTransaction }) {
            broadcastCalls += 1;
            assert.equal(serializedTransaction, signed);
            return keccak256(serializedTransaction);
          },
        },
      },
    },
    signerClient: { evm: { async sign() { signCalls += 1; throw new Error('a recorded signature must not be replaced'); } } },
    config,
    cycleRepository,
    context,
    request,
    preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
  });
  assert.equal(signCalls, 1);
  assert.equal(broadcastCalls, 2);
  assert.equal(cycleRepository.chainAttempt.attempt.state, 'BROADCAST');
  assert.equal(result.transactionHash, keccak256(signed));
});

test('mutateClaimProcess refuses a quoted EVM gas price above MoneyConfiguration before signing', async () => {
  const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
  const cycleRepository = chainRepository();
  const config = claimConfig(account.address);
  const request = await prepareClaimProcessRequest({ config, cycleRepository, context: { cycleId: CYCLE_ID } });
  let signCalls = 0;

  await assert.rejects(
    () => mutateClaimProcess({
      liveMode: true,
      adapters: {
        robinhood: {
          client: {
            async getChainId() { return 4663; },
            async getTransactionCount() { return 7n; },
            async estimateGas() { return 100n; },
            async estimateFeesPerGas() { return { maxFeePerGas: 3n, maxPriorityFeePerGas: 2n }; },
            async getBalance() { return 1_000_000n; },
            async sendRawTransaction() { throw new Error('broadcast must not be reached'); },
          },
        },
      },
      signerClient: { evm: { async sign() { signCalls += 1; throw new Error('signer must not be reached'); } } },
      config,
      cycleRepository,
      context: { cycleId: CYCLE_ID, stage: 'claim-process', requestDigest: `sha256:${'1'.repeat(64)}` },
      request,
      preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
    }),
    /gas price exceeds the configured MoneyConfigurationV1 cap/,
  );
  assert.equal(signCalls, 0);
});

test('mutateClaimProcess preserves the configured native reserve after the maximum quoted fee', async () => {
  const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
  const cycleRepository = chainRepository();
  const config = claimConfig(account.address);
  const request = await prepareClaimProcessRequest({ config, cycleRepository, context: { cycleId: CYCLE_ID } });
  let signCalls = 0;

  await assert.rejects(
    () => mutateClaimProcess({
      liveMode: true,
      adapters: {
        robinhood: {
          client: {
            async getChainId() { return 4663; },
            async getTransactionCount() { return 7n; },
            async estimateGas() { return 100n; },
            async estimateFeesPerGas() { return { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }; },
            async getBalance() { return 299n; },
            async sendRawTransaction() { throw new Error('broadcast must not be reached'); },
          },
        },
      },
      signerClient: { evm: { async sign() { signCalls += 1; throw new Error('signer must not be reached'); } } },
      config,
      cycleRepository,
      context: { cycleId: CYCLE_ID, stage: 'claim-process', requestDigest: `sha256:${'2'.repeat(64)}` },
      request,
      preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
    }),
    /native balance does not retain the configured reserve after quoted gas/,
  );
  assert.equal(signCalls, 0);
});

test('mutateClaimProcess refuses an invalid mutation authority before signing', async () => {
  const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
  const cycleRepository = chainRepository();
  const config = claimConfig(account.address);
  const request = await prepareClaimProcessRequest({ config, cycleRepository, context: { cycleId: CYCLE_ID } });
  let signCalls = 0;
  await assert.rejects(
    () => mutateClaimProcess({
      liveMode: true,
      adapters: {
        robinhood: {
          client: {
            async getChainId() { return 4663; },
            async getTransactionCount() { return 7n; },
            async estimateGas() { return 120000n; },
            async estimateFeesPerGas() { return { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }; },
            async getBalance() { return 1_000_000n; },
            async sendRawTransaction() { throw new Error('broadcast must not be reached'); },
          },
        },
      },
      signerClient: {
        evm: {
          async sign() {
            signCalls += 1;
            throw new Error('signer must not be reached');
          },
        },
      },
      config,
      cycleRepository,
      context: { cycleId: CYCLE_ID, stage: 'claim-process', requestDigest: `sha256:${'d'.repeat(64)}` },
      request,
      preflightAuthority: {},
    }),
    /claim-process fixture authority is invalid/,
  );
  assert.equal(signCalls, 0);
  assert.equal(cycleRepository.chainAttempt.attempt.state, 'PREPARED');
});

test('mutateClaimProcess refuses an unresolved claim attempt with a different request digest', async () => {
  const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
  const cycleRepository = chainRepository();
  const config = claimConfig(account.address);
  const request = await prepareClaimProcessRequest({ config, cycleRepository, context: { cycleId: CYCLE_ID } });
  const existingRequestDigest = `sha256:${'a'.repeat(64)}`;
  cycleRepository.chainAttempt = {
    attempt: {
      schema: 'hookemon.chain-transaction-attempt.v1',
      cycleId: CYCLE_ID,
      stage: 'claim-process',
      state: 'PREPARED',
      requestDigest: existingRequestDigest,
      rawBytes: null,
      nonce: null,
      blockhash: null,
      hash: null,
    },
    broadcastEvidence: null,
    finalityEvidence: null,
  };
  let signCalls = 0;

  await assert.rejects(
    () => mutateClaimProcess({
      liveMode: true,
      adapters: {
        robinhood: {
          client: {
            async getChainId() { return 4663; },
            async getTransactionCount() { return 7n; },
            async estimateGas() { return 120000n; },
            async estimateFeesPerGas() { return { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }; },
            async sendRawTransaction() { throw new Error('broadcast must not be reached'); },
          },
        },
      },
      signerClient: { evm: { async sign() { signCalls += 1; throw new Error('signer must not be reached'); } } },
      config,
      cycleRepository,
      context: { cycleId: CYCLE_ID, stage: 'claim-process', requestDigest: `sha256:${'e'.repeat(64)}` },
      request,
      preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
    }),
    /different request digest/,
  );
  assert.equal(signCalls, 0);
  assert.equal(cycleRepository.chainAttempt.attempt.requestDigest, existingRequestDigest);
  assert.equal(cycleRepository.chainAttempt.attempt.state, 'PREPARED');
});

test('reconcileLiveClaimProcess leaves a prepared claim attempt retryable after a pre-signing failure', async () => {
  const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
  const cycleRepository = chainRepository();
  const config = claimConfig(account.address);
  const request = await prepareClaimProcessRequest({ config, cycleRepository, context: { cycleId: CYCLE_ID } });
  const requestDigest = `sha256:${'f'.repeat(64)}`;
  cycleRepository.chainAttempt = {
    attempt: {
      schema: 'hookemon.chain-transaction-attempt.v1',
      cycleId: CYCLE_ID,
      stage: 'claim-process',
      state: 'PREPARED',
      requestDigest,
      rawBytes: null,
      nonce: null,
      blockhash: null,
      hash: null,
    },
    broadcastEvidence: null,
    finalityEvidence: null,
  };

  const reconciliation = await reconcileLiveClaimProcess({
    adapters: { robinhood: { client: {} } },
    config,
    cycleRepository,
    context: { cycleId: CYCLE_ID, stage: 'claim-process' },
  });
  assert.equal(reconciliation, null);
  assert.equal(cycleRepository.chainAttempt.attempt.state, 'PREPARED');

  let signCalls = 0;
  const result = await mutateClaimProcess({
    liveMode: true,
    adapters: {
      robinhood: {
        client: {
          async getChainId() { return 4663; },
          async getTransactionCount() { return 7n; },
          async estimateGas() { return 120000n; },
          async estimateFeesPerGas() { return { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }; },
          async getBalance() { return 1_000_000n; },
          async sendRawTransaction({ serializedTransaction }) { return keccak256(serializedTransaction); },
        },
      },
    },
    signerClient: {
      evm: {
        async sign({ transaction }) {
          signCalls += 1;
          const { from, ...unsigned } = transaction;
          return {
            signedTx: await account.signTransaction({
              ...unsigned,
              value: BigInt(unsigned.value),
              nonce: BigInt(unsigned.nonce),
              gas: BigInt(unsigned.gas),
              maxFeePerGas: BigInt(unsigned.maxFeePerGas),
              maxPriorityFeePerGas: BigInt(unsigned.maxPriorityFeePerGas),
            }),
          };
        },
      },
    },
    config,
    cycleRepository,
    context: { cycleId: CYCLE_ID, stage: 'claim-process', requestDigest },
    request,
    preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
  });
  assert.equal(signCalls, 1);
  assert.equal(cycleRepository.chainAttempt.attempt.state, 'BROADCAST');
  assert.equal(result.transactionHash, cycleRepository.chainAttempt.attempt.hash);
});

test('prepareClaimProcessRequest binds the snapshot-cleared cycle amount to Operations-self claim calldata', async () => {
  const request = await prepareClaimProcessRequest({
    config: claimConfig(OPERATIONS),
    cycleRepository: repository(),
    context: { cycleId: CYCLE_ID },
  });
  assert.equal(request.schema, 'hookemon.claim-process-request.v1');
  assert.equal(request.cycleId, CYCLE_ID);
  assert.equal(request.destination, OPERATIONS);
  assert.deepEqual(request.amount, {
    chainId: '4663',
    assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    decimals: 6,
    amountAtomic: '25000000',
  });
  assert.equal(request.call.functionName, 'claimProcess');
  assert.equal(request.call.args[1], 25000000n);
  assert.equal(request.call.args[2], OPERATIONS);
});

test('prepareClaimProcessRequest refuses before calldata construction when custody has an unresolved attribution', async () => {
  await assert.rejects(
    () => prepareClaimProcessRequest({
      config: claimConfig(OPERATIONS),
      cycleRepository: repository({ custody: { heldAssets: false, unattributed: true, unresolvedObligations: false } }),
      context: { cycleId: CYCLE_ID },
    }),
    /unresolved assets or obligations/,
  );
});

function addressTopic(address) {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

async function broadcastClaimFixture() {
  const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
  const cycleRepository = chainRepository();
  const config = claimConfig(account.address);
  const request = await prepareClaimProcessRequest({ config, cycleRepository, context: { cycleId: CYCLE_ID } });
  const transaction = {
    type: 'eip1559',
    to: request.call.to,
    data: request.call.data,
    value: '0',
    from: account.address,
    chainId: 4663,
    nonce: '7',
    gas: '120000',
    maxFeePerGas: '2',
    maxPriorityFeePerGas: '1',
  };
  const rawBytes = await account.signTransaction({
    ...transaction,
    value: 0n,
    nonce: 7,
    gas: 120000n,
    maxFeePerGas: 2n,
    maxPriorityFeePerGas: 1n,
  });
  const transactionHash = keccak256(rawBytes);
  cycleRepository.chainAttempt = {
    attempt: {
      schema: 'hookemon.chain-transaction-attempt.v1',
      cycleId: CYCLE_ID,
      stage: 'claim-process',
      state: 'BROADCAST',
      requestDigest: `sha256:${'c'.repeat(64)}`,
      rawBytes,
      nonce: '7',
      blockhash: null,
      hash: transactionHash,
    },
    broadcastEvidence: { transactionHash },
    finalityEvidence: null,
  };
  return { account, config, cycleRepository, request, transactionHash };
}

test('reconcileLiveClaimProcess records an observed signed claim after its broadcast response is lost', async () => {
  const { account, config, cycleRepository, request, transactionHash } = await broadcastClaimFixture();
  cycleRepository.chainAttempt = {
    ...cycleRepository.chainAttempt,
    attempt: { ...cycleRepository.chainAttempt.attempt, state: 'SIGNED' },
    broadcastEvidence: null,
  };
  let rawBroadcastCalls = 0;
  let signCalls = 0;
  const client = {
    async getTransaction() {
      return {
        hash: transactionHash,
        from: account.address,
        to: HOOK,
        input: request.call.data,
        value: 0n,
      };
    },
    async getTransactionReceipt() {
      throw new Error('the accepted transaction has not produced a receipt yet');
    },
    async sendRawTransaction() {
      rawBroadcastCalls += 1;
      throw new Error('a visible signed claim must not be broadcast again');
    },
  };

  const reconciliation = await reconcileLiveClaimProcess({
    adapters: { robinhood: { client } },
    config,
    cycleRepository,
    context: { cycleId: CYCLE_ID, stage: 'claim-process' },
  });
  assert.equal(reconciliation, null);
  assert.equal(cycleRepository.chainAttempt.attempt.state, 'BROADCAST');
  assert.deepEqual(cycleRepository.chainAttempt.broadcastEvidence, { transactionHash });

  const result = await mutateClaimProcess({
    liveMode: true,
    adapters: { robinhood: { client } },
    signerClient: { evm: { async sign() { signCalls += 1; throw new Error('a visible signed claim must not be signed again'); } } },
    config,
    cycleRepository,
    context: { cycleId: CYCLE_ID, stage: 'claim-process', requestDigest: `sha256:${'c'.repeat(64)}` },
    request,
    preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
  });
  assert.equal(result.transactionHash, transactionHash);
  assert.equal(rawBroadcastCalls, 0);
  assert.equal(signCalls, 0);
});

test('reconcileLiveClaimProcess finalizes only the canonical claim call, event, and exact hook credit', async () => {
  const { account, config, cycleRepository, request, transactionHash } = await broadcastClaimFixture();
  const walletReleases = [];
  cycleRepository.releaseWalletNonce = async (cycleId, reservation) => {
    walletReleases.push({ cycleId, reservation: structuredClone(reservation) });
  };
  const blockHash = `0x${'b'.repeat(64)}`;
  const processClaimed = {
    address: HOOK,
    topics: encodeEventTopics({
      abi: CLAIM_EVENT_ABI,
      eventName: 'ProcessClaimed',
      args: { cycleId: request.onchainCycleId, destination: account.address },
    }),
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [25000000n, 123n, 30000000n, 25000000n],
    ),
    logIndex: 0n,
  };
  const transfer = {
    address: config.contracts.usdg,
    topics: [ERC20_TRANSFER_TOPIC, addressTopic(HOOK), addressTopic(account.address)],
    data: `0x${(25000000n).toString(16).padStart(64, '0')}`,
    logIndex: 1n,
  };
  const receipt = {
    transactionHash,
    blockNumber: 100n,
    blockHash,
    status: 'success',
    logs: [processClaimed, transfer],
  };
  const client = {
    async getTransactionReceipt() { return receipt; },
    async getTransaction() {
      return {
        hash: transactionHash,
        from: account.address,
        to: HOOK,
        input: request.call.data,
        value: 0n,
      };
    },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag === 'finalized' || blockNumber === 100n) return { number: 100n, hash: blockHash, timestamp: 1n };
      throw new Error('unexpected block request');
    },
  };

  const result = await reconcileLiveClaimProcess({
    adapters: { robinhood: { client } },
    config,
    cycleRepository,
    context: { cycleId: CYCLE_ID, stage: 'claim-process', fencingToken: 'claim-finality-fence-1' },
  });
  assert.equal(result.transactionHash, transactionHash);
  assert.equal(result.finalized, true);
  assert.equal(result.finalizedBlockHash, blockHash);
  assert.equal(cycleRepository.chainAttempt.attempt.state, 'FINALIZED');
  assert.equal(cycleRepository.chainAttempt.finalityEvidence.claimedAmountAtomic, '25000000');
  assert.deepEqual(walletReleases, [{
    cycleId: CYCLE_ID,
    reservation: {
      chainId: '4663',
      wallet: account.address.toLowerCase(),
      stage: 'claim-process',
      fencingToken: 'claim-finality-fence-1',
      leaseAcquiredAtMs: 0,
      leaseExpiresAtMs: Number.MAX_SAFE_INTEGER,
    },
  }]);
  assert.deepEqual(cycleRepository.writes.slice(-2), ['custody-ledger', 'finality']);
  assert.deepEqual([...cycleRepository.custodyLedgers.values()], [{
    schema: 'hookemon.custody-ledger.v1',
    cycleId: CYCLE_ID,
    chainId: 'eip155:4663',
    assetId: `eip155:4663/erc20:${config.contracts.usdg}`,
    decimals: 6,
    claimed: '25000000',
    bridgeOut: '0',
    bridgeIn: '0',
    packCost: '0',
    buybackProceeds: '0',
    returnInput: '0',
    returnReceived: '0',
    refunds: '0',
    residual: '0',
    heldAssets: '0',
    payoutLiability: '0',
    dust: '0',
    unattributed: '0',
  }]);
});

test('reconcileLiveClaimProcess backfills the claimed custody ledger for an already finalized claim', async () => {
  const { config, cycleRepository, transactionHash } = await broadcastClaimFixture();
  cycleRepository.chainAttempt = {
    ...cycleRepository.chainAttempt,
    attempt: { ...cycleRepository.chainAttempt.attempt, state: 'FINALIZED' },
    finalityEvidence: { transactionHash, finalized: true },
  };

  const evidence = await reconcileLiveClaimProcess({
    adapters: { robinhood: {} },
    config,
    cycleRepository,
    context: { cycleId: CYCLE_ID, stage: 'claim-process' },
  });
  assert.equal(evidence.transactionHash, transactionHash);
  assert.equal(cycleRepository.custodyLedgers.size, 1);
  assert.equal([...cycleRepository.custodyLedgers.values()][0].claimed, '25000000');
});

test('reconcileLiveClaimProcess refuses a finalized receipt whose transaction input is not the canonical claim call', async () => {
  const { account, config, cycleRepository, request, transactionHash } = await broadcastClaimFixture();
  const blockHash = `0x${'b'.repeat(64)}`;
  const client = {
    async getTransactionReceipt() {
      return { transactionHash, blockNumber: 100n, blockHash, status: 'success', logs: [] };
    },
    async getTransaction() {
      return { hash: transactionHash, from: account.address, to: HOOK, input: '0x', value: 0n };
    },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag === 'finalized' || blockNumber === 100n) return { number: 100n, hash: blockHash, timestamp: 1n };
      throw new Error('unexpected block request');
    },
  };
  await assert.rejects(
    () => reconcileLiveClaimProcess({
      adapters: { robinhood: { client } },
      config,
      cycleRepository,
      context: { cycleId: CYCLE_ID, stage: 'claim-process' },
    }),
    /canonical claim intent/,
  );
  assert.equal(cycleRepository.chainAttempt.attempt.state, 'BROADCAST');
  assert.notEqual(request.call.data, '0x');
});
