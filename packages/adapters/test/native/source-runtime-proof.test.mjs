import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { readFinalizedRelaySourceDebit, isProcessRpcRelaySourceDebit } from '../../src/solana-rpc.mjs';
import { createRelayNativePaymentProof, createTestNativePaymentBinding, readReleaseBoundRelaySourceDebit } from '../../src/native-payment-proof.mjs';
import { setup } from './relay-native-proof-fixture.mjs';

function editData(observation, edit) {
  const bytes = Buffer.from(observation.value[1].data[0], 'base64');
  edit(bytes);
  observation.value[1].data[0] = bytes.toString('base64');
}

// Retained public account bytes, replayed through the real RPC producer with a synthetic signed
// source transaction. This is an isolated transport fixture, not evidence of a live payment.
test('verified public Relay runtime bytes prove the stable interval containing a finalized source slot', async () => {
  const root = new URL('../../../../docs/evidence/native-relay-source-instruction-20260908/', import.meta.url);
  const program = JSON.parse(await readFile(new URL('program-account-response.json', root), 'utf8'));
  const programData = JSON.parse(gunzipSync(await readFile(new URL('programdata-response.json.gz', root))).toString());
  const input = await setup({ sourceSlot: 445319500, runtimeObservation: {
    context: { slot: 445319652 }, value: [program.result.value, programData.result.value],
  } });
  assert.equal(input.sourceProof.sourceRuntime.normalizedRuntimeSha256, '01fd4b74bfecbbced90084938e458e4cf0373afeb4741402e0ca145ccec256d1');
  assert.equal(input.sourceProof.sourceRuntime.deploymentSlot, '386211280');
  assert.equal(input.sourceProof.sourceRuntime.sourceSlot, '445319500');
  assert.deepEqual(input.runtimeRequests[0].params, [[input.binding.relay.sourceRuntime.programId,
    input.binding.relay.sourceRuntime.programDataAddress], { commitment: 'finalized', encoding: 'base64', minContextSlot: 445319500 }]);
  const payment = await createRelayNativePaymentProof(input);
  assert.equal(payment.amountWei, '42');
  assert.notEqual(payment.relayRequestId, payment.orderId);
});

test('source runtime refuses absent accounts, wrong loader, executable flags and ProgramData association', async () => {
  for (const runtimeMutation of [
    o => { o.value[0] = null; }, o => { o.value[1] = null; },
    o => { o.value[0].owner = '11111111111111111111111111111111'; },
    o => { o.value[1].owner = '11111111111111111111111111111111'; },
    o => { o.value[0].executable = false; }, o => { o.value[1].executable = true; },
    o => { const bytes = Buffer.from(o.value[0].data[0], 'base64'); bytes[4] ^= 1; o.value[0].data[0] = bytes.toString('base64'); },
    o => editData(o, bytes => { bytes[0] = 2; }),
    o => editData(o, bytes => { bytes[12] = 2; }),
  ]) await assert.rejects(setup({ runtimeMutation }));
});

test('source runtime refuses stale context and later or same-slot upgrades even with identical executable hash', async () => {
  await assert.rejects(setup({ runtimeMutation: o => { o.context.slot = 9; } }), /stale/);
  for (const slot of [10n, 11n]) {
    await assert.rejects(setup({ runtimeMutation: o => editData(o, bytes => bytes.writeBigUInt64LE(slot, 4)) }), /at or after/);
  }
});

test('source runtime rejects changed executable and malformed account encodings', async () => {
  await assert.rejects(setup({ runtimeMutation: o => editData(o, bytes => { bytes[49] ^= 1; }) }), /hash mismatch/);
  await assert.rejects(setup({ runtimeMutation: o => { o.value[1].data[1] = 'base58'; } }), /identity/);
  await assert.rejects(setup({ runtimeMutation: o => { o.value[1].data[0] += '\n'; } }), /canonical base64/);
});

test('JSON release bindings and source proofs cannot provide runtime authority', async () => {
  const input = await setup();
  const expected = { signature: input.sourceProof.transactionHash, owner: input.expected.sourceOwner,
    mint: input.expected.sourceMint, amountAtomic: input.expected.sourceAmountAtomic, signedTransactionBase64: input.encoded };
  let calls = 0;
  await assert.rejects(readReleaseBoundRelaySourceDebit({ client: { fetchImpl: () => { calls++; } }, binding: structuredClone(input.binding), ...expected }), /release authenticated/);
  assert.equal(calls, 0);
  await assert.rejects(readFinalizedRelaySourceDebit(input.sourceClient, expected), /runtime binding is required/);
  const copiedRuntime = structuredClone(input.binding.relay.sourceRuntime);
  const foreignSource = await readFinalizedRelaySourceDebit(input.sourceClient, { ...expected, runtimeBinding: copiedRuntime });
  assert.equal(isProcessRpcRelaySourceDebit(foreignSource, { runtimeBinding: input.binding.relay.sourceRuntime }), false);
  await assert.rejects(createRelayNativePaymentProof({ ...input, sourceProof: foreignSource }), /source lacks/);
  await assert.rejects(createRelayNativePaymentProof({ ...input, sourceProof: structuredClone(input.sourceProof) }), /source lacks/);
  const changed = structuredClone(input.binding); changed.relay.sourceInstruction.programId = '11111111111111111111111111111111';
  const binding = createTestNativePaymentBinding(changed, createTestProfileMutationAuthority());
  await assert.rejects(readReleaseBoundRelaySourceDebit({ client: input.sourceClient, binding, ...expected }), /program binding mismatch/);
});
