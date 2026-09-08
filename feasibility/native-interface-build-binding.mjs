import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const approvedRequirementsSha256 = '750a12abf47a771d1181dd6a1782c1b6fbcc4eebb4632e5d1927bf52f4193425';
const historicalFreezeSha256 = 'e5b6fade85bd5ef9c0ae0cefaeffbf23ae7926460f21ccea52debd8484f1818d';
const scopeSha256 = '3e307c157d987b97223ffadb8b79ebfd079d674ca79b3266430015b8fef6c59f';
const fail = message => { throw new Error(`native build binding: ${message}`); };
const assert = (condition, message) => { if (!condition) fail(message); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export const nativeBuildInputs = Object.freeze([
  'architecture/interfaces.json',
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
  assert(record.schema === 'hookemon.native-interface-build-binding.v1', 'unsupported record');
  assert(record.status === 'PROVISIONAL_BUILD_ONLY' && record.productionReady === false,
    'record cannot grant production readiness');
  assert(record.requirementsRevision === 71 && record.architectureRevision === 11, 'revision mismatch');
  assert(JSON.stringify(Object.keys(record.inputHashes).sort()) === JSON.stringify([...nativeBuildInputs].sort()),
    'input set mismatch');
  for (const file of nativeBuildInputs) {
    assert(record.inputHashes[file] === digest(bytes(projectRoot, file)), `input hash mismatch: ${file}`);
  }
  assert(record.inputHashes['specs/requirements.json'] === approvedRequirementsSha256, 'unapproved requirements');
  assert(record.inputHashes['feasibility/interface-freeze.json'] === historicalFreezeSha256,
    'historical freeze changed');
  assert(record.inputHashes['decisions/native-eth-interface/IMPLEMENTATION-SCOPE.md'] === scopeSha256,
    'native implementation authority changed');
  assert(JSON.stringify(frozen) === JSON.stringify(JSON.parse(bytes(projectRoot, 'architecture/interfaces.json'))),
    'supplied interfaces differ from bound bytes');
  assert(JSON.stringify(freeze) === JSON.stringify(JSON.parse(bytes(projectRoot, 'feasibility/interface-freeze.json'))),
    'supplied historical freeze differs from bound bytes');
  assert(JSON.stringify(manifest) === JSON.stringify(JSON.parse(bytes(projectRoot, 'bindings/robinhood-chain.json'))),
    'supplied provider manifest differs from bound bytes');
  assert(frozen.productPhase === 3 && frozen.requirementsRevision === 71 && frozen.architectureRevision === 11,
    'interface revision mismatch');
  assert(frozen.status === 'PROVISIONAL_PHASE3_PENDING_FEASIBILITY'
    && frozen.bindingManifestDigest === null && frozen.nativeMigration?.launchEligible === false,
  'provisional boundary changed');
  assert(frozen.nativeMigration.requirementsRevision === 71
    && frozen.nativeMigration.requirementsSha256 === approvedRequirementsSha256, 'migration requirements mismatch');
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
    requirementsRevision: 71,
    architectureRevision: 11,
    historicalRequirementsRevision: freeze.requirementsRevision,
    historicalEvidenceScope: record.historicalEvidenceScope,
    productionReady: false,
    nativeFeasibilityProven: false,
    providerAdmissionProven: false,
  };
}
