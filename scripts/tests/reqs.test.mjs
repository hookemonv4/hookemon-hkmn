import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addRequirement, listRequirements, taskEvidenceContext, traceCheck,
} from '../lib/reqs.mjs';
import { openLedger, addTask, claimTask, completeTask } from '../lib/ledger.mjs';
import { addReceipt } from '../lib/receipts.mjs';
import { hashFile, sha256, writeJson } from '../lib/util.mjs';
import { checkGate, overrideGate } from '../lib/gates.mjs';
import { overrideSubjectInputs, writeOwnerApproval } from './helpers/owner-approval.mjs';
import {
  computeManifestDigest,
  parsePinnedLiquidityLauncherFacts,
  parsePinnedOfficialBindingFacts,
  resolveReleaseManifestCheckout,
  validateInterfaceFreeze,
  parseVerifierInvocation,
  validateDeclaredGitlinkCoverage,
  validateDistinctBuildCheckouts,
  validateCustodyArtifact,
  validateManifest,
  validatePhase3BindingEvidence,
  validatePinnedOfficialBindingFacts,
  validateReproducibleReleaseArtifacts,
  validateTrackedLocalProof,
} from '../../feasibility/verify-robinhood-binding.mjs';

test('Phase 3 process claims use a strict six-hour window without changing the policy spend ledger', () => {
  const requirements = JSON.parse(readFileSync(join(projectRoot, 'specs', 'requirements.json'), 'utf8'));
  const interfaces = JSON.parse(readFileSync(join(projectRoot, 'architecture', 'interfaces.json'), 'utf8'));
  const processClaimRequirement = requirements.requirements.find(
    ({ id }) => id === 'REQ-operations-wallet-2',
  );

  assert.equal(requirements.revision, 65);
  assert.match(processClaimRequirement.statement, /strictly less than 21600 seconds/);
  assert.match(processClaimRequirement.statement, /exactly 21600 seconds old is expired/);
  assert.match(processClaimRequirement.statement, /after 21600 seconds/);
  assert.equal(interfaces.processClaims.window.seconds, 21600);
  assert.equal(interfaces.processClaims.window.inclusion, 'block.timestamp - claimedAt < 21600');
  assert.match(interfaces.processClaims.treasuryControls.setProcessClaimLimit, /after-21600s/);
  assert.ok(interfaces.policyEngine.controls.includes('rolling-24h-spend'));
});

test('canonical market ignores hook data without deriving buyer credit', () => {
  const requirements = JSON.parse(readFileSync(join(projectRoot, 'specs', 'requirements.json'), 'utf8'));
  const canonicalMarketRequirement = requirements.requirements.find(
    ({ id }) => id === 'REQ-canonical-market-6',
  );

  assert.equal(requirements.revision, 65);
  assert.match(canonicalMarketRequirement.statement, /hookData.*ignored/i);
  assert.doesNotMatch(canonicalMarketRequirement.statement, /buyerHkmnCredit/);
  assert.doesNotMatch(canonicalMarketRequirement.measurement, /buyerHkmnCredit/);
});

test('revision 65 carries full-supply canonical allocation and preserves bridge settlement, standing authority, explicit configuration, split launch, and payout durability', () => {
  const requirements = JSON.parse(readFileSync(join(projectRoot, 'specs', 'requirements.json'), 'utf8'));
  const interfaces = JSON.parse(readFileSync(join(projectRoot, 'architecture', 'interfaces.json'), 'utf8'));
  const provisional = JSON.parse(readFileSync(join(projectRoot, 'architecture', 'provisional-interfaces.json'), 'utf8'));
  const capabilityMap = JSON.parse(readFileSync(join(projectRoot, 'architecture', 'capability-map.json'), 'utf8'));
  const failureMatrix = JSON.parse(readFileSync(join(projectRoot, 'docs', 'audit', '2026-09-04', 'failure-matrix.json'), 'utf8'));
  const byId = new Map(requirements.requirements.map((requirement) => [requirement.id, requirement]));

  assert.equal(requirements.revision, 65);
  assert.equal(interfaces.requirementsRevision, 65);
  assert.equal(interfaces.architectureRevision, 9);
  assert.equal(provisional.requirementsRevision, 65);
  assert.equal(provisional.architectureRevision, 9);
  assert.equal(capabilityMap.requirementsRevision, 65);
  assert.equal(capabilityMap.architectureRevision, 9);
  assert.deepEqual(interfaces.cycleExecution.stages, [
    'eligibility-snapshot', 'claim-process', 'outbound', 'purchase', 'open',
    'epic-gate', 'buyback', 'return', 'payout',
  ]);
  assert.deepEqual(interfaces.cycleExecution.providerAttempt, {
    schema: 'hookemon.provider-mutation-attempt.v2',
    states: ['PREPARED', 'NOT_SENT', 'SENT_UNKNOWN', 'RESPONSE_RECORDED', 'RECONCILED'],
    transitions: [
      'PREPARED -> NOT_SENT -> PREPARED',
      'PREPARED -> SENT_UNKNOWN -> RESPONSE_RECORDED -> RECONCILED',
      'PREPARED -> RESPONSE_RECORDED -> RECONCILED',
    ],
    notSent: 'pre-call failure; retryable before provider contact',
    sentUnknown: 'post-send ambiguity; observation-only and never resent',
  });
  assert.deepEqual(interfaces.cycleExecution.chainAttempt, {
    schema: 'hookemon.chain-transaction-attempt.v2',
    states: ['PREPARED', 'SIGNED', 'BROADCAST', 'FINALIZED', 'REFUSED'],
    preparedFields: ['requestDigest', 'policyDigest', 'fencingToken'],
    signedFields: ['rawSignedBytesHash', 'nonceOrBlockhash', 'txHash', 'approvedSemanticsDigest'],
    storedSignedBytes: 'immutable retrievable content-addressed bytes',
    transitions: ['PREPARED -> SIGNED -> BROADCAST -> FINALIZED', 'PREPARED -> REFUSED'],
    refusedFields: ['reason', 'fencingToken'],
    consumers: ['signer-wrapper', 'payout', 'relay-stages', 'collector-handlers'],
    restart: 'revalidate persisted approvedSemanticsDigest before any rebroadcast',
  });
  assert.deepEqual(interfaces.cycleExecution.purchaseRequest, {
    schema: 'hookemon.purchase-request.v1',
    persistence: 'persisted before signing',
    fields: {
      unitPriceAtomic: 'TypedAmount',
      quantity: 'positive-integer-string',
      totalAtomic: 'TypedAmount',
      boundedOverheadAtomic: 'TypedAmount',
    },
    invariants: [
      'totalAtomic.amountAtomic equals unitPriceAtomic.amountAtomic multiplied by quantity',
      'policy reserves totalAtomic plus boundedOverheadAtomic',
      'all money fields use the existing typed amount shape',
    ],
  });
  assert.deepEqual(interfaces.cycleExecution.cycleMode, {
    values: ['production', 'rehearsal'],
    persistence: 'stored in CycleRepository at creation and immutable for the cycle',
    isolation: 'production services refuse rehearsal cycles and rehearsal services refuse production cycles',
  });
  assert.deepEqual(interfaces.cycleExecution.relaySettlement, {
    schema: 'hookemon.relay-leg.v1',
    directions: ['outbound', 'return'],
    recordFields: [
      'cycleId', 'direction', 'relayRequestId', 'quoteDigest',
      'sourceChainId', 'sourceTxHash', 'sourceAssetId', 'sourceDecimals', 'sourceAmountAtomic',
      'destinationChainId', 'destinationTxHash', 'destinationAssetId', 'destinationDecimals',
      'destinationAmountAtomic', 'finalizedAtSource', 'finalizedAtDestination', 'netDeltaAtomic',
    ],
    amountEncoding: 'source and destination amounts are TypedAmount fields split into their named components; netDeltaAtomic is an integer string in destination-asset units',
    transactionHashUniqueness: 'each sourceTxHash and destinationTxHash attributes to exactly one RelayLegV1 across all cycles and directions',
    settlement: 'SETTLED only after this process observes both finalized chain deltas through its own RPC clients and attributes the destination delta by matching amount, time window, and memo or relayRequestId; Relay status alone never settles a leg',
    terminalRecoveryStates: [
      'HELD_RELAY_PARTIAL', 'HELD_RELAY_REFUND', 'HELD_RELAY_LATE', 'HELD_RELAY_WRONG_ASSET',
    ],
    fundingIsolation: 'outbound uses only the cycle claimed principal; return uses only the cycle-attributed proceeds delta',
  });
  assert.deepEqual(interfaces.cycleExecution.standingAuthority, {
    record: 'StandingAuthorityDecisionV1',
    fields: ['authorityDigest', 'verifiedAt', 'intentDigest', 'dayCapReservation', 'nonceReservation'],
    firstUse: 'check wall-clock expiry and atomically persist the decision with its day-cap and nonce reservations before any signable action',
    expiry: 'an expired authority is refused at first use',
    replay: 'replaying the persisted decision is idempotent and cannot reserve a second cap or nonce',
  });
  assert.deepEqual(interfaces.amount.minimaAndGasCaps, {
    moneyMinimums: 'every money minimum is an explicit TypedAmount',
    productionReturnMinimum: {
      chainId: 4663, assetId: 'USDG', decimals: 6, amountAtomic: '0',
    },
    requiredGasCaps: [
      'evmPerTransactionGasPriceCap', 'evmNativeReserve',
      'solanaPriorityFeeCap', 'solanaLamportReserve',
    ],
    placeholderAtomicAmount: {
      value: '1', status: 'configuration-error',
    },
  });
  assert.deepEqual(interfaces.launch.atomicity, {
    providerGraphTransaction: {
      atomic: true,
      targets: ['token', 'custody', 'hook'],
      steps: [
        'deploy three targets', 'allocate complete HKMN supply via token.allocate(hook)', 'configure custody',
        'initialize pool at fixed price', 'stamp launch',
      ],
    },
    ownerSeedTransaction: {
      atomic: true,
      steps: [
        'Permit2 pull at most 240000000 atomic USDG', 'PositionManager mint full HKMN allocation to custody', 'return unused USDG to payer',
      ],
      failure: 'roll back seed-local state only and allow retry',
    },
    preSeed: {
      hookHkmn: 'the complete HKMN allocation is held at the hook and non-transferable to every other recipient until seed succeeds',
      swaps: 'unavailable because the initialized pool has no liquidity',
    },
  });
  assert.deepEqual(interfaces.payout.durability, {
    walletNonceLock: 'one repository-backed lock covers claim, outbound, return, and payout',
    signedRecords: 'SIGNED records remain durable and recoverable after restart',
    droppedBroadcast: 'resolve by receipt search or replacement using the same nonce and calldata',
    frozenRecipient: 'quarantine the liability without blocking the rest of the manifest',
    dustCarry: 'persist and atomically consume provenance-bound carry between cycles',
  });
  assert.deepEqual(interfaces.transactionPolicy.wireSchema, {
    id: 'hookemon.transaction-policy.v1',
    version: 1,
    authority: 'the runner canonical validator is authoritative',
    canonicalValidator: 'packages/runner/src/cycle/money-schemas.mjs#assertTransactionPolicy',
    adapterDecoder: 'must emit the identical canonical schema',
  });
  assert.deepEqual(interfaces.processClaims.rotation, {
    immutableConstructorInput: true,
    productionDelaySeconds: 43200,
    processClaimMaxCountHardCap: 64,
    xmax: { chainId: 4663, assetId: 'USDG', decimals: 6, amountAtomic: '500000000000' },
    pendingOperationsCancellation: 'forbidden',
    treasuryReschedule: 'requires a new Treasury intent and starts a new delay',
  });
  assert.match(byId.get('REQ-cycle-repository-1').statement, /NOT_SENT/);
  assert.match(byId.get('REQ-cycle-repository-1').statement, /approvedSemanticsDigest/);
  assert.match(byId.get('REQ-cycle-repository-1').statement, /RelayLegV1/);
  assert.match(byId.get('REQ-cycle-repository-1').statement, /StandingAuthorityDecisionV1/);
  assert.match(byId.get('REQ-cycle-runner-3').statement, /eligibility-snapshot/);
  assert.match(byId.get('REQ-cycle-runner-3').statement, /cycle-attributed proceeds delta/);
  assert.match(byId.get('REQ-policy-engine-1').statement, /quantity multiplied by unitPriceAtomic/);
  assert.match(byId.get('REQ-policy-engine-1').statement, /production return minimum/);
  assert.match(byId.get('REQ-transaction-policy-1').statement, /gas cap/);
  assert.match(byId.get('REQ-operations-wallet-2').statement, /43200 seconds/);
  assert.match(byId.get('REQ-operations-wallet-2').statement, /500000 USDG/);
  assert.match(byId.get('REQ-operations-wallet-2').statement, /processClaimMaxCount.*64/);
  assert.match(byId.get('REQ-launch-orchestration-1').statement, /provider graph transaction/);
  assert.match(byId.get('REQ-launch-orchestration-2').statement, /separate owner-signed seed transaction/);
  assert.match(byId.get('REQ-direct-payout-1').statement, /receipt search/);
  assert.equal(byId.get('REQ-collector-crypt-adapter-1').status, 'approved');
  assert.match(byId.get('REQ-collector-crypt-adapter-1').statement, /tiers are numeric 1 through 4/);
  for (const id of [
    'REQ-process-budget-1', 'REQ-process-budget-2', 'REQ-process-budget-3',
    'REQ-process-budget-4', 'REQ-process-budget-5', 'REQ-process-budget-6',
    'REQ-payout-commitment-1', 'REQ-payout-commitment-2', 'REQ-payout-commitment-3',
    'REQ-payout-commitment-4', 'REQ-payout-commitment-5', 'REQ-payout-commitment-6',
    'REQ-payout-commitment-7', 'REQ-payout-commitment-8',
    'REQ-holder-settlement-1', 'REQ-holder-settlement-2', 'REQ-holder-settlement-3',
    'REQ-holder-settlement-4', 'REQ-holder-settlement-5', 'REQ-holder-settlement-6',
    'REQ-holder-settlement-7', 'REQ-cycle-runner-1', 'REQ-cycle-runner-2',
    'REQ-cycle-control-1', 'REQ-cycle-control-2', 'REQ-distribution-1', 'REQ-distribution-2',
  ]) {
    assert.equal(byId.get(id).status, 'superseded', id);
  }
  const preCallFailure = failureMatrix.cells.find(
    (cell) => cell.system === 'Provider mutation' && cell.failureClass === 'pre-call-failure',
  );
  assert.deepEqual(preCallFailure, {
    system: 'Provider mutation',
    failureClass: 'pre-call-failure',
    expectedTerminalState: null,
    expectedAttemptState: 'NOT_SENT',
    expectedNextStage: 'retry',
    owningWp: 'WP07-0',
    test: 'packages/adapters/test/app/stage-driver.test.mjs — persists NOT_SENT before an injected capability and retries the same request after reopen',
  });
  for (const cell of failureMatrix.cells.filter(({ expectedTerminalState }) => expectedTerminalState?.startsWith('HELD_'))) {
    assert.equal(cell.expectedNextStage, 'owner-decision', `${cell.system}: ${cell.failureClass}`);
  }
  assert.deepEqual(
    failureMatrix.cells.filter((cell) => cell.system === 'Relay leg'),
    [
      {
        system: 'Relay leg', failureClass: 'partial-finalized-delta',
        expectedTerminalState: 'HELD_RELAY_PARTIAL', expectedAttemptState: 'FINALIZED',
        expectedNextStage: 'owner-decision', owningWp: 'WP07',
        test: 'packages/adapters/test/app/cycle-repository.test.mjs — settleRelayLeg holds a wrong-amount return receipt as HELD_RELAY_PARTIAL after reopen',
      },
      {
        system: 'Relay leg', failureClass: 'refund-finalized-delta',
        expectedTerminalState: 'HELD_RELAY_REFUND', expectedAttemptState: 'FINALIZED',
        expectedNextStage: 'owner-decision', owningWp: 'WP07',
        test: 'packages/adapters/test/app/cycle-repository.test.mjs — settleRelayLeg holds a process-RPC origin refund credit after reopen without a second settlement',
      },
      {
        system: 'Relay leg', failureClass: 'late-finalized-delta',
        expectedTerminalState: 'HELD_RELAY_LATE', expectedAttemptState: 'FINALIZED',
        expectedNextStage: 'owner-decision', owningWp: 'WP07',
        test: 'packages/adapters/test/app/cycle-repository.test.mjs — settleRelayLeg holds a late return receipt as HELD_RELAY_LATE after reopen',
      },
      {
        system: 'Relay leg', failureClass: 'wrong-asset-finalized-delta',
        expectedTerminalState: 'HELD_RELAY_WRONG_ASSET', expectedAttemptState: 'FINALIZED',
        expectedNextStage: 'owner-decision', owningWp: 'WP07',
        test: 'packages/adapters/test/app/cycle-repository.test.mjs — settleRelayLeg holds a wrong-token or wrong-recipient return receipt as HELD_RELAY_WRONG_ASSET after reopen',
      },
    ],
  );
});

test('Robinhood reproducible-build invocation accepts only the documented argument order', () => {
  assert.deepEqual(
    parseVerifierInvocation([
      'node',
      'feasibility/verify-robinhood-binding.mjs',
      'bindings/robinhood-chain.json',
      '--reproducible-build',
      'CHECKOUT_A',
      'CHECKOUT_B',
    ]),
    {
      manifestPath: 'bindings/robinhood-chain.json',
      mode: 'reproducible-build',
      checkouts: ['CHECKOUT_A', 'CHECKOUT_B'],
    },
  );
  assert.throws(
    () => parseVerifierInvocation(['node', 'feasibility/verify-robinhood-binding.mjs', '--reproducible-build', 'CHECKOUT_A', 'CHECKOUT_B']),
    /usage: node feasibility\/verify-robinhood-binding\.mjs bindings\/robinhood-chain\.json --reproducible-build CHECKOUT_A CHECKOUT_B/,
  );
  assert.throws(
    () => parseVerifierInvocation(['node', 'feasibility/verify-robinhood-binding.mjs', 'bindings/robinhood-chain.json', '--reproducible-build', 'CHECKOUT_A']),
    /usage:/,
  );
});

test('Robinhood reproducible-build routes directly to clean checkout builds', () => {
  const invoker = mkdtempSync(join(tmpdir(), 'robinhood-repro-invoker-'));
  assert.throws(
    () => execFileSync(process.execPath, [
      join(projectRoot, 'feasibility', 'verify-robinhood-binding.mjs'),
      join(projectRoot, 'bindings', 'robinhood-chain.json'),
      '--reproducible-build',
      'CHECKOUT_A',
      'CHECKOUT_B',
    ], { cwd: invoker, encoding: 'utf8', stdio: 'pipe' }),
    /CHECKOUT_A is not a Git checkout/,
  );
});

test('Robinhood build pin declarations require every root and nested Gitlink exactly once', () => {
  const paths = [
    'packages/contracts/lib/v4-core',
    'packages/contracts/lib/v4-periphery',
    'packages/contracts/lib/liquidity-launcher',
    'packages/contracts/lib/uerc20-factory',
    'packages/contracts/lib/v4-core/lib/solmate',
    'packages/contracts/lib/v4-periphery/lib/permit2',
    'packages/contracts/lib/v4-core/lib/openzeppelin-contracts',
  ];
  assert.doesNotThrow(() => validateDeclaredGitlinkCoverage(paths.map((path) => ({ path }))));
  assert.throws(
    () => validateDeclaredGitlinkCoverage(paths.slice(0, -1).map((path) => ({ path }))),
    /Gitlink declarations must be exactly/,
  );
  assert.throws(
    () => validateDeclaredGitlinkCoverage([...paths, 'packages/contracts/lib/v4-core/lib/forge-std'].map((path) => ({ path }))),
    /Gitlink declarations must be exactly/,
  );
});

test('Robinhood reproducible builds require two distinct canonical Git working trees', () => {
  const first = proj();
  const second = proj();
  assert.deepEqual(validateDistinctBuildCheckouts(first, second), [realpathSync(first), realpathSync(second)]);
  assert.throws(
    () => validateDistinctBuildCheckouts(first, first),
    /distinct Git working trees/,
  );

  const aliasRoot = mkdtempSync(join(tmpdir(), 'robinhood-repro-alias-'));
  const alias = join(aliasRoot, 'checkout');
  symlinkSync(first, alias, 'dir');
  assert.throws(
    () => validateDistinctBuildCheckouts(first, alias),
    /distinct Git working trees/,
  );
});

test('Robinhood reproducible builds consume the canonical release manifest path', () => {
  const root = proj();
  mkdirSync(join(root, 'bindings'), { recursive: true });
  writeFileSync(join(root, 'bindings', 'robinhood-chain.json'), '{}\n');
  execFileSync('git', ['-C', root, 'add', 'bindings/robinhood-chain.json']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'fixture binding']);

  assert.equal(
    resolveReleaseManifestCheckout(join(root, 'bindings', 'robinhood-chain.json')),
    realpathSync(root),
  );
  assert.throws(
    () => resolveReleaseManifestCheckout(join(root, 'specs', 'requirements.json')),
    /canonical bindings\/robinhood-chain\.json/,
  );
});

test('Robinhood reproduced artifacts must match the bound release commit and bytecode', () => {
  const manifestDigest = `sha256:${'11'.repeat(32)}`;
  const reproducibleBuild = JSON.parse(
    readFileSync(join(projectRoot, 'feasibility', 'interface-freeze.json'), 'utf8'),
  ).proofCoverage.reproducibleBuild;
  const expectedBytecode = {
    historicalRevision54: structuredClone(reproducibleBuild.historicalRevision54.bytecode),
    compilerTemplates: structuredClone(reproducibleBuild.compilerTemplates),
  };
  const release = { head: '66'.repeat(20), manifestDigest, expectedBytecode };
  const checkout = {
    head: release.head,
    manifestDigest,
    freezeManifestDigest: manifestDigest,
    bytecode: {
      ...structuredClone(expectedBytecode.historicalRevision54),
      PegCycleVault: {
        ...structuredClone(expectedBytecode.compilerTemplates.PegCycleVault),
        concreteRuntimeEvidence: 'BOUND_SEPARATELY_IN_LOCAL_CANDIDATE',
      },
    },
  };
  assert.doesNotThrow(
    () => validateReproducibleReleaseArtifacts(release, checkout, structuredClone(checkout)),
  );

  const wrongHead = structuredClone(checkout);
  wrongHead.head = '77'.repeat(20);
  assert.throws(
    () => validateReproducibleReleaseArtifacts(release, checkout, wrongHead),
    /release commit mismatch/,
  );

  const wrongManifest = structuredClone(checkout);
  wrongManifest.manifestDigest = `sha256:${'66'.repeat(32)}`;
  assert.throws(
    () => validateReproducibleReleaseArtifacts(release, wrongManifest, checkout),
    /release manifest digest mismatch/,
  );

  const wrongFreeze = structuredClone(checkout);
  wrongFreeze.freezeManifestDigest = `sha256:${'77'.repeat(32)}`;
  assert.throws(
    () => validateReproducibleReleaseArtifacts(release, wrongFreeze, checkout),
    /freeze manifest digest mismatch/,
  );

  const mutuallyWrongBytecode = structuredClone(checkout);
  mutuallyWrongBytecode.bytecode.RobinhoodBindings.runtimeSha256 = `sha256:${'88'.repeat(32)}`;
  assert.throws(
    () => validateReproducibleReleaseArtifacts(
      release,
      mutuallyWrongBytecode,
      structuredClone(mutuallyWrongBytecode),
    ),
    /recorded release bytecode/,
  );

  const wrongTemplate = structuredClone(checkout);
  wrongTemplate.bytecode.PegCycleVault.runtimeTemplateSha256 = `sha256:${'99'.repeat(32)}`;
  assert.throws(
    () => validateReproducibleReleaseArtifacts(release, wrongTemplate, checkout),
    /recorded release bytecode/,
  );

  const wrongExpectedStatus = structuredClone(release);
  wrongExpectedStatus.expectedBytecode.compilerTemplates.PegCycleVault.concreteRuntimeEvidence =
    'BOUND_SEPARATELY_IN_LOCAL_CANDIDATE';
  assert.throws(
    () => validateReproducibleReleaseArtifacts(wrongExpectedStatus, checkout, structuredClone(checkout)),
    /pending commit-bound evidence/,
  );

  const wrongGeneratedStatus = structuredClone(checkout);
  wrongGeneratedStatus.bytecode.PegCycleVault.concreteRuntimeEvidence =
    'PENDING_COMMIT_BOUND_EVIDENCE';
  assert.throws(
    () => validateReproducibleReleaseArtifacts(release, wrongGeneratedStatus, checkout),
    /bound separately in local candidate/,
  );
});

const here = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(here, '../..');
function proj() {
  const root = mkdtempSync(join(tmpdir(), 'v4-'));
  mkdirSync(join(root, 'specs'), { recursive: true });
  writeJson(join(root, 'specs', 'requirements.json'), { revision: 0, requirements: [] });
  execFileSync('git', ['-C', root, 'init', '--quiet']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Hookemon']);
  execFileSync('git', ['-C', root, 'config', 'user.email', '312745360+hookemonv4@users.noreply.github.com']);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'fixture']);
  return root;
}

function head(root) {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function addCoreRequirement(root) {
  return addRequirement(root, {
    id: 'REQ-core-1', kind: 'functional', title: 't', statement: 's', measurement: 'm', module: 'core',
  });
}

function writeTasks(root, tasks) {
  writeJson(join(root, 'tasks.json'), { generatedAt: '2026-08-30T00:00:00.000Z', tasks });
}

function task(overrides = {}) {
  const projected = {
    id: 'T1', title: 'task', phase: 'build', risk: 'ordinary', deps: [], reqs: [], status: 'ready',
    ...overrides,
  };
  return projected;
}

function doneTask(root, overrides = {}) {
  return task({ status: 'done', commitSha: head(root), ...overrides });
}

function deferredTask(root, overrides = {}) {
  const id = overrides.id ?? 'P1-011';
  const rationale = 'Owner deferred this task to a later product phase';
  const descriptorInput = `decisions/task-deferrals/${id}.json`;
  const approvalInput = `decisions/owner-approvals/${id.toLowerCase()}-defer.json`;
  const prestate = {
    id,
    title: overrides.title ?? 'deferred task',
    phase: overrides.phase ?? 'build',
    risk: overrides.risk ?? 'ordinary',
    deps: overrides.deps ?? [],
    reqs: overrides.reqs ?? ['REQ-core-1'],
    status: 'ready',
    leaseToken: 0,
    completionCommit: null,
  };
  const prestateFingerprint = sha256(Buffer.from(JSON.stringify(prestate)));
  const policyPath = join(root, 'policy', 'policy.json');
  writeJson(policyPath, {
    protocol: [],
    autonomy: {
      askFirst: ['Terminally deferring a task'],
      never: ['Approve your own work on behalf of the owner'],
    },
  });
  const decisionPath = 'decisions/ADR-0018-manual-one-cycle-phase-boundary.md';
  const designPath = 'docs/superpowers/specs/2026-08-31-manual-one-cycle-design.md';
  writeJson(join(root, decisionPath), { approved: true });
  writeJson(join(root, designPath), { approved: true });
  const requirementsPath = join(root, 'specs', 'requirements.json');
  const requirements = JSON.parse(readFileSync(requirementsPath, 'utf8'));
  writeJson(join(root, descriptorInput), {
    schema: 'v4-task-deferral-v1',
    action: 'TASK_DEFER',
    taskId: id,
    phase: prestate.phase,
    targetStatus: 'deferred',
    rationale,
    prestate,
    prestateFingerprint,
    requirements: {
      path: 'specs/requirements.json',
      revision: requirements.revision,
      sha256: hashFile(requirementsPath),
    },
    decision: { path: decisionPath, sha256: hashFile(join(root, decisionPath)) },
    design: { path: designPath, sha256: hashFile(join(root, designPath)) },
  });
  writeOwnerApproval(root, approvalInput, {
    action: 'TASK_DEFER', phase: prestate.phase, itemId: id, rationale,
  }, ['policy/policy.json', descriptorInput]);
  return task({
    ...overrides,
    id,
    title: prestate.title,
    phase: prestate.phase,
    risk: prestate.risk,
    deps: prestate.deps,
    reqs: prestate.reqs,
    status: 'deferred',
    deferApproval: approvalInput,
    deferDescriptor: descriptorInput,
    deferPrestateFingerprint: prestateFingerprint,
  });
}

function addTasksGate(root, result = 'PASSED') {
  if (result === 'PASSED') {
    writeJson(join(root, 'gates', 'tasks.json'), { id: 'tasks', version: 1, items: [] });
    return checkGate(root, 'tasks').receipt;
  }
  writeJson(join(root, 'gates', 'tasks.json'), {
    id: 'tasks', version: 1, items: [{
      id: 'T-GATE', text: 'blocked', receiptType: 'evidence',
      evidencePolicy: {
        authority: 'SYSTEM', requiredInputs: ['tasks.json'], requiredPrefixes: [],
        allowedInputs: ['tasks.json'], allowedPrefixes: [],
      },
    }],
  });
  writeJson(join(root, 'gates', 'runs', 'tasks.json'), {
    items: { 'T-GATE': { status: 'ESCALATE' } },
  });
  writeJson(join(root, 'policy', 'policy.json'), {
    protocol: ["Every gate is owner-overridable. An override needs the owner's explicit rationale and is recorded as a receipt. Nothing external to the owner may block this project."],
    autonomy: { never: ['Approve your own work on behalf of the owner'] },
  });
  const rationale = 'owner explicitly accepts the risk';
  const approval = 'decisions/owner-approvals/tasks-override.json';
  writeOwnerApproval(root, approval, {
    action: 'GATE_OVERRIDE', phase: 'tasks', itemId: null, rationale,
  }, overrideSubjectInputs(root, 'tasks'));
  return overrideGate(root, 'tasks', rationale, approval);
}

function legacyLedgerWithTask(root, projectedTask) {
  const db = openLedger(root);
  addTask(db, projectedTask);
  if (projectedTask.status === 'done') {
    const { token } = claimTask(db, projectedTask.id, 'worker');
    completeTask(db, projectedTask.id, 'worker', token, projectedTask.commitSha);
  }
  return db;
}

function addTaskEvidenceReceipt(root, overrides = {}) {
  const context = taskEvidenceContext(root, 'T1');
  const inputs = Object.hasOwn(overrides, 'inputs')
    ? overrides.inputs
    : ['artifact.txt', ...context.inputs];
  return addReceipt(root, {
    type: 'evidence', phase: context.phase, result: 'PASSED',
    data: context.data, inputs,
    ...overrides,
    data: { ...context.data, ...overrides.data },
  });
}

test('typed requirements with stable ids and revision bump', () => {
  const root = proj();
  const r = addRequirement(root, { id: 'REQ-core-1', kind: 'functional', title: 'status output',
    statement: 'Given receipts exist, when v4 status runs, then STATE.md reflects them', measurement: 'cli test', module: 'core' });
  assert.equal(r.id, 'REQ-core-1');
  assert.throws(() => addRequirement(root, { id: 'REQ-core-1', kind: 'functional', title: 'dup', statement: 'x', measurement: 'y', module: 'core' }), /unique/);
  assert.throws(() => addRequirement(root, { id: 'REQ-core-2', kind: 'vibes', title: 'x', statement: 'x', measurement: 'y', module: 'core' }), /kind/);
  assert.equal(listRequirements(root).length, 1);
});

test('traceCheck does not require task coverage during the spec phase', () => {
  const root = proj();
  addCoreRequirement(root);
  const db = openLedger(root);

  assert.deepEqual(traceCheck(root, db).gaps, []);
});

test('traceCheck requires requirement coverage after a fresh tasks gate passes', () => {
  const root = proj();
  addCoreRequirement(root);
  const db = legacyLedgerWithTask(root, task({ reqs: ['REQ-core-1'] }));
  writeTasks(root, [task()]);
  addTasksGate(root);

  assert.deepEqual(
    traceCheck(root, db).gaps,
    [
      'T1: active task needs at least one known requirement',
      'REQ-core-1: no task covers this requirement',
    ],
  );

  writeTasks(root, [task({ reqs: ['REQ-core-1'] })]);
  assert.deepEqual(traceCheck(root, db).gaps, []);
});

test('traceCheck requires coverage after an explicit fresh tasks override', () => {
  const root = proj();
  addCoreRequirement(root);
  const db = legacyLedgerWithTask(root, task({ reqs: ['REQ-core-1'] }));
  writeTasks(root, [task()]);
  addTasksGate(root, 'OVERRIDDEN');

  assert.deepEqual(
    traceCheck(root, db).gaps,
    [
      'T1: active task needs at least one known requirement',
      'REQ-core-1: no task covers this requirement',
    ],
  );
});

test('traceCheck does not treat a stale tasks override as authoritative', () => {
  const root = proj();
  addCoreRequirement(root);
  const db = openLedger(root);
  writeTasks(root, []);
  addTasksGate(root, 'OVERRIDDEN');
  writeJson(join(root, 'gates', 'tasks.json'), { id: 'tasks', version: 2, items: [] });

  assert.deepEqual(traceCheck(root, db).gaps, []);
});

test('traceCheck always rejects done projected tasks without evidence', () => {
  const root = proj();
  addCoreRequirement(root);
  const db = openLedger(root);
  writeTasks(root, [doneTask(root, { reqs: ['REQ-core-1'] })]);

  assert.deepEqual(
    traceCheck(root, db).gaps,
    ['T1: done without valid evidence receipt'],
  );
});

test('traceCheck rejects ghost requirement ids in projected tasks', () => {
  const root = proj();
  const projected = task({ reqs: ['REQ-ghost-1'] });
  const db = legacyLedgerWithTask(root, projected);
  writeTasks(root, [projected]);

  assert.deepEqual(
    traceCheck(root, db).gaps,
    ['T1: unknown requirement REQ-ghost-1'],
  );
});

test('traceCheck requires every active task to bind a known requirement', () => {
  const root = proj();
  addCoreRequirement(root);
  writeTasks(root, [task()]);

  assert.deepEqual(
    traceCheck(root).gaps,
    ['T1: active task needs at least one known requirement'],
  );
});

test('traceCheck rejects malformed task projections', () => {
  const root = proj();
  const db = openLedger(root);
  writeTasks(root, [{ id: '', phase: null, status: 'complete', reqs: 'REQ-core-1' }]);

  assert.match(traceCheck(root, db).gaps.join('\n'), /tasks\.json task 0:/);
});

test('traceCheck accepts owner-deferred tasks without evidence or active requirement coverage', () => {
  const root = proj();
  addCoreRequirement(root);
  const deferred = deferredTask(root);
  writeTasks(root, [
    task({ id: 'T1', reqs: ['REQ-core-1'] }),
    deferred,
  ]);
  addTasksGate(root);

  assert.deepEqual(traceCheck(root).gaps, []);
});

test('traceCheck rejects unknown requirements on deferred tasks', () => {
  const root = proj();
  addCoreRequirement(root);
  const deferred = deferredTask(root, { reqs: ['REQ-ghost-deferred'] });
  writeTasks(root, [deferred]);
  assert.match(traceCheck(root).gaps.join('\n'), /P1-011: unknown requirement REQ-ghost-deferred/);
});

test('traceCheck does not let a deferred task satisfy active requirement coverage', () => {
  const root = proj();
  addCoreRequirement(root);
  const deferred = deferredTask(root, { reqs: ['REQ-core-1'] });
  writeTasks(root, [deferred]);
  addTasksGate(root);

  assert.deepEqual(traceCheck(root).gaps, ['REQ-core-1: no task covers this requirement']);
});

test('traceCheck rejects malformed or stale deferred task authority', () => {
  const malformedRoot = proj();
  addCoreRequirement(malformedRoot);
  const malformed = deferredTask(malformedRoot);
  delete malformed.deferApproval;
  writeTasks(malformedRoot, [malformed]);
  assert.match(traceCheck(malformedRoot).gaps.join('\n'), /deferred task needs deferApproval/);

  const staleRoot = proj();
  addCoreRequirement(staleRoot);
  const stale = deferredTask(staleRoot);
  writeJson(join(staleRoot, stale.deferDescriptor), { stale: true });
  writeTasks(staleRoot, [stale]);
  assert.match(traceCheck(staleRoot).gaps.join('\n'), /task deferral descriptor must contain exactly/);

  const mismatchedRoot = proj();
  addCoreRequirement(mismatchedRoot);
  const mismatched = deferredTask(mismatchedRoot);
  mismatched.title = 'tampered projected title';
  writeTasks(mismatchedRoot, [mismatched]);
  assert.match(
    traceCheck(mismatchedRoot).gaps.join('\n'),
    /task deferral prestate title does not match projected task/,
  );
});

test('traceCheck rejects non-passing, unbound, stale, or inconsistent task evidence', () => {
  const cases = [
    {
      name: 'missing result',
      receipt: { result: null },
    },
    {
      name: 'failed result',
      receipt: { result: 'FAILED' },
    },
    {
      name: 'unbound evidence',
      receipt: { inputs: [] },
    },
    {
      name: 'wrong phase',
      receipt: { phase: 'spec' },
    },
    {
      name: 'wrong task',
      receipt: { data: { taskId: 'T2' } },
    },
    {
      name: 'commit mismatch',
      receipt: { data: { commitSha: '0'.repeat(40) } },
    },
  ];

  for (const c of cases) {
    const root = proj();
    addCoreRequirement(root);
    writeFileSync(join(root, 'artifact.txt'), 'v1');
    const projected = doneTask(root, { reqs: ['REQ-core-1'] });
    const db = legacyLedgerWithTask(root, projected);
    writeTasks(root, [projected]);
    addTaskEvidenceReceipt(root, c.receipt);

    assert.deepEqual(
      traceCheck(root, db).gaps,
      ['T1: done without valid evidence receipt'],
      c.name,
    );
  }

  const staleRoot = proj();
  addCoreRequirement(staleRoot);
  writeFileSync(join(staleRoot, 'artifact.txt'), 'v1');
  const projected = doneTask(staleRoot, { reqs: ['REQ-core-1'] });
  const db = legacyLedgerWithTask(staleRoot, projected);
  writeTasks(staleRoot, [projected]);
  addTaskEvidenceReceipt(staleRoot);
  writeFileSync(join(staleRoot, 'artifact.txt'), 'v2');

  assert.deepEqual(
    traceCheck(staleRoot, db).gaps,
    ['T1: done without valid evidence receipt'],
    'stale evidence',
  );
});

test('traceCheck accepts fresh passing input-bound task evidence', () => {
  const root = proj();
  addCoreRequirement(root);
  writeFileSync(join(root, 'artifact.txt'), 'verified output');
  const projected = doneTask(root, { reqs: ['REQ-core-1'] });
  const db = legacyLedgerWithTask(root, projected);
  writeTasks(root, [projected]);
  addTaskEvidenceReceipt(root);

  assert.deepEqual(traceCheck(root, db).gaps, []);
});

test('task evidence becomes invalid when the projected task definition changes', () => {
  const root = proj();
  addCoreRequirement(root);
  writeFileSync(join(root, 'artifact.txt'), 'verified output');
  const projected = doneTask(root, { reqs: ['REQ-core-1'] });
  writeTasks(root, [projected]);
  addTaskEvidenceReceipt(root);
  assert.deepEqual(traceCheck(root).gaps, []);

  writeTasks(root, [{ ...projected, title: 'redefined task', reqs: ['REQ-core-1'] }]);

  assert.deepEqual(traceCheck(root).gaps, ['T1: done without valid evidence receipt']);
});

test('Robinhood binding is revision-bound, content-addressed, and fail-closed', () => {
  const manifestPath = join(projectRoot, 'bindings', 'robinhood-chain.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const result = validateManifest(manifest);

  assert.equal(manifest.requirementsRevision, 54);
  assert.equal(manifest.architectureRevision, 3);
  assert.equal(manifest.schemaVersion, 'hookemon.robinhood-binding.v2');
  assert.deepEqual(manifest.phase3, {
    requirementsRevision: 65,
    architectureRevision: 9,
    status: 'INTEGRATION_PENDING',
    operationsWallet: '0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384',
    programmableBeneficiary: '0x4957f49620AFf3Adbbe8195a4f633E49cc93376c',
    permit2: {
      address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      runtimeCodeHash: '0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca',
      evidencePath: 'scripts/tests/fixtures/programmable/capabilities-4663.json',
      evidencePointer: '/chainDeployment/permit2GenesisProvenance',
      evidenceDigest: 'sha256:93200f4be1543da0ea876af1d91ff0cd4dc3da0b500f170b3d42731776be8568',
    },
  });
  assert.equal(manifest.chain.chainId, 4663);
  assert.equal(manifest.market.poolKey.staticLpFee, 0);
  assert.equal(manifest.market.hookFee.totalBasisPoints, 300);
  assert.equal(manifest.market.launchAllocationBasisPoints, 10_000);
  assert.equal(manifest.market.custody.proofStatus, 'PROVED_LOCALLY');
  assert.equal(manifest.productionReadiness.status, 'INTEGRATION_PENDING');
  assert.ok(manifest.productionReadiness.blockers.length > 0);
  assert.deepEqual(result.blockers, manifest.productionReadiness.blockers);
  assert.equal(computeManifestDigest(manifest), manifest.manifestDigest);
  assert.doesNotThrow(() => validatePhase3BindingEvidence(manifest, projectRoot));
});

test('Robinhood binding schema remains backward compatible while Phase 3 is exact', () => {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'bindings', 'robinhood-chain.json'), 'utf8'));
  const legacy = structuredClone(manifest);
  legacy.schemaVersion = 'hookemon.robinhood-binding.v1';
  delete legacy.phase3;
  legacy.manifestDigest = computeManifestDigest(legacy);
  assert.doesNotThrow(() => validateManifest(legacy));

  const versionOneWithPhase3 = structuredClone(manifest);
  versionOneWithPhase3.schemaVersion = 'hookemon.robinhood-binding.v1';
  versionOneWithPhase3.manifestDigest = computeManifestDigest(versionOneWithPhase3);
  assert.throws(() => validateManifest(versionOneWithPhase3), /manifest keys must be exactly/);

  const versionTwoWithoutPhase3 = structuredClone(manifest);
  delete versionTwoWithoutPhase3.phase3;
  versionTwoWithoutPhase3.manifestDigest = computeManifestDigest(versionTwoWithoutPhase3);
  assert.throws(() => validateManifest(versionTwoWithoutPhase3), /manifest keys must be exactly/);

  const mutations = [
    [(candidate) => { candidate.phase3.requirementsRevision = 60; }, /requirements revision/],
    [(candidate) => { candidate.phase3.architectureRevision = 6; }, /architecture revision/],
    [(candidate) => { candidate.phase3.status = 'READY'; }, /binding status/],
    [(candidate) => { candidate.phase3.operationsWallet = '0x0000000000000000000000000000000000000001'; }, /Operations wallet/],
    [(candidate) => { candidate.phase3.programmableBeneficiary = '0x0000000000000000000000000000000000000002'; }, /Programmable beneficiary/],
    [(candidate) => { candidate.phase3.permit2.address = '0x0000000000000000000000000000000000000003'; }, /Permit2 address/],
    [(candidate) => { candidate.phase3.permit2.runtimeCodeHash = `0x${'0'.repeat(64)}`; }, /Permit2 runtime/],
    [(candidate) => { candidate.phase3.permit2.evidencePath = 'feasibility/model.mjs'; }, /evidence path/],
    [(candidate) => { candidate.phase3.permit2.evidencePointer = '/chainDeployment/contracts/permit2'; }, /evidence pointer/],
    [(candidate) => { candidate.phase3.permit2.evidenceDigest = `sha256:${'0'.repeat(64)}`; }, /Permit2 evidence digest/],
    [(candidate) => { candidate.phase3.unreviewed = true; }, /phase3 keys must be exactly/],
    [(candidate) => { delete candidate.phase3.permit2.address; }, /phase3\.permit2 keys must be exactly/],
  ];
  for (const [mutate, expected] of mutations) {
    const candidate = structuredClone(manifest);
    mutate(candidate);
    candidate.manifestDigest = computeManifestDigest(candidate);
    assert.throws(() => validateManifest(candidate), expected);
  }
});

test('Robinhood binding pins every tracked local proof to the current tree', () => {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'bindings', 'robinhood-chain.json'), 'utf8'));
  assert.deepEqual(
    manifest.localProof.artifacts.map(({ path }) => path).sort(),
    [
      'feasibility/model.mjs',
      'packages/contracts/src/bindings/RobinhoodBindings.sol',
      'packages/contracts/test/bindings/RobinhoodBindings.t.sol',
      'packages/contracts/test/bindings/RobinhoodV4PoolManager.t.sol',
    ],
  );

  for (const artifact of manifest.localProof.artifacts) {
    assert.equal(
      `sha256:${hashFile(join(projectRoot, artifact.path))}`,
      artifact.sha256,
      artifact.path,
    );
  }
});

test('Robinhood binding writer deterministically refreshes proofs, manifest, and index', async () => {
  const { writeRobinhoodBinding } = await import('../../feasibility/write-robinhood-binding.mjs');
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'robinhood-binding-writer-'));
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'bindings', 'robinhood-chain.json'), 'utf8'));
  for (const artifact of manifest.localProof.artifacts) {
    mkdirSync(dirname(join(fixtureRoot, artifact.path)), { recursive: true });
    cpSync(join(projectRoot, artifact.path), join(fixtureRoot, artifact.path));
    artifact.sha256 = `sha256:${'0'.repeat(64)}`;
  }
  const evidencePath = manifest.phase3.permit2.evidencePath;
  mkdirSync(dirname(join(fixtureRoot, evidencePath)), { recursive: true });
  cpSync(join(projectRoot, evidencePath), join(fixtureRoot, evidencePath));
  manifest.manifestDigest = `sha256:${'0'.repeat(64)}`;
  writeJson(join(fixtureRoot, 'bindings', 'robinhood-chain.json'), manifest);
  writeJson(join(fixtureRoot, 'bindings', 'index.json'), { schemaVersion: 1, bindings: [] });

  const first = writeRobinhoodBinding(fixtureRoot);
  const firstManifestBytes = readFileSync(join(fixtureRoot, 'bindings', 'robinhood-chain.json'));
  const firstIndexBytes = readFileSync(join(fixtureRoot, 'bindings', 'index.json'));
  const generated = JSON.parse(firstManifestBytes);
  assert.equal(first.status, 'REGENERATED');
  assert.equal(generated.manifestDigest, computeManifestDigest(generated));
  assert.doesNotThrow(() => validateTrackedLocalProof(generated, fixtureRoot));

  const second = writeRobinhoodBinding(fixtureRoot);
  assert.equal(second.status, 'REGENERATED');
  assert.deepEqual(readFileSync(join(fixtureRoot, 'bindings', 'robinhood-chain.json')), firstManifestBytes);
  assert.deepEqual(readFileSync(join(fixtureRoot, 'bindings', 'index.json')), firstIndexBytes);
  assert.doesNotThrow(() => writeRobinhoodBinding(fixtureRoot, { check: true }));

  writeJson(join(fixtureRoot, 'bindings', 'index.json'), { schemaVersion: 1, bindings: [] });
  const staleIndexBytes = readFileSync(join(fixtureRoot, 'bindings', 'index.json'));
  assert.throws(
    () => writeRobinhoodBinding(fixtureRoot, { check: true }),
    /bindings\/index\.json is stale/,
  );
  assert.deepEqual(readFileSync(join(fixtureRoot, 'bindings', 'index.json')), staleIndexBytes);
});

test('architecture projection writer deterministically refreshes both Markdown digests', async () => {
  const { refreshArchitectureProjections } = await import(
    '../../feasibility/refresh-architecture-projections.mjs'
  );
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'architecture-projections-'));
  mkdirSync(join(fixtureRoot, 'architecture'), { recursive: true });
  for (const path of [
    'architecture/capability-map.json',
    'architecture/capability-map.md',
    'architecture/execution-topology.md',
  ]) cpSync(join(projectRoot, path), join(fixtureRoot, path));
  const capabilityMapPath = join(fixtureRoot, 'architecture/capability-map.json');
  const capabilityMap = JSON.parse(readFileSync(capabilityMapPath, 'utf8'));
  capabilityMap.projection.capabilityMapMarkdown.sha256 = '0'.repeat(64);
  capabilityMap.projection.executionTopologyMarkdown.sha256 = '0'.repeat(64);
  writeJson(capabilityMapPath, capabilityMap);

  const first = refreshArchitectureProjections(fixtureRoot);
  const firstBytes = readFileSync(capabilityMapPath);
  const generated = JSON.parse(firstBytes);
  assert.equal(first.status, 'REGENERATED');
  assert.equal(
    generated.projection.capabilityMapMarkdown.sha256,
    hashFile(join(fixtureRoot, 'architecture/capability-map.md')),
  );
  assert.equal(
    generated.projection.executionTopologyMarkdown.sha256,
    hashFile(join(fixtureRoot, 'architecture/execution-topology.md')),
  );
  refreshArchitectureProjections(fixtureRoot);
  assert.deepEqual(readFileSync(capabilityMapPath), firstBytes);
  assert.doesNotThrow(() => refreshArchitectureProjections(fixtureRoot, { check: true }));

  writeFileSync(join(fixtureRoot, 'architecture/execution-topology.md'), 'stale projection\n');
  const staleBytes = readFileSync(capabilityMapPath);
  assert.throws(
    () => refreshArchitectureProjections(fixtureRoot, { check: true }),
    /architecture\/capability-map\.json is stale/,
  );
  assert.deepEqual(readFileSync(capabilityMapPath), staleBytes);
});

test('Robinhood binding verifier rejects a recomputed manifest with a tampered local proof hash', () => {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'bindings', 'robinhood-chain.json'), 'utf8'));
  manifest.localProof.artifacts[0].sha256 = `sha256:${'0'.repeat(64)}`;
  manifest.manifestDigest = computeManifestDigest(manifest);
  assert.doesNotThrow(() => validateManifest(manifest));
  assert.throws(
    () => validateTrackedLocalProof(manifest, projectRoot),
    /local proof hash mismatch/,
  );
});

test('Robinhood binding verifier requires the exact current custody ABI', () => {
  const functions = [
    'bindMintedPosition',
    'bindingHook',
    'configureBindingHook',
    'deployer',
    'finalizePosition',
    'positionManager',
    'positionReceived',
    'positionTokenId',
  ];
  const artifact = {
    abi: functions.map((name) => ({ type: 'function', name })),
    deployedBytecode: { object: '0x600000' },
  };
  assert.deepEqual(validateCustodyArtifact(artifact).functions, functions);

  const missing = structuredClone(artifact);
  missing.abi.pop();
  assert.throws(() => validateCustodyArtifact(missing), /custody ABI does not match/);
  const added = structuredClone(artifact);
  added.abi.push({ type: 'function', name: 'withdraw' });
  assert.throws(() => validateCustodyArtifact(added), /custody ABI does not match/);
  const delegated = structuredClone(artifact);
  delegated.deployedBytecode.object = '0xf4';
  assert.throws(() => validateCustodyArtifact(delegated), /DELEGATECALL/);
  const pushedOpcodeByte = structuredClone(artifact);
  pushedOpcodeByte.deployedBytecode.object = '0x60f400';
  assert.doesNotThrow(() => validateCustodyArtifact(pushedOpcodeByte));
});

test('Robinhood binding rejects tampering and unknown manifest keys', () => {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'bindings', 'robinhood-chain.json'), 'utf8'));
  const changedHash = structuredClone(manifest);
  changedHash.contracts.poolManager.runtimeCodeHash = `0x${'00'.repeat(32)}`;
  assert.throws(() => validateManifest(changedHash), /manifest digest mismatch/);

  const unknownKey = structuredClone(manifest);
  unknownKey.unreviewedOverride = true;
  unknownKey.manifestDigest = computeManifestDigest(unknownKey);
  assert.throws(() => validateManifest(unknownKey), /manifest keys must be exactly/);

  const changedAddress = structuredClone(manifest);
  changedAddress.contracts.poolManager.address = '0x0000000000000000000000000000000000000001';
  changedAddress.manifestDigest = computeManifestDigest(changedAddress);
  assert.throws(() => validateManifest(changedAddress), /poolManager address is not the known Robinhood deployment/);
});

test('Robinhood binding rejects recomputed-digest custody, pending-state, permission, and quadrant weakening', () => {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'bindings', 'robinhood-chain.json'), 'utf8'));
  const mutations = [
    ['project-controlled custody', (candidate) => { candidate.market.custody.projectControlled = true; }, /project controlled/],
    ['upgradeable custody', (candidate) => { candidate.market.custody.upgradeable = true; }, /upgradeable/],
    ['custody transfer path', (candidate) => { candidate.market.custody.forbiddenAuthorityPaths.transfer = true; }, /forbidden authority/],
    ['resolved pending PoolKey field', (candidate) => { candidate.market.poolKey.currency0 = '0x0000000000000000000000000000000000000001'; }, /currency0 must be null/],
    ['extra hook permission', (candidate) => { candidate.market.hookPermissions.allOtherPermissions = true; }, /all other hook permissions/],
    ['wrong process allocation rule', (candidate) => { candidate.market.hookFee.processRule = 'programmable receives all fees'; }, /process rule/],
    ['missing Q semantics blocker', (candidate) => {
      candidate.productionReadiness.blockers = candidate.productionReadiness.blockers.filter(
        (blocker) => blocker !== 'EXACT_OUTPUT_USDG_Q_GROSS_NET_AND_FEE_CUSTODY_SEMANTICS',
      );
    }, /production blockers/],
    ['relaxed production rule', (candidate) => { candidate.productionReadiness.rule = 'deployment allowed'; }, /production readiness rule/],
    ['incomplete quadrant set', (candidate) => { candidate.market.quadrantProof.directions = ['BUY_HKMN']; }, /quadrant directions/],
    ['missing post-custody sell proof', (candidate) => { candidate.market.quadrantProof.postCustodySell = false; }, /post-custody sell/],
    ['missing ordinary transfer proof', (candidate) => { candidate.market.quadrantProof.ordinaryUserTransfers = false; }, /ordinary user transfer/],
  ];

  for (const [name, mutate, expected] of mutations) {
    const candidate = structuredClone(manifest);
    mutate(candidate);
    candidate.manifestDigest = computeManifestDigest(candidate);
    assert.throws(() => validateManifest(candidate), expected, name);
  }
});

test('Robinhood binding reconciles pinned deployment registries', () => {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'bindings', 'robinhood-chain.json'), 'utf8'));
  const recheck = JSON.parse(readFileSync(join(projectRoot, 'feasibility', 'official-robinhood-binding-recheck.json'), 'utf8'));
  assert.doesNotThrow(() => validatePinnedOfficialBindingFacts(manifest, parsePinnedOfficialBindingFacts(recheck)));

  const source = `
    const LIQUIDITY_LAUNCHER_ROBINHOOD = getAddress('0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0')
    const UERC20_FACTORY = getAddress('0x000000e200088D55C39a11F609E5F667729ad49b')
    const POSITION_MANAGER_ROBINHOOD = getAddress('0x58daec3116aae6D93017bAAea7749052E8a04fA7')
    export const LAUNCHER_ADDRESSES = {
      [SupportedChainId.ROBINHOOD]: {
        liquidityLauncher: LIQUIDITY_LAUNCHER_ROBINHOOD,
        lbpStrategy: getAddress('0x05d552391067389EE44fec3924157ed33F976000'),
        uerc20Factory: UERC20_FACTORY,
        positionManager: POSITION_MANAGER_ROBINHOOD,
      },
    }
  `;
  const facts = parsePinnedLiquidityLauncherFacts(Buffer.from(source));
  assert.doesNotThrow(() => validatePinnedOfficialBindingFacts(manifest, facts));
});

test('interface freeze tracks the provisional Phase 3 architecture while preserving historical evidence', () => {
  const manifest = JSON.parse(readFileSync(join(projectRoot, 'bindings', 'robinhood-chain.json'), 'utf8'));
  const frozen = JSON.parse(readFileSync(join(projectRoot, 'architecture', 'interfaces.json'), 'utf8'));
  const provisional = JSON.parse(readFileSync(join(projectRoot, 'architecture', 'provisional-interfaces.json'), 'utf8'));
  const freeze = JSON.parse(readFileSync(join(projectRoot, 'feasibility', 'interface-freeze.json'), 'utf8'));
  const result = validateInterfaceFreeze({ freeze, frozen, provisional, manifest, projectRoot });

  assert.equal(manifest.requirementsRevision, 54, 'historical provider evidence keeps its original revision');
  assert.equal(manifest.architectureRevision, 3, 'historical provider evidence keeps its original architecture');
  assert.equal(result.requirementsRevision, 65);
  assert.equal(result.architectureRevision, 9);
  assert.equal(freeze.productPhase, 3);
  assert.equal(freeze.status, 'PROVISIONAL_PHASE3_PENDING_FEASIBILITY');
  assert.equal(freeze.bindingManifestDigest, null);
  assert.deepEqual(freeze.proofCoverage.phase3Interface, {
    status: 'PROVISIONAL_PENDING_FEASIBILITY',
    requirementsRevision: 65,
    architectureRevision: 9,
    bindingManifest: 'release/phase3/deployment-manifest.json',
    bindingManifestDigest: null,
    providerBindingStatus: 'INTEGRATION_PENDING',
    codeReadinessDoesNotAuthorizeLive: true,
  });
  assert.match(
    freeze.inputHashes['feasibility/cycle-control-model-results.json'],
    /^sha256:[0-9a-f]{64}$/,
  );
  assert.match(
    freeze.inputHashes['feasibility/cycle-control-survivability-bounds.json'],
    /^sha256:[0-9a-f]{64}$/,
  );
  assert.equal(result.productionReady, false);
  assert.equal(result.moduleCount, provisional.modules.length);
  assert.deepEqual(result.blockers, frozen.productionBlockers);
  assert.equal(freeze.proofCoverage.canonicalMarket.partialFillRejectionQuadrants, 8);
  assert.equal(
    freeze.proofCoverage.permanentCustody.pinnedV4PeripheryPositionManagerMintAndFinalization,
    'PASSED_LOCAL',
  );
  assert.deepEqual(freeze.proofCoverage.reproducibleBuild, {
    historicalRevision54: {
      status: 'PASSED_LOCAL_HISTORICAL_SOURCE_BOUND',
      requirementsRevision: 54,
      architectureRevision: 3,
      isolatedCleanBuilds: 2,
      declaredGitlinkPinsChecked: 7,
      bytecode: {
        ImmutableLaunchBinding: {
          creationSha256: 'sha256:ed54b2ad7e611fdb298606700bf46dd59249c4f71aff9934d50484bb3ed9322d',
          runtimeSha256: 'sha256:99061a1d239d861c2fcb465c2420fcda6ea88d9382c451c2bc2ce78342a6ab19',
        },
        PermanentPositionCustody: {
          creationSha256: 'sha256:354b1edc654e3ef04394ceeb3ea5f46ea5322110aa105a0e09f46f51e2a353b6',
          runtimeSha256: 'sha256:e0a1cadff0b8e2a6700675cf600abc596dd8af5659429c15e9f24fca33b3dfbc',
        },
        RobinhoodBindings: {
          creationSha256: 'sha256:d7ac96d464f78c6fda8aa1de9f7b9d92884b081f3bfcd79bb8a1c198e9752418',
          runtimeSha256: 'sha256:00b3b642139567b85e19cd344e804d27960107637f04ae5f72a6e2289fc00e80',
        },
      },
      repeatedExactly: true,
    },
    revision56Candidate: {
      status: 'PENDING_COMMIT_BOUND_EVIDENCE_GENERATION',
      expectedIsolatedCleanBuilds: 2,
      observedCommitBoundIsolatedCleanBuilds: 0,
      expectedArtifactCount: 20,
      localLoopEvidence: 'PENDING_COMMIT_BOUND_EVIDENCE',
      pegCycleVaultConcreteRuntimeEvidence: 'PENDING_COMMIT_BOUND_EVIDENCE',
      repeatedExactly: false,
    },
    pinnedToolchain: {
      foundry: {
        version: '1.7.1',
        commit: '4072e48705af9d93e3c0f6e29e93b5e9a40caed8',
      },
      solidity: {
        solcVersion: '0.8.26',
        evmVersion: 'cancun',
        optimizer: true,
        optimizerRuns: 20_000,
      },
    },
    compilerTemplates: {
      PegCycleVault: {
        creationTemplateSha256: 'sha256:10c3699cfbd6e4722e48cebd4f2ee0324286717c896c84c01412a738f4114565',
        runtimeTemplateSha256: 'sha256:138f608c4153e0c6afe332fe842e8bb5d081e94aac213d34f6b587caf2f90576',
        runtimeHasImmutableReferences: true,
        concreteRuntimeEvidence: 'PENDING_COMMIT_BOUND_EVIDENCE',
      },
    },
  });
  assert.deepEqual(freeze.proofCoverage.historicalPhase1Model, {
    status: 'PRESERVED_HISTORICAL_REVISION_56_ARCHITECTURE_4',
    requirementsRevision: 56,
    architectureRevision: 4,
    schemaVersion: 'hookemon.feasibility-model-results.v5',
  });
  assert.deepEqual(freeze.proofCoverage.cycleControl, {
    status: 'PASSED_LOCAL_REVISION_57_ARCHITECTURE_5',
    requirementsRevision: 57,
    architectureRevision: 5,
    maximumCrossCycleContaminationAtomicUSDG: '0',
    maximumBlindRetryMoneyMutationAtomicUSDG: '0',
    maximumActiveCycles: 1,
    minimumDistinctEscrowsObserved: 2,
    maximumAuthorizedLossPerCycleAtomicUSDG: '100000000',
    cumulativeSystemLossCap: 'NOT_CLAIMED',
  });
  assert.equal(frozen.bindingManifest, 'release/phase3/deployment-manifest.json');
  assert.equal(frozen.bindingManifestDigest, null);
  assert.equal(frozen.phaseBoundary.codeReadinessDoesNotAuthorizeLive, true);
});

test('interface freeze refresh is deterministic and validation rejects tampering', () => {
  const generator = join(projectRoot, 'feasibility', 'refresh-interface-freeze.mjs');
  const output = join(projectRoot, 'feasibility', 'interface-freeze.json');

  execFileSync(process.execPath, [generator, '--check'], { cwd: projectRoot, stdio: 'pipe' });
  const first = readFileSync(output);
  execFileSync(process.execPath, [generator, '--check'], { cwd: projectRoot, stdio: 'pipe' });
  const second = readFileSync(output);
  assert.deepEqual(second, first);

  const manifest = JSON.parse(readFileSync(join(projectRoot, 'bindings', 'robinhood-chain.json'), 'utf8'));
  const frozen = JSON.parse(readFileSync(join(projectRoot, 'architecture', 'interfaces.json'), 'utf8'));
  const provisional = JSON.parse(readFileSync(join(projectRoot, 'architecture', 'provisional-interfaces.json'), 'utf8'));
  const freeze = JSON.parse(second);
  freeze.inputHashes['architecture/interfaces.json'] = `sha256:${'0'.repeat(64)}`;
  assert.throws(
    () => validateInterfaceFreeze({ freeze, frozen, provisional, manifest, projectRoot }),
    /interface freeze input hash mismatch: architecture\/interfaces\.json/,
  );
});

test('revision 56 model proves permanent zero-LP-fee market custody in all eight quadrants', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'hookemon-r56-model-'));
  const feasibility = join(scratch, 'feasibility');
  cpSync(join(projectRoot, 'feasibility'), feasibility, { recursive: true });

  execFileSync(process.execPath, [join(feasibility, 'model.mjs')], { cwd: scratch, stdio: 'pipe' });

  const result = JSON.parse(readFileSync(join(feasibility, 'model-results.json'), 'utf8'));
  const proof = result.canonicalMarketProof;
  assert.equal(result.requirementsRevision, 56);
  assert.equal(result.architectureRevision, 4);
  assert.equal(proof.poolKey.staticLpFee, 0);
  assert.equal(proof.launchAllocationBasisPoints, 9_000);
  assert.equal(proof.custody.projectControlled, false);
  assert.deepEqual(proof.custody.forbiddenAuthorityPaths, {
    transfer: false, approval: false, liquidityDecrease: false, principalWithdrawal: false,
    feeCollection: false, rescue: false, upgrade: false, delegatecall: false, successorControl: false,
  });
  assert.deepEqual(proof.postCustodyAvailability, {
    supportedBuy: true, supportedSell: true, userBalanceTransfer: true,
  });
  assert.equal(proof.feeConformance.deterministicFuzz.sampleCount, 100_000);
  assert.equal(proof.feeConformance.deterministicFuzz.conservationFailures, 0);
  assert.match(proof.feeConformance.deterministicFuzz.vectorDigest, /^sha256:[0-9a-f]{64}$/);
  assert.ok(proof.feeConformance.roundingTransitions.some((entry) => entry.executedUsdg === '33' && entry.total === '0'));
  assert.ok(proof.feeConformance.roundingTransitions.some((entry) => entry.executedUsdg === '34' && entry.total === '1'));
  assert.equal(proof.swapQuadrants.length, 8);
  assert.equal(proof.swapQuadrants.filter((quadrant) => quadrant.executedUsdgSource === 'FINAL_CALLER_SPECIFIED_DELTA_AFTER_FULL_FILL').length, 4);
  assert.equal(proof.swapQuadrants.filter((quadrant) => quadrant.executedUsdgSource === 'RAW_POOL_UNSPECIFIED_DELTA_BEFORE_AFTERSWAP_HOOK_DELTA').length, 4);
  assert.ok(proof.swapQuadrants.every((quadrant) => quadrant.fullFill));
  assert.ok(proof.swapQuadrants.every((quadrant) => quadrant.staticLpFee === 0));
  assert.ok(proof.swapQuadrants.every((quadrant) => quadrant.additionalTradingFeeBasisPoints === 0));
  assert.ok(proof.swapQuadrants.every((quadrant) => BigInt(quadrant.collectedUsdg) === BigInt(quadrant.fee.total)));
  assert.ok(proof.swapQuadrants.every((quadrant) => {
    const rawSpecified = quadrant.specifiedCurrency === 'CURRENCY0'
      ? BigInt(quadrant.rawPoolDelta.amount0) : BigInt(quadrant.rawPoolDelta.amount1);
    return rawSpecified === BigInt(quadrant.amountSpecified) + BigInt(quadrant.hookDelta.beforeSwapSpecified);
  }));
  assert.ok(proof.swapQuadrants.every((quadrant) => {
    const callerSpecified = quadrant.specifiedCurrency === 'CURRENCY0'
      ? BigInt(quadrant.callerDelta.amount0) : BigInt(quadrant.callerDelta.amount1);
    return callerSpecified === BigInt(quadrant.amountSpecified);
  }));
  assert.ok(proof.swapQuadrants.every((quadrant) => BigInt(quadrant.hookDelta.beforeSwapSpecified)
    + BigInt(quadrant.hookDelta.afterSwapUnspecified) === BigInt(quadrant.fee.total)));
  assert.ok(proof.swapQuadrants.every((quadrant) => BigInt(quadrant.fee.total)
    === BigInt(quadrant.fee.programmable) + BigInt(quadrant.fee.treasury) + BigInt(quadrant.fee.process)));
});

test('revision 56 model keeps process principal and returned proceeds outside compromised Operations custody', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'hookemon-r56-operations-exposure-'));
  const feasibility = join(scratch, 'feasibility');
  cpSync(join(projectRoot, 'feasibility'), feasibility, { recursive: true });

  execFileSync(process.execPath, [join(feasibility, 'model.mjs')], { cwd: scratch, stdio: 'pipe' });

  const result = JSON.parse(readFileSync(join(feasibility, 'model-results.json'), 'utf8'));
  const bounds = JSON.parse(readFileSync(join(feasibility, 'survivability-bounds.json'), 'utf8'));
  const compromised = result.adversarialCases.find(
    (scenario) => scenario.id === 'compromised-current-operations-trigger-zero-custody',
  );
  const cooperativeCap = BigInt(
    result.authorityBoundary.cooperativeRunnerCyclePrincipalCapAtomicUSDG,
  );
  const processExposure = BigInt(compromised.outcomes.operationsProcessPrincipalExposureAtomicUSDG);
  const returnExposure = BigInt(compromised.outcomes.operationsReturnedProceedsExposureAtomicUSDG);

  assert.equal(result.schemaVersion, 'hookemon.feasibility-model-results.v5');
  assert.equal(compromised.inputs.releaseAuthority, 'TRIGGER_ONLY_EXACT_AUTHORIZATION');
  assert.equal(compromised.outcomes.releaseAccepted, true);
  assert.equal(
    compromised.outcomes.fundedToPegCycleVaultAtomicUSDG,
    compromised.outcomes.accruedProcessLiabilityBeforeReleaseAtomicUSDG,
  );
  assert.equal(compromised.outcomes.operationsUsdgBalanceAtomicUSDG, '0');
  assert.equal(compromised.outcomes.exposureRule, 'IMMUTABLE_VAULT_DESTINATION_AND_RETURN');
  assert.equal(processExposure, 0n);
  assert.equal(returnExposure, 0n);
  assert.ok(BigInt(compromised.outcomes.fundedToPegCycleVaultAtomicUSDG) > cooperativeCap);
  assert.equal(result.aggregate.maximumModeledCompromisedOperationsCustodyExposureAtomicUSDG, '0');
  assert.equal(result.aggregate.systemwideCompromisedOperationsCustodyLossUpperBoundAtomicUSDG, '0');
  assert.equal(result.candidateBoundComparison.scope, 'COOPERATIVE_SEPARATELY_AUTHORIZED_RUNNER_ACTIONS_ONLY');
  assert.ok(!Object.hasOwn(result.aggregate, 'maximumLiveCycleNonGasPrincipalLossAtomicUSDG'));
  assert.ok(!Object.hasOwn(
    result.aggregate,
    'maximumUnauthorizedOrDuplicateRobinhoodUSDGSpendAboveApprovedCapAtomicUSDG',
  ));

  assert.equal(bounds.schemaVersion, 'hookemon.owner-survivability-bounds.v5');
  assert.equal(bounds.approvalState, 'OWNER_REAPPROVAL_REQUIRED_AFTER_EXPOSURE_CORRECTION');
  assert.equal(bounds.ownerApprovalRequest.pending, true);
  assert.equal(bounds.currentOperationsCompromiseExposure.status, 'ZERO_CUSTODY_BY_CONSTRUCTION');
  assert.equal(
    bounds.currentOperationsCompromiseExposure.maximumReleaseRule,
    'EXACT_AUTHORIZATION_TO_IMMUTABLE_PEG_CYCLE_VAULT',
  );
  assert.equal(bounds.currentOperationsCompromiseExposure.processPrincipalExposureAtomicUSDG, '0');
  assert.equal(bounds.currentOperationsCompromiseExposure.returnedProceedsExposureAtomicUSDG, '0');
  assert.equal(bounds.currentOperationsCompromiseExposure.modelObservedExposureAtomicUSDG, '0');
  assert.deepEqual(
    Object.fromEntries(Object.entries(bounds.unresolvedExternalCompromiseExposure)
      .map(([riskClass, exposure]) => [riskClass, exposure.status])),
    {
      provider: 'UNRESOLVED_NONZERO',
      authorizer: 'UNRESOLVED_NONZERO',
      routeExecutor: 'UNRESOLVED_NONZERO',
      bridge: 'UNRESOLVED_NONZERO',
      policyWallet: 'UNRESOLVED_NONZERO',
    },
  );
  assert.ok(Object.hasOwn(
    bounds.candidateBounds,
    'maximumAuthorizedCooperativeRunnerCycleNonGasPrincipalLossAtomicUSDG',
  ));
  assert.ok(!Object.hasOwn(
    bounds.candidateBounds,
    'maximumLiveCycleNonGasPrincipalLossAtomicUSDG',
  ));
});

function assertCorrectedBoundsMutationRejected(mutate, expectedError) {
  const scratch = mkdtempSync(join(tmpdir(), 'hookemon-r56-bounds-mutation-'));
  const feasibility = join(scratch, 'feasibility');
  const model = join(feasibility, 'model.mjs');
  const results = join(feasibility, 'model-results.json');
  const boundsPath = join(feasibility, 'survivability-bounds.json');
  cpSync(join(projectRoot, 'feasibility'), feasibility, { recursive: true });
  execFileSync(process.execPath, [model], { cwd: scratch, stdio: 'pipe' });
  const bounds = JSON.parse(readFileSync(boundsPath, 'utf8'));
  mutate(bounds);
  writeFileSync(boundsPath, `${JSON.stringify(bounds, null, 2)}\n`);

  assert.throws(
    () => execFileSync(process.execPath, [
      model, '--verify', results, '--verify-bounds', boundsPath,
    ], { cwd: scratch, stdio: 'pipe' }),
    expectedError,
  );
}

test('verify-bounds rejects nonzero compromised Operations custody exposure', () => {
  assertCorrectedBoundsMutationRejected((bounds) => {
    bounds.currentOperationsCompromiseExposure.systemwideCustodyLossUpperBoundAtomicUSDG = '1';
  }, /compromised Operations custody exposure must remain exactly zero/);
});

test('verify-bounds rejects top-level owner approval before corrected-scope reapproval', () => {
  assertCorrectedBoundsMutationRejected((bounds) => {
    bounds.approvalState = 'OWNER_APPROVED';
  }, /bounds approval state must require corrected-scope owner reapproval/);
});

test('verify-bounds rejects an owner-approved cooperative cap status before reapproval', () => {
  assertCorrectedBoundsMutationRejected((bounds) => {
    bounds.candidateBounds.maximumAuthorizedCooperativeRunnerCycleNonGasPrincipalLossAtomicUSDG.status = 'OWNER_APPROVED';
  }, /cooperative runner cap must require corrected-scope owner reapproval/);
});

test('verify-bounds rejects a completed owner approval request before reapproval', () => {
  assertCorrectedBoundsMutationRejected((bounds) => {
    bounds.ownerApprovalRequest.pending = false;
  }, /corrected bounds owner approval request must remain pending/);
});

test('verify-bounds rejects a system-wide or onchain description of the cooperative cap', () => {
  assertCorrectedBoundsMutationRejected((bounds) => {
    bounds.candidateBounds.maximumAuthorizedCooperativeRunnerCycleNonGasPrincipalLossAtomicUSDG.scope = 'System-wide 100 USDG loss cap enforced onchain';
  }, /cooperative runner cap has invalid authority scope/);
});

test('verify-bounds rejects a compromised Operations status that permits custody', () => {
  assertCorrectedBoundsMutationRejected((bounds) => {
    bounds.currentOperationsCompromiseExposure.status = 'OPERATIONS_CUSTODY_ALLOWED';
  }, /compromised Operations status must declare zero custody by construction/);
});

test('verify-bounds rejects a stale top-level authority scope', () => {
  assertCorrectedBoundsMutationRejected((bounds) => {
    bounds.scope = 'One owner-approved 100 USDG system-wide live cycle loss bound';
  }, /bounds scope must match the corrected current authority scope/);
});

test('verify-bounds rejects an extra legacy candidate bound', () => {
  assertCorrectedBoundsMutationRejected((bounds) => {
    bounds.candidateBounds.maximumLiveCycleNonGasPrincipalLossAtomicUSDG = {
      value: '100000000',
      status: 'OWNER_APPROVED',
      scope: 'System-wide live cycle principal loss',
    };
  }, /candidate bounds must use the exact corrected key set/);
});

test('verify-bounds rejects parallel fields in corrected authority objects', () => {
  assertCorrectedBoundsMutationRejected((bounds) => {
    bounds.currentOperationsCompromiseExposure.maximumLiveCycleNonGasPrincipalLossAtomicUSDG = '100000000';
  }, /compromised Operations exposure must use the exact authority schema/);
  assertCorrectedBoundsMutationRejected((bounds) => {
    bounds.candidateBounds.maximumAuthorizedCooperativeRunnerCycleNonGasPrincipalLossAtomicUSDG.systemwideLossUpperBoundAtomicUSDG = '100000000';
  }, /cooperative runner cap must use the exact authority schema/);
  assertCorrectedBoundsMutationRejected((bounds) => {
    bounds.ownerApprovalRequest.ownerApproved = true;
  }, /owner approval request must use the exact authority schema/);
});

test('verify-bounds rejects an approved release-cap status before provider binding', () => {
  assertCorrectedBoundsMutationRejected((bounds) => {
    bounds.releaseBoundNumericCaps.status = 'OWNER_APPROVED';
  }, /release-bound numeric caps must remain pending provider binding/);
});

test('verify-bounds rejects legacy owner approval number aliases', () => {
  assertCorrectedBoundsMutationRejected((bounds) => {
    bounds.ownerApprovalRequest.numbers.maximumLiveCycleNonGasPrincipalLossAtomicUSDG = '100000000';
  }, /owner approval numbers must use the exact corrected key set/);
});

test('verify-bounds rejects parallel root-level approval claims', () => {
  assertCorrectedBoundsMutationRejected((bounds) => {
    bounds.ownerApproved = true;
  }, /survivability bounds must use the exact corrected root schema/);
});

test('verify-bounds rejects authoritative model comparison claims', () => {
  assertCorrectedBoundsMutationRejected((bounds) => {
    bounds.modelComparison.candidateResult = 'PASS';
    bounds.modelComparison.authority = 'OWNER_APPROVED_SYSTEM_WIDE';
  }, /model comparison must remain non-authoritative/);
});

test('verify-bounds rejects action authorization and contradictory authority explanations', () => {
  assertCorrectedBoundsMutationRejected((bounds) => {
    bounds.ownerApprovalRequest.notAnActionAuthorization = false;
  }, /owner approval request must remain separate from action authorization/);
  assertCorrectedBoundsMutationRejected((bounds) => {
    bounds.candidateBounds.maximumAuthorizedCooperativeRunnerCycleNonGasPrincipalLossAtomicUSDG.absorber =
      'The 100 USDG cap is enforced onchain and system-wide.';
  }, /cooperative runner cap must retain the corrected authority explanation/);
  assertCorrectedBoundsMutationRejected((bounds) => {
    bounds.currentOperationsCompromiseExposure.absorber =
      'A fixed onchain cap limits compromised Operations to 100 USDG.';
  }, /compromised Operations exposure must retain the immutable custody explanation/);
});

test('revision 57 cycle-control model proves sequential isolation and reconciliation-first recovery', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'hookemon-r57-cycle-control-'));
  const feasibility = join(scratch, 'feasibility');
  mkdirSync(feasibility, { recursive: true });
  cpSync(
    join(projectRoot, 'feasibility', 'cycle-control-model.mjs'),
    join(feasibility, 'cycle-control-model.mjs'),
  );
  cpSync(
    join(projectRoot, 'feasibility', 'cycle-control-survivability-bounds.json'),
    join(feasibility, 'cycle-control-survivability-bounds.json'),
  );

  execFileSync(process.execPath, [join(feasibility, 'cycle-control-model.mjs')], {
    cwd: scratch,
    stdio: 'pipe',
  });

  const resultPath = join(feasibility, 'cycle-control-model-results.json');
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  const byId = new Map(result.scenarios.map((scenario) => [scenario.id, scenario]));
  const sequential = byId.get('two-sequential-successful-cycles');
  const restart = byId.get('same-cycle-restart-requires-reconciliation');
  const failed = byId.get('failed-cycle-successor-isolates-late-return');

  assert.equal(result.schemaVersion, 'hookemon.cycle-control-model-results.v1');
  assert.equal(result.productPhase, 2);
  assert.equal(result.requirementsRevision, 57);
  assert.equal(result.architectureRevision, 5);
  assert.equal(sequential.outcomes.maximumActiveCycles, 1);
  assert.equal(new Set(sequential.cycles.map((cycle) => cycle.escrow)).size, 2);
  assert.ok(sequential.cycles.every((cycle) => cycle.terminalStatus === 'PAYOUT_COMMITTED'));
  assert.equal(restart.outcomes.blindRetryAccepted, false);
  assert.equal(restart.outcomes.blindRetryMoneyMutationAtomicUSDG, '0');
  assert.equal(restart.outcomes.reconciliationRequired, true);
  assert.equal(restart.outcomes.resumedCycleId, restart.inputs.interruptedCycleId);
  assert.equal(failed.outcomes.successorUsesFreshCycleId, true);
  assert.equal(failed.outcomes.successorUsesFreshNonce, true);
  assert.equal(failed.outcomes.successorUsesDistinctEscrow, true);
  assert.equal(failed.outcomes.lateReturnContributionToSuccessorAtomicUSDG, '0');
  assert.equal(result.aggregate.maximumCrossCycleContaminationAtomicUSDG, '0');
  assert.equal(result.aggregate.maximumBlindRetryMoneyMutationAtomicUSDG, '0');
  assert.equal(result.aggregate.maximumActiveCycles, 1);
  assert.ok(result.aggregate.minimumDistinctEscrowsObserved >= 2);
  assert.equal(result.aggregate.maximumAuthorizedLossPerCycleAtomicUSDG, '100000000');
  assert.equal(result.aggregate.cumulativeSystemLossCap.status, 'NOT_CLAIMED');
  assert.equal(result.aggregate.cumulativeSystemLossCap.atomicUSDG, null);

  assert.doesNotThrow(() => execFileSync(process.execPath, [
    join(feasibility, 'cycle-control-model.mjs'),
    '--verify', resultPath,
    '--verify-bounds', join(feasibility, 'cycle-control-survivability-bounds.json'),
  ], { cwd: scratch, stdio: 'pipe' }));
});

test('revision 57 cycle-control verification rejects cross-cycle contamination', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'hookemon-r57-cycle-contamination-'));
  const feasibility = join(scratch, 'feasibility');
  mkdirSync(feasibility, { recursive: true });
  cpSync(
    join(projectRoot, 'feasibility', 'cycle-control-model.mjs'),
    join(feasibility, 'cycle-control-model.mjs'),
  );
  cpSync(
    join(projectRoot, 'feasibility', 'cycle-control-survivability-bounds.json'),
    join(feasibility, 'cycle-control-survivability-bounds.json'),
  );
  execFileSync(process.execPath, [join(feasibility, 'cycle-control-model.mjs')], {
    cwd: scratch,
    stdio: 'pipe',
  });
  const resultPath = join(feasibility, 'cycle-control-model-results.json');
  const result = JSON.parse(readFileSync(resultPath, 'utf8'));
  result.scenarios.find(
    (scenario) => scenario.id === 'failed-cycle-successor-isolates-late-return',
  ).outcomes.lateReturnContributionToSuccessorAtomicUSDG = '1';
  writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);

  assert.throws(
    () => execFileSync(process.execPath, [
      join(feasibility, 'cycle-control-model.mjs'),
      '--verify', resultPath,
      '--verify-bounds', join(feasibility, 'cycle-control-survivability-bounds.json'),
    ], { cwd: scratch, stdio: 'pipe' }),
    /late return contribution to the successor must remain exactly zero/,
  );
});
