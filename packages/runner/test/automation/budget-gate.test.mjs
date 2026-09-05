import assert from 'node:assert/strict';
import test from 'node:test';

import { decideCycleBudget } from '../../src/automation/budget-gate.mjs';

const input = (overrides = {}) => ({
  availableProcessUsdg: '120000000',
  packPriceUsdg: '50000000',
  outboundCapUsdg: '1000000',
  returnCapUsdg: '1000000',
  operatingMarginUsdg: '3000000',
  activeCycleId: null,
  ...overrides,
});

test('releases exactly the bounded cycle budget at the threshold', () => {
  assert.deepEqual(decideCycleBudget(input({ availableProcessUsdg: '55000000' })), {
    ready: true,
    reason: 'READY',
    requiredProcessUsdg: '55000000',
    releaseAmount: '55000000',
  });
});

test('does not release excess process balance', () => {
  assert.equal(decideCycleBudget(input()).releaseAmount, '55000000');
});

test('waits when finalized process liability is insufficient', () => {
  assert.deepEqual(decideCycleBudget(input({ availableProcessUsdg: '54999999' })), {
    ready: false,
    reason: 'INSUFFICIENT_PROCESS_LIABILITY',
    requiredProcessUsdg: '55000000',
    releaseAmount: '0',
  });
});

test('waits while another cycle owns the process budget', () => {
  assert.deepEqual(decideCycleBudget(input({ activeCycleId: 'cycle-7' })), {
    ready: false,
    reason: 'ACTIVE_CYCLE',
    requiredProcessUsdg: '55000000',
    releaseAmount: '0',
  });
});

test('rejects non-canonical, negative, zero pack, and uint256 overflow inputs', () => {
  assert.throws(() => decideCycleBudget(input({ availableProcessUsdg: '01' })), /canonical/);
  assert.throws(() => decideCycleBudget(input({ outboundCapUsdg: '-1' })), /canonical/);
  assert.throws(() => decideCycleBudget(input({ packPriceUsdg: '0' })), /positive/);
  assert.throws(
    () => decideCycleBudget(input({ availableProcessUsdg: (1n << 256n).toString() })),
    /uint256/,
  );
  assert.throws(
    () => decideCycleBudget(input({
      packPriceUsdg: ((1n << 256n) - 1n).toString(),
      outboundCapUsdg: '1',
      returnCapUsdg: '1',
      operatingMarginUsdg: '1',
    })),
    /overflow/,
  );
});
