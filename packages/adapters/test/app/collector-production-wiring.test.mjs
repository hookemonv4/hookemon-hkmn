// Regression coverage for the bounded production Collector preparation wiring defect: purchase,
// open, epic-gate, and buyback prepareRequest previously ran in true production ("execution.profile
// !== 'rehearsal'") with no `adapters` and no `cycleRepository` at all -- only the collector-only
// rehearsal path supplied them. Every real handler's prepareRequest either crashed on undefined
// wiring (open/epic-gate/buyback) or, once a pack type was configured, threw "purchase prepareRequest
// requires collector-crypt machine data" (purchase). These tests prove the driver now supplies the
// same narrow, lease-fenced, read-only adapters/cycleRepository shape in true production mode that
// each real handler's own prepareRequest already declares it needs, without granting any mutation
// capability, signer, or standing authority at preparation time, and without weakening any existing
// refusal (Collector policy evidence-only gate, mutation authority, missing predecessor evidence).
import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { createStageDriver } from '../../src/app/stage-driver.mjs';

const CYCLE_ID = 'collector-production-wiring-cycle';
const fixtureStageDriverOptions = Object.freeze({ preflightAuthority: createTestProfileMutationAuthority() });

function throwingAdapters(overrides = {}) {
  return {
    collectorCrypt: null,
    relay: null,
    robinhood: { client: null },
    solana: { client: null },
    ...overrides,
  };
}

function baseConfig(overrides = {}) {
  return {
    contracts: { vault: null, hook: null },
    accounts: { evm: null, solana: null },
    // True production per the defect report: execution.profile is 'production', never 'rehearsal'
    // (isLiveCollectorOnlyRehearsal requires 'rehearsal'). providerMode is deliberately omitted so
    // these tests never reach the separate, unrelated standing-authority signing guard.
    execution: { profile: 'production' },
    ...overrides,
  };
}

// A minimal durable write-ahead repository: enough for the driver's own bookkeeping
// (prepareStageAttempt/markStageAttemptNotSent/readOperationalStageAttempt) plus the read-only
// methods a real prepareRequest may call (readStage, describeCycle, listHeldPositions).
function productionCycleRepository(stages = new Map()) {
  const attempts = new Map();
  return {
    attempts,
    async readStage(cycleId, stage) { return stages.get(stage) ?? { status: 'PENDING' }; },
    async describeCycle() { return { releaseAmount: '1' }; },
    async listHeldPositions() { return []; },
    async readOperationalStageAttempt(cycleId, stage) { return attempts.get(stage) ?? null; },
    async prepareStageAttempt(cycleId, stage, attempt) {
      attempts.set(stage, { attempt, responseEvidence: null, reconciliationEvidence: null });
    },
    async markStageAttemptNotSent(cycleId, stage) {
      const record = attempts.get(stage);
      record.attempt = { ...record.attempt, state: 'NOT_SENT' };
    },
    async markStageAttemptSentUnknown(cycleId, stage) {
      const record = attempts.get(stage);
      record.attempt = { ...record.attempt, state: 'SENT_UNKNOWN' };
    },
    async recordStageAttemptResponse(cycleId, stage, evidence) {
      const record = attempts.get(stage);
      record.attempt = { ...record.attempt, state: 'RESPONSE_RECORDED' };
      record.responseEvidence = evidence;
    },
    async reconcileStageAttempt(cycleId, stage, evidence) {
      const record = attempts.get(stage);
      record.attempt = { ...record.attempt, state: 'RECONCILED' };
      record.reconciliationEvidence = evidence;
    },
  };
}

test('purchase preparation in true production mode receives only a lease-fenced Collector machine-catalog reader, never a signer or the writable repository', async () => {
  const cycleRepository = productionCycleRepository();
  let captured = null;
  let assertLeaseCalls = 0;
  const realCatalog = { machines: [{ code: 'collector-25', contains: 1 }] };
  const driver = createStageDriver({
    liveMode: true,
    adapters: throwingAdapters({ collectorCrypt: { async getMachines() { return realCatalog; } } }),
    signerClient: { solana: { async sign() { throw new Error('signer must not be reachable during preparation'); } } },
    config: baseConfig({ accounts: { evm: null, solana: 'PLAYER11111111111111111111111111111111111' }, pack: { code: 'collector-25' } }),
    cycleRepository,
    stageHandlers: {
      purchase: {
        collectorCapable: true,
        async probe() { return null; },
        async prepareRequest(input) {
          captured = input;
          throw new Error('capture-only: stop before authorization and mutation');
        },
        async mutate() { throw new Error('mutate must not run in this test'); },
        async reconcileLive() { return null; },
      },
    },
  });

  await assert.rejects(
    () => driver.execute({
      cycleId: CYCLE_ID,
      stage: 'purchase',
      intent: { journalHead: 'head-capture' },
      assertLease: () => { assertLeaseCalls += 1; },
    }),
    /capture-only/,
  );

  assert.notEqual(captured, null);
  assert.deepEqual(Object.keys(captured).sort(), ['adapters', 'config', 'context', 'cycleRepository', 'liveMode']);
  assert.equal(Object.isFrozen(captured), true);
  assert.equal(Object.isFrozen(captured.adapters), true);
  assert.equal('signerClient' in captured, false);

  assert.deepEqual(Object.keys(captured.adapters).sort(), ['collectorCrypt']);
  assert.deepEqual(Object.keys(captured.adapters.collectorCrypt).sort(), ['getMachines']);
  assert.equal('relay' in captured.adapters, false);
  assert.equal('robinhood' in captured.adapters, false);
  assert.equal('solana' in captured.adapters, false);

  const before = assertLeaseCalls;
  assert.deepEqual(await captured.adapters.collectorCrypt.getMachines(), realCatalog);
  assert.equal(assertLeaseCalls, before + 1, 'the machine-catalog read must revalidate the lease at call time');

  assert.equal(typeof captured.cycleRepository.readStage, 'function');
  assert.equal('prepareStageAttempt' in captured.cycleRepository, false);
  assert.equal('recordPackBatchRequest' in captured.cycleRepository, false);
  assert.equal('markStageAttemptNotSent' in captured.cycleRepository, false);
});

test('purchase reaches the real Collector machine catalog in true production mode instead of throwing on missing wiring, then still refuses at its own Solana-configuration boundary', async () => {
  const cycleRepository = productionCycleRepository();
  const driver = createStageDriver({
    liveMode: true,
    adapters: throwingAdapters({
      collectorCrypt: { async getMachines() { return { machines: [{ code: 'collector-25', contains: 1 }] }; } },
    }),
    signerClient: null,
    config: baseConfig({ accounts: { evm: null, solana: 'PLAYER11111111111111111111111111111111111' }, pack: { code: 'collector-25' } }),
    cycleRepository,
    ...fixtureStageDriverOptions,
  });

  await assert.rejects(
    () => driver.execute({
      cycleId: CYCLE_ID,
      stage: 'purchase',
      intent: { journalHead: 'head-purchase' },
      assertMutationAllowed: async () => {},
    }),
    error => {
      // The original defect: preparation crashed with this exact message because no
      // collector-crypt adapter reached prepareRequest at all in true production mode.
      assert.notEqual(error.message, 'purchase prepareRequest requires collector-crypt machine data');
      assert.match(error.message, /Collector purchase requires a configured Solana RPC client/);
      return true;
    },
  );

  const attempt = await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'purchase');
  assert.equal(attempt.attempt.state, 'NOT_SENT', 'the refused attempt is rolled back, never left PREPARED as if it were runtime-ready');
  assert.equal(attempt.attempt.requestDigest !== undefined, true, 'preparation itself durably succeeded before the downstream refusal');
});

for (const [stage, predecessor] of [['open', 'purchase'], ['epic-gate', 'open'], ['buyback', 'epic-gate']]) {
  test(`${stage} preparation reaches its real predecessor-evidence check in true production mode instead of crashing on an unwired repository`, async () => {
    const cycleRepository = productionCycleRepository();
    const driver = createStageDriver({
      liveMode: true,
      adapters: throwingAdapters(),
      signerClient: null,
      config: baseConfig(),
      cycleRepository,
    });

    await assert.rejects(
      () => driver.execute({ cycleId: CYCLE_ID, stage, intent: { journalHead: `head-${stage}` } }),
      error => {
        assert.doesNotMatch(error.message, /Cannot read propert/);
        assert.match(error.message, new RegExp(`requires a completed ${predecessor} stage with a pack ledger`));
        return true;
      },
    );
    assert.equal(await cycleRepository.readOperationalStageAttempt(CYCLE_ID, stage), null, 'a refusal at preparation never durably records a PREPARED attempt');
  });
}

test('open preparation reads the real durable purchase ledger in true production mode once the predecessor stage is genuinely complete', async () => {
  const stages = new Map([['purchase', {
    status: 'COMPLETE',
    evidence: { quantity: 1, packs: [{ packIndex: 0, memo: 'collector-memo-1', status: 'purchased', expectedCardCount: 1 }] },
  }]]);
  const cycleRepository = productionCycleRepository(stages);
  const driver = createStageDriver({
    liveMode: true,
    adapters: throwingAdapters(),
    signerClient: null,
    config: baseConfig(),
    cycleRepository,
    ...fixtureStageDriverOptions,
  });

  await assert.rejects(
    () => driver.execute({
      cycleId: CYCLE_ID,
      stage: 'open',
      intent: { journalHead: 'head-open' },
      assertMutationAllowed: async () => {},
    }),
    /open mutate requires a configured collector-crypt client/,
  );

  const attempt = await cycleRepository.readOperationalStageAttempt(CYCLE_ID, 'open');
  assert.equal(attempt.attempt.state, 'NOT_SENT');
  assert.equal(attempt.attempt.requestDigest !== undefined, true, 'the real purchase ledger was read and a genuine open request was prepared and digested');
});
