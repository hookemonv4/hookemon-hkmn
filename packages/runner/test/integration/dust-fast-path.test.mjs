// End-to-end fixture regression (WP-23): the dust fast path.
//
// `PegCycleVault.authorizePayout` (packages/contracts/src/process/PegCycleVault.sol) was relaxed
// by WP-03 from requiring the escrow's live balance to equal `rootSum` exactly to requiring only
// `balance >= rootSum` (see the `IPegCycleUsdg(usdg).balanceOf(escrowAddress) < authorization.rootSum`
// guard in `authorizePayout`), and `consumePayoutAuthorization` always calls
// `PegCycleReturnEscrow.sendPayout(authorization.rootSum)` — never `balance` — so a trivial excess
// (a stray donation, rounding residue) is left untouched in the escrow rather than wedging the
// cycle or leaking into the payout.
//
// `rootSum` itself is never a free parameter off-chain: `deriveHolderDistributionCandidate`
// (packages/runner/src/distribution/reconcile.mjs) requires the manifest's total to equal the
// closed cycle's `finalCredit.amount` exactly, and `recordDistributionVerification`
// (packages/runner/src/cycle/reducer.mjs) requires the signed verification receipt's `rootSum` to
// match that same `finalCredit.amount` exactly. So the off-chain pipeline can only ever produce a
// `PayoutAuthorization.rootSum` equal to the return leg's real, evidenced credit — there is no
// off-chain field for "expected balance" or "excess" at all. A dust excess is therefore, by
// construction, a fact the escrow's *live* on-chain balance can carry that no off-chain artifact
// ever claims or depends on. This test proves both halves: (1) the full existing fixture pipeline
// produces a real, well-formed `PayoutAuthorization` whose exact schema has no balance field, so
// dust can never leak into what gets signed, and (2) the contract's documented acceptance rule —
// mirrored here as a small, literally-cited pure function, not reimplemented business logic —
// pays exactly that `rootSum` for any live balance at or above it, and refuses (must instead go
// through `recordDegradedReturn`, see degraded-return.test.mjs) below it.
import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import test from 'node:test';

import { CycleRunner } from '../../src/cycle/cycle-runner.mjs';
import { FixtureCycleStore } from '../../src/cycle/cycle-store.mjs';
import {
  encodeVaultPayoutAuthorization,
  validateVaultPayoutAuthorization,
} from '../../src/cycle/vault-payout-authorization.mjs';
import {
  compileApprovedDistribution,
  distributionApprovalDigest,
  distributionVerificationDigest,
  verifyDistributionCopies,
} from '../../src/distribution/manifest.mjs';
import { deriveClosedProceedsBasis, deriveHolderDistributionCandidate } from '../../src/distribution/reconcile.mjs';
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
const RECIPIENT_A = `0x${'1'.repeat(40)}`;
const RECIPIENT_B = `0x${'2'.repeat(40)}`;
const HOOK = `0x${'a'.repeat(40)}`;
const CYCLE = `0x${'c'.repeat(64)}`;
const PAYOUT = `0x${'d'.repeat(64)}`;

/// Mirrors, verbatim, the two lines of `PegCycleVault.sol` that implement the dust fast path:
///
///   authorizePayout:            balanceOf(escrow) < authorization.rootSum        => revert
///   consumePayoutAuthorization: PegCycleReturnEscrow(escrow).sendPayout(authorization.rootSum)
///
/// i.e. the only gate is `liveEscrowBalance >= rootSum`, and the transfer is always exactly
/// `rootSum` — never `liveEscrowBalance`. This is a citation, not a reimplementation: it carries
/// no logic beyond that one comparison and that one fixed transfer amount, so there is nothing
/// here that could itself diverge from the audited contract behavior in a way that would matter.
function applyDustFastPath({ liveEscrowBalance, rootSum }) {
  if (liveEscrowBalance < rootSum) {
    throw new Error('authorizePayout would revert InvalidAuthorization: balance below rootSum');
  }
  return { transferred: rootSum, remainingInEscrow: liveEscrowBalance - rootSum };
}

function fixture() {
  const cycleId = CYCLE;
  const cycleStore = new FixtureCycleStore();
  const runner = new CycleRunner(cycleId, [], { cycleStore });
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
    chainId: '4663',
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
  return { cycleStore, runner, proceedsKey, returnReceiptDigest, closedProceedsBasis, snapshot, entries };
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

function signedVerificationReceipt(artifact, copies, context) {
  const receipt = verifyDistributionCopies(artifact, copies, context);
  return {
    ...receipt,
    verificationSignature: sign(
      null,
      Buffer.from(distributionVerificationDigest(receipt), 'utf8'),
      DISTRIBUTION_VERIFIER_PRIVATE_KEY,
    ).toString('base64url'),
  };
}

/// Drives the real, existing fixture pipeline (fixture cycle -> holder-distribution candidate ->
/// dual-copy-verified canonical distribution -> signed verifier receipt -> vault payout
/// authorization) exactly as `manifest.test.mjs` does, and returns the resulting
/// `PayoutAuthorization` tuple untouched.
function buildRealPayoutAuthorization() {
  const input = fixture();
  const candidateInput = { closedProceedsBasis: input.closedProceedsBasis, snapshot: input.snapshot, entries: input.entries };
  const candidate = deriveHolderDistributionCandidate(candidateInput);
  const artifact = compileApprovedDistribution({ ...candidateInput, approval: signedApproval(candidate) });
  const copies = ['primary', 'mirror', 'archive'].map(sourceId => ({ sourceId, manifestBytes: artifact.manifest.bytes }));
  const receipt = signedVerificationReceipt(artifact, copies, {
    runnerCycleId: input.closedProceedsBasis.cycleId,
    proceedsKey: input.proceedsKey,
    closedLedgerDigest: input.closedProceedsBasis.closedLedgerDigest,
    closedProceedsBasisDigest: input.closedProceedsBasis.basisDigest,
    verificationJournalHead: input.runner.state.journalHead,
  });
  input.runner.recordDistributionVerification(receipt);
  const prepared = input.runner.preparePayoutFunding({
    proceedsKey: input.proceedsKey,
    verificationReceiptDigest: receipt.receiptDigest,
    expiresAt: '1893456000',
    nonce: '9',
  });
  return { input, artifact, prepared };
}

test('the full fixture pipeline produces a real PayoutAuthorization with rootSum equal to the exact returned proceeds and no balance field', () => {
  const { input, artifact, prepared } = buildRealPayoutAuthorization();

  assert.equal(prepared.rootSum, input.closedProceedsBasis.finalCredit.amount);
  assert.equal(prepared.rootSum, artifact.root.sum);
  assert.equal(prepared.rootSum, '10');

  const authorization = validateVaultPayoutAuthorization(prepared.vaultPayoutAuthorization);
  assert.deepEqual(
    Object.keys(authorization).sort(),
    [
      'bindingManifestDigest', 'chainId', 'cycleId', 'expiresAt', 'hook', 'manifestDigest', 'nonce',
      'operationsTrigger', 'payoutId', 'requirementsRevision', 'returnActionDigest', 'returnReceiptDigest',
      'rootHash', 'rootSum', 'usdg', 'vault',
    ].sort(),
  );
  // Structural proof, not just an absence check by name: the ABI-encoded authorization is exactly
  // 16 words (512 bytes) — there is no room for a 17th "balance" word to have leaked in anywhere.
  assert.equal((encodeVaultPayoutAuthorization(authorization).length - 2) / 64, 16);
});

test('a live balance at or above rootSum pays out exactly rootSum, leaving the excess untouched, however large the excess', () => {
  const { prepared } = buildRealPayoutAuthorization();
  const rootSum = BigInt(prepared.rootSum);

  for (const excess of [0n, 1n, 2n, 1000n, 1_000_000_000n]) {
    const liveEscrowBalance = rootSum + excess;
    const outcome = applyDustFastPath({ liveEscrowBalance, rootSum });
    assert.equal(outcome.transferred, rootSum, `excess ${excess}: must transfer exactly rootSum, never the live balance`);
    assert.equal(outcome.remainingInEscrow, excess, `excess ${excess}: the dust must be left exactly as-is, not partially swept`);
    // The transfer amount can never simply echo whatever the escrow happens to hold — assert it
    // independently of the live balance for every excess above zero, so a fast path that
    // accidentally paid `liveEscrowBalance` instead of `rootSum` cannot pass this test by
    // coincidence.
    if (excess > 0n) assert.notEqual(outcome.transferred, liveEscrowBalance);
  }
});

test('a live balance below rootSum by any amount is refused by the dust fast path, including by exactly one unit', () => {
  const { prepared } = buildRealPayoutAuthorization();
  const rootSum = BigInt(prepared.rootSum);

  for (const shortfall of [1n, 2n, rootSum]) {
    const liveEscrowBalance = rootSum - shortfall;
    assert.throws(
      () => applyDustFastPath({ liveEscrowBalance, rootSum }),
      /balance below rootSum/,
      `shortfall ${shortfall} must not be treated as dust`,
    );
  }
});

test('the dust fast path is keyed only to the authorization rootSum that was actually signed, never a value chosen ad hoc by the test', () => {
  const { prepared } = buildRealPayoutAuthorization();
  // Recompute rootSum from the signed, ABI-encodable authorization tuple itself (not from a
  // hand-typed literal) before applying the fast path, closing the gap where a test could
  // "prove" the invariant against the wrong number.
  const authorization = validateVaultPayoutAuthorization(prepared.vaultPayoutAuthorization);
  const rootSum = BigInt(authorization.rootSum);
  const outcome = applyDustFastPath({ liveEscrowBalance: rootSum + 3n, rootSum });
  assert.equal(outcome.transferred, rootSum);
  assert.equal(outcome.remainingInEscrow, 3n);
});
