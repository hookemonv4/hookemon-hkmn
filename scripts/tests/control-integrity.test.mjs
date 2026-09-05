import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJson } from '../lib/util.mjs';
import { writeRawReceipt } from './helpers/raw-receipt.mjs';
import { writeOwnerApproval } from './helpers/owner-approval.mjs';
import { copyTrackedProjectFiles } from './helpers/tracked-project.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const templateRoot = join(here, '..', '..');

function proj() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'v4-control-')));
  copyTrackedProjectFiles(templateRoot, root);
  rmSync(join(root, 'receipts'), { recursive: true, force: true });
  rmSync(join(root, '.v4'), { recursive: true, force: true });
  mkdirSync(join(root, 'receipts'));
  execFileSync('git', ['-C', root, 'init', '--quiet']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Hookemon']);
  execFileSync('git', ['-C', root, 'config', 'user.email', '312745360+hookemonv4@users.noreply.github.com']);
  execFileSync('git', ['-C', root, 'add', '.']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'fixture']);
  return root;
}

function head(root) {
  return execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
}

function v4(root, ...args) {
  return JSON.parse(execFileSync(process.execPath, [join(root, 'scripts', 'v4.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  }).trim());
}

function v4Result(root, ...args) {
  return spawnSync(process.execPath, [join(root, 'scripts', 'v4.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('status --check fails closed for malformed latest gate results', () => {
  for (const result of [null, undefined, 'UNKNOWN']) {
    const root = proj();
    writeRawReceipt(root, { type: 'gate', phase: 'init', result });

    const checked = v4Result(root, 'status', '--check');

    assert.equal(checked.status, 1, `${String(result)}: ${checked.stderr}`);
  }
});

test('generic receipt CLI cannot manufacture a gate receipt', () => {
  const root = proj();

  const added = v4Result(root, 'receipt', 'add', '--type', 'gate', '--phase', 'init');

  assert.equal(added.status, 1);
  assert.match(added.stderr, /gate receipt type is reserved for gate commands/);
  assert.deepEqual(readdirSync(join(root, 'receipts')).filter(name => name.endsWith('.json')), []);
});

test('generic receipt CLI cannot manufacture owner NOT_APPLICABLE authorization', () => {
  const root = proj();

  const added = v4Result(
    root, 'receipt', 'add', '--type', 'owner-not-applicable-authorized',
    '--phase', 'spec', '--result', 'PASSED', '--input', 'gates/spec.json',
  );

  assert.equal(added.status, 1);
  assert.match(added.stderr, /reserved for gate commands/);
  assert.deepEqual(readdirSync(join(root, 'receipts')).filter(name => name.endsWith('.json')), []);
});

test('dedicated CLI records explicit owner NOT_APPLICABLE authorization and updates the run', () => {
  const root = proj();
  const definition = JSON.parse(readFileSync(join(root, 'gates', 'spec.json'), 'utf8'));
  writeJson(join(root, 'gates', 'spec.json'), { ...definition, items: [definition.items[0]] });
  const approval = 'decisions/owner-approvals/spec-s1-na.json';
  writeOwnerApproval(root, approval, {
    action: 'NOT_APPLICABLE', phase: 'spec', itemId: 'S1',
    rationale: 'Owner confirms S1 does not apply.',
  }, ['gates/spec.json', 'policy/policy.json']);

  const authorization = v4(
    root, 'gate', 'authorize-not-applicable', 'spec', '--item', 'S1',
    '--rationale', 'Owner confirms S1 does not apply.', '--approval', approval,
  );

  assert.equal(authorization.type, 'owner-not-applicable-authorized');
  assert.equal(authorization.data.itemId, 'S1');
  assert.match(authorization.inputHashes['policy/policy.json'], /^[0-9a-f]{64}$/);
  const run = JSON.parse(readFileSync(join(root, 'gates', 'runs', 'spec.json'), 'utf8'));
  assert.deepEqual(run.items.S1, { status: 'NOT_APPLICABLE', receipt: authorization.id });
});

test('task heartbeat forwards the requested TTL', () => {
  const root = proj();
  v4(root, 'task', 'add', 'T1', '--title', 'ttl test');
  const { token } = v4(root, 'task', 'claim', 'T1', '--owner', 'worker', '--ttl', '120');
  const before = Date.now();

  v4(root, 'task', 'heartbeat', 'T1', '--owner', 'worker', '--token', String(token), '--ttl', '1');

  const task = v4(root, 'task', 'list').tasks.find(candidate => candidate.id === 'T1');
  assert.ok(task.lease_expires >= before);
  assert.ok(task.lease_expires <= Date.now() + 2_000, `lease expires too late: ${task.lease_expires}`);
});

test('trace check uses the committed projection without creating a local ledger', () => {
  const root = proj();
  // Completion SHAs from the source repository do not exist in this fresh fixture history.
  writeJson(join(root, 'tasks.json'), { generatedAt: '2026-08-30T00:00:00.000Z', tasks: [] });
  assert.equal(existsSync(join(root, '.v4')), false);

  const traced = v4Result(root, 'trace', 'check');

  assert.equal(traced.status, 0, traced.stderr);
  assert.equal(existsSync(join(root, '.v4')), false);
});

test('generic receipt CLI can record the strict task evidence fields', () => {
  const root = proj();
  const commitSha = head(root);
  writeFileSync(join(root, 'artifact.txt'), 'verified output');
  writeJson(join(root, 'tasks.json'), {
    generatedAt: '2026-08-30T00:00:00.000Z',
    tasks: [{
      id: 'T1', title: 'task', phase: 'build', risk: 'ordinary', deps: [], reqs: [],
      status: 'done', commitSha,
    }],
  });

  const receipt = v4(
    root, 'receipt', 'add', '--type', 'evidence', '--result', 'PASSED',
    '--task', 'T1', '--commit', commitSha, '--input', 'artifact.txt',
  );

  assert.equal(receipt.result, 'PASSED');
  assert.equal(receipt.phase, 'build');
  assert.equal(receipt.data.taskId, 'T1');
  assert.equal(receipt.data.commitSha, commitSha);
  assert.match(receipt.data.taskFingerprint, /^[0-9a-f]{64}$/);
  assert.match(receipt.data.requirementsHash, /^[0-9a-f]{64}$/);
  assert.match(receipt.inputHashes['artifact.txt'], /^[0-9a-f]{64}$/);
  assert.match(receipt.inputHashes['specs/requirements.json'], /^[0-9a-f]{64}$/);
});

test('task evidence CLI rejects a phase that differs from the committed task projection', () => {
  const root = proj();
  const commitSha = head(root);
  writeFileSync(join(root, 'artifact.txt'), 'verified output');
  writeJson(join(root, 'tasks.json'), {
    generatedAt: '2026-08-30T00:00:00.000Z',
    tasks: [{
      id: 'T1', title: 'task', phase: 'build', risk: 'ordinary', deps: [], reqs: [],
      status: 'done', commitSha,
    }],
  });

  const added = v4Result(
    root, 'receipt', 'add', '--type', 'evidence', '--phase', 'spec', '--result', 'PASSED',
    '--task', 'T1', '--commit', commitSha, '--input', 'artifact.txt',
  );

  assert.equal(added.status, 1);
  assert.match(added.stderr, /phase build does not match requested spec/);
  assert.deepEqual(readdirSync(join(root, 'receipts')).filter(name => name.endsWith('.json')), []);
});
