import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { getAddress, isAddress, recoverAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

import {
  decodeProviderTransaction,
  evaluate,
  revalidateSignedMessage,
} from './transaction-policy.mjs';
import {
  KeychainSecretStoreError,
  readGenericPassword,
  writeGenericPassword,
} from './keychain-secret-store.mjs';

const CHILD_FLAG = '--hookemon-evm-keychain-child';
const SELF_PATH = fileURLToPath(import.meta.url);
const DEFAULT_TIMEOUT_MS = 10_000;
const FORCE_KILL_GRACE_MS = 100;
const CHILD_CLEANUP_ALLOWANCE_MS = FORCE_KILL_GRACE_MS * 5;
const READINESS_DIGEST = `0x${'5a'.repeat(32)}`;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-f]{64}$/i;
const EVM_ATOMIC_FIELDS = [
  'nonce',
  'value',
  'gas',
  'gasPrice',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
];

export class EvmKeychainChildError extends Error {}

function fail(message) {
  throw new EvmKeychainChildError(message);
}

function timeout(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('timeoutMs must be a positive safe integer');
  return value;
}

function publicIdentity(address) {
  return getAddress(address);
}

function privateKeyFromCredential(credential) {
  const privateKey = credential.toString('ascii');
  if (!PRIVATE_KEY_PATTERN.test(privateKey)) fail('EVM Keychain credential must be a 0x-prefixed 32-byte hex private key');
  return privateKey;
}

function accountFromCredential(credential) {
  return privateKeyToAccount(privateKeyFromCredential(credential));
}

async function withStoredAccount(request, operation) {
  const credential = await readGenericPassword(request);
  if (credential === null) fail('Operations EVM Keychain entry does not exist; run generate first');
  try {
    return await operation(accountFromCredential(credential));
  } finally {
    credential.fill(0);
  }
}

function canonicalChainId(value, label) {
  try {
    const chainId = BigInt(value);
    if (chainId <= 0n || chainId > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error();
    return chainId;
  } catch {
    fail(`${label} must be a positive safe integer chain ID`);
  }
}

function viemAtomic(value, label) {
  if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 0)) {
    fail(`${label} must be a non-negative safe integer`);
  }
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') {
    fail(`${label} must be an integer`);
  }
  try {
    const atomic = BigInt(value);
    if (atomic < 0n) fail(`${label} must not be negative`);
    return atomic;
  } catch (error) {
    if (error instanceof EvmKeychainChildError) throw error;
    fail(`${label} must be an integer`);
  }
}

function transactionForSigning(transaction, account) {
  if (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)) {
    fail('EVM signing requires an unsigned transaction object');
  }
  const declaredChainId = transaction.declaredChainId ?? transaction.chainId;
  const nested = transaction.transaction && typeof transaction.transaction === 'object' && !Array.isArray(transaction.transaction)
    ? transaction.transaction
    : transaction;
  const transactionChainId = nested.chainId ?? declaredChainId;
  if (transactionChainId === undefined) fail('EVM signing request must declare chainId');
  const declared = canonicalChainId(declaredChainId ?? transactionChainId, 'declared chainId');
  const actual = canonicalChainId(transactionChainId, 'transaction chainId');
  if (declared !== actual) fail('EVM transaction chainId does not match the request declared chainId');
  if (actual !== 4663n && transaction.allowNonDefaultChain !== true) {
    fail('EVM transaction chainId must be 4663 unless allowNonDefaultChain is explicitly true');
  }
  if (nested.from !== undefined && nested.from !== null) {
    if (typeof nested.from !== 'string' || !isAddress(nested.from) || getAddress(nested.from) !== account.address) {
      fail('EVM transaction source does not match the stored Operations EVM identity');
    }
  }
  const { from, ...unsigned } = nested;
  unsigned.chainId = Number(actual);
  for (const field of EVM_ATOMIC_FIELDS) {
    if (unsigned[field] !== undefined && unsigned[field] !== null) {
      unsigned[field] = viemAtomic(unsigned[field], `EVM transaction ${field}`);
    }
  }
  return {
    unsigned,
    policyTransaction: { ...nested, chainId: Number(actual), from: account.address },
    policy: transaction.transactionPolicy ?? transaction.policy,
    policyRules: transaction.transactionPolicyRules ?? transaction.policyRules,
    decodeOptions: transaction.transactionDecodeOptions ?? transaction.decodeOptions ?? {},
  };
}

async function signTransaction(request, account) {
  const signing = transactionForSigning(request.transaction ?? request, account);
  if (request.liveMode === true && signing.policy === undefined) {
    fail('live EVM signing requires an explicit transaction policy');
  }
  let approved;
  let policyInput;
  if (signing.policy !== undefined) {
    policyInput = { ...signing.decodeOptions, family: 'evm', transaction: signing.policyTransaction };
    approved = await decodeProviderTransaction(policyInput);
    evaluate(signing.policy, approved, { rules: signing.policyRules });
  }
  let signedTx;
  try {
    signedTx = await account.signTransaction(signing.unsigned);
  } catch (error) {
    fail(`EVM transaction could not be signed: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (approved) {
    const redecoded = await revalidateSignedMessage({ signedTx }, approved, policyInput);
    evaluate(signing.policy, redecoded, { rules: signing.policyRules });
  }
  return { signedTx };
}

async function generate(request) {
  const existing = await readGenericPassword(request);
  let replaced;
  try {
    if (existing !== null) {
      if (request.replace !== true) fail('Operations EVM Keychain entry already exists; pass --replace to rotate it');
      replaced = publicIdentity(accountFromCredential(existing).address);
    }
  } finally {
    existing?.fill(0);
  }

  const privateKey = generatePrivateKey();
  const secret = Buffer.from(privateKey, 'ascii');
  const account = privateKeyToAccount(privateKey);
  await writeGenericPassword({ ...request, secret, replace: request.replace === true });
  return { address: publicIdentity(account.address), ...(replaced ? { replaced } : {}) };
}

async function executeChildRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('EVM keychain child request must be an object');
  const { operation, service, account, keychainCommand } = request;
  const timeoutMs = timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const keychain = { service, account, keychainCommand, timeoutMs };
  if (operation === 'generate') return generate({ ...keychain, replace: request.replace === true });
  if (operation === 'show') {
    return withStoredAccount(keychain, stored => ({ address: publicIdentity(stored.address) }));
  }
  if (operation === 'probe') {
    return withStoredAccount(keychain, async stored => {
      const signature = await stored.sign({ hash: READINESS_DIGEST });
      const recovered = await recoverAddress({ hash: READINESS_DIGEST, signature });
      if (getAddress(recovered) !== stored.address) fail('EVM sign-only readiness recovery did not match the stored identity');
      return { ready: true, address: publicIdentity(stored.address) };
    });
  }
  if (operation === 'sign') {
    return withStoredAccount(keychain, stored => signTransaction({ ...request, liveMode: request.liveMode === true }, stored));
  }
  fail(`unsupported EVM keychain operation: ${String(operation)}`);
}

function runChildProcess({ request, timeoutMs, requestTimeoutMs }) {
  return new Promise((resolve, reject) => {
    const deadline = timeout(timeoutMs);
    const child = spawn(process.execPath, [SELF_PATH, CHILD_FLAG], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let forceKillTimer;
    const finish = callback => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      callback();
    };
    const deadlineTimer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // The child may have exited just before the deadline.
      }
      forceKillTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // A cooperative child may already be gone.
        }
      }, FORCE_KILL_GRACE_MS);
      finish(() => reject(new EvmKeychainChildError(`EVM keychain child timed out after ${deadline}ms`)));
    }, deadline);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => finish(() => reject(new EvmKeychainChildError(`EVM keychain child failed: ${error.message}`))));
    child.once('close', code => {
      clearTimeout(forceKillTimer);
      finish(() => {
        if (code !== 0) {
          reject(new EvmKeychainChildError(`EVM keychain child exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
          return;
        }
        let response;
        try {
          response = JSON.parse(stdout);
        } catch {
          reject(new EvmKeychainChildError('EVM keychain child produced non-JSON stdout'));
          return;
        }
        if (!response || typeof response !== 'object' || response.ok !== true) {
          reject(new EvmKeychainChildError(`EVM keychain child failed${typeof response?.error === 'string' ? `: ${response.error}` : ''}`));
          return;
        }
        resolve(response.result);
      });
    });
    child.stdin.end(`${JSON.stringify({ ...request, timeoutMs: requestTimeoutMs })}\n`);
  });
}

export async function runEvmKeychainChildProcess(request, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const deadline = timeout(timeoutMs);
  return runChildProcess({
    request,
    timeoutMs: deadline + CHILD_CLEANUP_ALLOWANCE_MS,
    requestTimeoutMs: deadline,
  });
}

async function childMain() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  try {
    const result = await executeChildRequest(JSON.parse(input));
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ ok: false, error: message.slice(0, 500) })}\n`);
  }
}

if (process.argv.includes(CHILD_FLAG)) {
  childMain().catch(error => {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`${JSON.stringify({ ok: false, error: message.slice(0, 500) })}\n`);
  });
}

export { KeychainSecretStoreError };
