#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

import { cliErrorPayload, verifyLaunchPackage } from './lib/package.mjs';

function parseArguments(argv) {
  const options = { allowUnverified: false };
  const defaults = {
    artifactDirectory: 'release/phase3/artifacts',
    standardInputDirectory: 'release/phase3/build-info',
    launchInputsPath: 'release/phase3/launch-inputs.json',
    addressManifestPath: 'release/phase3/address-manifest.json',
    packageDirectory: 'release/phase3/package',
  };
  const names = new Map([
    ['--artifacts', 'artifactDirectory'],
    ['--standard-json-inputs', 'standardInputDirectory'],
    ['--launch-inputs', 'launchInputsPath'],
    ['--address-manifest', 'addressManifestPath'],
    ['--package', 'packageDirectory'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--allow-unverified') {
      if (options.allowUnverified) throw new Error('invalid arguments');
      options.allowUnverified = true;
      continue;
    }
    const name = names.get(argument);
    if (!name || index + 1 >= argv.length || options[name] !== undefined) throw new Error('invalid arguments');
    options[name] = argv[++index];
  }
  const suppliedPaths = [...names.values()].filter((name) => options[name] !== undefined);
  if (suppliedPaths.length === 0) return { ...defaults, ...options };
  if (suppliedPaths.length !== names.size) throw new Error('invalid arguments');
  return options;
}

export function run(argv) {
  const result = verifyLaunchPackage(parseArguments(argv));
  return {
    ok: result.ok,
    mode: result.mode,
    readyForPreflight: result.readyForPreflight,
    createRequestSha256: result.createRequestSha256,
    unverified: result.unverified.map((entry) => entry.code),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(cliErrorPayload(error))}\n`);
    process.exitCode = 1;
  }
}
