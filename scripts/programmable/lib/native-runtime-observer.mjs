import { createHash } from 'node:crypto';
import { keccak256Hex } from './keccak.mjs';

// Published chain descriptor and Safe policy captured 2026-09-08; no caller-selectable identities.
const ROLES = {
  "programmableLaunchStampRouter": {
    "address": "0x34965f2a2ee9254522232c32f02056e92be0c98a",
    "runtimeCodeHash": "0x1dbbdaaad901ea3c6134dca0d4872a4789b3c071bf8ccfb44edd65d26d817388"
  },
  "permitAuthority": {
    "address": "0xed617ce7f82e2ab589adeffd319d1d872bc8de06",
    "runtimeCodeHash": "0xd7d408ebcd99b2b70be43e20253d6d92a8ea8fab29bd3be7f55b10032331fb4c"
  },
  "graphFactory": {
    "address": "0x0b6b3f40f84df25d3bd69238f937096177dd09bd",
    "runtimeCodeHash": "0xd23692fae59331592048e71a96d4963e170ee56e449683dc9f7fa3f9470018b8"
  },
  "poolManager": {
    "address": "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    "runtimeCodeHash": "0xbd3881180b547f5fe817545743cfb4343e96b1bc6640dcd70c106b0066e95626"
  },
  "positionManager": {
    "address": "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    "runtimeCodeHash": "0xc873e135dc9aaec88489cfbad146b4cb49d6a32e0d80326377784b7ba17670b2"
  },
  "stateView": {
    "address": "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    "runtimeCodeHash": "0x7d9c591e0956fd89d98feb4ffcfe8bf1f7a62bd485edd979fa21d104b49878a6"
  },
  "v4Quoter": {
    "address": "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
    "runtimeCodeHash": "0xd707b1da8cb165e5ea35a3b4450d971eb562ec171e23492aa117036b78a868f6"
  },
  "permit2": {
    "address": "0x000000000022d473030f116ddee9f6b43ac78ba3",
    "runtimeCodeHash": "0x5208783f52488f7d3493e5e38311ab707c1d75457fe472a19b0b4d57d66a7fca"
  },
  "universalRouter": {
    "address": "0x06afba43fd06227fa663b0daecf536f6eaa6bf99",
    "runtimeCodeHash": "0xbe8e8191bb42d843c2e948a5a55772eaab864ce01e54dcd47c9d089170b302d5"
  }
};
const SAFE_READS = {
  "safeSingletonSlot": {
    "method": "eth_getStorageAt",
    "params": [
      "0xeD617CE7f82e2AB589aDeFFD319D1D872Bc8De06",
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    ],
    "expected": "0x00000000000000000000000041675c099f32341bf84bfc5382af534df5c7461a"
  },
  "safeFallbackHandlerSlot": {
    "method": "eth_getStorageAt",
    "params": [
      "0xeD617CE7f82e2AB589aDeFFD319D1D872Bc8De06",
      "0x6c9a6c4a39284e37ed1cf53d337577d14212a4870fb976a4366c693b939918d5"
    ],
    "expected": "0x000000000000000000000000fd0732dc9e303f09fcef3a7388ad10a83459ec99"
  },
  "safeGuardSlot": {
    "method": "eth_getStorageAt",
    "params": [
      "0xeD617CE7f82e2AB589aDeFFD319D1D872Bc8De06",
      "0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8"
    ],
    "expected": "0x0000000000000000000000000000000000000000000000000000000000000000"
  },
  "safeOwners": {
    "method": "eth_call",
    "params": [
      {
        "to": "0xeD617CE7f82e2AB589aDeFFD319D1D872Bc8De06",
        "data": "0xa0e67e2b"
      }
    ],
    "expected": "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000002000000000000000000000000032b1c7b96793717f0bd2f11eb86cd10cdefc4a30000000000000000000000002bb333d48dfaf1596d9036671d2e43168994249e"
  },
  "safeThreshold": {
    "method": "eth_call",
    "params": [
      {
        "to": "0xeD617CE7f82e2AB589aDeFFD319D1D872Bc8De06",
        "data": "0xe75235b8"
      }
    ],
    "expected": "0x0000000000000000000000000000000000000000000000000000000000000001"
  },
  "safeNonce": {
    "method": "eth_call",
    "params": [
      {
        "to": "0xeD617CE7f82e2AB589aDeFFD319D1D872Bc8De06",
        "data": "0xaffed0e0"
      }
    ]
  },
  "safeModules": {
    "method": "eth_call",
    "params": [
      {
        "to": "0xeD617CE7f82e2AB589aDeFFD319D1D872Bc8De06",
        "data": "0xcc2f845200000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000010"
      }
    ],
    "expected": "0x000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000"
  },
  "safeVersion": {
    "method": "eth_call",
    "params": [
      {
        "to": "0xeD617CE7f82e2AB589aDeFFD319D1D872Bc8De06",
        "data": "0xffa1ad74"
      }
    ],
    "expected": "0x00000000000000000000000000000000000000000000000000000000000000200000000000000000000000000000000000000000000000000000000000000005312e342e31000000000000000000000000000000000000000000000000000000"
  }
};
const GENESIS = '0xaad15f3d702aaea00caf3e9bb56395efe9127bc3b31b24921abf1eee3409305c';
const CAPABILITIES = 'https://api.programmable.market/v4/chains/4663/capabilities';
const SAFE_ABI = 'https://raw.githubusercontent.com/safe-global/safe-deployments/0974182c16c57ca6fe2b9bba8cffb8a7e55fb83c/src/assets/v1.4.1/safe.json';
const SAFE_ABI_SHA = 'a17ad057fb0d047126bd3d802a79e65c8687f9142374b0610d28cf6740ee0e58';
const FALLBACK_ABI = SAFE_ABI.replace('/safe.json', '/compatibility_fallback_handler.json');
const SAFE_IMPLEMENTATIONS = [
  ['singleton', '0x41675c099f32341bf84bfc5382af534df5c7461a', '0x1fe2df852ba3299d6534ef416eefa406e56ced995bca886ab7a553e6d0c5e1c4'],
  ['fallback', '0xfd0732dc9e303f09fcef3a7388ad10a83459ec99', '0x7c6007a5d711cea8dfd5d91f5940ec29c7f200fe511eb1fc1397b367af3c42f9'],
];
// Trust begins at module initialization: the host must supply its native fetch then.
// Capturing it prevents later global replacement; arbitrary pre-import/runtime compromise
// is outside this boundary. The selected HTTPS RPC remains a trusted state observer.
const liveFetch = globalThis.fetch.bind(globalThis);
const SAFE_PROXY_ARTIFACT = 'https://unpkg.com/@safe-global/safe-contracts@1.4.1/build/artifacts/contracts/proxies/SafeProxy.sol/SafeProxy.json';
const SAFE_PROXY_SHA = 'b05eaeaf7278097e52a9e9b38410de2a812c23fa3622373473e73eaa19646ecd';
const snapshots = new WeakMap();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = (code, message) => { throw new Error(`${code}: ${message}`); };
const need = (condition, code, message) => { if (!condition) fail(code, message); };
const encode = value => Buffer.from(JSON.stringify(value));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function fingerprint(result) {
  need(result && Object.keys(result).sort().join() === 'evidenceBytes,runtime', 'UNOBSERVED_RUNTIME', 'invalid result shape');
  const files = Object.keys(result.evidenceBytes).sort().map(path => {
    need(Buffer.isBuffer(result.evidenceBytes[path]), 'UNOBSERVED_RUNTIME', 'evidence must remain binary');
    return [path, sha(result.evidenceBytes[path])];
  });
  return sha(encode([result.runtime, files]));
}
/** Only this process's complete unchanged observation can enter the commitment producer. */
export function assertObservedNativeRuntime(result) {
  need(snapshots.has(result), 'UNOBSERVED_RUNTIME', 'no live observer provenance');
  need(snapshots.get(result) === fingerprint(result), 'OBSERVATION_CHANGED', 'runtime or evidence changed');
  return result;
}
function httpsUrl(value) {
  const url = new URL(value);
  need(url.protocol === 'https:' && !url.username && !url.password && !url.hash, 'INVALID_URL', 'HTTPS without embedded credentials required');
  return url.href;
}
function hexBytes(value) {
  need(typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})+$/.test(value), 'INVALID_CODE', 'nonempty runtime hex required');
  return Buffer.from(value.slice(2), 'hex');
}
function blockIdentity(block) {
  need(block && /^0x[0-9a-f]+$/.test(block.number) && /^0x[0-9a-f]{64}$/.test(block.hash)
    && /^0x[0-9a-f]+$/.test(block.timestamp), 'UNFINALIZED_CHECKPOINT', 'finalized block identity unavailable');
  return { number: block.number, hash: block.hash, timestamp: block.timestamp };
}
function abi(value, role) {
  need(Array.isArray(value) && value.length > 0 && value.every(item => item && typeof item === 'object'
    && ['function', 'constructor', 'event', 'error', 'fallback', 'receive'].includes(item.type)),
  'ABI_CORRESPONDENCE_UNAVAILABLE', `${role} complete ABI unavailable`);
  return value;
}
/** Read-only external runtime observation; never establishes provider admission or wallet authority. */
export async function observeNativeRuntimeAuthority({ rpcUrl = 'https://rpc.mainnet.chain.robinhood.com' } = {}) {
  const endpoint = httpsUrl(rpcUrl);
  need(!new URL(endpoint).search, 'INVALID_URL', 'RPC query credentials are not accepted');
  const evidenceBytes = Object.create(null);
  let id = 0;
  async function request(name, url, payload) {
    url = httpsUrl(url);
    const requestBytes = encode({ url, method: payload ? 'POST' : 'GET', ...(payload ? { body: payload } : {}) });
    evidenceBytes[`requests/${name}.json`] = requestBytes;
    const startedAt = new Date().toISOString();
    const response = await liveFetch(url, { method: payload ? 'POST' : 'GET', redirect: 'error',
      signal: AbortSignal.timeout(15000), ...(payload ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {}) });
    need(!response.redirected && (!response.url || new URL(response.url).origin === new URL(url).origin), 'REDIRECT_REFUSED', 'source origin changed');
    need(response.body && Number(response.headers.get('content-length') ?? 0) <= 2_500_000, 'RESPONSE_TOO_LARGE', 'response exceeds limit');
    const chunks = []; let size = 0;
    for await (const chunk of response.body) { size += chunk.length; if (size > 2_500_000) fail('RESPONSE_TOO_LARGE', 'response exceeds limit'); chunks.push(Buffer.from(chunk)); }
    const bytes = Buffer.concat(chunks);
    evidenceBytes[`responses/${name}.json`] = bytes;
    evidenceBytes[`observations/${name}-transport.json`] = encode({ url, startedAt, finishedAt: new Date().toISOString(), status: response.status,
      requestPath: `requests/${name}.json`, responsePath: `responses/${name}.json`, responseSha256: sha(bytes) });
    need(response.ok, name.startsWith('abi-') ? 'ABI_CORRESPONDENCE_UNAVAILABLE' : 'HTTP_READ_FAILED', `${name} HTTP ${response.status}`);
    try { return JSON.parse(bytes); } catch { fail('INVALID_RESPONSE', `${name} JSON unavailable`); }
  }
  async function rpc(name, method, params) {
    const callId = ++id;
    const response = await request(name, endpoint, { jsonrpc: '2.0', id: callId, method, params });
    need(response?.jsonrpc === '2.0' && response.id === callId && !response.error && Object.hasOwn(response, 'result'), 'RPC_READ_FAILED', `${name}: ${JSON.stringify(response?.error ?? 'invalid envelope')}`);
    return response.result;
  }
  const caps = await request('capabilities', CAPABILITIES);
  need(caps?.apiVersion === 'v4' && caps.chain?.id === '4663' && caps.profile?.profileVersion === '4.1.0', 'DESCRIPTOR_DRIFT', 'provider chain/profile changed');
  const published = caps.chainDeployment?.contracts;
  need(published && Object.keys(published).sort().join() === Object.keys(ROLES).sort().join(), 'DESCRIPTOR_DRIFT', 'nine roles required');
  for (const [role, expected] of Object.entries(ROLES)) need(published[role]?.address?.toLowerCase() === expected.address
    && published[role]?.runtimeCodeHash === expected.runtimeCodeHash, 'DESCRIPTOR_DRIFT', `${role} changed`);
  need(await rpc('chain-id', 'eth_chainId', []) === '0x1237', 'CHAIN_MISMATCH', 'expected 4663');
  need((await rpc('genesis', 'eth_getBlockByNumber', ['0x0', false]))?.hash === GENESIS, 'GENESIS_MISMATCH', 'unexpected genesis');
  const checkpoint = blockIdentity(await rpc('finalized', 'eth_getBlockByNumber', ['finalized', false]));
  const ref = { blockHash: checkpoint.hash, requireCanonical: true };
  const contracts = [];
  for (const role of Object.keys(ROLES).sort()) {
    const expected = ROLES[role];
    const code = hexBytes(await rpc(`${role}-code`, 'eth_getCode', [expected.address, ref]));
    need(keccak256Hex(code) === expected.runtimeCodeHash, 'RUNTIME_MISMATCH', role);
    let completeAbi;
    if (role === 'permitAuthority') {
      const policy = caps.chainDeployment?.permitAuthoritySourceProvenance?.configurationEvidence;
      need(policy?.singleton?.address?.toLowerCase() === SAFE_IMPLEMENTATIONS[0][1]
        && policy.fallbackHandler?.toLowerCase() === SAFE_IMPLEMENTATIONS[1][1]
        && policy.guard === null && policy.threshold === 1
        && same(policy.owners?.map(x => x.toLowerCase()), ['0x032b1c7b96793717f0bd2f11eb86cd10cdefc4a3', '0x2bb333d48dfaf1596d9036671d2e43168994249e'])
        && same(policy.modules, []), 'SAFE_POLICY_DRIFT', 'published Safe policy changed');
      // Official Safe npm release, gitHead bf943f80fec5ac647159d26161446ac5d716a294.
      // This artifact supplies deployedBytecode directly; no creation-code inference.
      const proxy = await request('abi-safe-proxy', SAFE_PROXY_ARTIFACT);
      need(sha(evidenceBytes['responses/abi-safe-proxy.json']) === SAFE_PROXY_SHA
        && proxy.contractName === 'SafeProxy' && proxy.sourceName === 'contracts/proxies/SafeProxy.sol',
      'SAFE_PROXY_SOURCE_DRIFT', 'canonical Safe 1.4.1 proxy artifact changed');
      need(hexBytes(proxy.deployedBytecode).equals(code), 'SAFE_PROXY_RUNTIME_MISMATCH', 'canonical Safe proxy required before delegated policy reads');
      for (const [name, read] of Object.entries(SAFE_READS)) {
        const observed = await rpc(name, read.method, [...read.params, ref]);
        need(name === 'safeNonce' ? /^0x[0-9a-fA-F]{64}$/.test(observed) : observed === read.expected,
          'SAFE_POLICY_DRIFT', name);
      }
      const source = await request('abi-safe', SAFE_ABI);
      need(sha(evidenceBytes['responses/abi-safe.json']) === SAFE_ABI_SHA, 'SAFE_SOURCE_DRIFT', 'pinned Safe ABI bytes changed');
      completeAbi = abi(source.abi, role);
      const fallback = await request('abi-safe-fallback', FALLBACK_ABI);
      need(sha(evidenceBytes['responses/abi-safe-fallback.json']) === 'e5375ff461bf0976f99d2ff80e39208c996ac53073c3871afbfa25d4e93d20d6', 'SAFE_SOURCE_DRIFT', 'pinned fallback ABI bytes changed');
      abi(fallback.abi, 'safe fallback');
      for (const [label, address, expectedHash] of SAFE_IMPLEMENTATIONS) {
        const sourceArtifact = label === 'singleton' ? source : fallback;
        need(sourceArtifact.version === '1.4.1' && sourceArtifact.deployments?.canonical?.address?.toLowerCase() === address
          && sourceArtifact.deployments.canonical.codeHash === expectedHash, 'SAFE_SOURCE_DRIFT', label);
        const implementationCode = hexBytes(await rpc(`safe-${label}-code`, 'eth_getCode', [address, ref]));
        need(keccak256Hex(implementationCode) === expectedHash, 'SAFE_RUNTIME_DRIFT', label);
        evidenceBytes[`code/safe-${label}.bin`] = implementationCode;
      }
    } else {
      const source = await request(`abi-${role}`, `https://sourcify.dev/server/v2/contract/4663/${expected.address}?fields=abi,runtimeBytecode.onchainBytecode,deployment,proxyResolution,compilation`);
      need(source?.chainId === '4663' && source.address?.toLowerCase() === expected.address
        && ['match', 'exact_match'].includes(source.runtimeMatch) && ['match', 'exact_match'].includes(source.match) && source.proxyResolution?.isProxy === false,
      'ABI_CORRESPONDENCE_UNAVAILABLE', `${role} verified non-proxy source unavailable`);
      need(hexBytes(source.runtimeBytecode?.onchainBytecode).equals(code), 'ABI_RUNTIME_MISMATCH', role);
      completeAbi = abi(source.abi, role);
    }
    const codePath = `code/${role}.bin`, abiPath = `abi/${role}.json`, observationPath = `observations/${role}.json`;
    evidenceBytes[codePath] = code;
    evidenceBytes[abiPath] = encode(completeAbi);
    evidenceBytes[observationPath] = encode({ role, address: expected.address, blockNumber: BigInt(checkpoint.number).toString(), blockHash: checkpoint.hash,
      ...(role === 'permitAuthority' ? { abiSource: 'safe-deployments singleton via canonical SafeProxy 1.4.1', proxyArtifactSource: SAFE_PROXY_ARTIFACT, proxyArtifactPath: 'responses/abi-safe-proxy.json' } : {}),
      runtimeKeccak256: expected.runtimeCodeHash, codeResponsePath: `responses/${role}-code.json`, finalitySource: 'responses/finalized.json', binding: 'EIP-1898 requireCanonical' });
    contracts.push({ role, address: expected.address, codePath, abiPath, observationPath, blockNumber: BigInt(checkpoint.number).toString(), blockHash: checkpoint.hash });
  }
  const recheck = blockIdentity(await rpc('checkpoint-recheck', 'eth_getBlockByNumber', [checkpoint.number, false]));
  need(same(recheck, checkpoint), 'CHECKPOINT_CHANGED', 'canonical checkpoint changed');
  const finalizedAgain = blockIdentity(await rpc('finalized-recheck', 'eth_getBlockByNumber', ['finalized', false]));
  need(BigInt(finalizedAgain.number) >= BigInt(checkpoint.number), 'UNFINALIZED_CHECKPOINT', 'finalized height regressed');
  if (finalizedAgain.number === checkpoint.number) need(finalizedAgain.hash === checkpoint.hash, 'CHECKPOINT_CHANGED', 'finalized hash changed');
  const runtime = freeze({ schema: 'hookemon.native-issuance-runtime-authority.v1', chainId: '4663', genesisHash: GENESIS,
    providerProtocol: 'programmable.custom-launch.v4', providerVersion: '4.1.0', contracts,
    evidenceFiles: Object.keys(evidenceBytes).sort().map(path => ({ path, sha256: `0x${sha(evidenceBytes[path])}` })) });
  const result = Object.freeze({ runtime, evidenceBytes: Object.freeze(evidenceBytes) });
  snapshots.set(result, fingerprint(result));
  return result;
}
