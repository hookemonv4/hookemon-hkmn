import assert from 'node:assert/strict';
import { createPrivateKey, sign } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CycleRunner } from '../../src/cycle/cycle-runner.mjs';
import { FixtureCycleStore } from '../../src/cycle/cycle-store.mjs';
import { digest } from '../../src/cycle/journal.mjs';
import { FIXTURE_BINDING_MANIFEST_DIGEST, createTestProfileMutationAuthority } from '../../src/cycle/preflight.mjs';
import { fixtureActionDigests } from '../../src/cycle/schemas.mjs';
import {
  DISTRIBUTION_SIGNER_ROLE,
  VERIFIER_ROLE,
  signDistributionApproval,
  signDistributionVerification,
} from '../../src/distribution/distribution-signer.mjs';
import { compileApprovedDistribution } from '../../src/distribution/manifest.mjs';
import { deriveClosedProceedsBasis } from '../../src/distribution/reconcile.mjs';
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

import {
  EntitlementAlreadyPaidError,
  SETTLEMENT_STATUS,
  createFileSettlementJournal,
  createInMemorySettlementJournal,
  settleDistribution,
  settlementJournalKey,
} from '../../src/distribution/settlement-worker.mjs';

// Same fixture Ed25519 keypairs manifest.mjs/distribution-signer.test.mjs already use for the
// "FIXTURE_OWNER_SIGNATURE" / "HOOKEMON_FIXTURE_DISTRIBUTION_VERIFIER" authorities — not
// production secrets, the local-only signing domain this whole package operates in.
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
const fixtureSigningOptions = Object.freeze({ preflightAuthority: createTestProfileMutationAuthority() });
const fixtureSettlementOptions = Object.freeze({ preflightAuthority: createTestProfileMutationAuthority() });

const RECIPIENT_A = `0x${'1'.repeat(40)}`;
const RECIPIENT_B = `0x${'2'.repeat(40)}`;
const RECIPIENT_C = `0x${'3'.repeat(40)}`;
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

function controlledFrozenControl(runnerCycleId, onchainCycleId) {
  const packSnapshot = createPackSnapshot({
    source: 'collector',
    observedAt: '2029-01-01T00:00:00.000Z',
    sourcePayloadDigest: digest({ domain: 'settlement-worker-pack-snapshot' }),
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
      { recipient: RECIPIENT_C, directHkmnBalance: '300' },
    ],
  };
  // Three leaves summing to the fixture cycle's finalCredit amount ('10'), spread across the
  // full index range (0, mid, max) so the settlement worker's sort-by-index and per-leaf proof
  // lookup are both exercised at the tree's edges, not just contiguous low indices.
  const entries = [
    { index: 0, recipient: RECIPIENT_A, directHkmnBalance: '100', amountAtomicUSDG: '3' },
    { index: 500, recipient: RECIPIENT_B, directHkmnBalance: '200', amountAtomicUSDG: '3' },
    { index: 1023, recipient: RECIPIENT_C, directHkmnBalance: '300', amountAtomicUSDG: '4' },
  ];
  return { cycleStore, runner, frozenControl, proceedsKey, closedProceedsBasis, snapshot, entries };
}

/**
 * A single-holder variant of fixture(): deriveHolderDistributionCandidate requires entries to
 * match the snapshot's holder set exactly (same length, same recipients), so a test that wants
 * only one leaf needs its own snapshot/entries pair, not a subset of the three-holder fixture's.
 */
function singleEntryFixture() {
  const base = fixture();
  return {
    ...base,
    snapshot: {
      ...base.snapshot,
      directBalances: [{ recipient: RECIPIENT_A, directHkmnBalance: '100' }],
    },
    entries: [{ index: 0, recipient: RECIPIENT_A, directHkmnBalance: '100', amountAtomicUSDG: '10' }],
  };
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

function threeCopies(artifact) {
  return ['primary', 'mirror', 'archive'].map((sourceId) => ({ sourceId, manifestBytes: artifact.manifest.bytes }));
}

/** Builds a fully paired { artifact, approval, verification } ready for settleDistribution. */
async function pairedDistribution(fixtureInput, entries = fixtureInput.entries) {
  const approval = await signDistributionApproval(
    candidateInput(fixtureInput, { entries }),
    distributionSignerClient,
    fixtureSigningOptions,
  );
  const artifact = compileApprovedDistribution({
    closedProceedsBasis: fixtureInput.closedProceedsBasis,
    snapshot: fixtureInput.snapshot,
    entries,
    approval,
  });
  const verification = await signDistributionVerification(
    artifact,
    threeCopies(artifact),
    verificationContext(fixtureInput),
    verifierSignerClient,
    fixtureSigningOptions,
  );
  return { approval, artifact, verification };
}

function recordingSubmitter(behavior = async () => ({ transactionId: 'tx' })) {
  const calls = [];
  const fn = async (request) => {
    calls.push(request);
    return behavior(request, calls.length);
  };
  fn.calls = calls;
  return fn;
}

function noSleep() {
  const calls = [];
  const fn = async (ms) => { calls.push(ms); };
  fn.calls = calls;
  return fn;
}

test('refuses a retained settlement submitter under the provisional authority before it is called', async () => {
  const input = singleEntryFixture();
  const { approval, artifact, verification } = await pairedDistribution(input, input.entries);
  const submitEntitlement = recordingSubmitter();

  await assert.rejects(
    () => settleDistribution({
      artifact,
      approval,
      verification,
      submitEntitlement,
      journalStore: createInMemorySettlementJournal(),
    }),
    /active frozen interface authority is invalid/,
  );
  assert.equal(submitEntitlement.calls.length, 0);
});

test('rejects a copied fixture settlement authority before it reaches the submitter', async () => {
  const input = singleEntryFixture();
  const { approval, artifact, verification } = await pairedDistribution(input, input.entries);
  const submitEntitlement = recordingSubmitter();

  await assert.rejects(
    () => settleDistribution({
      artifact,
      approval,
      verification,
      submitEntitlement,
      journalStore: createInMemorySettlementJournal(),
      preflightAuthority: { ...fixtureSettlementOptions.preflightAuthority },
    }),
    /fixture settlement test authority is invalid/,
  );
  assert.equal(submitEntitlement.calls.length, 0);
});

test('pays every committed leaf exactly once, sorted by index, using the artifact-pinned proofs', async () => {
  const input = fixture();
  const { approval, artifact, verification } = await pairedDistribution(input);
  const submitEntitlement = recordingSubmitter();
  const journalStore = createInMemorySettlementJournal();

  const result = await settleDistribution({
    artifact, approval, verification, submitEntitlement, journalStore, ...fixtureSettlementOptions,
  });

  assert.equal(result.payoutId, artifact.domain.payoutId);
  assert.equal(result.totalLeaves, 3);
  assert.equal(result.paid, 3);
  assert.equal(result.failed, 0);
  assert.deepEqual(submitEntitlement.calls.map((call) => call.index), [0, 500, 1023]);
  for (const call of submitEntitlement.calls) {
    assert.equal(call.payoutId, artifact.domain.payoutId);
    assert.equal(call.chunkIndex, 0);
    assert.equal(call.siblingHashes.length, 10);
    assert.equal(call.siblingSums.length, 10);
  }
  assert.deepEqual(
    result.results.map((record) => [record.index, record.status, record.skipped]),
    [[0, SETTLEMENT_STATUS.PAID, false], [500, SETTLEMENT_STATUS.PAID, false], [1023, SETTLEMENT_STATUS.PAID, false]],
  );

  const stored = await journalStore.read(settlementJournalKey(artifact.domain.payoutId, 0, 500));
  assert.equal(stored.status, SETTLEMENT_STATUS.PAID);
  assert.equal(stored.recipient, RECIPIENT_B);
  assert.equal(stored.amount, '3');
});

test('refuses to submit anything unless the distribution-signer approval and verifier receipt agree on the artifact', async () => {
  const input = fixture();
  const { approval, artifact, verification } = await pairedDistribution(input);
  const tamperedVerification = { ...verification, rootSum: String(BigInt(verification.rootSum) + 1n) };
  const submitEntitlement = recordingSubmitter();
  const journalStore = createInMemorySettlementJournal();

  await assert.rejects(
    () => settleDistribution({
      artifact, approval, verification: tamperedVerification, submitEntitlement, journalStore,
    }),
    /do not agree on the same rootHash\/rootSum/,
  );
  assert.equal(submitEntitlement.calls.length, 0);
});

test('aborts the whole run, before submitting anything, when a leaf proof fails local verification against the pinned root', async () => {
  const input = fixture();
  const { approval, artifact, verification } = await pairedDistribution(input);
  const tamperedArtifact = structuredClone(artifact);
  // Corrupt the proof for the lowest-index leaf only — proofs are stored independently of the
  // root/entries the pairing check inspects, so assertPairedDistributionApproval alone cannot
  // catch this; only this module's own local proof re-verification does.
  tamperedArtifact.proofs[0].siblingHashes[0] = `0x${'0'.repeat(64)}`;
  const submitEntitlement = recordingSubmitter();
  const journalStore = createInMemorySettlementJournal();

  await assert.rejects(
    () => settleDistribution({
      artifact: tamperedArtifact, approval, verification, submitEntitlement, journalStore,
    }),
    /local proof verification failed/,
  );
  assert.equal(submitEntitlement.calls.length, 0, 'must not submit any leaf once the artifact looks tampered');
});

test('retries a transiently failing submission with backoff and records the successful attempt count', async () => {
  const input = singleEntryFixture();
  const { approval, artifact, verification } = await pairedDistribution(input, input.entries);
  const submitEntitlement = recordingSubmitter(async (_request, callNumber) => {
    if (callNumber < 3) throw new Error('transient RPC timeout');
    return { transactionId: 'tx-after-retries' };
  });
  const journalStore = createInMemorySettlementJournal();
  const sleep = noSleep();

  const result = await settleDistribution({
    artifact, approval, verification, submitEntitlement, journalStore, sleep, ...fixtureSettlementOptions,
    baseDelayMs: 10, maxDelayMs: 1000,
  });

  assert.equal(result.paid, 1);
  assert.equal(result.failed, 0);
  assert.equal(submitEntitlement.calls.length, 3);
  assert.equal(result.results[0].attempts, 3);
  assert.equal(result.results[0].transactionId, 'tx-after-retries');
  assert.deepEqual(sleep.calls, [10, 20]);
});

test('treats a submitter EntitlementAlreadyPaidError as a terminal success, never retried', async () => {
  const input = singleEntryFixture();
  const { approval, artifact, verification } = await pairedDistribution(input, input.entries);
  const submitEntitlement = recordingSubmitter(async () => { throw new EntitlementAlreadyPaidError(); });
  const journalStore = createInMemorySettlementJournal();
  const sleep = noSleep();

  const result = await settleDistribution({
    artifact, approval, verification, submitEntitlement, journalStore, sleep, ...fixtureSettlementOptions,
  });

  assert.equal(result.paid, 1);
  assert.equal(submitEntitlement.calls.length, 1);
  assert.equal(sleep.calls.length, 0);
  assert.equal(result.results[0].status, SETTLEMENT_STATUS.PAID);
  assert.equal(result.results[0].alreadyPaid, true);
});

test('a leaf that exhausts every retry attempt is marked FAILED but the worker still pays the remaining leaves', async () => {
  const input = fixture();
  const { approval, artifact, verification } = await pairedDistribution(input);
  const submitEntitlement = recordingSubmitter(async (request) => {
    if (request.index === 500) throw new Error('recipient rejects transfer, permanently');
    return { transactionId: `tx-${request.index}` };
  });
  const journalStore = createInMemorySettlementJournal();
  const sleep = noSleep();

  const result = await settleDistribution({
    artifact, approval, verification, submitEntitlement, journalStore, sleep, ...fixtureSettlementOptions,
    maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1,
  });

  assert.equal(result.totalLeaves, 3);
  assert.equal(result.paid, 2);
  assert.equal(result.failed, 1);
  const failedRecord = result.results.find((record) => record.index === 500);
  assert.equal(failedRecord.status, SETTLEMENT_STATUS.FAILED);
  assert.equal(failedRecord.attempts, 3);
  assert.match(failedRecord.error, /recipient rejects transfer/);
  assert.deepEqual(
    result.results.filter((record) => record.index !== 500).map((record) => record.status),
    [SETTLEMENT_STATUS.PAID, SETTLEMENT_STATUS.PAID],
  );
  // Every attempt for the failing leaf actually reached the submitter (3), plus one call each
  // for the two leaves that succeeded on the first try.
  assert.equal(submitEntitlement.calls.length, 3 + 2);
});

test('crash-mid-distribution resume: killed after N of M leaves, restarted with the same durable journal, never resubmits a paid leaf', async () => {
  const input = fixture();
  const { approval, artifact, verification } = await pairedDistribution(input);
  const dir = mkdtempSync(join(tmpdir(), 'settlement-worker-journal-'));
  try {
    const journalStore = createFileSettlementJournal(dir);

    // "Run 1": the worker only gets through the first 2 of 3 leaves before the process is
    // killed — modeled directly, since this module has no separate crash-injection seam.
    const firstRunEntries = artifact.entries.filter((entry) => entry.index !== 1023);
    const firstArtifact = { ...artifact, entries: firstRunEntries };
    const firstSubmitter = recordingSubmitter();
    const firstResult = await settleDistribution({
      artifact: firstArtifact, approval, verification, submitEntitlement: firstSubmitter, journalStore, ...fixtureSettlementOptions,
    });
    assert.equal(firstResult.paid, 2);
    assert.deepEqual(firstSubmitter.calls.map((call) => call.index), [0, 500]);

    // "Restart": a fresh worker process, a fresh submitter, the full leaf set, the same
    // on-disk journal directory.
    const secondSubmitter = recordingSubmitter();
    const secondResult = await settleDistribution({
      artifact, approval, verification, submitEntitlement: secondSubmitter, journalStore, ...fixtureSettlementOptions,
    });

    assert.equal(secondResult.paid, 3);
    assert.equal(secondResult.failed, 0);
    // The two already-paid leaves must never be resubmitted after the restart.
    assert.deepEqual(secondSubmitter.calls.map((call) => call.index), [1023]);
    const skippedRecords = secondResult.results.filter((record) => record.skipped);
    assert.deepEqual(skippedRecords.map((record) => record.index), [0, 500]);

    for (const index of [0, 500, 1023]) {
      const stored = await journalStore.read(settlementJournalKey(artifact.domain.payoutId, 0, index));
      assert.equal(stored.status, SETTLEMENT_STATUS.PAID);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('crash-mid-distribution resume: a chain payment that succeeded but was never journaled is caught by the contract\'s own EntitlementAlreadyPaid revert, not double-paid', async () => {
  const input = fixture();
  const { approval, artifact, verification } = await pairedDistribution(input);
  const base = createInMemorySettlementJournal();
  let writeCount = 0;
  // The 3rd journal write ever attempted (the last of the three leaves, since entries are
  // processed in ascending index order) throws — modeling a crash that happens after the
  // on-chain call already succeeded but before the durable journal recorded it.
  const crashyJournalStore = {
    read: base.read,
    async write(key, value) {
      writeCount += 1;
      if (writeCount === 3) throw new Error('simulated process crash before journal persist');
      return base.write(key, value);
    },
  };
  const firstSubmitter = recordingSubmitter();

  await assert.rejects(
    () => settleDistribution({
      artifact, approval, verification, submitEntitlement: firstSubmitter, journalStore: crashyJournalStore, ...fixtureSettlementOptions,
    }),
    /simulated process crash/,
  );
  // The chain call for every leaf, including the un-journaled third one, actually went out.
  assert.deepEqual(firstSubmitter.calls.map((call) => call.index), [0, 500, 1023]);
  assert.equal(await base.read(settlementJournalKey(artifact.domain.payoutId, 0, 1023)), undefined);

  // Restart against the same (now-healthy) journal store. The worker attempts leaf 1023 again
  // — the journal did not know it was paid — and the injected chain client reports back exactly
  // what a real `payEntitlement` revert would: already paid.
  const secondSubmitter = recordingSubmitter(async (request) => {
    if (request.index === 1023) throw new EntitlementAlreadyPaidError();
    return { transactionId: `tx-${request.index}` };
  });
  const secondResult = await settleDistribution({
    artifact, approval, verification, submitEntitlement: secondSubmitter, journalStore: base, ...fixtureSettlementOptions,
  });

  assert.equal(secondResult.paid, 3);
  assert.equal(secondResult.failed, 0);
  // Leaves 0 and 500 were already journaled PAID and are skipped; only leaf 1023 is resubmitted,
  // and exactly once — no leaf's successful chain payment is ever attempted a second time after
  // the contract itself has already confirmed it.
  assert.deepEqual(secondSubmitter.calls.map((call) => call.index), [1023]);
  const finalRecord = secondResult.results.find((record) => record.index === 1023);
  assert.equal(finalRecord.alreadyPaid, true);
});

test('settlementJournalKey validates its inputs and is stable per (payoutId, chunkIndex, index)', () => {
  assert.equal(settlementJournalKey(PAYOUT, 0, 5), settlementJournalKey(PAYOUT, 0, 5));
  assert.notEqual(settlementJournalKey(PAYOUT, 0, 5), settlementJournalKey(PAYOUT, 1, 5));
  assert.throws(() => settlementJournalKey('', 0, 0), /nonempty payoutId/);
  assert.throws(() => settlementJournalKey(PAYOUT, -1, 0), /uint16 chunkIndex/);
  assert.throws(() => settlementJournalKey(PAYOUT, 0, 1024), /in-range leaf index/);
});

test('rejects a missing submitEntitlement client or a journal store missing read/write, before doing anything', async () => {
  const input = fixture();
  const { approval, artifact, verification } = await pairedDistribution(input);
  const journalStore = createInMemorySettlementJournal();
  await assert.rejects(
    () => settleDistribution({ artifact, approval, verification, journalStore }),
    /injected submitEntitlement/,
  );
  await assert.rejects(
    () => settleDistribution({
      artifact, approval, verification, submitEntitlement: recordingSubmitter(), journalStore: {},
    }),
    /injected durable journal store/,
  );
});

test('createFileSettlementJournal persists records across independent store instances (disk, not memory)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'settlement-worker-journal-plain-'));
  try {
    const key = settlementJournalKey(PAYOUT, 0, 7);
    const writer = createFileSettlementJournal(dir);
    await writer.write(key, { key, status: SETTLEMENT_STATUS.PAID, index: 7 });

    const reader = createFileSettlementJournal(dir);
    const record = await reader.read(key);
    assert.equal(record.status, SETTLEMENT_STATUS.PAID);
    assert.equal(record.index, 7);

    const missing = await reader.read(settlementJournalKey(PAYOUT, 0, 8));
    assert.equal(missing, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
