#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import { canonicalJson, cloneJson, sha256CanonicalJson } from '../programmable/lib/canonical-json.mjs';
import { requireEip55Addresses } from '../programmable/lib/eip55.mjs';
import { AddressDerivationError, deriveAddresses } from './derive-addresses.mjs';

const FACTORY_SOURCE = {
  repository: 'https://github.com/programmablehq/PROGRAMMABLE',
  commit: 'cbcabd3cfc166124485c6f7e7c3951810cf60dc1',
  path: 'contracts/src/ProgrammableCreate2GraphDeployerV1.sol',
  sha256: 'sha256:06a3acaf9beeb68647af231f5524c5a34dc013d99611a1b2d0a6c80895f595e9',
};
const ROUTER_SOURCE = {
  repository: 'https://github.com/programmablehq/PROGRAMMABLE',
  commit: 'cbcabd3cfc166124485c6f7e7c3951810cf60dc1',
  path: 'contracts/src/robinhood-custom-launch/ProgrammableLaunchStampRouterV1.sol',
  sha256: 'sha256:ef87aa9338c364634bffda64423bd3fb096c1630a45cc58ecf854d24959ff163',
};

function fail(message) {
  throw new AddressDerivationError(message);
}

function expectObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  return value;
}

function targetPreimage(target) {
  return {
    targetIndex: target.targetIndex,
    targetId: target.targetId,
    targetIdHash: target.targetIdHash,
    artifactPath: target.artifactPath,
    artifactDigest: target.artifactDigest,
    compilerVersion: target.compilerVersion,
    creationBytecode: target.creationBytecode,
    constructorArguments: target.constructorArguments,
    initCode: target.initCode,
    initCodeHash: target.initCodeHash,
    initializerCalldata: target.initializerCalldata,
    initializerCalldataHash: target.initializerCalldataHash,
    deploymentValue: target.deploymentValue,
    initializerValue: target.initializerValue,
    runtimeTemplateCode: target.runtimeTemplateCode,
    runtimeTemplateCodeHash: target.runtimeTemplateCodeHash,
    runtimeImmutableReferences: target.runtimeImmutableReferences,
    runtimeImmutablePatches: target.runtimeImmutablePatches,
    runtimeCode: target.runtimeCode,
    runtimeCodeHash: target.runtimeCodeHash,
    applicantSalt: target.applicantSalt,
    applicantSaltMode: target.applicantSaltMode,
    effectiveSalt: target.effectiveSalt,
    address: target.address,
  };
}

function buildDigestChain(launchInputs, preimages) {
  const input = sha256CanonicalJson(launchInputs);
  const token = sha256CanonicalJson({ input, target: preimages.targets.token });
  const hook = sha256CanonicalJson({ previous: token, currencyOrdering: preimages.pool, target: preimages.targets.hook });
  const pool = sha256CanonicalJson({ previous: hook, pool: preimages.pool });
  const custody = sha256CanonicalJson({ previous: pool, target: preimages.targets.custody });
  const graph = sha256CanonicalJson({ previous: custody, graph: preimages.graph });
  const manifest = sha256CanonicalJson({
    schemaVersion: 'hookemon.phase3.address-manifest.v1',
    providerSource: { factory: FACTORY_SOURCE, router: ROUTER_SOURCE },
    launchInputs,
    preimages,
    digestChain: { input, token, hook, pool, custody, graph },
  });
  return { input, token, hook, pool, custody, graph, manifest };
}

export function buildAddressManifest({ launchInputs, inputDirectory = process.cwd(), artifactPaths = {}, artifactsDirectory } = {}) {
  const derived = deriveAddresses({ launchInputs, inputDirectory, artifactPaths, artifactsDirectory });
  const preimages = {
    chainId: derived.chain.chainId,
    factory: derived.chain.factory,
    authorizedLauncher: derived.chain.authorizedLauncher,
    routeNamespace: derived.chain.routeNamespace,
    routeNonce: derived.chain.routeNonce,
    compilerProfileDigest: derived.compilerProfileDigest,
    targets: {
      token: targetPreimage(derived.targets.token),
      hook: targetPreimage(derived.targets.hook),
      custody: targetPreimage(derived.targets.custody),
    },
    pool: derived.pool,
    graph: derived.graph,
  };
  const frozenInputs = cloneJson(launchInputs);
  const manifest = {
    schemaVersion: 'hookemon.phase3.address-manifest.v1',
    providerSource: {
      factory: FACTORY_SOURCE,
      router: ROUTER_SOURCE,
    },
    launchInputs: frozenInputs,
    preimages,
    digestChain: buildDigestChain(frozenInputs, preimages),
  };
  requireEip55Addresses(manifest, 'address manifest');
  return manifest;
}

export function verifyAddressManifest({
  manifest,
  launchInputs,
  inputDirectory = process.cwd(),
  artifactPaths = {},
  artifactsDirectory,
} = {}) {
  expectObject(manifest, 'manifest');
  try {
    requireEip55Addresses(manifest, 'address manifest');
  } catch (error) {
    fail(error.message);
  }
  if (manifest.schemaVersion !== 'hookemon.phase3.address-manifest.v1') fail('manifest schema is unsupported');
  expectObject(manifest.launchInputs, 'manifest.launchInputs');
  if (launchInputs !== undefined && canonicalJson(launchInputs) !== canonicalJson(manifest.launchInputs)) {
    fail('launch inputs mismatch manifest.launchInputs');
  }
  const recomputed = buildAddressManifest({
    launchInputs: manifest.launchInputs,
    inputDirectory,
    artifactPaths,
    artifactsDirectory,
  });
  if (canonicalJson(recomputed) !== canonicalJson(manifest)) fail('manifest mismatch');
  return true;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${label} could not be parsed: ${error.message}`);
  }
}

function parseArgs(argv) {
  const options = {
    inputPath: null,
    outputPath: 'release/phase3/address-manifest.json',
    verifyPath: null,
    artifactsDirectory: null,
    artifactPaths: {},
  };
  const artifactFlags = new Map([
    ['--token-artifact', 'token'],
    ['--hook-artifact', 'hook'],
    ['--custody-artifact', 'custody'],
  ]);
  for (let index = 2; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--input') options.inputPath = argv[++index];
    else if (argument === '--output') options.outputPath = argv[++index];
    else if (argument === '--verify') options.verifyPath = argv[++index];
    else if (argument === '--artifacts') options.artifactsDirectory = argv[++index];
    else if (artifactFlags.has(argument)) options.artifactPaths[artifactFlags.get(argument)] = argv[++index];
    else fail(`unrecognized argument: ${argument}`);
  }
  if (!options.inputPath) fail('--input is required');
  if (options.verifyPath && options.outputPath !== 'release/phase3/address-manifest.json') {
    fail('--output cannot be used with --verify');
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv);
  const inputPath = resolve(options.inputPath);
  const inputDirectory = dirname(inputPath);
  const common = {
    inputDirectory,
    artifactPaths: options.artifactPaths,
    artifactsDirectory: options.artifactsDirectory,
  };
  if (options.verifyPath) {
    const manifest = readJson(resolve(options.verifyPath), 'address manifest');
    const launchInputs = readJson(inputPath, 'launch inputs');
    verifyAddressManifest({ manifest, launchInputs, ...common });
    process.stdout.write(`${JSON.stringify({ verified: true, schemaVersion: manifest.schemaVersion }, null, 2)}\n`);
    return;
  }
  const launchInputs = readJson(inputPath, 'launch inputs');
  const manifest = buildAddressManifest({ launchInputs, ...common });
  writeFileSync(resolve(options.outputPath), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
