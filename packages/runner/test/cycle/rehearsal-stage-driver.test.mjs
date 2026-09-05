import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CycleRepository } from '../../../adapters/src/app/cycle-repository.mjs';
import { createRehearsalStageDriver, RehearsalRestartInjectedError } from '../../src/cycle/rehearsal-stage-driver.mjs';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-rehearsal-driver-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('a restart injected after a recorded fake effect reconciles the persisted attempt without duplicating it', async t => {
  const repository = await CycleRepository.open(await temporaryDirectory(t), () => 1_000);
  const cycle = await repository.createCycle({ releaseAmount: '30', mode: 'rehearsal' });
  await repository.prepareStage(cycle.cycleId, 'eligibility-snapshot');
  let effects = 0;
  const driver = createRehearsalStageDriver({
    cycleRepository: repository,
    config: {
      chainId: 4663,
      contracts: { usdg: `0x${'a'.repeat(40)}`, usdgDecimals: 6 },
      relay: { solanaMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
      rehearsal: { mode: 'collector-only', proceedsAccount: '8Jw81w1ktEoZx18C4ZP6HhgnbtbzYAKZB7qL3WTmRS3t' },
    },
    onEffect: async () => { effects += 1; },
    restartInjector: async () => { throw new RehearsalRestartInjectedError(); },
  });
  const context = {
    cycleId: cycle.cycleId,
    stage: 'eligibility-snapshot',
    releaseAmountMicroUsdg: '30',
    assertMutationAllowed: async () => {},
  };

  await assert.rejects(() => driver.execute(context), RehearsalRestartInjectedError);
  assert.equal(effects, 1);
  assert.equal((await repository.readOperationalStageAttempt(cycle.cycleId, context.stage)).attempt.state, 'RESPONSE_RECORDED');

  const evidence = await driver.reconcile(context);
  assert.equal(effects, 1);
  await driver.commit({ ...context, evidence });
  assert.equal((await repository.readOperationalStageAttempt(cycle.cycleId, context.stage)).attempt.state, 'RECONCILED');
});

test('a prepared or unknown fake effect is never fabricated as reconciled evidence', async t => {
  const repository = await CycleRepository.open(await temporaryDirectory(t), () => 1_000);
  const cycle = await repository.createCycle({ releaseAmount: '30', mode: 'rehearsal', providerMode: 'fake' });
  await repository.prepareStage(cycle.cycleId, 'purchase');
  const driver = createRehearsalStageDriver({
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
  });
  const context = {
    cycleId: cycle.cycleId,
    stage: 'purchase',
    releaseAmountMicroUsdg: '30',
    assertMutationAllowed: async () => {},
  };
  await repository.prepareStageAttempt(cycle.cycleId, 'purchase', {
    schema: 'hookemon.provider-mutation-attempt.v1',
    cycleId: cycle.cycleId,
    stage: 'purchase',
    state: 'PREPARED',
    requestDigest: `sha256:${'f'.repeat(64)}`,
    responseDigest: null,
    reconciliationDigest: null,
  });

  await assert.rejects(() => driver.reconcile(context), /has no recorded provider response/);
  assert.equal((await repository.readOperationalStageAttempt(cycle.cycleId, 'purchase')).attempt.state, 'PREPARED');
  await repository.markStageAttemptSentUnknown(cycle.cycleId, 'purchase');
  await assert.rejects(() => driver.reconcile(context), /has no recorded provider response/);
  assert.equal((await repository.readOperationalStageAttempt(cycle.cycleId, 'purchase')).attempt.state, 'SENT_UNKNOWN');
});

test('a collector-only rehearsal dispatches collector effects through the sealed fake provider', async t => {
  const repository = await CycleRepository.open(await temporaryDirectory(t), () => 1_000);
  const cycle = await repository.createCycle({ releaseAmount: '30', mode: 'rehearsal' });
  await repository.prepareStage(cycle.cycleId, 'purchase');
  const effects = [];
  const driver = createRehearsalStageDriver({
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
      collector: {
        kind: 'hookemon.rehearsal-fake-provider.v1',
        async executeRehearsalEffect(effect) { effects.push(effect); },
      },
    },
  });
  const context = {
    cycleId: cycle.cycleId,
    stage: 'purchase',
    releaseAmountMicroUsdg: '30',
    assertMutationAllowed: async () => {},
  };

  await driver.execute(context);
  assert.deepEqual(effects, [{
    provider: 'collector', cycleId: cycle.cycleId, stage: 'purchase', effectId: `rehearsal:${cycle.cycleId}:purchase`,
  }]);
  assert.equal((await repository.readOperationalStageAttempt(cycle.cycleId, 'purchase')).attempt.state, 'RECONCILED');
});

test('a collector-only rehearsal durably skips outbound and return without a Relay fake effect', async t => {
  const repository = await CycleRepository.open(await temporaryDirectory(t), () => 1_000);
  const cycle = await repository.createCycle({ releaseAmount: '30', mode: 'rehearsal', providerMode: 'fake' });
  const relayEffects = [];
  const emittedEffects = [];
  const driver = createRehearsalStageDriver({
    cycleRepository: repository,
    config: {
      chainId: 4663,
      contracts: { usdg: `0x${'a'.repeat(40)}`, usdgDecimals: 6 },
      relay: { solanaMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
      rehearsal: { mode: 'collector-only', proceedsAccount: '8Jw81w1ktEoZx18C4ZP6HhgnbtbzYAKZB7qL3WTmRS3t' },
      execution: { providerMode: 'fake' },
    },
    providers: {
      relay: {
        kind: 'hookemon.rehearsal-fake-provider.v1',
        async executeRehearsalEffect(effect) { relayEffects.push(effect); },
      },
      collector: { kind: 'hookemon.rehearsal-fake-provider.v1', async executeRehearsalEffect() {} },
    },
    onEffect: async effect => { emittedEffects.push(effect); },
  });

  for (const stage of ['outbound', 'return']) {
    await repository.prepareStage(cycle.cycleId, stage);
    const context = {
      cycleId: cycle.cycleId,
      stage,
      releaseAmountMicroUsdg: '30',
      assertMutationAllowed: async () => {},
    };
    await driver.execute(context);
    const evidence = await driver.reconcile(context);
    assert.equal(evidence.skipped, true);
    assert.equal(evidence.rehearsalMode, 'collector-only');
    assert.deepEqual(evidence.finalizedDeltas, []);
    assert.deepEqual(evidence.residues, []);
    assert.equal((await repository.readOperationalStageAttempt(cycle.cycleId, stage)).attempt.state, 'RECONCILED');
  }

  assert.deepEqual(relayEffects, []);
  assert.deepEqual(emittedEffects, []);
});

test('a relay-roundtrip rehearsal refuses to construct without its explicit positive cap', async t => {
  const repository = await CycleRepository.open(await temporaryDirectory(t), () => 1_000);
  assert.throws(
    () => createRehearsalStageDriver({
      cycleRepository: repository,
      config: {
        chainId: 4663,
        contracts: { usdg: `0x${'a'.repeat(40)}`, usdgDecimals: 6 },
        relay: { solanaMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
        rehearsal: { mode: 'relay-roundtrip', proceedsAccount: '8Jw81w1ktEoZx18C4ZP6HhgnbtbzYAKZB7qL3WTmRS3t' },
        execution: { providerMode: 'fake' },
      },
      providers: {
        relay: { kind: 'hookemon.rehearsal-fake-provider.v1', async executeRehearsalEffect() {} },
        collector: { kind: 'hookemon.rehearsal-fake-provider.v1', async executeRehearsalEffect() {} },
      },
    }),
    /relay-roundtrip.*positive.*cap/,
  );
});

test('a capped relay-roundtrip rehearsal invokes the Relay fake provider', async t => {
  const repository = await CycleRepository.open(await temporaryDirectory(t), () => 1_000);
  const cycle = await repository.createCycle({ releaseAmount: '30', mode: 'rehearsal', providerMode: 'fake' });
  await repository.prepareStage(cycle.cycleId, 'outbound');
  const relayEffects = [];
  const driver = createRehearsalStageDriver({
    cycleRepository: repository,
    config: {
      chainId: 4663,
      contracts: { usdg: `0x${'a'.repeat(40)}`, usdgDecimals: 6 },
      relay: { solanaMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
      rehearsal: { mode: 'relay-roundtrip', proceedsAccount: '8Jw81w1ktEoZx18C4ZP6HhgnbtbzYAKZB7qL3WTmRS3t' },
      execution: { providerMode: 'fake', rehearsalCapUsdg: '30' },
    },
    providers: {
      relay: {
        kind: 'hookemon.rehearsal-fake-provider.v1',
        async executeRehearsalEffect(effect) { relayEffects.push(effect); },
      },
      collector: { kind: 'hookemon.rehearsal-fake-provider.v1', async executeRehearsalEffect() {} },
    },
  });
  const context = {
    cycleId: cycle.cycleId,
    stage: 'outbound',
    releaseAmountMicroUsdg: '30',
    assertMutationAllowed: async () => {},
  };

  await driver.execute(context);
  const evidence = await driver.reconcile(context);
  assert.equal(evidence.skipped, undefined);
  assert.deepEqual(relayEffects, [{
    provider: 'relay', cycleId: cycle.cycleId, stage: 'outbound', effectId: `rehearsal:${cycle.cycleId}:outbound`,
  }]);
  assert.equal((await repository.readOperationalStageAttempt(cycle.cycleId, 'outbound')).attempt.state, 'RECONCILED');
});
