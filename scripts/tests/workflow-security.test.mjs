import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');
const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'v4-gates.yml'), 'utf8');
const gitleaksConfig = readFileSync(join(repoRoot, '.gitleaks.toml'), 'utf8');
const gitleaksPolicyConsumers = [
  'scripts/verify-control-dependencies.mjs',
  'scripts/tests/control-dependencies.test.mjs',
].map(path => ({ path, text: readFileSync(join(repoRoot, path), 'utf8') }));

function workflowTriggerKeys(source) {
  const start = source.indexOf('on:\n');
  const end = source.indexOf('\npermissions:', start);
  const triggerBlock = start === -1 || end === -1 ? '' : source.slice(start, end);
  return [...triggerBlock.matchAll(/^  ([a-z_]+):/gm)].map(match => match[1]);
}

function inspectMoneyRolesAbi() {
  return JSON.parse(execFileSync(
    'forge',
    ['inspect', 'MoneyRoles', 'abi', '--root', join(repoRoot, 'packages', 'contracts'), '--json'],
    { encoding: 'utf8' },
  ));
}

function functionSignature(entry) {
  return `${entry.name}(${entry.inputs.map(({ type }) => type).join(',')}):${entry.stateMutability}`;
}

function eventShape(entry) {
  return {
    name: entry.name,
    anonymous: entry.anonymous,
    inputs: entry.inputs.map(({ name, type, indexed }) => ({ name, type, indexed })),
  };
}

test('CI targets pull requests and main pushes with bounded runner settings', () => {
  assert.match(workflow, /^on:\s*\n\s+pull_request:\s*\n\s+push:\s*\n\s+branches:\s*\[main\]/m);
  assert.match(workflow, /runs-on:\s*ubuntu-24\.04/);
  assert.match(workflow, /timeout-minutes:\s*\d+/);
  assert.match(workflow, /concurrency:\s*\n(?:.|\n)*?cancel-in-progress:\s*true/);
});

test('CI installs and verifies the pinned official Node distribution without setup-node', () => {
  assert.doesNotMatch(workflow, /actions\/setup-node@/);
  assert.match(workflow, /https:\/\/nodejs\.org\/download\/release\/v24\.19\.0\/node-v24\.19\.0-linux-x64\.tar\.xz/);
  assert.match(workflow, /14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647/);
  assert.match(workflow, /bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12/);
  assert.match(workflow, /sha256sum --check/);
  assert.match(workflow, /node_executable="\$\{node_root\}\/bin\/node"/);
});

test('CI installs and verifies the pinned Gitleaks executable without a remote action', () => {
  assert.doesNotMatch(workflow, /uses:\s*gitleaks\/gitleaks-action@/);
  assert.match(workflow, /https:\/\/github\.com\/gitleaks\/gitleaks\/releases\/download\/v8\.30\.1\/gitleaks_8\.30\.1_linux_x64\.tar\.gz/);
  assert.match(workflow, /551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/);
  assert.match(workflow, /88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509/);
});

test('CI installs the pinned Foundry release and runs the Phase 1 contract proofs', () => {
  assert.doesNotMatch(workflow, /foundry-rs\/foundry-toolchain@/);
  assert.match(workflow, /https:\/\/github\.com\/foundry-rs\/foundry\/releases\/download\/v1\.7\.1\/foundry_v1\.7\.1_linux_amd64\.tar\.gz/);
  assert.match(workflow, /cf7e688ed0c4c48adffca788b496076e31060b67ac5afe1e43dbb5499c20c88b/);
  assert.match(workflow, /4f77da0810de94325734855d0ad58d70640aa8a5b2a837608ddf8c26da34355c/);
  assert.match(workflow, /node --input-type=module --eval/);
  assert.match(workflow, /validateBuildPins\(process\.cwd\(\)\)/);
  assert.match(workflow, /git submodule update --init packages\/contracts\/lib\/v4-core packages\/contracts\/lib\/v4-periphery/);
  assert.match(workflow, /git -C packages\/contracts\/lib\/v4-core submodule update --init --recursive/);
  assert.match(workflow, /git -C packages\/contracts\/lib\/v4-periphery submodule update --init lib\/permit2/);
  assert.match(workflow, /git submodule update --init packages\/contracts\/lib\/liquidity-launcher packages\/contracts\/lib\/uerc20-factory/);
  assert.match(workflow, /FOUNDRY_LIBS='\["lib\/v4-core"\]' forge fmt --check --root packages\/contracts/);
  assert.match(workflow, /FOUNDRY_LIBS='\["lib\/v4-core","lib\/v4-periphery"\]' forge test --root packages\/contracts --match-path 'test\/bindings\/\*\.t\.sol' -vvv/);
  assert.match(workflow, /FOUNDRY_LIBS='\["lib\/v4-core"\]' forge test --root packages\/contracts --match-path 'test\/market\/\*\.t\.sol' -vvv/);
  assert.match(workflow, /node feasibility\/verify-robinhood-binding\.mjs bindings\/robinhood-chain\.json --offline/);
  assert.ok(
    workflow.indexOf('git submodule update --init packages/contracts/lib/v4-core packages/contracts/lib/v4-periphery')
      < workflow.indexOf('node --input-type=module --eval'),
    'top-level Gitlinks must be initialized before validating nested pins',
  );
  assert.ok(
    workflow.indexOf('node --input-type=module --eval')
      < workflow.indexOf('git -C packages/contracts/lib/v4-core submodule update --init --recursive'),
    'build pins must be validated before initializing the dependency closure',
  );
  assert.ok(
    workflow.indexOf('git submodule update --init packages/contracts/lib/liquidity-launcher packages/contracts/lib/uerc20-factory')
      < workflow.indexOf('forge fmt --check --root packages/contracts'),
    'launch dependencies must be initialized before compiling the contracts',
  );
});

test('CI runs the complete local Phase 2 contract suite with FFI and both pinned libraries, excluding only the mandatory archive proof', () => {
  assert.match(
    workflow,
    /FOUNDRY_LIBS='\["lib\/v4-core","lib\/v4-periphery"\]' forge test --root packages\/contracts --ffi -vv --no-match-path 'test\/integration\/RobinhoodV4ArchiveFork\.t\.sol'/,
  );
  assert.match(
    workflow,
    /files="\$\(node scripts\/test-manifest\.mjs list contracts-abi\)"\n\s+FOUNDRY_LIBS='\["lib\/v4-core"\]' node --test --test-timeout=120000 \$files/,
  );
});

test('CI runs the manifest-driven dashboard and contracts-js suites', () => {
  assert.match(workflow, /name: Verify dashboard suite/);
  assert.match(workflow, /files="\$\(node scripts\/test-manifest\.mjs list dashboard\)"\n\s+node --test --test-timeout=120000 \$files/);
  assert.match(workflow, /name: Verify contracts-js suite/);
  assert.match(workflow, /files="\$\(node scripts\/test-manifest\.mjs list contracts-js\)"\n\s+node --test --test-timeout=120000 \$files/);
  assert.match(workflow, /name: Verify scripts suite/);
  assert.match(workflow, /files="\$\(node scripts\/test-manifest\.mjs list scripts\)"\n\s+node --test --test-timeout=120000 \$files/);
  assert.match(workflow, /name: Verify the test manifest covers every test file\n\s+run: node scripts\/test-manifest\.mjs check/);
});

test('fork-proof runs only after a main push or a manual main dispatch and fails closed without its endpoint', () => {
  const forkProofPath = join(repoRoot, '.github', 'workflows', 'fork-proof.yml');
  assert.equal(existsSync(forkProofPath), true, 'fork-proof must be a separate workflow so pull requests do not create a skipped job');
  if (!existsSync(forkProofPath)) return;
  const forkProof = readFileSync(forkProofPath, 'utf8');

  assert.deepEqual(workflowTriggerKeys(forkProof), ['push', 'workflow_dispatch']);
  assert.match(forkProof, /^  push:\n    branches: \[main\]$/m);
  assert.doesNotMatch(forkProof, /^  pull_request:/m);
  assert.doesNotMatch(workflow, /^ {2}fork-proof:$/m);
  assert.match(forkProof, /^  fork-proof:\n    environment: fork-proof$/m);
  assert.doesNotMatch(forkProof, /^    if:/m, 'a non-main manual dispatch must fail instead of creating a skipped proof job');
  assert.match(forkProof, /name: Require main branch/);
  assert.match(forkProof, /\[\[ "\$GITHUB_REF" == 'refs\/heads\/main' \]\]/);
  assert.match(forkProof, /name: Run the mandatory archive fork proof/);
  assert.match(forkProof, /ROBINHOOD_FORK_RPC_URL: \$\{\{ secrets\.ROBINHOOD_FORK_RPC_URL \}\}/);
  assert.match(forkProof, /ROBINHOOD_FORK_PINNED: 'true'/);
  assert.match(forkProof, /if \[\[ -z "\$\{ROBINHOOD_FORK_RPC_URL:-\}" \]\]; then\n\s+echo "ROBINHOOD_FORK_RPC_URL is required for the mandatory archive fork proof\." >&2\n\s+exit 1/);
  assert.match(
    forkProof,
    /FOUNDRY_LIBS='\["lib\/v4-core","lib\/v4-periphery"\]' forge test --root packages\/contracts -vv --match-path 'test\/integration\/RobinhoodV4ArchiveFork\.t\.sol'/,
  );
  assert.match(forkProof, /node scripts\/verify-fork-pin\.mjs/);
  assert.ok(
    forkProof.indexOf('node scripts/verify-fork-pin.mjs')
      < forkProof.indexOf("forge test --root packages/contracts -vv --match-path 'test/integration/RobinhoodV4ArchiveFork.t.sol'"),
    'the archive pin must validate before Forge contacts the fork endpoint',
  );
  assert.doesNotMatch(forkProof, /--ffi|EVENT_NAME|skipping the archive fork proof|continue-on-error/);
});

test('fork jobs verify the supported fork-pin verifier digest before execution', () => {
  const pins = JSON.parse(readFileSync(join(repoRoot, 'product', 'dependency-pins.json'), 'utf8'));
  const verifier = pins.controlScripts?.forkPinVerifier;
  const archiveForkProof = pins.contentAddresses?.archiveForkProofTest;
  const canary = readFileSync(join(repoRoot, '.github', 'workflows', 'fork-pin-canary.yml'), 'utf8');
  const forkProofPath = join(repoRoot, '.github', 'workflows', 'fork-proof.yml');
  assert.equal(existsSync(forkProofPath), true, 'fork-proof workflow must exist');
  if (!existsSync(forkProofPath)) return;
  const forkProof = readFileSync(forkProofPath, 'utf8');

  assert.deepEqual(verifier.path, 'scripts/verify-fork-pin.mjs');
  assert.match(verifier.sha256, /^[0-9a-f]{64}$/);
  assert.ok(Array.isArray(verifier.closure), 'the complete verifier import closure must be pinned');
  if (!Array.isArray(verifier.closure)) return;
  assert.deepEqual(verifier.closure.map(entry => entry.path), [
    'scripts/verify-fork-pin.mjs',
    'scripts/programmable/lib/keccak.mjs',
  ]);
  const command = `node ${verifier.path}`;
  for (const source of [forkProof, canary]) {
    assert.ok(source.indexOf('verify_regular_git_blob') !== -1, 'workflow must reject symlinks and non-blob verifier inputs');
    for (const entry of verifier.closure) {
      const assignment = `fork_pin_${entry.path.replaceAll(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')}_sha256='${entry.sha256}'`;
      const check = `verify_regular_git_blob '${entry.path}' "$${assignment.slice(0, assignment.indexOf('='))}"`;
      assert.ok(source.indexOf(assignment) !== -1, `workflow must pin ${entry.path}`);
      assert.ok(source.indexOf(check) !== -1, `workflow must verify ${entry.path} as a tracked regular blob`);
      assert.ok(source.indexOf(check) < source.indexOf(command));
    }
  }
  assert.deepEqual(archiveForkProof.path, 'packages/contracts/test/integration/RobinhoodV4ArchiveFork.t.sol');
  assert.match(archiveForkProof.sha256, /^[0-9a-f]{64}$/);
  const archiveVariable = `fork_pin_${archiveForkProof.path.replaceAll(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '')}_sha256`;
  const archiveAssignment = `${archiveVariable}='${archiveForkProof.sha256}'`;
  const archiveCheck = `verify_regular_git_blob '${archiveForkProof.path}' "$${archiveVariable}"`;
  const archiveForge = "forge test --root packages/contracts -vv --match-path 'test/integration/RobinhoodV4ArchiveFork.t.sol'";
  assert.ok(forkProof.indexOf(archiveAssignment) !== -1, 'fork-proof must pin the archive test blob');
  assert.ok(forkProof.indexOf(archiveCheck) !== -1, 'fork-proof must verify the archive test as a tracked regular blob');
  assert.ok(forkProof.indexOf(archiveCheck) < forkProof.indexOf(archiveForge));
});

test('control gate checks candidate control inputs as data with base-defined code only', () => {
  const controlPath = join(repoRoot, '.github', 'workflows', 'control-gate.yml');
  assert.equal(existsSync(controlPath), true, 'control-gate.yml must exist on the protected base branch');
  if (!existsSync(controlPath)) return;
  const control = readFileSync(controlPath, 'utf8');

  assert.match(control, /^on:\s*\n\s+pull_request_target:/m);
  assert.match(control, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(control, /git show "\$\{range_base\}:scripts\/verify-control-dependencies\.mjs"/);
  assert.match(control, /git show "\$\{range_base\}:scripts\/lib\/util\.mjs"/);
  assert.match(control, /--base-control "\$range_base" "\$range_head"/);
  assert.doesNotMatch(control, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.doesNotMatch(control, /node scripts\//);
  assert.doesNotMatch(control, /npm\s/);
  assert.doesNotMatch(control, /git checkout --detach "\$range_head"/);
});

test('identity gate checks out the trusted base and executes no pull-request source', () => {
  const identityWorkflow = readFileSync(join(repoRoot, '.github', 'workflows', 'identity-gate.yml'), 'utf8');

  assert.match(identityWorkflow, /^on:\s*\n\s+pull_request_target:/m);
  assert.match(identityWorkflow, /ref: \$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(identityWorkflow, /GIT_NO_REPLACE_OBJECTS: '1'/);
  assert.match(identityWorkflow, /git fetch --no-tags origin "\+refs\/pull\/\$\{PR_NUMBER\}\/head:refs\/remotes\/origin\/pull\/\$\{PR_NUMBER\}\/head"/);
  assert.match(identityWorkflow, /git merge-base "\$PUSH_BASE_SHA" "\$PUSH_HEAD_SHA"/);
  assert.match(identityWorkflow, /git checkout --detach "\$range_base"/);
  assert.match(identityWorkflow, /git show "\$\{range_base\}:scripts\/check-commit-identity\.mjs"/);
  assert.doesNotMatch(identityWorkflow, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.doesNotMatch(identityWorkflow, /node scripts\/check-commit-identity\.mjs/);
});

test('the canary permits only the default branch and fails closed when its endpoint is absent', () => {
  const canaryPath = join(repoRoot, '.github', 'workflows', 'fork-pin-canary.yml');
  const canary = readFileSync(canaryPath, 'utf8');

  assert.doesNotMatch(canary, /\n\s*pull_request:\s*\n/);
  assert.doesNotMatch(canary, /\n\s*push:\s*\n/);
  assert.match(canary, /schedule:\s*\n\s*-\s*cron:/);
  assert.match(canary, /workflow_dispatch:/);
  assert.match(canary, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(canary, /^  canary:\n    environment: fork-proof$/m);
  assert.match(canary, /name: Require default branch/);
  assert.match(canary, /\[\[ "\$GITHUB_REF" == 'refs\/heads\/main' \]\]/);
  assert.match(canary, /canary only runs from refs\/heads\/main/);
  assert.match(canary, /uses: actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/);
  assert.match(canary, /ROBINHOOD_FORK_RPC_URL: \$\{\{ secrets\.ROBINHOOD_FORK_RPC_URL \}\}/);
  assert.match(canary, /node scripts\/verify-fork-pin\.mjs/);
  assert.match(canary, /::error::fork-pin-canary observed drift/);
  assert.match(canary, /ROBINHOOD_FORK_RPC_URL is required for the current-head canary\./);
  assert.doesNotMatch(canary, /nothing to observe yet|exit 0/);
});

test('MoneyRoles exposes exactly five frozen functions and two frozen events', () => {
  const abi = inspectMoneyRolesAbi();
  const functions = abi.filter(({ type }) => type === 'function');
  const events = abi.filter(({ type }) => type === 'event');

  assert.deepEqual(functions.map(functionSignature).sort(), [
    'acceptOperations():nonpayable',
    'acceptTreasury():nonpayable',
    'proposeOperations(address):nonpayable',
    'proposeTreasury(address):nonpayable',
    'readRoles(bytes32):view',
  ]);
  assert.deepEqual(events.map(eventShape).sort((left, right) => left.name.localeCompare(right.name)), [
    {
      name: 'RoleAccepted',
      anonymous: false,
      inputs: [
        { name: 'role', type: 'bytes32', indexed: true },
        { name: 'previousAccount', type: 'address', indexed: true },
        { name: 'currentAccount', type: 'address', indexed: true },
      ],
    },
    {
      name: 'RoleProposed',
      anonymous: false,
      inputs: [
        { name: 'role', type: 'bytes32', indexed: true },
        { name: 'currentAccount', type: 'address', indexed: true },
        { name: 'proposedAccount', type: 'address', indexed: true },
      ],
    },
  ]);
  assert.equal(abi.some(({ type }) => type === 'fallback' || type === 'receive'), false);
});

test('MoneyRoles readRoles exposes the frozen role-control records', () => {
  const readRoles = inspectMoneyRolesAbi().find(({ type, name }) => type === 'function' && name === 'readRoles');

  assert.deepEqual(readRoles.outputs.map(({ name, internalType, components }) => ({
    name,
    internalType,
    components: components.map(({ name: componentName, type }) => ({
      name: componentName,
      type,
    })),
  })), [
    {
      name: 'roles',
      internalType: 'struct MoneyRoles.RoleState',
      components: [
        { name: 'programmableBeneficiary', type: 'address' },
        { name: 'treasury', type: 'address' },
        { name: 'operations', type: 'address' },
      ],
    },
    {
      name: 'treasuryTransfer',
      internalType: 'struct MoneyRoles.PendingRoleTransfer',
      components: [
        { name: 'role', type: 'bytes32' },
        { name: 'currentAccount', type: 'address' },
        { name: 'proposedAccount', type: 'address' },
      ],
    },
    {
      name: 'operationsTransfer',
      internalType: 'struct MoneyRoles.PendingRoleTransfer',
      components: [
        { name: 'role', type: 'bytes32' },
        { name: 'currentAccount', type: 'address' },
        { name: 'proposedAccount', type: 'address' },
      ],
    },
    {
      name: 'cycle',
      internalType: 'struct MoneyRoles.CycleBoundOperations',
      components: [
        { name: 'cycleId', type: 'bytes32' },
        { name: 'operations', type: 'address' },
      ],
    },
  ]);
});

test('CI runs the Phase 1 runner and delivery-boundary proofs', () => {
  assert.match(workflow, /node scripts\/check-delivery-boundary\.mjs/);
  assert.match(workflow, /files="\$\(node scripts\/test-manifest\.mjs list runner\)"\n\s+node --test --test-timeout=120000 \$files/);
  assert.match(workflow, /node packages\/runner\/src\/cycle\/verify-fixtures\.mjs/);
});

test('Gitleaks limits generic-api-key exceptions to known receipt hashes and the model label', () => {
  const allowedReceiptHashes = [
    'fe20fd72714625746bd59c7c1d14341496e2bad92ea36bba924cbe11c2c1d95a',
    '4cc79b69d493302b87044e768688b591fbc8418b538b884f3bc73de22480d1a2',
    '6a99552ea4f401525dda218ca7f6f0d29ba9b21e1bf37491f260932a68bb38f8',
    '308c53154bb2bae575a005f66270a21dbfb6ded485f313d03f108d8e63dc49ca',
    '99b4318705f44c944268cd2bba928c338c4cf1a18f4e737640c6250618f2246f',
  ];

  assert.equal((gitleaksConfig.match(/^\[\[rules\]\]$/gm) ?? []).length, 1);
  assert.equal((gitleaksConfig.match(/^\[\[rules\.allowlists\]\]$/gm) ?? []).length, 5);
  assert.equal((gitleaksConfig.match(/^regexTarget = "secret"$/gm) ?? []).length, 3);
  assert.match(gitleaksConfig, /packages\/adapters\/test\/fixtures\/collector-crypt\/pack-status\\\.json/);
  assert.match(gitleaksConfig, /packages\/adapters\/test\/robinhood-rpc\\\.test\\\.mjs/);
  assert.match(gitleaksConfig, /docs\/modules\/collector-crypt-adapter\\\.md/);
  assert.match(gitleaksConfig, /^id = "generic-api-key"$/m);
  assert.match(gitleaksConfig, /^condition = "AND"$/m);
  assert.match(gitleaksConfig, /receipts\/r-\[0-9\]\{5\}\\\.json/);
  assert.match(gitleaksConfig, /ADR-0002-launchpad-token-issuance/);
  assert.match(gitleaksConfig, /docs\/modules\/token-core/);
  for (const hash of allowedReceiptHashes) assert.match(gitleaksConfig, new RegExp(hash));
  assert.doesNotMatch(gitleaksConfig, /\[0-9a-f\]\{64\}/);
  assert.doesNotMatch(gitleaksConfig, /r-\d{5}\|r-/);
  assert.match(gitleaksConfig, /feasibility\/model\\\.mjs/);
  assert.match(gitleaksConfig, /tokenOrder: usdgIsCurrency0/);
  assert.doesNotMatch(gitleaksConfig, /^\[\[allowlists\]\]$/m);
});

test('Gitleaks policy constants do not reproduce the permitted token-order match in tracked source', () => {
  for (const { path, text } of gitleaksPolicyConsumers) {
    assert.doesNotMatch(text, /^regexes = .*tokenOrder: usdgIsCurrency0.*$/m, path);
  }
});

test('CI permits only the pinned checkout remote action, once per job', () => {
  const actions = [...workflow.matchAll(/^\s*(?:-\s+)?uses:\s+([^\s#]+)/gm)].map(match => match[1]);
  assert.ok(actions.length >= 1);
  assert.ok(actions.every(action => action === 'actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803'));
  assert.match(workflow, /fetch-depth:\s*0/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.doesNotMatch(workflow, /actions\/cache|api\.github\.com/i);
});

test('v4 gates keeps explicit pull-request and push ranges for append-only and secret scans', () => {
  assert.match(workflow, /PR_BASE_SHA:\s*\$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(workflow, /PR_HEAD_SHA:\s*\$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(workflow, /PUSH_BASE_SHA:\s*\$\{\{ github\.event\.before \}\}/);
  assert.match(workflow, /PUSH_HEAD_SHA:\s*\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /name: Transitional base commit identity check/);
  assert.match(workflow, /git show "\$\{range_base\}:scripts\/check-commit-identity\.mjs"/);
  assert.match(workflow, /Remove this step only after the owner registers identity-gate and control-gate as required statuses on main\./);
  assert.match(workflow, /node scripts\/check-append-only\.mjs "\$range_base" "\$range_head"/);
  assert.match(workflow, /append_only_options=\(\)/);
  assert.match(workflow, /append_only_options=\(--require-ancestor\)/);
  assert.match(workflow, /"\$\{append_only_options\[@\]\}"/);
});

test('CI verifies the Phase 3 launch package in draft mode and checks release-package closure', () => {
  assert.match(workflow, /node scripts\/programmable\/verify-launch-package\.mjs --allow-unverified/);
  assert.match(workflow, /node scripts\/verify-release-package-closure\.mjs/);
});

test('fork-proof recovery and the control-supply-chain card document the protected environment and release verifiers', () => {
  const runbook = readFileSync(join(repoRoot, 'docs', 'runbooks', 'ci-fork-proof.md'), 'utf8');
  const index = readFileSync(join(repoRoot, 'docs', 'runbooks', 'README.md'), 'utf8');
  const card = readFileSync(join(repoRoot, 'docs', 'modules', 'control-supply-chain.md'), 'utf8');

  assert.match(index, /\[Fork proof\]\(ci-fork-proof\.md\)/);
  assert.match(runbook, /GitHub Environment `fork-proof`/);
  assert.match(runbook, /ROBINHOOD_FORK_RPC_URL/);
  assert.match(runbook, /Selected branches and tags/);
  assert.match(runbook, /Pull requests require `control-gate`, `identity-gate`, and `gates`\./);
  assert.match(runbook, /Main requires `control-gate`, `identity-gate`, `gates`, and `fork-proof`\./);
  assert.match(runbook, /ROBINHOOD_FORK_PINNED=true node scripts\/verify-fork-pin\.mjs/);
  assert.match(runbook, /ROBINHOOD_FORK_PINNED=true FOUNDRY_LIBS=/);
  assert.doesNotMatch(runbook, /required reviewer/i);
  assert.match(card, /\.github\/workflows\/v4-gates\.yml/);
  assert.match(card, /\.github\/workflows\/fork-proof\.yml/);
  assert.match(card, /\.github\/workflows\/fork-pin-canary\.yml/);
  assert.match(card, /\.github\/workflows\/identity-gate\.yml/);
  assert.match(card, /Pull requests require `control-gate`, `identity-gate`, and `gates`\./);
  assert.match(card, /Main requires `control-gate`, `identity-gate`, `gates`, and `fork-proof`\./);
  assert.match(card, /ROBINHOOD_FORK_PINNED=true node scripts\/verify-fork-pin\.mjs/);
  assert.doesNotMatch(card, /required reviewer/i);
  assert.match(card, /verify-launch-package\.mjs --allow-unverified/);
  assert.match(card, /node scripts\/test-manifest\.mjs check/);
  assert.match(card, /node scripts\/verify-release-ready\.mjs/);
  assert.match(card, /scripts\/check-commit-identity\.mjs/);
  assert.match(card, /fork-pin verifier/);
  assert.match(card, /verify-release-package-closure\.mjs/);
});

test('CI scans the tracked tree and complete explicit range with hardened Gitleaks settings', () => {
  assert.match(workflow, /git archive HEAD/);
  assert.match(workflow, /gitleaks dir/);
  assert.match(workflow, /gitleaks git/);
  assert.match(workflow, /--log-opts="--full-history -m --text --no-textconv \$range_base\.\.\$range_head"/);
  assert.doesNotMatch(workflow, /--first-parent|--no-merges/);
  assert.ok((workflow.match(/--ignore-gitleaks-allow/g) ?? []).length >= 3);
  assert.ok((workflow.match(/--gitleaks-ignore-path/g) ?? []).length >= 3);
});

test('CI proves the hardened scanner rejects a synthetic inline-allowed secret', () => {
  assert.match(workflow, /synthetic negative control/i);
  assert.match(workflow, /gitleaks:allow/);
  assert.match(workflow, /receipts\/r-99999\.json/);
  assert.match(workflow, /service_token/);
  assert.match(workflow, /docs\/modules\/token-core\.md/);
  assert.match(workflow, /RuleID === "github-pat"/);
  assert.match(workflow, /RuleID === "generic-api-key"/);
  assert.match(workflow, /finding\.StartLine === 3/);
  assert.match(workflow, /negative_status/);
});
