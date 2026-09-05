import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const fixtureVerifierPath = fileURLToPath(new URL('../../src/cycle/verify-fixtures.mjs', import.meta.url));
const stateMachinePath = fileURLToPath(new URL('../../src/cycle/state-machine.mjs', import.meta.url));

test('fixture verification executes and recovers the real durable CycleRunner', () => {
  const source = readFileSync(fixtureVerifierPath, 'utf8');
  assert.doesNotMatch(source, /CycleStateMachine|state-machine\.mjs/);
  assert.match(source, /CycleRunner/);
  assert.match(source, /FixtureCycleStore\.reopen/);
  const output = execFileSync(process.execPath, [fixtureVerifierPath], {
    encoding: 'utf8',
  });
  assert.match(output, /fixture verification passed: closed CycleRunner recovered durably/);
});

test('does not retain the legacy standalone cycle state machine', () => {
  assert.equal(existsSync(stateMachinePath), false);
});
