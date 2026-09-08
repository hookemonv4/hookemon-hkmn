import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildNativeSourceBundle } from '../programmable/lib/native-source-bundle.mjs';
import { sourceBundleContentSha256 } from '../programmable/lib/source-bundle.mjs';

// Retained outputs of checksum-verified official CLI 4.1.0, not a recomputed local oracle.
const root = resolve(import.meta.dirname, '../..');
const vector = JSON.parse(readFileSync(resolve(root, 'scripts/tests/fixtures/native-source-bundle-official.json')));
const request = { sourceBundleManifest: vector.manifest, sourceDescriptor: vector };
const sourceBytes = Object.fromEntries(vector.bundleContent.entries.map(entry => [entry.path, Buffer.from(entry.contentBase64, 'base64')]));

test('native bundle reproduces the retained official manifest and actual-content digests', () => {
  const bundle = buildNativeSourceBundle({ manifest: request.sourceBundleManifest, sourceBytes });
  assert.equal(bundle.sourceBundleDigest, request.sourceDescriptor.sourceBundleDigest);
  assert.equal(bundle.bundleContentSha256, request.sourceDescriptor.bundleContentSha256);
  assert.notEqual(bundle.bundleContentSha256, sourceBundleContentSha256(bundle.manifest));
  assert.equal(bundle.bundleContent.entries.length, bundle.manifest.entries.length);
});

test('native bundle refuses omitted or changed source bytes instead of accepting declared hashes', () => {
  const path = request.sourceBundleManifest.entries[0].path;
  for (const value of [undefined, Buffer.from('different bytes')]) {
    assert.throws(() => buildNativeSourceBundle({ manifest: request.sourceBundleManifest, sourceBytes: { ...sourceBytes, [path]: value } }), /bytes mismatch/);
  }
});

test('native bundle uploads only manifest members and owns a detached snapshot', () => {
  const manifest = structuredClone(request.sourceBundleManifest);
  const bundle = buildNativeSourceBundle({ manifest, sourceBytes: { ...sourceBytes, compiler: Buffer.from('not a provider bundle member') } });
  manifest.entries[0].path = 'changed';
  assert.equal(bundle.manifest.entries[0].path, request.sourceBundleManifest.entries[0].path);
  assert.equal(bundle.bundleContentSha256, request.sourceDescriptor.bundleContentSha256);
  assert.ok(bundle.bundleContent.entries.every(entry => entry.path !== 'compiler'));
});
