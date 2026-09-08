// Native readers validate their own units before reusing historical non-money shape checks.
// The validation-only skeleton contains only amount-presence sentinels; no native scalar becomes historical money.
const USD_STEMS = new Set(['used', 'limit', 'remaining', 'realizedLoss', 'atRisk', 'outstanding', 'value', 'cost', 'packSpend', 'buyback', 'packGain', 'packLoss', 'protectedCosts', 'confirmedCosts', 'cycleGain', 'cycleLoss', 'outboundBridge', 'inboundBridge', 'collectorApi', 'evmNetwork', 'solanaNetwork', 'slippage', 'packPrice', 'totalCollectorSpend', 'totalBuybacksReturned', 'totalQuotedOperatingCosts', 'maxUnitPrice', 'maxCycleBudget', 'max24HourBudget']);
const WEI_STEMS = new Set(['walletBalanceBefore', 'walletBalanceAfter', 'feeReserveBefore', 'feeReserveTarget', 'feeReserveTopUp', 'feeReserveAfter', 'plannedHolderRewards', 'paidHolderRewards', 'payoutLiability', 'payoutDust', 'returned', 'spent', 'paid', 'latestObservedProjectPool', 'cycleStartProjectPool', 'totalCycleFunding', 'totalBridgedBack', 'totalRewardsPaid', 'totalRewardsDeferred', 'latestRetainedReserve', 'latestCycleReserveTarget', 'allocated']);
const integer = /^(0|[1-9][0-9]*)$/;
export const NATIVE_ROUND_SCHEMA = 'hookemon.native-round-accounting.v1';

export function nativeFieldName(historical) {
  if (!historical.endsWith('MicroUsdg')) return historical;
  const stem = historical.slice(0, -9);
  if (USD_STEMS.has(stem)) return `${stem}MicroUsd`;
  if (WEI_STEMS.has(stem)) return `${stem}Wei`;
  throw new TypeError('NATIVE_ACCOUNTING_FIELD_UNKNOWN');
}

export function nativeUnknownFields(historical) {
  return Object.fromEntries(Object.entries(historical).map(([key, value]) => [nativeFieldName(key), key.endsWith('MicroUsdg') ? null : value]));
}

function assertScalar(value, signed = false) {
  if (value === null) return;
  if (typeof value !== 'string' || !(signed ? /^-?(0|[1-9][0-9]*)$/ : integer).test(value) || value === '-0') throw new TypeError('NATIVE_ACCOUNTING_AMOUNT_INVALID');
}

export function assertNativeAmount(value) {
  if (value === null) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'assetId,chainId,decimals,units'
    || value.chainId !== '4663' || value.assetId !== 'native' || value.decimals !== 18) throw new TypeError('NATIVE_ACCOUNTING_ASSET_INVALID');
  assertScalar(value.units);
  if (value.units === null) throw new TypeError('NATIVE_ACCOUNTING_AMOUNT_INVALID');
}

export function nativeValidationSkeleton(value, context = "") {
  if (Array.isArray(value)) return value.map(item => nativeValidationSkeleton(item, context));
  if (value === null || typeof value !== 'object') return value;
  for (const [gainKey, lossKey] of [['packGainMicroUsd', 'packLossMicroUsd'], ['cycleGainMicroUsd', 'cycleLossMicroUsd']]) {
    if (Object.hasOwn(value, gainKey) || Object.hasOwn(value, lossKey)) {
      const gain = value[gainKey], loss = value[lossKey];
      if (!((gain === null && loss === null) || (gain !== null && loss !== null && (gain === '0' || loss === '0')))) throw new TypeError('NATIVE_ACCOUNTING_GAIN_LOSS_INVALID');
    }
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (['cycles', 'custody', 'alerts', 'onChainRemainingCapacity'].includes(key)) { result[key] = item; continue; }
    if (key.endsWith('MicroUsdg')) throw new TypeError('NATIVE_ACCOUNTING_LEGACY_FIELD');
    if (context === 'roundAccounting' && key === 'schema' && item === NATIVE_ROUND_SCHEMA) continue;
    if (context === 'roundAccounting' && key === 'releaseAmount') { assertNativeAmount(item); continue; }
    if (key === 'outboundBridgeDebit' || key === 'inboundBridgeProceeds') assertNativeAmount(item);
    const suffix = key.endsWith('MicroUsd') ? 'MicroUsd' : key.endsWith('Wei') ? 'Wei' : null;
    if (suffix) {
      const stem = key.slice(0, -suffix.length);
      if (!(suffix === 'Wei' ? WEI_STEMS : USD_STEMS).has(stem)) throw new TypeError('NATIVE_ACCOUNTING_FIELD_UNKNOWN');
      assertScalar(item, key === 'confirmedCostsMicroUsd');
      result[`${stem}MicroUsdg`] = item === null ? null : '0';
    } else result[key] = nativeValidationSkeleton(item, key);
  }
  return result;
}

export function requireNativeRound(value) {
  if (value !== null && (value?.schema !== NATIVE_ROUND_SCHEMA || !Object.hasOwn(value, 'releaseAmount'))) throw new TypeError('NATIVE_ACCOUNTING_SCHEMA_INVALID');
}

export function formatNativeAmount(value, decimals = 18, unit = 'ETH') {
  if (value === null || value === undefined) return 'Not confirmed';
  assertScalar(value, true);
  const negative = value.startsWith('-');
  const amount = BigInt(negative ? value.slice(1) : value);
  const scale = 10n ** BigInt(decimals);
  const whole = (amount / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const fraction = (amount % scale).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${negative ? '−' : ''}${whole}${fraction ? `.${fraction}` : ''} ${unit}`;
}
