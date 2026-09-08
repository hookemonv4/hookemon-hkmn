import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Transaction } from '@solana/web3.js';
import { buildRelayLegacyTransaction } from '../../src/solana-rpc.mjs';
const sample = JSON.parse(readFileSync(new URL('./relay-return-instruction-case.json', import.meta.url)));
const build = instructionPlan => buildRelayLegacyTransaction({ feePayer: sample.payer,
  recentBlockhash: '11111111111111111111111111111111', instructionPlan });
test('production unsigned Relay compiler preserves captured plan and refuses incomplete, extra-signer and oversized input', () => {
  const before = JSON.stringify(sample);
  const bytes = Buffer.from(build(sample.instructionPlan), 'base64');
  assert.equal(bytes.length, 483);
  const decoded = Transaction.from(bytes);
  assert.equal(decoded.instructions[0].data.toString('hex'), sample.instructionPlan.instructions[0].data);
  assert.equal(decoded.instructions[0].keys.length, 10);
  assert.equal(JSON.stringify(sample), before);
  for (const mutate of [p => { delete p.instructions[0].data; }, p => { delete p.instructions[0].keys[0].pubkey; },
    p => { p.instructions[0].keys[0].isSigner = true; }, p => { p.instructions[0].data = '00'.repeat(1000); },
    p => { p.instructions[0].keys = []; }]) {
    const bad = structuredClone(sample.instructionPlan); mutate(bad); assert.throws(() => build(bad));
  }
});
