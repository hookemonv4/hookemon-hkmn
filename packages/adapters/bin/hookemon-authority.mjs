#!/usr/bin/env node
// Owner-facing tool for the standing-authority document (WP-33 part 2, coordinator directives
// D3/D4). This process never signs anything and never touches a private key — there is
// deliberately no "sign" subcommand here. `print` builds the exact canonical, unsigned document
// (with its `documentDigest`) the owner must sign OUTSIDE this repository, with their own tooling
// (a hardware key, an air-gapped machine, whatever the owner's own operational security requires);
// `verify` loads a signed document from disk and validates it against exactly the rules
// packages/runner/src/cycle/authorization-provider.mjs's `StandingAuthorityProvider` itself
// enforces (imported directly from `../src/signing/standing-authority.mjs`, never reimplemented),
// plus an owner public-key PEM file — a public key is never secret material, so reading it from
// disk here is fine.
import { readFileSync, writeFileSync } from 'node:fs';
import { createPublicKey } from 'node:crypto';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildCanonicalStandingAuthorityDocument,
  loadVerifiedStandingAuthorityDocument,
} from '../src/signing/standing-authority.mjs';

const USAGE = [
  'usage:',
  '  node hookemon-authority.mjs print  --input <plan.json> --policy-public-key <policy-public-key.pem> [--out <file>]',
  '  node hookemon-authority.mjs verify --document <standing-authority.json> --owner-public-key <owner-public-key.pem> [--out <file>]',
  '',
  '"--input <plan.json>" is a JSON object with the fields buildCanonicalStandingAuthorityDocument',
  'needs: owner, perCycleSpendCap, maxCyclesPerDay, allowedPacks, allowedDestinations, issuedAt,',
  'expiresAt, documentId. This tool never signs anything and never reads a private key: "print"',
  'outputs the canonical document for the owner to sign OUTSIDE this repository, with their own',
  'tooling; "verify" checks a signed document against the same rules',
  'packages/runner/src/cycle/authorization-provider.mjs enforces.',
].join('\n');

const KNOWN_FLAGS = new Set(['input', 'policy-public-key', 'document', 'owner-public-key', 'out']);

export function parseArgs(argv) {
  const [mode, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const key = flag?.startsWith('--') ? flag.slice(2) : undefined;
    if (!key || !KNOWN_FLAGS.has(key)) throw new Error(`unknown argument: ${flag}\n\n${USAGE}`);
    index += 1;
    options[key] = rest[index];
  }
  return { mode, options };
}

function requireAbsolute(path, label) {
  if (typeof path !== 'string' || path.length === 0) throw new Error(`${label} is required\n\n${USAGE}`);
  if (!isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  return path;
}

function writeOutput(options, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (options.out) writeFileSync(options.out, text);
  else process.stdout.write(text);
}

export async function runPrint(options) {
  const inputPath = requireAbsolute(options.input, '--input');
  const policyKeyPath = requireAbsolute(options['policy-public-key'], '--policy-public-key');
  const plan = JSON.parse(readFileSync(inputPath, 'utf8'));
  const policyPublicKey = createPublicKey(readFileSync(policyKeyPath, 'utf8'));
  const document = buildCanonicalStandingAuthorityDocument({ ...plan, policyPublicKey });
  writeOutput(options, document);
  return document;
}

export async function runVerify(options) {
  const documentPath = requireAbsolute(options.document, '--document');
  const ownerPublicKeyPath = requireAbsolute(options['owner-public-key'], '--owner-public-key');
  const verified = loadVerifiedStandingAuthorityDocument({ documentPath, ownerPublicKeyPath });
  writeOutput(options, verified);
  return verified;
}

export async function runCli(argv) {
  const { mode, options } = parseArgs(argv);
  if (mode === 'print') return runPrint(options);
  if (mode === 'verify') return runVerify(options);
  throw new Error(`unknown mode: ${mode ?? '(none)'}\n\n${USAGE}`);
}

const isMainModule = (() => {
  try {
    return import.meta.url === pathToFileURL(resolvePath(process.argv[1] ?? '')).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  runCli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`${error?.message ?? String(error)}\n`);
    process.exitCode = 1;
  });
}
