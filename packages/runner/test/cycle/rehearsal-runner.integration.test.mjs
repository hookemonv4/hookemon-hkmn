import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CycleRepository } from '../../../adapters/src/app/cycle-repository.mjs';
import { AutomatedCycleService, AUTOMATED_CYCLE_STAGES } from '../../src/automation/automated-cycle-service.mjs';
import { createPolicyEngine, deriveCyclePolicyDigest, PolicyRefusalError } from '../../src/automation/policy-engine.mjs';
import { createDefaultOperatorConfiguration } from '../../src/config/state-schema.mjs';
import { collectRehearsalEvidence, writeRehearsalEvidence } from '../../src/cycle/rehearsal-evidence.mjs';
import { createRehearsalStageDriver, RehearsalRestartInjectedError } from '../../src/cycle/rehearsal-stage-driver.mjs';

class MemoryLeaseStore {
  #version = 0;
  #lease = null;

  readLease() {
    return { version: this.#version, lease: this.#lease === null ? null : structuredClone(this.#lease) };
  }

  compareAndSwapLease(expectedVersion, nextLease) {
    if (expectedVersion !== this.#version) return false;
    this.#version += 1;
    this.#lease = nextLease === null ? null : structuredClone(nextLease);
    return true;
  }
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-rehearsal-runner-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function rehearsalConfiguration() {
  return {
    ...createDefaultOperatorConfiguration(),
    allowedPackIds: ['collector-25'],
    requestedOrders: 1,
    maxBoostersPerCycle: 1,
    maxUnitPriceMicroUsdg: '30',
    maxCycleBudgetMicroUsdg: '30',
    max24HourBudgetMicroUsdg: '60',
    perCycleCapMicroUsdg: '30',
    lossCapMicroUsdg: '60',
    maxOutstandingCustodyMicroUsdg: '60',
    maxCyclesPerDay: 2,
    manualApprovalCycles: 2,
  };
}

function createRehearsalPolicy(configuration) {
  let current = configuration;
  const policyEngine = createPolicyEngine({
    now: () => 1_000,
    readConfiguration: async () => current,
    readCustody: async () => ({
      realizedLossMicroUsdg: '0',
      atRiskMicroUsdg: '0',
      outstandingMicroUsdg: '0',
      heldAssets: false,
      unattributed: false,
      unvaluedExposure: false,
    }),
    mutateConfiguration: async mutation => {
      const outcome = await mutation(current);
      current = outcome.configuration;
      return outcome.result;
    },
  });
  return Object.freeze({ policyEngine, readConfiguration: () => current });
}

function createService({ repository, leaseStore, policyEngine, effects }) {
  const stageDriver = createRehearsalStageDriver({
    cycleRepository: repository,
    config: {
      chainId: 4663,
      contracts: { usdg: `0x${'a'.repeat(40)}`, usdgDecimals: 6 },
      relay: { solanaMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
      rehearsal: { mode: 'collector-only', proceedsAccount: '8Jw81w1ktEoZx18C4ZP6HhgnbtbzYAKZB7qL3WTmRS3t' },
      execution: { providerMode: 'fake' },
    },
    providers: {
      relay: { kind: 'hookemon.rehearsal-fake-provider.v1', async executeRehearsalEffect() {} },
      collector: { kind: 'hookemon.rehearsal-fake-provider.v1', async executeRehearsalEffect() {} },
    },
    onEffect: async effect => { effects.push(effect.effectId); },
    restartInjector: async () => { throw new RehearsalRestartInjectedError(); },
  });
  return new AutomatedCycleService({
    owner: 'rehearsal-worker',
    leaseTtlMs: 1_000,
    now: () => 1_000,
    leaseStore,
    budgetReader: {
      read: async () => ({
        availableProcessUsdg: '30',
        packPriceUsdg: '30',
        outboundCapUsdg: '0',
        returnCapUsdg: '0',
        operatingMarginUsdg: '0',
        activeCycleId: null,
      }),
    },
    cycleRepository: repository,
    runnerFactory: cycleId => ({ cycleId }),
    stageDriver,
    feeSettlementObserver: { observe: async cycleId => ({ cycleId, status: 'PENDING_BENEFICIARY_CLAIMS' }) },
    liveMode: false,
    mode: 'rehearsal',
    providerMode: 'fake',
    packId: 'collector-25',
    policyCapUsdg: '30',
    policyEngine,
  });
}

test('two capped collector-only rehearsal cycles recover after every fake effect and write invariant evidence', async t => {
  const stateDir = await temporaryDirectory(t);
  const repository = await CycleRepository.open(join(stateDir, 'cycles'), () => 1_000);
  const leaseStore = new MemoryLeaseStore();
  const policy = createRehearsalPolicy(rehearsalConfiguration());
  const effects = [];
  const completed = [];

  while (completed.length < 2) {
    const service = createService({ repository, leaseStore, policyEngine: policy.policyEngine, effects });
    try {
      const result = await service.runOnce();
      assert.equal(result.status, 'COMPLETE');
      const evidence = collectRehearsalEvidence(await repository.describeCycle(result.cycleId));
      const evidencePath = await writeRehearsalEvidence({ stateDir, evidence });
      completed.push({ evidence, evidencePath });
    } catch (error) {
      if (error instanceof PolicyRefusalError) {
        assert.equal(error.reason, 'MANUAL_APPROVAL_REQUIRED');
        const active = await repository.readActiveCycle();
        assert.ok(active);
        const configuration = policy.readConfiguration();
        const cycleDigest = deriveCyclePolicyDigest({
          configuration,
          cycleId: active.cycleId,
          releaseAmountMicroUsdg: active.releaseAmount,
          packId: 'collector-25',
          liveMode: false,
          mode: 'rehearsal',
        });
        await policy.policyEngine.recordManualApproval({ cycleDigest, cycleId: active.cycleId, approvedAtMs: 1_000 });
      } else {
        assert.ok(error instanceof RehearsalRestartInjectedError);
      }
    }
  }

  assert.equal(new Set(effects).size, effects.length, 'a restart never repeats a fake irreversible effect');
  const effectfulStages = AUTOMATED_CYCLE_STAGES.filter(stage => !['outbound', 'return'].includes(stage));
  assert.equal(effects.length, effectfulStages.length * 2);
  assert.ok(effects.every(effectId => !effectId.endsWith(':outbound') && !effectId.endsWith(':return')));
  assert.equal(new Set(completed.map(item => item.evidence.cycleId)).size, 2);
  for (const { evidence, evidencePath } of completed) {
    assert.equal(evidence.mode, 'rehearsal');
    assert.equal(evidence.payout.proceeds.amountAtomic, evidence.payout.allocated.amountAtomic);
    assert.ok(evidence.residues.every(residue => residue.classification === 'none'));
    assert.deepEqual(JSON.parse(await readFile(evidencePath, 'utf8')), evidence);
  }
});
