import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { CycleRunner } from '../../src/cycle/cycle-runner.mjs';
import { FixtureCycleStore } from '../../src/cycle/cycle-store.mjs';
import { digest } from '../../src/cycle/journal.mjs';
import { FIXTURE_BINDING_MANIFEST_DIGEST, createTestProfileMutationAuthority } from '../../src/cycle/preflight.mjs';
import { fixtureActionDigests } from '../../src/cycle/schemas.mjs';
import {
  buildDistributionApprovalPayload,
  DISTRIBUTION_SIGNER_ROLE,
  VERIFIER_ROLE,
  assertPairedDistributionApproval,
  loadSignerClient,
  runCli,
  signDistributionApproval,
  signDistributionVerification,
} from '../../src/distribution/distribution-signer.mjs';
import { compileApprovedDistribution, verifyDistributionVerificationReceipt } from '../../src/distribution/manifest.mjs';
import { deriveClosedProceedsBasis, deriveHolderDistributionCandidate } from '../../src/distribution/reconcile.mjs';
import {
  createCycleDraft,
  createFrozenCycleControl,
  freezeCycleDraft,
} from '../../src/operator/cycle-plan.mjs';
import { createPackSnapshot } from '../../src/operator/pack-selection.mjs';
import {
  executeCompleteFixtureCycle,
  fixtureBinding,
  fixtureCycleAction,
  fixtureCyclePreflight,
} from '../cycle/fixture-cycle.mjs';
import { signFixtureCycleEscrowObservation } from '../operator/fixture-crypto.mjs';

// Same fixture Ed25519 keypairs `manifest.mjs`/`manifest.test.mjs` already use for the
// "FIXTURE_OWNER_SIGNATURE" / "HOOKEMON_FIXTURE_DISTRIBUTION_VERIFIER" authorities —
// not production secrets, the local-only signing domain this whole package operates in.
const OWNER_PRIVATE_KEY = createPrivateKey({
  key: Buffer.from(
    '302e020100300506032b6570042204208566b1706357d4653313d88defec8219a3f4ad9d2abca8484765a4af92b12cb9',
    'hex',
  ),
  format: 'der',
  type: 'pkcs8',
});
const DISTRIBUTION_VERIFIER_PRIVATE_KEY = createPrivateKey({
  key: Buffer.from(
    '302e020100300506032b65700422042066d19592d6fe485bacd309b93ae3524217a22bdcba8ee6333d1c0f51fb150e16',
    'hex',
  ),
  format: 'der',
  type: 'pkcs8',
});

const RECIPIENT_A = `0x${'1'.repeat(40)}`;
const RECIPIENT_B = `0x${'2'.repeat(40)}`;
const HOOK = `0x${'a'.repeat(40)}`;
const CYCLE = `0x${'c'.repeat(64)}`;
const PAYOUT = `0x${'d'.repeat(64)}`;
const OPERATIONS_TRIGGER = '0x0000000000000000000000000000000000001004';
const CYCLE_VAULT_ACCOUNT = '0x0000000000000000000000000000000000001002';
const RETURN_ACCOUNT = '0x0000000000000000000000000000000000002002';

function ed25519SignerClient(role, privateKey) {
  return {
    role,
    sign(digestBuffer) {
      return sign(null, digestBuffer, privateKey).toString('base64url');
    },
  };
}

const distributionSignerClient = ed25519SignerClient(DISTRIBUTION_SIGNER_ROLE, OWNER_PRIVATE_KEY);
const verifierSignerClient = ed25519SignerClient(VERIFIER_ROLE, DISTRIBUTION_VERIFIER_PRIVATE_KEY);
const fixtureSigningOptions = Object.freeze({ preflightAuthority: createTestProfileMutationAuthority() });

function controlledFrozenControl(runnerCycleId, onchainCycleId) {
  const packSnapshot = createPackSnapshot({
    source: 'collector',
    observedAt: '2029-01-01T00:00:00.000Z',
    sourcePayloadDigest: digest({ domain: 'distribution-signer-pack-snapshot' }),
    packs: [{ code: 'collector-crypt' }, { code: 'collector-ember' }],
  });
  const preflight = fixtureCyclePreflight(runnerCycleId);
  const plan = freezeCycleDraft(createCycleDraft({
    cycleId: runnerCycleId,
    authorizationNonce: '1',
    packSnapshotDigest: packSnapshot.snapshotDigest,
    pack: fixtureBinding.pack,
    quantity: 1,
    turbo: false,
    amount: '10',
    minimumRobinhoodReceive: '19',
    minimumSolanaReceive: '10',
    minimumReturnUsdg: '10',
    // Must equal fixtureCyclePreflight's hardcoded nativeGasCaps (packages/runner/test/cycle/fixture-cycle.mjs)
    // now that assertFrozenControlBindings (reducer.mjs) cross-checks the preflight against the frozen plan.
    robinhoodNativeGasCap: '2',
    solanaNativeGasCap: '2',
    expiresAt: '2030-01-01T00:00:00.000Z',
    bindingManifestDigest: FIXTURE_BINDING_MANIFEST_DIGEST,
    outboundActionDigest: fixtureActionDigests(fixtureCycleAction('outbound', runnerCycleId, preflight.preflightDigest)).actionDigest,
    returnActionDigest: fixtureActionDigests(fixtureCycleAction('return', runnerCycleId, preflight.preflightDigest)).actionDigest,
    operationsTrigger: OPERATIONS_TRIGGER,
    cycleVaultAccount: CYCLE_VAULT_ACCOUNT,
    returnAccount: RETURN_ACCOUNT,
  }), packSnapshot);
  const escrowObservation = signFixtureCycleEscrowObservation({
    schema: 'hookemon.fixture-cycle-escrow-observation.v1',
    authority: 'hookemon-fixture-cycle-escrow-reader',
    requirementsRevision: 57,
    runnerCycleId,
    onchainCycleId,
    cycleVaultAccount: CYCLE_VAULT_ACCOUNT,
    returnAccount: RETURN_ACCOUNT,
    method: 'computeCycleEscrow(bytes32)',
    verificationDigest: '',
    verificationSignature: '',
  });
  return createFrozenCycleControl({ plan, packSnapshot, binding: fixtureBinding, escrowObservation });
}

function fixture() {
  const cycleStore = new FixtureCycleStore();
  const frozenControl = controlledFrozenControl(CYCLE, CYCLE);
  const runner = new CycleRunner(CYCLE, [], { cycleStore, frozenControl });
  runner.bindFrozenControl();
  const { returnReceiptDigest } = executeCompleteFixtureCycle(runner, CYCLE);
  runner.deriveClosedCycle();
  const proceedsKey = runner.consumeReturnedProceedsOnce({ receiptDigest: returnReceiptDigest });
  const closedProceedsBasis = deriveClosedProceedsBasis(
    runner.readClosedProceedsBasisHandoff({ proceedsKey }),
  );
  const snapshot = {
    schema: 'hookemon.input-bound-hkmn-snapshot-candidate.v1',
    authority: 'INPUT_BOUND_CANDIDATE_NOT_AUTHENTICATED',
    asset: 'HKMN',
    chainId: '466',
    tokenAddress: `0x${'b'.repeat(40)}`,
    blockNumber: '12345678',
    blockHash: `0x${'e'.repeat(64)}`,
    finalized: true,
    directBalances: [
      { recipient: RECIPIENT_A, directHkmnBalance: '100' },
      { recipient: RECIPIENT_B, directHkmnBalance: '200' },
    ],
  };
  const entries = [
    { index: 0, recipient: RECIPIENT_A, directHkmnBalance: '100', amountAtomicUSDG: '4' },
    { index: 1023, recipient: RECIPIENT_B, directHkmnBalance: '200', amountAtomicUSDG: '6' },
  ];
  return { cycleStore, runner, frozenControl, proceedsKey, closedProceedsBasis, snapshot, entries };
}

function candidateInput(fixtureInput, overrides = {}) {
  return {
    closedProceedsBasis: fixtureInput.closedProceedsBasis,
    snapshot: fixtureInput.snapshot,
    entries: fixtureInput.entries,
    hook: HOOK,
    cycleId: CYCLE,
    payoutId: PAYOUT,
    ...overrides,
  };
}

function verificationContext(fixtureInput) {
  return {
    runnerCycleId: fixtureInput.closedProceedsBasis.cycleId,
    proceedsKey: fixtureInput.proceedsKey,
    closedLedgerDigest: fixtureInput.closedProceedsBasis.closedLedgerDigest,
    closedProceedsBasisDigest: fixtureInput.closedProceedsBasis.basisDigest,
    verificationJournalHead: fixtureInput.runner.state.journalHead,
  };
}

async function compiledArtifact(fixtureInput) {
  const approval = await signDistributionApproval(candidateInput(fixtureInput), distributionSignerClient, fixtureSigningOptions);
  const artifact = compileApprovedDistribution({
    closedProceedsBasis: fixtureInput.closedProceedsBasis,
    snapshot: fixtureInput.snapshot,
    entries: fixtureInput.entries,
    approval,
  });
  return { approval, artifact };
}

function threeCopies(artifact) {
  return ['primary', 'mirror', 'archive'].map((sourceId) => ({ sourceId, manifestBytes: artifact.manifest.bytes }));
}

test('distribution-signer independently recomputes the candidate and signs an approval that the vault-authorizer side accepts', async () => {
  const input = fixture();
  const candidate = deriveHolderDistributionCandidate({
    closedProceedsBasis: input.closedProceedsBasis,
    snapshot: input.snapshot,
    entries: input.entries,
  });
  const { candidate: recomputed, payload } = buildDistributionApprovalPayload(candidateInput(input));
  assert.equal(recomputed.candidateDigest, candidate.candidateDigest);
  assert.equal(payload.candidateDigest, candidate.candidateDigest);

  const approval = await signDistributionApproval(candidateInput(input), distributionSignerClient, fixtureSigningOptions);
  assert.equal(approval.candidateDigest, candidate.candidateDigest);
  assert.equal(approval.schema, 'hookemon.fixture-distribution-approval.v1');
  assert.equal(approval.authority, 'FIXTURE_OWNER_SIGNATURE');
  assert.equal(typeof approval.signature, 'string');
  assert.ok(approval.signature.length > 0);

  const artifact = compileApprovedDistribution({
    closedProceedsBasis: input.closedProceedsBasis,
    snapshot: input.snapshot,
    entries: input.entries,
    approval,
  });
  assert.equal(artifact.schema, 'hookemon.canonical-holder-distribution.v1');
  assert.equal(artifact.ownerApprovalDigest, approval.approvalDigest);
  assert.equal(artifact.root.sum, input.closedProceedsBasis.finalCredit.amount);
});

test('rejects a signer client with the wrong role or no sign function — never fabricates one', async () => {
  const input = fixture();
  await assert.rejects(
    () => signDistributionApproval(candidateInput(input), verifierSignerClient),
    /role mismatch/,
  );
  await assert.rejects(
    () => signDistributionApproval(candidateInput(input), { role: DISTRIBUTION_SIGNER_ROLE }),
    /signer client/,
  );
  await assert.rejects(
    () => signDistributionApproval(candidateInput(input), null),
    /signer client/,
  );
  await assert.rejects(
    () => signDistributionVerification({}, [], {}, distributionSignerClient),
    /role mismatch/,
  );
});

test('verifier independently reconstructs the tree from three copies and signs a receipt the runner consumes', async () => {
  const input = fixture();
  const { artifact } = await compiledArtifact(input);
  const copies = threeCopies(artifact);

  const receipt = await signDistributionVerification(artifact, copies, verificationContext(input), verifierSignerClient, fixtureSigningOptions);
  assert.equal(receipt.rootHash, artifact.root.hash);
  assert.equal(receipt.rootSum, artifact.root.sum);
  assert.equal(receipt.manifestDigest, artifact.manifest.digest);
  assert.equal(typeof receipt.verificationSignature, 'string');
  assert.ok(receipt.verificationSignature.length > 0);

  // The receipt this module produces validates against the same public-key check the
  // vault-authorizer's own `manifest.mjs` module performs — no adaptation needed.
  const validated = verifyDistributionVerificationReceipt(receipt);
  assert.equal(validated.receiptDigest, receipt.receiptDigest);

  // And it plugs straight into the existing runner step that gates payout funding.
  assert.equal(input.runner.recordDistributionVerification(receipt), receipt.receiptDigest);
  const prepared = input.runner.preparePayoutFunding({
    proceedsKey: input.proceedsKey,
    verificationReceiptDigest: receipt.receiptDigest,
    expiresAt: '1893456000',
    nonce: '9',
  });
  assert.equal(prepared.rootHash, artifact.root.hash);
  assert.equal(prepared.rootSum, artifact.root.sum);
});

test('a mismatched verifier reconstruction is rejected, not silently accepted', async () => {
  const input = fixture();
  const { artifact } = await compiledArtifact(input);
  const copies = threeCopies(artifact);

  const tamperedCopies = structuredClone(copies);
  tamperedCopies[1].manifestBytes = `${tamperedCopies[1].manifestBytes.slice(0, -1)}0`;
  await assert.rejects(
    () => signDistributionVerification(artifact, tamperedCopies, verificationContext(input), verifierSignerClient),
    /copy.*manifest/,
  );

  const tamperedArtifact = structuredClone(artifact);
  tamperedArtifact.proofs[0].siblingHashes[0] = `0x${'0'.repeat(64)}`;
  await assert.rejects(
    () => signDistributionVerification(tamperedArtifact, copies, verificationContext(input), verifierSignerClient),
    /reconstruction/,
  );

  // No signature is produced on the rejected paths — nothing was silently vouched for.
  const before = input.cycleStore.snapshot;
  assert.deepEqual(input.cycleStore.snapshot, before);
});

test('assertPairedDistributionApproval only accepts an approval and verification that agree on the same rootHash/rootSum', async () => {
  const input = fixture();
  const { approval, artifact } = await compiledArtifact(input);
  const copies = threeCopies(artifact);
  const receipt = await signDistributionVerification(artifact, copies, verificationContext(input), verifierSignerClient, fixtureSigningOptions);

  const paired = assertPairedDistributionApproval(approval, artifact, receipt);
  assert.equal(paired.rootHash, artifact.root.hash);
  assert.equal(paired.rootSum, artifact.root.sum);
  assert.equal(paired.manifestDigest, artifact.manifest.digest);

  const mismatchedRootSum = { ...receipt, rootSum: String(BigInt(receipt.rootSum) + 1n) };
  assert.throws(
    () => assertPairedDistributionApproval(approval, artifact, mismatchedRootSum),
    /do not agree on the same rootHash\/rootSum/,
  );
  const mismatchedRootHash = { ...receipt, rootHash: `0x${'0'.repeat(64)}` };
  assert.throws(
    () => assertPairedDistributionApproval(approval, artifact, mismatchedRootHash),
    /do not agree on the same rootHash\/rootSum/,
  );
  assert.throws(() => assertPairedDistributionApproval(null, artifact, receipt), /approval is required/);
  assert.throws(() => assertPairedDistributionApproval(approval, null, receipt), /artifact is required/);
  assert.throws(() => assertPairedDistributionApproval(approval, artifact, null), /receipt is required/);
});

test('the service never imports or embeds the scheduler policy-wallet or vault-authorizer key material (structural, not conventional)', () => {
  const modulePath = fileURLToPath(new URL('../../src/distribution/distribution-signer.mjs', import.meta.url));
  const source = readFileSync(modulePath, 'utf8');

  // No forbidden import of the always-on worker's policy-wallet/automation surface,
  // nor of the vault-authorizer/cycle-runner signing surface. If those modules exist
  // one day at these conventional paths, this module must still never reach into them.
  const forbiddenImportPattern = /from\s+['"][^'"]*(automation\/policy-wallet|policy-wallets|cycle-runner|vault-payout-authorization|keychain-secret)[^'"]*['"]/i;
  assert.equal(forbiddenImportPattern.test(source), false, 'must not import the worker/vault-authorizer signing surface');

  // No embedded PKCS8 private-key bytes (the ASN.1 prefix every Ed25519 private key in
  // this repo's fixtures starts with) anywhere in the module's own source.
  assert.equal(/302e020100300506032b6570/i.test(source), false, 'must not embed private key material');

  // Only an operator-supplied module path can ever produce a signer client.
  assert.match(source, /loadSignerClient/);
  assert.match(source, /this service holds no key material/);
});

test('signDistributionApproval and signDistributionVerification each require an explicit externally-injected signer, never a default', async () => {
  const input = fixture();
  await assert.rejects(() => signDistributionApproval(candidateInput(input), undefined), /signer client/);
  const { artifact } = await compiledArtifact(input);
  await assert.rejects(
    () => signDistributionVerification(artifact, threeCopies(artifact), verificationContext(input), undefined),
    /signer client/,
  );
});

test('retained distribution signing refuses the provisional authority before an injected signer runs', async () => {
  const input = fixture();
  let approvalCalls = 0;
  await assert.rejects(
    () => signDistributionApproval(candidateInput(input), {
      role: DISTRIBUTION_SIGNER_ROLE,
      async sign() { approvalCalls += 1; return 'unused'; },
    }),
    /active frozen interface authority is invalid/,
  );
  assert.equal(approvalCalls, 0);

  const { artifact } = await compiledArtifact(input);
  let verificationCalls = 0;
  await assert.rejects(
    () => signDistributionVerification(artifact, threeCopies(artifact), verificationContext(input), {
      role: VERIFIER_ROLE,
      async sign() { verificationCalls += 1; return 'unused'; },
    }),
    /active frozen interface authority is invalid/,
  );
  assert.equal(verificationCalls, 0);
});

test('fixture distribution signing accepts only the canonical test authority object', async () => {
  const input = fixture();
  let calls = 0;
  await assert.rejects(
    () => signDistributionApproval(candidateInput(input), {
      role: DISTRIBUTION_SIGNER_ROLE,
      async sign() { calls += 1; return 'unused'; },
    }, { preflightAuthority: { ...createTestProfileMutationAuthority() } }),
    /fixture distribution signing test authority is invalid/,
  );
  assert.equal(calls, 0);
});

test('CLI: retained distribution-signer and verifier modes refuse before an operator module can sign', async () => {
  const input = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'distribution-signer-cli-'));
  try {
    const signerModulePath = join(dir, 'fixture-signer.mjs');
    writeFileSync(
      signerModulePath,
      [
        'export function createSignerClient(role) {',
        "  return { role, sign() { throw new Error('operator module signer was called'); } };",
        '}',
      ].join('\n'),
    );

    const candidateInputPath = join(dir, 'candidate-input.json');
    writeFileSync(candidateInputPath, JSON.stringify(candidateInput(input)));
    const approvalOutPath = join(dir, 'approval.json');
    await assert.rejects(
      () => runCli([
        'distribution-signer',
        '--input', candidateInputPath,
        '--signer', signerModulePath,
        '--out', approvalOutPath,
      ]),
      /active frozen interface authority is invalid/,
    );
    assert.equal(existsSync(approvalOutPath), false);

    const { approval, artifact } = await compiledArtifact(input);
    const copies = threeCopies(artifact);
    const artifactPath = join(dir, 'artifact.json');
    const copiesPath = join(dir, 'copies.json');
    const contextPath = join(dir, 'context.json');
    writeFileSync(artifactPath, JSON.stringify(artifact));
    writeFileSync(copiesPath, JSON.stringify(copies));
    writeFileSync(contextPath, JSON.stringify(verificationContext(input)));
    const receiptOutPath = join(dir, 'receipt.json');
    await assert.rejects(
      () => runCli([
        'verifier',
        '--artifact', artifactPath,
        '--copies', copiesPath,
        '--context', contextPath,
        '--signer', signerModulePath,
        '--out', receiptOutPath,
      ]),
      /active frozen interface authority is invalid/,
    );
    assert.equal(existsSync(receiptOutPath), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI refuses to run without an explicit --signer module and rejects a module returning the wrong role', async () => {
  const input = fixture();
  const dir = mkdtempSync(join(tmpdir(), 'distribution-signer-cli-noseal-'));
  try {
    const candidateInputPath = join(dir, 'candidate-input.json');
    writeFileSync(candidateInputPath, JSON.stringify(candidateInput(input)));
    await assert.rejects(
      () => runCli(['distribution-signer', '--input', candidateInputPath]),
      /signer module path is required/,
    );

    const wrongRoleModulePath = join(dir, 'wrong-role-signer.mjs');
    writeFileSync(
      wrongRoleModulePath,
      "export function createSignerClient() { return { role: 'verifier', sign: () => 'x' }; }\n",
    );
    await assert.rejects(
      () => loadSignerClient(wrongRoleModulePath, DISTRIBUTION_SIGNER_ROLE),
      /role mismatch/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
