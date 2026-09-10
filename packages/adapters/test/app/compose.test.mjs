// Integration coverage for the production composition root: a real scheduler
// (packages/runner/src/scheduler/scheduler.mjs), a real AutomatedCycleService
// (packages/runner/src/automation/automated-cycle-service.mjs), the real durable cycle repository
// and on-disk lease store (this package's src/app/*.mjs), and a real stage-driver — driven end to
// end against injected fake transports (never a real network call). This is the test-level
// equivalent of `node bin/hookemon-runner.mjs dry-run` (see hookemon-runner.test.mjs for the actual
// CLI subprocess invocation).
import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PublicKey, Transaction } from '@solana/web3.js';

import { acquireLease } from '../../../runner/src/automation/exclusive-lease.mjs';
import { createEmptyOperatorState, mutateOperatorState, readOperatorState } from '../../../runner/src/operator/state-file.mjs';
import { applyOperatorConfiguration } from '../../../runner/src/config/state-schema.mjs';
import { digest } from '../../../runner/src/cycle/journal.mjs';
import { createRelayClient, createQuoteUsdValuation, relayQuoteDigest } from '../../src/relay-client.mjs';
import { createRequestListener } from '../../../dashboard/src/server.mjs';
import { normalizePublicCommunitySnapshot } from '../../../dashboard/src/contracts/public-community-snapshot.mjs';
import { appendAuditEntry, readAllAuditEntries } from '../../../dashboard/src/auth/audit-log.mjs';
import { buildQuoteRefreshPlanner, compose as composeRoot, createTrustedSolanaBlockhashContextResolver } from '../../src/app/compose.mjs';
import {
  CYCLE_REPOSITORY_CLIENT_INTERFACE,
  assertCycleRepositoryClientInterface,
  CycleRepository,
} from '../../src/app/cycle-repository.mjs';
import { createFileLeaseStore } from '../../src/app/lease-store.mjs';
import { runOnePass as runVerifierPass } from '../../bin/hookemon-verifier.mjs';
import { DISTRIBUTION_SIGNER_ROLE, VERIFIER_ROLE } from '../../../runner/src/distribution/distribution-signer.mjs';
import {
  CIRCLE_USD_DECIMALS,
  CIRCLE_USD_MINT,
  SolanaAdapterError,
  TOKEN_PROGRAM_ID,
  buildTransferCheckedInstruction,
  createSolanaRpcClient,
  deriveAssociatedTokenAddress,
} from '../../src/solana-rpc.mjs';
import { createTestNativePaymentBinding } from '../../src/native-payment-proof.mjs';
import { keccak256 } from 'viem';
import { MoneyConfigurationRejected } from '../../src/app/environment.mjs';
import { deriveOnchainCycleId } from '../../src/app/stages/action-builder.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { deriveCyclePolicyDigest } from '../../../runner/src/automation/policy-engine.mjs';
import { AUTOMATED_CYCLE_STAGES } from '../../../runner/src/automation/automated-cycle-service.mjs';
import { stepAuthorizationIntentDigest } from '../../../runner/src/cycle/authorization-provider.mjs';
import {
  buildAndSignStepAuthorization,
  createProductionTestFixture,
} from '../../../runner/test/cycle/production-cycle.mjs';
import { nativeProducedAdmissionFixture } from '../native/admission-fixture.mjs';
import { privateKeyToAccount, serializeSignature, sign as signSecp256k1 } from 'viem/accounts';

const DASHBOARD_CREDENTIAL = 'd'.repeat(40);
const SOLANA_MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

// Isolated, test-only attributable process liability, standing in for the production hook reader
// wired at composition. A test that needs a live cycle supplies this explicitly rather than
// exercising the real archive client; nothing here lets a wallet balance or a configured figure
// stand in for attribution evidence -- the planner validates this shape exactly as it validates the
// real reader's output.
function testProcessLiabilityReader(amountAtomic = '1000000') {
  return {
    async read({ cycleId }) {
      return {
        schema: 'hookemon.process-liability-evidence.v2',
        chainId: '4663',
        assetId: FULL_ETH,
        decimals: 18,
        hook: FULL_HOOK,
        cycleId,
        onchainCycleId: deriveOnchainCycleId(cycleId),
        blockNumber: '10',
        blockHash: `0x${'1'.repeat(64)}`,
        finalized: true,
        processLiability: amountAtomic,
        remainingProcessClaimCapacity: amountAtomic,
        processClaimsPaused: false,
        processClaimCycleUsed: false,
        activeProcessClaimLimit: amountAtomic,
        totalLiability: amountAtomic,
        hookNativeBalance: amountAtomic,
        isSolvent: true,
        operations: FULL_EVM_ACCOUNT.toLowerCase(),
        ceilingAtomic: amountAtomic,
      };
    },
  };
}

const SUFFICIENT_BUDGET = Object.freeze({
  availableProcessWei: '10',
  packPriceWei: '1',
  outboundCapWei: '0',
  returnCapWei: '0',
  operatingMarginWei: '0',
});

function productionMoneyConfiguration() {
  return {
    schema: 'hookemon.money-configuration.v2',
    assets: {
      eth: { chainId: '4663', assetId: 'native', decimals: 18 },
      solanaStablecoin: {
        chainId: '792703809',
        assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        decimals: 6,
      },
    },
    minimums: {
      robinhoodReceive: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '0' },
      solanaReceive: {
        chainId: '792703809',
        assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        decimals: 6,
        amountAtomic: '0',
      },
      returnEth: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '0' },
    },
    evm: {
      perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '2000000000' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '3000000000000000' },
    },
    solana: {
      priorityFeeCap: {
        chainId: '792703809',
        assetId: 'microlamports-per-compute-unit',
        decimals: 0,
        amountAtomic: '25000',
      },
      lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '5000000' },
    },
  };
}

function collectorOnlyMoneyConfiguration() {
  const production = productionMoneyConfiguration();
  const solanaStablecoin = {
    chainId: 'solana-mainnet',
    assetId: CIRCLE_USD_MINT,
    decimals: CIRCLE_USD_DECIMALS,
  };
  return {
    ...production,
    assets: { ...production.assets, solanaStablecoin },
    minimums: {
      ...production.minimums,
      solanaReceive: { ...solanaStablecoin, amountAtomic: '0' },
    },
    solana: {
      priorityFeeCap: {
        chainId: 'solana-mainnet', assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '25000',
      },
      lamportReserve: {
        chainId: 'solana-mainnet', assetId: 'native', decimals: 9, amountAtomic: '5000000',
      },
    },
  };
}

// Exact fetched 25-settlement token quote valued at USD 21; the fixture deliberately assumes no parity.
async function collectorPackFundingUsd(operator) {
  const zero = `0x${'0'.repeat(40)}`;
  const client = createRelayClient({ now: () => 1_000, quoteValidityMs: 60_000,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const raw = { requestId: 'collector-usd-cost', details: { sender: operator, recipient: PRODUCTION_ADMISSION_EVM,
        currencyIn: { currency: { chainId: 792703809, address: CIRCLE_USD_MINT, decimals: 6 }, amount: request.amount, amountUsd: '21' },
        currencyOut: { currency: { chainId: 4663, address: zero, decimals: 18 }, amount: '8000000000000000', minimumAmount: '8000000000000000' } },
        protocol: { v2: { orderId: `0x${'4'.repeat(64)}`, orderData: {
          inputs: [{ payment: { chainId: 'solana', currency: CIRCLE_USD_MINT, amount: request.amount }, refunds: [{ chainId: 'solana', currency: CIRCLE_USD_MINT, recipient: operator, deadline: 2_000_000_000 }] }],
          output: { chainId: 'robinhood', deadline: 2_000_000_000, calls: [], payments: [{ recipient: PRODUCTION_ADMISSION_EVM, currency: zero, expectedAmount: '8000000000000000', minimumAmount: '8000000000000000' }] }
        } } }, steps: [] };
      return { ok: true, status: 200, text: async () => JSON.stringify(raw) };
    } });
  const quote = await client.quoteReturnBridge({ user: operator, recipient: PRODUCTION_ADMISSION_EVM, amount: '25000000', tradeType: 'EXACT_INPUT', skipRouteCheck: true });
  return createQuoteUsdValuation({ quote, side: 'origin', amount: { chainId: '792703809', assetId: CIRCLE_USD_MINT, decimals: 6, amountAtomic: '25000000' }, rounding: 'up', nowMs: 1_000 });
}

const OBSERVABILITY_PINS = Object.freeze({
  poolManager: '0x0000000000000000000000000000000000000003',
  positionManager: '0x0000000000000000000000000000000000000004',
  router: '0x0000000000000000000000000000000000000005',
  quoter: '0x0000000000000000000000000000000000000006',
  hook: '0x0000000000000000000000000000000000000007',
  treasury: '0x0000000000000000000000000000000000000008',
  operations: '0x0000000000000000000000000000000000000009',
});
const OBSERVABILITY_HASH = `0x${'a'.repeat(64)}`;

function liveObservabilityConfig(requiredSignerRoles = ['evm', 'solana']) {
  const pin = address => ({ address, runtimeHash: OBSERVABILITY_HASH });
  return {
    canaries: {
      chainId: 4663,
      nativePrincipal: { chainId: '4663', assetId: 'native', decimals: 18 },
      contracts: {
        poolManager: pin(OBSERVABILITY_PINS.poolManager),
        positionManager: pin(OBSERVABILITY_PINS.positionManager),
        router: pin(OBSERVABILITY_PINS.router),
        quoter: pin(OBSERVABILITY_PINS.quoter),
      },
      roles: {
        hookAddress: OBSERVABILITY_PINS.hook,
        cycleId: `0x${'0'.repeat(64)}`,
        treasury: OBSERVABILITY_PINS.treasury,
        operations: OBSERVABILITY_PINS.operations,
      },
      canonicalPool: { poolId: `0x${'f'.repeat(64)}` },
      providerPolicyDigest: OBSERVABILITY_HASH,
      nativeGasReserves: [
        { chainId: 4663, assetId: 'native', decimals: 18, amountAtomic: '1' },
        { chainId: 'solana', assetId: 'native', decimals: 9, amountAtomic: '1' },
      ],
    },
    alert: { webhookUrl: 'https://alerts.example.test/hooks', dedupePath: ':memory:' },
    startPreflight: { requiredSignerRoles, requireEvmRpc: false, requireSolanaRpc: false },
  };
}

function liveObservabilityDeps() {
  return {
    fetchImpl: async () => ({ ok: true, status: 204 }),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  };
}

async function tempStateDir(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-compose-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function seedCycle(stateDir, {
  releaseAmount,
  mode = 'production',
  providerMode = null,
  completedStages = [],
  packBatchRequests = [],
  heldPosition = null,
  archive = false,
  // `admission` may be the durable admission object itself, or a factory `reservedCycleId =>
  // admission` for a caller whose admission must name a cycleId reserved before createCycle opens
  // it (the admission rides inside `cycle-opened` itself, so it has to be built first). `operations`
  // is the matching deployment identity `assertDurableCycleAdmission` validates it against --
  // production identity by default.
  admission = null,
  operations = null,
  releaseCostMicroUsd = '1',
  now = () => 1_000,
}) {
  const cycleRepository = await CycleRepository.open(join(stateDir, 'cycles'), now, { testAuthority: createTestProfileMutationAuthority() });
  const reservedCycleId = admission === null ? null : cycleRepository.nextCycleId();
  const resolvedAdmission = typeof admission === 'function' ? await admission(reservedCycleId) : admission;
  const cycle = await cycleRepository.createCycle({
    releaseAmount,
    releaseCostMicroUsd,
    mode,
    ...(providerMode === null ? {} : { providerMode }),
    ...(reservedCycleId === null ? {} : { cycleId: reservedCycleId }),
    ...(resolvedAdmission === null ? {} : { admission: resolvedAdmission, operations }),
  });
  for (const { stage, evidence = { seeded: true } } of completedStages) {
    await cycleRepository.prepareStage(cycle.cycleId, stage);
    await cycleRepository.completeStage(cycle.cycleId, stage, evidence);
  }
  // Recorded through this same connection, sequentially before it returns: durable-store.mjs's
  // single-writer identity witness makes overlapping a second, independently-opened connection
  // against the same store unsafe, so a test never opens one just to seed one extra durable fact.
  for (const { stage, packs } of packBatchRequests) {
    await cycleRepository.recordPackBatchRequest(cycle.cycleId, stage, packs);
  }
  const recordedHeldPosition = heldPosition === null
    ? null
    : await cycleRepository.recordHeldPosition(cycle.cycleId, heldPosition);
  if (archive) await cycleRepository.completeCycle(cycle.cycleId);
  return {
    ...cycle,
    releaseCostMicroUsd,
    ...(resolvedAdmission === null ? {} : { admission: resolvedAdmission }),
    ...(recordedHeldPosition === null ? {} : { heldPosition: recordedHeldPosition }),
  };
}

function baseConfigurationPatch(overrides = {}) {
  return {
    intervalMinutes: 5,
    allowedPackIds: [],
    requestedOrders: 0,
    maxBoostersPerCycle: 1,
    maxUnitPriceMicroUsd: '0',
    maxCycleBudgetMicroUsd: '0',
    max24HourBudgetMicroUsd: '0',
    paused: false,
    liveMode: false,
    ...overrides,
  };
}

function livePolicyPatch(packId) {
  return {
    liveMode: true,
    allowedPackIds: [packId],
    requestedOrders: 1,
    maxUnitPriceMicroUsd: '10',
    maxCycleBudgetMicroUsd: '10',
    max24HourBudgetMicroUsd: '10',
    maxCyclesPerDay: 1,
    lossCapMicroUsd: '20',
    maxOutstandingCustodyMicroUsd: '20',
  };
}

function collectorOnlyLivePolicyPatch() {
  return {
    ...livePolicyPatch('collector-25'),
    maxUnitPriceMicroUsd: '21000000',
    maxCycleBudgetMicroUsd: '21000000',
    max24HourBudgetMicroUsd: '21000000',
    perCycleCapMicroUsd: '21000000',
    manualApprovalCycles: 1,
  };
}

async function writeOperatorState(statePath, patch = {}) {
  return mutateOperatorState(statePath, null, state => ({
    ...(state ?? createEmptyOperatorState()),
    configuration: applyOperatorConfiguration(state?.configuration ?? null, baseConfigurationPatch(patch)),
  }));
}

// Read-only calls are real and allowed (dry-run's whole point is to perform them); only the
// *mutating* half of each adapter throws, so this fixture actually proves "liveMode false never
// reaches a mutation", not merely "the adapters were never touched at all".
function throwingAdapters() {
  const boom = name => () => { throw new Error(`${name} must never be called while liveMode is false`); };
  const historicalEvidenceClient = {
    async readErc20BalanceAtBlock() {
      return { value: '0' };
    },
  };
  return {
    collectorCrypt: {
      // The configured pack must exist in the catalog: purchase derives its per-pack card count
      // from it, and admission prices from its exact catalog price.
      async getMachines() { return { machines: [{ code: 'base-pack', price: '0.000005', contains: 1 }] }; },
      async getStatus() { return { machineStatus: 'ok', gachas: [] }; },
      async getPackStatus() { return { memo: 'unused', pack: null, send: null, buyback: [] }; },
      generatePack: boom('collectorCrypt.generatePack'),
      openPack: boom('collectorCrypt.openPack'),
      getBuybackAvailable: boom('collectorCrypt.getBuybackAvailable'),
      buyback: boom('collectorCrypt.buyback'),
      submitTransaction: boom('collectorCrypt.submitTransaction'),
    },
    relay: {
      async quoteOutboundBridge() { return { requestId: 'req-1' }; },
      async quoteReturnBridge() { return { requestId: 'req-2' }; },
      simulateExecution({ quote }) { return { wouldExecute: true, requestId: quote.requestId }; },
      prepareExecution: boom('relay.prepareExecution'),
    },
    robinhood: {
      client: {
        async getChainId() { return 4663; },
        async readContract() { return { requirementsRevision: 0n, chainId: 4663n }; },
      },
      historicalEvidenceClient,
    },
    solana: { client: {} },
  };
}

function networkIdentity({
  evmChainId = 4663,
  evmError = null,
  solanaGenesisHash = SOLANA_MAINNET_GENESIS_HASH,
  solanaError = null,
} = {}) {
  return {
    async readEvmChainId() {
      if (evmError !== null) throw evmError;
      return evmChainId;
    },
    async readSolanaGenesisHash() {
      if (solanaError !== null) throw solanaError;
      return solanaGenesisHash;
    },
  };
}

function minimalInjectedAdapters() {
  return {
    collectorCrypt: null,
    relay: null,
    robinhood: { client: null },
    solana: { client: null },
  };
}

// Composition tests use fake transports. Supply the startup identity independently so every
// existing fixture stays deterministic while production composition still probes real RPCs.
function compose(config) {
  if (config.execution?.profile === 'production') {
    const hook = config.contracts?.hook ?? `0x${'8'.repeat(40)}`;
    const authority = config.preflightAuthority ?? createTestProfileMutationAuthority();
    config = { ...config, contracts: { ...config.contracts, hook }, preflightAuthority: authority,
      nativePaymentBinding: createTestNativePaymentBinding({ schema: 'hookemon.native-payment-binding.v1',
        chainId: '4663', hook: { address: hook, runtimeHash: keccak256('0x6000') }, relay: null }, authority) };
  }
  return composeRoot(Object.hasOwn(config, 'networkIdentity')
    ? config
    : { ...config, networkIdentity: networkIdentity() });
}

function collectorOnlySolanaCanaryClient({ balance = 5_000_000n } = {}) {
  return createSolanaRpcClient({
    rpcUrl: 'https://solana.example.test',
    fetchImpl: async (_url, request) => {
      const { id, method } = JSON.parse(request.body);
      const result = method === 'getLatestBlockhash'
        ? { value: { blockhash: 'SysvarC1ock11111111111111111111111111111111', lastValidBlockHeight: 101 } }
        : method === 'isBlockhashValid'
          ? { value: true }
          : method === 'getBalance'
            ? { value: Number(balance) }
            : null;
      return {
        ok: true,
        async text() { return JSON.stringify({ jsonrpc: '2.0', id, result }); },
      };
    },
  });
}

test('compose starts a live collector-only rehearsal with only Solana identity and canaries', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  const operator = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';
  await writeOperatorState(statePath, collectorOnlyLivePolicyPatch());
  const composition = await compose({
    stateDir,
    statePath,
    now: () => 1_000,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    solana: { rpcUrl: 'https://solana.example.test', chainId: 'solana-mainnet' },
    collectorCrypt: {
      baseUrl: 'https://collector.example.test',
      apiKey: 'fixture-api-key',
      settlementAsset: { chainId: 'solana-mainnet', assetId: CIRCLE_USD_MINT, decimals: CIRCLE_USD_DECIMALS },
      packPrice: { chainId: 'solana-mainnet', assetId: CIRCLE_USD_MINT, decimals: CIRCLE_USD_DECIMALS, amountAtomic: '25000000' },
      packFundingUsd: await collectorPackFundingUsd(operator),
    },
    accounts: { evm: null, solana: operator },
    pack: { code: 'collector-25' },
    budget: {
      availableProcessWei: '25000000',
      packPriceWei: '25000000',
      outboundCapWei: '0',
      returnCapWei: '0',
      operatingMarginWei: '0',
    },
    moneyConfiguration: collectorOnlyMoneyConfiguration(),
    rehearsal: {
      mode: 'collector-only',
      proceedsAccount: deriveAssociatedTokenAddress(operator, CIRCLE_USD_MINT).toBase58(),
      payoutRecipients: ['GfFAJnHnSgP7C2FQZLz6ogpdTV6Y7259f83qFFm9wxKm'],
      split: 'equal',
    },
    execution: { profile: 'rehearsal', networkProfile: 'mainnet', providerMode: 'live', enforceProfile: true },
    adapters: {
      collectorCrypt: {},
      relay: {},
      robinhood: { client: null },
      solana: { client: collectorOnlySolanaCanaryClient() },
    },
    networkIdentity: {
      async readSolanaGenesisHash() { return SOLANA_MAINNET_GENESIS_HASH; },
    },
  });
  t.after(() => composition.shutdown());

  assert.deepEqual(await composition.assertStartReadiness({
    liveMode: true,
    mode: 'rehearsal',
    requirePolicyConfiguration: true,
    requireCanaryPreflight: true,
  }), { cycleCount: 0, preflight: 'PASSED' });
});

/** A configured-RPC double for `createTrustedSolanaBlockhashContextResolver`: `getLatestBlockhash`
 * and `isBlockhashValid` answer from the given fixed values, and every call is counted so a test can
 * assert the resolver actually reached this exact client instance instead of some other. */
function configurableSolanaRpcClient({ blockhash, lastValidBlockHeight = 101, valid = true } = {}) {
  const calls = { getLatestBlockhash: 0, isBlockhashValid: 0 };
  const client = createSolanaRpcClient({
    rpcUrl: 'https://solana.example.test',
    fetchImpl: async (_url, request) => {
      const { id, method } = JSON.parse(request.body);
      calls[method] = (calls[method] ?? 0) + 1;
      const result = method === 'getLatestBlockhash'
        ? { value: { blockhash, lastValidBlockHeight } }
        : method === 'isBlockhashValid'
          ? { value: valid }
          : null;
      return { ok: true, async text() { return JSON.stringify({ jsonrpc: '2.0', id, result }); } };
    },
  });
  return { client, calls };
}

test('the trusted Solana blockhashContextResolver returns the exact RPC pair on an exact latest-blockhash match', async () => {
  const latestBlockhash = 'SysvarC1ock11111111111111111111111111111111';
  const { client } = configurableSolanaRpcClient({ blockhash: latestBlockhash, lastValidBlockHeight: 4242 });
  const resolver = createTrustedSolanaBlockhashContextResolver(client);

  const context = await resolver(latestBlockhash);

  assert.deepEqual(context, { blockhash: latestBlockhash, lastValidBlockHeight: 4242 });
});

test('the trusted Solana blockhashContextResolver refuses a provider blockhash that is not the current latest', async () => {
  const { client } = configurableSolanaRpcClient({ blockhash: 'SysvarC1ock11111111111111111111111111111111' });
  const resolver = createTrustedSolanaBlockhashContextResolver(client);

  await assert.rejects(
    () => resolver('SysvarRecentB1ockHashes11111111111111111111'),
    /compose Solana blockhashContextResolver refuses a blockhash that is not the current latest/,
  );
});

test('the trusted Solana blockhashContextResolver refuses when the RPC latest blockhash is already unusable', async () => {
  const latestBlockhash = 'SysvarC1ock11111111111111111111111111111111';
  const { client } = configurableSolanaRpcClient({ blockhash: latestBlockhash, valid: false });
  const resolver = createTrustedSolanaBlockhashContextResolver(client);

  await assert.rejects(() => resolver(latestBlockhash), SolanaAdapterError);
});

test('buildQuoteRefreshPlanner reuses the original pack/quantity/purchase targets/liability evidence and prices only fresh Relay quotes', async () => {
  const requests = [];
  const evmAccount = '0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384';
  const solanaAccount = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';
  const config = {
    accounts: { evm: evmAccount, solana: solanaAccount },
    moneyConfiguration: productionMoneyConfiguration(),
  };
  config.now = () => 1_000;
  const quotes = [];
  const client = createRelayClient({ now: config.now, quoteValidityMs: 60_000,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const isUnit = requests.length === 1;
      const quote = pinnedAdmissionRelayQuote({ requestId: isUnit ? 'relay-unit-refresh' : 'relay-aggregate-refresh',
        orderId: `0x${(isUnit ? '1' : '2').repeat(64)}`, fundingAtomic: isUnit ? '10000000' : '20000000', purchaseAtomic: request.amount });
      return { ok: true, status: 200, text: async () => JSON.stringify(quote.raw) };
    } });
  const adapters = { relay: { async quoteOutboundBridge(request) {
    requests.push(request);
    const quote = await client.quoteOutboundBridge({ ...request, skipRouteCheck: true });
    quotes.push(quote);
    return quote;
  } } };
  const admission = {
    quantity: 2,
    unitPurchase: {
      chainId: '792703809', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, amountAtomic: '5000000',
    },
    aggregatePurchase: {
      chainId: '792703809', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, amountAtomic: '10000000',
    },
    processLiabilityEvidence: { schema: 'hookemon.process-liability-evidence.v2', marker: 'original-evidence' },
  };
  const planner = buildQuoteRefreshPlanner({ config, adapters });
  const replacement = await planner.plan({
    cycleId: 'cycle-refresh-plan',
    packId: 'base-pack',
    admission,
    custody: { cycleId: 'cycle-refresh-plan' },
  });

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], {
    user: evmAccount,
    recipient: solanaAccount,
    destinationCurrency: config.moneyConfiguration.assets.solanaStablecoin.assetId,
    tradeType: 'EXACT_OUTPUT',
    amount: '5000000',
  });
  assert.deepEqual(requests[1], { ...requests[0], amount: '10000000' });
  assert.equal(replacement.schema, 'hookemon.policy-admission.v3');
  assert.equal(replacement.cycleId, 'cycle-refresh-plan');
  assert.equal(replacement.packId, 'base-pack');
  assert.equal(replacement.quantity, 2);
  assert.equal(replacement.unitPurchase, admission.unitPurchase);
  assert.equal(replacement.aggregatePurchase, admission.aggregatePurchase);
  assert.equal(replacement.processLiabilityEvidence, admission.processLiabilityEvidence);
  assert.equal(replacement.unitFundingQuote.amountAtomic, '10000000');
  assert.equal(replacement.aggregateFundingQuote.amountAtomic, '20000000');
  assert.equal(replacement.relay.requestId, 'relay-aggregate-refresh');
  assert.equal(replacement.unitRelay.requestId, 'relay-unit-refresh');
  assert.equal(replacement.quoteDigest, quotes[1].quoteDigest);
});

test('buildQuoteRefreshPlanner refuses to plan without repository-owned finalized claim/custody evidence bound to this exact cycle', async () => {
  const planner = buildQuoteRefreshPlanner({
    config: {
      accounts: { evm: '0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384', solana: 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE' },
      moneyConfiguration: productionMoneyConfiguration(),
    },
    adapters: { relay: { async quoteOutboundBridge() { throw new Error('must not quote without custody evidence'); } } },
  });
  assert.equal(await planner.plan({ cycleId: 'cycle-refresh-no-custody', packId: 'base-pack', admission: {}, custody: null }), null);
  assert.equal(
    await planner.plan({ cycleId: 'cycle-refresh-no-custody', packId: 'base-pack', admission: {}, custody: { cycleId: 'another-cycle' } }),
    null,
  );
});

/** A syntactically real, structurally valid legacy Solana transaction (deserializable by
 * `VersionedTransaction.deserialize`, exactly what `decodeProviderTransaction` requires to ever
 * reach `blockhashContextResolver`): a single-instruction SPL transfer-checked from the configured
 * operator to itself, signed by nobody (`decodeProviderTransaction` never verifies signatures, only
 * shape) so no private key is needed. `recentBlockhash` is the one field this test controls per
 * case. */
function realUnsignedPurchaseTransaction({ operator, recentBlockhash }) {
  const operatorKey = new PublicKey(operator);
  const source = deriveAssociatedTokenAddress(operator, CIRCLE_USD_MINT);
  const transaction = new Transaction({ feePayer: operatorKey, recentBlockhash }).add(
    buildTransferCheckedInstruction({
      source: source.toBase58(),
      destination: source.toBase58(),
      owner: operator,
      mint: CIRCLE_USD_MINT,
      amount: 1n,
      decimals: CIRCLE_USD_DECIMALS,
    }),
  );
  return Buffer.from(transaction.serialize({ requireAllSignatures: false, verifySignatures: false })).toString('base64');
}

/** The configured-RPC double a real composed purchase mutation actually reaches: `getLatestBlockhash`
 * / `isBlockhashValid` (consumed twice on the exact-match path -- once by `requireLiveCollectorOnlyCanary`'s
 * own startup canary, once again inside the resolver itself during decode), `getBlockHeight` (the
 * decode options' independent `currentBlockHeightResolver`), and `getAccountInfo` (the operator's
 * settlement associated-token-account existence read gating admission before any provider call).
 * `invalidFromCall` lets a test keep the startup canary healthy while making only the resolver's own
 * later `isBlockhashValid` read report the latest blockhash as already unusable. */
function collectorOnlyPurchaseSolanaClient({ operator, latestBlockhash, invalidFromCall = null }) {
  let isBlockhashValidCalls = 0;
  return createSolanaRpcClient({
    rpcUrl: 'https://solana.example.test',
    fetchImpl: async (_url, request) => {
      const { id, method } = JSON.parse(request.body);
      let result;
      if (method === 'getLatestBlockhash') result = { value: { blockhash: latestBlockhash, lastValidBlockHeight: 4242 } };
      else if (method === 'isBlockhashValid') {
        isBlockhashValidCalls += 1;
        result = { context: { slot: 1000 }, value: invalidFromCall === null || isBlockhashValidCalls < invalidFromCall };
      } else if (method === 'getBlockHeight') result = 100;
      else if (method === 'getBalance') result = { value: 10_000_000 };
      else if (method === 'getAccountInfo') {
        result = {
          value: {
            owner: TOKEN_PROGRAM_ID,
            data: {
              program: 'spl-token',
              parsed: {
                type: 'account',
                info: {
                  mint: CIRCLE_USD_MINT,
                  owner: operator,
                  tokenAmount: { amount: '1000000', decimals: CIRCLE_USD_DECIMALS },
                },
              },
            },
          },
        };
      } else result = null;
      return { ok: true, async text() { return JSON.stringify({ jsonrpc: '2.0', id, result }); } };
    },
  });
}

async function composedCollectorOnlyPurchaseAttempt(t, { latestBlockhash, transactionBlockhash, invalidFromCall = null }) {
  const operator = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';
  const asset = { chainId: 'solana-mainnet', assetId: CIRCLE_USD_MINT, decimals: CIRCLE_USD_DECIMALS };
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  // The loss/outstanding-custody caps are raised to the same 25000000 atomic units as the release
  // amount below -- `collectorOnlyLivePolicyPatch`'s base `livePolicyPatch` caps them at a token '20'.
  await writeOperatorState(statePath, {
    ...collectorOnlyLivePolicyPatch(),
    lossCapMicroUsd: '25000000',
    maxOutstandingCustodyMicroUsd: '25000000',
  });
  const cycle = await seedCycle(stateDir, {
    releaseAmount: '25000000',
    mode: 'rehearsal',
    providerMode: 'live',
    completedStages: [
      { stage: 'eligibility-snapshot' },
      { stage: 'claim-process' },
      { stage: 'outbound' },
    ],
  });

  const calls = { generatePack: 0, sign: 0, submitTransaction: 0 };
  const composition = await compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid', chainId: 'solana-mainnet' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: {
      baseUrl: 'https://example.invalid',
      settlementAsset: asset,
      packPrice: { ...asset, amountAtomic: '25000000' },
      packFundingUsd: await collectorPackFundingUsd(operator),
    },
    contracts: { vault: null, hook: null },
    accounts: { evm: null, solana: operator },
    pack: { code: 'collector-25' },
    signer: {
      backend: 'keychain',
      liveMode: true,
      roles: ['operator-solana'],
      keychain: { solanaAccount: 'operator-solana' },
    },
    moneyConfiguration: collectorOnlyMoneyConfiguration(),
    rehearsal: {
      mode: 'collector-only',
      proceedsAccount: deriveAssociatedTokenAddress(operator, CIRCLE_USD_MINT).toBase58(),
      payoutRecipients: ['GfFAJnHnSgP7C2FQZLz6ogpdTV6Y7259f83qFFm9wxKm'],
      split: 'equal',
    },
    execution: { profile: 'rehearsal', networkProfile: 'mainnet', providerMode: 'live', enforceProfile: true },
    preflightAuthority: createTestProfileMutationAuthority(),
    adapters: {
      collectorCrypt: {
        async getMachines() { return { machines: [{ code: 'collector-25', price: '0.025', contains: 1 }] }; },
        async getStatus() { return { machineStatus: 'ok', gachas: [] }; },
        async generatePack({ playerAddress }) {
          calls.generatePack += 1;
          assert.equal(playerAddress, operator);
          return {
            memo: 'memo-composed-purchase',
            transaction: realUnsignedPurchaseTransaction({ operator, recentBlockhash: transactionBlockhash }),
          };
        },
        submitTransaction: () => {
          calls.submitTransaction += 1;
          throw new Error('submitTransaction must never be reached before a pinned policy exists');
        },
      },
      relay: {
        quoteOutboundBridge: () => { throw new Error('unused: outbound is already seeded complete'); },
        quoteReturnBridge: () => { throw new Error('unused'); },
        simulateExecution: () => { throw new Error('unused'); },
        prepareExecution: () => { throw new Error('unused'); },
      },
      robinhood: { client: { async readContract() { return { requirementsRevision: 0n, chainId: 4663n }; } } },
      solana: { client: collectorOnlyPurchaseSolanaClient({ operator, latestBlockhash, invalidFromCall }) },
    },
    signerClient: {
      solana: {
        probe: async () => ({ ready: true }),
        async sign() { calls.sign += 1; throw new Error('signer must never be reached before a pinned policy exists'); },
      },
    },
    now: () => 1_000,
  });
  t.after(() => composition.shutdown());

  // `collectorOnlyLivePolicyPatch`'s manualApprovalCycles: 1 requires this cycle's own policy digest
  // to be pre-approved -- collector-only rehearsal policy refuses a manualApprovalCycles of 0
  // outright, so the approval is recorded rather than the requirement disabled.
  const approvedConfiguration = (await readOperatorState(statePath)).configuration;
  const cycleDigest = deriveCyclePolicyDigest({
    configuration: approvedConfiguration,
    cycleId: cycle.cycleId,
    releaseAmountWei: cycle.releaseAmount,
    releaseCostMicroUsd: '21000000',
    packId: 'collector-25',
    liveMode: true,
    mode: 'rehearsal',
  });
  await composition.policyEngine.recordManualApproval({ cycleDigest, cycleId: cycle.cycleId, approvedAtMs: 999 });

  // Completed historical stages cannot substitute for a native admission. Even a
  // separately valued cost and matching manual approval must leave new risk refused.
  const admission = await composition.policyEngine.admit({
    boundary: 'claim-process',
    cycleId: cycle.cycleId,
    releaseAmountWei: cycle.releaseAmount,
    releaseCostMicroUsd: '21000000',
    packId: 'collector-25',
    liveMode: true,
    mode: 'rehearsal',
  });
  assert.equal(admission.allowed, false, JSON.stringify(admission));
  assert.equal(admission.reason, 'USD_VALUATION_UNVERIFIED', JSON.stringify(admission));

  const error = await composition.service.recoverActiveCycle({ liveMode: true, mode: 'rehearsal' }).then(
    () => null,
    caught => caught,
  );
  return { error, calls, composition, cycle };
}

// Historical admission-free rehearsal rows remain readable but cannot acquire native
// purchase authority. An explicit USD cost and manual approval do not supply the missing
// bound admission or authorize any provider call.
test('a live collector-only rehearsal purchase remains unsupported under the durable-admission requirement: it refuses before any provider or signer call', async t => {
  const { error, calls } = await composedCollectorOnlyPurchaseAttempt(t, {
    latestBlockhash: 'SysvarC1ock11111111111111111111111111111111',
    transactionBlockhash: 'SysvarC1ock11111111111111111111111111111111',
  });

  assert.match(error?.message ?? '', /policy releaseCostMicroUsd must be positive for a money boundary/);
  assert.equal(calls.generatePack, 0);
  assert.equal(calls.sign, 0);
  assert.equal(calls.submitTransaction, 0);
});

// The collector-only rehearsal initializer never writes an executable pack plan: its policy names
// exactly one configured pack (`requestedOrders: 1`) and the saved `packPlan` stays empty. The saved
// plan belongs to the production admission planner, which this composition does not bind, so a fresh
// tick must open its cycle from the configured pack and reach the same durable-admission refusal as
// above -- never idle forever reporting WAITING_FOR_ADMISSION on the empty selection.
test('a live collector-only rehearsal tick opens a cycle from the configured pack instead of waiting on the empty saved pack plan', async t => {
  const operator = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';
  const asset = { chainId: 'solana-mainnet', assetId: CIRCLE_USD_MINT, decimals: CIRCLE_USD_DECIMALS };
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath, collectorOnlyLivePolicyPatch());
  assert.deepEqual((await readOperatorState(statePath)).configuration.packPlan.orders, []);

  const calls = { generatePack: 0, generateYoloPacks: 0, sign: 0, submitTransaction: 0 };
  const composition = await compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid', chainId: 'solana-mainnet' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: {
      baseUrl: 'https://example.invalid',
      settlementAsset: asset,
      packPrice: { ...asset, amountAtomic: '25000000' },
      packFundingUsd: await collectorPackFundingUsd(operator),
    },
    contracts: { vault: null, hook: null },
    accounts: { evm: null, solana: operator },
    pack: { code: 'collector-25' },
    budget: {
      availableProcessWei: '25000000',
      packPriceWei: '25000000',
      outboundCapWei: '0',
      returnCapWei: '0',
      operatingMarginWei: '0',
    },
    signer: {
      backend: 'keychain',
      liveMode: true,
      roles: ['operator-solana'],
      keychain: { solanaAccount: 'operator-solana' },
    },
    moneyConfiguration: collectorOnlyMoneyConfiguration(),
    rehearsal: {
      mode: 'collector-only',
      proceedsAccount: deriveAssociatedTokenAddress(operator, CIRCLE_USD_MINT).toBase58(),
      payoutRecipients: ['GfFAJnHnSgP7C2FQZLz6ogpdTV6Y7259f83qFFm9wxKm'],
      split: 'equal',
    },
    execution: { profile: 'rehearsal', networkProfile: 'mainnet', providerMode: 'live', enforceProfile: true },
    preflightAuthority: createTestProfileMutationAuthority(),
    adapters: {
      collectorCrypt: {
        async getMachines() { return { machines: [{ code: 'collector-25', price: '0.025', contains: 1 }] }; },
        async getStatus() { return { machineStatus: 'ok', gachas: [] }; },
        async generatePack() { calls.generatePack += 1; throw new Error('generatePack must never be reached without a durable admission'); },
        async generateYoloPacks() { calls.generateYoloPacks += 1; throw new Error('generateYoloPacks must never be reached without a durable admission'); },
        submitTransaction: () => { calls.submitTransaction += 1; throw new Error('submitTransaction must never be reached without a durable admission'); },
      },
      relay: {
        quoteOutboundBridge: () => { throw new Error('unused: the collector-only rehearsal skips the Robinhood-chain leg'); },
        quoteReturnBridge: () => { throw new Error('unused'); },
        simulateExecution: () => { throw new Error('unused'); },
        prepareExecution: () => { throw new Error('unused'); },
      },
      robinhood: { client: { async readContract() { return { requirementsRevision: 0n, chainId: 4663n }; } } },
      solana: { client: collectorOnlyPurchaseSolanaClient({ operator, latestBlockhash: 'SysvarC1ock11111111111111111111111111111111' }) },
    },
    signerClient: {
      solana: {
        probe: async () => ({ ready: true }),
        async sign() { calls.sign += 1; throw new Error('signer must never be reached without a durable admission'); },
      },
    },
    now: () => 1_000,
  });
  t.after(() => composition.shutdown());

  const outcome = await composition.service.runOnce({ liveMode: true, mode: 'rehearsal' }).then(
    value => ({ value, error: null }),
    error => ({ value: null, error }),
  );
  assert.notEqual(outcome.value?.status, 'WAITING_FOR_ADMISSION', 'the empty saved pack plan must not idle the collector-only rehearsal');
  assert.match(outcome.error?.message ?? JSON.stringify(outcome.value), /policy releaseCostMicroUsd must be positive for a money boundary/);

  // The tick got past admission on the configured pack: the cycle exists, its out-of-scope
  // eligibility snapshot completed, and the money boundary refused before any provider or signer call.
  const active = await composition.cycleRepository.readActiveCycle();
  assert.equal(active?.mode, 'rehearsal');
  assert.equal((await composition.cycleRepository.readStage(active.cycleId, 'eligibility-snapshot')).status, 'COMPLETE');
  assert.notEqual((await composition.cycleRepository.readStage(active.cycleId, 'claim-process'))?.status, 'COMPLETE');
  assert.deepEqual(calls, { generatePack: 0, generateYoloPacks: 0, sign: 0, submitTransaction: 0 });
});

// The recorded production Operations identity and canonical policy-engine routes
// (packages/runner/src/automation/policy-engine.mjs's PRODUCTION_ADMISSION_IDENTITY / ETH_ROUTE /
// COLLECTOR_SETTLEMENT_ROUTE). CycleRepository replay re-validates every durable admission against
// exactly these, regardless of what identity built it, so a durable admission meant to survive
// being read back has no choice but to use them verbatim -- never a namespace alias, never
// `createTestOnlyAdmissionIdentity` (which replay ignores entirely).
const PRODUCTION_ADMISSION_EVM = '0xb54aaf746eb1e80afdb5eb0992a75b08db2e4384';
const PRODUCTION_ADMISSION_SOLANA = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';
const PRODUCTION_ADMISSION_ETH = 'native';
const PRODUCTION_ADMISSION_SETTLEMENT_MINT = CIRCLE_USD_MINT;
const PRODUCTION_ADMISSION_ROUTES = Object.freeze({
  evm: PRODUCTION_ADMISSION_EVM,
  solana: PRODUCTION_ADMISSION_SOLANA,
  fundingRoute: Object.freeze({ chainId: '4663', assetId: PRODUCTION_ADMISSION_ETH, decimals: 18 }),
  settlementRoute: Object.freeze({ chainId: '792703809', assetId: PRODUCTION_ADMISSION_SETTLEMENT_MINT, decimals: 6 }),
});

function productionPurchaseMoneyConfiguration() {
  const configuration = productionMoneyConfiguration();
  const eth = { ...configuration.assets.eth, assetId: PRODUCTION_ADMISSION_ETH };
  return {
    ...configuration,
    assets: { ...configuration.assets, eth },
    minimums: {
      ...configuration.minimums,
      robinhoodReceive: { ...configuration.minimums.robinhoodReceive, assetId: PRODUCTION_ADMISSION_ETH },
      returnEth: { ...configuration.minimums.returnEth, assetId: PRODUCTION_ADMISSION_ETH },
    },
  };
}

/** A parsed Relay quote binding exactly `fundingAtomic` of the pinned production funding route to
 * `purchaseAtomic` of the pinned production settlement route, self-consistent under
 * `normalizeUnitRelayQuote` (packages/runner/src/automation/policy-engine.mjs): the quote digest is
 * recomputed from this same evidence, never trusted as supplied. */
function pinnedAdmissionRelayQuote({ requestId, orderId, fundingAtomic, purchaseAtomic, deadlineUnixSeconds = 2_000_000_000 }) {
  const routes = PRODUCTION_ADMISSION_ROUTES;
  const origin = { chainId: 4663, address: `0x${'0'.repeat(40)}`, decimals: 18, amount: fundingAtomic };
  const destination = {
    chainId: 792703809, address: routes.settlementRoute.assetId, decimals: 6, amount: purchaseAtomic, minimumAmount: purchaseAtomic,
  };
  const raw = {
    requestId,
    details: {
      sender: routes.evm,
      recipient: routes.solana,
      currencyIn: { currency: { chainId: origin.chainId, address: origin.address, decimals: origin.decimals }, amount: origin.amount, amountUsd: '0.000007' },
      currencyOut: { currency: { chainId: destination.chainId, address: destination.address, decimals: destination.decimals }, amount: destination.amount, minimumAmount: destination.minimumAmount },
    },
    protocol: { v2: { orderId, orderData: {
      inputs: [{ payment: { chainId: 'robinhood', currency: origin.address, amount: origin.amount }, refunds: [{ chainId: 'robinhood', currency: origin.address, recipient: routes.evm, deadline: deadlineUnixSeconds }] }],
      output: { chainId: 'solana', deadline: deadlineUnixSeconds, calls: [], payments: [{ recipient: routes.solana, currency: destination.address, expectedAmount: destination.amount, minimumAmount: destination.minimumAmount }] },
    } } },
    steps: [],
  };
  const quote = {
    direction: 'OUTBOUND', tradeType: 'EXACT_OUTPUT', requestId, orderId, sender: routes.evm, recipient: routes.solana,
    deadlineUnixSeconds, origin, destination, stepCount: raw.steps.length, raw,
  };
  return {
    ...quote,
    quoteDigest: digest({
      schema: 'hookemon.relay-quote.v1', direction: quote.direction, tradeType: quote.tradeType,
      requestId: quote.requestId, orderId: quote.orderId, sender: quote.sender, recipient: quote.recipient,
      deadlineUnixSeconds: quote.deadlineUnixSeconds, origin: quote.origin, destination: quote.destination, raw: quote.raw,
    }),
  };
}

/** A finalized hook process-liability evidence record covering exactly `ceilingAtomic`, shaped
 * exactly as `normalizeProcessLiabilityEvidence` requires: finalized, solvent, unused, unpaused,
 * denominated in the pinned production funding route. */
function pinnedAdmissionProcessLiabilityEvidence(cycleId, ceilingAtomic) {
  const routes = PRODUCTION_ADMISSION_ROUTES;
  return {
    schema: 'hookemon.process-liability-evidence.v2',
    chainId: routes.fundingRoute.chainId,
    assetId: routes.fundingRoute.assetId,
    decimals: routes.fundingRoute.decimals,
    hook: `0x${'8'.repeat(40)}`,
    cycleId,
    onchainCycleId: deriveOnchainCycleId(cycleId),
    blockNumber: '12345',
    blockHash: `0x${'3'.repeat(64)}`,
    finalized: true,
    processLiability: ceilingAtomic,
    remainingProcessClaimCapacity: ceilingAtomic,
    processClaimsPaused: false,
    processClaimCycleUsed: false,
    activeProcessClaimLimit: ceilingAtomic,
    totalLiability: ceilingAtomic,
    hookNativeBalance: ceilingAtomic,
    isSolvent: true,
    operations: routes.evm,
    ceilingAtomic,
  };
}

/** A complete, self-consistent quantity-1 `hookemon.policy-admission.v2` admission, denominated
 * exactly in the fixed production routes CycleRepository replay validates every durable admission
 * against -- independently authored, never derived from a candidate provider transaction. */
async function pinnedProductionPurchaseAdmission({ cycleId, packId, amountAtomic }) {
  const client = createRelayClient({ now: () => 1_000, quoteValidityMs: 60_000,
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      const quote = pinnedAdmissionRelayQuote({ requestId: `req-${request.amount}-${cycleId}`, orderId: `0x${'1'.repeat(64)}`, fundingAtomic: amountAtomic, purchaseAtomic: request.amount });
      return { ok: true, status: 200, text: async () => JSON.stringify(quote.raw) };
    } });
  const request = { user: PRODUCTION_ADMISSION_EVM, recipient: PRODUCTION_ADMISSION_SOLANA,
    destinationCurrency: CIRCLE_USD_MINT, tradeType: 'EXACT_OUTPUT', amount: amountAtomic, skipRouteCheck: true };
  const unitRelayQuote = await client.quoteOutboundBridge(request);
  const relayQuote = await client.quoteOutboundBridge(request);
  const routes = PRODUCTION_ADMISSION_ROUTES;
  return {
    schema: 'hookemon.policy-admission.v3',
    cycleId,
    packId,
    quantity: 1,
    quoteDigest: relayQuote.quoteDigest,
    unitPurchase: { ...routes.settlementRoute, amountAtomic },
    aggregatePurchase: { ...routes.settlementRoute, amountAtomic },
    unitFundingQuote: { ...routes.fundingRoute, amountAtomic },
    aggregateFundingQuote: { ...routes.fundingRoute, amountAtomic },
    unitFundingUsd: createQuoteUsdValuation({ quote: unitRelayQuote, side: 'origin', amount: { ...routes.fundingRoute, amountAtomic }, rounding: 'up', nowMs: 1_000 }),
    aggregateFundingUsd: createQuoteUsdValuation({ quote: relayQuote, side: 'origin', amount: { ...routes.fundingRoute, amountAtomic }, rounding: 'up', nowMs: 1_000 }),
    unitRelay: {
      tradeType: 'EXACT_OUTPUT', requestId: unitRelayQuote.requestId, orderId: unitRelayQuote.orderId,
      quoteDigest: unitRelayQuote.quoteDigest, deadlineUnixSeconds: unitRelayQuote.deadlineUnixSeconds,
      sender: routes.evm, recipient: routes.solana, destinationAmount: amountAtomic, destinationMinimumAmount: amountAtomic,
    },
    unitRelayQuote,
    relayQuote,
    relay: {
      tradeType: 'EXACT_OUTPUT', requestId: relayQuote.requestId, orderId: relayQuote.orderId,
      quoteDigest: relayQuote.quoteDigest, deadlineUnixSeconds: relayQuote.deadlineUnixSeconds,
      sender: routes.evm, recipient: routes.solana, destinationAmount: amountAtomic, destinationMinimumAmount: amountAtomic,
    },
    processLiabilityEvidence: pinnedAdmissionProcessLiabilityEvidence(cycleId, amountAtomic),
  };
}

/** An independently authored canonical transaction policy (never derived from a candidate decoded
 * transaction) pinning a settlement recipient this fixture's actual self-transfer purchase
 * transaction does not use. `requirePolicy` (purchase.mjs) accepts it before any provider call;
 * `evaluate` (transaction-policy.mjs) genuinely refuses it once purchase actually decodes a
 * candidate transaction against it, at `canonicalPolicyConstraint`'s `expectedRecipient` check --
 * the real next boundary past the trusted resolver, not a re-assertion of the earlier admission
 * refusal. */
function pinnedPurchaseTransactionPolicy() {
  return {
    policy: {
      schema: 'hookemon.transaction-policy.v1',
      chainId: 'solana-mainnet',
      stage: 'purchase',
      requestDigest: digest({ schema: 'hookemon.transaction-policy-request.v1', stage: 'purchase', fixture: 'production-purchase-resolver' }),
      expectedRecipient: 'GfFAJnHnSgP7C2FQZLz6ogpdTV6Y7259f83qFFm9wxKm',
      amount: { chainId: 'solana-mainnet', assetId: PRODUCTION_ADMISSION_SETTLEMENT_MINT, decimals: 6, amountAtomic: '10' },
      allowedTargets: [],
      allowedPrograms: [TOKEN_PROGRAM_ID],
    },
    // Never evaluated by the two resolver-refusal cases below: the resolver refuses before decode
    // reaches policy evaluation at all. Kept non-empty only to satisfy `explicitRules`.
    rules: [{ id: 'production-purchase-fixture-rule' }],
  };
}

/** A real composed production-profile purchase: real compose/service/stage-driver, a durable
 * canonical admission pinned to the fixed production routes above, an independently pinned
 * transaction policy, and fake EVM/archive/Solana RPC boundaries -- exactly the pattern other
 * production compose fixtures in this file use (`throwingAdapters`, `liveObservabilityConfig`,
 * `createTestProfileMutationAuthority`). Predecessor stages are seeded directly into the repository
 * so this isolates purchase, exactly as `composedCollectorOnlyPurchaseAttempt` does above. */
async function composedProductionPurchaseAttempt(t, { latestBlockhash, transactionBlockhash, invalidFromCall = null, purchasePolicy = pinnedPurchaseTransactionPolicy() }) {
  const operator = PRODUCTION_ADMISSION_SOLANA;
  const asset = { chainId: 'solana-mainnet', assetId: CIRCLE_USD_MINT, decimals: CIRCLE_USD_DECIMALS };
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  // `livePolicyPatch`'s caps (maxUnitPriceMicroUsd/maxCycleBudgetMicroUsd/max24HourBudgetMicroUsd:
  // '10', lossCapMicroUsd/maxOutstandingCustodyMicroUsd: '20') are used unchanged: the admission
  // below commits 10 wei separately from its quoted 7 microdollar cost, within those caps.
  await writeOperatorState(statePath, livePolicyPatch('base-pack'));
  const amountAtomic = '10';
  const cycle = await seedCycle(stateDir, {
    releaseAmount: amountAtomic,
    mode: 'production',
    providerMode: 'live',
    completedStages: [
      { stage: 'eligibility-snapshot' },
      { stage: 'claim-process' },
      { stage: 'outbound' },
    ],
    releaseCostMicroUsd: '7',
    admission: cycleId => pinnedProductionPurchaseAdmission({ cycleId, packId: 'base-pack', amountAtomic }),
  });

  const calls = { generatePack: 0, sign: 0, submitTransaction: 0 };
  const composition = await compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid', chainId: 'solana-mainnet' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: {
      baseUrl: 'https://example.invalid',
      settlementAsset: asset,
      packPrice: { ...asset, amountAtomic },
      purchase: { policy: purchasePolicy },
    },
    execution: { profile: 'production', networkProfile: 'mainnet', providerMode: 'live', enforceProfile: true },
    contracts: { vault: null, hook: null, eth: PRODUCTION_ADMISSION_ETH, ethDecimals: 18 },
    accounts: { evm: PRODUCTION_ADMISSION_EVM, solana: operator },
    pack: { code: 'base-pack' },
    moneyConfiguration: productionPurchaseMoneyConfiguration(),
    execution: { profile: 'production', networkProfile: 'mainnet', providerMode: 'live', enforceProfile: true },
    preflightAuthority: createTestProfileMutationAuthority(),
    nativePaymentBinding: createTestNativePaymentBinding({ schema: 'hookemon.native-payment-binding.v1', chainId: '4663', hook: { address: `0x${'8'.repeat(40)}`, runtimeHash: keccak256('0x6000') }, relay: null }, createTestProfileMutationAuthority()),
    observability: liveObservabilityConfig(['solana']),
    observabilityDeps: {
      ...liveObservabilityDeps(),
      readers: {
        async readNativePrincipalIdentity() { return { chainId: '4663', assetId: 'native', decimals: 18 }; },
        async readNativeBalance(reserve) { return { ...reserve, amountAtomic: '1000000000000000000' }; },
      },
    },
    adapters: {
      collectorCrypt: {
        async getMachines() { return { machines: [{ code: 'base-pack', price: '0.00001', contains: 1 }] }; },
        async getStatus() { return { machineStatus: 'ok', gachas: [] }; },
        async generatePack({ playerAddress }) {
          calls.generatePack += 1;
          assert.equal(playerAddress, operator);
          return {
            memo: 'memo-production-purchase',
            transaction: realUnsignedPurchaseTransaction({ operator, recentBlockhash: transactionBlockhash }),
          };
        },
        submitTransaction: () => {
          calls.submitTransaction += 1;
          throw new Error('submitTransaction must never be reached before the pinned policy explicitly allows this transaction');
        },
      },
      relay: {
        quoteOutboundBridge: () => { throw new Error('unused: outbound is already seeded complete'); },
        quoteReturnBridge: () => { throw new Error('unused'); },
        simulateExecution: () => { throw new Error('unused'); },
        prepareExecution: () => { throw new Error('unused'); },
      },
      robinhood: {
        client: {
          async getChainId() { return 4663; },
          async readContract() { return { requirementsRevision: 0n, chainId: 4663n }; },
        },
        historicalEvidenceClient: { async readErc20BalanceAtBlock() { return { value: '0' }; } },
      },
      solana: { client: collectorOnlyPurchaseSolanaClient({ operator, latestBlockhash, invalidFromCall }) },
    },
    signerClient: {
      solana: {
        probe: async () => ({ ready: true }),
        async sign() { calls.sign += 1; throw new Error('signer must never be reached before the pinned policy explicitly allows this transaction'); },
      },
    },
    now: () => 1_000,
  });
  t.after(() => composition.shutdown());

  // Predecessor stages above are seeded directly into the repository (this test isolates purchase),
  // but the policy engine's own claim-process ledger entry is not a byproduct of that -- it is what
  // lets the purchase boundary find `existingCycle(...)` instead of refusing CYCLE_POLICY_MISSING
  // before purchase's own handler ever runs. `admission: cycle.admission` matches exactly what
  // `automated-cycle-service.mjs` re-presents at every later execution boundary for an admitted
  // cycle, so the recorded spend reservation's digest keeps matching.
  const admission = await composition.policyEngine.admit({
    boundary: 'claim-process',
    cycleId: cycle.cycleId,
    releaseAmountWei: cycle.releaseAmount,
    releaseCostMicroUsd: cycle.releaseCostMicroUsd,
    packId: 'base-pack',
    liveMode: true,
    mode: 'production',
    admission: cycle.admission,
  });
  assert.equal(admission.allowed, true);

  const error = await composition.service.recoverActiveCycle({ liveMode: true }).then(
    () => null,
    caught => caught,
  );
  return { error, calls, composition, cycle };
}

test('a composed production purchase refuses at the trusted resolver before any signer or submit call, on a stale provider blockhash', async t => {
  const { error, calls } = await composedProductionPurchaseAttempt(t, {
    latestBlockhash: 'SysvarC1ock11111111111111111111111111111111',
    transactionBlockhash: 'SysvarRecentB1ockHashes11111111111111111111',
    invalidFromCall: 1,
  });

  assert.match(
    error?.message ?? '',
    /Solana blockhashContextResolver failed: original blockhash is not valid/,
  );
  assert.equal(calls.generatePack, 1, 'decode must reach the resolver only after the single-pack call and candidate transaction exist');
  assert.equal(calls.sign, 0);
  assert.equal(calls.submitTransaction, 0);
});

test('a composed production purchase refuses at the trusted resolver before any signer or submit call, when RPC marks the original blockhash unusable', async t => {
  const blockhash = 'SysvarC1ock11111111111111111111111111111111';
  const { error, calls } = await composedProductionPurchaseAttempt(t, {
    latestBlockhash: blockhash,
    transactionBlockhash: blockhash,
    // Unlike the collector-only rehearsal path, production purchase has no separate startup canary
    // consuming an earlier `isBlockhashValid` call -- call 1 is the resolver's own internal
    // original-hash validity observation during decode, so that is the one this test rejects.
    invalidFromCall: 1,
  });

  assert.match(
    error?.message ?? '',
    /Solana blockhashContextResolver failed: original blockhash is not valid/,
  );
  assert.equal(calls.generatePack, 1, 'decode must reach the resolver only after the single-pack call and candidate transaction exist');
  assert.equal(calls.sign, 0);
  assert.equal(calls.submitTransaction, 0);
});

test('a composed production purchase advances past the trusted resolver on a valid older blockhash, refusing only at the genuine next pinned-policy boundary', async t => {
  const blockhash = 'SysvarC1ock11111111111111111111111111111111';
  const { error, calls } = await composedProductionPurchaseAttempt(t, {
    latestBlockhash: 'SysvarRecentB1ockHashes11111111111111111111',
    transactionBlockhash: blockhash,
  });

  assert.equal(calls.generatePack, 1, 'the resolver match must let the single-pack call and decode actually happen');
  // The pinned fixture policy (`pinnedPurchaseTransactionPolicy`) is configured and accepted by
  // `requirePolicy` before generatePack -- the single-pack call above already proves that -- so the
  // refusal below is the real next boundary the decoded candidate transaction meets: the policy's
  // independently authored `expectedRecipient` does not name this fixture's actual self-transfer
  // settlement destination.
  assert.match(error?.message ?? '', /canonical policy expectedRecipient is not explicitly allowed/);
  assert.equal(calls.sign, 0);
  assert.equal(calls.submitTransaction, 0);
});

test('compose refuses a production profile without MoneyConfigurationV2 before opening durable state', async t => {
  const stateDir = await tempStateDir(t);
  await assert.rejects(
    () => compose({
      stateDir,
      statePath: join(stateDir, 'operator-state.json'),
      workerOwner: 'test-worker',
      leaseTtlMs: 30_000,
      execution: { profile: 'production', networkProfile: 'mainnet', providerMode: 'live', enforceProfile: true },
    }),
    MoneyConfigurationRejected,
  );
  assert.deepEqual(await readdir(stateDir), []);
});

test('compose requires a distinct archive-capable historical evidence client for production', async t => {
  const productionConfig = async adapters => {
    const stateDir = await tempStateDir(t);
    return {
      stateDir,
      statePath: join(stateDir, 'operator-state.json'),
      workerOwner: 'test-worker',
      leaseTtlMs: 30_000,
      robinhood: { rpcUrl: 'https://example.invalid' },
      solana: { rpcUrl: 'https://example.invalid' },
      relay: { baseUrl: 'https://example.invalid' },
      collectorCrypt: { baseUrl: 'https://example.invalid' },
      moneyConfiguration: productionMoneyConfiguration(),
      execution: { profile: 'production', networkProfile: 'mainnet', providerMode: 'live', enforceProfile: true },
      adapters,
    };
  };

  const missing = throwingAdapters();
  delete missing.robinhood.historicalEvidenceClient;
  const missingConfig = await productionConfig(missing);
  await assert.rejects(
    () => compose(missingConfig),
    /production requires an archive-capable historical evidence client/,
  );
  assert.deepEqual(await readdir(missingConfig.stateDir), []);

  const latestOnly = throwingAdapters();
  latestOnly.robinhood.client.readErc20BalanceAtBlock = async () => ({ value: '0' });
  latestOnly.robinhood.historicalEvidenceClient = latestOnly.robinhood.client;
  const latestOnlyConfig = await productionConfig(latestOnly);
  await assert.rejects(
    () => compose(latestOnlyConfig),
    /must be distinct from the public Robinhood RPC client/,
  );
  assert.deepEqual(await readdir(latestOnlyConfig.stateDir), []);

  const archiveEvidenceClient = {
    async readErc20BalanceAtBlock() {
      return { value: '0' };
    },
  };
  const configured = throwingAdapters();
  delete configured.robinhood.historicalEvidenceClient;
  const configuredConfig = await productionConfig(configured);
  configuredConfig.historicalEvidenceClient = archiveEvidenceClient;
  const composition = await compose(configuredConfig);
  t.after(() => composition.shutdown());

  assert.equal(composition.adapters.robinhood.historicalEvidenceClient, archiveEvidenceClient);
});

test('production composition wires its own owned cycle-attributable payout-availability reader over any injected same-named client method', async t => {
  const stateDir = await tempStateDir(t);
  const adapters = throwingAdapters();
  const injectedSelfAttestation = async () => ({
    chainId: '4663', assetId: `0x${'9'.repeat(40)}`, decimals: 6, amountAtomic: '999999999999999999',
  });
  adapters.robinhood.client.readCycleAttributableFinalizedAvailable = injectedSelfAttestation;
  const composition = await compose({
    stateDir,
    statePath: join(stateDir, 'operator-state.json'),
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    moneyConfiguration: productionMoneyConfiguration(),
    execution: { profile: 'production', networkProfile: 'mainnet', providerMode: 'live', enforceProfile: true },
    adapters,
  });
  t.after(() => composition.shutdown());

  const composedReader = composition.adapters.robinhood.client.readCycleAttributableFinalizedAvailable;
  assert.notEqual(composedReader, injectedSelfAttestation);
  // An untrusted injected client can never self-attest its own cycle-attributable availability:
  // the composed method is the real owned reader, proven by its distinct refusal vocabulary
  // rather than the injected fixture's fixed resolved amount.
  await assert.rejects(() => composedReader({}), /payout-availability reader refuses/);
});

test('compose constructs archive evidence from a distinct configured archive RPC when no explicit client is injected', async t => {
  const stateDir = await tempStateDir(t);
  const adapters = throwingAdapters();
  delete adapters.robinhood.historicalEvidenceClient;
  await assert.rejects(
    () => compose({
      stateDir,
      statePath: join(stateDir, 'operator-state.json'),
      workerOwner: 'test-worker',
      leaseTtlMs: 30_000,
      robinhood: {
        rpcUrl: 'https://public-rpc.example.test',
        archiveRpcUrl: 'https://public-rpc.example.test',
      },
      solana: { rpcUrl: 'https://solana-rpc.example.test' },
      relay: { baseUrl: 'https://relay.example.test' },
      collectorCrypt: { baseUrl: 'https://collector.example.test' },
      moneyConfiguration: productionMoneyConfiguration(),
      execution: { profile: 'production', networkProfile: 'mainnet', providerMode: 'live', enforceProfile: true },
      adapters,
    }),
    /archiveRpcUrl must be distinct from robinhood.rpcUrl/,
  );
  const composition = await compose({
    stateDir,
    statePath: join(stateDir, 'operator-state.json'),
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: {
      rpcUrl: 'https://public-rpc.example.test',
      archiveRpcUrl: 'https://archive-rpc.example.test',
    },
    solana: { rpcUrl: 'https://solana-rpc.example.test' },
    relay: { baseUrl: 'https://relay.example.test' },
    collectorCrypt: { baseUrl: 'https://collector.example.test' },
    moneyConfiguration: productionMoneyConfiguration(),
    execution: { profile: 'production', networkProfile: 'mainnet', providerMode: 'live', enforceProfile: true },
    adapters,
  });
  t.after(() => composition.shutdown());
  assert.equal(typeof composition.adapters.robinhood.historicalEvidenceClient.readErc20BalanceAtBlock, 'function');
  assert.notEqual(composition.adapters.robinhood.historicalEvidenceClient, composition.adapters.robinhood.client);
});

test('production composition persists an already-authorized standing-authority decision before its guarded signing boundary', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  const authorityFixture = createProductionTestFixture({ moneyConfiguration: productionMoneyConfiguration() });
  const packCode = authorityFixture.standingAuthority.allowedPacks[0];
  await writeOperatorState(statePath, livePolicyPatch(packCode));

  let signCalls = 0;
  let issuedAuthorization = null;
  const completed = new Set();
  const stageHandlers = Object.fromEntries(AUTOMATED_CYCLE_STAGES.map(stage => [stage, {
    async probe() { return null; },
    async prepareRequest({ config }) {
      assert.equal('standingAuthorityStepAuthorization' in config, false);
      assert.equal(config.standingAuthority.provider, undefined);
      return { stage, request: 'composition-standing-authority-test' };
    },
    async mutate({ context, signerClient }) {
      if (stage === 'outbound') {
        await signerClient.evm.sign({ transaction: { stage, cycleId: context.cycleId } });
      }
      completed.add(stage);
      return { stage, finalized: true };
    },
    async reconcileLive() {
      return completed.has(stage) ? { stage, finalized: true } : null;
    },
  }]));

  const seeded = await seedCycle(stateDir, { releaseAmount: '1', releaseCostMicroUsd: '7', providerMode: 'live',
    admission: cycleId => pinnedProductionPurchaseAdmission({ cycleId, packId: packCode, amountAtomic: '1' }),
    completedStages: [{ stage: 'eligibility-snapshot' }, { stage: 'claim-process' }] });
  const composition = await compose({
    stateDir,
    statePath,
    now: () => 1_000,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    pack: { code: packCode },
    budget: SUFFICIENT_BUDGET,
    contracts: {
      eth: productionMoneyConfiguration().assets.eth.assetId,
      ethDecimals: 18,
    },
    moneyConfiguration: productionMoneyConfiguration(),
    execution: { profile: 'production', networkProfile: 'mainnet', providerMode: 'live', enforceProfile: true },
    adapters: throwingAdapters(),
    signerClient: {
      evm: {
        async probe() { return { ready: true }; },
        async sign() {
          signCalls += 1;
          return { signedTx: 'not-a-real-signature' };
        },
      },
      solana: { async probe() { return { ready: true }; } },
    },
    observability: liveObservabilityConfig(['evm', 'solana']),
    observabilityDeps: {
      ...liveObservabilityDeps(),
      readers: {
        async readNativePrincipalIdentity() { return { chainId: '4663', assetId: 'native', decimals: 18 }; },
        async readNativeBalance(reserve) { return { ...reserve, amountAtomic: '1000000000000000000' }; },
      },
    },
    preflightAuthority: createTestProfileMutationAuthority(),
    standingAuthority: {
      ...authorityFixture.standingAuthority,
      provider: authorityFixture.standingAuthorityProvider,
    },
    standingAuthorityStepAuthorization({ cycleId, stage, authorizationKind, requestDigest }) {
      assert.equal(stage, 'outbound');
      assert.equal(authorizationKind, 'sign');
      assert.match(requestDigest, /^sha256:[0-9a-f]{64}$/);
      issuedAuthorization ??= buildAndSignStepAuthorization(authorityFixture, {
        cycleId,
        actionKind: 'outbound',
        authorizationKind: 'sign',
        subjectDigest: requestDigest,
        destination: authorityFixture.standingAuthority.allowedDestinations[0],
        pack: packCode,
        spendAmount: '10',
        nonce: 'compose-standing-authority-sign',
      });
      return issuedAuthorization;
    },
    stageHandlers,
  });
  t.after(() => composition.shutdown());

  const allowed = await composition.policyEngine.admit({ boundary: 'claim-process', cycleId: seeded.cycleId, packId: packCode, releaseAmountWei: '1', releaseCostMicroUsd: '7', admission: seeded.admission, liveMode: true, mode: 'production' });
  assert.equal(allowed.allowed, true);
  const outcome = await composition.service.recoverActiveCycle({ liveMode: true });
  assert.equal(outcome.status, 'COMPLETE');
  assert.equal(signCalls, 1, 'the test signer is reached only after authority persistence');
  assert.notEqual(issuedAuthorization, null);

  const repository = await CycleRepository.open(join(stateDir, 'cycles'));
  const decision = await repository.readStandingAuthorityDecision(
    outcome.cycleId,
    stepAuthorizationIntentDigest(issuedAuthorization),
  );
  assert.equal(decision.authorityDigest, authorityFixture.standingAuthority.documentDigest);
  assert.equal(decision.nonceReservation.nonce, 'compose-standing-authority-sign');
});

test('a production-profile fake dry run reaches return and payout without a signer or provider mutation', async t => {
  const stateDir = await tempStateDir(t);
  const reached = [];
  let mutationCalls = 0;
  let signCalls = 0;
  let broadcastCalls = 0;
  const stageHandlers = Object.fromEntries(AUTOMATED_CYCLE_STAGES.map(stage => [stage, {
    async probe({ context }) {
      reached.push(context.stage);
      return { stage: context.stage, observation: 'dry-run' };
    },
    async mutate() {
      mutationCalls += 1;
      throw new Error('dry-run must not invoke a stage mutation');
    },
    async reconcileLive() { return null; },
  }]));
  const composition = await compose({
    stateDir,
    statePath: join(stateDir, 'operator-state.json'),
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid', archiveRpcUrl: 'https://archive.example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    pack: { code: 'dry-run-pack' },
    budget: SUFFICIENT_BUDGET,
    contracts: {
      eth: productionMoneyConfiguration().assets.eth.assetId,
      ethDecimals: 18,
    },
    moneyConfiguration: productionMoneyConfiguration(),
    execution: {
      profile: 'production',
      networkProfile: 'mainnet',
      providerMode: 'fake',
      dryRun: true,
      enforceProfile: true,
    },
    adapters: throwingAdapters(),
    signerClient: {
      evm: {
        async sign() { signCalls += 1; },
        async broadcast() { broadcastCalls += 1; },
      },
    },
    stageHandlers,
  });
  t.after(() => composition.shutdown());

  const outcome = await composition.service.runOnce({ liveMode: false });
  assert.equal(outcome.status, 'COMPLETE');
  assert.ok(reached.includes('return'));
  assert.ok(reached.includes('payout'));
  assert.equal(mutationCalls, 0);
  assert.equal(signCalls, 0);
  assert.equal(broadcastCalls, 0);
});

test('compose refuses an uncapped relay-roundtrip rehearsal before opening durable state', async t => {
  const stateDir = await tempStateDir(t);
  const config = {
    stateDir,
    statePath: join(stateDir, 'operator-state.json'),
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    rehearsal: {
      mode: 'relay-roundtrip',
      proceedsAccount: '11111111111111111111111111111111',
    },
  };
  for (const rehearsalCapMicroUsd of [undefined, '0']) {
    await assert.rejects(
      () => compose({
        ...config,
        execution: {
          profile: 'rehearsal', networkProfile: 'mainnet', providerMode: 'fake', enforceProfile: true, rehearsalCapMicroUsd,
        },
      }),
      /relay-roundtrip rehearsal requires a positive explicit rehearsalCapMicroUsd/,
    );
  }
  await assert.rejects(
    () => compose({
      ...config,
      execution: {
        profile: 'rehearsal', networkProfile: 'mainnet', providerMode: 'fake', enforceProfile: true, rehearsalCapMicroUsd: '30',
      },
    }),
    MoneyConfigurationRejected,
  );
  assert.deepEqual(await readdir(stateDir), []);
});

test('compose fails closed on an injected network identity mismatch before opening durable state', async t => {
  const stateDir = await tempStateDir(t);
  const input = {
    stateDir,
    statePath: join(stateDir, 'operator-state.json'),
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
  };

  for (const [label, identity, expected] of [
    ['EVM mismatch', networkIdentity({ evmChainId: 1 }), /EVM network identity mismatch/i],
    ['unavailable EVM identity', networkIdentity({ evmError: new Error('unavailable') }), /EVM network identity unavailable/i],
    ['Solana mismatch', networkIdentity({ solanaGenesisHash: 'wrong-genesis-hash' }), /Solana network identity mismatch/i],
    ['unavailable Solana identity', networkIdentity({ solanaError: new Error('unavailable') }), /Solana network identity unavailable/i],
  ]) {
    await assert.rejects(
      compose({ ...input, adapters: minimalInjectedAdapters(), networkIdentity: identity }),
      expected,
      label,
    );
    assert.deepEqual(await readdir(stateDir), [], `${label} must reject before durable state is opened`);
  }

  await assert.rejects(
    composeRoot({ ...input, adapters: minimalInjectedAdapters() }),
    /injected network identity unavailable/i,
  );
  assert.deepEqual(await readdir(stateDir), [], 'an injected adapter without identity must reject before durable state is opened');
});

function throwingSignerClient() {
  return {
    evm: {
      probe: async () => ({ ready: true }),
      sign: () => { throw new Error('signerClient.evm.sign must never be called in dry-run'); },
    },
    solana: {
      probe: async () => ({ ready: true }),
      sign: () => { throw new Error('signerClient.solana.sign must never be called in dry-run'); },
    },
  };
}

test('compose dashboard identities expose exactly the read-only, secret-free identity fields', async t => {
  const stateDir = await tempStateDir(t);
  const composition = await compose({
    stateDir,
    statePath: join(stateDir, 'operator-state.json'),
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    dashboard: { proxyCredential: DASHBOARD_CREDENTIAL, sqlitePath: ':memory:' },
  });
  t.after(() => composition.shutdown());

  const expectedKeys = [
    'treasuryAddress', 'vaultAddress', 'hookAddress', 'hkmnAddress', 'poolAddress',
    'evmAccount', 'solanaAccount', 'signerBackend',
    'distributionProfile', 'distributionSignerAddress', 'distributionVerifierAddress',
    'collectorCryptConfigured', 'relayConfigured', 'rehearsalMode',
  ];
  const identities = composition.dashboard.ctx.identities;
  assert.deepEqual(Object.keys(identities).sort(), [...expectedKeys].sort());
  assert.equal(Object.getPrototypeOf(identities), Object.prototype);
  assert.equal(Object.isFrozen(identities), true);
  assert.equal(Object.keys(identities).some(key => /apiKey|credential|keychain/i.test(key)), false);
});

test('compose exposes one repository-backed cycle client instead of a bare runner stub', async t => {
  const stateDir = await tempStateDir(t);
  const cycle = await seedCycle(stateDir, { releaseAmount: '1' });
  const composition = await compose({
    stateDir,
    statePath: join(stateDir, 'operator-state.json'),
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
  });
  t.after(() => composition.shutdown());

  assert.deepEqual(CYCLE_REPOSITORY_CLIENT_INTERFACE, [
    'readActiveCycle', 'peekActiveCycle', 'readStage', 'describeCycle', 'readOperationalStageAttempt',
    'readChainTransactionAttempt', 'readClaimPreconditions', 'readHeldPosition', 'readHeldPositionEvidence', 'listHeldPositions',
    'readSupplementarySettlement', 'listKnownCycleIds', 'readOutboundQuoteRefresh', 'readFinalizedClaimCustodyEvidence',
    'readPagedPayoutState',
  ]);
  assert.equal(assertCycleRepositoryClientInterface(composition.cycleRepository), composition.cycleRepository);
  assert.deepEqual(Object.keys(composition.cycleRepository).sort(), [...CYCLE_REPOSITORY_CLIENT_INTERFACE].sort());
  assert.equal(Object.isFrozen(composition.cycleRepository), true);
  const runner = composition.createCycleRunner(cycle.cycleId);
  assert.equal(runner.cycleId, cycle.cycleId);
  assert.notEqual(runner.repository, composition.cycleRepository);
  assert.deepEqual(Object.keys(runner.repository).sort(), [...CYCLE_REPOSITORY_CLIENT_INTERFACE].sort());
  assert.equal(Object.isFrozen(runner.repository), true);
  assert.equal(typeof runner.repository.createCycle, 'undefined');
  assert.equal(typeof runner.repository.holdCycle, 'undefined');
  assert.deepEqual(await runner.readStage('eligibility-snapshot'), { status: 'PENDING' });
});

test('compose keeps cycle repository writers private from callers and dashboard context', async t => {
  const stateDir = await tempStateDir(t);
  const composition = await compose({
    stateDir,
    statePath: join(stateDir, 'operator-state.json'),
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    dashboard: { proxyCredential: DASHBOARD_CREDENTIAL, sqlitePath: ':memory:' },
  });
  t.after(() => composition.shutdown());

  assert.equal(assertCycleRepositoryClientInterface(composition.cycleRepository), composition.cycleRepository);
  assert.deepEqual(Object.keys(composition.cycleRepository).sort(), [...CYCLE_REPOSITORY_CLIENT_INTERFACE].sort());
  assert.equal(Object.isFrozen(composition.cycleRepository), true);
  assert.equal(typeof composition.cycleRepository.createCycle, 'undefined');
  assert.equal(typeof composition.cycleRepository.completeCycle, 'undefined');
  assert.equal(composition.dashboard.ctx.cycleRepository, composition.cycleRepository);
});

test('compose reads the persisted kill switch before it creates a live cycle', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath, {
    liveMode: true,
    allowedPackIds: ['base-pack'],
    requestedOrders: 1,
    maxUnitPriceMicroUsd: '1',
    maxCycleBudgetMicroUsd: '1',
    max24HourBudgetMicroUsd: '1',
    maxCyclesPerDay: 1,
    lossCapMicroUsd: '1',
    maxOutstandingCustodyMicroUsd: '1',
    killSwitch: true,
  });
  const composition = await compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    pack: { code: 'base-pack' },
    budget: SUFFICIENT_BUDGET,
    adapters: throwingAdapters(),
    signerClient: throwingSignerClient(),
    observability: liveObservabilityConfig(),
    observabilityDeps: liveObservabilityDeps(),
  });
  t.after(() => composition.shutdown());

  assert.deepEqual(await composition.service.runOnce({ liveMode: true }), {
    status: 'POLICY_REFUSED', cycleId: null, stage: null, reason: 'KILL_SWITCH',
  });
  assert.equal(await composition.cycleRepository.readActiveCycle(), null);
});

test('compose refuses a live service call when the configured observability preflight fails before signing', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath, livePolicyPatch('base-pack'));
  let signCalls = 0;
  const composition = await compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    pack: { code: 'base-pack' },
    budget: SUFFICIENT_BUDGET,
    adapters: throwingAdapters(),
    signerClient: {
      evm: {
        probe: async () => ({ ready: true }),
        async sign() { signCalls += 1; },
      },
      solana: {
        probe: async () => ({ ready: true }),
        async sign() { signCalls += 1; },
      },
    },
    observability: {
      canaries: null,
      alert: { webhookUrl: 'https://alerts.example.test/hooks', dedupePath: ':memory:' },
      startPreflight: { requiredSignerRoles: ['evm', 'solana'], requireEvmRpc: false, requireSolanaRpc: false },
    },
    observabilityDeps: {
      fetchImpl: async () => ({ ok: true, status: 204 }),
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    },
  });
  t.after(() => composition.shutdown());

  await assert.rejects(
    () => composition.service.runOnce({ liveMode: true }),
    /observability start preflight failed: CONFIG_INCOMPLETE/,
  );
  assert.equal(signCalls, 0);
  assert.equal(await composition.cycleRepository.readActiveCycle(), null);
});

async function createNativeStatusCanaryFixture(t, { wrongIdentity, insufficientBalance }) {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath, livePolicyPatch('base-pack'));
  const cycle = await seedCycle(stateDir, {
    releaseAmount: '1',
    mode: 'production',
    providerMode: 'live',
    releaseCostMicroUsd: '7',
    admission: cycleId => pinnedProductionPurchaseAdmission({ cycleId, packId: 'base-pack', amountAtomic: '1' }),
    completedStages: [
      { stage: 'eligibility-snapshot' },
      { stage: 'claim-process' },
    ],
  });
  const calls = { mutate: 0, sign: 0, broadcast: 0 };
  const stageHandlers = Object.fromEntries(AUTOMATED_CYCLE_STAGES.map(stage => [stage, {
    async probe() { throw new Error(`${stage} probe must not run after a native principal failure`); },
    async prepareRequest() { return { stage, request: 'status-canary-test' }; },
    async mutate() {
      calls.mutate += 1;
      throw new Error(`${stage} mutation must not run after a native principal failure`);
    },
    async reconcileLive() { return null; },
  }]));
  const composition = await compose({
    stateDir,
    statePath,
    now: () => 1_000,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid', archiveRpcUrl: 'https://archive.example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    pack: { code: 'base-pack' },
    budget: SUFFICIENT_BUDGET,
    contracts: {
      eth: productionMoneyConfiguration().assets.eth.assetId,
      ethDecimals: 18,
    },
    moneyConfiguration: productionMoneyConfiguration(),
    execution: { profile: 'production', networkProfile: 'mainnet', providerMode: 'live', enforceProfile: true },
    adapters: throwingAdapters(),
    signerClient: {
      evm: {
        async probe() { return { ready: true }; },
        async sign() { calls.sign += 1; },
        async broadcast() { calls.broadcast += 1; },
      },
      solana: {
        async probe() { return { ready: true }; },
        async sign() { calls.sign += 1; },
        async broadcast() { calls.broadcast += 1; },
      },
    },
    observability: liveObservabilityConfig(['evm', 'solana']),
    observabilityDeps: {
      ...liveObservabilityDeps(),
      readers: {
        async readNativePrincipalIdentity() { return { chainId: '4663', assetId: wrongIdentity ? 'wrong-native' : 'native', decimals: 18 }; },
        async readNativeBalance(reserve) { return { ...reserve, amountAtomic: insufficientBalance ? '1' : '100' }; },
      },
    },
    stageHandlers,
    preflightAuthority: createTestProfileMutationAuthority(),
  });
  const admission = await composition.policyEngine.admit({
    boundary: 'claim-process',
    cycleId: cycle.cycleId,
    releaseAmountWei: cycle.releaseAmount,
    releaseCostMicroUsd: cycle.releaseCostMicroUsd,
    admission: cycle.admission,
    packId: 'base-pack',
    liveMode: true,
    mode: 'production',
  });
  assert.equal(admission.allowed, true);
  t.after(() => composition.shutdown());
  return { calls, composition, cycle, stateDir };
}

test('holds an active cycle on a wrong native principal identity before any signing boundary', async t => {
  const { calls, composition, cycle, stateDir } = await createNativeStatusCanaryFixture(t, {
    wrongIdentity: true,
    insufficientBalance: false,
  });

  await assert.rejects(
    () => composition.service.recoverActiveCycle({ liveMode: true }),
    /native principal canary failed: NATIVE_PRINCIPAL_UNVERIFIED/,
  );
  assert.deepEqual(calls, { mutate: 0, sign: 0, broadcast: 0 });

  const reopened = await CycleRepository.open(join(stateDir, 'cycles'));
  const description = await reopened.describeCycle(cycle.cycleId);
  assert.equal(description.terminalState, 'HELD_UNAVAILABLE');
  assert.deepEqual(description.terminalEvidence, {
    schema: 'hookemon.native-status-canary-hold.v1',
    stage: 'outbound',
    drift: [{
      code: 'NATIVE_PRINCIPAL_UNVERIFIED',
      target: 'native principal',
      expected: '4663/native/18 balance covering principal and gas',
      observed: null,
    }],
  });
  assert.equal((await reopened.readStage(cycle.cycleId, 'outbound')).status, 'PENDING');
  assert.equal(await reopened.readOperationalStageAttempt(cycle.cycleId, 'outbound'), null);
  await assert.rejects(
    () => reopened.prepareStage(cycle.cycleId, 'outbound'),
    /terminal/,
  );
});

test('holds an active cycle on insufficient native principal plus gas before any signing boundary', async t => {
  const { calls, composition, cycle, stateDir } = await createNativeStatusCanaryFixture(t, {
    wrongIdentity: false,
    insufficientBalance: true,
  });

  await assert.rejects(
    () => composition.service.recoverActiveCycle({ liveMode: true }),
    /native principal canary failed: NATIVE_PRINCIPAL_UNVERIFIED/,
  );
  assert.deepEqual(calls, { mutate: 0, sign: 0, broadcast: 0 });

  const reopened = await CycleRepository.open(join(stateDir, 'cycles'));
  const description = await reopened.describeCycle(cycle.cycleId);
  assert.equal(description.terminalState, 'HELD_UNAVAILABLE');
  assert.deepEqual(description.terminalEvidence, {
    schema: 'hookemon.native-status-canary-hold.v1',
    stage: 'outbound',
    drift: [{
      code: 'NATIVE_PRINCIPAL_UNVERIFIED',
      target: 'native principal',
      expected: '4663/native/18 balance covering principal and gas',
      observed: null,
    }],
  });
  assert.equal((await reopened.readStage(cycle.cycleId, 'outbound')).status, 'PENDING');
  assert.equal(await reopened.readOperationalStageAttempt(cycle.cycleId, 'outbound'), null);
  await assert.rejects(
    () => reopened.prepareStage(cycle.cycleId, 'outbound'),
    /terminal/,
  );
});

test('does not create or hold a cycle before an active cycle reaches the native principal boundary', async t => {
  const stateDir = await tempStateDir(t);
  let identityReads = 0;
  const composition = await compose({
    stateDir,
    statePath: join(stateDir, 'operator-state.json'),
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid', archiveRpcUrl: 'https://archive.example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    pack: { code: 'base-pack' },
    budget: SUFFICIENT_BUDGET,
    contracts: {
      eth: productionMoneyConfiguration().assets.eth.assetId,
      ethDecimals: 18,
    },
    moneyConfiguration: productionMoneyConfiguration(),
    execution: { profile: 'production', networkProfile: 'mainnet', providerMode: 'live', enforceProfile: true },
    adapters: throwingAdapters(),
    signerClient: {
      evm: { async probe() { return { ready: true }; } },
      solana: { async probe() { return { ready: true }; } },
    },
    observability: liveObservabilityConfig(['evm', 'solana']),
    observabilityDeps: {
      ...liveObservabilityDeps(),
      readers: {
        async readNativePrincipalIdentity() { identityReads += 1; return { chainId: '1', assetId: 'native', decimals: 18 }; },
      },
    },
  });
  t.after(() => composition.shutdown());

  assert.deepEqual(await composition.service.runOnce({ liveMode: true }), {
    status: 'WAITING_FOR_PROCESS_BUDGET',
    cycleId: null,
    stage: null,
    requiredProcessWei: '1',
  });
  assert.equal(identityReads, 0);
  assert.equal(await composition.cycleRepository.readActiveCycle(), null);
});

test('compose refuses a live service call when observability is not configured', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath, livePolicyPatch('base-pack'));
  const composition = await compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    pack: { code: 'base-pack' },
    budget: SUFFICIENT_BUDGET,
    adapters: throwingAdapters(),
  });
  t.after(() => composition.shutdown());

  await assert.rejects(
    () => composition.service.runOnce({ liveMode: true }),
    /observability configuration is required before live service startup/,
  );
  assert.equal(await composition.cycleRepository.readActiveCycle(), null);
});

test('compose default profile enforcement refuses a live call without observability', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath, livePolicyPatch('base-pack'));
  const composition = await compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    pack: { code: 'base-pack' },
    budget: SUFFICIENT_BUDGET,
    adapters: throwingAdapters(),
  });
  t.after(() => composition.shutdown());

  await assert.rejects(
    () => composition.service.runOnce({ liveMode: true }),
    /observability configuration is required before live service startup/,
  );
  assert.equal(await composition.cycleRepository.readActiveCycle(), null);
});

test('explicit production readiness permits an activated automatic policy before signer construction', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath, livePolicyPatch('base-pack'));
  const composition = await compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    pack: { code: 'base-pack' },
    budget: SUFFICIENT_BUDGET,
    moneyConfiguration: productionMoneyConfiguration(),
    execution: { profile: 'production', networkProfile: 'mainnet', providerMode: 'live', enforceProfile: true },
    adapters: throwingAdapters(),
    signerReadiness: {
      'operator-evm': { probe: async () => ({ ready: true }) },
      'operator-solana': { probe: async () => ({ ready: true }) },
    },
    observability: liveObservabilityConfig(['operator-evm', 'operator-solana']),
    observabilityDeps: liveObservabilityDeps(),
  });
  t.after(() => composition.shutdown());

  assert.deepEqual(await composition.assertStartReadiness({
    liveMode: true, mode: 'production', requirePolicyConfiguration: true, requireCanaryPreflight: true,
  }), { cycleCount: 0, preflight: 'PASSED' });
});

test('explicit production readiness refuses an RPC that reports a different chain before signer construction', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath, livePolicyPatch('base-pack', { manualApprovalCycles: 3 }));
  const adapters = throwingAdapters();
  adapters.robinhood.client.getChainId = async () => 1;
  const composition = await compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    pack: { code: 'base-pack' },
    budget: SUFFICIENT_BUDGET,
    moneyConfiguration: productionMoneyConfiguration(),
    execution: { profile: 'production', networkProfile: 'mainnet', providerMode: 'live', enforceProfile: true },
    adapters,
    signerReadiness: {
      'operator-evm': { probe: async () => ({ ready: true }) },
      'operator-solana': { probe: async () => ({ ready: true }) },
    },
    observability: liveObservabilityConfig(['operator-evm', 'operator-solana']),
    observabilityDeps: liveObservabilityDeps(),
  });
  t.after(() => composition.shutdown());

  await assert.rejects(
    () => composition.assertStartReadiness({
      liveMode: true, mode: 'production', requirePolicyConfiguration: true, requireCanaryPreflight: true,
    }),
    /EVM RPC chain id must equal 4663/,
  );
});

test('compose scheduler refuses a live tick when observability is not configured', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath, livePolicyPatch('base-pack'));
  const events = [];
  const composition = await compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    pack: { code: 'base-pack' },
    budget: SUFFICIENT_BUDGET,
    adapters: throwingAdapters(),
    onTick: event => events.push(event),
  });
  t.after(() => composition.shutdown());

  const outcome = await composition.scheduler.triggerTick();

  assert.equal(outcome.result, undefined);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'TICK_FAILED');
  assert.match(events[0].error.message, /observability configuration is required before live service startup/);
  assert.equal(await composition.cycleRepository.readActiveCycle(), null);
});

test('a full dry-run cycle completes through the real scheduler, service, durable store, and stage driver, and leaves a written journal', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath);

  const composition = await compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    pack: { code: 'base-pack' },
    budget: SUFFICIENT_BUDGET,
    now: () => 1_000,
  });
  const outcome = await composition.scheduler.triggerTick();
  assert.equal(outcome.result?.status, 'COMPLETE');

  const active = await composition.cycleRepository.readActiveCycle();
  assert.equal(active, null, 'a completed cycle is archived, not left active');

  const archived = await readdir(join(stateDir, 'cycles', 'archive'));
  assert.equal(archived.length, 1, 'exactly one archived cycle journal file was written to disk');
});

test('liveMode false: a full dry-run cycle completes without ever reaching signerClient.sign/broadcast or any adapter mutation', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath);

  const composition = await compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    contracts: { vault: `0x${'1'.repeat(40)}`, hook: `0x${'2'.repeat(40)}` },
    accounts: { evm: `0x${'3'.repeat(40)}`, solana: 'PLAYER11111111111111111111111111111111111' },
    pack: { code: 'base-pack' },
    budget: SUFFICIENT_BUDGET,
    adapters: throwingAdapters(),
    signerClient: throwingSignerClient(),
    now: () => 1_000,
  });

  const result = await composition.service.runOnce({ liveMode: false });
  assert.equal(result.status, 'COMPLETE', 'every stage resolved via its read-only probe alone; no throwing stub was ever reached');
});

test('crash between stages: a second, independently-composed process resumes the same cycle at the right stage after the first process fails mid-cycle', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath);

  let outboundAttempts = 0;
  const sharedAdapters = {
    collectorCrypt: null,
    relay: {
      async quoteOutboundBridge() {
        outboundAttempts += 1;
        if (outboundAttempts === 1) throw new Error('simulated transient relay outage');
        return { requestId: 'req-1' };
      },
      simulateExecution({ quote }) { return { wouldExecute: true, requestId: quote.requestId }; },
      quoteReturnBridge: async () => { throw new Error('unused in this test'); },
      prepareExecution: () => { throw new Error('unused in this test'); },
    },
    robinhood: {
      client: {
        async readContract() { return { requirementsRevision: 0n, chainId: 4663n }; },
      },
    },
    solana: { client: {} },
  };

  const buildComposition = () => compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: {
      baseUrl: 'https://example.invalid',
      solanaMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      evmDepository: `0x${'4'.repeat(40)}`,
    },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    contracts: { vault: `0x${'1'.repeat(40)}`, hook: null },
    accounts: { evm: `0x${'3'.repeat(40)}`, solana: '11111111111111111111111111111111' },
    pack: { code: 'base-pack' },
    budget: SUFFICIENT_BUDGET,
    adapters: sharedAdapters,
    now: () => 1_000,
  });

  // "Process A": the first attempt completes the read-only eligibility and claim checks, then
  // fails while probing outbound.
  const processA = await buildComposition();
  await assert.rejects(() => processA.service.runOnce({ liveMode: false }), /simulated transient relay outage/);

  const afterCrash = await processA.cycleRepository.readActiveCycle();
  assert.notEqual(afterCrash, null, 'the cycle is still active — it never reached completeCycle()');
  const snapshotAfterCrash = await processA.cycleRepository.readStage(afterCrash.cycleId, 'eligibility-snapshot');
  assert.equal(snapshotAfterCrash.status, 'COMPLETE', 'eligibility snapshot durably completed before outbound failed');
  const claimAfterCrash = await processA.cycleRepository.readStage(afterCrash.cycleId, 'claim-process');
  assert.equal(claimAfterCrash.status, 'COMPLETE', 'claim-process durably completed before outbound failed');
  const outboundAfterCrash = await processA.cycleRepository.readStage(afterCrash.cycleId, 'outbound');
  assert.equal(outboundAfterCrash.status, 'PENDING', 'outbound never durably completed');

  // "Process B": an independently-constructed composition (a fresh CycleRepository/lease store
  // instance, opened from the same on-disk directory) picks the interrupted cycle back up and
  // finishes it, without ever redoing the eligibility snapshot.
  const processB = await buildComposition();
  const result = await processB.service.recoverActiveCycle({ liveMode: false });
  assert.equal(result.status, 'COMPLETE');
  assert.equal(result.cycleId, afterCrash.cycleId, 'the same cycle was resumed, not a new one');
  const snapshotAfterResume = await processB.cycleRepository.readStage(afterCrash.cycleId, 'eligibility-snapshot');
  assert.deepEqual(snapshotAfterResume, snapshotAfterCrash, 'the durably-completed snapshot evidence is unchanged by the resume');
});

test('liveMode true: native purchase refuses a missing pinned transaction policy before any provider call', async t => {
  const { error, calls } = await composedProductionPurchaseAttempt(t, {
    latestBlockhash: 'SysvarC1ock11111111111111111111111111111111',
    transactionBlockhash: 'SysvarC1ock11111111111111111111111111111111',
    purchasePolicy: null,
  });
  assert.match(error?.message ?? '', /Collector purchase requires a pinned transaction policy/);
  assert.deepEqual(calls, { generatePack: 0, sign: 0, submitTransaction: 0 });
});

test('liveMode true: the remaining pending operational integration refuses through the composed service loop', async t => {
  const boundaries = [
    { stage: 'epic-gate', predecessors: ['eligibility-snapshot', 'claim-process', 'outbound', 'purchase', 'open'] },
  ];

  for (const { stage, predecessors } of boundaries) {
    const stateDir = await tempStateDir(t);
    const statePath = join(stateDir, 'operator-state.json');
    await writeOperatorState(statePath, livePolicyPatch('base-pack'));
    const cycle = await seedCycle(stateDir, {
      releaseAmount: SUFFICIENT_BUDGET.packPriceWei,
    releaseCostMicroUsd: '7',
    admission: cycleId => pinnedProductionPurchaseAdmission({ cycleId, packId: 'base-pack', amountAtomic: SUFFICIENT_BUDGET.packPriceWei }),
      completedStages: predecessors.map(predecessor => ({ stage: predecessor })),
    });

    const composition = await compose({
      stateDir,
      statePath,
      workerOwner: 'test-worker',
      leaseTtlMs: 30_000,
      robinhood: { rpcUrl: 'https://example.invalid' },
      solana: { rpcUrl: 'https://example.invalid' },
      relay: { baseUrl: 'https://example.invalid' },
      collectorCrypt: { baseUrl: 'https://example.invalid' },
      contracts: { vault: null, hook: null, eth: FULL_ETH, ethDecimals: 18 },
      pack: { code: 'base-pack' },
      budget: SUFFICIENT_BUDGET,
    moneyConfiguration: productionMoneyConfiguration(),
    preflightAuthority: createTestProfileMutationAuthority(),
      adapters: throwingAdapters(),
      signerClient: throwingSignerClient(),
      observability: liveObservabilityConfig(),
      observabilityDeps: liveObservabilityDeps(),
      now: () => 1_000,
    });

    // The durable predecessors were seeded before composition so the service reaches this boundary
    // on its first live pass. Post-claim stages also need the policy reservation that a live claim
    // would have created.
    if (predecessors.includes('claim-process')) {
      const admission = await composition.policyEngine.admit({
        boundary: 'claim-process',
        cycleId: cycle.cycleId,
        releaseAmountWei: cycle.releaseAmount,
    releaseCostMicroUsd: cycle.releaseCostMicroUsd,
    admission: cycle.admission,
        packId: 'base-pack',
        liveMode: true,
      });
      assert.equal(admission.allowed, true, 'a post-claim stage needs the durable claim reservation');
    }
    // epic-gate now prepares a real request from its own durable predecessor evidence (stage-driver
    // "Collector-capable" preparation); the seeded "completed" `open` stage here carries no real
    // pack ledger, so epic-gate reaches its own genuine predecessor-evidence refusal rather than the
    // retired INTEGRATION_PENDING scaffolding.
    await assert.rejects(
      () => composition.service.recoverActiveCycle({ liveMode: true }),
      /epic gate requires a completed open stage with a pack ledger/,
      `stage "${stage}" must refuse through the real reconcile-then-execute path`,
    );
  }
});

test('the on-disk lease prevents a second runner from acting on the same state directory while the first holds it', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath);

  const composition = await compose({
    stateDir,
    statePath,
    workerOwner: 'runner-two',
    leaseTtlMs: 60_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    pack: { code: 'base-pack' },
    budget: SUFFICIENT_BUDGET,
    now: () => 1_000,
  });

  // Simulate "runner-one" already holding the lease (e.g. mid-cycle in another process) by
  // acquiring it directly against the same on-disk lease file this composition's own leaseStore
  // reads.
  const leaseStore = createFileLeaseStore(join(stateDir, 'lease.json'));
  acquireLease({ store: leaseStore, owner: 'runner-one', now: 1_000, ttlMs: 60_000 });

  const result = await composition.service.runOnce({ liveMode: false });
  assert.equal(result.status, 'LEASE_HELD');
  assert.equal(await composition.cycleRepository.readActiveCycle(), null, 'no cycle was created while the lease was held by another runner');
});

test('compose(config) with no config.dashboard composes no dashboard at all', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath);

  const composition = await compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    pack: { code: 'base-pack' },
    budget: SUFFICIENT_BUDGET,
    now: () => 1_000,
  });
  assert.equal(composition.dashboard, null);
  await composition.shutdown();
});

test('compose exposes one audit-bound operator facade for the installed CLI', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath);
  const composition = await compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    adapters: minimalInjectedAdapters(),
  });
  t.after(() => composition.shutdown());

  let effects = 0;
  const execute = () => composition.operatorControl.execute({
    expectedRevision: 0,
    requestId: 'cli-pause-1',
    command: { type: 'pause' },
  }).then(result => {
    effects += 1;
    return result;
  });
  const request = {
    requestId: 'cli-pause-1',
    expectedRevision: 0,
    command: { type: 'pause' },
    effect: execute,
  };

  const first = await composition.executeAudited(request);
  const replay = await composition.executeAudited(request);

  assert.equal(first.commandState, 'APPLIED');
  assert.equal(replay.replayed, true);
  assert.equal(effects, 1);
  assert.equal(
    (await readAllAuditEntries(join(stateDir, 'dashboard-audit.log'))).length,
    2,
    'the listener-free operator facade shares the dashboard audit log by default',
  );
});

test('compose respects the listener-free operator audit log override', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  const auditLogPath = join(stateDir, 'shared-dashboard-audit.log');
  await writeOperatorState(statePath);
  const composition = await compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    adapters: minimalInjectedAdapters(),
    operatorAuditLogPath: auditLogPath,
  });
  t.after(() => composition.shutdown());

  const result = await composition.executeAudited({
    requestId: 'cli-shared-audit-1',
    expectedRevision: 0,
    command: { type: 'pause' },
    effect: () => composition.operatorControl.execute({
      expectedRevision: 0,
      requestId: 'cli-shared-audit-1',
      command: { type: 'pause' },
    }),
  });

  assert.equal(composition.dashboard, null);
  assert.equal(result.commandState, 'APPLIED');
  assert.equal((await readAllAuditEntries(auditLogPath)).length, 2);
});

test('compose rejects a tampered dashboard audit chain before it builds the dashboard context', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  const auditLogPath = join(stateDir, 'dashboard-audit.log');
  await appendAuditEntry(auditLogPath, {
    eventId: 'tampered-audit-entry',
    occurredAt: new Date(1_000).toISOString(),
    actor: { email: 'operator-console' },
    actorRole: 'operator',
    action: 'pause',
    outcome: 'accepted',
    resultCode: 'COMMAND_APPLIED',
    observedVersion: 0,
    note: null,
  });
  const [line] = (await readFile(auditLogPath, 'utf8')).trim().split('\n');
  await writeFile(auditLogPath, `${JSON.stringify({ ...JSON.parse(line), hash: `sha256:${'f'.repeat(64)}` })}\n`, 'utf8');

  await assert.rejects(async () => {
    const composition = await compose({
      stateDir,
      statePath,
      workerOwner: 'test-worker',
      leaseTtlMs: 30_000,
      robinhood: { rpcUrl: 'https://example.invalid' },
      solana: { rpcUrl: 'https://example.invalid' },
      relay: { baseUrl: 'https://example.invalid' },
      collectorCrypt: { baseUrl: 'https://example.invalid' },
      adapters: minimalInjectedAdapters(),
      dashboard: { proxyCredential: DASHBOARD_CREDENTIAL, sqlitePath: ':memory:', auditLogPath },
    });
    await composition.shutdown();
  }, /audit chain.*invalid/i);
});

// --- WP-33: standingAuthority passthrough ---------------------------------------------------

test('compose(config) exposes config.standingAuthority unchanged, and null when not configured', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath);

  const withoutAuthority = await compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    budget: SUFFICIENT_BUDGET,
    now: () => 1_000,
  });
  assert.equal(withoutAuthority.standingAuthority, null);
  await withoutAuthority.shutdown();

  const stateDir2 = await tempStateDir(t);
  const statePath2 = join(stateDir2, 'operator-state.json');
  await writeOperatorState(statePath2);
  const fakeStandingAuthority = Object.freeze({ schema: 'hookemon.standing-authority-document.v1', documentDigest: 'sha256:aa'.padEnd(71, '0') });
  const withAuthority = await compose({
    stateDir: stateDir2,
    statePath: statePath2,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    budget: SUFFICIENT_BUDGET,
    now: () => 1_000,
    standingAuthority: fakeStandingAuthority,
  });
  assert.deepEqual(withAuthority.standingAuthority, fakeStandingAuthority);
  await withAuthority.shutdown();
});

/** Builds a full composition (scheduler + dashboard, same cycleRepository/statePath) with a live
 * dashboard HTTP server bound to an ephemeral port. Mirrors packages/dashboard/test/routes/
 * server.test.mjs's own `buildTestServer` helper, but drives it through the real, composed
 * `compose()` rather than a hand-built ctx. */
async function buildComposedDashboard(t, {
  statePath,
  stateDir,
  configurationPatch = {},
  cycleSeed = null,
  adapters = undefined,
  configureState = null,
  composePatch = {},
} = {}) {
  await writeOperatorState(statePath, configurationPatch);
  const seededCycle = cycleSeed === null ? null : await seedCycle(stateDir, cycleSeed);
  if (configureState !== null) await configureState({ statePath, stateDir, seededCycle });
  const composition = await compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    budget: SUFFICIENT_BUDGET,
    dashboard: {
      profileId: 'mainnet',
      proxyCredential: DASHBOARD_CREDENTIAL,
      sqlitePath: ':memory:',
      auditLogPath: join(stateDir, 'dashboard-audit.log'),
    },
    now: () => 1_000,
    ...composePatch,
    ...(adapters === undefined ? {} : { adapters }),
  });
  assert.notEqual(composition.dashboard, null, 'compose() must build a dashboard when config.dashboard is present');

  const server = createServer(createRequestListener(composition.dashboard.ctx));
  await new Promise(resolve => server.listen(0, resolve));
  const port = server.address().port;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await composition.shutdown();
  });

  return {
    composition,
    seededCycle,
    async get(path, headers) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers, keepalive: false });
      const text = await res.text();
      return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null };
    },
    async post(path, body, headers) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
        keepalive: false,
      });
      const text = await res.text();
      return { status: res.status, body: text.length > 0 ? JSON.parse(text) : null };
    },
  };
}

test('dashboard bootstrap exposes the Collector catalog and actual start readiness result', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  const adapters = throwingAdapters();
  adapters.collectorCrypt.getMachines = async () => ({
    machines: [{ code: 'base-pack', name: 'Base pack', price: '12.5', public: true }],
  });
  const server = await buildComposedDashboard(t, { statePath, stateDir, adapters });
  const bootstrap = await server.get('/operator/api/bootstrap', {
    'x-hookemon-proxy-credential': DASHBOARD_CREDENTIAL,
  });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.body.catalog.status, 'LOADED');
  assert.deepEqual(bootstrap.body.catalog.packs, [{
    id: 'base-pack',
    name: 'Base pack',
    priceMicroStablecoin: '12500000',
    available: null,
  }]);
  assert.deepEqual(bootstrap.body.readiness, { ready: true, reasons: [] });
});

test('dashboard bootstrap reports the configured RPC chain mismatch as not ready', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  const adapters = throwingAdapters();
  adapters.robinhood.client.getChainId = async () => 1;
  const server = await buildComposedDashboard(t, { statePath, stateDir, adapters });
  const bootstrap = await server.get('/operator/api/bootstrap', {
    'x-hookemon-proxy-credential': DASHBOARD_CREDENTIAL,
  });
  assert.equal(bootstrap.status, 200);
  assert.equal(bootstrap.body.readiness.ready, false);
  assert.match(bootstrap.body.readiness.reasons[0], /^start-readiness: .*4663/);
});

test('dashboard composed in-process: run-cycle-now over HTTP actually drives the real scheduler through a complete dry-run cycle', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  const server = await buildComposedDashboard(t, { statePath, stateDir });

  const decision = await server.post('/operator/api/decisions', {
    requestId: 'req-run-now-1',
    expectedVersion: 0,
    command: { type: 'run-cycle-now' },
  }, { 'x-hookemon-proxy-credential': DASHBOARD_CREDENTIAL });
  assert.equal(decision.status, 200);
  assert.equal(decision.body.code, 'TICK_TRIGGERED', 'run-cycle-now must reach the real scheduler, not RECORDED_NO_LIVE_SCHEDULER');

  const active = await server.composition.cycleRepository.readActiveCycle();
  assert.equal(active, null, 'the triggered tick actually ran a complete dry-run cycle and archived it');

  // The dashboard's own status projection must now reflect a real tick having happened (lastTick,
  // fed from the composed scheduler's own onTick hook, is what makes nextCycleAt non-null here).
  const dashboardBody = await server.get('/operator/api/dashboard', { 'x-hookemon-proxy-credential': DASHBOARD_CREDENTIAL });
  assert.equal(dashboardBody.status, 200);
  assert.notEqual(dashboardBody.body.nextCycleAt, null);
});

test('dashboard composed in-process: public and private routes share the real lifetime projection', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  const server = await buildComposedDashboard(t, { statePath, stateDir });

  const decision = await server.post('/operator/api/decisions', {
    requestId: 'req-public-routes-1',
    expectedVersion: 0,
    command: { type: 'run-cycle-now' },
  }, { 'x-hookemon-proxy-credential': DASHBOARD_CREDENTIAL });
  assert.equal(decision.status, 200);

  const headers = { 'x-hookemon-proxy-credential': DASHBOARD_CREDENTIAL };
  const [status, community, history, operator] = await Promise.all([
    server.get('/public/api/cycle-status'),
    server.get('/public/api/community-dashboard'),
    server.get('/public/api/cycle-history?limit=5'),
    server.get('/operator/api/dashboard', headers),
  ]);
  for (const response of [status, community, history, operator]) assert.equal(response.status, 200);
  const cycleId = (await server.composition.cycleRepository.listKnownCycleIds())[0];
  const purchaseStage = await server.composition.cycleRepository.readStage(cycleId, 'purchase');
  const openStage = await server.composition.cycleRepository.readStage(cycleId, 'open');
  const openedPacks = Array.isArray(openStage.evidence?.packs)
    ? openStage.evidence.packs.filter(pack => pack.decision === 'opened').length
    : null;
  const accounting = await server.composition.dashboard.ctx.readAccounting(cycleId);
  assert.equal(accounting.schema, undefined);
  assert.equal(community.body.schemaVersion, 8);
  normalizePublicCommunitySnapshot(community.body, 'mainnet');
  assert.equal(community.body.metrics.completedCycles, 1);
  assert.equal(operator.body.metrics.completedCycles, 1);
  assert.equal(operator.body.historyComplete, true);
  assert.equal(operator.body.execution.connected, true);
  assert.equal(community.body.metrics.openedPacks, openedPacks);
  assert.equal(operator.body.metrics.openedPacks, openedPacks);
  assert.match(accounting.packSpendMicroUsdg, /^(0|[1-9][0-9]*)$/);
  assert.strictEqual(community.body.metrics.totalCycleFundingMicroUsdg, accounting.packSpendMicroUsdg);
  assert.strictEqual(operator.body.metrics.totalCycleFundingMicroUsdg, accounting.packSpendMicroUsdg);
  assert.equal(operator.body.metrics.totalCollectorSpendMicroUsdg, null);
  const purchasedPacks = Array.isArray(purchaseStage.evidence?.packs)
    ? purchaseStage.evidence.packs.filter(pack => pack.status === 'purchased').length
    : 0;
  assert.equal(operator.body.metrics.skippedCycles, purchasedPacks > 0 ? 0 : 1);
  assert.equal(operator.body.completeness.totalCycleFundingMicroUsdg, accounting.packSpendMicroUsdg !== null);
  assert.equal(operator.body.completeness.totalCollectorSpendMicroUsdg, false);
});

test('dashboard composed in-process: held decisions and manual approvals remain durable and idempotent', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  let manualCycleId;
  let manualCycleDigest;
  const server = await buildComposedDashboard(t, {
    statePath,
    stateDir,
    composePatch: { moneyConfiguration: productionMoneyConfiguration() },
    cycleSeed: {
      releaseAmount: '1',
      releaseCostMicroUsd: '7',
      mode: 'production',
      now: () => 1_700_000_000_000,
      admission: cycleId => nativeProducedAdmissionFixture(cycleId, { amountWei: '1', costMicroUsd: '7' }),
      completedStages: AUTOMATED_CYCLE_STAGES.map(stage => ({
        stage,
        evidence: { stage, finalized: true },
      })),
      heldPosition: {
        packId: 'base-pack',
        memo: 'compose-held-memo',
        mint: 'compose-held-mint',
        cardRef: 'compose-held-mint',
        costMicroUsd: '7',
        valueMicroUsd: '7',
        insuredValue: null,
        reason: 'EPIC_THRESHOLD',
        terminalState: 'HELD_OWNER_DECISION',
        evidence: { stage: 'epic-gate', decision: 'hold' },
      },
      archive: true,
    },
    configureState: async ({ stateDir: configuredStateDir, statePath: configuredStatePath, seededCycle }) => {
      const repository = await CycleRepository.open(
        join(configuredStateDir, 'cycles'),
        () => 1_000,
        { testAuthority: createTestProfileMutationAuthority() },
      );
      const manualCycle = await repository.createCycle({
        releaseAmount: '2',
        releaseCostMicroUsd: '9',
        mode: 'production',
      });
      manualCycleId = manualCycle.cycleId;
      manualCycleDigest = digest({ schema: 'hookemon.test-manual-approval.v1', cycleId: manualCycleId });
      const currentState = await readOperatorState(configuredStatePath);
      await mutateOperatorState(configuredStatePath, currentState.revision, state => ({
        ...state,
        configuration: {
          ...state.configuration,
          manualApprovalCycles: 1,
          cycleLedger: [{
            cycleId: manualCycleId,
            cycleDigest: manualCycleDigest,
            mode: 'production',
            openedAtMs: 1_000,
            releaseCostMicroUsd: '9',
            releaseAmountWei: '2',
          }],
          approvalsByCycleDigest: {},
        },
      }));
      assert.equal(seededCycle.heldPosition.positionId.startsWith('held:'), true);
    },
  });
  const headers = { 'x-hookemon-proxy-credential': DASHBOARD_CREDENTIAL };
  const before = await server.get('/operator/api/dashboard', headers);
  assert.equal(before.status, 200, before.diagnostics);
  const held = before.body.heldPositions[0];
  assert.equal(before.body.completeness.heldPositions, true);
  assert.equal(typeof held.evidenceDigest, 'string');
  assert.equal(held.positionRevision, 0);
  assert.equal(before.body.manualApprovals.length, 1);
  assert.equal(before.body.manualApprovals[0].cycleId, manualCycleId);
  assert.equal(before.body.manualApprovals[0].approved, false);

  const command = {
    type: 'held-owner-decision',
    positionId: held.positionId,
    heldEvidenceDigest: held.evidenceDigest,
    expectedPositionRevision: held.positionRevision,
    choice: 'sell',
  };
  const first = await server.post('/operator/api/decisions', {
    requestId: 'compose-held-sell-1',
    expectedVersion: 1,
    command,
  }, headers);
  assert.equal(first.status, 200, first.diagnostics);
  assert.equal(first.body.code, 'HELD_OWNER_DECISION_RECORDED');

  const afterFirstDescription = await server.composition.cycleRepository.describeCycle(held.cycleId);
  assert.equal(afterFirstDescription.heldPositions.get(held.positionId).ownerDecision.choice, 'sell');
  const firstSettlement = await server.composition.cycleRepository.readSupplementarySettlement(held.positionId);
  assert.equal(firstSettlement.state, 'PREPARED');
  assert.equal(firstSettlement.positionEvidenceDigest, held.evidenceDigest);

  const duplicate = await server.post('/operator/api/decisions', {
    requestId: 'compose-held-sell-2',
    expectedVersion: 1,
    command: { ...command, expectedPositionRevision: 1 },
  }, headers);
  assert.equal(duplicate.status, 200, duplicate.diagnostics);
  const duplicateSettlement = await server.composition.cycleRepository.readSupplementarySettlement(held.positionId);
  assert.deepEqual(duplicateSettlement, firstSettlement);
  assert.deepEqual(
    (await server.composition.cycleRepository.describeCycle(held.cycleId)).heldPositions.get(held.positionId).ownerDecision,
    afterFirstDescription.heldPositions.get(held.positionId).ownerDecision,
  );

  const stale = await server.post('/operator/api/decisions', {
    requestId: 'compose-held-sell-stale',
    expectedVersion: 1,
    command,
  }, headers);
  assert.equal(stale.status, 409, stale.diagnostics);
  assert.deepEqual(await server.composition.cycleRepository.readSupplementarySettlement(held.positionId), firstSettlement);

  const approval = await server.post('/operator/api/decisions', {
    requestId: 'compose-manual-approval-1',
    expectedVersion: 1,
    command: {
      type: 'manual-approval',
      cycleId: manualCycleId,
      cycleDigest: manualCycleDigest,
    },
  }, headers);
  assert.equal(approval.status, 200, approval.diagnostics);
  const stateAfterApproval = await readOperatorState(statePath);
  assert.deepEqual(stateAfterApproval.configuration.approvalsByCycleDigest[manualCycleDigest], {
    cycleId: manualCycleId,
    approvedAtMs: 1_000,
  });
  const afterApproval = await server.get('/operator/api/dashboard', headers);
  assert.equal(afterApproval.body.manualApprovals[0].approved, true);
  assert.equal(afterApproval.body.manualApprovals[0].approvedAt, new Date(1_000).toISOString());
});

test('dashboard composed in-process: restart-request/reconcile-request over HTTP actually reach AutomatedCycleService.recoverActiveCycle', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  const server = await buildComposedDashboard(t, { statePath, stateDir });

  const decision = await server.post('/operator/api/decisions', {
    requestId: 'req-restart-1',
    expectedVersion: 0,
    command: { type: 'restart-request' },
  }, { 'x-hookemon-proxy-credential': DASHBOARD_CREDENTIAL });
  assert.equal(decision.status, 200);
  // No cycle is active yet, so the real recoverActiveCycle() call reports NO_ACTIVE_CYCLE — proving
  // the request actually reached the live service (RECORDED_NO_LIVE_SERVICE would mean it did not).
  assert.equal(decision.body.code, 'RECOVERY_NO_ACTIVE_CYCLE');
});

test('operator resume-cycle recovers a supplementary settlement after its completed cycle is no longer active', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath);

  const repository = await CycleRepository.open(join(stateDir, 'cycles'), () => 1_000, { testAuthority: createTestProfileMutationAuthority() });
  const cycleId = repository.nextCycleId();
  const cycle = await repository.createCycle({ cycleId, releaseAmount: '1', releaseCostMicroUsd: '7', mode: 'production', admission: await pinnedProductionPurchaseAdmission({ cycleId, packId: 'base-pack', amountAtomic: '1' }) });
  for (const stage of AUTOMATED_CYCLE_STAGES) {
    await repository.prepareStage(cycle.cycleId, stage);
    await repository.completeStage(cycle.cycleId, stage, { stage, finalized: true });
  }
  const position = await repository.recordHeldPosition(cycle.cycleId, {
    packId: 'base-pack',
    memo: 'memo-resume-supplementary',
    mint: 'mint-resume-supplementary',
    cardRef: 'mint-resume-supplementary',
    costMicroUsd: '7',
    valueMicroUsd: '7',
    insuredValue: null,
    reason: 'EPIC_THRESHOLD',
    terminalState: 'HELD_OWNER_DECISION',
    evidence: { stage: 'epic-gate', decision: 'hold' },
  });
  await repository.completeCycle(cycle.cycleId);
  await repository.recordHeldOwnerDecision(position.positionId, {
    heldEvidenceDigest: position.evidenceDigest,
    requestId: 'resume-supplementary-sell',
    expectedRevision: 0,
    choice: 'sell',
  });
  assert.equal(await repository.readActiveCycle(), null, 'the completed main cycle is deliberately no longer active');

  const composition = await compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    adapters: minimalInjectedAdapters(),
    now: () => 1_000,
    supplementaryStageHandlers: {
      PREPARED: {
        stage: 'supplementary-buyback',
        async reconcile({ cycleRepository, position: heldPosition, settlement }) {
          await cycleRepository.advanceSupplementarySettlement(heldPosition.positionId, {
            expectedState: settlement.state,
            nextState: 'BUYBACK_SENT_UNKNOWN',
            evidence: { requestDigest: `sha256:${'a'.repeat(64)}` },
          });
        },
      },
    },
  });
  t.after(() => composition.shutdown());

  const outcome = await composition.executeAudited({
    requestId: 'resume-supplementary-1',
    expectedRevision: 0,
    command: { type: 'resume-cycle' },
    effect: () => composition.operatorControl.execute({
      expectedRevision: 0,
      requestId: 'resume-supplementary-1',
      command: { type: 'resume-cycle' },
    }),
  });

  assert.equal(outcome.commandState, 'APPLIED');
  // `operatorAuditResultCode` classifies every `resume-cycle` command as `RECOVERY_DISPATCHED`
  // unconditionally (packages/adapters/src/app/compose.mjs) -- there is no more specific
  // per-recovery-kind code today. The durable proof this test exists for is the settlement
  // actually advancing, asserted next.
  assert.equal(outcome.receipt.resultCode, 'RECOVERY_DISPATCHED');
  assert.equal((await composition.cycleRepository.readSupplementarySettlement(position.positionId)).state, 'BUYBACK_SENT_UNKNOWN');
});

test('dashboard composed in-process: pause/activate decisions are read fresh by the real scheduler on its next tick', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  const server = await buildComposedDashboard(t, { statePath, stateDir, configurationPatch: { paused: true } });

  const decision = await server.post('/operator/api/decisions', {
    requestId: 'req-activate-1',
    expectedVersion: (await readOperatorState(statePath)).revision,
    command: { type: 'activate' },
  }, { 'x-hookemon-proxy-credential': DASHBOARD_CREDENTIAL });
  assert.equal(decision.status, 200);
  assert.equal(decision.body.code, 'DECISION_ACCEPTED');

  const outcome = await server.composition.scheduler.triggerTick();
  assert.equal(outcome.result?.status, 'COMPLETE', 'the scheduler tick re-read the just-written configuration.paused=false and actually ran');
});

test('dashboard composed in-process: ctx.readAccounting is wired to the real cycleRepository, deriving real per-cycle accounting from the journal rather than a fabricated placeholder', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  const server = await buildComposedDashboard(t, {
    statePath,
    stateDir,
    cycleSeed: {
      releaseAmount: SUFFICIENT_BUDGET.packPriceWei,
      completedStages: [
        { stage: 'eligibility-snapshot' },
        { stage: 'claim-process' },
        { stage: 'outbound' },
        { stage: 'purchase', evidence: { memo: 'memo-1', signature: 'sig-1' } },
      ],
    },
  });

  // This admission-free historical journal preserves its legacy projection on read.
  // Native admissions are tested separately and never reinterpret this field as ETH.
  const cycle = server.seededCycle;
  assert.notEqual(cycle, null);

  const accounting = await server.composition.dashboard.ctx.readAccounting(cycle.cycleId);
  assert.equal(accounting.packSpendMicroUsdg, SUFFICIENT_BUDGET.packPriceWei);
  assert.equal(accounting.holderRewardsStatus, 'not-started');

  // And the exact same object shape reaches the public HTTP contract's validator untouched — proven
  // once at the dashboard-package level (cycle-status-projection.test.mjs), so this only needs to
  // prove compose.mjs's own wiring reaches a real, non-fabricated value.
  assert.notEqual(accounting.packSpendMicroUsdg, '0');
});

test('dashboard composed in-process: ctx.getSchedulerView is wired to the real scheduler.getView(), never a second timer', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  const server = await buildComposedDashboard(t, { statePath, stateDir });

  const view = server.composition.dashboard.ctx.getSchedulerView();
  assert.deepEqual(view, server.composition.scheduler.getView());
});

test('dashboard composed in-process: ctx.listRecentWinners derives real deduplicated cards from the durable pack-batch ledger, never a fabricated placeholder', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  const server = await buildComposedDashboard(t, {
    statePath,
    stateDir,
    cycleSeed: {
      releaseAmount: SUFFICIENT_BUDGET.packPriceWei,
      completedStages: [
        { stage: 'eligibility-snapshot' },
        { stage: 'claim-process' },
        { stage: 'outbound' },
        {
          stage: 'purchase',
          evidence: { packs: [
            { packIndex: 0, memo: 'memo-0', status: 'purchased', signature: 'sig-0' },
            { packIndex: 1, memo: 'memo-1', status: 'not_purchased' },
          ] },
        },
      ],
      packBatchRequests: [{ stage: 'purchase', packs: [
        { packIndex: 0, memo: 'memo-0', expectedCardCount: 1, packType: 'pokemon_25' },
        { packIndex: 1, memo: 'memo-1', expectedCardCount: 1, packType: 'pokemon_25' },
      ] }],
    },
  });
  const cycle = server.seededCycle;
  assert.notEqual(cycle, null);

  const cards = await server.composition.dashboard.ctx.listRecentWinners({ limit: 10 });
  assert.equal(cards.length, 1, 'only the actually-purchased pack becomes a card; the not_purchased pack never fabricates one');
  assert.equal(cards[0].cycleId, cycle.cycleId);
  assert.equal(cards[0].operationId, `pack:${cycle.cycleId}:0`);
  assert.equal(cards[0].memo, 'memo-0');
  assert.equal(cards[0].state, 'observed');
  assert.equal(cards[0].transactionId, 'sig-0');

  // An observation whose memo is not among this project's own trusted operations must never appear,
  // even if it otherwise looks like a well-formed card for the same cycle.
  const foreignCards = await server.composition.dashboard.ctx.listRecentWinners({ limit: 10 });
  assert.ok(foreignCards.every(card => card.memo === 'memo-0' || card.memo === 'memo-1'));
});

test('dashboard composed in-process: ctx.listRecentWinners returns no cards when no pack batch has been requested yet', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  const server = await buildComposedDashboard(t, {
    statePath,
    stateDir,
    cycleSeed: { releaseAmount: SUFFICIENT_BUDGET.packPriceWei, completedStages: [{ stage: 'eligibility-snapshot' }] },
  });

  assert.deepEqual(await server.composition.dashboard.ctx.listRecentWinners({ limit: 10 }), []);
});

// --- WP-36: the full eight-stage liveMode true cycle ---------------------------------------------
//
// The central WP-36 acceptance criterion: with every adapter/config surface configured, a
// liveMode:true cycle runs every one of the eight stages (funding, outbound, purchase, open,
// buyback, return, distribution, payout) through the real composed service to a settled payout —
// against fake transports throughout (collector-crypt, relay, robinhood RPC, solana RPC), and a
// genuinely separate `bin/hookemon-verifier.mjs` process run for the distribution stage's own
// verification (never a hand-constructed receipt).
//
// distribution is deliberately a two-pass affair, matching its own real-world cadence (decision
// D7: the verifier runs at a lower, semi-manual frequency, never inside the always-on worker's own
// tick): the first `recoverActiveCycle` call runs funding..return to completion, then distribution's
// own mutate() writes its verification request and — since no receipt exists yet — the whole call
// throws "distribution mutation remains unresolved after execution", exactly `AutomatedCycleService`'s
// own documented behavior for a stage whose mutation does not resolve synchronously. The real
// verifier process then answers that request. A second `recoverActiveCycle` call resumes the same
// cycle: every already-COMPLETE stage is skipped, distribution's own reconcile() now finds the
// receipt and completes without re-signing, and payout — gated on distribution being durably
// COMPLETE (`STAGE_JOIN_PRECONDITIONS`) — finally becomes reachable and completes the cycle.

const OWNER_PRIVATE_KEY = createPrivateKey({
  key: Buffer.from('302e020100300506032b6570042204208566b1706357d4653313d88defec8219a3f4ad9d2abca8484765a4af92b12cb9', 'hex'),
  format: 'der', type: 'pkcs8',
});
const DISTRIBUTION_VERIFIER_PRIVATE_KEY = createPrivateKey({
  key: Buffer.from('302e020100300506032b65700422042066d19592d6fe485bacd309b93ae3524217a22bdcba8ee6333d1c0f51fb150e16', 'hex'),
  format: 'der', type: 'pkcs8',
});
function ed25519SignerClient(role, privateKey) {
  return { role, sign(digestBuffer) { return sign(null, digestBuffer, privateKey).toString('base64url'); } };
}

// WP-39: the production distribution profile's two secp256k1 EIP-712 identities — real, fixed
// local test private keys (never production secrets), used so this test exercises the exact same
// EIP-712 signature scheme the vault verifies on-chain, not a stand-in.
const FULL_DISTRIBUTION_SIGNER_KEY = `0x${'11'.repeat(32)}`;
const FULL_DISTRIBUTION_VERIFIER_KEY = `0x${'22'.repeat(32)}`;
const FULL_DISTRIBUTION_SIGNER_ADDRESS = privateKeyToAccount(FULL_DISTRIBUTION_SIGNER_KEY).address;
const FULL_DISTRIBUTION_VERIFIER_ADDRESS = privateKeyToAccount(FULL_DISTRIBUTION_VERIFIER_KEY).address;
function evmDigestSignerClient(role, privateKey) {
  return {
    role,
    async sign(request) {
      const signature = serializeSignature(await signSecp256k1({ hash: request.digest, privateKey }));
      return { signature };
    },
  };
}

const FULL_VAULT = `0x${'a'.repeat(40)}`;
const FULL_HOOK = `0x${'b'.repeat(40)}`;
// Pinned deployment identity, so a live composition is admitted against the same accounts and assets
// production enforces rather than against a weakened check. Same pair as the policy engine's pins,
// RobinhoodBindings.sol and the recorded owner inputs.
const FULL_EVM_ACCOUNT = '0xb54aaf746eb1e80afdb5eb0992a75b08db2e4384';
const FULL_ETH = 'native';
const FULL_HKMN = `0x${'f'.repeat(40)}`;
const FULL_RETURN_ESCROW = `0x${'d'.repeat(40)}`;
const FULL_SOLANA_ACCOUNT = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';
const FULL_ROUTE_DATA = '0x1234abcd';
const FULL_SOLANA_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const FULL_OPEN_TX_SIGNATURE = 'OpenTransactionSignature1111111111111111111111111111111111111111111111111111';
const FULL_CARD_MINT = 'CardMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
const FULL_HOLDER = `0x${'9'.repeat(39)}9`;
const FULL_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const FULL_ESCROW_BALANCE = 24_000_000n;

function fullMoneyConfiguration() {
  const configuration = productionMoneyConfiguration();
  const eth = { ...configuration.assets.eth, assetId: FULL_ETH };
  return {
    ...configuration,
    assets: { ...configuration.assets, eth },
    minimums: {
      ...configuration.minimums,
      robinhoodReceive: { ...configuration.minimums.robinhoodReceive, assetId: FULL_ETH },
      returnEth: { ...configuration.minimums.returnEth, assetId: FULL_ETH },
    },
  };
}

function fullAddressTopic(address) { return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`; }

function fullRobinhoodClient() {
  let nextHash = 1;
  return {
    async readContract({ functionName, args }) {
      if (functionName === 'computeCycleEscrow') return FULL_RETURN_ESCROW;
      if (functionName === 'totalSupply') return FULL_ESCROW_BALANCE;
      if (functionName === 'balanceOf') {
        const [account] = args;
        return account.toLowerCase() === FULL_RETURN_ESCROW.toLowerCase() ? FULL_ESCROW_BALANCE : 0n;
      }
      throw new Error(`unexpected readContract ${functionName}`);
    },
    async sendRawTransaction() {
      return `0x${(nextHash++).toString(16).padStart(64, '0')}`;
    },
    async getTransactionReceipt({ hash }) {
      return { transactionHash: hash, blockNumber: 5n, status: 'success' };
    },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag === 'finalized' || blockTag === 'latest') return { number: 10n, hash: `0x${'11'.repeat(32)}`, timestamp: 1n };
      return { number: blockNumber, hash: `0x${blockNumber.toString(16).padStart(64, '0')}`, timestamp: 1n };
    },
    async request({ method }) {
      if (method === 'eth_getLogs') {
        return [{
          topics: [FULL_TRANSFER_TOPIC, fullAddressTopic(`0x${'0'.repeat(40)}`), fullAddressTopic(FULL_HOLDER)],
          data: `0x${FULL_ESCROW_BALANCE.toString(16).padStart(64, '0')}`,
          blockNumber: '0xa',
          logIndex: '0x0',
        }];
      }
      throw new Error(`unexpected request ${method}`);
    },
  };
}

function fullEligibilitySnapshotConfig() {
  const launchManifest = {
    supply: { chainId: '4663', assetId: FULL_HKMN, decimals: 18, amountAtomic: FULL_ESCROW_BALANCE.toString() },
    hook: FULL_HOOK,
    poolManager: `0x${'1'.repeat(40)}`,
    custody: `0x${'2'.repeat(40)}`,
    operations: FULL_EVM_ACCOUNT,
    treasury: `0x${'3'.repeat(40)}`,
    programmableRecipient: `0x${'4'.repeat(40)}`,
    launchContracts: [FULL_VAULT],
    burnAddresses: [`0x${'0'.repeat(36)}dead`],
    roleHistory: [{ role: 'former-operations', address: `0x${'5'.repeat(40)}` }],
  };
  return {
    finality: { policyId: 'robinhood-stage-finality-v1', depth: '2' },
    launchManifest,
    launchManifestDigest: digest({
      domain: 'hookemon.eligibility-launch-manifest.v1',
      launchManifest: {
        ...launchManifest,
        launchContracts: [...launchManifest.launchContracts].sort(),
        burnAddresses: [...launchManifest.burnAddresses].sort(),
        roleHistory: [...launchManifest.roleHistory].sort((a, b) => a.address.localeCompare(b.address)),
      },
    }),
    primaryLogSourceId: 'fixture-primary',
    secondaryLogSourceId: 'fixture-secondary',
    logPageSize: '2',
    maxRetriesPerPage: 2,
    feasibility: {
      measuredTransferGas: '50000',
      maxGasPriceWei: '2',
      nativeReserveWei: '10',
      nativeBalanceWei: '400000',
      maxRecipientCount: 2000,
      maxTransactionCount: 2000,
    },
  };
}

function fullEligibilitySnapshotClient() {
  const blockHash = number => `0x${number.toString(16).padStart(64, '0')}`;
  const transfer = {
    address: FULL_HKMN,
    topics: [FULL_TRANSFER_TOPIC, fullAddressTopic(`0x${'0'.repeat(40)}`), fullAddressTopic(FULL_HOLDER)],
    data: `0x${FULL_ESCROW_BALANCE.toString(16).padStart(64, '0')}`,
    blockNumber: '0x1',
    logIndex: '0x0',
    blockHash: blockHash(1n),
    removed: false,
  };
  return {
    async sendRawTransaction() {
      throw new Error('claim process must not broadcast before canonical nonce reads');
    },
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag === 'latest' || blockTag === 'finalized') {
        return { number: 10n, hash: blockHash(10n), timestamp: 1n };
      }
      return { number: blockNumber, hash: blockHash(blockNumber), timestamp: 1n };
    },
    async request({ method, params }) {
      assert.equal(method, 'eth_getLogs');
      const [{ fromBlock, toBlock }] = params;
      const from = BigInt(fromBlock);
      const to = BigInt(toBlock);
      return from <= 1n && to >= 1n ? [transfer] : [];
    },
  };
}

function fullSolanaFetchImpl() {
  let nextSignature = 1;
  return async (url, options) => {
    const body = JSON.parse(options.body);
    const respond = result => ({ ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) });
    if (body.method === 'getTokenAccountBalance') {
      return respond({ value: { amount: '5000000', decimals: 6, uiAmountString: '5' } });
    }
    if (body.method === 'sendTransaction') {
      return respond(`fake-signature-${nextSignature++}`);
    }
    if (body.method === 'getSignatureStatuses') {
      return respond({ value: body.params[0].map(() => ({ slot: 1, confirmations: null, err: null, confirmationStatus: 'finalized' })) });
    }
    if (body.method === 'getTransaction') {
      return respond({
        transaction: { message: { accountKeys: [{ pubkey: FULL_SOLANA_ACCOUNT }, { pubkey: 'PackTokenAccount1111111111111111111111111' }, { pubkey: 'CardTokenAccount1111111111111111111111111' }] } },
        meta: {
          preTokenBalances: [{ accountIndex: 1, mint: 'PackMint1111111111111111111111111111111111', owner: FULL_SOLANA_ACCOUNT, uiTokenAmount: { amount: '1', decimals: 0, uiAmountString: '1' } }],
          postTokenBalances: [
            { accountIndex: 1, mint: 'PackMint1111111111111111111111111111111111', owner: FULL_SOLANA_ACCOUNT, uiTokenAmount: { amount: '0', decimals: 0, uiAmountString: '0' } },
            { accountIndex: 2, mint: FULL_CARD_MINT, owner: FULL_SOLANA_ACCOUNT, uiTokenAmount: { amount: '1', decimals: 0, uiAmountString: '1' } },
          ],
        },
      });
    }
    throw new Error(`unexpected solana RPC method ${body.method}`);
  };
}

function fullCollectorCryptClient() {
  let submitCount = 0;
  return {
    async generatePack({ playerAddress }) {
      assert.equal(playerAddress, FULL_SOLANA_ACCOUNT);
      return { memo: 'memo-full-1', transaction: 'dW5zaWduZWQtcHVyY2hhc2U=' };
    },
    async submitTransaction() {
      submitCount += 1;
      return { success: true, signature: `submit-sig-${submitCount}`, confirmationStatus: 'confirmed' };
    },
    async openPack({ memo }) {
      assert.equal(memo, 'memo-full-1');
      return { success: true, transactionSignature: FULL_OPEN_TX_SIGNATURE };
    },
    async getBuybackAvailable({ nft }) {
      assert.equal(nft, FULL_CARD_MINT);
      return { available: true, amount: 5_000_000 };
    },
    async buyback({ nftAddress }) {
      assert.equal(nftAddress, FULL_CARD_MINT);
      return { success: true, serializedTransaction: 'dW5zaWduZWQtYnV5YmFjaw==', refundAmount: 5_000_000, memo: 'memo-full-1:buyback' };
    },
    // The admission planner prices the pack from the catalog before a live cycle is created, so
    // getMachines is now reached ahead of the claim boundary this fixture exercises.
    getMachines: async () => ({ machines: [{ code: 'base-pack', price: '0.000005', contains: 1 }, { code: 'collector-nova', price: '0.000005', contains: 1 }] }),
    getStatus: () => { throw new Error('unused in liveMode true'); },
    getPackStatus: () => { throw new Error('unused in liveMode true'); },
  };
}

function fullRelayClient({ now = () => 1_000 } = {}) {
  const backend = {
    async quoteOutboundBridge({ amount, user, recipient }) {
      // Parser-shaped, because the admission planner persists the returned QuoteResult verbatim and
      // the policy engine re-derives its digest from exactly these fields. Distinct per target: the
      // planner refuses one quote reused for both the unit and aggregate above quantity one.
      const parsed = {
        direction: 'OUTBOUND',
        tradeType: 'EXACT_OUTPUT',
        requestId: `req-outbound-full-${amount}`,
        orderId: `0x${String(amount).padStart(64, '0')}`,
        sender: user,
        recipient,
        deadlineUnixSeconds: 2_000_000_000,
        origin: { chainId: 4663, address: `0x${'0'.repeat(40)}`, symbol: 'ETH', decimals: 18, amount, amountFormatted: null, minimumAmount: null },
        destination: { chainId: 792703809, address: FULL_SOLANA_MINT, symbol: 'CIRCLE_USD', decimals: 6, amount, amountFormatted: null, minimumAmount: amount },
        stepCount: 1,
        raw: {
          requestId: `req-outbound-full-${amount}`,
          steps: [{ data: { data: FULL_ROUTE_DATA } }],
          details: {
            sender: user,
            recipient,
            currencyIn: { currency: { chainId: 4663, address: `0x${'0'.repeat(40)}`, symbol: 'ETH', decimals: 18 }, amount, amountUsd: '0.000005' },
            currencyOut: { currency: { chainId: 792703809, address: FULL_SOLANA_MINT, symbol: 'CIRCLE_USD', decimals: 6 }, amount, minimumAmount: amount },
          },
          protocol: {
            v2: {
              orderId: `0x${String(amount).padStart(64, '0')}`,
              orderData: {
                output: {
                  chainId: 'solana',
                  deadline: 2_000_000_000,
                  calls: [],
                  payments: [{ recipient, currency: FULL_SOLANA_MINT, expectedAmount: amount, minimumAmount: amount }],
                },
                inputs: [{
                  payment: { chainId: 'robinhood', currency: `0x${'0'.repeat(40)}`, amount },
                  refunds: [{ chainId: 'robinhood', currency: `0x${'0'.repeat(40)}`, recipient: user, deadline: 2_000_000_000 }],
                }],
              },
            },
          },
        },
      };
      return { ...parsed, quoteDigest: relayQuoteDigest(parsed) };
    },
    async quoteReturnBridge({ amount }) {
      return { requestId: 'req-return-full', origin: { amount }, destination: { amount }, raw: { steps: [{ transaction: 'dW5zaWduZWQtcmV0dXJu' }] } };
    },
    simulateExecution({ quote }) { return { wouldExecute: true, requestId: quote.requestId }; },
    prepareExecution({ quote, liveMode }) {
      assert.equal(liveMode, true);
      return { intentDigest: quote.requestId, steps: quote.raw.steps };
    },
  };
  const client = createRelayClient({ now, quoteValidityMs: 60_000,
    fetchImpl: async (_url, options) => { const parsed = await backend.quoteOutboundBridge(JSON.parse(options.body));
      return { ok: true, status: 200, text: async () => JSON.stringify(parsed.raw) }; } });
  return { ...backend, quoteOutboundBridge: request => client.quoteOutboundBridge({ ...request, skipRouteCheck: true }) };
}

test('liveMode true fails closed before claim signing when canonical nonce reads are unavailable', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath, { ...livePolicyPatch('collector-nova'), packPlan: { orders: [{ pack: 'collector-nova', quantity: 1 }] } });
  const distributionDir = await mkdtemp(join(tmpdir(), 'hookemon-compose-distribution-'));
  t.after(() => rm(distributionDir, { recursive: true, force: true }));

  const signerClient = {
    evm: {
      probe: async () => ({ ready: true }),
      async sign(request) { return { signedTx: `0x${Buffer.from(JSON.stringify(request)).toString('hex')}` }; },
    },
    solana: {
      probe: async () => ({ ready: true }),
      async sign(request) { return { signedTxBase64: `signed:${typeof request === 'string' ? request : JSON.stringify(request)}` }; },
    },
    // WP-39: the production profile — real secp256k1 signatures over the vault's own EIP-712
    // PayoutDistribution digest, never the Ed25519 fixture scheme.
    distributionSigner: evmDigestSignerClient(DISTRIBUTION_SIGNER_ROLE, FULL_DISTRIBUTION_SIGNER_KEY),
  };

  const composition = await compose({
    processLiabilityReader: testProcessLiabilityReader(),
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    contracts: { vault: FULL_VAULT, hook: FULL_HOOK, eth: FULL_ETH, ethDecimals: 18 },
    accounts: { evm: FULL_EVM_ACCOUNT, solana: FULL_SOLANA_ACCOUNT },
    pack: { code: 'collector-nova' },
    hkmn: { address: FULL_HKMN, deployBlock: 0n, decimals: 18 },
    eligibilitySnapshot: fullEligibilitySnapshotConfig(),
    distribution: {
      dir: distributionDir,
      profile: 'production',
      signerAddress: FULL_DISTRIBUTION_SIGNER_ADDRESS,
      verifierAddress: FULL_DISTRIBUTION_VERIFIER_ADDRESS,
    },
    budget: SUFFICIENT_BUDGET,
    moneyConfiguration: fullMoneyConfiguration(),
    adapters: {
      collectorCrypt: fullCollectorCryptClient(),
      relay: fullRelayClient(),
      robinhood: { client: fullEligibilitySnapshotClient(), secondaryLogClient: fullEligibilitySnapshotClient() },
      solana: { client: createSolanaRpcClient({ fetchImpl: fullSolanaFetchImpl() }) },
    },
    signerClient,
    observability: liveObservabilityConfig(),
    observabilityDeps: liveObservabilityDeps(),
    preflightAuthority: createTestProfileMutationAuthority(),
    now: () => 1_000,
  });

  await assert.rejects(
    () => composition.service.runOnce({ liveMode: true }),
    /claim-process requires Robinhood RPC getChainId before signing/,
  );

  const active = await composition.cycleRepository.readActiveCycle();
  assert.notEqual(active, null, 'the active cycle remains available for retry after the missing canonical read is restored');
  const snapshot = await composition.cycleRepository.readStage(active.cycleId, 'eligibility-snapshot');
  assert.equal(snapshot.status, 'COMPLETE');
  assert.equal(snapshot.evidence.logCompleteness.mode, 'dual-source');
  assert.equal(await composition.cycleRepository.readOperationalStageAttempt(active.cycleId, 'eligibility-snapshot'), null);
  assert.equal(await composition.cycleRepository.readOperationalStageAttempt(active.cycleId, 'claim-process'), null);
  const chainAttempts = (await composition.cycleRepository.describeCycle(active.cycleId)).chainAttempts;
  assert.equal(chainAttempts.size, 1, 'the durable claim journal records PREPARED before the canonical RPC reads');
  const [{ attempt }] = chainAttempts.values();
  assert.equal(attempt.stage, 'claim-process');
  assert.equal(attempt.state, 'PREPARED');
  assert.equal(attempt.rawBytes, null);
});

test('compose refuses a third Operations EVM identity before creating services', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await assert.rejects(
    () => compose({
      stateDir,
      statePath,
      workerOwner: 'test-worker',
      leaseTtlMs: 30_000,
      robinhood: { rpcUrl: 'https://example.invalid' },
      solana: { rpcUrl: 'https://example.invalid' },
      relay: { baseUrl: 'https://example.invalid' },
      collectorCrypt: { baseUrl: 'https://example.invalid' },
      accounts: { evm: FULL_EVM_ACCOUNT, solana: null, operationsTrigger: `0x${'7'.repeat(40)}` },
      pack: { code: 'base-pack' },
      budget: SUFFICIENT_BUDGET,
      adapters: throwingAdapters(),
      signerClient: throwingSignerClient(),
      now: () => 1_000,
    }),
    /third Operations EVM identity is not supported/,
  );
});

for (const scenario of ['default-fresh', 'default-stale', 'injected-fresh']) {
  test(`composed custody clock ${scenario} values native principal and preserves held purchase cost`, async t => {
    const stateDir = await tempStateDir(t);
    const statePath = join(stateDir, 'operator-state.json');
    await writeOperatorState(statePath, { lossCapMicroUsd: '1000000', maxOutstandingCustodyMicroUsd: '1000000' });
    const now = scenario === 'injected-fresh' ? () => 1_000 : () => Date.now();
    const relay = fullRelayClient({ now: scenario === 'default-stale' ? () => Date.now() - 120_000 : now });
    let quoteReads = 0;
    const quote = relay.quoteOutboundBridge;
    relay.quoteOutboundBridge = async request => { quoteReads++; return quote(request); };
    // Synthetic repository read model only: no receipt, signed payment or production authority.
    const cycleId = 'clock-cycle';
    const ledger = { schema: 'hookemon.custody-ledger.v3', cycleId, chainId: '4663', assetId: 'native', decimals: 18,
      claimed: '42', bridgeOut: '0', bridgeIn: '0', packCost: '0', buybackProceeds: '0', returnInput: '0',
      returnReceived: '0', refunds: '0', residual: '0', heldAssets: '0', heldPositions: '0', payoutLiability: '0',
      dust: '0', unattributed: '0', verifiedCurrentBalance: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '42' },
      gasReserve: '0', gasSpent: '0', gasPayments: [] };
    const positionId = 'held:clock-card';
    const description = { terminalState: null, version: 0, heldEvidenceDigest: null, ownerDecision: null, custodyLedgers: new Map([['native', ledger]]),
      heldPositions: new Map([[positionId, { positionId, cycleId, costMicroUsd: '700000', reason: 'OWNER_KEEP',
        terminalState: 'HELD_USER_CHOICE', evidenceDigest: `sha256:${'1'.repeat(64)}`, openedAtMs: 1,
        positionRevision: 0, insuredValue: null, ownerDecision: null, resolution: null, ledgerAsset: null }]]) };
    t.mock.method(CycleRepository.prototype, 'listKnownCycleIds', async () => [cycleId]);
    t.mock.method(CycleRepository.prototype, 'describeCycle', async () => description);
    const composition = await compose({ stateDir, statePath, workerOwner: 'clock-test', moneyConfiguration: productionMoneyConfiguration(),
      accounts: { evm: FULL_EVM_ACCOUNT, solana: FULL_SOLANA_ACCOUNT }, relay: { solanaMint: FULL_SOLANA_MINT },
      adapters: { ...minimalInjectedAdapters(), relay }, ...(scenario === 'injected-fresh' ? { now } : {}) });
    t.after(() => composition.shutdown());
    const status = await composition.operatorControl.status();
    assert.equal(status.alertSources.safetyTelemetry, true);
    assert.ok(quoteReads > 0, 'the composed reader must fetch authenticated native pricing');
    assert.equal(status.cap.loss.atRiskMicroUsd, scenario === 'default-stale' ? '0' : '5');
    assert.equal(status.cap.outstandingCustody.usedMicroUsd, scenario === 'default-stale' ? '0' : '5');
    assert.equal(status.cap.heldPositions.count, 1);
    assert.equal(status.cap.heldPositions.valueMicroUsd, '700000', 'held purchase cost is frozen separately from native principal');
  });
}
