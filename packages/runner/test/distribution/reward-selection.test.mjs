import assert from 'node:assert/strict';
import test from 'node:test';
import { REWARD_RECIPIENT_LIMIT_OPTIONS, DEFAULT_REWARD_RECIPIENT_LIMIT, assertRewardRecipientLimit } from '../../src/config/reward-recipient-selection.mjs';
import { createRewardSelectionSnapshot, assertRewardSelectionSnapshot } from '../../src/automation/reward-selection-snapshot.mjs';
import { buildHolderSnapshot, selectEligibilityRecipients } from '../../src/distribution/snapshot-indexer.mjs';
const address = n => `0x${n.toString(16).padStart(40, '0')}`;
const supply = amountAtomic => ({ chainId: '4663', assetId: address(99999), decimals: 18, amountAtomic });
function fixture(size, limit = 200) {
  const holderSnapshot = buildHolderSnapshot({ chainId: '4663', tokenAddress: address(99999), blockNumber: '42', blockHash: `0x${'1'.repeat(64)}`, finalized: true, totalSupply: String(size + 10), excludedAddresses: [{ address: address(99998), reason: 'operations' }], transferLogs: [...Array.from({ length: size }, (_, i) => ({ blockNumber: '1', logIndex: String(i), from: address(0), to: address(i + 1), value: '1' })), { blockNumber: '1', logIndex: String(size), from: address(0), to: address(99998), value: '10' }] });
  return { holderSnapshot, supply: supply(String(size + 10)), rewardSelection: createRewardSelectionSnapshot({ cycleId: 'cycle-1', configurationRevision: 1, rewardRecipientLimit: limit }) };
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
 assert.equal(plan.schema,'hookemon.direct-payout-plan.v3');
 assert.equal(plan.allocations.length,100);
 assert.equal(plan.totalAllocated.amountAtomic,'100');
 assert.equal(plan.dust.amountAtomic,'1');
 assert.equal(plan.totalEligibleHkmn.amountAtomic,'100');
 assert.deepEqual(plan.eligibility.selection,manifest.selection);
 const zero = compileDirectPayoutPlan(payoutArgs(manifest,'1'));
 assert.equal(zero.allocations.length,100);
 assert.equal(zero.payableRecipientCount,0);
 assert.equal(zero.dust.amountAtomic,'1');
 const supplementary = compileSupplementaryDirectPayoutPlan({...payoutArgs(manifest),supplementaryIndex:1});
 assert.equal(supplementary.schema,'hookemon.supplementary-direct-payout-plan.v3');
 assert.deepEqual(supplementary.payoutPlan.eligibility.selection,manifest.selection);
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
