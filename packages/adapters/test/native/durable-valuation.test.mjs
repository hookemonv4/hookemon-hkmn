import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { createDefaultOperatorConfiguration } from '../../../runner/src/config/state-schema.mjs';
import { createPolicyEngine } from '../../../runner/src/automation/policy-engine.mjs';
import { nativeProducedAdmissionFixture, nativeAdmissionFixture } from './admission-fixture.mjs';
const testAuthority = createTestProfileMutationAuthority();
async function folder(t) { const path = await mkdtemp(join(tmpdir(), 'native-valuation-')); t.after(() => rm(path, { recursive: true, force: true })); return path; }
function engine(repository, now) {
  const config = { ...createDefaultOperatorConfiguration(), liveMode: true, allowedPackIds: ['base-pack'], requestedOrders: 1, maxBoostersPerCycle: 1,
    maxUnitPriceMicroUsd: '55000000', maxCycleBudgetMicroUsd: '55000000', max24HourBudgetMicroUsd: '165000000', perCycleCapMicroUsd: '55000000',
    lossCapMicroUsd: '55000000', maxOutstandingCustodyMicroUsd: '165000000', maxCyclesPerDay: 3 };
  return createPolicyEngine({ now, readConfiguration: async () => config, mutateConfiguration: async () => assert.fail('evaluation does not mutate'),
    verifyQuoteUsdValuation: (value, expected) => repository.isDurableQuoteUsdValuation(value, expected),
    readCustody: async () => ({ realizedLossMicroUsd: '0', atRiskMicroUsd: '0', outstandingMicroUsd: '0', heldAssets: false,
      heldPositions: { count: 0, valueMicroUsd: '0', positions: [] }, unattributed: false, unvaluedExposure: false, cycleExposureMicroUsd: {} }) });
}
test('trusted repository restores original valuation to policy after creation and restart, never JSON or expired evidence', async t => {
  const path = await folder(t); let timestamp = 1_700_000_000_000; const now = () => timestamp;
  const repository = await CycleRepository.open(path, now, { testAuthority });
  const admission = await nativeProducedAdmissionFixture('synthetic-valued');
  const opened = await repository.createCycle({ cycleId: admission.cycleId, releaseAmount: '42', mode: 'production', admission });
  const request = { cycleId: admission.cycleId, packId: 'base-pack', liveMode: true, releaseAmountWei: '42', releaseCostMicroUsd: '35000000', admission: opened.admission };
  assert.equal((await engine(repository, now).evaluateClaim(request)).allowed, true);
  assert.equal(repository.isDurableQuoteUsdValuation(structuredClone(opened.admission.aggregateFundingUsd)), false);
  const restarted = await CycleRepository.open(path, now, { testAuthority });
  const restored = await restarted.readActiveCycle();
  assert.equal((await engine(restarted, now).evaluateClaim({ ...request, admission: restored.admission })).allowed, true);
  assert.equal(restarted.isDurableQuoteUsdValuation(restored.admission.aggregateFundingUsd, { amount: { ...admission.aggregateFundingQuote, amountAtomic: '43' } }), false);
  assert.equal((await engine(restarted, now).evaluateClaim({ ...request, admission: structuredClone(restored.admission) })).reason, 'USD_VALUATION_UNVERIFIED');
  const wrongAuthority = await CycleRepository.open(path, now);
  assert.equal(wrongAuthority.isDurableQuoteUsdValuation((await wrongAuthority.readActiveCycle()).admission.aggregateFundingUsd), false);
  timestamp += 60000;
  assert.equal((await engine(restarted, now).evaluateClaim({ ...request, admission: restored.admission })).reason, 'USD_VALUATION_UNVERIFIED');
  assert.equal(restarted.isDurableQuoteUsdValuation((await restarted.readActiveCycle()).admission.aggregateFundingUsd), false);
});
test('native admission refuses fabricated capabilities, changed raw evidence and copied test authority before journal creation', async t => {
  const path = await folder(t), now = () => 1_700_000_000_000;
  await assert.rejects(CycleRepository.open(path, now, { testAuthority: structuredClone(testAuthority) }), /explicit process test profile/);
  const repository = await CycleRepository.open(path, now, { testAuthority });
  for (const admission of [nativeAdmissionFixture('synthetic-forged'), structuredClone(await nativeProducedAdmissionFixture('synthetic-clone'))]) {
    await assert.rejects(repository.createCycle({ cycleId: admission.cycleId, releaseAmount: '42', mode: 'production', admission }), /producer valuation capabilities/);
  }
  const changed = await nativeProducedAdmissionFixture('synthetic-mutated'); changed.relayQuote.raw.details.currencyIn.amountUsd = '1';
  await assert.rejects(repository.createCycle({ cycleId: changed.cycleId, releaseAmount: '42', mode: 'production', admission: changed }));
  assert.equal(await repository.readActiveCycle(), null);
});
