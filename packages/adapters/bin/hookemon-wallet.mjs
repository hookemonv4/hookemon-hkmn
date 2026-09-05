#!/usr/bin/env node

import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';

import { runEvmKeychainChildProcess } from '../src/signing/keychain-child-evm.mjs';
import { runSolanaWalletKeychainChildProcess } from '../src/signing/operations-wallet-keychain-child.mjs';

const DEFAULT_SERVICE = 'hookemon-operations';
const DEFAULT_KEYCHAIN_COMMAND = '/usr/bin/security';
const DEFAULT_TIMEOUT_MS = 10_000;

const IDENTITIES = Object.freeze({
  'operations-evm': Object.freeze({ account: 'operator-evm', publicField: 'address', run: runEvmKeychainChildProcess }),
  'operations-solana': Object.freeze({ account: 'operator-solana', publicField: 'publicKey', run: runSolanaWalletKeychainChildProcess }),
});

const USAGE = [
  'Usage:',
  '  hookemon-wallet generate --identity operations-evm|operations-solana [--service hookemon-operations] [--keychain-command /usr/bin/security] [--replace]',
  '  hookemon-wallet show --identity operations-evm|operations-solana [--service hookemon-operations] [--keychain-command /usr/bin/security]',
  '  hookemon-wallet probe --identity operations-evm|operations-solana [--service hookemon-operations] [--keychain-command /usr/bin/security]',
  '  hookemon-wallet export-public --out <absolute-path> [--service hookemon-operations] [--keychain-command /usr/bin/security]',
].join('\n');

function fail(message) {
  throw new Error(`${message}\n\n${USAGE}`);
}

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!['generate', 'show', 'probe', 'export-public'].includes(command)) fail('command must be generate, show, probe, or export-public');
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--replace') {
      if (options.replace === true) fail('--replace may be supplied only once');
      options.replace = true;
      continue;
    }
    if (!['--identity', '--service', '--keychain-command', '--out'].includes(flag)) fail(`unknown argument: ${flag}`);
    const value = rest[++index];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) fail(`${flag} requires a value`);
    options[flag.slice(2)] = value;
  }
  if (command === 'export-public') {
    if (options.identity !== undefined) fail('export-public reads both Operations identities and does not accept --identity');
    if (options.replace === true) fail('--replace is valid only with generate');
    if (!options.out) fail('export-public requires --out');
    if (!isAbsolute(options.out)) fail('--out must be an absolute path');
  } else {
    if (!Object.hasOwn(IDENTITIES, options.identity)) fail('--identity must be operations-evm or operations-solana');
    if (options.out !== undefined) fail('--out is valid only with export-public');
    if (options.replace === true && command !== 'generate') fail('--replace is valid only with generate');
  }
  if (options['keychain-command'] !== undefined && !isAbsolute(options['keychain-command'])) {
    fail('--keychain-command must be an absolute path');
  }
  return {
    command,
    identity: options.identity,
    service: options.service ?? DEFAULT_SERVICE,
    keychainCommand: options['keychain-command'] ?? DEFAULT_KEYCHAIN_COMMAND,
    replace: options.replace === true,
    out: options.out,
  };
}

function publicOutput(identity, value, { service, keychainCommand }) {
  const spec = IDENTITIES[identity];
  const publicValue = value[spec.publicField];
  if (typeof publicValue !== 'string' || publicValue.length === 0) throw new Error(`wallet child did not return ${spec.publicField}`);
  return {
    identity,
    [spec.publicField]: publicValue,
    keychain: { service, account: spec.account },
  };
}

async function runIdentity(operation, identity, options) {
  const spec = IDENTITIES[identity];
  const result = await spec.run({
    operation,
    service: options.service,
    account: spec.account,
    keychainCommand: options.keychainCommand,
    ...(operation === 'generate' ? { replace: options.replace } : {}),
  }, { timeoutMs: DEFAULT_TIMEOUT_MS });
  const output = publicOutput(identity, result, options);
  if (operation === 'generate' && result.replaced) {
    return { replaced: publicOutput(identity, { [spec.publicField]: result.replaced }, options), ...output };
  }
  if (operation === 'probe') {
    if (result.ready !== true) throw new Error('wallet child did not confirm sign-only readiness');
    return { ready: true, ...output };
  }
  return output;
}

async function exportPublic(options) {
  const evm = await runIdentity('show', 'operations-evm', options);
  const solana = await runIdentity('show', 'operations-solana', options);
  const document = {
    schema: 'hookemon-operations-wallets-v1',
    evm: { address: evm.address, keychain: evm.keychain },
    solana: { publicKey: solana.publicKey, keychain: solana.keychain },
    generatedAt: new Date().toISOString(),
  };
  await writeFile(options.out, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8' });
  return document;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.command === 'generate' && options.replace) {
    const previous = await runIdentity('show', options.identity, options);
    process.stdout.write(`${JSON.stringify({ replaced: previous })}\n`);
    const generated = await runIdentity('generate', options.identity, options);
    const { replaced: childPrevious, ...result } = generated;
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result;
  }
  const result = options.command === 'export-public'
    ? await exportPublic(options)
    : await runIdentity(options.command, options.identity, options);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  return result;
}

if (import.meta.url === new URL(process.argv[1], 'file:').href) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
