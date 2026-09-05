import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Keypair, PublicKey, SystemProgram, Transaction, VersionedTransaction } from '@solana/web3.js';

import {
  readGenericPassword,
  writeGenericPassword,
} from './keychain-secret-store.mjs';

const CHILD_FLAG = '--hookemon-solana-wallet-keychain-child';
const SELF_PATH = fileURLToPath(import.meta.url);
const DEFAULT_TIMEOUT_MS = 10_000;
const FORCE_KILL_GRACE_MS = 100;
const CHILD_CLEANUP_ALLOWANCE_MS = FORCE_KILL_GRACE_MS * 5;
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_VALUES = new Map([...BASE58_ALPHABET].map((character, index) => [character, index]));

export class SolanaWalletKeychainChildError extends Error {}

function fail(message) {
  throw new SolanaWalletKeychainChildError(message);
}

function timeout(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('timeoutMs must be a positive safe integer');
  return value;
}

function encodeBase58(value) {
  const bytes = value instanceof Uint8Array ? value : Uint8Array.from(value);
  if (bytes.length === 0) return '';
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let index = 0; index < digits.length; index += 1) {
      const next = digits[index] * 256 + carry;
      digits[index] = next % 58;
      carry = Math.floor(next / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes += 1;
  return `${'1'.repeat(leadingZeroes)}${digits.reverse().map(digit => BASE58_ALPHABET[digit]).join('')}`;
}

function decodeBase58(value) {
  const bytes = [0];
  for (const character of value) {
    const digit = BASE58_VALUES.get(character);
    if (digit === undefined) fail('Solana Keychain credential is not valid base58');
    let carry = digit;
    for (let index = 0; index < bytes.length; index += 1) {
      const next = bytes[index] * 58 + carry;
      bytes[index] = next & 0xff;
      carry = next >> 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let leadingOnes = 0;
  while (leadingOnes < value.length && value[leadingOnes] === '1') leadingOnes += 1;
  const decoded = bytes.reverse();
  const prefixLength = decoded.length === 1 && decoded[0] === 0 ? leadingOnes - 1 : leadingOnes;
  return Uint8Array.from([...new Array(Math.max(0, prefixLength)).fill(0), ...decoded]);
}

function clearKeypair(keypair) {
  try {
    keypair?.secretKey?.fill(0);
  } catch {
    // The process exits after this isolated child operation.
  }
}

function keypairFromCredential(credential) {
  let decoded;
  try {
    const base58 = credential.toString('ascii');
    decoded = decodeBase58(base58);
    if (decoded.length !== 64) fail(`Solana Keychain credential decodes to ${decoded.length} bytes; expected 64`);
    return { keypair: Keypair.fromSecretKey(decoded), secretBytes: decoded };
  } catch (error) {
    decoded?.fill(0);
    if (error instanceof SolanaWalletKeychainChildError) throw error;
    fail('Solana Keychain credential is not a valid 64-byte secret key');
  }
}

async function withStoredKeypair(request, operation) {
  const credential = await readGenericPassword(request);
  if (credential === null) fail('Operations Solana Keychain entry does not exist; run generate first');
  let loaded;
  try {
    loaded = keypairFromCredential(credential);
    return await operation(loaded.keypair);
  } finally {
    credential.fill(0);
    loaded?.secretBytes.fill(0);
    clearKeypair(loaded?.keypair);
  }
}

function signOnlyProbe(keypair) {
  const transaction = new Transaction({
    feePayer: keypair.publicKey,
    recentBlockhash: SystemProgram.programId.toBase58(),
  }).add(SystemProgram.transfer({
    fromPubkey: keypair.publicKey,
    toPubkey: keypair.publicKey,
    lamports: 0,
  }));
  transaction.partialSign(keypair);
  if (!transaction.verifySignatures()) fail('Solana sign-only readiness signature did not verify');
}

function assertExpectedPublicKey(keypair, value) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('Solana signing requires the expected public key');
  }
  let expected;
  try {
    expected = new PublicKey(value);
  } catch {
    fail('Solana signing expectedAccount must be a valid public key');
  }
  if (!keypair.publicKey.equals(expected)) {
    fail('Solana Keychain credential does not match the configured account');
  }
}

function signSerializedTransaction(transactionBase64, keypair) {
  if (typeof transactionBase64 !== 'string' || transactionBase64.length === 0) {
    fail('Solana signing requires a non-empty base64 transaction string');
  }
  const bytes = Buffer.from(transactionBase64, 'base64');
  try {
    const versioned = VersionedTransaction.deserialize(bytes);
    if (versioned.version !== 'legacy') {
      versioned.sign([keypair]);
      return Buffer.from(versioned.serialize()).toString('base64');
    }
  } catch {
    // Legacy messages retain existing co-signer slots through Transaction.partialSign().
  }
  const legacy = Transaction.from(bytes);
  legacy.partialSign(keypair);
  return legacy.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

async function generate(request) {
  const existing = await readGenericPassword(request);
  let replaced;
  try {
    if (existing !== null) {
      if (request.replace !== true) fail('Operations Solana Keychain entry already exists; pass --replace to rotate it');
      const old = keypairFromCredential(existing);
      try {
        replaced = old.keypair.publicKey.toBase58();
      } finally {
        old.secretBytes.fill(0);
        clearKeypair(old.keypair);
      }
    }
  } finally {
    existing?.fill(0);
  }

  const keypair = Keypair.generate();
  const secret = Buffer.from(encodeBase58(keypair.secretKey), 'ascii');
  try {
    await writeGenericPassword({ ...request, secret, replace: request.replace === true });
    return { publicKey: keypair.publicKey.toBase58(), ...(replaced ? { replaced } : {}) };
  } finally {
    clearKeypair(keypair);
  }
}

async function executeChildRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) fail('Solana wallet keychain child request must be an object');
  const { operation, service, account, keychainCommand } = request;
  const timeoutMs = timeout(request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const keychain = { service, account, keychainCommand, timeoutMs };
  if (operation === 'generate') return generate({ ...keychain, replace: request.replace === true });
  if (operation === 'show') {
    return withStoredKeypair(keychain, keypair => ({ publicKey: keypair.publicKey.toBase58() }));
  }
  if (operation === 'probe') {
    return withStoredKeypair(keychain, keypair => {
      signOnlyProbe(keypair);
      return { ready: true, publicKey: keypair.publicKey.toBase58() };
    });
  }
  if (operation === 'sign') {
    return withStoredKeypair(keychain, keypair => {
      assertExpectedPublicKey(keypair, request.expectedAccount);
      return { signedTxBase64: signSerializedTransaction(request.transactionBase64, keypair) };
    });
  }
  fail(`unsupported Solana wallet keychain operation: ${String(operation)}`);
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
      finish(() => reject(new SolanaWalletKeychainChildError(`Solana wallet keychain child timed out after ${deadline}ms`)));
    }, deadline);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', error => finish(() => reject(new SolanaWalletKeychainChildError(`Solana wallet keychain child failed: ${error.message}`))));
    child.once('close', code => {
      clearTimeout(forceKillTimer);
      finish(() => {
        if (code !== 0) {
          reject(new SolanaWalletKeychainChildError(`Solana wallet keychain child exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
          return;
        }
        let response;
        try {
          response = JSON.parse(stdout);
        } catch {
          reject(new SolanaWalletKeychainChildError('Solana wallet keychain child produced non-JSON stdout'));
          return;
        }
        if (!response || typeof response !== 'object' || response.ok !== true) {
          reject(new SolanaWalletKeychainChildError(`Solana wallet keychain child failed${typeof response?.error === 'string' ? `: ${response.error}` : ''}`));
          return;
        }
        resolve(response.result);
      });
    });
    child.stdin.end(`${JSON.stringify({ ...request, timeoutMs: requestTimeoutMs })}\n`);
  });
}

export async function runSolanaWalletKeychainChildProcess(request, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
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
