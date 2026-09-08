import { assertSourceBundleManifest, sourceBundleDigest } from './source-bundle.mjs';
import { jcsBytes } from './jcs.mjs';
import { sha256 } from './native-issuance-commitments.mjs';

// Official programmable-launch 4.1.0, src/source-bundle.mjs SHA-256
// 17059a88e1e08c16ba60b18de30dba0023036bcdf424ec2bd0f8f6a4fd6ba624.
// https://github.com/programmablehq/PROGRAMMABLE/releases/tag/programmable-launch-v4.1.0
// The manifest digest and content digest have different preimages. The latter includes
// the actual base64 file bytes, not just their hashes. The build closure can additionally
// contain the compiler and inputs that are not uploaded in this provider source bundle.
export function buildNativeSourceBundle({ manifest, sourceBytes }) {
  const snapshot = structuredClone(assertSourceBundleManifest(manifest));
  const entries = snapshot.entries.map(entry => {
    const bytes = sourceBytes && Object.hasOwn(sourceBytes, entry.path) ? sourceBytes[entry.path] : undefined;
    if (!Buffer.isBuffer(bytes) || String(bytes.length) !== entry.byteLength
      || `sha256:${sha256(bytes).slice(2)}` !== entry.contentSha256) {
      throw new TypeError(`native provider bundle bytes mismatch: ${entry.path}`);
    }
    return { ...entry, contentBase64: bytes.toString('base64') };
  });
  const bundleContent = { schemaVersion: 'programmable.source-bundle-content.v1', entries };
  return {
    manifest: snapshot,
    sourceBundleDigest: sourceBundleDigest(snapshot),
    bundleContentSha256: `sha256:${sha256(jcsBytes(bundleContent)).slice(2)}`,
    bundleContent,
  };
}
