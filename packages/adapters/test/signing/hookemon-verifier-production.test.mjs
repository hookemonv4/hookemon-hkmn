// WP-39: the production-profile branch of `bin/hookemon-verifier.mjs`'s `runOnePass` — the
// verifier independently rebuilds the Merkle-sum artifact from the request's own candidate inputs
// (never trusting the requester's own numbers), cross-checks the distribution-signer's claimed
// manifestDigest/rootHash/rootSum/EIP-712 digest against that rebuild, and only then signs the
// same digest with its own key. A request whose claimed fields do not match its own inputs is
// answered in `failed/`, never `receipts/`.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CycleRunner } from '../../../runner/src/cycle/cycle-runner.mjs';
import { FixtureCycleStore } from '../../../runner/src/cycle/cycle-store.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { deriveClosedProceedsBasis } from '../../../runner/src/distribution/reconcile.mjs';
import { buildProductionDistributionArtifact } from '../../../runner/src/distribution/manifest.mjs';
import { executeCompleteFixtureCycle } from '../../../runner/test/cycle/fixture-cycle.mjs';
import { VERIFIER_ROLE } from '../../src/signing/signer-client.mjs';
import { payoutDistributionDigest } from '../../src/signing/payout-typed-data.mjs';
import { runOnePass } from '../../bin/hookemon-verifier.mjs';

const RECIPIENT_A = `0x${'1'.repeat(40)}`;
const RECIPIENT_B = `0x${'2'.repeat(40)}`;
const HOOK = `0x${'a'.repeat(40)}`;
const VAULT = `0x${'b'.repeat(40)}`;
const USDG = `0x${'c'.repeat(40)}`;
const OPERATIONS_TRIGGER = `0x${'d'.repeat(40)}`;
const CYCLE = `0x${'c'.repeat(64)}`;
const PAYOUT = `0x${'d'.repeat(64)}`;
const BINDING_MANIFEST_DIGEST = `0x${'9'.repeat(64)}`;
const fixtureVerifierOptions = Object.freeze({ preflightAuthority: createTestProfileMutationAuthority() });
function buildCandidateInputs() {
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
  const domain = {
    requirementsRevision: 57,
    chainId: snapshot.chainId,
    cycleId: CYCLE,
    hook: HOOK,
    vault: VAULT,
    usdg: USDG,
    operationsTrigger: OPERATIONS_TRIGGER,
    bindingManifestDigest: BINDING_MANIFEST_DIGEST,
  };
  return { closedProceedsBasis, snapshot, entries, domain };
}

async function buildProductionPendingRequest() {
  const { closedProceedsBasis, snapshot, entries, domain } = buildCandidateInputs();
  const artifact = buildProductionDistributionArtifact({ closedProceedsBasis, snapshot, entries, domain, payoutId: PAYOUT });
  const fields = { ...domain, payoutId: PAYOUT, manifestDigest: artifact.manifest.digest, rootHash: artifact.root.hash, rootSum: artifact.root.sum };
  const distributionDigest = payoutDistributionDigest(fields);
  const distributionSignature = `0x${'f1'.repeat(65)}`;
  return {
    profile: 'production', closedProceedsBasis, snapshot, entries, domain, payoutId: PAYOUT, fields, distributionDigest, distributionSignature,
  };
}

function fakeVerifierSignerClient(signature) {
  const calls = [];
  return { client: { role: VERIFIER_ROLE, async sign(request) { calls.push(request); return { signature }; } }, calls };
}

test('runOnePass (production profile) refuses the provisional authority before the verifier signer is called', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hookemon-verifier-production-'));
  const request = await buildProductionPendingRequest();
  const verifierSignature = `0x${'f2'.repeat(65)}`;
  const { client: signerClient, calls } = fakeVerifierSignerClient(verifierSignature);

  await runOnePass({ dir, signerClient }); // create directories
  writeFileSync(join(dir, 'pending', 'cycle-1.json'), JSON.stringify(request));

  const results = await runOnePass({ dir, signerClient });
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'FAILED');
  assert.match(results[0].error, /active frozen interface authority is invalid/);
  assert.deepEqual(calls, []);

  assert.equal(existsSync(join(dir, 'receipts', 'cycle-1.json')), false);
  const failure = JSON.parse(readFileSync(join(dir, 'failed', 'cycle-1.json'), 'utf8'));
  assert.match(failure.error, /active frozen interface authority is invalid/);

  rmSync(dir, { recursive: true, force: true });
});

test('runOnePass (production profile) writes a verified receipt under the exact fixture authority', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hookemon-verifier-production-fixture-'));
  try {
    const request = await buildProductionPendingRequest();
    const verifierSignature = `0x${'f2'.repeat(65)}`;
    const { client: signerClient, calls } = fakeVerifierSignerClient(verifierSignature);

    await runOnePass({ dir, signerClient, ...fixtureVerifierOptions });
    writeFileSync(join(dir, 'pending', 'cycle-1.json'), JSON.stringify(request));

    const results = await runOnePass({ dir, signerClient, ...fixtureVerifierOptions });
    assert.deepEqual(results, [{ requestId: 'cycle-1', status: 'VERIFIED' }]);
    assert.deepEqual(calls, [{ kind: 'hookemon.payout-distribution-signature.v1', digest: request.distributionDigest }]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'receipts', 'cycle-1.json'), 'utf8')), {
      profile: 'production',
      digest: request.distributionDigest,
      signature: verifierSignature,
    });
    assert.equal(existsSync(join(dir, 'failed', 'cycle-1.json')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runOnePass (production profile) writes failed/, never receipts/, when the claimed fields do not match the request\'s own inputs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hookemon-verifier-production-mismatch-'));
  const request = await buildProductionPendingRequest();
  request.fields = { ...request.fields, rootSum: String(BigInt(request.fields.rootSum) + 1n) };
  const { client: signerClient, calls } = fakeVerifierSignerClient(`0x${'f2'.repeat(65)}`);

  await runOnePass({ dir, signerClient });
  writeFileSync(join(dir, 'pending', 'cycle-1.json'), JSON.stringify(request));
  const results = await runOnePass({ dir, signerClient });

  assert.equal(results[0].status, 'FAILED');
  assert.match(results[0].error, /does not match the distribution-signer/);
  assert.deepEqual(calls, []);
  assert.equal(existsSync(join(dir, 'receipts', 'cycle-1.json')), false);
  assert.equal(existsSync(join(dir, 'failed', 'cycle-1.json')), true);

  rmSync(dir, { recursive: true, force: true });
});
