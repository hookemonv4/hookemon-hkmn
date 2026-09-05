#!/usr/bin/env node

import { execFileSync } from 'node:child_process';

const PROJECT_NAME = 'Hookemon';
const PROJECT_EMAIL = '312745360+hookemonv4@users.noreply.github.com';
const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const HISTORICAL_IDENTITY_EXCEPTIONS = new Map([
  ['daa22b72f8b063b7a20a8fc8d029554265e36618', new Set(['author-identity', 'committer-identity'])],
  ['b96121f859dcf588059744e241db5c47136f0ce2', new Set(['author-identity', 'committer-identity'])],
  ['7db4557dcc9ab870a9bd2569e961ec9e4555f638', new Set(['author-identity'])],
  ['fbbcc68cb0771aebd37ba5942f62484d4b616f48', new Set(['author-identity'])],
  ['1ee432735021a62b1173ae6fccd4ca1df7e5c038', new Set(['author-identity'])],
  ['f65f75badbd1eb8041ffeb4c439f9ef3a61348d5', new Set(['author-identity'])],
  ['5963e29c8fae1d3cac59707b34d5b0a1f93d5e3e', new Set(['author-identity', 'committer-identity'])],
  ['3d51a63b75382f0aadfb3a35357950b1af033c08', new Set(['author-identity', 'committer-identity'])],
  ['98d80a4ce92d9e42ae2c492adb374ffc97fd78b2', new Set(['author-identity', 'committer-identity'])],
  ['7b922bb54cc2754801be46c1ef8ed13948d453dc', new Set(['author-identity', 'committer-identity'])],
  ['86d1a352e1d4824d66591d781ebcc7f2a5f14493', new Set(['author-identity', 'committer-identity'])],
  ['65ab6105bea8523a1dbdf6003cfaebc50363e2ff', new Set(['author-identity', 'committer-identity'])],
  ['feb43d31b017bcda8c89cead391e850d50e8c93a', new Set(['author-identity', 'committer-identity'])],
  ['f4d75ec1ab0647fcbac0c9e1d072b9f1fc9d530a', new Set(['author-identity', 'committer-identity', 'attribution-trailer'])],
  ['0df0c4596172595a744522933dcff364521d3b8c', new Set(['author-identity', 'committer-identity', 'attribution-trailer'])],
  ['81d0113ea38a81808cccd729ccf300897c26f8d5', new Set(['author-identity', 'committer-identity', 'attribution-trailer'])],
  ['5b0b4148a63c18c58bc96ac58519af49d4ca2c46', new Set(['author-identity', 'committer-identity', 'attribution-trailer'])],
  ['0cc681532184f615d29f771c03071163c15b89fc', new Set(['author-identity', 'committer-identity', 'attribution-trailer'])],
  ['55b2c5378bdcd1d15342eabf43286d1e107543ff', new Set(['author-identity', 'committer-identity', 'attribution-trailer'])],
  ['69502fcb67cd90978405f410052f1d1c9b916684', new Set(['author-identity', 'committer-identity', 'attribution-trailer'])],
  ['0963f003a12680e4dda2d5cf87f5232f91d5ba5f', new Set(['author-identity', 'committer-identity', 'attribution-trailer'])],
  ['1c82e23c7089677a17df66748a5fff649483514b', new Set(['author-identity', 'committer-identity', 'attribution-trailer'])],
  ['932b1d36b7b46de6f471c319307cc095f765108a', new Set(['author-identity', 'committer-identity', 'attribution-trailer'])],
  ['caf5500287c3ebbdcc98def630996529b5079a01', new Set(['author-identity', 'committer-identity', 'attribution-trailer'])],
]);
const attributionNames = [
  ['Co-', 'Authored-By'].join(''),
  ['Signed-', 'off-by'].join(''),
  ['Reviewed-', 'by'].join(''),
  ['Acked-', 'by'].join(''),
  ['Tested-', 'by'].join(''),
];
const ATTRIBUTION_PATTERN = new RegExp(`^\\s*(?:${attributionNames.join('|')})\\s*:`, 'i');

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });
}

function assertSha(value, label) {
  if (!SHA_PATTERN.test(value ?? '')) throw new Error(`${label} must be a full commit SHA`);
}

function readCommit(root, sha) {
  const fields = git(root, ['show', '--no-patch', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', sha]).split('\0');
  if (fields.length < 5) throw new Error(`could not read commit metadata for ${sha}`);
  return {
    sha,
    authorName: fields[0],
    authorEmail: fields[1],
    committerName: fields[2],
    committerEmail: fields[3],
    message: fields.slice(4).join('\0'),
  };
}

export function scanCommitRange(root, base, head) {
  assertSha(base, 'base');
  assertSha(head, 'head');
  const hashes = git(root, ['rev-list', '--reverse', `${base}..${head}`]).trim().split('\n').filter(Boolean);
  const findings = [];

  function recordFinding(sha, rule) {
    if (!HISTORICAL_IDENTITY_EXCEPTIONS.get(sha)?.has(rule)) findings.push({ sha, rule });
  }

  for (const commit of hashes.map(sha => readCommit(root, sha))) {
    if (commit.authorName !== PROJECT_NAME || commit.authorEmail !== PROJECT_EMAIL) {
      recordFinding(commit.sha, 'author-identity');
    }
    if (commit.committerName !== PROJECT_NAME || commit.committerEmail !== PROJECT_EMAIL) {
      recordFinding(commit.sha, 'committer-identity');
    }
    for (const line of commit.message.split(/\r?\n/)) {
      if (ATTRIBUTION_PATTERN.test(line)) {
        recordFinding(commit.sha, 'attribution-trailer');
      }
    }
  }

  return { commits: hashes.length, findings };
}

function main() {
  const [base, head] = process.argv.slice(2);
  try {
    const result = scanCommitRange(process.cwd(), base, head);
    if (result.findings.length === 0) {
      console.log(`commit identity check passed (${result.commits} ${result.commits === 1 ? 'commit' : 'commits'})`);
      return;
    }
    console.log(`commit identity check failed: ${result.findings.length} violation(s)`);
    for (const finding of result.findings) console.log(`- ${finding.sha}: ${finding.rule}`);
    process.exitCode = 1;
  } catch (error) {
    console.error(`commit identity check failed: ${error.message ?? error}`);
    process.exitCode = 1;
  }
}

main();
