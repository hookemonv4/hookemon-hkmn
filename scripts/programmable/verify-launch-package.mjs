#!/usr/bin/env node

import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { PackageValidationError, cliErrorPayload, verifyLaunchPackage } from './lib/package.mjs';

const root = resolve(import.meta.dirname, '../..');

function parseArguments(argv) {
  const options = { allowUnverified: false };
  const defaults = {
    artifactDirectory: 'release/phase3/artifacts',
    standardInputDirectory: 'release/phase3/build-info',
    launchInputsPath: 'release/phase3/launch-inputs.json',
    addressManifestPath: 'release/phase3/address-manifest.json',
    packageDirectory: 'release/phase3/package',
    requestMaterializationRoot: root,
  };
  const packagePathNames = new Map([
    ['--artifacts', 'artifactDirectory'],
    ['--standard-json-inputs', 'standardInputDirectory'],
    ['--launch-inputs', 'launchInputsPath'],
    ['--address-manifest', 'addressManifestPath'],
    ['--package', 'packageDirectory'],
  ]);
  const materializationNames = new Map([
    ['--materialized-manifest', 'materializedManifestPath'],
    ['--submission', 'submissionPath'],
    ['--materialized-seed', 'materializedSeedPath'],
  ]);
  const names = new Map([...packagePathNames, ...materializationNames]);
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
  const suppliedPaths = [...packagePathNames.values()].filter((name) => options[name] !== undefined);
  if (suppliedPaths.length !== 0 && suppliedPaths.length !== packagePathNames.size) throw new Error('invalid arguments');
  const materializedManifest = options.materializedManifestPath !== undefined;
  const submission = options.submissionPath !== undefined;
  const materializedSeed = options.materializedSeedPath !== undefined;
  if (materializedManifest !== submission || (materializedSeed && !materializedManifest)) {
    throw new Error('invalid arguments');
  }
  const paths = suppliedPaths.length === 0 ? defaults : { requestMaterializationRoot: root };
  const result = { ...paths, ...options };
  if (materializedManifest) {
    result.materializedManifestInputDirectory = dirname(resolve(options.materializedManifestPath));
  }
  if (materializedManifest) {
    result.phaseThreeMaterialization = {
      materializedManifest: readJson(options.materializedManifestPath, '/materializedManifestPath'),
      submission: readJson(options.submissionPath, '/submissionPath'),
      ...(materializedSeed
        ? { materializedSeed: readJson(options.materializedSeedPath, '/materializedSeedPath') }
        : {}),
    };
  }
  return result;
}

function readJson(path, pointer) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    throw new PackageValidationError('INPUT_READ_FAILED', pointer);
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new PackageValidationError('INVALID_JSON', pointer);
  }
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
