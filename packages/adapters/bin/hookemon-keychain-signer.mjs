#!/usr/bin/env node

import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

import { runEvmKeychainChildProcess } from '../src/signing/keychain-child-evm.mjs';
import { runSolanaWalletKeychainChildProcess } from '../src/signing/operations-wallet-keychain-child.mjs';
import { signRequestDigest } from '../src/signing/signer-client.mjs';

const USAGE = 'Usage: hookemon-keychain-signer.mjs <probe|sign|broadcast> --role <operator-evm|operator-solana> --account <account>';
const DEFAULT_SERVICE = 'hookemon-operations';
const DEFAULT_SECURITY_COMMAND = '/usr/bin/security';
const DEFAULT_TIMEOUT_MS = 10_000;
const ROLE_ACCOUNTS = Object.freeze({
  'operator-evm': 'operator-evm',
  'operator-solana': 'operator-solana',
});

function fail(message) {
  throw new Error(message);
}

function configuredAccount(role) {
  const account = ROLE_ACCOUNTS[role];
  if (!account) fail(`unsupported role: ${String(role)}`);
  return account;
}

function keychainCommand() {
  // The override makes the offline fixture possible. Production uses the absolute macOS path.
  const command = process.env.HOOKEMON_OPERATIONS_SECURITY_COMMAND ?? DEFAULT_SECURITY_COMMAND;
  if (!command.startsWith('/')) fail('Operations Keychain command must be an absolute path');
  return command;
}

function liveMode() {
  return process.env.HOOKEMON_SIGNER_LIVE_MODE === 'true';
}

function timeoutMs() {
  const value = process.env.HOOKEMON_KEYCHAIN_TIMEOUT_MS;
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > DEFAULT_TIMEOUT_MS) {
    fail(`HOOKEMON_KEYCHAIN_TIMEOUT_MS must be a positive safe integer no greater than ${DEFAULT_TIMEOUT_MS}`);
  }
  return parsed;
}

function remainingTimeout(deadline, limit) {
  const remaining = deadline - Date.now();
  if (!Number.isSafeInteger(remaining) || remaining <= 0) fail(`Operations Keychain signer timed out after ${limit}ms`);
  return remaining;
}

export function parseWireArgs(argv) {
  const [operation, ...rest] = argv;
  if (!['probe', 'sign', 'broadcast'].includes(operation)) {
    throw new Error(`operation must be probe, sign, or broadcast\n\n${USAGE}`);
  }
  if (rest.length !== 4 || rest[0] !== '--role' || rest[2] !== '--account') {
    throw new Error(`expected --role and --account\n\n${USAGE}`);
  }
  const [, role, , account] = rest;
  if (!['operator-evm', 'operator-solana'].includes(role)) {
    throw new Error('role must be operator-evm or operator-solana');
  }
  if (typeof account !== 'string' || account.length === 0) throw new Error('account must be non-empty');
  if (account !== configuredAccount(role)) {
    throw new Error(`account ${account} is not configured for role ${role}`);
  }
  return { operation, role, account };
}

async function readSingleJsonLine() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const lines = input.split(/\r?\n/).filter(line => line.length > 0);
  if (lines.length !== 1) fail('keychain signer requires exactly one JSON request line on stdin');
  try {
    return JSON.parse(lines[0]);
  } catch {
    fail('keychain signer received invalid JSON on stdin');
  }
}

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    fail('keychain signer request base64 data is invalid');
  }
  return Buffer.from(value, 'base64');
}

function decodeWireRequest(input, expected) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('keychain signer request must be an object');
  if (input.operation !== expected.operation || input.role !== expected.role || input.account !== expected.account) {
    fail('keychain signer stdin fields do not match the command operation, role, and account');
  }
  if (!input.request || typeof input.request !== 'object' || Array.isArray(input.request)) {
    fail('keychain signer request envelope is required');
  }
  let payload;
  if (input.request.encoding === 'json') {
    payload = input.request.data;
  } else if (input.request.encoding === 'utf8') {
    if (typeof input.request.data !== 'string') fail('keychain signer utf8 request data must be a string');
    payload = input.request.data;
  } else if (input.request.encoding === 'base64') {
    payload = decodeBase64(input.request.data);
  } else {
    fail('keychain signer request encoding must be json, utf8, or base64');
  }
  if (typeof input.digest !== 'string' || input.digest !== signRequestDigest(payload)) {
    fail('keychain signer request digest did not match its payload');
  }
  return payload;
}

function requireObject(value, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(message);
  return value;
}

function solanaRequest(payload) {
  if (typeof payload === 'string' || Buffer.isBuffer(payload) || payload instanceof Uint8Array) {
    return { transactionBase64: Buffer.isBuffer(payload) || payload instanceof Uint8Array ? Buffer.from(payload).toString('base64') : payload };
  }
  const request = requireObject(payload, 'Solana signing requires a base64 transaction string or request object');
  const transactionBase64 = request.transaction ?? request.transactionBase64;
  if (typeof transactionBase64 !== 'string' || transactionBase64.length === 0) {
    fail('Solana signing requires a non-empty base64 transaction string');
  }
  return {
    transactionBase64,
    policy: request.transactionPolicy ?? request.policy,
  };
}

async function solanaPublicIdentity({ account, command, timeout }) {
  const result = await runSolanaWalletKeychainChildProcess({
    operation: 'show',
    service: DEFAULT_SERVICE,
    account,
    keychainCommand: command,
  }, { timeoutMs: timeout });
  if (!result || typeof result.publicKey !== 'string') fail('Operations Solana Keychain entry did not return a public key');
  return result.publicKey;
}

function fixedSolanaReadinessTransaction(publicKey) {
  const identity = new PublicKey(publicKey);
  const transaction = new Transaction({
    feePayer: identity,
    recentBlockhash: SystemProgram.programId.toBase58(),
  }).add(SystemProgram.transfer({
    fromPubkey: identity,
    toPubkey: identity,
    lamports: 0,
  }));
  return transaction.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

async function probeSolana({ account, command, deadline, timeout }) {
  const expectedAccount = await solanaPublicIdentity({ account, command, timeout: remainingTimeout(deadline, timeout) });
  const result = await runSolanaWalletKeychainChildProcess({
    operation: 'sign',
    transactionBase64: fixedSolanaReadinessTransaction(expectedAccount),
    service: DEFAULT_SERVICE,
    account,
    expectedAccount,
    keychainCommand: command,
  }, { timeoutMs: remainingTimeout(deadline, timeout) });
  if (!result || typeof result.signedTxBase64 !== 'string') fail('Solana sign-only readiness check did not return a signed transaction');
  const signed = Transaction.from(Buffer.from(result.signedTxBase64, 'base64'));
  if (!signed.verifySignatures()) fail('Solana sign-only readiness signature did not verify');
  return { ready: true };
}

async function signSolana(payload, { account, command, deadline, timeout, isLive }) {
  const request = solanaRequest(payload);
  if (isLive) {
    fail('live Solana signing requires parent transaction policy evaluation with trusted chain resolvers');
  }
  if (request.policy !== undefined) {
    fail('Solana transaction policy must be evaluated by the parent signer wrapper; trusted chain resolvers cannot cross the JSON keychain wire protocol');
  }
  const expectedAccount = await solanaPublicIdentity({ account, command, timeout: remainingTimeout(deadline, timeout) });
  return runSolanaWalletKeychainChildProcess({
    operation: 'sign',
    transactionBase64: request.transactionBase64,
    service: DEFAULT_SERVICE,
    account,
    expectedAccount,
    keychainCommand: command,
  }, { timeoutMs: remainingTimeout(deadline, timeout) });
}

async function dispatch({ operation, role, account }, payload) {
  const command = keychainCommand();
  const timeout = timeoutMs();
  const deadline = Date.now() + timeout;
  const isLive = liveMode();
  if (operation === 'broadcast') {
    return { error: { code: 'broadcast_not_supported', message: 'broadcast is performed by the configured RPC client' } };
  }
  if (role === 'operator-evm') {
    if (operation === 'probe') {
      const result = await runEvmKeychainChildProcess({
        operation: 'probe',
        service: DEFAULT_SERVICE,
        account,
        keychainCommand: command,
      }, { timeoutMs: timeout });
      if (!result || result.ready !== true) fail('EVM sign-only readiness check did not confirm readiness');
      return { ready: true };
    }
    if (operation === 'sign') {
      return runEvmKeychainChildProcess({
        operation: 'sign',
        service: DEFAULT_SERVICE,
        account,
        keychainCommand: command,
        transaction: payload,
        liveMode: isLive,
      }, { timeoutMs: timeout });
    }
  }
  if (role === 'operator-solana') {
    if (operation === 'probe') return probeSolana({ account, command, deadline, timeout });
    if (operation === 'sign') return signSolana(payload, { account, command, deadline, timeout, isLive });
  }
  fail(`unsupported keychain signer operation: ${operation}`);
}

async function main() {
  const parsed = parseWireArgs(process.argv.slice(2));
  const payload = decodeWireRequest(await readSingleJsonLine(), parsed);
  const result = await dispatch(parsed, payload);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
