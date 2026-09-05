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
