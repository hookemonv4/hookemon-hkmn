import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { attachOwnerSignature } from '../../src/signing/standing-authority.mjs';
import { runCli, runPrint, runVerify, parseArgs } from '../../bin/hookemon-authority.mjs';

const execFileAsync = promisify(execFile);
const binPath = new URL('../../bin/hookemon-authority.mjs', import.meta.url).pathname;

const dir = mkdtempSync(join(tmpdir(), 'hookemon-authority-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

const ownerKeys = generateKeyPairSync('ed25519');
const policyKeys = generateKeyPairSync('ed25519');
const ownerPublicKeyPath = join(dir, 'owner-public.pem');
writeFileSync(ownerPublicKeyPath, ownerKeys.publicKey.export({ type: 'spki', format: 'pem' }));
const policyPublicKeyPath = join(dir, 'policy-public.pem');
writeFileSync(policyPublicKeyPath, policyKeys.publicKey.export({ type: 'spki', format: 'pem' }));

const planPath = join(dir, 'plan.json');
writeFileSync(planPath, JSON.stringify({
  owner: 'hookemon-owner',
  perCycleSpendCap: '25000000',
  maxCyclesPerDay: 72,
  allowedPacks: ['collector-crypt'],
  allowedDestinations: ['relay-bridge-return'],
  issuedAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2027-01-01T00:00:00.000Z',
  documentId: 'standing-authority-2026-01',
}));

test('parseArgs rejects an unknown flag', () => {
  assert.throws(() => parseArgs(['print', '--nope', 'x']), /unknown argument/);
});

test('print builds the canonical unsigned document from a plan file and a policy public key', async () => {
  const document = await runPrint({ input: planPath, 'policy-public-key': policyPublicKeyPath });
  assert.equal(document.schema, 'hookemon.standing-authority-document.v1');
  assert.equal(Object.hasOwn(document, 'ownerSignature'), false);
  assert.match(document.documentDigest, /^sha256:[0-9a-f]{64}$/);
});

test('print --out writes the document to a file instead of stdout', async () => {
  const outPath = join(dir, 'printed.json');
  await runPrint({ input: planPath, 'policy-public-key': policyPublicKeyPath, out: outPath });
  const written = JSON.parse(readFileSync(outPath, 'utf8'));
  assert.equal(written.schema, 'hookemon.standing-authority-document.v1');
});

test('verify accepts a document signed (simulated) by the owner key, and rejects one that is not', async () => {
  const document = await runPrint({ input: planPath, 'policy-public-key': policyPublicKeyPath });
  const signed = attachOwnerSignature(document, ownerKeys.privateKey);
  const documentPath = join(dir, 'signed.json');
  writeFileSync(documentPath, JSON.stringify(signed));

  const verified = await runVerify({ document: documentPath, 'owner-public-key': ownerPublicKeyPath });
  assert.equal(verified.documentDigest, document.documentDigest);

  const tamperedPath = join(dir, 'signed-tampered.json');
  writeFileSync(tamperedPath, JSON.stringify({ ...signed, maxCyclesPerDay: 9999 }));
  await assert.rejects(() => runVerify({ document: tamperedPath, 'owner-public-key': ownerPublicKeyPath }), /failed verification/);
});

test('runCli dispatches print/verify and rejects an unknown mode', async () => {
  await assert.rejects(() => runCli(['bogus']), /unknown mode/);
  const document = await runCli(['print', '--input', planPath, '--policy-public-key', policyPublicKeyPath]);
  assert.equal(document.schema, 'hookemon.standing-authority-document.v1');
});

test('hookemon-authority runs print as a subprocess and never emits an ownerSignature field', async () => {
  const { stdout } = await execFileAsync(process.execPath, [binPath, 'print', '--input', planPath, '--policy-public-key', policyPublicKeyPath]);
  const document = JSON.parse(stdout);
  assert.equal(document.schema, 'hookemon.standing-authority-document.v1');
  assert.equal(Object.hasOwn(document, 'ownerSignature'), false);
});

test('this tool exposes no signing subcommand at all (source-level check)', async () => {
  const source = await import('node:fs').then(fs => fs.readFileSync(new URL('../../bin/hookemon-authority.mjs', import.meta.url), 'utf8'));
  assert.equal(source.includes('attachOwnerSignature'), false, 'the CLI must never call attachOwnerSignature itself');
  assert.equal(/createPrivateKey/.test(source), false, 'the CLI must never construct a private key');
});
