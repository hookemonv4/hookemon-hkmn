import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import test from 'node:test';

import { CycleRunner } from '../../src/cycle/cycle-runner.mjs';
import { FixtureCycleStore } from '../../src/cycle/cycle-store.mjs';
import { CycleJournal, digest } from '../../src/cycle/journal.mjs';
import { FIXTURE_BINDING_MANIFEST_DIGEST } from '../../src/cycle/preflight.mjs';
import { fixtureActionDigests } from '../../src/cycle/schemas.mjs';
import {
  contractBytes32FromDigest,
  vaultPayoutAuthorizationDigest,
} from '../../src/cycle/vault-payout-authorization.mjs';
import { deriveClosedProceedsBasis } from '../../src/distribution/reconcile.mjs';
import {
  compileApprovedDistribution,
  distributionApprovalDigest,
  distributionVerificationDigest,
  verifyDistributionCopies,
} from '../../src/distribution/manifest.mjs';
import { verifyProof } from '../../src/distribution/merkle-sum.mjs';
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
const OTHER_CYCLE = `0x${'9'.repeat(64)}`;
const PAYOUT = `0x${'d'.repeat(64)}`;
const OPERATIONS_TRIGGER = '0x0000000000000000000000000000000000001004';
const CYCLE_VAULT_ACCOUNT = '0x0000000000000000000000000000000000001002';
const RETURN_ACCOUNT = '0x0000000000000000000000000000000000002002';

function controlledFrozenControl(runnerCycleId, onchainCycleId) {
  const packSnapshot = createPackSnapshot({
    source: 'collector',
    observedAt: '2029-01-01T00:00:00.000Z',
    sourcePayloadDigest: digest({ domain: 'controlled-distribution-pack-snapshot' }),
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

function fixture({ runnerCycleId = CYCLE, onchainCycleId = null } = {}) {
  const cycleId = runnerCycleId;
  const cycleStore = new FixtureCycleStore();
  const frozenControl = onchainCycleId === null ? null : controlledFrozenControl(runnerCycleId, onchainCycleId);
  const runner = new CycleRunner(cycleId, [], { cycleStore, ...(frozenControl ? { frozenControl } : {}) });
  if (frozenControl) runner.bindFrozenControl();
  const { returnReceiptDigest } = executeCompleteFixtureCycle(runner, cycleId);
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
  return { cycleStore, runner, frozenControl, proceedsKey, returnReceiptDigest, closedProceedsBasis, snapshot, entries };
}

function signedApproval(candidate) {
  const payload = {
    schema: 'hookemon.fixture-distribution-approval.v1',
    authority: 'FIXTURE_OWNER_SIGNATURE',
    candidateDigest: candidate.candidateDigest,
    closedProceedsBasisDigest: candidate.closedProceedsBasisDigest,
    entriesDigest: candidate.entriesDigest,
    chainId: candidate.snapshot.chainId,
    hook: HOOK,
    cycleId: CYCLE,
    payoutId: PAYOUT,
    snapshotNumber: candidate.snapshot.blockNumber,
    snapshotHash: candidate.snapshot.blockHash,
  };
  const approvalDigest = distributionApprovalDigest(payload);
  return {
    ...payload,
    approvalDigest,
    signature: sign(null, Buffer.from(approvalDigest, 'utf8'), OWNER_PRIVATE_KEY).toString('base64url'),
  };
}

function distributionInput(input) {
  return {
    closedProceedsBasis: input.closedProceedsBasis,
    snapshot: input.snapshot,
    entries: input.entries,
  };
}

function verificationContext(input) {
  return {
    runnerCycleId: input.closedProceedsBasis.cycleId,
    proceedsKey: input.proceedsKey,
    closedLedgerDigest: input.closedProceedsBasis.closedLedgerDigest,
    closedProceedsBasisDigest: input.closedProceedsBasis.basisDigest,
    verificationJournalHead: input.runner.state.journalHead,
  };
}

function signedVerificationReceipt(artifact, copies, context) {
  const receipt = verifyDistributionCopies(artifact, copies, context);
  assert.equal(receipt.receiptDigest, distributionVerificationDigest(receipt));
  return {
    ...receipt,
    verificationSignature: sign(
      null,
      Buffer.from(receipt.receiptDigest, 'utf8'),
      DISTRIBUTION_VERIFIER_PRIVATE_KEY,
    ).toString('base64url'),
  };
}

function resignVerificationReceipt(receipt, overrides) {
  const value = { ...receipt, ...overrides, receiptDigest: '', verificationSignature: '' };
  value.receiptDigest = distributionVerificationDigest(value);
  value.verificationSignature = sign(
    null,
    Buffer.from(value.receiptDigest, 'utf8'),
    DISTRIBUTION_VERIFIER_PRIVATE_KEY,
  ).toString('base64url');
  return value;
}

test('compiles the approved reconciled return into the frozen canonical proof domain', async () => {
  const input = fixture();
  const { deriveHolderDistributionCandidate } = await import('../../src/distribution/reconcile.mjs');
  const candidate = deriveHolderDistributionCandidate(distributionInput(input));
  const artifact = compileApprovedDistribution({
    ...distributionInput(input),
    approval: signedApproval(candidate),
  });

  assert.equal(artifact.schema, 'hookemon.canonical-holder-distribution.v1');
  assert.equal(artifact.authority, 'LOCAL_FIXTURE_VERIFIED_NOT_PUBLISHED');
  assert.equal(artifact.candidateDigest, candidate.candidateDigest);
  assert.equal(artifact.root.sum, input.closedProceedsBasis.finalCredit.amount);
  assert.equal(artifact.proofs.length, 1024);
  for (const entry of artifact.entries) {
    assert.equal(
      verifyProof(
        artifact.leaves[entry.index],
        entry.index,
        artifact.proofs[entry.index],
        artifact.root,
      ),
      true,
    );
  }
});

test('rejects changed approval, snapshot binding, and hook-recipient artifacts', async () => {
  const input = fixture();
  const { deriveHolderDistributionCandidate } = await import('../../src/distribution/reconcile.mjs');
  const candidate = deriveHolderDistributionCandidate(distributionInput(input));
  const approval = signedApproval(candidate);

  assert.throws(
    () => compileApprovedDistribution({
      ...distributionInput(input),
      approval: { ...approval, payoutId: CYCLE },
    }),
    /approval digest/,
  );
  const otherCycleApproval = signedApproval(candidate);
  otherCycleApproval.cycleId = OTHER_CYCLE;
  const { approvalDigest: _oldDigest, signature: _oldSignature, ...otherCyclePayload } = otherCycleApproval;
  otherCycleApproval.approvalDigest = distributionApprovalDigest(otherCyclePayload);
  otherCycleApproval.signature = sign(
    null,
    Buffer.from(otherCycleApproval.approvalDigest, 'utf8'),
    OWNER_PRIVATE_KEY,
  ).toString('base64url');
  assert.throws(
    () => compileApprovedDistribution({
      ...distributionInput(input),
      approval: otherCycleApproval,
    }),
    /approval candidate binding/,
  );
  assert.throws(
    () => compileApprovedDistribution({
      ...distributionInput(input),
      snapshot: { ...input.snapshot, blockHash: `0x${'f'.repeat(64)}` },
      approval,
    }),
    /approval candidate binding/,
  );
  const hookRecipient = structuredClone(input);
  hookRecipient.snapshot.directBalances[0].recipient = HOOK;
  hookRecipient.entries[0].recipient = HOOK;
  const changedCandidate = deriveHolderDistributionCandidate(distributionInput(hookRecipient));
  assert.throws(
    () => compileApprovedDistribution({
      ...distributionInput(hookRecipient),
      approval: signedApproval(changedCandidate),
    }),
    /recipient/,
  );
});

test('accepts three exact independent copies and rejects one changed byte', async () => {
  const input = fixture();
  const { deriveHolderDistributionCandidate } = await import('../../src/distribution/reconcile.mjs');
  const candidate = deriveHolderDistributionCandidate(distributionInput(input));
  const artifact = compileApprovedDistribution({
    ...distributionInput(input),
    approval: signedApproval(candidate),
  });
  const copies = ['primary', 'mirror', 'archive'].map((sourceId) => ({
    sourceId,
    manifestBytes: artifact.manifest.bytes,
  }));

  const receipt = verifyDistributionCopies(artifact, copies, verificationContext(input));
  assert.equal(receipt.copyCount, 3);
  assert.equal(receipt.manifestDigest, artifact.manifest.digest);

  const changed = structuredClone(copies);
  changed[1].manifestBytes = `${changed[1].manifestBytes.slice(0, -1)}0`;
  assert.throws(
    () => verifyDistributionCopies(artifact, changed, verificationContext(input)),
    /copy.*manifest/,
  );

  const changedProof = structuredClone(artifact);
  changedProof.proofs[0].siblingHashes[0] = `0x${'0'.repeat(64)}`;
  assert.throws(
    () => verifyDistributionCopies(changedProof, copies, verificationContext(input)),
    /reconstruction/,
  );
});

test('journals one verified local handoff and recovers one funding preparation', async () => {
  const input = fixture();
  const { deriveHolderDistributionCandidate } = await import('../../src/distribution/reconcile.mjs');
  const candidate = deriveHolderDistributionCandidate(distributionInput(input));
  const artifact = compileApprovedDistribution({
    ...distributionInput(input),
    approval: signedApproval(candidate),
  });
  const copies = ['primary', 'mirror', 'archive'].map((sourceId) => ({
    sourceId,
    manifestBytes: artifact.manifest.bytes,
  }));
  const receipt = signedVerificationReceipt(artifact, copies, verificationContext(input));
  const beforeRejectedReceipt = input.cycleStore.snapshot;

  assert.throws(
    () => input.runner.recordDistributionVerification({
      ...receipt,
      verificationSignature: receipt.verificationSignature.slice(1),
    }),
    /distribution verification signature/,
  );
  assert.deepEqual(input.cycleStore.snapshot, beforeRejectedReceipt);

  assert.equal(input.runner.recordDistributionVerification(receipt), receipt.receiptDigest);
  const prepared = input.runner.preparePayoutFunding({
    proceedsKey: input.proceedsKey,
    verificationReceiptDigest: receipt.receiptDigest,
    expiresAt: '1893456000',
    nonce: '9',
  });
  assert.equal(input.runner.inspect().payoutFundingPrepared, true);
  assert.equal(prepared.authority, 'LOCAL_PREPARATION_ONLY_NOT_LIVE_FUNDING_AUTHORITY');
  assert.equal(prepared.manifestDigest, artifact.manifest.digest);
  assert.equal(prepared.rootHash, artifact.root.hash);
  assert.equal(prepared.rootSum, artifact.root.sum);
  const returnAction = input.runner.entries.find(entry => (
    entry.kind === 'intent-prepared' && entry.payload.action.actionKind === 'return'
  ));
  const expectedAuthorization = {
    requirementsRevision: 57,
    chainId: '4663',
    cycleId: CYCLE,
    hook: HOOK,
    vault: '0x0000000000000000000000000000000000001002',
    usdg: '0x0000000000000000000000000000000000001003',
    operationsTrigger: '0x0000000000000000000000000000000000001004',
    bindingManifestDigest: contractBytes32FromDigest(FIXTURE_BINDING_MANIFEST_DIGEST),
    payoutId: PAYOUT,
    manifestDigest: artifact.manifest.digest,
    rootHash: artifact.root.hash,
    rootSum: artifact.root.sum,
    returnActionDigest: contractBytes32FromDigest(returnAction.payload.actionDigest),
    returnReceiptDigest: contractBytes32FromDigest(input.returnReceiptDigest),
    expiresAt: '1893456000',
    nonce: '9',
  };
  assert.deepEqual(prepared.vaultPayoutAuthorization, expectedAuthorization);
  assert.equal(
    prepared.vaultPayoutAuthorizationDigest,
    vaultPayoutAuthorizationDigest(expectedAuthorization),
  );
  const payoutAuthorizationRecord = input.cycleStore.snapshot.authorizations.find(
    record => record.authorizationKind === 'vault-payout',
  );
  assert.equal(payoutAuthorizationRecord.actionKind, 'payout');
  assert.equal(
    input.cycleStore.authorizationKeyForNonce(digest({
      domain: 'hookemon.fixture-vault-payout-authorization-nonce.v1',
      nonce: expectedAuthorization.nonce,
    })),
    payoutAuthorizationRecord.key,
  );

  const preparedEntry = input.runner.entries.at(-1);
  const tamperedJournal = new CycleJournal(CYCLE, input.runner.entries.slice(0, -1));
  tamperedJournal.append(preparedEntry.kind, {
    ...preparedEntry.payload,
    vaultPayoutAuthorization: {
      ...preparedEntry.payload.vaultPayoutAuthorization,
      rootSum: '11',
    },
  });
  assert.throws(
    () => CycleRunner.recover(CYCLE, tamperedJournal.entries, { cycleStore: new FixtureCycleStore() }),
    /vault authorization binding mismatch/,
  );

  const reopenedStore = FixtureCycleStore.reopen(input.cycleStore.snapshot);
  const reopened = CycleRunner.recover(CYCLE, input.runner.entries, { cycleStore: reopenedStore });
  assert.throws(() => reopened.recordDistributionVerification(receipt), /already recorded/);
  assert.throws(
    () => reopened.preparePayoutFunding({
      proceedsKey: input.proceedsKey,
      verificationReceiptDigest: receipt.receiptDigest,
      expiresAt: '1893456000',
      nonce: '9',
    }),
    /already prepared|nonce already consumed/,
  );
});

test('binds a distinct local runner cycle to the observed onchain cycle through verification, funding, and recovery', async () => {
  const runnerCycleId = 'distribution-runner-one';
  const input = fixture({ runnerCycleId, onchainCycleId: CYCLE });
  const { deriveHolderDistributionCandidate } = await import('../../src/distribution/reconcile.mjs');
  const candidate = deriveHolderDistributionCandidate(distributionInput(input));
  const artifact = compileApprovedDistribution({
    ...distributionInput(input),
    approval: signedApproval(candidate),
  });
  const copies = ['primary', 'mirror', 'archive'].map(sourceId => ({
    sourceId,
    manifestBytes: artifact.manifest.bytes,
  }));
  const receipt = signedVerificationReceipt(artifact, copies, verificationContext(input));
  assert.equal(receipt.runnerCycleId, runnerCycleId);
  assert.equal(receipt.onchainCycleId, CYCLE);

  const substituted = resignVerificationReceipt(receipt, { onchainCycleId: OTHER_CYCLE });
  const before = input.cycleStore.snapshot;
  assert.throws(
    () => input.runner.recordDistributionVerification(substituted),
    /onchain|escrow|cycle.*binding/i,
  );
  assert.deepEqual(input.cycleStore.snapshot, before);

  const poisoned = new CycleJournal(runnerCycleId, input.runner.entries);
  poisoned.append('distribution-verification-recorded', { receipt: substituted });
  assert.throws(
    () => CycleRunner.recover(runnerCycleId, poisoned.entries, {
      cycleStore: new FixtureCycleStore(),
      frozenControl: input.frozenControl,
    }),
    /onchain|escrow|cycle.*binding/i,
  );

  input.runner.recordDistributionVerification(receipt);
  const prepared = input.runner.preparePayoutFunding({
    proceedsKey: input.proceedsKey,
    verificationReceiptDigest: receipt.receiptDigest,
    expiresAt: '1893456000',
    nonce: '9',
  });
  assert.equal(prepared.onchainCycleId, CYCLE);
  assert.equal(prepared.vaultPayoutAuthorization.cycleId, CYCLE);

  const reopened = CycleRunner.recover(runnerCycleId, input.runner.entries, {
    cycleStore: FixtureCycleStore.reopen(input.cycleStore.snapshot),
    frozenControl: input.frozenControl,
  });
  assert.equal(reopened.inspect().controlDigest, input.frozenControl.controlDigest);
});
