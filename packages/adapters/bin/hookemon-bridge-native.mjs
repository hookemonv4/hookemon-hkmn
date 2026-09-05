#!/usr/bin/env node

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import destinationBinding from '../../../bindings/robinhood-chain.json' with { type: 'json' };
import { runEvmKeychainChildProcess } from '../src/signing/keychain-child-evm.mjs';
import {
  DESTINATION_CHAIN_ID,
  ORIGIN_CHAIN_ID,
  executeNativeBridge,
  formatNative,
  monitorNativeBridge,
  parseRpcQuantity,
  planNativeBridge,
  rpcQuantity,
} from '../src/ops/native-bridge.mjs';

export const DEFAULT_ORIGIN_RPC_URL = 'https://eth.drpc.org';
export const DESTINATION_CHAIN_RPC_URL = destinationBinding.chain.rpcUrl;
const DEFAULT_TIMEOUT_MS = 900_000;
const DEFAULT_KEYCHAIN_SERVICE = 'hookemon-operations';
const DEFAULT_KEYCHAIN_ACCOUNT = 'operator-evm';
const DEFAULT_KEYCHAIN_COMMAND = '/usr/bin/security';
const USAGE = 'Usage: hookemon-bridge-native --from-chain 1 --to-chain 4663 --amount max|<native> [--rpc-url <url>] [--state-dir <absolute-path>] [--timeout-ms <milliseconds>] [--confirm]';

function fail(message) {
  throw new Error(`${message}\n\n${USAGE}`);
}

export function parseArgs(argv, environment = process.env) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--confirm') {
      if (values.confirm === true) fail('--confirm may be supplied only once');
      values.confirm = true;
      continue;
    }
    if (!['--from-chain', '--to-chain', '--amount', '--rpc-url', '--state-dir', '--timeout-ms'].includes(flag)) fail(`unknown argument: ${flag}`);
    if (values[flag] !== undefined) fail(`${flag} may be supplied only once`);
    const value = argv[++index];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) fail(`${flag} requires a value`);
    values[flag] = value;
  }
  if (values['--from-chain'] !== '1') fail('--from-chain must be 1');
  if (values['--to-chain'] !== '4663') fail('--to-chain must be 4663');
  if (values['--amount'] === undefined) fail('--amount is required');
  if (values['--rpc-url'] !== undefined && !URL.canParse(values['--rpc-url'])) fail('--rpc-url must be an absolute URL');
  if (values['--state-dir'] !== undefined && !isAbsolute(values['--state-dir'])) fail('--state-dir must be an absolute path');
  if (values.confirm === true && values['--state-dir'] === undefined) fail('--state-dir is required with --confirm');
  const timeoutMs = values['--timeout-ms'] === undefined ? DEFAULT_TIMEOUT_MS : Number(values['--timeout-ms']);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) fail('--timeout-ms must be a positive integer');
  return Object.freeze({
    fromChain: ORIGIN_CHAIN_ID,
    toChain: DESTINATION_CHAIN_ID,
    amount: values['--amount'],
    rpcUrl: values['--rpc-url'] ?? environment.HOOKEMON_ORIGIN_RPC_URL ?? DEFAULT_ORIGIN_RPC_URL,
    stateDir: values['--state-dir'] ?? null,
    confirm: values.confirm === true,
    timeoutMs,
  });
}

async function jsonRequest(url, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `${method}-${Date.now()}`, method, params }),
  });
  const body = await response.json();
  if (!response.ok || body?.error) throw new Error(`${method} failed: ${body?.error?.message ?? response.status}`);
  return body?.result;
}

function createEvmRpc(url) {
  return Object.freeze({
    getBalance: async address => parseRpcQuantity(await jsonRequest(url, 'eth_getBalance', [address, 'latest']), 'eth_getBalance'),
    getFeeData: async () => Object.freeze({
      maxFeePerGas: parseRpcQuantity(await jsonRequest(url, 'eth_gasPrice', []), 'eth_gasPrice'),
    }),
    getTransactionCount: async address => parseRpcQuantity(await jsonRequest(url, 'eth_getTransactionCount', [address, 'pending']), 'eth_getTransactionCount'),
    estimateGas: async transaction => parseRpcQuantity(await jsonRequest(url, 'eth_estimateGas', [{
      from: transaction.from,
      to: transaction.to,
      data: transaction.data,
      value: rpcQuantity(transaction.value),
      ...(transaction.maxFeePerGas !== undefined ? { maxFeePerGas: rpcQuantity(transaction.maxFeePerGas) } : {}),
      ...(transaction.maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas: rpcQuantity(transaction.maxPriorityFeePerGas) } : {}),
    }]), 'eth_estimateGas'),
    sendRawTransaction: signedTx => jsonRequest(url, 'eth_sendRawTransaction', [signedTx]),
  });
}

function createRelayClient() {
  return Object.freeze({
    quote: async request => {
      const response = await fetch('https://api.relay.link/quote/v2', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(`Relay quote failed: ${body?.message ?? response.status}`);
      return body;
    },
    status: async requestId => {
      const response = await fetch(`https://api.relay.link/intents/status/v3?requestId=${encodeURIComponent(requestId)}`);
      const body = await response.json();
      if (!response.ok) throw new Error(`Relay status failed: ${body?.message ?? response.status}`);
      return body;
    },
  });
}

export async function createFileState(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return Object.freeze({
    get: async requestId => {
      const path = join(directory, `native-bridge-${requestId.slice(2)}.json`);
      try {
        return JSON.parse(await readFile(path, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
      }
    },
    set: async (requestId, record) => {
      const path = join(directory, `native-bridge-${requestId.slice(2)}.json`);
      await writeFile(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    },
    findPending: async () => {
      const entries = await readdir(directory, { withFileTypes: true });
      const pending = [];
      for (const entry of entries) {
        if (!entry.isFile() || !/^native-bridge-[0-9a-f]{64}\.json$/i.test(entry.name)) continue;
        const record = JSON.parse(await readFile(join(directory, entry.name), 'utf8'));
        if (record?.signedTx && !record.transactionHash) pending.push(record);
      }
      if (pending.length > 1) throw new Error('state directory contains more than one unsigned-origin native bridge record');
      return pending[0] ?? null;
    },
  });
}

export function toKeychainSignRequest({ transaction, transactionPolicy, transactionPolicyRules }) {
  return Object.freeze({
    declaredChainId: ORIGIN_CHAIN_ID,
    allowNonDefaultChain: true,
    transaction,
    transactionPolicy,
    transactionPolicyRules,
  });
}

function createOperationsSigner() {
  return Object.freeze({
    showAddress: async () => (await runEvmKeychainChildProcess({
      operation: 'show', service: DEFAULT_KEYCHAIN_SERVICE, account: DEFAULT_KEYCHAIN_ACCOUNT, keychainCommand: DEFAULT_KEYCHAIN_COMMAND,
    })).address,
    sign: async request => (await runEvmKeychainChildProcess({
      operation: 'sign',
      service: DEFAULT_KEYCHAIN_SERVICE,
      account: DEFAULT_KEYCHAIN_ACCOUNT,
      keychainCommand: DEFAULT_KEYCHAIN_COMMAND,
      liveMode: request.liveMode === true,
      transaction: toKeychainSignRequest(request),
    })).signedTx,
  });
}

export function displayPlan(plan) {
  return {
    from: plan.operationsAddress,
    to: plan.operationsAddress,
    valueNative: formatNative(plan.amount.amountAtomic),
    gasLimit: plan.gas.limit,
    maxFeePerGasWei: plan.gas.maxFeePerGas.amountAtomic,
    gasReserveNative: formatNative(plan.gas.reserve.amountAtomic),
    relayRequestId: plan.requestId,
    expectedReceivedNative: formatNative(plan.destination.amount.amountAtomic),
    expiry: plan.expiry,
  };
}

export async function askForConfirmation({ input = stdin, output = stdout } = {}) {
  const terminal = createInterface({ input, output });
  try {
    return (await terminal.question('Broadcast this native bridge transaction? [y/N] ')).trim().toLowerCase() === 'y';
  } finally {
    terminal.close();
  }
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv, dependencies.environment);
  const originRpc = dependencies.originRpc ?? createEvmRpc(options.rpcUrl);
  const destinationRpc = dependencies.destinationRpc ?? createEvmRpc(DESTINATION_CHAIN_RPC_URL);
  const relay = dependencies.relay ?? createRelayClient();
  const signer = dependencies.signer ?? createOperationsSigner();
  const state = options.confirm ? (dependencies.state ?? await createFileState(options.stateDir)) : null;
  const pending = state && typeof state.findPending === 'function' ? await state.findPending() : null;
  const output = dependencies.output ?? process.stdout;
  if (pending) {
    output.write(`${JSON.stringify({ retry: { requestId: pending.requestId, rawSignedBytesDigest: pending.rawSignedBytesDigest ?? null } })}\n`);
    if (!(await (dependencies.confirm ?? askForConfirmation)())) return 2;
    const transactionHash = await originRpc.sendRawTransaction(pending.signedTx);
    if (typeof transactionHash !== 'string' || !/^0x[0-9a-f]{64}$/i.test(transactionHash)) {
      throw new Error('origin-chain RPC returned an invalid transaction hash while rebroadcasting persisted bytes');
    }
    const record = { ...pending, transactionHash };
    await state.set(record.requestId, record);
    output.write(`${JSON.stringify({ transactionHash, rawSignedBytesDigest: record.rawSignedBytesDigest ?? null })}\n`);
    const result = await monitorNativeBridge({
      requestId: record.requestId,
      expectedDestinationBalanceAtomic: (BigInt(record.destinationBalanceBeforeAtomic) + BigInt(record.expectedDestinationAmountAtomic)).toString(),
      relay,
      destinationRpc,
      maxAttempts: Math.max(1, Math.ceil(options.timeoutMs / 5_000)),
    });
    output.write(`${JSON.stringify(result)}\n`);
    return result.outcome === 'credited' ? 0 : 1;
  }
  const plan = await planNativeBridge({ amount: options.amount, signer, originRpc, relay });
  output.write(`${JSON.stringify({ plan: displayPlan(plan) })}\n`);
  if (!options.confirm) return 2;
  if (!(await (dependencies.confirm ?? askForConfirmation)())) return 2;
  const initialDestinationBalance = await destinationRpc.getBalance(plan.operationsAddress);
  const submission = await executeNativeBridge({
    plan,
    confirm: true,
    signer,
    originRpc,
    state,
    destinationBalanceBeforeAtomic: initialDestinationBalance,
  });
  output.write(`${JSON.stringify({ transactionHash: submission.transactionHash, rawSignedBytesDigest: submission.record.rawSignedBytesDigest })}\n`);
  const expectedBalance = BigInt(initialDestinationBalance) + BigInt(plan.destination.amount.amountAtomic);
  const result = await monitorNativeBridge({
    requestId: plan.requestId,
    expectedDestinationBalanceAtomic: expectedBalance.toString(),
    relay,
    destinationRpc,
    maxAttempts: Math.max(1, Math.ceil(options.timeoutMs / 5_000)),
  });
  output.write(`${JSON.stringify(result)}\n`);
  return result.outcome === 'credited' ? 0 : 1;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
