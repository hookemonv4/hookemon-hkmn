import assert from 'node:assert/strict';
import test from 'node:test';
import { REWARD_RECIPIENT_LIMIT_OPTIONS, DEFAULT_REWARD_RECIPIENT_LIMIT, assertRewardRecipientLimit } from '../../src/config/reward-recipient-selection.mjs';
import { createRewardSelectionSnapshot, assertRewardSelectionSnapshot } from '../../src/automation/reward-selection-snapshot.mjs';
import {
  assertEligibilitySelection,
  assertEligibilitySelectionSummary,
  buildHolderSnapshot,
  selectEligibilityRecipients,
  summarizeEligibilitySelection,
} from '../../src/distribution/snapshot-indexer.mjs';
const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const supply = amountAtomic => ({ chainId: '4663', assetId: address(99999), decimals: 18, amountAtomic });
function fixture(size, limit = 200) {
  const holderSnapshot = buildHolderSnapshot({ chainId: '4663', tokenAddress: address(99999), blockNumber: '42', blockHash: `0x${'1'.repeat(64)}`, finalized: true, totalSupply: String(size + 10), excludedAddresses: [{ address: address(99998), reason: 'operations' }], transferLogs: [...Array.from({ length: size }, (_, i) => ({ blockNumber: '1', logIndex: String(i), from: address(0), to: address(i + 1), value: '1' })), { blockNumber: '1', logIndex: String(size), from: address(0), to: address(99998), value: '10' }] });
  return { holderSnapshot, supply: supply(String(size + 10)), rewardSelection: createRewardSelectionSnapshot({ cycleId: 'cycle-1', configurationRevision: 1, rewardRecipientLimit: limit }) };
}

function largeFixture(size, limit, { shuffled = false, balance = index => (index % 997) + 1 } = {}) {
  const indexes = Array.from({ length: size }, (_, index) => index);
  if (shuffled) {
    for (let index = indexes.length - 1; index > 0; index -= 1) {
      const swap = (index * 7919 + 104729) % (index + 1);
      [indexes[index], indexes[swap]] = [indexes[swap], indexes[index]];
    }
  }
  const transferLogs = indexes.map((index, logIndex) => ({
    blockNumber: '1',
    logIndex: String(logIndex),
    from: address(0),
    to: address(index + 1),
    value: String(balance(index)),
  }));
  const totalHolderBalance = transferLogs.reduce((sum, log) => sum + BigInt(log.value), 0n);
  const holderSnapshot = buildHolderSnapshot({
    chainId: '4663',
    tokenAddress: address(99999),
    blockNumber: '42',
    blockHash: `0x${'1'.repeat(64)}`,
    finalized: true,
    totalSupply: (totalHolderBalance + 10n).toString(),
    excludedAddresses: [{ address: address(999999), reason: 'operations' }],
    transferLogs: [...transferLogs, {
      blockNumber: '1',
      logIndex: String(size),
      from: address(0),
      to: address(999999),
      value: '10',
    }],
  });
  return {
    holderSnapshot,
    supply: supply((totalHolderBalance + 10n).toString()),
    rewardSelection: createRewardSelectionSnapshot({
      cycleId: 'cycle-large',
      configurationRevision: 1,
      rewardRecipientLimit: limit,
    }),
  };
}

function independentlyRankedRecipients(holderSnapshot, limit) {
  return [...holderSnapshot.directBalances]
    .sort((left, right) => {
      const balanceDifference = BigInt(right.directHkmnBalance) - BigInt(left.directHkmnBalance);
      if (balanceDifference !== 0n) return balanceDifference < 0n ? -1 : 1;
      return left.recipient < right.recipient ? -1 : left.recipient > right.recipient ? 1 : 0;
    })
    .slice(0, limit)
    .map(entry => entry.recipient)
    .sort();
}
test('policy admits exactly ten numeric choices', () => {
  assert.deepEqual(REWARD_RECIPIENT_LIMIT_OPTIONS, [100,200,300,400,500,600,700,800,900,1000]);
  assert.equal(DEFAULT_REWARD_RECIPIENT_LIMIT, 200);
  for (const limit of REWARD_RECIPIENT_LIMIT_OPTIONS) assert.equal(assertRewardRecipientLimit(limit), limit);
  for (const limit of [undefined,null,'200',0,99,101,1100,NaN,Infinity,200.5]) assert.throws(() => assertRewardRecipientLimit(limit));
});
for (const limit of [100,200,300,400,500,600,700,800,900,1000]) for (const size of [0,1,99,100,1000,1025]) test(`selection limit ${limit} from ${size} eligible holders`, () => {
  const { entries, selection } = selectEligibilityRecipients(fixture(size, limit));
  assert.equal(entries.length, Math.min(size, limit));
  assert.equal(selection.selectedBalanceTotal.amountAtomic, String(entries.length));
  assert.equal(selection.unselectedEligibleBalanceTotal.amountAtomic, String(size - entries.length));
  assert.equal(selection.excludedBalanceTotal.amountAtomic, '10');
  assert.deepEqual(entries.map(e => e.recipient), Array.from({length: Math.min(size,limit)}, (_, i) => address(i + 1)));
});
test('snapshot binds identity, revision, policy and exact shape', () => {
 const policy = fixture(1).rewardSelection;
 assert.equal(assertRewardSelectionSnapshot(policy, {cycleId:'cycle-1'}), policy);
 for (const change of [{cycleId:'other'},{configurationRevision:2},{rewardRecipientLimit:100},{extra:true},{digest:`sha256:${'0'.repeat(64)}`}]) assert.throws(() => assertRewardSelectionSnapshot({...policy,...change}));
 assert.throws(() => assertRewardSelectionSnapshot(policy,{cycleId:'other'}));
});
test('holder evidence tampering is rejected before selection', () => {
 const value = fixture(101,100);
 for (const change of [{totalExcludedBalance:'11'},{holderSnapshotDigest:`sha256:${'0'.repeat(64)}`},{directBalances:value.holderSnapshot.directBalances.slice(1)}]) assert.throws(() => selectEligibilityRecipients({...value,holderSnapshot:{...value.holderSnapshot,...change}}));
});

import { createEligibilityPayoutManifest } from '../../src/distribution/pro-rata.mjs';
import { compileDirectPayoutPlan, compileSupplementaryDirectPayoutPlan } from '../../src/distribution/payout-plan.mjs';
const native = amountAtomic => ({ chainId: '4663', assetId: 'native', decimals: 18, amountAtomic });
function manifestInput(size = 101) {
  const value = fixture(size,100);
  const { entries, selection } = selectEligibilityRecipients(value);
  return {
    cycleId: 'cycle-1', snapshotBlock: '42', snapshotHash: value.holderSnapshot.blockHash,
    finality: {policyId:'finalized',depth:'2'}, supply:value.supply, entries, selection,
    exclusions:value.holderSnapshot.excludedAddresses, holderSnapshotDigest:value.holderSnapshot.holderSnapshotDigest,
    launchManifestDigest:`sha256:${'2'.repeat(64)}`,
    logCompleteness:{mode:'dual-source',primary:{sourceId:'a',transferLogDigest:`sha256:${'3'.repeat(64)}`,logCount:size+1},secondary:{sourceId:'b',transferLogDigest:`sha256:${'3'.repeat(64)}`,logCount:size+1}},
    feasibility:{recipientCount:entries.length,transactionCount:entries.length,maxRecipientCount:1000,maxTransactionCount:1000,measuredTransferGas:'1',maxGasPriceWei:'1',estimatedNativeFee:native(String(entries.length)),nativeReserve:native('0'),nativeBalance:native('100000'),requiredNativeAmount:native(String(entries.length)),feasible:true,reason:null},
  };
}
function payoutArgs(eligibilityManifest, amount = '101') { return {cycleId:'cycle-1',eligibilityManifest,finalizedReturn:native(amount),previousDust:native('0'),returnBinding:{operations:address(99998),assetId:'native',evidenceDigest:`sha256:${'4'.repeat(64)}`}}; }
test('selected manifest and payout bind evidence while retaining floor-and-carry and supplementary policy', () => {
 const manifest = createEligibilityPayoutManifest(manifestInput());
 assert.equal(manifest.schema,'hookemon.eligibility-payout-manifest.v2');
 const plan = compileDirectPayoutPlan(payoutArgs(manifest));
 assert.equal(plan.schema,'hookemon.direct-payout-plan.v4');
 assert.equal(plan.allocations.length,100);
 assert.equal(plan.totalAllocated.amountAtomic,'100');
 assert.equal(plan.dust.amountAtomic,'1');
 assert.equal(plan.totalEligibleHkmn.amountAtomic,'100');
 assert.equal(plan.eligibility.selection.schema, 'hookemon.reward-selection-summary.v1');
 assert.equal(plan.eligibility.selection.digest, manifest.selection.digest);
 const zero = compileDirectPayoutPlan(payoutArgs(manifest,'1'));
 assert.equal(zero.allocations.length,100);
 assert.equal(zero.payableRecipientCount,0);
 assert.equal(zero.dust.amountAtomic,'1');
 const supplementary = compileSupplementaryDirectPayoutPlan({...payoutArgs(manifest),supplementaryIndex:1});
 assert.equal(supplementary.schema,'hookemon.supplementary-direct-payout-plan.v4');
 assert.equal(supplementary.payoutPlan.eligibility.selection.digest, manifest.selection.digest);
});

test('summaries retain the authenticated selection totals without embedding the holder snapshot', () => {
 const manifest = createEligibilityPayoutManifest(manifestInput());
 const summary = summarizeEligibilitySelection(manifest.selection);
 assert.equal(summary.schema, 'hookemon.reward-selection-summary.v1');
 assert.equal(Object.hasOwn(summary, 'holderSnapshot'), false);
 assert.doesNotThrow(() => assertEligibilitySelectionSummary(summary, manifest));
 for (const mutation of [
   value => ({ ...value, selectedCount: value.selectedCount - 1 }),
   value => ({ ...value, holderSnapshotDigest: `sha256:${'0'.repeat(64)}` }),
   value => ({ ...value, selectedBalanceTotal: supply('99') }),
 ]) {
   assert.throws(() => assertEligibilitySelectionSummary(mutation(summary), manifest));
 }
 const droppedEntryManifest = { ...manifest, entries: manifest.entries.slice(0, -1) };
 assert.throws(() => assertEligibilitySelectionSummary(summary, droppedEntryManifest));
});

test('payout compilation rejects tampered durable full selection evidence', () => {
 const manifest = createEligibilityPayoutManifest(manifestInput());
 const tampered = structuredClone(manifest);
 tampered.selection.holderSnapshot.directBalances[0].directHkmnBalance = '2';
 assert.throws(() => compileDirectPayoutPlan(payoutArgs(tampered)));
});

test('manifest rejects fabricated supply evidence, stale digests, and incorrectly ranked entries', () => {
 const input = manifestInput();
 for (const change of [{selectedCount:99},{eligibleCount:102},{excludedBalanceTotal:supply('11')},{selectedBalanceTotal:supply('99')},{digest:`sha256:${'0'.repeat(64)}`},{extra:true}]) assert.throws(() => createEligibilityPayoutManifest({...input,selection:{...input.selection,...change}}));
 assert.throws(() => createEligibilityPayoutManifest({...input,entries:input.entries.map((entry,i) => i ===99 ? {...entry,recipient:address(101)}:entry)}));
 assert.throws(() => createEligibilityPayoutManifest({...input,exclusions:[]}));
 assert.throws(() => compileDirectPayoutPlan(payoutArgs({...createEligibilityPayoutManifest(input),schema:'hookemon.eligibility-payout-manifest.v1'})));
});
test('legacy v1 manifest still produces unchanged native v2 plan shapes', () => {
 const {selection,...legacy} = manifestInput(1);
 const manifest = createEligibilityPayoutManifest(legacy);
 assert.equal(manifest.schema,'hookemon.eligibility-payout-manifest.v1');
 assert.equal(Object.hasOwn(manifest,'selection'),false);
 const first = compileDirectPayoutPlan(payoutArgs(manifest));
 const second = compileDirectPayoutPlan(payoutArgs(JSON.parse(JSON.stringify(manifest))));
 assert.equal(first.schema,'hookemon.direct-payout-plan.v2');
 assert.equal(Object.hasOwn(first.eligibility,'selection'),false);
 assert.equal(JSON.stringify(first),JSON.stringify(second));
 assert.equal(compileSupplementaryDirectPayoutPlan({...payoutArgs(manifest),supplementaryIndex:1}).schema,'hookemon.supplementary-direct-payout-plan.v2');
});
test('balance rank precedes address and zero balances never enter selected set', () => {
 const value = fixture(101,100);
 const snapshot = buildHolderSnapshot({chainId:'4663',tokenAddress:address(99999),blockNumber:'42',blockHash:value.holderSnapshot.blockHash,finalized:true,totalSupply:'102',excludedAddresses:[],transferLogs:Array.from({length:102},(_,i)=>({blockNumber:'1',logIndex:String(i),from:address(0),to:address(i+1),value:i===100?'2':i===101?'0':'1'}))});
 const result = selectEligibilityRecipients({...value,holderSnapshot:snapshot,supply:supply('102')});
  assert.equal(result.entries.at(-1).recipient,address(101));
  assert.equal(result.entries.some(e=>e.recipient===address(100)),false);
 assert.equal(result.selection.eligibleCount,101);
});

test('selects the independently ranked top 100 from 10,001 positive holders', () => {
  const value = largeFixture(10_001, 100);
  const result = selectEligibilityRecipients(value);
  assert.deepEqual(
    result.entries.map(entry => entry.recipient),
    independentlyRankedRecipients(value.holderSnapshot, 100),
  );
  assert.equal(result.selection.eligibleCount, 10_001);
  assert.equal(result.selection.selectedCount, 100);
  assert.equal(
    BigInt(result.selection.selectedBalanceTotal.amountAtomic)
      + BigInt(result.selection.unselectedEligibleBalanceTotal.amountAtomic)
      + BigInt(result.selection.excludedBalanceTotal.amountAtomic),
    BigInt(value.supply.amountAtomic),
  );

  const manifest = {
    cycleId: 'cycle-large',
    supply: value.supply,
    snapshotBlock: value.holderSnapshot.blockNumber,
    snapshotHash: value.holderSnapshot.blockHash,
    holderSnapshotDigest: value.holderSnapshot.holderSnapshotDigest,
    exclusions: value.holderSnapshot.excludedAddresses,
    entries: result.entries,
  };
  assert.deepEqual(assertEligibilitySelection(result.selection, manifest), result.selection);
  const tampered = {
    ...result.selection,
    holderSnapshot: {
      ...result.selection.holderSnapshot,
      directBalances: result.selection.holderSnapshot.directBalances.map((entry, index) => (
        index === 0 ? { ...entry, directHkmnBalance: (BigInt(entry.directHkmnBalance) + 1n).toString() } : entry
      )),
    },
  };
  assert.throws(() => assertEligibilitySelection(tampered, manifest), /holder snapshot (total holder balance|digest mismatch)/);
});

test('accepts 50,000 tied holders with stable address tie-breaking and shuffled input', () => {
  const startedAt = performance.now();
  const first = selectEligibilityRecipients(largeFixture(50_000, 1000, { balance: () => 1 }));
  const second = selectEligibilityRecipients(largeFixture(50_000, 1000, { shuffled: true, balance: () => 1 }));
  const elapsedMs = performance.now() - startedAt;
  console.log(`50,000-holder selection wall time: ${elapsedMs.toFixed(1)} ms`);
  const expected = Array.from({ length: 1000 }, (_, index) => address(index + 1));
  assert.deepEqual(first.entries.map(entry => entry.recipient), expected);
  assert.deepEqual(second.entries.map(entry => entry.recipient), expected);
  assert.deepEqual(first, second);
});

test('rejects 250,001 positive holders at the holder snapshot bound', () => {
  const startedAt = performance.now();
  assert.throws(
    () => largeFixture(250_001, 100, { balance: () => 1 }),
    /holder snapshot direct balances exceed the limit of 250000/,
  );
  console.log(`250,001-holder bound wall time: ${(performance.now() - startedAt).toFixed(1)} ms`);
});
