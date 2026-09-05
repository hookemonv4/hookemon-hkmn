#!/usr/bin/env node

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { PackageValidationError, buildLaunchPackage, cliErrorPayload } from './lib/package.mjs';

const requiredOptionNames = [
  'artifactDirectory',
  'standardInputDirectory',
  'launchInputsPath',
  'addressManifestPath',
  'outputDirectory',
];
const materializationOptionNames = [
  'materializedManifestPath',
  'submissionPath',
  'materializedSubmissionOutputPath',
];

function fail(code, path) {
  throw new PackageValidationError(code, path);
}

function isWithin(directory, path) {
  const difference = relative(resolve(directory), resolve(path));
  return difference === '' || (!difference.startsWith('..') && !isAbsolute(difference));
}

function readJson(path, pointer) {
  let bytes;
  try {
    bytes = readFileSync(path);
  } catch {
    fail('INPUT_READ_FAILED', pointer);
  }
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('INVALID_JSON', pointer);
  }
}

function validateMaterializationOutput(options) {
  const output = resolve(options.materializedSubmissionOutputPath);
  if (
    [options.materializedManifestPath, options.submissionPath].map((path) => resolve(path)).includes(output)
    || isWithin(options.outputDirectory, output)
  ) {
    fail('INVALID_PATH', '/materializedSubmissionOutputPath');
  }
  if (existsSync(output)) fail('OUTPUT_EXISTS', '/materializedSubmissionOutputPath');
}

function phaseThreeMaterialization(options) {
  if (options.materializedManifestPath === undefined) return null;
  validateMaterializationOutput(options);
  return {
    materializedManifest: readJson(options.materializedManifestPath, '/materializedManifestPath'),
    submission: readJson(options.submissionPath, '/submissionPath'),
  };
}

function writeMaterializedSubmission(outputPath, submission) {
  try {
    writeFileSync(outputPath, `${JSON.stringify(submission, null, 2)}\n`, { flag: 'wx' });
  } catch (error) {
    if (error?.code === 'EEXIST') fail('OUTPUT_EXISTS', '/materializedSubmissionOutputPath');
    fail('OUTPUT_WRITE_FAILED', '/materializedSubmissionOutputPath');
  }
}

function parseArguments(argv) {
  const options = {};
  const names = new Map([
    ['--artifacts', 'artifactDirectory'],
    ['--standard-json-inputs', 'standardInputDirectory'],
    ['--launch-inputs', 'launchInputsPath'],
    ['--address-manifest', 'addressManifestPath'],
    ['--output', 'outputDirectory'],
    ['--materialized-manifest', 'materializedManifestPath'],
    ['--submission', 'submissionPath'],
    ['--materialized-submission-output', 'materializedSubmissionOutputPath'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const name = names.get(argument);
    if (!name || index + 1 >= argv.length || options[name] !== undefined) throw new Error('invalid arguments');
    options[name] = argv[++index];
  }
  if (requiredOptionNames.some((name) => options[name] === undefined)) throw new Error('invalid arguments');
  const materializationCount = materializationOptionNames
    .filter((name) => options[name] !== undefined)
    .length;
  if (materializationCount !== 0 && materializationCount !== materializationOptionNames.length) {
    fail('INVALID_VALUE', '/phaseThreeMaterialization');
  }
  return options;
}

export function run(argv) {
  const options = parseArguments(argv);
  const materialization = phaseThreeMaterialization(options);
  const result = buildLaunchPackage({
    artifactDirectory: options.artifactDirectory,
    standardInputDirectory: options.standardInputDirectory,
    launchInputsPath: options.launchInputsPath,
    addressManifestPath: options.addressManifestPath,
    outputDirectory: options.outputDirectory,
    ...(materialization === null ? {} : { phaseThreeMaterialization: materialization }),
  });
  const response = {
    ok: true,
    mode: result.mode,
    fileCount: result.fileCount,
    createRequestSha256: result.createRequestSha256,
    unverified: result.unverified.map((entry) => entry.code),
  };
  if (materialization !== null) {
    if (result.materializedSubmission === undefined) fail('INVALID_VALUE', '/phaseThreeMaterialization');
    writeMaterializedSubmission(options.materializedSubmissionOutputPath, result.materializedSubmission);
    response.materializedSubmissionOutput = options.materializedSubmissionOutputPath;
  }
  return response;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.stdout.write(`${JSON.stringify(run(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(cliErrorPayload(error))}\n`);
    process.exitCode = 1;
  }
}
