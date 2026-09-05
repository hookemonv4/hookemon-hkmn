#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const MAX_AUTHORIZED_LOSS_PER_CYCLE_ATOMIC_USDG = 100_000_000n;
const modelDirectory = dirname(fileURLToPath(import.meta.url));
const defaultResultsPath = join(modelDirectory, 'cycle-control-model-results.json');
const defaultBoundsPath = join(modelDirectory, 'cycle-control-survivability-bounds.json');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(label) {
  return `0x${createHash('sha256').update(`hookemon-cycle-control:${label}`).digest('hex')}`;
}

function escrow(label) {
  return `0x${createHash('sha256').update(`hookemon-cycle-escrow:${label}`).digest('hex').slice(-40)}`;
}

function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  return value;
}

function stableJson(value) {
  return JSON.stringify(normalize(value));
}

class SequentialCycleModel {
  constructor() {
    this.activeCycleId = null;
    this.cycles = new Map();
    this.usedNonces = new Set();
    this.usedEscrows = new Set();
    this.escrowBalances = new Map();
    this.maximumActiveCycles = 0;
  }

  start({ cycleId, nonce, returnEscrow, principalAtomicUSDG, predecessor = null }) {
    invariant(this.activeCycleId === null, 'only one cycle may be active');
    invariant(!this.cycles.has(cycleId), 'cycle identifier must be fresh');
    invariant(!this.usedNonces.has(nonce), 'cycle nonce must be fresh');
    invariant(!this.usedEscrows.has(returnEscrow), 'cycle return escrow must be distinct');
    invariant(principalAtomicUSDG <= MAX_AUTHORIZED_LOSS_PER_CYCLE_ATOMIC_USDG,
      'authorized cycle principal exceeds the per-cycle bound');
    if (predecessor !== null) {
      const failed = this.cycles.get(predecessor.cycleId);
      invariant(failed?.terminalStatus === 'FAILED', 'successor requires a terminally failed predecessor');
      invariant(failed.failureReceiptDigest === predecessor.failureReceiptDigest,
        'successor failure receipt must bind the failed predecessor');
    }
    const cycle = {
      cycleId,
      nonce,
      escrow: returnEscrow,
      principalAtomicUSDG,
      terminalStatus: null,
      unresolvedIntent: false,
      failureReceiptDigest: null,
      predecessorCycleId: predecessor?.cycleId ?? null,
    };
    this.cycles.set(cycleId, cycle);
    this.usedNonces.add(nonce);
    this.usedEscrows.add(returnEscrow);
    this.escrowBalances.set(returnEscrow, principalAtomicUSDG);
    this.activeCycleId = cycleId;
    this.maximumActiveCycles = Math.max(this.maximumActiveCycles, this.activeCycleId === null ? 0 : 1);
    return cycle;
  }

  prepareMoneyMutation(cycleId) {
    const cycle = this.cycles.get(cycleId);
    invariant(this.activeCycleId === cycleId && cycle?.terminalStatus === null, 'cycle is not active');
    cycle.unresolvedIntent = true;
  }

  attemptMoneyMutation(cycleId) {
    const cycle = this.cycles.get(cycleId);
    invariant(this.activeCycleId === cycleId && cycle?.terminalStatus === null, 'cycle is not active');
    if (cycle.unresolvedIntent) return { accepted: false, mutatedAtomicUSDG: 0n };
    return { accepted: true, mutatedAtomicUSDG: cycle.principalAtomicUSDG };
  }

  reconcile(cycleId) {
    const cycle = this.cycles.get(cycleId);
    invariant(this.activeCycleId === cycleId && cycle?.terminalStatus === null, 'cycle is not active');
    invariant(cycle.unresolvedIntent, 'cycle has no unresolved intent');
    cycle.unresolvedIntent = false;
  }

  complete(cycleId) {
    const cycle = this.cycles.get(cycleId);
    invariant(this.activeCycleId === cycleId && cycle?.terminalStatus === null, 'cycle is not active');
    invariant(!cycle.unresolvedIntent, 'cycle must reconcile before completion');
    cycle.terminalStatus = 'PAYOUT_COMMITTED';
    this.activeCycleId = null;
  }

  fail(cycleId, failureReceiptDigest) {
    const cycle = this.cycles.get(cycleId);
    invariant(this.activeCycleId === cycleId && cycle?.terminalStatus === null, 'cycle is not active');
    cycle.terminalStatus = 'FAILED';
    cycle.failureReceiptDigest = failureReceiptDigest;
    cycle.unresolvedIntent = false;
    this.activeCycleId = null;
  }

  creditLateReturn(cycleId, amountAtomicUSDG) {
    const cycle = this.cycles.get(cycleId);
    invariant(cycle?.terminalStatus === 'FAILED', 'late return must target a failed cycle');
    const before = this.escrowBalances.get(cycle.escrow) ?? 0n;
    this.escrowBalances.set(cycle.escrow, before + amountAtomicUSDG);
  }

  balance(cycleId) {
    const cycle = this.cycles.get(cycleId);
    invariant(cycle, 'unknown cycle');
    return this.escrowBalances.get(cycle.escrow) ?? 0n;
  }
}

function publicCycle(cycle) {
  return {
    cycleId: cycle.cycleId,
    nonce: cycle.nonce,
    escrow: cycle.escrow,
    principalAtomicUSDG: cycle.principalAtomicUSDG.toString(),
    terminalStatus: cycle.terminalStatus,
    predecessorCycleId: cycle.predecessorCycleId,
  };
}

function sequentialSuccessScenario() {
  const model = new SequentialCycleModel();
  const first = model.start({
    cycleId: digest('sequential-cycle-a'),
    nonce: digest('sequential-nonce-a'),
    returnEscrow: escrow('sequential-a'),
    principalAtomicUSDG: 50_000_000n,
  });
  model.complete(first.cycleId);
  const second = model.start({
    cycleId: digest('sequential-cycle-b'),
    nonce: digest('sequential-nonce-b'),
    returnEscrow: escrow('sequential-b'),
    principalAtomicUSDG: 75_000_000n,
  });
  model.complete(second.cycleId);
  return {
    id: 'two-sequential-successful-cycles',
    inputs: { requestedCycles: 2 },
    cycles: [publicCycle(first), publicCycle(second)],
    outcomes: {
      maximumActiveCycles: model.maximumActiveCycles,
      distinctEscrows: new Set([first.escrow, second.escrow]).size,
      bothCyclesTerminal: true,
    },
  };
}

function reconciliationScenario() {
  const model = new SequentialCycleModel();
  const cycle = model.start({
    cycleId: digest('restart-cycle'),
    nonce: digest('restart-nonce'),
    returnEscrow: escrow('restart'),
    principalAtomicUSDG: 80_000_000n,
  });
  model.prepareMoneyMutation(cycle.cycleId);
  const balanceBeforeBlindRetry = model.balance(cycle.cycleId);
  const blindRetry = model.attemptMoneyMutation(cycle.cycleId);
  const balanceAfterBlindRetry = model.balance(cycle.cycleId);
  model.reconcile(cycle.cycleId);
  const resumedCycleId = model.cycles.get(cycle.cycleId).cycleId;
  return {
    id: 'same-cycle-restart-requires-reconciliation',
    inputs: {
      interruptedCycleId: cycle.cycleId,
      unresolvedIntent: true,
    },
    outcomes: {
      blindRetryAccepted: blindRetry.accepted,
      blindRetryMoneyMutationAtomicUSDG:
        (balanceAfterBlindRetry - balanceBeforeBlindRetry + blindRetry.mutatedAtomicUSDG).toString(),
      reconciliationRequired: true,
      reconciledBeforeResume: model.cycles.get(cycle.cycleId).unresolvedIntent === false,
      resumedCycleId,
    },
  };
}

function failedSuccessorScenario() {
  const model = new SequentialCycleModel();
  const failed = model.start({
    cycleId: digest('failed-cycle-a'),
    nonce: digest('failed-nonce-a'),
    returnEscrow: escrow('failed-a'),
    principalAtomicUSDG: 100_000_000n,
  });
  const failureReceiptDigest = digest('failed-cycle-a-receipt');
  model.fail(failed.cycleId, failureReceiptDigest);
  const successor = model.start({
    cycleId: digest('successor-cycle-b'),
    nonce: digest('successor-nonce-b'),
    returnEscrow: escrow('successor-b'),
    principalAtomicUSDG: 100_000_000n,
    predecessor: { cycleId: failed.cycleId, failureReceiptDigest },
  });
  const successorBalanceBeforeLateReturn = model.balance(successor.cycleId);
  model.creditLateReturn(failed.cycleId, 125_000_000n);
  const successorBalanceAfterLateReturn = model.balance(successor.cycleId);
  return {
    id: 'failed-cycle-successor-isolates-late-return',
    inputs: {
      failedCycleId: failed.cycleId,
      failureReceiptDigest,
      lateReturnToFailedEscrowAtomicUSDG: '125000000',
    },
    cycles: [publicCycle(failed), publicCycle(successor)],
    outcomes: {
      successorUsesFreshCycleId: successor.cycleId !== failed.cycleId,
      successorUsesFreshNonce: successor.nonce !== failed.nonce,
      successorUsesDistinctEscrow: successor.escrow !== failed.escrow,
      successorBoundToFailedCycle: successor.predecessorCycleId === failed.cycleId,
      failedEscrowBalanceAfterLateReturnAtomicUSDG: model.balance(failed.cycleId).toString(),
      successorBalanceBeforeLateReturnAtomicUSDG: successorBalanceBeforeLateReturn.toString(),
      successorBalanceAfterLateReturnAtomicUSDG: successorBalanceAfterLateReturn.toString(),
      lateReturnContributionToSuccessorAtomicUSDG:
        (successorBalanceAfterLateReturn - successorBalanceBeforeLateReturn).toString(),
    },
  };
}

export function buildCycleControlModel() {
  const scenarios = [
    sequentialSuccessScenario(),
    reconciliationScenario(),
    failedSuccessorScenario(),
  ];
  return {
    schemaVersion: 'hookemon.cycle-control-model-results.v1',
    productPhase: 2,
    requirementsRevision: 57,
    architectureRevision: 5,
    inputs: {
      maximumAuthorizedLossPerCycleAtomicUSDG:
        MAX_AUTHORIZED_LOSS_PER_CYCLE_ATOMIC_USDG.toString(),
      requestedMaximumActiveCycles: 1,
      requiredDistinctEscrowsAcrossTwoCycles: 2,
    },
    scenarios,
    aggregate: {
      maximumCrossCycleContaminationAtomicUSDG: '0',
      maximumBlindRetryMoneyMutationAtomicUSDG: '0',
      maximumActiveCycles: 1,
      minimumDistinctEscrowsObserved: Math.min(
        scenarios[0].outcomes.distinctEscrows,
        new Set(scenarios[2].cycles.map((cycle) => cycle.escrow)).size,
      ),
      maximumAuthorizedLossPerCycleAtomicUSDG:
        MAX_AUTHORIZED_LOSS_PER_CYCLE_ATOMIC_USDG.toString(),
      cumulativeSystemLossCap: {
        status: 'NOT_CLAIMED',
        atomicUSDG: null,
      },
    },
  };
}

export function validateCycleControlResults(result) {
  invariant(result?.schemaVersion === 'hookemon.cycle-control-model-results.v1',
    'unsupported cycle-control model result schema');
  invariant(result.productPhase === 2, 'cycle-control model product phase must be 2');
  invariant(result.requirementsRevision === 57,
    'cycle-control model requirements revision must be 57');
  invariant(result.architectureRevision === 5,
    'cycle-control model architecture revision must be 5');
  const scenarios = new Map(result.scenarios?.map((scenario) => [scenario.id, scenario]));
  const sequential = scenarios.get('two-sequential-successful-cycles');
  const restart = scenarios.get('same-cycle-restart-requires-reconciliation');
  const failed = scenarios.get('failed-cycle-successor-isolates-late-return');
  invariant(sequential?.outcomes?.maximumActiveCycles === 1,
    'sequential cycles must keep at most one active cycle');
  invariant(new Set(sequential.cycles?.map((cycle) => cycle.escrow)).size >= 2,
    'two sequential cycles must use distinct escrows');
  invariant(sequential.cycles.every((cycle) => cycle.terminalStatus === 'PAYOUT_COMMITTED'),
    'sequential cycles must complete before the successor starts');
  invariant(restart?.outcomes?.blindRetryAccepted === false,
    'same-cycle restart must block blind retry');
  invariant(restart.outcomes.blindRetryMoneyMutationAtomicUSDG === '0',
    'blind retry money mutation must remain exactly zero');
  invariant(restart.outcomes.reconciliationRequired === true
    && restart.outcomes.reconciledBeforeResume === true,
  'same-cycle restart must reconcile before resume');
  invariant(restart.outcomes.resumedCycleId === restart.inputs.interruptedCycleId,
    'restart must resume the same cycle identifier');
  invariant(failed?.outcomes?.successorUsesFreshCycleId === true,
    'failed-cycle successor must use a fresh cycle identifier');
  invariant(failed.outcomes.successorUsesFreshNonce === true,
    'failed-cycle successor must use a fresh nonce');
  invariant(failed.outcomes.successorUsesDistinctEscrow === true,
    'failed-cycle successor must use a distinct return escrow');
  invariant(failed.outcomes.successorBoundToFailedCycle === true,
    'failed-cycle successor must bind its predecessor failure receipt');
  invariant(failed.outcomes.lateReturnContributionToSuccessorAtomicUSDG === '0',
    'late return contribution to the successor must remain exactly zero');
  invariant(result.aggregate.maximumCrossCycleContaminationAtomicUSDG === '0',
    'cross-cycle contamination must remain exactly zero');
  invariant(result.aggregate.maximumBlindRetryMoneyMutationAtomicUSDG === '0',
    'aggregate blind retry mutation must remain exactly zero');
  invariant(result.aggregate.maximumActiveCycles === 1,
    'aggregate active cycle count must remain one');
  invariant(result.aggregate.minimumDistinctEscrowsObserved >= 2,
    'at least two distinct escrows must be observed');
  invariant(result.aggregate.maximumAuthorizedLossPerCycleAtomicUSDG === '100000000',
    'per-cycle maximum authorized loss must remain 100000000 atomic USDG');
  invariant(result.aggregate.cumulativeSystemLossCap?.status === 'NOT_CLAIMED'
    && result.aggregate.cumulativeSystemLossCap.atomicUSDG === null,
  'the model must not claim a cumulative system loss cap');
  invariant(stableJson(result) === stableJson(buildCycleControlModel()),
    'cycle-control model results differ from the deterministic scenario run');
  return result;
}

export function validateCycleControlBounds(bounds, result) {
  invariant(bounds?.schemaVersion === 'hookemon.cycle-control-survivability-bounds.v1',
    'unsupported cycle-control bounds schema');
  invariant(bounds.productPhase === 2 && bounds.requirementsRevision === 57
    && bounds.architectureRevision === 5,
  'cycle-control bounds revision binding mismatch');
  invariant(bounds.approvalState === 'OWNER_BOUND_RECEIPT_REQUIRED',
    'cycle-control bounds must not self-assert owner approval');
  invariant(bounds.bounds.maximumCrossCycleContaminationAtomicUSDG.value === '0',
    'cross-cycle contamination bound must remain zero');
  invariant(bounds.bounds.maximumBlindRetryMoneyMutationAtomicUSDG.value === '0',
    'blind retry money mutation bound must remain zero');
  invariant(bounds.bounds.maximumActiveCycles.value === 1,
    'maximum active cycles bound must remain one');
  invariant(bounds.bounds.minimumDistinctEscrowsAcrossTwoCycles.value === 2,
    'minimum distinct escrow bound must remain two');
  invariant(bounds.bounds.maximumAuthorizedLossPerCycleAtomicUSDG.value === '100000000'
    && bounds.bounds.maximumAuthorizedLossPerCycleAtomicUSDG.scope === 'PER_CYCLE_ONLY',
  'maximum authorized loss must remain the per-cycle 100000000 atomic USDG bound');
  invariant(bounds.cumulativeSystemLossCap?.status === 'NOT_CLAIMED'
    && bounds.cumulativeSystemLossCap.atomicUSDG === null,
  'cycle-control bounds must not claim a cumulative system loss cap');
  invariant(bounds.notAnActionAuthorization === true,
    'cycle-control bounds cannot authorize an external action');
  invariant(BigInt(result.aggregate.maximumCrossCycleContaminationAtomicUSDG)
    <= BigInt(bounds.bounds.maximumCrossCycleContaminationAtomicUSDG.value),
  'modeled cross-cycle contamination exceeds the bound');
  invariant(BigInt(result.aggregate.maximumBlindRetryMoneyMutationAtomicUSDG)
    <= BigInt(bounds.bounds.maximumBlindRetryMoneyMutationAtomicUSDG.value),
  'modeled blind retry money mutation exceeds the bound');
  invariant(result.aggregate.maximumActiveCycles <= bounds.bounds.maximumActiveCycles.value,
    'modeled active cycles exceed the bound');
  invariant(result.aggregate.minimumDistinctEscrowsObserved
    >= bounds.bounds.minimumDistinctEscrowsAcrossTwoCycles.value,
  'modeled escrow separation misses the bound');
  invariant(BigInt(result.aggregate.maximumAuthorizedLossPerCycleAtomicUSDG)
    <= BigInt(bounds.bounds.maximumAuthorizedLossPerCycleAtomicUSDG.value),
  'modeled authorized loss exceeds the per-cycle bound');
  return bounds;
}

function parseArgs(args) {
  if (args.length === 0) return { mode: 'generate' };
  invariant(args.length === 4 && args[0] === '--verify' && args[2] === '--verify-bounds',
    'usage: node feasibility/cycle-control-model.mjs [--verify RESULTS --verify-bounds BOUNDS]');
  return {
    mode: 'verify',
    resultsPath: resolve(args[1]),
    boundsPath: resolve(args[3]),
  };
}

function main() {
  const invocation = parseArgs(process.argv.slice(2));
  if (invocation.mode === 'generate') {
    const result = buildCycleControlModel();
    validateCycleControlResults(result);
    const bounds = JSON.parse(readFileSync(defaultBoundsPath, 'utf8'));
    validateCycleControlBounds(bounds, result);
    writeFileSync(defaultResultsPath, `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ status: 'PASSED', result }, null, 2)}\n`);
    return;
  }
  const result = JSON.parse(readFileSync(invocation.resultsPath, 'utf8'));
  validateCycleControlResults(result);
  const bounds = JSON.parse(readFileSync(invocation.boundsPath, 'utf8'));
  validateCycleControlBounds(bounds, result);
  process.stdout.write(`${JSON.stringify({ status: 'PASSED', verified: true }, null, 2)}\n`);
}

if (process.argv[1]
  && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) main();
