import { NATIVE_ROUND_SCHEMA, nativeFieldName } from '../../../dashboard/src/contracts/native-accounting.mjs';

const DECIMAL = /^(0|[1-9][0-9]*)$/;

const HISTORICAL_FIELDS = Object.freeze([
  'totalCycleFundingMicroUsdg',
  'totalCollectorSpendMicroUsdg',
  'totalBuybacksReturnedMicroUsdg',
  'totalBridgedBackMicroUsdg',
  'totalRewardsPaidMicroUsdg',
  'totalRewardsDeferredMicroUsdg',
  'totalQuotedOperatingCostsMicroUsdg',
  'latestRetainedReserveMicroUsdg',
  'latestCycleReserveTargetMicroUsdg',
]);
const NATIVE_FIELDS = Object.freeze(HISTORICAL_FIELDS.map(nativeFieldName));
const ALL_FIELDS = Object.freeze([...HISTORICAL_FIELDS, ...NATIVE_FIELDS]);

function validAmount(value) {
  return typeof value === 'string' && DECIMAL.test(value) ? value : null;
}

function addAmounts(values) {
  if (values.some(value => value === null)) return null;
  return values.reduce((total, value) => total + BigInt(value), 0n).toString();
}

function typedUsdg(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (String(value.chainId) !== '4663' || value.decimals !== 6 || typeof value.assetId !== 'string') return null;
  return validAmount(value.units);
}

function nativeWei(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (String(value.chainId) !== '4663' || value.assetId !== 'native' || value.decimals !== 18) return null;
  return validAmount(value.units);
}

function openedPackCount(stage) {
  if (!stage || stage.status !== 'COMPLETE' || !Array.isArray(stage.evidence?.packs)) return null;
  return stage.evidence.packs.filter(pack => pack?.decision === 'opened' || pack?.outcome === 'opened').length;
}

function purchasedPackCount(stage) {
  if (!stage || stage.status !== 'COMPLETE' || !Array.isArray(stage.evidence?.packs)) return 0;
  return stage.evidence.packs.filter(pack => pack?.status === 'purchased' || pack?.outcome === 'purchased').length;
}

function quotedOperatingCosts(accounting) {
  const costs = accounting?.quotedCosts;
  if (!costs || typeof costs !== 'object') return null;
  const values = [
    costs.outboundBridgeMicroUsdg,
    costs.inboundBridgeMicroUsdg,
    costs.collectorApiMicroUsdg,
    costs.evmNetworkMicroUsdg,
    costs.solanaNetworkMicroUsdg,
    costs.slippageMicroUsdg,
  ].map(validAmount);
  return addAmounts(values);
}

function accountingAmounts(accounting, unit) {
  if (unit === 'wei') {
    return {
      totalCycleFundingWei: nativeWei(accounting?.releaseAmount),
      totalCollectorSpendMicroUsd: null,
      totalBuybacksReturnedMicroUsd: null,
      totalBridgedBackWei: nativeWei(accounting?.inboundBridgeProceeds),
      totalRewardsPaidWei: validAmount(accounting?.paidHolderRewardsWei),
      totalRewardsDeferredWei: validAmount(accounting?.payoutLiabilityWei),
      totalQuotedOperatingCostsMicroUsd: null,
      latestRetainedReserveWei: validAmount(accounting?.feeReserveAfterWei),
      latestCycleReserveTargetWei: validAmount(accounting?.feeReserveTargetWei),
    };
  }
  return {
    totalCycleFundingMicroUsdg: validAmount(accounting?.packSpendMicroUsdg),
    // Collector Crypt amounts are typed Solana settlement amounts, not USDG.
    totalCollectorSpendMicroUsdg: null,
    totalBuybacksReturnedMicroUsdg: null,
    totalBridgedBackMicroUsdg: typedUsdg(accounting?.inboundBridgeProceeds),
    totalRewardsPaidMicroUsdg: validAmount(accounting?.paidHolderRewardsMicroUsdg),
    totalRewardsDeferredMicroUsdg: validAmount(accounting?.payoutLiabilityMicroUsdg),
    totalQuotedOperatingCostsMicroUsdg: quotedOperatingCosts(accounting),
    latestRetainedReserveMicroUsdg: validAmount(accounting?.feeReserveAfterMicroUsdg),
    latestCycleReserveTargetMicroUsdg: validAmount(accounting?.feeReserveTargetMicroUsdg),
  };
}

function newestTerminal(perCycle) {
  return perCycle
    .filter(cycle => cycle.terminalState !== null)
    .filter(cycle => Number.isSafeInteger(cycle.terminalAtMs) && cycle.terminalAtMs >= 0)
    .sort((left, right) => right.terminalAtMs - left.terminalAtMs || left.cycleId.localeCompare(right.cycleId))[0] ?? null;
}

/**
 * Projects lifetime facts from every durable cycle. A total is emitted only when every terminal
 * cycle has the evidence required for that field; missing evidence remains visible as null.
 */
export async function projectLifetimeTotals({ cycleRepository, cycleIds, readAccounting, now = Date.now }) {
  if (!cycleRepository || typeof cycleRepository.describeCycle !== 'function'
    || typeof cycleRepository.readStage !== 'function') {
    throw new Error('projectLifetimeTotals requires a cycleRepository exposing describeCycle/readStage');
  }
  if (typeof readAccounting !== 'function') throw new Error('projectLifetimeTotals requires readAccounting');
  const ids = Array.isArray(cycleIds) ? cycleIds : await cycleRepository.listKnownCycleIds();
  const perCycle = [];
  for (const cycleId of ids) {
    const description = await cycleRepository.describeCycle(cycleId);
    const [purchase, open, accounting] = await Promise.all([
      cycleRepository.readStage(cycleId, 'purchase'),
      cycleRepository.readStage(cycleId, 'open'),
      readAccounting(cycleId),
    ]);
    const terminalState = typeof description?.terminalState === 'string' ? description.terminalState : null;
    const terminalAtMs = Number.isSafeInteger(description?.terminalAtMs) ? description.terminalAtMs : null;
    const unit = accounting?.schema === NATIVE_ROUND_SCHEMA ? 'wei' : 'micro-usdg';
    const openedPacks = openedPackCount(open);
    const purchased = purchasedPackCount(purchase);
    const skipped = terminalState !== null
      && !terminalState.startsWith('HELD_')
      && (purchase?.status !== 'COMPLETE' || purchased === 0);
    perCycle.push({
      cycleId,
      terminalState,
      terminalAtMs,
      unit,
      openedPacks,
      skippedCycles: terminalState === null ? null : (skipped ? 1 : 0),
      accounting,
    });
  }

  const terminal = perCycle.filter(cycle => cycle.terminalState !== null);
  const unitSet = new Set(terminal.map(cycle => cycle.unit));
  const units = unitSet.size === 0 ? null : unitSet.size === 1 ? [...unitSet][0] : 'mixed';
  const fieldNames = units === 'wei' ? NATIVE_FIELDS : HISTORICAL_FIELDS;
  const fieldValues = Object.fromEntries(ALL_FIELDS.map(field => [field, []]));
  for (const cycle of terminal) {
    const values = accountingAmounts(cycle.accounting, cycle.unit);
    for (const field of ALL_FIELDS) {
      fieldValues[field].push(cycle.unit === 'wei'
        ? (field.endsWith('Wei') ? values[field] : null)
        : (field.endsWith('MicroUsdg') ? values[field] : null));
    }
  }
  const latest = newestTerminal(perCycle);
  const latestValues = latest ? accountingAmounts(latest.accounting, latest.unit) : null;
  const totals = {};
  const completeness = {};
  for (const field of ALL_FIELDS) {
    const values = fieldValues[field];
    const isLatest = field.endsWith('RetainedReserveMicroUsdg')
      || field.endsWith('CycleReserveTargetMicroUsdg')
      || field.endsWith('RetainedReserveWei')
      || field.endsWith('CycleReserveTargetWei');
    totals[field] = units === 'mixed' || !fieldNames.includes(field)
      ? null
      : isLatest
        ? (latest?.unit === units ? latestValues?.[field] ?? null : null)
        : values.length === 0 ? null : addAmounts(values);
    completeness[field] = units !== 'mixed'
      && fieldNames.includes(field)
      && values.length > 0
      && totals[field] !== null;
  }
  const openedValues = terminal.map(cycle => cycle.openedPacks);
  const skippedValues = terminal.map(cycle => cycle.skippedCycles);

  return {
    generatedAt: new Date(now()).toISOString(),
    units,
    cyclesScanned: perCycle.length,
    terminalCycles: terminal.length,
    totals,
    counts: {
      openedPacks: openedValues.length > 0 && openedValues.every(value => value !== null)
        ? openedValues.reduce((total, value) => total + value, 0)
        : null,
      skippedCycles: skippedValues.length > 0 && skippedValues.every(value => value !== null)
        ? skippedValues.reduce((total, value) => total + value, 0)
        : null,
      completedCycles: terminal.filter(cycle => ['COMPLETE', 'COMPLETED'].includes(cycle.terminalState)).length,
    },
    completeness: {
      ...completeness,
      openedPacks: openedValues.length > 0 && openedValues.every(value => value !== null),
      skippedCycles: skippedValues.length > 0 && skippedValues.every(value => value !== null),
    },
    perCycle,
    latestCycle: latest
      ? {
        cycleId: latest.cycleId,
        terminalState: latest.terminalState,
        terminalAtMs: latest.terminalAtMs,
        accounting: latest.accounting,
        paidMicroUsdg: latestValues?.totalRewardsPaidMicroUsdg ?? null,
        paidWei: latestValues?.totalRewardsPaidWei ?? null,
      }
      : null,
  };
}

export { HISTORICAL_FIELDS as LIFETIME_FIELDS, HISTORICAL_FIELDS, NATIVE_FIELDS };
