import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { checkCapabilities, checkDeploymentDigest, checkOutput, safeInputPath } from '../programmable/lib/api-input-preparation.mjs';

const capabilities = () => ({ chain: { id: '4663', caip2: 'eip155:4663' }, chainDeployment: { chainId: '4663' }, profile: { profileVersion: '4.1.0' } });
function directory(t) {
  const path = mkdtempSync(join(tmpdir(), 'api-input-test-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}
test('capability routing rejects another chain or profile before official module loading', () => {
  checkCapabilities(capabilities());
  for (const mutate of [c => { c.chain.id = '1'; }, c => { c.chain.caip2 = 'eip155:1'; }, c => { c.chainDeployment.chainId = '1'; }]) {
    const candidate = capabilities(); mutate(candidate);
    assert.throws(() => checkCapabilities(candidate), /expected Robinhood chain 4663/);
  }
  const candidate = capabilities(); candidate.profile.profileVersion = '4.0.0';
  assert.throws(() => checkCapabilities(candidate), /expected provider profile 4.1.0/);
});
test('provider digest mismatch is refused', () => {
  checkDeploymentDigest('sha256:matching', 'sha256:matching');
  assert.throws(() => checkDeploymentDigest('sha256:actual', 'sha256:altered'), /digest mismatch/);
});
test('source path admission rejects credential names without opening a file', () => {
  // The missing root proves rejection happens before any filesystem read.
  for (const name of ['.env', '.env.local', '.git/config', 'nested/.env', '../.env', '/tmp/.env', 'wallet.key', 'a/../../.env']) {
    assert.throws(() => safeInputPath('/nonexistent-input-root', name), /unsafe source path/);
  }
});
test('source path admission refuses symlink leaves and ancestors', t => {
  const root = directory(t);
  writeFileSync(join(root, 'real.sol'), 'source');
  symlinkSync(join(root, 'real.sol'), join(root, 'linked.sol'));
  assert.throws(() => safeInputPath(root, 'linked.sol'), /linked source path/);
  mkdirSync(join(root, 'real'));
  writeFileSync(join(root, 'real/a.sol'), 'source');
  symlinkSync(join(root, 'real'), join(root, 'linked'), 'dir');
  assert.throws(() => safeInputPath(root, 'linked/a.sol'), /linked source path/);
});
test('output admission refuses overwrite, source descendants and aliased descendants', t => {
  const root = directory(t);
  const source = join(root, 'source'); mkdirSync(source);
  const existing = join(root, 'existing'); mkdirSync(existing);
  assert.throws(() => checkOutput(source, existing), /output exists/);
  assert.throws(() => checkOutput(source, join(source, 'output')), /outside source/);
  assert.throws(() => checkOutput(source, join(source, '..output')), /outside source/);
  const alias = join(root, 'alias'); symlinkSync(source, alias, 'dir');
  assert.throws(() => checkOutput(source, join(alias, 'output')), /outside source/);
  assert.equal(checkOutput(source, join(root, 'new-output')), join(realpathSync(root), 'new-output'));
});
