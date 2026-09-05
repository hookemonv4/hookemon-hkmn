// Coverage for observability/protocol-fee-monitor.mjs: a nonzero protocol-fee reading fires the alert
// webhook exactly once on the tick it first appears, stays deduplicated on every subsequent tick that
// still reads nonzero, and re-arms if the fee is ever observed back at zero before going nonzero again.
import assert from 'node:assert/strict';
import test from 'node:test';

import { createProtocolFeeMonitor } from '../../src/observability/protocol-fee-monitor.mjs';

function fakeSender() {
  const calls = [];
  return {
    calls,
    send: async alert => {
      calls.push(alert);
      return { delivered: true, attempts: 1, status: 200 };
    },
  };
}

test('a zero protocol fee never fires', async () => {
  const sender = fakeSender();
  const monitor = createProtocolFeeMonitor({ poolId: 'pool-1', send: sender.send });
  const result = await monitor.observe({ protocolFee: 0n });
  assert.deepEqual(result, { fired: false, deduped: false, protocolFee: '0' });
  assert.equal(sender.calls.length, 0);
});

test('a nonzero protocol fee fires on the first tick it appears, exactly once, and is deduplicated on every subsequent tick', async () => {
  const sender = fakeSender();
  const monitor = createProtocolFeeMonitor({ poolId: 'pool-1', send: sender.send });

  const first = await monitor.observe({ protocolFee: 500n });
  assert.equal(first.fired, true);
  assert.equal(first.deduped, false);
  assert.equal(first.protocolFee, '500');
  assert.equal(sender.calls.length, 1);
  assert.equal(sender.calls[0].reason, 'PROTOCOL_FEE_NONZERO');
  assert.equal(sender.calls[0].severity, 'critical');
  assert.equal(sender.calls[0].detail.poolId, 'pool-1');
  assert.equal(sender.calls[0].detail.protocolFee, '500');

  // Same nonzero value on the next tick: still deduplicated.
  const second = await monitor.observe({ protocolFee: 500n });
  assert.deepEqual(second, { fired: false, deduped: true, protocolFee: '500' });

  // A different nonzero value on a later tick: still deduplicated (this is "did the brick condition
  // ever start", not "alert on every value change").
  const third = await monitor.observe({ protocolFee: 900n });
  assert.deepEqual(third, { fired: false, deduped: true, protocolFee: '900' });

  assert.equal(sender.calls.length, 1, 'the alert webhook must fire exactly once, not once per subsequent tick');
});

test('going back to zero re-arms: a second onset after a return to zero fires again', async () => {
  const sender = fakeSender();
  const monitor = createProtocolFeeMonitor({ poolId: 'pool-1', send: sender.send });

  await monitor.observe({ protocolFee: 500n });
  await monitor.observe({ protocolFee: 500n });
  assert.equal(sender.calls.length, 1);

  await monitor.observe({ protocolFee: 0n });
  const result = await monitor.observe({ protocolFee: 500n });
  assert.equal(result.fired, true);
  assert.equal(sender.calls.length, 2);
});

test('accepts bigint, safe-integer number, and canonical decimal string forms of protocolFee', async () => {
  const sender = fakeSender();
  const monitor = createProtocolFeeMonitor({ poolId: 'pool-1', send: sender.send });
  assert.equal((await monitor.observe({ protocolFee: 42 })).protocolFee, '42');
  await monitor.observe({ protocolFee: 0n }); // re-arm
  assert.equal((await monitor.observe({ protocolFee: '99' })).protocolFee, '99');
});

test('rejects a malformed protocolFee value', async () => {
  const sender = fakeSender();
  const monitor = createProtocolFeeMonitor({ poolId: 'pool-1', send: sender.send });
  await assert.rejects(() => monitor.observe({ protocolFee: -1n }), /nonnegative/);
  await assert.rejects(() => monitor.observe({ protocolFee: 'not-a-number' }), /protocol fee must be/);
  await assert.rejects(() => monitor.observe({ protocolFee: 1.5 }), /protocol fee must be/);
  await assert.rejects(() => monitor.observe(null), /protocolFee field/);
});

test('createProtocolFeeMonitor validates its options', () => {
  assert.throws(() => createProtocolFeeMonitor(null), /object/);
  assert.throws(() => createProtocolFeeMonitor({ poolId: '', send: async () => {} }), /poolId/);
  assert.throws(() => createProtocolFeeMonitor({ poolId: 'p', send: 'nope' }), /send must be a function/);
  assert.throws(() => createProtocolFeeMonitor({ poolId: 'p', send: async () => {}, logger: {} }), /logger.error/);
});

test('two monitors for different pools keep independent dedupe state', async () => {
  const senderA = fakeSender();
  const senderB = fakeSender();
  const monitorA = createProtocolFeeMonitor({ poolId: 'pool-a', send: senderA.send });
  const monitorB = createProtocolFeeMonitor({ poolId: 'pool-b', send: senderB.send });

  await monitorA.observe({ protocolFee: 1n });
  await monitorA.observe({ protocolFee: 1n });
  await monitorB.observe({ protocolFee: 1n });

  assert.equal(senderA.calls.length, 1);
  assert.equal(senderB.calls.length, 1);
});

test('reads the canonical pool state through an injected reader without sending a second alert path', async () => {
  const sender = fakeSender();
  const calls = [];
  const monitor = createProtocolFeeMonitor({
    poolId: 'pool-1',
    send: sender.send,
    readPoolState: async poolId => {
      calls.push(poolId);
      return { protocolFee: '0', lpFee: '0' };
    },
  });

  const state = await monitor.read();

  assert.deepEqual(state, { protocolFee: 0n, lpFee: 0n });
  assert.deepEqual(calls, ['pool-1']);
  assert.equal(sender.calls.length, 0);
});
