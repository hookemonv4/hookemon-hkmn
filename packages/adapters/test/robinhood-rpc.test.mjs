// Tests for src/robinhood-rpc.mjs. Every RPC call is driven through a viem `custom({ request })`
// transport that returns fixed, hand-verified responses — no real network call is ever made in
// this suite. Where a request's exact JSON-RPC method/params matter (e.g. the ERC20 `balanceOf`
// calldata), the mock asserts them against a value independently cross-checked with
// `cast calldata "balanceOf(address)" ...` (see the inline comment at that assertion).
import assert from 'node:assert/strict';
import test from 'node:test';

import { custom } from 'viem';

import {
  ROBINHOOD_CHAIN_ID,
  ROBINHOOD_CONSTANTS,
  ERC20_TRANSFER_TOPIC,
  createRobinhoodClient,
  readChainId,
  readLatestBlock,
  readFinalizedBlock,
  selectFinalizedSnapshotBlock,
  confirmReadFinalized,
  readTokenBalanceAtLatest,
  createHistoricalErc20EvidenceClient,
  readTokenTotalSupplyAtLatest,
  getTransferLogs,
  readTransaction,
  readTransactionReceipt,
  readFinalizedTransactionReceipt,
  readFinalizedErc20TransferCredit,
  readFinalizedErc20TransferProof,
  sendRawTransaction,
  RobinhoodRpcError,
  RobinhoodFinalityUnavailableError,
  RobinhoodMalformedResponseError,
} from '../src/robinhood-rpc.mjs';

const TOKEN = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const ACCOUNT = '0x6666666666666666666666666666666666666666'.length === 42
  ? '0x6666666666666666666666666666666666666666'
  : (() => { throw new Error('fixture address length drifted'); })();
const TX_HASH = `0x${'ab'.repeat(32)}`;
const BALANCEOF_CALLDATA_FOR_ACCOUNT = '0x70a082310000000000000000000000006666666666666666666666666666666666666666';

function blockFixture({ number, hash, parentHash = `0x${'00'.repeat(32)}` }) {
  return {
    number, hash, parentHash, timestamp: '0x68b7a000',
    gasLimit: '0x1', gasUsed: '0x1', miner: `0x${'00'.repeat(20)}`, nonce: '0x0000000000000000',
    difficulty: '0x0', extraData: '0x', logsBloom: `0x${'00'.repeat(256)}`,
    transactionsRoot: `0x${'00'.repeat(32)}`, stateRoot: `0x${'00'.repeat(32)}`,
    receiptsRoot: `0x${'00'.repeat(32)}`, size: '0x1', transactions: [], uncles: [],
    sha3Uncles: `0x${'00'.repeat(32)}`,
  };
}

function mockClient(handlers) {
  return createRobinhoodClient({
    transport: custom(
      {
        async request({ method, params }) {
          const handler = handlers[method];
          if (!handler) throw new Error(`unexpected RPC method in test: ${method}`);
          return handler(params);
        },
      },
      // No retry/backoff in tests: every mock response is deterministic, so a retry would only
      // slow the suite down, never change the outcome.
      { retryCount: 0 },
    ),
  });
}

test('createRobinhoodClient binds to Robinhood Chain id 4663 and exposes a viem PublicClient', async () => {
  const client = mockClient({ eth_chainId: () => '0x1237' });
  assert.equal(client.chain.id, ROBINHOOD_CHAIN_ID);
  assert.equal(await readChainId(client), 4663);
});

test('ROBINHOOD_CONSTANTS matches the live-verified chain facts (external-facts.json, 2026-09-02)', () => {
  assert.equal(ROBINHOOD_CONSTANTS.ROBINHOOD_CHAIN_ID, 4663);
  assert.equal(ROBINHOOD_CONSTANTS.ROBINHOOD_TESTNET_CHAIN_ID, 46630);
  assert.equal(ROBINHOOD_CONSTANTS.ROBINHOOD_MAINNET_RPC_URL, 'https://rpc.mainnet.chain.robinhood.com');
  assert.equal(
    ROBINHOOD_CONSTANTS.ROBINHOOD_GENESIS_HASH,
    '0xaad15f3d702aaea00caf3e9bb56395efe9127bc3b31b24921abf1eee3409305c',
  );
});

test('readLatestBlock issues eth_getBlockByNumber("latest", false) and returns number/hash/timestamp', async () => {
  const calls = [];
  const client = mockClient({
    eth_getBlockByNumber: (params) => {
      calls.push(params);
      return blockFixture({ number: '0x64', hash: `0x${'11'.repeat(32)}` });
    },
  });
  const block = await readLatestBlock(client);
  assert.deepEqual(calls[0], ['latest', false]);
  assert.equal(block.number, 100n);
  assert.equal(block.hash, `0x${'11'.repeat(32)}`);
});

test('readFinalizedBlock issues eth_getBlockByNumber("finalized", false) — confirmed live to work for block fetches', async () => {
  const calls = [];
  const client = mockClient({
    eth_getBlockByNumber: (params) => {
      calls.push(params);
      return blockFixture({ number: '0x63', hash: `0x${'22'.repeat(32)}` });
    },
  });
  const block = await readFinalizedBlock(client);
  assert.deepEqual(calls[0], ['finalized', false]);
  assert.equal(block.number, 99n);
});

test('readFinalizedBlock wraps an RPC failure in RobinhoodFinalityUnavailableError, never a bare Error', async () => {
  const client = mockClient({
    eth_getBlockByNumber: () => { throw new Error('metadata is not found'); },
  });
  await assert.rejects(() => readFinalizedBlock(client), RobinhoodFinalityUnavailableError);
});

test('selectFinalizedSnapshotBlock refuses a latest-depth candidate above the finalized head', async () => {
  const calls = [];
  const client = {
    async getBlock({ blockTag, blockNumber }) {
      calls.push({ blockTag: blockTag ?? null, blockNumber: blockNumber ?? null });
      if (blockTag === 'latest') return { number: 100n, hash: `0x${'10'.repeat(32)}`, timestamp: 1n };
      if (blockTag === 'finalized') return { number: 50n, hash: `0x${'20'.repeat(32)}`, timestamp: 1n };
      return { number: blockNumber, hash: `0x${'30'.repeat(32)}`, timestamp: 1n };
    },
  };

  await assert.rejects(
    () => selectFinalizedSnapshotBlock(client, { finalityDepth: 2n }),
    RobinhoodFinalityUnavailableError,
  );
  assert.equal(calls.some(call => call.blockTag === 'finalized'), true);
  assert.equal(calls.some(call => call.blockNumber === 98n), false);
});

test('selectFinalizedSnapshotBlock returns the selected block with its finalized-head evidence', async () => {
  const client = {
    async getBlock({ blockTag, blockNumber }) {
      if (blockTag === 'latest') return { number: 100n, hash: `0x${'40'.repeat(32)}`, timestamp: 4n };
      if (blockTag === 'finalized') return { number: 98n, hash: `0x${'50'.repeat(32)}`, timestamp: 5n };
      return { number: blockNumber, hash: `0x${'60'.repeat(32)}`, timestamp: 6n };
    },
  };

  const selected = await selectFinalizedSnapshotBlock(client, { finalityDepth: 2n });
  assert.deepEqual(selected, {
    number: 98n,
    hash: `0x${'60'.repeat(32)}`,
    timestamp: 6n,
    finalizedHead: {
      number: 98n,
      hash: `0x${'50'.repeat(32)}`,
      timestamp: 5n,
    },
  });
});

test('selectFinalizedSnapshotBlock rejects a malformed finalized-head response before reading a candidate', async () => {
  const calls = [];
  const client = {
    async getBlock({ blockTag, blockNumber }) {
      calls.push({ blockTag: blockTag ?? null, blockNumber: blockNumber ?? null });
      if (blockTag === 'latest') return { number: 100n, hash: `0x${'70'.repeat(32)}`, timestamp: 7n };
      if (blockTag === 'finalized') return { number: undefined, hash: `0x${'80'.repeat(32)}`, timestamp: 8n };
      return { number: blockNumber, hash: `0x${'90'.repeat(32)}`, timestamp: 9n };
    },
  };

  await assert.rejects(
    () => selectFinalizedSnapshotBlock(client, { finalityDepth: 2n }),
    RobinhoodFinalityUnavailableError,
  );
  assert.equal(calls.some(call => call.blockNumber === 98n), false);
});

test(
  'readTokenBalanceAtLatest reads at "latest" only (never "finalized") and its eth_call calldata '
  + 'matches an independently-computed `cast calldata "balanceOf(address)"` vector',
  async () => {
    const ethCallCalls = [];
    const client = mockClient({
      eth_call: (params) => {
        ethCallCalls.push(params);
        return `0x${(123456789n).toString(16).padStart(64, '0')}`;
      },
      eth_getBlockByNumber: (params) => {
        assert.deepEqual(params, ['latest', false]);
        return blockFixture({ number: '0x64', hash: `0x${'33'.repeat(32)}` });
      },
    });
    const result = await readTokenBalanceAtLatest(client, { token: TOKEN, account: ACCOUNT });
    assert.equal(result.value, 123456789n);
    assert.equal(result.blockNumber, 100n);
    assert.equal(result.blockHash, `0x${'33'.repeat(32)}`);

    const [callParams, blockTag] = ethCallCalls[0];
    assert.equal(callParams.data, BALANCEOF_CALLDATA_FOR_ACCOUNT);
    assert.equal(callParams.to.toLowerCase(), TOKEN.toLowerCase());
    assert.equal(blockTag, 'latest');
  },
);

test('createHistoricalErc20EvidenceClient reads balanceOf at the requested block and rejects a mismatched canonical hash', async () => {
  const requestedBlock = 100n;
  const requestedHash = `0x${'55'.repeat(32)}`;
  const calls = [];
  const client = {
    async readContract(input) {
      calls.push({ kind: 'readContract', input });
      return 456n;
    },
    async getBlock(input) {
      calls.push({ kind: 'getBlock', input });
      return { number: requestedBlock, hash: requestedHash, timestamp: 9n };
    },
  };
  const evidenceClient = createHistoricalErc20EvidenceClient({ client });
  const observation = await evidenceClient.readErc20BalanceAtBlock({
    token: TOKEN,
    account: ACCOUNT,
    blockNumber: requestedBlock,
    blockHash: requestedHash,
  });
  assert.deepEqual(observation, { value: 456n, blockNumber: requestedBlock, blockHash: requestedHash });
  assert.equal(calls[0].input.blockNumber, requestedBlock);
  assert.equal(calls[1].input.blockNumber, requestedBlock);

  const wrongHashEvidence = createHistoricalErc20EvidenceClient({
    client: {
      async readContract() { return 456n; },
      async getBlock() { return { number: requestedBlock, hash: `0x${'66'.repeat(32)}`, timestamp: 9n }; },
    },
  });
  await assert.rejects(
    () => wrongHashEvidence.readErc20BalanceAtBlock({
      token: TOKEN,
      account: ACCOUNT,
      blockNumber: requestedBlock,
      blockHash: requestedHash,
    }),
    RobinhoodMalformedResponseError,
  );
});

test('confirmReadFinalized compares the given block number against a fresh finalized-block read', async () => {
  const client = mockClient({
    eth_getBlockByNumber: () => blockFixture({ number: '0x64', hash: `0x${'44'.repeat(32)}` }), // 100
  });
  const notYet = await confirmReadFinalized(client, 150n);
  assert.equal(notYet.finalized, false);
  assert.equal(notYet.finalizedBlockNumber, 100n);

  const already = await confirmReadFinalized(client, 100n);
  assert.equal(already.finalized, true);

  const older = await confirmReadFinalized(client, 50n);
  assert.equal(older.finalized, true);
});

test('confirmReadFinalized rejects a non-bigint blockNumber (never silently coerced)', async () => {
  const client = mockClient({});
  await assert.rejects(() => confirmReadFinalized(client, 100), RobinhoodRpcError);
});

test('readTransaction / readTransactionReceipt call the exact JSON-RPC method with the given hash', async () => {
  const calls = [];
  const client = mockClient({
    eth_getTransactionByHash: (params) => { calls.push(['eth_getTransactionByHash', params]); return null; },
    eth_getTransactionReceipt: (params) => { calls.push(['eth_getTransactionReceipt', params]); return null; },
  });
  await readTransaction(client, TX_HASH).catch(() => {});
  await readTransactionReceipt(client, TX_HASH).catch(() => {});
  assert.deepEqual(calls[0], ['eth_getTransactionByHash', [TX_HASH]]);
  assert.deepEqual(calls[1], ['eth_getTransactionReceipt', [TX_HASH]]);
});

test('readTransaction/readTransactionReceipt reject a malformed hash before any RPC call', async () => {
  const client = mockClient({});
  await assert.rejects(() => readTransaction(client, '0x1234'), RobinhoodRpcError);
  await assert.rejects(() => readTransactionReceipt(client, 'not-a-hash'), RobinhoodRpcError);
});

test('readFinalizedTransactionReceipt reports finalized=true only after the receipt hash matches a stable canonical inclusion block', async () => {
  const receiptFixture = {
    transactionHash: TX_HASH, blockNumber: '0x64', blockHash: `0x${'66'.repeat(32)}`,
    status: '0x1', gasUsed: '0x1', cumulativeGasUsed: '0x1', logs: [], logsBloom: `0x${'00'.repeat(256)}`,
    transactionIndex: '0x0', from: `0x${'00'.repeat(20)}`, to: `0x${'00'.repeat(20)}`, contractAddress: null,
    effectiveGasPrice: '0x1', type: '0x2',
  };
  const client = mockClient({
    eth_getTransactionReceipt: () => receiptFixture,
    eth_getBlockByNumber: () => blockFixture({ number: '0x64', hash: `0x${'66'.repeat(32)}` }),
  });
  const { finalized, finalizedBlockNumber } = await readFinalizedTransactionReceipt(client, TX_HASH);
  assert.equal(finalized, true);
  assert.equal(finalizedBlockNumber, 100n);
});

test('readFinalizedTransactionReceipt leaves a stale-fork receipt unresolved when its block hash differs from the canonical block', async () => {
  const receiptFixture = {
    transactionHash: TX_HASH, blockNumber: '0x64', blockHash: `0x${'55'.repeat(32)}`,
    status: '0x1', gasUsed: '0x1', cumulativeGasUsed: '0x1', logs: [], logsBloom: `0x${'00'.repeat(256)}`,
    transactionIndex: '0x0', from: `0x${'00'.repeat(20)}`, to: `0x${'00'.repeat(20)}`, contractAddress: null,
    effectiveGasPrice: '0x1', type: '0x2',
  };
  const client = mockClient({
    eth_getTransactionReceipt: () => receiptFixture,
    eth_getBlockByNumber: ([selector]) => blockFixture({
      number: selector === 'finalized' ? '0x64' : selector,
      hash: `0x${'66'.repeat(32)}`,
    }),
  });
  const observation = await readFinalizedTransactionReceipt(client, TX_HASH);
  assert.equal(observation.finalized, false);
  assert.equal(observation.reason, 'RECEIPT_BLOCK_NOT_CANONICAL');
});

test('readFinalizedTransactionReceipt leaves a receipt unresolved when its settlement material changes on the second read', async () => {
  const receiptFixture = {
    transactionHash: TX_HASH, blockNumber: '0x64', blockHash: `0x${'99'.repeat(32)}`,
    status: '0x1', gasUsed: '0x1', cumulativeGasUsed: '0x1', logs: [], logsBloom: `0x${'00'.repeat(256)}`,
    transactionIndex: '0x0', from: `0x${'00'.repeat(20)}`, to: `0x${'00'.repeat(20)}`, contractAddress: null,
    effectiveGasPrice: '0x1', type: '0x2',
  };
  let receiptReads = 0;
  const client = mockClient({
    eth_getTransactionReceipt: () => {
      receiptReads += 1;
      return receiptReads === 1 ? receiptFixture : { ...receiptFixture, status: '0x0' };
    },
    eth_getBlockByNumber: () => blockFixture({ number: '0x64', hash: `0x${'99'.repeat(32)}` }),
  });

  const observation = await readFinalizedTransactionReceipt(client, TX_HASH);
  assert.equal(observation.finalized, false);
  assert.equal(observation.reason, 'RECEIPT_UNSTABLE');
  assert.equal(receiptReads, 2);
});

test('readFinalizedTransactionReceipt reports finalized=false while the receipt block is still ahead of the finalized tip', async () => {
  const receiptFixture = {
    transactionHash: TX_HASH, blockNumber: '0x65', blockHash: `0x${'77'.repeat(32)}`,
    status: '0x1', gasUsed: '0x1', cumulativeGasUsed: '0x1', logs: [], logsBloom: `0x${'00'.repeat(256)}`,
    transactionIndex: '0x0', from: `0x${'00'.repeat(20)}`, to: `0x${'00'.repeat(20)}`, contractAddress: null,
    effectiveGasPrice: '0x1', type: '0x2',
  };
  const client = mockClient({
    eth_getTransactionReceipt: () => receiptFixture,
    eth_getBlockByNumber: () => blockFixture({ number: '0x64', hash: `0x${'88'.repeat(32)}` }), // 100 < 101
  });
  const { finalized } = await readFinalizedTransactionReceipt(client, TX_HASH);
  assert.equal(finalized, false);
});

test('readFinalizedTransactionReceipt rejects a receipt whose transaction hash does not match the query', async () => {
  const client = {
    async getTransactionReceipt() {
      return { transactionHash: `0x${'ff'.repeat(32)}`, blockNumber: 100n, status: 'success', logs: [] };
    },
    async getBlock() { return { number: 100n, hash: `0x${'11'.repeat(32)}` }; },
  };
  await assert.rejects(
    () => readFinalizedTransactionReceipt(client, TX_HASH),
    /different transaction hash/,
  );
});

test('sendRawTransaction broadcasts exactly the given pre-signed hex and returns the tx hash', async () => {
  const signedTx = `0x${'99'.repeat(70)}`;
  const calls = [];
  const client = mockClient({
    eth_sendRawTransaction: (params) => { calls.push(params); return TX_HASH; },
  });
  const hash = await sendRawTransaction(client, signedTx);
  assert.equal(hash, TX_HASH);
  assert.deepEqual(calls[0], [signedTx]);
});

test('sendRawTransaction rejects a non-hex payload before ever calling the RPC (never signs, never guesses)', async () => {
  const client = mockClient({});
  await assert.rejects(() => sendRawTransaction(client, 'not-hex'), RobinhoodRpcError);
});

// --- readTokenTotalSupplyAtLatest (WP-36) ------------------------------------------------------

test('readTokenTotalSupplyAtLatest reads totalSupply() at "latest" only, alongside its own block context', async () => {
  const ethCallCalls = [];
  const client = mockClient({
    eth_call: (params) => {
      ethCallCalls.push(params);
      return `0x${(420_690_000_000n).toString(16).padStart(64, '0')}`;
    },
    eth_getBlockByNumber: (params) => {
      assert.deepEqual(params, ['latest', false]);
      return blockFixture({ number: '0x64', hash: `0x${'aa'.repeat(32)}` });
    },
  });
  const result = await readTokenTotalSupplyAtLatest(client, { token: TOKEN });
  assert.equal(result.value, 420_690_000_000n);
  assert.equal(result.blockNumber, 100n);
  assert.equal(result.blockHash, `0x${'aa'.repeat(32)}`);
  // `totalSupply()` calldata is just its 4-byte selector — no arguments to encode.
  assert.equal(ethCallCalls[0][0].data, '0x18160ddd');
});

// --- getTransferLogs (WP-36) -------------------------------------------------------------------

function addressTopic(address) {
  return `0x${'0'.repeat(24)}${address.slice(2).toLowerCase()}`;
}

function transferLogFixture({ blockNumber, logIndex, from, to, value }) {
  return {
    address: TOKEN,
    topics: [ERC20_TRANSFER_TOPIC, addressTopic(from), addressTopic(to)],
    data: `0x${value.toString(16).padStart(64, '0')}`,
    blockNumber,
    logIndex,
    transactionHash: `0x${'cc'.repeat(32)}`,
    transactionIndex: '0x0',
    blockHash: `0x${'dd'.repeat(32)}`,
    removed: false,
  };
}

const FROM_ADDRESS = `0x${'1'.repeat(39)}a`;
const TO_ADDRESS = `0x${'2'.repeat(39)}b`;

test('readFinalizedErc20TransferCredit accepts only a finalized successful receipt with a USDG Transfer credit to the expected Operations account', async () => {
  const receiptFixture = {
    transactionHash: TX_HASH,
    blockNumber: '0x64',
    blockHash: `0x${'66'.repeat(32)}`,
    status: '0x1',
    gasUsed: '0x1',
    cumulativeGasUsed: '0x1',
    logs: [
      transferLogFixture({ blockNumber: '0x64', logIndex: '0x0', from: FROM_ADDRESS, to: TO_ADDRESS, value: 24000000n }),
      transferLogFixture({ blockNumber: '0x64', logIndex: '0x1', from: FROM_ADDRESS, to: FROM_ADDRESS, value: 99n }),
    ],
    logsBloom: `0x${'00'.repeat(256)}`,
    transactionIndex: '0x0',
    from: FROM_ADDRESS,
    to: TO_ADDRESS,
    contractAddress: null,
    effectiveGasPrice: '0x1',
    type: '0x2',
  };
  const client = mockClient({
    eth_getTransactionReceipt: () => receiptFixture,
    eth_getBlockByNumber: () => blockFixture({ number: '0x64', hash: `0x${'66'.repeat(32)}` }),
  });
  const result = await readFinalizedErc20TransferCredit(client, { hash: TX_HASH, token: TOKEN, recipient: TO_ADDRESS });
  assert.equal(result.finalized, true);
  assert.equal(result.successful, true);
  assert.equal(result.amountAtomic, '24000000');
  assert.deepEqual(result.transfers, [{ from: FROM_ADDRESS, to: TO_ADDRESS, amountAtomic: '24000000', logIndex: '0' }]);
});

test('readFinalizedErc20TransferCredit does not report a credit before receipt finality', async () => {
  const receiptFixture = {
    transactionHash: TX_HASH,
    blockNumber: '0x65',
    blockHash: `0x${'77'.repeat(32)}`,
    status: '0x1',
    gasUsed: '0x1',
    cumulativeGasUsed: '0x1',
    logs: [transferLogFixture({ blockNumber: '0x65', logIndex: '0x0', from: FROM_ADDRESS, to: TO_ADDRESS, value: 1n })],
    logsBloom: `0x${'00'.repeat(256)}`,
    transactionIndex: '0x0',
    from: FROM_ADDRESS,
    to: TO_ADDRESS,
    contractAddress: null,
    effectiveGasPrice: '0x1',
    type: '0x2',
  };
  const client = mockClient({
    eth_getTransactionReceipt: () => receiptFixture,
    eth_getBlockByNumber: () => blockFixture({ number: '0x64', hash: `0x${'88'.repeat(32)}` }),
  });
  const result = await readFinalizedErc20TransferCredit(client, { hash: TX_HASH, token: TOKEN, recipient: TO_ADDRESS });
  assert.equal(result.finalized, false);
  assert.equal(result.successful, null);
  assert.equal(result.amountAtomic, null);
  assert.deepEqual(result.transfers, []);
});

test('readFinalizedErc20TransferProof requires a stable canonical receipt and exact archive balance deltas for both transfer parties', async () => {
  const receiptBlockHash = `0x${'a1'.repeat(32)}`;
  const priorBlockHash = `0x${'b2'.repeat(32)}`;
  const finalizedBlockHash = `0x${'c3'.repeat(32)}`;
  const amountAtomic = '24000000';
  const receiptFixture = {
    transactionHash: TX_HASH,
    blockNumber: '0x64',
    blockHash: receiptBlockHash,
    status: '0x1',
    gasUsed: '0x1',
    cumulativeGasUsed: '0x1',
    logs: [transferLogFixture({ blockNumber: '0x64', logIndex: '0x0', from: FROM_ADDRESS, to: TO_ADDRESS, value: BigInt(amountAtomic) })],
    logsBloom: `0x${'00'.repeat(256)}`,
    transactionIndex: '0x0',
    from: FROM_ADDRESS,
    to: TO_ADDRESS,
    contractAddress: null,
    effectiveGasPrice: '0x1',
    type: '0x2',
  };
  let receiptReads = 0;
  const client = mockClient({
    eth_getTransactionReceipt: () => {
      receiptReads += 1;
      return receiptFixture;
    },
    eth_getBlockByNumber: ([selector]) => {
      if (selector === 'finalized') return blockFixture({ number: '0x65', hash: finalizedBlockHash });
      if (selector === '0x64') return blockFixture({ number: '0x64', hash: receiptBlockHash, parentHash: priorBlockHash });
      if (selector === '0x63') return blockFixture({ number: '0x63', hash: priorBlockHash });
      throw new Error(`unexpected block selector ${selector}`);
    },
  });
  const evidenceCalls = [];
  const evidenceClient = {
    async readErc20BalanceAtBlock(request) {
      evidenceCalls.push(request);
      const isSource = request.account.toLowerCase() === FROM_ADDRESS;
      const isPrior = request.blockNumber === 99n;
      const value = isSource
        ? (isPrior ? 100_000_000n : 76_000_000n)
        : (isPrior ? 5_000_000n : 29_000_000n);
      return { value, blockNumber: request.blockNumber, blockHash: request.blockHash };
    },
  };

  const result = await readFinalizedErc20TransferProof(client, {
    hash: TX_HASH,
    token: TOKEN,
    source: FROM_ADDRESS,
    recipient: TO_ADDRESS,
    amountAtomic,
    evidenceClient,
  });

  assert.equal(result.finalized, true);
  assert.equal(result.successful, true);
  assert.equal(result.amountAtomic, amountAtomic);
  assert.equal(result.receiptBlockHash, receiptBlockHash);
  assert.equal(result.receiptBlockTimestampUnixSeconds, '1756864512');
  assert.equal(result.sourceBalanceDeltaAtomic, amountAtomic);
  assert.equal(result.recipientBalanceDeltaAtomic, amountAtomic);
  assert.equal(receiptReads, 2, 'the receipt is re-read after finality to reject an unstable inclusion');
  assert.deepEqual(evidenceCalls.map(call => ({
    ...call,
    token: call.token.toLowerCase(),
    account: call.account.toLowerCase(),
  })), [
    { token: TOKEN, account: FROM_ADDRESS, blockNumber: 99n, blockHash: priorBlockHash },
    { token: TOKEN, account: FROM_ADDRESS, blockNumber: 100n, blockHash: receiptBlockHash },
    { token: TOKEN, account: TO_ADDRESS, blockNumber: 99n, blockHash: priorBlockHash },
    { token: TOKEN, account: TO_ADDRESS, blockNumber: 100n, blockHash: receiptBlockHash },
  ]);
});

test('readFinalizedErc20TransferProof keeps a finalized receipt unresolved without capable historical balance evidence', async () => {
  const receiptBlockHash = `0x${'d4'.repeat(32)}`;
  const priorBlockHash = `0x${'a5'.repeat(32)}`;
  const finalizedBlockHash = `0x${'b6'.repeat(32)}`;
  const receiptFixture = {
    transactionHash: TX_HASH,
    blockNumber: '0x64',
    blockHash: receiptBlockHash,
    status: '0x1',
    gasUsed: '0x1',
    cumulativeGasUsed: '0x1',
    logs: [transferLogFixture({ blockNumber: '0x64', logIndex: '0x0', from: FROM_ADDRESS, to: TO_ADDRESS, value: 1n })],
    logsBloom: `0x${'00'.repeat(256)}`,
    transactionIndex: '0x0',
    from: FROM_ADDRESS,
    to: TO_ADDRESS,
    contractAddress: null,
    effectiveGasPrice: '0x1',
    type: '0x2',
  };
  const client = mockClient({
    eth_getTransactionReceipt: () => receiptFixture,
    eth_getBlockByNumber: ([selector]) => {
      if (selector === 'finalized') return blockFixture({ number: '0x65', hash: finalizedBlockHash });
      if (selector === '0x64') return blockFixture({ number: '0x64', hash: receiptBlockHash, parentHash: priorBlockHash });
      if (selector === '0x63') return blockFixture({ number: '0x63', hash: priorBlockHash });
      throw new Error(`unexpected block selector ${selector}`);
    },
  });

  const result = await readFinalizedErc20TransferProof(client, {
    hash: TX_HASH,
    token: TOKEN,
    source: FROM_ADDRESS,
    recipient: TO_ADDRESS,
    amountAtomic: '1',
  });

  assert.equal(result.finalized, false);
  assert.equal(result.receiptFinalized, true);
  assert.equal(result.successful, null);
  assert.equal(result.reason, 'HISTORICAL_BALANCE_EVIDENCE_UNAVAILABLE');
});

test('readFinalizedErc20TransferProof keeps a transfer unresolved when either observed party delta differs from the planned amount', async () => {
  const receiptBlockHash = `0x${'e5'.repeat(32)}`;
  const priorBlockHash = `0x${'f6'.repeat(32)}`;
  const receiptFixture = {
    transactionHash: TX_HASH,
    blockNumber: '0x64',
    blockHash: receiptBlockHash,
    status: '0x1',
    gasUsed: '0x1',
    cumulativeGasUsed: '0x1',
    logs: [transferLogFixture({ blockNumber: '0x64', logIndex: '0x0', from: FROM_ADDRESS, to: TO_ADDRESS, value: 10n })],
    logsBloom: `0x${'00'.repeat(256)}`,
    transactionIndex: '0x0',
    from: FROM_ADDRESS,
    to: TO_ADDRESS,
    contractAddress: null,
    effectiveGasPrice: '0x1',
    type: '0x2',
  };
  const client = mockClient({
    eth_getTransactionReceipt: () => receiptFixture,
    eth_getBlockByNumber: ([selector]) => {
      if (selector === 'finalized') return blockFixture({ number: '0x65', hash: `0x${'a7'.repeat(32)}` });
      if (selector === '0x64') return blockFixture({ number: '0x64', hash: receiptBlockHash, parentHash: priorBlockHash });
      if (selector === '0x63') return blockFixture({ number: '0x63', hash: priorBlockHash });
      throw new Error(`unexpected block selector ${selector}`);
    },
  });
  const evidenceClient = {
    async readErc20BalanceAtBlock({ account, blockNumber, blockHash }) {
      const isSource = account.toLowerCase() === FROM_ADDRESS;
      const value = isSource ? (blockNumber === 99n ? 20n : 10n) : (blockNumber === 99n ? 0n : 9n);
      return { value, blockNumber, blockHash };
    },
  };

  const result = await readFinalizedErc20TransferProof(client, {
    hash: TX_HASH,
    token: TOKEN,
    source: FROM_ADDRESS,
    recipient: TO_ADDRESS,
    amountAtomic: '10',
    evidenceClient,
  });

  assert.equal(result.finalized, false);
  assert.equal(result.receiptFinalized, true);
  assert.equal(result.reason, 'BALANCE_DELTA_MISMATCH');
  assert.equal(result.sourceBalanceDeltaAtomic, '10');
  assert.equal(result.recipientBalanceDeltaAtomic, '9');
});

test('getTransferLogs issues a topic-filtered eth_getLogs call per page and decodes every log into the canonical {blockNumber, logIndex, from, to, value} shape', async () => {
  const logCalls = [];
  const client = mockClient({
    eth_getLogs: (params) => {
      logCalls.push(params[0]);
      return [
        transferLogFixture({ blockNumber: '0xa', logIndex: '0x0', from: FROM_ADDRESS, to: TO_ADDRESS, value: 1_000_000n }),
        transferLogFixture({ blockNumber: '0xa', logIndex: '0x1', from: TO_ADDRESS, to: FROM_ADDRESS, value: 250_000n }),
      ];
    },
    eth_getBlockByNumber: () => blockFixture({ number: '0x14', hash: `0x${'ee'.repeat(32)}` }),
  });
  const result = await getTransferLogs(client, { token: TOKEN, fromBlock: 10n, toBlock: 20n });
  assert.equal(logCalls.length, 1, 'a range within one page issues exactly one eth_getLogs call');
  assert.deepEqual(logCalls[0].topics, [ERC20_TRANSFER_TOPIC]);
  assert.equal(logCalls[0].fromBlock, '0xa');
  assert.equal(logCalls[0].toBlock, '0x14');
  assert.equal(result.blockHash, `0x${'ee'.repeat(32)}`);
  assert.deepEqual(result.pages, [{ fromBlockNumber: 10n, toBlockNumber: 20n, blockHash: `0x${'ee'.repeat(32)}` }]);
  assert.deepEqual(result.logs, [
    { blockNumber: '10', logIndex: '0', from: FROM_ADDRESS, to: TO_ADDRESS, value: '1000000' },
    { blockNumber: '10', logIndex: '1', from: TO_ADDRESS, to: FROM_ADDRESS, value: '250000' },
  ]);
});

test('getTransferLogs pages a wide range into pageSize-block windows, in ascending order, and concatenates every page\'s logs', async () => {
  const requestedRanges = [];
  const client = mockClient({
    eth_getLogs: (params) => {
      requestedRanges.push([params[0].fromBlock, params[0].toBlock]);
      const fromBlock = BigInt(params[0].fromBlock);
      return [transferLogFixture({ blockNumber: `0x${fromBlock.toString(16)}`, logIndex: '0x0', from: FROM_ADDRESS, to: TO_ADDRESS, value: fromBlock })];
    },
    eth_getBlockByNumber: (params) => blockFixture({ number: params[0], hash: `0x${params[0].slice(2).padStart(64, '0')}` }),
  });
  const result = await getTransferLogs(client, { token: TOKEN, fromBlock: 0n, toBlock: 25n, pageSize: 10n });
  assert.deepEqual(requestedRanges, [['0x0', '0x9'], ['0xa', '0x13'], ['0x14', '0x19']]);
  assert.equal(result.logs.length, 3);
  assert.deepEqual(result.logs.map(log => log.blockNumber), ['0', '10', '20']);
  // the returned top-level blockHash is the *last* page's own confirmed hash (toBlock = 25 = 0x19).
  assert.equal(result.blockHash, `0x${'19'.padStart(64, '0')}`);
});

test('getTransferLogs retries a page whose toBlock hash changed between the before/after read (a reorg mid-fetch), and succeeds once the hash is stable', async () => {
  let blockReads = 0;
  const client = mockClient({
    eth_getLogs: () => [transferLogFixture({ blockNumber: '0xa', logIndex: '0x0', from: FROM_ADDRESS, to: TO_ADDRESS, value: 1n })],
    eth_getBlockByNumber: () => {
      blockReads += 1;
      // First page attempt: before=hash A, after=hash B (reorg detected, this whole page retried).
      // Second attempt: before=hash B, after=hash B (stable).
      const hash = blockReads === 1 ? 'a1' : 'b2';
      return blockFixture({ number: '0xa', hash: `0x${hash.repeat(32)}` });
    },
  });
  const result = await getTransferLogs(client, { token: TOKEN, fromBlock: 10n, toBlock: 10n });
  assert.equal(result.blockHash, `0x${'b2'.repeat(32)}`);
  assert.equal(blockReads, 4, 'first attempt: 2 block reads (mismatch, retried); second attempt: 2 more block reads (match)');
});

test('getTransferLogs gives up with RobinhoodFinalityUnavailableError after maxRetriesPerPage consecutive reorg-mismatches, never returning an unstable page', async () => {
  const client = mockClient({
    eth_getLogs: () => [],
    eth_getBlockByNumber: () => blockFixture({ number: '0xa', hash: `0x${Math.random().toString(16).slice(2).padStart(64, '0')}` }),
  });
  await assert.rejects(
    () => getTransferLogs(client, { token: TOKEN, fromBlock: 10n, toBlock: 10n, maxRetriesPerPage: 2 }),
    RobinhoodFinalityUnavailableError,
  );
});

test('getTransferLogs throws RobinhoodMalformedResponseError on a log whose topic0 is not the ERC20 Transfer selector', async () => {
  const client = mockClient({
    eth_getLogs: () => [{ ...transferLogFixture({ blockNumber: '0xa', logIndex: '0x0', from: FROM_ADDRESS, to: TO_ADDRESS, value: 1n }), topics: [`0x${'0'.repeat(64)}`, addressTopic(FROM_ADDRESS), addressTopic(TO_ADDRESS)] }],
    eth_getBlockByNumber: () => blockFixture({ number: '0xa', hash: `0x${'ff'.repeat(32)}` }),
  });
  await assert.rejects(() => getTransferLogs(client, { token: TOKEN, fromBlock: 10n, toBlock: 10n }), RobinhoodMalformedResponseError);
});

test('getTransferLogs rejects a page endpoint response whose block number differs from the requested block', async () => {
  const client = mockClient({
    eth_getLogs: () => [],
    eth_getBlockByNumber: () => blockFixture({ number: '0x9', hash: `0x${'ff'.repeat(32)}` }),
  });
  await assert.rejects(
    () => getTransferLogs(client, { token: TOKEN, fromBlock: 10n, toBlock: 10n }),
    RobinhoodMalformedResponseError,
  );
});

test('getTransferLogs rejects an invalid block range or pageSize before any RPC call', async () => {
  const client = mockClient({});
  await assert.rejects(() => getTransferLogs(client, { token: TOKEN, fromBlock: 20n, toBlock: 10n }), RobinhoodRpcError);
  await assert.rejects(() => getTransferLogs(client, { token: TOKEN, fromBlock: 1, toBlock: 10n }), RobinhoodRpcError);
  await assert.rejects(() => getTransferLogs(client, { token: TOKEN, fromBlock: 1n, toBlock: 10n, pageSize: 0n }), RobinhoodRpcError);
});
