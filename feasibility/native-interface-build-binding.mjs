import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const implementationScopeRequirementsSha256 = 'cf8ca1e3d36cc6019b7555b4dd7815730bfadba9543803fff62ff11734b2983d';
const historicalFreezeSha256 = 'e5b6fade85bd5ef9c0ae0cefaeffbf23ae7926460f21ccea52debd8484f1818d';
const scopeSha256 = '3e307c157d987b97223ffadb8b79ebfd079d674ca79b3266430015b8fef6c59f';
const pinnedSnapshotHashes = Object.freeze({
  "decisions/owner-approvals/revision-72-native-commitments-approved.json": "eef9e64fbd86db39d4a825dc4fc2f8b532931b997eb7f6903abd574d95c62cef",
  "architecture/interfaces.json": "b54b50a0cd96d1db48b73eca23dd67d03c73c6a787d594cd6e6d68b7eac253d5",
  "feasibility/phase3-offchain-interface-amendment.json": "3e91a11ca644f1664f670979a772628690caf4f3eeda53e0ecb2722f91daa6b0",
  "decisions/owner-approvals/revision-67-spec-s5-approved.json": "aebdddeb596ce2f9b6cd1fed6cbd9621cbcb5897c06b911d291608f5f376ca8b",
  "decisions/owner-approvals/revision-68-spec-s5-approved.json": "38146dffe3f47df9e5cf62f03e049310bf638ee141052b24c7b1bb97c43fd1a2",
  "decisions/owner-approvals/revision-69-collector-explicit-spec-s5-approved.json": "e576590ea782085ff791887a7f9dac4ef52f7a68e6066b436ae722d82cc869fb",
  "decisions/owner-approvals/revision-70-collector-explicit-spec-s5-approved.json": "c5381d6e698ac50a15c65a766f8c6d941dd06f6c34020e25fec5e97632a62061"
});
const fail = message => { throw new Error(`native build binding: ${message}`); };
const assert = (condition, message) => { if (!condition) fail(message); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const nativeBuildInputs = Object.freeze([
  'decisions/owner-approvals/revision-72-native-commitments-approved.json',
  'architecture/interfaces.json',
  'architecture/provisional-interfaces.json',
  'decisions/owner-approvals/revision-67-spec-s5-approved.json',
  'decisions/owner-approvals/revision-68-spec-s5-approved.json',
  'decisions/owner-approvals/revision-69-collector-explicit-spec-s5-approved.json',
  'decisions/owner-approvals/revision-70-collector-explicit-spec-s5-approved.json',

  'bindings/robinhood-chain.json',
  'decisions/native-eth-interface/IMPLEMENTATION-SCOPE.md',
  'feasibility/interface-freeze.json',
  'feasibility/phase3-offchain-interface-amendment.json',
  'packages/contracts/foundry.toml',
  'packages/contracts/remappings.txt',
  'product/dependency-pins.json',
  'specs/requirements.json',
]);
function bytes(root, file) {
  let current = resolve(root);
  for (const part of file.split('/')) {
    current = resolve(current, part);
    assert(!lstatSync(current).isSymbolicLink(), `symlink in ${file}`);
  }
  assert(lstatSync(current).isFile(), `not a file: ${file}`);
  return readFileSync(current);
}

// A provisional native build binding replaces neither historical proof nor release admission.
export function validateNativeInterfaceBuildBinding({ projectRoot, frozen, freeze, manifest }) {
  const record = JSON.parse(bytes(projectRoot, 'feasibility/native-interface-build-binding.json'));
  assert(JSON.stringify(Object.keys(record).sort()) === JSON.stringify([
    'schema', 'status', 'requirementsRevision', 'architectureRevision', 'productionReady',
    'historicalEvidenceScope', 'inputHashes',
  ].sort()), 'record key set mismatch');
  assert(record.schema === 'hookemon.native-interface-build-binding.v1', 'unsupported record');
  assert(record.status === 'PROVISIONAL_BUILD_ONLY' && record.productionReady === false,
    'record cannot grant production readiness');
  assert(record.requirementsRevision === 72 && record.architectureRevision === 11, 'revision mismatch');
  assert(JSON.stringify(Object.keys(record.inputHashes).sort()) === JSON.stringify([...nativeBuildInputs].sort()),
    'input set mismatch');
  for (const file of nativeBuildInputs) {
    assert(record.inputHashes[file] === digest(bytes(projectRoot, file)), `input hash mismatch: ${file}`);
  }
  for (const [file, expected] of Object.entries(pinnedSnapshotHashes)) {
    assert(record.inputHashes[file] === expected, `pinned snapshot changed: ${file}`);
  }
  assert(record.inputHashes['specs/requirements.json'] === implementationScopeRequirementsSha256, 'requirements outside implementation scope');
  assert(record.inputHashes['feasibility/interface-freeze.json'] === historicalFreezeSha256,
    'historical freeze changed');
  assert(record.inputHashes['decisions/native-eth-interface/IMPLEMENTATION-SCOPE.md'] === scopeSha256,
    'native implementation scope note changed');
  assert(JSON.stringify(frozen) === JSON.stringify(JSON.parse(bytes(projectRoot, 'architecture/interfaces.json'))),
    'supplied interfaces differ from bound bytes');
  assert(JSON.stringify(freeze) === JSON.stringify(JSON.parse(bytes(projectRoot, 'feasibility/interface-freeze.json'))),
    'supplied historical freeze differs from bound bytes');
  assert(JSON.stringify(manifest) === JSON.stringify(JSON.parse(bytes(projectRoot, 'bindings/robinhood-chain.json'))),
    'supplied provider manifest differs from bound bytes');
  assert(frozen.productPhase === 3 && frozen.requirementsRevision === 72 && frozen.architectureRevision === 11,
    'interface revision mismatch');
  assert(frozen.status === 'PROVISIONAL_PHASE3_PENDING_FEASIBILITY'
    && frozen.bindingManifestDigest === null && frozen.nativeMigration?.launchEligible === false,
  'provisional boundary changed');
  assert(frozen.nativeMigration.requirementsRevision === 72
    && frozen.nativeMigration.requirementsSha256 === implementationScopeRequirementsSha256, 'migration requirements mismatch');
  assert(frozen.nativeMigration.nativePaymentBindingSha256 === null, 'runtime authority requires release verification');
  assert(frozen.feeContract.basis === 'GROSS_NATIVE_ETH_QUOTE_VOLUME'
    && JSON.stringify(frozen.feeContract.streams.map(({ name, basisPoints }) => [name, basisPoints]))
      === JSON.stringify([['programmable', 10], ['treasury', 40], ['process', 250]]), 'native fee model changed');
  assert(JSON.stringify(Object.keys(frozen.launch.positionCustody).sort()) === JSON.stringify(['approval', 'operator', 'withdraw'])
    && Object.values(frozen.launch.positionCustody).every(value => value === false), 'custody authority changed');
  const quote = frozen.nativeMigration.quoteCurrency;
  assert(quote.wireAddress === '0x0000000000000000000000000000000000000000'
    && quote.assetId === 'native' && quote.currencyIndex === 0 && quote.decimals === 18, 'native quote identity changed');
  assert(frozen.phaseBoundary.codeReadinessDoesNotAuthorizeLive === true
    && frozen.phaseBoundary.launchEligibleRequiredForLive === true, 'release boundary changed');
  assert(record.historicalEvidenceScope === 'HISTORICAL_ONLY_NO_NATIVE_FEASIBILITY_CREDIT',
    'historical evidence promoted');
  return {
    status: record.status,
    requirementsRevision: 72,
    architectureRevision: 11,
    historicalRequirementsRevision: freeze.requirementsRevision,
    historicalEvidenceScope: record.historicalEvidenceScope,
    productionReady: false,
    nativeFeasibilityProven: false,
    providerAdmissionProven: false,
  };
}
