import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  NativeBridgePolicyError,
  executeNativeBridge,
  monitorNativeBridge,
  planNativeBridge,
  validateBridgeQuote,
} from '../../src/ops/native-bridge.mjs';
import { createFileState, parseArgs, toKeychainSignRequest } from '../../bin/hookemon-bridge-native.mjs';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const RELAY_ADDRESS = '0x2222222222222222222222222222222222222222';
const NATIVE_ASSET = '0x0000000000000000000000000000000000000000';

function quoteFor(amount, overrides = {}) {
  return {
    requestId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    details: {
      sender: ADDRESS,
      recipient: ADDRESS,
      currencyIn: { currency: { chainId: 1, address: NATIVE_ASSET, decimals: 18 }, amount },
      currencyOut: { currency: { chainId: 4663, address: NATIVE_ASSET, decimals: 18 }, amount: '1900000000000000' },
    },
    protocol: { v2: { orderData: { deadline: '4102444800' } } },
    steps: [{
      id: 'deposit',
      kind: 'transaction',
      requestId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      items: [{ data: {
        from: ADDRESS,
        to: RELAY_ADDRESS,
        data: '0x12345678',
        value: amount,
        chainId: 1,
        maxFeePerGas: '100',
        maxPriorityFeePerGas: '2',
      } }],
    }],
    ...overrides,
  };
}

function planningFakes() {
  return {
    signer: { showAddress: async () => ADDRESS },
    originRpc: {
      getBalance: async () => '2000000000000000',
      getFeeData: async () => ({ maxFeePerGas: '100' }),
      estimateGas: async () => '21000',
    },
    relay: { quote: async ({ amount }) => quoteFor(amount) },
  };
}

test('plans a max native bridge after reserving the margin-adjusted origin-chain gas cost', async () => {
  const plan = await planNativeBridge({ amount: 'max', ...planningFakes() });

  assert.equal(plan.amount.amountAtomic, '1999999994960000');
  assert.equal(plan.gas.limit, '25200');
  assert.equal(plan.gas.maxFeePerGas.amountAtomic, '100');
  assert.equal(plan.gas.reserve.amountAtomic, '5040000');
  assert.equal(plan.destination.amount.chainId, '4663');
});

test('plans max below the balance so gas estimation succeeds for a 0.002 native-asset wallet', async () => {
  const balanceAtomic = 2_000_000_000_000_000n;
  const maxFeePerGas = 10_000_000_000n;
  const quoteAmounts = [];
  const estimatedValues = [];
  const plan = await planNativeBridge({
    amount: 'max',
    signer: { showAddress: async () => ADDRESS },
    originRpc: {
      getBalance: async () => balanceAtomic.toString(),
      getFeeData: async () => ({ maxFeePerGas: maxFeePerGas.toString() }),
      estimateGas: async transaction => {
        const value = BigInt(transaction.value);
        estimatedValues.push(value);
        if (value > balanceAtomic - 21_000n * maxFeePerGas) {
          throw new Error('eth_estimateGas failed: insufficient funds for transfer');
        }
        return '21000';
      },
    },
    relay: {
      quote: async ({ amount }) => {
        quoteAmounts.push(amount);
        const quote = quoteFor(amount);
        quote.steps[0].items[0].data.maxFeePerGas = maxFeePerGas.toString();
        return quote;
      },
    },
  });

  assert.equal(plan.amount.amountAtomic, '1496000000000000');
  assert.equal(plan.gas.reserve.amountAtomic, '504000000000000');
  assert.deepEqual(quoteAmounts, ['1580000000000000', '1496000000000000']);
  assert.ok(estimatedValues.every(value => value <= balanceAtomic - 21_000n * maxFeePerGas));
});

test('refuses a native bridge amount below the Relay minimum', async () => {
  const fakes = planningFakes();
  fakes.relay.quote = async ({ amount }) => {
    const quote = quoteFor(amount);
    quote.details.currencyIn.minimumAmount = '100000000000000';
    return quote;
  };

  await assert.rejects(
    () => planNativeBridge({ amount: '0.00009', ...fakes }),
    /Relay quote input amount is below its minimum/,
  );
});

test('rejects a Relay quote with a wrong recipient, non-native asset, or extra transaction', async () => {
  const base = quoteFor('1000');
  const wrongRecipient = structuredClone(base);
  wrongRecipient.details.recipient = RELAY_ADDRESS;
  const wrongAsset = structuredClone(base);
  wrongAsset.details.currencyIn.currency.address = RELAY_ADDRESS;
  const extraTransaction = structuredClone(base);
  extraTransaction.steps.push(structuredClone(base.steps[0]));

  for (const quote of [wrongRecipient, wrongAsset, extraTransaction]) {
    await assert.rejects(
      () => validateBridgeQuote({ quote, operationsAddress: ADDRESS, amountAtomic: '1000' }),
      NativeBridgePolicyError,
    );
  }
});

test('does not sign or broadcast a dry-run plan', async () => {
  let signCalls = 0;
  let broadcasts = 0;
  const result = await executeNativeBridge({
    plan: await planNativeBridge({ amount: '0.001', ...planningFakes() }),
    confirm: false,
    signer: { sign: async () => { signCalls += 1; return '0xsigned'; } },
    originRpc: { sendRawTransaction: async () => { broadcasts += 1; } },
    state: new Map(),
  });

  assert.equal(result.outcome, 'dry-run');
  assert.equal(signCalls, 0);
  assert.equal(broadcasts, 0);
});

test('signs once and re-broadcasts the persisted bytes after an unknown origin submission', async () => {
  const state = new Map();
  const sent = [];
  let signCalls = 0;
  let firstAttempt = true;
  const plan = await planNativeBridge({ amount: '0.001', ...planningFakes() });
  const signer = { sign: async () => { signCalls += 1; return '0xsigned'; } };
  const originRpc = {
    sendRawTransaction: async raw => {
      sent.push(raw);
      if (firstAttempt) {
        firstAttempt = false;
        throw new Error('transport ended after submission');
      }
      return '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    },
  };

  await assert.rejects(() => executeNativeBridge({ plan, confirm: true, signer, originRpc, state }), /transport ended/);
  const result = await executeNativeBridge({ plan, confirm: true, signer, originRpc, state });

  assert.equal(result.transactionHash, '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.equal(signCalls, 1);
  assert.deepEqual(sent, ['0xsigned', '0xsigned']);
});

test('reports a timeout when Relay and the destination balance never show a credit', async () => {
  const result = await monitorNativeBridge({
    requestId: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    expectedDestinationBalanceAtomic: '1',
    relay: { status: async () => ({ status: 'pending' }) },
    destinationRpc: { getBalance: async () => '0' },
    maxAttempts: 2,
    delay: async () => {},
  });

  assert.equal(result.outcome, 'timeout');
  assert.equal(result.attempts, 2);
});

test('requires the fixed recovery route and a state directory before confirmation', () => {
  assert.deepEqual(
    parseArgs(['--from-chain', '1', '--to-chain', '4663', '--amount', 'max', '--state-dir', '/tmp/bridge', '--confirm']),
    {
      fromChain: 1,
      toChain: 4663,
      amount: 'max',
      rpcUrl: 'https://eth.drpc.org',
      stateDir: '/tmp/bridge',
      confirm: true,
      timeoutMs: 900_000,
    },
  );
  assert.throws(
    () => parseArgs(['--from-chain', '1', '--to-chain', '4663', '--amount', '0.001', '--confirm']),
    /--state-dir is required with --confirm/,
  );
});

test('finds one persisted signed bridge record for a byte-identical retry', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-native-bridge-'));
  const requestId = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  try {
    await writeFile(join(directory, `native-bridge-${requestId.slice(2)}.json`), JSON.stringify({ requestId, signedTx: '0xsigned', transactionHash: null }));
    const state = await createFileState(directory);
    assert.deepEqual(await state.findPending(), { requestId, signedTx: '0xsigned', transactionHash: null });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('nests the native bridge policy with the transaction for the Keychain child', () => {
  const transaction = { chainId: 1, from: ADDRESS, to: RELAY_ADDRESS, value: '1000', data: '0x' };
  const policy = { schema: 'policy' };
  const rules = [{ id: 'native-bridge-deposit' }];

  assert.deepEqual(toKeychainSignRequest({ transaction, transactionPolicy: policy, transactionPolicyRules: rules }), {
    declaredChainId: 1,
    allowNonDefaultChain: true,
    transaction,
    transactionPolicy: policy,
    transactionPolicyRules: rules,
  });
});
