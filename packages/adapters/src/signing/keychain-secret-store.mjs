import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';

const FORCE_KILL_GRACE_MS = 100;
const MAX_ERROR_TEXT = 500;
const MISSING_ITEM_PATTERN = /could not be found|errsecitemnotfound/i;
const SAFE_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_KEYCHAIN_PATH_PATTERN = /^\/[A-Za-z0-9._/+-]+$/;
const SAFE_SECRET_BYTE = byte => (
  (byte >= 0x30 && byte <= 0x39)
  || (byte >= 0x41 && byte <= 0x5a)
  || (byte >= 0x61 && byte <= 0x7a)
  || byte === 0x2d
  || byte === 0x5f
);

export class KeychainSecretStoreError extends Error {}

function fail(message) {
  throw new KeychainSecretStoreError(message);
}

function truncate(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text.length > MAX_ERROR_TEXT ? `${text.slice(0, MAX_ERROR_TEXT)}…` : text;
}

function assertTimeout(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('keychain timeoutMs must be a positive safe integer');
  return value;
}

function assertKeychainCommand(value) {
  if (typeof value !== 'string' || !isAbsolute(value)) {
    fail('keychainCommand must be an absolute executable path');
  }
  return value;
}

function assertLabel(value, label) {
  if (typeof value !== 'string' || !SAFE_LABEL_PATTERN.test(value)) {
    fail(`${label} must use only letters, numbers, dots, underscores, or hyphens`);
  }
  return value;
}

function assertInteractiveSecret(secret) {
  if (!Buffer.isBuffer(secret) || secret.length === 0 || ![...secret].every(SAFE_SECRET_BYTE)) {
    fail('keychain secret must be a non-empty ASCII token safe for security interactive mode');
  }
}

function runProcess({ command, args, input = Buffer.alloc(0), timeoutMs, label }) {
  return new Promise((resolve, reject) => {
    const deadline = assertTimeout(timeoutMs);
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      reject(new KeychainSecretStoreError(`${label} could not start: ${error.message}`));
      return;
    }

    const stdout = [];
    const stderr = [];
    let settled = false;
    let forceKillTimer;
    const settle = callback => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      callback();
    };
    const deadlineTimer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        // The child may have exited between the timer firing and this call.
      }
      forceKillTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // A cooperative child may already be gone.
        }
      }, FORCE_KILL_GRACE_MS);
      settle(() => reject(new KeychainSecretStoreError(`${label} timed out after ${deadline}ms`)));
    }, deadline);

    child.stdout.on('data', chunk => { stdout.push(Buffer.from(chunk)); });
    child.stderr.on('data', chunk => { stderr.push(Buffer.from(chunk)); });
    child.once('error', error => settle(() => reject(new KeychainSecretStoreError(`${label} failed: ${error.message}`))));
    child.once('close', code => {
      clearTimeout(forceKillTimer);
      settle(() => resolve({
        code: typeof code === 'number' ? code : 1,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr).toString('utf8'),
      }));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

function publicKeychainPath(output, label) {
  let value = output.toString('utf8').trim();
  if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
  if (value.length === 0) fail(`${label} returned an empty keychain path`);
  if (!SAFE_KEYCHAIN_PATH_PATTERN.test(value)) {
    fail(`${label} returned a Keychain path that cannot be passed safely to security interactive mode`);
  }
  return value;
}

async function assertLoginKeychain({ keychainCommand, timeoutMs }) {
  const common = { command: keychainCommand, timeoutMs };
  const [defaultResult, loginResult] = await Promise.all([
    runProcess({ ...common, args: ['default-keychain'], label: 'macOS default keychain lookup' }),
    runProcess({ ...common, args: ['login-keychain'], label: 'macOS login keychain lookup' }),
  ]);
  if (defaultResult.code !== 0) {
    fail(`macOS default keychain lookup exited with code ${defaultResult.code}${defaultResult.stderr ? `: ${truncate(defaultResult.stderr)}` : ''}`);
  }
  if (loginResult.code !== 0) {
    fail(`macOS login keychain lookup exited with code ${loginResult.code}${loginResult.stderr ? `: ${truncate(loginResult.stderr)}` : ''}`);
  }
  const defaultPath = publicKeychainPath(defaultResult.stdout, 'macOS default keychain lookup');
  const loginPath = publicKeychainPath(loginResult.stdout, 'macOS login keychain lookup');
  if (defaultPath !== loginPath) {
    fail('macOS default keychain does not match the login keychain; select the login keychain before using Operations wallets');
  }
  return loginPath;
}

function trimPasswordBuffer(output) {
  let end = output.length;
  while (end > 0 && (output[end - 1] === 0x0a || output[end - 1] === 0x0d)) end -= 1;
  const password = Buffer.from(output.subarray(0, end));
  output.fill(0);
  return password;
}

export async function readGenericPassword({ keychainCommand, service, account, timeoutMs }) {
  assertKeychainCommand(keychainCommand);
  assertLabel(service, 'service');
  assertLabel(account, 'account');
  const deadline = assertTimeout(timeoutMs);
  const loginKeychain = await assertLoginKeychain({ keychainCommand, timeoutMs: deadline });
  const result = await runProcess({
    command: keychainCommand,
    args: ['find-generic-password', '-s', service, '-a', account, '-w', loginKeychain],
    timeoutMs: deadline,
    label: 'macOS Keychain lookup',
  });
  if (result.code === 0) return trimPasswordBuffer(result.stdout);
  result.stdout.fill(0);
  if (MISSING_ITEM_PATTERN.test(result.stderr)) return null;
  fail(`macOS Keychain lookup exited with code ${result.code}${result.stderr ? `: ${truncate(result.stderr)}` : ''}`);
}

export async function writeGenericPassword({ keychainCommand, service, account, secret, replace, timeoutMs }) {
  assertKeychainCommand(keychainCommand);
  assertLabel(service, 'service');
  assertLabel(account, 'account');
  assertInteractiveSecret(secret);
  const deadline = assertTimeout(timeoutMs);
  let input;
  try {
    const loginKeychain = await assertLoginKeychain({ keychainCommand, timeoutMs: deadline });
    const prefix = Buffer.from(
      `add-generic-password -a ${account} -s ${service}${replace === true ? ' -U' : ''} -w `,
      'utf8',
    );
    input = Buffer.concat([prefix, secret, Buffer.from(` ${loginKeychain}\n`)]);
    const result = await runProcess({
      command: keychainCommand,
      args: ['-i'],
      input,
      timeoutMs: deadline,
      label: 'macOS Keychain write',
    });
    if (result.code !== 0) {
      fail(`macOS Keychain write exited with code ${result.code}${result.stderr ? `: ${truncate(result.stderr)}` : ''}`);
    }
  } finally {
    input?.fill(0);
    secret.fill(0);
  }
}
