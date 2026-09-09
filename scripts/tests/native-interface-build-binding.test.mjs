import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { nativeBuildInputs, validateNativeInterfaceBuildBinding } from '../../feasibility/native-interface-build-binding.mjs';
import { validateInterfaceFreeze } from '../../feasibility/verify-robinhood-binding.mjs';
const root = resolve(import.meta.dirname, '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'native-build-binding-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const path of [...nativeBuildInputs, 'feasibility/native-interface-build-binding.json']) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), readFileSync(join(root, path)));
  }
  const read = path => JSON.parse(readFileSync(join(dir, path)));
  const write = (path, value) => writeFileSync(join(dir, path), `${JSON.stringify(value, null, 2)}\n`);
  const run = () => validateNativeInterfaceBuildBinding({ projectRoot: dir,
    frozen: read('architecture/interfaces.json'), freeze: read('feasibility/interface-freeze.json'),
    manifest: read('bindings/robinhood-chain.json') });
  const rebind = path => {
    const record = read('feasibility/native-interface-build-binding.json');
    record.inputHashes[path] = hash(readFileSync(join(dir, path)));
    write('feasibility/native-interface-build-binding.json', record);
  };
  return { dir, read, write, run, rebind };
}
test('native build binding preserves historical scope and cannot report launch readiness', t => {
  const f = fixture(t); const result = f.run();
  assert.equal(result.requirementsRevision, 74);
  assert.equal(result.historicalRequirementsRevision, 65);
  assert.equal(result.productionReady, false);
  assert.equal(result.nativeFeasibilityProven, false);
  assert.equal(result.providerAdmissionProven, false);
});
test('unrefreshed interface evidence fails closed', t => {
  const f = fixture(t); const x = f.read('architecture/interfaces.json'); x.source += ' edited';
  f.write('architecture/interfaces.json', x); assert.throws(f.run, /input hash mismatch/);
});
for (const [name, path, mutate, expected] of [
  ['different requirements', 'specs/requirements.json', x => { x.revision = 75; }, /requirements outside implementation scope/],
  ['rewritten historical freeze', 'feasibility/interface-freeze.json', x => { x.requirementsRevision = 71; }, /historical freeze changed/],
  ['additional platform fee', 'architecture/interfaces.json', x => { x.feeContract.streams[0].basisPoints = 20; }, /pinned snapshot changed: architecture\/interfaces.json/],
  ['custody withdrawal authority', 'architecture/interfaces.json', x => { x.launch.positionCustody.withdraw = true; }, /pinned snapshot changed: architecture\/interfaces.json/],
  ['invented live eligibility', 'architecture/interfaces.json', x => { x.nativeMigration.launchEligible = true; }, /pinned snapshot changed: architecture\/interfaces.json/],
  ['unverified runtime authority', 'architecture/interfaces.json', x => { x.nativeMigration.nativePaymentBindingSha256 = 'a'.repeat(64); }, /pinned snapshot changed: architecture\/interfaces.json/],
]) test(`recomputed document hashes cannot approve ${name}`, t => {
  const f = fixture(t); const x = f.read(path); mutate(x); f.write(path, x); f.rebind(path);
  assert.throws(f.run, expected);
});
test('omitted input and forged historical credit are rejected', t => {
  const f = fixture(t); const record = f.read('feasibility/native-interface-build-binding.json');
  delete record.inputHashes['packages/contracts/remappings.txt'];
  f.write('feasibility/native-interface-build-binding.json', record); assert.throws(f.run, /input set mismatch/);
  record.inputHashes['packages/contracts/remappings.txt'] = hash(readFileSync(join(f.dir, 'packages/contracts/remappings.txt')));
  record.historicalEvidenceScope = 'CURRENT_NATIVE_PROOF';
  f.write('feasibility/native-interface-build-binding.json', record); assert.throws(f.run, /historical evidence promoted/);
});
test('a symlink cannot substitute even identical input bytes', t => {
  const f = fixture(t); const file = join(f.dir, 'architecture/interfaces.json');
  const copy = join(f.dir, 'copy.json'); writeFileSync(copy, readFileSync(file)); rmSync(file); symlinkSync(copy, file);
  assert.throws(f.run, /symlink/);
});

test('shared gate validator refuses a valid provisional native build', t => {
  const f = fixture(t);
  assert.equal(f.run().productionReady, false);
  assert.throws(() => validateInterfaceFreeze({ projectRoot: f.dir,
    frozen: f.read('architecture/interfaces.json'), freeze: f.read('feasibility/interface-freeze.json'),
    provisional: f.read('architecture/provisional-interfaces.json'), manifest: f.read('bindings/robinhood-chain.json'),
  }), /cannot satisfy an interface freeze gate/);
});
test('extra readiness claims cannot enter a build record', t => {
  const f = fixture(t); const record = f.read('feasibility/native-interface-build-binding.json');
  record.nativeFeasibilityProven = true;
  f.write('feasibility/native-interface-build-binding.json', record);
  assert.throws(f.run, /record key set mismatch/);
});
for (const path of ['feasibility/phase3-offchain-interface-amendment.json',
  'decisions/owner-approvals/revision-70-collector-explicit-spec-s5-approved.json']) {
  test(`rebound historical bytes are rejected: ${path}`, t => {
    const f = fixture(t); const data = f.read(path); data.forgedNativeApproval = true;
    f.write(path, data); f.rebind(path); assert.throws(f.run, /pinned snapshot changed/);
  });
}
test('unreviewed interface fields cannot be rebound into the snapshot', t => {
  const f = fixture(t); const data = f.read('architecture/interfaces.json');
  data.processClaims.window.seconds = 1;
  f.write('architecture/interfaces.json', data); f.rebind('architecture/interfaces.json');
  assert.throws(f.run, /pinned snapshot changed/);
});
