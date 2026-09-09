import assert from 'node:assert/strict';
import test from 'node:test';
import { planFixture } from './plan-execution-fixture.mjs';
import { assertPolicyAdmission } from '../../../runner/src/automation/policy-engine.mjs';
import { digest } from '../../../runner/src/cycle/journal.mjs';
import { prepareClaimProcessRequest } from '../../src/app/stages/claim-process.mjs';
import { prepareOutboundRequest } from '../../src/app/stages/outbound.mjs';
import { prepareReturnRequest } from '../../src/app/stages/return.mjs';
import { projectCycleAccounting } from '../../src/app/accounting-projection.mjs';

const cycleId = 'cycle-plan-stage';
const eth = { chainId: '4663', assetId: 'native', decimals: 18 };
const sol = { chainId: '792703809', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
const amount = (asset, amountAtomic) => ({ ...asset, amountAtomic });
const config = {
  solana: { chainId: 'solana-mainnet' }, collectorCrypt: { settlementAsset: { ...sol, chainId: 'solana-mainnet' } },
  chainId: 4663, contracts: { hook: `0x${'1'.repeat(40)}` },
  accounts: { evm: '0xb54aaf746eb1e80afdb5eb0992a75b08db2e4384', solana: 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE' },
  relay: { solanaMint: sol.assetId, evmDepository: `0x${'2'.repeat(40)}` },
  moneyConfiguration: {
    schema: 'hookemon.money-configuration.v2', assets: { eth, solanaStablecoin: sol },
    minimums: { robinhoodReceive: amount(eth, '0'), returnEth: amount(eth, '0'), solanaReceive: amount(sol, '0') },
    evm: { perTransactionGasPriceCap: amount(eth, '100'), nativeReserve: amount(eth, '200') },
    solana: { priorityFeeCap: amount({ chainId: sol.chainId, assetId: 'microlamports-per-compute-unit', decimals: 0 }, '100'),
      lamportReserve: amount({ chainId: sol.chainId, assetId: 'native', decimals: 9 }, '200') },
  },
};
async function fixture() {
  const admission = assertPolicyAdmission(await planFixture().planner.plan({ cycleId,
    packPlan: { schema: 'hookemon.pack-plan.v1', revision: 1, orders: [{ pack: 'base-pack', quantity: 2 }, { pack: 'premium-pack', quantity: 1 }] } }));
  const description = { admission, releaseAmount: admission.aggregateFundingQuote.amountAtomic,
    custodyLedgers: new Map(), relayLegs: new Map(), heldPositions: new Map([['held', {}]]) };
  const repository = { describeCycle: async () => description, readStage: async () => ({ status: 'COMPLETE', evidence: null }),
    readClaimPreconditions: async () => ({}), readStageAttempt: async () => null };
  return { admission, description, repository };
}

test('validated plan admission retains native claim, zero-proceeds return and typed accounting', async () => {
  const { repository, description } = await fixture();
  const claim = await prepareClaimProcessRequest({ config, cycleRepository: repository, context: { cycleId } });
  assert.equal(claim.amount.assetId, 'native');
  assert.equal(claim.amount.amountAtomic, description.releaseAmount);
  const returned = await prepareReturnRequest({ adapters: { relay: {} }, config, cycleRepository: repository, context: { cycleId }, nowMs: 1700000000000 });
  assert.equal(returned.schema, 'hookemon.return-zero-proceeds-request.v2');
  assert.equal(returned.destinationAmount.assetId, 'native');
  const accounting = await projectCycleAccounting({ cycleRepository: repository, cycleId });
  assert.equal(accounting.schema, 'hookemon.native-round-accounting.v1');
  assert.equal(accounting.releaseAmount.units, description.releaseAmount);
  assert.equal(Object.hasOwn(accounting, 'packSpendMicroUsdg'), false);
});

test('expired plan aggregate records every ordered unit quote without substituting a quote', async () => {
  const { admission, repository } = await fixture();
  let evidence;
  repository.recordOutboundQuoteExpired = async (_id, value) => { evidence = value; };
  const observedAtMs = 2000000000001;
  await assert.rejects(prepareOutboundRequest({ adapters: { relay: {} }, config, cycleRepository: repository, context: { cycleId }, nowMs: observedAtMs }));
  assert.deepEqual(evidence, {
    schema: 'hookemon.outbound-quote-expiry-evidence.v2', cycleId, admissionDigest: digest(admission),
    aggregateQuote: { requestId: admission.relay.requestId, deadlineUnixSeconds: admission.relay.deadlineUnixSeconds, quoteDigest: admission.relay.quoteDigest },
    unitQuotes: admission.orders.map(order => ({ requestId: order.unitRelay.requestId, deadlineUnixSeconds: order.unitRelay.deadlineUnixSeconds, quoteDigest: order.unitRelay.quoteDigest })),
    observedAtMs,
  });
});

test('outbound rejects a wrong unit funding identity or zero purchase in any plan order', async () => {
  for (const mutate of [a => { a.orders[1].unitFundingQuote.assetId = 'wrong'; }, a => { a.orders[1].unitPurchase.amountAtomic = '0'; }]) {
    const { admission, description, repository } = await fixture();
    description.admission = structuredClone(admission);
    mutate(description.admission);
    let recorded = false;
    repository.recordOutboundQuoteExpired = async () => { recorded = true; };
    await assert.rejects(prepareOutboundRequest({ adapters: { relay: {} }, config, cycleRepository: repository, context: { cycleId }, nowMs: 1700000000000 }), /unit funding quote|positive/);
    assert.equal(recorded, false);
  }
});


test('expired unit quote vetoes outbound while aggregate quote remains fresh', async () => {
  const admission = assertPolicyAdmission(await planFixture({ unitDeadlineUnixSeconds: 1700000060 }).planner.plan({ cycleId,
    packPlan: { schema: 'hookemon.pack-plan.v1', revision: 1, orders: [{ pack: 'base-pack', quantity: 2 }, { pack: 'premium-pack', quantity: 1 }] } }));
  let expiry;
  const repository = { describeCycle: async () => ({ admission, releaseAmount: admission.aggregateFundingQuote.amountAtomic }),
    readOutboundQuoteRefresh: async () => null, recordOutboundQuoteExpired: async (_id, evidence) => { expiry = evidence; } };
  const nowMs = 1700000060001;
  assert.ok(nowMs < admission.relay.deadlineUnixSeconds * 1000);
  await assert.rejects(prepareOutboundRequest({ adapters: { relay: {} }, config, cycleRepository: repository, context: { cycleId }, nowMs }), /expired/);
  assert.equal(expiry.unitQuotes.length, 2);
});
