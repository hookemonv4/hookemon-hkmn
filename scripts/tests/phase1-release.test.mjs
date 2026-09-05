import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import * as releaseVerifier from '../verify-phase1-release.mjs';

import {
  buildForgeBase,
  countPositiveInvariantResults,
  custodySourcePaths,
  marketRoutingSourcePaths,
  sourceSurfaceClasses,
  expectedArtifactIdentities,
  expectedHighRiskMethodIdentifiers,
  parseDeterministicVaultIdentity,
  requiredCandidatePaths,
  requireAbsoluteRegularFile,
  validateReadOnlyReleaseScript,
  validateCustodySourceSurfaces,
  validateMarketRoutingSourceSurfaces,
  validateSourceSurfacePolicyCoverage,
  validateDeterministicVaultIdentity,
  validateHighRiskCompilerSurfaces,
  validateReproducibilityReport,
  withNonGitForgeRoot,
} from '../verify-phase1-release.mjs';

const root = resolve(import.meta.dirname, '../..');
const report = JSON.parse(readFileSync(resolve(root, 'release/phase1/local-reproducibility.json')));
const toolchain = JSON.parse(readFileSync(resolve(root, 'release/phase1/local-toolchain.json')));
const dependencyPins = JSON.parse(readFileSync(resolve(root, 'product/dependency-pins.json')));
const evidence = JSON.parse(readFileSync(resolve(root, 'release/phase1/local-evidence.json')));
const manifest = JSON.parse(readFileSync(resolve(root, 'release/phase1/local-candidate.json')));
const clone = (value) => structuredClone(value);
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
function currentReportFixture() {
  const prior = new Map(report.artifacts.map((artifact) => [
    `${artifact.source}::${artifact.contract}`, artifact,
  ]));
  const artifacts = expectedArtifactIdentities.map((identity) => {
    const [source, contract] = identity.split('::');
    return {
      ...(prior.get(identity) ?? {
        source,
        contract,
        abiSha256: '0'.repeat(64),
        eventSchemaSha256: '0'.repeat(64),
        initcodeSha256: '0'.repeat(64),
        runtimeSha256: '0'.repeat(64),
        initcodeBytes: 0,
        runtimeBytes: 0,
        localCompilerGas: null,
      }),
      methodIdentifiers: structuredClone(expectedHighRiskMethodIdentifiers[identity] ?? {}),
    };
  });
  const runnerFiles = manifest.files
    .filter((file) => file.path.startsWith('packages/runner/'))
    .sort((left, right) => left.path.localeCompare(right.path));
  const candidate = clone(report);
  candidate.artifacts = artifacts;
  candidate.staticInputs = {
    candidateManifestSha256: report.staticInputs.candidateManifestSha256,
    runnerSourceCount: runnerFiles.length,
    runnerSourceSetSha256: sha256(canonicalJson(runnerFiles)),
  };
  candidate.reproducibility.artifactCount = artifacts.length;
  candidate.reproducibility.artifactSetSha256 = sha256(canonicalJson(artifacts));
  return candidate;
}

const validReport = currentReportFixture();
const validReportInput = (candidate = validReport) => ({
  report: candidate,
  expectedManifestSha256: report.staticInputs.candidateManifestSha256,
  sourceCommitManifestSha256: report.staticInputs.candidateManifestSha256,
  toolchain,
  dependencyPins,
  manifest,
});

test('release verifier requires reproducibility inputs in the exact candidate set', () => {
  for (const path of [
    'scripts/verify-phase1-reproducibility.mjs',
    'scripts/tests/phase1-reproducibility.test.mjs',
  ]) assert.ok(requiredCandidatePaths.includes(path), path);
});

test('release verifier requires revision 56 vault custody source and focused proofs', () => {
  for (const path of [
    'packages/contracts/src/process/IPegCycleVault.sol',
    'packages/contracts/src/process/IPegCycleRouteExecutor.sol',
    'packages/contracts/src/process/PegCycleVault.sol',
    'packages/contracts/test/process/PegCycleVault.t.sol',
    'packages/contracts/test/process/ProcessBudget.t.sol',
    'packages/contracts/test/payout/PayoutCommitment.t.sol',
    'packages/runner/test/cycle/security.test.mjs',
    'product/REQUIREMENTS_REVISION_56_PROPOSAL.md',
    'decisions/ADR-0019-immutable-peg-cycle-custody.md',
    'architecture/provisional-interfaces.json',
    'docs/modules/peg-cycle-vault.md',
  ]) assert.ok(requiredCandidatePaths.includes(path), path);
  assert.equal(expectedArtifactIdentities.length, 32);
});

test('release verifier rejects custody escape declarations without flagging narrow operations', () => {
  const safe = [
    'function executeOutbound(bytes32 cycleId, bytes calldata routeData) external {}',
    'function fundPayoutFromPegCycle(bytes calldata auth) external {}',
    'function bindHook(address hook) external {}',
    'contract SafeText { string constant TEXT = "function execute(address target)"; /* function rescue(address token) external {} */ function executeOutbound(bytes32 cycleId, bytes calldata data) external {} }',
  ].join('\n');
  assert.doesNotThrow(() => validateCustodySourceSurfaces(safe));
  for (const forbidden of [
    'function releaseProcessBudget(address operations, uint256 amount) external {}',
    'function fundPayout(bytes32 payoutId, uint256 amount) external {}',
    'function execute(address target, bytes calldata data) external {}',
    'function approve(address spender, uint256 amount) external {}',
    'interface IPegCycleUsdg { function transfer(address recipient, uint256 amount) external returns (bool); function approve(address spender, uint256 amount) external returns (bool); }',
    'function rescue(address token) external {}',
    'function setAuthorizer(address next) external {}',
    'function upgradeTo(address next) external {}',
    'target.call(data);',
    'target. /* comment cannot hide a low-level escape */ call(data);',
    'target.staticcall(data);',
    'assembly { pop(call(gas(), target, 0, 0, 0, 0, 0)) }',
    'assembly { pop(delegatecall(gas(), target, 0, 0, 0, 0)) }',
    'assembly { verbatim_0i_0o(hex"00") }',
    'contract StringBypass { string constant MARKER = "//"; function execute(address target) external {} }',
    'contract BlockStringBypass { string constant MARKER = "/*"; function rescue(address token) external {} }',
    'interface UnsafeExecutor { function execute(address target, bytes calldata data) external; }',
    'contract ImportedInterfaceBypass { function authorizeFunding(bytes32 cycleId) external { IERC20(usdg).approve(routeExecutor, 1); } }',
    'contract ExistingSelectorBypass { function authorizeFunding(bytes32 cycleId) external { IERC20(usdg).transferFrom(operations, address(this), 1); } }',
    'contract ApproveOptionsBypass { function authorizeFunding(bytes32 cycleId) external { IERC20(usdg).approve{gas: 50_000}(routeExecutor, 1); } }',
    'contract TransferFromOptionsBypass { function authorizeFunding(bytes32 cycleId) external { IERC20(usdg).transferFrom{gas: 50_000}(operations, address(this), 1); } }',
    'contract ExecuteOptionsBypass { function authorizeFunding(bytes32 cycleId) external { executor.execute{value: 0}(routeData); } }',
  ]) assert.throws(() => validateCustodySourceSurfaces(forbidden), /custody source surface/);
  assert.doesNotThrow(() => validateCustodySourceSurfaces(
    'interface IPegCycleUsdg { function transfer(address recipient, uint256 amount) external returns (bool); }',
  ));
  for (const path of [
    'packages/contracts/src/process/FundingAuthorizationValidation.sol',
    'packages/contracts/src/process/IPegCycleRouteExecutor.sol',
    'packages/contracts/src/process/IPegCycleVault.sol',
    'packages/contracts/src/process/PayoutDistributionSignatures.sol',
    'packages/contracts/src/process/PegCycleEscrowFactory.sol',
    'packages/contracts/src/process/PegCycleVault.sol',
    'packages/contracts/src/process/PegCycleReturnEscrow.sol',
    'packages/contracts/src/process/ProcessBudget.sol',
    'packages/contracts/src/payout/PayoutCommitment.sol',
    'packages/contracts/src/settlement/HolderSettlement.sol',
  ]) assert.ok(custodySourcePaths.includes(path), path);
  // The surface policy narrowed the strict custody set: HookemonHook, CanonicalMarket,
  // HookemonIssuance, HKMNToken, CustomLaunchStrategy, PegCycleRouteExecutor, and RobinhoodBindings
  // use the market-routing allow-list (see the next test); WP-38 then added three delegatecall-linked
  // library files (FundingAuthorizationValidation, PayoutDistributionSignatures,
  // PegCycleEscrowFactory) that stay in the strict custody set, leaving 13 strict custody sources.
  assert.equal(custodySourcePaths.length, 13);
  assert.doesNotThrow(() => validateCustodySourceSurfaces(
    custodySourcePaths.map((path) => readFileSync(resolve(root, path), 'utf8')).join('\n'),
  ));
});

test('release verifier checks an explicit surface-policy classification for every source', () => {
  const allSources = [...custodySourcePaths, ...marketRoutingSourcePaths].sort();
  assert.deepEqual(Object.keys(sourceSurfaceClasses).sort(), allSources);
  assert.equal(new Set(allSources).size, allSources.length);
  assert.doesNotThrow(() => validateSourceSurfacePolicyCoverage(allSources));
  assert.throws(
    () => validateSourceSurfacePolicyCoverage(allSources.slice(1)),
    /explicit surface policy classification/,
  );
  assert.throws(
    () => validateSourceSurfacePolicyCoverage([...allSources, 'packages/contracts/src/Unclassified.sol']),
    /explicit surface policy classification/,
  );
});

test('release verifier allows only the documented market-routing external-call patterns', () => {
  for (const path of [
    'packages/contracts/src/HookemonHook.sol',
    'packages/contracts/src/bindings/RobinhoodBindings.sol',
    'packages/contracts/src/launch/CustomLaunchStrategy.sol',
    'packages/contracts/src/launch/HookemonIssuance.sol',
    'packages/contracts/src/launch/HKMNToken.sol',
    'packages/contracts/src/market/CanonicalMarket.sol',
    'packages/contracts/src/process/PegCycleRouteExecutor.sol',
  ]) assert.ok(marketRoutingSourcePaths.includes(path), path);
  assert.equal(marketRoutingSourcePaths.length, 7);
  for (const path of marketRoutingSourcePaths) {
    assert.doesNotThrow(
      () => validateMarketRoutingSourceSurfaces(readFileSync(resolve(root, path), 'utf8'), path),
      path,
    );
  }

  const hookPath = 'packages/contracts/src/HookemonHook.sol';
  const hookSource = readFileSync(resolve(root, hookPath), 'utf8');
  const hookMutations = [
    [
      '.transferFrom(params.payer, address(this), uint160(usdgMax), Currency.unwrap(usdg));',
      '.transferFrom(launchAuthority, address(this), uint160(usdgMax), Currency.unwrap(usdg));',
    ],
    [
      '.transferFrom(params.payer, address(this), uint160(usdgMax), Currency.unwrap(usdg));',
      '.transferFrom(params.payer, params.custody, uint160(usdgMax), Currency.unwrap(usdg));',
    ],
    [
      '.transferFrom(params.payer, address(this), uint160(usdgMax), Currency.unwrap(usdg));',
      '.transferFrom(params.payer, address(this), uint160(hkmnMax), Currency.unwrap(usdg));',
    ],
    [
      '.transferFrom(params.payer, address(this), uint160(usdgMax), Currency.unwrap(usdg));',
      '.transferFrom(params.payer, address(this), uint160(usdgMax), Currency.unwrap(hkmn));',
    ],
    [
      'permit.approve(usdgToken, positionManager, uint160(usdgMax), uint48(block.timestamp));',
      'permit.approve(usdgToken, launchAuthority, uint160(usdgMax), uint48(block.timestamp));',
    ],
    [
      'permit.approve(usdgToken, positionManager, uint160(usdgMax), uint48(block.timestamp));',
      'permit.approve(usdgToken, positionManager, uint160(hkmnMax), uint48(block.timestamp));',
    ],
    [
      'permit.approve(usdgToken, positionManager, uint160(usdgMax), uint48(block.timestamp));',
      'permit.approve(usdgToken, positionManager, uint160(usdgMax), uint48(params.deadline));',
    ],
    [
      'token.call(abi.encodeWithSelector(bytes4(0x095ea7b3), spender, amount));',
      'token.call(abi.encodeWithSelector(bytes4(0xa9059cbb), spender, amount));',
    ],
    [
      'token.staticcall(abi.encodeWithSelector(bytes4(0x70a08231), account));',
      'token.staticcall(abi.encodeWithSelector(bytes4(0x095ea7b3), account));',
    ],
    [
      '_approveToken(usdgToken, permit2, usdgMax);',
      '_approveToken(usdgToken, permit2, usdgMax);\n        _approveToken(usdgToken, launchAuthority, usdgMax);',
    ],
    [
      `                        address(this),
                        Currency.unwrap(usdg),
                        sqrtPriceX96,
                        graphInitializer,
                        graphExpectedDecimals`,
      `                        launchAuthority,
                        Currency.unwrap(usdg),
                        sqrtPriceX96,
                        graphInitializer,
                        graphExpectedDecimals`,
    ],
    [
      `                    (address(this), Currency.unwrap(usdg), graphInitializer, graphExpectedDecimals)`,
      `                    (launchAuthority, Currency.unwrap(usdg), graphInitializer, graphExpectedDecimals)`,
    ],
    [
      `hkmnToken.call(
                abi.encodeWithSelector(bytes4(0xa9059cbb), _currentTreasury(), transferred)
            )`,
      `hkmnToken.call(
                abi.encodeWithSelector(bytes4(0xa9059cbb), launchAuthority, transferred)
            )`,
    ],
  ];
  for (const [documented, mutation] of hookMutations) {
    assert.ok(hookSource.includes(documented), documented);
    assert.throws(
      () => validateMarketRoutingSourceSurfaces(
        hookSource.replace(documented, mutation), hookPath,
      ),
      /market-routing source surface/,
    );
  }
  assert.throws(
    () => validateMarketRoutingSourceSurfaces(
      hookSource,
      'packages/contracts/src/bindings/RobinhoodBindings.sol',
    ),
    /market-routing source surface/,
  );

  const issuancePath = 'packages/contracts/src/launch/HookemonIssuance.sol';
  const issuanceSource = readFileSync(resolve(root, issuancePath), 'utf8');
  assert.throws(
    () => validateMarketRoutingSourceSurfaces(
      `${issuanceSource}\ncontract DuplicateTransferSurface { function transfer(address recipient, uint256 amount) external returns (bool) { return amount > 0 && recipient != address(0); } }`,
      issuancePath,
    ),
    /market-routing source surface/,
  );

  const tokenPath = 'packages/contracts/src/launch/HKMNToken.sol';
  const tokenSource = readFileSync(resolve(root, tokenPath), 'utf8');
  assert.throws(
    () => validateMarketRoutingSourceSurfaces(
      `${tokenSource}\ncontract DuplicateTransferSurface { function transfer(address recipient, uint256 amount) external returns (bool) { return amount > 0 && recipient != address(0); } }`,
      tokenPath,
    ),
    /market-routing source surface/,
  );

  // Negative: a custody file that grows a fresh, unlisted external call must still be rejected
  // even though PegCycleReturnEscrow's one narrow transfer idiom is allowed elsewhere.
  assert.throws(
    () => validateCustodySourceSurfaces(
      'contract ProcessBudgetWithEscape { function releaseToOperations(address token, address operations, uint256 amount) external { token.call(abi.encodeWithSelector(bytes4(0xa9059cbb), operations, amount)); } }',
    ),
    /custody source surface/,
  );

  // Negative: swapping the recipient identifier in HookemonHook's exact allowed transfer shape
  // for a hypothetical owner-mutable field must be rejected, not silently matched.
  assert.throws(
    () => validateMarketRoutingSourceSurfaces(
      'contract MutableRecipientBypass { address public owner; function setOwner(address next) external { owner = next; } function pay(uint256 amount) external { Currency.unwrap(usdg).call(abi.encodeWithSelector(bytes4(0xa9059cbb), owner, amount)); } } }',
    ),
    /market-routing source surface/,
  );

  // Negative: an arbitrary generic call target on a market-routing file is still forbidden --
  // the allow-list only recognizes the exact documented shapes, not any low-level call.
  assert.throws(
    () => validateMarketRoutingSourceSurfaces('target.call(data);'),
    /market-routing source surface/,
  );
  assert.throws(
    () => validateMarketRoutingSourceSurfaces('target.delegatecall(data);'),
    /market-routing source surface/,
  );
  assert.throws(
    () => validateMarketRoutingSourceSurfaces('function f(address payable a) external { selfdestruct(a); }'),
    /market-routing source surface/,
  );
});

test('release verifier binds candidate production sources to the tree and local import closure', () => {
  assert.equal(typeof releaseVerifier.validateCandidateProductionSourceClosure, 'function');
  assert.doesNotThrow(() => releaseVerifier.validateCandidateProductionSourceClosure({
    projectRoot: root,
    candidatePaths: requiredCandidatePaths,
  }));

  const fixtureRoot = mkdtempSync('/tmp/hookemon-production-closure-');
  try {
    mkdirSync(resolve(fixtureRoot, 'packages/contracts/src'), { recursive: true });
    writeFileSync(
      resolve(fixtureRoot, 'packages/contracts/src/Main.sol'),
      'pragma solidity 0.8.26; import "./Helper.sol"; contract Main {}\n',
    );
    writeFileSync(
      resolve(fixtureRoot, 'packages/contracts/src/Helper.sol'),
      'pragma solidity 0.8.26; contract Helper {}\n',
    );
    assert.throws(
      () => releaseVerifier.validateCandidateProductionSourceClosure({
        projectRoot: fixtureRoot,
        candidatePaths: ['packages/contracts/src/Main.sol'],
      }),
      /production Solidity source set mismatch/,
    );

    rmSync(resolve(fixtureRoot, 'packages/contracts/src/Helper.sol'));
    mkdirSync(resolve(fixtureRoot, 'packages/contracts/helpers'), { recursive: true });
    writeFileSync(
      resolve(fixtureRoot, 'packages/contracts/helpers/Helper.sol'),
      'pragma solidity 0.8.26; contract Helper {}\n',
    );
    writeFileSync(
      resolve(fixtureRoot, 'packages/contracts/src/Main.sol'),
      'pragma solidity 0.8.26; import "../helpers/Helper.sol"; contract Main {}\n',
    );
    assert.throws(
      () => releaseVerifier.validateCandidateProductionSourceClosure({
        projectRoot: fixtureRoot,
        candidatePaths: ['packages/contracts/src/Main.sol'],
      }),
      /production Solidity import escapes candidate source closure/,
    );

    for (const escapedImport of [
      '@uniswap/v4-core/../../helpers/Helper.sol',
      '@uniswap/v4-core/%2e%2e/%2e%2e/helpers/Helper.sol',
      '@uniswap/v4-core//private/tmp/Helper.sol',
      '@uniswap/v4-periphery/../../helpers/Helper.sol',
    ]) {
      writeFileSync(
        resolve(fixtureRoot, 'packages/contracts/src/Main.sol'),
        `pragma solidity 0.8.26; import "${escapedImport}"; contract Main {}\n`,
      );
      assert.throws(
        () => releaseVerifier.validateCandidateProductionSourceClosure({
          projectRoot: fixtureRoot,
          candidatePaths: ['packages/contracts/src/Main.sol'],
        }),
        /pinned (?:v4-core|v4-periphery) import path is invalid/,
      );
    }
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('release verifier binds the candidate to the emitted deterministic vault identity', () => {
  const candidate = clone(manifest);
  candidate.deterministicLocalVault.deploymentAuthority = candidate.deterministicLocalVault.deployer;
  const trustedManifestSha256 = 'ab'.repeat(32);
  const addressWord = (address) => `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
  const identity = candidate.deterministicLocalVault;
  const output = `emit DeterministicVaultIdentity(deployer: ${addressWord(identity.deployer)}, salt: ${identity.salt}, initCodeHash: ${identity.initcodeKeccak256}, concreteRuntimeCodeHash: ${identity.concreteRuntimeCodeKeccak256}, vault: ${addressWord(identity.expectedVault)}, usdg: ${addressWord(identity.usdg)}, authorizer: ${addressWord(identity.authorizer)}, routeExecutor: ${addressWord(identity.routeExecutor)}, bindingManifestDigest: ${identity.bindingManifestDigest}, deploymentAuthority: ${addressWord(identity.deploymentAuthority)}, candidateManifestSha256: 0x${trustedManifestSha256})`;
  assert.deepEqual(parseDeterministicVaultIdentity(output), {
    deployer: identity.deployer.toLowerCase(),
    salt: identity.salt,
    initcodeKeccak256: identity.initcodeKeccak256,
    concreteRuntimeCodeKeccak256: identity.concreteRuntimeCodeKeccak256,
    expectedVault: identity.expectedVault.toLowerCase(),
    usdg: identity.usdg.toLowerCase(),
    authorizer: identity.authorizer.toLowerCase(),
    routeExecutor: identity.routeExecutor.toLowerCase(),
    bindingManifestDigest: identity.bindingManifestDigest,
    deploymentAuthority: identity.deploymentAuthority.toLowerCase(),
    candidateManifestSha256: `0x${trustedManifestSha256}`,
  });
  assert.doesNotThrow(() => validateDeterministicVaultIdentity(candidate, output, trustedManifestSha256));
  candidate.deterministicLocalVault.authorizer = '0x0000000000000000000000000000000000005000';
  assert.throws(
    () => validateDeterministicVaultIdentity(candidate, output, trustedManifestSha256),
    /deterministic vault identity/,
  );
  for (const [field, value] of [
    ['initcodeKeccak256', `0x${'11'.repeat(32)}`],
    ['expectedVault', `0x${'22'.repeat(20)}`],
    ['concreteRuntimeCodeKeccak256', `0x${'33'.repeat(32)}`],
  ]) {
    const mismatch = clone(manifest);
    mismatch.deterministicLocalVault[field] = value;
    assert.throws(
      () => validateDeterministicVaultIdentity(mismatch, output, trustedManifestSha256),
      /deterministic vault identity/,
    );
  }
  assert.throws(
    () => validateDeterministicVaultIdentity(clone(manifest), output, 'cd'.repeat(32)),
    /deterministic vault identity/,
  );
});

test('release verifier binds exact high-risk compiler method identifier maps', () => {
  const exact = Object.entries(expectedHighRiskMethodIdentifiers).map(([identity, methodIdentifiers]) => {
    const [source, contract] = identity.split('::');
    return { source, contract, methodIdentifiers: structuredClone(methodIdentifiers) };
  });
  assert.doesNotThrow(() => validateHighRiskCompilerSurfaces(exact));

  const forbidden = structuredClone(exact);
  forbidden[0].methodIdentifiers['fundPayout(bytes32,uint256)'] = 'deadbeef';
  assert.throws(() => validateHighRiskCompilerSurfaces(forbidden), /compiler surface/);

  const altered = structuredClone(exact);
  altered.at(-1).methodIdentifiers['unexpected()'] = '12345678';
  assert.throws(() => validateHighRiskCompilerSurfaces(altered), /compiler surface/);
});

test('release verifier binds invariant coverage and a non-broadcasting deployment plan', () => {
  for (const path of [
    'packages/contracts/test/invariant/PhaseOneReleaseInvariant.t.sol',
    'packages/contracts/script/release/PhaseOneReleasePlan.sol',
  ]) assert.ok(requiredCandidatePaths.includes(path), path);

  assert.throws(
    () => validateReadOnlyReleaseScript('function run() external { vm.startBroadcast(); }'),
    /broadcast-capable release script/,
  );
  assert.throws(
    () => validateReadOnlyReleaseScript(
      'string constant MARKER = "safe //"; fallback() external { Target(x).mutate(); }',
    ),
    /broadcast-capable release script/,
  );
  assert.doesNotThrow(() => validateReadOnlyReleaseScript(readFileSync(resolve(
    root,
    'packages/contracts/script/release/PhaseOneReleasePlan.sol',
  ), 'utf8')));
});

test('release verifier recognizes Foundry invariant results with function parentheses', () => {
  const output = [
    '[PASS] invariant_totalLiabilityEqualsEveryKnownLiability() (runs: 256, calls: 128000, reverts: 0)',
    '[PASS] invariant_positionCustodyRemainsPermanent() (runs: 1, calls: 1, reverts: 0)',
    '[PASS] test_releasePlanIsReadOnlyAndRejectsAnAccountWithoutRuntimeCode() (gas: 644644)',
    '[PASS] invariant_zeroRuns() (runs: 0, calls: 128000, reverts: 0)',
    '[PASS] invariant_zeroCalls() (runs: 256, calls: 0, reverts: 0)',
  ].join('\n');

  assert.equal(countPositiveInvariantResults(output), 2);
});

test('release verifier preserves invariant output larger than the observed trace', () => {
  assert.equal(releaseVerifier.RELEASE_CHECK_MAX_BUFFER_BYTES, 32 * 1024 * 1024);
  assert.equal(typeof releaseVerifier.spawnReleaseCheckChild, 'function');
  const marker = '\nFULL_INVARIANT_TRACE_END\n';
  const result = releaseVerifier.spawnReleaseCheckChild(process.execPath, [
    '-e',
    `process.stdout.write('x'.repeat(13 * 1024 * 1024)); process.stdout.write(${JSON.stringify(marker)});`,
  ], { cwd: root, env: process.env });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0);
  assert.ok(result.stdout.length > 12_625_930);
  assert.ok(result.stdout.endsWith(marker));

  const verifierSource = readFileSync(resolve(root, 'scripts/verify-phase1-release.mjs'), 'utf8');
  assert.match(verifierSource, /PhaseOneReleaseInvariant\.t\.sol'[\s\S]*'-vvvv'/);
});

test('release verifier reports child failures before parsing truncated evidence', () => {
  assert.equal(typeof releaseVerifier.validateReleaseCheckChildResult, 'function');
  const check = {
    id: 'phase-one-release-invariants',
    bindsDeterministicVaultIdentity: true,
    countPattern: /Ran 1 test suite[\s\S]*?\((\d+) total tests\)/,
    expectedPasses: 10,
    expectedInvariantResults: 9,
    command: '/pinned/forge',
  };
  const input = {
    check,
    forgeBinary: '/pinned/forge',
    manifest,
    expectedManifestSha256: 'ab'.repeat(32),
  };
  const enobufs = new Error('spawnSync /pinned/forge ENOBUFS');
  enobufs.code = 'ENOBUFS';
  assert.throws(
    () => releaseVerifier.validateReleaseCheckChildResult({
      ...input,
      result: { error: enobufs, status: null, stdout: 'truncated', stderr: '' },
    }),
    (error) => {
      assert.match(error.message, /ENOBUFS/);
      assert.doesNotMatch(error.message, /deterministic vault identity/);
      return true;
    },
  );

  assert.throws(
    () => releaseVerifier.validateReleaseCheckChildResult({
      ...input,
      result: { status: 7, stdout: 'missing event', stderr: 'forge failed' },
    }),
    (error) => {
      assert.match(error.message, /status 7/);
      assert.doesNotMatch(error.message, /deterministic vault identity/);
      return true;
    },
  );
});

test('local evidence records the exact reproducibility proof shape', () => {
  assert.deepEqual(evidence.reproducibility, {
    report: 'release/phase1/local-reproducibility.json',
    expectedBuilds: 2,
    expectedArtifacts: 32,
    expectedLocalGasTests: 7,
    productionLimits: 'INTEGRATION_PENDING',
    officialHeadroom: 'NOT_CLAIMED',
  });
});

test('release verifier accepts only the report bound to its trusted candidate digest', () => {
  assert.doesNotThrow(() => validateReproducibilityReport(validReportInput()));
  assert.throws(() => validateReproducibilityReport({
    ...validReportInput(),
    expectedManifestSha256: '0'.repeat(64),
  }), /reproducibility report does not bind the trusted candidate manifest/);
});

test('release verifier recomputes the exact canonical artifact digest and set', () => {
  const changedBytes = clone(validReport);
  changedBytes.artifacts[4].runtimeBytes += 1;
  assert.throws(
    () => validateReproducibilityReport(validReportInput(changedBytes)),
    /artifact set digest/,
  );

  const duplicate = clone(validReport);
  duplicate.artifacts[27] = clone(duplicate.artifacts[26]);
  duplicate.reproducibility.artifactSetSha256 = sha256(canonicalJson(duplicate.artifacts));
  assert.throws(
    () => validateReproducibilityReport(validReportInput(duplicate)),
    /artifact source and contract set/,
  );
});

test('release verifier binds exact static, source-commit, and local gas evidence', () => {
  const staticDrift = clone(validReport);
  staticDrift.staticInputs.runnerSourceSetSha256 = '0'.repeat(64);
  assert.throws(() => validateReproducibilityReport(validReportInput(staticDrift)), /static inputs/);
  assert.throws(() => validateReproducibilityReport({
    ...validReportInput(),
    sourceCommitManifestSha256: '0'.repeat(64),
  }), /source commit/);

  const gasDrift = clone(validReport);
  gasDrift.localGas.contracts[1] = clone(gasDrift.localGas.contracts[0]);
  assert.throws(() => validateReproducibilityReport(validReportInput(gasDrift)), /local gas evidence/);
});

test('release verifier keeps Forge artifacts outside Git and preserves the contract source namespace', () => {
  const args = buildForgeBase({
    forgeRoot: '/tmp/hookemon-forge-root',
    contractsRoot: '/checkout/packages/contracts',
    v4CorePath: '/deps/v4-core',
    solcBinary: '/tools/solc',
  });
  assert.deepEqual(args.slice(0, 8), [
    'test', '--offline', '--use', '/tools/solc', '--root', '/checkout/packages/contracts',
    '--config-path', '/checkout/packages/contracts/foundry.toml',
  ]);
  assert.equal(args.includes('--contracts'), false);
  assert.equal(args[args.indexOf('--out') + 1], '/tmp/hookemon-forge-root/out');
  assert.equal(args[args.indexOf('--cache-path') + 1], '/tmp/hookemon-forge-root/cache');
  assert.ok(args.includes('/checkout/packages/contracts/foundry.toml'));
  assert.equal(args.includes('--test'), false);
  assert.ok(args.includes('@uniswap/v4-core/=/deps/v4-core/'));
  assert.ok(args.includes('--evm-version'));
  assert.ok(args.includes('cancun'));
  assert.ok(args.includes('--optimizer-runs'));
  assert.ok(args.includes('20000'));
  assert.equal(args.includes('CanonicalMarket'), false);
  const verifierSource = readFileSync(resolve(root, 'scripts/verify-phase1-release.mjs'), 'utf8');
  assert.match(verifierSource, /'test\/integration\/PhaseOneLocalLoop\.t\.sol'/);
  assert.match(verifierSource, /'test\/invariant\/PhaseOneReleaseInvariant\.t\.sol'/);
});

test('Forge scratch cleanup survives body and post-check failures despite hostile TMPDIR', () => {
  const prior = process.env.TMPDIR;
  process.env.TMPDIR = root;
  let scratch;
  try {
    assert.throws(() => withNonGitForgeRoot(root, (forgeRoot) => {
      scratch = forgeRoot;
      throw new Error('config write failed');
    }, () => {
      throw new Error('post-check failed');
    }), /post-check failed/);
    assert.equal(scratch.startsWith(`${root}/`), false);
    assert.equal(existsSync(scratch), false);
  } finally {
    if (prior === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = prior;
  }
});

test('release verifier accepts only absolute regular non-symlink executables', () => {
  assert.throws(() => requireAbsoluteRegularFile('relative/tool'), /absolute/);
  const nodeBinary = realpathSync(process.execPath);
  const temporary = mkdtempSync(resolve(realpathSync('/tmp'), 'hookemon-release-bin-test-'));
  const link = resolve(temporary, 'node-link');
  try {
    symlinkSync(nodeBinary, link);
    assert.throws(() => requireAbsoluteRegularFile(link), /regular non-symlink/);
    assert.equal(requireAbsoluteRegularFile(nodeBinary), nodeBinary);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
