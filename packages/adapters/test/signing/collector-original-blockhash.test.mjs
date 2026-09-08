import assert from 'node:assert/strict';
import test from 'node:test';
import { createSolanaRpcClient } from '../../src/solana-rpc.mjs';
import { createOriginalSolanaBlockhashContextResolver } from '../../src/app/compose.mjs';

const HASH = 'SysvarRecentB1ockHashes11111111111111111111';
function fixture(value = true, slot = 120) {
  const calls = [];
  const client = createSolanaRpcClient({ rpcUrl: 'https://solana.example.test', fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body); calls.push(body);
    return { ok: true, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { context: { slot }, value } }) };
  } });
  return { calls, resolver: createOriginalSolanaBlockhashContextResolver(client) };
}
test('checks the original hash directly without replacing it with a newer latest hash', async () => {
  const { calls, resolver } = fixture();
  assert.deepEqual(await resolver(HASH), { type: 'rpc-blockhash-validity', blockhash: HASH, valid: true, observedSlot: '120' });
  assert.deepEqual(calls.map(call => call.method), ['isBlockhashValid']);
  assert.equal(calls[0].params[0], HASH);
});
for (const [label, value, slot] of [['expired', false, 120], ['malformed validity', 'true', 120], ['missing slot', true, undefined], ['fractional slot', true, 1.5]]) {
  test(`original hash rejects ${label}`, async () => {
    const { resolver } = fixture(value, slot === undefined ? null : slot);
    await assert.rejects(() => resolver(HASH));
  });
}
