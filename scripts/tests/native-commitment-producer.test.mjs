import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareNativeCommitmentInputs } from '../programmable/lib/native-commitment-producer.mjs';

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
