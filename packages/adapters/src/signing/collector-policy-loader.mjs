import { readFile } from 'node:fs/promises';

import { canonicalJson, digest } from '../../../runner/src/cycle/journal.mjs';
import {
  createCanonicalTransactionPolicy,
  createTransactionPolicy,
  decodeProviderTransaction,
} from './transaction-policy.mjs';

export const COLLECTOR_POLICY_BUNDLE_SCHEMA = 'hookemon.collector-policy-bundle.v1';
export const COLLECTOR_POLICY_SPECIMEN_SCHEMA = 'hookemon.collector-policy-specimen.v1';

const BUNDLE_URL = new URL('../../rehearsal/collector-policy/bundle.json', import.meta.url);
const ACTIONS = Object.freeze(['purchase', 'open', 'buyback']);
const loadedBundles = new WeakSet();
const BUNDLE_FIELDS = Object.freeze(['schema', 'version', 'provider', 'chainId', 'integrity', 'runtime', 'specimens']);
const INTEGRITY_FIELDS = Object.freeze(['algorithm', 'digest']);
const SPECIMEN_REFERENCE_FIELDS = Object.freeze(['action', 'path', 'digest']);
const SPECIMEN_FIELDS = Object.freeze([
  'schema', 'action', 'signature', 'slot', 'observedAt', 'source', 'transactionBase64', 'roles', 'decoded',
]);
const DECODED_FIELDS = Object.freeze([
  'family', 'format', 'chainId', 'nonce', 'programIds', 'addressLookupTables', 'target', 'selector', 'source',
  'destination', 'mint', 'token', 'amount', 'nativeValue', 'gas', 'feePayer', 'requiredSigners',
  'coSigners', 'instructions', 'extraInstructions', 'extraInstructionIndexes', 'blockhash', 'deadline', 'priorityFee',
]);
const INSTRUCTION_FIELDS = Object.freeze([
  'kind', 'programId', 'instructionId', 'data', 'accounts', 'source', 'destination', 'mint', 'token',
  'amount', 'nativeValue', 'computeUnitLimit', 'priorityFee',
]);

export class CollectorPolicyBundleError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CollectorPolicyBundleError';
  }
}

function fail(message) {
  throw new CollectorPolicyBundleError(message);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function exactKeys(value, fields, label) {
  if (!plainObject(value)) fail(`${label} must be a plain object`);
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    fail(`${label} fields are invalid`);
  }
}

function canonicalEqual(actual, expected, label) {
  let actualJson;
  let expectedJson;
  try {
    actualJson = canonicalJson(actual);
    expectedJson = canonicalJson(expected);
  } catch (error) {
    fail(`${label} is not canonical: ${error.message}`);
  }
  if (actualJson !== expectedJson) fail(`${label} does not match the verified specimen`);
}

function parseJson(text, label) {
  if (typeof text !== 'string') fail(`${label} is not text`);
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} is not valid JSON`);
  }
}

function manifestDigestPayload(manifest) {
  return {
    ...manifest,
    integrity: { algorithm: manifest.integrity?.algorithm },
  };
}

function verifyManifest(manifest) {
  exactKeys(manifest, BUNDLE_FIELDS, 'Collector policy bundle');
  if (manifest.schema !== COLLECTOR_POLICY_BUNDLE_SCHEMA) fail('Collector policy bundle schema is invalid');
  if (manifest.version !== 1) fail('Collector policy bundle version is invalid');
  exactKeys(manifest.integrity, INTEGRITY_FIELDS, 'Collector policy bundle integrity');
  if (manifest.integrity.algorithm !== 'sha256-canonical-json'
    || typeof manifest.integrity.digest !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(manifest.integrity.digest)) {
    fail('Collector policy bundle integrity declaration is invalid');
  }
  if (digest(manifestDigestPayload(manifest)) !== manifest.integrity.digest) {
    fail('Collector policy bundle digest mismatch');
  }
  if (manifest.provider !== 'collector-crypt' || manifest.chainId !== 'solana-mainnet') {
    fail('Collector policy bundle provider or chain is invalid');
  }
  if (!plainObject(manifest.runtime) || manifest.runtime.status !== 'evidence-only') {
    fail('Collector policy bundle runtime status is invalid');
  }
  if (!Array.isArray(manifest.specimens) || manifest.specimens.length !== ACTIONS.length) {
    fail('Collector policy bundle specimen references are invalid');
  }
  const actions = [];
  for (const reference of manifest.specimens) {
    exactKeys(reference, SPECIMEN_REFERENCE_FIELDS, 'Collector policy bundle specimen reference');
    if (typeof reference.action !== 'string' || typeof reference.path !== 'string'
      || !/^specimens\/[a-z]+\.json$/.test(reference.path)
      || !/^sha256:[0-9a-f]{64}$/.test(reference.digest)) {
      fail('Collector policy bundle specimen reference is invalid');
    }
    actions.push(reference.action);
  }
  canonicalEqual(actions, ACTIONS, 'Collector policy bundle action order');
  return manifest;
}

function verifyInstruction(expected, actual, label) {
  exactKeys(expected, INSTRUCTION_FIELDS, label);
  const fields = [...INSTRUCTION_FIELDS];
  for (const field of fields) canonicalEqual(actual[field], expected[field], `${label}.${field}`);
}

function decodedSummary(decoded) {
  return {
    family: decoded.family,
    format: decoded.format,
    chainId: decoded.chainId,
    nonce: decoded.nonce,
    programIds: decoded.programIds,
    addressLookupTables: decoded.addressLookupTables,
    target: decoded.target,
    selector: decoded.selector,
    source: decoded.source,
    destination: decoded.destination,
    mint: decoded.mint,
    token: decoded.token,
    amount: decoded.amount,
    nativeValue: decoded.nativeValue,
    gas: decoded.gas,
    feePayer: decoded.feePayer,
    requiredSigners: decoded.requiredSigners,
    coSigners: decoded.coSigners,
    instructions: decoded.instructions,
    extraInstructions: decoded.extraInstructions,
    extraInstructionIndexes: decoded.extraInstructions.map(instruction => decoded.instructions.indexOf(instruction)),
    blockhash: decoded.blockhash,
    deadline: decoded.deadline,
    priorityFee: decoded.priorityFee,
  };
}

function verifySpecimen(specimen, reference, decoded) {
  exactKeys(specimen, SPECIMEN_FIELDS, `Collector ${reference.action} specimen`);
  if (specimen.schema !== COLLECTOR_POLICY_SPECIMEN_SCHEMA || specimen.action !== reference.action) {
    fail(`Collector ${reference.action} specimen identity is invalid`);
  }
  if (typeof specimen.signature !== 'string' || specimen.signature.length === 0
    || !Number.isSafeInteger(specimen.slot) || specimen.slot < 0
    || typeof specimen.observedAt !== 'string' || typeof specimen.transactionBase64 !== 'string'
    || specimen.transactionBase64.length === 0 || !plainObject(specimen.source) || !plainObject(specimen.roles)) {
    fail(`Collector ${reference.action} specimen metadata is invalid`);
  }
  exactKeys(specimen.decoded, DECODED_FIELDS, `Collector ${reference.action} decoded summary`);
  const actual = decodedSummary(decoded);
  for (const field of DECODED_FIELDS) {
    if (field === 'instructions') continue;
    canonicalEqual(actual[field], specimen.decoded[field], `Collector ${reference.action} decoded.${field}`);
  }
  if (!Array.isArray(specimen.decoded.instructions)
    || specimen.decoded.instructions.length !== decoded.instructions.length) {
    fail(`Collector ${reference.action} decoded instruction count does not match the verified specimen`);
  }
  specimen.decoded.instructions.forEach((instruction, index) => {
    verifyInstruction(instruction, decoded.instructions[index], `Collector ${reference.action} instruction ${index}`);
  });
  return specimen;
}

function amountRule(value) {
  return value === null ? null : { exact: structuredClone(value) };
}

function instructionRule(instruction) {
  return {
    kind: instruction.kind,
    programId: instruction.programId,
    instructionId: instruction.instructionId,
    data: instruction.data,
    accounts: structuredClone(instruction.accounts),
    source: instruction.source,
    destination: instruction.destination,
    mint: instruction.mint,
    token: instruction.token,
    amount: amountRule(instruction.amount),
    nativeValue: amountRule(instruction.nativeValue),
    computeUnitLimit: instruction.computeUnitLimit,
    priorityFee: amountRule(instruction.priorityFee),
  };
}

function gasRule(gas) {
  return Object.fromEntries(Object.entries(gas).map(([field, value]) => [
    field,
    value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'amountAtomic')
      ? amountRule(value)
      : value,
  ]));
}

function specimenPolicy(decoded, action) {
  return createTransactionPolicy({
    policy: createCanonicalTransactionPolicy({ decoded, stage: action }),
    rules: [{
      id: `collector-${action}-specimen-v1`,
      family: decoded.family,
      format: decoded.format,
      chainId: decoded.chainId,
      nonce: decoded.nonce,
      programIds: structuredClone(decoded.programIds),
      addressLookupTables: structuredClone(decoded.addressLookupTables),
      target: decoded.target,
      selector: decoded.selector,
      source: decoded.source,
      destination: decoded.destination,
      mint: decoded.mint,
      token: decoded.token,
      amount: amountRule(decoded.amount),
      nativeValue: amountRule(decoded.nativeValue),
      gas: gasRule(decoded.gas),
      feePayer: decoded.feePayer,
      requiredSigners: structuredClone(decoded.requiredSigners),
      coSigners: structuredClone(decoded.coSigners),
      instructions: decoded.instructions.map(instructionRule),
      extraInstructions: decoded.extraInstructions.map(instructionRule),
      blockhash: decoded.blockhash,
      deadline: decoded.deadline,
      priorityFee: amountRule(decoded.priorityFee),
    }],
  });
}

async function defaultReadText(url) {
  return readFile(url, 'utf8');
}

/**
 * Loads the checked-in Collector evidence bundle, verifies every canonical digest, decodes each
 * recorded transaction, and creates process-local transaction-policy sidecars for those exact
 * specimens. The bundle intentionally remains evidence-only until a current-operator transaction
 * contract is independently verified.
 */
export async function loadCollectorPolicyBundle({ bundleUrl = BUNDLE_URL, readText = defaultReadText } = {}) {
  if (typeof readText !== 'function') fail('Collector policy bundle reader is invalid');
  const manifest = verifyManifest(parseJson(await readText(bundleUrl), 'Collector policy bundle'));
  const specimens = {};
  const policies = {};
  for (const reference of manifest.specimens) {
    const specimenUrl = new URL(reference.path, bundleUrl);
    const text = await readText(specimenUrl);
    const specimen = parseJson(text, `Collector ${reference.action} specimen`);
    if (digest(specimen) !== reference.digest) {
      fail(`Collector ${reference.action} specimen digest mismatch`);
    }
    const decoded = await decodeProviderTransaction({
      family: 'solana',
      chainId: manifest.chainId,
      transaction: specimen.transactionBase64,
    });
    verifySpecimen(specimen, reference, decoded);
    specimens[reference.action] = Object.freeze(structuredClone(specimen));
    policies[reference.action] = specimenPolicy(decoded, reference.action);
  }
  const bundle = Object.freeze({
    schema: manifest.schema,
    version: manifest.version,
    digest: manifest.integrity.digest,
    runtime: Object.freeze(structuredClone(manifest.runtime)),
    specimens: Object.freeze(specimens),
    policies: Object.freeze(policies),
  });
  loadedBundles.add(bundle);
  return bundle;
}

/** Refuses use of historic evidence as authority for an unverified live operator transaction. */
export function assertCollectorPolicyBundleRuntimeReady(bundle) {
  if (!plainObject(bundle) || !loadedBundles.has(bundle)) {
    fail('Collector policy bundle was not loaded and integrity-checked in this process');
  }
  if (bundle.runtime?.status !== 'runtime-ready') {
    fail('Collector policy bundle has no verified current-operator runtime authorization');
  }
  return bundle;
}

/** Attaches an already verified bundle without allowing callers to supply a file path or rules. */
export function attachCollectorPolicyBundle(config, bundle) {
  if (!plainObject(config) || !plainObject(config.collectorCrypt)) {
    fail('Collector policy bundle requires Collector configuration');
  }
  if (!plainObject(bundle) || !loadedBundles.has(bundle)) {
    fail('Collector policy bundle was not loaded and integrity-checked in this process');
  }
  return Object.freeze({
    ...config,
    collectorCrypt: Object.freeze({
      ...config.collectorCrypt,
      executionBundle: bundle,
    }),
  });
}

/** Returns a stage policy only after the bundle has authority for the current runtime. */
export function collectorPolicyForStage(config, action) {
  if (!ACTIONS.includes(action)) fail('Collector policy action is invalid');
  const bundle = config?.collectorCrypt?.executionBundle;
  if (bundle === undefined) return null;
  assertCollectorPolicyBundleRuntimeReady(bundle);
  const policy = bundle.policies?.[action];
  if (policy === undefined) fail(`Collector policy bundle is missing ${action} policy`);
  return policy;
}
