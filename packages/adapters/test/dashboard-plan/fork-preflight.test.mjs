import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectFork } from './fork-preflight.mjs';
const blockHash = `0x${'ab'.repeat(32)}`;
const local = 'http://127.0.0.1:18545/';
function fixture(overrides = {}) {
  const calls = [];
  return { calls, request: async (url, method, params) => {
    calls.push({ url, method, params });
    if (method === 'anvil_metadata') return { clientVersion: 'anvil/v1.7.1', chainId: 4663,
      forkedNetwork: { chainId: 4663, forkBlockNumber: 100, forkBlockHash: blockHash }, ...overrides };
    if (method === 'eth_chainId') return '0x1237';
    return { number: '0x64', hash: blockHash };
  } };
}
for (let attempt = 1; attempt <= 3; attempt++) {
  test(`attempt ${attempt}: verified fork metadata and independently matching public block`, async () => {
    const { request, calls } = fixture();
    const result = await inspectFork(local, request);
    assert.equal(result.evidence, 'ROBINHOOD_MAINNET_FORK');
    assert.equal(result.dashboardPlanVerified, false);
    assert.equal(calls.length, 4);
    assert.ok(calls.every(call => ['anvil_metadata', 'eth_chainId', 'eth_getBlockByNumber'].includes(call.method)));
  });
  test(`attempt ${attempt}: blank anvil cannot masquerade as a chain fork`, async () => {
    const { request } = fixture({ forkedNetwork: null });
    assert.equal((await inspectFork(local, request)).evidence, 'LOCAL_UNFORKED');
  });
  test(`attempt ${attempt}: missing or wrong fork chain stays unverified`, async () => {
    for (const chainId of [1, undefined]) {
      const { request } = fixture({ forkedNetwork: { chainId, forkBlockNumber: 100, forkBlockHash: blockHash } });
      assert.equal((await inspectFork(local, request)).reason, 'WRONG_CHAIN');
    }
  });
  test(`attempt ${attempt}: independent upstream mismatch invalidates metadata`, async () => {
    const { request } = fixture();
    const result = await inspectFork(local, (url, method, params) =>
      url !== local && method === 'eth_getBlockByNumber' ? { number: '0x64', hash: `0x${'cd'.repeat(32)}` } : request(url, method, params));
    assert.equal(result.reason, 'FORK_BLOCK_MISMATCH');
  });
  test(`attempt ${attempt}: public targets and credentials are rejected before requests`, async () => {
    const { request, calls } = fixture();
    for (const url of ['https://rpc.mainnet.chain.robinhood.com', 'http://user:secret@127.0.0.1:18545', `${local}?token=secret`]) {
      assert.equal((await inspectFork(url, request)).reason, 'LOCAL_RPC_REQUIRED');
    }
    assert.equal(calls.length, 0);
  });
  test(`attempt ${attempt}: unavailable upstream does not leak errors or claim success`, async () => {
    const result = await inspectFork(local, async () => { throw new Error('secret provider credential'); });
    assert.equal(result.evidence, 'UNVERIFIED');
    assert.equal(result.reason, 'RPC_UNAVAILABLE');
    assert.ok(!JSON.stringify(result).includes('secret'));
  });
}
