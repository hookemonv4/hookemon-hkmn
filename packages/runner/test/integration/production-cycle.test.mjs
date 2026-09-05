// WP-31: proves the production evidence profile drives a full, real CycleRunner cycle — backed by
// WP-27's disk DurableCycleStore, not the in-memory FixtureCycleStore — through every stage to a closed,
// payout-ready cycle using only chain-observer confirmation, an injected signer registry, and a
// StandingAuthorityProvider. No fixture key (fixture-owner, fixture-provider, fixture-rpc,
// fixture-transaction-signer, fixture-accounting-verifier) is ever read or referenced by this file or by
// production-cycle.mjs; the observers are plain in-memory lookup tables the test itself seeds (no
// network). The distribution-signer/verifier keypairs reused here are the same ones
// automated-cycle.test.mjs/distribution-signer.test.mjs already use for that module's own fixed,
// separately-keyed protocol identity (design section 2.3 identity 4, coordinator decision D7) — a
// different custody boundary than the fixture/production evidence-profile split this package introduces,
// and out of this package's writeSet (packages/runner/src/distribution/*).
import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CycleRunner } from '../../src/cycle/cycle-runner.mjs';
import { DurableCycleStore } from '../../src/cycle/durable-store.mjs';
import { FixtureCycleStore } from '../../src/cycle/cycle-store.mjs';
import { digest } from '../../src/cycle/journal.mjs';
import { createTestProfileMutationAuthority } from '../../src/cycle/preflight.mjs';
import {
  DISTRIBUTION_SIGNER_ROLE,
  VERIFIER_ROLE,
  assertPairedDistributionApproval,
  signDistributionApproval,
  signDistributionVerification,
} from '../../src/distribution/distribution-signer.mjs';
import { compileApprovedDistribution } from '../../src/distribution/manifest.mjs';
import { deriveClosedProceedsBasis } from '../../src/distribution/reconcile.mjs';
import {
  buildAndSignStepAuthorization,
  buildProductionFrozenControl,
  createProductionTestFixture,
  executeCompleteProductionCycle,
  productionCycleAction,
  productionCyclePreflight,
} from '../cycle/production-cycle.mjs';
import { fixtureCyclePreflight } from '../cycle/fixture-cycle.mjs';

// Same test-only keypairs automated-cycle.test.mjs already uses for the distribution-signer/verifier's
// own fixed protocol identity (see the module comment above) — never the fixture/production evidence
// profile keys this test suite is otherwise proving are unused.
const DISTRIBUTION_SIGNER_PRIVATE_KEY = createPrivateKey({
  key: Buffer.from('302e020100300506032b6570042204208566b1706357d4653313d88defec8219a3f4ad9d2abca8484765a4af92b12cb9', 'hex'),
  format: 'der',
  type: 'pkcs8',
});
const VERIFIER_PRIVATE_KEY = createPrivateKey({
  key: Buffer.from('302e020100300506032b65700422042066d19592d6fe485bacd309b93ae3524217a22bdcba8ee6333d1c0f51fb150e16', 'hex'),
  format: 'der',
  type: 'pkcs8',
});
const HOOK = `0x${'a'.repeat(40)}`;
const RECIPIENT_A = `0x${'1'.repeat(40)}`;
const RECIPIENT_B = `0x${'2'.repeat(40)}`;

function ed25519SignerClient(role, privateKey) {
  return { role, sign: digestBuffer => sign(null, digestBuffer, privateKey).toString('base64url') };
}
const distributionSignerClient = ed25519SignerClient(DISTRIBUTION_SIGNER_ROLE, DISTRIBUTION_SIGNER_PRIVATE_KEY);
const verifierSignerClient = ed25519SignerClient(VERIFIER_ROLE, VERIFIER_PRIVATE_KEY);
const fixtureSigningOptions = Object.freeze({ preflightAuthority: createTestProfileMutationAuthority() });

async function temporaryDurableStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-production-cycle-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return DurableCycleStore.open(directory);
}

function payoutId(seed) { return `0x${seed.repeat(64)}`; }

async function driveToPayoutReady(cycleId, cycleStore) {
  const fixture = createProductionTestFixture();
  const runner = new CycleRunner(cycleId, [], { cycleStore, evidenceProfile: fixture.evidenceProfile });
  const { returnReceiptDigest } = executeCompleteProductionCycle(fixture, runner, cycleId);
  runner.deriveClosedCycle();
  const proceedsKey = runner.consumeReturnedProceedsOnce({ receiptDigest: returnReceiptDigest });
  const closedProceedsBasis = deriveClosedProceedsBasis(runner.readClosedProceedsBasisHandoff({ proceedsKey }));
  const snapshot = {
    schema: 'hookemon.input-bound-hkmn-snapshot-candidate.v1', authority: 'INPUT_BOUND_CANDIDATE_NOT_AUTHENTICATED',
    asset: 'HKMN', chainId: '4663', tokenAddress: `0x${'b'.repeat(40)}`, blockNumber: '12345678', blockHash: `0x${'e'.repeat(64)}`, finalized: true,
    directBalances: [{ recipient: RECIPIENT_A, directHkmnBalance: '100' }, { recipient: RECIPIENT_B, directHkmnBalance: '200' }],
  };
  const entries = [
    { index: 0, recipient: RECIPIENT_A, directHkmnBalance: '100', amountAtomicUSDG: '4' },
    { index: 1023, recipient: RECIPIENT_B, directHkmnBalance: '200', amountAtomicUSDG: '6' },
  ];
  const candidateInput = { closedProceedsBasis, snapshot, entries };
  const approval = await signDistributionApproval({ ...candidateInput, hook: HOOK, cycleId, payoutId: payoutId('d') }, distributionSignerClient, fixtureSigningOptions);
  const artifact = compileApprovedDistribution({ ...candidateInput, approval });
  const copies = ['primary', 'mirror', 'archive'].map(sourceId => ({ sourceId, manifestBytes: artifact.manifest.bytes }));
  const receipt = await signDistributionVerification(artifact, copies, {
    runnerCycleId: closedProceedsBasis.cycleId,
    proceedsKey,
    closedLedgerDigest: closedProceedsBasis.closedLedgerDigest,
    closedProceedsBasisDigest: closedProceedsBasis.basisDigest,
    verificationJournalHead: runner.state.journalHead,
  }, verifierSignerClient, fixtureSigningOptions);
  assertPairedDistributionApproval(approval, artifact, receipt);
  runner.recordDistributionVerification(receipt);
  const funding = runner.preparePayoutFunding({
    proceedsKey, verificationReceiptDigest: receipt.receiptDigest, expiresAt: '1893456000', nonce: '9',
  });
  return { runner, fixture, funding };
}

test('drives a full eight-stage cycle through CycleRunner with DurableCycleStore and production-profile evidence to a payout-ready state, with no fixture keys involved', async t => {
  const cycleId = `0x${'c'.repeat(64)}`;
  const cycleStore = await temporaryDurableStore(t);
  const { runner, funding } = await driveToPayoutReady(cycleId, cycleStore);

  assert.equal(runner.state.stage, 'closed');
  assert.equal(runner.inspect().payoutFundingPrepared, true);
  assert.equal(funding.authority, 'LOCAL_PREPARATION_ONLY_NOT_LIVE_FUNDING_AUTHORITY');
  assert.ok(funding.payoutId);
  assert.ok(funding.rootSum);
});

test('production-profile CycleRunner accepts a DurableCycleStore and recovers correctly after a fresh open of the same directory', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-production-recover-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cycleId = `0x${'f'.repeat(64)}`;
  const fixture = createProductionTestFixture();
  const store = await DurableCycleStore.open(directory);
  const runner = new CycleRunner(cycleId, [], { cycleStore: store, evidenceProfile: fixture.evidenceProfile });
  executeCompleteProductionCycle(fixture, runner, cycleId);
  runner.deriveClosedCycle();
  assert.equal(runner.state.stage, 'closed');

  const reopened = await DurableCycleStore.open(directory);
  const stored = reopened.readCycle(cycleId);
  assert.equal(stored.entries.length, runner.entries.length);
  const recovered = CycleRunner.recover(cycleId, stored.entries, { cycleStore: reopened, evidenceProfile: fixture.evidenceProfile });
  assert.equal(recovered.state.stage, 'closed');
  assert.equal(recovered.state.journalHead, runner.state.journalHead);
});

test('production-profile CycleRunner refuses an expired standing authority before recording an owner authorization', async t => {
  const cycleId = `0x${'8'.repeat(64)}`;
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-production-expired-recover-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // The authority is intentionally outside the current wall-clock validity window.
  const fixture = createProductionTestFixture({
    standingAuthorityIssuedAt: '2020-01-01T00:00:00.000Z',
    standingAuthorityExpiresAt: '2020-06-01T00:00:00.000Z',
  });
  const store = await DurableCycleStore.open(directory);
  const runner = new CycleRunner(cycleId, [], { cycleStore: store, evidenceProfile: fixture.evidenceProfile });
  const preflight = productionCyclePreflight(cycleId, fixture);
  runner.recordReleasedCyclePreflight(preflight);
  const outbound = productionCycleAction('outbound', cycleId, preflight.preflightDigest);
  const intent = runner.prepareExternalIntent(outbound);
  const mutation = buildAndSignStepAuthorization(fixture, {
    cycleId, actionKind: 'outbound', authorizationKind: 'mutation', subjectDigest: intent.actionDigest,
    destination: outbound.destination, pack: outbound.binding.pack, spendAmount: outbound.principalAmount,
    issuedAt: '2020-03-01T00:00:00.000Z',
  });
  assert.throws(() => runner.recordOwnerAuthorization(mutation), /standing authority is expired/);
  assert.equal(runner.entries.some(entry => entry.kind === 'owner-approval-recorded'), false);
});

test('rejects a production provider receipt the injected chain observer never confirmed', () => {
  const cycleId = `0x${'1'.repeat(64)}`;
  const fixture = createProductionTestFixture();
  const runner = new CycleRunner(cycleId, [], { cycleStore: new FixtureCycleStore(), evidenceProfile: fixture.evidenceProfile });
  const preflight = productionCyclePreflight(cycleId, fixture);
  runner.recordReleasedCyclePreflight(preflight);
  const outbound = productionCycleAction('outbound', cycleId, preflight.preflightDigest);
  const receipt = {
    schema: 'hookemon.production-provider-receipt.v1', cycleId, actionKind: 'outbound', provider: 'relay',
    providerReceiptId: `${cycleId}-outbound-receipt`, chain: outbound.chain, cluster: outbound.cluster,
    actionDigest: 'sha256:' + '9'.repeat(64), messageDigest: 'sha256:' + '9'.repeat(64),
    transactionSignature: 'never-observed-signature', blockHeight: '15', blockHash: 'ccdd', finalized: true,
    relation: {
      sourceAccount: outbound.sourceAccount, destinationAccount: outbound.destination, inputAsset: outbound.inputAsset, outputAsset: outbound.outputAsset,
      preSourceBalance: '10', postSourceBalance: '0', preDestinationBalance: '0', postDestinationBalance: '10', amountIn: '10', amountOut: '10',
    },
    apiResponseDigest: 'sha256:' + '8'.repeat(64),
  };
  // Never seeded on fixture.evmObserver — the injected observer has no confirmation for this signature.
  assert.throws(() => runner.verifyProductionProviderReceipt(receipt), /never confirmed by the injected chain observer/i);
});

test('rejects a production provider receipt whose claimed amounts do not match the injected observer confirmation', () => {
  const cycleId = `0x${'2'.repeat(64)}`;
  const fixture = createProductionTestFixture();
  const outbound = productionCycleAction('outbound', cycleId, 'sha256:' + '7'.repeat(64));
  const relation = {
    sourceAccount: outbound.sourceAccount, destinationAccount: outbound.destination, inputAsset: outbound.inputAsset, outputAsset: outbound.outputAsset,
    preSourceBalance: '10', postSourceBalance: '0', preDestinationBalance: '0', postDestinationBalance: '10', amountIn: '10', amountOut: '10',
  };
  const receipt = {
    schema: 'hookemon.production-provider-receipt.v1', cycleId, actionKind: 'outbound', provider: 'relay',
    providerReceiptId: `${cycleId}-outbound-receipt`, chain: outbound.chain, cluster: outbound.cluster,
    actionDigest: 'sha256:' + '9'.repeat(64), messageDigest: 'sha256:' + '9'.repeat(64),
    transactionSignature: 'mismatched-amount-signature', blockHeight: '15', blockHash: 'ccdd', finalized: true,
    relation, apiResponseDigest: 'sha256:' + '8'.repeat(64),
  };
  // The observer confirms a DIFFERENT amountOut than the receipt claims — a tampered/incorrect receipt.
  fixture.evmObserver.seedTransaction('mismatched-amount-signature', {
    schema: 'hookemon.production-observer-confirmation.v1', chain: outbound.chain, cluster: outbound.cluster,
    transactionSignature: 'mismatched-amount-signature', finalized: true, blockHeight: '15', blockHash: 'ccdd',
    programId: 'RelayBridgeContractV1', payer: outbound.feePayer,
    relation: { ...relation, amountOut: '999', postDestinationBalance: '999' },
  });
  const runner = new CycleRunner(cycleId, [], { cycleStore: new FixtureCycleStore(), evidenceProfile: fixture.evidenceProfile });
  assert.throws(() => runner.verifyProductionProviderReceipt(receipt), /does not match the injected chain observer confirmation/);
});

test('rejects reusing a standing-authority step-authorization nonce', async t => {
  const cycleId = `0x${'3'.repeat(64)}`;
  const cycleStore = await temporaryDurableStore(t);
  const fixture = createProductionTestFixture();
  const runner = new CycleRunner(cycleId, [], { cycleStore, evidenceProfile: fixture.evidenceProfile });
  const preflight = productionCyclePreflight(cycleId, fixture);
  runner.recordReleasedCyclePreflight(preflight);
  const outbound = productionCycleAction('outbound', cycleId, preflight.preflightDigest);
  const intent = runner.prepareExternalIntent(outbound);

  // Build one standing-authority step intent and consume it as the outbound 'mutation' authorization.
  const stepIntent = buildAndSignStepAuthorization(fixture, {
    cycleId, actionKind: 'outbound', authorizationKind: 'mutation', subjectDigest: intent.actionDigest,
    destination: outbound.destination, pack: outbound.binding.pack, spendAmount: outbound.principalAmount, nonce: 'reused-nonce-test',
  });
  runner.recordOwnerAuthorization(stepIntent);
  runner.consumeAuthorizationOnce(stepIntent);

  // Reusing the SAME nonce for a completely independent authorization (the Collector generate mutation)
  // must be rejected: a fresh nonce is required per authorization across the whole cycle, exactly as the
  // fixture path already enforces one global owner nonce namespace (see security.test.mjs's "uses one
  // global owner nonce namespace across action and Collector authorizations").
  const request = { schema: 'hookemon.production-collector-generate-request.v1', cycleId, pack: outbound.binding.pack, quantity: 1, turbo: false, wallet: outbound.binding.executionWallet, memo: `${cycleId}:collector-generate` };
  runner.prepareCollectorGenerateIntent(request);
  const requestDigest = digest({ domain: 'hookemon.production-collector-generate-request.v1', request });
  const collectorAuthorization = buildAndSignStepAuthorization(fixture, {
    cycleId, actionKind: 'generate', authorizationKind: 'mutation', subjectDigest: requestDigest,
    destination: outbound.binding.executionWallet, pack: outbound.binding.pack, spendAmount: '1', nonce: 'reused-nonce-test',
  });
  assert.throws(
    () => runner.consumeCollectorMutationAuthorization({ request, binding: outbound.binding, authorization: collectorAuthorization }),
    /nonce/i,
  );
});

test('rejects fixture-profile evidence when the runner was constructed with the production evidence profile', async t => {
  const cycleId = `0x${'4'.repeat(64)}`;
  const cycleStore = await temporaryDurableStore(t);
  const fixture = createProductionTestFixture();
  const runner = new CycleRunner(cycleId, [], { cycleStore, evidenceProfile: fixture.evidenceProfile });
  const preflight = fixtureCyclePreflight(cycleId);
  // A fixture-schema preflight, signed with the fixture owner key, must be rejected outright by a
  // production-profile runner: it does not even satisfy the production schema's field shape.
  assert.throws(() => runner.recordReleasedCyclePreflight(preflight), /production cycle spend preflight|must use the exact schema/i);
});

test('rejects a production-profile CycleRunner constructed with a plain object cycle store (interface check, not instanceof)', () => {
  const fixture = createProductionTestFixture();
  assert.throws(
    () => new CycleRunner(`0x${'5'.repeat(64)}`, [], { cycleStore: {}, evidenceProfile: fixture.evidenceProfile }),
    /cycle store.*required/,
  );
});

test('a production-profile CycleRunner accepts the in-memory FixtureCycleStore too (same interface, faster tests)', () => {
  const fixture = createProductionTestFixture();
  const runner = new CycleRunner(`0x${'6'.repeat(64)}`, [], { cycleStore: new FixtureCycleStore(), evidenceProfile: fixture.evidenceProfile });
  assert.equal(runner.state.stage, 'prepared');
});

// WP-34: a production-profile CycleRunner bound to a *production* frozen cycle control — the
// operator/cycle-plan.mjs and operator/cycle-escrow-observation.mjs counterpart to every fixture-bound
// frozenControl test in test/cycle/runner.test.mjs — closing the last INTEGRATION_PENDING gap
// docs/modules/cycle-runner.md previously cited for this module: `bindingManifestDigest` comes from the
// retained test binding record, `outboundActionDigest`/`returnActionDigest` come from the real
// production action digests (`productionActionDigests`, schemas.mjs) of the exact actions the cycle later
// executes, and the escrow observation is anchored in the injected fake (in-memory, no network) EVM
// observer rather than a fixture key. This verification profile has no live signing or broadcast effect.
test('a production-profile CycleRunner bound to a production frozen cycle control completes a full cycle, and recovers identically after a crash', async t => {
  const cycleId = `0x${'9'.repeat(64)}`;
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-production-frozen-control-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = createProductionTestFixture();
  const { control, plan } = buildProductionFrozenControl(cycleId, fixture);
  assert.equal(control.escrowObservation.schema, 'hookemon.production-cycle-escrow-observation.v1');
  assert.equal(plan.bindingManifestDigest, control.plan.bindingManifestDigest);

  const store = await DurableCycleStore.open(directory);
  const runner = new CycleRunner(cycleId, [], { cycleStore: store, evidenceProfile: fixture.evidenceProfile, frozenControl: control });
  assert.equal(runner.bindFrozenControl(), control.controlDigest);
  const { returnReceiptDigest } = executeCompleteProductionCycle(fixture, runner, cycleId);
  runner.deriveClosedCycle();
  assert.equal(runner.state.stage, 'closed');
  assert.ok(returnReceiptDigest);

  // Recovery after a crash: reopen the durable store fresh, reconstruct the exact same frozen control
  // (exactly as control.mjs's own start/recoverActiveRunner already do, rebuilding it from durable state
  // via createFrozenCycleControl on every recovery — see cycle-plan.mjs's module comments) and replay the
  // exact same journal, deps-free (assertFrozenCycleControl never contacts the chain observer again).
  const reopened = await DurableCycleStore.open(directory);
  const stored = reopened.readCycle(cycleId);
  const recovered = CycleRunner.recover(cycleId, stored.entries, { cycleStore: reopened, evidenceProfile: fixture.evidenceProfile, frozenControl: control });
  assert.equal(recovered.state.stage, 'closed');
  assert.equal(recovered.state.journalHead, runner.state.journalHead);
});

test('a production-profile CycleRunner rejects binding a frozen control whose escrow observation carries a mismatched block hash', () => {
  const fixture = createProductionTestFixture();
  assert.throws(
    () => buildProductionFrozenControl(`0x${'e'.repeat(64)}`, fixture, { escrowObservationOverrides: { blockHash: `sha256:${'f'.repeat(64)}` } }),
    /does not match the injected chain observer confirmation/i,
  );
});

test('a production-profile CycleRunner rejects binding a frozen control whose escrow observation claims the wrong escrow address', () => {
  const fixture = createProductionTestFixture();
  assert.throws(
    () => buildProductionFrozenControl(`0x${'d'.repeat(64)}`, fixture, { escrowObservationOverrides: { returnAccount: '0x0000000000000000000000000000000000009999' } }),
    /cycle return escrow differs from authenticated computeCycleEscrow output/i,
  );
});

test('a production-profile CycleRunner rejects binding a frozen control whose escrow observation reports an amount below the frozen minimum Robinhood receive', () => {
  const fixture = createProductionTestFixture();
  assert.throws(
    () => buildProductionFrozenControl(`0x${'0'.repeat(63)}1`, fixture, { usdgBalance: '5' }),
    /below the frozen minimum/i,
  );
});
