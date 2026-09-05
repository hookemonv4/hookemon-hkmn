import assert from 'node:assert/strict';
import test from 'node:test';

import { planFeeSettlements, verifyFeeSettlement } from '../../src/automation/fee-settlement.mjs';

const programmable = '0x0000000000000000000000000000000000005000';
const treasury = '0x0000000000000000000000000000000000006000';
const canonicalUsdg = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const hookSource = '0x0000000000000000000000000000000000007000';

const snapshot = (overrides = {}) => ({
  asset: canonicalUsdg,
  source: hookSource,
  programmable: { beneficiary: programmable, amount: '1000', claimAuthorityAvailable: true },
  treasuries: [{ beneficiary: treasury, amount: '4000', claimAuthorityAvailable: true }],
  processLiability: '25000',
  ...overrides,
});

const independentEvidence = receipt => ({
  chainReceipt: {
    transactionId: receipt.transactionId,
    status: 'SUCCESS',
    finalized: true,
    asset: receipt.asset,
    source: receipt.source,
    destination: receipt.destination,
    amount: receipt.amount,
  },
  credit: {
    asset: receipt.asset,
    source: receipt.source,
    destination: receipt.destination,
    amount: receipt.amount,
    beforeBalance: '0',
    afterBalance: receipt.amount,
  },
});

test('plans only beneficiary-owned fixed-destination claims', () => {
  const plans = planFeeSettlements(snapshot());
  assert.equal(plans.length, 2);
  assert.deepEqual(plans.map(plan => [plan.kind, plan.destination, plan.amount, plan.status]), [
    ['PROGRAMMABLE', programmable, '1000', 'READY'],
    ['TREASURY', treasury, '4000', 'READY'],
  ]);
  assert.equal(JSON.stringify(plans).includes('25000'), false);
});

test('keeps missing beneficiary authority pending instead of fabricating payment', () => {
  const [plan] = planFeeSettlements(snapshot({
    programmable: { beneficiary: programmable, amount: '1000', claimAuthorityAvailable: false },
    treasuries: [],
  }));
  assert.equal(plan.status, 'PENDING_BENEFICIARY_AUTHORITY');
  const receipt = {
    kind: 'PROGRAMMABLE',
    beneficiary: programmable,
    destination: programmable,
    asset: canonicalUsdg,
    source: hookSource,
    amount: '1000',
    transactionId: '0xtx',
    status: 'SUCCESS',
    finalized: true,
  };
  assert.throws(() => verifyFeeSettlement(receipt, plan, independentEvidence(receipt)), /authority/);
});

test('rejects redirected, changed, failed, and unfinalized settlement receipts', () => {
  const [plan] = planFeeSettlements(snapshot());
  const receipt = {
    kind: 'PROGRAMMABLE',
    beneficiary: programmable,
    destination: programmable,
    asset: canonicalUsdg,
    source: hookSource,
    amount: '1000',
    transactionId: '0xtx',
    status: 'SUCCESS',
    finalized: true,
  };
  assert.equal(verifyFeeSettlement(receipt, plan, independentEvidence(receipt)).transactionId, '0xtx');
  assert.throws(() => verifyFeeSettlement({ ...receipt, destination: treasury }, plan, independentEvidence(receipt)), /destination/);
  assert.throws(() => verifyFeeSettlement({ ...receipt, asset: treasury }, plan, independentEvidence({ ...receipt, asset: treasury })), /asset/);
  assert.throws(() => verifyFeeSettlement({ ...receipt, source: treasury }, plan, independentEvidence({ ...receipt, source: treasury })), /source/);
  assert.throws(() => verifyFeeSettlement({ ...receipt, amount: '999' }, plan, independentEvidence(receipt)), /amount/);
  assert.throws(() => verifyFeeSettlement({ ...receipt, status: 'FAILED' }, plan, independentEvidence(receipt)), /success/);
  assert.throws(() => verifyFeeSettlement({ ...receipt, finalized: false }, plan, independentEvidence(receipt)), /finalized/);
});

test('requires independently fetched finalized chain and credit evidence', () => {
  const [plan] = planFeeSettlements(snapshot());
  const receipt = {
    kind: 'PROGRAMMABLE',
    beneficiary: programmable,
    destination: programmable,
    asset: canonicalUsdg,
    source: hookSource,
    amount: '1000',
    transactionId: '0xtx',
    status: 'SUCCESS',
    finalized: true,
  };
  assert.throws(() => verifyFeeSettlement(receipt, plan), /chain|evidence/);
});
