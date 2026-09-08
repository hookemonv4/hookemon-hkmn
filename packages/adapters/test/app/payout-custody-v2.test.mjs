import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { keccak256, TransactionReceiptNotFoundError } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { compileDirectPayoutPlan, createNativePayoutAmount } from '../../../runner/src/distribution/payout-plan.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { wrapSignerClient } from '../../src/signing/signer-client.mjs';
import { DirectPayoutError, mutatePayout, reconcileLivePayout } from '../../src/app/stages/payout.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';

// Focused coverage for the payout-only EVM USDG custody-v2 write introduced by
// interfaces.json revision 67 / ADR-0026: `ensurePayoutCustodyLedger` inside
// `stages/payout.mjs`. Drives the real `mutatePayout` entrypoint against a real, durable
// `CycleRepository` and the real `createEvmCustodyBalanceObservationReader` producer (through fake
// public/archive RPC clients) -- never a bare unit-tested helper -- so every assertion here
// observes what the actual repository journal and the actual observation reader produced.

const TOKEN = `0x${'a'.repeat(40)}`;
const PRIVATE_KEY = `0x${'1'.repeat(64)}`;
const ACCOUNT = privateKeyToAccount(PRIVATE_KEY);
const OPERATIONS = ACCOUNT.address.toLowerCase();
const RECIPIENT_A = `0x${'2'.repeat(40)}`;
const RETURN_BINDING = Object.freeze({
  operations: OPERATIONS,
  assetId: 'native',
  evidenceDigest: `sha256:${'9'.repeat(64)}`,
});
const FIXTURE_SIGNER_OPTIONS = Object.freeze({ preflightAuthority: createTestProfileMutationAuthority() });

const CANONICAL_CHAIN_ID = '4663';
const CANONICAL_ASSET_ID = 'native';
const CANONICAL_KEY = `${CANONICAL_CHAIN_ID}${String.fromCharCode(0)}${CANONICAL_ASSET_ID}`;
const RAW_KEY = CANONICAL_KEY;

function usdg(amountAtomic) {
  return createNativePayoutAmount({ assetId: 'native', amountAtomic: String(amountAtomic) });
}

function payoutManifest(cycleId) {
  const entries = [{ recipient: RECIPIENT_A, hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' } }];
  return {
    schema: 'hookemon.eligibility-payout-manifest.v1',
    cycleId,
    snapshotBlock: '12',
    snapshotHash: `0x${'b'.repeat(64)}`,
    finality: { policyId: 'robinhood-stage-finality-v1', depth: '2' },
    supply: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1' },
    entries,
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
      primary: { sourceId: 'primary', transferLogDigest: `sha256:${'c'.repeat(64)}`, logCount: 1 },
      secondary: null,
    },
    holderSnapshotDigest: `sha256:${'d'.repeat(64)}`,
    launchManifestDigest: `sha256:${'e'.repeat(64)}`,
  };
}

function payoutPlan(cycleId, returnAmountAtomic = '9') {
  return compileDirectPayoutPlan({
    cycleId,
    eligibilityManifest: payoutManifest(cycleId),
    finalizedReturn: usdg(returnAmountAtomic),
    previousDust: usdg('0'),
    returnBinding: RETURN_BINDING,
  });
}

function baseConfig() {
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

function rpc({
  frozen = new Set(),
  nonce = 0n,
  balance = 1_000_000n,
  finalizedNumber = 100n,
  finalizedHash = `0x${'f'.repeat(64)}`,
  recheckHash = undefined,
  archiveBalance = 500_000n,
  archiveBlockNumber = undefined,
  archiveBlockHash = undefined,
  historicalEvidenceClient = 'default',
} = {}) {
  const client = {
    async readContract({ functionName, args }) {
      assert.equal(functionName, 'isFrozen');
      return frozen.has(args[0].toLowerCase());
    },
    async getTransactionCount() { return nonce; },
    async getBalance() { return balance; },
    async readCycleAttributableFinalizedAvailable() {
      return { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '999999999999999999999999' };
    },
    async sendRawTransaction() {
      return { transactionHash: `0x${'0'.repeat(64)}` };
    },
    async getTransactionReceipt({ hash }) {
      throw new TransactionReceiptNotFoundError({ hash });
    },
    async getBlock({ blockTag } = {}) {
      if (blockTag === 'finalized') return { number: finalizedNumber, hash: finalizedHash, timestamp: 1_700_000_000n };
      return { number: finalizedNumber, hash: recheckHash ?? finalizedHash, timestamp: 1_700_000_000n };
    },
  };
  if (historicalEvidenceClient === 'default') {
    client.historicalEvidenceClient = {
      async readNativeBalanceAtBlock({ blockNumber, blockHash }) {
        return {
          value: archiveBalance,
          blockNumber: archiveBlockNumber ?? blockNumber,
          blockHash: archiveBlockHash ?? blockHash,
        };
      },
    };
  } else if (historicalEvidenceClient === 'same') {
    client.historicalEvidenceClient = client;
  } else if (historicalEvidenceClient && historicalEvidenceClient !== 'none') {
    client.historicalEvidenceClient = historicalEvidenceClient;
  }
  return client;
}

function signer(counter) {
  const inner = {
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
  };
  return { evm: wrapSignerClient({ role: 'operator-evm', liveMode: true, ...FIXTURE_SIGNER_OPTIONS, inner }) };
}

async function durableCycle(t, cycleId = 'cycle-custody-v2-1') {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-payout-custody-v2-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = await CycleRepository.open(directory);
  await repository.createCycle({ releaseAmount: '1', mode: 'production', cycleId });
  return { directory, repository, cycleId };
}

function context(cycleId, seed = '1') {
  return {
    cycleId,
    requestDigest: `sha256:${seed.repeat(64)}`,
    fencingToken: `2222222${seed}-2222-4222-8222-222222222222`.slice(0, 36),
  };
}

async function runPayout({ cycleRepository, cycleId, config, client, returnAmountAtomic = '9', ctx = context(cycleId) }) {
  const plan = payoutPlan(cycleId, returnAmountAtomic);
  const counter = { sign: 0 };
  return mutatePayout({
    liveMode: true,
    config,
    cycleRepository,
    context: ctx,
    request: { plan },
    adapters: { robinhood: { client } },
    signerClient: signer(counter),
  });
}

async function customRow(cycleRepository, cycleId, overrides = {}) {
  const buckets = {
    claimed: '0', bridgeOut: '0', bridgeIn: '0', packCost: '0', buybackProceeds: '0',
    returnInput: '0', returnReceived: '0', refunds: '0', residual: '0', heldAssets: '0',
    heldPositions: '0', payoutLiability: '0', dust: '0', unattributed: '0',
  };
  const row = {
    schema: 'hookemon.custody-ledger.v3',
    cycleId,
    chainId: CANONICAL_CHAIN_ID,
    assetId: CANONICAL_ASSET_ID,
    decimals:18,gasReserve:{chainId:'4663',assetId:'native',decimals:18,amountAtomic:'10'},gasSpent:{chainId:'4663',assetId:'native',decimals:18,amountAtomic:'0'},gasPayments:[],verifiedCurrentBalance:null,expectedCycleAsset:null,
    ...buckets,
    ...overrides,
  };
  await cycleRepository.recordCustodyLedger(cycleId, row);
  return row;
}

async function rawRow(cycleRepository, cycleId, overrides = {}) {
  const buckets = {
    claimed: '0', bridgeOut: '0', bridgeIn: '0', packCost: '0', buybackProceeds: '0',
    returnInput: '0', returnReceived: '0', refunds: '0', residual: '0', heldAssets: '0',
    heldPositions: '0', payoutLiability: '0', dust: '0', unattributed: '0',
  };
  const row = {
    schema: 'hookemon.custody-ledger.v1',
    cycleId,
    chainId: '4663',
    assetId: 'native',
    decimals: 18,
    ...buckets,
    ...overrides,
  };
  await cycleRepository.recordCustodyLedger(cycleId, row);
  return row;
}

// Exercises `reconcileLivePayout` with zero writer capability beyond the plain read it needs:
// every mutation-shaped method a full CycleRepository exposes throws if reached, so a passing
// assertion here proves the custody check is genuinely read-only, never a bare repository escape.
function reconciliationOnlyFacade(cycleRepository) {
  return {
    readPagedPayoutState: (...callArgs) => cycleRepository.readPagedPayoutState(...callArgs),
    describeCycle: (...callArgs) => cycleRepository.describeCycle(...callArgs),
    persistPagedPayoutState() { throw new Error('reconciliation must not persist paged payout state'); },
    recordCustodyLedger() { throw new Error('reconciliation must not write the custody ledger'); },
    recordPayoutDust() { throw new Error('reconciliation must not record successor dust'); },
    reserveWalletNonce() { throw new Error('reconciliation must not reserve a wallet nonce'); },
    assertWalletNonce() { throw new Error('reconciliation must not assert a wallet nonce'); },
    releaseWalletNonce() { throw new Error('reconciliation must not release a wallet nonce'); },
    holdCycle() { throw new Error('reconciliation must not hold the cycle'); },
  };
}

test('refuses a raw-only legacy USDG predecessor before any custody write, signature, or broadcast', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await rawRow(cycleRepository, cycleId, { claimed: '100', returnReceived: '0' });

  const plan = payoutPlan(cycleId, '9');
  const counter = { sign: 0 };
  await assert.rejects(
    () => mutatePayout({
      liveMode: true,
      config: baseConfig(),
      cycleRepository,
      context: context(cycleId),
      request: { plan },
      adapters: { robinhood: { client: rpc() } },
      signerClient: signer(counter),
    }),
    error => {
      assert.ok(error instanceof DirectPayoutError);
      assert.match(error.message, /historical custody state/);
      return true;
    },
  );
  assert.equal(counter.sign, 0, 'must not sign before the raw-predecessor refusal');
  assert.equal(counter.broadcasts, undefined, 'must not broadcast before the raw-predecessor refusal');

  const state = await cycleRepository.describeCycle(cycleId);
  assert.equal(state.custodyLedgers.size, 1, 'must not create a competing canonical row');
  assert.deepEqual(state.custodyLedgers.get(RAW_KEY), {
    schema: 'hookemon.custody-ledger.v1', cycleId, chainId: '4663', assetId: 'native', decimals: 18,
    claimed: '100', bridgeOut: '0', bridgeIn: '0', packCost: '0', buybackProceeds: '0',
    returnInput: '0', returnReceived: '0', refunds: '0', residual: '0', heldAssets: '0',
    heldPositions: '0', payoutLiability: '0', dust: '0', unattributed: '0',
  });
  assert.equal(state.custodyLedgers.get(CANONICAL_KEY).schema, 'hookemon.custody-ledger.v1');
});

test('writes a new canonical v2 custody row on first admission with a real observation', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  const result = await runPayout({ cycleRepository, cycleId, config: baseConfig(), client: rpc() });
  assert.equal(result, undefined);

  const state = await cycleRepository.describeCycle(cycleId);
  const row = state.custodyLedgers.get(CANONICAL_KEY);
  assert.ok(row, 'expected a canonical v2 custody row');
  assert.equal(row.schema, 'hookemon.custody-ledger.v3');
  assert.equal(row.chainId, CANONICAL_CHAIN_ID);
  assert.equal(row.assetId, CANONICAL_ASSET_ID);
  assert.equal(row.returnReceived, '9');
  assert.equal(row.claimed, '0');
  assert.equal(row.expectedCycleAsset, null);
  assert.ok(row.verifiedCurrentBalance, 'expected a non-null verifiedCurrentBalance on the fresh write');
  assert.equal(row.verifiedCurrentBalance.schema, 'hookemon.custody-balance-observation.v1');
  assert.equal(row.verifiedCurrentBalance.account, OPERATIONS);
  assert.equal(row.verifiedCurrentBalance.balance.amountAtomic, '500000');
  assert.equal(row.verifiedCurrentBalance.finality.height, '100');
});

test('upgrades a legitimate existing canonical v1 row, retaining every bucket, only with a genuine observation', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await customRow(cycleRepository, cycleId, { claimed: '100', bridgeIn: '20', returnReceived: '9' });

  await runPayout({ cycleRepository, cycleId, config: baseConfig(), client: rpc() });

  const state = await cycleRepository.describeCycle(cycleId);
  const row = state.custodyLedgers.get(CANONICAL_KEY);
  assert.equal(row.schema, 'hookemon.custody-ledger.v3');
  assert.equal(row.claimed, '100');
  assert.equal(row.bridgeIn, '20');
  assert.equal(row.returnReceived, '9');
  assert.equal(row.expectedCycleAsset, null);
  assert.ok(row.verifiedCurrentBalance);
});

test('refuses when the existing canonical row does not yet prove the finalized return backing', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await customRow(cycleRepository, cycleId, { claimed: '100', returnReceived: '3' });

  await assert.rejects(
    () => runPayout({ cycleRepository, cycleId, config: baseConfig(), client: rpc() }),
    error => {
      assert.ok(error instanceof DirectPayoutError);
      assert.match(error.message, /does not prove the finalized return backing/);
      return true;
    },
  );

  const state = await cycleRepository.describeCycle(cycleId);
  const row = state.custodyLedgers.get(CANONICAL_KEY);
  assert.equal(row.schema, 'hookemon.custody-ledger.v3');
  assert.equal(row.returnReceived, '3');
});

test('refreshes an existing v2 observation on resume, and replays identically when nothing changed', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  const ctx = context(cycleId);
  await runPayout({ cycleRepository, cycleId, config: baseConfig(), client: rpc(), ctx });
  const first = (await cycleRepository.describeCycle(cycleId)).custodyLedgers.get(CANONICAL_KEY);

  // Idempotent replay: unchanged fixture, unchanged finalized height -> byte-identical observation.
  await runPayout({ cycleRepository, cycleId, config: baseConfig(), client: rpc(), ctx });
  const replayed = (await cycleRepository.describeCycle(cycleId)).custodyLedgers.get(CANONICAL_KEY);
  assert.deepEqual(replayed, first);

  // Refresh: a strictly later finalized height must move the recorded observation forward.
  await runPayout({
    cycleRepository,
    cycleId,
    config: baseConfig(),
    client: rpc({ finalizedNumber: 101n, finalizedHash: `0x${'1'.repeat(64)}`, archiveBalance: 600_000n }),
    ctx,
  });
  const refreshed = (await cycleRepository.describeCycle(cycleId)).custodyLedgers.get(CANONICAL_KEY);
  assert.equal(refreshed.verifiedCurrentBalance.finality.height, '101');
  assert.equal(refreshed.verifiedCurrentBalance.balance.amountAtomic, '600000');
});

test('accepts a truthful zero observed balance as evidence, independently of payout admission', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  const result = await runPayout({ cycleRepository, cycleId, config: baseConfig(), client: rpc({ archiveBalance: 0n }) });
  assert.equal(result, undefined);

  const row = (await cycleRepository.describeCycle(cycleId)).custodyLedgers.get(CANONICAL_KEY);
  assert.equal(row.verifiedCurrentBalance.balance.amountAtomic, '0');
  assert.equal(row.returnReceived, '9');
});

test('refuses a configured USDG chain mismatch before any custody write', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  const config = baseConfig();
  config.moneyConfiguration.assets.eth.chainId = '1';

  await assert.rejects(
    () => runPayout({ cycleRepository, cycleId, config, client: rpc() }),
    DirectPayoutError,
  );
  const state = await cycleRepository.describeCycle(cycleId);
  assert.equal(state.custodyLedgers.size, 0);
});

test('refuses a configured USDG token/asset mismatch before any custody write', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  const config = baseConfig();
  const otherToken = `0x${'b'.repeat(40)}`;
  config.moneyConfiguration.assets.eth.assetId = otherToken;

  await assert.rejects(
    () => runPayout({ cycleRepository, cycleId, config, client: rpc() }),
    DirectPayoutError,
  );
  const state = await cycleRepository.describeCycle(cycleId);
  assert.equal(state.custodyLedgers.size, 0);
});

test('refuses a configured USDG decimals mismatch before any custody write', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  const config = baseConfig();
  config.moneyConfiguration.assets.eth.decimals = 8;

  await assert.rejects(
    () => runPayout({ cycleRepository, cycleId, config, client: rpc() }),
    DirectPayoutError,
  );
  const state = await cycleRepository.describeCycle(cycleId);
  assert.equal(state.custodyLedgers.size, 0);
});

test('refuses an invalid configured Operations account before any custody write', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  const config = baseConfig();
  config.accounts.evm = 'not-an-address';

  await assert.rejects(
    () => runPayout({ cycleRepository, cycleId, config, client: rpc() }),
    DirectPayoutError,
  );
  const state = await cycleRepository.describeCycle(cycleId);
  assert.equal(state.custodyLedgers.size, 0);
});

test('refuses a missing archive-capable historical evidence client', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await assert.rejects(
    () => runPayout({ cycleRepository, cycleId, config: baseConfig(), client: rpc({ historicalEvidenceClient: 'none' }) }),
    error => {
      assert.ok(error instanceof DirectPayoutError);
      assert.match(error.message, /distinct native archive evidence reader required/);
      return true;
    },
  );
  const state = await cycleRepository.describeCycle(cycleId);
  assert.equal(state.custodyLedgers.size, 0);
});

test('refuses an archive client that is the same object as the public client', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await assert.rejects(
    () => runPayout({ cycleRepository, cycleId, config: baseConfig(), client: rpc({ historicalEvidenceClient: 'same' }) }),
    error => {
      assert.ok(error instanceof DirectPayoutError);
      assert.match(error.message, /distinct native archive evidence reader required/);
      return true;
    },
  );
  const state = await cycleRepository.describeCycle(cycleId);
  assert.equal(state.custodyLedgers.size, 0);
});

test('refuses an archive read that does not bind the requested finalized block', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await assert.rejects(
    () => runPayout({
      cycleRepository,
      cycleId,
      config: baseConfig(),
      client: rpc({ archiveBlockNumber: 42n }),
    }),
    error => {
      assert.ok(error instanceof DirectPayoutError);
      assert.match(error.message, /native archive evidence checkpoint mismatch/);
      return true;
    },
  );
  const state = await cycleRepository.describeCycle(cycleId);
  assert.equal(state.custodyLedgers.size, 0);
});

test('refuses a public reorg between the finalized read and the recheck', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await assert.rejects(
    () => runPayout({
      cycleRepository,
      cycleId,
      config: baseConfig(),
      client: rpc({ recheckHash: `0x${'2'.repeat(64)}` }),
    }),
    error => {
      assert.ok(error instanceof DirectPayoutError);
      assert.match(error.message, /native custody checkpoint changed/);
      return true;
    },
  );
  const state = await cycleRepository.describeCycle(cycleId);
  assert.equal(state.custodyLedgers.size, 0);
});

test('refuses a stale observation height and leaves the prior row unchanged', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  const ctx = context(cycleId);
  await runPayout({
    cycleRepository,
    cycleId,
    config: baseConfig(),
    client: rpc({ finalizedNumber: 100n }),
    ctx,
  });
  const before = (await cycleRepository.describeCycle(cycleId)).custodyLedgers.get(CANONICAL_KEY);

  await assert.rejects(
    () => runPayout({
      cycleRepository,
      cycleId,
      config: baseConfig(),
      client: rpc({ finalizedNumber: 99n, finalizedHash: `0x${'e'.repeat(64)}` }),
      ctx,
    }),
    /finality height cannot go backward/,
  );

  const after = (await cycleRepository.describeCycle(cycleId)).custodyLedgers.get(CANONICAL_KEY);
  assert.deepEqual(after, before);
});

test('refuses a conflicting observation at the same finalized height and leaves the prior row unchanged', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  const ctx = context(cycleId);
  await runPayout({
    cycleRepository,
    cycleId,
    config: baseConfig(),
    client: rpc({ finalizedNumber: 100n, archiveBalance: 500_000n }),
    ctx,
  });
  const before = (await cycleRepository.describeCycle(cycleId)).custodyLedgers.get(CANONICAL_KEY);

  await assert.rejects(
    () => runPayout({
      cycleRepository,
      cycleId,
      config: baseConfig(),
      client: rpc({ finalizedNumber: 100n, archiveBalance: 777_777n }),
      ctx,
    }),
    /conflicts with prior evidence at the same finality height/,
  );

  const after = (await cycleRepository.describeCycle(cycleId)).custodyLedgers.get(CANONICAL_KEY);
  assert.deepEqual(after, before);
});

test('a restarted resume preserves every bucket and expectedCycleAsset with no duplicate payout or dust effect', async t => {
  const { directory, repository: cycleRepository, cycleId } = await durableCycle(t);
  const ctx = context(cycleId);
  await customRow(cycleRepository, cycleId, { claimed: '9', returnReceived: '9' });

  await runPayout({ cycleRepository, cycleId, config: baseConfig(), client: rpc(), ctx });
  const afterFirst = await cycleRepository.describeCycle(cycleId);
  const firstRow = afterFirst.custodyLedgers.get(CANONICAL_KEY);
  assert.equal(firstRow.schema, 'hookemon.custody-ledger.v3');
  assert.equal(firstRow.claimed, '9');
  const dustConsumptionsBefore = afterFirst.payoutDustConsumptions.size;

  const reopened = await CycleRepository.open(directory);
  await runPayout({ cycleRepository: reopened, cycleId, config: baseConfig(), client: rpc(), ctx });

  const afterRestart = await reopened.describeCycle(cycleId);
  const restartedRow = afterRestart.custodyLedgers.get(CANONICAL_KEY);
  assert.equal(restartedRow.claimed, '9');
  assert.equal(restartedRow.expectedCycleAsset, null);
  assert.equal(afterRestart.payoutDustConsumptions.size, dustConsumptionsBefore);
});

test('a zero-payable-recipient payout never reads the chain and writes a first-ever null-observation row', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  const untouchable = new Proxy({}, { get() { throw new Error('zero-proceeds payout must not read the RPC'); } });
  const ctx = context(cycleId);
  const plan = payoutPlan(cycleId, '0');
  const counter = { sign: 0 };
  const evidence = await mutatePayout({
    liveMode: true,
    config: baseConfig(),
    cycleRepository,
    context: ctx,
    request: { plan },
    adapters: { robinhood: { client: untouchable } },
    signerClient: signer(counter),
  });

  assert.equal(evidence.distributablePool.amountAtomic, '0');
  const row = (await cycleRepository.describeCycle(cycleId)).custodyLedgers.get(CANONICAL_KEY);
  assert.equal(row.schema, 'hookemon.custody-ledger.v3');
  assert.equal(row.verifiedCurrentBalance, null);
});

// Focused coverage for the reconciliation-time custody bypass: a zero-recipient direct payout is
// `isDirectPayoutComplete` the instant its state is persisted, before `ensurePayoutCustodyLedger`
// ever runs. A disallowed raw predecessor refuses that custody write, but -- before this fix --
// the already-persisted zero-recipient state survived the refusal, and a later `reconcileLivePayout`
// call read only `isDirectPayoutComplete` and finalized on it regardless.

test('reconciliation refuses a persisted zero-recipient payout backed only by a disallowed raw predecessor, across restart and repeated attempts', async t => {
  const { directory, repository: cycleRepository, cycleId } = await durableCycle(t);
  await rawRow(cycleRepository, cycleId, { claimed: '100', returnReceived: '0' });

  const plan = payoutPlan(cycleId, '0');
  const counter = { sign: 0 };
  await assert.rejects(
    () => mutatePayout({
      liveMode: true,
      config: baseConfig(),
      cycleRepository,
      context: context(cycleId),
      request: { plan },
      adapters: { robinhood: { client: rpc() } },
      signerClient: signer(counter),
    }),
    error => {
      assert.ok(error instanceof DirectPayoutError);
      assert.match(error.message, /historical custody state/);
      return true;
    },
  );
  assert.equal(counter.sign, 0, 'must not sign before the raw-predecessor refusal');

  const beforeReconcile = await cycleRepository.describeCycle(cycleId);
  assert.equal(beforeReconcile.custodyLedgers.size, 1, 'must not create a competing canonical row');
  assert.equal(beforeReconcile.custodyLedgers.get(CANONICAL_KEY).schema, 'hookemon.custody-ledger.v1');

  // Reopen the repository, simulating a restart onto the already-persisted zero-recipient state.
  const reopened = await CycleRepository.open(directory);
  const facade = reconciliationOnlyFacade(reopened);
  const ctx = context(cycleId);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const evidence = await reconcileLivePayout({ config: baseConfig(), cycleRepository: facade, context: ctx });
    assert.equal(evidence, null, `reconciliation attempt ${attempt} must not return terminal evidence`);
  }

  const afterReconcile = await reopened.describeCycle(cycleId);
  assert.equal(afterReconcile.custodyLedgers.size, 1, 'reconciliation must not create a canonical row');
  assert.deepEqual(afterReconcile.custodyLedgers.get(RAW_KEY), beforeReconcile.custodyLedgers.get(RAW_KEY));
});

test('reconciliation refuses a completed zero-recipient payout with no existing custody row at all', async t => {
  const { directory, repository: cycleRepository, cycleId } = await durableCycle(t);
  // A config whose configured USDG identity cannot back any custody row causes the same
  // atomic-persist-then-custody-refuse sequence as the raw-predecessor case, but leaves no custody
  // row of any kind -- modeling a corrupted or never-admitted custody ledger for this cycle.
  const mismatchedConfig = baseConfig();
  mismatchedConfig.moneyConfiguration.assets.eth.chainId = '1';
  const plan = payoutPlan(cycleId, '0');
  await assert.rejects(
    () => mutatePayout({
      liveMode: true,
      config: mismatchedConfig,
      cycleRepository,
      context: context(cycleId),
      request: { plan },
      adapters: { robinhood: { client: rpc() } },
      signerClient: signer({ sign: 0 }),
    }),
    DirectPayoutError,
  );
  assert.equal((await cycleRepository.describeCycle(cycleId)).custodyLedgers.size, 0, 'no custody row of any kind must exist');

  const reopened = await CycleRepository.open(directory);
  const facade = reconciliationOnlyFacade(reopened);
  const evidence = await reconcileLivePayout({ config: baseConfig(), cycleRepository: facade, context: context(cycleId) });
  assert.equal(evidence, null, 'a missing custody row must never be treated as evidence of prior admission');
});

test('reconciliation recovers a genuinely completed zero-recipient payout backed by an existing canonical row', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await customRow(cycleRepository, cycleId, { claimed: '0', returnReceived: '0' });

  const plan = payoutPlan(cycleId, '0');
  const ctx = context(cycleId);
  const evidence = await mutatePayout({
    liveMode: true,
    config: baseConfig(),
    cycleRepository,
    context: ctx,
    request: { plan },
    adapters: { robinhood: { client: rpc() } },
    signerClient: signer({ sign: 0 }),
  });
  assert.equal(evidence.distributablePool.amountAtomic, '0');

  const facade = reconciliationOnlyFacade(cycleRepository);
  const recovered = await reconcileLivePayout({ config: baseConfig(), cycleRepository: facade, context: ctx });
  assert.ok(recovered, 'a genuinely backed zero-recipient payout must still recover through reconciliation');
  assert.equal(recovered.distributablePool.amountAtomic, '0');
});

test('reconciliation refuses when the runtime Operations account no longer matches the persisted payout state', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await customRow(cycleRepository, cycleId, { claimed: '0', returnReceived: '0' });

  const plan = payoutPlan(cycleId, '0');
  const ctx = context(cycleId);
  await mutatePayout({
    liveMode: true,
    config: baseConfig(),
    cycleRepository,
    context: ctx,
    request: { plan },
    adapters: { robinhood: { client: rpc() } },
    signerClient: signer({ sign: 0 }),
  });

  const driftedConfig = baseConfig();
  driftedConfig.accounts.evm = `0x${'5'.repeat(40)}`;
  const facade = reconciliationOnlyFacade(cycleRepository);
  const evidence = await reconcileLivePayout({ config: driftedConfig, cycleRepository: facade, context: ctx });
  assert.equal(evidence, null, 'a drifted Operations account must never finalize a payout signed under a different identity');
});

test('reconciliation refuses when the runtime USDG contract no longer matches the persisted payout state', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await customRow(cycleRepository, cycleId, { claimed: '0', returnReceived: '0' });

  const plan = payoutPlan(cycleId, '0');
  const ctx = context(cycleId);
  await mutatePayout({
    liveMode: true,
    config: baseConfig(),
    cycleRepository,
    context: ctx,
    request: { plan },
    adapters: { robinhood: { client: rpc() } },
    signerClient: signer({ sign: 0 }),
  });

  const driftedConfig = baseConfig();
  driftedConfig.moneyConfiguration.assets.eth.assetId = `0x${'c'.repeat(40)}`;
  const facade = reconciliationOnlyFacade(cycleRepository);
  const evidence = await reconcileLivePayout({ config: driftedConfig, cycleRepository: facade, context: ctx });
  assert.equal(evidence, null, 'a drifted USDG contract must never finalize a payout signed under a different identity');
});

test('refuses historical custody reinterpretation before native payout can mutate it', async t => {
 const {repository,cycleId}=await durableCycle(t);
 await rawRow(repository,cycleId);
 await assert.rejects(()=>customRow(repository,cycleId),/cannot reinterpret historical custody as native/);
 assert.equal((await repository.describeCycle(cycleId)).custodyLedgers.get(CANONICAL_KEY).schema,'hookemon.custody-ledger.v1');
});
