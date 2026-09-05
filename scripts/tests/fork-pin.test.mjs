import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import { keccak256Hex } from '../programmable/lib/keccak.mjs';
import {
  parseInvocation,
  verifyForkPin,
  verifyForkPinAndCurrentHead,
} from '../verify-fork-pin.mjs';

const PINNED_HASH = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const LATEST_HASH = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const POOL_MANAGER = '0x8366a39CC670B4001A1121B8F6A443A643e40951';
const POSITION_MANAGER = '0x58daec3116aae6D93017bAAea7749052E8a04fA7';
const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
const USDG_PROXY = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const USDG_IMPLEMENTATION = '0x68184C449E1a8f34fA18d289737129FD27B66f8F';
const DRIFTED_USDG_IMPLEMENTATION = '0x9999999999999999999999999999999999999999';
const UNIVERSAL_ROUTER = '0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf99';
const V4_QUOTER = '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94';
const STATE_VIEW = '0xF3334192D15450CdD385c8B70e03f9A6bD9E673b';
const IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const root = resolve(import.meta.dirname, '../..');
const ARCHIVE_FORK_SOURCE = resolve(root, 'packages/contracts/test/integration/RobinhoodV4ArchiveFork.t.sol');

function codeHash(hex) {
  return keccak256Hex(Buffer.from(hex.slice(2), 'hex'));
}

function pin() {
  return {
    schemaVersion: 'hookemon.phase3.fork-pin.v1',
    chainId: 4663,
    pinnedBlock: { number: 123, hash: PINNED_HASH },
    contracts: {
      poolManager: {
        address: POOL_MANAGER,
        runtimeCodeHash: codeHash('0x01'),
      },
      positionManager: {
        address: POSITION_MANAGER,
        runtimeCodeHash: codeHash('0x04'),
      },
      permit2: {
        address: PERMIT2,
        runtimeCodeHash: codeHash('0x05'),
      },
      usdg: {
        address: USDG_PROXY,
        runtimeCodeHash: codeHash('0x02'),
        implementation: {
          address: USDG_IMPLEMENTATION,
          runtimeCodeHash: codeHash('0x03'),
        },
      },
      universalRouter: {
        address: UNIVERSAL_ROUTER,
        runtimeCodeHash: codeHash('0x06'),
      },
      v4Quoter: {
        address: V4_QUOTER,
        runtimeCodeHash: codeHash('0x08'),
      },
      stateView: {
        address: STATE_VIEW,
        runtimeCodeHash: codeHash('0x07'),
      },
    },
  };
}

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

function fakeRpc({
  latestPoolCode = '0x02',
  pinnedBlockHash = PINNED_HASH,
  observedImplementationAddress = USDG_IMPLEMENTATION,
  observedImplementationCode = '0x03',
} = {}) {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request);
    if (request.method === 'eth_chainId') {
      return jsonResponse({ jsonrpc: '2.0', id: request.id, result: '0x1237' });
    }
    if (request.method === 'eth_getBlockByNumber') {
      const [tag] = request.params;
      const isLatest = tag === 'latest';
      return jsonResponse({
        jsonrpc: '2.0',
        id: request.id,
        result: {
          number: isLatest ? '0x7c' : '0x7b',
          hash: isLatest ? LATEST_HASH : pinnedBlockHash,
        },
      });
    }
    if (request.method === 'eth_getStorageAt') {
      assert.equal(request.params[0], USDG_PROXY.toLowerCase());
      assert.equal(request.params[1], IMPLEMENTATION_SLOT);
      assert.ok(['0x7b', '0x7c', 'latest'].includes(request.params[2]));
      return jsonResponse({
        jsonrpc: '2.0',
        id: request.id,
        result: `0x000000000000000000000000${observedImplementationAddress.slice(2)}`,
      });
    }
    if (request.method === 'eth_getCode') {
      const [address, tag] = request.params;
      const normalized = address.toLowerCase();
      let code = '0x';
      if (normalized === POOL_MANAGER.toLowerCase()) code = tag === '0x7b' ? '0x01' : latestPoolCode;
      if (normalized === POSITION_MANAGER.toLowerCase()) code = '0x04';
      if (normalized === PERMIT2.toLowerCase()) code = '0x05';
      if (normalized === USDG_PROXY.toLowerCase()) code = '0x02';
      if (normalized === observedImplementationAddress.toLowerCase()) code = observedImplementationCode;
      if (normalized === UNIVERSAL_ROUTER.toLowerCase()) code = '0x06';
      if (normalized === V4_QUOTER.toLowerCase()) code = '0x08';
      if (normalized === STATE_VIEW.toLowerCase()) code = '0x07';
      return jsonResponse({ jsonrpc: '2.0', id: request.id, result: code });
    }
    throw new Error(`unexpected RPC method ${request.method}`);
  };
  return { fetchImpl, calls };
}

test('verifyForkPin accepts an exact pinned block hash and runtime bundle', async () => {
  const fixture = fakeRpc();
  const report = await verifyForkPin({
    pin: pin(),
    rpcUrl: 'https://rpc.example.invalid',
    fetchImpl: fixture.fetchImpl,
  });

  assert.equal(report.status, 'PASSED');
  assert.equal(report.block.number, 123);
  assert.equal(report.block.hash, PINNED_HASH);
  assert.ok(report.contracts.every((contract) => contract.status === 'PASSED'));
  assert.deepEqual(
    fixture.calls.find((call) => call.method === 'eth_getBlockByNumber').params,
    ['0x7b', false],
  );
});

test('verifyForkPin reports a pinned block hash mismatch as drift', async () => {
  const { fetchImpl } = fakeRpc({
    pinnedBlockHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  });
  const report = await verifyForkPin({
    pin: pin(),
    rpcUrl: 'https://rpc.example.invalid',
    fetchImpl,
  });

  assert.equal(report.status, 'DRIFTED');
  assert.equal(report.block.status, 'DRIFTED');
  assert.match(report.block.reason, /hash/i);
});

test('verifyForkPinAndCurrentHead retains a passing pinned result when current head drifts', async () => {
  const { fetchImpl } = fakeRpc({ latestPoolCode: '0x04' });
  const report = await verifyForkPinAndCurrentHead({
    pin: pin(),
    rpcUrl: 'https://rpc.example.invalid',
    fetchImpl,
  });

  assert.equal(report.pinned.status, 'PASSED');
  assert.equal(report.currentHead.status, 'DRIFTED');
  assert.equal(report.status, 'PASSED_WITH_CURRENT_HEAD_WARNING');
  assert.match(report.currentHead.warning, /warning/i);
});

test('verifyForkPinAndCurrentHead reports a clean pass when the current head matches', async () => {
  const { fetchImpl } = fakeRpc({ latestPoolCode: '0x01' });
  const report = await verifyForkPinAndCurrentHead({
    pin: pin(),
    rpcUrl: 'https://rpc.example.invalid',
    fetchImpl,
  });

  assert.equal(report.pinned.status, 'PASSED');
  assert.equal(report.currentHead.status, 'PASSED');
  assert.equal(report.status, 'PASSED');
  assert.equal(report.currentHead.warning, undefined);
});

test('verifyForkPinAndCurrentHead captures one current-head block before runtime reads', async () => {
  const fixture = fakeRpc({ latestPoolCode: '0x01' });
  const report = await verifyForkPinAndCurrentHead({
    pin: pin(),
    rpcUrl: 'https://rpc.example.invalid',
    fetchImpl: fixture.fetchImpl,
  });

  const latestReads = fixture.calls.filter((call) => call.params.includes('latest'));
  assert.equal(latestReads.length, 1);
  assert.equal(latestReads[0].method, 'eth_getBlockByNumber');
  assert.equal(report.currentHead.block.tag, '0x7c');
});

test('verifyForkPin rejects a missing RPC URL before any request', async () => {
  await assert.rejects(
    () => verifyForkPin({ pin: pin(), rpcUrl: '' }),
    /ROBINHOOD_FORK_RPC_URL is required/,
  );
});

test('verifyForkPin rejects every missing required runtime entry before making an RPC request', async () => {
  const omissions = [
    'poolManager',
    'positionManager',
    'permit2',
    'usdg',
    'universalRouter',
    'v4Quoter',
    'stateView',
  ];

  for (const omitted of omissions) {
    const incomplete = structuredClone(pin());
    delete incomplete.contracts[omitted];
    let calls = 0;
    await assert.rejects(
      () => verifyForkPin({
        pin: incomplete,
        rpcUrl: 'https://rpc.example.invalid',
        fetchImpl: async () => {
          calls += 1;
          throw new Error('schema validation must happen before RPC');
        },
      }),
      /required contract entries/i,
    );
    assert.equal(calls, 0, `${omitted} validation made an RPC request`);
  }

  const missingImplementation = structuredClone(pin());
  delete missingImplementation.contracts.usdg.implementation;
  let calls = 0;
  await assert.rejects(
    () => verifyForkPin({
      pin: missingImplementation,
      rpcUrl: 'https://rpc.example.invalid',
      fetchImpl: async () => {
        calls += 1;
        throw new Error('schema validation must happen before RPC');
      },
    }),
    /contracts\.usdg\.implementation/i,
  );
  assert.equal(calls, 0, 'missing USDG implementation validation made an RPC request');
});

test('verifyForkPin rejects an unexpected runtime entry before making an RPC request', async () => {
  const incomplete = structuredClone(pin());
  incomplete.contracts.unexpected = {
    address: DRIFTED_USDG_IMPLEMENTATION,
    runtimeCodeHash: codeHash('0x08'),
  };
  let calls = 0;

  await assert.rejects(
    () => verifyForkPin({
      pin: incomplete,
      rpcUrl: 'https://rpc.example.invalid',
      fetchImpl: async () => {
        calls += 1;
        throw new Error('schema validation must happen before RPC');
      },
    }),
    /required contract entries/i,
  );
  assert.equal(calls, 0, 'unexpected entry validation made an RPC request');
});

test('verifyForkPin rejects every JSON-to-Solidity pin binding mismatch before RPC', async () => {
  const committed = JSON.parse(readFileSync(resolve(root, 'release/phase3/fork-pin.json'), 'utf8'));
  const source = readFileSync(ARCHIVE_FORK_SOURCE, 'utf8');
  const cases = [
    ['4663', '4664'],
    ['54_484_625', '54_484_624'],
    ['0x88959d6f23a8b713b923fbed50459580c56a1ba5acb4e65707594673bcc26743', '0x88959d6f23a8b713b923fbed50459580c56a1ba5acb4e65707594673bcc26742'],
    [POOL_MANAGER, '0x8366a39CC670B4001A1121B8F6A443A643e40950'],
    ['0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626', '0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95625'],
    [POSITION_MANAGER, '0x58daec3116aae6D93017bAAea7749052E8a04fA8'],
    ['0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2', '0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b1'],
    [PERMIT2, '0x000000000022D473030F116dDEE9F6B43aC78BA4'],
    ['0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca', '0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fc9'],
    [USDG_PROXY, '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d167'],
    ['0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6', '0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a5'],
    [USDG_IMPLEMENTATION, '0x68184C449E1a8f34fA18d289737129FD27B66f8E'],
    ['0x3a551ac5c744af57e68a1d1431ac403c0f516ffd7d224a75746aee11fc4f3baf', '0x3a551ac5c744af57e68a1d1431ac403c0f516ffd7d224a75746aee11fc4f3bae'],
    [UNIVERSAL_ROUTER, '0x06AfBA43Fd06227fA663b0DAecF536f6EaA6bf98'],
    ['0xbe8e8191bb42d843c2e948a5a55772eaab864ce01e54dcd47c9d089170b302d5', '0xbe8e8191bb42d843c2e948a5a55772eaab864ce01e54dcd47c9d089170b302d4'],
    [V4_QUOTER, '0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F93'],
    ['0xd707b1da8cb165e5ea35a3b4450d971eb562ec171e23492aa117036b78a868f6', '0xd707b1da8cb165e5ea35a3b4450d971eb562ec171e23492aa117036b78a868f5'],
    [STATE_VIEW, '0xF3334192D15450CdD385c8B70e03f9A6bD9E673a'],
    ['0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6', '0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a5'],
  ];

  for (const [expected, replacement] of cases) {
    const sourceLiteral = source.match(new RegExp(expected, 'i'))?.[0];
    assert.ok(sourceLiteral, `test fixture did not contain ${expected}`);
    const altered = source.replace(sourceLiteral, replacement);
    let calls = 0;
    await assert.rejects(
      () => verifyForkPin({
        pin: committed,
        rpcUrl: 'https://rpc.example.invalid',
        solidityBindingSource: altered,
        fetchImpl: async () => {
          calls += 1;
          throw new Error('binding validation must happen before RPC');
        },
      }),
      /Solidity fork pin binding mismatch/,
    );
    assert.equal(calls, 0, `${expected} mismatch made an RPC request`);
  }
});

test('verifyForkPin fetches code at an observed EIP-1967 implementation address when the slot drifts', async () => {
  const fixture = fakeRpc({
    observedImplementationAddress: DRIFTED_USDG_IMPLEMENTATION,
    observedImplementationCode: '0x08',
  });
  const report = await verifyForkPin({
    pin: pin(),
    rpcUrl: 'https://rpc.example.invalid',
    fetchImpl: fixture.fetchImpl,
  });

  const usdg = report.contracts.find((contract) => contract.name === 'usdg');
  assert.equal(report.status, 'DRIFTED');
  assert.equal(usdg.status, 'DRIFTED');
  assert.deepEqual(usdg.implementation, {
    address: DRIFTED_USDG_IMPLEMENTATION,
    expectedAddress: USDG_IMPLEMENTATION.toLowerCase(),
    expectedRuntimeCodeHash: codeHash('0x03'),
    observedRuntimeCodeHash: codeHash('0x08'),
    status: 'DRIFTED',
  });

  const implementationCodeCalls = fixture.calls.filter((call) => call.method === 'eth_getCode');
  assert.ok(
    implementationCodeCalls.some((call) => call.params[0] === DRIFTED_USDG_IMPLEMENTATION),
    'the verifier must fetch code at the implementation address reported by the EIP-1967 slot',
  );
  assert.ok(
    !implementationCodeCalls.some((call) => call.params[0] === USDG_IMPLEMENTATION),
    'the verifier must not hash the pinned implementation when the observed slot points elsewhere',
  );
});

test('parseInvocation accepts no arguments and rejects unsupported flags', () => {
  assert.doesNotThrow(() => parseInvocation([]));
  assert.throws(() => parseInvocation(['--pin']), /usage/);
});

test('the committed pin binds the finalized block and every required runtime', () => {
  const committed = JSON.parse(
    readFileSync(resolve(root, 'release/phase3/fork-pin.json'), 'utf8'),
  );

  assert.deepEqual(committed, {
    schemaVersion: 'hookemon.phase3.fork-pin.v1',
    chainId: 4663,
    pinnedBlock: {
      number: 54484625,
      hash: '0x88959d6f23a8b713b923fbed50459580c56a1ba5acb4e65707594673bcc26743',
    },
    contracts: {
      poolManager: {
        address: POOL_MANAGER,
        runtimeCodeHash: '0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626',
      },
      positionManager: {
        address: POSITION_MANAGER,
        runtimeCodeHash: '0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2',
      },
      permit2: {
        address: PERMIT2,
        runtimeCodeHash: '0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca',
      },
      usdg: {
        address: USDG_PROXY,
        runtimeCodeHash: '0x864cc9ad53b338b82da1f7cab85ab0b3d5c8861acb422b6fec63cf36234f36a6',
        implementation: {
          address: USDG_IMPLEMENTATION,
          runtimeCodeHash: '0x3a551ac5c744af57e68a1d1431ac403c0f516ffd7d224a75746aee11fc4f3baf',
        },
      },
      universalRouter: {
        address: UNIVERSAL_ROUTER,
        runtimeCodeHash: '0xbe8e8191bb42d843c2e948a5a55772eaab864ce01e54dcd47c9d089170b302d5',
      },
      v4Quoter: {
        address: V4_QUOTER,
        runtimeCodeHash: '0xd707b1da8cb165e5ea35a3b4450d971eb562ec171e23492aa117036b78a868f6',
      },
      stateView: {
        address: STATE_VIEW,
        runtimeCodeHash: '0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6',
      },
    },
  });
});
