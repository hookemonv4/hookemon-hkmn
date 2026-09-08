import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { createDefaultOperatorConfiguration } from '../../src/config/state-schema.mjs';
import { MAXIMUM_PACK_BATCH_SIZE } from '../../src/cycle/money-schemas.mjs';
import {
  assertCollectorOnlyRehearsalPolicy,
  assertPolicyAdmission,
  decodeHistoricalPolicyAdmission,
  createPolicyEngine,
  deriveCyclePolicyDigest as rawDeriveCyclePolicyDigest,
  POLICY_WINDOW_MS,
  PolicyRefusalError,
  reserveStandingAuthorityDecision,
} from '../../src/automation/policy-engine.mjs';
import { digest } from '../../src/cycle/journal.mjs';

const fixtureValuations = new WeakSet();
function valuationFixture(amount, quote, cost = amount.amountAtomic) {
  const value = { schema: 'hookemon.quote-usd-valuation.v1', quoteDigest: quote.quoteDigest,
    requestDigest: digest({ fixtureRequest: quote.requestId }), quoteRequestId: quote.requestId,
    sourcePath: 'details.currencyIn.amountUsd', amount, amountMicroUsd: cost, rounding: 'up',
    observedAtMs: 0, validUntilMs: quote.deadlineUnixSeconds * 1000 };
  fixtureValuations.add(value);
  return value;
}
function nativeFixtureRequest(input, configuration) {
  if (!input || !input.cycleId || !input.packId || !input.releaseCostMicroUsd) return input;
  const admission = input.admission ?? exactOutputAdmission({ cycleId: input.cycleId,
    quantity: Math.max(1, configuration.requestedOrders), unitFunding: input.releaseCostMicroUsd,
    unitPurchase: input.releaseCostMicroUsd, aggregateFunding: input.releaseCostMicroUsd,
    deadlineUnixSeconds: 1_000_000_000 });
  if (input.admission === undefined) admission.packId = input.packId;
  return { ...input, admission, releaseAmountWei: input.releaseAmountWei ?? admission.aggregateFundingQuote.amountAtomic };
}
function deriveCyclePolicyDigest(input) {
  return rawDeriveCyclePolicyDigest(nativeFixtureRequest(input, input.configuration));
}

function configuredPolicy(overrides = {}) {
  return {
    ...createDefaultOperatorConfiguration(),
    liveMode: true,
    allowedPackIds: ['base-pack'],
    requestedOrders: 1,
    maxBoostersPerCycle: 1,
    maxUnitPriceMicroUsd: '5000000',
    maxCycleBudgetMicroUsd: '5000000',
    max24HourBudgetMicroUsd: '5000000',
    perCycleCapMicroUsd: '5000000',
    lossCapMicroUsd: '10000000',
    maxOutstandingCustodyMicroUsd: '10000000',
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
  if (configuration) configuration = { ...configuration, cycleLedger: configuration.cycleLedger.map(entry => ({ ...entry, releaseAmountWei: entry.releaseAmountWei ?? entry.releaseCostMicroUsd })) };
  let current = configuration;
  const underlying = createPolicyEngine({
    verifyQuoteUsdValuation: value => fixtureValuations.has(value),
    now,
    readConfiguration: async () => current,
    readCustody: readCustodyOverride === null ? (async () => ({
      realizedLossMicroUsd: '0',
      atRiskMicroUsd: '0',
      outstandingMicroUsd: '0',
      heldAssets: false,
      heldPositions: { count: 0, valueMicroUsd: '0', positions: [] },
      unattributed: false,
      unvaluedExposure: false,
      cycleExposureMicroUsd: new Proxy({}, { get: () => '0' }),
      ...custody,
    })) : async () => ({ cycleExposureMicroUsd: new Proxy({}, { get: () => '0' }), ...await readCustodyOverride() }),
    mutateConfiguration: async mutation => {
      const outcome = await mutation(current);
      current = outcome.configuration;
      return outcome.result;
    },
  });
  return {
    rawEngine: underlying,
    engine: new Proxy({ ...underlying }, { get(target, key) {
      if (typeof target[key] !== 'function' || key === 'recordManualApproval') return target[key];
      return input => target[key](nativeFixtureRequest(input, current));
    } }),
    readConfiguration: () => current,
    replaceConfiguration: next => { current = next; },
  };
}

test('collector-only live rehearsal policy binds one approved pack, one booster, and one manual approval', () => {
  const configuration = configuredPolicy({
    allowedPackIds: ['collector-25'],
    requestedOrders: 1,
    maxBoostersPerCycle: 1,
    maxUnitPriceMicroUsd: '25000000',
    maxCycleBudgetMicroUsd: '25000000',
    max24HourBudgetMicroUsd: '25000000',
    perCycleCapMicroUsd: '25000000',
    maxCyclesPerDay: 1,
    manualApprovalCycles: 1,
  });

  assert.deepEqual(
    assertCollectorOnlyRehearsalPolicy(configuration, {
      packCode: 'collector-25',
      packPriceAtomic: '25000000', packCostMicroUsd: '25000000',
    }),
    configuration,
  );
  assert.throws(
    () => assertCollectorOnlyRehearsalPolicy({ ...configuration, maxBoostersPerCycle: 2 }, {
      packCode: 'collector-25',
      packPriceAtomic: '25000000', packCostMicroUsd: '25000000',
    }),
    /maxBoostersPerCycle must equal 1/,
  );
  assert.throws(
    () => assertCollectorOnlyRehearsalPolicy({ ...configuration, allowedPackIds: ['another-pack'] }, {
      packCode: 'collector-25',
      packPriceAtomic: '25000000', packCostMicroUsd: '25000000',
    }),
    /allow exactly the selected pack/,
  );
});

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
    releaseCostMicroUsd: '5000000',
    packId: 'base-pack',
    liveMode: true,
  });
  assert.equal(first.allowed, true);

  const second = await engine.admit({
    boundary: 'claim-process',
    cycleId: 'cycle-two',
    releaseCostMicroUsd: '1',
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
      maxUnitPriceMicroUsd: '30',
      perCycleCapMicroUsd: '30',
      maxCycleBudgetMicroUsd: '30',
      max24HourBudgetMicroUsd: '30',
    }),
  });
  const decision = await engine.evaluate({
    boundary: 'cycle-start',
    releaseCostMicroUsd: '31',
    liveMode: false,
    mode: 'rehearsal',
  });
  assert.deepEqual(decision, { allowed: false, reason: 'PER_CYCLE_CAP' });
});

test('a rehearsal command cap is enforced by the policy engine below the configured cap', async () => {
  const { engine } = policyFixture({
    configuration: configuredPolicy({
      liveMode: false,
      maxUnitPriceMicroUsd: '100',
      perCycleCapMicroUsd: '100',
      maxCycleBudgetMicroUsd: '100',
      max24HourBudgetMicroUsd: '100',
    }),
  });
  const decision = await engine.evaluate({
    boundary: 'cycle-start',
    releaseCostMicroUsd: '31',
    liveMode: false,
    mode: 'rehearsal',
    capMicroUsd: '30',
  });
  assert.deepEqual(decision, { allowed: false, reason: 'PER_CYCLE_CAP' });
});

test('a rehearsal claim still requires a configured manual approval', async () => {
  const { engine } = policyFixture({
    configuration: configuredPolicy({
      liveMode: false,
      maxUnitPriceMicroUsd: '30',
      perCycleCapMicroUsd: '30',
      maxCycleBudgetMicroUsd: '30',
      max24HourBudgetMicroUsd: '30',
      manualApprovalCycles: 1,
    }),
  });
  const decision = await engine.admit({
    boundary: 'claim-process',
    cycleId: 'cycle-rehearsal-approval',
    releaseCostMicroUsd: '30',
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
        realizedLossMicroUsd: '0',
        atRiskMicroUsd: '0',
        outstandingMicroUsd: '0',
        heldAssets: false,
        heldPositions: { count: 0, valueMicroUsd: '0', positions: [] },
        unattributed: reads > 1,
        unvaluedExposure: false,
      cycleExposureMicroUsd: new Proxy({}, { get: () => '0' }),
      };
    },
  });

  const decision = await engine.admit({
    boundary: 'claim-process',
    cycleId: 'cycle-custody-race',
    releaseCostMicroUsd: '5000000',
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
      max24HourBudgetMicroUsd: '10000000',
      lossCapMicroUsd: '20000000',
      maxOutstandingCustodyMicroUsd: '20000000',
    }),
  });

  const first = await engine.admit({
    boundary: 'claim-process',
    cycleId: 'cycle-daily-first',
    releaseCostMicroUsd: '5000000',
    packId: 'base-pack',
    liveMode: true,
  });
  assert.equal(first.allowed, true);

  const second = await engine.admit({
    boundary: 'claim-process',
    cycleId: 'cycle-daily-second',
    releaseCostMicroUsd: '5000000',
    packId: 'base-pack',
    liveMode: true,
  });
  assert.deepEqual(second, { allowed: false, reason: 'MAX_CYCLES_PER_DAY' });
});

test('a purchase retains its admitted aggregate cost basis', async () => {
  const { engine } = policyFixture();
  const admission = await engine.admit({
    boundary: 'claim-process',
    cycleId: 'cycle-partial-purchase',
    releaseCostMicroUsd: '5000000',
    packId: 'base-pack',
    liveMode: true,
  });
  assert.equal(admission.allowed, true);

  const purchase = await engine.evaluatePurchase({
    boundary: 'purchase',
    cycleId: 'cycle-partial-purchase',
    releaseCostMicroUsd: '5000000',
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
      releaseCostMicroUsd: '1',
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
    releaseCostMicroUsd: '5000000',
    packId: 'base-pack',
    stage: 'eligibility-snapshot',
    liveMode: true,
  });

  assert.deepEqual(decision, { allowed: true });

  await assert.rejects(
    () => engine.assertExecutionAllowed({
      boundary: 'mutation',
      cycleId: 'cycle-unadmitted-later-mutation',
      releaseCostMicroUsd: '5000000',
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
      releaseCostMicroUsd: '5000000',
      packId: 'base-pack',
      stage: 'claim-process',
      liveMode: true,
    }),
    error => error instanceof PolicyRefusalError && error.reason === 'CYCLE_POLICY_MISSING',
  );
});

test('claim admission keeps legacy held state and pending decisions nonblocking', async () => {
  const { engine } = policyFixture({
    configuration: configuredPolicy({
      maxHeldPositions: 2,
      maxHeldValueMicroUsd: '5',
      pendingEpicDecisions: [{
        cycleId: 'cycle-prior-held-decision',
        cycleDigest: `sha256:${'d'.repeat(64)}`,
        heldAtMs: 1,
      }],
    }),
    custody: {
      heldAssets: true,
      heldPositions: { count: 1, valueMicroUsd: '5', positions: [{ costMicroUsd: '5' }] },
    },
  });

  const decision = await engine.admit({
    boundary: 'claim-process',
    cycleId: 'cycle-held-position-under-limit',
    releaseCostMicroUsd: '5000000',
    packId: 'base-pack',
    liveMode: true,
  });

  assert.equal(decision.allowed, true);
});

test('claim admission refuses at the held-position count or value limit', async () => {
  for (const [configuration, custody] of [
    [
      configuredPolicy({ maxHeldPositions: 1, maxHeldValueMicroUsd: '100' }),
      { heldPositions: { count: 1, valueMicroUsd: '0', positions: [{ costMicroUsd: '0' }] } },
    ],
    [
      configuredPolicy({ maxHeldPositions: 2, maxHeldValueMicroUsd: '5' }),
      { heldPositions: { count: 1, valueMicroUsd: '6', positions: [{ costMicroUsd: '6' }] } },
    ],
  ]) {
    const { engine } = policyFixture({ configuration, custody });
    assert.deepEqual(await engine.admit({
      boundary: 'claim-process',
      cycleId: `cycle-held-limit-${custody.heldPositions.count}-${custody.heldPositions.valueMicroUsd}`,
      releaseCostMicroUsd: '5000000',
      packId: 'base-pack',
      liveMode: true,
    }), { allowed: false, reason: 'HELD_LIMIT' });
  }
});

test('claim admission rejects a held-position projection whose count understates its positions', async () => {
  const { engine } = policyFixture({
    configuration: configuredPolicy({ maxHeldPositions: 1, maxHeldValueMicroUsd: '5' }),
    custody: {
      heldPositions: {
        count: 0,
        valueMicroUsd: '0',
        positions: [{ costMicroUsd: '6' }],
      },
    },
  });

  await assert.rejects(
    engine.admit({
      boundary: 'claim-process',
      cycleId: 'cycle-inconsistent-held-positions',
      releaseCostMicroUsd: '5000000',
      packId: 'base-pack',
      liveMode: true,
    }),
    /heldPositions count/i,
  );
});

test('claim admission rejects a held-position projection whose value understates its positions', async () => {
  const { engine } = policyFixture({
    configuration: configuredPolicy({ maxHeldPositions: 2, maxHeldValueMicroUsd: '5' }),
    custody: {
      heldPositions: {
        count: 1,
        valueMicroUsd: '0',
        positions: [{ costMicroUsd: '6' }],
      },
    },
  });

  await assert.rejects(
    engine.admit({
      boundary: 'claim-process',
      cycleId: 'cycle-inconsistent-held-value',
      releaseCostMicroUsd: '5000000',
      packId: 'base-pack',
      liveMode: true,
    }),
    /heldPositions value/i,
  );
});

test('claim admission fails closed for the pack allowlist and custody loss controls', async () => {
  const scenarios = [
    [{}, { packId: 'other-pack' }, 'PACK_NOT_ALLOWED'],
    [{}, { custody: { unattributed: true } }, 'UNATTRIBUTED_CUSTODY'],
    [{}, { custody: { unvaluedExposure: true } }, 'UNVALUED_CUSTODY'],
    [{ lossCapMicroUsd: '5000000' }, { custody: { atRiskMicroUsd: '1' } }, 'LOSS_CAP'],
    [{ maxOutstandingCustodyMicroUsd: '5000000' }, { custody: { outstandingMicroUsd: '1' } }, 'OUTSTANDING_CUSTODY_CAP'],
  ];

  for (const [configurationOverrides, inputOverrides, reason] of scenarios) {
    const { engine } = policyFixture({
      configuration: configuredPolicy(configurationOverrides),
      custody: inputOverrides.custody,
    });
    const decision = await engine.admit({
      boundary: 'claim-process',
      cycleId: `cycle-${reason.toLowerCase()}`,
      releaseCostMicroUsd: '5000000',
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
    releaseCostMicroUsd: '5000000',
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
      maxUnitPriceMicroUsd: '55000001',
      maxCycleBudgetMicroUsd: '165000001',
      max24HourBudgetMicroUsd: '495000001',
      perCycleCapMicroUsd: '165000001',
    }),
  });

  await assert.rejects(
    engine.admit({
      boundary: 'claim-process',
      cycleId: 'cycle-over-hard-cap',
      releaseCostMicroUsd: '1',
      packId: 'base-pack',
      liveMode: true,
    }),
    /fixed hard cap/i,
  );
});

// Synthetic native-policy valuation fixture; no live ETH/USD or USDC/USD rate is implied.
const SYNTHETIC_N2_COST_MICRO_USD = '50309869';

function parsedUnitRelayQuote({ cycleId, unitFunding, unitPurchase, deadlineUnixSeconds, requestId: overrideRequestId, orderId: overrideOrderId }) {
  const sender = '0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384';
  const recipient = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';
  const origin = {
    chainId: 4663, address: '0x0000000000000000000000000000000000000000', decimals: 18, amount: unitFunding,
  };
  const destination = {
    chainId: 792703809, address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6,
    amount: unitPurchase, minimumAmount: unitPurchase,
  };
  const requestId = overrideRequestId ?? `relay-unit-${cycleId}`;
  const orderId = overrideOrderId ?? `0x${'1'.repeat(64)}`;
  const raw = {
    requestId,
    details: {
      sender,
      recipient,
      currencyIn: { currency: { chainId: origin.chainId, address: origin.address, decimals: origin.decimals }, amount: origin.amount },
      currencyOut: { currency: { chainId: destination.chainId, address: destination.address, decimals: destination.decimals }, amount: destination.amount, minimumAmount: destination.minimumAmount },
    },
    protocol: { v2: { orderId, orderData: {
      inputs: [{ payment: { chainId: 'robinhood', currency: origin.address, amount: origin.amount } }],
      output: { chainId: 'solana', deadline: deadlineUnixSeconds, calls: [], payments: [{ recipient, currency: destination.address, expectedAmount: destination.amount, minimumAmount: destination.minimumAmount }] },
    } } },
    steps: [],
  };
  const quote = {
    direction: 'OUTBOUND', tradeType: 'EXACT_OUTPUT', requestId, orderId, sender, recipient,
    deadlineUnixSeconds, origin, destination, stepCount: raw.steps.length, raw,
  };
  return {
    ...quote,
    quoteDigest: digest({
      schema: 'hookemon.relay-quote.v1', direction: quote.direction, tradeType: quote.tradeType,
      requestId: quote.requestId, orderId: quote.orderId, sender: quote.sender, recipient: quote.recipient,
      deadlineUnixSeconds: quote.deadlineUnixSeconds, origin: quote.origin, destination: quote.destination, raw: quote.raw,
    }),
  };
}

// Same sha256-of-the-plain-cycleId formula as `deriveOnchainCycleId` in
// packages/adapters/src/app/stages/action-builder.mjs, duplicated to keep this package boundary
// clean; the policy engine's own evidence normalizer computes it the same way.
function onchainCycleIdFor(cycleId) {
  return `0x${createHash('sha256').update(cycleId, 'utf8').digest('hex')}`;
}

const PRODUCTION_HOOK = `0x${'7'.repeat(40)}`;

/** A finalized hook process-liability evidence record covering exactly `ceilingAtomic`. */
function processLiabilityEvidenceFixture({ cycleId, ceilingAtomic }) {
  return {
    schema: 'hookemon.process-liability-evidence.v2',
    chainId: '4663',
    assetId: 'native',
    decimals: 18,
    hook: PRODUCTION_HOOK,
    cycleId,
    onchainCycleId: onchainCycleIdFor(cycleId),
    blockNumber: '12345',
    blockHash: `0x${'3'.repeat(64)}`,
    finalized: true,
    processLiability: ceilingAtomic,
    remainingProcessClaimCapacity: ceilingAtomic,
    processClaimsPaused: false,
    processClaimCycleUsed: false,
    activeProcessClaimLimit: ceilingAtomic,
    totalLiability: ceilingAtomic,
    hookNativeBalance: ceilingAtomic,
    isSolvent: true,
    operations: '0xb54aaf746eb1e80afdb5eb0992a75b08db2e4384',
    ceilingAtomic,
  };
}

function exactOutputAdmission({
  cycleId, quantity = 2, unitPurchase = '25000000', unitFunding = '25000000',
  aggregateFunding = quantity === 1 ? unitFunding : SYNTHETIC_N2_COST_MICRO_USD, deadlineUnixSeconds = 1_000_000,
} = {}) {
  const aggregatePurchase = (BigInt(unitPurchase) * BigInt(quantity)).toString();
  const unitRelayQuote = parsedUnitRelayQuote({ cycleId, unitFunding, unitPurchase, deadlineUnixSeconds });
  // The aggregate quote is the one restart and outbound execute, so it now carries the same parsed
  // and raw evidence as the unit quote and its digest is recomputed from that evidence too.
  const relayQuote = parsedUnitRelayQuote({
    cycleId,
    unitFunding: aggregateFunding,
    unitPurchase: aggregatePurchase,
    deadlineUnixSeconds,
    requestId: 'relay-n2',
    orderId: `0x${'2'.repeat(64)}`,
  });
  return {
    schema: 'hookemon.policy-admission.v3',
    cycleId,
    packId: 'base-pack',
    quantity,
    quoteDigest: relayQuote.quoteDigest,
    unitPurchase: { chainId: '792703809', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, amountAtomic: unitPurchase },
    aggregatePurchase: { chainId: '792703809', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, amountAtomic: aggregatePurchase },
    unitFundingQuote: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: unitFunding },
    aggregateFundingQuote: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: aggregateFunding },
    unitFundingUsd: valuationFixture({ chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: unitFunding }, unitRelayQuote),
    aggregateFundingUsd: valuationFixture({ chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: aggregateFunding }, relayQuote),
    unitRelay: {
      tradeType: 'EXACT_OUTPUT', requestId: `relay-unit-${cycleId}`, orderId: `0x${'1'.repeat(64)}`,
      quoteDigest: unitRelayQuote.quoteDigest, deadlineUnixSeconds,
      sender: '0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384', recipient: 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE',
      destinationAmount: unitPurchase, destinationMinimumAmount: unitPurchase,
    },
    unitRelayQuote,
    relayQuote,
    relay: {
      tradeType: 'EXACT_OUTPUT', requestId: 'relay-n2', orderId: `0x${'2'.repeat(64)}`,
      quoteDigest: relayQuote.quoteDigest,
      deadlineUnixSeconds, sender: '0xB54AAF746eb1e80AFDb5eb0992a75b08DB2E4384',
      recipient: 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE', destinationAmount: aggregatePurchase, destinationMinimumAmount: aggregatePurchase,
    },
    processLiabilityEvidence: processLiabilityEvidenceFixture({ cycleId, ceilingAtomic: aggregateFunding }),
  };
}

test('N2 admission keeps the independent unit quote on the unit rail and reserves the aggregate quote once', async () => {
  const cycleId = 'cycle-n2-separate-quotes';
  const admission = exactOutputAdmission({ cycleId });
  const configuration = configuredPolicy({
    maxUnitPriceMicroUsd: '25000000', maxCycleBudgetMicroUsd: SYNTHETIC_N2_COST_MICRO_USD,
    perCycleCapMicroUsd: SYNTHETIC_N2_COST_MICRO_USD, max24HourBudgetMicroUsd: SYNTHETIC_N2_COST_MICRO_USD,
    lossCapMicroUsd: SYNTHETIC_N2_COST_MICRO_USD, maxOutstandingCustodyMicroUsd: SYNTHETIC_N2_COST_MICRO_USD,
    maxCyclesPerDay: 1, manualApprovalCycles: 0, requestedOrders: 2, maxBoostersPerCycle: 2,
  });
  let timestamp = 1_000;
  const { engine, readConfiguration } = policyFixture({ configuration, now: () => timestamp });
  const request = {
    boundary: 'claim-process', cycleId, releaseCostMicroUsd: SYNTHETIC_N2_COST_MICRO_USD,
    packId: 'base-pack', liveMode: true, admission,
  };
  const admitted = await engine.admit(request);
  assert.equal(admitted.allowed, true);
  assert.deepEqual(await engine.evaluatePurchase(request), { allowed: true, cycleDigest: admitted.cycleDigest });
  assert.equal(readConfiguration().spendLedger.length, 1);
  assert.equal(readConfiguration().spendLedger[0].amountMicroUsd, SYNTHETIC_N2_COST_MICRO_USD);

  const unitOver = exactOutputAdmission({ cycleId, unitFunding: '25000001' });
  assert.deepEqual(await engine.evaluatePurchase({ ...request, admission: unitOver }), { allowed: false, reason: 'UNIT_PRICE_CAP' });
  assert.deepEqual(await engine.admit({ ...request, cycleId: 'cycle-n2-over-cap', admission: exactOutputAdmission({ cycleId: 'cycle-n2-over-cap', aggregateFunding: '50309870' }), releaseCostMicroUsd: '50309870' }), { allowed: false, reason: 'PER_CYCLE_CAP' });
  timestamp += POLICY_WINDOW_MS;
  assert.deepEqual(await engine.evaluatePurchase(request), { allowed: false, reason: 'SPEND_RESERVATION_EXPIRED' });
});

test('N1 requires immutable parsed Relay quote evidence before it can satisfy the unit-price rail', async () => {
  const cycleId = 'cycle-unit-raw-evidence';
  const forged = exactOutputAdmission({ cycleId, unitFunding: '1', aggregateFunding: '50309869' });
  delete forged.unitRelayQuote;
  const configuration = configuredPolicy({
    requestedOrders: 2, maxBoostersPerCycle: 2, maxUnitPriceMicroUsd: '1',
    maxCycleBudgetMicroUsd: '50309869', perCycleCapMicroUsd: '50309869', max24HourBudgetMicroUsd: '50309869',
    lossCapMicroUsd: '50309869', maxOutstandingCustodyMicroUsd: '50309869', maxCyclesPerDay: 1, manualApprovalCycles: 0,
  });
  const { engine } = policyFixture({ configuration });
  await assert.rejects(
    () => engine.admit({
      boundary: 'claim-process', cycleId, releaseCostMicroUsd: '50309869', packId: 'base-pack', liveMode: true, admission: forged,
    }),
    /unitRelayQuote must be a parsed Relay quote/,
  );
});

test('N1 admission accepts independently parsed unit and aggregate Relay evidence', async () => {
  const cycleId = 'cycle-n1-parsed-evidence';
  const admission = exactOutputAdmission({ cycleId, quantity: 1 });
  const configuration = configuredPolicy({
    manualApprovalCycles: 0, maxUnitPriceMicroUsd: '25000000', maxCycleBudgetMicroUsd: '25000000',
    perCycleCapMicroUsd: '25000000', max24HourBudgetMicroUsd: '25000000',
    lossCapMicroUsd: '25000000', maxOutstandingCustodyMicroUsd: '25000000',
  });
  const { engine, readConfiguration } = policyFixture({ configuration });
  const request = {
    boundary: 'claim-process', cycleId, releaseCostMicroUsd: admission.aggregateFundingQuote.amountAtomic,
    packId: 'base-pack', liveMode: true, admission,
  };
  const decision = await engine.admit(request);
  assert.equal(decision.allowed, true);
  assert.deepEqual(await engine.evaluatePurchase(request), { allowed: true, cycleDigest: decision.cycleDigest });
  assert.equal(readConfiguration().spendLedger[0].amountMicroUsd, admission.aggregateFundingQuote.amountAtomic);
});

test('N1 rejects a parsed Relay quote whose canonical digest or raw origin amount changes', async () => {
  const cycleId = 'cycle-unit-evidence-mutation';
  const admission = exactOutputAdmission({ cycleId });
  const configuration = configuredPolicy({ requestedOrders: 2, maxBoostersPerCycle: 2, manualApprovalCycles: 0 });
  const { engine } = policyFixture({ configuration });
  const digestMutation = structuredClone(admission);
  digestMutation.unitRelayQuote.raw.details.operation = 'changed';
  await assert.rejects(
    () => engine.admit({ boundary: 'claim-process', cycleId, releaseCostMicroUsd: SYNTHETIC_N2_COST_MICRO_USD, packId: 'base-pack', liveMode: true, admission: digestMutation }),
    /unitRelayQuote digest does not match/,
  );
  const originMutation = structuredClone(admission);
  originMutation.unitRelayQuote.raw.details.currencyIn.amount = '1';
  await assert.rejects(
    () => engine.admit({ boundary: 'claim-process', cycleId, releaseCostMicroUsd: SYNTHETIC_N2_COST_MICRO_USD, packId: 'base-pack', liveMode: true, admission: originMutation }),
    /raw origin does not bind/,
  );
});

test('quote refresh re-admits a replacement under current caps without a second reservation', async () => {
  const cycleId = 'cycle-quote-refresh-success';
  const admission = exactOutputAdmission({ cycleId, quantity: 1 });
  const configuration = configuredPolicy({
    manualApprovalCycles: 0, maxUnitPriceMicroUsd: '25000000', maxCycleBudgetMicroUsd: '25000000',
    perCycleCapMicroUsd: '25000000', max24HourBudgetMicroUsd: '25000000',
    lossCapMicroUsd: '25000000', maxOutstandingCustodyMicroUsd: '25000000',
  });
  const { engine, readConfiguration } = policyFixture({ configuration });
  const request = {
    boundary: 'claim-process', cycleId, releaseCostMicroUsd: admission.aggregateFundingQuote.amountAtomic,
    packId: 'base-pack', liveMode: true, admission,
  };
  const admitted = await engine.admit(request);
  assert.equal(admitted.allowed, true);

  const replacement = exactOutputAdmission({ cycleId, quantity: 1, deadlineUnixSeconds: 2_000_000 });
  const decision = await engine.evaluateQuoteRefresh({
    cycleId, releaseCostMicroUsd: admission.aggregateFundingQuote.amountAtomic, packId: 'base-pack',
    liveMode: true, admission, replacement,
  });
  assert.equal(decision.allowed, true);
  assert.match(decision.refreshPolicyDecisionDigest, /^sha256:[0-9a-f]{64}$/);
  // The refresh decision binds original+replacement together; it is never a stand-in for the
  // cycle-policy digest that already governs the immutable original admission and reservation.
  assert.notEqual(decision.refreshPolicyDecisionDigest, admitted.cycleDigest);
  assert.equal(readConfiguration().spendLedger.length, 1);
  assert.equal(readConfiguration().spendLedger[0].amountMicroUsd, admission.aggregateFundingQuote.amountAtomic);
});

test('quote refresh refuses under a newly engaged kill switch without touching the reservation', async () => {
  const cycleId = 'cycle-quote-refresh-kill-switch';
  const admission = exactOutputAdmission({ cycleId, quantity: 1 });
  const configuration = configuredPolicy({
    manualApprovalCycles: 0, maxUnitPriceMicroUsd: '25000000', maxCycleBudgetMicroUsd: '25000000',
    perCycleCapMicroUsd: '25000000', max24HourBudgetMicroUsd: '25000000',
    lossCapMicroUsd: '25000000', maxOutstandingCustodyMicroUsd: '25000000',
  });
  const { engine, readConfiguration, replaceConfiguration } = policyFixture({ configuration });
  const request = {
    boundary: 'claim-process', cycleId, releaseCostMicroUsd: admission.aggregateFundingQuote.amountAtomic,
    packId: 'base-pack', liveMode: true, admission,
  };
  assert.equal((await engine.admit(request)).allowed, true);
  replaceConfiguration({ ...readConfiguration(), killSwitch: true });

  const replacement = exactOutputAdmission({ cycleId, quantity: 1, deadlineUnixSeconds: 2_000_000 });
  assert.deepEqual(await engine.evaluateQuoteRefresh({
    cycleId, releaseCostMicroUsd: admission.aggregateFundingQuote.amountAtomic, packId: 'base-pack',
    liveMode: true, admission, replacement,
  }), { allowed: false, reason: 'KILL_SWITCH' });
  assert.equal(readConfiguration().spendLedger.length, 1);
});

test('quote refresh refuses a replacement whose unit funding exceeds the current unit-price cap', async () => {
  const cycleId = 'cycle-quote-refresh-unit-cap';
  const admission = exactOutputAdmission({ cycleId, quantity: 1 });
  const configuration = configuredPolicy({
    manualApprovalCycles: 0, maxUnitPriceMicroUsd: '25000000', maxCycleBudgetMicroUsd: '25000000',
    perCycleCapMicroUsd: '25000000', max24HourBudgetMicroUsd: '25000000',
    lossCapMicroUsd: '25000000', maxOutstandingCustodyMicroUsd: '25000000',
  });
  const { engine } = policyFixture({ configuration });
  const request = {
    boundary: 'claim-process', cycleId, releaseCostMicroUsd: admission.aggregateFundingQuote.amountAtomic,
    packId: 'base-pack', liveMode: true, admission,
  };
  assert.equal((await engine.admit(request)).allowed, true);

  const replacement = exactOutputAdmission({
    cycleId, quantity: 1, unitFunding: '25000001', aggregateFunding: '25000000', deadlineUnixSeconds: 2_000_000,
  });
  assert.deepEqual(await engine.evaluateQuoteRefresh({
    cycleId, releaseCostMicroUsd: admission.aggregateFundingQuote.amountAtomic, packId: 'base-pack',
    liveMode: true, admission, replacement,
  }), { allowed: false, reason: 'UNIT_PRICE_CAP' });
});

test('quote refresh refuses a replacement whose principal no longer equals the immutable release amount', async () => {
  const cycleId = 'cycle-quote-refresh-principal-drift';
  const admission = exactOutputAdmission({ cycleId, quantity: 1 });
  const configuration = configuredPolicy({
    manualApprovalCycles: 0, maxUnitPriceMicroUsd: '25000001', maxCycleBudgetMicroUsd: '25000001',
    perCycleCapMicroUsd: '25000001', max24HourBudgetMicroUsd: '25000001',
    lossCapMicroUsd: '25000001', maxOutstandingCustodyMicroUsd: '25000001',
  });
  const { engine } = policyFixture({ configuration });
  const request = {
    boundary: 'claim-process', cycleId, releaseCostMicroUsd: admission.aggregateFundingQuote.amountAtomic,
    packId: 'base-pack', liveMode: true, admission,
  };
  assert.equal((await engine.admit(request)).allowed, true);

  const driftedReplacement = exactOutputAdmission({
    cycleId, quantity: 1, aggregateFunding: '25000001', deadlineUnixSeconds: 2_000_000,
  });
  await assert.rejects(
    () => engine.evaluateQuoteRefresh({
      cycleId, releaseCostMicroUsd: admission.aggregateFundingQuote.amountAtomic, packId: 'base-pack',
      liveMode: true, admission, replacement: driftedReplacement,
    }),
    /release amount does not match the immutable admitted principal/,
  );
});

test('a quote-bound admission without process liability evidence is refused, not silently accepted as equivalent', () => {
  const cycleId = 'cycle-evidence-absent';
  const admission = exactOutputAdmission({ cycleId, quantity: 1 });
  delete admission.processLiabilityEvidence;
  assert.throws(() => assertPolicyAdmission(admission), /processLiabilityEvidence is required/);
});

test('a valid process liability evidence record survives normalization unchanged and binds the cycle policy digest', () => {
  const cycleId = 'cycle-evidence-roundtrip';
  const admission = exactOutputAdmission({ cycleId, quantity: 1 });
  const normalized = assertPolicyAdmission(admission);
  assert.deepEqual(normalized.processLiabilityEvidence, admission.processLiabilityEvidence);

  const configuration = configuredPolicy();
  const baseDigest = deriveCyclePolicyDigest({
    configuration, cycleId, releaseCostMicroUsd: admission.aggregateFundingQuote.amountAtomic,
    packId: 'base-pack', liveMode: true, admission,
  });
  const mutated = structuredClone(admission);
  // activeProcessClaimLimit only has a `remainingProcessClaimCapacity <= activeProcessClaimLimit`
  // upper-bound relationship, so raising it keeps every other invariant intact.
  mutated.processLiabilityEvidence.activeProcessClaimLimit = (BigInt(mutated.processLiabilityEvidence.activeProcessClaimLimit) + 1n).toString();
  const mutatedDigest = deriveCyclePolicyDigest({
    configuration, cycleId, releaseCostMicroUsd: admission.aggregateFundingQuote.amountAtomic,
    packId: 'base-pack', liveMode: true, admission: mutated,
  });
  assert.notEqual(mutatedDigest, baseDigest, 'a one-field evidence mutation must change the cycle policy digest');
});

test('an aggregate funding quote above the persisted process liability ceiling is refused', () => {
  const cycleId = 'cycle-evidence-over-ceiling';
  const admission = exactOutputAdmission({ cycleId, quantity: 1 });
  const shrunk = structuredClone(admission);
  for (const field of ['processLiability', 'remainingProcessClaimCapacity', 'ceilingAtomic']) {
    shrunk.processLiabilityEvidence[field] = '1';
  }
  assert.throws(() => assertPolicyAdmission(shrunk), /exceeds the persisted process liability ceiling/);
});

test('each independent process liability evidence control refuses the admission', () => {
  const cycleId = 'cycle-evidence-controls';
  const admission = exactOutputAdmission({ cycleId, quantity: 1 });
  const cases = [
    [{ processClaimsPaused: true }, /refuses while hook process claims are paused/],
    [{ processClaimCycleUsed: true }, /refuses a cycle id the hook already used/],
    [{ isSolvent: false, hookNativeBalance: '0' }, /refuses while the hook is not solvent/],
    [{ operations: `0x${'9'.repeat(40)}` }, /Operations role does not match the approved deployment identity/],
    [{ cycleId: 'a-different-cycle' }, /cycleId does not match the admitted cycle/],
    [{ onchainCycleId: `0x${'9'.repeat(64)}` }, /onchainCycleId does not match its cycleId/],
    [{ ceilingAtomic: (BigInt(admission.processLiabilityEvidence.ceilingAtomic) + 1n).toString() }, /ceilingAtomic does not equal min/],
    [{ chainId: '1' }, /not denominated in the configured funding asset/],
    [{ schema: 'hookemon.process-liability-evidence.v0' }, /must use hookemon\.process-liability-evidence\.v2/],
    [{ notARecognizedField: '1' }, /unrecognized field/],
    // The hook's own accounting guarantees these three relationships; a value combination outside
    // them cannot have come from the contract regardless of who supplied it.
    [{ activeProcessClaimLimit: '0' }, /remainingProcessClaimCapacity exceeds activeProcessClaimLimit/],
    [{ totalLiability: '0' }, /processLiability exceeds totalLiability/],
    [{ isSolvent: true, hookNativeBalance: '0' }, /isSolvent does not match hookNativeBalance and totalLiability/],
  ];
  for (const [override, pattern] of cases) {
    const tampered = structuredClone(admission);
    Object.assign(tampered.processLiabilityEvidence, override);
    assert.throws(() => assertPolicyAdmission(tampered), pattern, JSON.stringify(override));
  }
});

test('a policy admission quantity above the shared batch/catalog ceiling is refused before the cycle exists (BOT-PACK-QUANTITY P1)', () => {
  const cycleId = 'cycle-quantity-over-ceiling';
  const admission = exactOutputAdmission({ cycleId, quantity: MAXIMUM_PACK_BATCH_SIZE + 1 });
  assert.throws(
    () => assertPolicyAdmission(admission),
    /policy admission quantity must be an integer from 1 through/,
  );
});

test('a synthetic N2 native fixture is admitted under an explicit configuration sized exactly to it, and one atomic unit above the same rail is refused', async () => {
  const releaseCostMicroUsd = SYNTHETIC_N2_COST_MICRO_USD;
  const configuration = configuredPolicy({
    maxUnitPriceMicroUsd: releaseCostMicroUsd,
    maxCycleBudgetMicroUsd: releaseCostMicroUsd,
    perCycleCapMicroUsd: releaseCostMicroUsd,
    max24HourBudgetMicroUsd: releaseCostMicroUsd,
    lossCapMicroUsd: releaseCostMicroUsd,
    maxOutstandingCustodyMicroUsd: releaseCostMicroUsd,
    maxCyclesPerDay: 1,
    manualApprovalCycles: 0,
  });
  const cycleId = 'cycle-n2-verified-quote';
  const cycleDigest = deriveCyclePolicyDigest({
    configuration, cycleId, releaseCostMicroUsd, packId: 'base-pack', liveMode: true,
  });
  const { engine } = policyFixture({
    configuration: {
      ...configuration,
      cycleLedger: [{ cycleId, cycleDigest, mode: 'production', openedAtMs: 1_000, releaseCostMicroUsd }],
      spendLedger: [{ cycleId, cycleDigest, amountMicroUsd: releaseCostMicroUsd, reservedAtMs: 1_000 }],
    },
  });

  assert.deepEqual(await engine.evaluatePurchase({
    boundary: 'purchase', cycleId, releaseCostMicroUsd, packId: 'base-pack', liveMode: true,
  }), { allowed: true, cycleDigest });

  const oneAtomicUnitOver = (BigInt(releaseCostMicroUsd) + 1n).toString();
  assert.deepEqual(await engine.evaluatePurchase({
    boundary: 'purchase', cycleId, releaseCostMicroUsd: oneAtomicUnitOver, packId: 'base-pack', liveMode: true,
  }), { allowed: false, reason: 'UNIT_PRICE_CAP' });
});

test('an existing production cycle without its matching durable spend reservation cannot proceed', async () => {
  const cycleId = 'cycle-missing-reservation';
  const releaseCostMicroUsd = '5000000';
  const base = configuredPolicy();
  const cycleDigest = deriveCyclePolicyDigest({
    configuration: base,
    cycleId,
    releaseCostMicroUsd,
    packId: 'base-pack',
    liveMode: true,
  });
  const configuration = {
    ...base,
    cycleLedger: [{ cycleId, cycleDigest, mode: 'production', openedAtMs: 1_000, releaseCostMicroUsd }],
    spendLedger: [],
  };
  const { engine } = policyFixture({ configuration });
  assert.deepEqual(await engine.admit({
    boundary: 'claim-process',
    cycleId,
    releaseCostMicroUsd,
    packId: 'base-pack',
    liveMode: true,
  }), { allowed: false, reason: 'SPEND_RESERVATION_MISSING' });
});

test('a reservation expires at the end of the off-chain policy window and remains pending custody before then', async () => {
  let timestamp = 1_000;
  let custody = {
    realizedLossMicroUsd: '0',
    atRiskMicroUsd: '0',
    outstandingMicroUsd: '0',
    heldAssets: false,
    heldPositions: { count: 0, valueMicroUsd: '0', positions: [] },
    unattributed: false,
    unvaluedExposure: false,
  };
  const { engine } = policyFixture({
    now: () => timestamp,
    readCustody: async () => custody,
    configuration: configuredPolicy({
      max24HourBudgetMicroUsd: '5',
      maxCycleBudgetMicroUsd: '5',
      perCycleCapMicroUsd: '5',
      maxUnitPriceMicroUsd: '5',
      lossCapMicroUsd: '5',
      maxOutstandingCustodyMicroUsd: '5',
    }),
  });
  const request = {
    boundary: 'claim-process',
    cycleId: 'cycle-expiring-reservation',
    releaseCostMicroUsd: '5',
    packId: 'base-pack',
    liveMode: true,
  };

  assert.equal((await engine.admit(request)).allowed, true);

  timestamp += 1;
  custody = { ...custody, atRiskMicroUsd: '6', outstandingMicroUsd: '6' };
  assert.deepEqual(await engine.admit(request), { allowed: false, reason: 'LOSS_CAP' });

  timestamp = 1_000 + POLICY_WINDOW_MS;
  custody = { ...custody, atRiskMicroUsd: '0', outstandingMicroUsd: '0' };
  assert.deepEqual(await engine.admit(request), { allowed: false, reason: 'SPEND_RESERVATION_EXPIRED' });
});

test('an expired retry is refused before a different full-cap claim enters the next policy window', async () => {
  let timestamp = 1_000;
  const { engine } = policyFixture({
    now: () => timestamp,
    configuration: configuredPolicy({
      maxCyclesPerDay: 1,
      max24HourBudgetMicroUsd: '5',
      maxCycleBudgetMicroUsd: '5',
      perCycleCapMicroUsd: '5',
      maxUnitPriceMicroUsd: '5',
    }),
  });
  const first = {
    boundary: 'claim-process',
    cycleId: 'cycle-expired-before-replacement',
    releaseCostMicroUsd: '5',
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
    releaseCostMicroUsd: '5000000',
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
      releaseCostMicroUsd: request.releaseCostMicroUsd,
      packId: request.packId,
      requestDigest: `sha256:${'a'.repeat(64)}`,
      liveMode: true,
    }),
    error => error instanceof PolicyRefusalError && error.reason === 'PACK_NOT_ALLOWED',
  );
});

test('a cycle-bound broadcast guard rereads loss and custody caps before broadcast', async () => {
  let custody = {
    realizedLossMicroUsd: '0',
    atRiskMicroUsd: '0',
    outstandingMicroUsd: '0',
    heldAssets: false,
    heldPositions: { count: 0, valueMicroUsd: '0', positions: [] },
    unattributed: false,
    unvaluedExposure: false,
  };
  const { engine } = policyFixture({
    readCustody: async () => custody,
    configuration: configuredPolicy({
      max24HourBudgetMicroUsd: '5',
      maxCycleBudgetMicroUsd: '5',
      perCycleCapMicroUsd: '5',
      maxUnitPriceMicroUsd: '5',
      lossCapMicroUsd: '5',
      maxOutstandingCustodyMicroUsd: '5',
    }),
  });
  const request = {
    boundary: 'claim-process',
    cycleId: 'cycle-broadcast-cap-guard',
    releaseCostMicroUsd: '5',
    packId: 'base-pack',
    liveMode: true,
  };
  assert.equal((await engine.admit(request)).allowed, true);
  custody = { ...custody, atRiskMicroUsd: '6', outstandingMicroUsd: '6' };

  await assert.rejects(
    () => engine.assertExecutionAllowed({
      boundary: 'broadcast',
      cycleId: request.cycleId,
      releaseCostMicroUsd: request.releaseCostMicroUsd,
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
    realizedLossMicroUsd: '0',
    atRiskMicroUsd: '0',
    outstandingMicroUsd: '0',
    heldAssets: false,
    heldPositions: { count: 0, valueMicroUsd: '0', positions: [] },
    unattributed: false,
    unvaluedExposure: false,
  };
  const { engine } = policyFixture({
    now: () => timestamp,
    readCustody: async () => custody,
    configuration: configuredPolicy({
      max24HourBudgetMicroUsd: '5',
      maxCycleBudgetMicroUsd: '5',
      perCycleCapMicroUsd: '5',
      maxUnitPriceMicroUsd: '5',
      lossCapMicroUsd: '5',
      maxOutstandingCustodyMicroUsd: '5',
    }),
  });
  const request = {
    boundary: 'claim-process',
    cycleId: 'cycle-later-stage-guard',
    releaseCostMicroUsd: '5',
    packId: 'base-pack',
    liveMode: true,
  };
  assert.equal((await engine.admit(request)).allowed, true);
  custody = { ...custody, atRiskMicroUsd: '5', outstandingMicroUsd: '5' };
  const guard = () => engine.assertExecutionAllowed({
    boundary: 'signature',
    stage: 'outbound',
    cycleId: request.cycleId,
    releaseCostMicroUsd: request.releaseCostMicroUsd,
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
    releaseCostMicroUsd: '5000000',
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

test('cycle policy digest binds the unresolved-card reconciliation deadline', () => {
  const configuration = configuredPolicy({ unresolvedCardDeadlineMinutes: 45 });
  const cycleId = 'cycle-deadline-policy';
  const releaseCostMicroUsd = '5000000';
  const expected = digest({
    schema: 'hookemon.policy-cycle.v5',
    cycleId,
    releaseCostMicroUsd,
    releaseAmountWei: releaseCostMicroUsd,
    admission: assertPolicyAdmission(nativeFixtureRequest({cycleId, packId: 'base-pack', releaseCostMicroUsd}, configuration).admission),
    packId: 'base-pack',
    mode: 'production',
    policy: {
      allowedPackIds: [...configuration.allowedPackIds],
      requestedOrders: configuration.requestedOrders,
      maxBoostersPerCycle: configuration.maxBoostersPerCycle,
      maxUnitPriceMicroUsd: configuration.maxUnitPriceMicroUsd,
      perCycleCapMicroUsd: configuration.perCycleCapMicroUsd,
      max24HourBudgetMicroUsd: configuration.max24HourBudgetMicroUsd,
      maxCyclesPerDay: configuration.maxCyclesPerDay,
      lossCapMicroUsd: configuration.lossCapMicroUsd,
      maxOutstandingCustodyMicroUsd: configuration.maxOutstandingCustodyMicroUsd,
      maxHeldPositions: configuration.maxHeldPositions,
      maxHeldValueMicroUsd: configuration.maxHeldValueMicroUsd,
      unresolvedCardDeadlineMinutes: configuration.unresolvedCardDeadlineMinutes,
      manualApprovalCycles: configuration.manualApprovalCycles,
    },
  });

  assert.equal(deriveCyclePolicyDigest({
    configuration,
    cycleId,
    releaseCostMicroUsd,
    packId: 'base-pack',
    liveMode: true,
  }), expected);
});

test('an active held-position policy digest without an unresolved-card deadline is refused for native execution', async () => {
  const cycleId = 'cycle-pre-deadline-policy';
  const releaseCostMicroUsd = '5000000';
  const base = configuredPolicy();
  const cycleDigest = digest({
    schema: 'hookemon.policy-cycle.v3',
    cycleId,
    releaseCostMicroUsd,
    packId: 'base-pack',
    mode: 'production',
    policy: {
      allowedPackIds: [...base.allowedPackIds],
      requestedOrders: base.requestedOrders,
      maxBoostersPerCycle: base.maxBoostersPerCycle,
      maxUnitPriceMicroUsd: base.maxUnitPriceMicroUsd,
      perCycleCapMicroUsd: base.perCycleCapMicroUsd,
      max24HourBudgetMicroUsd: base.max24HourBudgetMicroUsd,
      maxCyclesPerDay: base.maxCyclesPerDay,
      lossCapMicroUsd: base.lossCapMicroUsd,
      maxOutstandingCustodyMicroUsd: base.maxOutstandingCustodyMicroUsd,
      maxHeldPositions: base.maxHeldPositions,
      maxHeldValueMicroUsd: base.maxHeldValueMicroUsd,
      manualApprovalCycles: base.manualApprovalCycles,
    },
  });
  const { engine } = policyFixture({
    configuration: {
      ...base,
      configurationRevision: 2,
      cycleLedger: [{ cycleId, cycleDigest, mode: 'production', openedAtMs: 1_000, releaseCostMicroUsd }],
      spendLedger: [{ cycleId, cycleDigest, amountMicroUsd: releaseCostMicroUsd, reservedAtMs: 1_000 }],
    },
  });

  assert.deepEqual(await engine.evaluatePurchase({
    boundary: 'purchase',
    cycleId,
    releaseCostMicroUsd,
    packId: 'base-pack',
    liveMode: true,
  }), { allowed: false, reason: 'CYCLE_POLICY_DIGEST_CHANGED' });
});

test('a legacy policy digest is refused for native execution when only its generic revision changed', async () => {
  const cycleId = 'cycle-legacy-pause-resume';
  const releaseCostMicroUsd = '5000000';
  const base = configuredPolicy();
  const cycleDigest = digest({
    schema: 'hookemon.policy-cycle.v1',
    cycleId,
    releaseCostMicroUsd,
    packId: 'base-pack',
    mode: 'production',
    policy: {
      configurationRevision: 0,
      allowedPackIds: [...base.allowedPackIds],
      requestedOrders: base.requestedOrders,
      maxBoostersPerCycle: base.maxBoostersPerCycle,
      maxUnitPriceMicroUsd: base.maxUnitPriceMicroUsd,
      perCycleCapMicroUsd: base.perCycleCapMicroUsd,
      max24HourBudgetMicroUsd: base.max24HourBudgetMicroUsd,
      maxCyclesPerDay: base.maxCyclesPerDay,
      lossCapMicroUsd: base.lossCapMicroUsd,
      maxOutstandingCustodyMicroUsd: base.maxOutstandingCustodyMicroUsd,
      manualApprovalCycles: base.manualApprovalCycles,
    },
  });
  const { engine } = policyFixture({
    configuration: {
      ...base,
      configurationRevision: 2,
      cycleLedger: [{ cycleId, cycleDigest, mode: 'production', openedAtMs: 1_000, releaseCostMicroUsd }],
      spendLedger: [{ cycleId, cycleDigest, amountMicroUsd: releaseCostMicroUsd, reservedAtMs: 1_000 }],
    },
  });

  assert.deepEqual(await engine.evaluatePurchase({
    boundary: 'purchase',
    cycleId,
    releaseCostMicroUsd,
    packId: 'base-pack',
    liveMode: true,
  }), { allowed: false, reason: 'CYCLE_POLICY_DIGEST_CHANGED' });
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
    verifyQuoteUsdValuation: value => fixtureValuations.has(value),
    readConfiguration: async () => configuration,
    readCustody: async () => ({
      realizedLossMicroUsd: '0',
      atRiskMicroUsd: '0',
      outstandingMicroUsd: '0',
      heldAssets: false,
      heldPositions: { count: 0, valueMicroUsd: '0', positions: [] },
      unattributed: false,
      unvaluedExposure: false,
      cycleExposureMicroUsd: new Proxy({}, { get: () => '0' }),
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

test('native principal and frozen USD cost stay separate; JSON restart cannot authorize new risk', async () => {
  const cycleId = 'cycle-native-valuation';
  const admission = exactOutputAdmission({ cycleId, quantity: 1, unitFunding: '1000000000000000000', aggregateFunding: '1000000000000000000' });
  admission.unitFundingUsd = valuationFixture(admission.unitFundingQuote, admission.unitRelayQuote, '5000000');
  admission.aggregateFundingUsd = valuationFixture(admission.aggregateFundingQuote, admission.relayQuote, '5000000');
  let timestamp = 1000;
  const { rawEngine, readConfiguration } = policyFixture({ now: () => timestamp });
  const request = { boundary: 'claim-process', cycleId, packId: 'base-pack', liveMode: true,
    releaseAmountWei: '1000000000000000000', releaseCostMicroUsd: '5000000', admission };
  const accepted = await rawEngine.admit(request);
  assert.equal(accepted.allowed, true);
  const config = readConfiguration();
  assert.equal(config.cycleLedger[0].releaseAmountWei, '1000000000000000000');
  assert.equal(config.cycleLedger[0].releaseCostMicroUsd, '5000000');
  assert.equal(config.spendLedger[0].amountMicroUsd, '5000000');
  const restarted = { ...request, admission: structuredClone(admission) };
  assert.deepEqual(await rawEngine.evaluatePurchase(restarted), { allowed: false, reason: 'USD_VALUATION_UNVERIFIED' });
  // Observation/recovery execution retains frozen basis, independent of quotation freshness.
  timestamp = admission.aggregateFundingUsd.validUntilMs;
  assert.deepEqual(await rawEngine.evaluate({ ...restarted, boundary: 'mutation', stage: 'return' }), accepted);
  assert.deepEqual(await rawEngine.evaluateClaim(request), { allowed: false, reason: 'USD_VALUATION_UNVERIFIED' });
  assert.equal(readConfiguration().spendLedger.length, 1);
});

test('new native risk refuses missing producer capability and wrong valuation units or rounding', async () => {
  const cycleId = 'cycle-native-negative';
  const admission = exactOutputAdmission({ cycleId, quantity: 1, unitFunding: '5000000' });
  const request = { boundary: 'claim-process', cycleId, packId: 'base-pack', liveMode: true,
    releaseAmountWei: '5000000', releaseCostMicroUsd: '5000000', admission };
  const noCapability = createPolicyEngine({ readConfiguration: async () => configuredPolicy(), mutateConfiguration: async () => { throw new Error('must not reserve'); }, now: () => 1000 });
  assert.deepEqual(await noCapability.evaluateClaim(request), { allowed: false, reason: 'USD_VALUATION_UNVERIFIED' });
  const { rawEngine } = policyFixture();
  for (const mutation of [
    value => { value.aggregateFundingUsd.rounding = 'down'; },
    value => { value.aggregateFundingUsd.amount.assetId = 'USDC'; },
    value => { value.aggregateFundingUsd.amount.decimals = 6; },
    value => { value.aggregateFundingUsd.amount.amountAtomic = '5000001'; },
    value => { value.aggregateFundingUsd.sourcePath = 'details.currencyOut.amountUsd'; },
  ]) {
    const tampered = structuredClone(admission);
    mutation(tampered);
    await assert.rejects(rawEngine.evaluateClaim({ ...request, admission: tampered }), /valuation binding/);
  }
});

test('a retry counts only the reserved cost absent from the cycle custody projection', async () => {
  const cycleId = 'cycle-native-accounted';
  const admission = exactOutputAdmission({ cycleId, quantity: 1, unitFunding: '5000000' });
  let observed = false;
  const { rawEngine, readConfiguration } = policyFixture({
    configuration: configuredPolicy({ lossCapMicroUsd: '5000000', maxOutstandingCustodyMicroUsd: '5000000' }),
    readCustody: async () => ({ realizedLossMicroUsd: '0', atRiskMicroUsd: observed ? '5000000' : '0', outstandingMicroUsd: observed ? '5000000' : '0',
      heldAssets: false, heldPositions: { count: 0, valueMicroUsd: '0', positions: [] }, unattributed: false, unvaluedExposure: false,
      cycleExposureMicroUsd: { [cycleId]: observed ? '5000000' : '0' } }),
  });
  const request = { boundary: 'claim-process', cycleId, packId: 'base-pack', liveMode: true, releaseAmountWei: '5000000', releaseCostMicroUsd: '5000000', admission };
  assert.equal((await rawEngine.admit(request)).allowed, true);
  observed = true;
  assert.equal((await rawEngine.admit(request)).allowed, true);
  assert.equal(readConfiguration().spendLedger.length, 1);
});

test('historical USDG admission remains readable but never authorizes native execution', () => {
  const legacy = structuredClone(exactOutputAdmission({ cycleId: 'cycle-historical-read', quantity: 1 }));
  const assetId = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  legacy.schema = 'hookemon.policy-admission.v2';
  delete legacy.unitFundingUsd;
  delete legacy.aggregateFundingUsd;
  for (const field of ['unitFundingQuote', 'aggregateFundingQuote']) Object.assign(legacy[field], { assetId, decimals: 6 });
  legacy.processLiabilityEvidence.schema = 'hookemon.process-liability-evidence.v1';
  Object.assign(legacy.processLiabilityEvidence, { assetId, decimals: 6, hookUsdgBalance: legacy.processLiabilityEvidence.hookNativeBalance });
  delete legacy.processLiabilityEvidence.hookNativeBalance;
  for (const [field, identity] of [['unitRelayQuote', 'unitRelay'], ['relayQuote', 'relay']]) {
    const quote = legacy[field];
    Object.assign(quote.origin, { address: assetId, decimals: 6 });
    Object.assign(quote.raw.details.currencyIn.currency, { address: assetId, decimals: 6 });
    quote.raw.protocol.v2.orderData.inputs[0].payment.currency = assetId;
    quote.quoteDigest = digest({ schema: 'hookemon.relay-quote.v1', direction: quote.direction, tradeType: quote.tradeType,
      requestId: quote.requestId, orderId: quote.orderId, sender: quote.sender, recipient: quote.recipient,
      deadlineUnixSeconds: quote.deadlineUnixSeconds, origin: quote.origin, destination: quote.destination, raw: quote.raw });
    legacy[identity].quoteDigest = quote.quoteDigest;
  }
  legacy.quoteDigest = legacy.relayQuote.quoteDigest;
  const readable = decodeHistoricalPolicyAdmission(legacy);
  assert.equal(readable.schema, 'hookemon.policy-admission.v2');
  assert.equal(readable.aggregateFundingQuote.assetId, assetId);
  assert.equal(readable.processLiabilityEvidence.hookUsdgBalance, legacy.processLiabilityEvidence.hookUsdgBalance);
  assert.throws(() => assertPolicyAdmission(readable), /must use hookemon.policy-admission.v3/);
  assert.throws(() => decodeHistoricalPolicyAdmission({ ...legacy, aggregateFundingQuote: { ...legacy.aggregateFundingQuote, assetId: 'native' } }), /canonical asset route/);
});

test('held purchase costs remain counted without a native principal held bucket', async () => {
  const cycleId = 'cycle-held-usd-only';
  const admission = exactOutputAdmission({ cycleId, quantity: 1, unitFunding: '5000000' });
  const { rawEngine } = policyFixture({
    configuration: configuredPolicy({ maxHeldValueMicroUsd: '9000000' }),
    custody: {
      heldAssets: false,
      heldPositions: { count: 2, valueMicroUsd: '10000000', positions: [
        { positionId: 'held-one', costMicroUsd: '5000000', ledgerAsset: null },
        { positionId: 'held-two', costMicroUsd: '5000000', ledgerAsset: null },
      ] },
    },
  });
  assert.deepEqual(await rawEngine.evaluateClaim({ boundary: 'claim-process', cycleId, packId: 'base-pack', liveMode: true,
    releaseAmountWei: '5000000', releaseCostMicroUsd: '5000000', admission }), { allowed: false, reason: 'HELD_LIMIT' });
});
