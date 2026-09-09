import test from 'node:test';
import assert from 'node:assert/strict';
import { assertLocalSelectionCommand } from '../src/local-selection-policy.mjs';
const configuration = { paused: true, executionPaused: true, liveMode: false, allowedPackIds: ['pack-a'] };
const command = patch => ({ type: 'update-configuration', configuration: patch });
for (const limit of [100,200,300,400,500,600,700,800,900,1000]) test(`paused service accepts ${limit} without a catalog`, () => {
  assert.doesNotThrow(() => assertLocalSelectionCommand(command({ rewardRecipientLimit: limit }), { configuration }));
});
test('local service rejects invalid values, execution commands and non-paused state', () => {
  for (const value of [null,'200',200.5,0,50,99,101,150,1100]) assert.throws(() => assertLocalSelectionCommand(command({ rewardRecipientLimit: value }), { configuration }));
  for (const value of [{type:'resume'}, command({liveMode:true}), command({allowedPackIds:[]}), command({rewardRecipientLimit:200, maxCyclesPerDay:1})]) assert.throws(() => assertLocalSelectionCommand(value, { configuration }));
  for (const edit of [{paused:false},{executionPaused:false},{liveMode:true}]) assert.throws(() => assertLocalSelectionCommand(command({ rewardRecipientLimit: 200 }), { configuration: {...configuration,...edit} }));
});
test('pack edits preserve catalog membership and safety allowlist checks', () => {
  assert.doesNotThrow(() => assertLocalSelectionCommand(command({ packPlan:{orders:[{pack:'pack-b',quantity:1}]}, allowedPackIds:['pack-a','pack-b'], rewardRecipientLimit:300 }), {configuration,catalogCodes:['pack-a','pack-b']}));
  for (const patch of [{packPlan:{orders:[{pack:'unknown',quantity:1}]}}, {packPlan:{orders:[]},allowedPackIds:[]}, {packPlan:{orders:[]},allowedPackIds:['pack-a','pack-b']}]) assert.throws(() => assertLocalSelectionCommand(command(patch), {configuration,catalogCodes:['pack-a','pack-b']}));
});
