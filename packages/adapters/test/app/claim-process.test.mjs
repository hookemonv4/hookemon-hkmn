import assert from 'node:assert/strict';
import { nativeProducedAdmissionFixture } from '../native/admission-fixture.mjs';
import { createTestNativePaymentBinding } from '../../src/native-payment-proof.mjs';
import test from 'node:test';
import { encodeAbiParameters, encodeEventTopics, keccak256, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { assertCustodyLedger, CUSTODY_LEDGER_BUCKETS } from '../../../runner/src/cycle/money-schemas.mjs';
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
  'event ProcessClaimed(bytes32 indexed cycleId, uint256 amountWei, address indexed destination, uint256 timestamp, uint256 capWei, uint256 usedAfterWei)',
]);
const TEST_PREFLIGHT_AUTHORITY = createTestProfileMutationAuthority();

function claimMoneyConfiguration({ gasPriceCap = '2', nativeReserve = '100', ethChainId = '4663' } = {}) {
  const eth = { chainId: ethChainId, assetId: 'native', decimals: 18 };
  const solanaStablecoin = { chainId: '792703809', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
  return {
    schema: 'hookemon.money-configuration.v2',
    assets: { eth, solanaStablecoin },
    minimums: {
      robinhoodReceive: { ...eth, amountAtomic: '0' },
      solanaReceive: { ...solanaStablecoin, amountAtomic: '0' },
      returnEth: { ...eth, amountAtomic: '0' },
    },
    evm: {
      perTransactionGasPriceCap: { chainId: ethChainId, assetId: 'native', decimals: 18, amountAtomic: gasPriceCap },
      nativeReserve: { chainId: ethChainId, assetId: 'native', decimals: 18, amountAtomic: nativeReserve },
    },
    solana: {
      priorityFeeCap: { chainId: '792703809', assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '2' },
      lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '2' },
    },
  };
}

// Isolated hook process-liability evidence: the pre-sign veto re-reads the hook's own ledger at a
// canonical finalized block, so a fixture that omits it is refused rather than silently signed.
function hookProcessStateFixture({ amount = 10n ** 12n, operations, ...overrides } = {}) {
  const blockHash = `0x${'1'.repeat(64)}`;
  return {
    finalizedBlock: { number: 10n, hash: blockHash, timestamp: 1n },
    evidenceClient: {
      async readHookProcessStateAtBlock() {
        return {
          processLiability: amount,
          remainingProcessClaimCapacity: amount,
          processClaimsPaused: false,
          processClaimCycleUsed: false,
          activeProcessClaimLimit: 4n,
          totalLiability: amount,
          hookNativeBalance: amount,
          isSolvent: true,
          operations: String(operations).toLowerCase(),
          blockNumber: 10n,
          blockHash,
          ...overrides,
        };
      },
    },
  };
}

// The native balance observer reads a distinct archive client at the finalized height/hash.
function evmArchiveBalanceClient({ balanceAtomic = 5_000_000n, respond = null, onRead = null } = {}) {
  return {
    async readNativeBalanceAtBlock(request) {
      if (onRead) onRead(request);
      if (respond) return respond(request);
      return { value: balanceAtomic, blockNumber: request.blockNumber, blockHash: request.blockHash };
    },
  };
}

// The veto compares the hook's Operations role against the configured account, which differs per
// test (several derive one from a signing key). Recording the account each config was built with
// lets the isolated evidence fixture answer for that same account without weakening the check.
let lastConfiguredOperations = OPERATIONS;
const OPERATIONS_FOR_VETO = () => lastConfiguredOperations;

function claimConfig(account, overrides = {}) {
  lastConfiguredOperations = account;
  return {
    chainId: 4663,
    contracts: { hook: HOOK },
    nativePaymentBinding: createTestNativePaymentBinding({ schema: 'hookemon.native-payment-binding.v1', chainId: '4663', hook: { address: HOOK, runtimeHash: keccak256('0x6000') } }, TEST_PREFLIGHT_AUTHORITY),
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
    async describeCycle() { return { releaseAmount: '25000000', admission: await nativeProducedAdmissionFixture(CYCLE_ID, { amountWei: '25000000' }) }; },
    async readOperationalStageAttempt() { return attempt; },
  };
}

// Replicates, for this test double only, the subset of `CycleRepository#recordCustodyLedger`'s
// `assertState` transition rules ADR-0026 fixes (cycle-repository.mjs's own tests cover the real
// repository): no v3 downgrade, no erasing a previously-recorded non-null
// `verifiedCurrentBalance`, and a repeat write must either be an exact idempotent replay or carry a
// strictly greater finality height. This lets the focused tests below tell a genuinely idempotent
// restart apart from one that would silently fabricate or lose evidence.
function assertCustodyLedgerRepositoryTransition(previous, next) {
  if (!previous) return;
  if (previous.schema === 'hookemon.custody-ledger.v3' && next.schema !== 'hookemon.custody-ledger.v3') {
    throw new Error('test double refuses a custody ledger v3 downgrade');
  }
  const previousBalance = previous.schema === 'hookemon.custody-ledger.v3' ? previous.verifiedCurrentBalance : null;
  const nextBalance = next.schema === 'hookemon.custody-ledger.v3' ? next.verifiedCurrentBalance : null;
  if (previousBalance !== null && nextBalance === null) {
    throw new Error('test double refuses erasing a previously recorded verifiedCurrentBalance');
  }
  if (previousBalance === null || nextBalance === null) return;
  if (JSON.stringify(nextBalance) === JSON.stringify(previousBalance)) return;
  const previousHeight = BigInt(previousBalance.finality.height);
  const nextHeight = BigInt(nextBalance.finality.height);
  if (nextHeight < previousHeight) throw new Error('test double refuses a stale verifiedCurrentBalance height');
  if (nextHeight === previousHeight) throw new Error('test double refuses conflicting evidence at the same finality height');
}

function chainRepository() {
  let chainAttempt = null;
  const custodyLedgers = new Map();
  const writes = [];
  const repo = {
    async reserveProcessClaimUsd() {},
    async finalizeProcessClaimUsd() {},
    get chainAttempt() { return chainAttempt; },
    set chainAttempt(value) { chainAttempt = value; },
    get custodyLedgers() { return new Map(custodyLedgers); },
    get writes() { return [...writes]; },
    async readStage() { return { status: 'COMPLETE', evidence: { finalizedBlock: '123' } }; },
    async readClaimPreconditions() { return { heldAssets: false, unattributed: false, unresolvedObligations: false }; },
    async describeCycle() {
      return {
        releaseAmount: '25000000', admission: await nativeProducedAdmissionFixture(CYCLE_ID, { amountWei: '25000000' }),
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
    async recordCustodyLedgerRaw(_cycleId, ledger) {
      writes.push('custody-ledger');
      custodyLedgers.set(`${ledger.chainId}\u0000${ledger.assetId}`, ledger);
    },
  };
  repo.recordCustodyLedger = async (cycleId, ledgerValue) => {
    const ledger = assertCustodyLedger(ledgerValue);
    const previous = [...repo.custodyLedgers.values()]
      .find(row => row.chainId === ledger.chainId && row.assetId === ledger.assetId) ?? null;
    assertCustodyLedgerRepositoryTransition(previous, ledger);
    return repo.recordCustodyLedgerRaw(cycleId, ledger);
  };
  return repo;
}

test('mutateClaimProcess persists signed raw bytes and replays those exact bytes after a broadcast interruption', async () => {
  const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
  const cycleRepository = chainRepository();
  const usdReservations = [];
  cycleRepository.reserveProcessClaimUsd = async (cycleId, value) => { usdReservations.push({ cycleId, ...value }); };
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
          historicalEvidenceClient: hookProcessStateFixture({ operations: OPERATIONS_FOR_VETO() }).evidenceClient,
          client: {
            async getBlock() { return { number: 10n, hash: `0x${'1'.repeat(64)}`, timestamp: 1n }; },
            async getChainId() { return 4663; },
            async getTransactionCount() {
              assert.equal(reservationEstablished, true);
              return 7n;
            },
            async estimateGas() { return 120000n; },
            async estimateFeesPerGas() { return { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }; },
            async getBalance() { return 1_000_000n; },
            async sendRawTransaction({ serializedTransaction }) {
              assert.equal(usdReservations.length, 2, 'USD guard must run again before broadcast');
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
            assert.equal(usdReservations.length, 1, 'USD must be reserved before signing');
            assert.equal(usdReservations[0].limitMicroUsd, '25000000000');
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
          historicalEvidenceClient: hookProcessStateFixture({ operations: OPERATIONS_FOR_VETO() }).evidenceClient,
          client: {
            async getBlock() { return { number: 10n, hash: `0x${'1'.repeat(64)}`, timestamp: 1n }; },
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
        historicalEvidenceClient: hookProcessStateFixture({ operations: OPERATIONS_FOR_VETO() }).evidenceClient,
        client: {
          async getBlock() { return { number: 10n, hash: `0x${'1'.repeat(64)}`, timestamp: 1n }; },
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
          historicalEvidenceClient: hookProcessStateFixture({ operations: OPERATIONS_FOR_VETO() }).evidenceClient,
          client: {
            async getBlock() { return { number: 10n, hash: `0x${'1'.repeat(64)}`, timestamp: 1n }; },
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
    /gas price exceeds the configured MoneyConfigurationV2 cap/,
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
          historicalEvidenceClient: hookProcessStateFixture({ operations: OPERATIONS_FOR_VETO() }).evidenceClient,
          client: {
            async getBlock() { return { number: 10n, hash: `0x${'1'.repeat(64)}`, timestamp: 1n }; },
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
          historicalEvidenceClient: hookProcessStateFixture({ operations: OPERATIONS_FOR_VETO() }).evidenceClient,
          client: {
            async getBlock() { return { number: 10n, hash: `0x${'1'.repeat(64)}`, timestamp: 1n }; },
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
          historicalEvidenceClient: hookProcessStateFixture({ operations: OPERATIONS_FOR_VETO() }).evidenceClient,
          client: {
            async getBlock() { return { number: 10n, hash: `0x${'1'.repeat(64)}`, timestamp: 1n }; },
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
        historicalEvidenceClient: hookProcessStateFixture({ operations: OPERATIONS_FOR_VETO() }).evidenceClient,
        client: {
          async getBlock() { return { number: 10n, hash: `0x${'1'.repeat(64)}`, timestamp: 1n }; },
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
  assert.equal(request.schema, 'hookemon.claim-process-request.v2');
  assert.equal(request.cycleId, CYCLE_ID);
  assert.equal(request.destination, OPERATIONS);
  assert.deepEqual(request.amount, {
    chainId: '4663',
    assetId: 'native',
    decimals: 18,
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

async function broadcastClaimFixture({ chainId = 4663, configOverrides = {} } = {}) {
  const account = privateKeyToAccount(`0x${'1'.repeat(64)}`);
  const cycleRepository = chainRepository();
  const config = claimConfig(account.address, {
    chainId,
    moneyConfiguration: claimMoneyConfiguration({ ethChainId: String(chainId) }),
    ...configOverrides,
  });
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

// Native claim evidence rereads the persisted signed transaction, exact post-payment hook
// event and runtime at a finalized checkpoint. Custody observation follows that independent proof.
// A later archive-triggered reorg must refuse the custody write and finality advancement.
function finalizedClaimReceiptClient({
  account,
  config,
  request,
  transactionHash,
  blockHash = `0x${'b'.repeat(64)}`,
  amountAtomic = '25000000',
  driftAfterArchiveRead = null,
}) {
  const processClaimed = {
    address: config.contracts.hook,
    topics: encodeEventTopics({
      abi: CLAIM_EVENT_ABI,
      eventName: 'ProcessClaimed',
      args: { cycleId: request.onchainCycleId, destination: account.address },
    }),
    data: encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
      [BigInt(amountAtomic), 123n, 30000000n, BigInt(amountAtomic)],
    ),
    logIndex: 0, transactionHash, blockNumber: 100n, blockHash,
  };
  const receipt = {
    transactionHash,
    blockNumber: 100n,
    blockHash,
    status: 'success',
    logs: [processClaimed], gasUsed: 100000n, effectiveGasPrice: 2n,
  };
  return {
    blockHash,
    async getChainId() { return 4663; },
    async getCode() { return '0x6000'; },
    async getTransactionReceipt() { return receipt; },
    async getTransaction() {
      return { hash: transactionHash, from: account.address, to: config.contracts.hook, input: request.call.data, value: 0n, nonce: 7, blockNumber: 100n, blockHash };
    },
    async getBlock({ blockTag, blockNumber } = {}) {
      if (blockTag === 'finalized') return { number: 100n, hash: blockHash, timestamp: 1n };
      if (blockNumber === 100n) {
        const hash = driftAfterArchiveRead?.triggered ? driftAfterArchiveRead.hash : blockHash;
        return { number: 100n, hash, timestamp: 1n };
      }
      throw new Error('unexpected block request');
    },
  };
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
  const client = finalizedClaimReceiptClient({ account, config, request, transactionHash, blockHash });

  const result = await reconcileLiveClaimProcess({
    adapters: { robinhood: { client, historicalEvidenceClient: evmArchiveBalanceClient() } },
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
    schema: 'hookemon.custody-ledger.v3',
    cycleId: CYCLE_ID,
    chainId: '4663',
    assetId: 'native',
    decimals: 18,
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
    heldPositions: '0',
    payoutLiability: '0',
    dust: '0',
    unattributed: '0',
    verifiedCurrentBalance: {
      schema: 'hookemon.custody-balance-observation.v1',
      account: account.address.toLowerCase(),
      balance: {
        chainId: '4663',
        assetId: 'native',
        decimals: 18,
        amountAtomic: '5000000',
      },
      finality: {
        height: '100',
        hash: blockHash,
        timestampUnixSeconds: '1',
      },
    },
    expectedCycleAsset: null,
    gasReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '100' },
    gasSpent: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '200000' },
    gasPayments: [{ transactionHash, amountWei: '200000' }],
  }]);
});

test('reconcileLiveClaimProcess backfills the claimed custody ledger for an already finalized claim', async () => {
  const { account, config, cycleRepository, request, transactionHash } = await broadcastClaimFixture();
  cycleRepository.chainAttempt = {
    ...cycleRepository.chainAttempt,
    attempt: { ...cycleRepository.chainAttempt.attempt, state: 'FINALIZED' },
    finalityEvidence: { transactionHash, finalized: true },
  };

  const evidence = await reconcileLiveClaimProcess({
    adapters: {
      robinhood: {
        client: finalizedClaimReceiptClient({ account, config, request, transactionHash }),
        historicalEvidenceClient: evmArchiveBalanceClient(),
      },
    },
    config,
    cycleRepository,
    context: { cycleId: CYCLE_ID, stage: 'claim-process' },
  });
  assert.equal(evidence.transactionHash, transactionHash);
  assert.equal(cycleRepository.custodyLedgers.size, 1);
  const ledger = [...cycleRepository.custodyLedgers.values()][0];
  assert.equal(ledger.schema, 'hookemon.custody-ledger.v3');
  assert.equal(ledger.claimed, '25000000');
  assert.equal(ledger.verifiedCurrentBalance.balance.amountAtomic, '5000000');
  assert.equal(ledger.expectedCycleAsset, null);
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

test('reconcileLiveClaimProcess preserves every existing native custody bucket when finalizing the claim', async () => {
  const { account, config, cycleRepository, request, transactionHash } = await broadcastClaimFixture();
  const preexisting = Object.fromEntries(CUSTODY_LEDGER_BUCKETS.map(bucket => [bucket, bucket === 'dust' ? '777' : '0']));
  await cycleRepository.recordCustodyLedger(CYCLE_ID, {
    schema: 'hookemon.custody-ledger.v3',
    cycleId: CYCLE_ID,
    chainId: '4663',
    assetId: 'native',
    decimals: 18,
    ...preexisting,
    gasReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '100' },
    gasSpent: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '0' }, gasPayments: [],
    verifiedCurrentBalance: null, expectedCycleAsset: null,
  });

  const client = finalizedClaimReceiptClient({ account, config, request, transactionHash });
  const result = await reconcileLiveClaimProcess({
    adapters: { robinhood: { client, historicalEvidenceClient: evmArchiveBalanceClient() } },
    config,
    cycleRepository,
    context: { cycleId: CYCLE_ID, stage: 'claim-process' },
  });
  assert.equal(result.transactionHash, transactionHash);
  assert.equal(cycleRepository.custodyLedgers.size, 1);
  const ledger = [...cycleRepository.custodyLedgers.values()][0];
  assert.equal(ledger.schema, 'hookemon.custody-ledger.v3');
  assert.equal(ledger.claimed, '25000000');
  assert.equal(ledger.dust, '777');
  assert.equal(ledger.verifiedCurrentBalance.balance.amountAtomic, '5000000');
  assert.equal(ledger.expectedCycleAsset, null);
});

test('reconcileLiveClaimProcess replays an already-finalized claim custody observation idempotently across restarts', async () => {
  const { account, config, cycleRepository, request, transactionHash } = await broadcastClaimFixture();
  cycleRepository.chainAttempt = {
    ...cycleRepository.chainAttempt,
    attempt: { ...cycleRepository.chainAttempt.attempt, state: 'FINALIZED' },
    finalityEvidence: { transactionHash, finalized: true },
  };
  const adapters = {
    robinhood: {
      client: finalizedClaimReceiptClient({ account, config, request, transactionHash }),
      historicalEvidenceClient: evmArchiveBalanceClient(),
    },
  };

  const first = await reconcileLiveClaimProcess({
    adapters,
    config,
    cycleRepository,
    context: { cycleId: CYCLE_ID, stage: 'claim-process' },
  });
  const second = await reconcileLiveClaimProcess({
    adapters,
    config,
    cycleRepository,
    context: { cycleId: CYCLE_ID, stage: 'claim-process' },
  });

  assert.equal(first.transactionHash, transactionHash);
  assert.equal(second.transactionHash, transactionHash);
  assert.equal(cycleRepository.custodyLedgers.size, 1);
  assert.deepEqual(cycleRepository.writes.filter(write => write === 'custody-ledger'), ['custody-ledger', 'custody-ledger']);
  const ledger = [...cycleRepository.custodyLedgers.values()][0];
  assert.equal(ledger.claimed, '25000000');
  assert.equal(ledger.gasSpent.amountAtomic, '200000');
  assert.deepEqual(ledger.gasPayments, [{ transactionHash, amountWei: '200000' }]);
  assert.equal(ledger.verifiedCurrentBalance.balance.amountAtomic, '5000000');
});

test('reconcileLiveClaimProcess refuses the custody write and finality advancement when the archive balance drifts from the public recheck', async () => {
  const { account, config, cycleRepository, request, transactionHash } = await broadcastClaimFixture();
  const driftAfterArchiveRead = { triggered: false, hash: `0x${'d'.repeat(64)}` };
  const client = finalizedClaimReceiptClient({ account, config, request, transactionHash, driftAfterArchiveRead });
  const historicalEvidenceClient = evmArchiveBalanceClient({ onRead: () => { driftAfterArchiveRead.triggered = true; } });

  await assert.rejects(
    () => reconcileLiveClaimProcess({
      adapters: { robinhood: { client, historicalEvidenceClient } },
      config,
      cycleRepository,
      context: { cycleId: CYCLE_ID, stage: 'claim-process' },
    }),
    /native custody checkpoint changed/,
  );
  assert.equal(cycleRepository.chainAttempt.attempt.state, 'BROADCAST');
  assert.equal(cycleRepository.custodyLedgers.size, 0);
  assert.deepEqual(cycleRepository.writes, []);
});

test('reconcileLiveClaimProcess never derives the custody row identity from the archive or public response', async () => {
  const { account, config, cycleRepository, request, transactionHash } = await broadcastClaimFixture();
  const client = finalizedClaimReceiptClient({ account, config, request, transactionHash });
  const hostileArchive = evmArchiveBalanceClient({
    respond: ({ blockNumber, blockHash }) => ({
      value: 5_000_000n,
      blockNumber,
      blockHash,
      // A hostile archive response naming a different chain, token, and account. The reader only
      // ever reads `.value`/`.blockNumber`/`.blockHash` off this object -- these extra fields must
      // have no path into the persisted row identity or the observation's own account/asset.
      chainId: 'eip155:1',
      assetId: 'eip155:1/erc20:0xbadbadbadbadbadbadbadbadbadbadbadbadbad',
      account: '0xbadbadbadbadbadbadbadbadbadbadbadbadbad',
    }),
  });

  const result = await reconcileLiveClaimProcess({
    adapters: { robinhood: { client, historicalEvidenceClient: hostileArchive } },
    config,
    cycleRepository,
    context: { cycleId: CYCLE_ID, stage: 'claim-process' },
  });
  assert.equal(result.transactionHash, transactionHash);
  const ledger = [...cycleRepository.custodyLedgers.values()][0];
  assert.equal(ledger.chainId, '4663');
  assert.equal(ledger.assetId, 'native');
  assert.equal(ledger.decimals, 18);
  assert.equal(ledger.verifiedCurrentBalance.account, account.address.toLowerCase());
  assert.equal(ledger.verifiedCurrentBalance.balance.chainId, '4663');
  assert.equal(ledger.verifiedCurrentBalance.balance.assetId, 'native');
});

test('reconcileLiveClaimProcess persists a truthful zero verified balance without treating it as unclaimed', async () => {
  const { account, config, cycleRepository, request, transactionHash } = await broadcastClaimFixture();
  const client = finalizedClaimReceiptClient({ account, config, request, transactionHash });

  const result = await reconcileLiveClaimProcess({
    adapters: {
      robinhood: {
        client,
        historicalEvidenceClient: evmArchiveBalanceClient({ balanceAtomic: 0n }),
      },
    },
    config,
    cycleRepository,
    context: { cycleId: CYCLE_ID, stage: 'claim-process' },
  });
  assert.equal(result.transactionHash, transactionHash);
  const ledger = [...cycleRepository.custodyLedgers.values()][0];
  assert.equal(ledger.claimed, '25000000');
  assert.equal(ledger.verifiedCurrentBalance.balance.amountAtomic, '0');
});

test('prepareClaimProcessRequest refuses a non-native configured chain before creating a signing request', async () => {
  await assert.rejects(() => broadcastClaimFixture({ chainId: 7 }), /native ETH|native chain|native asset|4663/);
});

// A durable legacy raw-identity row for this exact configured asset (`4663` / the configured USDG
// address, no `eip155:`/`erc20:` CAIP wrapping -- the same raw shape `returnSettlementCustodyLedger`
// keys its own row by, per ADR-0026). A canonical-only key lookup cannot see this row, so before this
// fix the writer would happily create (or keep refreshing) a second, canonical-keyed row -- whatever
// this row's own bucket values, including an all-zero row or the common historical-return shape of
// `claimed: '0'` with a nonzero `returnReceived`.
const LEGACY_RAW_IDENTITY_CONFLICT = /native claim cannot resume historical EVM custody/;

function legacyRawCustodyRow({ config, claimed = '0', returnReceived = '0' }) {
  const buckets = Object.fromEntries(CUSTODY_LEDGER_BUCKETS.map(bucket => {
    if (bucket === 'claimed') return [bucket, claimed];
    if (bucket === 'returnReceived') return [bucket, returnReceived];
    return [bucket, '0'];
  }));
  return {
    schema: 'hookemon.custody-ledger.v1',
    cycleId: CYCLE_ID,
    chainId: '4663',
    assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    decimals: 6,
    ...buckets,
  };
}

function canonicalRowMatching(config, buckets) {
  return {
    schema: 'hookemon.custody-ledger.v1',
    cycleId: CYCLE_ID,
    chainId: 'eip155:4663',
    assetId: 'eip155:4663/erc20:0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    decimals: 6,
    ...buckets,
  };
}

async function assertRefusesOverLegacyRawRow({ config, cycleRepository, rawRow, canonicalCoexisting = null }) {
  await cycleRepository.recordCustodyLedger(CYCLE_ID, rawRow);
  if (canonicalCoexisting) await cycleRepository.recordCustodyLedger(CYCLE_ID, canonicalCoexisting);
  const writesBefore = cycleRepository.writes.length;
  const rowsBefore = new Map(cycleRepository.custodyLedgers);

  await assert.rejects(
    () => reconcileLiveClaimProcess({
      adapters: { robinhood: { client: cycleRepository.finalizedClient, historicalEvidenceClient: evmArchiveBalanceClient() } },
      config,
      cycleRepository,
      context: { cycleId: CYCLE_ID, stage: 'claim-process' },
    }),
    LEGACY_RAW_IDENTITY_CONFLICT,
  );
  assert.equal(cycleRepository.writes.length, writesBefore);
  assert.deepEqual(cycleRepository.custodyLedgers, rowsBefore);
}

async function finalizedRestartFixture() {
  const { account, config, cycleRepository, request, transactionHash } = await broadcastClaimFixture();
  cycleRepository.chainAttempt = {
    ...cycleRepository.chainAttempt,
    attempt: { ...cycleRepository.chainAttempt.attempt, state: 'FINALIZED' },
    finalityEvidence: { transactionHash, finalized: true },
  };
  cycleRepository.finalizedClient = finalizedClaimReceiptClient({ account, config, request, transactionHash });
  return { config, cycleRepository };
}

test('reconcileLiveClaimProcess refuses a raw-only legacy claimed row instead of creating a second canonical row', async () => {
  const { config, cycleRepository } = await finalizedRestartFixture();
  await assertRefusesOverLegacyRawRow({
    config,
    cycleRepository,
    rawRow: legacyRawCustodyRow({ config, claimed: '25000000' }),
  });
  assert.equal(cycleRepository.custodyLedgers.size, 1);
});

test('reconcileLiveClaimProcess refuses when a legacy raw claimed row already coexists with the canonical row', async () => {
  const { config, cycleRepository } = await finalizedRestartFixture();
  const buckets = Object.fromEntries(CUSTODY_LEDGER_BUCKETS.map(bucket => [bucket, bucket === 'claimed' ? '25000000' : '0']));
  await assertRefusesOverLegacyRawRow({
    config,
    cycleRepository,
    rawRow: legacyRawCustodyRow({ config, claimed: '25000000' }),
    canonicalCoexisting: canonicalRowMatching(config, buckets),
  });
  assert.equal(cycleRepository.custodyLedgers.size, 2);
  for (const row of cycleRepository.custodyLedgers.values()) {
    assert.equal(row.schema, 'hookemon.custody-ledger.v1');
    assert.equal(row.claimed, '25000000');
  }
});

test('reconcileLiveClaimProcess refuses a raw-only row carrying only a historical return, not a claimed amount', async () => {
  const { config, cycleRepository } = await finalizedRestartFixture();
  await assertRefusesOverLegacyRawRow({
    config,
    cycleRepository,
    rawRow: legacyRawCustodyRow({ config, claimed: '0', returnReceived: '25000000' }),
  });
  assert.equal(cycleRepository.custodyLedgers.size, 1);
  const [rawRow] = [...cycleRepository.custodyLedgers.values()];
  assert.equal(rawRow.claimed, '0');
  assert.equal(rawRow.returnReceived, '25000000');
});

test('reconcileLiveClaimProcess refuses a historical-return raw row coexisting with the canonical row', async () => {
  const { config, cycleRepository } = await finalizedRestartFixture();
  const buckets = Object.fromEntries(CUSTODY_LEDGER_BUCKETS.map(bucket => [bucket, bucket === 'claimed' ? '25000000' : '0']));
  await assertRefusesOverLegacyRawRow({
    config,
    cycleRepository,
    rawRow: legacyRawCustodyRow({ config, claimed: '0', returnReceived: '25000000' }),
    canonicalCoexisting: canonicalRowMatching(config, buckets),
  });
  assert.equal(cycleRepository.custodyLedgers.size, 2);
});

test('reconcileLiveClaimProcess refuses an all-zero raw-only row -- a zero balance is not proof the identity split is resolved', async () => {
  const { config, cycleRepository } = await finalizedRestartFixture();
  await assertRefusesOverLegacyRawRow({
    config,
    cycleRepository,
    rawRow: legacyRawCustodyRow({ config }),
  });
  assert.equal(cycleRepository.custodyLedgers.size, 1);
  const [rawRow] = [...cycleRepository.custodyLedgers.values()];
  assert.equal(rawRow.claimed, '0');
  assert.equal(rawRow.returnReceived, '0');
});
