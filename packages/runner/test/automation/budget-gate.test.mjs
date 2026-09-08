import assert from 'node:assert/strict';
import test from 'node:test';

import { decideCycleBudget } from '../../src/automation/budget-gate.mjs';

const input = (overrides = {}) => ({
  availableProcessWei: '120000000',
  packPriceWei: '50000000',
  outboundCapWei: '1000000',
  returnCapWei: '1000000',
  operatingMarginWei: '3000000',
  activeCycleId: null,
  ...overrides,
});

test('releases exactly the bounded cycle budget at the threshold', () => {
  assert.deepEqual(decideCycleBudget(input({ availableProcessWei: '55000000' })), {
    ready: true,
    reason: 'READY',
    requiredProcessWei: '55000000',
    releaseAmount: '55000000',
  });
});

test('does not release excess process balance', () => {
  assert.equal(decideCycleBudget(input()).releaseAmount, '55000000');
});

test('waits when finalized process liability is insufficient', () => {
  assert.deepEqual(decideCycleBudget(input({ availableProcessWei: '54999999' })), {
    ready: false,
    reason: 'INSUFFICIENT_PROCESS_LIABILITY',
    requiredProcessWei: '55000000',
    releaseAmount: '0',
  });
});

test('waits while another cycle owns the process budget', () => {
  assert.deepEqual(decideCycleBudget(input({ activeCycleId: 'cycle-7' })), {
    ready: false,
    reason: 'ACTIVE_CYCLE',
    requiredProcessWei: '55000000',
    releaseAmount: '0',
  });
});

test('rejects non-canonical, negative, zero pack, and uint256 overflow inputs', () => {
  assert.throws(() => decideCycleBudget(input({ availableProcessWei: '01' })), /canonical/);
  assert.throws(() => decideCycleBudget(input({ outboundCapWei: '-1' })), /canonical/);
  assert.throws(() => decideCycleBudget(input({ packPriceWei: '0' })), /positive/);
  assert.throws(
    () => decideCycleBudget(input({ availableProcessWei: (1n << 256n).toString() })),
    /uint256/,
  );
  assert.throws(
    () => decideCycleBudget(input({
      packPriceWei: ((1n << 256n) - 1n).toString(),
      outboundCapWei: '1',
      returnCapWei: '1',
      operatingMarginWei: '1',
    })),
    /overflow/,
  );
});
