import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  buildOfflineReport as buildOfflineDriftReport,
  checkBindingDrift,
  parseInvocation as parseDriftInvocation,
  probeContractRuntime,
} from '../check-binding-drift.mjs';
import {
  buildOfflineReport,
  buildReadinessReport,
  parseInvocation,
  parseUniversalRouterDeploymentRegistry,
  probeCollectorCrypt,
  probeProgrammable,
  probeRelayChains,
  resolveUniversalRouter,
} from '../verify-phase2-readiness.mjs';

const root = resolve(import.meta.dirname, '../..');
const REPO_PINNED = '0x06afBA43fd06227fA663b0dAeCF536F6eaA6BF99';
const CHALLENGER = '0x8876789976decbfcbbbe364623c63652db8c0904';
const PROGRAMMABLE_DISCOVERY_URL = 'https://programmable.market/.well-known/programmable.json';
const PROGRAMMABLE_CAPABILITIES_URL = 'https://api.programmable.market/v4/chains/4663/capabilities';

function readJsonFixture(name) {
  return JSON.parse(readFileSync(resolve(root, 'scripts/tests/fixtures/programmable', name), 'utf8'));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function programmableLiveFacts() {
  return {
    discovery: readJsonFixture('discovery-4663.json'),
    capabilities: readJsonFixture('capabilities-4663.json'),
  };
}

function launchableProgrammableFacts() {
  const facts = programmableLiveFacts();
  const chain = facts.discovery.chains.find((entry) => entry.chainId === 4663);
  chain.publicAuthorization = true;
  chain.publicWrites = true;
  chain.releaseReady = true;
  facts.discovery.customLaunchApi.versions.v4.activationBlockers = [];
  return facts;
}

function programmableFetchStub({ discovery, capabilities, calls = [] }) {
  return async (url) => {
    calls.push(url);
    if (url === PROGRAMMABLE_DISCOVERY_URL) return jsonResponse(discovery);
    if (url === PROGRAMMABLE_CAPABILITIES_URL) return jsonResponse(capabilities);
    throw new Error(`unexpected Programmable URL ${url}`);
  };
}

function bindingManifest() {
  return JSON.parse(readFileSync(resolve(root, 'bindings/robinhood-chain.json'), 'utf8'));
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) };
}

function sha256OfHex(hex) {
  return createHash('sha256').update(Buffer.from(hex.replace(/^0x/, ''), 'hex')).digest('hex');
}

const POOL_MANAGER_CODE = '0xaaaa';
const POSITION_MANAGER_CODE = '0xdddd';
const STATE_VIEW_CODE = '0xeeee';
const UNIVERSAL_ROUTER_CODE = '0xbbbb';
const CHALLENGER_CODE = '0xcccc';
const WRONG_POOL_MANAGER_CODE = '0xffff';

// A minimal manifest shaped like bindings/robinhood-chain.json's `chain` and
// `contracts` sections, small enough to keep the tests focused on the drift
// logic rather than the full binding schema. Its pinned runtimeSha256
// values are the real sha256 of POOL_MANAGER_CODE / UNIVERSAL_ROUTER_CODE so
// a stub RPC returning exactly that code reproduces a genuine drift-free
// match, the same way the live pinned manifest does.
function sampleManifest() {
  return {
    chain: { chainId: 4663, rpcUrl: 'https://rpc.example.invalid' },
    contracts: {
      poolManager: {
        address: '0x8366a39cc670b4001a1121b8f6a443a643e40951',
        runtimeSha256: `sha256:${sha256OfHex(POOL_MANAGER_CODE)}`,
        codeSize: 2,
      },
      universalRouter: {
        address: REPO_PINNED,
        runtimeSha256: `sha256:${sha256OfHex(UNIVERSAL_ROUTER_CODE)}`,
        codeSize: 2,
      },
    },
  };
}

function readinessManifest() {
  const manifest = sampleManifest();
  const binding = bindingManifest().contracts;
  const roots = {
    poolManager: POOL_MANAGER_CODE,
    positionManager: POSITION_MANAGER_CODE,
    stateView: STATE_VIEW_CODE,
    universalRouter: UNIVERSAL_ROUTER_CODE,
  };
  for (const [name, code] of Object.entries(roots)) {
    manifest.contracts[name] = {
      address: binding[name].address,
      runtimeCodeHash: binding[name].runtimeCodeHash,
      runtimeSha256: `sha256:${sha256OfHex(code)}`,
      codeSize: 2,
    };
  }
  return manifest;
}

function readinessCodeByAddress() {
  const contracts = readinessManifest().contracts;
  return {
    [contracts.poolManager.address.toLowerCase()]: POOL_MANAGER_CODE,
    [contracts.positionManager.address.toLowerCase()]: POSITION_MANAGER_CODE,
    [contracts.stateView.address.toLowerCase()]: STATE_VIEW_CODE,
    [contracts.universalRouter.address.toLowerCase()]: UNIVERSAL_ROUTER_CODE,
    [CHALLENGER.toLowerCase()]: CHALLENGER_CODE,
  };
}

function rpcFetchStub({ codeByAddress, blockError = false }) {
  return async (url, options) => {
    const request = JSON.parse(options.body);
    if (request.method === 'eth_getBlockByNumber') {
      if (blockError && request.params[0] === 'finalized') {
        return jsonResponse({ jsonrpc: '2.0', id: 1, error: { message: 'metadata is not found' } });
      }
      const isFinalized = request.params[0] === 'finalized';
      return jsonResponse({
        jsonrpc: '2.0',
        id: 1,
        result: { number: isFinalized ? '0x1' : '0x2', hash: `0x${isFinalized ? 'fi' : 'la'}` },
      });
    }
    if (request.method === 'eth_getCode') {
      const [address] = request.params;
      const code = codeByAddress[address.toLowerCase()] ?? '0x';
      return jsonResponse({ jsonrpc: '2.0', id: 1, result: code });
    }
    throw new Error(`unexpected RPC method ${request.method}`);
  };
}

// ---------------------------------------------------------------------------
// check-binding-drift.mjs
// ---------------------------------------------------------------------------

test('probeContractRuntime reports code presence, runtime hash, and finality', async () => {
  const fetchImpl = rpcFetchStub({ codeByAddress: { [REPO_PINNED.toLowerCase()]: '0xaabbcc' } });
  const result = await probeContractRuntime({ rpcUrl: 'https://rpc.example.invalid', address: REPO_PINNED, fetchImpl });
  assert.equal(result.address, REPO_PINNED.toLowerCase());
  assert.equal(result.codeSize, 3);
  assert.equal(result.hasCode, true);
  assert.equal(result.runtimeSha256.length, 64);
  assert.equal(result.finalityConfirmed, false, 'finalized block (0x1) is behind the probed block (0x2)');
});

test('probeContractRuntime never requires the finalized tag to succeed', async () => {
  const fetchImpl = rpcFetchStub({ codeByAddress: { [REPO_PINNED.toLowerCase()]: '0x01' }, blockError: true });
  const result = await probeContractRuntime({ rpcUrl: 'https://rpc.example.invalid', address: REPO_PINNED, fetchImpl });
  assert.equal(result.hasCode, true);
  assert.equal(result.finalizedBlockNumber, null);
  assert.equal(result.finalityConfirmed, false);
});

test('probeContractRuntime rejects a non-address', async () => {
  await assert.rejects(
    () => probeContractRuntime({ rpcUrl: 'x', address: 'not-an-address', fetchImpl: async () => jsonResponse({}) }),
    /EVM address/,
  );
});

test('checkBindingDrift reports PASSED when live bytecode matches every pinned hash', async () => {
  const manifest = sampleManifest();
  const codeByAddress = {
    '0x8366a39cc670b4001a1121b8f6a443a643e40951': POOL_MANAGER_CODE,
    [REPO_PINNED.toLowerCase()]: UNIVERSAL_ROUTER_CODE,
  };
  const report = await checkBindingDrift({ manifest, fetchImpl: rpcFetchStub({ codeByAddress }) });
  assert.equal(report.status, 'PASSED');
  assert.equal(report.contracts.length, 2);
  assert.ok(report.contracts.every((entry) => entry.status === 'PASSED'));
});

test('checkBindingDrift reports DRIFTED for a mismatched contract without hiding the others', async () => {
  const manifest = sampleManifest();
  const codeByAddress = {
    '0x8366a39cc670b4001a1121b8f6a443a643e40951': WRONG_POOL_MANAGER_CODE, // does not hash to the pinned value
    [REPO_PINNED.toLowerCase()]: UNIVERSAL_ROUTER_CODE,
  };
  const report = await checkBindingDrift({ manifest, fetchImpl: rpcFetchStub({ codeByAddress }) });
  assert.equal(report.status, 'DRIFTED');
  const drifted = report.contracts.find((entry) => entry.name === 'poolManager');
  const clean = report.contracts.find((entry) => entry.name === 'universalRouter');
  assert.equal(drifted.status, 'DRIFTED');
  assert.equal(clean.status, 'PASSED');
});

test('checkBindingDrift reports INTEGRATION_PENDING per-contract on a probe failure, never throws', async () => {
  const manifest = sampleManifest();
  const fetchImpl = async (url, options) => {
    const request = JSON.parse(options.body);
    if (request.method === 'eth_getCode' && request.params[0].toLowerCase() === REPO_PINNED.toLowerCase()) {
      throw new Error('network unreachable');
    }
    return rpcFetchStub({ codeByAddress: { '0x8366a39cc670b4001a1121b8f6a443a643e40951': POOL_MANAGER_CODE } })(url, options);
  };
  const report = await checkBindingDrift({ manifest, fetchImpl });
  assert.equal(report.status, 'INTEGRATION_PENDING');
  const pending = report.contracts.find((entry) => entry.name === 'universalRouter');
  assert.equal(pending.status, 'INTEGRATION_PENDING');
  assert.match(pending.reason, /network unreachable/);
});

test('checkBindingDrift rejects a manifest missing chain.rpcUrl or contracts', async () => {
  await assert.rejects(() => checkBindingDrift({ manifest: { contracts: {} } }), /rpcUrl/);
  await assert.rejects(() => checkBindingDrift({ manifest: { chain: { rpcUrl: 'x' } } }), /contracts/);
});

test('check-binding-drift offline report never claims a live PASSED', () => {
  const manifest = sampleManifest();
  const report = buildOfflineDriftReport(manifest);
  assert.equal(report.status, 'INTEGRATION_PENDING');
  assert.ok(report.contracts.every((entry) => entry.status === 'INTEGRATION_PENDING'));
});

test('check-binding-drift parseInvocation reads the default manifest path and the --offline flag', () => {
  assert.deepEqual(parseDriftInvocation(['node', 'script']), {
    manifestPath: 'bindings/robinhood-chain.json',
    offline: false,
  });
  assert.deepEqual(parseDriftInvocation(['node', 'script', 'custom.json', '--offline']), {
    manifestPath: 'custom.json',
    offline: true,
  });
  assert.throws(() => parseDriftInvocation(['node', 'script', '--offline', '--offline']), /once/);
});

test('check-binding-drift CLI --offline runs against the real committed manifest and exits 0', () => {
  const stdout = execFileSync(process.execPath, ['scripts/check-binding-drift.mjs', '--offline'], { cwd: root, encoding: 'utf8' });
  const report = JSON.parse(stdout);
  assert.equal(report.schemaVersion, 'hookemon.binding-drift.v1');
  assert.equal(report.mode, 'offline');
  assert.ok(report.contracts.length >= 9, 'the real bindings manifest pins at least the 9 expected contracts');
});

// ---------------------------------------------------------------------------
// verify-phase2-readiness.mjs: Universal Router resolution
// ---------------------------------------------------------------------------

function deploymentRegistryBytes({ latestAddress = REPO_PINNED, historyAddress = CHALLENGER } = {}) {
  return Buffer.from(JSON.stringify({
    chainId: 4663,
    latest: { UniversalRouter: { address: latestAddress, note: 'latest redeploy' } },
    history: [
      { label: 'current', contracts: { UniversalRouter: { address: latestAddress } } },
      { label: 'orphaned: replaced', contracts: { UniversalRouter: { address: historyAddress } } },
    ],
  }), 'utf8');
}

test('parseUniversalRouterDeploymentRegistry extracts latest and every historic instance', () => {
  const registry = parseUniversalRouterDeploymentRegistry(deploymentRegistryBytes());
  assert.equal(registry.latestAddress, REPO_PINNED.toLowerCase());
  assert.equal(registry.instances.length, 2);
  const historic = registry.instances.find((entry) => entry.address === CHALLENGER.toLowerCase());
  assert.match(historic.labels[0], /orphaned/);
});

test('parseUniversalRouterDeploymentRegistry rejects the wrong chain', () => {
  const bytes = Buffer.from(JSON.stringify({ chainId: 1, latest: { UniversalRouter: { address: REPO_PINNED } } }), 'utf8');
  assert.throws(() => parseUniversalRouterDeploymentRegistry(bytes), /chain ID/);
});

test('resolveUniversalRouter: PASSED with the repo-pinned address when the registry and on-chain code agree', async () => {
  const fetchImpl = rpcFetchStub({
    codeByAddress: { [REPO_PINNED.toLowerCase()]: '0xaa', [CHALLENGER.toLowerCase()]: '0xbb' },
  });
  const result = await resolveUniversalRouter({
    registrySourceBytes: deploymentRegistryBytes(),
    rpcUrl: 'https://rpc.example.invalid',
    fetchImpl,
  });
  assert.equal(result.status, 'PASSED');
  assert.equal(result.liveAddress, REPO_PINNED.toLowerCase());
  assert.equal(result.resolution, 'REPO_PINNED_ADDRESS_IS_LIVE');
  assert.equal(result.matchesRepoPin, true);
  assert.ok(result.evidence.onChainProbe[REPO_PINNED.toLowerCase()].hasCode);
});

test('resolveUniversalRouter: PASSED with the challenger address when the registry names it as latest', async () => {
  const fetchImpl = rpcFetchStub({
    codeByAddress: { [REPO_PINNED.toLowerCase()]: '0xaa', [CHALLENGER.toLowerCase()]: '0xbb' },
  });
  const result = await resolveUniversalRouter({
    registrySourceBytes: deploymentRegistryBytes({ latestAddress: CHALLENGER, historyAddress: REPO_PINNED }),
    rpcUrl: 'https://rpc.example.invalid',
    fetchImpl,
  });
  assert.equal(result.status, 'PASSED');
  assert.equal(result.liveAddress, CHALLENGER.toLowerCase());
  assert.equal(result.resolution, 'CHALLENGER_ADDRESS_IS_LIVE');
  assert.equal(result.matchesRepoPin, false);
});

test('resolveUniversalRouter: INTEGRATION_PENDING when the registry names neither candidate', async () => {
  const other = '0x1111111111111111111111111111111111111111';
  const fetchImpl = rpcFetchStub({ codeByAddress: { [other]: '0xaa' } });
  const result = await resolveUniversalRouter({
    registrySourceBytes: deploymentRegistryBytes({ latestAddress: other, historyAddress: CHALLENGER }),
    rpcUrl: 'https://rpc.example.invalid',
    fetchImpl,
  });
  assert.equal(result.status, 'INTEGRATION_PENDING');
  assert.equal(result.resolution, 'REGISTRY_NAMES_NEITHER_CANDIDATE');
  assert.equal(result.liveAddress, null);
});

test('resolveUniversalRouter: INTEGRATION_PENDING when the registry-named address has no on-chain code', async () => {
  // Registry says the repo-pinned address is latest, but the on-chain probe
  // finds it empty -- resolution must fail closed rather than trust the
  // registry alone.
  const fetchImpl = rpcFetchStub({ codeByAddress: { [CHALLENGER.toLowerCase()]: '0xbb' } });
  const result = await resolveUniversalRouter({
    registrySourceBytes: deploymentRegistryBytes(),
    rpcUrl: 'https://rpc.example.invalid',
    fetchImpl,
  });
  assert.equal(result.status, 'INTEGRATION_PENDING');
  assert.equal(result.liveAddress, null);
});

test('resolveUniversalRouter: INTEGRATION_PENDING (never throws) on an unparseable registry source', async () => {
  const fetchImpl = rpcFetchStub({ codeByAddress: {} });
  const result = await resolveUniversalRouter({
    registrySourceBytes: Buffer.from('not json'),
    rpcUrl: 'https://rpc.example.invalid',
    fetchImpl,
  });
  assert.equal(result.status, 'INTEGRATION_PENDING');
  assert.equal(result.resolution, 'REGISTRY_UNAVAILABLE');
});

test('resolveUniversalRouter: INTEGRATION_PENDING/REGISTRY_UNAVAILABLE (never throws) when the registry fetch itself rejects', async () => {
  const fetchImpl = async () => {
    throw new Error('getaddrinfo ENOTFOUND raw.githubusercontent.com');
  };
  const result = await resolveUniversalRouter({
    // no registrySourceBytes supplied: resolveUniversalRouter must fetch it itself
    rpcUrl: 'https://rpc.example.invalid',
    fetchImpl,
  });
  assert.equal(result.status, 'INTEGRATION_PENDING');
  assert.equal(result.resolution, 'REGISTRY_UNAVAILABLE');
  assert.match(result.reason, /ENOTFOUND/);
});

test('resolveUniversalRouter: INTEGRATION_PENDING/REGISTRY_UNAVAILABLE (never throws) when the registry fetch returns non-2xx', async () => {
  const fetchImpl = async () => jsonResponse({}, { ok: false, status: 503 });
  const result = await resolveUniversalRouter({
    rpcUrl: 'https://rpc.example.invalid',
    fetchImpl,
  });
  assert.equal(result.status, 'INTEGRATION_PENDING');
  assert.equal(result.resolution, 'REGISTRY_UNAVAILABLE');
  assert.match(result.reason, /503/);
});

// ---------------------------------------------------------------------------
// verify-phase2-readiness.mjs: Collector Crypt / Relay / Programmable
// ---------------------------------------------------------------------------

test('probeCollectorCrypt: PASSED when both endpoints return 200 with a non-empty catalog', async () => {
  const fetchImpl = async (url) => (url.endsWith('/api/status')
    ? jsonResponse({ ok: true })
    : jsonResponse({ machines: [{ id: 'pokemon_25' }] }));
  const result = await probeCollectorCrypt({ fetchImpl });
  assert.equal(result.status, 'PASSED');
  assert.equal(result.evidence.machineCount, 1);
});

test('probeCollectorCrypt: INTEGRATION_PENDING on an empty machine catalog', async () => {
  const fetchImpl = async (url) => (url.endsWith('/api/status')
    ? jsonResponse({ ok: true })
    : jsonResponse([]));
  const result = await probeCollectorCrypt({ fetchImpl });
  assert.equal(result.status, 'INTEGRATION_PENDING');
});

test('probeCollectorCrypt: INTEGRATION_PENDING (never throws) when the request itself fails', async () => {
  const fetchImpl = async () => {
    throw new Error('DNS failure');
  };
  const result = await probeCollectorCrypt({ fetchImpl });
  assert.equal(result.status, 'INTEGRATION_PENDING');
  assert.match(result.reason, /DNS failure/);
});

test('probeRelayChains: PASSED only when both USDG on Robinhood and USD Coin on Solana are enabled', async () => {
  const fetchImpl = async () => jsonResponse({
    chains: [
      { id: 4663, erc20Currencies: [{ address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' }] },
      { id: 792703809, solverCurrencies: [{ address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }] },
    ],
  });
  const result = await probeRelayChains({ fetchImpl });
  assert.equal(result.status, 'PASSED');
});

test('probeRelayChains: INTEGRATION_PENDING when the Solana leg is missing', async () => {
  const fetchImpl = async () => jsonResponse({
    chains: [{ id: 4663, erc20Currencies: [{ address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' }] }],
  });
  const result = await probeRelayChains({ fetchImpl });
  assert.equal(result.status, 'INTEGRATION_PENDING');
  assert.equal(result.evidence.solanaChainListed, false);
});

test('probeProgrammable: separately evaluates every public-launch input across all boolean combinations', async () => {
  let cases = 0;
  for (const publicAuthorization of [false, true]) {
    for (const publicWrites of [false, true]) {
      for (const releaseReady of [false, true]) {
        for (const readinessReady of [false, true]) {
          for (const activationBlockersEmpty of [false, true]) {
            const facts = launchableProgrammableFacts();
            const chain = facts.discovery.chains.find((entry) => entry.chainId === 4663);
            chain.publicAuthorization = publicAuthorization;
            chain.publicWrites = publicWrites;
            chain.releaseReady = releaseReady;
            facts.capabilities.readiness.status = readinessReady ? 'ready' : 'unavailable';
            facts.discovery.customLaunchApi.versions.v4.activationBlockers = activationBlockersEmpty
              ? []
              : ['public-cli-release'];
            const calls = [];
            const result = await probeProgrammable({
              manifest: bindingManifest(),
              fetchImpl: programmableFetchStub({ ...facts, calls }),
            });
            const expectedLaunchEligible = publicAuthorization
              && publicWrites
              && releaseReady
              && readinessReady
              && activationBlockersEmpty;
            const scenario = JSON.stringify({
              publicAuthorization,
              publicWrites,
              releaseReady,
              readinessReady,
              activationBlockersEmpty,
            });

            assert.equal(result.repairMergeEligible, true, scenario);
            assert.equal(result.launchEligible, expectedLaunchEligible, scenario);
            assert.equal(result.status, expectedLaunchEligible ? 'PASSED' : 'INTEGRATION_PENDING', scenario);
            assert.equal(result.evidence.launchFlags.publicAuthorization, publicAuthorization, scenario);
            assert.equal(result.evidence.launchFlags.publicWrites, publicWrites, scenario);
            assert.equal(result.evidence.launchFlags.releaseReady, releaseReady, scenario);
            assert.equal(result.evidence.launchFlags.readinessReady, readinessReady, scenario);
            assert.equal(result.evidence.launchFlags.activationBlockersEmpty, activationBlockersEmpty, scenario);
            assert.ok(calls.includes(PROGRAMMABLE_DISCOVERY_URL), scenario);
            assert.ok(calls.includes(PROGRAMMABLE_CAPABILITIES_URL), scenario);
            cases += 1;
          }
        }
      }
    }
  }
  assert.equal(cases, 32);
});

test('probeProgrammable: names live launch blockers without making them repair-merge blockers', async () => {
  const facts = programmableLiveFacts();
  const result = await probeProgrammable({
    manifest: bindingManifest(),
    fetchImpl: programmableFetchStub(facts),
  });

  assert.equal(result.repairMergeEligible, true);
  assert.equal(result.launchEligible, false);
  assert.equal(result.evidence.launchFlags.readinessReady, true);
  assert.equal(result.evidence.launchFlags.publicAuthorization, false);
  assert.equal(result.evidence.launchFlags.publicWrites, false);
  assert.equal(result.evidence.launchFlags.releaseReady, false);
  assert.equal(result.evidence.launchFlags.activationBlockersEmpty, false);
  assert.deepEqual(result.evidence.activationBlockers, [
    'public-cli-release',
    'generated-release-evidence',
    'clean-room-end-to-end-proof',
    'public-indexing-canary',
  ]);
  assert.ok(result.evidence.launchBlockers.includes('PUBLIC_AUTHORIZATION_DISABLED'));
  assert.ok(result.evidence.launchBlockers.includes('PUBLIC_WRITES_DISABLED'));
  assert.ok(result.evidence.launchBlockers.includes('RELEASE_NOT_READY'));
  assert.ok(result.evidence.launchBlockers.includes('ACTIVATION_BLOCKERS_PRESENT'));
});

test('probeProgrammable: external request failures remain reportable when a fetch rejects without an Error', async () => {
  const result = await probeProgrammable({
    manifest: bindingManifest(),
    fetchImpl: async () => { throw undefined; },
  });

  assert.equal(result.status, 'INTEGRATION_PENDING');
  assert.equal(result.repairMergeEligible, true);
  assert.equal(result.launchEligible, false);
  assert.ok(result.evidence.launchBlockers.includes('PROGRAMMABLE_DISCOVERY_UNAVAILABLE'));
  assert.ok(result.evidence.launchBlockers.includes('PROGRAMMABLE_CAPABILITIES_UNAVAILABLE'));
});

test('probeProgrammable: fails launch eligibility when deployment evidence is incomplete or inconsistent', async () => {
  const scenarios = [
    {
      name: 'profile missing',
      mutate: (facts) => { facts.capabilities.profile = null; },
      blocker: 'PROFILE_MISSING',
    },
    {
      name: 'profile digest missing',
      mutate: (facts) => { facts.capabilities.profile.profileDigest = ''; },
      blocker: 'PROFILE_DIGEST_MISSING',
    },
    {
      name: 'deployment descriptor digest missing',
      mutate: (facts) => { facts.capabilities.chainDeploymentDescriptorDigest = ''; },
      blocker: 'CHAIN_DEPLOYMENT_DESCRIPTOR_DIGEST_MISSING',
    },
    {
      name: 'external root evidence missing',
      mutate: (facts) => { facts.capabilities.chainDeployment.externalRootDeploymentEvidence = []; },
      blocker: 'EXTERNAL_ROOT_DEPLOYMENT_EVIDENCE_MISSING',
    },
    {
      name: 'binding root address mismatch',
      mutate: (facts) => { facts.capabilities.chainDeployment.contracts.poolManager.address = '0x1111111111111111111111111111111111111111'; },
      blocker: 'BINDING_ROOT_ADDRESS_MISMATCH:poolManager',
    },
    {
      name: 'binding root runtime mismatch',
      mutate: (facts) => { facts.capabilities.chainDeployment.contracts.poolManager.runtimeCodeHash = '0x1111111111111111111111111111111111111111111111111111111111111111'; },
      blocker: 'BINDING_ROOT_RUNTIME_MISMATCH:poolManager',
    },
  ];

  for (const scenario of scenarios) {
    const facts = launchableProgrammableFacts();
    scenario.mutate(facts);
    const result = await probeProgrammable({
      manifest: bindingManifest(),
      fetchImpl: programmableFetchStub(facts),
    });
    assert.equal(result.repairMergeEligible, true, scenario.name);
    assert.equal(result.launchEligible, false, scenario.name);
    assert.ok(result.evidence.launchBlockers.includes(scenario.blocker), scenario.name);
  }
});

// ---------------------------------------------------------------------------
// verify-phase2-readiness.mjs: aggregate report + mining gate
// ---------------------------------------------------------------------------

test('buildReadinessReport: overall PASSED and mining unblocked only when every precondition passes', async () => {
  const manifest = readinessManifest();
  const codeByAddress = readinessCodeByAddress();
  const rpcFetch = rpcFetchStub({ codeByAddress });
  const fetchImpl = async (url, options) => {
    if (url === 'https://rpc.example.invalid') return rpcFetch(url, options);
    if (url.endsWith('/api/status')) return jsonResponse({ ok: true });
    if (url.endsWith('/api/machines')) return jsonResponse({ machines: [{ id: 'pokemon_25' }] });
    if (url.endsWith('/chains')) {
      return jsonResponse({
        chains: [
          { id: 4663, erc20Currencies: [{ address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' }] },
          { id: 792703809, solverCurrencies: [{ address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }] },
        ],
      });
    }
    if (url === PROGRAMMABLE_DISCOVERY_URL) return jsonResponse(launchableProgrammableFacts().discovery);
    if (url === PROGRAMMABLE_CAPABILITIES_URL) return jsonResponse(launchableProgrammableFacts().capabilities);
    throw new Error(`unexpected fetch ${url}`);
  };
  const report = await buildReadinessReport({
    manifest,
    registrySourceBytes: deploymentRegistryBytes(),
    rpcUrl: 'https://rpc.example.invalid',
    fetchImpl,
  });
  assert.equal(report.overallStatus, 'ALL_PRECONDITIONS_PASSED');
  assert.equal(report.miningGate.unblocked, true);
  assert.equal(report.repairMergeEligible, true);
  assert.equal(report.launchEligible, true);
  assert.equal(report.preconditions.length, 5);
});

test('buildReadinessReport: mining stays blocked while the router is unresolved even if everything else passes', async () => {
  const manifest = readinessManifest();
  const other = '0x1111111111111111111111111111111111111111';
  const codeByAddress = readinessCodeByAddress();
  const rpcFetch = rpcFetchStub({ codeByAddress });
  const fetchImpl = async (url, options) => {
    if (url === 'https://rpc.example.invalid') return rpcFetch(url, options);
    if (url.endsWith('/api/status')) return jsonResponse({ ok: true });
    if (url.endsWith('/api/machines')) return jsonResponse({ machines: [{ id: 'pokemon_25' }] });
    if (url.endsWith('/chains')) {
      return jsonResponse({
        chains: [
          { id: 4663, erc20Currencies: [{ address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' }] },
          { id: 792703809, solverCurrencies: [{ address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }] },
        ],
      });
    }
    if (url === PROGRAMMABLE_DISCOVERY_URL) return jsonResponse(launchableProgrammableFacts().discovery);
    if (url === PROGRAMMABLE_CAPABILITIES_URL) return jsonResponse(launchableProgrammableFacts().capabilities);
    throw new Error(`unexpected fetch ${url}`);
  };
  const report = await buildReadinessReport({
    manifest,
    registrySourceBytes: deploymentRegistryBytes({ latestAddress: other, historyAddress: CHALLENGER }),
    rpcUrl: 'https://rpc.example.invalid',
    fetchImpl,
  });
  assert.equal(report.overallStatus, 'INTEGRATION_PENDING');
  assert.equal(report.miningGate.unblocked, false);
  assert.equal(report.universalRouterResolution.status, 'INTEGRATION_PENDING');
});

test('buildReadinessReport: a failed registry fetch degrades only the router precondition, never rejects, and still reports the other four', async () => {
  const manifest = readinessManifest();
  const codeByAddress = readinessCodeByAddress();
  const rpcFetch = rpcFetchStub({ codeByAddress });
  const fetchImpl = async (url, options) => {
    if (url.includes('githubusercontent.com')) throw new Error('registry fetch: connection timed out');
    if (url === 'https://rpc.example.invalid') return rpcFetch(url, options);
    if (url.endsWith('/api/status')) return jsonResponse({ ok: true });
    if (url.endsWith('/api/machines')) return jsonResponse({ machines: [{ id: 'pokemon_25' }] });
    if (url.endsWith('/chains')) {
      return jsonResponse({
        chains: [
          { id: 4663, erc20Currencies: [{ address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168' }] },
          { id: 792703809, solverCurrencies: [{ address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' }] },
        ],
      });
    }
    if (url === PROGRAMMABLE_DISCOVERY_URL) return jsonResponse(launchableProgrammableFacts().discovery);
    if (url === PROGRAMMABLE_CAPABILITIES_URL) return jsonResponse(launchableProgrammableFacts().capabilities);
    throw new Error(`unexpected fetch ${url}`);
  };
  // No registrySourceBytes: buildReadinessReport must let resolveUniversalRouter
  // fetch it, and must not reject when that fetch fails -- the other four
  // independent probes (binding drift, Collector Crypt, Relay, Programmable)
  // are still expected to run and be reported.
  const report = await buildReadinessReport({
    manifest,
    rpcUrl: 'https://rpc.example.invalid',
    fetchImpl,
  });
  assert.equal(report.overallStatus, 'INTEGRATION_PENDING');
  assert.equal(report.miningGate.unblocked, false);
  assert.equal(report.universalRouterResolution.status, 'INTEGRATION_PENDING');
  assert.equal(report.universalRouterResolution.evidence.resolution, 'REGISTRY_UNAVAILABLE');
  assert.equal(report.preconditions.length, 5);
  const byId = Object.fromEntries(report.preconditions.map((entry) => [entry.id, entry]));
  assert.equal(byId['binding-runtime-drift'].status, 'PASSED');
  assert.equal(byId['collector-crypt-read-endpoints'].status, 'PASSED');
  assert.equal(byId['relay-chains-usdg-solana-usd-coin-route'].status, 'PASSED');
  assert.equal(byId['programmable-robinhood-chain-launch-profile'].status, 'PASSED');
});

test('verify-phase2-readiness offline report never fabricates a resolution and blocks mining', () => {
  const report = buildOfflineReport(sampleManifest());
  assert.equal(report.mode, 'offline');
  assert.equal(report.overallStatus, 'INTEGRATION_PENDING');
  assert.equal(report.miningGate.unblocked, false);
  assert.equal(report.repairMergeEligible, true);
  assert.equal(report.launchEligible, false);
  assert.deepEqual(report.eligibility.launch.blockers, ['OFFLINE_NO_LIVE_PROBE']);
  assert.ok(report.preconditions.every((entry) => entry.status === 'INTEGRATION_PENDING'));
});

test('verify-phase2-readiness parseInvocation reads the default manifest path and the --offline flag', () => {
  assert.deepEqual(parseInvocation(['node', 'script']), {
    manifestPath: 'bindings/robinhood-chain.json',
    offline: false,
  });
  assert.deepEqual(parseInvocation(['node', 'script', 'custom.json', '--offline']), {
    manifestPath: 'custom.json',
    offline: true,
  });
  assert.throws(() => parseInvocation(['node', 'script', '--offline', '--offline']), /once/);
});

test('verify-phase2-readiness CLI --offline runs against the real committed manifest and exits 0', () => {
  const stdout = execFileSync(process.execPath, ['scripts/verify-phase2-readiness.mjs', '--offline'], { cwd: root, encoding: 'utf8' });
  const report = JSON.parse(stdout);
  assert.equal(report.schemaVersion, 'hookemon.phase2-readiness.v1');
  assert.equal(report.mode, 'offline');
  assert.equal(report.miningGate.unblocked, false);
  assert.equal(report.preconditions.length, 5);
});
