import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { PublicKey, Transaction, TransactionInstruction } = require('@solana/web3.js');
const fixture = JSON.parse(readFileSync(new URL('./relay-return-instruction-case.json', import.meta.url)));
// Synthetic offline blockhash; never a validity observation or execution candidate.
const TEST_BLOCKHASH = '11111111111111111111111111111111';

// Test-only compiler. It does not invoke or relax the production ALT refusal.
function compile(plan) {
  assert.ok(Array.isArray(plan.instructions) && plan.instructions.length > 0);
  const tx = new Transaction({ feePayer: new PublicKey(fixture.payer), recentBlockhash: TEST_BLOCKHASH });
  for (const instruction of plan.instructions) {
    assert.equal(typeof instruction.programId, 'string');
    assert.ok(Array.isArray(instruction.keys) && instruction.keys.length > 0);
    assert.equal(typeof instruction.data, 'string');
    assert.match(instruction.data, /^(?:[0-9a-f]{2})*$/i);
    const keys = instruction.keys.map(key => {
      assert.equal(typeof key.pubkey, 'string');
      assert.equal(typeof key.isSigner, 'boolean');
      assert.equal(typeof key.isWritable, 'boolean');
      return { ...key, pubkey: new PublicKey(key.pubkey) };
    });
    tx.add(new TransactionInstruction({ keys, programId: new PublicKey(instruction.programId), data: Buffer.from(instruction.data, 'hex') }));
  }
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false });
}

function assertEquivalent(decoded, plan) {
  // Solana message privileges are the union across duplicate account references,
  // including the fee payer. Per-occurrence flags do not survive message compilation.
  const privileges = new Map([[fixture.payer, { isSigner: true, isWritable: true }]]);
  for (const ix of plan.instructions) for (const key of ix.keys) {
    const old = privileges.get(key.pubkey) ?? { isSigner: false, isWritable: false };
    privileges.set(key.pubkey, { isSigner: old.isSigner || key.isSigner, isWritable: old.isWritable || key.isWritable });
  }
  assert.equal(decoded.instructions.length, plan.instructions.length);
  decoded.instructions.forEach((actual, i) => {
    const expected = plan.instructions[i];
    assert.equal(actual.programId.toBase58(), expected.programId);
    assert.equal(actual.data.toString('hex'), expected.data);
    assert.equal(actual.keys.length, expected.keys.length);
    actual.keys.forEach((key, j) => {
      assert.equal(key.pubkey.toBase58(), expected.keys[j].pubkey);
      assert.deepEqual({ isSigner: key.isSigner, isWritable: key.isWritable }, privileges.get(expected.keys[j].pubkey));
    });
  });
}

test('captured unsigned Relay plan fits legacy SDK encoding with exact effective semantics', () => {
  assert.equal(require('@solana/web3.js/package.json').version, '1.98.4');
  const original = JSON.stringify(fixture);
  assert.deepEqual(fixture.instructionPlan.addressLookupTableAddresses, ['Hm9fUgcn7qwDaiNTFiGh6pNtVATgnaRcmK6Bbx6EMZfP']);
  const wire = compile(fixture.instructionPlan);
  assert.equal(wire.length, 483);
  assert.ok(wire.length <= 1232);
  const decoded = Transaction.from(wire);
  assert.equal(decoded.feePayer.toBase58(), fixture.payer);
  assert.equal(decoded.recentBlockhash, TEST_BLOCKHASH);
  assert.equal(decoded.signatures.length, 1);
  assert.equal(decoded.signatures[0].signature, null);
  assertEquivalent(decoded, fixture.instructionPlan);
  assert.deepEqual(decoded.serialize({ requireAllSignatures: false, verifySignatures: false }), wire);
  assert.equal(JSON.stringify(fixture), original);

  for (const field of ['pubkey', 'isSigner', 'isWritable']) {
    const malformed = structuredClone(fixture.instructionPlan);
    delete malformed.instructions[0].keys[0][field];
    assert.throws(() => compile(malformed));
  }
  const missingData = structuredClone(fixture.instructionPlan);
  delete missingData.instructions[0].data;
  assert.throws(() => compile(missingData));
  const missingAccount = structuredClone(fixture.instructionPlan);
  missingAccount.instructions[0].keys.splice(3, 1);
  assert.throws(() => assertEquivalent(Transaction.from(compile(missingAccount)), fixture.instructionPlan));
  const oversized = structuredClone(fixture.instructionPlan);
  oversized.instructions[0].data = '00'.repeat(1000);
  assert.throws(() => compile(oversized), /too large|encoding overruns|offset|bounds/i);
});
