import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const repoRoot = join(import.meta.dirname, '..', '..');
const runbooksRoot = join(repoRoot, 'docs', 'runbooks');
const failureMatrix = JSON.parse(readFileSync(join(repoRoot, 'docs', 'audit', '2026-09-04', 'failure-matrix.json'), 'utf8'));
const alarmSources = [
  'packages/runner/src/observability/canaries.mjs',
  'packages/runner/src/observability/alert-webhook.mjs',
].map(path => readFileSync(join(repoRoot, path), 'utf8')).join('\n');
const requiredSections = [
  'Detection',
  'Safe stop',
  'Runner behavior',
  'Operator recovery',
  'Escalation',
  'Evidence',
];

function readRunbook(file) {
  const path = join(runbooksRoot, file);
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function indexedRunbooks() {
  const readme = readRunbook('README.md');
  return [...readme.matchAll(/\]\(([^)]+\.md)\)/g)].map(([, file]) => file);
}

function readEvidenceField(content, field, file) {
  const contract = content.match(/^## Recovery contract\n([\s\S]*)$/m)?.[1];
  assert.ok(contract, `${file} must provide a Recovery contract section`);
  const match = contract.match(new RegExp(`^${field}: (.+)$`, 'm'));
  assert.ok(match, `${file} must provide ${field}`);
  return match[1];
}

function matrixCellKey(cell) {
  return `${cell.system}:${cell.failureClass}`;
}

function parseMappedCells(value) {
  if (value === 'none (not in frozen matrix)') return [];
  return value.split('; ').map(cell => cell.replaceAll('`', ''));
}

test('incident index links every required runbook', () => {
  const readme = readRunbook('README.md');
  assert.ok(readme, 'docs/runbooks/README.md must exist');

  const runbooks = indexedRunbooks();
  assert.ok(runbooks.length > 0, 'README must link at least one incident runbook');
  assert.equal(new Set(runbooks).size, runbooks.length, 'README must not link an incident runbook twice');
  assert.deepEqual(
    runbooks.slice().sort(),
    readdirSync(runbooksRoot).filter(file => file.endsWith('.md') && ![
      'README.md', 'operations-wallets.md', 'rehearsal-and-recovery.md',
    ].includes(file)).sort(),
    'README must index every incident runbook and no non-existent file',
  );
});

test('incident runbooks map every frozen failure-matrix cell exactly once', () => {
  const mappedCells = new Map();
  for (const file of indexedRunbooks()) {
    const content = readRunbook(file);
    for (const cell of parseMappedCells(readEvidenceField(content, 'Failure-matrix cells', file))) {
      assert.ok(failureMatrix.cells.some(candidate => matrixCellKey(candidate) === cell), `${file} maps unknown failure-matrix cell ${cell}`);
      assert.ok(!mappedCells.has(cell), `${cell} is mapped by both ${mappedCells.get(cell)} and ${file}`);
      mappedCells.set(cell, file);
    }
  }
  assert.deepEqual(
    [...mappedCells.keys()].sort(),
    failureMatrix.cells.map(matrixCellKey).sort(),
    'every frozen failure-matrix cell must map to exactly one runbook',
  );
});

test('observability card links the canary recovery runbooks', () => {
  const card = readFileSync(join(repoRoot, 'docs', 'modules', 'observability.md'), 'utf8');
  for (const file of [
    'usdg-paused.md',
    'usdg-frozen.md',
    'pool-protocol-fee.md',
    'solana-blockhash-expiry.md',
    'evm-nonce-interference.md',
    'unattributed-deposit.md',
  ]) {
    assert.ok(card.includes(`](../runbooks/${file})`), `observability card must link ${file}`);
  }
});

test('money-path module cards link their incident-specific recovery contracts', () => {
  const expectedLinks = {
    'relay-bridge-client.md': [
      'relay-delay.md',
      'relay-partial.md',
      'relay-refund.md',
      'relay-wrong-asset.md',
      'relay-late.md',
      'relay-wrong-asset-finalized.md',
      'relay-quote-expired.md',
    ],
    'collector-crypt-adapter.md': [
      'collector-timeout.md',
      'collector-already-opened.md',
      'collector-blocked.md',
      'collector-schema-drift.md',
    ],
    'signing.md': [
      'keychain-user-interaction.md',
      'solana-blockhash-expiry.md',
      'evm-transaction-ambiguity.md',
      'evm-nonce-interference.md',
    ],
    'transaction-policy.md': [
      'transaction-policy-wrong-recipient.md',
      'relay-wrong-asset.md',
      'solana-blockhash-expiry.md',
      'keychain-user-interaction.md',
      'evm-transaction-ambiguity.md',
      'evm-nonce-interference.md',
    ],
    'robinhood-rpc-client.md': [
      'robinhood-rpc-reorg.md',
      'robinhood-rpc-incomplete-logs.md',
      'robinhood-rpc-latest-only.md',
    ],
    'holder-snapshot-indexer.md': [
      'robinhood-rpc-reorg.md',
      'robinhood-rpc-incomplete-logs.md',
      'payout-holder-envelope.md',
    ],
    'cycle-repository.md': [
      'repository-state-directory-loss.md',
      'provider-call-journal-crash.md',
      'provider-pre-call-failure.md',
      'lease-expiry-mid-mutation.md',
      'unattributed-deposit.md',
    ],
    'policy-engine.md': [
      'relay-wrong-asset.md',
      'transaction-policy-wrong-recipient.md',
      'epic-card-held.md',
      'epic-threshold-equality.md',
      'unattributed-deposit.md',
    ],
    'direct-payout.md': [
      'payout-recipient-frozen.md',
      'payout-holder-envelope.md',
      'evm-nonce-interference.md',
      'evm-transaction-ambiguity.md',
    ],
  };

  for (const [cardFile, runbooks] of Object.entries(expectedLinks)) {
    const card = readFileSync(join(repoRoot, 'docs', 'modules', cardFile), 'utf8');
    for (const runbook of runbooks) {
      assert.ok(card.includes(`](../runbooks/${runbook})`), `${cardFile} must link ${runbook}`);
    }
  }
});

test('signing recovery uses an implemented sign-only probe', () => {
  const card = readFileSync(join(repoRoot, 'docs', 'modules', 'signing.md'), 'utf8');
  const runbook = readRunbook('keychain-user-interaction.md');
  assert.match(card, /Frozen but unimplemented interface names are `requestExternalSignature`,\s+`checkSignOnlyReadiness`, and `verifyReturnedSignature`\./);
  assert.doesNotMatch(runbook, /checkSignOnlyReadiness/);
  assert.match(runbook, /`node packages\/adapters\/bin\/hookemon-wallet\.mjs probe --identity operations-(?:evm|solana)`/);
});

test('runtime module cards distinguish chain-attempt v1 from the frozen v2 contract', () => {
  for (const cardFile of [
    'adapters.md',
    'automation.md',
    'composition-root.md',
    'cycle-repository.md',
    'cycle-runner.md',
    'relay-bridge-client.md',
    'signing.md',
    'transaction-policy.md',
  ]) {
    const card = readFileSync(join(repoRoot, 'docs', 'modules', cardFile), 'utf8');
    assert.match(
      card,
      /chain-attempt runtime\s+is v1;[\s\S]{0,180}approval-digest fields\s+are unavailable\./,
      `${cardFile} must distinguish current chain attempts from the frozen v2 contract`,
    );
  }
});

for (const file of indexedRunbooks()) {
  test(`${file} supplies the required operator recovery fields`, () => {
    const content = readRunbook(file);
    assert.ok(content, `${file} must exist`);
    assert.ok(content.split('\n').length <= 80, `${file} must stay within 80 lines`);

    for (const section of requiredSections) {
      assert.match(content, new RegExp(`^## ${section}$`, 'm'), `${file} must include ${section}`);
    }
    assert.doesNotMatch(content, /hookemon-runner status/, `${file} must not overstate status inspection evidence`);
    const mappedCells = parseMappedCells(readEvidenceField(content, 'Failure-matrix cells', file));
    const owner = readEvidenceField(content, 'Owning work package', file);
    const outcome = readEvidenceField(content, 'Expected outcome', file);
    const testCitation = readEvidenceField(content, 'Test', file);
    const alarm = readEvidenceField(content, 'Alarm reason/code', file);
    const resume = readEvidenceField(content, 'Resume command', file);

    assert.match(resume, /`[^`]+`|none supported|OPEN FACT/, `${file} must state the supported resume command or its absence`);
    assert.match(alarm, /`[A-Z][A-Z0-9_]+`|OPEN FACT/, `${file} must cite a real alarm code or an OPEN FACT`);
    if (!alarm.startsWith('OPEN FACT')) {
      const code = alarm.match(/`([A-Z][A-Z0-9_]+)`/)?.[1];
      assert.ok(code, `${file} must format its alarm code`);
      assert.match(alarmSources, new RegExp(`['\"]${code}['\"]`), `${file} cites unknown alarm code ${code}`);
    }
    assert.match(testCitation, /(?:^OPEN FACT \(WP\d+(?:[a-z]|-\d+)?\):|^.+\.test\.mjs — .+$)/, `${file} must cite a concrete test or its owning OPEN FACT`);
    if (!testCitation.startsWith('OPEN FACT')) {
      const [testPath, testName] = testCitation.split(' — ');
      const path = join(repoRoot, testPath);
      assert.ok(existsSync(path), `${file} cites missing test file ${testPath}`);
      assert.match(readFileSync(path, 'utf8'), new RegExp(`test\\(['\"]${testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), `${file} cites missing test ${testName}`);
    }

    for (const key of mappedCells) {
      const cell = failureMatrix.cells.find(candidate => matrixCellKey(candidate) === key);
      assert.equal(owner, cell.owningWp, `${file} owner must match ${key}`);
      assert.equal(testCitation, cell.test, `${file} test must match ${key}`);
      assert.equal(
        outcome,
        `terminal=${cell.expectedTerminalState ?? 'none'}; attempt=${cell.expectedAttemptState ?? 'none'}; next=${cell.expectedNextStage ?? 'none'}`,
        `${file} outcome must match ${key}`,
      );
    }
  });
}
