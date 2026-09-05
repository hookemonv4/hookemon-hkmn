import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { collectRehearsalEvidence, writeRehearsalEvidence } from '../../src/cycle/rehearsal-evidence.mjs';
import { OPERATIONAL_CYCLE_STAGES } from '../../src/cycle/money-schemas.mjs';

const settlementAmount = Object.freeze({
  chainId: 'solana-mainnet',
  assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  decimals: 6,
  amountAtomic: '30',
});

function stageEvidence(stage) {
  return {
    schema: 'hookemon.rehearsal-stage-evidence.v1',
    cycleId: 'cycle-evidence',
    stage,
    effectId: `rehearsal:cycle-evidence:${stage}`,
    finalizedDeltas: [settlementAmount],
    residues: [{ ...settlementAmount, amountAtomic: '0', classification: 'none' }],
    ...(stage === 'payout'
      ? { proceedsAccount: '8Jw81w1ktEoZx18C4ZP6HhgnbtbzYAKZB7qL3WTmRS3t', payoutConservation: { proceeds: settlementAmount, allocated: settlementAmount } }
      : {}),
  };
}

function completedDescription() {
  return {
    cycleId: 'cycle-evidence',
    mode: 'rehearsal',
    providerMode: 'fake',
    releaseAmount: '30',
    completed: true,
    terminalState: 'COMPLETED',
    stages: new Map(OPERATIONAL_CYCLE_STAGES.map(stage => [stage, { status: 'COMPLETE', evidence: stageEvidence(stage) }])),
    operationalAttempts: new Map(OPERATIONAL_CYCLE_STAGES.map(stage => [stage, { attempt: { state: 'RECONCILED' } }])),
    chainAttempts: new Map(),
  };
}

test('rehearsal evidence records unique fake effects, classified residues, and exact payout conservation', async t => {
  const stateDir = await mkdtemp(join(tmpdir(), 'hookemon-rehearsal-evidence-'));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const evidence = collectRehearsalEvidence(completedDescription());
  assert.deepEqual(evidence.effectIds, OPERATIONAL_CYCLE_STAGES.map(stage => `rehearsal:cycle-evidence:${stage}`));
  const path = await writeRehearsalEvidence({ stateDir, evidence });
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), evidence);
  await assert.rejects(() => writeRehearsalEvidence({ stateDir, evidence }), /already exists/);
});

test('rehearsal evidence can be sealed after all stage reconciliation and before terminal archival', () => {
  const ready = completedDescription();
  ready.completed = false;
  ready.terminalState = null;
  const evidence = collectRehearsalEvidence(ready, { allowReadyToComplete: true });
  assert.equal(evidence.cycleId, ready.cycleId);
  assert.equal(evidence.providerMode, 'fake');
  assert.throws(() => collectRehearsalEvidence(ready), /requires a completed cycle/);
});

test('rehearsal evidence refuses a completed cycle that omits any operational stage or reconciliation', () => {
  const missingStage = completedDescription();
  missingStage.stages.delete('buyback');
  assert.throws(() => collectRehearsalEvidence(missingStage), /stage buyback is incomplete/);

  const unresolvedAttempt = completedDescription();
  unresolvedAttempt.operationalAttempts.set('return', { attempt: { state: 'SENT_UNKNOWN' } });
  assert.throws(() => collectRehearsalEvidence(unresolvedAttempt), /stage return provider attempt is not reconciled/);
});

test('rehearsal evidence refuses a live provider journal without a dedicated proceeds projection', () => {
  const description = completedDescription();
  description.providerMode = 'live';
  assert.throws(
    () => collectRehearsalEvidence(description),
    /live rehearsal evidence requires a dedicated Solana proceeds projection/,
  );
});
