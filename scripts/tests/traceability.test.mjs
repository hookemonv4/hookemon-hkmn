import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = resolve(import.meta.dirname, '../..');
const buildScript = join(root, 'scripts/build-traceability.mjs');
const verifyScript = join(root, 'scripts/verify-traceability.mjs');

function sourceReport(entries) {
  return [{ lane: 'fixture', verified: entries }];
}

function rawSourceReport(entries) {
  return [{ lane: 'fixture', merged: { candidates: [] }, verified: entries }];
}

function finding(id, verdict) {
  return {
    id,
    severity: 'HIGH',
    tag: 'FIXTURE',
    title: `Fixture ${id}`,
    where: 'fixture:1',
    verdict,
  };
}

function writeFixtureRoot() {
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'traceability-'));
  const findingsDirectory = join(fixtureRoot, 'docs/audit/2026-09-04/findings');
  mkdirSync(findingsDirectory, { recursive: true });
  writeFileSync(
    join(findingsDirectory, 'verified-L3.json'),
    JSON.stringify(sourceReport([finding('L3-M17', 'CONTESTED')]), null, 2) + '\n',
  );
  writeFileSync(
    join(findingsDirectory, 'verified-L1-L2-L4-L5-L6.json'),
    JSON.stringify(sourceReport([finding('L1-M1', 'CONFIRMED')]), null, 2) + '\n',
  );
  return fixtureRoot;
}

function run(script, fixtureRoot) {
  return spawnSync(process.execPath, [script, '--root', fixtureRoot], {
    cwd: root,
    encoding: 'utf8',
  });
}

function importReports(fixtureRoot, l3InputPath, combinedInputPath) {
  return spawnSync(process.execPath, [
    buildScript,
    '--root', fixtureRoot,
    '--import', l3InputPath, combinedInputPath,
  ], {
    cwd: root,
    encoding: 'utf8',
  });
}

function buildFixture(fixtureRoot) {
  const result = run(buildScript, fixtureRoot);
  assert.equal(result.status, 0, `build failed:\n${result.stdout}\n${result.stderr}`);
}

function verifyFixture(fixtureRoot) {
  return run(verifyScript, fixtureRoot);
}

function traceabilityPath(fixtureRoot) {
  return join(fixtureRoot, 'docs/audit/2026-09-04/traceability.json');
}

function readTraceability(fixtureRoot) {
  return JSON.parse(readFileSync(traceabilityPath(fixtureRoot), 'utf8'));
}

function writeTraceability(fixtureRoot, traceability) {
  writeFileSync(traceabilityPath(fixtureRoot), JSON.stringify(traceability, null, 2) + '\n');
}

test('builds a matrix that verifies every eligible fixture finding', () => {
  const fixtureRoot = writeFixtureRoot();
  try {
    buildFixture(fixtureRoot);
    const result = verifyFixture(fixtureRoot);
    assert.equal(result.status, 0, `verification failed:\n${result.stdout}\n${result.stderr}`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('rejects a matrix missing an eligible finding disposition', () => {
  const fixtureRoot = writeFixtureRoot();
  try {
    buildFixture(fixtureRoot);
    const traceability = readTraceability(fixtureRoot);
    traceability.findings = traceability.findings.filter(entry => entry.id !== 'L1-M1');
    writeTraceability(fixtureRoot, traceability);

    const result = verifyFixture(fixtureRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing disposition for L1-M1/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('rejects duplicate and unknown-work-package dispositions', () => {
  const fixtureRoot = writeFixtureRoot();
  try {
    buildFixture(fixtureRoot);
    const traceability = readTraceability(fixtureRoot);
    const duplicate = structuredClone(traceability.findings.find(entry => entry.id === 'L1-M1'));
    duplicate.disposition = { wp: ['WP999'], acceptance: 'Fixture acceptance.' };
    traceability.findings.push(duplicate);
    writeTraceability(fixtureRoot, traceability);

    const result = verifyFixture(fixtureRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /multiple dispositions for L1-M1/);
    assert.match(result.stderr, /unknown work package WP999/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('rejects two disposition variants on one finding', () => {
  const fixtureRoot = writeFixtureRoot();
  try {
    buildFixture(fixtureRoot);
    const traceability = readTraceability(fixtureRoot);
    const entry = traceability.findings.find(candidate => candidate.id === 'L1-M1');
    entry.disposition = {
      wp: ['WP04c'],
      acceptance: 'Fixture acceptance.',
      openFailClosed: 'A second disposition is not allowed.',
    };
    writeTraceability(fixtureRoot, traceability);

    const result = verifyFixture(fixtureRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /invalid disposition shape for L1-M1/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('rejects a sanitized source report with an unexpected finding field', () => {
  const fixtureRoot = writeFixtureRoot();
  try {
    const sourcePath = join(fixtureRoot, 'docs/audit/2026-09-04/findings/verified-L3.json');
    const source = JSON.parse(readFileSync(sourcePath, 'utf8'));
    source[0].verified[0].detail = 'Unexpected source field.';
    writeFileSync(sourcePath, JSON.stringify(source, null, 2) + '\n');

    const build = run(buildScript, fixtureRoot);
    assert.notEqual(build.status, 0);
    assert.match(build.stderr, /unexpected field detail/);

    const verify = verifyFixture(fixtureRoot);
    assert.notEqual(verify.status, 0);
    assert.match(verify.stderr, /unexpected field detail/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('imports a compact source projection before building the matrix', () => {
  const fixtureRoot = writeFixtureRoot();
  const l3InputPath = join(fixtureRoot, 'raw-l3.json');
  const combinedInputPath = join(fixtureRoot, 'raw-combined.json');
  try {
    writeFileSync(l3InputPath, JSON.stringify(rawSourceReport([{
      ...finding('L3-M17', 'CONTESTED'),
      detail: 'This field must not be copied.',
    }]), null, 2) + '\n');
    writeFileSync(combinedInputPath, JSON.stringify(rawSourceReport([{
      ...finding('L1-M1', 'CONFIRMED'),
      detail: 'This field must not be copied.',
    }]), null, 2) + '\n');

    const result = importReports(fixtureRoot, l3InputPath, combinedInputPath);
    assert.equal(result.status, 0, `import failed:\n${result.stdout}\n${result.stderr}`);

    const imported = JSON.parse(readFileSync(join(
      fixtureRoot,
      'docs/audit/2026-09-04/findings/verified-L3.json',
    ), 'utf8'));
    assert.deepEqual(Object.keys(imported[0]), ['lane', 'verified']);
    assert.deepEqual(Object.keys(imported[0].verified[0]).sort(), [
      'id', 'severity', 'tag', 'title', 'verdict', 'where',
    ]);

    const verify = verifyFixture(fixtureRoot);
    assert.equal(verify.status, 0, `verification failed:\n${verify.stdout}\n${verify.stderr}`);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('redacts clean-room regex markers during source import', () => {
  const fixtureRoot = writeFixtureRoot();
  const l3InputPath = join(fixtureRoot, 'raw-l3.json');
  const combinedInputPath = join(fixtureRoot, 'raw-combined.json');
  try {
    const localPath = ['', 'Users', 'fixture', 'secrets'].join('/');
    const privateEmail = ['person', 'example.invalid'].join('@');
    const credential = ['pm', '_live_', 'fixture'].join('');
    writeFileSync(l3InputPath, JSON.stringify(rawSourceReport([{
      ...finding('L3-M17', 'CONTESTED'),
      title: `Fixture ${privateEmail} ${credential}`,
      where: localPath,
    }]), null, 2) + '\n');
    writeFileSync(combinedInputPath, JSON.stringify(rawSourceReport([finding('L1-M1', 'CONFIRMED')]), null, 2) + '\n');

    const result = importReports(fixtureRoot, l3InputPath, combinedInputPath);
    assert.equal(result.status, 0, `import failed:\n${result.stdout}\n${result.stderr}`);

    const imported = readFileSync(join(
      fixtureRoot,
      'docs/audit/2026-09-04/findings/verified-L3.json',
    ), 'utf8');
    assert.match(imported, /\[redacted local path\]/);
    assert.match(imported, /\[redacted email\]/);
    assert.match(imported, /\[redacted credential\]/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('rejects traceability JSON with noncanonical bytes', () => {
  const fixtureRoot = writeFixtureRoot();
  try {
    buildFixture(fixtureRoot);
    writeFileSync(traceabilityPath(fixtureRoot), readFileSync(traceabilityPath(fixtureRoot), 'utf8') + ' ');

    const result = verifyFixture(fixtureRoot);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /does not match generated output/);
  } finally {
    rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('verifies the committed phase-three finding matrix', () => {
  const result = spawnSync(process.execPath, [verifyScript], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `verification failed:\n${result.stdout}\n${result.stderr}`);
});
