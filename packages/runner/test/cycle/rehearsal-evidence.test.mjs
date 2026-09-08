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

const purchaseAmount = Object.freeze({ ...settlementAmount, amountAtomic: '25000000' });
const proceedsAmount = Object.freeze({ ...settlementAmount, amountAtomic: '15000000' });
const proceedsAccount = '8Jw81w1ktEoZx18C4ZP6HhgnbtbzYAKZB7qL3WTmRS3t';
const recipientTokenAccounts = Object.freeze([
  'GfFAJnHnSgP7C2FQZLz6ogpdTV6Y7259f83qFFm9wxKm',
  'H9ZXYkudxn6qhyp5S25jm5SrA8Vnu8naSfvymm9TptLA',
]);

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

function liveStageEvidence(stage) {
  if (['eligibility-snapshot', 'claim-process', 'outbound', 'return'].includes(stage)) {
    return {
      skipped: true,
      rehearsalMode: 'collector-only',
      stage,
      reason: 'stage is outside the collector-only rehearsal boundary',
    };
  }
  if (stage === 'purchase') {
    return { memo: 'memo-live', signature: 'signature-purchase', expectedCardCount: 1, packCost: purchaseAmount };
  }
  if (stage === 'open') {
    return { memo: 'memo-live', signature: 'signature-open', mint: 'mint-live', assetKind: 'spl' };
  }
  if (stage === 'epic-gate') {
    return {
      memo: 'memo-live',
      mint: 'mint-live',
      decision: 'sell',
      offer: proceedsAmount,
      insuredValue: purchaseAmount,
    };
  }
  if (stage === 'buyback') {
    return {
      memo: 'memo-live',
      mint: 'mint-live',
      signature: 'signature-buyback',
      quote: proceedsAmount,
      refundAmount: proceedsAmount,
      proceeds: proceedsAmount,
      proceedsProjection: {
        account: proceedsAccount,
        beforeAtomic: '1000000',
        afterAtomic: '16000000',
        delta: proceedsAmount,
      },
    };
  }
  if (stage === 'payout') {
    return {
      signature: 'signature-payout',
      buybackSignature: 'signature-buyback',
      sourceTokenAccount: proceedsAccount,
      proceedsAccount,
      proceeds: proceedsAmount,
      allocated: proceedsAmount,
      recipients: [
        { recipient: 'recipient-one', tokenAccount: recipientTokenAccounts[0], amount: { ...proceedsAmount, amountAtomic: '7500000' } },
        { recipient: 'recipient-two', tokenAccount: recipientTokenAccounts[1], amount: { ...proceedsAmount, amountAtomic: '7500000' } },
      ],
    };
  }
  throw new Error(`unexpected live stage ${stage}`);
}

function completedLiveDescription() {
  return {
    cycleId: 'cycle-live-evidence',
    mode: 'rehearsal',
    providerMode: 'live',
    releaseAmount: '25000000',
    completed: true,
    terminalState: 'COMPLETED',
    stages: new Map(OPERATIONAL_CYCLE_STAGES.map(stage => [stage, { status: 'COMPLETE', evidence: liveStageEvidence(stage) }])),
    operationalAttempts: new Map(OPERATIONAL_CYCLE_STAGES
      .filter(stage => stage !== 'eligibility-snapshot')
      .map(stage => [stage, { attempt: { state: 'RECONCILED' } }])),
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

test('rehearsal evidence records a finalized live collector-only flow with an exact dedicated-proceeds payout', () => {
  const evidence = collectRehearsalEvidence(completedLiveDescription());
  assert.equal(evidence.providerMode, 'live');
  assert.equal(evidence.purchase.packCost.amountAtomic, '25000000');
  assert.equal(evidence.proceeds.account, proceedsAccount);
  assert.equal(evidence.proceeds.delta.amountAtomic, '15000000');
  assert.deepEqual(evidence.payout.recipients.map(entry => entry.amount.amountAtomic), ['7500000', '7500000']);
});

test('rehearsal evidence refuses a live provider journal without a dedicated proceeds projection', () => {
  const description = completedLiveDescription();
  delete description.stages.get('buyback').evidence.proceedsProjection;
  assert.throws(
    () => collectRehearsalEvidence(description),
    /live rehearsal evidence requires a dedicated Solana proceeds projection/,
  );
});

test('native rehearsal evidence uses v2 without relabeling retained historical v1', () => {
  const historical = completedDescription();
  assert.equal(collectRehearsalEvidence(historical).schema, 'hookemon.rehearsal-evidence.v1');
  const native = completedDescription();
  for (const [stage, record] of native.stages) {
    record.evidence.schema = 'hookemon.rehearsal-stage-evidence.v2';
    if (stage !== 'payout') record.evidence.finalizedDeltas = [{ chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '30' }];
  }
  const evidence = collectRehearsalEvidence(native);
  assert.equal(evidence.schema, 'hookemon.rehearsal-evidence.v2');
  assert.equal(evidence.releaseAmount.assetId, 'native');
  assert.equal(evidence.releaseAmount.decimals, 18);
  native.stages.get('open').evidence.schema = 'hookemon.rehearsal-stage-evidence.v1';
  assert.throws(() => collectRehearsalEvidence(native), /cannot mix historical/);
});
