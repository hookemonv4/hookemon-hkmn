import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createTestKeychain } from './fixtures/keychain/fixture.mjs';

const BIN_PATH = fileURLToPath(new URL('../bin/hookemon-wallet.mjs', import.meta.url));
const DEFAULT_SERVICE = 'hookemon-operations';
const EVM = Object.freeze({ identity: 'operations-evm', account: 'operator-evm', publicField: 'address' });
const SOLANA = Object.freeze({ identity: 'operations-solana', account: 'operator-solana', publicField: 'publicKey' });

function runProcess(command, args, { env = process.env, input = '', timeoutMs = 5_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
    child.stdin.end(input);
  });
}

async function runWallet(keychain, args, options = {}) {
  return runProcess(BIN_PATH, [...args, '--keychain-command', keychain.command], {
    env: { ...process.env, ...keychain.env },
    ...options,
  });
}

function parseSuccessLines(result) {
  assert.equal(result.timedOut, false, `wallet CLI test command timed out: ${result.stderr}`);
  assert.equal(result.signal, null, `wallet CLI was killed: ${result.stderr}`);
  assert.equal(result.code, 0, result.stderr);
  return result.stdout.trim().split('\n').map(line => JSON.parse(line));
}

function parseSuccess(result) {
  const lines = parseSuccessLines(result);
  assert.equal(lines.length, 1, 'this command must emit exactly one public JSON line');
  return lines[0];
}

function assertNoSecretMaterial(value, secret) {
  const serialized = JSON.stringify(value);
  assert.equal(serialized.includes(secret), false, 'public output must not contain the Keychain secret');
  assert.equal(/"(?:privateKey|secret|seed|mnemonic)"\s*:/i.test(serialized), false, 'public output must not expose a secret-material field');
}

function assertPublicIdentity(value, identity) {
  assert.equal(value.identity, identity.identity);
  assert.deepEqual(value.keychain, { service: DEFAULT_SERVICE, account: identity.account });
  assert.equal(typeof value[identity.publicField], 'string');
  assert.notEqual(value[identity.publicField], '');
  if (identity === EVM) assert.match(value.address, /^0x[0-9a-fA-F]{40}$/);
  else assert.match(value.publicKey, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
}

function publicIdentity(value, identity) {
  return {
    identity: value.identity,
    [identity.publicField]: value[identity.publicField],
    keychain: value.keychain,
  };
}

function walletArgs(command, identity) {
  return [command, '--identity', identity.identity];
}

test('fake security records the interactive Keychain protocol and preserves generic-password replacement semantics', async t => {
  const keychain = await createTestKeychain(t);
  const secret = 'fixture-secret-not-an-argv-value';

  const defaultKeychain = await runProcess(keychain.command, ['default-keychain'], { env: { ...process.env, ...keychain.env } });
  const loginKeychain = await runProcess(keychain.command, ['login-keychain'], { env: { ...process.env, ...keychain.env } });
  assert.equal(defaultKeychain.stdout, `\"${keychain.keychainPath}\"\n`);
  assert.equal(loginKeychain.stdout, defaultKeychain.stdout);

  const added = await runProcess(keychain.command, ['-i'], {
    env: { ...process.env, ...keychain.env },
    input: `add-generic-password -a ${EVM.account} -s ${DEFAULT_SERVICE} -w ${secret} ${keychain.keychainPath}\n`,
  });
  assert.equal(added.code, 0, added.stderr);

  const found = await runProcess(keychain.command, ['find-generic-password', '-a', EVM.account, '-s', DEFAULT_SERVICE, '-w'], {
    env: { ...process.env, ...keychain.env },
  });
  assert.equal(found.code, 0, found.stderr);
  assert.equal(found.stdout, secret);

  const duplicate = await runProcess(keychain.command, ['add-generic-password', '-a', EVM.account, '-s', DEFAULT_SERVICE, '-w'], {
    env: { ...process.env, ...keychain.env },
    input: 'replacement-secret\n',
  });
  assert.notEqual(duplicate.code, 0);
  assert.match(duplicate.stderr, /already exists/i);

  const replaced = await runProcess(keychain.command, ['add-generic-password', '-a', EVM.account, '-s', DEFAULT_SERVICE, '-U', '-w'], {
    env: { ...process.env, ...keychain.env },
    input: 'replacement-secret\n',
  });
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.equal(await keychain.readValue({ service: DEFAULT_SERVICE, account: EVM.account }), 'replacement-secret');

  const records = await keychain.readRecords();
  assert.equal(records.some(record => record.argv.some(argument => argument.includes(secret))), false, 'the fake records its outer argv separately from stdin');
  assert.deepEqual(records.find(record => record.argv.length === 1 && record.argv[0] === '-i'), {
    argv: ['-i'],
    stdin: `add-generic-password -a ${EVM.account} -s ${DEFAULT_SERVICE} -w ${secret} ${keychain.keychainPath}\n`,
  });
});

test('hookemon-wallet generation reports public identities and never sends stored secrets in argv', async t => {
  const keychain = await createTestKeychain(t);
  for (const identity of [EVM, SOLANA]) {
    const generated = parseSuccess(await runWallet(keychain, walletArgs('generate', identity)));
    assertPublicIdentity(generated, identity);

    const secret = await keychain.readValue({ service: DEFAULT_SERVICE, account: identity.account });
    assert.equal(typeof secret, 'string');
    assert.notEqual(secret, '');
    assertNoSecretMaterial(generated, secret);
    assert.equal(generated[identity.publicField].includes(secret), false);

    const records = await keychain.readRecords();
    assert.ok(records.some(record => record.argv.length === 1 && record.argv[0] === '-i'), 'generation must use security -i');
    assert.equal(records.some(record => record.argv.some(argument => argument.includes(secret))), false, 'the Keychain secret must never enter security argv');
  }
});

test('hookemon-wallet generate refuses to overwrite an existing identity without --replace', async t => {
  const keychain = await createTestKeychain(t);
  parseSuccess(await runWallet(keychain, walletArgs('generate', EVM)));

  const refused = await runWallet(keychain, walletArgs('generate', EVM));
  assert.equal(refused.timedOut, false);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /exists|--replace/i);
});

test('hookemon-wallet --replace reports each old public identity before rotating it', async t => {
  const keychain = await createTestKeychain(t);
  for (const identity of [EVM, SOLANA]) {
    const first = parseSuccess(await runWallet(keychain, walletArgs('generate', identity)));
    const replacementLines = parseSuccessLines(await runWallet(keychain, [...walletArgs('generate', identity), '--replace']));
    assert.equal(replacementLines.length, 2, 'replacement must reveal the old public record before writing the new one');
    const [oldPublicRecord, replacement] = replacementLines;

    assertPublicIdentity(replacement, identity);
    assert.notEqual(replacement[identity.publicField], first[identity.publicField], 'replacement must produce a new public identity');
    assert.deepEqual(oldPublicRecord, { replaced: publicIdentity(first, identity) });
    assert.equal(Object.hasOwn(replacement, 'replaced'), false, 'the final public record must follow the pre-replacement record');
    assertNoSecretMaterial(replacement, await keychain.readValue({ service: DEFAULT_SERVICE, account: identity.account }));
  }
});

test('hookemon-wallet show and probe derive each generated public identity', async t => {
  const keychain = await createTestKeychain(t);
  for (const identity of [EVM, SOLANA]) {
    const generated = parseSuccess(await runWallet(keychain, walletArgs('generate', identity)));
    const shown = parseSuccess(await runWallet(keychain, walletArgs('show', identity)));
    const probed = parseSuccess(await runWallet(keychain, walletArgs('probe', identity)));

    assertPublicIdentity(shown, identity);
    assertPublicIdentity(probed, identity);
    assert.equal(probed.ready, true);
    assert.deepEqual(publicIdentity(shown, identity), publicIdentity(generated, identity));
    assert.deepEqual(publicIdentity(probed, identity), publicIdentity(generated, identity));
  }
});

test('hookemon-wallet probe preserves a Keychain interaction denial in stderr', async t => {
  const keychain = await createTestKeychain(t, { mode: 'deny' });
  for (const identity of [EVM, SOLANA]) {
    const denied = await runWallet(keychain, walletArgs('probe', identity));

    assert.equal(denied.timedOut, false);
    assert.notEqual(denied.code, 0);
    assert.match(denied.stderr, /User interaction is not allowed/);
  }
});

test('EVM Keychain child reports a bounded timeout for an unresponsive security command', { timeout: 1_000 }, async t => {
  const keychain = await createTestKeychain(t, { mode: 'hang' });
  const { runEvmKeychainChildProcess } = await import('../src/signing/keychain-child-evm.mjs');
  const previous = Object.fromEntries(Object.keys(keychain.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, keychain.env);
  try {
    await assert.rejects(
      () => runEvmKeychainChildProcess({
        operation: 'probe',
        service: DEFAULT_SERVICE,
        account: EVM.account,
        keychainCommand: keychain.command,
      }, { timeoutMs: 50 }),
      /timed out after 50ms/i,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('Solana Keychain child reports a bounded timeout for an unresponsive security command', { timeout: 1_000 }, async t => {
  const keychain = await createTestKeychain(t, { mode: 'hang' });
  const { runSolanaWalletKeychainChildProcess } = await import('../src/signing/operations-wallet-keychain-child.mjs');
  const previous = Object.fromEntries(Object.keys(keychain.env).map(key => [key, process.env[key]]));
  Object.assign(process.env, keychain.env);
  try {
    await assert.rejects(
      () => runSolanaWalletKeychainChildProcess({
        operation: 'probe',
        service: DEFAULT_SERVICE,
        account: SOLANA.account,
        keychainCommand: keychain.command,
      }, { timeoutMs: 50 }),
      /timed out after 50ms/i,
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('hookemon-wallet export-public writes the documented two-identity public schema', async t => {
  const keychain = await createTestKeychain(t);
  const evm = parseSuccess(await runWallet(keychain, walletArgs('generate', EVM)));
  const solana = parseSuccess(await runWallet(keychain, walletArgs('generate', SOLANA)));
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-wallet-export-'));
  const output = join(directory, 'operations-wallets-public.json');
  t.after(() => rm(directory, { recursive: true, force: true }));

  const exported = await runWallet(keychain, ['export-public', '--out', output]);
  assert.equal(exported.code, 0, exported.stderr);
  const document = JSON.parse(await readFile(output, 'utf8'));

  assert.equal(document.schema, 'hookemon-operations-wallets-v1');
  assert.deepEqual(document.evm, {
    address: evm.address,
    keychain: { service: DEFAULT_SERVICE, account: EVM.account },
  });
  assert.deepEqual(document.solana, {
    publicKey: solana.publicKey,
    keychain: { service: DEFAULT_SERVICE, account: SOLANA.account },
  });
  assert.equal(typeof document.generatedAt, 'string');
  assert.equal(Number.isNaN(Date.parse(document.generatedAt)), false);
  assertNoSecretMaterial(document, await keychain.readValue({ service: DEFAULT_SERVICE, account: EVM.account }));
  assertNoSecretMaterial(document, await keychain.readValue({ service: DEFAULT_SERVICE, account: SOLANA.account }));
});
