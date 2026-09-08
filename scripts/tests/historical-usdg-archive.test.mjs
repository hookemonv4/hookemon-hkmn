import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, chmodSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openLedger, addTask, archiveHistoricalUsdgCompletion } from '../lib/ledger.mjs';
import { HISTORICAL_USDG_ARCHIVE, HISTORICAL_USDG_SOURCES, prepareHistoricalUsdgArchive, historicalUsdgArchiveInventory } from '../lib/historical-usdg-archive.mjs';
import { writeJson, sha256 } from '../lib/util.mjs';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeOwnerApproval } from './helpers/owner-approval.mjs';

function fixture(t, taskId = 'PR38-EVIDENCE-CLEANUP') {
  const root = mkdtempSync(join(tmpdir(), 'pr38-archive-'));
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Hookemon');
  git('config', 'user.email', '312745360+hookemonv4@users.noreply.github.com');
  execFileSync('git', ['-C', root, 'index-pack', '--stdin'], { input: readFileSync(new URL('./fixtures/pr38-history/objects.pack', import.meta.url)), stdio: ['pipe', 'pipe', 'pipe'] });
  git('update-ref', 'HEAD', HISTORICAL_USDG_ARCHIVE);
  const inventory = historicalUsdgArchiveInventory(root, taskId, HISTORICAL_USDG_ARCHIVE);
  for (const file of inventory.archiveFiles) {
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    writeFileSync(join(root, file.path), execFileSync('git', ['-C', root, 'cat-file', 'blob', file.blob]));
  }
  const db = openLedger(root);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  addTask(db, { id: taskId, title: 'Historical PR38 task' });
  db.prepare("UPDATE tasks SET status='done' WHERE id=?").run(taskId);
  db.prepare("INSERT INTO attempts(task_id,token,owner,started,ended,outcome,commit_sha) VALUES(?,0,'original','then','then','done',?)").run(taskId, HISTORICAL_USDG_SOURCES[taskId]);
  const current = prepareHistoricalUsdgArchive(db, taskId);
  const descriptor = { schema: 'v4-historical-usdg-completion-archive-v1', action: 'TASK_ARCHIVE_HISTORICAL_USDG_COMPLETION', taskId,
    prestate: current.prestate, prestateFingerprint: current.fingerprint, inventory,
    rationale: 'Accept this historical archive disposition without native release authority' };
  const options = { record: `decisions/task-archives/${taskId}.json`, approval: 'decisions/owner-approvals/archive.json' };
  const save = () => writeJson(join(root, options.record), descriptor);
  const approve = () => writeOwnerApproval(root, options.approval, { action: descriptor.action, phase: 'build', itemId: taskId, rationale: descriptor.rationale }, [options.record]);
  save(); approve();
  const snapshot = () => JSON.stringify(['tasks', 'attempts'].map(table => db.prepare(`SELECT * FROM ${table}`).all()));
  const apply = () => archiveHistoricalUsdgCompletion(db, taskId, options);
  return { root, git, db, taskId, descriptor, options, save, approve, snapshot, apply };
}
for (const [taskId, count, normalized] of [['PR38-EVIDENCE-CLEANUP', 8, 3], ['PR38-PUBLIC-HASH-REDACTION', 25, 0]]) {
  test(`${taskId} preserves complete historical paths and appends truthful provenance`, t => {
    const f = fixture(t, taskId);
    const original = f.db.prepare('SELECT * FROM attempts').get();
    const task = f.db.prepare('SELECT * FROM tasks').get();
    assert.equal(f.descriptor.inventory.partition.length, count);
    assert.equal(f.descriptor.inventory.partition.filter(p => p.disposition === 'pinned-later-normalized-counterpart').length, normalized);
    assert.equal(f.apply().route, 'owner-approved-historical-usdg-archive');
    assert.deepEqual(f.db.prepare('SELECT * FROM attempts ORDER BY seq LIMIT 1').get(), original);
    assert.deepEqual(f.db.prepare('SELECT * FROM tasks').get(), task);
    const latest = f.db.prepare('SELECT * FROM attempts ORDER BY seq DESC LIMIT 1').get();
    const provenance = JSON.parse(latest.provenance);
    assert.equal(provenance.recordHash, sha256(readFileSync(join(f.root, f.options.record))));
    assert.equal(provenance.descriptor.prestate.completion.seq, original.seq);
    assert.throws(f.apply, /source completion/);
  });
}
const failures = {
  'missing pinned source objects': f => { for (const file of readdirSync(join(f.root, '.git/objects/pack'))) rmSync(join(f.root, '.git/objects/pack', file)); },
  'wrong approval action': f => writeOwnerApproval(f.root, f.options.approval, { action: 'TASK_BIND_REQUIREMENTS', phase: 'build', itemId: f.taskId, rationale: f.descriptor.rationale }, [f.options.record]),
  'missing owner approval': f => rmSync(join(f.root, f.options.approval)),
  'changed approved descriptor': f => { f.descriptor.rationale += ' altered'; f.save(); },
  'stale title': f => f.db.prepare("UPDATE tasks SET title='changed'").run(),
  'stale completion sequence': f => f.db.prepare("INSERT INTO attempts(task_id,token,owner,started,outcome,commit_sha) SELECT task_id,token,owner,started,outcome,commit_sha FROM attempts").run(),
  'leased completed task': f => f.db.prepare("UPDATE tasks SET lease_owner='worker',lease_expires=1").run(),
  'wrong source completion': f => f.db.prepare('UPDATE attempts SET commit_sha=?').run(HISTORICAL_USDG_ARCHIVE),
  'dropped source path': f => { f.descriptor.inventory.partition.pop(); f.save(); f.approve(); },
  'false normalized equivalence': f => { f.descriptor.inventory.partition.find(p => p.normalization).disposition = 'exact-archived-counterpart'; f.save(); f.approve(); },
  'different source commit': f => { f.descriptor.inventory.sourceCommit = HISTORICAL_USDG_ARCHIVE; f.save(); f.approve(); },
  'missing archive counterpart': f => rmSync(join(f.root, f.descriptor.inventory.archiveFiles[0].path)),
  'tampered archive counterpart': f => writeFileSync(join(f.root, f.descriptor.inventory.archiveFiles[0].path), 'tampered'),
  'executable archive counterpart': f => chmodSync(join(f.root, f.descriptor.inventory.archiveFiles[0].path), 0o755),
  'replacement source ref': f => f.git('replace', HISTORICAL_USDG_SOURCES[f.taskId], HISTORICAL_USDG_ARCHIVE),
};
for (const [name, change] of Object.entries(failures)) test(`refuses ${name} without ledger writes`, t => {
  const f = fixture(t); change(f); const before = f.snapshot();
  assert.throws(f.apply); assert.equal(f.snapshot(), before);
});
test('refuses other tasks and caller-chosen source refs', t => {
  const f = fixture(t);
  assert.throws(() => prepareHistoricalUsdgArchive(f.db, 'BOT-CLEANROOM'), /limited/);
  assert.throws(() => historicalUsdgArchiveInventory(f.root, f.taskId, 'HEAD'), /exact commit/);
});
for (const [name, mode, contents] of [['content', '100644', 'changed'], ['mode', '100755', null], ['extra path', '100644', 'unexpected archive file']]) test(`rejects target ${name} replacement even with fresh owner descriptor`, t => {
  const f = fixture(t);
  const file = f.descriptor.inventory.archiveFiles[0];
  const blob = contents ? execFileSync('git', ['-C', f.root, 'hash-object', '-w', '--stdin'], { input: contents, encoding: 'utf8' }).trim() : file.blob;
  f.git('read-tree', HISTORICAL_USDG_ARCHIVE);
  f.git('update-index', '--add', '--cacheinfo', mode, blob, name === 'extra path' ? 'docs/evidence/usdg-launch-preparation-20260907/extra.txt' : file.path);
  const tree = f.git('write-tree', '--missing-ok');
  const target = f.git('commit-tree', tree, '-p', HISTORICAL_USDG_ARCHIVE, '-m', 'invalid archive fixture');
  f.git('update-ref', 'HEAD', target);
  f.descriptor.inventory.target = target; f.save(); f.approve();
  const before = f.snapshot(); assert.throws(f.apply, /target differs|100644/); assert.equal(f.snapshot(), before);
});

test('the original module card cannot be dropped from the approved partition', t => {
  const f = fixture(t, 'PR38-PUBLIC-HASH-REDACTION');
  f.descriptor.inventory.partition = f.descriptor.inventory.partition.filter(p => p.source.path !== 'docs/modules/launch-preparation.md');
  f.save(); f.approve(); const before = f.snapshot();
  assert.throws(f.apply, /inventory mismatch/); assert.equal(f.snapshot(), before);
});
