import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { collectNativeBuildClosure } from './native-build-closure.mjs';
import { envelope, sha256 } from './native-issuance-commitments.mjs';
import { assertObservedNativeRuntime } from './native-runtime-observer.mjs';

const REQUIREMENTS_SHA256 = '0xcf8ca1e3d36cc6019b7555b4dd7815730bfadba9543803fff62ff11734b2983d';
// Official solc 0.8.26 macosx-amd64 distribution, independently captured by the coordinator.
// https://binaries.soliditylang.org/macosx-amd64/list.json
const COMPILER_SHA256 = '0x0ff016aef2396b12d1fc65429d8ea6cf53c2ee4b041bb8925644615ee1c30ab9';
const KEYS = new Set(['root', 'compilerPath', 'standardInputPath', 'sourceRoot', 'sourceBundleManifest', 'excludedOutputPaths', 'observedRuntime']);

function requirementsBytes(root) {
  // The collector has already checked every root component; this fixed file is separate from
  // the provider bundle. Its actual bytes must match the independently frozen revision 72.
  const directory = resolve(root, 'specs');
  const path = resolve(directory, 'requirements.json');
  const parent = lstatSync(directory), file = lstatSync(path);
  if (parent.isSymbolicLink() || !parent.isDirectory() || file.isSymbolicLink() || !file.isFile()) {
    throw new TypeError('native commitment inputs: requirements must be a regular file without symlinks');
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== file.dev || opened.ino !== file.ino) throw new TypeError('native commitment inputs: requirements file rebound');
    const bytes = readFileSync(fd);
    if (sha256(bytes) !== REQUIREMENTS_SHA256) throw new TypeError('native commitment inputs: frozen revision-72 requirements mismatch');
    return bytes;
  } finally { closeSync(fd); }
}

/**
 * Prepares verified bytes and the runtime-authority digest, not a constructor prebinding.
 * Runtime must be the original process observation; serialized evidence is insufficient.
 * The compiler binary has one independently pinned distribution SHA. Its complete inline
 * standard-input bytes are collected as supplied, without asserting optimizer/profile approval.
 * Every declared provider-bundle byte is verified and excluded outputs are refused; completeness
 * of that declared inventory and global dependency acyclicity remain producer-policy obligations.
 * Exclusions are caller declarations, not a frozen output policy; this preparation cannot
 * establish anti-self-reference. The materializer must pin its output set before use.
 * No route namespace, nonce, independent deployment values, bindingDigest or readiness is accepted
 * or returned. Provider bundle digests are also omitted: the official CLI hashes canonical
 * bundle content including file bytes, which differs from the repository manifest hash.
 * The next stage must apply the retained checksum-verified official provider coordinate derivation and token/
 * custody artifacts reproduced from this exact compiler/input before committing their identities.
 */
export function prepareNativeCommitmentInputs(options) {
  if (!options || Object.getPrototypeOf(options) !== Object.prototype || Object.keys(options).some(key => !KEYS.has(key))
    || Object.values(Object.getOwnPropertyDescriptors(options)).some(descriptor => descriptor.get || descriptor.set)) {
    throw new TypeError('native commitment inputs: unsupported input or acceptance claim');
  }
  const observedRuntime = assertObservedNativeRuntime(options.observedRuntime);
  const sourceBundleManifest = structuredClone(options.sourceBundleManifest);
  const { sourceClosure, sourceBytes } = collectNativeBuildClosure({
    root: options.root, compilerPath: options.compilerPath, compilerSha256: COMPILER_SHA256,
    standardInputPath: options.standardInputPath, sourceRoot: options.sourceRoot === undefined ? '.' : options.sourceRoot,
    sourceBundleManifest, excludedOutputPaths: options.excludedOutputPaths,
  });
  const requirements = requirementsBytes(options.root);
  // Recheck the private observation after the filesystem work; no caller-supplied digest replaces it.
  assertObservedNativeRuntime(observedRuntime);
  const runtimeAuthorityDigest = envelope('HOOKEMON_NATIVE_ISSUANCE_RUNTIME_AUTHORITY_V1', observedRuntime.runtime);
  return {
    sourceClosure, sourceBytes, requirementsBytes: requirements, requirementsSha256: REQUIREMENTS_SHA256,
    observedRuntime, runtimeAuthorityDigest,
    sourceBundleManifest,
  };
}
