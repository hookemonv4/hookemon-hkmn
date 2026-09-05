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

import { acquireLease } from '../../../runner/src/automation/exclusive-lease.mjs';
import { createEmptyOperatorState, mutateOperatorState, readOperatorState } from '../../../runner/src/operator/state-file.mjs';
import { applyOperatorConfiguration } from '../../../runner/src/config/state-schema.mjs';
import { digest } from '../../../runner/src/cycle/journal.mjs';
import { createRequestListener } from '../../../dashboard/src/server.mjs';
import { appendAuditEntry, readAllAuditEntries } from '../../../dashboard/src/auth/audit-log.mjs';
import { compose as composeRoot } from '../../src/app/compose.mjs';
import {
  CYCLE_REPOSITORY_CLIENT_INTERFACE,
  assertCycleRepositoryClientInterface,
  CycleRepository,
} from '../../src/app/cycle-repository.mjs';
import { createFileLeaseStore } from '../../src/app/lease-store.mjs';
import { runOnePass as runVerifierPass } from '../../bin/hookemon-verifier.mjs';
import { DISTRIBUTION_SIGNER_ROLE, VERIFIER_ROLE } from '../../../runner/src/distribution/distribution-signer.mjs';
import { createSolanaRpcClient } from '../../src/solana-rpc.mjs';
import { MoneyConfigurationRejected } from '../../src/app/environment.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { AUTOMATED_CYCLE_STAGES } from '../../../runner/src/automation/automated-cycle-service.mjs';
import { stepAuthorizationIntentDigest } from '../../../runner/src/cycle/authorization-provider.mjs';
import {
  buildAndSignStepAuthorization,
  createProductionTestFixture,
} from '../../../runner/test/cycle/production-cycle.mjs';
import { privateKeyToAccount, serializeSignature, sign as signSecp256k1 } from 'viem/accounts';

const DASHBOARD_CREDENTIAL = 'd'.repeat(40);
const SOLANA_MAINNET_GENESIS_HASH = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

const SUFFICIENT_BUDGET = Object.freeze({
  availableProcessUsdg: '10',
  packPriceUsdg: '1',
  outboundCapUsdg: '0',
  returnCapUsdg: '0',
  operatingMarginUsdg: '0',
});

function productionMoneyConfiguration() {
  return {
    schema: 'hookemon.money-configuration.v1',
    assets: {
      usdg: { chainId: '4663', assetId: '0x0000000000000000000000000000000000000001', decimals: 6 },
      solanaStablecoin: {
        chainId: '792703809',
        assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        decimals: 6,
      },
    },
    minimums: {
      robinhoodReceive: { chainId: '4663', assetId: '0x0000000000000000000000000000000000000001', decimals: 6, amountAtomic: '0' },
      solanaReceive: {
        chainId: '792703809',
        assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
        decimals: 6,
        amountAtomic: '0',
      },
      returnUsdg: { chainId: '4663', assetId: '0x0000000000000000000000000000000000000001', decimals: 6, amountAtomic: '0' },
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

const OBSERVABILITY_PINS = Object.freeze({
  usdgProxy: '0x0000000000000000000000000000000000000001',
  usdgImplementation: '0x0000000000000000000000000000000000000002',
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
      contracts: {
        usdg: { proxy: pin(OBSERVABILITY_PINS.usdgProxy), implementation: pin(OBSERVABILITY_PINS.usdgImplementation), decimals: 6 },
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
}) {
  const cycleRepository = await CycleRepository.open(join(stateDir, 'cycles'), () => 1_000);
  const cycle = await cycleRepository.createCycle({
    releaseAmount,
    mode,
    ...(providerMode === null ? {} : { providerMode }),
  });
  for (const { stage, evidence = { seeded: true } } of completedStages) {
    await cycleRepository.prepareStage(cycle.cycleId, stage);
    await cycleRepository.completeStage(cycle.cycleId, stage, evidence);
  }
  return cycle;
}

function baseConfigurationPatch(overrides = {}) {
  return {
    intervalMinutes: 5,
    allowedPackIds: [],
    requestedOrders: 0,
    maxBoostersPerCycle: 1,
    maxUnitPriceMicroUsdg: '0',
    maxCycleBudgetMicroUsdg: '0',
    max24HourBudgetMicroUsdg: '0',
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
    maxUnitPriceMicroUsdg: '10',
    maxCycleBudgetMicroUsdg: '10',
    max24HourBudgetMicroUsdg: '10',
    maxCyclesPerDay: 1,
    lossCapMicroUsdg: '20',
    maxOutstandingCustodyMicroUsdg: '20',
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
      async getMachines() { return { machines: [] }; },
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
  return composeRoot(Object.hasOwn(config, 'networkIdentity')
    ? config
    : { ...config, networkIdentity: networkIdentity() });
}

test('compose refuses a production profile without MoneyConfigurationV1 before opening durable state', async t => {
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
  const authorityFixture = createProductionTestFixture();
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

  const composition = await compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    pack: { code: packCode },
    budget: SUFFICIENT_BUDGET,
    contracts: {
      usdg: productionMoneyConfiguration().assets.usdg.assetId,
      usdgDecimals: 6,
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
        async readUsdgPaused() { return false; },
        async readUsdgFrozen() { return false; },
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

  const outcome = await composition.service.runOnce({ liveMode: true });
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
      usdg: productionMoneyConfiguration().assets.usdg.assetId,
      usdgDecimals: 6,
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
  for (const rehearsalCapUsdg of [undefined, '0']) {
    await assert.rejects(
      () => compose({
        ...config,
        execution: {
          profile: 'rehearsal', networkProfile: 'mainnet', providerMode: 'fake', enforceProfile: true, rehearsalCapUsdg,
        },
      }),
      /relay-roundtrip rehearsal requires a positive explicit rehearsalCapUsdg/,
    );
  }
  await assert.rejects(
    () => compose({
      ...config,
      execution: {
        profile: 'rehearsal', networkProfile: 'mainnet', providerMode: 'fake', enforceProfile: true, rehearsalCapUsdg: '30',
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
    'readChainTransactionAttempt', 'readClaimPreconditions', 'listKnownCycleIds',
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
    maxUnitPriceMicroUsdg: '1',
    maxCycleBudgetMicroUsdg: '1',
    max24HourBudgetMicroUsdg: '1',
    maxCyclesPerDay: 1,
    lossCapMicroUsdg: '1',
    maxOutstandingCustodyMicroUsdg: '1',
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

async function createUsdgStatusCanaryFixture(t, { paused, frozen }) {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath, livePolicyPatch('base-pack'));
  const cycle = await seedCycle(stateDir, {
    releaseAmount: '1',
    mode: 'production',
    providerMode: 'live',
    completedStages: [
      { stage: 'eligibility-snapshot' },
      { stage: 'claim-process' },
    ],
  });
  const calls = { mutate: 0, sign: 0, broadcast: 0 };
  const stageHandlers = Object.fromEntries(AUTOMATED_CYCLE_STAGES.map(stage => [stage, {
    async probe() { throw new Error(`${stage} probe must not run after a USDG status failure`); },
    async prepareRequest() { return { stage, request: 'status-canary-test' }; },
    async mutate() {
      calls.mutate += 1;
      throw new Error(`${stage} mutation must not run after a USDG status failure`);
    },
    async reconcileLive() { return null; },
  }]));
  const composition = await compose({
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid', archiveRpcUrl: 'https://archive.example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    pack: { code: 'base-pack' },
    budget: SUFFICIENT_BUDGET,
    contracts: {
      usdg: productionMoneyConfiguration().assets.usdg.assetId,
      usdgDecimals: 6,
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
        async readUsdgPaused() { return paused; },
        async readUsdgFrozen() { return frozen; },
      },
    },
    stageHandlers,
    preflightAuthority: createTestProfileMutationAuthority(),
  });
  const admission = await composition.policyEngine.admit({
    boundary: 'claim-process',
    cycleId: cycle.cycleId,
    releaseAmountMicroUsdg: cycle.releaseAmount,
    packId: 'base-pack',
    liveMode: true,
    mode: 'production',
  });
  assert.equal(admission.allowed, true);
  t.after(() => composition.shutdown());
  return { calls, composition, cycle, stateDir };
}

test('holds an active cycle on a paused USDG status canary before any signing boundary', async t => {
  const { calls, composition, cycle, stateDir } = await createUsdgStatusCanaryFixture(t, {
    paused: true,
    frozen: false,
  });

  await assert.rejects(
    () => composition.service.recoverActiveCycle({ liveMode: true }),
    /USDG status canary failed: USDG_PAUSED/,
  );
  assert.deepEqual(calls, { mutate: 0, sign: 0, broadcast: 0 });

  const reopened = await CycleRepository.open(join(stateDir, 'cycles'));
  const description = await reopened.describeCycle(cycle.cycleId);
  assert.equal(description.terminalState, 'HELD_UNAVAILABLE');
  assert.deepEqual(description.terminalEvidence, {
    schema: 'hookemon.usdg-status-canary-hold.v1',
    stage: 'outbound',
    drift: [{
      code: 'USDG_PAUSED',
      target: 'USDG pause state',
      expected: false,
      observed: true,
    }],
  });
  assert.equal((await reopened.readStage(cycle.cycleId, 'outbound')).status, 'PENDING');
  assert.equal(await reopened.readOperationalStageAttempt(cycle.cycleId, 'outbound'), null);
  await assert.rejects(
    () => reopened.prepareStage(cycle.cycleId, 'outbound'),
    /terminal/,
  );
});

test('holds an active cycle on a frozen USDG status canary before any signing boundary', async t => {
  const { calls, composition, cycle, stateDir } = await createUsdgStatusCanaryFixture(t, {
    paused: false,
    frozen: true,
  });

  await assert.rejects(
    () => composition.service.recoverActiveCycle({ liveMode: true }),
    /USDG status canary failed: USDG_FROZEN/,
  );
  assert.deepEqual(calls, { mutate: 0, sign: 0, broadcast: 0 });

  const reopened = await CycleRepository.open(join(stateDir, 'cycles'));
  const description = await reopened.describeCycle(cycle.cycleId);
  assert.equal(description.terminalState, 'HELD_UNAVAILABLE');
  assert.deepEqual(description.terminalEvidence, {
    schema: 'hookemon.usdg-status-canary-hold.v1',
    stage: 'outbound',
    drift: [{
      code: 'USDG_FROZEN',
      target: 'USDG freeze state',
      expected: false,
      observed: true,
    }],
  });
  assert.equal((await reopened.readStage(cycle.cycleId, 'outbound')).status, 'PENDING');
  assert.equal(await reopened.readOperationalStageAttempt(cycle.cycleId, 'outbound'), null);
  await assert.rejects(
    () => reopened.prepareStage(cycle.cycleId, 'outbound'),
    /terminal/,
  );
});

test('does not create or hold a cycle before an active cycle reaches the USDG status boundary', async t => {
  const stateDir = await tempStateDir(t);
  let pausedReads = 0;
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
      usdg: productionMoneyConfiguration().assets.usdg.assetId,
      usdgDecimals: 6,
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
        async readUsdgPaused() { pausedReads += 1; return true; },
        async readUsdgFrozen() { return false; },
      },
    },
  });
  t.after(() => composition.shutdown());

  assert.deepEqual(await composition.service.runOnce({ liveMode: true }), {
    status: 'WAITING_FOR_PROCESS_BUDGET',
    cycleId: null,
    stage: null,
    requiredProcessUsdg: '1',
  });
  assert.equal(pausedReads, 0);
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

test('explicit production readiness requires the owner\'s first three manual-approval slots before signer construction', async t => {
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

  await assert.rejects(
    () => composition.assertStartReadiness({
      liveMode: true, mode: 'production', requirePolicyConfiguration: true, requireCanaryPreflight: true,
    }),
    /manualApprovalCycles must be at least 3/,
  );

  const state = await readOperatorState(statePath);
  await mutateOperatorState(statePath, state.revision, current => ({
    ...current,
    configuration: applyOperatorConfiguration(current.configuration, { manualApprovalCycles: 3 }),
  }));
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

test('liveMode true: the composed service freezes purchase before any legacy provider call', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath, livePolicyPatch('base-pack'));

  const calls = { generatePack: 0, submitTransaction: 0, openPack: 0 };
  const adapters = {
    collectorCrypt: {
      async getMachines() { return { machines: [] }; },
      async getStatus() { return { machineStatus: 'ok', gachas: [] }; },
      async generatePack({ playerAddress }) {
        calls.generatePack += 1;
        assert.equal(playerAddress, 'PLAYER11111111111111111111111111111111111');
        return { memo: 'memo-live-1', transaction: 'dW5zaWduZWQ=' };
      },
      async submitTransaction({ signedTransaction }) {
        calls.submitTransaction += 1;
        assert.equal(signedTransaction, 'signed:dW5zaWduZWQ=');
        return { success: true, signature: 'sig-live-1', confirmationStatus: 'confirmed' };
      },
      async openPack({ memo }) {
        calls.openPack += 1;
        assert.equal(memo, 'memo-live-1');
        // No `transactionSignature` field: this variant records mint: null (open.mjs never
        // guesses), which is exactly what makes buyback unreachable next, honestly.
        return { success: true };
      },
      getPackStatus: () => { throw new Error('getPackStatus unused in this test'); },
      getBuybackAvailable: () => { throw new Error('getBuybackAvailable must never be reached: open recorded no mint'); },
      buyback: () => { throw new Error('buyback must never be reached: open recorded no mint'); },
    },
    relay: {
      quoteOutboundBridge: () => { throw new Error('unused: funding/outbound are already completed by the seed below'); },
      quoteReturnBridge: () => { throw new Error('unused: return refuses before ever quoting'); },
      simulateExecution: () => { throw new Error('unused in this test'); },
      prepareExecution: () => { throw new Error('unused in this test'); },
    },
    robinhood: { client: { async readContract() { return { requirementsRevision: 0n, chainId: 4663n }; } } },
    solana: { client: {} },
  };
  const signerClient = {
    solana: {
      probe: async () => ({ ready: true }),
      async sign(txBase64) { return { signedTxBase64: `signed:${txBase64}` }; },
    },
  };
  const cycle = await seedCycle(stateDir, {
    releaseAmount: SUFFICIENT_BUDGET.packPriceUsdg,
    completedStages: [
      { stage: 'eligibility-snapshot' },
      { stage: 'claim-process' },
      { stage: 'outbound' },
    ],
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
    contracts: { vault: null, hook: null, usdg: FULL_USDG, usdgDecimals: 6 },
    accounts: { evm: null, solana: 'PLAYER11111111111111111111111111111111111' },
    pack: { code: 'base-pack' },
    budget: SUFFICIENT_BUDGET,
    adapters,
    signerClient,
    observability: liveObservabilityConfig(['solana']),
    observabilityDeps: liveObservabilityDeps(),
    now: () => 1_000,
  });

  // Completed predecessor evidence is seeded before composition so this test isolates the real
  // purchase/open path. The production service normally reaches these records only after their live
  // integrations exist.
  const admission = await composition.policyEngine.admit({
    boundary: 'claim-process',
    cycleId: cycle.cycleId,
    releaseAmountMicroUsdg: cycle.releaseAmount,
    packId: 'base-pack',
    liveMode: true,
  });
  assert.equal(admission.allowed, true);

  await assert.rejects(
    () => composition.service.recoverActiveCycle({ liveMode: true }),
    /stage "purchase" live-mode mutation is INTEGRATION_PENDING/,
    'purchase must stay closed until WP08b supplies policy and finality evidence',
  );

  assert.equal(calls.generatePack, 0, 'purchase must not call collector-crypt before WP08b owns the integration');
  assert.equal(calls.submitTransaction, 0, 'purchase must not sign or submit before WP08b owns the integration');
  assert.equal(calls.openPack, 0, 'open must stay unreachable before purchase reconciles');

  const purchase = await composition.cycleRepository.readStage(cycle.cycleId, 'purchase');
  assert.equal(purchase.status, 'PENDING');
  assert.equal((await composition.cycleRepository.readOperationalStageAttempt(cycle.cycleId, 'purchase')).attempt.state, 'PREPARED');
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
      releaseAmount: SUFFICIENT_BUDGET.packPriceUsdg,
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
      contracts: { vault: null, hook: null, usdg: FULL_USDG, usdgDecimals: 6 },
      pack: { code: 'base-pack' },
      budget: SUFFICIENT_BUDGET,
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
        releaseAmountMicroUsdg: cycle.releaseAmount,
        packId: 'base-pack',
        liveMode: true,
      });
      assert.equal(admission.allowed, true, 'a post-claim stage needs the durable claim reservation');
    }
    await assert.rejects(
      () => composition.service.recoverActiveCycle({ liveMode: true }),
      new RegExp(`stage "${stage}" live-mode mutation is INTEGRATION_PENDING`),
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
async function buildComposedDashboard(t, { statePath, stateDir, configurationPatch = {}, cycleSeed = null } = {}) {
  await writeOperatorState(statePath, configurationPatch);
  const seededCycle = cycleSeed === null ? null : await seedCycle(stateDir, cycleSeed);
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
      releaseAmount: SUFFICIENT_BUDGET.packPriceUsdg,
      completedStages: [
        { stage: 'eligibility-snapshot' },
        { stage: 'claim-process' },
        { stage: 'outbound' },
        { stage: 'purchase', evidence: { memo: 'memo-1', signature: 'sig-1' } },
      ],
    },
  });

  // The seeded cycle has 'purchase' durably COMPLETE, exactly the fact accounting-projection.mjs
  // uses to attribute the cycle's own release amount as real spend.
  const cycle = server.seededCycle;
  assert.notEqual(cycle, null);

  const accounting = await server.composition.dashboard.ctx.readAccounting(cycle.cycleId);
  assert.equal(accounting.packSpendMicroUsdg, SUFFICIENT_BUDGET.packPriceUsdg);
  assert.equal(accounting.holderRewardsStatus, 'not-started');

  // And the exact same object shape reaches the public HTTP contract's validator untouched — proven
  // once at the dashboard-package level (cycle-status-projection.test.mjs), so this only needs to
  // prove compose.mjs's own wiring reaches a real, non-fabricated value.
  assert.notEqual(accounting.packSpendMicroUsdg, '0');
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
const FULL_EVM_ACCOUNT = `0x${'c'.repeat(40)}`;
const FULL_USDG = `0x${'e'.repeat(40)}`;
const FULL_HKMN = `0x${'f'.repeat(40)}`;
const FULL_RETURN_ESCROW = `0x${'d'.repeat(40)}`;
const FULL_SOLANA_ACCOUNT = 'HWPRgtDGpBm8mByTGS57BWCsijMo53qPPSbskWDukfTc';
const FULL_ROUTE_DATA = '0x1234abcd';
const FULL_OPEN_TX_SIGNATURE = 'OpenTransactionSignature1111111111111111111111111111111111111111111111111111';
const FULL_CARD_MINT = 'CardMintAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA1';
const FULL_HOLDER = `0x${'9'.repeat(39)}9`;
const FULL_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const FULL_ESCROW_BALANCE = 24_000_000n;

function fullMoneyConfiguration() {
  const configuration = productionMoneyConfiguration();
  const usdg = { ...configuration.assets.usdg, assetId: FULL_USDG };
  return {
    ...configuration,
    assets: { ...configuration.assets, usdg },
    minimums: {
      ...configuration.minimums,
      robinhoodReceive: { ...configuration.minimums.robinhoodReceive, assetId: FULL_USDG },
      returnUsdg: { ...configuration.minimums.returnUsdg, assetId: FULL_USDG },
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
    getMachines: () => { throw new Error('unused in liveMode true'); },
    getStatus: () => { throw new Error('unused in liveMode true'); },
    getPackStatus: () => { throw new Error('unused in liveMode true'); },
  };
}

function fullRelayClient() {
  return {
    async quoteOutboundBridge({ amount, user, recipient }) {
      return { requestId: 'req-outbound-full', origin: { amount }, destination: { amount }, raw: { steps: [{ data: { data: FULL_ROUTE_DATA } }] } };
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
}

test('liveMode true fails closed before claim signing when canonical nonce reads are unavailable', async t => {
  const stateDir = await tempStateDir(t);
  const statePath = join(stateDir, 'operator-state.json');
  await writeOperatorState(statePath, livePolicyPatch('collector-nova'));
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
    stateDir,
    statePath,
    workerOwner: 'test-worker',
    leaseTtlMs: 30_000,
    robinhood: { rpcUrl: 'https://example.invalid' },
    solana: { rpcUrl: 'https://example.invalid' },
    relay: { baseUrl: 'https://example.invalid' },
    collectorCrypt: { baseUrl: 'https://example.invalid' },
    contracts: { vault: FULL_VAULT, hook: FULL_HOOK, usdg: FULL_USDG, usdgDecimals: 6 },
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
