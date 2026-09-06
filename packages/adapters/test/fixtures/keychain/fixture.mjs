import { readFile, rm } from 'node:fs/promises';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SECURITY_FIXTURE_PATH = fileURLToPath(new URL('./security', import.meta.url));

function keyFor({ service, account }) {
  return `${service}\u0000${account}`;
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function killHangingFixture(pidPath) {
  try {
    const processId = Number((await readFile(pidPath, 'utf8')).trim());
    if (Number.isSafeInteger(processId) && processId > 0) process.kill(processId, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ENOENT' && error?.code !== 'ESRCH') throw error;
  }
}

// src/signing/keychain-secret-store.mjs's readGenericPassword runs three labeled Keychain
// lookups at the SAME requested timeoutMs (the default/login-keychain discovery pair, then
// find-generic-password): under real cold-start contention, any one of the three fixture
// process spawns - not only find-generic-password - can legitimately be the one whose own
// deadline timer fires first, so any of the three exact messages below is an equally
// legitimate "requested Xms" inner-deadline outcome. This maps an observed message back to
// the exact command that specific deadline timer was guarding, so a test can assert
// precisely which stage's timer fired instead of assuming it was always
// find-generic-password. It does NOT prove the fixture process itself ran far enough to
// record the call: that timer starts immediately after the fixture is spawned, before the
// fixture's own (also cold-starting) Node runtime can necessarily reach its recordCall.
const KEYCHAIN_LOOKUP_STAGE_COMMANDS = new Map([
  ['macOS default keychain lookup', 'default-keychain'],
  ['macOS login keychain lookup', 'login-keychain'],
  ['macOS Keychain lookup', 'find-generic-password'],
]);

/**
 * Returns the fixture command (e.g. "find-generic-password") whose deadline timer must have
 * fired for `message` to be a legitimate "timed out after <timeoutMs>ms" Keychain-lookup
 * error, or `null` if `message` does not exactly match one of the three known labels at
 * that exact timeoutMs (this also discriminates a genuine <timeoutMs>ms deadline from the
 * unrelated 10s production default, and from an unrelated/inherited string). Uses a Map so
 * lookups never fall through to inherited Object.prototype properties (e.g. "toString").
 */
export function keychainLookupTimeoutStage(message, timeoutMs) {
  const suffix = ` timed out after ${timeoutMs}ms`;
  if (typeof message !== 'string' || !message.endsWith(suffix)) return null;
  const label = message.slice(0, -suffix.length);
  return KEYCHAIN_LOOKUP_STAGE_COMMANDS.get(label) ?? null;
}

/** Creates an isolated on-disk fake `security` command. Its paths are test-controlled; no secret is supplied through its environment. */
export async function createTestKeychain(t, { mode = 'success' } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-wallet-keychain-'));
  const recordsPath = join(directory, 'security-records.jsonl');
  const storePath = join(directory, 'security-store.json');
  const keychainPath = join(directory, 'login.keychain-db');
  const pidPath = join(directory, 'security.pid');
  const env = Object.freeze({
    HOOKEMON_TEST_KEYCHAIN_RECORD_PATH: recordsPath,
    HOOKEMON_TEST_KEYCHAIN_STORE_PATH: storePath,
    HOOKEMON_TEST_KEYCHAIN_PATH: keychainPath,
    HOOKEMON_TEST_KEYCHAIN_PID_PATH: pidPath,
    HOOKEMON_TEST_KEYCHAIN_MODE: mode,
  });

  t.after(async () => {
    await killHangingFixture(pidPath);
    await rm(directory, { recursive: true, force: true });
  });

  return Object.freeze({
    command: SECURITY_FIXTURE_PATH,
    directory,
    env,
    keychainPath,
    async readRecords() {
      try {
        const raw = await readFile(recordsPath, 'utf8');
        return raw.split('\n').filter(Boolean).map(line => JSON.parse(line));
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
    },
    async readValue(item) {
      const store = await readJson(storePath, { values: {} });
      return store.values[keyFor(item)];
    },
  });
}
