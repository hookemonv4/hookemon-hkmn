import { requireNativePaymentBinding } from '../native-payment-proof.mjs';
// The production composition root: wires the real scheduler (packages/runner/src/scheduler), the
// real automation service (packages/runner/src/automation/automated-cycle-service.mjs), the durable
// cycle repository and on-disk lease store (this directory), and the real provider adapters
// (packages/adapters/src) into one object a CLI or test can drive. Every dependency comes from the
// explicit `config` object this module is called with — no file path, RPC URL, or credential is ever
// hardcoded here; see environment.mjs for how `config` is normally built from the process
// environment, and packages/adapters/README.md for the injected-transport pattern tests use instead.
import { join } from 'node:path';

import { http } from 'viem';

import { AutomatedCycleService } from '../../../runner/src/automation/automated-cycle-service.mjs';
import { assertCollectorOnlyRehearsalPolicy, createPolicyEngine } from '../../../runner/src/automation/policy-engine.mjs';
import { createRehearsalStageDriver } from '../../../runner/src/cycle/rehearsal-stage-driver.mjs';
import { collectRehearsalEvidence, ensureRehearsalEvidence } from '../../../runner/src/cycle/rehearsal-evidence.mjs';
import { MAXIMUM_PACK_BATCH_SIZE } from '../../../runner/src/cycle/money-schemas.mjs';
import { createOperatorControl } from '../../../runner/src/operator/control.mjs';
import { inspectCycleRecovery } from '../../../runner/src/operator/cli.mjs';
import { createScheduler } from '../../../runner/src/scheduler/scheduler.mjs';
import { mutateOperatorState, readOperatorState } from '../../../runner/src/operator/state-file.mjs';
import { createRequestListener } from '../../../dashboard/src/server.mjs';
import { openSqliteProjection } from '../../../dashboard/src/storage/sqlite-projection.mjs';
import { executeAuditedCommand, readAllAuditEntries, verifyAuditChain } from '../../../dashboard/src/auth/audit-log.mjs';
import { createAccessJwtVerifier } from '../../../dashboard/src/auth/access-jwt.mjs';
import { assertProxyCredentialConfigured } from '../../../dashboard/src/auth/proxy-credential.mjs';
import { readDashboardProfile } from '../../../dashboard/src/contracts/dashboard-profile.mjs';
import { deriveOnchainCycleId } from './stages/action-builder.mjs';
import { createCollectorCryptClient } from '../collector-crypt.mjs';
import { createRelayClient, createQuoteUsdValuation, isProcessQuoteUsdValuation } from '../relay-client.mjs';
import {
  createHistoricalErc20EvidenceClient, createRobinhoodClient, readBlockByNumber, readChainId,
  readFinalizedBlock,
} from '../robinhood-rpc.mjs';
import { createSolanaRpcClient, readSolBalance, readUsableLatestBlockhash, readOriginalBlockhashContext } from '../solana-rpc.mjs';
import { attachCollectorPolicyBundle, loadCollectorPolicyBundle } from '../signing/collector-policy-loader.mjs';
import {
  COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE,
  createLoopbackConfinedFetch,
  loadCollectorProductionBindingRegistry,
} from '../signing/collector-production-binding.mjs';
import { buildDurableCardFeed } from '../collector/durable-card-feed.mjs';
import { createRecentWinnersCollector } from '../collector/recent-winners.mjs';
import {
  assertCycleRepositoryInterface,
  createCycleRepositoryClient,
  createCycleRepositoryRunner,
  CycleRepository,
} from './cycle-repository.mjs';
import { createFileLeaseStore } from './lease-store.mjs';
import { createCycleAttributableFinalizedAvailableReader } from './payout-availability.mjs';
import { createObservability } from './observability.mjs';
import { createStageDriver } from './stage-driver.mjs';
import { projectCycleAccounting, projectPolicyCustody } from './accounting-projection.mjs';
import { MoneyConfigurationRejected, validateMoneyConfiguration } from './environment.mjs';
import { createSupplementaryBuybackHandler } from './stages/supplementary-buyback.mjs';
import {
  mutateSupplementaryPayout,
  mutateSupplementaryReturn,
  reconcileSupplementaryReturn,
} from './stages/supplementary-money.mjs';

export { validateMoneyConfiguration } from './environment.mjs';

const decimalPattern = /^(0|[1-9][0-9]*)$/;
const solanaGenesisHashPattern = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;

function assertDecimal(value, label) {
  if (typeof value !== 'string' || !decimalPattern.test(value)) throw new Error(`${label} must be a canonical unsigned decimal string`);
}

function resolveMoneyConfiguration(value, execution) {
  if (value === null || value === undefined) {
    if (execution.profile === 'inspection') return null;
    throw new MoneyConfigurationRejected('compose requires MoneyConfigurationV1 outside inspection');
  }
  return validateMoneyConfiguration(value);
}

const missingStateFileMessage = 'operator state file does not exist';

function emptyPolicyCustody({ unvaluedExposure = false } = {}) {
  return Object.freeze({
    realizedLossMicroUsd: '0',
    atRiskMicroUsd: '0',
    outstandingMicroUsd: '0',
    heldAssets: false,
    heldPositions: Object.freeze({ count: 0, valueMicroUsd: '0', positions: Object.freeze([]) }),
    unattributed: false,
    unvaluedExposure,
    cycles: Object.freeze([]),
  });
}

function configuredEvmNativeAsset(config) {
  const asset = config.moneyConfiguration?.assets?.eth;
  if (asset?.chainId !== '4663' || asset.assetId !== 'native' || asset.decimals !== 18) return null;
  return Object.freeze({ ...asset });
}

function isLiveCollectorOnlyRehearsal(config) {
  return config?.execution?.profile === 'rehearsal'
    && config.execution?.providerMode === 'live'
    && config.rehearsal?.mode === 'collector-only';
}

function collectorOnlyPackPrice(config) {
  const amountAtomic = config?.collectorCrypt?.packPrice?.amountAtomic;
  if (typeof config?.pack?.code !== 'string' || config.pack.code.length === 0
    || typeof amountAtomic !== 'string' || !decimalPattern.test(amountAtomic) || amountAtomic === '0') {
    throw new Error('live collector-only rehearsal requires a configured pack and typed positive pack price');
  }
  return amountAtomic;
}

async function readPolicyConfiguration(statePath) {
  try {
    return (await readOperatorState(statePath)).configuration;
  } catch (error) {
    if (error?.message === missingStateFileMessage) return null;
    throw error;
  }
}

function retryablePolicyStateError(error) {
  return error?.message === 'stale operator state revision' || error?.message === 'operator state lock contention';
}

async function mutatePolicyConfiguration({ statePath, mutation, expectedRevision = undefined }) {
  if (expectedRevision !== undefined && expectedRevision !== null
    && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)) {
    throw new Error('policy configuration expected revision is invalid');
  }
  const attempts = expectedRevision === undefined ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const state = await readOperatorState(statePath).catch(error => {
      if (error?.message === missingStateFileMessage) return null;
      throw error;
    });
    if (state === null || state.configuration === null) throw new Error('policy configuration is missing');
    if (expectedRevision !== undefined && expectedRevision !== state.revision) {
      throw new Error('stale operator state revision');
    }
    let result;
    try {
      await mutateOperatorState(statePath, expectedRevision ?? state.revision, async current => {
        if (current === null || current.configuration === null) throw new Error('policy configuration is missing');
        const outcome = await mutation(current.configuration);
        if (!outcome || typeof outcome !== 'object' || !Object.hasOwn(outcome, 'configuration') || !Object.hasOwn(outcome, 'result')) {
          throw new Error('policy configuration mutation returned an invalid outcome');
        }
        result = outcome.result;
        return { ...current, configuration: outcome.configuration };
      });
      return result;
    } catch (error) {
      if (expectedRevision !== undefined || !retryablePolicyStateError(error) || attempt === attempts - 1) throw error;
    }
  }
  throw new Error('policy configuration mutation retry loop was exhausted');
}

function buildPolicyCustodyReader({ config, cycleRepository, relay }) {
  const nativeAsset = configuredEvmNativeAsset(config);
  if (nativeAsset === null) return async () => emptyPolicyCustody({ unvaluedExposure: true });
  const valueAmountUsd = async (amount, { rounding }) => {
    const quote = await relay.quoteOutboundBridge({ user: config.accounts.evm, recipient: config.accounts.solana,
      amount: amount.amountAtomic, tradeType: 'EXACT_INPUT', destinationCurrency: config.relay.solanaMint });
    return createQuoteUsdValuation({ quote, side: 'origin', amount, rounding, nowMs: config.now() });
  };
  return async () => projectPolicyCustody({ cycleRepository, nativeAsset, valueAmountUsd, now: config.now });
}

function operatorAuditResultCode(command) {
  if (command?.type === 'run-cycle-now') return 'TICK_TRIGGERED';
  if (command?.type === 'resume-cycle') return 'RECOVERY_DISPATCHED';
  if (command?.type === 'reconcile') return 'RECONCILIATION_DISPATCHED';
  return 'DECISION_ACCEPTED';
}

function withResumeAuditResult(command, result) {
  if (command?.type !== 'resume-cycle' || !result || typeof result !== 'object' || Array.isArray(result)
    || typeof result.resultCode !== 'string' || result.resultCode.length === 0) {
    return result;
  }
  return { ...result, auditResultCode: result.resultCode };
}

/** Builds the dashboard request context in-process, beside the scheduler. The injected
 * `operatorControl` owns every operation through the scheduler's writable repository, policy
 * engine, and state file. The dashboard receives only a frozen read-only client over that same
 * repository, so it cannot create a second lifecycle store or turn reconciliation into recovery.
 *
 * @param {object} input
 * @param {object} input.dashboardConfig - `{ profileId, proxyCredential, port, sqlitePath,
 *   auditLogPath, access }` (see `resolveDashboardConfig`).
 * @param {object} input.cycleRepository - a frozen read-only client over the repository the
 * scheduler uses.
 * @param {number} input.chainId - the runner's validated EVM chain ID.
 * @param {object} input.operatorControl - the composed runner control authority.
 * @param {() => {at: number, intervalMs: number}|null} input.readLastTick
 */
function nullableString(value) {
  return typeof value === 'string' ? value : null;
}

function buildDashboardIdentities(config) {
  const contracts = config.contracts ?? {};
  const accounts = config.accounts ?? {};
  const signer = config.signer ?? {};
  const distribution = config.distribution ?? {};
  return Object.freeze({
    treasuryAddress: nullableString(contracts.treasury),
    vaultAddress: nullableString(contracts.vault),
    hookAddress: nullableString(contracts.hook),
    hkmnAddress: nullableString(config.hkmn?.address),
    poolAddress: nullableString(contracts.pool),
    evmAccount: nullableString(accounts.evm),
    solanaAccount: nullableString(accounts.solana),
    signerBackend: nullableString(signer.backend),
    distributionProfile: nullableString(distribution.profile),
    distributionSignerAddress: nullableString(distribution.signerAddress),
    distributionVerifierAddress: nullableString(distribution.verifierAddress),
    collectorCryptConfigured: Boolean(config.collectorCrypt?.apiKey),
    relayConfigured: Boolean(config.relay?.apiKey),
    rehearsalMode: nullableString(config.rehearsal?.mode),
  });
}

async function composeDashboard({ dashboardConfig, chainId, operationsAddress, cycleRepository, operatorControl, readLastTick, adapters, identities, getSchedulerView, listRecentWinners }) {
  const auditVerification = await verifyAuditChain(dashboardConfig.auditLogPath);
  if (!auditVerification.valid) {
    throw new Error(`compose dashboard audit chain is invalid at sequence ${auditVerification.brokenAtSequence}: ${auditVerification.reason}`);
  }
  const sqliteProjection = openSqliteProjection(dashboardConfig.sqlitePath);
  const auditEntries = await readAllAuditEntries(dashboardConfig.auditLogPath);
  sqliteProjection.rebuildAuditProjection(auditEntries);

  const accessJwtVerifier = dashboardConfig.access
    ? createAccessJwtVerifier({
      jwksUrl: dashboardConfig.access.jwksUrl,
      issuer: dashboardConfig.access.issuer,
      audience: dashboardConfig.access.audience,
    })
    : undefined;

  const ctx = {
    profileId: dashboardConfig.profileId,
    chainId,
    proxyCredential: dashboardConfig.proxyCredential,
    cycleRepository,
    operatorControl,
    sqliteProjection,
    auditLogPath: dashboardConfig.auditLogPath,
    accessJwtVerifier,
    lastTick: readLastTick,
    listPacks: adapters.collectorCrypt
      ? async () => adapters.collectorCrypt.getMachines()
      : null,
    identities,
    // Real per-cycle accounting (routes/public.mjs's `ctx.readAccounting` seam, threaded through
    // status-projection.mjs's own `readAccounting` parameter) — see accounting-projection.mjs's own
    // header for exactly which fields this can and cannot honestly report today.
    async readAccounting(cycleId) {
      return projectCycleAccounting({ cycleRepository, cycleId, trustedPayoutContext: {
        nativeAsset: { chainId: '4663', assetId: 'native', decimals: 18 },
        operationsAddress,
      } });
    },
    // Public-Integration-interface.md binding 2: the frozen SchedulerView, read synchronously off
    // the real running scheduler — never wrapped in a Promise, never a second timer's guess.
    getSchedulerView,
    // Public-Integration-interface.md binding 3: real recently-revealed cards, deduplicated and
    // attributed to this project's own known operations, never a second source of financial truth.
    listRecentWinners,
    onError(route, error) {
      // eslint-disable-next-line no-console -- this composition has no injected logger seam; stderr
      // is the whole observability story for a dependency-free node:http process.
      console.error(`[dashboard] ${route} failed:`, error);
    },
    async close() {
      sqliteProjection.close();
    },
  };

  return {
    ctx,
    port: dashboardConfig.port,
    listener: createRequestListener(ctx),
    async close() {
      await ctx.close();
    },
  };
}

/** Fills in the same defaults packages/dashboard/src/server.mjs's own `readEnvironmentConfig` uses
 * (`sqlitePath`/`auditLogPath` under `stateDir` unless overridden), and validates the proxy
 * credential the same fail-loud way. Returns `null` when `dashboardInput` itself is `null`/
 * `undefined` — the composition simply has no dashboard in that case (see `bin/hookemon-runner.mjs`'s
 * `--no-dashboard`). */
function resolveDashboardConfig(stateDir, dashboardInput, chainId) {
  if (dashboardInput === null || dashboardInput === undefined) return null;
  if (typeof dashboardInput !== 'object' || Array.isArray(dashboardInput)) throw new Error('compose config.dashboard must be an object or null');
  const {
    profileId = 'mainnet',
    proxyCredential,
    port = 8787,
    sqlitePath = join(stateDir, 'dashboard-projection.sqlite'),
    auditLogPath = join(stateDir, 'dashboard-audit.log'),
    access = null,
  } = dashboardInput;
  if (profileId !== 'testnet' && profileId !== 'mainnet') throw new Error('compose config.dashboard.profileId must be "testnet" or "mainnet"');
  const profileChainId = readDashboardProfile(profileId).network.evm.chainId;
  if (chainId !== profileChainId) {
    throw new Error(`compose dashboard profile ${profileId} does not match chain ${chainId} (${profileChainId} required)`);
  }
  assertProxyCredentialConfigured(proxyCredential);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('compose config.dashboard.port must be a valid port number');
  if (access !== null) {
    if (typeof access !== 'object' || typeof access.jwksUrl !== 'string' || typeof access.issuer !== 'string' || typeof access.audience !== 'string') {
      throw new Error('compose config.dashboard.access must be {jwksUrl, issuer, audience} or null');
    }
  }
  return Object.freeze({ profileId, proxyCredential, port, sqlitePath, auditLogPath, access });
}

/** Resolve the one append-only audit ledger used by all local operator entry points. A dashboard
 * listener and the listener-free installed CLI may only coexist when they name the same ledger. */
function resolveOperatorAuditLogPath(stateDir, dashboardConfig, override) {
  if (override !== undefined && (typeof override !== 'string' || override.length === 0)) {
    throw new Error('compose config.operatorAuditLogPath must be a nonempty string when supplied');
  }
  if (dashboardConfig !== null && override !== undefined && override !== dashboardConfig.auditLogPath) {
    throw new Error('compose config.operatorAuditLogPath must match dashboard.auditLogPath');
  }
  return override ?? dashboardConfig?.auditLogPath ?? join(stateDir, 'dashboard-audit.log');
}

/** Real Collector Crypt / Relay / Robinhood / Solana clients from `config`, or `null` where the
 * operator has not supplied enough configuration to construct one — stage-driver.mjs's probes and
 * mutations both treat `null` as "not configured" rather than throwing at composition time, so a
 * partially-configured operator can still run a dry-run cycle against whichever adapters are ready.
 * Tests override any of these by passing pre-built fake-transport clients directly as
 * `config.adapters.*` instead (see packages/adapters/README.md's injected-transport pattern; every
 * existing adapter test uses `fetchImpl`/`transport` injection the same way). */
function archiveEvidenceClientFromConfig(config, { transport } = {}) {
  const archiveRpcUrl = config?.robinhood?.archiveRpcUrl;
  if (archiveRpcUrl === null || archiveRpcUrl === undefined) return null;
  if (typeof archiveRpcUrl !== 'string' || archiveRpcUrl.length === 0) {
    throw new Error('compose robinhood.archiveRpcUrl must be a nonempty URL when supplied');
  }
  if (archiveRpcUrl === config?.robinhood?.rpcUrl) {
    throw new Error('compose robinhood.archiveRpcUrl must be distinct from robinhood.rpcUrl');
  }
  return createHistoricalErc20EvidenceClient({
    client: createRobinhoodClient({ rpcUrl: archiveRpcUrl, transport }),
  });
}

function buildAdapters(config) {
  const injectedEvidenceClient = config.historicalEvidenceClient;
  if (config.adapters) {
    const configuredEvidenceClient = config.adapters?.robinhood?.historicalEvidenceClient;
    if (injectedEvidenceClient !== undefined && configuredEvidenceClient !== undefined
      && injectedEvidenceClient !== configuredEvidenceClient) {
      throw new Error('compose historical evidence client conflicts with adapters.robinhood.historicalEvidenceClient');
    }
    const evidenceClient = injectedEvidenceClient ?? configuredEvidenceClient ?? archiveEvidenceClientFromConfig(config);
    if (evidenceClient === configuredEvidenceClient) return config.adapters;
    return {
      ...config.adapters,
      robinhood: {
        ...config.adapters.robinhood,
        historicalEvidenceClient: evidenceClient,
      },
    };
  }

  const fakeProvider = kind => Object.freeze({
    kind: 'hookemon.rehearsal-fake-provider.v1',
    async executeRehearsalEffect(effect) {
      if (!effect || typeof effect !== 'object' || effect.provider !== kind || typeof effect.effectId !== 'string') {
        throw new Error(`rehearsal fake ${kind} provider received an invalid effect`);
      }
      return Object.freeze({ provider: kind, effectId: effect.effectId });
    },
  });

  // Redirect confinement for exactly the synthetic-offline evidence boundary: an already-loopback
  // `baseUrl`/`rpcUrl` does not by itself stop a misbehaving local mock from handing a client a
  // 3xx response pointing outward. Collector, Relay, and Solana RPC all accept an injectable
  // `fetchImpl`; the three Robinhood/EVM construction sites (primary client, secondaryLogClient,
  // archiveEvidenceClientFromConfig) get the same confined fetch through viem's own `http(url,
  // {fetchFn})` transport, so every actually-constructed external transport is covered.
  const offlineTransportFetch = config.collectorCrypt?.productionBindingAuthority === COLLECTOR_PRODUCTION_BINDING_AUTHORITY_SYNTHETIC_OFFLINE
    ? createLoopbackConfinedFetch()
    : null;
  const offlineHttpTransport = rpcUrl => (offlineTransportFetch === null ? undefined : http(rpcUrl, { fetchFn: offlineTransportFetch }));
  const collectorCrypt = config.execution?.providerMode === 'fake'
    ? fakeProvider('collector')
    : config.collectorCrypt.apiKey
    ? createCollectorCryptClient({
      apiKey: config.collectorCrypt.apiKey,
      baseUrl: config.collectorCrypt.baseUrl,
      ...(offlineTransportFetch === null ? {} : { fetchImpl: offlineTransportFetch }),
    })
    : null;
  const liveCollectorOnly = isLiveCollectorOnlyRehearsal(config);
  const relay = config.execution?.providerMode === 'fake'
    ? fakeProvider('relay')
    : liveCollectorOnly
      ? null
      : createRelayClient({
        baseUrl: config.relay.baseUrl,
        apiKey: config.relay.apiKey ?? undefined,
        quoteValidityMs: config.relayQuoteValidityMs ?? null,
        now: config.now ?? Date.now,
        ...(offlineTransportFetch === null ? {} : { fetchImpl: offlineTransportFetch }),
      });
  const robinhoodClient = liveCollectorOnly ? null : createRobinhoodClient({
    rpcUrl: config.robinhood.rpcUrl,
    transport: offlineHttpTransport(config.robinhood.rpcUrl),
  });
  const secondaryLogClient = liveCollectorOnly || config.robinhood.archiveRpcUrl === null || config.robinhood.archiveRpcUrl === undefined
    ? null
    : createRobinhoodClient({ rpcUrl: config.robinhood.archiveRpcUrl, transport: offlineHttpTransport(config.robinhood.archiveRpcUrl) });
  const solanaClient = createSolanaRpcClient({
    rpcUrl: config.solana.rpcUrl,
    ...(offlineTransportFetch === null ? {} : { fetchImpl: offlineTransportFetch }),
  });
  const historicalEvidenceClient = injectedEvidenceClient
    ?? archiveEvidenceClientFromConfig(config, { transport: offlineHttpTransport(config.robinhood.archiveRpcUrl) });

  return {
    collectorCrypt,
    relay,
    robinhood: {
      client: robinhoodClient,
      ...(secondaryLogClient === null ? {} : { secondaryLogClient }),
      ...(historicalEvidenceClient === null ? {} : { historicalEvidenceClient }),
    },
    solana: { client: solanaClient },
  };
}

/** The one trusted `config.solana.blockhashContextResolver` purchase/buyback/supplementary-buyback
 * and signed transaction-policy revalidation all consume (packages/adapters/src/signing/
 * transaction-policy.mjs). It refuses any provider blockhash that is not the configured Solana
 * client's own current latest usable blockhash, because only that RPC pair's `lastValidBlockHeight`
 * is trustworthy -- a still-valid older blockhash has no independently recoverable deadline. */
export function createTrustedSolanaBlockhashContextResolver(client) {
  return async function trustedSolanaBlockhashContextResolver(observedBlockhash) {
    const latest = await readUsableLatestBlockhash(client);
    if (latest.blockhash !== observedBlockhash) {
      throw new Error('compose Solana blockhashContextResolver refuses a blockhash that is not the current latest');
    }
    return { blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight };
  };
}

/** Purchase-only resolver for immutable, provider-signed original messages. */
export function createOriginalSolanaBlockhashContextResolver(client) {
  return blockhash => readOriginalBlockhashContext(client, blockhash);
}

/** The public Robinhood endpoint has verified latest-only state reads, so it is never a valid
 * source of historical settlement evidence. Production requires a separate archive-capable
 * client, either injected explicitly or built from the distinct configured archive endpoint. */
function assertProductionHistoricalEvidenceClient(adapters) {
  const publicClient = adapters?.robinhood?.client;
  const evidenceClient = adapters?.robinhood?.historicalEvidenceClient;
  if (!evidenceClient || typeof evidenceClient.readErc20BalanceAtBlock !== 'function') {
    throw new Error('compose production requires an archive-capable historical evidence client with readErc20BalanceAtBlock');
  }
  if (evidenceClient === publicClient) {
    throw new Error('compose historical evidence client must be distinct from the public Robinhood RPC client');
  }
  return evidenceClient;
}

function unavailableNetworkIdentity(network) {
  throw new Error(`compose ${network} network identity unavailable`);
}

function requireNetworkIdentity(value, { requireEvm = true } = {}) {
  if (!value || (requireEvm && typeof value.readEvmChainId !== 'function') || typeof value.readSolanaGenesisHash !== 'function') {
    unavailableNetworkIdentity('injected');
  }
  return value;
}

async function readSolanaGenesisHash(client) {
  if (!client || typeof client.rpcUrl !== 'string' || typeof client.fetchImpl !== 'function') {
    unavailableNetworkIdentity('Solana');
  }
  let response;
  try {
    response = await client.fetchImpl(
      client.rpcUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'compose-network-identity', method: 'getGenesisHash', params: [] }),
      },
      client.timeoutMs,
    );
  } catch {
    unavailableNetworkIdentity('Solana');
  }
  if (!response?.ok || typeof response.text !== 'function') unavailableNetworkIdentity('Solana');

  let payload;
  try {
    payload = JSON.parse(await response.text());
  } catch {
    unavailableNetworkIdentity('Solana');
  }
  if (payload?.error || typeof payload?.result !== 'string' || !solanaGenesisHashPattern.test(payload.result)) {
    unavailableNetworkIdentity('Solana');
  }
  return payload.result;
}

function networkIdentityFor(config, adapters, { requireEvm = true } = {}) {
  if (config.networkIdentity !== undefined) return requireNetworkIdentity(config.networkIdentity, { requireEvm });
  if (config.adapters) unavailableNetworkIdentity('injected');
  return Object.freeze({
    ...(requireEvm ? { readEvmChainId: () => readChainId(adapters?.robinhood?.client) } : {}),
    readSolanaGenesisHash: () => readSolanaGenesisHash(adapters?.solana?.client),
  });
}

async function assertNetworkIdentity({ config, adapters, profileId, requireEvm = true }) {
  const profile = readDashboardProfile(profileId);
  const identity = networkIdentityFor(config, adapters, { requireEvm });
  if (requireEvm) {
    let evmChainId;
    try {
      evmChainId = await identity.readEvmChainId();
    } catch {
      unavailableNetworkIdentity('EVM');
    }
    if (!Number.isSafeInteger(evmChainId) || evmChainId <= 0) unavailableNetworkIdentity('EVM');
    if (evmChainId !== config.chainId) {
      throw new Error(`compose EVM network identity mismatch: expected chain ${config.chainId}, received ${evmChainId}`);
    }
  }

  let solanaGenesisHash;
  try {
    solanaGenesisHash = await identity.readSolanaGenesisHash();
  } catch {
    unavailableNetworkIdentity('Solana');
  }
  if (solanaGenesisHash !== profile.network.solana.genesisHash) {
    throw new Error('compose Solana network identity mismatch');
  }
}

function composeObservability({ config, adapters, cycleRepository }) {
  if (config.observability === undefined || config.observability === null) return null;
  if (typeof config.observability !== 'object' || Array.isArray(config.observability)) {
    throw new Error('compose config.observability must be an object or null');
  }
  const injected = config.observabilityDeps ?? {};
  if (typeof injected !== 'object' || Array.isArray(injected)) {
    throw new Error('compose config.observabilityDeps must be an object when provided');
  }
  return createObservability(config.observability, {
    ...injected,
    evmClient: injected.evmClient ?? adapters?.robinhood?.client,
    solanaClient: injected.solanaClient ?? adapters?.solana?.client,
    cycleRepository,
    signers: config.signerReadiness ?? config.signerClient,
  });
}

function withRestartInjection(stageDriver, restartInjector) {
  if (restartInjector === null || restartInjector === undefined) return stageDriver;
  if (typeof restartInjector !== 'function') throw new Error('compose restartInjector must be a function');
  return Object.freeze({
    ...stageDriver,
    async execute(context) {
      await stageDriver.execute(context);
      await restartInjector(Object.freeze({
        cycleId: context.cycleId,
        stage: context.stage,
        fencingToken: context.fencingToken,
      }));
    },
  });
}

/** Reads observed reserve inputs from composition config and the spend limit from the current
 * operator state. A missing or disabled configuration returns a non-ready budget for a live
 * service, while a dry-run remains able to exercise its explicitly supplied read-only budget. */
const CATALOG_PRICE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/**
 * Scales a catalog price expressed in whole settlement units into atomic units without ever going
 * through a float. A price with more fractional digits than the asset has decimals is refused
 * rather than rounded: rounding a pack price silently changes what the cycle is authorized to buy.
 */
function catalogAtomicAmount(price, decimals, label) {
  const text = typeof price === 'number' && Number.isFinite(price) ? String(price) : price;
  if (typeof text !== 'string' || !CATALOG_PRICE.test(text)) {
    throw new Error(`${label} is not a canonical catalog price`);
  }
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) throw new Error(`${label} has more precision than the settlement asset`);
  const atomic = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction.padEnd(decimals, '0')) || '0');
  if (atomic <= 0n) throw new Error(`${label} must be positive`);
  return atomic;
}

/** The one configured machine for this pack, with its price validated as exact catalog evidence. */
function admittedCatalogUnit({ catalog, packId, settlementAsset }) {
  if (!catalog || typeof catalog !== 'object' || !Array.isArray(catalog.machines)) {
    throw new Error('admission planner received an invalid Collector machine catalog');
  }
  const matches = catalog.machines.filter(machine => machine && typeof machine === 'object' && machine.code === packId);
  if (matches.length !== 1) throw new Error('admission planner requires exactly one configured Collector machine');
  const [machine] = matches;
  if (machine.available === false || machine.enabled === false) {
    throw new Error('admission planner refuses an unavailable Collector machine');
  }
  return catalogAtomicAmount(machine.price, settlementAsset.decimals, `Collector machine "${packId}" price`);
}

function typedAdmissionAmount(asset, amountAtomic) {
  return Object.freeze({
    chainId: asset.chainId, assetId: asset.assetId, decimals: asset.decimals, amountAtomic: amountAtomic.toString(),
  });
}

function admittedRelayIdentity(quote) {
  return Object.freeze({
    tradeType: 'EXACT_OUTPUT',
    requestId: quote.requestId,
    orderId: quote.orderId,
    deadlineUnixSeconds: quote.deadlineUnixSeconds,
    sender: quote.sender,
    recipient: quote.recipient,
    destinationAmount: quote.destination.amount,
    destinationMinimumAmount: quote.destination.minimumAmount,
    quoteDigest: quote.quoteDigest,
  });
}

/**
 * Plans the quote-bound admission a live cycle is opened under.
 *
 * Two quotes are obtained, never one. The unit quote prices exactly one configured pack and is the
 * only thing compared against the operator's per-unit ceiling; the aggregate quote prices the whole
 * requested quantity and is the only thing compared against the per-cycle and rolling caps. The
 * aggregate is never divided to obtain a unit price, and the unit is never multiplied to obtain an
 * aggregate: fees and slippage are not linear in quantity, so either substitution would authorize a
 * spend nobody quoted. Both are EXACT_OUTPUT, so Relay reports the source USDG required to deliver
 * an exact settlement-asset target rather than leaving the delivered amount to vary.
 *
 * Returns `null` when the configuration cannot admit a cycle at all, which the service reports as
 * WAITING_FOR_ADMISSION. Anything malformed throws instead of degrading into a cheaper cycle.
 */
export function buildAdmissionPlanner({ config, adapters, readConfiguration, processLiabilityReader = null }) {
  return {
    async plan({ cycleId, packId }) {
      const configuration = await readConfiguration();
      if (configuration === null || !configuration.liveMode) return null;
      const quantity = configuration.requestedOrders;
      if (!Number.isInteger(quantity) || quantity < 1) return null;
      // BOT-PACK-QUANTITY (pack-quantity-review.md P1 / pack-quantity-corrected-report.md OPEN
      // FACT): requestedOrders is only bounded against the operator's own maxBoostersPerCycle
      // ceiling (up to 1,000, packages/runner/src/config/state-schema.mjs) at configuration-write
      // time, which can exceed the shared purchase-stage batch/catalog ceiling. Refuse here, before
      // any catalog read, Relay quote, hook liability read, or durable cycle-open effect -- the
      // normalized policy admission (packages/runner/src/automation/policy-engine.mjs's
      // assertPolicyAdmission) and the purchase stage's own replay check both still enforce the
      // same ceiling independently; this closes the remaining, earliest construction boundary.
      if (quantity > MAXIMUM_PACK_BATCH_SIZE) {
        throw new Error(`admission planner refuses requestedOrders above the shared batch/catalog ceiling of ${MAXIMUM_PACK_BATCH_SIZE}`);
      }
      if (!configuration.allowedPackIds.includes(packId)) return null;
      if (typeof adapters?.collectorCrypt?.getMachines !== 'function') {
        throw new Error('admission planner requires collector-crypt machine data');
      }
      if (typeof adapters?.relay?.quoteOutboundBridge !== 'function') {
        throw new Error('admission planner requires a Relay client');
      }
      const settlementAsset = config.moneyConfiguration.assets.solanaStablecoin;
      const fundingAsset = config.moneyConfiguration.assets.eth;
      // Fails closed: with no attributable finalized process liability there is nothing that shows
      // this cycle may spend process money, and a wallet balance or configured figure is not a
      // substitute.
      const liability = assertProcessLiabilityEvidence(
        typeof processLiabilityReader?.read === 'function' ? await processLiabilityReader.read({ cycleId, packId }) : null,
        fundingAsset,
        { hook: config.contracts?.hook ?? null, cycleId, operations: config.accounts.evm.toLowerCase() },
      );
      if (liability === null) return null;
      const unitAtomic = admittedCatalogUnit({
        catalog: await adapters.collectorCrypt.getMachines(),
        packId,
        settlementAsset,
      });
      const aggregateAtomic = unitAtomic * BigInt(quantity);
      const route = {
        user: config.accounts.evm,
        recipient: config.accounts.solana,
        destinationCurrency: settlementAsset.assetId,
        tradeType: 'EXACT_OUTPUT',
      };
      // Sequential, not concurrent: these are two separate priced facts about the same reserve, and
      // issuing them together would make the pair's ordering -- and therefore which one Relay
      // priced against which inventory state -- nondeterministic evidence.
      const unitQuote = await adapters.relay.quoteOutboundBridge({ ...route, amount: unitAtomic.toString() });
      const aggregateQuote = await adapters.relay.quoteOutboundBridge({ ...route, amount: aggregateAtomic.toString() });
      // Only meaningful above one pack. At quantity 1 the unit and aggregate targets are the same
      // amount, so one identical quote for both is the correct answer, not a reused one.
      if (quantity > 1 && unitQuote.requestId === aggregateQuote.requestId) {
        throw new Error('admission planner received one Relay quote for both the unit and aggregate targets');
      }
      if (BigInt(aggregateQuote.origin.amount) > BigInt(liability.ceilingAtomic)) {
        throw new Error('admission planner refuses an aggregate quote above the attributable process liability');
      }
      return Object.freeze({
        schema: 'hookemon.policy-admission.v3',
        cycleId,
        packId,
        quantity,
        quoteDigest: aggregateQuote.quoteDigest,
        unitPurchase: typedAdmissionAmount(settlementAsset, unitAtomic),
        aggregatePurchase: typedAdmissionAmount(settlementAsset, aggregateAtomic),
        unitFundingQuote: typedAdmissionAmount(fundingAsset, BigInt(unitQuote.origin.amount)),
        aggregateFundingQuote: typedAdmissionAmount(fundingAsset, BigInt(aggregateQuote.origin.amount)),
        unitFundingUsd: createQuoteUsdValuation({ quote: unitQuote, side: 'origin', amount: typedAdmissionAmount(fundingAsset, BigInt(unitQuote.origin.amount)), rounding: 'up', nowMs: (config.now ?? Date.now)() }),
        aggregateFundingUsd: createQuoteUsdValuation({ quote: aggregateQuote, side: 'origin', amount: typedAdmissionAmount(fundingAsset, BigInt(aggregateQuote.origin.amount)), rounding: 'up', nowMs: (config.now ?? Date.now)() }),
        relay: admittedRelayIdentity(aggregateQuote),
        unitRelay: admittedRelayIdentity(unitQuote),
        unitRelayQuote: unitQuote,
        relayQuote: aggregateQuote,
        processLiabilityEvidence: liability,
      });
    },
  };
}

/**
 * Plans the replacement admission ADR-0025 `refresh-after-readmission` selects once, after the
 * originally admitted quote expired before any outbound request existed.
 *
 * Deliberately narrower than `buildAdmissionPlanner`: pack, quantity, both destination purchase
 * targets, and the finalized `processLiabilityEvidence` all come from the immutable original
 * admission unchanged, never re-derived -- the funding this replacement quotes was already claimed
 * and its finalized custody already proved by the caller's `readFinalizedClaimCustodyEvidence`
 * evidence, so nothing here re-reads the pre-claim hook liability (which the hook itself would now
 * refuse as an already-used cycle id) or infers a new catalog price. Only two fresh Relay quotes,
 * for exactly the same destination amounts the original admission targeted, are obtained.
 */
export function buildQuoteRefreshPlanner({ config, adapters }) {
  return {
    async plan({ cycleId, packId, admission, custody }) {
      if (!admission || !custody || custody.cycleId !== cycleId) return null;
      if (typeof adapters?.relay?.quoteOutboundBridge !== 'function') {
        throw new Error('quote refresh planner requires a Relay client');
      }
      const settlementAsset = config.moneyConfiguration.assets.solanaStablecoin;
      const fundingAsset = config.moneyConfiguration.assets.eth;
      const route = {
        user: config.accounts.evm,
        recipient: config.accounts.solana,
        destinationCurrency: settlementAsset.assetId,
        tradeType: 'EXACT_OUTPUT',
      };
      // Sequential for the same reason as the original admission planner: one deterministic
      // ordering of two separate priced facts, never issued together.
      const unitQuote = await adapters.relay.quoteOutboundBridge({ ...route, amount: admission.unitPurchase.amountAtomic });
      const aggregateQuote = await adapters.relay.quoteOutboundBridge({ ...route, amount: admission.aggregatePurchase.amountAtomic });
      if (admission.quantity > 1 && unitQuote.requestId === aggregateQuote.requestId) {
        throw new Error('quote refresh planner received one Relay quote for both the unit and aggregate targets');
      }
      return Object.freeze({
        schema: 'hookemon.policy-admission.v3',
        cycleId,
        packId,
        quantity: admission.quantity,
        quoteDigest: aggregateQuote.quoteDigest,
        unitPurchase: admission.unitPurchase,
        aggregatePurchase: admission.aggregatePurchase,
        unitFundingQuote: typedAdmissionAmount(fundingAsset, BigInt(unitQuote.origin.amount)),
        aggregateFundingQuote: typedAdmissionAmount(fundingAsset, BigInt(aggregateQuote.origin.amount)),
        unitFundingUsd: createQuoteUsdValuation({ quote: unitQuote, side: 'origin', amount: typedAdmissionAmount(fundingAsset, BigInt(unitQuote.origin.amount)), rounding: 'up', nowMs: (config.now ?? Date.now)() }),
        aggregateFundingUsd: createQuoteUsdValuation({ quote: aggregateQuote, side: 'origin', amount: typedAdmissionAmount(fundingAsset, BigInt(aggregateQuote.origin.amount)), rounding: 'up', nowMs: (config.now ?? Date.now)() }),
        relay: admittedRelayIdentity(aggregateQuote),
        unitRelay: admittedRelayIdentity(unitQuote),
        unitRelayQuote: unitQuote,
        relayQuote: aggregateQuote,
        processLiabilityEvidence: admission.processLiabilityEvidence,
      });
    },
  };
}

/**
 * Attributable finalized process liability, bound to the exact block it was observed at.
 *
 * A bare `balanceOf` on the Operations wallet is not this. The cycle's first money mutation is the
 * claim that moves process funds from the hook into Operations, so a correctly empty Operations
 * wallet would refuse a fundable cycle, while a wallet holding owner or unrelated USDG would be
 * accepted as process money -- authorizing a spend of funds never attributed to the process. Nor is
 * a configured figure evidence of anything.
 *
 * The evidence this accepts is the full normalized reading of the hook's process-liability ledger:
 * every control getter alongside the derived ceiling, the asset it is denominated in, the hook and
 * cycle identity it was read against, and the exact block number and hash it was read at. A value
 * read at `latest` and merely compared against a separately observed finalized head does not
 * qualify: those are two unrelated reads and the balance carries no block identity of its own. The
 * bare ceiling alone does not qualify either: without the getters that produced it, nothing durable
 * can re-derive or re-authenticate which hook observation authorized the principal.
 *
 * The production reader below is wired at composition; this validates whatever reader is supplied,
 * so a test may substitute an isolated reader without weakening the check the real one is held to.
 */
/**
 * The production process-liability reader: the deployed hook's own accrued ledger, read at one
 * canonical finalized block.
 *
 * The public RPC selects the finalized block; every getter is then issued against the archive client
 * at that explicit height, and the archive re-reads the block so the values are bound to the hash
 * they were taken at. The evidenced ceiling is min(processLiability, remainingProcessClaimCapacity),
 * because remaining capacity alone ignores liability just as liability alone ignores the claim
 * limit. Paused claims, a cycle id already used, an Operations role that is not the frozen identity,
 * and an insolvent hook each refuse outright.
 *
 * There is no latest read, no configured literal, and no wallet balance anywhere on this path: an
 * Operations USDG balance is post-claim custody and can include unrelated deposits, so it cannot
 * authorize a new claim.
 */
export function buildProcessLiabilityReader({ config, adapters }) {
  const publicClient = adapters?.robinhood?.client ?? null;
  const archive = adapters?.robinhood?.historicalEvidenceClient ?? null;
  const hook = config.contracts?.hook ?? null;
  const fundingAsset = config.moneyConfiguration?.assets?.usdg ?? null;
  return {
    async read({ cycleId }) {
      if (publicClient === null || hook === null || fundingAsset === null
        || typeof archive?.readHookProcessStateAtBlock !== 'function') {
        return null;
      }
      const onchainCycleId = deriveOnchainCycleId(cycleId);
      const finalized = await readFinalizedBlock(publicClient);
      const state = await archive.readHookProcessStateAtBlock({
        hook,
        onchainCycleId,
        blockNumber: finalized.number,
        blockHash: finalized.hash,
      });
      // The public chain must still report the same hash at that height after the archive reads.
      const recheck = await readBlockByNumber(publicClient, finalized.number);
      if (recheck.hash?.toLowerCase() !== state.blockHash) {
        throw new Error('process liability evidence block hash changed between the archive read and its recheck');
      }
      if (state.processClaimsPaused) throw new Error('process liability evidence refuses while hook process claims are paused');
      if (state.processClaimCycleUsed) throw new Error('process liability evidence refuses a cycle id the hook already used');
      if (!state.isSolvent) throw new Error('process liability evidence refuses while the hook is not solvent');
      if (state.operations !== config.accounts.evm.toLowerCase()) {
        throw new Error('process liability evidence Operations role does not match the configured Operations account');
      }
      const ceiling = state.processLiability < state.remainingProcessClaimCapacity
        ? state.processLiability
        : state.remainingProcessClaimCapacity;
      return {
        schema: 'hookemon.process-liability-evidence.v2',
        chainId: fundingAsset.chainId,
        assetId: fundingAsset.assetId,
        decimals: fundingAsset.decimals,
        hook: hook.toLowerCase(),
        cycleId,
        onchainCycleId,
        blockNumber: state.blockNumber.toString(),
        blockHash: state.blockHash,
        finalized: true,
        processLiability: state.processLiability.toString(),
        remainingProcessClaimCapacity: state.remainingProcessClaimCapacity.toString(),
        processClaimsPaused: state.processClaimsPaused,
        processClaimCycleUsed: state.processClaimCycleUsed,
        activeProcessClaimLimit: state.activeProcessClaimLimit.toString(),
        totalLiability: state.totalLiability.toString(),
        hookNativeBalance: state.hookNativeBalance.toString(),
        isSolvent: state.isSolvent,
        operations: state.operations,
        ceilingAtomic: ceiling.toString(),
      };
    },
  };
}

const UNSIGNED_DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * Validates the exact normalized shape `buildProcessLiabilityReader` produces, against this specific
 * admission's hook, cycle and funding asset -- whichever reader supplied it. Every control getter is
 * re-checked here, not only re-read by the production reader, so a fake reader that skips a real
 * chain read cannot hand the planner evidence a real one would have refused; that is what lets a
 * planner-level test exercise each independent control refusal without touching a provider.
 */
const PROCESS_LIABILITY_EVIDENCE_FIELDS = Object.freeze([
  'schema', 'chainId', 'assetId', 'decimals', 'hook', 'cycleId', 'onchainCycleId', 'blockNumber',
  'blockHash', 'finalized', 'processLiability', 'remainingProcessClaimCapacity',
  'processClaimsPaused', 'processClaimCycleUsed', 'activeProcessClaimLimit', 'totalLiability',
  'hookNativeBalance', 'isSolvent', 'operations', 'ceilingAtomic',
]);

function assertProcessLiabilityEvidence(value, fundingAsset, { hook, cycleId, operations }) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('process liability evidence must be a plain object');
  }
  for (const key of Object.keys(value)) {
    if (!PROCESS_LIABILITY_EVIDENCE_FIELDS.includes(key)) {
      throw new Error(`process liability evidence has an unrecognized field "${key}"`);
    }
  }
  if (value.schema !== 'hookemon.process-liability-evidence.v2') {
    throw new Error('process liability evidence must use hookemon.process-liability-evidence.v2');
  }
  if (value.finalized !== true) throw new Error('process liability evidence must be finalized');
  if (value.chainId !== fundingAsset.chainId || value.assetId?.toLowerCase() !== fundingAsset.assetId.toLowerCase()
    || value.decimals !== fundingAsset.decimals) {
    throw new Error('process liability evidence is not denominated in the configured funding asset');
  }
  if (typeof hook !== 'string' || typeof value.hook !== 'string' || value.hook.toLowerCase() !== hook.toLowerCase()) {
    throw new Error('process liability evidence hook does not match the configured hook');
  }
  if (value.cycleId !== cycleId) throw new Error('process liability evidence cycleId does not match the admitted cycle');
  if (typeof value.onchainCycleId !== 'string' || value.onchainCycleId !== deriveOnchainCycleId(cycleId)) {
    throw new Error('process liability evidence onchainCycleId does not match its cycleId');
  }
  if (typeof value.blockNumber !== 'string' || !UNSIGNED_DECIMAL.test(value.blockNumber)
    || typeof value.blockHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value.blockHash)) {
    throw new Error('process liability evidence must bind the exact finalized block number and hash');
  }
  for (const field of [
    'processLiability', 'remainingProcessClaimCapacity', 'activeProcessClaimLimit',
    'totalLiability', 'hookNativeBalance', 'ceilingAtomic',
  ]) {
    if (typeof value[field] !== 'string' || !UNSIGNED_DECIMAL.test(value[field])) {
      throw new Error(`process liability evidence ${field} is invalid`);
    }
  }
  if (typeof value.processClaimsPaused !== 'boolean' || typeof value.processClaimCycleUsed !== 'boolean'
    || typeof value.isSolvent !== 'boolean') {
    throw new Error('process liability evidence has a non-boolean control flag');
  }
  // These three relationships hold for any real hook read (FeeAccounting.sol/HookemonHook.sol); a
  // combination outside them cannot have come from the contract, so a fake reader cannot use one to
  // pass the shape check the real reader would fail.
  if (BigInt(value.remainingProcessClaimCapacity) > BigInt(value.activeProcessClaimLimit)) {
    throw new Error('process liability evidence remainingProcessClaimCapacity exceeds activeProcessClaimLimit');
  }
  if (BigInt(value.processLiability) > BigInt(value.totalLiability)) {
    throw new Error('process liability evidence processLiability exceeds totalLiability');
  }
  if (value.isSolvent !== (BigInt(value.hookNativeBalance) >= BigInt(value.totalLiability))) {
    throw new Error('process liability evidence isSolvent does not match hookNativeBalance and totalLiability');
  }
  if (value.processClaimsPaused !== false) throw new Error('process liability evidence refuses while hook process claims are paused');
  if (value.processClaimCycleUsed !== false) throw new Error('process liability evidence refuses a cycle id the hook already used');
  if (value.isSolvent !== true) throw new Error('process liability evidence refuses while the hook is not solvent');
  if (typeof value.operations !== 'string' || value.operations !== operations) {
    throw new Error('process liability evidence Operations role does not match the configured Operations account');
  }
  const ceiling = BigInt(value.processLiability) < BigInt(value.remainingProcessClaimCapacity)
    ? BigInt(value.processLiability)
    : BigInt(value.remainingProcessClaimCapacity);
  if (ceiling.toString() !== value.ceilingAtomic) {
    throw new Error('process liability evidence ceilingAtomic does not equal min(processLiability, remainingProcessClaimCapacity)');
  }
  return Object.freeze({
    schema: value.schema,
    chainId: value.chainId,
    assetId: value.assetId,
    decimals: value.decimals,
    hook: value.hook,
    cycleId: value.cycleId,
    onchainCycleId: value.onchainCycleId,
    blockNumber: value.blockNumber,
    blockHash: value.blockHash,
    finalized: value.finalized,
    processLiability: value.processLiability,
    remainingProcessClaimCapacity: value.remainingProcessClaimCapacity,
    processClaimsPaused: value.processClaimsPaused,
    processClaimCycleUsed: value.processClaimCycleUsed,
    activeProcessClaimLimit: value.activeProcessClaimLimit,
    totalLiability: value.totalLiability,
    hookNativeBalance: value.hookNativeBalance,
    isSolvent: value.isSolvent,
    operations: value.operations,
    ceilingAtomic: value.ceilingAtomic,
  });
}

function buildBudgetReader({ config, cycleRepository, readConfiguration, liveMode }) {
  return {
    async read() {
      const active = await cycleRepository.readActiveCycle();
      const configuration = await readConfiguration();
      const disabled = liveMode && (configuration === null || (configuration.liveMode && (
        configuration.requestedOrders === 0
        || configuration.allowedPackIds.length === 0
        || configuration.maxUnitPriceMicroUsd === '0'
        || configuration.perCycleCapMicroUsd === '0'
      )));
      return {
        availableProcessWei: disabled ? '0' : config.budget.availableProcessWei,
        packPriceWei: config.budget.packPriceWei,
        outboundCapWei: config.budget.outboundCapWei,
        returnCapWei: config.budget.returnCapWei,
        operatingMarginWei: config.budget.operatingMarginWei,
        activeCycleId: active ? active.cycleId : null,
      };
    },
  };
}

/** Read-only fee-settlement observation. A real production observer (reading
 * `SwapLiabilitiesAccrued`-derived liabilities off the hook, per design section 4.10) is future work
 * for whichever package owns that adapter surface; this reports the same conservative
 * `PENDING_BENEFICIARY_CLAIMS` status `AutomatedCycleService`'s own fixture integration tests use as
 * a safe default rather than fabricating settlement data this composition cannot yet observe for
 * real. `AutomatedCycleService` already treats an `observe()` failure as non-fatal
 * (`OBSERVATION_FAILED`), so this never blocks cycle completion either way. */
function buildFeeSettlementObserver() {
  return { async observe(cycleId) { return { cycleId, status: 'PENDING_BENEFICIARY_CLAIMS' }; } };
}

export function createProductionSupplementaryStageHandlers({ assertCanary }) {
  const guarded = handler => Object.freeze({
    stage: handler.stage,
    async reconcile(input) {
      await assertCanary({
        cycleId: input.context.cycleId,
        stage: input.context.stage,
        assertLease: input.assertLease,
      });
      return handler.reconcile(input);
    },
  });
  const buyback = createSupplementaryBuybackHandler();
  const returnHandler = {
    stage: 'supplementary-return',
    async reconcile({ adapters, signerClient, config, cycleRepository, context, position, preflightAuthority }) {
      const sale = await cycleRepository.readSupplementarySettlementEvidence(position.positionId);
      if (sale?.state !== 'BUYBACK_SENT_UNKNOWN' || !sale.evidence) {
        throw new Error('supplementary return requires durable confirmed-sale evidence');
      }
      await mutateSupplementaryReturn({
        liveMode: true,
        adapters,
        signerClient,
        config,
        cycleRepository,
        context,
        confirmedSale: sale.evidence,
        preflightAuthority,
      });
      return reconcileSupplementaryReturn({ adapters, config, cycleRepository, context });
    },
  };
  const payoutHandler = {
    stage: 'supplementary-payout',
    async reconcile({ adapters, signerClient, config, cycleRepository, context, position }) {
      const [boundary, snapshot] = await Promise.all([
        cycleRepository.readSupplementarySettlementEvidence(position.positionId),
        cycleRepository.readStage(position.cycleId, 'eligibility-snapshot'),
      ]);
      const returnBoundary = boundary?.state === 'RETURN_BROADCAST' ? boundary
        : boundary?.state === 'PAYOUT_BROADCAST' ? boundary.returnBoundary : null;
      if (!returnBoundary
        || snapshot?.status !== 'COMPLETE' || !snapshot.evidence) {
        throw new Error('supplementary payout requires durable return and eligibility evidence');
      }
      return mutateSupplementaryPayout({
        liveMode: true,
        adapters,
        signerClient,
        config,
        cycleRepository,
        context: { ...context, eligibilityManifest: snapshot.evidence, returnBoundary },
      });
    },
  };
  return Object.freeze({
    PREPARED: guarded(buyback),
    BUYBACK_SENT_UNKNOWN: guarded(returnHandler),
    RETURN_BROADCAST: guarded(payoutHandler),
    PAYOUT_BROADCAST: guarded(payoutHandler),
  });
}

/**
 * Builds the full composition from an explicit config object. Returns `{ scheduler, service,
 * shutdown }`:
 *   - `scheduler`: the real `createScheduler()` result (`start/stop/triggerTick/settled/...`),
 *     already wired to re-read `config.statePath` and rebuild the worker fresh every tick.
 *   - `service`: a `{ runOnce(), recoverActiveCycle(), tick() }` convenience for one-shot CLI use
 *     (`bin/hookemon-runner.mjs tick`/`dry-run`) that builds one `AutomatedCycleService` instance
 *     against the config's own `liveMode` (or an override for `dry-run`), matching exactly what a
 *     scheduler tick would have built.
 *   - `shutdown()`: stops the scheduler if it was started; idempotent.
 *
 * @param {object} config
 * @param {string} config.stateDir - absolute path; holds the durable cycle-repository directory and
 *   the lease file. Never inside this repository's own tree in real use.
 * @param {string} config.statePath - absolute path to the operator state file
 *   (packages/runner/src/operator/state-file.mjs) the scheduler re-reads every tick.
 * @param {string} config.workerOwner
 * @param {number} config.leaseTtlMs
 * @param {number} [config.defaultIntervalMs]
 * @param {object} config.robinhood - `{ rpcUrl }`
 * @param {object} config.solana - `{ rpcUrl }`
 * @param {object} config.relay - `{ baseUrl, apiKey }`
 * @param {object} config.collectorCrypt - `{ baseUrl, apiKey }`
 * @param {object} config.contracts - `{ vault, hook, usdg }` (0x addresses or null); `usdg` is
 *   required to classify nonzero custody for production policy. WP-37 adds
 *   `treasury`/`pool` (operator-configured fallbacks `distribution.mjs`'s holder-exclusion-set
 *   builder consumes — see `environment.mjs`'s own header) and a test-only `poolManager` override
 *   (defaults to `bindings/robinhood-chain.json`'s `contracts.poolManager`, mirroring `usdg`).
 * @param {object} config.accounts - `{ evm, solana }` (addresses or null)
 * @param {object} [config.budget] - `{ availableProcessWei, packPriceWei, outboundCapWei,
 *   returnCapWei, operatingMarginWei }`, all canonical decimal strings; defaults to all-zero
 *   (never ready to spend) when omitted.
 * @param {object|null} [config.signerClient] - `{ evm, solana, distributionSigner }` (see
 *   packages/adapters/README.md's injected signerClient seam); `null` unless the operator supplied
 *   `HOOKEMON_SIGNER_MODULE` (environment.mjs) or a test injects one directly.
 *   `distributionSigner` (WP-36) is a distinct role — never the operator `evm`/`solana` signer,
 *   never worker-held key material per decision D7 — `distribution.mjs`'s own mutate() calls
 *   through to obtain the distribution-signer approval; the separate verifier role is never
 *   constructed here at all (see `bin/hookemon-verifier.mjs`'s own process).
 * @param {object} [config.hkmn] - `{ address, deployBlock }` — the HKMN token contract
 *   `distribution.mjs` reads `Transfer` logs from (WP-36); `address: null` (the default) leaves
 *   distribution reporting "not configured" until launch.
 * @param {object} [config.distribution] - `{ dir, excludedHolderAddresses }` — the absolute
 *   directory `distribution.mjs` shares with the separate `bin/hookemon-verifier.mjs` process
 *   (`pending`/`receipts`/`failed`), and (WP-37) an operator-supplied array of additional 0x
 *   addresses its holder-exclusion-set builder always includes, alongside the vault/hook/pool
 *   manager/canonical pool/Programmable/treasury/every prior return escrow/zero address it derives
 *   on its own.
 * @param {object|null} [config.standingAuthority] - an owner-signature- and policy-key-verified
 *   standing-authority document with the branded provider created by `environment.mjs`'s
 *   `loadStandingAuthority`. A production signer refuses when this is absent or invalid.
 * @param {(context: {cycleId: string, stage: string, authorizationKind: 'sign', requestDigest:
 *   string, signerRole: string|null}) => Promise<object>|object} [config.standingAuthorityStepAuthorization]
 *   - supplies an already policy-signed standing-authority step intent at a production signing
 *   boundary. This capability is never exposed to stage handlers or journal preparation.
 * @param {object} [config.adapters] - test-only escape hatch: pre-built adapter clients (fake
 *   transports) instead of constructing real ones from the URLs above. Injected adapters must
 *   include the separate `networkIdentity` seam below.
 * @param {{readErc20BalanceAtBlock: ({token: string, account: string, blockNumber: string,
 *   blockHash: string}) => Promise<object>}} [config.historicalEvidenceClient] - independent
 *   archive-capable EVM balance evidence. Production requires this client or the equivalent
 *   `config.adapters.robinhood.historicalEvidenceClient`; the public Robinhood RPC is rejected.
 * @param {{readEvmChainId: () => Promise<number>, readSolanaGenesisHash: () => Promise<string>}}
 *   [config.networkIdentity] - test-only startup identity seam for deterministic checks with
 *   `config.adapters`; it must report the configured EVM chain and selected Solana genesis hash.
 * @param {object|null} [config.dashboard] - `{ profileId, proxyCredential, port, sqlitePath,
 *   auditLogPath, access }` (see `resolveDashboardConfig`); `null`/omitted composes no dashboard at
 *   all (`composition.dashboard` is then `null`) — `bin/hookemon-runner.mjs`'s `--no-dashboard` maps
 *   straight onto this. When present, the dashboard control service (packages/dashboard) is composed
 *   in this same process with a read-only client over the scheduler's repository and a composed
 *   operator-control authority. `run-cycle-now`, `resume-cycle`, and `reconcile` reach the real
 *   scheduler and automation service above.
 * @param {string} [config.operatorAuditLogPath] - the append-only ledger for the listener-free
 *   operator facade. It defaults to `<stateDir>/dashboard-audit.log` and must equal
 *   `dashboard.auditLogPath` whenever a dashboard listener is composed.
 * @param {() => number} [config.now]
 */
export async function compose(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('compose(config) requires a config object');
  if (typeof config.stateDir !== 'string' || config.stateDir.length === 0) throw new Error('compose config.stateDir is required');
  if (typeof config.statePath !== 'string' || config.statePath.length === 0) throw new Error('compose config.statePath is required');

  const now = config.now ?? (() => Date.now());
  const budget = {
    availableProcessWei: '0',
    packPriceWei: '0',
    outboundCapWei: '0',
    returnCapWei: '0',
    operatingMarginWei: '0',
    ...(config.budget ?? {}),
  };
  for (const [key, value] of Object.entries(budget)) assertDecimal(value, `compose config.budget.${key}`);

  let resolved = {
    chainId: 4663,
    // WP-37: `treasury`/`pool` are operator/test-configured fallbacks for `distribution.mjs`'s own
    // holder-exclusion-set builder (see environment.mjs's own header — `pool` only matters until
    // `bindings/robinhood-chain.json`'s `market.poolKey` resolves; `poolManager` is deliberately
    // absent from this default — like `usdg`, it is always read from that binding file directly,
    // and exists on `config.contracts` only as a test-only override, never operator configuration).
    contracts: { vault: null, hook: null, usdg: null, usdgDecimals: null, treasury: null, pool: null, poolManager: null },
    accounts: { evm: null, solana: null },
    pack: { code: null },
    moneyConfiguration: null,
    execution: {
      profile: 'inspection', networkProfile: 'mainnet', providerMode: 'live', dryRun: false, rehearsalCapUsdg: null, rehearsalSessionId: null, enforceProfile: false,
    },
    // WP-36: distribution.mjs's own configuration — the HKMN token contract (once launched; see
    // docs/modules/composition-root.md's "What remains unimplemented" for the current
    // INTEGRATION_PENDING launch status) and the on-disk directory it shares with the separate
    // `bin/hookemon-verifier.mjs` process (pending/receipts/failed). WP-37: `excludedHolderAddresses`
    // is the operator-supplied addition to `distribution.mjs`'s own exclusion set. WP-39:
    // `profile` ('fixture', the default, or 'production') and `signerAddress`/`verifierAddress`
    // (production-only, the two configured EIP-712 identities — never the fixture Ed25519 keys).
    hkmn: { address: null, deployBlock: 0n },
    distribution: { dir: null, excludedHolderAddresses: [], profile: 'fixture', signerAddress: null, verifierAddress: null },
    signerClient: null,
    reconciliationAdapters: null,
    standingAuthority: null,
    ...config,
    budget,
  };
  if (resolved.accounts?.operationsTrigger !== undefined && resolved.accounts.operationsTrigger !== null) {
    throw new Error('compose: a third Operations EVM identity is not supported');
  }
  if (resolved.stageHandlers !== undefined && resolved.stageHandlers !== null
    && process.env.NODE_TEST_CONTEXT === undefined) {
    throw new Error('compose stageHandlers are available only from the Node test runner');
  }
  if (resolved.supplementaryStageHandlers !== undefined && resolved.supplementaryStageHandlers !== null
    && process.env.NODE_TEST_CONTEXT === undefined) {
    throw new Error('compose supplementaryStageHandlers are available only from the Node test runner');
  }

  if (resolved.execution?.profile === 'production' && resolved.execution?.dryRun !== true) {
    resolved.nativePaymentBinding = requireNativePaymentBinding(resolved.nativePaymentBindingPath);
    if (resolved.nativePaymentBinding.hook.address.toLowerCase() !== resolved.contracts.hook?.toLowerCase()) {
      throw new Error('native payment release binding names a different hook');
    }
  }
  if (!resolved.execution || typeof resolved.execution !== 'object' || Array.isArray(resolved.execution)) {
    throw new Error('compose execution profile is invalid');
  }
  if (resolved.execution.dryRun === undefined) {
    resolved.execution = { ...resolved.execution, dryRun: false };
  }
  if (!['inspection', 'production', 'rehearsal'].includes(resolved.execution.profile)) {
    throw new Error('compose execution profile is invalid');
  }
  if (resolved.execution.networkProfile !== 'mainnet' || resolved.chainId !== 4663) {
    throw new Error('compose only accepts the verified mainnet network profile');
  }
  if (!['live', 'fake'].includes(resolved.execution.providerMode)) {
    throw new Error('compose provider mode is invalid');
  }
  if (typeof resolved.execution.enforceProfile !== 'boolean') {
    throw new Error('compose execution enforceProfile is invalid');
  }
  if (typeof resolved.execution.dryRun !== 'boolean') {
    throw new Error('compose execution dryRun is invalid');
  }
  if (resolved.execution.rehearsalCapUsdg !== null && resolved.execution.rehearsalCapUsdg !== undefined) {
    assertDecimal(resolved.execution.rehearsalCapUsdg, 'compose execution rehearsalCapUsdg');
  }
  if (resolved.rehearsal?.mode === 'relay-roundtrip') {
    if (resolved.execution.profile !== 'rehearsal' || resolved.execution.providerMode !== 'fake') {
      throw new Error('compose relay-roundtrip rehearsal requires fake rehearsal execution');
    }
    if (resolved.execution.rehearsalCapUsdg === null || resolved.execution.rehearsalCapUsdg === undefined
      || resolved.execution.rehearsalCapUsdg === '0') {
      throw new Error('compose relay-roundtrip rehearsal requires a positive explicit rehearsalCapUsdg');
    }
  }
  if (resolved.execution.rehearsalSessionId !== null && resolved.execution.rehearsalSessionId !== undefined
    && (typeof resolved.execution.rehearsalSessionId !== 'string' || !/^rehearsal-[0-9a-f-]{36}$/.test(resolved.execution.rehearsalSessionId))) {
    throw new Error('compose execution rehearsalSessionId is invalid');
  }
  if (resolved.execution.rehearsalSessionId !== null && resolved.execution.rehearsalSessionId !== undefined
    && (resolved.execution.profile !== 'rehearsal' || resolved.execution.providerMode !== 'fake')) {
    throw new Error('compose execution rehearsalSessionId requires fake rehearsal execution');
  }
  if (resolved.execution.profile === 'production' && (
    (resolved.execution.dryRun
      ? resolved.execution.providerMode !== 'fake'
      : resolved.execution.providerMode !== 'live')
    || (resolved.rehearsal !== null && resolved.rehearsal !== undefined)
  )) {
    throw new Error('compose production profile requires live providers unless dryRun uses fake providers without rehearsal flags');
  }
  if (resolved.execution.profile === 'rehearsal' && resolved.execution.providerMode === 'fake'
    && (!resolved.rehearsal || resolved.rehearsal.proceedsAccount === undefined)) {
    throw new Error('compose fake rehearsal requires a dedicated proceeds account');
  }
  if (isLiveCollectorOnlyRehearsal(resolved)) {
    if (resolved.accounts?.evm !== null && resolved.accounts?.evm !== undefined) {
      throw new Error('compose live collector-only rehearsal requires no EVM Operations account');
    }
    if (typeof resolved.accounts?.solana !== 'string' || resolved.accounts.solana.length === 0
      || typeof resolved.rehearsal?.proceedsAccount !== 'string' || resolved.rehearsal.proceedsAccount.length === 0
      || !Array.isArray(resolved.rehearsal.payoutRecipients) || resolved.rehearsal.payoutRecipients.length === 0) {
      throw new Error('compose live collector-only rehearsal requires Solana Operations, proceeds, and payout recipients');
    }
    if (resolved.rehearsal.proceedsAccount === resolved.accounts.solana
      || resolved.rehearsal.payoutRecipients.includes(resolved.rehearsal.proceedsAccount)) {
      throw new Error('compose live collector-only rehearsal requires a proceeds account distinct from Operations and recipients');
    }
    collectorOnlyPackPrice(resolved);
  }
  resolved.moneyConfiguration = resolveMoneyConfiguration(resolved.moneyConfiguration, resolved.execution);

  // The dashboard profile is part of the same network boundary as the runner. Resolve and check
  // it before opening durable services so an EVM mainnet/testnet mismatch never reaches a listener.
  const dashboardConfig = resolveDashboardConfig(config.stateDir, config.dashboard, resolved.chainId);
  const operatorAuditLogPath = resolveOperatorAuditLogPath(
    resolved.stateDir,
    dashboardConfig,
    resolved.operatorAuditLogPath,
  );

  let adapters = buildAdapters(resolved);
  if (isLiveCollectorOnlyRehearsal(resolved) && resolved.collectorCrypt?.executionBundleRequired === true) {
    resolved = attachCollectorPolicyBundle(resolved, await loadCollectorPolicyBundle());
  }
  // Narrow typed attachment of the Collector production binding registry: never read from a
  // file path or an environment variable (environment.mjs only ever selects the authority
  // identity), only from a raw registry object/JSON text directly injected on `config` the same
  // way `config.adapters`/`config.historicalEvidenceClient` already are. Fully schema/digest
  // validated here, before any stage ever sees it; `resolved.collectorCrypt.productionBindingAuthority`
  // is set only for the production profile (environment.mjs's own guard), so this never runs
  // outside it.
  if (resolved.collectorCrypt?.productionBindingAuthority !== undefined
    && resolved.collectorCrypt?.productionBindingAuthority !== null) {
    resolved = {
      ...resolved,
      collectorCrypt: {
        ...resolved.collectorCrypt,
        productionBindingRegistry: loadCollectorProductionBindingRegistry(resolved.collectorProductionBindingRegistry),
      },
    };
  }
  if (adapters.solana?.client) {
    resolved = {
      ...resolved,
      solana: {
        ...resolved.solana,
        blockhashContextResolver: createTrustedSolanaBlockhashContextResolver(adapters.solana.client),
        originalBlockhashContextResolver: createOriginalSolanaBlockhashContextResolver(adapters.solana.client),
      },
    };
  }
  if (resolved.execution.profile === 'production') {
    assertProductionHistoricalEvidenceClient(adapters);
  }
  // Inspection with the built-in adapters is the offline dry-run path: it never constructs a
  // signer or sends an effect, so it remains usable while RPC endpoints are unavailable. Explicit
  // injected identities are still verified in inspection, and every production/rehearsal profile
  // verifies both networks before durable services open.
  if (resolved.execution.profile !== 'inspection' || config.adapters || config.networkIdentity !== undefined) {
    await assertNetworkIdentity({
      config: resolved,
      adapters,
      profileId: dashboardConfig?.profileId ?? 'mainnet',
      requireEvm: !isLiveCollectorOnlyRehearsal(resolved),
    });
  }

  const cycleRepository = await CycleRepository.open(join(config.stateDir, 'cycles'), now);
  assertCycleRepositoryInterface(cycleRepository);
  if (resolved.execution.profile === 'production') {
    // The owned reader closes over this private repository instance and the distinct archive
    // client; it is spread in last so it always wins over any same-named method an injected raw
    // client (e.g. a test double passed as config.adapters) might already carry -- an untrusted
    // client must never be able to self-attest its own cycle-attributable availability.
    const reader = createCycleAttributableFinalizedAvailableReader({
      cycleRepository,
      publicClient: adapters.robinhood.client,
      archiveClient: adapters.robinhood.historicalEvidenceClient,
    });
    adapters = {
      ...adapters,
      robinhood: {
        ...adapters.robinhood,
        client: Object.freeze({ ...adapters.robinhood.client, readCycleAttributableFinalizedAvailable: reader }),
      },
    };
  }
  const cycleRepositoryClient = createCycleRepositoryClient(cycleRepository);
  const createCycleRunner = cycleId => createCycleRepositoryRunner(cycleRepository, cycleId);
  const leaseStore = createFileLeaseStore(join(config.stateDir, 'lease.json'));
  const observability = composeObservability({ config: resolved, adapters, cycleRepository });
  const readConfiguration = () => readPolicyConfiguration(resolved.statePath);
  const readCustody = buildPolicyCustodyReader({ config: resolved, cycleRepository, relay: adapters.relay });
  const policyEngine = createPolicyEngine({
    verifyQuoteUsdValuation: isProcessQuoteUsdValuation,
    now,
    readConfiguration,
    readCustody,
    mutateConfiguration: (mutation, { expectedRevision } = {}) => mutatePolicyConfiguration({
      statePath: resolved.statePath,
      mutation,
      expectedRevision,
    }),
  });
  const feeSettlementObserver = buildFeeSettlementObserver();
  let successfulStartPreflight = null;
  let successfulMainnetRpcIdentity = null;

  async function assertLiveCollectorOnlyPolicyConfiguration() {
    const configuration = await readConfiguration();
    if (configuration === null) throw new Error('policy configuration is required before service startup');
    assertCollectorOnlyRehearsalPolicy(configuration, {
      packCode: resolved.pack.code,
      packPriceAtomic: collectorOnlyPackPrice(resolved),
    });
    return configuration;
  }

  async function requireLiveCollectorOnlyCanary() {
    const client = adapters?.solana?.client;
    const operator = resolved.accounts?.solana;
    const reserve = resolved.moneyConfiguration?.solana?.lamportReserve;
    if (!client || typeof operator !== 'string' || operator.length === 0
      || !reserve || typeof reserve.amountAtomic !== 'string' || !decimalPattern.test(reserve.amountAtomic)) {
      throw new Error('live collector-only rehearsal requires a Solana RPC client, Operations account, and typed lamport reserve');
    }
    const [blockhash, solBalance] = await Promise.all([
      readUsableLatestBlockhash(client),
      readSolBalance(client, operator),
    ]);
    if (!blockhash || typeof blockhash.blockhash !== 'string' || blockhash.blockhash.length === 0) {
      throw new Error('live collector-only rehearsal Solana blockhash canary did not return a usable blockhash');
    }
    if (typeof solBalance !== 'bigint' || solBalance < BigInt(reserve.amountAtomic)) {
      throw new Error('live collector-only rehearsal Operations SOL balance is below the typed lamport reserve');
    }
    return Object.freeze({ blockhash: blockhash.blockhash, solBalanceLamports: solBalance.toString() });
  }

  async function requireStartPreflight({ requireCanonicalEvmIdentity = true } = {}) {
    if (isLiveCollectorOnlyRehearsal(resolved)) {
      await assertLiveCollectorOnlyPolicyConfiguration();
      await requireLiveCollectorOnlyCanary();
      return;
    }
    if (observability === null) throw new Error('observability configuration is required before live service startup');
    if (requireCanonicalEvmIdentity) await assertMainnetRpcChainId();
    if (successfulStartPreflight !== null) {
      await successfulStartPreflight;
      return;
    }
    const pending = observability.runStartPreflight().then(result => {
      if (result.ok) return result;
      const codes = result.drift.map(item => item.code).join(', ');
      throw new Error(`observability start preflight failed${codes.length > 0 ? `: ${codes}` : ''}`);
    });
    successfulStartPreflight = pending;
    try {
      await pending;
    } catch (error) {
      successfulStartPreflight = null;
      throw error;
    }
  }

  function redactedNativeStatusEvidence(stage, drift) {
    return Object.freeze({
      schema: 'hookemon.native-status-canary-hold.v1',
      stage,
      drift: Object.freeze(drift.map(item => Object.freeze({
        code: item.code,
        target: item.target,
        expected: item.expected,
        observed: item.observed,
      }))),
    });
  }

  async function requireNativeStatusCanary({ cycleId, stage, assertLease }) {
    if (observability === null || typeof observability.runNativePrincipalCanary !== 'function') {
      throw new Error('native principal canary is required before a production mutation');
    }
    assertLease();
    const current = await cycleRepository.describeCycle(cycleId);
    if (current?.admission?.schema !== 'hookemon.policy-admission.v3') throw new Error('native canary requires native cycle admission');
    const result = await observability.runNativePrincipalCanary({ nativePrincipal: current.admission.aggregateFundingQuote, destinations: [] });
    if (!result || !Array.isArray(result.drift) || typeof result.ok !== 'boolean') {
      throw new Error('native principal canary returned an invalid result');
    }
    const heldDrift = result.drift.filter(item => item?.code === 'NATIVE_PRINCIPAL_IDENTITY_DRIFT' || item?.code === 'NATIVE_BALANCE_INSUFFICIENT');
    if (heldDrift.length > 0) {
      assertLease();
      const active = await cycleRepository.readActiveCycle();
      if (active !== null && active.cycleId === cycleId && active.terminalState === undefined) {
        await cycleRepository.holdCycle(
          cycleId,
          'HELD_UNAVAILABLE',
          redactedNativeStatusEvidence(stage, heldDrift),
          { assertLease },
        );
      }
      const codes = heldDrift.map(item => item.code).join(', ');
      throw new Error(`native principal canary failed: ${codes}`);
    }
    if (!result.ok) {
      const codes = result.drift.map(item => item?.code ?? 'UNVERIFIED').join(', ');
      throw new Error(`native principal canary failed: ${codes}`);
    }
  }

  async function assertRepositoryIntegrity() {
    const cycleIds = await cycleRepository.listKnownCycleIds();
    for (const cycleId of cycleIds) await cycleRepository.describeCycle(cycleId);
    return Object.freeze({ cycleCount: cycleIds.length });
  }

  async function assertMainnetRpcChainId() {
    if (successfulMainnetRpcIdentity !== null) {
      await successfulMainnetRpcIdentity;
      return;
    }
    const pending = (async () => {
      const client = adapters?.robinhood?.client;
      if (typeof client?.getChainId !== 'function') throw new Error('EVM RPC chain-id reader is unavailable');
      const reported = await client.getChainId();
      const chainId = typeof reported === 'bigint'
        ? (reported <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(reported) : null)
        : reported;
      if (chainId !== 4663) {
        throw new Error(`EVM RPC chain id must equal 4663, got ${typeof reported === 'bigint' ? reported.toString() : String(reported)}`);
      }
    })();
    successfulMainnetRpcIdentity = pending;
    try {
      await pending;
    } catch (error) {
      successfulMainnetRpcIdentity = null;
      throw error;
    }
  }

  /**
   * Performs the non-mutating process-start checks. Callers invoke this before constructing a
   * transaction-capable signer; the signer readiness dependency may therefore be a direct
   * keychain probe rather than a signer client.
   */
  async function assertStartReadiness({
    liveMode = false,
    mode = liveMode ? 'production' : 'rehearsal',
    requirePolicyConfiguration = false,
    requireCanaryPreflight = false,
  } = {}) {
    if (mode !== 'production' && mode !== 'rehearsal') throw new Error('compose readiness mode is invalid');
    if (typeof requireCanaryPreflight !== 'boolean') throw new Error('compose readiness canary requirement is invalid');
    const repository = await assertRepositoryIntegrity();
    const liveCollectorOnly = isLiveCollectorOnlyRehearsal(resolved);
    if (!liveCollectorOnly) await assertMainnetRpcChainId();
    if (requirePolicyConfiguration) {
      const configuration = await readConfiguration();
      if (configuration === null) throw new Error('policy configuration is required before service startup');
      if (configuration.liveMode !== liveMode) {
        throw new Error('policy configuration liveMode does not match the execution profile');
      }
      if (liveCollectorOnly) {
        assertCollectorOnlyRehearsalPolicy(configuration, {
          packCode: resolved.pack.code,
          packPriceAtomic: collectorOnlyPackPrice(resolved),
        });
      }
    }
    if (requireCanaryPreflight || liveMode === true) await requireStartPreflight();
    return Object.freeze({ ...repository, preflight: requireCanaryPreflight || liveMode === true ? 'PASSED' : 'NOT_REQUIRED' });
  }

  function buildAutomatedCycleService(liveMode, mode = liveMode ? 'production' : 'rehearsal') {
    if (mode !== 'production' && mode !== 'rehearsal') throw new Error('compose execution mode is invalid');
    if (!resolved.execution || typeof resolved.execution !== 'object') throw new Error('compose execution profile is invalid');
    if (resolved.execution.networkProfile !== 'mainnet' || resolved.chainId !== 4663) {
      throw new Error('compose only accepts the verified mainnet network profile');
    }
    if (resolved.execution.profile !== 'inspection' && resolved.execution.profile !== mode) {
      throw new Error('compose execution profile does not match the requested cycle mode');
    }
    if (resolved.execution.enforceProfile) {
      if (resolved.execution.profile === 'inspection' && liveMode === true) {
        throw new Error('compose inspection profile refuses live execution');
      }
      if (resolved.execution.profile === 'production' && (
        mode !== 'production'
        || (resolved.execution.dryRun ? liveMode !== false : liveMode !== true)
      )) {
        throw new Error('compose production profile requires live production execution unless dryRun is explicit');
      }
      if (resolved.execution.profile === 'rehearsal'
        && (mode !== 'rehearsal' || liveMode !== (resolved.execution.providerMode === 'live'))) {
        throw new Error('compose rehearsal profile does not match its provider execution mode');
      }
    }
    if (mode === 'production' && resolved.execution.providerMode !== 'live' && !resolved.execution.dryRun) {
      throw new Error('compose production mode requires live providers unless dryRun is explicit');
    }
    if (mode === 'production' && resolved.rehearsal !== null && resolved.rehearsal !== undefined) {
      throw new Error('compose production mode refuses rehearsal configuration');
    }
    if (mode === 'rehearsal' && resolved.execution.providerMode === 'fake'
      && (!resolved.rehearsal || resolved.rehearsal.proceedsAccount === undefined)) {
      throw new Error('compose fake rehearsal requires a dedicated proceeds account');
    }
    const productionSupplementaryStageHandlers = liveMode === true && resolved.execution.profile === 'production'
      ? createProductionSupplementaryStageHandlers({ assertCanary: requireNativeStatusCanary })
      : null;
    const stageDriver = mode === 'rehearsal' && resolved.execution.providerMode === 'fake'
      ? createRehearsalStageDriver({
        cycleRepository,
        config: resolved,
        providers: Object.freeze({ relay: adapters.relay, collector: adapters.collectorCrypt }),
        onEffect: resolved.onRehearsalEffect ?? (async () => {}),
        restartInjector: resolved.restartInjector ?? null,
      })
      : withRestartInjection(createStageDriver({
        liveMode,
        adapters,
        reconciliationAdapters: resolved.reconciliationAdapters ?? null,
        signerClient: resolved.signerClient,
        config: resolved,
        cycleRepository,
        stageHandlers: resolved.stageHandlers ?? null,
        supplementaryStageHandlers: resolved.supplementaryStageHandlers ?? null,
        supplementaryAdapters: productionSupplementaryStageHandlers === null ? null : adapters,
        supplementarySignerClient: productionSupplementaryStageHandlers === null ? null : resolved.signerClient,
        productionSupplementaryStageHandlers,
        preflightAuthority: resolved.preflightAuthority,
        readOperatorConfiguration: readConfiguration,
      }), resolved.restartInjector ?? null);
    const serviceConfig = {
      owner: resolved.workerOwner,
      leaseTtlMs: resolved.leaseTtlMs,
      now,
      leaseStore,
      budgetReader: buildBudgetReader({ config: resolved, cycleRepository, readConfiguration, liveMode }),
      // Only a live production cycle with a resolved money configuration and Operations accounts is
      // quote-bound: those are what a quote is denominated in and routed to, so a composition
      // without them has nothing to price. Rehearsal, dry-run and such partial compositions keep the
      // previous unadmitted path, where decideCycleBudget still uses its configured static sum and
      // outbound still refuses for want of a repository-owned admission.
      ...(liveMode && mode === 'production'
        && resolved.moneyConfiguration?.assets?.solanaStablecoin && resolved.moneyConfiguration?.assets?.usdg
        && typeof resolved.accounts?.evm === 'string' && typeof resolved.accounts?.solana === 'string'
        ? {
          admissionPlanner: buildAdmissionPlanner({
            config: resolved,
            adapters,
            readConfiguration,
            // The hook's own accrued liability ledger at a canonical finalized block. A test may
            // substitute an isolated reader; nothing substitutes a wallet balance or a config value.
            processLiabilityReader: config.processLiabilityReader ?? buildProcessLiabilityReader({ config: resolved, adapters }),
          }),
          quoteRefreshPlanner: buildQuoteRefreshPlanner({ config: resolved, adapters }),
        }
        : {}),
      cycleRepository,
      runnerFactory: createCycleRunner,
      stageDriver,
      feeSettlementObserver,
      liveMode,
      mode,
      ...(resolved.execution.profile === 'inspection' ? {} : { providerMode: resolved.execution.providerMode }),
      ...(resolved.execution.dryRun ? { dryRun: true } : {}),
      // Inspection preserves the original offline dry-run contract: non-live probes never reserve
      // policy budget or require an operator configuration. Explicit production and rehearsal
      // profiles always use the policy engine, including fake-provider rehearsals.
      ...(resolved.execution.dryRun || (resolved.execution.profile === 'inspection' && liveMode === false) ? {} : { policyEngine }),
      recoveryGuard: async ({ cycleId }) => inspectCycleRecovery(await cycleRepository.describeCycle(cycleId)),
    };
    if (mode === 'production'
      && resolved.execution.profile === 'production'
      && resolved.execution.providerMode === 'live'
      && resolved.execution.dryRun !== true) {
      serviceConfig.beforeMutation = requireNativeStatusCanary;
    }
    if (mode === 'rehearsal' && resolved.execution.rehearsalCapUsdg !== null && resolved.execution.rehearsalCapUsdg !== undefined) {
      serviceConfig.policyCapMicroUsd = resolved.execution.rehearsalCapUsdg;
    }
    if (resolved.execution.rehearsalSessionId !== null && resolved.execution.rehearsalSessionId !== undefined) {
      serviceConfig.rehearsalSessionId = resolved.execution.rehearsalSessionId;
    }
    if (mode === 'rehearsal' && resolved.execution.providerMode === 'fake') {
      serviceConfig.beforeComplete = async ({ runner }) => {
        const evidence = collectRehearsalEvidence(await runner.describe(), { allowReadyToComplete: true });
        await ensureRehearsalEvidence({ stateDir: resolved.stateDir, evidence });
      };
    }
    // `AutomatedCycleService` distinguishes an absent optional pack ID from an invalid supplied
    // value. The environment's conservative default is `null`, which means no process budget is
    // configured yet and must remain a valid dry-run state.
    if (resolved.pack.code !== null) serviceConfig.packId = resolved.pack.code;
    const automatedService = new AutomatedCycleService(serviceConfig);
    if (liveMode !== true) return automatedService;
    return Object.freeze({
      async runOnce(options = {}) {
        await requireStartPreflight({ requireCanonicalEvmIdentity: resolved.execution.profile === 'production' });
        return automatedService.runOnce(options);
      },
      async recoverActiveCycle(options = {}) {
        await requireStartPreflight({ requireCanonicalEvmIdentity: resolved.execution.profile === 'production' });
        return automatedService.recoverActiveCycle(options);
      },
    });
  }

  function buildConfiguredRecoveryService() {
    if (resolved.execution.profile === 'production') {
      return buildAutomatedCycleService(!resolved.execution.dryRun, 'production');
    }
    if (resolved.execution.profile === 'rehearsal') {
      return buildAutomatedCycleService(resolved.execution.providerMode === 'live', 'rehearsal');
    }
    return buildAutomatedCycleService(false, resolved.execution.dryRun ? 'production' : 'rehearsal');
  }

  // Tracked so the composed dashboard's `ctx.lastTick()` (status-projection.mjs's `nextRunAt`) always
  // reflects the real, most recent tick this exact scheduler ran — never a value the dashboard
  // guessed or cached independently. Updated on every tick outcome, not only a successful one, since
  // "when does the next tick happen" is meaningful even after a failed one.
  let lastTick = null;
  const scheduler = createScheduler({
    statePath: resolved.statePath,
    now,
    defaultIntervalMs: resolved.defaultIntervalMs,
    buildWorker: ({ liveMode }) => buildAutomatedCycleService(liveMode, liveMode ? 'production' : 'rehearsal'),
    onTick(event) {
      lastTick = { at: event.at, intervalMs: event.intervalMs };
      resolved.onTick?.(event);
    },
  });

  const operatorControl = createOperatorControl({
    statePath: resolved.statePath,
    cycleRepository,
    policyEngine,
    now,
    readCustody,
    triggerTick: () => scheduler.triggerTick(),
    async resumeActiveCycle() {
      const active = await cycleRepository.readActiveCycle();
      if (active === null) {
        return buildConfiguredRecoveryService().recoverActiveCycle({});
      }
      if (active.mode !== 'production' && active.mode !== 'rehearsal') {
        return { status: 'CYCLE_MODE_UNRESOLVED', cycleId: active.cycleId, stage: null };
      }
      return buildAutomatedCycleService(active.mode === 'production', active.mode).recoverActiveCycle({});
    },
    recordHeldOwnerDecision: ({ positionId, ...decision }) => cycleRepository.recordHeldOwnerDecision(positionId, decision),
  });

  async function executeAudited({ requestId, expectedRevision, command, effect, note = null } = {}) {
    const status = await operatorControl.status();
    return executeAuditedCommand({
      path: operatorAuditLogPath,
      requestId,
      expectedVersion: expectedRevision,
      observedVersion: status.revision ?? 0,
      command,
      actor: { email: 'local-operator' },
      actorRole: 'operator',
      note,
      resultCode: operatorAuditResultCode(command),
      effect: async receipt => withResumeAuditResult(command, await effect(receipt)),
    });
  }

  const service = {
    async runOnce({ liveMode = false, mode = liveMode ? 'production' : (resolved.execution.dryRun ? 'production' : 'rehearsal'), signal } = {}) {
      return buildAutomatedCycleService(liveMode, mode).runOnce({ signal });
    },
    async recoverActiveCycle({ liveMode = false, mode = liveMode ? 'production' : (resolved.execution.dryRun ? 'production' : 'rehearsal'), signal } = {}) {
      return buildAutomatedCycleService(liveMode, mode).recoverActiveCycle({ signal });
    },
  };

  // Public-Integration-interface.md binding 3: rebuilt from C's own durable pack-lifecycle evidence
  // on every call, the same restart-recovery role `reconcileFromJournal` documents, never a mutable
  // long-lived cache the dashboard could see go stale or duplicate across a composition restart.
  // Bounded to the most recently known cycles: `listKnownCycleIds()` returns every cycle a store has
  // ever held (archived cycles first, then active), unbounded over a long production lifetime, and
  // this feed only ever needs to show the newest cards.
  const RECENT_WINNERS_CYCLE_SCAN_LIMIT = 50;
  async function listRecentWinners({ limit } = {}) {
    const knownCycleIds = await cycleRepository.listKnownCycleIds();
    const scannedCycleIds = knownCycleIds.slice(-RECENT_WINNERS_CYCLE_SCAN_LIMIT);
    const trustedOperations = new Map();
    const observations = [];
    for (const cycleId of scannedCycleIds) {
      const batch = await cycleRepository.readPackBatchRequest(cycleId, 'purchase');
      if (batch === null) continue;
      const built = buildDurableCardFeed({
        cycleId,
        packBatchRequestPacks: batch.packs,
        purchaseRequestedAtMs: batch.requestedAtMs,
        stages: {
          purchase: await cycleRepository.readStage(cycleId, 'purchase'),
          open: await cycleRepository.readStage(cycleId, 'open'),
          epicGate: await cycleRepository.readStage(cycleId, 'epic-gate'),
          buyback: await cycleRepository.readStage(cycleId, 'buyback'),
        },
        operatorWallet: resolved.accounts?.solana ?? null,
      });
      for (const [memo, record] of built.trustedOperations) trustedOperations.set(memo, record);
      observations.push(...built.observations);
    }
    if (trustedOperations.size === 0) return [];
    const collector = createRecentWinnersCollector({ trustedOperations });
    for (const observation of observations) collector.ingest(observation);
    return collector.list({ limit });
  }

  const dashboard = dashboardConfig
    ? await composeDashboard({
      dashboardConfig,
      chainId: resolved.chainId,
      cycleRepository: cycleRepositoryClient,
      operatorControl,
      getSchedulerView: () => scheduler.getView(),
      listRecentWinners,
      readLastTick: () => lastTick,
      adapters,
      identities: buildDashboardIdentities(resolved),
      operationsAddress: resolved.accounts.evm,
    })
    : null;

  return {
    scheduler,
    service,
    cycleRepository: cycleRepositoryClient,
    createCycleRunner,
    operatorControl,
    executeAudited,
    dashboard,
    policyEngine,
    // WP-39: the real, composed adapter clients — exposed read-only for a one-off caller (e.g.
    // `bin/hookemon-runner.mjs`'s `accept-degraded-return`) that needs a live adapter without
    // driving a full `AutomatedCycleService` stage. Never mutated by this composition itself.
    adapters,
    // The verified document and branded provider passed to the stage driver. The provider records
    // the first-use authority decision before a production signer is reached; this return value
    // remains a read-only configuration projection, not a signing capability.
    standingAuthority: resolved.standingAuthority ? Object.freeze({ ...resolved.standingAuthority }) : null,
    assertRepositoryIntegrity,
    assertStartReadiness,
    async shutdown() {
      scheduler.stop();
      await dashboard?.close();
      observability?.close();
    },
  };
}
