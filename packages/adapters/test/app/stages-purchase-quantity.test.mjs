// Focused coverage for BOT-PACK-QUANTITY: the durably admitted cycle's own quantity is the one
// authoritative source for how many packs preparePurchaseRequest requests, not a second competing
// config knob. See pack-quantity-report.md (coordination directory) for the verified production
// defect this closes: config.pack.quantity has no environment producer, so it always defaulted to
// 1 while a real admission could carry a different requestedOrders-derived quantity.
//
// Corrected per pack-quantity-review.md (P1, P2): a missing admission is now refused, not
// defaulted, in the composed production execution profile; this file's earlier "changed
// requestedOrders" test is renamed and reworded below because it never modeled a live operator
// configuration change, and the real live-config-drift behavior (QUANTITY_MISMATCH at the
// claim/purchase policy boundary, packages/runner/src/automation/policy-engine.mjs) is
// immutable-but-refused, not "unaffected" -- that policy semantics is unchanged here and is out
// of this file's scope.
import assert from 'node:assert/strict';
import test from 'node:test';

import { preparePurchaseRequest, probePurchase } from '../../src/app/stages/purchase.mjs';
import { MAXIMUM_PACK_BATCH_SIZE } from '../../../runner/src/cycle/money-schemas.mjs';

const OPERATOR = 'AKnL4NNf3DGWZJS6cPknBuEGnVsV4A4m5tgebLHaRSZ9';
const PACK_TYPE = 'pokemon_25';

function typedAmount(amountAtomic) {
  return { chainId: 'solana-mainnet', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, amountAtomic };
}

function admission({ packId = PACK_TYPE, quantity, unitAtomic = '8' }) {
  return {
    packId,
    quantity,
    unitPurchase: typedAmount(unitAtomic),
    aggregatePurchase: typedAmount((BigInt(unitAtomic) * BigInt(quantity)).toString()),
  };
}

/** Cycle repository fake: one fixed record per cycleId, replayed unchanged on every call -- models
 * only that `preparePurchaseRequest` rereads the exact same durable record for a given cycleId
 * (restart/retry safety at this layer). It does not model the policy engine's own live
 * `requestedOrders` reevaluation or its QUANTITY_MISMATCH refusal; that is a different module and
 * out of this file's scope. */
function repositoryWithAdmissions(admissionsByCycleId) {
  return {
    async describeCycle(cycleId) {
      const cycleAdmission = admissionsByCycleId[cycleId];
      return cycleAdmission === undefined ? { admission: null } : { admission: cycleAdmission };
    },
  };
}

function config(overrides = {}) {
  return {
    accounts: { solana: OPERATOR },
    pack: { code: PACK_TYPE },
    ...overrides,
  };
}

const CATALOG_ADAPTERS = {
  collectorCrypt: {
    async getMachines() { return { machines: [{ code: PACK_TYPE, contains: 1 }] }; },
  },
};

test('quantity 1: an admitted single-pack cycle resolves to the admission\'s own quantity', async () => {
  const cycleRepository = repositoryWithAdmissions({ 'cycle-1': admission({ quantity: 1 }) });
  const request = await preparePurchaseRequest({
    adapters: CATALOG_ADAPTERS, config: config(), cycleRepository, context: { cycleId: 'cycle-1' },
  });
  assert.equal(request.quantity, 1);
  assert.equal(request.unitPurchase.amountAtomic, '8');
  assert.equal(request.aggregatePurchase.amountAtomic, '8');
});

test('quantity 2: an admitted two-pack cycle resolves to 2, not config.pack.quantity\'s unset default', async () => {
  const cycleRepository = repositoryWithAdmissions({ 'cycle-2': admission({ quantity: 2 }) });
  const request = await preparePurchaseRequest({
    adapters: CATALOG_ADAPTERS, config: config(), cycleRepository, context: { cycleId: 'cycle-2' },
  });
  assert.equal(request.quantity, 2);
  assert.equal(request.aggregatePurchase.amountAtomic, '16');
});

// This is purchase-stage defense-in-depth (replay/corruption safety), not the cycle's pre-cycle
// ceiling: purchase is the fourth operational stage, after claim-process and outbound, so a
// request reaching here could already have spent. The pre-cycle enforcement point is
// packages/runner/src/automation/policy-engine.mjs's `normalizePolicyAdmission`, covered by its
// own focused test in packages/runner/test/automation/policy-engine.test.mjs.
test('limit: an admitted quantity above the shared batch bound is refused at the purchase stage', async () => {
  const cycleRepository = repositoryWithAdmissions({
    'cycle-over': admission({ quantity: MAXIMUM_PACK_BATCH_SIZE + 1 }),
  });
  await assert.rejects(
    preparePurchaseRequest({
      adapters: CATALOG_ADAPTERS, config: config(), cycleRepository, context: { cycleId: 'cycle-over' },
    }),
    /admitted quantity must be an integer from 1 through/,
  );
});

test('restart/frozen admission: repeated prepare calls against the same cycle resolve the identical quantity and bounds', async () => {
  const cycleRepository = repositoryWithAdmissions({ 'cycle-restart': admission({ quantity: 2 }) });
  const first = await preparePurchaseRequest({
    adapters: CATALOG_ADAPTERS, config: config(), cycleRepository, context: { cycleId: 'cycle-restart' },
  });
  // A later tick (or a full process restart) re-invokes prepareRequest against the exact same
  // durable cycle; this must reread the same frozen admission and never drift.
  const second = await preparePurchaseRequest({
    adapters: CATALOG_ADAPTERS, config: config(), cycleRepository, context: { cycleId: 'cycle-restart' },
  });
  assert.deepEqual(first, second);
  assert.equal(second.quantity, 2);
});

// Renamed from an earlier "changed requestedOrders ... does not alter an earlier admitted cycle"
// framing per pack-quantity-review.md P2: this fixture never drives a live operator configuration
// change, so it cannot and does not establish what happens to an *in-flight* cycle when
// requestedOrders changes underneath it. What it does establish, at this layer only: two distinct
// durable cycle records, each with its own already-written admission, are read independently by
// cycleId -- one cycle's record is not consulted when resolving another's. Whether a live
// requestedOrders change is refused (QUANTITY_MISMATCH, immutable-but-refused) or ignored for an
// already-admitted cycle is a policy-engine.mjs question this test does not touch; per
// pack-quantity-review.md, the existing live behavior there is immutable-but-refused and is
// unchanged by this task.
test('cycle-scoped admission: preparing one cycle never reads or resolves another cycle\'s admitted quantity', async () => {
  const cycleRepository = repositoryWithAdmissions({
    'cycle-a': admission({ quantity: 2 }),
    'cycle-b': admission({ quantity: 5 }),
  });
  const replayed = await preparePurchaseRequest({
    adapters: CATALOG_ADAPTERS, config: config(), cycleRepository, context: { cycleId: 'cycle-a' },
  });
  assert.equal(replayed.quantity, 2);
  const later = await preparePurchaseRequest({
    adapters: CATALOG_ADAPTERS, config: config(), cycleRepository, context: { cycleId: 'cycle-b' },
  });
  assert.equal(later.quantity, 5);
});

test('explicit contradictory quantity: an explicitly configured config.pack.quantity that disagrees with the admission is refused', async () => {
  const cycleRepository = repositoryWithAdmissions({ 'cycle-conflict': admission({ quantity: 2 }) });
  await assert.rejects(
    preparePurchaseRequest({
      adapters: CATALOG_ADAPTERS,
      config: config({ pack: { code: PACK_TYPE, quantity: 3 } }),
      cycleRepository,
      context: { cycleId: 'cycle-conflict' },
    }),
    /purchase prepareRequest quantity does not match the admitted quantity/,
  );
});

test('explicit quantity matching the admission is accepted (not a competing source, just consistent)', async () => {
  const cycleRepository = repositoryWithAdmissions({ 'cycle-match': admission({ quantity: 2 }) });
  const request = await preparePurchaseRequest({
    adapters: CATALOG_ADAPTERS,
    config: config({ pack: { code: PACK_TYPE, quantity: 2 } }),
    cycleRepository,
    context: { cycleId: 'cycle-match' },
  });
  assert.equal(request.quantity, 2);
});

// pack-quantity-review.md P1: a missing admission is a production invariant failure, not
// permission to construct an unpriced one-pack request. The catalog spy proves the refusal
// happens before catalog access (and therefore before policy authorization, signer, or provider
// mutation, which all sit later in the stage).
function spyCatalogAdapters() {
  let called = false;
  return {
    calledGetMachines: () => called,
    adapters: { collectorCrypt: { async getMachines() { called = true; return { machines: [{ code: PACK_TYPE, contains: 1 }] }; } } },
  };
}

test('production execution profile: a missing admission is refused before catalog access, not defaulted to an unpriced request (no cycle scope at all)', async () => {
  const { adapters, calledGetMachines } = spyCatalogAdapters();
  await assert.rejects(
    preparePurchaseRequest({ adapters, config: config({ execution: { profile: 'production' } }) }),
    /purchase prepareRequest requires a durable cycle admission in the production execution profile/,
  );
  assert.equal(calledGetMachines(), false);
});

test('production execution profile: a real cycle record whose admission is null is refused before catalog access', async () => {
  const { adapters, calledGetMachines } = spyCatalogAdapters();
  const cycleRepository = repositoryWithAdmissions({});
  await assert.rejects(
    preparePurchaseRequest({
      adapters, config: config({ execution: { profile: 'production' } }), cycleRepository, context: { cycleId: 'cycle-legacy-no-admission' },
    }),
    /purchase prepareRequest requires a durable cycle admission in the production execution profile/,
  );
  assert.equal(calledGetMachines(), false);
});

test('non-production execution profile (rehearsal): a missing admission still falls back to the bounded default, unaffected by the production refusal', async () => {
  const request = await preparePurchaseRequest({
    adapters: CATALOG_ADAPTERS, config: config({ execution: { profile: 'rehearsal' } }),
  });
  assert.equal(request.quantity, 1);
});

test('genuinely unadmitted dry-run: quantity defaults to the bounded default of 1 with no cycle repository at all', async () => {
  const request = await preparePurchaseRequest({ adapters: CATALOG_ADAPTERS, config: config() });
  assert.equal(request.quantity, 1);
});

test('genuinely unadmitted dry-run: quantity defaults to the bounded default of 1 when the cycle repository has no admission for it', async () => {
  const cycleRepository = repositoryWithAdmissions({});
  const request = await preparePurchaseRequest({
    adapters: CATALOG_ADAPTERS, config: config(), cycleRepository, context: { cycleId: 'cycle-unknown' },
  });
  assert.equal(request.quantity, 1);
});

test('probePurchase (standalone dry-run, no cycle context) still bounds an unset quantity to 1', async () => {
  const adapters = {
    collectorCrypt: {
      async getMachines() { return { machines: [{ code: PACK_TYPE, contains: 1 }] }; },
      async getStatus() { return { machineStatus: 'ok', gachas: [] }; },
    },
  };
  const evidence = await probePurchase({ adapters, config: config() });
  assert.equal(evidence.quantity, 1);
});

test('explicit quantity above the shared batch bound is refused even with no admission at all (existing behaviour preserved)', async () => {
  await assert.rejects(
    preparePurchaseRequest({
      adapters: CATALOG_ADAPTERS,
      config: config({ pack: { code: PACK_TYPE, quantity: MAXIMUM_PACK_BATCH_SIZE + 1 } }),
    }),
    /config\.pack\.quantity must be an integer from 1 through/,
  );
});

test('admitted pack does not match the configured pack code: refused before quantity is even considered', async () => {
  const cycleRepository = repositoryWithAdmissions({ 'cycle-wrong-pack': admission({ packId: 'other_pack', quantity: 2 }) });
  await assert.rejects(
    preparePurchaseRequest({
      adapters: CATALOG_ADAPTERS, config: config(), cycleRepository, context: { cycleId: 'cycle-wrong-pack' },
    }),
    /purchase prepareRequest pack does not match the admitted pack/,
  );
});
