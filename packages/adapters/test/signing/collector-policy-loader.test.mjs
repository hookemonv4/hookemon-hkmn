import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  loadCollectorPolicyBundle,
} from '../../src/signing/collector-policy-loader.mjs';
import {
  decodeProviderTransaction,
  evaluate,
} from '../../src/signing/transaction-policy.mjs';

async function decodeSpecimen(specimen) {
  return decodeProviderTransaction({
    family: 'solana',
    chainId: 'solana-mainnet',
    transaction: specimen.transactionBase64,
  });
}

test('Collector policy bundle accepts each verified historical specimen', async () => {
  const bundle = await loadCollectorPolicyBundle();

  for (const [action, specimen] of Object.entries(bundle.specimens)) {
    const decoded = await decodeSpecimen(specimen);
    const result = evaluate(bundle.policies[action], decoded);
    assert.deepEqual(result, {
      schema: 'hookemon.transaction-policy.v1',
      allowed: true,
      ruleId: `collector-${action}-specimen-v1`,
    });
  }
});

test('Collector policy bundle rejects mutated specimen semantics', async t => {
  const bundle = await loadCollectorPolicyBundle();
  const purchase = await decodeSpecimen(bundle.specimens.purchase);

  const mutations = [
    ['wrong recipient', decoded => ({ ...decoded, destination: '11111111111111111111111111111111' })],
    ['wrong mint', decoded => ({ ...decoded, mint: '11111111111111111111111111111111' })],
    ['changed amount', decoded => ({
      ...decoded,
      amount: { ...decoded.amount, amountAtomic: '25000001' },
    })],
    ['wrong program', decoded => ({
      ...decoded,
      programIds: [...decoded.programIds.slice(0, -1), '11111111111111111111111111111111'],
    })],
    ['extra instruction', decoded => ({
      ...decoded,
      instructions: [...decoded.instructions, decoded.instructions[0]],
      extraInstructions: [...decoded.extraInstructions, decoded.instructions[0]],
    })],
  ];

  for (const [name, mutate] of mutations) {
    await t.test(name, () => {
      assert.throws(() => evaluate(bundle.policies.purchase, mutate(structuredClone(purchase))));
    });
  }
});

test('Collector policy bundle refuses a manifest whose digest does not match its content', async () => {
  const url = new URL('../../rehearsal/collector-policy/bundle.json', import.meta.url);
  const manifest = JSON.parse(await readFile(url, 'utf8'));
  manifest.provider = 'collector-crypt-tampered';
  await assert.rejects(
    () => loadCollectorPolicyBundle({
      readText: async () => JSON.stringify(manifest),
    }),
    /digest mismatch/,
  );
});
