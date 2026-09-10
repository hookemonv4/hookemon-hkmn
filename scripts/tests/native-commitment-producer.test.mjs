import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { prepareNativeCommitmentInputs, readNativeRequirementsBytes } from '../programmable/lib/native-commitment-producer.mjs';

test('requirements binding accepts the approved revision 76 and refuses changed bytes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'native-requirements-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'specs'));
  const approved = readFileSync(new URL('../../specs/requirements.json', import.meta.url));
  assert.equal(JSON.parse(approved).revision, 76);
  const target = join(root, 'specs/requirements.json');
  writeFileSync(target, approved);
  assert.deepEqual(readNativeRequirementsBytes(root), approved);

  const changed = JSON.parse(approved);
  changed.requirements[0].statement += ' Changed input.';
  writeFileSync(target, JSON.stringify(changed));
  assert.throws(() => readNativeRequirementsBytes(root), /frozen revision-76 requirements mismatch/);
  writeFileSync(target, Buffer.concat([approved, Buffer.from('\n')]));
  assert.throws(() => readNativeRequirementsBytes(root), /frozen revision-76 requirements mismatch/);
});

test('requirements binding refuses linked files and linked specs directories', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'native-requirements-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, 'real');
  mkdirSync(real);
  writeFileSync(join(real, 'requirements.json'), readFileSync(new URL('../../specs/requirements.json', import.meta.url)));
  symlinkSync(real, join(root, 'specs'), 'dir');
  assert.throws(() => readNativeRequirementsBytes(root), /regular file without symlinks/);
  rmSync(join(root, 'specs'));
  mkdirSync(join(root, 'specs'));
  symlinkSync(join(real, 'requirements.json'), join(root, 'specs/requirements.json'));
  assert.throws(() => readNativeRequirementsBytes(root), /regular file without symlinks/);
});

// These are refusal-boundary tests. They do not synthesize live observer provenance, run a
// compiler, or claim that the currently incomplete external runtime evidence has become usable.
const diskObservation = () => JSON.parse(JSON.stringify({
  runtime: { schema: 'hookemon.native-issuance-runtime-authority.v1', chainId: '4663',
    genesisHash: `0x${'1'.repeat(64)}`, providerProtocol: 'programmable', providerVersion: '4.1.0', contracts: [], evidenceFiles: [] },
  evidenceBytes: {},
}));
test('copied runtime JSON refuses before any filesystem/compiler input is consumed', () => {
  assert.throws(() => prepareNativeCommitmentInputs({ root: '/nonexistent-native-input-fixture', observedRuntime: diskObservation() }),
    /^Error: UNOBSERVED_RUNTIME: no live observer provenance$/);
});
test('frozen runtime JSON and caller verification markers cannot replace observer provenance', () => {
  const observedRuntime = Object.freeze({ ...diskObservation(), verified: true, authenticated: true });
  assert.throws(() => prepareNativeCommitmentInputs({ observedRuntime }), /^Error: UNOBSERVED_RUNTIME: no live observer provenance$/);
});
test('refuses caller-provided independent coordinates and compiler approval overrides', () => {
  for (const extra of [{ independentDeployment: {} }, { bindingDigest: `0x${'2'.repeat(64)}` },
    { compilerSha256: `0x${'3'.repeat(64)}` }, { sourceBundleComplete: true }, { routeNamespace: `0x${'4'.repeat(64)}` }]) {
    assert.throws(() => prepareNativeCommitmentInputs({ observedRuntime: diskObservation(), ...extra }), /unsupported input or acceptance claim/);
  }
});

test('refuses caller-supplied provider bundle digests in place of verified manifest bytes', () => {
  for (const field of ['sourceBundleDigest', 'sourceBundleContentSha256']) {
    assert.throws(() => prepareNativeCommitmentInputs({
      observedRuntime: diskObservation(), [field]: `0x${'5'.repeat(64)}`,
    }), /unsupported input or acceptance claim/);
  }
});
