#!/usr/bin/env node
// Standalone dry-run readiness harness, modeled on
// feasibility/verify-robinhood-binding.mjs's fail-closed pattern: every
// external precondition this design depends on is re-probed fresh and
// reported as PASSED or INTEGRATION_PENDING -- never silently skipped, and
// never assumed from a stale committed fact. It performs only real,
// read-only reads (RPC state reads, HTTP GETs); it never signs, broadcasts,
// or mutates anything, live or offline.
//
// Its one specifically load-bearing job: resolve which Universal Router
// address is actually the live one for chain 4663 -- the repo-pinned
// 0x06afBA43fd06227fA663b0dAeCF536F6eaA6BF99 or Uniswap's currently-listed
// public deployments-page value 0x8876789976decbfcbbbe364623c63652db8c0904
// -- via Uniswap's own deployment registry cross-checked against an
// on-chain runtime-codehash probe of both addresses. WP-20 (CREATE2 hook
// mining) is hard-blocked on this script reporting that resolution PASSED.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { nowIso } from './lib/util.mjs';
import { checkBindingDrift, probeContractRuntime } from './check-binding-drift.mjs';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DEFAULT_TIMEOUT_MS = 10_000;

const ROBINHOOD_CHAIN_ID = 4663;
const REPO_PINNED_UNIVERSAL_ROUTER = '0x06afBA43fd06227fA663b0dAeCF536F6eaA6BF99';
const CHALLENGER_UNIVERSAL_ROUTER = '0x8876789976decbfcbbbe364623c63652db8c0904';
const UNISWAP_DEPLOYMENT_REGISTRY_URL =
  'https://raw.githubusercontent.com/Uniswap/contracts/4cfc406c8e34da3ce04e60657a7825075b64fd22/deployments/json/4663.json';
const COLLECTOR_CRYPT_BASE_URL = 'https://gacha.collectorcrypt.com';
const RELAY_BASE_URL = 'https://api.relay.link';
const PROGRAMMABLE_DISCOVERY_URL = 'https://programmable.market/.well-known/programmable.json';
const PROGRAMMABLE_CAPABILITIES_URL = `https://api.programmable.market/v4/chains/${ROBINHOOD_CHAIN_ID}/capabilities`;
const RELAY_SOLANA_CHAIN_ID = 792703809;
const USDG_ADDRESS = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const SOLANA_USD_COIN_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PROGRAMMABLE_CAPABILITY_ROOTS = [
  'programmableLaunchStampRouter',
  'permitAuthority',
  'graphFactory',
  'poolManager',
  'positionManager',
  'stateView',
  'v4Quoter',
  'permit2',
  'universalRouter',
];
const PROGRAMMABLE_DEPLOYMENT_ROOTS = [
  'programmableLaunchStampRouter',
  'graphFactory',
  'permitAuthority',
];
const PROGRAMMABLE_EXTERNAL_ROOTS = [
  'poolManager',
  'positionManager',
  'stateView',
  'v4Quoter',
  'universalRouter',
];
const PROGRAMMABLE_BINDING_ROOTS = ['poolManager', 'positionManager', 'stateView', 'universalRouter'];
const PROGRAMMABLE_PROFILE_IDENTITY_FIELDS = ['structuralProfileId', 'businessProfileId', 'profileVersion'];
const PROGRAMMABLE_PROFILE_DIGEST_FIELDS = [
  'profileDigest',
  'admissionDescriptorDigest',
  'admissionPolicyDigest',
  'admissionBindingDigest',
  'admissionSchemaDigest',
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function defaultFetch(url, options) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
}

function preconditionPending(id, category, reason, evidence = {}) {
  return { id, category, status: 'INTEGRATION_PENDING', evidence, reason };
}

async function probeJson(url, { fetchImpl, headers } = {}) {
  const response = await fetchImpl(url, { headers });
  const bodyText = await response.text();
  let body = null;
  try {
    body = JSON.parse(bodyText);
  } catch {
    body = null;
  }
  return { ok: response.ok, status: response.status, body };
}

// ---------------------------------------------------------------------------
// Universal Router resolution
// ---------------------------------------------------------------------------

// Uniswap's deployments registry (the pinned "uniswap-chain-4663-deployment"
// source already recorded in bindings/robinhood-chain.json) carries both a
// `latest` pointer per contract name and a `history` array of every prior
// instance, each labeled by Uniswap itself. A redeploy shows up as a new
// `latest` entry while the superseded address moves into `history` -- this
// is the authoritative, machine-readable answer to "which one is live",
// independent of any prose on the human-facing deployments page.
export function parseUniversalRouterDeploymentRegistry(sourceBytes) {
  const deployment = JSON.parse(Buffer.from(sourceBytes).toString('utf8'));
  invariant(String(deployment.chainId) === String(ROBINHOOD_CHAIN_ID), 'deployment registry chain ID mismatch');
  const latest = deployment.latest?.UniversalRouter;
  invariant(ADDRESS.test(latest?.address ?? ''), 'deployment registry is missing latest.UniversalRouter.address');

  const instances = new Map();
  const record = (address, label, isLatest) => {
    invariant(ADDRESS.test(address ?? ''), 'deployment registry UniversalRouter entry has an invalid address');
    const key = address.toLowerCase();
    const existing = instances.get(key) ?? { address: key, labels: [], isLatest: false };
    if (label) existing.labels.push(label);
    if (isLatest) existing.isLatest = true;
    instances.set(key, existing);
  };
  record(latest.address, latest.note ?? null, true);
  for (const entry of Array.isArray(deployment.history) ? deployment.history : []) {
    const historicUniversalRouter = entry.contracts?.UniversalRouter;
    if (historicUniversalRouter?.address) {
      record(historicUniversalRouter.address, entry.label ?? null, false);
    }
  }

  return {
    chainId: ROBINHOOD_CHAIN_ID,
    latestAddress: latest.address.toLowerCase(),
    instances: [...instances.values()].sort((left, right) => left.address.localeCompare(right.address)),
  };
}

// Fetches the raw registry bytes over the network. Left un-guarded here on
// purpose -- its one caller (resolveUniversalRouter) wraps it in the same
// try/catch as the parse step below, so a DNS/timeout failure or a non-2xx
// response (rate limit, transient 5xx) is reported as REGISTRY_UNAVAILABLE
// exactly like an unparseable body, instead of throwing out of main().
async function fetchRegistrySourceBytes({ registryUrl, fetchImpl }) {
  const response = await fetchImpl(registryUrl);
  invariant(response.ok, `Uniswap deployment registry HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

// Cross-checks Uniswap's deployment registry against a live on-chain
// runtime-codehash probe of both the repo-pinned address and the challenger
// address the public deployments page currently lists, and reports which
// one is actually live -- resolving only when the registry's own `latest`
// pointer names one of the two candidates AND that candidate has deployed
// bytecode on-chain right now. Anything short of that stays
// INTEGRATION_PENDING; it is never assumed.
//
// registrySourceBytes may be supplied pre-fetched (tests, offline mode); if
// omitted, the registry is fetched here from registryUrl. Both the fetch and
// the parse are covered by one try/catch so a network failure degrades to
// REGISTRY_UNAVAILABLE exactly like a parse failure, rather than throwing.
export async function resolveUniversalRouter({
  registrySourceBytes,
  repoPinnedAddress = REPO_PINNED_UNIVERSAL_ROUTER,
  challengerAddress = CHALLENGER_UNIVERSAL_ROUTER,
  registryUrl = UNISWAP_DEPLOYMENT_REGISTRY_URL,
  rpcUrl,
  fetchImpl = defaultFetch,
}) {
  invariant(ADDRESS.test(repoPinnedAddress), 'repoPinnedAddress must be an EVM address');
  invariant(ADDRESS.test(challengerAddress), 'challengerAddress must be an EVM address');
  invariant(typeof rpcUrl === 'string' && rpcUrl.length > 0, 'rpcUrl is required');

  const pinnedKey = repoPinnedAddress.toLowerCase();
  const challengerKey = challengerAddress.toLowerCase();
  const base = {
    id: 'universal-router-address-resolution',
    category: 'UNISWAP_ROUTER',
    repoPinnedAddress: pinnedKey,
    challengerAddress: challengerKey,
  };

  let registry;
  try {
    const sourceBytes = registrySourceBytes
      ?? await fetchRegistrySourceBytes({ registryUrl, fetchImpl });
    registry = parseUniversalRouterDeploymentRegistry(sourceBytes);
  } catch (error) {
    return {
      ...base,
      status: 'INTEGRATION_PENDING',
      liveAddress: null,
      resolution: 'REGISTRY_UNAVAILABLE',
      evidence: {},
      reason: `Could not obtain or parse Uniswap's deployment registry: ${error.message}`,
    };
  }

  const onChainProbe = {};
  for (const candidate of [pinnedKey, challengerKey]) {
    try {
      onChainProbe[candidate] = await probeContractRuntime({ rpcUrl, address: candidate, fetchImpl });
    } catch (error) {
      onChainProbe[candidate] = { address: candidate, hasCode: false, error: error.message };
    }
  }

  let liveAddress = null;
  let resolution = 'AMBIGUOUS';
  if (registry.latestAddress === pinnedKey && onChainProbe[pinnedKey]?.hasCode) {
    liveAddress = pinnedKey;
    resolution = 'REPO_PINNED_ADDRESS_IS_LIVE';
  } else if (registry.latestAddress === challengerKey && onChainProbe[challengerKey]?.hasCode) {
    liveAddress = challengerKey;
    resolution = 'CHALLENGER_ADDRESS_IS_LIVE';
  } else if (registry.latestAddress !== pinnedKey && registry.latestAddress !== challengerKey) {
    resolution = 'REGISTRY_NAMES_NEITHER_CANDIDATE';
  }

  const status = liveAddress ? 'PASSED' : 'INTEGRATION_PENDING';
  return {
    ...base,
    status,
    liveAddress,
    matchesRepoPin: liveAddress !== null && liveAddress === pinnedKey,
    resolution,
    evidence: { deploymentRegistry: registry, onChainProbe },
    reason: status === 'PASSED'
      ? `Uniswap's deployment registry latest.UniversalRouter is ${liveAddress}, which has deployed on-chain bytecode; this is the live Universal Router for chain ${ROBINHOOD_CHAIN_ID}.`
      : `Universal Router address is not resolved (resolution=${resolution}): the deployment registry's latest.UniversalRouter did not both name one of the two candidates and match on-chain bytecode presence.`,
  };
}

// ---------------------------------------------------------------------------
// Collector Crypt
// ---------------------------------------------------------------------------

export async function probeCollectorCrypt({ baseUrl = COLLECTOR_CRYPT_BASE_URL, fetchImpl = defaultFetch } = {}) {
  const id = 'collector-crypt-read-endpoints';
  const category = 'COLLECTOR_CRYPT';
  let status;
  let machines;
  try {
    [status, machines] = await Promise.all([
      probeJson(`${baseUrl}/api/status`, { fetchImpl }),
      probeJson(`${baseUrl}/api/machines`, { fetchImpl }),
    ]);
  } catch (error) {
    return preconditionPending(id, category, `Collector Crypt request failed: ${error.message}`);
  }
  const machinesList = Array.isArray(machines.body)
    ? machines.body
    : Array.isArray(machines.body?.machines)
      ? machines.body.machines
      : null;
  const passed = status.ok && machines.ok && Array.isArray(machinesList) && machinesList.length > 0;
  return {
    id,
    category,
    status: passed ? 'PASSED' : 'INTEGRATION_PENDING',
    evidence: {
      statusHttp: status.status,
      machinesHttp: machines.status,
      machineCount: Array.isArray(machinesList) ? machinesList.length : null,
    },
    reason: passed
      ? 'Collector Crypt /api/status and /api/machines both returned 200 with a non-empty machine catalog.'
      : `Collector Crypt read endpoints did not confirm availability (status http=${status.status}, machines http=${machines.status}).`,
  };
}

// ---------------------------------------------------------------------------
// Relay
// ---------------------------------------------------------------------------

export async function probeRelayChains({
  baseUrl = RELAY_BASE_URL,
  fetchImpl = defaultFetch,
  robinhoodChainId = ROBINHOOD_CHAIN_ID,
  solanaChainId = RELAY_SOLANA_CHAIN_ID,
} = {}) {
  const id = 'relay-chains-usdg-solana-usd-coin-route';
  const category = 'RELAY';
  let result;
  try {
    result = await probeJson(`${baseUrl}/chains`, { fetchImpl });
  } catch (error) {
    return preconditionPending(id, category, `Relay /chains request failed: ${error.message}`);
  }
  const chains = Array.isArray(result.body?.chains) ? result.body.chains : [];
  const robinhood = chains.find((chain) => Number(chain?.id) === robinhoodChainId);
  const solana = chains.find((chain) => Number(chain?.id) === solanaChainId);
  const currencyEnabled = (chain, matches) => Boolean(
    chain?.erc20Currencies?.some(matches) || chain?.solverCurrencies?.some(matches),
  );
  const usdgEnabled = currencyEnabled(
    robinhood,
    (currency) => typeof currency?.address === 'string' && currency.address.toLowerCase() === USDG_ADDRESS,
  );
  const solanaUsdEnabled = currencyEnabled(
    solana,
    (currency) => currency?.address === SOLANA_USD_COIN_ADDRESS,
  );
  const passed = result.ok && Boolean(robinhood) && Boolean(solana) && usdgEnabled && solanaUsdEnabled;
  return {
    id,
    category,
    status: passed ? 'PASSED' : 'INTEGRATION_PENDING',
    evidence: {
      http: result.status,
      robinhoodChainListed: Boolean(robinhood),
      solanaChainListed: Boolean(solana),
      usdgEnabled,
      solanaUsdEnabled,
    },
    reason: passed
      ? `Relay /chains lists chain ${robinhoodChainId} with USDG and chain ${solanaChainId} with Solana USD Coin both enabled.`
      : 'Relay /chains does not confirm both legs of the USDG<->Solana-USD-Coin route as enabled.',
  };
}

// ---------------------------------------------------------------------------
// Programmable
// ---------------------------------------------------------------------------

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sameHexValue(left, right) {
  return hasText(left) && hasText(right) && left.toLowerCase() === right.toLowerCase();
}

function isContractEvidence(value) {
  return isRecord(value)
    && ADDRESS.test(value.address ?? '')
    && /^0x[0-9a-fA-F]{64}$/.test(value.runtimeCodeHash ?? '');
}

function entriesByContract(entries) {
  const byContract = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (isRecord(entry) && hasText(entry.contract)) byContract.set(entry.contract, entry);
  }
  return byContract;
}

function contractEvidenceMatches(expected, observed) {
  return isContractEvidence(expected)
    && isContractEvidence(observed)
    && sameHexValue(expected.address, observed.address)
    && sameHexValue(expected.runtimeCodeHash, observed.runtimeCodeHash);
}

function failedJsonProbe(error) {
  const message = hasText(error?.message) ? error.message : String(error ?? 'unknown error');
  return { ok: false, status: null, body: null, error: message };
}

function evaluateProgrammableLaunchEligibility({ discovery, capabilities, manifest, chainId }) {
  const chains = Array.isArray(discovery.body?.chains) ? discovery.body.chains : [];
  const chainEntry = chains.find((chain) => Number(chain?.chainId) === chainId) ?? null;
  const v4 = discovery.body?.customLaunchApi?.versions?.v4;
  const activationBlockers = Array.isArray(v4?.activationBlockers) ? v4.activationBlockers : null;
  const readiness = capabilities.body?.readiness;
  const profile = capabilities.body?.profile;
  const chainDeployment = capabilities.body?.chainDeployment;
  const capabilityContracts = isRecord(chainDeployment?.contracts) ? chainDeployment.contracts : {};
  const deploymentEvidence = chainDeployment?.deploymentEvidence;
  const providerEvidenceByContract = entriesByContract(deploymentEvidence?.resultingContracts);
  const externalEvidenceByContract = entriesByContract(chainDeployment?.externalRootDeploymentEvidence);
  const permit2GenesisProvenance = chainDeployment?.permit2GenesisProvenance;
  const manifestContracts = isRecord(manifest?.contracts) ? manifest.contracts : null;

  const providerRootChecks = Object.fromEntries(PROGRAMMABLE_DEPLOYMENT_ROOTS.map((name) => {
    const capability = capabilityContracts[name];
    const evidence = providerEvidenceByContract.get(name) ?? null;
    return [name, {
      capabilityAddress: capability?.address ?? null,
      evidenceAddress: evidence?.address ?? null,
      addressMatches: sameHexValue(capability?.address, evidence?.address),
      capabilityRuntimeCodeHash: capability?.runtimeCodeHash ?? null,
      evidenceRuntimeCodeHash: evidence?.runtimeCodeHash ?? null,
      runtimeCodeHashMatches: sameHexValue(capability?.runtimeCodeHash, evidence?.runtimeCodeHash),
      stateEvidenceDigestPresent: hasText(evidence?.stateEvidenceDigest),
    }];
  }));
  const externalRootChecks = Object.fromEntries(PROGRAMMABLE_EXTERNAL_ROOTS.map((name) => {
    const capability = capabilityContracts[name];
    const evidence = externalEvidenceByContract.get(name) ?? null;
    return [name, {
      capabilityAddress: capability?.address ?? null,
      evidenceAddress: evidence?.address ?? null,
      addressMatches: sameHexValue(capability?.address, evidence?.address),
      capabilityRuntimeCodeHash: capability?.runtimeCodeHash ?? null,
      evidenceRuntimeCodeHash: evidence?.runtimeCodeHash ?? null,
      runtimeCodeHashMatches: sameHexValue(capability?.runtimeCodeHash, evidence?.runtimeCodeHash),
      evidenceDigestPresent: hasText(evidence?.evidenceDigest),
    }];
  }));
  const bindingRootChecks = Object.fromEntries(PROGRAMMABLE_BINDING_ROOTS.map((name) => {
    const binding = manifestContracts?.[name] ?? null;
    const capability = capabilityContracts[name] ?? null;
    return [name, {
      bindingPresent: isContractEvidence(binding),
      bindingAddress: binding?.address ?? null,
      capabilityAddress: capability?.address ?? null,
      addressMatches: sameHexValue(binding?.address, capability?.address),
      bindingRuntimeCodeHash: binding?.runtimeCodeHash ?? null,
      capabilityRuntimeCodeHash: capability?.runtimeCodeHash ?? null,
      runtimeCodeHashMatches: sameHexValue(binding?.runtimeCodeHash, capability?.runtimeCodeHash),
    }];
  }));

  const deploymentEvidencePresent = isRecord(deploymentEvidence)
    && hasText(deploymentEvidence.deploymentId)
    && Number(deploymentEvidence.chainId) === chainId
    && hasText(deploymentEvidence.evidenceDigest)
    && PROGRAMMABLE_DEPLOYMENT_ROOTS.every((name) => {
      const evidence = providerEvidenceByContract.get(name);
      return isContractEvidence(evidence) && hasText(evidence?.stateEvidenceDigest);
    });
  const externalRootDeploymentEvidencePresent = PROGRAMMABLE_EXTERNAL_ROOTS.every((name) => {
    const evidence = externalEvidenceByContract.get(name);
    return isContractEvidence(evidence) && hasText(evidence?.evidenceDigest);
  });
  const bindingRootsPresent = manifestContracts !== null
    && PROGRAMMABLE_BINDING_ROOTS.every((name) => isContractEvidence(manifestContracts[name]));
  const launchFlags = {
    discoveryHttpOk: discovery.ok,
    capabilitiesHttpOk: capabilities.ok,
    chainListed: chainEntry !== null,
    publicAuthorization: chainEntry?.publicAuthorization === true,
    publicWrites: chainEntry?.publicWrites === true,
    releaseReady: chainEntry?.releaseReady === true,
    readinessReady: readiness?.status === 'ready',
    activationBlockersReported: activationBlockers !== null,
    activationBlockersEmpty: activationBlockers?.length === 0,
    profilePresent: isRecord(profile),
    profileIdentityPresent: isRecord(profile)
      && PROGRAMMABLE_PROFILE_IDENTITY_FIELDS.every((field) => hasText(profile[field])),
    profileDigestPresent: isRecord(profile)
      && PROGRAMMABLE_PROFILE_DIGEST_FIELDS.every((field) => hasText(profile[field])),
    chainDeploymentDescriptorDigestPresent: hasText(capabilities.body?.chainDeploymentDescriptorDigest),
    capabilityRootsPresent: PROGRAMMABLE_CAPABILITY_ROOTS.every((name) => isContractEvidence(capabilityContracts[name])),
    deploymentEvidencePresent,
    deploymentEvidenceConsistent: deploymentEvidencePresent
      && PROGRAMMABLE_DEPLOYMENT_ROOTS.every((name) => {
        const evidence = providerEvidenceByContract.get(name);
        return contractEvidenceMatches(capabilityContracts[name], evidence);
      }),
    externalRootDeploymentEvidencePresent,
    externalRootDeploymentEvidenceConsistent: externalRootDeploymentEvidencePresent
      && PROGRAMMABLE_EXTERNAL_ROOTS.every((name) => {
        const evidence = externalEvidenceByContract.get(name);
        return contractEvidenceMatches(capabilityContracts[name], evidence);
      }),
    permit2GenesisProvenanceConsistent: isContractEvidence(permit2GenesisProvenance)
      && hasText(permit2GenesisProvenance.evidenceDigest)
      && contractEvidenceMatches(capabilityContracts.permit2, permit2GenesisProvenance),
    bindingRootsPresent,
    bindingRootsConsistent: bindingRootsPresent
      && PROGRAMMABLE_BINDING_ROOTS.every((name) => {
        const root = bindingRootChecks[name];
        return root.addressMatches && root.runtimeCodeHashMatches;
      }),
  };
  const launchBlockers = [];
  if (!launchFlags.discoveryHttpOk) launchBlockers.push('PROGRAMMABLE_DISCOVERY_UNAVAILABLE');
  if (!launchFlags.capabilitiesHttpOk) launchBlockers.push('PROGRAMMABLE_CAPABILITIES_UNAVAILABLE');
  if (!launchFlags.chainListed) launchBlockers.push(`CHAIN_${chainId}_NOT_LISTED`);
  if (!launchFlags.publicAuthorization) launchBlockers.push('PUBLIC_AUTHORIZATION_DISABLED');
  if (!launchFlags.publicWrites) launchBlockers.push('PUBLIC_WRITES_DISABLED');
  if (!launchFlags.releaseReady) launchBlockers.push('RELEASE_NOT_READY');
  if (!launchFlags.readinessReady) launchBlockers.push('CAPABILITIES_READINESS_NOT_READY');
  if (!launchFlags.activationBlockersReported) launchBlockers.push('ACTIVATION_BLOCKERS_UNREPORTED');
  if (launchFlags.activationBlockersReported && !launchFlags.activationBlockersEmpty) {
    launchBlockers.push('ACTIVATION_BLOCKERS_PRESENT');
  }
  if (!launchFlags.profilePresent) launchBlockers.push('PROFILE_MISSING');
  if (launchFlags.profilePresent && !launchFlags.profileIdentityPresent) launchBlockers.push('PROFILE_IDENTITY_MISSING');
  if (!launchFlags.profileDigestPresent) launchBlockers.push('PROFILE_DIGEST_MISSING');
  if (!launchFlags.chainDeploymentDescriptorDigestPresent) {
    launchBlockers.push('CHAIN_DEPLOYMENT_DESCRIPTOR_DIGEST_MISSING');
  }
  if (!launchFlags.capabilityRootsPresent) launchBlockers.push('CAPABILITY_ROOTS_INCOMPLETE');
  if (!launchFlags.deploymentEvidencePresent) launchBlockers.push('DEPLOYMENT_EVIDENCE_MISSING');
  if (launchFlags.deploymentEvidencePresent && !launchFlags.deploymentEvidenceConsistent) {
    launchBlockers.push('DEPLOYMENT_EVIDENCE_INCONSISTENT');
  }
  if (!launchFlags.externalRootDeploymentEvidencePresent) {
    launchBlockers.push('EXTERNAL_ROOT_DEPLOYMENT_EVIDENCE_MISSING');
  }
  if (launchFlags.externalRootDeploymentEvidencePresent && !launchFlags.externalRootDeploymentEvidenceConsistent) {
    launchBlockers.push('EXTERNAL_ROOT_DEPLOYMENT_EVIDENCE_INCONSISTENT');
  }
  if (!launchFlags.permit2GenesisProvenanceConsistent) {
    launchBlockers.push('PERMIT2_GENESIS_PROVENANCE_INCONSISTENT');
  }
  if (!launchFlags.bindingRootsPresent) launchBlockers.push('BINDING_ROOTS_INCOMPLETE');
  for (const name of PROGRAMMABLE_BINDING_ROOTS) {
    const root = bindingRootChecks[name];
    if (root.bindingPresent && !root.addressMatches) {
      launchBlockers.push(`BINDING_ROOT_ADDRESS_MISMATCH:${name}`);
    }
    if (root.bindingPresent && !root.runtimeCodeHashMatches) {
      launchBlockers.push(`BINDING_ROOT_RUNTIME_MISMATCH:${name}`);
    }
  }

  const launchEligible = launchFlags.discoveryHttpOk
    && launchFlags.capabilitiesHttpOk
    && launchFlags.chainListed
    && launchFlags.publicAuthorization
    && launchFlags.publicWrites
    && launchFlags.releaseReady
    && launchFlags.readinessReady
    && launchFlags.activationBlockersReported
    && launchFlags.activationBlockersEmpty
    && launchFlags.profilePresent
    && launchFlags.profileIdentityPresent
    && launchFlags.profileDigestPresent
    && launchFlags.chainDeploymentDescriptorDigestPresent
    && launchFlags.capabilityRootsPresent
    && launchFlags.deploymentEvidencePresent
    && launchFlags.deploymentEvidenceConsistent
    && launchFlags.externalRootDeploymentEvidencePresent
    && launchFlags.externalRootDeploymentEvidenceConsistent
    && launchFlags.permit2GenesisProvenanceConsistent
    && launchFlags.bindingRootsPresent
    && launchFlags.bindingRootsConsistent;

  return {
    chainEntry,
    activationBlockers,
    launchFlags,
    launchBlockers,
    launchEligible,
    providerRootChecks,
    externalRootChecks,
    bindingRootChecks,
    observed: {
      v4DiscoveryFlags: isRecord(v4)
        ? {
          publicAuthorization: v4.publicAuthorization ?? null,
          publicWrites: v4.publicWrites ?? null,
          releaseReady: v4.releaseReady ?? null,
        }
        : null,
      externalIndexingGuaranteed: chainEntry?.externalIndexingGuaranteed ?? null,
    },
  };
}

export async function probeProgrammable({
  discoveryUrl = PROGRAMMABLE_DISCOVERY_URL,
  capabilitiesUrl = PROGRAMMABLE_CAPABILITIES_URL,
  fetchImpl = defaultFetch,
  chainId = ROBINHOOD_CHAIN_ID,
  manifest,
} = {}) {
  const id = 'programmable-robinhood-chain-launch-profile';
  const category = 'PROGRAMMABLE';
  const [discoveryResult, capabilitiesResult] = await Promise.allSettled([
    probeJson(discoveryUrl, { fetchImpl }),
    probeJson(capabilitiesUrl, { fetchImpl }),
  ]);
  const discovery = discoveryResult.status === 'fulfilled'
    ? discoveryResult.value
    : failedJsonProbe(discoveryResult.reason);
  const capabilities = capabilitiesResult.status === 'fulfilled'
    ? capabilitiesResult.value
    : failedJsonProbe(capabilitiesResult.reason);
  const eligibility = evaluateProgrammableLaunchEligibility({ discovery, capabilities, manifest, chainId });
  const readinessStatus = capabilities.body?.readiness?.status ?? null;
  return {
    id,
    category,
    status: eligibility.launchEligible ? 'PASSED' : 'INTEGRATION_PENDING',
    repairMergeEligible: true,
    repairMergeBlockers: [],
    launchEligible: eligibility.launchEligible,
    evidence: {
      discoveryHttp: discovery.status,
      discoveryError: discovery.error ?? null,
      chainListed: eligibility.launchFlags.chainListed,
      chainDiscoveryStatus: eligibility.chainEntry?.status ?? null,
      capabilitiesHttp: capabilities.status,
      capabilitiesError: capabilities.error ?? null,
      readinessStatus,
      reasonCodes: capabilities.body?.readiness?.reasonCodes ?? [],
      activationBlockers: eligibility.activationBlockers,
      launchFlags: eligibility.launchFlags,
      launchBlockers: eligibility.launchBlockers,
      providerRootChecks: eligibility.providerRootChecks,
      externalRootChecks: eligibility.externalRootChecks,
      bindingRootChecks: eligibility.bindingRootChecks,
      observed: eligibility.observed,
    },
    reason: eligibility.launchEligible
      ? `Programmable's public launch conditions for chain ${chainId} are all confirmed by the current discovery and capabilities evidence.`
      : `Programmable's public launch conditions for chain ${chainId} remain unresolved: ${eligibility.launchBlockers.join(', ')}.`,
  };
}

// ---------------------------------------------------------------------------
// Aggregate report
// ---------------------------------------------------------------------------

export async function buildReadinessReport({
  manifest,
  registrySourceBytes,
  repoPinnedRouterAddress = REPO_PINNED_UNIVERSAL_ROUTER,
  challengerRouterAddress = CHALLENGER_UNIVERSAL_ROUTER,
  rpcUrl,
  fetchImpl = defaultFetch,
}) {
  invariant(manifest && typeof manifest === 'object', 'manifest is required');
  const resolvedRpcUrl = rpcUrl ?? manifest.chain?.rpcUrl;
  invariant(typeof resolvedRpcUrl === 'string' && resolvedRpcUrl.length > 0, 'an RPC URL is required');

  const [router, drift, collectorCrypt, relay, programmable] = await Promise.all([
    resolveUniversalRouter({
      registrySourceBytes,
      repoPinnedAddress: repoPinnedRouterAddress,
      challengerAddress: challengerRouterAddress,
      rpcUrl: resolvedRpcUrl,
      fetchImpl,
    }),
    checkBindingDrift({ manifest, rpcUrl: resolvedRpcUrl, fetchImpl }),
    probeCollectorCrypt({ fetchImpl }),
    probeRelayChains({ fetchImpl }),
    probeProgrammable({ fetchImpl, manifest }),
  ]);

  const bindingDriftPrecondition = {
    id: 'binding-runtime-drift',
    category: 'BINDING_DRIFT',
    status: drift.status === 'PASSED' ? 'PASSED' : 'INTEGRATION_PENDING',
    evidence: { chainId: drift.chainId, contracts: drift.contracts },
    reason: drift.status === 'PASSED'
      ? 'Every pinned contract runtime in bindings/robinhood-chain.json still matches its live on-chain bytecode.'
      : `Binding drift check is not clean (status=${drift.status}); see evidence.contracts for the specific pinned contract(s).`,
  };

  const routerPrecondition = {
    id: router.id,
    category: router.category,
    status: router.status,
    evidence: {
      repoPinnedAddress: router.repoPinnedAddress,
      challengerAddress: router.challengerAddress,
      liveAddress: router.liveAddress,
      matchesRepoPin: router.matchesRepoPin,
      resolution: router.resolution,
      deploymentRegistry: router.evidence.deploymentRegistry,
      onChainProbe: router.evidence.onChainProbe,
    },
    reason: router.reason,
  };

  const preconditions = [routerPrecondition, bindingDriftPrecondition, collectorCrypt, relay, programmable];
  const overallStatus = preconditions.every((entry) => entry.status === 'PASSED')
    ? 'ALL_PRECONDITIONS_PASSED'
    : 'INTEGRATION_PENDING';

  return {
    schemaVersion: 'hookemon.phase2-readiness.v1',
    observedAt: nowIso(),
    chain: { id: ROBINHOOD_CHAIN_ID, rpcUrl: resolvedRpcUrl },
    preconditions,
    overallStatus,
    repairMergeEligible: programmable.repairMergeEligible,
    launchEligible: programmable.launchEligible,
    eligibility: {
      repairMerge: {
        eligible: programmable.repairMergeEligible,
        blockers: programmable.repairMergeBlockers,
      },
      launch: {
        eligible: programmable.launchEligible,
        flags: programmable.evidence.launchFlags,
        blockers: programmable.evidence.launchBlockers,
      },
    },
    universalRouterResolution: routerPrecondition,
    miningGate: {
      blockedPackage: 'WP-20',
      unblocked: router.status === 'PASSED',
      reason: router.status === 'PASSED'
        ? `WP-20 may proceed with CREATE2 mining: the Universal Router address is resolved as ${router.liveAddress}.`
        : 'WP-20 remains blocked: the Universal Router address is not resolved by this probe.',
    },
  };
}

// ---------------------------------------------------------------------------
// Offline fixture mode
// ---------------------------------------------------------------------------

// A deterministic, network-free snapshot for CI, shaped like the real
// pinned uniswap-chain-4663-deployment registry: the registry's
// `latest.UniversalRouter` is the repo-pinned address, and the challenger
// address is present only in `history`, explicitly labeled superseded.
// Every other precondition is honestly reported INTEGRATION_PENDING rather
// than fabricated, because --offline performs no live probe of them.
function offlineRegistrySourceBytes() {
  const deployment = {
    chainId: ROBINHOOD_CHAIN_ID,
    latest: {
      UniversalRouter: {
        address: REPO_PINNED_UNIVERSAL_ROUTER,
        note: `current deployment; supersedes the ${CHALLENGER_UNIVERSAL_ROUTER} instance`,
      },
    },
    history: [
      {
        label: 'current deployment',
        contracts: { UniversalRouter: { address: REPO_PINNED_UNIVERSAL_ROUTER } },
      },
      {
        label: 'superseded: replaced by the current deployment',
        contracts: { UniversalRouter: { address: CHALLENGER_UNIVERSAL_ROUTER } },
      },
    ],
  };
  return Buffer.from(JSON.stringify(deployment), 'utf8');
}

function offlinePreconditionPending(id, category, reason) {
  return preconditionPending(id, category, `${reason} (--offline: no live probe performed)`);
}

export function buildOfflineReport(manifest) {
  const registry = parseUniversalRouterDeploymentRegistry(offlineRegistrySourceBytes());
  const router = {
    id: 'universal-router-address-resolution',
    category: 'UNISWAP_ROUTER',
    status: 'INTEGRATION_PENDING',
    evidence: {
      repoPinnedAddress: REPO_PINNED_UNIVERSAL_ROUTER.toLowerCase(),
      challengerAddress: CHALLENGER_UNIVERSAL_ROUTER.toLowerCase(),
      liveAddress: null,
      deploymentRegistry: registry,
      onChainProbe: {},
    },
    reason: 'Deployment registry parsed from the offline fixture names '
      + `${registry.latestAddress} as latest, but --offline performs no on-chain runtime-codehash probe to corroborate it, `
      + 'so resolution stays INTEGRATION_PENDING; run without --offline against a live RPC to resolve it.',
  };
  const bindingDrift = offlinePreconditionPending(
    'binding-runtime-drift',
    'BINDING_DRIFT',
    'binding drift was not checked',
  );
  const programmable = {
    ...offlinePreconditionPending(
      'programmable-robinhood-chain-launch-profile',
      'PROGRAMMABLE',
      'Programmable was not probed',
    ),
    repairMergeEligible: true,
    repairMergeBlockers: [],
    launchEligible: false,
    evidence: {
      launchFlags: {
        discoveryHttpOk: null,
        capabilitiesHttpOk: null,
        chainListed: null,
        publicAuthorization: null,
        publicWrites: null,
        releaseReady: null,
        readinessReady: null,
        activationBlockersReported: null,
        activationBlockersEmpty: null,
        profilePresent: null,
        profileIdentityPresent: null,
        profileDigestPresent: null,
        chainDeploymentDescriptorDigestPresent: null,
        capabilityRootsPresent: null,
        deploymentEvidencePresent: null,
        deploymentEvidenceConsistent: null,
        externalRootDeploymentEvidencePresent: null,
        externalRootDeploymentEvidenceConsistent: null,
        permit2GenesisProvenanceConsistent: null,
        bindingRootsPresent: null,
        bindingRootsConsistent: null,
      },
      launchBlockers: ['OFFLINE_NO_LIVE_PROBE'],
      activationBlockers: null,
    },
  };
  const preconditions = [
    router,
    bindingDrift,
    offlinePreconditionPending('collector-crypt-read-endpoints', 'COLLECTOR_CRYPT', 'Collector Crypt was not probed'),
    offlinePreconditionPending('relay-chains-usdg-solana-usd-coin-route', 'RELAY', 'Relay was not probed'),
    programmable,
  ];
  return {
    schemaVersion: 'hookemon.phase2-readiness.v1',
    observedAt: nowIso(),
    mode: 'offline',
    chain: { id: ROBINHOOD_CHAIN_ID, rpcUrl: manifest.chain?.rpcUrl ?? null },
    preconditions,
    overallStatus: 'INTEGRATION_PENDING',
    repairMergeEligible: programmable.repairMergeEligible,
    launchEligible: programmable.launchEligible,
    eligibility: {
      repairMerge: {
        eligible: programmable.repairMergeEligible,
        blockers: programmable.repairMergeBlockers,
      },
      launch: {
        eligible: programmable.launchEligible,
        flags: programmable.evidence.launchFlags,
        blockers: programmable.evidence.launchBlockers,
      },
    },
    universalRouterResolution: router,
    miningGate: {
      blockedPackage: 'WP-20',
      unblocked: false,
      reason: 'WP-20 remains blocked: --offline mode never resolves the router address, only a live run can.',
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function parseInvocation(argv) {
  const args = argv.slice(2);
  let manifestPath = 'bindings/robinhood-chain.json';
  let manifestProvided = false;
  let offline = false;
  for (const arg of args) {
    if (arg === '--offline') {
      invariant(!offline, '--offline may be specified only once');
      offline = true;
    } else {
      invariant(
        !arg.startsWith('-') && !manifestProvided,
        'usage: node scripts/verify-phase2-readiness.mjs [bindings/robinhood-chain.json] [--offline]',
      );
      manifestPath = arg;
      manifestProvided = true;
    }
  }
  return { manifestPath, offline };
}

async function main() {
  const { manifestPath, offline } = parseInvocation(process.argv);
  const manifest = JSON.parse(readFileSync(path.resolve(manifestPath), 'utf8'));
  // The registry fetch (if any) happens inside buildReadinessReport ->
  // resolveUniversalRouter, guarded by its own try/catch: a fetch failure
  // degrades that one precondition to INTEGRATION_PENDING / REGISTRY_UNAVAILABLE
  // instead of rejecting main() before the other four independent probes run.
  const report = offline
    ? buildOfflineReport(manifest)
    : await buildReadinessReport({ manifest });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const isMain = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
