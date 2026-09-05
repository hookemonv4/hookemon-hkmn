// WP-39: the production-profile Merkle-sum artifact builder in manifest.mjs — the direct analog
// of the fixture `compileApprovedDistribution`, minus any Ed25519 key or local owner-approval
// object (see manifest.mjs's own header comment on this section). Reuses this directory's own
// manifest.test.mjs `fixture()`/`distributionInput()` helpers for the candidate inputs so both
// test files exercise the exact same underlying reconciled cycle.
import assert from 'node:assert/strict';
import test from 'node:test';

import { CycleRunner } from '../../src/cycle/cycle-runner.mjs';
import { FixtureCycleStore } from '../../src/cycle/cycle-store.mjs';
import { deriveClosedProceedsBasis } from '../../src/distribution/reconcile.mjs';
import {
  buildProductionDistributionArtifact,
  verifyProductionDistributionArtifactReconstruction,
} from '../../src/distribution/manifest.mjs';
import { verifyProof } from '../../src/distribution/merkle-sum.mjs';
import { executeCompleteFixtureCycle } from '../cycle/fixture-cycle.mjs';

const RECIPIENT_A = `0x${'1'.repeat(40)}`;
const RECIPIENT_B = `0x${'2'.repeat(40)}`;
const HOOK = `0x${'a'.repeat(40)}`;
const VAULT = `0x${'b'.repeat(40)}`;
const USDG = `0x${'c'.repeat(40)}`;
const OPERATIONS_TRIGGER = `0x${'d'.repeat(40)}`;
const CYCLE = `0x${'c'.repeat(64)}`;
const PAYOUT = `0x${'d'.repeat(64)}`;
const BINDING_MANIFEST_DIGEST = `0x${'9'.repeat(64)}`;

function fixture() {
  const cycleStore = new FixtureCycleStore();
  const runner = new CycleRunner(CYCLE, [], { cycleStore });
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
  return { closedProceedsBasis, snapshot, entries };
}

function domainFor(input) {
  return {
    requirementsRevision: 57,
    chainId: input.snapshot.chainId,
    cycleId: CYCLE,
    hook: HOOK,
    vault: VAULT,
    usdg: USDG,
    operationsTrigger: OPERATIONS_TRIGGER,
    bindingManifestDigest: BINDING_MANIFEST_DIGEST,
  };
}

test('buildProductionDistributionArtifact compiles the same reconciled return, no owner-approval object involved', () => {
  const input = fixture();
  const artifact = buildProductionDistributionArtifact({
    closedProceedsBasis: input.closedProceedsBasis,
    snapshot: input.snapshot,
    entries: input.entries,
    domain: domainFor(input),
    payoutId: PAYOUT,
  });

  assert.equal(artifact.schema, 'hookemon.production-eip712-holder-distribution.v1');
  assert.equal(artifact.root.sum, input.closedProceedsBasis.finalCredit.amount);
  assert.equal(artifact.domain.hook, HOOK);
  assert.equal(artifact.domain.vault, VAULT);
  assert.equal(artifact.domain.operationsTrigger, OPERATIONS_TRIGGER);
  assert.equal(artifact.domain.payoutId, PAYOUT);
  assert.equal(typeof artifact.ownerApprovalDigest, 'undefined');
  assert.equal(artifact.proofs.length, 1024);
  for (const entry of artifact.entries) {
    assert.equal(verifyProof(artifact.leaves[entry.index], entry.index, artifact.proofs[entry.index], artifact.root), true);
  }
});

test('two independent builders from the same candidate inputs produce byte-identical artifacts', () => {
  const input = fixture();
  const artifactOne = buildProductionDistributionArtifact({
    closedProceedsBasis: input.closedProceedsBasis, snapshot: input.snapshot, entries: input.entries,
    domain: domainFor(input), payoutId: PAYOUT,
  });
  const artifactTwo = buildProductionDistributionArtifact({
    closedProceedsBasis: input.closedProceedsBasis, snapshot: input.snapshot, entries: input.entries,
    domain: domainFor(input), payoutId: PAYOUT,
  });
  assert.equal(artifactOne.manifest.digest, artifactTwo.manifest.digest);
  assert.equal(artifactOne.root.hash, artifactTwo.root.hash);
  assert.equal(artifactOne.root.sum, artifactTwo.root.sum);
});

test('verifyProductionDistributionArtifactReconstruction accepts a genuine artifact and rejects a tampered one', () => {
  const input = fixture();
  const artifact = buildProductionDistributionArtifact({
    closedProceedsBasis: input.closedProceedsBasis, snapshot: input.snapshot, entries: input.entries,
    domain: domainFor(input), payoutId: PAYOUT,
  });
  const verified = verifyProductionDistributionArtifactReconstruction(artifact);
  assert.equal(verified.manifest.digest, artifact.manifest.digest);

  const tampered = structuredClone(artifact);
  tampered.root.sum = String(BigInt(tampered.root.sum) + 1n);
  assert.throws(() => verifyProductionDistributionArtifactReconstruction(tampered), /reconstruction mismatch/);
});

test('buildProductionDistributionArtifact rejects a zero payoutId', () => {
  const input = fixture();
  assert.throws(
    () => buildProductionDistributionArtifact({
      closedProceedsBasis: input.closedProceedsBasis, snapshot: input.snapshot, entries: input.entries,
      domain: domainFor(input), payoutId: `0x${'0'.repeat(64)}`,
    }),
    /payoutId/,
  );
});

test('buildProductionDistributionArtifact rejects an incomplete domain', () => {
  const input = fixture();
  const { operationsTrigger: _dropped, ...incompleteDomain } = domainFor(input);
  assert.throws(
    () => buildProductionDistributionArtifact({
      closedProceedsBasis: input.closedProceedsBasis, snapshot: input.snapshot, entries: input.entries,
      domain: incompleteDomain, payoutId: PAYOUT,
    }),
    /exact schema/,
  );
});
