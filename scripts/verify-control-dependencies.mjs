#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile, readJson, sha256, writeJson } from './lib/util.mjs';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const SUPPORTED_NODE_VERSION = '24.19.0';
const NODE_WORKFLOW_DISTRIBUTION = 'linux-x64';
const SUPPORTED_NODE_DISTRIBUTIONS = Object.freeze({
  'linux-x64': Object.freeze({
    url: 'https://nodejs.org/download/release/v24.19.0/node-v24.19.0-linux-x64.tar.xz',
    archiveSha256: '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647',
    executableSha256: 'bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12',
  }),
  'darwin-arm64': Object.freeze({
    url: 'https://nodejs.org/download/release/v24.19.0/node-v24.19.0-darwin-arm64.tar.xz',
    archiveSha256: '3f1cf157479c1480352083105e13faf9d008ede98e7e157746b6df940d197b94',
    executableSha256: '27db838bb204ef7c21df2931f5656e4c8fb32e6e947f363a402b49714d32b5b1',
  }),
});
const V4_GATES_WORKFLOW_PATH = '.github/workflows/v4-gates.yml';
const FORK_PROOF_WORKFLOW_PATH = '.github/workflows/fork-proof.yml';
const FORK_PIN_CANARY_WORKFLOW_PATH = '.github/workflows/fork-pin-canary.yml';
const IDENTITY_GATE_WORKFLOW_PATH = '.github/workflows/identity-gate.yml';
const CONTROL_GATE_WORKFLOW_PATH = '.github/workflows/control-gate.yml';
const PERMITTED_WORKFLOW_PATHS = new Set([
  V4_GATES_WORKFLOW_PATH,
  FORK_PROOF_WORKFLOW_PATH,
  FORK_PIN_CANARY_WORKFLOW_PATH,
  IDENTITY_GATE_WORKFLOW_PATH,
  CONTROL_GATE_WORKFLOW_PATH,
]);
const COMMIT_IDENTITY_ALLOWLIST_PATH = 'scripts/check-commit-identity.mjs';
const FORK_PIN_VERIFIER_PATH = 'scripts/verify-fork-pin.mjs';
const RELEASE_CLOSURE_BUILDER_MANIFEST_PATH = 'scripts/programmable/vendor/programmable-v4-hook-builder/manifest.json';
const FORK_PIN_VERIFIER_IMPORT_PATH = 'scripts/programmable/lib/keccak.mjs';
const CONTROL_DEPENDENCY_VERIFIER_PATH = 'scripts/verify-control-dependencies.mjs';
const CONTROL_DEPENDENCY_VERIFIER_IMPORT_PATH = 'scripts/lib/util.mjs';
const ARCHIVE_FORK_PROOF_TEST_PATH = 'packages/contracts/test/integration/RobinhoodV4ArchiveFork.t.sol';
const SUPPORTED_V4_GATES_WORKFLOW_SHA256 = 'fdbe6a32fc961dae0094850108ed66852061782c41b1755424de1d3d9cd1b276';
const SUPPORTED_FORK_PROOF_WORKFLOW_SHA256 = '8127fd545380aead60865a100412a5490c592fd8cac156f879783cf078a25a21';
const SUPPORTED_FORK_PIN_CANARY_WORKFLOW_SHA256 = 'd96801f9885587e84ffc390acbee7f2b973aff1ad42e4b98b5d25d31aa5cca2a';
const SUPPORTED_IDENTITY_GATE_WORKFLOW_SHA256 = 'd917cb396aff6e2883fa2d083379bd1869b35522c02b6a38bce3bed4dbd7d019';
const SUPPORTED_CONTROL_GATE_WORKFLOW_SHA256 = '08b6c64a76b55303ae019942cf9438c2001967b471d8139990ec0d1a183a6c50';
const SUPPORTED_COMMIT_IDENTITY_ALLOWLIST_SHA256 = '9b89ef928d69676f07bea9052d0c5bb2e4c1c151de5dc590d9c7685711316cba';
const SUPPORTED_FORK_PIN_VERIFIER_SHA256 = '09249c50f08b092305e497b6a9430d3acab0131c689ce58862f1f700668ef94a';
const SUPPORTED_RELEASE_CLOSURE_BUILDER_MANIFEST_SHA256 = 'd3dd54f13b39f251a1cabb1253b19d155075409f68671eec07790eff12375c5b';
const SUPPORTED_RELEASE_CLOSURE_BUILDER_SOURCE_TREE_SHA256 = '4795ee279dec6ae22e047e6fe6c032b85f242cc96797f40d4560f70b6e8559ae';
const SUPPORTED_RELEASE_CLOSURE_BUILDER_ENTRYPOINT = 'scripts/cli-review-target.mjs';
const SUPPORTED_RELEASE_CLOSURE_BUILDER_UPSTREAM = Object.freeze({
  repositorySha256: '7cfbbd3098251021760b48e6bb57b934c9f8fbbb58dc2b053a2440dc0408cc19',
  version: 'v0.4.0',
  ref: 'refs/tags/v0.4.0',
  tree: '237a64de92efdb0e84954e42c654f83f926e82c3',
  path: 'skills/programmable-v4-hook-builder',
  normalization: 'cleanroom-labels-v1',
});
const SUPPORTED_FORK_PIN_VERIFIER_IMPORT_SHA256 = 'ce4ea412ddd845b7495fc960f16855a2d5dea62482f224c5dc4cd8aefaede863';
const SUPPORTED_GITLEAKS_VERSION = '8.30.1';
const GITLEAKS_DISTRIBUTION = 'linux-x64';
const SUPPORTED_GITLEAKS_URL = 'https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz';
const SUPPORTED_FOUNDRY_VERSION = '1.7.1';
const SUPPORTED_FOUNDRY_COMMIT = '4072e48705af9d93e3c0f6e29e93b5e9a40caed8';
const FOUNDRY_DISTRIBUTION = 'linux-amd64';
const SUPPORTED_FOUNDRY_DISTRIBUTION = Object.freeze({
  url: 'https://github.com/foundry-rs/foundry/releases/download/v1.7.1/foundry_v1.7.1_linux_amd64.tar.gz',
  archiveSha256: 'cf7e688ed0c4c48adffca788b496076e31060b67ac5afe1e43dbb5499c20c88b',
  executableSha256: '4f77da0810de94325734855d0ad58d70640aa8a5b2a837608ddf8c26da34355c',
});
const REQUIRED_LOCAL_PHASE2_GATE_BLOCKS = Object.freeze({
  'Verify local Phase 2 runner': Object.freeze([
    'files="$(node scripts/test-manifest.mjs list runner)"',
    'node --test --test-timeout=120000 $files',
    'node packages/runner/src/cycle/verify-fixtures.mjs',
  ]),
  'Verify adapters dependencies': Object.freeze([
    'cd packages/adapters',
    'npm ci --ignore-scripts',
    'cd - >/dev/null',
    'files="$(node scripts/test-manifest.mjs list adapters)"',
    'node --test --test-timeout=120000 $files',
  ]),
  'Verify dashboard suite': Object.freeze([
    'files="$(node scripts/test-manifest.mjs list dashboard)"',
    'node --test --test-timeout=120000 $files',
  ]),
  'Verify local Phase 2 contracts': Object.freeze([
    'FOUNDRY_LIBS=\'["lib/v4-core","lib/v4-periphery"]\' forge test --root packages/contracts --ffi -vv --no-match-path \'test/integration/RobinhoodV4ArchiveFork.t.sol\'',
    'files="$(node scripts/test-manifest.mjs list contracts-abi)"',
    'FOUNDRY_LIBS=\'["lib/v4-core"]\' node --test --test-timeout=120000 $files',
  ]),
  'Verify contracts-js suite': Object.freeze([
    'files="$(node scripts/test-manifest.mjs list contracts-js)"',
    'node --test --test-timeout=120000 $files',
  ]),
  'Verify scripts suite': Object.freeze([
    'files="$(node scripts/test-manifest.mjs list scripts)"',
    'node --test --test-timeout=120000 $files',
  ]),
});
const ADAPTERS_PACKAGE_PATH = 'packages/adapters/package.json';
const ADAPTERS_LOCKFILE_PATH = 'packages/adapters/package-lock.json';
const SUPPORTED_GITLEAKS_CONFIG = String.raw`[extend]
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

function normalizeNodeVersion(version) {
  return String(version).replace(/^v/, '');
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesExactObject(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
    && expectedKeys.every(key => value[key] === expected[key]);
}

function workflowConstant(text, name, errors) {
  const escapedName = escapeRegex(name);
  const assignmentPattern = new RegExp(`^\\s*${escapedName}\\s*=`, 'gm');
  const canonicalPattern = new RegExp(`^\\s*${escapedName}\\s*=\\s*(?:'([^']*)'|"([^"]*)")\\s*$`, 'gm');
  const assignments = [...text.matchAll(assignmentPattern)];
  const canonical = [...text.matchAll(canonicalPattern)];
  // Two identically-named jobs (e.g. the main gates job and the fork-proof job) may each
  // reassign the same installer constant; every occurrence must be in the exact canonical
  // `name='value'` shape and all must agree on the same value, or this fails closed.
  if (assignments.length === 0 || canonical.length !== assignments.length) {
    errors.push(`workflow constant ${name} is missing or ambiguous`);
    return null;
  }
  const values = canonical.map(match => match[1] ?? match[2]);
  if (values.some(value => value !== values[0])) {
    errors.push(`workflow constant ${name} has inconsistent values across the workflow`);
    return null;
  }
  return values[0];
}

function workflowInstallRunBlock(workflow, stepName, errors) {
  const lines = workflow.replaceAll('\r\n', '\n').split('\n');
  const stepPattern = new RegExp(`^( *)- name: ${escapeRegex(stepName)}$`);
  const matches = lines
    .map((line, index) => ({ index, match: line.match(stepPattern) }))
    .filter(entry => entry.match);
  if (matches.length !== 1) {
    errors.push(`${stepName} workflow step is missing or ambiguous`);
    return null;
  }

  const { index, match } = matches[0];
  const stepIndent = match[1];
  if (lines[index + 1] !== `${stepIndent}  shell: bash` || lines[index + 2] !== `${stepIndent}  run: |`) {
    errors.push(`${stepName} workflow step must use the canonical Bash run block`);
    return null;
  }

  const contentIndent = `${stepIndent}    `;
  const content = [];
  for (let cursor = index + 3; cursor < lines.length; cursor += 1) {
    const line = lines[cursor];
    if (line === '') {
      content.push('');
      continue;
    }
    if (!line.startsWith(contentIndent)) break;
    content.push(line.slice(contentIndent.length));
  }
  return content.join('\n');
}

function canonicalNodeInstallBlock(pins) {
  const version = pins.controlRuntime?.node;
  const distribution = pins.controlRuntime?.distributions?.[NODE_WORKFLOW_DISTRIBUTION] ?? {};
  return [
    'set -euo pipefail',
    `node_version='${version}'`,
    `node_url='${distribution.url}'`,
    `node_archive_sha256='${distribution.archiveSha256}'`,
    `node_executable_sha256='${distribution.executableSha256}'`,
    'node_archive="${RUNNER_TEMP}/node-v${node_version}-linux-x64.tar.xz"',
    'node_root="${RUNNER_TEMP}/node-v${node_version}-linux-x64"',
    'node_executable="${node_root}/bin/node"',
    'curl --fail --location --proto \'=https\' --tlsv1.2 --silent --show-error --output "$node_archive" "$node_url"',
    'printf \'%s  %s\\n\' "$node_archive_sha256" "$node_archive" | sha256sum --check',
    'tar -xJf "$node_archive" -C "$RUNNER_TEMP"',
    'printf \'%s  %s\\n\' "$node_executable_sha256" "$node_executable" | sha256sum --check',
    'echo "${node_root}/bin" >> "$GITHUB_PATH"',
    '[[ "$("$node_executable" --version)" == "v${node_version}" ]]',
  ].join('\n');
}

function canonicalGitleaksInstallBlock(pins) {
  const gitleaks = pins.securityTools?.gitleaks ?? {};
  const distribution = gitleaks.distributions?.[GITLEAKS_DISTRIBUTION] ?? {};
  const config = gitleaks.config ?? {};
  return [
    'set -euo pipefail',
    `gitleaks_version='${gitleaks.version}'`,
    `gitleaks_url='${distribution.url}'`,
    `gitleaks_archive_sha256='${distribution.archiveSha256}'`,
    `gitleaks_executable_sha256='${distribution.executableSha256}'`,
    `gitleaks_config_sha256='${config.sha256}'`,
    'gitleaks_archive="${RUNNER_TEMP}/gitleaks_${gitleaks_version}_linux_x64.tar.gz"',
    'gitleaks_root="${RUNNER_TEMP}/gitleaks-${gitleaks_version}"',
    'gitleaks_executable="${gitleaks_root}/gitleaks"',
    'curl --fail --location --proto \'=https\' --tlsv1.2 --silent --show-error --output "$gitleaks_archive" "$gitleaks_url"',
    'printf \'%s  %s\\n\' "$gitleaks_archive_sha256" "$gitleaks_archive" | sha256sum --check',
    'mkdir -p "$gitleaks_root"',
    'tar -xzf "$gitleaks_archive" -C "$gitleaks_root"',
    'printf \'%s  %s\\n\' "$gitleaks_executable_sha256" "$gitleaks_executable" | sha256sum --check',
    `printf '%s  %s\\n' "$gitleaks_config_sha256" '${config.path}' | sha256sum --check`,
    'echo "$gitleaks_root" >> "$GITHUB_PATH"',
    '[[ "$("$gitleaks_executable" version)" == "$gitleaks_version" ]]',
  ].join('\n');
}

function canonicalFoundryInstallBlock(pins) {
  const foundry = pins.phase1Toolchain?.foundry ?? {};
  const distribution = foundry.distributions?.[FOUNDRY_DISTRIBUTION] ?? {};
  return [
    'set -euo pipefail',
    `foundry_version='${foundry.version}'`,
    `foundry_commit='${foundry.commit}'`,
    `foundry_url='${distribution.url}'`,
    `foundry_archive_sha256='${distribution.archiveSha256}'`,
    `foundry_executable_sha256='${distribution.executableSha256}'`,
    'foundry_archive="${RUNNER_TEMP}/foundry_v${foundry_version}_linux_amd64.tar.gz"',
    'foundry_root="${RUNNER_TEMP}/foundry-v${foundry_version}-linux-amd64"',
    'foundry_executable="${foundry_root}/forge"',
    'curl --fail --location --proto \'=https\' --tlsv1.2 --silent --show-error --output "$foundry_archive" "$foundry_url"',
    'printf \'%s  %s\\n\' "$foundry_archive_sha256" "$foundry_archive" | sha256sum --check',
    'mkdir -p "$foundry_root"',
    'tar -xzf "$foundry_archive" -C "$foundry_root"',
    'printf \'%s  %s\\n\' "$foundry_executable_sha256" "$foundry_executable" | sha256sum --check',
    'foundry_version_output="$("$foundry_executable" --version)"',
    '[[ "$foundry_version_output" == *"Version: ${foundry_version}"* ]]',
    '[[ "$foundry_version_output" == *"Commit SHA: ${foundry_commit}"* ]]',
    'echo "$foundry_root" >> "$GITHUB_PATH"',
  ].join('\n');
}

function verifyInstallerDataFlow(pins, workflow, forkProofWorkflow, errors) {
  const nodeBlock = workflowInstallRunBlock(workflow, 'Install pinned Node', errors);
  if (nodeBlock !== null && nodeBlock !== canonicalNodeInstallBlock(pins)) {
    errors.push('Node install block must match the canonical verified data flow');
  }
  const forkProofNodeBlock = workflowInstallRunBlock(forkProofWorkflow, 'Install pinned Node (fork-proof)', errors);
  if (forkProofNodeBlock !== null && forkProofNodeBlock !== canonicalNodeInstallBlock(pins)) {
    errors.push('fork-proof Node install block must match the canonical verified data flow');
  }
  const gitleaksBlock = workflowInstallRunBlock(workflow, 'Install pinned Gitleaks', errors);
  if (gitleaksBlock !== null && gitleaksBlock !== canonicalGitleaksInstallBlock(pins)) {
    errors.push('Gitleaks install block must match the canonical verified data flow');
  }
  const foundryBlock = workflowInstallRunBlock(workflow, 'Install pinned Foundry', errors);
  if (foundryBlock !== null && foundryBlock !== canonicalFoundryInstallBlock(pins)) {
    errors.push('Foundry install block must match the canonical verified data flow');
  }
  const forkProofFoundryBlock = workflowInstallRunBlock(forkProofWorkflow, 'Install pinned Foundry (fork-proof)', errors);
  if (forkProofFoundryBlock !== null && forkProofFoundryBlock !== canonicalFoundryInstallBlock(pins)) {
    errors.push('fork-proof Foundry install block must match the canonical verified data flow');
  }
}

function verifyLocalPhase2Gates(workflow, errors) {
  for (const [stepName, commands] of Object.entries(REQUIRED_LOCAL_PHASE2_GATE_BLOCKS)) {
    const actual = workflowInstallRunBlock(workflow, stepName, errors);
    if (actual !== null && actual !== commands.join('\n')) {
      errors.push(`${stepName} workflow gate must match the canonical local-only command block`);
    }
  }
}

function verifyFoundryManifestAndWorkflow(pins, workflow, errors) {
  const foundry = pins.phase1Toolchain?.foundry ?? {};
  const distributionNames = Object.keys(foundry.distributions ?? {});
  const distribution = foundry.distributions?.[FOUNDRY_DISTRIBUTION] ?? {};

  if (foundry.version !== SUPPORTED_FOUNDRY_VERSION) {
    errors.push(`Foundry version mismatch: expected ${SUPPORTED_FOUNDRY_VERSION}, got ${foundry.version ?? '(missing)'}`);
  }
  if (foundry.commit !== SUPPORTED_FOUNDRY_COMMIT) {
    errors.push('Foundry commit must match the supported release');
  }
  if (distributionNames.length !== 1 || distributionNames[0] !== FOUNDRY_DISTRIBUTION) {
    errors.push(`Foundry distributions must contain only ${FOUNDRY_DISTRIBUTION}`);
  }
  for (const [field, expected] of Object.entries(SUPPORTED_FOUNDRY_DISTRIBUTION)) {
    if (distribution[field] !== expected) {
      const label = field === 'url' ? 'URL' : field === 'archiveSha256' ? 'archive digest' : 'executable digest';
      errors.push(`Foundry distribution ${label} must match the supported release`);
    }
  }

  const workflowValues = {
    version: workflowConstant(workflow, 'foundry_version', errors),
    commit: workflowConstant(workflow, 'foundry_commit', errors),
    url: workflowConstant(workflow, 'foundry_url', errors),
    archiveSha256: workflowConstant(workflow, 'foundry_archive_sha256', errors),
    executableSha256: workflowConstant(workflow, 'foundry_executable_sha256', errors),
  };
  const expectedWorkflowValues = {
    version: foundry.version,
    commit: foundry.commit,
    url: distribution.url,
    archiveSha256: distribution.archiveSha256,
    executableSha256: distribution.executableSha256,
  };
  for (const [field, expected] of Object.entries(expectedWorkflowValues)) {
    if (workflowValues[field] !== null && workflowValues[field] !== expected) {
      errors.push(`Foundry workflow ${field} mismatch`);
    }
  }

  return {
    version: foundry.version ?? null,
    commit: foundry.commit ?? null,
    distribution: FOUNDRY_DISTRIBUTION,
    url: distribution.url ?? null,
    archiveSha256: distribution.archiveSha256 ?? null,
    executableSha256: distribution.executableSha256 ?? null,
    workflow: workflowValues,
  };
}

function verifyNodeManifestAndWorkflow(pins, workflow, errors) {
  const nodeVersion = pins.controlRuntime?.node;
  const distributions = pins.controlRuntime?.distributions ?? {};
  const workflowDistribution = distributions[NODE_WORKFLOW_DISTRIBUTION] ?? {};

  if (nodeVersion !== SUPPORTED_NODE_VERSION) {
    errors.push(`Node version mismatch: expected ${SUPPORTED_NODE_VERSION}, got ${nodeVersion ?? '(missing)'}`);
  }
  const expectedDistributionNames = Object.keys(SUPPORTED_NODE_DISTRIBUTIONS);
  const sortedExpectedDistributionNames = [...expectedDistributionNames].sort();
  const actualDistributionNames = Object.keys(distributions).sort();
  if (actualDistributionNames.length !== sortedExpectedDistributionNames.length
    || actualDistributionNames.some((name, index) => name !== sortedExpectedDistributionNames[index])) {
    errors.push(`Node distributions must contain only ${expectedDistributionNames.join(', ')}`);
  }
  for (const [name, expectedDistribution] of Object.entries(SUPPORTED_NODE_DISTRIBUTIONS)) {
    const distribution = distributions[name] ?? {};
    for (const [field, expected] of Object.entries(expectedDistribution)) {
      if (distribution[field] !== expected) {
        const label = field === 'url' ? 'URL' : field === 'archiveSha256' ? 'archive digest' : 'executable digest';
        errors.push(`Node distribution ${name} ${label} must match the supported release`);
      }
    }
  }

  const workflowValues = {
    version: workflowConstant(workflow, 'node_version', errors),
    url: workflowConstant(workflow, 'node_url', errors),
    archiveSha256: workflowConstant(workflow, 'node_archive_sha256', errors),
    executableSha256: workflowConstant(workflow, 'node_executable_sha256', errors),
  };
  const expectedWorkflowValues = {
    version: nodeVersion,
    url: workflowDistribution.url,
    archiveSha256: workflowDistribution.archiveSha256,
    executableSha256: workflowDistribution.executableSha256,
  };
  const workflowLabels = {
    version: 'version',
    url: 'URL',
    archiveSha256: 'archive digest',
    executableSha256: 'executable digest',
  };
  for (const [field, expected] of Object.entries(expectedWorkflowValues)) {
    if (workflowValues[field] !== null && workflowValues[field] !== expected) {
      errors.push(`Node workflow ${workflowLabels[field]} mismatch`);
    }
  }

  return workflowValues;
}

function verifyWorkflowIntegrity(workflowPath, pins, errors) {
  const workflowPin = pins.contentAddresses?.workflow ?? {};
  const actualSha256 = workflowPath === null ? null : hashFile(workflowPath);

  if (workflowPin.path !== V4_GATES_WORKFLOW_PATH) {
    errors.push(`workflow path must be ${V4_GATES_WORKFLOW_PATH}`);
  }
  if (workflowPin.sha256 !== SUPPORTED_V4_GATES_WORKFLOW_SHA256) {
    errors.push('workflow digest must match the supported release');
  }
  if (actualSha256 !== workflowPin.sha256) {
    errors.push(`workflow digest mismatch: expected ${workflowPin.sha256 ?? '(missing)'}, got ${actualSha256 ?? '(unavailable)'}`);
  }
  if (actualSha256 !== SUPPORTED_V4_GATES_WORKFLOW_SHA256) {
    errors.push('workflow content mismatch: v4-gates.yml must match the supported release');
  }

  return {
    path: V4_GATES_WORKFLOW_PATH,
    expectedSha256: workflowPin.sha256 ?? null,
    actualSha256,
  };
}

function verifyForkProofIntegrity(root, pins, errors) {
  const pin = pins.contentAddresses?.forkProof ?? {};
  const path = join(root, FORK_PROOF_WORKFLOW_PATH);
  let actualSha256 = null;
  try {
    actualSha256 = hashFile(path);
  } catch {
    errors.push('fork-proof workflow could not be read');
  }
  if (pin.path !== FORK_PROOF_WORKFLOW_PATH) {
    errors.push(`fork-proof path must be ${FORK_PROOF_WORKFLOW_PATH}`);
  }
  if (pin.sha256 !== SUPPORTED_FORK_PROOF_WORKFLOW_SHA256) {
    errors.push('fork-proof digest must match the supported release');
  }
  if (actualSha256 !== null && actualSha256 !== pin.sha256) {
    errors.push(`fork-proof digest mismatch: expected ${pin.sha256 ?? '(missing)'}, got ${actualSha256}`);
  }
  if (actualSha256 !== null && actualSha256 !== SUPPORTED_FORK_PROOF_WORKFLOW_SHA256) {
    errors.push('fork-proof content mismatch: workflow must match the supported release');
  }
  return {
    path: FORK_PROOF_WORKFLOW_PATH,
    expectedSha256: pin.sha256 ?? null,
    actualSha256,
  };
}

function verifyForkPinCanaryIntegrity(root, pins, errors) {
  const pin = pins.contentAddresses?.forkPinCanary ?? {};
  const path = join(root, FORK_PIN_CANARY_WORKFLOW_PATH);
  let actualSha256 = null;
  try {
    actualSha256 = hashFile(path);
  } catch {
    errors.push('fork-pin canary workflow could not be read');
  }
  if (pin.path !== FORK_PIN_CANARY_WORKFLOW_PATH) {
    errors.push(`fork-pin canary path must be ${FORK_PIN_CANARY_WORKFLOW_PATH}`);
  }
  if (pin.sha256 !== SUPPORTED_FORK_PIN_CANARY_WORKFLOW_SHA256) {
    errors.push('fork-pin canary digest must match the supported release');
  }
  if (actualSha256 !== null && actualSha256 !== pin.sha256) {
    errors.push(`fork-pin canary digest mismatch: expected ${pin.sha256 ?? '(missing)'}, got ${actualSha256}`);
  }
  if (actualSha256 !== null && actualSha256 !== SUPPORTED_FORK_PIN_CANARY_WORKFLOW_SHA256) {
    errors.push('fork-pin canary content mismatch: workflow must match the supported release');
  }
  return {
    path: FORK_PIN_CANARY_WORKFLOW_PATH,
    expectedSha256: pin.sha256 ?? null,
    actualSha256,
  };
}

function verifyIdentityGateIntegrity(root, pins, errors) {
  const pin = pins.contentAddresses?.identityGate ?? {};
  const path = join(root, IDENTITY_GATE_WORKFLOW_PATH);
  let actualSha256 = null;
  try {
    actualSha256 = hashFile(path);
  } catch {
    errors.push('identity-gate workflow could not be read');
  }
  if (pin.path !== IDENTITY_GATE_WORKFLOW_PATH) {
    errors.push(`identity-gate path must be ${IDENTITY_GATE_WORKFLOW_PATH}`);
  }
  if (pin.sha256 !== SUPPORTED_IDENTITY_GATE_WORKFLOW_SHA256) {
    errors.push('identity-gate digest must match the supported release');
  }
  if (actualSha256 !== null && actualSha256 !== pin.sha256) {
    errors.push(`identity-gate digest mismatch: expected ${pin.sha256 ?? '(missing)'}, got ${actualSha256}`);
  }
  if (actualSha256 !== null && actualSha256 !== SUPPORTED_IDENTITY_GATE_WORKFLOW_SHA256) {
    errors.push('identity-gate content mismatch: workflow must match the supported release');
  }
  return {
    path: IDENTITY_GATE_WORKFLOW_PATH,
    expectedSha256: pin.sha256 ?? null,
    actualSha256,
  };
}

function verifyControlGateIntegrity(root, pins, errors) {
  const pin = pins.contentAddresses?.controlGate ?? {};
  const path = join(root, CONTROL_GATE_WORKFLOW_PATH);
  let actualSha256 = null;
  try {
    actualSha256 = hashFile(path);
  } catch {
    errors.push('control-gate workflow could not be read');
  }
  if (pin.path !== CONTROL_GATE_WORKFLOW_PATH) {
    errors.push(`control-gate path must be ${CONTROL_GATE_WORKFLOW_PATH}`);
  }
  if (pin.sha256 !== SUPPORTED_CONTROL_GATE_WORKFLOW_SHA256) {
    errors.push('control-gate digest must match the supported release');
  }
  if (actualSha256 !== null && actualSha256 !== pin.sha256) {
    errors.push(`control-gate digest mismatch: expected ${pin.sha256 ?? '(missing)'}, got ${actualSha256}`);
  }
  if (actualSha256 !== null && actualSha256 !== SUPPORTED_CONTROL_GATE_WORKFLOW_SHA256) {
    errors.push('control-gate content mismatch: workflow must match the supported release');
  }
  return {
    path: CONTROL_GATE_WORKFLOW_PATH,
    expectedSha256: pin.sha256 ?? null,
    actualSha256,
  };
}

function verifyCommitIdentityAllowlistIntegrity(root, pins, errors) {
  const pin = pins.controlScripts?.commitIdentityAllowlist ?? {};

  if (pin.path !== COMMIT_IDENTITY_ALLOWLIST_PATH) {
    errors.push(`commit-identity allowlist path must be ${COMMIT_IDENTITY_ALLOWLIST_PATH}`);
  }
  if (!SHA256_PATTERN.test(pin.sha256 ?? '')) {
    errors.push('commit-identity allowlist digest must be a SHA-256');
  }
  if (pin.sha256 !== SUPPORTED_COMMIT_IDENTITY_ALLOWLIST_SHA256) {
    errors.push('commit-identity allowlist digest must match the supported release');
  }

  let actualSha256 = null;
  try {
    actualSha256 = hashFile(join(root, COMMIT_IDENTITY_ALLOWLIST_PATH));
  } catch {
    errors.push('commit-identity allowlist script could not be read');
  }
  if (actualSha256 !== null && pin.sha256 && actualSha256 !== pin.sha256) {
    errors.push(
      `commit-identity allowlist digest mismatch: expected ${pin.sha256}, got ${actualSha256}. `
      + 'This script is not covered by the workflow-content pin; a change to its allowlist must be reviewed '
      + 'and re-pinned in product/dependency-pins.json explicitly, or it fails closed.',
    );
  }
  if (actualSha256 !== null && actualSha256 !== SUPPORTED_COMMIT_IDENTITY_ALLOWLIST_SHA256) {
    errors.push('commit-identity allowlist content mismatch: the checker must match the supported release');
  }

  return {
    path: COMMIT_IDENTITY_ALLOWLIST_PATH,
    expectedSha256: pin.sha256 ?? null,
    actualSha256,
  };
}

function forkPinVerifierClosureEntries(pin, errors) {
  const expected = [
    { path: FORK_PIN_VERIFIER_PATH, sha256: SUPPORTED_FORK_PIN_VERIFIER_SHA256 },
    { path: FORK_PIN_VERIFIER_IMPORT_PATH, sha256: SUPPORTED_FORK_PIN_VERIFIER_IMPORT_SHA256 },
  ];
  const closure = pin.closure;
  if (!Array.isArray(closure)) {
    errors.push('fork-pin verifier import closure must be an ordered array');
    return expected.map(entry => ({ ...entry, actualSha256: null }));
  }
  if (closure.length !== expected.length) {
    errors.push('fork-pin verifier import closure must contain the complete supported import set');
  }

  return expected.map((expectedEntry, index) => {
    const candidate = closure[index] ?? {};
    if (candidate.path !== expectedEntry.path) {
      errors.push(`fork-pin verifier import closure entry ${index} must be ${expectedEntry.path}`);
    }
    if (candidate.sha256 !== expectedEntry.sha256) {
      errors.push(`fork-pin verifier import closure ${expectedEntry.path} digest must match the supported release`);
    }
    return {
      ...expectedEntry,
      actualSha256: null,
    };
  });
}

function candidateForkPinVerifierClosureEntries(pin, errors) {
  const expectedPaths = [
    FORK_PIN_VERIFIER_PATH,
    FORK_PIN_VERIFIER_IMPORT_PATH,
  ];
  const closure = pin.closure;
  if (!Array.isArray(closure)) {
    errors.push('candidate fork-pin verifier import closure must be an ordered array');
    return expectedPaths.map(path => ({ path, sha256: null, actualSha256: null }));
  }
  if (closure.length !== expectedPaths.length) {
    errors.push('candidate fork-pin verifier import closure must contain the complete supported import set');
  }

  return expectedPaths.map((expectedPath, index) => {
    const candidate = closure[index] ?? {};
    if (candidate.path !== expectedPath) {
      errors.push(`candidate fork-pin verifier import closure entry ${index} must be ${expectedPath}`);
    }
    if (!SHA256_PATTERN.test(candidate.sha256 ?? '')) {
      errors.push(`candidate fork-pin verifier import closure ${expectedPath} digest must be a SHA-256`);
    }
    return {
      path: expectedPath,
      sha256: candidate.sha256 ?? null,
      actualSha256: null,
    };
  });
}

function controlDependencyVerifierClosureEntries(pin, errors) {
  const expectedPaths = [
    CONTROL_DEPENDENCY_VERIFIER_PATH,
    CONTROL_DEPENDENCY_VERIFIER_IMPORT_PATH,
  ];
  const closure = pin.closure;
  if (!Array.isArray(closure)) {
    errors.push('control dependency verifier import closure must be an ordered array');
    return expectedPaths.map(path => ({ path, sha256: null, actualSha256: null }));
  }
  if (closure.length !== expectedPaths.length) {
    errors.push('control dependency verifier import closure must contain the complete supported import set');
  }

  return expectedPaths.map((expectedPath, index) => {
    const candidate = closure[index] ?? {};
    if (candidate.path !== expectedPath) {
      errors.push(`control dependency verifier import closure entry ${index} must be ${expectedPath}`);
    }
    if (!SHA256_PATTERN.test(candidate.sha256 ?? '')) {
      errors.push(`control dependency verifier import closure ${expectedPath} digest must be a SHA-256`);
    }
    return {
      path: expectedPath,
      sha256: candidate.sha256 ?? null,
      actualSha256: null,
    };
  });
}

function resolveRelativeModulePath(importerPath, specifier) {
  const segments = importerPath.split('/').slice(0, -1);
  for (const segment of specifier.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (segments.length === 0) return null;
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return segments.length === 0 ? null : segments.join('/');
}

function localEsmImports(source, importerPath, label, errors) {
  if (typeof source !== 'string') {
    errors.push(`${label} ${importerPath} source is unavailable`);
    return [];
  }
  const imports = [];
  const staticImport = /^\s*import\s+(?:(?:[\w*$,\s{}]+)\s+from\s+)?(['"])([^'"\r\n]+)\1\s*;?\s*$/gm;
  const staticDeclarations = (source.match(/(?:^|[;\r\n])\s*import\s+(?!\()/g) ?? []).length;
  let parsedStaticDeclarations = 0;
  for (const match of source.matchAll(staticImport)) {
    parsedStaticDeclarations += 1;
    const specifier = match[2];
    if (!specifier.startsWith('.')) {
      if (!specifier.startsWith('node:')) {
        errors.push(`${label} ${importerPath} must not import an unpinned module ${specifier}`);
      }
      continue;
    }
    const path = resolveRelativeModulePath(importerPath, specifier);
    if (!path) {
      errors.push(`${label} ${importerPath} has an invalid relative import ${specifier}`);
      continue;
    }
    imports.push(path);
  }
  if (parsedStaticDeclarations !== staticDeclarations) {
    errors.push(`${label} ${importerPath} has unsupported static import syntax`);
  }
  if (/\bimport\s*\(/.test(source)) {
    errors.push(`${label} ${importerPath} must not use dynamic imports`);
  }
  return [...new Set(imports)].sort();
}

function verifyPinnedImportClosure(closure, sourceByPath, label, errors) {
  const paths = closure.map(entry => entry.path);
  if (paths.length === 0 || new Set(paths).size !== paths.length) {
    errors.push(`${label} must contain unique import paths`);
    return;
  }

  const allowed = new Set(paths);
  const visited = new Set();
  const pending = [paths[0]];
  while (pending.length > 0) {
    const path = pending.pop();
    if (visited.has(path)) continue;
    visited.add(path);
    const imports = localEsmImports(sourceByPath.get(path), path, label, errors);
    for (const importedPath of imports) {
      if (!allowed.has(importedPath)) {
        errors.push(`${label} imports an undeclared local module ${importedPath}`);
        continue;
      }
      pending.push(importedPath);
    }
  }

  for (const path of paths) {
    if (!visited.has(path)) {
      errors.push(`${label} contains an unreachable local module ${path}`);
    }
  }
}

function regularRepositoryFileHash(root, relativePath, label, errors) {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.startsWith('/')
    || relativePath.split('/').some(segment => segment === '' || segment === '.' || segment === '..')) {
    errors.push(`${label} ${relativePath ?? '(missing)'} must be a regular repository file`);
    return null;
  }

  let path = root;
  const segments = relativePath.split('/');
  for (const [index, segment] of segments.entries()) {
    path = join(path, segment);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      errors.push(`${label} ${relativePath} must be a regular repository file`);
      return null;
    }
    if (stat.isSymbolicLink()) {
      errors.push(`${label} ${relativePath} must be a regular repository file, not a symlink`);
      return null;
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      errors.push(`${label} ${relativePath} must be a regular repository file`);
      return null;
    }
    if (index === segments.length - 1 && !stat.isFile()) {
      errors.push(`${label} ${relativePath} must be a regular repository file`);
      return null;
    }
  }

  try {
    return hashFile(path);
  } catch {
    errors.push(`${label} ${relativePath} could not be read`);
    return null;
  }
}

function verifyForkPinVerifierIntegrity(root, pins, errors) {
  const pin = pins.controlScripts?.forkPinVerifier ?? {};

  if (pin.path !== FORK_PIN_VERIFIER_PATH) {
    errors.push(`fork-pin verifier path must be ${FORK_PIN_VERIFIER_PATH}`);
  }
  if (!SHA256_PATTERN.test(pin.sha256 ?? '')) {
    errors.push('fork-pin verifier digest must be a SHA-256');
  }
  if (pin.sha256 !== SUPPORTED_FORK_PIN_VERIFIER_SHA256) {
    errors.push('fork-pin verifier digest must match the supported release');
  }

  const closure = forkPinVerifierClosureEntries(pin, errors);
  const sourceByPath = new Map();
  for (const entry of closure) {
    entry.actualSha256 = regularRepositoryFileHash(root, entry.path, 'fork-pin verifier import closure', errors);
    if (entry.actualSha256 !== null && entry.actualSha256 !== entry.sha256) {
      errors.push(
        `fork-pin verifier import closure ${entry.path} digest mismatch: expected ${entry.sha256}, got ${entry.actualSha256}`,
      );
    }
    if (entry.actualSha256 !== null) {
      try {
        sourceByPath.set(entry.path, readFileSync(join(root, entry.path), 'utf8'));
      } catch {
        errors.push(`fork-pin verifier import closure ${entry.path} source could not be read`);
      }
    }
  }
  verifyPinnedImportClosure(closure, sourceByPath, 'fork-pin verifier import closure', errors);
  const actualSha256 = closure[0]?.actualSha256 ?? null;
  if (actualSha256 !== null && pin.sha256 && actualSha256 !== pin.sha256) {
    errors.push(
      `fork-pin verifier digest mismatch: expected ${pin.sha256}, got ${actualSha256}. `
      + 'The archive-fork verifier must be reviewed and re-pinned explicitly, or it fails closed.',
    );
  }
  if (actualSha256 !== null && actualSha256 !== SUPPORTED_FORK_PIN_VERIFIER_SHA256) {
    errors.push('fork-pin verifier content mismatch: the verifier must match the supported release');
  }

  return {
    path: FORK_PIN_VERIFIER_PATH,
    expectedSha256: pin.sha256 ?? null,
    actualSha256,
    closure,
  };
}

function isSafeVendoredBuilderPath(path) {
  return typeof path === 'string'
    && path.length > 0
    && !isAbsolute(path)
    && !path.split(/[\\/]/).includes('..');
}

function vendoredBuilderSourcePaths(builderRoot, errors) {
  const paths = [];
  function visit(directory, prefix = '') {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    } catch {
      errors.push('release-closure builder source tree is unavailable');
      return;
    }
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        errors.push(`release-closure builder source tree must not contain symlinks: ${path}`);
      } else if (entry.isDirectory()) {
        visit(join(directory, entry.name), path);
      } else if (entry.isFile()) {
        if (path !== 'manifest.json') paths.push(path);
      } else {
        errors.push(`release-closure builder source tree must contain only regular files: ${path}`);
      }
    }
  }
  visit(builderRoot);
  return paths.sort();
}

function verifyReleaseClosureBuilderSourceTree(root, pin, errors) {
  const builderRoot = join(root, 'scripts', 'programmable', 'vendor', 'programmable-v4-hook-builder');
  let manifest;
  try {
    manifest = readJson(join(root, RELEASE_CLOSURE_BUILDER_MANIFEST_PATH));
  } catch {
    return null;
  }
  if (!Array.isArray(manifest?.files) || manifest.files.length === 0) {
    errors.push('release-closure builder source tree manifest must list its files');
    return null;
  }

  const sourceTree = createHash('sha256');
  const declaredPaths = [];
  let previousPath = null;
  for (const entry of manifest.files) {
    if (
      entry === null
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || !isSafeVendoredBuilderPath(entry.path)
      || !Number.isInteger(entry.bytes)
      || entry.bytes < 0
      || typeof entry.sha256 !== 'string'
      || !SHA256_PATTERN.test(entry.sha256)
    ) {
      errors.push('release-closure builder source tree manifest has an invalid file record');
      return null;
    }
    if (previousPath !== null && entry.path <= previousPath) {
      errors.push('release-closure builder source tree manifest records must be uniquely sorted');
      return null;
    }
    previousPath = entry.path;
    declaredPaths.push(entry.path);

    const sourcePath = resolve(builderRoot, entry.path);
    const sourceRelativePath = relative(builderRoot, sourcePath);
    if (sourceRelativePath === '..' || sourceRelativePath.startsWith(`..${sep}`)) {
      errors.push(`release-closure builder source tree path escapes its root: ${entry.path}`);
      return null;
    }
    let stat;
    let bytes;
    try {
      stat = lstatSync(sourcePath);
      if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('not a regular file');
      bytes = readFileSync(sourcePath);
    } catch {
      errors.push(`release-closure builder source tree content mismatch: ${entry.path}`);
      return null;
    }
    if (bytes.byteLength !== entry.bytes || createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
      errors.push(`release-closure builder source tree content mismatch: ${entry.path}`);
      return null;
    }
    sourceTree.update(entry.path);
    sourceTree.update('\0');
    sourceTree.update(bytes);
    sourceTree.update('\0');
  }

  const actualPaths = vendoredBuilderSourcePaths(builderRoot, errors);
  if (
    actualPaths.length !== declaredPaths.length
    || actualPaths.some((path, index) => path !== declaredPaths[index])
  ) {
    errors.push('release-closure builder source tree content mismatch: manifest does not enumerate its files');
    return null;
  }
  const actualSourceTreeSha256 = sourceTree.digest('hex');
  if (actualSourceTreeSha256 !== pin.sourceTreeSha256) {
    errors.push(
      `release-closure builder source tree digest mismatch: expected ${pin.sourceTreeSha256 ?? '(missing)'}, got ${actualSourceTreeSha256}`,
    );
  }
  if (actualSourceTreeSha256 !== SUPPORTED_RELEASE_CLOSURE_BUILDER_SOURCE_TREE_SHA256) {
    errors.push('release-closure builder source tree content mismatch: tree must match the supported release');
  }
  return actualSourceTreeSha256;
}

function verifyReleaseClosureBuilderIntegrity(root, pins, errors) {
  const pin = pins.controlScripts?.releaseClosureBuilder ?? {};
  let actualSha256 = null;

  if (pin.path !== RELEASE_CLOSURE_BUILDER_MANIFEST_PATH) {
    errors.push(`release-closure builder manifest path must be ${RELEASE_CLOSURE_BUILDER_MANIFEST_PATH}`);
  }
  if (pin.sha256 !== SUPPORTED_RELEASE_CLOSURE_BUILDER_MANIFEST_SHA256) {
    errors.push('release-closure builder manifest digest must match the supported release');
  }
  if (pin.sourceTreeSha256 !== SUPPORTED_RELEASE_CLOSURE_BUILDER_SOURCE_TREE_SHA256) {
    errors.push('release-closure builder source tree digest must match the supported release');
  }
  if (pin.entrypoint !== SUPPORTED_RELEASE_CLOSURE_BUILDER_ENTRYPOINT) {
    errors.push(`release-closure builder entrypoint must be ${SUPPORTED_RELEASE_CLOSURE_BUILDER_ENTRYPOINT}`);
  }
  if (!matchesExactObject(pin.upstream, SUPPORTED_RELEASE_CLOSURE_BUILDER_UPSTREAM)) {
    errors.push('release-closure builder upstream provenance must match the supported release');
  }
  try {
    actualSha256 = hashFile(join(root, RELEASE_CLOSURE_BUILDER_MANIFEST_PATH));
  } catch {
    errors.push(`release-closure builder manifest is unavailable at ${RELEASE_CLOSURE_BUILDER_MANIFEST_PATH}`);
  }
  if (actualSha256 !== null && actualSha256 !== pin.sha256) {
    errors.push(
      `release-closure builder manifest digest mismatch: expected ${pin.sha256 ?? '(missing)'}, got ${actualSha256}`,
    );
  }
  if (actualSha256 !== null && actualSha256 !== SUPPORTED_RELEASE_CLOSURE_BUILDER_MANIFEST_SHA256) {
    errors.push('release-closure builder manifest content mismatch: manifest must match the supported release');
  }
  const actualSourceTreeSha256 = verifyReleaseClosureBuilderSourceTree(root, pin, errors);
  return {
    path: RELEASE_CLOSURE_BUILDER_MANIFEST_PATH,
    expectedSha256: pin.sha256 ?? null,
    actualSha256,
    sourceTreeSha256: pin.sourceTreeSha256 ?? null,
    actualSourceTreeSha256,
    entrypoint: pin.entrypoint ?? null,
    upstream: pin.upstream ?? null,
  };
}

function verifyRegularPinnedControlInput(root, pin, expectedPath, label, errors) {
  if (pin.path !== expectedPath) {
    errors.push(`${label} path must be ${expectedPath}`);
  }
  if (!SHA256_PATTERN.test(pin.sha256 ?? '')) {
    errors.push(`${label} digest must be a SHA-256`);
  }
  const actualSha256 = regularRepositoryFileHash(root, expectedPath, label, errors);
  if (actualSha256 !== null && actualSha256 !== pin.sha256) {
    errors.push(`${label} digest mismatch: expected ${pin.sha256 ?? '(missing)'}, got ${actualSha256}`);
  }
  return {
    path: expectedPath,
    expectedSha256: pin.sha256 ?? null,
    actualSha256,
  };
}

function verifyControlDependencyVerifierIntegrity(root, pins, errors) {
  const pin = pins.controlScripts?.controlDependencyVerifier ?? {};
  if (pin.path !== CONTROL_DEPENDENCY_VERIFIER_PATH) {
    errors.push(`control dependency verifier path must be ${CONTROL_DEPENDENCY_VERIFIER_PATH}`);
  }
  if (!SHA256_PATTERN.test(pin.sha256 ?? '')) {
    errors.push('control dependency verifier digest must be a SHA-256');
  }
  const closure = controlDependencyVerifierClosureEntries(pin, errors);
  if (pin.sha256 !== closure[0]?.sha256) {
    errors.push('control dependency verifier entry pin must match the first closure entry');
  }
  const sourceByPath = new Map();
  for (const entry of closure) {
    entry.actualSha256 = regularRepositoryFileHash(root, entry.path, 'control dependency verifier import closure', errors);
    if (entry.actualSha256 !== null && entry.actualSha256 !== entry.sha256) {
      errors.push(
        `control dependency verifier import closure ${entry.path} digest mismatch: expected ${entry.sha256}, got ${entry.actualSha256}`,
      );
    }
    if (entry.actualSha256 !== null) {
      try {
        sourceByPath.set(entry.path, readFileSync(join(root, entry.path), 'utf8'));
      } catch {
        errors.push(`control dependency verifier import closure ${entry.path} source could not be read`);
      }
    }
  }
  verifyPinnedImportClosure(closure, sourceByPath, 'control dependency verifier import closure', errors);
  const actualSha256 = closure[0]?.actualSha256 ?? null;
  if (actualSha256 !== null && pin.sha256 && actualSha256 !== pin.sha256) {
    errors.push(`control dependency verifier digest mismatch: expected ${pin.sha256}, got ${actualSha256}`);
  }
  return {
    path: CONTROL_DEPENDENCY_VERIFIER_PATH,
    expectedSha256: pin.sha256 ?? null,
    actualSha256,
    closure,
  };
}

function verifyArchiveForkProofTestIntegrity(root, pins, errors) {
  return verifyRegularPinnedControlInput(
    root,
    pins.contentAddresses?.archiveForkProofTest ?? {},
    ARCHIVE_FORK_PROOF_TEST_PATH,
    'archive fork proof test',
    errors,
  );
}
function verifyForkPinVerifierWorkflow(workflow, label, pin, errors) {
  const closure = pin.closure;
  const invocation = `node ${FORK_PIN_VERIFIER_PATH}`;
  const invocationIndex = workflow.indexOf(invocation);

  if (!Array.isArray(closure) || invocationIndex === -1) {
    errors.push(`${label} must verify the complete supported fork-pin verifier closure before execution`);
    return;
  }
  for (const entry of closure) {
    const variable = `fork_pin_${entry.path.replaceAll(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')}_sha256`;
    const assignment = `${variable}='${entry.sha256 ?? ''}'`;
    const check = `verify_regular_git_blob '${entry.path}' "$${variable}"`;
    const assignmentIndex = workflow.indexOf(assignment);
    const checkIndex = workflow.indexOf(check);
    if (assignmentIndex === -1 || checkIndex === -1) {
      errors.push(`${label} must verify the supported fork-pin verifier closure before execution`);
      continue;
    }
    if (assignmentIndex > checkIndex || checkIndex > invocationIndex) {
      errors.push(`${label} must verify each fork-pin verifier closure entry before execution`);
    }
  }
}

const CONTROL_PIN_BUMP_SCHEMA = 'hookemon.control-gate-pin-bump.v1';

function controlSurfaceDescriptors(pins, errors, source) {
  const descriptors = [];
  const add = (label, path, pin) => {
    if (pin?.path !== path) {
      errors.push(`${source} ${label} path must be ${path}`);
    }
    if (!SHA256_PATTERN.test(pin?.sha256 ?? '')) {
      errors.push(`${source} ${label} digest must be a SHA-256`);
    }
    descriptors.push({ label, path, sha256: pin?.sha256 ?? null });
  };

  add('v4-gates workflow', V4_GATES_WORKFLOW_PATH, pins.contentAddresses?.workflow);
  add('fork-proof workflow', FORK_PROOF_WORKFLOW_PATH, pins.contentAddresses?.forkProof);
  add('fork-pin canary workflow', FORK_PIN_CANARY_WORKFLOW_PATH, pins.contentAddresses?.forkPinCanary);
  add('identity-gate workflow', IDENTITY_GATE_WORKFLOW_PATH, pins.contentAddresses?.identityGate);
  add('control-gate workflow', CONTROL_GATE_WORKFLOW_PATH, pins.contentAddresses?.controlGate);
  const forkPinVerifier = pins.controlScripts?.forkPinVerifier ?? {};
  const closure = forkPinVerifier.closure;
  if (!Array.isArray(closure) || closure.length !== 2) {
    errors.push(`${source} fork-pin verifier closure must contain exactly two entries`);
  }
  if (forkPinVerifier.path !== FORK_PIN_VERIFIER_PATH || forkPinVerifier.sha256 !== closure?.[0]?.sha256) {
    errors.push(`${source} fork-pin verifier entry pin must match the first closure entry`);
  }
  add('fork-pin verifier', FORK_PIN_VERIFIER_PATH, closure?.[0]);
  add('fork-pin verifier import', FORK_PIN_VERIFIER_IMPORT_PATH, closure?.[1]);
  const controlDependencyVerifier = pins.controlScripts?.controlDependencyVerifier ?? {};
  const controlClosure = controlDependencyVerifierClosureEntries(controlDependencyVerifier, errors);
  if (controlDependencyVerifier.path !== CONTROL_DEPENDENCY_VERIFIER_PATH
      || controlDependencyVerifier.sha256 !== controlClosure[0]?.sha256) {
    errors.push(`${source} control dependency verifier entry pin must match the first closure entry`);
  }
  add('control dependency verifier', CONTROL_DEPENDENCY_VERIFIER_PATH, controlClosure[0]);
  add('control dependency verifier import', CONTROL_DEPENDENCY_VERIFIER_IMPORT_PATH, controlClosure[1]);
  add('archive fork proof test', ARCHIVE_FORK_PROOF_TEST_PATH, pins.contentAddresses?.archiveForkProofTest);
  return descriptors;
}

function descriptorChanges(baseDescriptors, candidateDescriptors) {
  return baseDescriptors
    .map((base, index) => ({ base, candidate: candidateDescriptors[index] }))
    .filter(({ base, candidate }) => candidate?.path !== base.path || candidate?.sha256 !== base.sha256)
    .map(({ base, candidate }) => ({
      path: base.path,
      previousSha256: base.sha256,
      sha256: candidate?.sha256 ?? null,
    }));
}

function orderedControlChanges(changes) {
  return [...changes].sort((left, right) => left.path.localeCompare(right.path));
}

function sameControlChanges(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const sortedActual = orderedControlChanges(actual);
  const sortedExpected = orderedControlChanges(expected);
  return sortedActual.every((entry, index) => (
    entry?.path === sortedExpected[index].path
      && entry?.previousSha256 === sortedExpected[index].previousSha256
      && entry?.sha256 === sortedExpected[index].sha256
  ));
}

function baseCheckerPinBumpErrors({
  candidateVerification,
  baseTree,
  candidateTree,
  basePinsSha256,
  candidatePinsSha256,
  baseCheckerBlob,
  changes,
}) {
  const errors = [];
  const bump = candidateVerification?.controlGatePinBump;
  if (!bump || typeof bump !== 'object' || Array.isArray(bump)) {
    return ['candidate control pins differ from the protected base without a base-checker-approved owner pin bump'];
  }
  if (bump.schema !== CONTROL_PIN_BUMP_SCHEMA) {
    errors.push('control pin bump must use the base-checker schema');
  }
  if (bump.approvalToken !== 'OWNER APPROVED') {
    errors.push('control pin bump requires an explicit OWNER APPROVED token');
  }
  if (bump.baseTree !== baseTree || bump.candidateTree !== candidateTree) {
    errors.push('control pin bump must bind the exact base and candidate trees');
  }
  if (bump.basePinsSha256 !== basePinsSha256 || bump.candidatePinsSha256 !== candidatePinsSha256) {
    errors.push('control pin bump must bind the exact base and candidate dependency-pin bytes');
  }
  if (bump.baseChecker?.path !== CONTROL_DEPENDENCY_VERIFIER_PATH || bump.baseChecker?.blobId !== baseCheckerBlob) {
    errors.push('control pin bump must bind the protected base checker blob');
  }
  if (!sameControlChanges(bump.controls, changes)) {
    errors.push('control pin bump must enumerate the exact control-surface digest changes');
  }
  return errors;
}

function candidateBlob(candidateBlobs, path) {
  return candidateBlobs instanceof Map ? candidateBlobs.get(path) : candidateBlobs?.[path];
}

export function verifyBaseControlSurface({
  basePins,
  candidatePins,
  basePinsSha256,
  candidatePinsSha256,
  baseTree,
  candidateTree,
  baseCheckerBlob,
  candidateBlobs,
  candidateVerification,
}) {
  const errors = [];
  const baseDescriptors = controlSurfaceDescriptors(basePins ?? {}, errors, 'protected base');
  const candidateDescriptors = controlSurfaceDescriptors(candidatePins ?? {}, errors, 'candidate');
  const changes = descriptorChanges(baseDescriptors, candidateDescriptors);

  for (const descriptor of candidateDescriptors) {
    const blob = candidateBlob(candidateBlobs, descriptor.path);
    if (blob?.mode !== '100644' || blob?.type !== 'blob' || !/^[0-9a-f]{40,64}$/.test(blob?.blobId ?? '')) {
      errors.push(`candidate control input ${descriptor.path} must be a regular Git blob`);
      continue;
    }
    if (blob.sha256 !== descriptor.sha256) {
      errors.push(`candidate control input ${descriptor.path} digest does not match its candidate pin`);
    }
  }

  const verifyCandidateClosure = (closure, label) => {
    const sources = new Map(closure.map(entry => [
      entry.path,
      candidateBlob(candidateBlobs, entry.path)?.bytes?.toString('utf8'),
    ]));
    verifyPinnedImportClosure(closure, sources, label, errors);
  };
  verifyCandidateClosure(
    candidateForkPinVerifierClosureEntries(candidatePins?.controlScripts?.forkPinVerifier ?? {}, errors),
    'candidate fork-pin verifier import closure',
  );
  verifyCandidateClosure(
    controlDependencyVerifierClosureEntries(candidatePins?.controlScripts?.controlDependencyVerifier ?? {}, errors),
    'candidate control dependency verifier import closure',
  );

  if (!SHA256_PATTERN.test(basePinsSha256 ?? '') || !SHA256_PATTERN.test(candidatePinsSha256 ?? '')) {
    errors.push('base and candidate dependency-pin bytes must have SHA-256 digests');
  } else if (basePinsSha256 !== candidatePinsSha256) {
    errors.push(...baseCheckerPinBumpErrors({
      candidateVerification,
      baseTree,
      candidateTree,
      basePinsSha256,
      candidatePinsSha256,
      baseCheckerBlob,
      changes,
    }));
  } else if (changes.length > 0) {
    errors.push('candidate control pins differ from the protected base without a dependency-pin byte change');
  }

  return {
    schemaVersion: 1,
    result: errors.length === 0 ? 'PASSED' : 'FAILED',
    errors,
    changes: orderedControlChanges(changes),
  };
}

function gitData(args) {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'buffer',
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: '1' },
  });
}

function gitBlobAtTree(tree, path) {
  const entries = gitData(['ls-tree', '-z', tree, '--', path])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  if (entries.length !== 1) {
    throw new Error(`${path} is missing or ambiguous in candidate tree ${tree}`);
  }
  const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40,64})\t(.+)$/.exec(entries[0]);
  if (!match || match[4] !== path) {
    throw new Error(`${path} has an unsupported Git tree entry`);
  }
  const [, mode, type, blobId] = match;
  const bytes = gitData(['cat-file', 'blob', blobId]);
  return { mode, type, blobId, sha256: sha256(bytes), bytes };
}

function parseCandidateJson(blob, path) {
  try {
    return JSON.parse(blob.bytes.toString('utf8'));
  } catch {
    throw new Error(`${path} must be valid JSON data in the candidate tree`);
  }
}

function controlSurfacePaths() {
  return [
    V4_GATES_WORKFLOW_PATH,
    FORK_PROOF_WORKFLOW_PATH,
    FORK_PIN_CANARY_WORKFLOW_PATH,
    IDENTITY_GATE_WORKFLOW_PATH,
    CONTROL_GATE_WORKFLOW_PATH,
    FORK_PIN_VERIFIER_PATH,
    FORK_PIN_VERIFIER_IMPORT_PATH,
    CONTROL_DEPENDENCY_VERIFIER_PATH,
    CONTROL_DEPENDENCY_VERIFIER_IMPORT_PATH,
    ARCHIVE_FORK_PROOF_TEST_PATH,
  ];
}

export function verifyBaseControlDependencies(rootPath, baseTree, candidateTree) {
  const root = resolve(rootPath);
  const errors = [];
  let basePins;
  let basePinsSha256 = null;
  let baseCheckerBlob = null;
  let candidatePins;
  let candidatePinsSha256 = null;
  let candidateVerification;
  const candidateBlobs = new Map();

  try {
    const bytes = readFileSync(join(root, 'product', 'dependency-pins.json'));
    basePins = JSON.parse(bytes.toString('utf8'));
    basePinsSha256 = sha256(bytes);
    baseCheckerBlob = gitBlobAtTree(baseTree, CONTROL_DEPENDENCY_VERIFIER_PATH).blobId;
    const candidatePinsBlob = gitBlobAtTree(candidateTree, 'product/dependency-pins.json');
    candidatePins = parseCandidateJson(candidatePinsBlob, 'product/dependency-pins.json');
    candidatePinsSha256 = candidatePinsBlob.sha256;
    const candidateVerificationBlob = gitBlobAtTree(candidateTree, 'product/dependency-verification.json');
    candidateVerification = parseCandidateJson(candidateVerificationBlob, 'product/dependency-verification.json');
    for (const path of controlSurfacePaths()) {
      candidateBlobs.set(path, gitBlobAtTree(candidateTree, path));
    }
  } catch (error) {
    errors.push(error.message);
  }

  const report = verifyBaseControlSurface({
    basePins,
    candidatePins,
    basePinsSha256,
    candidatePinsSha256,
    baseTree,
    candidateTree,
    baseCheckerBlob,
    candidateBlobs,
    candidateVerification,
  });
  return {
    ...report,
    errors: [...errors, ...report.errors],
    result: errors.length === 0 && report.result === 'PASSED' ? 'PASSED' : 'FAILED',
    baseTree,
    candidateTree,
  };
}

function verifyGitleaks(root, pins, workflow, errors) {
  const gitleaks = pins.securityTools?.gitleaks ?? {};
  const distributionNames = Object.keys(gitleaks.distributions ?? {});
  const distribution = gitleaks.distributions?.[GITLEAKS_DISTRIBUTION] ?? {};
  const config = gitleaks.config ?? {};

  if (gitleaks.version !== SUPPORTED_GITLEAKS_VERSION) {
    errors.push(`Gitleaks version mismatch: expected ${SUPPORTED_GITLEAKS_VERSION}, got ${gitleaks.version ?? '(missing)'}`);
  }
  if (distributionNames.length !== 1 || distributionNames[0] !== GITLEAKS_DISTRIBUTION) {
    errors.push(`Gitleaks distributions must contain only ${GITLEAKS_DISTRIBUTION}`);
  }
  if (distribution.url !== SUPPORTED_GITLEAKS_URL) {
    errors.push('Gitleaks URL must be the supported HTTPS release');
  }
  if (!SHA256_PATTERN.test(distribution.archiveSha256 ?? '')) {
    errors.push('Gitleaks archive digest must be a SHA-256');
  }
  if (!SHA256_PATTERN.test(distribution.executableSha256 ?? '')) {
    errors.push('Gitleaks executable digest must be a SHA-256');
  }
  if (config.path !== '.gitleaks.toml') {
    errors.push('Gitleaks config path must be .gitleaks.toml');
  }
  if (!SHA256_PATTERN.test(config.sha256 ?? '')) {
    errors.push('Gitleaks config digest must be a SHA-256');
  }

  let configText = null;
  let actualConfigSha256 = null;
  try {
    configText = readFileSync(join(root, config.path), 'utf8');
    actualConfigSha256 = hashFile(join(root, config.path));
  } catch {
    errors.push('Gitleaks config could not be read');
  }
  if (configText !== null && configText !== SUPPORTED_GITLEAKS_CONFIG) {
    errors.push('Gitleaks config must match the supported fail-closed policy');
  }
  if (actualConfigSha256 !== config.sha256) {
    errors.push(`Gitleaks config digest mismatch: expected ${config.sha256 ?? '(missing)'}, got ${actualConfigSha256 ?? '(unavailable)'}`);
  }

  const workflowValues = {
    version: workflowConstant(workflow, 'gitleaks_version', errors),
    url: workflowConstant(workflow, 'gitleaks_url', errors),
    archiveSha256: workflowConstant(workflow, 'gitleaks_archive_sha256', errors),
    executableSha256: workflowConstant(workflow, 'gitleaks_executable_sha256', errors),
    configSha256: workflowConstant(workflow, 'gitleaks_config_sha256', errors),
  };
  const expectedWorkflowValues = {
    version: gitleaks.version,
    url: distribution.url,
    archiveSha256: distribution.archiveSha256,
    executableSha256: distribution.executableSha256,
    configSha256: config.sha256,
  };
  const workflowLabels = {
    version: 'version',
    url: 'URL',
    archiveSha256: 'archive digest',
    executableSha256: 'executable digest',
    configSha256: 'config digest',
  };
  for (const [field, expected] of Object.entries(expectedWorkflowValues)) {
    if (workflowValues[field] !== null && workflowValues[field] !== expected) {
      errors.push(`Gitleaks workflow ${workflowLabels[field]} mismatch`);
    }
  }

  return {
    version: gitleaks.version ?? null,
    distribution: GITLEAKS_DISTRIBUTION,
    url: distribution.url ?? null,
    archiveSha256: distribution.archiveSha256 ?? null,
    executableSha256: distribution.executableSha256 ?? null,
    config: {
      path: config.path ?? null,
      expectedSha256: config.sha256 ?? null,
      actualSha256: actualConfigSha256,
    },
    workflow: workflowValues,
  };
}

function sortedKeys(value) {
  return Object.keys(value ?? {}).sort();
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function verifyAdaptersDependencies(root, pins, errors) {
  const expected = pins.npmDependencies?.adapters ?? {};
  const expectedDependencies = expected.dependencies ?? {};
  const expectedDependencyNames = sortedKeys(expectedDependencies);

  if (expected.packagePath !== ADAPTERS_PACKAGE_PATH) {
    errors.push(`adapters package path must be ${ADAPTERS_PACKAGE_PATH}`);
  }
  if (expected.lockfilePath !== ADAPTERS_LOCKFILE_PATH) {
    errors.push(`adapters lockfile path must be ${ADAPTERS_LOCKFILE_PATH}`);
  }
  for (const [name, version] of Object.entries(expectedDependencies)) {
    if (typeof version !== 'string' || version.length === 0) {
      errors.push(`adapters pinned dependency ${name} must have an exact version string`);
    }
  }

  let packageJson = null;
  try {
    packageJson = readJson(join(root, ADAPTERS_PACKAGE_PATH));
  } catch {
    errors.push('adapters package.json could not be read');
  }
  if (packageJson) {
    if (packageJson.private !== true) errors.push('adapters package.json must be private');
    if (packageJson.type !== 'module') errors.push('adapters package.json must be type module');
    const actualDependencyNames = sortedKeys(packageJson.dependencies);
    if (!sameStringArray(actualDependencyNames, expectedDependencyNames)) {
      errors.push('adapters package.json dependency set does not match the pinned set');
    }
    for (const [name, version] of Object.entries(expectedDependencies)) {
      if (packageJson.dependencies?.[name] !== version) {
        errors.push(`adapters package.json ${name} version must match the pinned version ${version}`);
      }
    }
  }

  let lockfile = null;
  try {
    lockfile = readJson(join(root, ADAPTERS_LOCKFILE_PATH));
  } catch {
    errors.push('adapters package-lock.json could not be read');
  }
  if (lockfile) {
    if (lockfile.lockfileVersion !== 3) {
      errors.push('adapters package-lock.json must be lockfileVersion 3');
    }
    const rootEntry = lockfile.packages?.[''] ?? {};
    const rootDependencyNames = sortedKeys(rootEntry.dependencies);
    if (!sameStringArray(rootDependencyNames, expectedDependencyNames)) {
      errors.push('adapters package-lock.json direct dependency set does not match the pinned set');
    }
    for (const [name, version] of Object.entries(expectedDependencies)) {
      if (rootEntry.dependencies?.[name] !== version) {
        errors.push(`adapters package-lock.json ${name} version must match the pinned version ${version}`);
      }
    }
    const packageEntries = Object.entries(lockfile.packages ?? {}).filter(([key]) => key !== '');
    if (packageEntries.length === 0) {
      errors.push('adapters package-lock.json must contain resolved dependency entries');
    }
    for (const [key, entry] of packageEntries) {
      if (entry.link) continue;
      if (typeof entry.integrity !== 'string' || entry.integrity.length === 0) {
        errors.push(`adapters package-lock.json entry ${key} is missing an integrity field`);
      }
    }
  }

  return {
    packagePath: expected.packagePath ?? null,
    lockfilePath: expected.lockfilePath ?? null,
    dependencies: expectedDependencies,
    lockfileVersion: lockfile?.lockfileVersion ?? null,
    resolvedEntryCount: lockfile ? Object.keys(lockfile.packages ?? {}).length - 1 : null,
  };
}

function workflowFiles(root) {
  const files = [];
  const errors = [];

  function regularDirectory(relativePath) {
    const path = join(root, relativePath);
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      errors.push(`${relativePath} must be a regular repo-internal directory`);
      return null;
    }
    if (stat.isSymbolicLink()) {
      errors.push(`${relativePath} must be a regular repo-internal directory, not a symlink`);
      return null;
    }
    if (!stat.isDirectory()) {
      errors.push(`${relativePath} must be a regular repo-internal directory`);
      return null;
    }
    return path;
  }

  const githubRoot = regularDirectory('.github');
  if (githubRoot === null) return { files, errors, canonicalPath: null };
  const workflowsRoot = regularDirectory('.github/workflows');
  if (workflowsRoot === null) return { files, errors, canonicalPath: null };

  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const workflow = relative(root, path).split(sep).join('/');
      if (entry.isSymbolicLink()) {
        errors.push(`${workflow} must be a regular repo-internal file, not a symlink`);
      } else if (entry.isDirectory()) {
        visit(path);
      } else if (/\.ya?ml$/i.test(entry.name)) {
        if (!entry.isFile()) {
          errors.push(`${workflow} must be a regular repo-internal file`);
          continue;
        }
        files.push(path);
        if (!PERMITTED_WORKFLOW_PATHS.has(workflow)) {
          errors.push(`workflow file is not permitted: ${workflow}`);
        }
      }
    }
  }

  visit(workflowsRoot);
  const canonicalPath = files.find(path => relative(root, path).split(sep).join('/') === V4_GATES_WORKFLOW_PATH) ?? null;
  const forkProofPath = files.find(path => relative(root, path).split(sep).join('/') === FORK_PROOF_WORKFLOW_PATH) ?? null;
  const identityGatePath = files.find(path => relative(root, path).split(sep).join('/') === IDENTITY_GATE_WORKFLOW_PATH) ?? null;
  const controlGatePath = files.find(path => relative(root, path).split(sep).join('/') === CONTROL_GATE_WORKFLOW_PATH) ?? null;
  if (canonicalPath === null && !errors.some(error => error.startsWith(`${V4_GATES_WORKFLOW_PATH} `))) {
    errors.push(`${V4_GATES_WORKFLOW_PATH} must be present`);
  }
  if (forkProofPath === null && !errors.some(error => error.startsWith(`${FORK_PROOF_WORKFLOW_PATH} `))) {
    errors.push(`${FORK_PROOF_WORKFLOW_PATH} must be present`);
  }
  if (identityGatePath === null && !errors.some(error => error.startsWith(`${IDENTITY_GATE_WORKFLOW_PATH} `))) {
    errors.push(`${IDENTITY_GATE_WORKFLOW_PATH} must be present`);
  }
  if (controlGatePath === null && !errors.some(error => error.startsWith(`${CONTROL_GATE_WORKFLOW_PATH} `))) {
    errors.push(`${CONTROL_GATE_WORKFLOW_PATH} must be present`);
  }
  return { files, errors, canonicalPath, forkProofPath, identityGatePath, controlGatePath };
}

function workflowActionInvocations(root, files) {
  const invocations = [];
  const syntaxErrors = [];
  const forbiddenRuntimeKeys = [];
  const canonicalPattern = /^\s*(?:-\s*)?uses\s*:\s*(.*?)\s*$/;
  const usesKeyPattern = /(?:^|[\s{,])(?:"uses"|'uses'|uses)\s*:/g;
  const unsupportedKeyPattern = /(?:^|[{,])\s*(?:-\s*)?(?:(?:"(?:[^"\\]|\\.)*"|'[^']*')\s*:|\?\s|[*&!][^\s:,{}[\]]*\s*:)/;
  const forbiddenRuntimeKeyPattern = /(?:^|[{,])\s*(?:-\s*)?(container|services|image)\s*:/g;

  for (const path of files) {
    const workflow = relative(root, path).split(sep).join('/');
    const text = readFileSync(path, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (unsupportedKeyPattern.test(line)) {
        syntaxErrors.push(`unsupported workflow key syntax in ${workflow}`);
      }
      for (const match of line.matchAll(forbiddenRuntimeKeyPattern)) {
        const key = match[1];
        forbiddenRuntimeKeys.push({ workflow, key });
        syntaxErrors.push(`workflow runtime key ${key} is not permitted in ${workflow}`);
      }
      const usesKeys = [...line.matchAll(usesKeyPattern)];
      if (usesKeys.length === 0) continue;
      const match = line.match(canonicalPattern);
      if (!match || usesKeys.length !== 1) {
        syntaxErrors.push(`unsupported uses syntax in ${workflow}`);
        continue;
      }
      let value = match[1].replace(/\s+#.*$/, '').trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (value.startsWith('./')) {
        syntaxErrors.push(`local actions are not permitted in ${workflow}: ${value}`);
        continue;
      }
      const separator = value.lastIndexOf('@');
      invocations.push({
        workflow,
        action: separator === -1 ? value : value.slice(0, separator),
        ref: separator === -1 ? null : value.slice(separator + 1),
      });
    }
  }

  return { invocations, syntaxErrors, forbiddenRuntimeKeys };
}

export function verifyControlDependencies(rootPath, options = {}) {
  const root = resolve(rootPath);
  const errors = [];
  const pins = readJson(join(root, 'product', 'dependency-pins.json'));
  const runtimeVersion = normalizeNodeVersion(options.runtimeVersion ?? process.version);
  const expectedNode = pins.controlRuntime?.node;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const distribution = `${platform}-${arch}`;
  const expectedNodeDistribution = pins.controlRuntime?.distributions?.[distribution];
  const runtimeExecutablePath = options.runtimeExecutablePath ?? process.execPath;
  const nvmrc = readFileSync(join(root, '.nvmrc'), 'utf8').trim();
  const basePack = pins.contentAddresses?.basePack ?? {};
  const expectedActions = pins.contentAddresses?.githubActions ?? {};
  const workflowSet = workflowFiles(root);
  errors.push(...workflowSet.errors);
  const workflow = workflowSet.canonicalPath === null ? '' : readFileSync(workflowSet.canonicalPath, 'utf8');
  const actionScan = workflowActionInvocations(root, workflowSet.files);
  const actionInvocations = actionScan.invocations;
  let forkProofWorkflow = '';
  try {
    forkProofWorkflow = readFileSync(join(root, FORK_PROOF_WORKFLOW_PATH), 'utf8');
  } catch {
    // The integrity check below records the missing workflow.
  }
  let forkPinCanaryWorkflow = '';
  try {
    forkPinCanaryWorkflow = readFileSync(join(root, FORK_PIN_CANARY_WORKFLOW_PATH), 'utf8');
  } catch {
    // The integrity check below records the missing workflow.
  }

  errors.push(...actionScan.syntaxErrors);
  const workflowIntegrity = verifyWorkflowIntegrity(workflowSet.canonicalPath, pins, errors);
  const forkProof = verifyForkProofIntegrity(root, pins, errors);
  const forkPinCanary = verifyForkPinCanaryIntegrity(root, pins, errors);
  const identityGate = verifyIdentityGateIntegrity(root, pins, errors);
  const controlGate = verifyControlGateIntegrity(root, pins, errors);
  const commitIdentityAllowlist = verifyCommitIdentityAllowlistIntegrity(root, pins, errors);
  const forkPinVerifier = verifyForkPinVerifierIntegrity(root, pins, errors);
  const releaseClosureBuilder = verifyReleaseClosureBuilderIntegrity(root, pins, errors);
  const controlDependencyVerifier = verifyControlDependencyVerifierIntegrity(root, pins, errors);
  const archiveForkProofTest = verifyArchiveForkProofTestIntegrity(root, pins, errors);
  verifyForkPinVerifierWorkflow(forkProofWorkflow, FORK_PROOF_WORKFLOW_PATH, pins.controlScripts?.forkPinVerifier ?? {}, errors);
  verifyForkPinVerifierWorkflow(forkPinCanaryWorkflow, FORK_PIN_CANARY_WORKFLOW_PATH, pins.controlScripts?.forkPinVerifier ?? {}, errors);
  verifyInstallerDataFlow(pins, workflow, forkProofWorkflow, errors);
  verifyLocalPhase2Gates(workflow, errors);
  const nodeWorkflow = verifyNodeManifestAndWorkflow(pins, workflow, errors);
  const foundry = verifyFoundryManifestAndWorkflow(pins, workflow, errors);

  if (runtimeVersion !== expectedNode) {
    errors.push(`Node runtime mismatch: expected ${expectedNode}, got ${runtimeVersion}`);
  }
  if (nvmrc !== expectedNode) {
    errors.push(`Node version file mismatch: expected ${expectedNode}, got ${nvmrc}`);
  }
  if (!expectedNodeDistribution) {
    errors.push(`Node distribution missing for ${distribution}`);
  }

  let actualNodeExecutableSha256 = null;
  try {
    actualNodeExecutableSha256 = options.hashRuntimeExecutable?.(runtimeExecutablePath) ?? hashFile(runtimeExecutablePath);
  } catch {
    errors.push('Node executable could not be hashed');
  }
  if (expectedNodeDistribution && actualNodeExecutableSha256 !== expectedNodeDistribution.executableSha256) {
    errors.push(
      `Node executable digest mismatch: expected ${expectedNodeDistribution.executableSha256}, got ${actualNodeExecutableSha256 ?? '(unavailable)'}`,
    );
  }

  const actualBasePackHash = hashFile(join(root, basePack.path));
  if (actualBasePackHash !== basePack.sha256) {
    errors.push(`base pack digest mismatch: expected ${basePack.sha256}, got ${actualBasePackHash}`);
  }

  const actualActions = Object.fromEntries(Object.keys(expectedActions).map(action => [action, []]));
  for (const [action, expectedSha] of Object.entries(expectedActions)) {
    if (!/^[0-9a-f]{40}$/.test(expectedSha)) {
      errors.push(`${action} expected pin is not an immutable commit SHA: ${expectedSha}`);
    }
  }
  for (const invocation of actionInvocations) {
    const expectedSha = expectedActions[invocation.action];
    if (!expectedSha) {
      errors.push(`unlisted remote action ${invocation.action} in ${invocation.workflow}`);
      continue;
    }
    actualActions[invocation.action].push({ workflow: invocation.workflow, ref: invocation.ref });
    if (invocation.ref !== expectedSha) {
      errors.push(
        `${invocation.action} pin mismatch in ${invocation.workflow}: expected ${expectedSha}, got ${invocation.ref ?? '(missing)'}`,
      );
    }
  }
  for (const [action, expectedSha] of Object.entries(expectedActions)) {
    if (actualActions[action].length === 0) {
      errors.push(`${action} pin mismatch: expected ${expectedSha}, got (missing)`);
    }
  }
  const securityTools = {
    gitleaks: verifyGitleaks(root, pins, workflow, errors),
  };
  const npmDependencies = {
    adapters: verifyAdaptersDependencies(root, pins, errors),
  };

  return {
    schemaVersion: 4,
    result: errors.length === 0 ? 'PASSED' : 'FAILED',
    errors,
    node: {
      expected: expectedNode,
      actual: runtimeVersion,
      versionFile: nvmrc,
      platform,
      arch,
      distribution,
      url: expectedNodeDistribution?.url ?? null,
      archiveSha256: expectedNodeDistribution?.archiveSha256 ?? null,
      expectedExecutableSha256: expectedNodeDistribution?.executableSha256 ?? null,
      actualExecutableSha256: actualNodeExecutableSha256,
      workflow: nodeWorkflow,
    },
    basePack: {
      path: basePack.path,
      expectedSha256: basePack.sha256,
      actualSha256: actualBasePackHash,
    },
    githubActions: actualActions,
    workflowIntegrity,
    forkProof,
    forkPinCanary,
    identityGate,
    controlGate,
    controlScripts: {
      commitIdentityAllowlist,
      forkPinVerifier,
      releaseClosureBuilder,
      controlDependencyVerifier,
    },
    controlInputs: {
      archiveForkProofTest,
    },
    workflowPolicy: {
      forbiddenRuntimeKeys: actionScan.forbiddenRuntimeKeys,
    },
    phase1Toolchain: {
      foundry,
    },
    securityTools,
    npmDependencies,
  };
}

function main() {
  if (process.argv[2] === '--base-control') {
    const [baseTree, candidateTree] = process.argv.slice(3);
    if (!/^[0-9a-f]{40,64}$/.test(baseTree ?? '') || !/^[0-9a-f]{40,64}$/.test(candidateTree ?? '')) {
      console.error('usage: verify-control-dependencies.mjs --base-control <base-tree> <candidate-tree>');
      process.exitCode = 1;
      return;
    }
    const report = verifyBaseControlDependencies(process.cwd(), baseTree, candidateTree);
    console.log(JSON.stringify(report));
    if (report.result !== 'PASSED') process.exitCode = 1;
    return;
  }
  const report = verifyControlDependencies(process.cwd());
  if (process.argv.includes('--write')) {
    writeJson(join(process.cwd(), 'product', 'dependency-verification.json'), report);
  }
  console.log(JSON.stringify(report));
  if (report.result !== 'PASSED') process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
