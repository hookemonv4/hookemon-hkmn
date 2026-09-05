import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { keccak256Hex } from './programmable/lib/keccak.mjs';

const RPC_ENV_NAME = 'ROBINHOOD_FORK_RPC_URL';
const IMPLEMENTATION_SLOT =
  '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HASH = /^0x[0-9a-fA-F]{64}$/;
const REQUIRED_CONTRACT_NAMES = [
  'poolManager',
  'positionManager',
  'permit2',
  'usdg',
  'universalRouter',
  'v4Quoter',
  'stateView',
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeAddress(value, label) {
  invariant(ADDRESS.test(value ?? ''), `${label} must be an EVM address`);
  return value.toLowerCase();
}

function normalizeHash(value, label) {
  invariant(HASH.test(value ?? ''), `${label} must be a 32-byte hex hash`);
  return value.toLowerCase();
}

function blockTagFor(number) {
  invariant(Number.isSafeInteger(number) && number >= 0, 'pinnedBlock.number must be a non-negative safe integer');
  return `0x${number.toString(16)}`;
}

function implementationAddress(word) {
  invariant(/^0x[0-9a-fA-F]{64}$/.test(word ?? ''), 'USDG implementation slot must be a 32-byte hex word');
  return `0x${word.slice(-40).toLowerCase()}`;
}

function hashRuntime(code, label) {
  invariant(typeof code === 'string' && /^0x[0-9a-fA-F]*$/.test(code), `${label} runtime code must be hex`);
  invariant(code.length > 2, `${label} runtime code is empty`);
  return keccak256Hex(Buffer.from(code.slice(2), 'hex')).toLowerCase();
}

async function rpcCall({ rpcUrl, method, params, fetchImpl, requestId }) {
  let response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }),
    });
  } catch {
    throw new Error(`RPC request failed for ${method}`);
  }
  if (!response?.ok) throw new Error(`RPC HTTP request failed for ${method}`);

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`RPC response was not JSON for ${method}`);
  }
  if (payload?.error) throw new Error(`RPC returned an error for ${method}`);
  if (!Object.hasOwn(payload ?? {}, 'result')) throw new Error(`RPC response omitted result for ${method}`);
  return payload.result;
}

function validatePin(pin) {
  invariant(pin && typeof pin === 'object', 'fork pin must be an object');
  invariant(pin.schemaVersion === 'hookemon.phase3.fork-pin.v1', 'unsupported fork-pin schemaVersion');
  invariant(pin.chainId === 4663, 'fork pin must target chain ID 4663');
  invariant(pin.pinnedBlock && typeof pin.pinnedBlock === 'object', 'fork pin must include pinnedBlock');
  blockTagFor(pin.pinnedBlock.number);
  normalizeHash(pin.pinnedBlock.hash, 'pinnedBlock.hash');
  invariant(pin.contracts && typeof pin.contracts === 'object', 'fork pin must include contracts');

  const contractNames = Object.keys(pin.contracts);
  invariant(
    contractNames.length === REQUIRED_CONTRACT_NAMES.length
      && REQUIRED_CONTRACT_NAMES.every((name) => Object.hasOwn(pin.contracts, name)),
    'fork pin contracts must contain exactly the required contract entries',
  );

  for (const name of REQUIRED_CONTRACT_NAMES) {
    const contract = pin.contracts[name];
    invariant(contract && typeof contract === 'object', `contracts.${name} must be an object`);
    normalizeAddress(contract.address, `contracts.${name}.address`);
    normalizeHash(contract.runtimeCodeHash, `contracts.${name}.runtimeCodeHash`);

    if (name === 'usdg') {
      invariant(
        contract.implementation && typeof contract.implementation === 'object',
        'contracts.usdg.implementation must be an object',
      );
      normalizeAddress(contract.implementation.address, `contracts.${name}.implementation.address`);
      normalizeHash(
        contract.implementation.runtimeCodeHash,
        `contracts.${name}.implementation.runtimeCodeHash`,
      );
    } else {
      invariant(
        !Object.hasOwn(contract, 'implementation'),
        `contracts.${name} must not include an implementation`,
      );
    }
  }
}

function solidityConstant(source, constantName) {
  invariant(typeof source === 'string', 'Solidity fork pin binding source must be a string');
  const match = source.match(
    new RegExp(`\\b${constantName}\\s*=\\s*(0x[0-9a-fA-F]+|[0-9][0-9_]*)\\s*;`),
  );
  invariant(match, `Solidity fork pin binding mismatch: ${constantName} is missing`);
  return match[1];
}

function assertSolidityPinAddress(source, constantName, expected, label) {
  const observed = normalizeAddress(solidityConstant(source, constantName), constantName);
  invariant(
    observed === normalizeAddress(expected, label),
    `Solidity fork pin binding mismatch: ${label}`,
  );
}

function assertSolidityPinHash(source, constantName, expected, label) {
  const observed = normalizeHash(solidityConstant(source, constantName), constantName);
  invariant(
    observed === normalizeHash(expected, label),
    `Solidity fork pin binding mismatch: ${label}`,
  );
}

function assertSolidityPinUint(source, constantName, expected, label) {
  const literal = solidityConstant(source, constantName).replaceAll('_', '');
  invariant(/^\d+$/.test(literal), `Solidity fork pin binding mismatch: ${label}`);
  invariant(BigInt(literal) === BigInt(expected), `Solidity fork pin binding mismatch: ${label}`);
}

export function validateSolidityForkPinBinding({ pin, source }) {
  validatePin(pin);
  assertSolidityPinUint(source, 'ROBINHOOD_CHAIN_ID', pin.chainId, 'chainId');
  assertSolidityPinUint(source, 'PINNED_BLOCK', pin.pinnedBlock.number, 'pinnedBlock.number');
  assertSolidityPinHash(source, 'PINNED_BLOCK_HASH', pin.pinnedBlock.hash, 'pinnedBlock.hash');

  const contracts = pin.contracts;
  assertSolidityPinAddress(source, 'POOL_MANAGER', contracts.poolManager.address, 'contracts.poolManager.address');
  assertSolidityPinHash(
    source,
    'POOL_MANAGER_RUNTIME_CODEHASH',
    contracts.poolManager.runtimeCodeHash,
    'contracts.poolManager.runtimeCodeHash',
  );
  assertSolidityPinAddress(
    source,
    'POSITION_MANAGER',
    contracts.positionManager.address,
    'contracts.positionManager.address',
  );
  assertSolidityPinHash(
    source,
    'POSITION_MANAGER_RUNTIME_CODEHASH',
    contracts.positionManager.runtimeCodeHash,
    'contracts.positionManager.runtimeCodeHash',
  );
  assertSolidityPinAddress(source, 'PERMIT2', contracts.permit2.address, 'contracts.permit2.address');
  assertSolidityPinHash(
    source,
    'PERMIT2_RUNTIME_CODEHASH',
    contracts.permit2.runtimeCodeHash,
    'contracts.permit2.runtimeCodeHash',
  );
  assertSolidityPinAddress(source, 'USDG', contracts.usdg.address, 'contracts.usdg.address');
  assertSolidityPinHash(
    source,
    'USDG_PROXY_RUNTIME_CODEHASH',
    contracts.usdg.runtimeCodeHash,
    'contracts.usdg.runtimeCodeHash',
  );
  assertSolidityPinAddress(
    source,
    'USDG_IMPLEMENTATION',
    contracts.usdg.implementation.address,
    'contracts.usdg.implementation.address',
  );
  assertSolidityPinHash(
    source,
    'USDG_IMPLEMENTATION_RUNTIME_CODEHASH',
    contracts.usdg.implementation.runtimeCodeHash,
    'contracts.usdg.implementation.runtimeCodeHash',
  );
  assertSolidityPinAddress(
    source,
    'UNIVERSAL_ROUTER',
    contracts.universalRouter.address,
    'contracts.universalRouter.address',
  );
  assertSolidityPinHash(
    source,
    'UNIVERSAL_ROUTER_RUNTIME_CODEHASH',
    contracts.universalRouter.runtimeCodeHash,
    'contracts.universalRouter.runtimeCodeHash',
  );
  assertSolidityPinAddress(source, 'V4_QUOTER', contracts.v4Quoter.address, 'contracts.v4Quoter.address');
  assertSolidityPinHash(
    source,
    'V4_QUOTER_RUNTIME_CODEHASH',
    contracts.v4Quoter.runtimeCodeHash,
    'contracts.v4Quoter.runtimeCodeHash',
  );
  assertSolidityPinAddress(source, 'STATE_VIEW', contracts.stateView.address, 'contracts.stateView.address');
  assertSolidityPinHash(
    source,
    'STATE_VIEW_RUNTIME_CODEHASH',
    contracts.stateView.runtimeCodeHash,
    'contracts.stateView.runtimeCodeHash',
  );
}

function contractsToVerify(pin) {
  const contracts = [];
  for (const name of REQUIRED_CONTRACT_NAMES) {
    const contract = pin.contracts[name];
    contracts.push({
      name,
      address: normalizeAddress(contract.address, `contracts.${name}.address`),
      expectedRuntimeCodeHash: normalizeHash(contract.runtimeCodeHash, `contracts.${name}.runtimeCodeHash`),
      proxy: contract.implementation
        ? {
          expectedImplementationAddress: normalizeAddress(
            contract.implementation.address,
            `contracts.${name}.implementation.address`,
          ),
          expectedImplementationRuntimeCodeHash: normalizeHash(
            contract.implementation.runtimeCodeHash,
            `contracts.${name}.implementation.runtimeCodeHash`,
          ),
        }
        : null,
    });
  }
  return contracts;
}

async function observeContract({ contract, rpcUrl, tag, fetchImpl, requestId }) {
  const runtime = await rpcCall({
    rpcUrl,
    method: 'eth_getCode',
    params: [contract.address, tag],
    fetchImpl,
    requestId: requestId(),
  });
  const observedRuntimeCodeHash = hashRuntime(runtime, contract.name);
  const result = {
    name: contract.name,
    address: contract.address,
    expectedRuntimeCodeHash: contract.expectedRuntimeCodeHash,
    observedRuntimeCodeHash,
    status: observedRuntimeCodeHash === contract.expectedRuntimeCodeHash ? 'PASSED' : 'DRIFTED',
  };

  if (!contract.proxy) return result;

  const implementationSlot = await rpcCall({
    rpcUrl,
    method: 'eth_getStorageAt',
    params: [contract.address, IMPLEMENTATION_SLOT, tag],
    fetchImpl,
    requestId: requestId(),
  });
  const observedImplementationAddress = implementationAddress(implementationSlot);
  const implementationRuntime = await rpcCall({
    rpcUrl,
    method: 'eth_getCode',
    params: [observedImplementationAddress, tag],
    fetchImpl,
    requestId: requestId(),
  });
  const observedImplementationRuntimeCodeHash = hashRuntime(
    implementationRuntime,
    `${contract.name} implementation`,
  );
  const implementationStatus = observedImplementationAddress === contract.proxy.expectedImplementationAddress
    && observedImplementationRuntimeCodeHash === contract.proxy.expectedImplementationRuntimeCodeHash
    ? 'PASSED'
    : 'DRIFTED';
  result.implementation = {
    address: observedImplementationAddress,
    expectedAddress: contract.proxy.expectedImplementationAddress,
    expectedRuntimeCodeHash: contract.proxy.expectedImplementationRuntimeCodeHash,
    observedRuntimeCodeHash: observedImplementationRuntimeCodeHash,
    status: implementationStatus,
  };
  if (implementationStatus !== 'PASSED') result.status = 'DRIFTED';
  return result;
}

/**
 * Verifies the chain, block, runtime bundle, and USDG implementation at one exact block tag.
 * It intentionally returns a drift report instead of embedding endpoint details in thrown errors.
 */
export async function verifyForkPin({
  pin,
  rpcUrl,
  fetchImpl = globalThis.fetch,
  blockTag,
  requirePinnedBlockHash = true,
  solidityBindingSource,
}) {
  validatePin(pin);
  if (solidityBindingSource !== undefined) {
    validateSolidityForkPinBinding({ pin, source: solidityBindingSource });
  }
  invariant(typeof rpcUrl === 'string' && rpcUrl.length > 0, `${RPC_ENV_NAME} is required`);
  invariant(typeof fetchImpl === 'function', 'fetchImpl must be a function');

  let id = 0;
  const requestId = () => ++id;
  const tag = blockTag ?? blockTagFor(pin.pinnedBlock.number);
  const observedChainId = await rpcCall({
    rpcUrl,
    method: 'eth_chainId',
    params: [],
    fetchImpl,
    requestId: requestId(),
  });
  const expectedChainId = `0x${pin.chainId.toString(16)}`;
  const chainStatus = observedChainId?.toLowerCase() === expectedChainId ? 'PASSED' : 'DRIFTED';
  const block = await rpcCall({
    rpcUrl,
    method: 'eth_getBlockByNumber',
    params: [tag, false],
    fetchImpl,
    requestId: requestId(),
  });
  invariant(block?.number && block?.hash, `RPC returned an incomplete block for ${tag}`);

  const expectedBlockHash = normalizeHash(pin.pinnedBlock.hash, 'pinnedBlock.hash');
  const expectedBlockNumber = blockTagFor(pin.pinnedBlock.number);
  const observedBlockHash = normalizeHash(block.hash, `block hash for ${tag}`);
  const observedBlockNumber = typeof block.number === 'string' ? block.number.toLowerCase() : null;
  const blockMatches = requirePinnedBlockHash
    ? observedBlockNumber === expectedBlockNumber && observedBlockHash === expectedBlockHash
    : true;

  const observationTag = requirePinnedBlockHash
    ? tag
    : blockTagFor(Number.parseInt(observedBlockNumber, 16));
  const contracts = [];
  for (const contract of contractsToVerify(pin)) {
    contracts.push(await observeContract({
      contract,
      rpcUrl,
      tag: observationTag,
      fetchImpl,
      requestId,
    }));
  }

  const status = chainStatus === 'PASSED' && blockMatches && contracts.every((contract) => contract.status === 'PASSED')
    ? 'PASSED'
    : 'DRIFTED';
  return {
    schemaVersion: 'hookemon.fork-pin-verification.v1',
    status,
    chain: { expectedId: pin.chainId, observedId: observedChainId, status: chainStatus },
    block: {
      tag: observationTag,
      expectedNumber: requirePinnedBlockHash ? pin.pinnedBlock.number : null,
      expectedHash: requirePinnedBlockHash ? expectedBlockHash : null,
      number: Number.parseInt(observedBlockNumber, 16),
      hash: observedBlockHash,
      status: blockMatches ? 'PASSED' : 'DRIFTED',
      ...(blockMatches ? {} : { reason: 'Pinned block number or hash did not match.' }),
    },
    contracts,
  };
}

/**
 * Keeps current-head drift observational: only a pinned verification failure is fatal to callers.
 */
export async function verifyForkPinAndCurrentHead({ pin, rpcUrl, fetchImpl = globalThis.fetch }) {
  const pinned = await verifyForkPin({ pin, rpcUrl, fetchImpl });
  let currentHead;
  try {
    currentHead = await verifyForkPin({
      pin,
      rpcUrl,
      fetchImpl,
      blockTag: 'latest',
      requirePinnedBlockHash: false,
    });
    if (currentHead.status !== 'PASSED') {
      currentHead.warning = 'WARNING: current-head runtime bundle differs from the pinned archive bundle.';
    }
  } catch {
    currentHead = {
      schemaVersion: 'hookemon.fork-pin-verification.v1',
      status: 'UNAVAILABLE',
      warning: 'WARNING: current-head canary could not be observed; the pinned archive result remains authoritative.',
    };
  }
  return {
    schemaVersion: 'hookemon.fork-pin-canary.v1',
    status: pinned.status !== 'PASSED'
      ? 'DRIFTED'
      : currentHead.status === 'PASSED'
        ? 'PASSED'
        : 'PASSED_WITH_CURRENT_HEAD_WARNING',
    pinned,
    currentHead,
  };
}

export function parseInvocation(argv) {
  invariant(argv.length === 0, 'usage: node scripts/verify-fork-pin.mjs');
}

async function main() {
  parseInvocation(process.argv.slice(2));
  const rpcUrl = process.env[RPC_ENV_NAME];
  invariant(typeof rpcUrl === 'string' && rpcUrl.length > 0, `${RPC_ENV_NAME} is required`);
  const pinPath = path.resolve('release/phase3/fork-pin.json');
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  const solidityBindingPath = path.resolve(
    'packages/contracts/test/integration/RobinhoodV4ArchiveFork.t.sol',
  );
  validateSolidityForkPinBinding({ pin, source: readFileSync(solidityBindingPath, 'utf8') });
  const report = await verifyForkPinAndCurrentHead({ pin, rpcUrl });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.currentHead.warning) process.stderr.write(`${report.currentHead.warning}\n`);
  if (report.pinned.status !== 'PASSED') process.exitCode = 1;
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
