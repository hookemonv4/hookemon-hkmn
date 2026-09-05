import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import {
  addReceipt, compareReceiptFilenames, listReceipts, isStale,
} from '../lib/receipts.mjs';

function proj() { return mkdtempSync(join(tmpdir(), 'v4-')); }

test('addReceipt writes append-only receipts with input hashes', () => {
  const root = proj();
  writeFileSync(join(root, 'a.txt'), 'hello');
  const r1 = addReceipt(root, { type: 'evidence', phase: 'spec', result: 'PASSED', inputs: ['a.txt'] });
  assert.equal(r1.id, 'r-00001');
  assert.match(r1.inputHashes['a.txt'], /^[0-9a-f]{64}$/);
  const r2 = addReceipt(root, { type: 'decision', data: { note: 'x' } });
  assert.equal(r2.id, 'r-00002');
  assert.deepEqual(listReceipts(root).map(r => r.id), ['r-00001', 'r-00002']);
});

test('receipt history fails closed when a sequence has a gap', () => {
  const root = proj();
  addReceipt(root, { type: 'first' });
  const removed = addReceipt(root, { type: 'removed' });
  addReceipt(root, { type: 'existing' });
  unlinkSync(join(root, 'receipts', `${removed.id}.json`));

  assert.throws(() => listReceipts(root), /contiguous/);
  assert.throws(() => addReceipt(root, { type: 'next' }), /contiguous/);
});

test('listReceipts rejects noncanonical names, id mismatches, invalid schemas, and symlinks', () => {
  const cases = [
    {
      name: 'noncanonical filename',
      setup(root, receipt) { writeFileSync(join(root, 'receipts', 'zzz.json'), JSON.stringify(receipt)); },
      error: /canonical/,
    },
    {
      name: 'filename and id mismatch',
      setup(root, receipt) {
        writeFileSync(join(root, 'receipts', 'r-00001.json'), JSON.stringify({ ...receipt, id: 'r-00002' }));
      },
      error: /does not match filename/,
    },
    {
      name: 'array schema',
      setup(root) { writeFileSync(join(root, 'receipts', 'r-00001.json'), '[]'); },
      error: /plain object/,
    },
    {
      name: 'unexpected schema field',
      setup(root, receipt) {
        writeFileSync(join(root, 'receipts', 'r-00001.json'), JSON.stringify({ ...receipt, unexpected: true }));
      },
      error: /contain exactly/,
    },
    {
      name: 'receipt symlink',
      setup(root, receipt) {
        const outside = join(proj(), 'outside.json');
        writeFileSync(outside, JSON.stringify(receipt));
        symlinkSync(outside, join(root, 'receipts', 'r-00001.json'));
      },
      error: /symlink/,
    },
  ];

  for (const c of cases) {
    const root = proj();
    mkdirSync(join(root, 'receipts'));
    const receipt = {
      id: 'r-00001', at: '2026-08-30T00:00:00.000Z', type: 'evidence', phase: null,
      result: null, data: {}, inputHashes: {},
    };
    c.setup(root, receipt);
    assert.throws(() => listReceipts(root), c.error, c.name);
  }
});

test('listReceipts rejects a symlinked receipts directory', () => {
  const root = proj();
  const outside = proj();
  symlinkSync(outside, join(root, 'receipts'));
  assert.throws(() => listReceipts(root), /real directory, not a symlink/);
});

test('receipt filenames sort by arbitrary-precision numeric sequence', () => {
  assert.ok(compareReceiptFilenames('r-99999.json', 'r-100000.json') < 0);
  assert.ok(compareReceiptFilenames('r-100000.json', 'r-100001.json') < 0);
});

test('the repository receipt history r1-r25 remains valid and ordered', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const receipts = listReceipts(root);
  assert.ok(receipts.length >= 25);
  assert.deepEqual(receipts.slice(0, 25).map(receipt => receipt.id),
    Array.from({ length: 25 }, (_, index) => `r-${String(index + 1).padStart(5, '0')}`));
});

test('addReceipt fails a write collision without overwriting the existing receipt', async () => {
  const root = proj();
  mkdirSync(join(root, 'receipts'));
  const ready = join(root, 'collision-ready');
  const release = join(root, 'collision-release');
  const moduleUrl = new URL('../lib/receipts.mjs', import.meta.url).href;
  const worker = `
    import { existsSync, writeFileSync } from 'node:fs';
    import { addReceipt } from ${JSON.stringify(moduleUrl)};
    const [root, ready, release] = process.argv.slice(1);
    const NativeDate = Date;
    globalThis.Date = class extends NativeDate {
      toISOString() {
        writeFileSync(ready, 'ready');
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!existsSync(release)) Atomics.wait(wait, 0, 0, 10);
        return super.toISOString();
      }
    };
    addReceipt(root, { type: 'racing-writer' });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '--eval', worker, root, ready, release], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const exited = once(child, 'exit');
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr += chunk; });
  for (let attempt = 0; attempt < 200 && !existsSync(ready); attempt += 1) {
    if (child.exitCode !== null) break;
    await delay(5);
  }
  assert.equal(existsSync(ready), true, `worker failed before collision point: ${stderr}`);
  const target = join(root, 'receipts', 'r-00001.json');
  const sentinel = '{"id":"r-00001","type":"existing"}\n';
  writeFileSync(target, sentinel);
  writeFileSync(release, 'release');

  const [code] = await exited;

  assert.notEqual(code, 0);
  assert.match(stderr, /EEXIST/);
  assert.equal(readFileSync(target, 'utf8'), sentinel);
});

test('addReceipt rejects absolute input paths', () => {
  const root = proj();
  const outside = join(proj(), 'outside.txt');
  writeFileSync(outside, 'secret');

  assert.throws(
    () => addReceipt(root, { type: 'evidence', inputs: [outside] }),
    /repo-relative input path/,
  );
});

test('addReceipt rejects parent traversal input paths', () => {
  const root = proj();
  const outsideRoot = proj();
  const outside = join(outsideRoot, 'outside.txt');
  writeFileSync(outside, 'secret');

  assert.throws(
    () => addReceipt(root, { type: 'evidence', inputs: [relative(root, outside)] }),
    /repo-relative input path/,
  );
});

test('addReceipt rejects input symlinks that escape the repository', () => {
  const root = proj();
  const outside = join(proj(), 'outside.txt');
  writeFileSync(outside, 'secret');
  symlinkSync(outside, join(root, 'escape.txt'));

  assert.throws(
    () => addReceipt(root, { type: 'evidence', inputs: ['escape.txt'] }),
    /input resolves outside repository/,
  );
});

test('isStale detects changed inputs', () => {
  const root = proj();
  writeFileSync(join(root, 'a.txt'), 'v1');
  const r = addReceipt(root, { type: 'evidence', phase: 'spec', result: 'PASSED', inputs: ['a.txt'] });
  assert.equal(isStale(root, r), false);
  writeFileSync(join(root, 'a.txt'), 'v2');
  assert.equal(isStale(root, r), true);
});

test('isStale follows receipt inputs transitively', () => {
  const root = proj();
  writeFileSync(join(root, 'evidence.txt'), 'v1');
  const evidence = addReceipt(root, { type: 'evidence', inputs: ['evidence.txt'] });
  const gate = addReceipt(root, {
    type: 'decision',
    phase: 'spec',
    result: 'PASSED',
    inputs: [`receipts/${evidence.id}.json`],
  });

  assert.equal(isStale(root, gate), false);
  writeFileSync(join(root, 'evidence.txt'), 'v2');
  assert.equal(isStale(root, gate), true);
});

test('isStale treats cyclic receipt identities as stale', () => {
  const root = proj();
  const evidence = addReceipt(root, { type: 'evidence' });
  const gate = addReceipt(root, {
    type: 'decision',
    phase: 'spec',
    result: 'PASSED',
    inputs: [`receipts/${evidence.id}.json`],
  });

  assert.equal(isStale(root, { ...gate, id: evidence.id }), true);
});
