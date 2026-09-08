import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
const directory = new URL('./', import.meta.url);
const read = name => JSON.parse(readFileSync(new URL(name, directory), 'utf8'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sources = read('sources.json');
const inventory = read('findings.json');
const files = new Map();
for (const [path, expected] of Object.entries(sources.fileSha256)) {
  const bytes = readFileSync(path);
  assert.equal(sha256(bytes), expected, `Audited bytes changed: ${path}`);
  files.set(path, bytes.toString('utf8'));
}
for (const row of inventory.findings) {
  const text = files.get(row.file);
  assert.equal(sha256(text.slice(row.offset, row.offset + row.markerLength).toLowerCase()), row.markerSha256,
    `Marker differs at ${row.file}:${row.line}`);
  assert.equal(text.slice(0, row.offset).split('\n').length, row.line);
}
assert.equal(inventory.findings.length, inventory.total);
assert.equal(files.size, sources.targetedFileCount);
if (process.argv[2]) {
  const log = readFileSync(process.argv[2]);
  assert.equal(sha256(log), sources.ciLogSha256);
  const counts = rows => rows.reduce((result, [file, rule]) => {
    const key = `${file}:${rule}`; result[key] = (result[key] ?? 0) + 1; return result;
  }, {});
  const logged = [...log.toString('utf8').matchAll(/Z - (.+): ([a-z-]+)/g)].map(match => [match[1], match[2]]);
  assert.deepEqual(counts(inventory.findings.map(row => [row.file, row.rule])), counts(logged));
}
console.log(`Verified ${inventory.total} recorded findings in ${files.size} exact files; no full scan.`);
