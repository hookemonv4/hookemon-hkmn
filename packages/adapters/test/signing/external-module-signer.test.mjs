import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { createExternalModuleSignerClient } from '../../src/signing/external-module-signer.mjs';
import { SignerClientError } from '../../src/signing/signer-client.mjs';
import {
  decodeProviderTransaction,
  readTransactionPolicyRules,
  TRANSACTION_POLICY_SCHEMA,
} from '../../src/signing/transaction-policy.mjs';
import { registerSignerClientConformanceSuite } from './conformance.mjs';
import { policyFor } from './policy-fixture.mjs';

// A single fixture module, reused for every role/liveMode combination in this file: it never
// reads the answer to "which role/liveMode" from anywhere but its own `createSignerClient(role,
// {liveMode})` arguments (exactly the contract external-module-signer.mjs calls), and it reports
// each call it receives into a per-test bucket keyed by `process.env.SIGNER_TEST_CALL_KEY` — read
// once, synchronously, inside the factory call itself (not inside `sign`/`broadcast`), so later
// mutation of that env var by another test cannot leak into an already-constructed client's
// closure.
const FIXTURE_MODULE_SOURCE = `
export function createSignerClient(role, { liveMode }) {
  const bucket = globalThis.__SIGNER_TEST_CALLS__.get(process.env.SIGNER_TEST_CALL_KEY);
  return {
    async sign(request, meta) {
      bucket.push({ method: 'sign', digest: meta.digest, role, liveMode });
      return { signedBytes: 'AAAA', signedTx: '0xdead', role };
    },
    async broadcast(signed, meta) {
      bucket.push({ method: 'broadcast', digest: null, role, liveMode });
      return { transactionId: 'tx-fixture-1' };
    },
  };
}
`;

const dir = mkdtempSync(join(tmpdir(), 'hookemon-external-module-signer-'));
const modulePath = join(dir, 'signer-module.mjs');
writeFileSync(modulePath, FIXTURE_MODULE_SOURCE);
globalThis.__SIGNER_TEST_CALLS__ = globalThis.__SIGNER_TEST_CALLS__ ?? new Map();
const fixtureSignerOptions = Object.freeze({ preflightAuthority: createTestProfileMutationAuthority() });

test.after(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function build(role, liveMode) {
  const key = randomUUID();
  const bucket = [];
  globalThis.__SIGNER_TEST_CALLS__.set(key, bucket);
  process.env.SIGNER_TEST_CALL_KEY = key;
  const client = await createExternalModuleSignerClient({ modulePath, role, liveMode, ...fixtureSignerOptions });
  return { client, calls: () => bucket };
}

registerSignerClientConformanceSuite(test, { name: 'external-module-signer', build });

test('external-module-signer requires a module path and refuses to fabricate a signer', async () => {
  await assert.rejects(
    () => createExternalModuleSignerClient({ modulePath: null, role: 'operator-evm', liveMode: true }),
    SignerClientError,
  );
  await assert.rejects(
    () => createExternalModuleSignerClient({ modulePath: '', role: 'operator-evm', liveMode: true }),
    /module path/,
  );
});

test('external-module-signer refuses a relative module path', async () => {
  await assert.rejects(
    () => createExternalModuleSignerClient({ modulePath: 'relative/signer.mjs', role: 'operator-evm', liveMode: true }),
    /absolute/,
  );
});

test('external-module-signer refuses a non-boolean liveMode', async () => {
  await assert.rejects(
    () => createExternalModuleSignerClient({ modulePath, role: 'operator-evm', liveMode: 'true' }),
    /liveMode must be a boolean/,
  );
});

test('external-module-signer refuses a module with no usable factory export', async () => {
  const badModulePath = join(dir, 'bad-signer-module.mjs');
  writeFileSync(badModulePath, 'export const somethingElse = 1;\n');
  await assert.rejects(
    () => createExternalModuleSignerClient({ modulePath: badModulePath, role: 'operator-evm', liveMode: true }),
    /must export createSignerClient/,
  );
});

test('external-module-signer accepts a default-export factory too', async () => {
  const defaultModulePath = join(dir, 'default-signer-module.mjs');
  writeFileSync(defaultModulePath, `
    export default function (role, { liveMode }) {
      return { async sign(request) { return { signedBytes: 'AAAA' }; } };
    }
  `);
  const client = await createExternalModuleSignerClient({ modulePath: defaultModulePath, role: 'distribution-signer', liveMode: true, ...fixtureSignerOptions });
  const result = await client.sign(Buffer.from('abc'));
  assert.equal(result.signedBytes, 'AAAA');
});

test('external-module-signer refuses a factory that does not return an object exposing sign()', async () => {
  const badModulePath = join(dir, 'no-sign-signer-module.mjs');
  writeFileSync(badModulePath, `export function createSignerClient() { return { onlyBroadcast() {} }; }\n`);
  await assert.rejects(
    () => createExternalModuleSignerClient({ modulePath: badModulePath, role: 'operator-evm', liveMode: true }),
    /exposing sign\(\)/,
  );
});

test('external-module-signer requires broadcast() for a role that needs it, but not for one that does not', async () => {
  const signOnlyModulePath = join(dir, 'sign-only-signer-module.mjs');
  writeFileSync(signOnlyModulePath, `export function createSignerClient() { return { async sign() { return { signedBytes: 'AAAA' }; } }; }\n`);
  await assert.rejects(
    () => createExternalModuleSignerClient({ modulePath: signOnlyModulePath, role: 'operator-evm', liveMode: true }),
    /exposing broadcast\(\)/,
  );
  // distribution-signer/verifier never need broadcast(), so the same sign-only module is fine there.
  const client = await createExternalModuleSignerClient({ modulePath: signOnlyModulePath, role: 'verifier', liveMode: true });
  assert.equal(client.broadcast, undefined);
});

test('external-module-signer passes the raw request through unchanged (a Buffer stays a Buffer at the module boundary)', async () => {
  const echoModulePath = join(dir, 'echo-signer-module.mjs');
  writeFileSync(echoModulePath, `
    export function createSignerClient() {
      return { async sign(request) { return { isBuffer: Buffer.isBuffer(request), length: request.length }; } };
    }
  `);
  const client = await createExternalModuleSignerClient({ modulePath: echoModulePath, role: 'distribution-signer', liveMode: true, ...fixtureSignerOptions });
  const result = await client.sign(Buffer.from('hello-digest'));
  assert.equal(result.isBuffer, true);
  assert.equal(result.length, 'hello-digest'.length);
});

function canonicalWirePolicy() {
  return {
    schema: 'hookemon.transaction-policy.v1',
    chainId: '4663',
    stage: 'payout',
    requestDigest: `sha256:${'a'.repeat(64)}`,
    expectedRecipient: '0x4444444444444444444444444444444444444444',
    amount: {
      chainId: '4663',
      assetId: 'native',
      decimals: 18,
      amountAtomic: '0',
    },
    allowedTargets: ['0x4444444444444444444444444444444444444444'],
    allowedPrograms: [],
  };
}

function policyRequest() {
  return {
    to: '0x4444444444444444444444444444444444444444',
    data: '0x',
    value: '0',
    chainId: '4663',
    from: '0x19E7E376E7C213B7E7e7e46cc70A5dD086DAff2A',
  };
}

test('external-module-signer recognizes the independent canonical v1 envelope before adapter rules', async () => {
  const key = randomUUID();
  const bucket = [];
  globalThis.__SIGNER_TEST_CALLS__.set(key, bucket);
  process.env.SIGNER_TEST_CALL_KEY = key;
  await assert.rejects(
    () => createExternalModuleSignerClient({
      modulePath,
      role: 'operator-evm',
      liveMode: true,
      ...fixtureSignerOptions,
      transactionPolicy: canonicalWirePolicy(),
      transactionPolicyRules: [],
      transactionDecodeOptions: { family: 'evm' },
    }),
    /at least one explicit rule/,
  );
  assert.equal(bucket.length, 0);
});

test('external-module-signer evaluates separately serialized adapter rules beside the canonical policy', async () => {
  const key = randomUUID();
  const bucket = [];
  globalThis.__SIGNER_TEST_CALLS__.set(key, bucket);
  process.env.SIGNER_TEST_CALL_KEY = key;
  const request = policyRequest();
  const decoded = await decodeProviderTransaction({ family: 'evm', transaction: request });
  const policy = policyFor(decoded, TRANSACTION_POLICY_SCHEMA);
  const wirePolicy = JSON.parse(JSON.stringify(policy));
  const wireRules = structuredClone(readTransactionPolicyRules(policy));
  assert.equal(Object.hasOwn(wirePolicy, 'rules'), false);

  const client = await createExternalModuleSignerClient({
    modulePath,
    role: 'operator-evm',
    liveMode: true,
    ...fixtureSignerOptions,
    transactionPolicy: wirePolicy,
    transactionPolicyRules: wireRules,
    transactionDecodeOptions: { family: 'evm' },
  });

  assert.deepEqual(await client.sign(request), { signedTx: '0xdead' });
  assert.equal(bucket.filter(call => call.method === 'sign').length, 1);
});
