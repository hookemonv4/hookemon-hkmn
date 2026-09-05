// End-to-end fixture regression (WP-23): DEGRADED quarantine + successor cycle.
//
// WP-03 added `PegCycleVault.recordDegradedReturn(cycleId, receiptDigest, acceptDegraded)`
// (packages/contracts/src/process/PegCycleVault.sol) for a nonzero return that is neither a clean
// payout (>= rootSum) nor a clean failure (== 0) — a short or ambiguous return. Two on-chain gates:
// `balanceOf(escrow) != 0` (a zero balance is FAILED's exclusive territory, not DEGRADED's), and
// `acceptDegraded == true` else `DegradedConfirmationRequired`. The doc comment is explicit that
// `acceptDegraded` "MUST NOT" be set true from an unattended/automatic signing path — accepting a
// short return is an economic judgment call, gated behind "an off-chain, separately-logged human
// confirmation" that must happen *before* the call is even submitted. `authorizeFundingAfterFailure`
// then opens a fresh successor cycle from either FAILED or DEGRADED identically, and the quarantined
// balance itself is never touched by any other function.
//
// A short return leg cannot actually be produced through today's fixture cycle harness: every
// fixture action's own `minimumReceive`/`amount` fields are pinned to an exact-match policy
// whitelist (`assertFixtureActionPolicy` in packages/runner/src/cycle/schemas.mjs requires
// `minimumReceive === '10'` for every action kind, including return), and
// `assertReceiptRelationship` separately requires `amountOut >= minimumReceive` — together these
// make an executed, finalized return leg crediting less than '10' unrepresentable without editing
// that core validation policy, which is real production logic (owned by WP-29's reducer rewrite),
// not something this package should touch. So this test instead reuses the exact technique
// `holder-candidate.test.mjs` already established for exercising a closed-proceeds basis at a
// value other than the fixture's fixed '10': clone the REAL basis returned by the real fixture
// cycle pipeline, override `finalCredit.{amount,preBalance,postBalance}` to model the short
// return, and recompute `basisDigest` — a `hookemon.closed-proceeds-basis.v1` object is documented
// as `READ_ONLY_SELF_CONSISTENT_NOT_STORE_MEMBERSHIP_PROOF`, i.e. exactly this kind of
// input-bound-but-not-store-authenticated reuse is within its stated contract.
import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import test from 'node:test';

import { CycleRunner } from '../../src/cycle/cycle-runner.mjs';
import { FixtureCycleStore } from '../../src/cycle/cycle-store.mjs';
import { digest } from '../../src/cycle/journal.mjs';
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
const CYCLE_A = `0x${'c'.repeat(64)}`;
const CYCLE_B = `0x${'f'.repeat(64)}`;
const PAYOUT = `0x${'d'.repeat(64)}`;
const MINIMUM_RETURN_USDG = '10'; // the cycle-level expected return the fixture pipeline models
const SHORT_RETURN_CREDITED = '4'; // nonzero, below MINIMUM_RETURN_USDG: short, not a clean failure

/// Mirrors, verbatim, `PegCycleVault.authorizePayout`'s minimum-return gate:
///   authorization.rootSum < activeAuthorization.minimumReturnUsdg => revert InvalidAuthorization
function wouldAuthorizePayoutSucceed({ rootSum, minimumReturnUsdg }) {
  return BigInt(rootSum) >= BigInt(minimumReturnUsdg);
}

/// Mirrors, verbatim, `PegCycleVault.recordDegradedReturn`'s two on-chain gates:
///   balanceOf(escrow) == 0                => revert InvalidAuthorization  (that's FAILED's case)
///   acceptDegraded != true                => revert DegradedConfirmationRequired
/// plus the off-chain signing-policy requirement its doc comment mandates in prose ("The
/// authorizer's own signing policy MUST NOT set acceptDegraded=true from an unattended/automatic
/// path"): `acceptDegraded` may only be considered true if a distinct, separately-logged human
/// confirmation record for this exact receipt already exists. This is a citation plus the policy
/// the design/WP-03 explicitly require be enforced off-chain, not a reimplementation of the
/// contract's own logic.
function applyRecordDegradedReturn({ liveEscrowBalance, receiptDigest, acceptDegraded, confirmation }) {
  if (liveEscrowBalance === 0n) {
    throw new Error('recordDegradedReturn would revert InvalidAuthorization: escrow balance is zero');
  }
  if (
    !confirmation
    || confirmation.receiptDigest !== receiptDigest
    || confirmation.acceptDegraded !== true
  ) {
    throw new Error('signing policy refusal: acceptDegraded requires a separately-logged human confirmation for this exact receipt');
  }
  if (!acceptDegraded) {
    throw new Error('recordDegradedReturn would revert DegradedConfirmationRequired');
  }
  return { receiptDigest, lifecycle: 'DEGRADED', quarantinedBalance: liveEscrowBalance };
}

function closedCycle(cycleId, cycleStore) {
  const runner = new CycleRunner(cycleId, [], { cycleStore });
  const { returnReceiptDigest } = executeCompleteFixtureCycle(runner, cycleId);
  runner.deriveClosedCycle();
  const proceedsKey = runner.consumeReturnedProceedsOnce({ receiptDigest: returnReceiptDigest });
  const closedProceedsBasis = deriveClosedProceedsBasis(
    runner.readClosedProceedsBasisHandoff({ proceedsKey }),
  );
  return { runner, returnReceiptDigest, proceedsKey, closedProceedsBasis };
}

/// Clones a real closed-proceeds basis and overrides its final credit to model a return whose
/// actual on-chain balance diverged from the ordinarily-expected amount, recomputing the digest —
/// the exact technique `holder-candidate.test.mjs` already uses to exercise this input-bound,
/// `READ_ONLY_SELF_CONSISTENT_NOT_STORE_MEMBERSHIP_PROOF` structure at a value other than the
/// fixture harness's own fixed return amount.
function withFinalCreditAmount(basis, amount) {
  const clone = structuredClone(basis);
  clone.finalCredit.preBalance = '0';
  clone.finalCredit.postBalance = amount;
  clone.finalCredit.amount = amount;
  const { basisDigest: _old, ...content } = clone;
  clone.basisDigest = digest({ domain: 'hookemon.closed-proceeds-basis.v1', basis: content });
  return clone;
}

function signedApproval(candidate, cycleId) {
  const payload = {
    schema: 'hookemon.fixture-distribution-approval.v1',
    authority: 'FIXTURE_OWNER_SIGNATURE',
    candidateDigest: candidate.candidateDigest,
    closedProceedsBasisDigest: candidate.closedProceedsBasisDigest,
    entriesDigest: candidate.entriesDigest,
    chainId: candidate.snapshot.chainId,
    hook: HOOK,
    cycleId,
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

function snapshotAndEntries(amountA, amountB) {
  return {
    snapshot: {
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
    },
    entries: [
      { index: 0, recipient: RECIPIENT_A, directHkmnBalance: '100', amountAtomicUSDG: amountA },
      { index: 1023, recipient: RECIPIENT_B, directHkmnBalance: '200', amountAtomicUSDG: amountB },
    ],
  };
}

test('a short return basis is evidenced exactly as short, and the real reconcile code refuses to launder it into a full-amount manifest', () => {
  const cycleStore = new FixtureCycleStore();
  const { closedProceedsBasis } = closedCycle(CYCLE_A, cycleStore);
  const shortBasis = withFinalCreditAmount(closedProceedsBasis, SHORT_RETURN_CREDITED);

  assert.equal(shortBasis.finalCredit.amount, SHORT_RETURN_CREDITED);
  assert.notEqual(shortBasis.finalCredit.amount, MINIMUM_RETURN_USDG);

  // Real production code (deriveHolderDistributionCandidate), not a mirror: entries summing to
  // the *originally expected* full amount must be rejected against the genuinely short basis.
  const { snapshot, entries } = snapshotAndEntries('4', '6'); // sums to '10', the expected amount
  assert.throws(
    () => deriveHolderDistributionCandidate({ closedProceedsBasis: shortBasis, snapshot, entries }),
    /holder candidate USDG sum must equal the closed proceeds final credit/,
  );
});

test('the ordinary authorizePayout path is unavailable for a short return, even though the off-chain manifest can mechanically be built for the exact short amount', () => {
  const cycleStore = new FixtureCycleStore();
  const { runner, closedProceedsBasis, proceedsKey } = closedCycle(CYCLE_A, cycleStore);
  const shortBasis = withFinalCreditAmount(closedProceedsBasis, SHORT_RETURN_CREDITED);

  // The off-chain pipeline itself does not gate on minimumReturnUsdg (that is purely an on-chain
  // check) — a manifest for the exact short amount can be compiled and verified mechanically.
  const { snapshot, entries } = snapshotAndEntries('1', '3'); // sums to '4', the true short amount
  const candidateInput = { closedProceedsBasis: shortBasis, snapshot, entries };
  const candidate = deriveHolderDistributionCandidate(candidateInput);
  const artifact = compileApprovedDistribution({ ...candidateInput, approval: signedApproval(candidate, shortBasis.cycleId) });
  const copies = ['primary', 'mirror', 'archive'].map(sourceId => ({ sourceId, manifestBytes: artifact.manifest.bytes }));
  const receipt = verifyDistributionCopies(artifact, copies, {
    runnerCycleId: shortBasis.cycleId,
    proceedsKey,
    closedLedgerDigest: shortBasis.closedLedgerDigest,
    closedProceedsBasisDigest: shortBasis.basisDigest,
    verificationJournalHead: runner.state.journalHead,
  });
  assert.equal(receipt.rootSum, SHORT_RETURN_CREDITED);

  // But that manifest's rootSum still fails the contract's minimum-return gate — the ordinary
  // authorizePayout path is simply not open for this cycle, no matter how the manifest is built.
  assert.equal(
    wouldAuthorizePayoutSucceed({ rootSum: receipt.rootSum, minimumReturnUsdg: MINIMUM_RETURN_USDG }),
    false,
  );
});

test('recordDegradedReturn requires both a nonzero balance and a separately-logged confirmation before acceptDegraded may be true, and never touches the quarantined balance', () => {
  const cycleStore = new FixtureCycleStore();
  const { runner, returnReceiptDigest, closedProceedsBasis } = closedCycle(CYCLE_A, cycleStore);
  const shortBasis = withFinalCreditAmount(closedProceedsBasis, SHORT_RETURN_CREDITED);
  const liveEscrowBalance = BigInt(shortBasis.finalCredit.amount);
  const confirmation = {
    schema: 'hookemon.fixture-degraded-confirmation.v1',
    authority: 'FIXTURE_OWNER_OFF_CHAIN_CONFIRMATION',
    cycleId: CYCLE_A,
    receiptDigest: returnReceiptDigest,
    acceptDegraded: true,
    confirmedAt: '2029-06-01T00:00:00.000Z',
  };

  // No confirmation at all: the signing policy refuses regardless of the acceptDegraded flag.
  assert.throws(
    () => applyRecordDegradedReturn({ liveEscrowBalance, receiptDigest: returnReceiptDigest, acceptDegraded: true, confirmation: null }),
    /separately-logged human confirmation/,
  );
  // acceptDegraded left false: the on-chain call itself would revert, confirmation or not.
  assert.throws(
    () => applyRecordDegradedReturn({ liveEscrowBalance, receiptDigest: returnReceiptDigest, acceptDegraded: false, confirmation }),
    /DegradedConfirmationRequired/,
  );
  // A confirmation for a *different* receipt cannot authorize this one.
  assert.throws(
    () => applyRecordDegradedReturn({
      liveEscrowBalance, receiptDigest: returnReceiptDigest, acceptDegraded: true,
      confirmation: { ...confirmation, receiptDigest: `sha256:${'0'.repeat(64)}` },
    }),
    /separately-logged human confirmation/,
  );
  // A zero balance is FAILED's exclusive territory, not DEGRADED's, however the flags are set.
  assert.throws(
    () => applyRecordDegradedReturn({ liveEscrowBalance: 0n, receiptDigest: returnReceiptDigest, acceptDegraded: true, confirmation }),
    /balance is zero/,
  );

  // Confirmation present, flag true, balance nonzero: the quarantine succeeds, and quarantines
  // exactly the short balance — nothing is swept, floored, or rounded away.
  const quarantine = applyRecordDegradedReturn({ liveEscrowBalance, receiptDigest: returnReceiptDigest, acceptDegraded: true, confirmation });
  assert.equal(quarantine.lifecycle, 'DEGRADED');
  assert.equal(quarantine.quarantinedBalance, liveEscrowBalance);
  assert.equal(quarantine.quarantinedBalance, BigInt(SHORT_RETURN_CREDITED));

  // The off-chain journal for cycle A never even attempted a distribution/payout-funding step —
  // going DEGRADED is a decision made instead of, not after, the ordinary payout preparation.
  assert.equal(runner.inspect().payoutFundingPrepared, false);
  assert.equal(runner.inspect().stage, 'closed');
});

test('a successor cycle, sharing the same durable store as the degraded predecessor, starts and fully completes through the same fixture pipeline', () => {
  const cycleStore = new FixtureCycleStore();
  const degraded = closedCycle(CYCLE_A, cycleStore);
  // Cycle A is left exactly as a DEGRADED quarantine would leave it: closed, unfunded, untouched.
  assert.equal(degraded.runner.inspect().payoutFundingPrepared, false);

  // Cycle B: a fresh cycleId in the *same* store, run through the unmodified, ordinary path.
  const successor = closedCycle(CYCLE_B, cycleStore);
  assert.equal(successor.closedProceedsBasis.finalCredit.amount, MINIMUM_RETURN_USDG);

  const { snapshot, entries } = snapshotAndEntries('4', '6');
  const candidateInput = { closedProceedsBasis: successor.closedProceedsBasis, snapshot, entries };
  const candidate = deriveHolderDistributionCandidate(candidateInput);
  const artifact = compileApprovedDistribution({ ...candidateInput, approval: signedApproval(candidate, CYCLE_B) });
  const copies = ['primary', 'mirror', 'archive'].map(sourceId => ({ sourceId, manifestBytes: artifact.manifest.bytes }));
  const receipt = verifyDistributionCopies(artifact, copies, {
    runnerCycleId: successor.closedProceedsBasis.cycleId,
    proceedsKey: successor.proceedsKey,
    closedLedgerDigest: successor.closedProceedsBasis.closedLedgerDigest,
    closedProceedsBasisDigest: successor.closedProceedsBasis.basisDigest,
    verificationJournalHead: successor.runner.state.journalHead,
  });
  const signedReceipt = {
    ...receipt,
    verificationSignature: sign(
      null,
      Buffer.from(distributionVerificationDigest(receipt), 'utf8'),
      DISTRIBUTION_VERIFIER_PRIVATE_KEY,
    ).toString('base64url'),
  };
  successor.runner.recordDistributionVerification(signedReceipt);
  const prepared = successor.runner.preparePayoutFunding({
    proceedsKey: successor.proceedsKey,
    verificationReceiptDigest: signedReceipt.receiptDigest,
    expiresAt: '1893456000',
    nonce: '9',
  });

  assert.equal(successor.runner.inspect().payoutFundingPrepared, true);
  assert.equal(prepared.rootSum, MINIMUM_RETURN_USDG);
  assert.equal(
    wouldAuthorizePayoutSucceed({ rootSum: prepared.rootSum, minimumReturnUsdg: MINIMUM_RETURN_USDG }),
    true,
  );

  // Both cycles coexist in the one shared store: the predecessor's degraded evidence is
  // undisturbed by the successor's success.
  assert.equal(degraded.runner.inspect().stage, 'closed');
  assert.equal(degraded.runner.inspect().payoutFundingPrepared, false);
});
