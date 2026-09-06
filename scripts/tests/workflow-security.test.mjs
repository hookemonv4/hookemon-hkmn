import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { interfaceFreezeInputDigest } from '../../feasibility/verify-robinhood-binding.mjs';

const repoRoot = join(import.meta.dirname, '..', '..');
const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'v4-gates.yml'), 'utf8');
const launchGateWorkflow = readFileSync(join(repoRoot, '.github', 'workflows', 'launch-gate.yml'), 'utf8');
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
  assert.match(workflow, /git -C packages\/contracts\/lib\/uerc20-factory submodule update --init lib\/solady lib\/openzeppelin-contracts/);
  assert.match(workflow, /FOUNDRY_LIBS='\["lib\/v4-core"\]' forge fmt --check --root packages\/contracts/);
  assert.match(workflow, /FOUNDRY_LIBS='\["lib\/v4-core","lib\/v4-periphery"\]' forge test --root packages\/contracts --match-path 'test\/bindings\/\*\.t\.sol' -vvv/);
  assert.match(workflow, /FOUNDRY_LIBS='\["lib\/v4-core"\]' forge test --root packages\/contracts --match-path 'test\/market\/\*\.t\.sol' -vvv/);
  assert.match(workflow, /node feasibility\/verify-robinhood-binding\.mjs bindings\/robinhood-chain\.json --offline/);
  assert.ok(
    workflow.indexOf('git submodule update --init packages/contracts/lib/v4-core packages/contracts/lib/v4-periphery')
      < workflow.indexOf('git -C packages/contracts/lib/v4-core submodule update --init --recursive'),
    'top-level v4 Gitlinks must be initialized before the v4 nested closure',
  );
  assert.ok(
    workflow.indexOf('git -C packages/contracts/lib/v4-core submodule update --init --recursive')
      < workflow.indexOf('git submodule update --init packages/contracts/lib/liquidity-launcher packages/contracts/lib/uerc20-factory'),
    'the v4 nested closure must be initialized before the top-level launch Gitlinks',
  );
  assert.ok(
    workflow.indexOf('git submodule update --init packages/contracts/lib/liquidity-launcher packages/contracts/lib/uerc20-factory')
      < workflow.indexOf('git -C packages/contracts/lib/uerc20-factory submodule update --init lib/solady lib/openzeppelin-contracts'),
    'uerc20-factory must be initialized before its nested compile dependencies',
  );
  assert.ok(
    workflow.indexOf('git -C packages/contracts/lib/uerc20-factory submodule update --init lib/solady lib/openzeppelin-contracts')
      < workflow.indexOf('node --input-type=module --eval'),
    'all four pinned dependency init stages must complete before validateBuildPins reads any Gitlink OID',
  );
  assert.ok(
    workflow.indexOf('node --input-type=module --eval')
      < workflow.indexOf('forge fmt --check --root packages/contracts'),
    'build pins must be validated before compiling the contracts',
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
  assert.match(
    workflow,
    /files="\$\(node scripts\/test-manifest\.mjs list scripts\)"\n\s+heavy_files=\(\n(?:\s+scripts\/tests\/[a-z0-9-]+\.test\.mjs\n){2}\s*\)\n\s+isolated_files=\(\n\s+scripts\/tests\/phase3-bytecode-binding\.test\.mjs\n\s*\)\n[\s\S]*?\n\s+node --test --test-timeout=120000 \$remaining_files/,
  );
  assert.match(workflow, /name: Verify the test manifest covers every test file\n\s+run: node scripts\/test-manifest\.mjs check/);
});

test('CI isolates the Phase 3 bytecode-binding test in its own required job with a fail-closed dependency from gates', () => {
  assert.match(workflow, /^ {2}phase3-bytecode:\n {4}runs-on: ubuntu-24\.04\n {4}timeout-minutes: 45\n/m);
  assert.match(
    workflow,
    /^ {2}gates:\n {4}needs: \[phase3-bytecode\]\n {4}if: \$\{\{ always\(\) \}\}\n {4}runs-on: ubuntu-24\.04\n {4}timeout-minutes: 45\n/m,
  );
  const requireStep = [
    '      - name: Require the isolated Phase 3 bytecode job to succeed',
    '        shell: bash',
    '        env:',
    '          PHASE3_BYTECODE_RESULT: ${{ needs.phase3-bytecode.result }}',
    '        run: |',
    '          echo "phase3-bytecode job result: $PHASE3_BYTECODE_RESULT"',
    '          [ "$PHASE3_BYTECODE_RESULT" = "success" ]',
  ].join('\n');
  assert.ok(
    workflow.includes(requireStep),
    'gates must fail closed on its very first step unless the isolated phase3-bytecode job result is exactly success',
  );
  const gatesIndex = workflow.indexOf('\n  gates:\n');
  const requireIndex = workflow.indexOf(requireStep);
  const firstCheckoutInGates = workflow.indexOf('actions/checkout', gatesIndex);
  assert.ok(gatesIndex !== -1 && requireIndex > gatesIndex, 'the fail-closed step must belong to the gates job');
  assert.ok(
    requireIndex < firstCheckoutInGates,
    'the fail-closed dependency check must be the earliest step in gates, before any checkout',
  );
  assert.match(
    workflow,
    /name: Verify Phase 3 bytecode binding\n {8}run: node --test --test-timeout=120000 scripts\/tests\/phase3-bytecode-binding\.test\.mjs/,
  );
  // The isolated job must reuse the identical pinned checkout action, Node, and Foundry
  // versions as gates, not a drifted or unpinned copy.
  const checkoutPin = 'uses: actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803';
  assert.equal(workflow.split(checkoutPin).length - 1, 2, 'both jobs must use the identical pinned checkout action');
  assert.match(workflow, /name: Install pinned Node \(phase3-bytecode\)/);
  assert.match(workflow, /name: Install pinned Foundry \(phase3-bytecode\)/);
  assert.match(workflow, /node_version='24\.19\.0'[\s\S]*?node_version='24\.19\.0'/);
  assert.match(workflow, /foundry_version='1\.7\.1'[\s\S]*?foundry_version='1\.7\.1'/);
});

test('fork-proof runs the same read-only archive proof for a main push, a manual main dispatch, and a pull request head, and fails closed without its endpoint', () => {
  const forkProofPath = join(repoRoot, '.github', 'workflows', 'fork-proof.yml');
  assert.equal(existsSync(forkProofPath), true, 'fork-proof must be a separate workflow so other pull requests do not create a skipped job');
  if (!existsSync(forkProofPath)) return;
  const forkProof = readFileSync(forkProofPath, 'utf8');

  assert.deepEqual(workflowTriggerKeys(forkProof), ['push', 'pull_request', 'workflow_dispatch']);
  assert.match(forkProof, /^  push:\n    branches: \[main\]$/m);
  assert.match(forkProof, /^  pull_request:$/m);
  assert.doesNotMatch(forkProof, /pull_request_target/);
  assert.doesNotMatch(workflow, /^ {2}fork-proof:$/m);
  assert.match(forkProof, /^permissions:\n  contents: read$/m);

  assert.match(forkProof, /^  main:\n    name: fork-proof\n    if: github\.event_name == 'push' \|\| github\.event_name == 'workflow_dispatch'\n    environment: fork-proof$/m);
  assert.match(forkProof, /name: Require main branch/);
  assert.match(forkProof, /\[\[ "\$GITHUB_REF" == 'refs\/heads\/main' \]\]/);

  assert.match(forkProof, /^  pull-request:\n    name: fork-proof\n    if: github\.event_name == 'pull_request'\n    environment: fork-proof$/m);
  assert.match(forkProof, /name: Require an exact PR head SHA/);
  assert.match(forkProof, /PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(forkProof, /\[\[ "\$PR_HEAD_SHA" =~ \^\[0-9a-f\]\{40\}\$ \]\]/);
  assert.match(forkProof, /ref: \$\{\{ github\.event\.pull_request\.head\.sha \}\}/, 'the PR job must prove the exact head, not a synthetic merge ref');

  const jobBodies = forkProof.split(/^  (?=main:|pull-request:)/m).filter(body => /^(?:main|pull-request):/.test(body));
  assert.equal(jobBodies.length, 2, 'fork-proof must define exactly the main and pull-request jobs');
  for (const body of jobBodies) {
    assert.match(body, /name: Run the mandatory archive fork proof/);
    assert.match(body, /ROBINHOOD_FORK_RPC_URL: \$\{\{ secrets\.ROBINHOOD_FORK_RPC_URL \}\}/);
    assert.match(body, /ROBINHOOD_FORK_PINNED: 'true'/);
    assert.match(body, /if \[\[ -z "\$\{ROBINHOOD_FORK_RPC_URL:-\}" \]\]; then\n\s+echo "ROBINHOOD_FORK_RPC_URL is required for the mandatory archive fork proof\." >&2\n\s+exit 1/);
    assert.match(
      body,
      /FOUNDRY_LIBS='\["lib\/v4-core","lib\/v4-periphery"\]' forge test --root packages\/contracts -vv --match-path 'test\/integration\/RobinhoodV4ArchiveFork\.t\.sol'/,
    );
    assert.match(body, /node scripts\/verify-fork-pin\.mjs/);
    assert.ok(
      body.indexOf('node scripts/verify-fork-pin.mjs')
        < body.indexOf("forge test --root packages/contracts -vv --match-path 'test/integration/RobinhoodV4ArchiveFork.t.sol'"),
      'the archive pin must validate before Forge contacts the fork endpoint',
    );
  }
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

test('base-defined gates publish the configured required check names', () => {
  const workflows = [
    ['control-gate', readFileSync(join(repoRoot, '.github', 'workflows', 'control-gate.yml'), 'utf8')],
    ['identity-gate', readFileSync(join(repoRoot, '.github', 'workflows', 'identity-gate.yml'), 'utf8')],
  ];

  for (const [checkName, source] of workflows) {
    assert.match(source, new RegExp(`^  pull-request:\\n    name: ${checkName}$`, 'm'));
    assert.match(source, new RegExp(`^  push:\\n    name: ${checkName}$`, 'm'));
  }
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

test('CI runs the Phase 1 runner proof; delivery-boundary runs only in the launch gate', () => {
  assert.doesNotMatch(workflow, /node scripts\/check-delivery-boundary\.mjs/);
  assert.match(workflow, /files="\$\(node scripts\/test-manifest\.mjs list runner\)"\n\s+node --test --test-timeout=120000 \$files/);
  assert.match(workflow, /node packages\/runner\/src\/cycle\/verify-fixtures\.mjs/);
  assert.match(launchGateWorkflow, /node scripts\/check-delivery-boundary\.mjs/);
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
  assert.equal((gitleaksConfig.match(/^\[\[rules\.allowlists\]\]$/gm) ?? []).length, 15);
  assert.equal((gitleaksConfig.match(/^regexTarget = "secret"$/gm) ?? []).length, 8);
  assert.equal((gitleaksConfig.match(/^regexTarget = "line"$/gm) ?? []).length, 7);
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
  assert.match(gitleaksConfig, /packages\/adapters\/test\/fixtures\/transactions\/solana-context\\\.json/);
  assert.match(gitleaksConfig, /packages\/adapters\/test\/fixtures\/transactions\/solana-v0-alt-wrong-resolution\\\.json/);
  assert.match(gitleaksConfig, /packages\/adapters\/test\/app\/return\\\.test\\\.mjs/);
  assert.match(gitleaksConfig, /release\/phase3\/launch-inputs\\\.json/);
  assert.match(gitleaksConfig, /release\/phase3\/package\/graph-draft\\\.json/);
  assert.match(gitleaksConfig, /\^5Z6Ay5NEcbg3xhopc522sBCRXQujkTiuDRnHGfQdcnSf\$/);
  assert.match(gitleaksConfig, /\^GyGKxMyg1p9SsHfm15MkNUu1u9TN2JtTspcdmrtGUdse\$/);
  assert.match(gitleaksConfig, /\^0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168\$/);
  assert.match(gitleaksConfig, /packages\/dashboard\/src\/contracts\/public-cycle-status\\\.mjs/);
  assert.match(gitleaksConfig, /packages\/dashboard\/src\/contracts\/public-community-snapshot\\\.mjs/);
  assert.match(gitleaksConfig, /HELD_POSITION_V5_KEYS : HELD_POSITION_V4_KEYS/);
  assert.match(gitleaksConfig, /HELD_POSITION_V7_KEYS : HELD_POSITION_V6_KEYS/);
  assert.match(gitleaksConfig, /packages\/adapters\/rehearsal\/collector-policy\/specimens\/purchase\\\.json/);
  assert.match(gitleaksConfig, /packages\/adapters\/rehearsal\/collector-policy\/specimens\/buyback\\\.json/);
  assert.match(gitleaksConfig, /\^EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v\$/);
  assert.match(gitleaksConfig, /apps\/web\/lib\/public-cycle-status\\\.ts/);
  assert.match(gitleaksConfig, /apps\/web\/lib\/public-community-snapshot\\\.ts/);
  assert.match(gitleaksConfig, /scripts\/check-cleanroom\\\.mjs/);
  assert.match(gitleaksConfig, /const keys = schemaVersion === 5 \\\|\\\| schemaVersion === 6 \\\? HELD_POSITION_V5_KEYS : HELD_POSITION_V4_KEYS/);
  assert.match(gitleaksConfig, /const keys = schemaVersion === 7 \\\|\\\| schemaVersion === 8 \\\? HELD_POSITION_V7_KEYS : HELD_POSITION_V6_KEYS/);
  assert.match(gitleaksConfig, buildAssignmentPattern('APPROVED_LEGACY_WIRE_FIELD_TOKEN_DIGEST', extractAssignedValue(cleanroomSource, 'APPROVED_LEGACY_WIRE_FIELD_TOKEN_DIGEST')));
  assert.doesNotMatch(gitleaksConfig, /^\[\[allowlists\]\]$/m);
});

function allowlistBlock(descriptionFragment) {
  const marker = `description = "${descriptionFragment}`;
  const start = gitleaksConfig.indexOf(marker);
  assert.ok(start !== -1, `expected an allowlist block matching: ${descriptionFragment}`);
  const end = gitleaksConfig.indexOf('\n\n', start);
  return gitleaksConfig.slice(start, end === -1 ? gitleaksConfig.length : end);
}

function extractedRegex(block, field) {
  const match = block.match(new RegExp(`${field} = \\['''([\\s\\S]*?)'''\\]`));
  assert.ok(match, `expected a ${field} entry in the block`);
  return new RegExp(match[1]);
}

// Every fixture value below is read from the real, currently-approved source file at test time
// (never retyped as a literal here) so this test cannot itself reintroduce the exact flagged
// line/value as tracked source text -- the same requirement the scanner exception enforces.
function realSourceLine(text, anchor) {
  const idx = text.indexOf(anchor);
  assert.ok(idx !== -1, `expected to find an anchor line containing: ${anchor}`);
  const start = text.lastIndexOf('\n', idx) + 1;
  const end = text.indexOf('\n', idx);
  return text.slice(start, end === -1 ? text.length : end);
}

function extractAssignedValue(text, identifier) {
  const marker = `${identifier} = '`;
  const start = text.indexOf(marker);
  assert.ok(start !== -1, `expected ${identifier} in source`);
  const valueStart = start + marker.length;
  const valueEnd = text.indexOf("'", valueStart);
  return text.slice(valueStart, valueEnd);
}

function buildAssignmentPattern(identifier, value) {
  return new RegExp(`${identifier} = '${value}'`);
}

function withReplacedSelector(line) {
  return line.replace(/V(\d)_KEYS/, 'V9_KEYS');
}

const cleanroomSource = readFileSync(join(repoRoot, 'scripts', 'check-cleanroom.mjs'), 'utf8');

test('Gitleaks imported-web-copy allowlists only match their own exact path and full line', () => {
  const cycleStatusSource = readFileSync(join(repoRoot, 'apps', 'web', 'lib', 'public-cycle-status.ts'), 'utf8');
  const communitySnapshotSource = readFileSync(join(repoRoot, 'apps', 'web', 'lib', 'public-community-snapshot.ts'), 'utf8');
  const cycleStatusLine = realSourceLine(cycleStatusSource, 'const keys = schemaVersion === 5');
  const communitySnapshotLine = realSourceLine(communitySnapshotSource, 'const keys = schemaVersion === 7');
  const digestLine = realSourceLine(cleanroomSource, 'APPROVED_LEGACY_WIRE_FIELD_TOKEN_DIGEST = \'');
  const digestValue = extractAssignedValue(cleanroomSource, 'APPROVED_LEGACY_WIRE_FIELD_TOKEN_DIGEST');
  const changedDigestValue = digestValue.split('').reverse().join('');

  const entries = [
    {
      block: allowlistBlock('Held-position key-set selector ternary in the imported web copy of the public cycle-status'),
      matchingPath: 'apps/web/lib/public-cycle-status.ts',
      matchingLine: cycleStatusLine,
      changedLine: withReplacedSelector(cycleStatusLine),
      unrelatedPath: 'packages/dashboard/src/contracts/public-cycle-status.mjs',
    },
    {
      block: allowlistBlock('Held-position key-set selector ternary in the imported web copy of the public community-snapshot'),
      matchingPath: 'apps/web/lib/public-community-snapshot.ts',
      matchingLine: communitySnapshotLine,
      changedLine: withReplacedSelector(communitySnapshotLine),
      unrelatedPath: 'packages/dashboard/src/contracts/public-community-snapshot.mjs',
    },
    {
      block: allowlistBlock('Legacy wire-field exception SHA-256 digest declaration'),
      matchingPath: 'scripts/check-cleanroom.mjs',
      matchingLine: digestLine,
      changedLine: digestLine.replace(digestValue, changedDigestValue),
      unrelatedPath: 'scripts/verify-control-dependencies.mjs',
    },
  ];

  for (const entry of entries) {
    const pathPattern = extractedRegex(entry.block, 'paths');
    const linePattern = extractedRegex(entry.block, 'regexes');

    assert.match(entry.matchingPath, pathPattern, 'must match its own exact approved path');
    assert.match(entry.matchingLine, linePattern, 'must match its own exact approved line');

    assert.doesNotMatch(entry.unrelatedPath, pathPattern, 'must not match an unrelated file with the same or similar name');
    assert.doesNotMatch(`nested/${entry.matchingPath}.bak`, pathPattern, 'must not match a suffixed variant of the approved path');
    assert.doesNotMatch(entry.changedLine, linePattern, 'must not match the same line with a changed selector value');
    assert.doesNotMatch(`${entry.matchingLine}extra`, linePattern, 'must not match the exact line with trailing non-whitespace appended');
  }
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

test('the required code gate carries no launch/release evidence; the launch gate verifies it strictly', () => {
  assert.doesNotMatch(workflow, /verify-launch-package\.mjs/);
  assert.doesNotMatch(workflow, /verify-release-package-closure\.mjs/);
  assert.doesNotMatch(workflow, /verify-release-ready\.mjs/);
  assert.doesNotMatch(workflow, /v4\.mjs status --check/);
  assert.doesNotMatch(workflow, /v4\.mjs trace check/);
  assert.match(launchGateWorkflow, /node scripts\/programmable\/verify-launch-package\.mjs\n/);
  assert.doesNotMatch(launchGateWorkflow, /verify-launch-package\.mjs --allow-unverified/);
  assert.match(launchGateWorkflow, /node scripts\/verify-release-package-closure\.mjs/);
  assert.match(launchGateWorkflow, /node scripts\/verify-release-ready\.mjs/);
  assert.match(launchGateWorkflow, /node scripts\/v4\.mjs status --check/);
  assert.match(launchGateWorkflow, /node scripts\/v4\.mjs trace check/);
  assert.match(launchGateWorkflow, /report\.launchEligible !== true/);
  assert.match(launchGateWorkflow, /refs\/heads\/main/);
  assert.doesNotMatch(launchGateWorkflow, /pull_request/);
  assert.doesNotMatch(launchGateWorkflow, /^ {2}push:/m);
  assert.match(launchGateWorkflow, /mainSha/);
  assert.match(launchGateWorkflow, /required:\s*true/);
});

test('the interface freeze digest for product/dependency-pins.json ignores CI-tool churn but still binds phase1Toolchain', () => {
  const dir = mkdtempSync(join(tmpdir(), 'interface-freeze-digest-'));
  try {
    mkdirSync(join(dir, 'product'));
    const base = {
      controlRuntime: { node: '24.19.0' },
      contentAddresses: { workflow: { path: '.github/workflows/v4-gates.yml', sha256: 'a'.repeat(64) } },
      securityTools: { gitleaks: { version: '8.30.1' } },
      phase1Toolchain: { foundry: { version: '1.7.1' }, requirementsRevision: 56 },
    };
    const relativePath = 'product/dependency-pins.json';
    const pinsPath = join(dir, relativePath);
    writeFileSync(pinsPath, JSON.stringify(base));
    const original = interfaceFreezeInputDigest(dir, relativePath);

    const ciToolChurn = structuredClone(base);
    ciToolChurn.contentAddresses.workflow.sha256 = 'b'.repeat(64);
    ciToolChurn.securityTools.gitleaks.version = '9.0.0';
    writeFileSync(pinsPath, JSON.stringify(ciToolChurn));
    assert.equal(
      interfaceFreezeInputDigest(dir, relativePath),
      original,
      'a CI-tool-only pin change must not change the interface freeze digest',
    );

    const interfaceChange = structuredClone(base);
    interfaceChange.phase1Toolchain.foundry.version = '1.8.0';
    writeFileSync(pinsPath, JSON.stringify(interfaceChange));
    assert.notEqual(
      interfaceFreezeInputDigest(dir, relativePath),
      original,
      'a phase1Toolchain change must still change the interface freeze digest',
    );

    const otherInputPath = join(dir, 'plain.txt');
    writeFileSync(otherInputPath, 'unchanged\n');
    const plainDigest = interfaceFreezeInputDigest(dir, 'plain.txt');
    writeFileSync(otherInputPath, 'unchanged\n');
    assert.equal(interfaceFreezeInputDigest(dir, 'plain.txt'), plainDigest, 'non-pins inputs still hash the whole file');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  assert.match(card, /\.github\/workflows\/launch-gate\.yml/);
  assert.doesNotMatch(card, /verify-launch-package\.mjs --allow-unverified/);
  assert.match(card, /verify-launch-package\.mjs/);
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
