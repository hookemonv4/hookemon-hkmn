import test from 'node:test';
import assert from 'node:assert/strict';
import { reconcileLiveEpicGate } from '../../src/app/stages/epic-gate.mjs';
const asset = { chainId: 'solana-mainnet', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
const mint = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
function scenario(cost = '25327249') {
  const records = [];
  const pack = { packIndex: 0, memo: 'memo-held-native', mint, decision: 'hold', offer: { ...asset, amountAtomic: '39' },
    rawInsuredValue: '100', insuredValue: { ...asset, amountAtomic: '100' }, insuredValueUnit: 'atomic',
    instantBuybackPercent: 85, matchedBuybackPercent: 85, prizeTier: '1', rarity: 'epic' };
  return { records, config: { pack: { code: 'pokemon_50' }, collectorCrypt: { settlementAsset: asset } },
    context: { cycleId: 'native-held-cycle' }, adapters: {}, cycleRepository: {
      readOperationalStageAttempt: async () => ({ attempt: { state: 'RESPONSE_RECORDED' }, responseEvidence: { packs: [pack] }, reconciliationEvidence: null }),
      describeCycle: async () => ({ releaseAmount: '10243579001330370', admission: { aggregateFundingUsd: { amountMicroUsd: cost } } }),
      recordHeldPosition: async (cycleId, input) => { records.push(input); return { ...input, positionId: 'held-native', evidenceDigest: `sha256:${'a'.repeat(64)}` }; },
    } };
}
test('held NFT retains conservative aggregate USD purchase basis without a wei principal ledger write', async () => {
  const args = scenario();
  const result = await reconcileLiveEpicGate(args);
  assert.equal(result.packs[0].decision, 'held');
  assert.equal(args.records[0].costMicroUsd, '25327249');
  assert.equal(args.records[0].valueMicroUsd, '25327249');
  assert.equal(args.records[0].insuredValue.amountAtomic, '100');
  assert.equal(Object.hasOwn(args.records[0], 'ledgerAsset'), false);
  assert.equal(Object.hasOwn(args.records[0], 'costMicroUsdg'), false);
});
test('held NFT refuses missing committed USD basis rather than treating native release wei as dollars', async () => {
  const args = scenario(null);
  await assert.rejects(reconcileLiveEpicGate(args), /committed USD purchase cost/);
  assert.equal(args.records.length, 0);
});
