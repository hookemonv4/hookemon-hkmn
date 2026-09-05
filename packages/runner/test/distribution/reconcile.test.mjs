import assert from 'node:assert/strict';
import test from 'node:test';

import { CycleRunner } from '../../src/cycle/cycle-runner.mjs';
import { FixtureCycleStore } from '../../src/cycle/cycle-store.mjs';
import { digest } from '../../src/cycle/journal.mjs';
import { deriveClosedProceedsBasis } from '../../src/distribution/reconcile.mjs';
import { executeCompleteFixtureCycle } from '../cycle/fixture-cycle.mjs';

function closedHandoff(cycleId) {
  const cycleStore = new FixtureCycleStore();
  const runner = new CycleRunner(cycleId, [], { cycleStore });
  const { returnReceiptDigest } = executeCompleteFixtureCycle(runner, cycleId);
  runner.deriveClosedCycle();
  const proceedsKey = runner.consumeReturnedProceedsOnce({ receiptDigest: returnReceiptDigest });
  return {
    cycleStore,
    runner,
    proceedsKey,
    handoff: runner.readClosedProceedsBasisHandoff({ proceedsKey }),
  };
}

function rebindHandoff(value) {
  const handoff = structuredClone(value);
  const { ledgerDigest: _oldLedgerDigest, ...ledger } = handoff.closedLedger;
  handoff.closedLedger.ledgerDigest = digest({
    domain: 'hookemon.fixture-closed-cycle-ledger.v4',
    ledger,
  });
  handoff.proceedsKey = digest({
    domain: 'hookemon.cycle-runner.proceeds.v4',
    cycleId: handoff.cycleId,
    preflightDigest: handoff.closedLedger.preflightDigest,
    closedJournalHead: handoff.closedLedger.closedJournalHead,
    ledgerDigest: handoff.closedLedger.ledgerDigest,
    cycleVaultAccount: handoff.closedLedger.cycleVaultAccount,
    returnAccount: handoff.closedLedger.returnAccount,
    finalCredit: handoff.closedLedger.finalCredit,
  });
  return handoff;
}

test('derives one deterministic read-only basis from store-checked closed proceeds', () => {
  const cycleId = 'cycle-distribution-basis';
  const { cycleStore, runner, proceedsKey, handoff } = closedHandoff(cycleId);
  const beforeRead = cycleStore.snapshot;

  const first = deriveClosedProceedsBasis(handoff);
  const second = deriveClosedProceedsBasis(structuredClone(handoff));

  assert.deepEqual(second, first);
  assert.deepEqual(cycleStore.snapshot, beforeRead);
  assert.equal(first.schema, 'hookemon.closed-proceeds-basis.v1');
  assert.equal(first.cycleId, cycleId);
  assert.equal(first.proceedsKey, proceedsKey);
  assert.equal(first.closedLedgerDigest, handoff.closedLedger.ledgerDigest);
  assert.equal(first.operationsTrigger, '0x0000000000000000000000000000000000001004');
  assert.equal(first.cycleVaultAccount, '0x0000000000000000000000000000000000001002');
  assert.equal(first.returnAccount, '0x0000000000000000000000000000000000002002');
  assert.notEqual(first.returnAccount, first.cycleVaultAccount);
  assert.equal(first.finalCredit.destinationAccount, first.returnAccount);
  assert.notEqual(first.policyAccount, first.operationsTrigger);
  assert.deepEqual(first.finalCredit, handoff.closedLedger.finalCredit);
  assert.match(first.basisDigest, /^sha256:[0-9a-f]{64}$/);

  const reopenedStore = FixtureCycleStore.reopen(beforeRead);
  const reopened = CycleRunner.recover(cycleId, runner.entries, { cycleStore: reopenedStore });
  const recovered = deriveClosedProceedsBasis(
    reopened.readClosedProceedsBasisHandoff({ proceedsKey }),
  );

  assert.deepEqual(recovered, first);
  assert.deepEqual(reopenedStore.snapshot, beforeRead);
});

test('rejects closed proceeds basis reads before proceeds are authenticated in the store', () => {
  const cycleId = 'cycle-distribution-basis-rejection';
  const cycleStore = new FixtureCycleStore();
  const runner = new CycleRunner(cycleId, [], { cycleStore });
  const unknownProceedsKey = `sha256:${'f'.repeat(64)}`;

  assert.throws(
    () => runner.readClosedProceedsBasisHandoff({ proceedsKey: unknownProceedsKey }),
    /authenticated closed-cycle proceeds/,
  );

  const { returnReceiptDigest } = executeCompleteFixtureCycle(runner, cycleId);
  runner.deriveClosedCycle();
  const beforeRejectedRead = cycleStore.snapshot;
  assert.throws(
    () => runner.readClosedProceedsBasisHandoff({ proceedsKey: unknownProceedsKey }),
    /authenticated closed-cycle proceeds/,
  );
  assert.deepEqual(cycleStore.snapshot, beforeRejectedRead);

  const proceedsKey = runner.consumeReturnedProceedsOnce({ receiptDigest: returnReceiptDigest });
  assert.doesNotThrow(() => runner.readClosedProceedsBasisHandoff({ proceedsKey }));
});

test('rejects handoff content that no longer matches its ledger or proceeds digest', () => {
  const cycleId = 'cycle-distribution-basis-tamper';
  const { handoff } = closedHandoff(cycleId);

  const changedLedger = structuredClone(handoff);
  changedLedger.closedLedger.finalCredit.amount = '11';
  assert.throws(
    () => deriveClosedProceedsBasis(changedLedger),
    /closed ledger digest mismatch/,
  );

  const changedProceeds = structuredClone(handoff);
  changedProceeds.proceedsKey = `sha256:${'e'.repeat(64)}`;
  assert.throws(
    () => deriveClosedProceedsBasis(changedProceeds),
    /proceeds key mismatch/,
  );
});

test('rejects non-canonical handoff and closed-ledger schemas', () => {
  const cycleId = 'cycle-distribution-basis-schema';
  const { handoff } = closedHandoff(cycleId);

  assert.throws(
    () => deriveClosedProceedsBasis({ ...handoff, schema: 'hookemon.untrusted-handoff.v1' }),
    /handoff schema/,
  );
  assert.throws(
    () => deriveClosedProceedsBasis({ ...handoff, authority: 'STORE_AUTHENTICATED' }),
    /handoff schema or authority/,
  );

  const extendedLedger = structuredClone(handoff);
  extendedLedger.closedLedger.unexpected = true;
  assert.throws(
    () => deriveClosedProceedsBasis(rebindHandoff(extendedLedger)),
    /closed proceeds basis ledger must use the exact schema/,
  );
});

test('rejects self-consistent handoffs without exact closed USDG semantics', () => {
  const cycleId = 'cycle-distribution-basis-semantics';
  const { handoff } = closedHandoff(cycleId);

  const wrongCycle = structuredClone(handoff);
  wrongCycle.cycleId = 'cycle-distribution-basis-forged';
  assert.throws(
    () => deriveClosedProceedsBasis(rebindHandoff(wrongCycle)),
    /cycle mismatch/,
  );

  const wrongAsset = structuredClone(handoff);
  wrongAsset.closedLedger.finalCredit.asset = 'ETH';
  assert.throws(
    () => deriveClosedProceedsBasis(rebindHandoff(wrongAsset)),
    /final credit.*USDG/,
  );

  const staleRevision = structuredClone(handoff);
  staleRevision.closedLedger.requirementsRevision = 56;
  assert.throws(
    () => deriveClosedProceedsBasis(rebindHandoff(staleRevision)),
    /requirements revision/,
  );

  const coordinatorReturn = structuredClone(handoff);
  coordinatorReturn.closedLedger.returnAccount = coordinatorReturn.closedLedger.cycleVaultAccount;
  coordinatorReturn.closedLedger.finalCredit.destinationAccount =
    coordinatorReturn.closedLedger.cycleVaultAccount;
  assert.throws(
    () => deriveClosedProceedsBasis(rebindHandoff(coordinatorReturn)),
    /custody/i,
  );

  const operationsReturn = structuredClone(handoff);
  operationsReturn.closedLedger.returnAccount = operationsReturn.closedLedger.operationsTrigger;
  operationsReturn.closedLedger.finalCredit.destinationAccount = operationsReturn.closedLedger.operationsTrigger;
  assert.throws(
    () => deriveClosedProceedsBasis(rebindHandoff(operationsReturn)),
    /custody|cycle vault/i,
  );

  const policyReturn = structuredClone(handoff);
  policyReturn.closedLedger.returnAccount = policyReturn.closedLedger.policyAccount;
  policyReturn.closedLedger.finalCredit.destinationAccount = policyReturn.closedLedger.policyAccount;
  assert.throws(
    () => deriveClosedProceedsBasis(rebindHandoff(policyReturn)),
    /custody/i,
  );

  const wrongCreditDestination = structuredClone(handoff);
  wrongCreditDestination.closedLedger.finalCredit.destinationAccount =
    wrongCreditDestination.closedLedger.cycleVaultAccount;
  assert.throws(
    () => deriveClosedProceedsBasis(rebindHandoff(wrongCreditDestination)),
    /final credit.*return account/i,
  );

  const operationsPolicy = structuredClone(handoff);
  operationsPolicy.closedLedger.policyAccount = operationsPolicy.closedLedger.operationsTrigger;
  assert.throws(
    () => deriveClosedProceedsBasis(rebindHandoff(operationsPolicy)),
    /custody/i,
  );

  const positivePriorBalance = structuredClone(handoff);
  positivePriorBalance.closedLedger.finalCredit.preBalance = '1';
  positivePriorBalance.closedLedger.finalCredit.postBalance = '11';
  assert.deepEqual(
    deriveClosedProceedsBasis(rebindHandoff(positivePriorBalance)).finalCredit,
    positivePriorBalance.closedLedger.finalCredit,
  );

  for (const [name, postBalance] of [['delta short by one', '10'], ['delta over by one', '12']]) {
    const wrongDelta = structuredClone(positivePriorBalance);
    wrongDelta.closedLedger.finalCredit.postBalance = postBalance;
    assert.throws(
      () => deriveClosedProceedsBasis(rebindHandoff(wrongDelta)),
      /activity-isolated/,
      name,
    );
  }

  const extendedCredit = structuredClone(handoff);
  extendedCredit.closedLedger.finalCredit.unexpected = true;
  assert.throws(
    () => deriveClosedProceedsBasis(rebindHandoff(extendedCredit)),
    /final credit must use the exact schema/,
  );
});

test('labels the portable closed proceeds basis without unlocking funding or publication', async () => {
  const cycleId = 'cycle-closed-proceeds-authority';
  const { cycleStore, runner, proceedsKey } = closedHandoff(cycleId);
  const beforeRead = cycleStore.snapshot;
  const module = await import('../../src/distribution/reconcile.mjs');

  assert.equal(typeof module.deriveClosedProceedsBasis, 'function');
  const handoff = runner.readClosedProceedsBasisHandoff({ proceedsKey });
  const basis = module.deriveClosedProceedsBasis(handoff);

  assert.equal(handoff.schema, 'hookemon.closed-proceeds-basis-handoff.v1');
  assert.equal(basis.schema, 'hookemon.closed-proceeds-basis.v1');
  assert.equal(basis.authority, 'READ_ONLY_SELF_CONSISTENT_NOT_STORE_MEMBERSHIP_PROOF');
  assert.deepEqual(cycleStore.snapshot, beforeRead);
  for (const forbidden of ['manifestDigest', 'root', 'proof', 'publication', 'fundingIntent']) {
    assert.equal(Object.hasOwn(basis, forbidden), false);
  }
  assert.equal(typeof runner.compileAndPublishDistribution, 'undefined');
  assert.equal(typeof runner.verifyIndependentDistribution, 'undefined');
  assert.throws(
    () => runner.preparePayoutFunding({
      proceedsKey,
      verificationReceiptDigest: basis.basisDigest,
      expiresAt: '1893456000',
      nonce: '9',
    }),
    /recorded distribution verification/i,
  );
  assert.deepEqual(cycleStore.snapshot, beforeRead);
});
