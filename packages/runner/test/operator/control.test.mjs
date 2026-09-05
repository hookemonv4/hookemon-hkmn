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
    command: { type: 'manual-approval', cycleId: 'cycle-one', cycleDigest: hash('c') },
  });

  assert.deepEqual(calls, [{ cycleId: 'cycle-one', cycleDigest: hash('c'), expectedRevision: 0 }]);
  assert.deepEqual(result.approval, { cycleId: 'cycle-one', cycleDigest: hash('c'), approvedAtMs: nowMs });
});

test('held owner decisions carry the audited request and held-cycle revision to the repository authority', async t => {
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
      cycleId: 'cycle-held',
      heldEvidenceDigest: hash('d'),
      expectedCycleRevision: 4,
      choice: 'keep-holding',
    },
  });

  const decision = {
    cycleId: 'cycle-held',
    heldEvidenceDigest: hash('d'),
    expectedRevision: 4,
    requestId: 'held-decision-1',
    choice: 'keep-holding',
  };
  assert.deepEqual(calls, [decision]);
  assert.deepEqual(result, { action: 'held-owner-decision', revision: 0, decision });
});

test('reconcile reads repository state without invoking an effect callback', async t => {
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

test('resume-cycle and run-cycle-now each call their injected authority once', async t => {
  const statePath = await temporaryState(t);
  await seedConfiguration(statePath);
  let ticks = 0;
  let resumes = 0;
  const { createOperatorControl } = await controlModule();
  const control = createOperatorControl({
    statePath,
    cycleRepository: createRepository({ activeCycleId: null, knownCycleIds: [] }),
    policyEngine: { recordManualApproval: async () => { throw new Error('not used'); } },
    triggerTick: async () => { ticks += 1; return { tick: 'started' }; },
    resumeActiveCycle: async () => { resumes += 1; return { status: 'RESUMED', cycle: 'resumed' }; },
    readCustody: async () => safetyTelemetry(),
  });

  assert.deepEqual(
    await control.execute({ expectedRevision: 0, command: { type: 'resume-cycle' } }),
    {
      action: 'resume-cycle',
      resultCode: 'RECOVERY_RESUMED',
      result: { status: 'RESUMED', cycle: 'resumed' },
      revision: 0,
    },
  );
  assert.deepEqual(
    await control.execute({ expectedRevision: 0, command: { type: 'run-cycle-now' } }),
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
        maxUnitPriceMicroUsdg: '25000000',
        maxCycleBudgetMicroUsdg: '50000000',
        max24HourBudgetMicroUsdg: '3600000000',
        perCycleCapMicroUsdg: '50000000',
        lossCapMicroUsdg: '50000000',
        maxOutstandingCustodyMicroUsdg: '50000000',
      },
    },
  });
  assert.equal(atCeiling.revision, 1);

  await assert.rejects(
    control.execute({
      expectedRevision: 1,
      command: { type: 'update-configuration', configuration: { maxUnitPriceMicroUsdg: '25000001' } },
    }),
    /hard cap|ceiling/i,
  );
});
