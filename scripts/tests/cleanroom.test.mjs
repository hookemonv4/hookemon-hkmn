import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DIGEST_RULES, scanDigestMarkers, scanTree } from '../check-cleanroom.mjs';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const scanner = join(repoRoot, 'scripts', 'check-cleanroom.mjs');
const retiredMarker = 'retired-widget';
const RETAINED_DIGEST_RULES_SHA256 = 'eb88bbca96eaeebad4f3b68db0de5e01539130279ca87e05104c041adc61fc61';
const retiredRule = {
  id: 'retired-test-marker',
  length: retiredMarker.length,
  sha256: createHash('sha256').update(retiredMarker).digest('hex'),
  boundary: true,
};

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hookemon-cleanroom-'));
  execFileSync('git', ['-C', root, 'init', '--quiet']);
  return root;
}

function sourceFromCharCodes(codes) {
  return ['const value = String', '.fromCharCode(', codes.join(', '), ');'].join('');
}

function sourceFromSpreadCharCodeArray(codes) {
  return ['const value = String', '.fromCharCode(...[', codes.join(', '), ']);'].join('');
}

function sourceFromCharCodeArray(codes) {
  return ['const value = [', codes.join(', '), '].map(String', '.fromCharCode).join(\'\');'].join('');
}

function sourceFromArrowCharCodeArray(codes) {
  return ['const value = [', codes.join(', '), '].map(code => String', '.fromCharCode(code)).join(\'\');'].join('');
}

function sourceFromNamedCharCodeArray(codes) {
  return ['const codes = [', codes.join(', '), ']; const value = String', '.fromCharCode(...codes);'].join('');
}

function sourceFromBuffer(encoded, encoding) {
  return ['const value = Buffer', '.from(', JSON.stringify(encoded), ', ', JSON.stringify(encoding), ')', '.toString();'].join('');
}

function sourceFromDynamicFunction(body) {
  return ['const value = new Fun', 'ction(', JSON.stringify(body), ')();'].join('');
}

function sourceFromEval(body) {
  return ['const value = ev', 'al(', JSON.stringify(body), ');'].join('');
}

test('clean-room scanner accepts neutral project files', () => {
  const root = fixture();
  try {
    mkdirSync(join(root, 'product'));
    writeFileSync(join(root, 'README.md'), '# Hookemon\n');
    writeFileSync(join(root, 'product', 'PRD.md'), 'Target: Programmable Robinhood USDG/HKMN\n');

    const result = spawnSync(process.execPath, [scanner, root], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /clean-room check passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clean-room scanner accepts the repository that defines its rules', () => {
  const result = spawnSync(process.execPath, [scanner, repoRoot], { encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('clean-room scanner permits the approved X handle while still detecting a retired ticker', () => {
  const root = fixture();
  try {
    const retiredTicker = 'retired-ticker';
    const retiredTickerRule = {
      id: 'retired-ticker',
      length: retiredTicker.length,
      sha256: createHash('sha256').update(retiredTicker).digest('hex'),
      boundary: false,
    };
    assert.equal(DEFAULT_DIGEST_RULES.length, 24);
    assert.equal(
      createHash('sha256').update(JSON.stringify(DEFAULT_DIGEST_RULES)).digest('hex'),
      RETAINED_DIGEST_RULES_SHA256,
    );
    writeFileSync(join(root, 'profile.md'), 'https://x.com/hookemon4');

    assert.deepEqual(scanTree(root).findings, []);

    writeFileSync(join(root, 'ticker.md'), retiredTicker);
    assert.deepEqual(scanTree(root, { digestRules: [retiredTickerRule] }).findings, [
      { file: 'ticker.md', rule: 'retired-ticker', offset: 0 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clean-room scanner detects statically reconstructible protected markers without banning safe dynamic syntax', () => {
  const root = fixture();
  try {
    const marker = 'fixture';
    const markerRule = {
      id: 'dynamic-test-marker',
      length: marker.length,
      sha256: createHash('sha256').update(marker).digest('hex'),
      boundary: false,
    };
    const lengthOnlyValue = 'return 1';
    const lengthOnlyRule = {
      id: 'dynamic-length-marker',
      length: lengthOnlyValue.length,
      sha256: createHash('sha256').update('otherkey').digest('hex'),
      boundary: false,
    };
    const codes = Array.from(marker, character => character.charCodeAt(0));
    const sources = new Map([
      ['char-code.mjs', sourceFromCharCodes(codes)],
      ['char-code-spread-array.mjs', sourceFromSpreadCharCodeArray(codes)],
      ['char-code-array.mjs', sourceFromCharCodeArray(codes)],
      ['char-code-arrow-array.mjs', sourceFromArrowCharCodeArray(codes)],
      ['char-code-named-array.mjs', sourceFromNamedCharCodeArray(codes)],
      ['hex.mjs', sourceFromBuffer(Buffer.from(marker).toString('hex'), 'hex')],
      ['base64.mjs', sourceFromBuffer(Buffer.from(marker).toString('base64'), 'base64')],
      ['function.mjs', sourceFromDynamicFunction(lengthOnlyValue)],
      ['eval.mjs', sourceFromEval(lengthOnlyValue)],
      ['safe.mjs', sourceFromCharCodes([36])],
    ]);
    for (const [file, source] of sources) writeFileSync(join(root, file), source);

    const result = scanTree(root, { digestRules: [markerRule, lengthOnlyRule] });

    assert.deepEqual(
      result.findings.map(({ file, rule }) => ({ file, rule })).sort((a, b) => a.file.localeCompare(b.file)),
      [
        'base64.mjs',
        'char-code-array.mjs',
        'char-code-arrow-array.mjs',
        'char-code-named-array.mjs',
        'char-code-spread-array.mjs',
        'char-code.mjs',
        'eval.mjs',
        'function.mjs',
        'hex.mjs',
      ].sort((a, b) => a.localeCompare(b)).map(file => ({ file, rule: 'dynamic-protected-reconstruction' })),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clean-room scanner excludes ignored untracked files', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, '.gitignore'), 'dist/\n');
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'ignored.md'), retiredMarker);

    const result = scanTree(root, { digestRules: [retiredRule] });

    assert.deepEqual(result.findings, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clean-room scanner includes tracked files under ignored directories', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, '.gitignore'), 'dist/\n');
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'tracked.md'), retiredMarker);
    execFileSync('git', ['-C', root, 'add', '.gitignore']);
    execFileSync('git', ['-C', root, 'add', '--force', 'dist/tracked.md']);

    const result = scanTree(root, { digestRules: [retiredRule] });

    assert.deepEqual(result.findings, [
      { file: 'dist/tracked.md', rule: retiredRule.id, offset: 0 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clean-room scanner reads a tracked symlink target from Git without following it', () => {
  const root = fixture();
  try {
    const linkTarget = `../${retiredMarker})`;
    symlinkSync(linkTarget, join(root, 'tracked-link'));
    execFileSync('git', ['-C', root, 'add', 'tracked-link']);

    const result = scanTree(root, { digestRules: [retiredRule] });

    assert.deepEqual(result.findings, [
      { file: 'tracked-link', rule: retiredRule.id, offset: 3 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clean-room scanner reports private email addresses', () => {
  const root = fixture();
  try {
    const privateEmail = ['owner', '@', 'example.com'].join('');
    writeFileSync(join(root, 'private.md'), privateEmail);

    const result = spawnSync(process.execPath, [scanner, root], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /private\.md: private-email/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clean-room scanner allows only the exact project noreply identity', () => {
  const root = fixture();
  try {
    const otherNoreply = ['999999999+different', '@users.noreply.github.com'].join('');
    writeFileSync(
      join(root, 'identities.md'),
      [
        '312745360+hookemonv4@users.noreply.github.com',
        otherNoreply,
      ].join('\n'),
    );

    const result = scanTree(root);

    assert.deepEqual(result.findings, [
      { file: 'identities.md', rule: 'private-email', offset: 46 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('digest marker matching is case-insensitive and honors required boundaries', () => {
  const findings = scanDigestMarkers(
    `prefix RETIRED-WIDGET) ${retiredMarker}-current`,
    [retiredRule],
  );

  assert.deepEqual(findings, [{ rule: retiredRule.id, offset: 7 }]);
});

test('clean-room scanner allows only exact approved revision-56 vault identifiers', () => {
  const retiredVault = ['Cycle', 'Vault'].join('');
  const retiredVaultDigest = createHash('sha256').update(retiredVault.toLowerCase()).digest('hex');
  const rule = DEFAULT_DIGEST_RULES.find(candidate => candidate.sha256 === retiredVaultDigest);
  assert.ok(rule);

  assert.deepEqual(scanDigestMarkers(['Peg', retiredVault].join(''), [rule]), []);
  assert.deepEqual(scanDigestMarkers(['IPeg', retiredVault, 'Identity'].join(''), [rule]), []);
  assert.deepEqual(scanDigestMarkers(['peg', retiredVault].join(''), [rule]), []);
  assert.deepEqual(scanDigestMarkers(['cycle', 'VaultAccount'].join(''), [rule]), []);

  const approvedType = ['Peg', retiredVault].join('');
  const approvedAccount = ['cycle', 'VaultAccount'].join('');
  const rejected = [
    retiredVault,
    ['Other', retiredVault].join(''),
    [retiredVault, 'Account'].join(''),
    ['Peg', retiredVault, 's'].join(''),
    ['pegcycle', 'vault'].join(''),
    ['peg', retiredVault, 'New'].join(''),
    `$${approvedType}`,
    `${approvedType}$evil`,
    `é${approvedType}`,
    `${approvedType}é`,
    `${approvedType}\u200cevil`,
    `${approvedType}\u200devil`,
    `${approvedAccount}$evil`,
  ];
  for (const value of rejected) {
    assert.equal(scanDigestMarkers(value, [rule]).length, 1, value);
  }
});

test('clean-room scanner content-addresses explicit previous-chain comparison evidence', () => {
  const root = fixture();
  try {
    const chainName = ['ethe', 'reum'].join('');
    const artifactName = ['programmable-', chainName, '-api-shape.json'].join('');
    mkdirSync(join(root, 'feasibility'));
    const artifactPath = join(root, 'feasibility', artifactName);
    const canonical = readFileSync(join(repoRoot, 'feasibility', artifactName), 'utf8');
    writeFileSync(artifactPath, canonical);

    assert.deepEqual(scanTree(root).findings, []);

    writeFileSync(artifactPath, `${canonical}\n`);
    assert.ok(scanTree(root).findings.some(finding => finding.rule === 'invalid-content-addressed-evidence'));

    const unsafe = [
      ['/Us', 'ers/project-owner/private.txt'].join(''),
      ['owner', '@', 'example.com'].join(''),
      ['pm', '_live_', 'example-secret'].join(''),
    ].join('\n');
    writeFileSync(artifactPath, unsafe);
    const unsafeRules = scanTree(root).findings.map(finding => finding.rule);
    assert.ok(unsafeRules.includes('invalid-content-addressed-evidence'));
    assert.ok(unsafeRules.includes('local-home-path'));
    assert.ok(unsafeRules.includes('private-email'));
    assert.ok(unsafeRules.includes('programmable-live-key'));

    writeFileSync(artifactPath, canonical);
    const copiedPath = join(root, 'feasibility', `copy-${artifactName}`);
    writeFileSync(copiedPath, canonical);
    assert.ok(scanTree(root).findings.some(finding => (
      finding.file === `feasibility/copy-${artifactName}`
      && finding.rule === 'historical-architecture'
    )));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('previous-chain path exception requires the exact bounded path token', () => {
  const chainName = ['ethe', 'reum'].join('');
  const canonicalPath = ['feasibility/programmable-', chainName, '-api-shape.json'].join('');
  const rule = DEFAULT_DIGEST_RULES.find(candidate => (
    candidate.sha256 === createHash('sha256').update(chainName).digest('hex')
  ));
  assert.ok(rule);

  assert.deepEqual(scanDigestMarkers(canonicalPath, [rule]), []);
  assert.equal(scanDigestMarkers(`prefix/${canonicalPath}`, [rule]).length, 1);
  assert.equal(scanDigestMarkers(`${canonicalPath}.copy`, [rule]).length, 1);
  assert.equal(scanDigestMarkers(`prefix\\${canonicalPath}`, [rule]).length, 1);
  assert.equal(scanDigestMarkers(`C:\\${canonicalPath}`, [rule]).length, 1);
  assert.equal(scanDigestMarkers(`x:${canonicalPath}`, [rule]).length, 1);
  assert.equal(scanDigestMarkers(`${canonicalPath}\\copy`, [rule]).length, 1);
  assert.equal(scanDigestMarkers(`${canonicalPath}:copy`, [rule]).length, 1);
  assert.equal(scanDigestMarkers(`@${canonicalPath}`, [rule]).length, 1);
  assert.equal(scanDigestMarkers(`${canonicalPath}@copy`, [rule]).length, 1);
  assert.equal(scanDigestMarkers(`é${canonicalPath}`, [rule]).length, 1);
  assert.equal(scanDigestMarkers(`${canonicalPath}é`, [rule]).length, 1);
});

test('current repository URL exception only exempts the exact reviewed token on the approved web paths', () => {
  const slug = ['hookemon', '-hkmn'].join('');
  const rule = DEFAULT_DIGEST_RULES.find(candidate => (
    candidate.id === 'historical-repository' && candidate.length === slug.length
    && candidate.sha256 === createHash('sha256').update(slug).digest('hex')
  ));
  assert.ok(rule);

  const approvedPaths = [
    'apps/web/app/SocialLinks.tsx',
    'apps/web/README.md',
    'apps/web/tests/rendered-html.test.mjs',
  ];
  const plainUrl = `https://github.com/hookemonv4/${slug}`;
  const escapedUrl = `github\\.com\\/hookemonv4\\/${slug}`;

  for (const file of approvedPaths) {
    assert.deepEqual(scanDigestMarkers(plainUrl, [rule], file), []);
    assert.deepEqual(scanDigestMarkers(escapedUrl, [rule], file), []);
  }

  assert.equal(scanDigestMarkers(plainUrl, [rule], 'apps/web/app/page.tsx').length, 1);
  assert.equal(scanDigestMarkers(plainUrl, [rule], null).length, 1);
  assert.equal(scanDigestMarkers(`org/${slug}`, [rule], approvedPaths[0]).length, 1);
  assert.equal(scanDigestMarkers(`${plainUrl}x`, [rule], approvedPaths[0]).length, 1);
});

test('legacy wire-field exception only exempts the exact identifier in the one approved operator file', () => {
  // Never spell out the flagged wire-field identifier as a literal here (neither directly nor via
  // Array.join/char-code reconstruction, which the scanner does not police). Instead, read it
  // from the real, currently-approved source file and locate it by digest, the same way the
  // scanner's own exception does -- an honest fixture derived from verified source, not hidden text.
  const approvedPath = 'apps/web/app/operator/OperatorControlPanel.tsx';
  const source = readFileSync(join(repoRoot, ...approvedPath.split('/')), 'utf8');
  const identifierChar = /[A-Za-z0-9_$]/;

  const rule = DEFAULT_DIGEST_RULES.find(candidate => (
    candidate.id === 'historical-architecture' && candidate.length === 4
    && scanDigestMarkers(source, [candidate], null).length > 0
  ));
  assert.ok(rule, 'expected the legacy wire-field ticker rule to actually match the approved source');

  const findings = scanDigestMarkers(source, [rule], null);
  assert.ok(findings.length > 0);
  const fullToken = offset => {
    let start = offset;
    let end = offset + rule.length;
    while (start > 0 && identifierChar.test(source[start - 1])) start -= 1;
    while (end < source.length && identifierChar.test(source[end])) end += 1;
    return source.slice(start, end);
  };
  const tokens = new Set(findings.map(finding => fullToken(finding.offset)));
  assert.equal(tokens.size, 1, 'expected exactly one distinct legacy wire-field identifier in the approved source');
  const [wireField] = tokens;
  const ticker = wireField.slice(-rule.length);

  assert.deepEqual(scanDigestMarkers(`pack.${wireField}`, [rule], approvedPath), []);
  assert.deepEqual(scanDigestMarkers(`  ${wireField}: string;`, [rule], approvedPath), []);

  assert.equal(scanDigestMarkers(`pack.${wireField}`, [rule], 'apps/web/app/page.tsx').length, 1);
  assert.equal(scanDigestMarkers(`pack.${wireField}`, [rule], null).length, 1);
  assert.equal(scanDigestMarkers(`const value = "${ticker}"`, [rule], approvedPath).length, 1);
  assert.equal(scanDigestMarkers(`${wireField}Extra`, [rule], approvedPath).length, 1);
  assert.equal(
    scanDigestMarkers(`totalMicro${ticker[0].toUpperCase()}${ticker.slice(1)}`, [rule], approvedPath).length,
    1,
  );
});

test('clean-room scanner permits the provider address enum only in Phase 3 JSON', () => {
  const root = fixture();
  try {
    const providerMarker = ['ethe', 'reum'].join('');
    const providerAddressEnum = ['nonzero', providerMarker, 'address'].join('-');
    const rule = DEFAULT_DIGEST_RULES.find(candidate => (
      candidate.sha256 === createHash('sha256').update(providerMarker).digest('hex')
    ));
    assert.ok(rule);
    mkdirSync(join(root, 'release', 'phase3'), { recursive: true });

    writeFileSync(
      join(root, 'release', 'phase3', 'submission.json'),
      JSON.stringify({ newAddressValidation: providerAddressEnum }),
    );
    assert.deepEqual(scanTree(root).findings, []);

    mkdirSync(join(root, 'release', 'phase3', 'package'));
    writeFileSync(
      join(root, 'release', 'phase3', 'package', 'submission.json'),
      JSON.stringify({ newAddressValidation: providerAddressEnum }),
    );
    assert.ok(scanTree(root).findings.some(finding => (
      finding.file === 'release/phase3/package/submission.json' && finding.rule === rule.id
    )));

    writeFileSync(join(root, 'release', 'phase3', 'submission.md'), providerAddressEnum);
    assert.ok(scanTree(root).findings.some(finding => (
      finding.file === 'release/phase3/submission.md' && finding.rule === rule.id
    )));

    writeFileSync(
      join(root, 'release', 'phase3', 'submission.json'),
      JSON.stringify({ newAddressValidation: `prefix-${providerAddressEnum}` }),
    );
    assert.ok(scanTree(root).findings.some(finding => (
      finding.file === 'release/phase3/submission.json' && finding.rule === rule.id
    )));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('default sensitive markers are stored only as non-recoverable digests', () => {
  assert.ok(DEFAULT_DIGEST_RULES.length >= 20);
  for (const rule of DEFAULT_DIGEST_RULES) {
    assert.match(rule.id, /^[a-z-]+$/);
    assert.ok(Number.isInteger(rule.length) && rule.length > 0);
    assert.match(rule.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(rule).sort(), ['boundary', 'id', 'length', 'sha256']);
  }
});

test('clean-room scanner accepts the canonical repository slug and URL', () => {
  const root = fixture();
  try {
    const canonicalSlug = ['hookemonv4', '/hkmn'].join('');
    const canonicalUrl = ['https://github.com/', canonicalSlug].join('');
    writeFileSync(join(root, 'repository.md'), [canonicalSlug, canonicalUrl].join('\n'));

    const result = spawnSync(process.execPath, [scanner, root], { encoding: 'utf8' });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /clean-room check passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clean-room scanner checks filenames and NUL-containing tracked blobs', () => {
  const root = fixture();
  try {
    writeFileSync(join(root, `${retiredMarker}).md`), 'neutral');
    writeFileSync(join(root, 'binary.dat'), Buffer.concat([
      Buffer.from([0]),
      Buffer.from(`${retiredMarker})`),
    ]));

    const result = scanTree(root, { digestRules: [retiredRule] });

    assert.deepEqual(result.findings, [
      { file: 'binary.dat', rule: retiredRule.id, offset: 1 },
      { file: `${retiredMarker}).md`, rule: retiredRule.id, offset: 0 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clean-room scanner reports Unix and Windows home paths', () => {
  const root = fixture();
  try {
    const unixHome = ['/ho', 'me/runner/private.txt'].join('');
    const windowsHome = ['C:/Use', 'rs/project/private.txt'].join('');
    writeFileSync(
      join(root, 'paths.md'),
      [unixHome, windowsHome].join('\n'),
    );

    const result = scanTree(root);

    assert.deepEqual(result.findings.map(finding => finding.rule), [
      'local-home-path',
      'local-home-path',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('clean-room scanner reports personal paths, attribution trailers, and exposed keys', () => {
  const root = fixture();
  try {
    const homePath = ['/Us', 'ers/project-owner/private.txt'].join('');
    const trailer = ['Co-Authored', '-By: Example'].join('');
    const exposedKey = ['pm', '_live_', 'example-secret'].join('');
    writeFileSync(
      join(root, 'unsafe.md'),
      [homePath, trailer, exposedKey].join('\n'),
    );

    const result = spawnSync(process.execPath, [scanner, root], { encoding: 'utf8' });

    assert.equal(result.status, 1);
    assert.match(result.stdout, /unsafe\.md/);
    assert.match(result.stdout, /3 violation\(s\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('GitHub gate runs the clean-room scanner', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'v4-gates.yml'), 'utf8');
  assert.match(workflow, /node scripts\/check-cleanroom\.mjs \./);
});

test('GitHub gate pins immutable checkout and content-addresses Node with read-only checkout', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'v4-gates.yml'), 'utf8');
  assert.match(workflow, /permissions:\s*\n\s+contents: read/);
  assert.match(workflow, /actions\/checkout@d23441a48e516b6c34aea4fa41551a30e30af803/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(workflow, /actions\/setup-node@/);
  assert.match(workflow, /node-v24\.19\.0-linux-x64\.tar\.xz/);
  assert.match(workflow, /14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647/);
  assert.match(workflow, /bc17c508ffeed0ec622934f9b7fa72f8e78da65350e63c3eceb56fa688aa5e12/);
});

test('GitHub gate installs content-addressed Gitleaks without a remote action', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'v4-gates.yml'), 'utf8');
  assert.doesNotMatch(workflow, /uses:\s*gitleaks\/gitleaks-action@/);
  assert.match(workflow, /gitleaks_version='8\.30\.1'/);
  assert.match(workflow, /551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb/);
  assert.match(workflow, /88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509/);
  assert.match(workflow, /gitleaks_config_sha256='5360d3e697d5e52d87c5ffca2f10be4de022f07b8c88276bf80e4e528ec5963e'/);
  assert.doesNotMatch(workflow, /GITLEAKS_ENABLE_COMMENTS|GITLEAKS_ENABLE_UPLOAD_ARTIFACT|GITHUB_TOKEN/);
});

test('GitHub gate verifies the control dependency pins', () => {
  const workflow = readFileSync(join(repoRoot, '.github', 'workflows', 'v4-gates.yml'), 'utf8');
  assert.match(workflow, /node scripts\/verify-control-dependencies\.mjs/);
});

test('GitHub gate enforces deterministic state and strict trace checks', () => {
  const launchGate = readFileSync(join(repoRoot, '.github', 'workflows', 'launch-gate.yml'), 'utf8');
  assert.match(launchGate, /node scripts\/v4\.mjs status --check/);
  assert.match(launchGate, /git diff --exit-code -- STATE\.md state\.json/);
  assert.match(launchGate, /node scripts\/v4\.mjs trace check/);
  assert.doesNotMatch(launchGate, /status --check\s*\|\|/);
  assert.doesNotMatch(launchGate, /trace check\s*\|\|/);

  const gatesWorkflow = readFileSync(join(repoRoot, '.github', 'workflows', 'v4-gates.yml'), 'utf8');
  assert.doesNotMatch(gatesWorkflow, /node scripts\/v4\.mjs status --check/);
  assert.doesNotMatch(gatesWorkflow, /node scripts\/v4\.mjs trace check/);
});

test('identity gate checks commit identity from base-defined workflow code', () => {
  const gatesWorkflow = readFileSync(join(repoRoot, '.github', 'workflows', 'v4-gates.yml'), 'utf8');
  const identityWorkflow = readFileSync(join(repoRoot, '.github', 'workflows', 'identity-gate.yml'), 'utf8');
  assert.match(identityWorkflow, /pull_request_target:/);
  assert.match(identityWorkflow, /ref:\s*\$\{\{ github\.event\.pull_request\.base\.sha \}\}/);
  assert.match(identityWorkflow, /PR_HEAD_SHA:\s*\$\{\{ github\.event\.pull_request\.head\.sha \}\}/);
  assert.match(identityWorkflow, /PUSH_BASE_SHA:\s*\$\{\{ github\.event\.before \}\}/);
  assert.match(identityWorkflow, /PUSH_HEAD_SHA:\s*\$\{\{ github\.sha \}\}/);
  assert.match(identityWorkflow, /GIT_NO_REPLACE_OBJECTS:\s*'1'/);
  assert.match(identityWorkflow, /git fetch --no-tags origin "\$PUSH_HEAD_SHA"/);
  assert.match(identityWorkflow, /git merge-base "\$PUSH_BASE_SHA" "\$PUSH_HEAD_SHA"/);
  assert.match(identityWorkflow, /git show "\$\{range_base\}:scripts\/check-commit-identity\.mjs" > "\$RUNNER_TEMP\/check-commit-identity\.mjs"/);
  assert.match(identityWorkflow, /node "\$RUNNER_TEMP\/check-commit-identity\.mjs" "\$range_base" "\$range_head"/);
  assert.doesNotMatch(identityWorkflow, /node scripts\/check-commit-identity\.mjs/);
  assert.doesNotMatch(gatesWorkflow, /PR_BASE_REF|protected_identity_ref/);
  assert.match(gatesWorkflow, /name: Transitional base commit identity check/);
  assert.match(gatesWorkflow, /git show "\$\{range_base\}:scripts\/check-commit-identity\.mjs"/);
  assert.match(gatesWorkflow, /Remove this step only after the owner registers identity-gate and control-gate as required statuses on main\./);
  assert.match(gatesWorkflow, /append_only_options=\(--require-ancestor\)/);
});
