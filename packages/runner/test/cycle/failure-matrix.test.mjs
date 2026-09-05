import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CHAIN_TRANSACTION_ATTEMPT_STATES,
  CYCLE_TERMINAL_STATES,
  PROVIDER_MUTATION_ATTEMPT_STATES,
} from '../../src/cycle/money-schemas.mjs';
import { listSuite } from '../../../../scripts/test-manifest.mjs';

const matrixUrl = new URL('../../../../docs/audit/2026-09-04/failure-matrix.json', import.meta.url);
const interfacesUrl = new URL('../../../../architecture/interfaces.json', import.meta.url);

const REQUIRED_CELLS = [
  ['Provider mutation', 'pre-call-failure'],
  ['Collector API', 'committed-then-503'],
  ['Relay', 'lost-response'],
  ['Relay leg', 'partial-finalized-delta'],
  ['Relay leg', 'refund-finalized-delta'],
  ['Relay leg', 'late-finalized-delta'],
  ['Relay leg', 'wrong-asset-finalized-delta'],
  ['Transaction policy', 'wrong-asset'],
  ['Transaction policy', 'wrong-recipient'],
  ['Relay quote', 'expired-quote'],
  ['Chain transaction', 'expired-blockhash'],
  ['EVM transaction', 'dropped'],
  ['EVM transaction', 'replaced'],
  ['Wallet lease', 'lost-lease'],
  ['Repository recovery', 'state-directory-loss'],
  ['Open result', 'missing-mint-response-recorded'],
  ['Open result', 'missing-mint-sent-unknown-retry'],
  ['Epic gate', 'threshold-equality'],
  ['Buyback API', 'unavailable'],
  ['Snapshot', 'incomplete-logs'],
  ['Snapshot', 'reorg'],
  ['Payout', 'frozen-recipient'],
  ['EVM nonce', 'interference'],
  ['Payout feasibility', 'holder-count-above-envelope'],
  ['USDG canary', 'paused'],
  ['USDG canary', 'frozen'],
  ['External signer', 'keychain-interaction'],
  ['Standing authority', 'replay-after-expiry'],
];

const outcome = (expectedTerminalState, expectedNextStage, owningWp, expectedAttemptState = null) => ({
  expectedTerminalState,
  expectedAttemptState,
  expectedNextStage,
  owningWp,
});

const EXPECTED_OUTCOMES = new Map([
  ['Provider mutation:pre-call-failure', outcome(null, 'retry', 'WP07-0', 'NOT_SENT')],
  ['Collector API:committed-then-503', outcome(null, 'reconcile', 'WP08b', 'SENT_UNKNOWN')],
  ['Relay:lost-response', outcome(null, 'reconcile', 'WP07', 'SENT_UNKNOWN')],
  ['Relay leg:partial-finalized-delta', outcome('HELD_RELAY_PARTIAL', 'owner-decision', 'WP07', 'FINALIZED')],
  ['Relay leg:refund-finalized-delta', outcome('HELD_RELAY_REFUND', 'owner-decision', 'WP07', 'FINALIZED')],
  ['Relay leg:late-finalized-delta', outcome('HELD_RELAY_LATE', 'owner-decision', 'WP07', 'FINALIZED')],
  ['Relay leg:wrong-asset-finalized-delta', outcome('HELD_RELAY_WRONG_ASSET', 'owner-decision', 'WP07', 'FINALIZED')],
  ['Transaction policy:wrong-asset', outcome('HELD_DATA_UNVERIFIED', 'owner-decision', 'WP08a', 'NOT_SENT')],
  ['Transaction policy:wrong-recipient', outcome('HELD_DATA_UNVERIFIED', 'owner-decision', 'WP08a', 'NOT_SENT')],
  ['Relay quote:expired-quote', outcome('HELD_UNAVAILABLE', 'owner-decision', 'WP07')],
  ['Chain transaction:expired-blockhash', outcome('HELD_UNAVAILABLE', 'owner-decision', 'WP08a', 'BROADCAST')],
  ['EVM transaction:dropped', outcome(null, 'reconcile-or-rebroadcast', 'WP08a', 'BROADCAST')],
  ['EVM transaction:replaced', outcome('HELD_OWNER_DECISION', 'owner-decision', 'WP08a', 'NONCE_INTERFERENCE')],
  ['Wallet lease:lost-lease', outcome('HELD_UNAVAILABLE', 'owner-decision', 'WP07', 'NOT_SENT')],
  ['Repository recovery:state-directory-loss', outcome('HELD_DATA_UNVERIFIED', 'owner-decision', 'WP10a')],
  ['Open result:missing-mint-response-recorded', outcome('HELD_DATA_UNVERIFIED', 'owner-decision', 'WP08b', 'RESPONSE_RECORDED')],
  ['Open result:missing-mint-sent-unknown-retry', outcome('HELD_DATA_UNVERIFIED', 'owner-decision', 'WP08b', 'SENT_UNKNOWN')],
  ['Epic gate:threshold-equality', outcome(null, 'buyback', 'WP08b')],
  ['Buyback API:unavailable', outcome('HELD_UNAVAILABLE', 'owner-decision', 'WP08b')],
  ['Snapshot:incomplete-logs', outcome('HELD_DATA_UNVERIFIED', 'owner-decision', 'WP09a')],
  ['Snapshot:reorg', outcome('HELD_DATA_UNVERIFIED', 'owner-decision', 'WP09a')],
  ['Payout:frozen-recipient', outcome('HELD_OWNER_DECISION', 'owner-decision', 'WP09b', 'REFUSED')],
  ['EVM nonce:interference', outcome('HELD_OWNER_DECISION', 'owner-decision', 'WP08a', 'NONCE_INTERFERENCE')],
  ['Payout feasibility:holder-count-above-envelope', outcome('HELD_UNAVAILABLE', 'owner-decision', 'WP09b')],
  ['USDG canary:paused', outcome('HELD_UNAVAILABLE', 'owner-decision', 'WP14')],
  ['USDG canary:frozen', outcome('HELD_UNAVAILABLE', 'owner-decision', 'WP14')],
  ['External signer:keychain-interaction', outcome('HELD_UNAVAILABLE', 'owner-decision', 'WP08a', 'NOT_SENT')],
  ['Standing authority:replay-after-expiry', outcome(null, 'reconcile', 'WP07', 'RESPONSE_RECORDED')],
]);

const RECOVERY_TUPLE_CITATIONS = new Map([
  ['Relay leg:partial-finalized-delta', {
    expectedTerminalState: 'HELD_RELAY_PARTIAL',
    expectedAttemptState: 'FINALIZED',
    expectedNextStage: 'owner-decision',
    test: 'packages/adapters/test/app/cycle-repository.test.mjs — settleRelayLeg holds a wrong-amount return receipt as HELD_RELAY_PARTIAL after reopen',
  }],
  ['Relay leg:refund-finalized-delta', {
    expectedTerminalState: 'HELD_RELAY_REFUND',
    expectedAttemptState: 'FINALIZED',
    expectedNextStage: 'owner-decision',
    test: 'packages/adapters/test/app/cycle-repository.test.mjs — settleRelayLeg holds a process-RPC origin refund credit after reopen without a second settlement',
  }],
  ['Relay leg:late-finalized-delta', {
    expectedTerminalState: 'HELD_RELAY_LATE',
    expectedAttemptState: 'FINALIZED',
    expectedNextStage: 'owner-decision',
    test: 'packages/adapters/test/app/cycle-repository.test.mjs — settleRelayLeg holds a late return receipt as HELD_RELAY_LATE after reopen',
  }],
  ['Relay leg:wrong-asset-finalized-delta', {
    expectedTerminalState: 'HELD_RELAY_WRONG_ASSET',
    expectedAttemptState: 'FINALIZED',
    expectedNextStage: 'owner-decision',
    test: 'packages/adapters/test/app/cycle-repository.test.mjs — settleRelayLeg holds a wrong-token or wrong-recipient return receipt as HELD_RELAY_WRONG_ASSET after reopen',
  }],
  ['Standing authority:replay-after-expiry', {
    expectedTerminalState: null,
    expectedAttemptState: 'RESPONSE_RECORDED',
    expectedNextStage: 'reconcile',
    test: 'packages/adapters/test/app/stage-driver.test.mjs — production signing replays a stored authority after expiry with one signer and a reopened reconciliation attempt',
  }],
]);

const PAYOUT_RECIPIENT_ATTEMPT_STATES = new Set(['REFUSED', 'NONCE_INTERFERENCE']);

test('failure matrix names every WP13 contract cell exactly once against the frozen cycle contract', async () => {
  const matrix = JSON.parse(await readFile(matrixUrl, 'utf8'));
  const interfaces = JSON.parse(await readFile(interfacesUrl, 'utf8'));
  const frozenProvider = interfaces.cycleExecution.providerAttempt;
  const frozenChain = interfaces.cycleExecution.chainAttempt;
  assert.equal(matrix.schema, 'hookemon.failure-matrix.v1');
  assert.ok(Array.isArray(matrix.cells));
  assert.equal(frozenProvider.schema, 'hookemon.provider-mutation-attempt.v2');
  assert.deepEqual(frozenProvider.states, ['PREPARED', 'NOT_SENT', 'SENT_UNKNOWN', 'RESPONSE_RECORDED', 'RECONCILED']);
  assert.ok(frozenProvider.transitions.includes('PREPARED -> NOT_SENT -> PREPARED'));
  assert.equal(PROVIDER_MUTATION_ATTEMPT_STATES.includes('NOT_SENT'), true, 'runtime must implement the frozen NOT_SENT provider contract');

  const keys = new Set();
  for (const cell of matrix.cells) {
    assert.deepEqual(Object.keys(cell).sort(), ['expectedAttemptState', 'expectedNextStage', 'expectedTerminalState', 'failureClass', 'owningWp', 'system', 'test']);
    const key = `${cell.system}:${cell.failureClass}`;
    assert.equal(keys.has(key), false, `duplicate failure-matrix cell ${key}`);
    keys.add(key);
    assert.ok(cell.expectedTerminalState === null || CYCLE_TERMINAL_STATES.includes(cell.expectedTerminalState));
    assert.ok(
      cell.expectedAttemptState === null
      || frozenProvider.states.includes(cell.expectedAttemptState)
      || frozenChain.states.includes(cell.expectedAttemptState)
      || CHAIN_TRANSACTION_ATTEMPT_STATES.includes(cell.expectedAttemptState)
      || PAYOUT_RECIPIENT_ATTEMPT_STATES.has(cell.expectedAttemptState),
    );
    assert.equal(typeof cell.owningWp, 'string');
    assert.deepEqual(
      {
        expectedTerminalState: cell.expectedTerminalState,
        expectedAttemptState: cell.expectedAttemptState,
        expectedNextStage: cell.expectedNextStage,
        owningWp: cell.owningWp,
      },
      EXPECTED_OUTCOMES.get(key),
      `unexpected failure-matrix outcome for ${key}`,
    );
  }
  assert.deepEqual([...keys].sort(), REQUIRED_CELLS.map(([system, failureClass]) => `${system}:${failureClass}`).sort());
});

// A cell's `test` field is an executable conformance binding. It must point to a test that is
// in the CI manifest and passes when run by its exact name. Source-text matching is deliberately
// insufficient: it cannot distinguish a comment, a skipped test, or an unregistered file from
// a conformance test that CI actually executes.
const repoRoot = new URL('../../../../', import.meta.url);
const repoRootPath = fileURLToPath(repoRoot);
const TEST_CITATION_PATTERN = /^packages\/(?:adapters|runner)\/test\/[A-Za-z0-9_./-]+\.test\.mjs — [^\r\n]+$/;
const OPEN_FACT_PATTERN = /^OPEN FACT \((WP\d+(?:[a-z]|-\d+)?)\): evidence=([A-Za-z0-9_./-]+:\d+); resolution=([^;]+); verified alternative=(.+)$/;

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseCitation(citation, key) {
  assert.match(citation, TEST_CITATION_PATTERN, `${key} must cite one exact adapter or runner test`);
  const separator = citation.indexOf(' — ');
  return {
    testPath: citation.slice(0, separator),
    testName: citation.slice(separator + 3),
  };
}

function executeCitedTest({ testPath, testName }) {
  const { NODE_TEST_CONTEXT: _nodeTestContext, ...environment } = process.env;
  const result = spawnSync(process.execPath, [
    '--test',
    '--test-reporter=tap',
    '--test-name-pattern',
    `^${escapePattern(testName)}$`,
    testPath,
  ], {
    cwd: repoRootPath,
    encoding: 'utf8',
    env: environment,
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  const resultLine = new RegExp(`^(ok|not ok) \\d+ - ${escapePattern(testName)}(?: .*)?$`, 'm').exec(output);
  if (!resultLine) return { status: 'dead', output };
  if (resultLine[1] !== 'ok' || result.status !== 0 || result.error) return { status: 'failed', output };
  if (/# SKIP\b/.test(resultLine[0])) return { status: 'skipped', output };
  if (/# TODO\b/.test(resultLine[0])) return { status: 'todo', output };
  return { status: 'passed', output };
}

function assertCitesAnExecutedTest(citation, key, {
  manifestFiles = new Set([
    ...listSuite(repoRootPath, 'runner'),
    ...listSuite(repoRootPath, 'adapters'),
  ]),
  execute = executeCitedTest,
} = {}) {
  const { testPath, testName } = parseCitation(citation, key);
  assert.ok(manifestFiles.has(testPath), `${key} cites a test excluded from the CI manifest: ${testPath}`);
  const result = execute({ testPath, testName });
  assert.equal(result.status, 'passed', `${key} cites a ${result.status} test: ${testName}\n${result.output}`);
}

function assertOpenFactRecord(record, owningWp) {
  const match = OPEN_FACT_PATTERN.exec(record);
  assert.ok(match, 'OPEN FACT must include owner WP, file:line evidence, resolution path, and verified alternative');
  assert.equal(match[1], owningWp, 'OPEN FACT owner must match the matrix cell');
  assert.ok(match[3].trim().length > 0, 'OPEN FACT resolution path is required');
  assert.ok(match[4].trim().length > 0, 'OPEN FACT verified alternative is required');
}

test('every failure-matrix cell binds to one passing test executed by the CI manifest', async () => {
  const matrix = JSON.parse(await readFile(matrixUrl, 'utf8'));
  for (const cell of matrix.cells) {
    const key = `${cell.system}:${cell.failureClass}`;
    assert.equal(typeof cell.test, 'string', `${key} must have a test citation`);
    assert.equal(cell.test.startsWith('OPEN FACT'), false, `${key} has an OPEN FACT and cannot count as conformance`);
    assertCitesAnExecutedTest(cell.test, key);
  }
});

test('Relay holds and authority replay cite distinct executed tests for the full recovery tuple', async () => {
  const matrix = JSON.parse(await readFile(matrixUrl, 'utf8'));
  const cells = new Map(matrix.cells.map(cell => [`${cell.system}:${cell.failureClass}`, cell]));
  const citations = new Set();

  for (const [key, expected] of RECOVERY_TUPLE_CITATIONS) {
    const cell = cells.get(key);
    assert.ok(cell, `missing recovery tuple cell ${key}`);
    assert.deepEqual({
      expectedTerminalState: cell.expectedTerminalState,
      expectedAttemptState: cell.expectedAttemptState,
      expectedNextStage: cell.expectedNextStage,
      test: cell.test,
    }, expected, `${key} must bind one exact terminal, attempt, next-decision, and recovery test tuple`);
    assert.equal(citations.has(cell.test), false, `${key} must cite a uniquely named recovery test`);
    citations.add(cell.test);
    assertCitesAnExecutedTest(cell.test, key);
  }
  assert.equal(citations.size, RECOVERY_TUPLE_CITATIONS.size);
});

test('failure-matrix bindings reject failing, skipped, todo, dead, excluded, and malformed citations', () => {
  const citation = 'packages/adapters/test/app/example.test.mjs — exact conformance test';
  const options = status => ({
    manifestFiles: new Set(['packages/adapters/test/app/example.test.mjs']),
    execute: () => ({ status }),
  });

  for (const status of ['failed', 'skipped', 'todo', 'dead']) {
    assert.throws(() => assertCitesAnExecutedTest(citation, 'negative', options(status)), new RegExp(`cites a ${status} test`));
  }
  assert.throws(
    () => assertCitesAnExecutedTest(citation, 'negative', { manifestFiles: new Set(), execute: () => ({ status: 'passed' }) }),
    /excluded from the CI manifest/,
  );
  assert.throws(() => assertCitesAnExecutedTest('comment only', 'negative'), /must cite one exact adapter or runner test/);
});

test('failure-matrix OPEN FACT records are structurally checked apart from conformance', async () => {
  const matrix = JSON.parse(await readFile(matrixUrl, 'utf8'));
  for (const cell of matrix.cells.filter(candidate => candidate.test.startsWith('OPEN FACT'))) {
    assertOpenFactRecord(cell.test, cell.owningWp);
  }
});

test('OPEN FACT schema rejects malformed owner, evidence, resolution, and verified alternative fields', () => {
  const valid = 'OPEN FACT (WP07): evidence=packages/adapters/src/app/example.mjs:42; resolution=add the durable hold; verified alternative=read-only reconciliation remains available';
  assertOpenFactRecord(valid, 'WP07');
  assert.throws(
    () => assertOpenFactRecord('OPEN FACT (WP07): evidence=packages/adapters/src/app/example.mjs:42', 'WP07'),
    /OPEN FACT must include owner WP/,
  );
  assert.throws(() => assertOpenFactRecord(valid, 'WP08a'), /owner must match/);
});
