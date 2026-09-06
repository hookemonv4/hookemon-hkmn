import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertOperatorConfiguration,
  createDefaultOperatorConfiguration,
} from '../../src/config/state-schema.mjs';
import { createPolicyEngine } from '../../src/automation/policy-engine.mjs';
import { CUSTODY_LEDGER_BUCKETS } from '../../src/cycle/money-schemas.mjs';

const controlUrl = new URL('../../src/operator/control.mjs', import.meta.url);
const stateFileUrl = new URL('../../src/operator/state-file.mjs', import.meta.url);
const nowMs = 2_000_000_000_000;
const hash = character => `sha256:${character.repeat(64)}`;

async function controlModule() {
  return import(controlUrl.href);
}

async function stateFileModule() {
  return import(stateFileUrl.href);
}

async function temporaryState(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-operator-control-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'operator-state.json');
}

function configuration(overrides = {}) {
  return assertOperatorConfiguration({
    ...createDefaultOperatorConfiguration(),
    liveMode: true,
    allowedPackIds: ['base-pack'],
    requestedOrders: 1,
    maxUnitPriceMicroUsdg: '100',
    maxCycleBudgetMicroUsdg: '100',
    max24HourBudgetMicroUsdg: '100',
    perCycleCapMicroUsdg: '100',
    lossCapMicroUsdg: '100',
    maxOutstandingCustodyMicroUsdg: '100',
    ...overrides,
  });
}

async function seedConfiguration(statePath, config = configuration()) {
  const { createEmptyOperatorState, mutateOperatorState } = await stateFileModule();
  return mutateOperatorState(statePath, null, () => ({
    ...createEmptyOperatorState(),
    configuration: config,
  }));
}

function custodyLedger(cycleId) {
  return {
    schema: 'hookemon.custody-ledger.v1',
    cycleId,
    chainId: 'eip155:4663',
    assetId: 'eip155:4663/erc20:asset',
    decimals: 6,
    claimed: '40',
    bridgeOut: '0',
    bridgeIn: '0',
    packCost: '0',
    buybackProceeds: '0',
    returnInput: '0',
    returnReceived: '0',
    refunds: '0',
    residual: '0',
    heldAssets: '0',
    heldPositions: '0',
    payoutLiability: '0',
    dust: '0',
    unattributed: '0',
  };
}

function safetyTelemetry(overrides = {}) {
  return {
    realizedLossMicroUsdg: '0',
    atRiskMicroUsdg: '0',
    outstandingMicroUsdg: '0',
    heldAssets: false,
    heldPositions: { count: 0, valueMicroUsdg: '0', positions: [] },
    unattributed: false,
    unvaluedExposure: false,
    ...overrides,
  };
}

function createRepository({ activeCycleId = 'cycle-one', knownCycleIds = [activeCycleId], descriptions = new Map() } = {}) {
  const calls = { readActiveCycle: 0, peekActiveCycle: 0, listKnownCycleIds: 0, describeCycle: [] };
  return {
    calls,
    async readActiveCycle() {
      calls.readActiveCycle += 1;
      return activeCycleId === null ? null : { cycleId: activeCycleId, releaseAmount: '40' };
    },
    async peekActiveCycle() {
      calls.peekActiveCycle += 1;
      return activeCycleId === null ? null : { cycleId: activeCycleId, releaseAmount: '40' };
    },
    async listKnownCycleIds() {
      calls.listKnownCycleIds += 1;
      return knownCycleIds;
    },
    async describeCycle(cycleId) {
      calls.describeCycle.push(cycleId);
      return {
        cycleId,
        releaseAmount: '40',
        terminalState: null,
        version: 0,
        heldEvidenceDigest: null,
        ownerDecision: null,
        heldPositions: new Map(),
        stages: new Map(),
        operationalAttempts: new Map(),
        custodyLedgers: new Map(),
        ...(descriptions.get(cycleId) ?? {}),
      };
    },
  };
}

function policyEngineForState(statePath) {
  return createPolicyEngine({
    now: () => nowMs,
    readConfiguration: async () => (await (await stateFileModule()).readOperatorState(statePath)).configuration,
    readCustody: async () => ({
      realizedLossMicroUsdg: '0',
      atRiskMicroUsdg: '0',
      outstandingMicroUsdg: '0',
      heldAssets: false,
      heldPositions: { count: 0, valueMicroUsdg: '0', positions: [] },
      unattributed: false,
      unvaluedExposure: false,
      cycles: [],
    }),
    mutateConfiguration: async mutation => {
      const { mutateOperatorState, readOperatorState } = await stateFileModule();
      const state = await readOperatorState(statePath);
      let result;
      await mutateOperatorState(statePath, state.revision, async current => {
        const outcome = await mutation(current.configuration);
        result = outcome.result;
        return { ...current, configuration: outcome.configuration };
      });
      return result;
    },
  });
}

test('control source exports the repository-backed authority and no local cycle engine', async () => {
  const source = await readFile(controlUrl, 'utf8');
  assert.match(source, /export function createOperatorControl/);
  assert.doesNotMatch(source, /FixtureCycleStore|CycleRunner|class OperatorControl/);
});

test('status rejects an invalid active cycle identity from the repository', async t => {
  const statePath = await temporaryState(t);
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: 'cycle id with spaces', knownCycleIds: [] }),
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
  });

  await assert.rejects(control.status(), /peekActiveCycle.*invalid/i);
});

test('status uses the repository pure peek instead of the archival repair accessor', async t => {
  const statePath = await temporaryState(t);
  const repository = createRepository({ activeCycleId: null, knownCycleIds: [] });
  repository.readActiveCycle = async () => {
    throw new Error('archival repair must not run during status');
  };
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: repository,
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
  });

  await control.status();

  assert.equal(repository.calls.peekActiveCycle, 1);
  assert.equal(repository.calls.readActiveCycle, 0);
});

test('status rejects a malformed on-chain remaining capacity amount', async t => {
  const statePath = await temporaryState(t);
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    readCustody: async () => ({ onChainRemainingCapacity: { amountAtomic: '40' } }),
  });

  await assert.rejects(control.status(), /on-chain remaining capacity.*(?:schema|plain object|chainId)/i);
});

test('status projects cycle facts and typed custody buckets from the repository', async t => {
  const statePath = await temporaryState(t);
  const digest = hash('a');
  await seedConfiguration(statePath, configuration({
    cycleLedger: [{
      cycleId: 'cycle-one',
      cycleDigest: digest,
      mode: 'production',
      openedAtMs: nowMs - 1,
      releaseAmountMicroUsdg: '40',
    }],
    spendLedger: [{
      cycleId: 'cycle-one',
      cycleDigest: digest,
      amountMicroUsdg: '40',
      reservedAtMs: nowMs - 1,
    }],
  }));
  const ledger = custodyLedger('cycle-one');
  const repository = createRepository({
    descriptions: new Map([['cycle-one', {
      cycleId: 'cycle-one',
      releaseAmount: '40',
      terminalState: null,
      stages: new Map([['claim-process', { status: 'COMPLETE' }]]),
      operationalAttempts: new Map([['claim-process', {
        attempt: {
          schema: 'hookemon.provider-mutation-attempt.v1',
          cycleId: 'cycle-one',
          stage: 'claim-process',
          state: 'PREPARED',
          requestDigest: hash('b'),
          responseDigest: null,
          reconciliationDigest: null,
        },
      }]]),
      custodyLedgers: new Map([['asset', ledger]]),
    }]]),
  });
  let custodyReads = 0;
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: repository,
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    now: () => nowMs,
    readCustody: async () => {
      custodyReads += 1;
      return { ...safetyTelemetry(), onChainRemainingCapacity: null };
    },
  });

  const status = await control.status();

  assert.equal(status.revision, 0);
  assert.equal(status.activeCycleId, 'cycle-one');
  assert.deepEqual(status.cap, {
    offChain24Hour: {
      usedMicroUsdg: '40',
      limitMicroUsdg: '100',
      remainingMicroUsdg: '60',
    },
    loss: {
      realizedLossMicroUsdg: '0',
      atRiskMicroUsdg: '0',
      usedMicroUsdg: '0',
      limitMicroUsdg: '100',
      remainingMicroUsdg: '100',
    },
    outstandingCustody: {
      usedMicroUsdg: '0',
      limitMicroUsdg: '100',
      remainingMicroUsdg: '100',
    },
    heldPositions: {
      count: 0,
      maxCount: 10,
      valueMicroUsdg: '0',
      maxValueMicroUsdg: '5000000000',
    },
    onChainRemainingCapacity: null,
  });
  assert.deepEqual(status.cycles[0].stages, [
    { stage: 'eligibility-snapshot', status: 'PENDING' },
    { stage: 'claim-process', status: 'COMPLETE' },
  ]);
  assert.deepEqual(status.cycles[0].requests, [{
    stage: 'claim-process',
    state: 'PREPARED',
    requestDigest: hash('b'),
  }]);
  assert.equal(status.cycles[0].payout, null);
  assert.equal(status.cycles[0].transactionIds, null);
  const bucket = status.custody.buckets[0];
  assert.deepEqual(bucket.buckets.claimed, {
    chainId: ledger.chainId,
    assetId: ledger.assetId,
    decimals: ledger.decimals,
    amountAtomic: '40',
  });
  assert.deepEqual(Object.keys(bucket.buckets), CUSTODY_LEDGER_BUCKETS);
  assert.deepEqual(status.alerts, []);
  assert.deepEqual(status.alertSources, { safetyTelemetry: true });
  assert.equal(custodyReads, 1);
  assert.deepEqual(repository.calls.describeCycle, ['cycle-one']);
});

test('status projects canonical lifecycle order and durable chain transaction evidence', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  const outboundDigest = hash('d');
  const payoutDigest = hash('e');
  const repository = createRepository({
    descriptions: new Map([['cycle-one', {
      cycleId: 'cycle-one',
      releaseAmount: '40',
      terminalState: null,
      stages: new Map([
        ['purchase', { status: 'COMPLETE' }],
        ['payout', { status: 'COMPLETE' }],
      ]),
      preparedStages: new Map([
        ['claim-process', { journalHead: hash('a') }],
        ['outbound', { journalHead: hash('b') }],
      ]),
      operationalAttempts: new Map([['outbound', {
        attempt: {
          schema: 'hookemon.provider-mutation-attempt.v1',
          cycleId: 'cycle-one',
          stage: 'outbound',
          state: 'SENT_UNKNOWN',
          requestDigest: outboundDigest,
          responseDigest: null,
          reconciliationDigest: null,
        },
        responseEvidence: null,
        reconciliationEvidence: null,
        failed: false,
      }]]),
      chainAttempts: new Map([[`payout\u0000${payoutDigest}`, {
        attempt: {
          schema: 'hookemon.chain-transaction-attempt.v1',
          cycleId: 'cycle-one',
          stage: 'payout',
          state: 'FINALIZED',
          requestDigest: payoutDigest,
          rawBytes: '0xdeadbeef',
          nonce: '7',
          blockhash: null,
          hash: '0xpayout',
        },
        broadcastEvidence: { transactionHash: '0xpayout' },
        finalityEvidence: { transactionHash: '0xpayout', blockNumber: '9' },
      }]]),
      custodyLedgers: new Map(),
    }]]),
  });
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: repository,
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    readCustody: async () => ({
      realizedLossMicroUsdg: '0',
      atRiskMicroUsdg: '0',
      outstandingMicroUsdg: '0',
      heldAssets: false,
      heldPositions: { count: 0, valueMicroUsdg: '0', positions: [] },
      unattributed: false,
      unvaluedExposure: false,
    }),
  });

  const [cycle] = (await control.status()).cycles;

  assert.deepEqual(cycle.stages, [
    { stage: 'eligibility-snapshot', status: 'PENDING' },
    { stage: 'claim-process', status: 'PREPARED' },
    { stage: 'outbound', status: 'SENT_UNKNOWN' },
    { stage: 'purchase', status: 'COMPLETE' },
    { stage: 'payout', status: 'COMPLETE' },
  ]);
  assert.deepEqual(cycle.transactions, [{
    stage: 'payout',
    state: 'FINALIZED',
    requestDigest: payoutDigest,
    transactionId: '0xpayout',
  }]);
  assert.deepEqual(cycle.transactionIds, ['0xpayout']);
  assert.deepEqual(cycle.payout, { status: 'COMPLETE', transactionIds: ['0xpayout'] });
});

test('status retains durable pending and unknown stages and derives the next canonical stage', async t => {
  const statePath = await temporaryState(t);
  const repository = createRepository({
    descriptions: new Map([['cycle-one', {
      cycleId: 'cycle-one',
      releaseAmount: '40',
      terminalState: null,
      stages: new Map([
        ['eligibility-snapshot', { status: 'COMPLETE' }],
        ['claim-process', { status: 'PENDING' }],
        ['outbound', { status: 'UNKNOWN' }],
      ]),
      operationalAttempts: new Map(),
      chainAttempts: new Map(),
      custodyLedgers: new Map(),
    }]]),
  });
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: repository,
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    readCustody: async () => safetyTelemetry(),
  });

  const [cycle] = (await control.status()).cycles;

  assert.deepEqual(cycle.stages, [
    { stage: 'eligibility-snapshot', status: 'COMPLETE' },
    { stage: 'claim-process', status: 'PENDING' },
    { stage: 'outbound', status: 'UNKNOWN' },
  ]);
});

test('status derives the first incomplete canonical stage when the repository has only a completed prefix', async t => {
  const statePath = await temporaryState(t);
  const repository = createRepository({
    descriptions: new Map([['cycle-one', {
      cycleId: 'cycle-one',
      releaseAmount: '40',
      terminalState: null,
      stages: new Map([
        ['eligibility-snapshot', { status: 'COMPLETE' }],
        ['claim-process', { status: 'COMPLETE' }],
      ]),
      operationalAttempts: new Map(),
      chainAttempts: new Map(),
      custodyLedgers: new Map(),
    }]]),
  });
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: repository,
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    readCustody: async () => safetyTelemetry(),
  });

  const [cycle] = (await control.status()).cycles;

  assert.deepEqual(cycle.stages, [
    { stage: 'eligibility-snapshot', status: 'COMPLETE' },
    { stage: 'claim-process', status: 'COMPLETE' },
    { stage: 'outbound', status: 'PENDING' },
  ]);
});

test('status leaves a payout unavailable when no durable payout stage exists', async t => {
  const statePath = await temporaryState(t);
  const repository = createRepository({
    descriptions: new Map([['cycle-one', {
      cycleId: 'cycle-one',
      releaseAmount: '40',
      terminalState: 'HELD_OWNER_DECISION',
      stages: new Map([['purchase', { status: 'COMPLETE' }]]),
      operationalAttempts: new Map(),
      chainAttempts: new Map(),
      custodyLedgers: new Map(),
    }]]),
  });
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: repository,
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    readCustody: async () => ({
      realizedLossMicroUsdg: '0',
      atRiskMicroUsdg: '0',
      outstandingMicroUsdg: '0',
      heldAssets: false,
      heldPositions: { count: 0, valueMicroUsdg: '0', positions: [] },
      unattributed: false,
      unvaluedExposure: false,
    }),
  });

  assert.equal((await control.status()).cycles[0].payout, null);
});

test('status preserves held owner-decision facts from the repository', async t => {
  const statePath = await temporaryState(t);
  const heldEvidenceDigest = hash('f');
  const ownerDecision = {
    cycleId: 'cycle-one',
    heldEvidenceDigest,
    requestId: 'held-decision-1',
    expectedRevision: 6,
    choice: 'keep-holding',
  };
  const repository = createRepository({
    descriptions: new Map([['cycle-one', {
      cycleId: 'cycle-one',
      releaseAmount: '40',
      terminalState: 'HELD_OWNER_DECISION',
      version: 7,
      heldEvidenceDigest,
      ownerDecision,
      stages: new Map([['purchase', { status: 'COMPLETE' }]]),
      operationalAttempts: new Map(),
      chainAttempts: new Map(),
      custodyLedgers: new Map(),
    }]]),
  });
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: repository,
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    readCustody: async () => safetyTelemetry(),
  });

  const [cycle] = (await control.status()).cycles;

  assert.equal(cycle.version, 7);
  assert.equal(cycle.heldEvidenceDigest, heldEvidenceDigest);
  assert.deepEqual(cycle.ownerDecision, ownerDecision);
});

test('status projects loss and outstanding custody cap usage from policy telemetry', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath, configuration({
    lossCapMicroUsdg: '100',
    maxOutstandingCustodyMicroUsdg: '100',
  }));
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    readCustody: async () => ({
      realizedLossMicroUsdg: '7',
      atRiskMicroUsdg: '8',
      outstandingMicroUsdg: '19',
      heldAssets: false,
      heldPositions: { count: 0, valueMicroUsdg: '0', positions: [] },
      unattributed: false,
      unvaluedExposure: false,
    }),
  });

  const status = await control.status();

  assert.deepEqual(status.cap.loss, {
    realizedLossMicroUsdg: '7',
    atRiskMicroUsdg: '8',
    usedMicroUsdg: '15',
    limitMicroUsdg: '100',
    remainingMicroUsdg: '85',
  });
  assert.deepEqual(status.cap.outstandingCustody, {
    usedMicroUsdg: '19',
    limitMicroUsdg: '100',
    remainingMicroUsdg: '81',
  });
  assert.deepEqual(status.alertSources, { safetyTelemetry: true });
  assert.deepEqual(status.alerts, []);
});

test('status exposes held-position limit usage and the open positions', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath, configuration({ maxHeldPositions: 3, maxHeldValueMicroUsdg: '100' }));
  const position = {
    positionId: 'position-one',
    cycleId: 'cycle-one',
    packId: 'base-pack',
    memo: 'memo-one',
    mint: 'mint-one',
    cardRef: 'card-one',
    costMicroUsdg: '7',
    insuredValue: null,
    reason: 'HELD_UNAVAILABLE',
    terminalState: 'OPEN',
    evidenceDigest: hash('e'),
    openedAtMs: nowMs,
    ownerDecision: null,
    resolution: null,
    positionRevision: 0,
  };
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    readCustody: async () => safetyTelemetry({
      heldPositions: { count: 1, valueMicroUsdg: '7', positions: [position] },
    }),
  });

  const status = await control.status();

  assert.deepEqual(status.cap.heldPositions, {
    count: 1,
    maxCount: 3,
    valueMicroUsdg: '7',
    maxValueMicroUsdg: '100',
  });
  assert.deepEqual(status.heldPositions, [position]);
});

test('status marks unavailable safety telemetry with an authority alert', async t => {
  const statePath = await temporaryState(t);
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    readCustody: async () => { throw new Error('reader offline'); },
  });

  const status = await control.status();

  assert.equal(status.cap.loss, null);
  assert.equal(status.cap.outstandingCustody, null);
  assert.deepEqual(status.alertSources, { safetyTelemetry: false });
  assert.deepEqual(status.alerts, [{
    source: 'operator-control',
    code: 'SAFETY_TELEMETRY_UNAVAILABLE',
    severity: 'critical',
    message: 'Required safety telemetry is unavailable',
  }]);
});

test('run-cycle-now refuses to invoke an exposure-increasing authority without safety telemetry', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  let ticks = 0;
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    triggerTick: async () => { ticks += 1; },
    readCustody: async () => { throw new Error('reader offline'); },
  });

  await assert.rejects(
    control.execute({ expectedRevision: 0, command: { type: 'run-cycle-now' } }),
    /safety telemetry.*unavailable/i,
  );

  assert.equal(ticks, 0);
});

test('an exposure-increasing configuration update refuses unavailable safety telemetry', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    readCustody: async () => { throw new Error('reader offline'); },
  });

  await assert.rejects(
    control.execute({
      expectedRevision: 0,
      command: { type: 'update-configuration', configuration: { max24HourBudgetMicroUsdg: '101' } },
    }),
    /safety telemetry.*unavailable/i,
  );
});

test('increasing the unresolved-card deadline requires safety telemetry', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    readCustody: async () => { throw new Error('reader offline'); },
  });

  await assert.rejects(
    control.execute({
      expectedRevision: 0,
      command: { type: 'update-configuration', configuration: { unresolvedCardDeadlineMinutes: 31 } },
    }),
    /safety telemetry.*unavailable/i,
  );
});

test('pause and kill persist execution guards before the policy engine observes them', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  const policyEngine = policyEngineForState(statePath);
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    policyEngine,
    readCustody: async () => safetyTelemetry(),
  });

  await control.execute({ expectedRevision: 0, command: { type: 'pause' } });
  await assert.rejects(
    policyEngine.assertExecutionAllowed({ boundary: 'signature', liveMode: true }),
    /EXECUTION_PAUSED/,
  );

  await control.execute({ expectedRevision: 1, command: { type: 'resume' } });
  await control.execute({ expectedRevision: 2, command: { type: 'kill' } });
  await assert.rejects(
    policyEngine.assertExecutionAllowed({ boundary: 'signature', liveMode: true }),
    /KILL_SWITCH/,
  );
});

test('retrying pause after an unrelated configuration change advanced the revision is a real conflict, never a false success', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    readCustody: async () => safetyTelemetry(),
  });

  // An unrelated command advances the revision while pause's own retry still targets revision 0 —
  // the exact independent-repro shape: pause never durably applied, but a generic revision CAS
  // failure alone must not be read as proof that it did.
  await control.execute({
    expectedRevision: 0,
    command: { type: 'update-configuration', configuration: { intervalMinutes: 10 } },
  });

  await assert.rejects(
    control.execute({ expectedRevision: 0, command: { type: 'pause' } }),
    /stale operator state revision/,
  );
  const status = await control.status();
  assert.equal(status.configuration.paused, false, 'pause was never durably applied by the failed retry');
});

test('retrying pause against a revision it already durably applied recognizes the authoritative postcondition instead of failing', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    readCustody: async () => safetyTelemetry(),
  });

  const first = await control.execute({ expectedRevision: 0, command: { type: 'pause' } });
  assert.equal(first.revision, 1);
  assert.equal(first.configuration.paused, true);

  // A retry with the same original (now stale) expectedRevision — the exact shape a crashed effect's
  // safe re-execution produces — must recognize the postcondition it already reached, not throw.
  const retried = await control.execute({ expectedRevision: 0, command: { type: 'pause' } });
  assert.equal(retried.action, 'pause');
  assert.equal(retried.revision, 1);
  assert.equal(retried.configuration.paused, true);
});

test('retrying update-configuration against a revision it already durably applied recognizes the authoritative postcondition', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    readCustody: async () => safetyTelemetry(),
  });
  const patch = { intervalMinutes: 15 };

  const first = await control.execute({ expectedRevision: 0, command: { type: 'update-configuration', configuration: patch } });
  assert.equal(first.configuration.intervalMinutes, 15);

  const retried = await control.execute({ expectedRevision: 0, command: { type: 'update-configuration', configuration: patch } });
  assert.equal(retried.revision, first.revision);
  assert.equal(retried.configuration.intervalMinutes, 15);

  // A retry whose patch would produce a functionally different result than what is durably current
  // remains a real, reported conflict.
  await assert.rejects(
    control.execute({ expectedRevision: 0, command: { type: 'update-configuration', configuration: { intervalMinutes: 20 } } }),
    /stale operator state revision/,
  );
});

test('manual approval delegates one exact digest-bound request to the policy engine', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  const calls = [];
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    policyEngine: {
      async recordManualApproval(input) {
        calls.push(input);
        return { cycleId: input.cycleId, cycleDigest: input.cycleDigest, approvedAtMs: nowMs };
      },
    },
    readCustody: async () => safetyTelemetry(),
  });

  const result = await control.execute({
    expectedRevision: 0,
    requestId: 'manual-approval-1',
    command: { type: 'manual-approval', cycleId: 'cycle-one', cycleDigest: hash('c') },
  });

  assert.deepEqual(calls, [{ cycleId: 'cycle-one', cycleDigest: hash('c'), expectedRevision: 0 }]);
  assert.deepEqual(result.approval, { cycleId: 'cycle-one', cycleDigest: hash('c'), approvedAtMs: nowMs });
});

test('manual approval requires a stable request identity', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    policyEngine: { recordManualApproval: async () => { throw new Error('must not be called without a requestId'); } },
    readCustody: async () => safetyTelemetry(),
  });

  await assert.rejects(
    control.execute({
      expectedRevision: 0,
      command: { type: 'manual-approval', cycleId: 'cycle-one', cycleDigest: hash('c') },
    }),
    /requestId is invalid/,
  );
});

test('a manual approval that crashed after its effect but before audit completion recovers by reading back the exact durable approval, not by failing UNCERTAIN', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  const cycleDigest = hash('e');
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    // Stands in for production composition's injected mutateConfiguration: it rejects a stale
    // expectedRevision before recordManualApproval's own cycleDigest idempotency check ever runs --
    // exactly the shape of a crash-after-effect replay, since the approval itself is what advanced
    // the revision this retry still expects.
    policyEngine: { recordManualApproval: async () => { throw new Error('stale operator state revision'); } },
    readCustody: async () => safetyTelemetry(),
  });

  // An unrelated command first advances the revision (matching the real shape: the crashed attempt's
  // own effect is what moves the revision the retry's expectedRevision still targets), then a
  // policyEngine that performs a real, expectedRevision-honoring durable write -- mirroring
  // production's actual mutateConfiguration dependency, unlike the always-succeeds-against-latest
  // policyEngineForState() test helper -- durably records the approval.
  await control.execute({
    expectedRevision: 0,
    requestId: 'seed-approval',
    command: { type: 'update-configuration', configuration: { intervalMinutes: 10 } },
  });
  const seeded = await createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    policyEngine: {
      recordManualApproval: async ({ cycleId, cycleDigest: digestValue, expectedRevision }) => {
        const { mutateOperatorState } = await stateFileModule();
        await mutateOperatorState(statePath, expectedRevision, current => ({
          ...current,
          configuration: {
            ...current.configuration,
            approvalsByCycleDigest: { ...current.configuration.approvalsByCycleDigest, [digestValue]: { cycleId, approvedAtMs: 5_000 } },
          },
        }));
        return { cycleId, cycleDigest: digestValue, approvedAtMs: 5_000 };
      },
    },
    readCustody: async () => safetyTelemetry(),
  }).execute({
    expectedRevision: 1,
    requestId: 'real-approval',
    command: { type: 'manual-approval', cycleId: 'cycle-one', cycleDigest },
  });
  assert.equal(seeded.approval.cycleId, 'cycle-one');

  // The retry replays the crashed attempt's original (now stale) expectedRevision.
  const retried = await control.execute({
    expectedRevision: 1,
    requestId: 'real-approval',
    command: { type: 'manual-approval', cycleId: 'cycle-one', cycleDigest },
  });
  assert.deepEqual(retried.approval, { cycleId: 'cycle-one', cycleDigest, approvedAtMs: 5_000 });

  // A retry for a cycleId that was never actually approved remains a real, reported conflict.
  await assert.rejects(
    control.execute({
      expectedRevision: 1,
      requestId: 'real-approval-other',
      command: { type: 'manual-approval', cycleId: 'cycle-two', cycleDigest },
    }),
    /stale operator state revision/,
  );
});

test('held owner decisions carry the audited request and position revision to the repository authority', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  const calls = [];
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    recordHeldOwnerDecision: async decision => {
      calls.push(decision);
      return decision;
    },
  });

  const result = await control.execute({
    expectedRevision: 0,
    requestId: 'held-decision-1',
    command: {
      type: 'held-owner-decision',
      positionId: 'position-held',
      heldEvidenceDigest: hash('d'),
      expectedPositionRevision: 4,
      choice: 'keep-holding',
    },
  });

  const decision = {
    positionId: 'position-held',
    heldEvidenceDigest: hash('d'),
    expectedRevision: 4,
    requestId: 'held-decision-1',
    choice: 'keep-holding',
  };
  assert.deepEqual(calls, [decision]);
  assert.deepEqual(result, { action: 'held-owner-decision', revision: 0, decision });
});

test('reconcile without a wired reconciliation authority reads repository state and invokes nothing', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  let ticks = 0;
  let resumes = 0;
  let approvals = 0;
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository(),
    policyEngine: { async recordManualApproval() { approvals += 1; } },
    triggerTick: async () => { ticks += 1; },
    resumeActiveCycle: async () => { resumes += 1; },
  });

  const result = await control.execute({ expectedRevision: 0, command: { type: 'reconcile' } });

  assert.equal(result.action, 'reconcile');
  assert.equal(ticks, 0);
  assert.equal(resumes, 0);
  assert.equal(approvals, 0);
});

test('reconcile with a wired reconciliation authority triggers serialized recovery and never opens a new cycle', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  let ticks = 0;
  let reconciles = 0;
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository(),
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    triggerTick: async () => { ticks += 1; return { tick: 'started' }; },
    reconcileActiveCycle: async input => { reconciles += 1; assert.deepEqual(input, { requestId: 'reconcile-request-1' }); return { status: 'IN_PROGRESS', cycleId: 'cycle-one' }; },
    readCustody: async () => safetyTelemetry(),
  });

  const result = await control.execute({
    expectedRevision: 0, requestId: 'reconcile-request-1', command: { type: 'reconcile' },
  });

  assert.deepEqual(result, {
    action: 'reconcile',
    resultCode: 'RECOVERY_IN_PROGRESS',
    result: { status: 'IN_PROGRESS', cycleId: 'cycle-one' },
    revision: 0,
  });
  assert.equal(reconciles, 1);
  assert.equal(ticks, 0, 'reconcile never opens a new cycle, wired or not');
});

test('reconcile with a wired authority requires a stable request identity, so a compliant authority can check its own durable postcondition', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository(),
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    reconcileActiveCycle: async () => ({ status: 'NO_ACTIVE_CYCLE' }),
    readCustody: async () => safetyTelemetry(),
  });

  await assert.rejects(
    control.execute({ expectedRevision: 0, command: { type: 'reconcile' } }),
    /requestId is invalid/,
  );
});

test('a wired reconcile refuses without safety telemetry, same as resume-cycle', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository(),
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    reconcileActiveCycle: async () => { throw new Error('must not be called without safety telemetry'); },
  });

  await assert.rejects(
    control.execute({ expectedRevision: 0, command: { type: 'reconcile' } }),
    /safety telemetry is unavailable/,
  );
});

test('resume-cycle and run-cycle-now each call their injected authority once, threading the stable request identity', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  let ticks = 0;
  let resumes = 0;
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    triggerTick: async input => { ticks += 1; assert.deepEqual(input, { requestId: 'run-now-1' }); return { tick: 'started' }; },
    resumeActiveCycle: async input => { resumes += 1; assert.deepEqual(input, { requestId: 'resume-1' }); return { status: 'RESUMED', cycle: 'resumed' }; },
    readCustody: async () => safetyTelemetry(),
  });

  assert.deepEqual(
    await control.execute({ expectedRevision: 0, requestId: 'resume-1', command: { type: 'resume-cycle' } }),
    {
      action: 'resume-cycle',
      resultCode: 'RECOVERY_RESUMED',
      result: { status: 'RESUMED', cycle: 'resumed' },
      revision: 0,
    },
  );
  assert.deepEqual(
    await control.execute({ expectedRevision: 0, requestId: 'run-now-1', command: { type: 'run-cycle-now' } }),
    {
      action: 'run-cycle-now',
      resultCode: 'TICK_TRIGGERED',
      result: { tick: 'started' },
      revision: 0,
    },
  );
  assert.equal(resumes, 1);
  assert.equal(ticks, 1);
});

test('resume-cycle and run-cycle-now each require a stable request identity, so a compliant authority can check its own durable postcondition instead of trusting a bare retry', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    triggerTick: async () => ({ tick: 'started' }),
    resumeActiveCycle: async () => ({ status: 'RESUMED' }),
    readCustody: async () => safetyTelemetry(),
  });

  await assert.rejects(
    control.execute({ expectedRevision: 0, command: { type: 'resume-cycle' } }),
    /requestId is invalid/,
  );
  await assert.rejects(
    control.execute({ expectedRevision: 0, command: { type: 'run-cycle-now' } }),
    /requestId is invalid/,
  );
});

test('configuration updates use the runner schema and reject unknown fields', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    readCustody: async () => safetyTelemetry(),
  });

  const updated = await control.execute({
    expectedRevision: 0,
    command: { type: 'update-configuration', configuration: { intervalMinutes: 30 } },
  });
  assert.equal(updated.revision, 1);
  assert.equal(updated.configuration.intervalMinutes, 30);
  await assert.rejects(
    control.execute({
      expectedRevision: 1,
      command: { type: 'update-configuration', configuration: { unsupported: true } },
    }),
    /configuration|patch/i,
  );
});

test('configuration updates reject monetary values above the fixed operator ceilings', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    readCustody: async () => safetyTelemetry(),
  });

  const atCeiling = await control.execute({
    expectedRevision: 0,
    command: {
      type: 'update-configuration',
      configuration: {
        maxUnitPriceMicroUsdg: '55000000',
        maxCycleBudgetMicroUsdg: '165000000',
        max24HourBudgetMicroUsdg: '495000000',
        perCycleCapMicroUsdg: '165000000',
        lossCapMicroUsdg: '495000000',
        maxOutstandingCustodyMicroUsdg: '495000000',
      },
    },
  });
  assert.equal(atCeiling.revision, 1);

  await assert.rejects(
    control.execute({
      expectedRevision: 1,
      command: {
        type: 'update-configuration',
        configuration: {
          maxUnitPriceMicroUsdg: '55000001',
          maxCycleBudgetMicroUsdg: '165000001',
          perCycleCapMicroUsdg: '165000001',
          max24HourBudgetMicroUsdg: '495000001',
        },
      },
    }),
    /hard cap|ceiling/i,
  );
});
