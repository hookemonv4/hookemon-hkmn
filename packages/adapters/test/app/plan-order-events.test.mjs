import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { assertPolicyAdmission } from '../../../runner/src/automation/policy-engine.mjs';
import { planFixture } from './plan-execution-fixture.mjs';
const now = () => 1_700_000_000_000;
const selected = () => ({ schema: 'hookemon.pack-plan.v1', revision: 2,
  orders: [{ pack: 'base-pack', quantity: 2 }, { pack: 'premium-pack', quantity: 1 }] });
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-order-events-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = await CycleRepository.open(directory, now, { testAuthority: createTestProfileMutationAuthority() });
  const admission = await planFixture().planner.plan({ cycleId: 'cycle-orders', packPlan: selected() });
  await repository.createCycle({ cycleId: admission.cycleId, releaseAmount: admission.aggregateFundingQuote.amountAtomic,
    mode: 'rehearsal', admission, packPlan: selected() });
  await repository.recordStageRequestDigest(admission.cycleId, 'purchase', `sha256:${'a'.repeat(64)}`);
  return { directory, repository, admission };
}
const intent = (packType, quantity) => ({ packType, quantity, expectedCardCountPerPack: 1,
  playerAddress: 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE' });
const pack = (packIndex, packType, memo = `memo-${packIndex}`) => ({ packIndex, packType, memo, expectedCardCount: 1 });
const requestDigest = `sha256:${'a'.repeat(64)}`;

test('planner binds independent unit quotes and one full plan aggregate', async () => {
  const admission = await planFixture().planner.plan({ cycleId: 'cycle-prices', packPlan: selected() });
  const checked = assertPolicyAdmission(admission);
  assert.equal(checked.quantity, 3);
  assert.equal(checked.aggregatePurchase.amountAtomic, '4000000');
  assert.deepEqual(checked.orders.map(order => order.unitPurchase.amountAtomic), ['1000000', '2000000']);
  assert.equal(checked.orders[0].unitRelay.requestId, 'req-1');
  assert.equal(checked.orders[1].unitRelay.requestId, 'req-2');
  assert.equal(checked.relay.requestId, 'req-3');
});
test('order intents and responses survive restart without replacing partial generation', async t => {
  const { directory, repository, admission } = await fixture(t);
  await assert.rejects(repository.recordPackOrderIntent('cycle-orders', 1, intent('premium-pack', 1), requestDigest), /sequence/);
  await repository.recordPackOrderIntent('cycle-orders', 0, intent('base-pack', 2), requestDigest);
  await repository.recordPackOrderRequest('cycle-orders', 0, [pack(0, 'base-pack'), pack(1, 'base-pack')]);
  const restarted = await CycleRepository.open(directory, now, { testAuthority: createTestProfileMutationAuthority() });
  assert.equal((await restarted.readPackBatchRequest('cycle-orders', 'purchase')).generationComplete, false);
  const restored = await restarted.describeCycle('cycle-orders');
  assert.deepEqual(restored.packPlanSnapshot.plan, admission.packPlan);
  for (const unit of restored.admission.orders) assert.equal(restarted.isDurableQuoteUsdValuation(unit.unitFundingUsd), true);
  assert.equal(restarted.isDurableQuoteUsdValuation(restored.admission.aggregateFundingUsd), true);
  await restarted.recordPackOrderIntent('cycle-orders', 1, intent('premium-pack', 1), requestDigest);
  await assert.rejects(restarted.recordPackOrderRequest('cycle-orders', 1, [pack(2, 'premium-pack', 'memo-0')]), /unique/);
  await restarted.recordPackOrderRequest('cycle-orders', 1, [pack(2, 'premium-pack')]);
  const complete = await restarted.readPackBatchRequest('cycle-orders', 'purchase');
  assert.equal(complete.generationComplete, true);
  assert.equal(complete.packs.length, 3);
  await restarted.recordPackOrderRequest('cycle-orders', 1, [pack(2, 'premium-pack')]);
  await assert.rejects(restarted.recordPackOrderRequest('cycle-orders', 1, [pack(2, 'premium-pack', 'different-memo')]), /conflicts/);
});
test('order response requires intent and exact admitted pack, quantity and index', async t => {
  const { repository } = await fixture(t);
  await assert.rejects(repository.recordPackOrderRequest('cycle-orders', 0, [pack(0, 'base-pack')]), /intent/);
  await assert.rejects(repository.recordPackOrderIntent('cycle-orders', 0, intent('premium-pack', 2), requestDigest), /admission/);
  await repository.recordPackOrderIntent('cycle-orders', 0, intent('base-pack', 2), requestDigest);
  await assert.rejects(repository.recordPackOrderRequest('cycle-orders', 0, [pack(0, 'base-pack')]), /quantity/);
  await assert.rejects(repository.recordPackOrderRequest('cycle-orders', 0, [pack(0, 'base-pack'), pack(2, 'base-pack')]), /identity/);
  await assert.rejects(repository.recordPackBatchIntent('cycle-orders', 'purchase', intent('base-pack', 2)), /legacy/);
});


test('stored expiry evidence binds all plan unit identities and rejects omission', async t => {
  const { directory, admission } = await fixture(t);
  const repository = await CycleRepository.open(directory, () => 2_000_000_000_001, { testAuthority: createTestProfileMutationAuthority() });
  const identity = quote => ({ requestId: quote.requestId, deadlineUnixSeconds: quote.deadlineUnixSeconds, quoteDigest: quote.quoteDigest });
  const { digest } = await import('../../../runner/src/cycle/journal.mjs');
  const evidence = { schema: 'hookemon.outbound-quote-expiry-evidence.v2', cycleId: admission.cycleId,
    admissionDigest: digest(assertPolicyAdmission(admission)), aggregateQuote: identity(admission.relay),
    unitQuotes: admission.orders.map(order => identity(order.unitRelay)), observedAtMs: 2_000_000_000_001 };
  await assert.rejects(repository.recordOutboundQuoteExpired(admission.cycleId, { ...evidence, unitQuotes: evidence.unitQuotes.slice(0, 1) }), /unitQuote/);
  await repository.recordOutboundQuoteExpired(admission.cycleId, evidence);
  assert.equal((await repository.readOutboundQuoteRefresh(admission.cycleId)).state, 'REFRESH_REQUIRED');
});
