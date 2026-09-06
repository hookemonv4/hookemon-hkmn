#!/usr/bin/env node

import { resolve } from 'node:path';

import {
  formatWalletHandoff,
  getPreflightStatus,
  prepareV4PreflightAttempt,
  runPreflight,
  stripSecrets,
} from './lib/preflight-runner.mjs';
import { PROGRAMMABLE_API_BASE_URL } from './lib/preflight-package.mjs';

const root = resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);

function usage() {
  return 'Usage: node scripts/programmable/preflight.mjs --repository-url <https-url> --source-commit <commit> --source-tree <tree> [--launch-attempt <path>] [--new-launch-attempt] [--dry-run | --status <requestId>]';
}

function parseArgs(argv) {
  const options = { mode: 'preflight' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      if (options.mode !== 'preflight') throw new Error(usage());
      options.mode = 'dry-run';
      continue;
    }
    if (arg === '--status') {
      if (options.mode !== 'preflight' || index + 1 >= argv.length) throw new Error(usage());
      options.mode = 'status';
      options.requestId = argv[++index];
      continue;
    }
    if (arg === '--new-launch-attempt') {
      if (options.newLaunchAttempt === true) throw new Error(usage());
      options.newLaunchAttempt = true;
      continue;
    }
    const name = {
      '--repository-url': 'repositoryUrl',
      '--source-commit': 'sourceCommit',
      '--source-tree': 'sourceTree',
      '--launch-attempt': 'launchAttemptPath',
    }[arg];
    if (!name || index + 1 >= argv.length || options[name] !== undefined) throw new Error(usage());
    options[name] = argv[++index];
  }
  if (options.mode !== 'status') {
    for (const name of ['repositoryUrl', 'sourceCommit', 'sourceTree']) {
      if (typeof options[name] !== 'string' || options[name].length === 0) throw new Error(`--${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} is required`);
    }
  } else if (options.launchAttemptPath !== undefined || options.newLaunchAttempt === true) {
    throw new Error(usage());
  }
  return options;
}

function sourceFrom(options) {
  return {
    repositoryUrl: options.repositoryUrl,
    sourceCommit: options.sourceCommit,
    sourceTree: options.sourceTree,
  };
}

async function main() {
  const options = parseArgs(args);
  const baseUrl = PROGRAMMABLE_API_BASE_URL;
  if (options.mode === 'status') {
    const status = await getPreflightStatus({ baseUrl, apiKey: process.env.PROGRAMMABLE_API_KEY, requestId: options.requestId });
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }
  if (options.mode === 'dry-run') {
    const prepared = await prepareV4PreflightAttempt({
      root,
      baseUrl,
      source: sourceFrom(options),
      launchAttemptPath: options.launchAttemptPath,
      newLaunchAttempt: options.newLaunchAttempt === true,
    });
    process.stdout.write(`${JSON.stringify(stripSecrets({
      baseUrl,
      launchAttemptPath: prepared.attemptPath,
      request: prepared.request,
    }), null, 2)}\n`);
    return 0;
  }
  const result = await runPreflight({
    root,
    baseUrl,
    apiKey: process.env.PROGRAMMABLE_API_KEY,
    source: sourceFrom(options),
    launchAttemptPath: options.launchAttemptPath,
    newLaunchAttempt: options.newLaunchAttempt === true,
  });
  process.stdout.write(`${formatWalletHandoff(result)}\n`);
  if (result.mismatches.length > 0) {
    process.stderr.write(`${result.mismatches.join('\n')}\n`);
    return 1;
  }
  return 0;
}

main().then((exitCode) => { process.exitCode = exitCode; }).catch((error) => {
  process.stderr.write(`${stripSecrets(String(error?.message ?? error), { secrets: [process.env.PROGRAMMABLE_API_KEY] })}\n`);
  if (typeof error?.evidencePath === 'string') process.stderr.write(`evidence: ${error.evidencePath}\n`);
  process.exitCode = 1;
});
