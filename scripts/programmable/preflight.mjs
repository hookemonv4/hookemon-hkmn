#!/usr/bin/env node

import { resolve } from 'node:path';

import {
  formatWalletHandoff,
  getPreflightStatus,
  runPreflight,
  stripSecrets,
} from './lib/preflight-runner.mjs';
import { loadCommittedPreflightPackage, PROGRAMMABLE_API_BASE_URL } from './lib/preflight-package.mjs';

const root = resolve(import.meta.dirname, '../..');
const args = process.argv.slice(2);
const baseUrl = PROGRAMMABLE_API_BASE_URL;

function usage() {
  return 'Usage: node scripts/programmable/preflight.mjs [--dry-run | --status <requestId>]';
}

async function main() {
  if (args.length === 1 && args[0] === '--dry-run') {
    const packageData = loadCommittedPreflightPackage(root);
    process.stdout.write(`${JSON.stringify(stripSecrets({ baseUrl, request: packageData.request }), null, 2)}\n`);
    return 0;
  }
  if (args[0] === '--status') {
    if (args.length !== 2) throw new Error(usage());
    const status = await getPreflightStatus({ baseUrl, apiKey: process.env.PROGRAMMABLE_API_KEY, requestId: args[1] });
    process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }
  if (args.length !== 0) throw new Error(usage());
  const result = await runPreflight({ root, baseUrl, apiKey: process.env.PROGRAMMABLE_API_KEY });
  process.stdout.write(`Preflight evidence: ${result.evidencePath}\n`);
  if (result.mismatches.length > 0) {
    process.stderr.write(`${result.mismatches.join('\n')}\n`);
    return 1;
  }
  process.stdout.write(`${formatWalletHandoff(result)}\n`);
  return 0;
}

main().then((exitCode) => { process.exitCode = exitCode; }).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
