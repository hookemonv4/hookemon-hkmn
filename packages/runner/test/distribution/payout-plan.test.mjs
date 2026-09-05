import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalJson } from '../../src/cycle/journal.mjs';
import {
  compileDirectPayoutPlan as compilePayoutPlan,
  createUsdgPayoutAmount,
  directPayoutPlanDigest,
} from '../../src/distribution/payout-plan.mjs';

const TOKEN = `0x${'a'.repeat(40)}`;
const RETURN_BINDING = Object.freeze({
  operations: `0x${'b'.repeat(40)}`,
  usdgAddress: TOKEN,
  evidenceDigest: `sha256:${'e'.repeat(64)}`,
});

function compileDirectPayoutPlan(input) {
  return compilePayoutPlan({ ...input, returnBinding: input.returnBinding ?? RETURN_BINDING });
}

function address(index) {
  return `0x${(index + 1).toString(16).padStart(40, '0')}`;
}

function usdg(amountAtomic, assetId = RETURN_BINDING.usdgAddress) {
  return createUsdgPayoutAmount({ assetId, amountAtomic });
}

function dustSource(overrides = {}) {
  return {
    cycleId: 'cycle-dust-source',
    digest: `sha256:${'f'.repeat(64)}`,
    planDigest: `sha256:${'a'.repeat(64)}`,
    ...overrides,
  };
}

function eligibilityManifest(entries, overrides = {}) {
  const sortedEntries = [...entries].sort((left, right) => left.recipient.localeCompare(right.recipient));
  const estimatedNativeFee = (BigInt(entries.length) * 100_000n).toString();
  const requiredNativeAmount = (BigInt(estimatedNativeFee) + 1n).toString();
  return {
    schema: 'hookemon.eligibility-payout-manifest.v1',
    cycleId: 'cycle-payout-plan-1',
    snapshotBlock: '42',
    snapshotHash: `0x${'b'.repeat(64)}`,
    finality: { policyId: 'robinhood-stage-finality-v1', depth: '2' },
    supply: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: entries.reduce((sum, entry) => sum + BigInt(entry.hkmnBalance.amountAtomic), 0n).toString() },
    entries: sortedEntries,
    exclusions: [],
    feasibility: {
      recipientCount: entries.length,
      transactionCount: entries.length,
      maxRecipientCount: entries.length,
      maxTransactionCount: entries.length,
      measuredTransferGas: '50000',
      maxGasPriceWei: '2',
      estimatedNativeFee: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: estimatedNativeFee },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '1' },
      nativeBalance: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: requiredNativeAmount },
      requiredNativeAmount: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: requiredNativeAmount },
      feasible: true,
      reason: null,
    },
    logCompleteness: {
      mode: 'single-source-explicitly-allowed',
      primary: { sourceId: 'primary', transferLogDigest: `sha256:${'c'.repeat(64)}`, logCount: entries.length },
      secondary: null,
    },
    holderSnapshotDigest: `sha256:${'d'.repeat(64)}`,
    launchManifestDigest: `sha256:${'e'.repeat(64)}`,
    ...overrides,
  };
}

function holder(index, amountAtomic, decimals = 18) {
  return {
    recipient: address(index),
    hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals, amountAtomic: String(amountAtomic) },
  };
}

test('retains floor-rounding residual atomic units as durable dust', () => {
  const plan = compileDirectPayoutPlan({
    cycleId: 'cycle-largest-remainder',
    eligibilityManifest: eligibilityManifest([holder(2, 2), holder(0, 5), holder(1, 3)], { cycleId: 'cycle-largest-remainder' }),
    finalizedReturn: usdg('11'),
    previousDust: usdg('0'),
  });

  assert.equal(plan.schema, 'hookemon.direct-payout-plan.v1');
  assert.deepEqual(plan.returnDelta, usdg('11'));
  assert.deepEqual(plan.dust, usdg('1'));
  assert.deepEqual(
    plan.allocations.map(({ recipient, amount }) => [recipient, amount.amountAtomic]),
    [[address(0), '5'], [address(1), '3'], [address(2), '2']],
  );
  assert.equal(plan.totalAllocated.amountAtomic, '10');
});

test('binds the plan to the finalized return recipient, token, and evidence digest', () => {
  const plan = compileDirectPayoutPlan({
    cycleId: 'cycle-return-binding',
    eligibilityManifest: eligibilityManifest([holder(0, 1)], { cycleId: 'cycle-return-binding' }),
    finalizedReturn: usdg('1'),
    previousDust: usdg('0'),
  });

  assert.deepEqual(plan.returnEvidence, RETURN_BINDING);
});

test('derives every USDG amount from the canonical return-binding token identity', () => {
  const boundToken = `0x${'C'.repeat(40)}`;
  const returnBinding = {
    ...RETURN_BINDING,
    usdgAddress: boundToken,
  };
  const plan = compileDirectPayoutPlan({
    cycleId: 'cycle-canonical-usdg-identity',
    eligibilityManifest: eligibilityManifest([holder(0, 2), holder(1, 1)], { cycleId: 'cycle-canonical-usdg-identity' }),
    finalizedReturn: usdg('3', boundToken),
    previousDust: usdg('0', boundToken),
    returnBinding,
  });
  const canonicalToken = boundToken.toLowerCase();

  assert.equal(plan.returnEvidence.usdgAddress, canonicalToken);
  assert.equal(plan.returnDelta.assetId, canonicalToken);
  assert.equal(plan.previousDust.assetId, canonicalToken);
  assert.equal(plan.distributablePool.assetId, canonicalToken);
  assert.equal(plan.allocations.every(allocation => allocation.amount.assetId === canonicalToken), true);
  assert.equal(plan.dust.assetId, canonicalToken);

  assert.throws(
    () => compileDirectPayoutPlan({
      cycleId: 'cycle-canonical-usdg-identity',
      eligibilityManifest: eligibilityManifest([holder(0, 1)], { cycleId: 'cycle-canonical-usdg-identity' }),
      finalizedReturn: { chainId: 4663, assetId: 'usdg', decimals: 6, amountAtomic: '1' },
      previousDust: usdg('0', boundToken),
      returnBinding,
    }),
    /assetId must be an EVM address/i,
  );
  assert.throws(
    () => compileDirectPayoutPlan({
      cycleId: 'cycle-canonical-usdg-identity',
      eligibilityManifest: eligibilityManifest([holder(0, 1)], { cycleId: 'cycle-canonical-usdg-identity' }),
      finalizedReturn: usdg('1', `0x${'D'.repeat(40)}`),
      previousDust: usdg('0', boundToken),
      returnBinding,
    }),
    /configured USDG asset identity/i,
  );
});

test('keeps a persisted dust balance in the next cycle conservation basis', () => {
  const entries = [holder(0, 1), holder(1, 1), holder(2, 1)];
  const previousDustSource = dustSource();
  const plan = compileDirectPayoutPlan({
    cycleId: 'cycle-dust-carry',
    eligibilityManifest: eligibilityManifest(entries, { cycleId: 'cycle-dust-carry' }),
    finalizedReturn: usdg('8'),
    previousDust: usdg('2'),
    previousDustSource,
  });

  assert.deepEqual(plan.previousDust, usdg('2'));
  assert.deepEqual(plan.previousDustSource, previousDustSource);
  assert.deepEqual(plan.distributablePool, usdg('10'));
  assert.equal(plan.totalAllocated.amountAtomic, '9');
  assert.equal(plan.dust.amountAtomic, '1');
});

test('binds nonzero prior dust to immutable source evidence', () => {
  const source = dustSource();
  const input = {
    cycleId: 'cycle-dust-provenance',
    eligibilityManifest: eligibilityManifest([holder(0, 1), holder(1, 1)], { cycleId: 'cycle-dust-provenance' }),
    finalizedReturn: usdg('3'),
    previousDust: usdg('1'),
    previousDustSource: source,
  };
  const plan = compileDirectPayoutPlan(input);

  assert.deepEqual(plan.previousDustSource, source);
  assert.equal(Object.isFrozen(plan.previousDustSource), true);
  assert.notEqual(
    plan.planDigest,
    compileDirectPayoutPlan({
      ...input,
      previousDustSource: dustSource({ digest: `sha256:${'b'.repeat(64)}` }),
    }).planDigest,
  );
  assert.throws(
    () => compileDirectPayoutPlan({ ...input, previousDustSource: null }),
    /previous dust source.*nonzero/i,
  );
  assert.throws(
    () => compileDirectPayoutPlan({
      ...input,
      previousDust: usdg('0'),
      previousDustSource: source,
    }),
    /previous dust source.*zero/i,
  );
});

test('supports 1,025 recipients when the frozen feasibility envelope permits them', () => {
  const entries = Array.from({ length: 1025 }, (_, index) => holder(index, 1));
  const plan = compileDirectPayoutPlan({
    cycleId: 'cycle-1025',
    eligibilityManifest: eligibilityManifest(entries, { cycleId: 'cycle-1025' }),
    finalizedReturn: usdg('1025'),
    previousDust: usdg('0'),
  });

  assert.equal(plan.allocations.length, 1025);
  assert.equal(plan.payableRecipientCount, 1025);
  assert.equal(plan.totalAllocated.amountAtomic, '1025');
  assert.equal(plan.planDigest.startsWith('sha256:'), true);
});

test('rejects a feasible holder set beyond direct-payout capacity before allocation', () => {
  const entries = Array.from({ length: 1026 }, (_, index) => holder(index, 1));
  const manifest = eligibilityManifest(entries, { cycleId: 'cycle-direct-capacity' });

  assert.equal(manifest.feasibility.feasible, true);
  assert.throws(
    () => compileDirectPayoutPlan({
      cycleId: 'cycle-direct-capacity',
      eligibilityManifest: manifest,
      finalizedReturn: usdg('1026'),
      previousDust: usdg('0'),
    }),
    /supports at most 1025 recipients/,
  );
});

test('rejects a holder count beyond the frozen payout envelope', () => {
  const entries = Array.from({ length: 1025 }, (_, index) => holder(index, 1));
  const manifest = eligibilityManifest(entries, {
    cycleId: 'cycle-maximum-holder-envelope',
    feasibility: {
      ...eligibilityManifest(entries).feasibility,
      maxRecipientCount: 1024,
      maxTransactionCount: 1024,
      feasible: false,
      reason: 'recipient-count-exceeds-configured-maximum',
    },
  });
  assert.throws(
    () => compileDirectPayoutPlan({
      cycleId: 'cycle-maximum-holder-envelope',
      eligibilityManifest: manifest,
      finalizedReturn: usdg('1025'),
      previousDust: usdg('0'),
    }),
    /feasibility/,
  );
});

test('keeps maximum atomic holder weights in integer arithmetic', () => {
  const maximumValue = (1n << 256n) - 1n;
  const maximum = maximumValue.toString();
  const plan = compileDirectPayoutPlan({
    cycleId: 'cycle-maximum-holder-weight',
    eligibilityManifest: eligibilityManifest([
      holder(0, maximum),
    ], { cycleId: 'cycle-maximum-holder-weight' }),
    finalizedReturn: usdg(maximum),
    previousDust: usdg('0'),
  });

  assert.equal(plan.totalAllocated.amountAtomic, maximum);
  assert.equal(plan.dust.amountAtomic, '0');
});

test('preserves the frozen HKMN decimals in allocations and eligible-total evidence', () => {
  const plan = compileDirectPayoutPlan({
    cycleId: 'cycle-nonstandard-hkmn-decimals',
    eligibilityManifest: eligibilityManifest([holder(0, 2, 7), holder(1, 1, 7)], {
      cycleId: 'cycle-nonstandard-hkmn-decimals',
      supply: { chainId: '4663', assetId: TOKEN, decimals: 7, amountAtomic: '3' },
    }),
    finalizedReturn: usdg('3'),
    previousDust: usdg('0'),
  });

  assert.equal(plan.allocations[0].hkmnBalance.decimals, 7);
  assert.deepEqual(plan.totalEligibleHkmn, {
    chainId: 4663,
    assetId: TOKEN,
    decimals: 7,
    amountAtomic: '3',
  });
});

test('rejects ERC-20 amounts above uint256 and a return-plus-dust overflow', () => {
  const maximum = ((1n << 256n) - 1n).toString();
  const tooLarge = (1n << 256n).toString();
  const manifest = eligibilityManifest([holder(0, maximum)], { cycleId: 'cycle-uint256-bounds' });

  assert.throws(
    () => compileDirectPayoutPlan({
      cycleId: 'cycle-uint256-bounds',
      eligibilityManifest: manifest,
      finalizedReturn: usdg(tooLarge),
      previousDust: usdg('0'),
    }),
    /uint256/,
  );
  assert.throws(
    () => compileDirectPayoutPlan({
      cycleId: 'cycle-uint256-bounds',
      eligibilityManifest: manifest,
      finalizedReturn: usdg(maximum),
      previousDust: usdg('1'),
      previousDustSource: dustSource({ cycleId: 'cycle-uint256-source' }),
    }),
    /distributable pool.*uint256/,
  );
  assert.throws(
    () => compileDirectPayoutPlan({
      cycleId: 'cycle-uint256-bounds',
      eligibilityManifest: eligibilityManifest([holder(0, maximum), holder(1, maximum)], { cycleId: 'cycle-uint256-bounds' }),
      finalizedReturn: usdg('1'),
      previousDust: usdg('0'),
    }),
    /uint256/,
  );
});

test('rejects a frozen eligibility manifest that includes an excluded recipient', () => {
  const manifest = eligibilityManifest([holder(0, 1)], {
    cycleId: 'cycle-excluded-recipient',
    exclusions: [{ address: address(0), reason: 'operations-role-history' }],
  });
  assert.throws(
    () => compileDirectPayoutPlan({
      cycleId: 'cycle-excluded-recipient',
      eligibilityManifest: manifest,
      finalizedReturn: usdg('1'),
      previousDust: usdg('0'),
    }),
    /frozen exclusions/,
  );
});

test('uses non-excluded snapshot entries as payout weights while preserving total supply evidence', () => {
  const plan = compileDirectPayoutPlan({
    cycleId: 'cycle-excluded-supply',
    eligibilityManifest: eligibilityManifest([holder(1, 3)], {
      cycleId: 'cycle-excluded-supply',
      supply: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '5' },
      exclusions: [{ address: address(0), reason: 'operations-role-history' }],
    }),
    finalizedReturn: usdg('11'),
    previousDust: usdg('0'),
  });

  assert.deepEqual(plan.totalEligibleHkmn, {
    chainId: 4663,
    assetId: TOKEN,
    decimals: 18,
    amountAtomic: '3',
  });
  assert.deepEqual(plan.allocations.map(({ recipient, amount }) => [recipient, amount.amountAtomic]), [
    [address(1), '11'],
  ]);
});

test('rejects eligibility entries whose aggregate weight exceeds frozen gross supply', () => {
  const manifest = eligibilityManifest([holder(0, 6)], {
    cycleId: 'cycle-eligible-weight-overflow',
    supply: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '5' },
  });
  assert.throws(
    () => compileDirectPayoutPlan({
      cycleId: 'cycle-eligible-weight-overflow',
      eligibilityManifest: manifest,
      finalizedReturn: usdg('1'),
      previousDust: usdg('0'),
    }),
    /aggregate eligible balance exceeds frozen gross supply/,
  );
});

test('keeps the plan digest stable after a canonical persistence reload', () => {
  const plan = compileDirectPayoutPlan({
    cycleId: 'cycle-canonical-plan-reload',
    eligibilityManifest: eligibilityManifest([holder(0, 2), holder(1, 3)], {
      cycleId: 'cycle-canonical-plan-reload',
    }),
    finalizedReturn: usdg('7'),
    previousDust: usdg('0'),
  });

  const reloadedPlan = JSON.parse(canonicalJson(plan));

  assert.equal(directPayoutPlanDigest(reloadedPlan), plan.planDigest);
});

test('refuses a frozen feasibility envelope that cannot support the payout', () => {
  const manifest = eligibilityManifest([holder(0, 1)], {
    cycleId: 'cycle-envelope',
    feasibility: {
      ...eligibilityManifest([holder(0, 1)]).feasibility,
      feasible: false,
      reason: 'native-balance-below-reserve-and-fee',
    },
  });
  assert.throws(
    () => compileDirectPayoutPlan({
      cycleId: 'cycle-envelope',
      eligibilityManifest: manifest,
      finalizedReturn: usdg('1'),
      previousDust: usdg('0'),
    }),
    /feasibility/,
  );
});

test('conserves every atomic unit across deterministic randomized holder sets', () => {
  let seed = 0x12345678;
  const next = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed;
  };

  for (let run = 0; run < 120; run += 1) {
    const count = 1 + (next() % 48);
    const entries = Array.from({ length: count }, (_, index) => holder(index, 1 + (next() % 10_000)));
    const finalizedReturn = String(next() % 1_000_000);
    const previousDust = String(next() % 1_000);
    const input = {
      cycleId: `cycle-fuzz-${run}`,
      eligibilityManifest: eligibilityManifest(entries, { cycleId: `cycle-fuzz-${run}` }),
      finalizedReturn: usdg(finalizedReturn),
      previousDust: usdg(previousDust),
      previousDustSource: previousDust === '0'
        ? null
        : dustSource({ cycleId: `cycle-fuzz-source-${run}` }),
    };
    const first = compileDirectPayoutPlan(input);
    const second = compileDirectPayoutPlan({ ...input, eligibilityManifest: eligibilityManifest([...entries].reverse(), { cycleId: `cycle-fuzz-${run}` }) });
    const paid = first.allocations.reduce((sum, allocation) => sum + BigInt(allocation.amount.amountAtomic), 0n);

    assert.equal(paid + BigInt(first.dust.amountAtomic), BigInt(finalizedReturn) + BigInt(previousDust));
    assert.deepEqual(first.allocations, second.allocations);
    assert.equal(first.planDigest, second.planDigest);
  }
});
