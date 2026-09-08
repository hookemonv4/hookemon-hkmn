import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preserveEthReceiptCollision, verifiedEthCollisionPaths, PROVENANCE_DIRECTORY } from '../lib/receipt-provenance.mjs';
const SOURCE = '56f185e07dfafe5533df617ec1dad473ecb63f68';
const ACTIVE = '63396266c1fa7f30814177a6c548e9af332d07ad';
const env = { ...process.env, GIT_AUTHOR_NAME: 'Hookemon', GIT_AUTHOR_EMAIL: '312745360+hookemonv4@users.noreply.github.com', GIT_COMMITTER_NAME: 'Hookemon', GIT_COMMITTER_EMAIL: '312745360+hookemonv4@users.noreply.github.com' };
function git(root, ...args) { return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
function snapshot(root, parents = [SOURCE, ACTIVE]) {
  git(root, 'add', 'receipts', PROVENANCE_DIRECTORY);
  return git(root, 'commit-tree', git(root, 'write-tree'), ...parents.flatMap(parent => ['-p', parent]), '-m', 'test preservation');
}

test('preserves only the pinned two-receipt collision and fails closed on tampering', () => {
  const root = mkdtempSync(join(tmpdir(), 'hookemon-provenance-'));
  try {
    git(root, 'clone', '--quiet', '--shared', '--no-checkout', process.cwd(), '.');
    git(root, 'checkout', '--quiet', '-b', 'codex/provenance-test', SOURCE);
    assert.throws(() => preserveEthReceiptCollision(root));
    spawnSync('git', ['-C', root, '-c', 'commit.gpgsign=false', 'merge', '--no-ff', '--no-commit', ACTIVE], { env });
    git(root, 'read-tree', '--reset', '-u', ACTIVE);
    const result = preserveEthReceiptCollision(root);
    assert.equal(result.authority, false);
    const head = snapshot(root);
    const verified = verifiedEthCollisionPaths(root, head, [SOURCE, ACTIVE]);
    assert.deepEqual([...verified.get(SOURCE)], ['receipts/r-00648.json', 'receipts/r-00649.json']);
    assert.equal(verified.has(ACTIVE), false);
    const scanner = join(import.meta.dirname, '../check-append-only.mjs');
    const scan = target => spawnSync(process.execPath, [scanner, ACTIVE, target], { cwd: root, encoding: 'utf8' });
    const passing = scan(head);
    assert.equal(passing.status, 0, passing.stdout + passing.stderr);
    const unrelated = join(root, 'receipts/r-00001.json');
    const unrelatedBytes = readFileSync(unrelated);
    writeFileSync(unrelated, '{}\n');
    const rejected = scan(snapshot(root));
    assert.equal(rejected.status, 1);
    assert.match(rejected.stdout, /receipts\/r-00001.json: modified/);
    writeFileSync(unrelated, unrelatedBytes);
    assert.equal(verifiedEthCollisionPaths(root, head, [SOURCE]).size, 0);
    assert.equal(verifiedEthCollisionPaths(root, head, [SOURCE, SOURCE]).size, 0);
    assert.equal(verifiedEthCollisionPaths(root, head, [SOURCE, ACTIVE, head]).size, 0);
    const descriptor = join(root, result.descriptor);
    const original = readFileSync(descriptor);
    writeFileSync(descriptor, '{}\n');
    assert.equal(verifiedEthCollisionPaths(root, snapshot(root), [SOURCE, ACTIVE]).size, 0);
    assert.throws(() => preserveEthReceiptCollision(root), /bytes differ/);
    writeFileSync(descriptor, original);
    const archive = join(root, PROVENANCE_DIRECTORY, 'b196230ae714ce01a0d3317bde4bfbfbd65b6891.json');
    const archiveBytes = readFileSync(archive);
    writeFileSync(archive, '{}\n');
    assert.equal(verifiedEthCollisionPaths(root, snapshot(root), [SOURCE, ACTIVE]).size, 0);
    writeFileSync(archive, archiveBytes);
    chmodSync(archive, 0o755);
    assert.equal(verifiedEthCollisionPaths(root, snapshot(root), [SOURCE, ACTIVE]).size, 0);
    chmodSync(archive, 0o644);
    writeFileSync(join(root, 'receipts/r-00648.json'), '{}\n');
    assert.equal(verifiedEthCollisionPaths(root, snapshot(root), [SOURCE, ACTIVE]).size, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
