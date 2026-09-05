import assert from 'node:assert/strict';
import test from 'node:test';

import { createDefaultOperatorConfiguration } from '../../src/config/state-schema.mjs';
import {
  createPolicyEngine,
  deriveCyclePolicyDigest,
  POLICY_WINDOW_MS,
  PolicyRefusalError,
  reserveStandingAuthorityDecision,
} from '../../src/automation/policy-engine.mjs';
import { digest } from '../../src/cycle/journal.mjs';

function configuredPolicy(overrides = {}) {
  return {
    ...createDefaultOperatorConfiguration(),
    liveMode: true,
    allowedPackIds: ['base-pack'],
    requestedOrders: 1,
    maxBoostersPerCycle: 1,
    maxUnitPriceMicroUsdg: '5000000',
    maxCycleBudgetMicroUsdg: '5000000',
    max24HourBudgetMicroUsdg: '5000000',
    perCycleCapMicroUsdg: '5000000',
    lossCapMicroUsdg: '10000000',
    maxOutstandingCustodyMicroUsdg: '10000000',
    maxCyclesPerDay: 2,
    ...overrides,
  };
}

function policyFixture({
  configuration = configuredPolicy(),
  custody = {},
  now = () => 1_000,
  readCustody: readCustodyOverride = null,
} = {}) {
  let current = configuration;
  const engine = createPolicyEngine({
    now,
    readConfiguration: async () => current,
    readCustody: readCustodyOverride ?? (async () => ({
      realizedLossMicroUsdg: '0',
      atRiskMicroUsdg: '0',
      outstandingMicroUsdg: '0',
      heldAssets: false,
      unattributed: false,
      unvaluedExposure: false,
      ...custody,
    })),
    mutateConfiguration: async mutation => {
      const outcome = await mutation(current);
      current = outcome.configuration;
      return outcome.result;
    },
  });
  return {
    engine,
    readConfiguration: () => current,
    replaceConfiguration: next => { current = next; },
  };
}

test('standing-authority cap reservation delegates one exact decision to the authoritative repository', async () => {
  const decision = {
    schema: 'hookemon.standing-authority-decision.v1',
    authorityDigest: `sha256:${'a'.repeat(64)}`,
    verifiedAt: '2026-06-01T00:00:01.000Z',
    intentDigest: `sha256:${'b'.repeat(64)}`,
    dayCapReservation: {
      day: '2026-06-01',
      reservationKey: `sha256:${'c'.repeat(64)}`,
    },
    nonceReservation: {
      nonce: 'cycle-authority-nonce',
      reservationKey: `sha256:${'d'.repeat(64)}`,
    },
  };
  const calls = [];
  const cycleRepository = {
    async recordStandingAuthorityDecision(cycleId, actualDecision, options) {
      calls.push({ cycleId, actualDecision, options });
      return structuredClone(actualDecision);
    },
  };

  const persisted = await reserveStandingAuthorityDecision({
    cycleRepository,
    cycleId: 'cycle-authority',
    decision,
    maxCyclesPerDay: 4,
  });

  assert.deepEqual(persisted, decision);
  assert.deepEqual(calls, [{
    cycleId: 'cycle-authority',
    actualDecision: decision,
    options: { maxCyclesPerDay: 4 },
  }]);
  await assert.rejects(
    () => reserveStandingAuthorityDecision({ cycleRepository, cycleId: 'cycle-authority', decision, maxCyclesPerDay: 0 }),
    /maxCyclesPerDay/,
  );
});

test('a production claim reserves its atomic amount and a second claim inside the trailing window is refused', async () => {
  const { engine } = policyFixture();
  const first = await engine.admit({
    boundary: 'claim-process',
    cycleId: 'cycle-one',
    releaseAmountMicroUsdg: '5000000',
    packId: 'base-pack',
    liveMode: true,
  });
  assert.equal(first.allowed, true);

  const second = await engine.admit({
    boundary: 'claim-process',
    cycleId: 'cycle-two',
    releaseAmountMicroUsdg: '1',
    packId: 'base-pack',
    liveMode: true,
  });
  assert.deepEqual(second, {
    allowed: false,
    reason: 'ROLLING_24H_CAP',
  });
});

test('a rehearsal cycle applies the policy cap instead of bypassing admission', async () => {
  const { engine } = policyFixture({
    configuration: configuredPolicy({
      liveMode: false,
      maxUnitPriceMicroUsdg: '30',
      perCycleCapMicroUsdg: '30',
      maxCycleBudgetMicroUsdg: '30',
      max24HourBudgetMicroUsdg: '30',
    }),
  });
  const decision = await engine.evaluate({
    boundary: 'cycle-start',
    releaseAmountMicroUsdg: '31',
    liveMode: false,
    mode: 'rehearsal',
  });
  assert.deepEqual(decision, { allowed: false, reason: 'PER_CYCLE_CAP' });
});

test('a rehearsal command cap is enforced by the policy engine below the configured cap', async () => {
  const { engine } = policyFixture({
    configuration: configuredPolicy({
      liveMode: false,
      maxUnitPriceMicroUsdg: '100',
      perCycleCapMicroUsdg: '100',
      maxCycleBudgetMicroUsdg: '100',
      max24HourBudgetMicroUsdg: '100',
    }),
  });
  const decision = await engine.evaluate({
    boundary: 'cycle-start',
    releaseAmountMicroUsdg: '31',
    liveMode: false,
    mode: 'rehearsal',
    capUsdg: '30',
  });
  assert.deepEqual(decision, { allowed: false, reason: 'PER_CYCLE_CAP' });
});

test('a rehearsal claim still requires a configured manual approval', async () => {
  const { engine } = policyFixture({
    configuration: configuredPolicy({
      liveMode: false,
      maxUnitPriceMicroUsdg: '30',
      perCycleCapMicroUsdg: '30',
      maxCycleBudgetMicroUsdg: '30',
      max24HourBudgetMicroUsdg: '30',
      manualApprovalCycles: 1,
    }),
  });
  const decision = await engine.admit({
    boundary: 'claim-process',
    cycleId: 'cycle-rehearsal-approval',
    releaseAmountMicroUsdg: '30',
    packId: 'base-pack',
    liveMode: false,
    mode: 'rehearsal',
  });
  assert.deepEqual(decision, { allowed: false, reason: 'MANUAL_APPROVAL_REQUIRED' });
});

test('a claim admission rechecks custody inside the durable reservation boundary', async () => {
  let reads = 0;
  const { engine } = policyFixture({
    readCustody: async () => {
      reads += 1;
      return {
        realizedLossMicroUsdg: '0',
        atRiskMicroUsdg: '0',
        outstandingMicroUsdg: '0',
        heldAssets: false,
        unattributed: reads > 1,
        unvaluedExposure: false,
      };
    },
  });

  const decision = await engine.admit({
    boundary: 'claim-process',
    cycleId: 'cycle-custody-race',
    releaseAmountMicroUsdg: '5000000',
    packId: 'base-pack',
    liveMode: true,
  });

  assert.deepEqual(decision, { allowed: false, reason: 'UNATTRIBUTED_CUSTODY' });
  assert.equal(reads, 2);
});

test('a new production claim is refused after the configured daily cycle count is exhausted', async () => {
  const { engine } = policyFixture({
    configuration: configuredPolicy({
      maxCyclesPerDay: 1,
      max24HourBudgetMicroUsdg: '10000000',
      lossCapMicroUsdg: '20000000',
      maxOutstandingCustodyMicroUsdg: '20000000',
    }),
  });

  const first = await engine.admit({
    boundary: 'claim-process',
    cycleId: 'cycle-daily-first',
    releaseAmountMicroUsdg: '5000000',
    packId: 'base-pack',
    liveMode: true,
  });
  assert.equal(first.allowed, true);

  const second = await engine.admit({
    boundary: 'claim-process',
    cycleId: 'cycle-daily-second',
    releaseAmountMicroUsdg: '5000000',
    packId: 'base-pack',
    liveMode: true,
  });
  assert.deepEqual(second, { allowed: false, reason: 'MAX_CYCLES_PER_DAY' });
});

test('a purchase may consume less than its previously reserved cycle cap', async () => {
  const { engine } = policyFixture();
  const admission = await engine.admit({
    boundary: 'claim-process',
    cycleId: 'cycle-partial-purchase',
    releaseAmountMicroUsdg: '5000000',
    packId: 'base-pack',
    liveMode: true,
  });
  assert.equal(admission.allowed, true);

  const purchase = await engine.evaluatePurchase({
    boundary: 'purchase',
    cycleId: 'cycle-partial-purchase',
    releaseAmountMicroUsdg: '4000000',
    packId: 'base-pack',
    liveMode: true,
  });

  assert.deepEqual(purchase, { allowed: true, cycleDigest: admission.cycleDigest });
});

test('execution controls refuse a new cycle and an immediately preceding signature check', async () => {
  for (const [field, reason] of [
    ['executionPaused', 'EXECUTION_PAUSED'],
    ['killSwitch', 'KILL_SWITCH'],
  ]) {
    const { engine } = policyFixture({ configuration: configuredPolicy({ [field]: true }) });
    const start = await engine.evaluate({
      boundary: 'cycle-start',
      cycleId: 'cycle-execution-control',
      releaseAmountMicroUsdg: '1',
      packId: 'base-pack',
      liveMode: true,
    });
    assert.deepEqual(start, { allowed: false, reason });
    await assert.rejects(
      () => engine.assertExecutionAllowed({ boundary: 'signature', liveMode: true }),
      error => error instanceof PolicyRefusalError && error.reason === reason,
    );
  }
});

test('a pre-claim mutation guard does not require a reservation that claim admission has not created', async () => {
  const { engine } = policyFixture();

  const decision = await engine.assertExecutionAllowed({
    boundary: 'mutation',
    cycleId: 'cycle-pre-claim-mutation',
    releaseAmountMicroUsdg: '5000000',
    packId: 'base-pack',
    stage: 'eligibility-snapshot',
    liveMode: true,
  });

  assert.deepEqual(decision, { allowed: true });

  await assert.rejects(
    () => engine.assertExecutionAllowed({
      boundary: 'mutation',
      cycleId: 'cycle-unadmitted-later-mutation',
      releaseAmountMicroUsdg: '5000000',
      packId: 'base-pack',
      stage: 'open',
      liveMode: true,
    }),
    error => error instanceof PolicyRefusalError && error.reason === 'CYCLE_POLICY_MISSING',
  );
});

test('a claim-stage mutation guard requires the admission reservation to persist first', async () => {
  const { engine } = policyFixture();

  await assert.rejects(
    () => engine.assertExecutionAllowed({
      boundary: 'mutation',
      cycleId: 'cycle-unadmitted-claim-mutation',
      releaseAmountMicroUsdg: '5000000',
      packId: 'base-pack',
      stage: 'claim-process',
      liveMode: true,
    }),
    error => error instanceof PolicyRefusalError && error.reason === 'CYCLE_POLICY_MISSING',
  );
});

test('claim admission fails closed for the pack allowlist and all custody loss controls', async () => {
  const scenarios = [
    [{}, { packId: 'other-pack' }, 'PACK_NOT_ALLOWED'],
    [{ pendingEpicDecisions: [{ cycleId: 'held-cycle', cycleDigest: `sha256:${'1'.repeat(64)}`, heldAtMs: 1 }] }, {}, 'HELD_CUSTODY'],
    [{}, { custody: { heldAssets: true } }, 'HELD_CUSTODY'],
    [{}, { custody: { unattributed: true } }, 'UNATTRIBUTED_CUSTODY'],
    [{}, { custody: { unvaluedExposure: true } }, 'UNVALUED_CUSTODY'],
    [{ lossCapMicroUsdg: '5000000' }, { custody: { atRiskMicroUsdg: '1' } }, 'LOSS_CAP'],
    [{ maxOutstandingCustodyMicroUsdg: '5000000' }, { custody: { outstandingMicroUsdg: '1' } }, 'OUTSTANDING_CUSTODY_CAP'],
  ];

  for (const [configurationOverrides, inputOverrides, reason] of scenarios) {
    const { engine } = policyFixture({
      configuration: configuredPolicy(configurationOverrides),
      custody: inputOverrides.custody,
    });
    const decision = await engine.admit({
      boundary: 'claim-process',
      cycleId: `cycle-${reason.toLowerCase()}`,
      releaseAmountMicroUsdg: '5000000',
      packId: inputOverrides.packId ?? 'base-pack',
      liveMode: true,
    });
    assert.deepEqual(decision, { allowed: false, reason });
  }
});

test('the first production cycle needs an approval bound to its exact policy digest', async () => {
  const configuration = configuredPolicy({ manualApprovalCycles: 1 });
  const { engine } = policyFixture({ configuration });
  const request = {
    boundary: 'claim-process',
    cycleId: 'cycle-manual-approval',
    releaseAmountMicroUsdg: '5000000',
    packId: 'base-pack',
    liveMode: true,
  };

  assert.deepEqual(await engine.admit(request), { allowed: false, reason: 'MANUAL_APPROVAL_REQUIRED' });
  const cycleDigest = deriveCyclePolicyDigest({ configuration, ...request });
  await engine.recordManualApproval({ cycleDigest, cycleId: request.cycleId, approvedAtMs: 1_000 });
  const admitted = await engine.admit(request);
  assert.equal(admitted.allowed, true);
  assert.equal(admitted.cycleDigest, cycleDigest);
});

test('claim admission rejects configuration values above the fixed operator ceilings', async () => {
  const { engine } = policyFixture({
    configuration: configuredPolicy({
      maxUnitPriceMicroUsdg: '25000001',
      maxCycleBudgetMicroUsdg: '50000001',
      max24HourBudgetMicroUsdg: '3600000001',
      perCycleCapMicroUsdg: '50000001',
    }),
  });

  await assert.rejects(
    engine.admit({
      boundary: 'claim-process',
      cycleId: 'cycle-over-hard-cap',
      releaseAmountMicroUsdg: '1',
      packId: 'base-pack',
      liveMode: true,
    }),
    /fixed hard cap/i,
  );
});

test('an existing production cycle without its matching durable spend reservation cannot proceed', async () => {
  const cycleId = 'cycle-missing-reservation';
  const releaseAmountMicroUsdg = '5000000';
  const base = configuredPolicy();
  const cycleDigest = deriveCyclePolicyDigest({
    configuration: base,
    cycleId,
    releaseAmountMicroUsdg,
    packId: 'base-pack',
    liveMode: true,
  });
  const configuration = {
    ...base,
    cycleLedger: [{ cycleId, cycleDigest, mode: 'production', openedAtMs: 1_000, releaseAmountMicroUsdg }],
    spendLedger: [],
  };
  const { engine } = policyFixture({ configuration });
  assert.deepEqual(await engine.admit({
    boundary: 'claim-process',
    cycleId,
    releaseAmountMicroUsdg,
    packId: 'base-pack',
    liveMode: true,
  }), { allowed: false, reason: 'SPEND_RESERVATION_MISSING' });
});

test('a reservation expires at the end of the off-chain policy window and remains pending custody before then', async () => {
  let timestamp = 1_000;
  let custody = {
    realizedLossMicroUsdg: '0',
    atRiskMicroUsdg: '0',
    outstandingMicroUsdg: '0',
    heldAssets: false,
    unattributed: false,
    unvaluedExposure: false,
  };
  const { engine } = policyFixture({
    now: () => timestamp,
    readCustody: async () => custody,
    configuration: configuredPolicy({
      max24HourBudgetMicroUsdg: '5',
      maxCycleBudgetMicroUsdg: '5',
      perCycleCapMicroUsdg: '5',
      maxUnitPriceMicroUsdg: '5',
      lossCapMicroUsdg: '5',
      maxOutstandingCustodyMicroUsdg: '5',
    }),
  });
  const request = {
    boundary: 'claim-process',
    cycleId: 'cycle-expiring-reservation',
    releaseAmountMicroUsdg: '5',
    packId: 'base-pack',
    liveMode: true,
  };

  assert.equal((await engine.admit(request)).allowed, true);

  timestamp += 1;
  custody = { ...custody, atRiskMicroUsdg: '6', outstandingMicroUsdg: '6' };
  assert.deepEqual(await engine.admit(request), { allowed: false, reason: 'LOSS_CAP' });

  timestamp = 1_000 + POLICY_WINDOW_MS;
  custody = { ...custody, atRiskMicroUsdg: '0', outstandingMicroUsdg: '0' };
  assert.deepEqual(await engine.admit(request), { allowed: false, reason: 'SPEND_RESERVATION_EXPIRED' });
});

test('an expired retry is refused before a different full-cap claim enters the next policy window', async () => {
  let timestamp = 1_000;
  const { engine } = policyFixture({
    now: () => timestamp,
    configuration: configuredPolicy({
      maxCyclesPerDay: 1,
      max24HourBudgetMicroUsdg: '5',
      maxCycleBudgetMicroUsdg: '5',
      perCycleCapMicroUsdg: '5',
      maxUnitPriceMicroUsdg: '5',
    }),
  });
  const first = {
    boundary: 'claim-process',
    cycleId: 'cycle-expired-before-replacement',
    releaseAmountMicroUsdg: '5',
    packId: 'base-pack',
    liveMode: true,
  };

  assert.equal((await engine.admit(first)).allowed, true);
  timestamp += POLICY_WINDOW_MS;
  assert.deepEqual(await engine.admit(first), { allowed: false, reason: 'SPEND_RESERVATION_EXPIRED' });

  const replacement = await engine.admit({ ...first, cycleId: 'cycle-next-window-full-cap' });
  assert.equal(replacement.allowed, true);
});

test('a cycle-bound signature guard rereads the current allowlist before signing', async () => {
  const { engine, readConfiguration, replaceConfiguration } = policyFixture();
  const request = {
    boundary: 'claim-process',
    cycleId: 'cycle-signature-guard',
    releaseAmountMicroUsdg: '5000000',
    packId: 'base-pack',
    liveMode: true,
  };
  assert.equal((await engine.admit(request)).allowed, true);
  const configuration = readConfiguration();
  replaceConfiguration({
    ...configuration,
    allowedPackIds: [],
    configurationRevision: configuration.configurationRevision + 1,
  });

  await assert.rejects(
    () => engine.assertExecutionAllowed({
      boundary: 'signature',
      cycleId: request.cycleId,
      releaseAmountMicroUsdg: request.releaseAmountMicroUsdg,
      packId: request.packId,
      requestDigest: `sha256:${'a'.repeat(64)}`,
      liveMode: true,
    }),
    error => error instanceof PolicyRefusalError && error.reason === 'PACK_NOT_ALLOWED',
  );
});

test('a cycle-bound broadcast guard rereads loss and custody caps before broadcast', async () => {
  let custody = {
    realizedLossMicroUsdg: '0',
    atRiskMicroUsdg: '0',
    outstandingMicroUsdg: '0',
    heldAssets: false,
    unattributed: false,
    unvaluedExposure: false,
  };
  const { engine } = policyFixture({
    readCustody: async () => custody,
    configuration: configuredPolicy({
      max24HourBudgetMicroUsdg: '5',
      maxCycleBudgetMicroUsdg: '5',
      perCycleCapMicroUsdg: '5',
      maxUnitPriceMicroUsdg: '5',
      lossCapMicroUsdg: '5',
      maxOutstandingCustodyMicroUsdg: '5',
    }),
  });
  const request = {
    boundary: 'claim-process',
    cycleId: 'cycle-broadcast-cap-guard',
    releaseAmountMicroUsdg: '5',
    packId: 'base-pack',
    liveMode: true,
  };
  assert.equal((await engine.admit(request)).allowed, true);
  custody = { ...custody, atRiskMicroUsdg: '6', outstandingMicroUsdg: '6' };

  await assert.rejects(
    () => engine.assertExecutionAllowed({
      boundary: 'broadcast',
      cycleId: request.cycleId,
      releaseAmountMicroUsdg: request.releaseAmountMicroUsdg,
      packId: request.packId,
      requestDigest: `sha256:${'b'.repeat(64)}`,
      liveMode: true,
    }),
    error => error instanceof PolicyRefusalError && error.reason === 'LOSS_CAP',
  );
});

test('a later-stage execution guard does not count an already observed claim as pending again', async () => {
  let timestamp = 1_000;
  let custody = {
    realizedLossMicroUsdg: '0',
    atRiskMicroUsdg: '0',
    outstandingMicroUsdg: '0',
    heldAssets: false,
    unattributed: false,
    unvaluedExposure: false,
  };
  const { engine } = policyFixture({
    now: () => timestamp,
    readCustody: async () => custody,
    configuration: configuredPolicy({
      max24HourBudgetMicroUsdg: '5',
      maxCycleBudgetMicroUsdg: '5',
      perCycleCapMicroUsdg: '5',
      maxUnitPriceMicroUsdg: '5',
      lossCapMicroUsdg: '5',
      maxOutstandingCustodyMicroUsdg: '5',
    }),
  });
  const request = {
    boundary: 'claim-process',
    cycleId: 'cycle-later-stage-guard',
    releaseAmountMicroUsdg: '5',
    packId: 'base-pack',
    liveMode: true,
  };
  assert.equal((await engine.admit(request)).allowed, true);
  custody = { ...custody, atRiskMicroUsdg: '5', outstandingMicroUsdg: '5' };
  const guard = () => engine.assertExecutionAllowed({
    boundary: 'signature',
    stage: 'outbound',
    cycleId: request.cycleId,
    releaseAmountMicroUsdg: request.releaseAmountMicroUsdg,
    packId: request.packId,
    requestDigest: `sha256:${'c'.repeat(64)}`,
    liveMode: true,
  });

  assert.equal((await guard()).allowed, true);
  timestamp += POLICY_WINDOW_MS;
  assert.equal((await guard()).allowed, true);
});

test('a pause and resume revision does not invalidate an admitted cycle policy digest', async () => {
  const { engine, readConfiguration, replaceConfiguration } = policyFixture();
  const request = {
    boundary: 'claim-process',
    cycleId: 'cycle-pause-resume',
    releaseAmountMicroUsdg: '5000000',
    packId: 'base-pack',
    liveMode: true,
  };
  const admission = await engine.admit(request);
  assert.equal(admission.allowed, true);

  const paused = readConfiguration();
  replaceConfiguration({ ...paused, paused: true, configurationRevision: paused.configurationRevision + 1 });
  const resumed = readConfiguration();
  replaceConfiguration({ ...resumed, paused: false, configurationRevision: resumed.configurationRevision + 1 });

  assert.deepEqual(await engine.evaluatePurchase({ ...request, boundary: 'purchase' }), {
    allowed: true,
    cycleDigest: admission.cycleDigest,
  });
});

test('a legacy policy digest remains valid when only its generic revision changed', async () => {
  const cycleId = 'cycle-legacy-pause-resume';
  const releaseAmountMicroUsdg = '5000000';
  const base = configuredPolicy();
  const cycleDigest = digest({
    schema: 'hookemon.policy-cycle.v1',
    cycleId,
    releaseAmountMicroUsdg,
    packId: 'base-pack',
    mode: 'production',
    policy: {
      configurationRevision: 0,
      allowedPackIds: [...base.allowedPackIds],
      requestedOrders: base.requestedOrders,
      maxBoostersPerCycle: base.maxBoostersPerCycle,
      maxUnitPriceMicroUsdg: base.maxUnitPriceMicroUsdg,
      perCycleCapMicroUsdg: base.perCycleCapMicroUsdg,
      max24HourBudgetMicroUsdg: base.max24HourBudgetMicroUsdg,
      maxCyclesPerDay: base.maxCyclesPerDay,
      lossCapMicroUsdg: base.lossCapMicroUsdg,
      maxOutstandingCustodyMicroUsdg: base.maxOutstandingCustodyMicroUsdg,
      manualApprovalCycles: base.manualApprovalCycles,
    },
  });
  const { engine } = policyFixture({
    configuration: {
      ...base,
      configurationRevision: 2,
      cycleLedger: [{ cycleId, cycleDigest, mode: 'production', openedAtMs: 1_000, releaseAmountMicroUsdg }],
      spendLedger: [{ cycleId, cycleDigest, amountMicroUsdg: releaseAmountMicroUsdg, reservedAtMs: 1_000 }],
    },
  });

  assert.deepEqual(await engine.evaluatePurchase({
    boundary: 'purchase',
    cycleId,
    releaseAmountMicroUsdg,
    packId: 'base-pack',
    liveMode: true,
  }), { allowed: true, cycleDigest });
});

test('a timestamp-less manual approval retry returns the stored approval', async () => {
  let timestamp = 1_000;
  const { engine } = policyFixture({ now: () => timestamp });
  const cycleDigest = `sha256:${'a'.repeat(64)}`;

  const initial = await engine.recordManualApproval({ cycleDigest, cycleId: 'cycle-approval-retry' });
  timestamp += 1;
  const retried = await engine.recordManualApproval({ cycleDigest, cycleId: 'cycle-approval-retry' });

  assert.deepEqual(retried, initial);
});

test('manual approval forwards its caller revision into the configuration mutation', async () => {
  const calls = [];
  const configuration = configuredPolicy();
  const engine = createPolicyEngine({
    readConfiguration: async () => configuration,
    readCustody: async () => ({
      realizedLossMicroUsdg: '0',
      atRiskMicroUsdg: '0',
      outstandingMicroUsdg: '0',
      heldAssets: false,
      unattributed: false,
      unvaluedExposure: false,
    }),
    mutateConfiguration: async (mutation, options) => {
      calls.push(options);
      const outcome = await mutation(configuration);
      return outcome.result;
    },
  });

  await engine.recordManualApproval({
    cycleDigest: `sha256:${'b'.repeat(64)}`,
    cycleId: 'cycle-atomic-approval',
    expectedRevision: 17,
  });

  assert.deepEqual(calls, [{ expectedRevision: 17 }]);
});
