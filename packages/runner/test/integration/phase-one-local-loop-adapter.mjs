import { createPrivateKey, sign } from 'node:crypto';

import { CycleRunner } from '../../src/cycle/cycle-runner.mjs';
import { FixtureCycleStore } from '../../src/cycle/cycle-store.mjs';
import { FIXTURE_BINDING_MANIFEST_DIGEST } from '../../src/cycle/preflight.mjs';
import {
  contractBytes32FromDigest,
  vaultPayoutAuthorizationDigest,
} from '../../src/cycle/vault-payout-authorization.mjs';
import {
  compileApprovedDistribution,
  distributionApprovalDigest,
  distributionVerificationDigest,
  verifyDistributionCopies,
} from '../../src/distribution/manifest.mjs';
import {
  deriveClosedProceedsBasis,
  deriveHolderDistributionCandidate,
} from '../../src/distribution/reconcile.mjs';
import { executeCompleteFixtureCycle } from '../cycle/fixture-cycle.mjs';

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
const CYCLE_ID = `0x${'c'.repeat(64)}`;
const PAYOUT_ID = `0x${'d'.repeat(64)}`;
const RECIPIENT = '0x0000000000000000000000000000000000001001';

const hook = process.argv[2]?.toLowerCase();
const chainId = process.argv[3];
if (!/^0x[0-9a-f]{40}$/.test(hook ?? '')) throw new Error('hook argument is invalid');
if (!/^(?:[1-9][0-9]*)$/.test(chainId ?? '')) throw new Error('chainId argument is invalid');

const cycleStore = new FixtureCycleStore();
const runner = new CycleRunner(CYCLE_ID, [], { cycleStore });
const { returnReceiptDigest } = executeCompleteFixtureCycle(runner, CYCLE_ID, { hook });
runner.deriveClosedCycle();
const proceedsKey = runner.consumeReturnedProceedsOnce({ receiptDigest: returnReceiptDigest });
const closedProceedsBasis = deriveClosedProceedsBasis(
  runner.readClosedProceedsBasisHandoff({ proceedsKey }),
);
if (closedProceedsBasis.finalCredit.amount !== '10') {
  throw new Error('fixture return amount changed');
}

const snapshot = {
  schema: 'hookemon.input-bound-hkmn-snapshot-candidate.v1',
  authority: 'INPUT_BOUND_CANDIDATE_NOT_AUTHENTICATED',
  asset: 'HKMN',
  chainId,
  tokenAddress: `0x${'b'.repeat(40)}`,
  blockNumber: '12345678',
  blockHash: `0x${'e'.repeat(64)}`,
  finalized: true,
  directBalances: [{ recipient: RECIPIENT, directHkmnBalance: '100' }],
};
const entries = [
  { index: 0, recipient: RECIPIENT, directHkmnBalance: '100', amountAtomicUSDG: '10' },
];
const candidateInput = { closedProceedsBasis, snapshot, entries };
const candidate = deriveHolderDistributionCandidate(candidateInput);
const approvalPayload = {
  schema: 'hookemon.fixture-distribution-approval.v1',
  authority: 'FIXTURE_OWNER_SIGNATURE',
  candidateDigest: candidate.candidateDigest,
  closedProceedsBasisDigest: candidate.closedProceedsBasisDigest,
  entriesDigest: candidate.entriesDigest,
  chainId,
  hook,
  cycleId: CYCLE_ID,
  payoutId: PAYOUT_ID,
  snapshotNumber: snapshot.blockNumber,
  snapshotHash: snapshot.blockHash,
};
const approvalDigest = distributionApprovalDigest(approvalPayload);
const approval = {
  ...approvalPayload,
  approvalDigest,
  signature: sign(null, Buffer.from(approvalDigest, 'utf8'), OWNER_PRIVATE_KEY).toString('base64url'),
};
const artifact = compileApprovedDistribution({ ...candidateInput, approval });
const copies = ['primary', 'mirror', 'archive'].map((sourceId) => ({
  sourceId,
  manifestBytes: artifact.manifest.bytes,
}));
const receipt = verifyDistributionCopies(artifact, copies, {
  runnerCycleId: CYCLE_ID,
  proceedsKey,
  closedLedgerDigest: closedProceedsBasis.closedLedgerDigest,
  closedProceedsBasisDigest: closedProceedsBasis.basisDigest,
  verificationJournalHead: runner.state.journalHead,
});
const signedReceipt = {
  ...receipt,
  verificationSignature: sign(
    null,
    Buffer.from(distributionVerificationDigest(receipt), 'utf8'),
    DISTRIBUTION_VERIFIER_PRIVATE_KEY,
  ).toString('base64url'),
};
runner.recordDistributionVerification(signedReceipt);
const prepared = runner.preparePayoutFunding({
  proceedsKey,
  verificationReceiptDigest: receipt.receiptDigest,
  expiresAt: '1893456000',
  nonce: '9',
});
const returnAction = runner.entries.find(entry => (
  entry.kind === 'intent-prepared' && entry.payload.action.actionKind === 'return'
));
const expectedAuthorization = {
  requirementsRevision: 57,
  chainId,
  cycleId: CYCLE_ID,
  hook,
  vault: '0x0000000000000000000000000000000000001002',
  usdg: '0x0000000000000000000000000000000000001003',
  operationsTrigger: '0x0000000000000000000000000000000000001004',
  bindingManifestDigest: contractBytes32FromDigest(FIXTURE_BINDING_MANIFEST_DIGEST),
  payoutId: PAYOUT_ID,
  manifestDigest: artifact.manifest.digest,
  rootHash: artifact.root.hash,
  rootSum: artifact.root.sum,
  returnActionDigest: contractBytes32FromDigest(returnAction.payload.actionDigest),
  returnReceiptDigest: contractBytes32FromDigest(returnReceiptDigest),
  expiresAt: '1893456000',
  nonce: '9',
};
if (
  prepared.authority !== 'LOCAL_PREPARATION_ONLY_NOT_LIVE_FUNDING_AUTHORITY'
  || prepared.manifestDigest !== artifact.manifest.digest
  || prepared.rootHash !== artifact.root.hash
  || prepared.rootSum !== artifact.root.sum
  || JSON.stringify(prepared.vaultPayoutAuthorization) !== JSON.stringify(expectedAuthorization)
  || prepared.vaultPayoutAuthorizationDigest !== vaultPayoutAuthorizationDigest(expectedAuthorization)
) throw new Error('local funding preparation differs from the canonical artifact');

const proof = artifact.proofs[0];
const word = (value) => BigInt(value).toString(16).padStart(64, '0');
const bytes32 = (value) => value.slice(2);
const address = (value) => value.slice(2).padStart(64, '0');
const encoded = [
  bytes32(CYCLE_ID),
  bytes32(PAYOUT_ID),
  bytes32(artifact.manifest.digest),
  bytes32(artifact.root.hash),
  word(artifact.root.sum),
  address(RECIPIENT),
  word(entries[0].amountAtomicUSDG),
  ...proof.siblingHashes.map(bytes32),
  ...proof.siblingSums.map(word),
].join('');
process.stdout.write(`0x${encoded}`);
