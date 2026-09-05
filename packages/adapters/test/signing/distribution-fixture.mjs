// A reusable "a real, fully-executed fixture cycle → a valid candidate distribution artifact +
// copies + verification context" builder for this package's own signing tests
// (bin/hookemon-verifier.mjs's tests in particular). Not itself a `*.test.mjs` file. This drives
// the exact same runner fixtures packages/runner/test/distribution/distribution-signer.test.mjs
// itself uses (packages/runner/test/cycle/fixture-cycle.mjs,
// packages/runner/test/operator/fixture-crypto.mjs), so a receipt this package's tests produce is
// checked against the real runner-side reconstruction rules, never a simplified stand-in. The
// Ed25519 keypair below is the same well-known, non-secret, local-only "FIXTURE_OWNER_SIGNATURE"
// fixture key already committed and reused throughout packages/runner/test — never production key
// material, and it never leaves this repository's own test fixtures.
import { createPrivateKey, sign as cryptoSign } from 'node:crypto';

import { CycleRunner } from '../../../runner/src/cycle/cycle-runner.mjs';
import { FixtureCycleStore } from '../../../runner/src/cycle/cycle-store.mjs';
import { digest } from '../../../runner/src/cycle/journal.mjs';
import { FIXTURE_BINDING_MANIFEST_DIGEST, createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { fixtureActionDigests } from '../../../runner/src/cycle/schemas.mjs';
import {
  DISTRIBUTION_SIGNER_ROLE,
  signDistributionApproval,
} from '../../../runner/src/distribution/distribution-signer.mjs';
import { compileApprovedDistribution } from '../../../runner/src/distribution/manifest.mjs';
import { deriveClosedProceedsBasis } from '../../../runner/src/distribution/reconcile.mjs';
import {
  createCycleDraft,
  createFrozenCycleControl,
  freezeCycleDraft,
} from '../../../runner/src/operator/cycle-plan.mjs';
import { createPackSnapshot } from '../../../runner/src/operator/pack-selection.mjs';
import {
  executeCompleteFixtureCycle,
  fixtureBinding,
  fixtureCycleAction,
  fixtureCyclePreflight,
} from '../../../runner/test/cycle/fixture-cycle.mjs';
import { signFixtureCycleEscrowObservation } from '../../../runner/test/operator/fixture-crypto.mjs';

// Same fixture Ed25519 owner keypair `manifest.mjs`/`manifest.test.mjs`/`distribution-signer.test.mjs`
// already use for the "FIXTURE_OWNER_SIGNATURE" authority — a local-only test fixture, not a
// production secret.
const OWNER_PRIVATE_KEY = createPrivateKey({
  key: Buffer.from(
    '302e020100300506032b6570042204208566b1706357d4653313d88defec8219a3f4ad9d2abca8484765a4af92b12cb9',
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
const fixtureSigningOptions = Object.freeze({ preflightAuthority: createTestProfileMutationAuthority() });

function ownerSignerClient() {
  return {
    role: DISTRIBUTION_SIGNER_ROLE,
    sign(digestBuffer) {
      return cryptoSign(null, digestBuffer, OWNER_PRIVATE_KEY).toString('base64url');
    },
  };
}

function controlledFrozenControl(runnerCycleId, onchainCycleId) {
  const packSnapshot = createPackSnapshot({
    source: 'collector',
    observedAt: '2029-01-01T00:00:00.000Z',
    sourcePayloadDigest: digest({ domain: 'hookemon-verifier-fixture-pack-snapshot' }),
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

function runFixtureCycle() {
  const cycleStore = new FixtureCycleStore();
  const frozenControl = controlledFrozenControl(CYCLE, CYCLE);
  const runner = new CycleRunner(CYCLE, [], { cycleStore, frozenControl });
  runner.bindFrozenControl();
  const { returnReceiptDigest } = executeCompleteFixtureCycle(runner, CYCLE);
  runner.deriveClosedCycle();
  const proceedsKey = runner.consumeReturnedProceedsOnce({ receiptDigest: returnReceiptDigest });
  const closedProceedsBasis = deriveClosedProceedsBasis(runner.readClosedProceedsBasisHandoff({ proceedsKey }));
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

function threeCopies(artifact) {
  return ['primary', 'mirror', 'archive'].map(sourceId => ({ sourceId, manifestBytes: artifact.manifest.bytes }));
}

/**
 * Builds a complete, valid `{ artifact, copies, context }` triple — exactly the shape
 * `packages/runner/src/distribution/distribution-signer.mjs`'s `signDistributionVerification`
 * requires — by running a full fixture cycle end to end and having the (fixture, non-secret)
 * distribution-signer key approve the resulting candidate. This is what a real runner would drop
 * into `hookemon-verifier.mjs`'s `pending/` directory as a verification request.
 */
export async function buildDistributionVerificationRequest() {
  const input = runFixtureCycle();
  const candidateInput = {
    closedProceedsBasis: input.closedProceedsBasis,
    snapshot: input.snapshot,
    entries: input.entries,
    hook: HOOK,
    cycleId: CYCLE,
    payoutId: PAYOUT,
  };
  const approval = await signDistributionApproval(candidateInput, ownerSignerClient(), fixtureSigningOptions);
  const artifact = compileApprovedDistribution({
    closedProceedsBasis: input.closedProceedsBasis,
    snapshot: input.snapshot,
    entries: input.entries,
    approval,
  });
  const context = {
    runnerCycleId: input.closedProceedsBasis.cycleId,
    proceedsKey: input.proceedsKey,
    closedLedgerDigest: input.closedProceedsBasis.closedLedgerDigest,
    closedProceedsBasisDigest: input.closedProceedsBasis.basisDigest,
    verificationJournalHead: input.runner.state.journalHead,
  };
  return { approval, artifact, copies: threeCopies(artifact), context };
}
