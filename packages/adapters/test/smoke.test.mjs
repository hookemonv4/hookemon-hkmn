// Smoke coverage for the packages/adapters scaffold: confirms the pinned dependencies actually
// install and load, and that the package boundary declared in package.json holds. Real chain-adapter
// behavior (transaction construction against the injected signerClient seam) lands with WP-08/09/10;
// this file exists so the CI step in .github/workflows/v4-gates.yml (`node --test test/*.test.mjs`)
// always has at least one real test to run.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { Connection } from '@solana/web3.js';
import { createPublicClient, http } from 'viem';

const packageJsonPath = fileURLToPath(new URL('../package.json', import.meta.url));
const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

test('package.json declares the private, dependency-isolated adapters boundary', () => {
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.type, 'module');
  assert.deepEqual(Object.keys(packageJson.dependencies).sort(), ['@solana/web3.js', 'viem']);
});

test('viem loads and can construct a read-only public client', () => {
  const client = createPublicClient({ transport: http('https://example.invalid') });
  assert.equal(typeof client.getBlockNumber, 'function');
});

test('@solana/web3.js loads and can construct a read-only connection', () => {
  const connection = new Connection('https://example.invalid');
  assert.equal(typeof connection.getBalance, 'function');
});
