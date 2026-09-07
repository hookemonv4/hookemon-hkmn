const MAX_UINT256 = (1n << 256n) - 1n;
const fields = [
  'availableProcessUsdg',
  'packPriceUsdg',
  'outboundCapUsdg',
  'returnCapUsdg',
  'operatingMarginUsdg',
  'activeCycleId',
];

function parseAtomicUsdg(value, label, { positive = false } = {}) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) {
    throw new Error(`${label} must be a canonical unsigned decimal string`);
  }
  const amount = BigInt(value);
  if (amount > MAX_UINT256) throw new Error(`${label} exceeds uint256`);
  if (positive && amount === 0n) throw new Error(`${label} must be positive`);
  return amount;
}

/**
 * Decides whether a new cycle may open and, when it may, what USDG principal it is opened for.
 *
 * With `admittedAggregateFundingUsdg` supplied -- the origin input of the cycle's own N-quantity
 * EXACT_OUTPUT Relay quote -- that quoted amount *is* the required and released principal. Relay
 * has already priced its own fee into that origin amount, so nothing here may add to it: the
 * static pack/outbound/return/margin figures below are configuration, not a contemporaneous price,
 * and adding them would authorize spending beyond the amount actually quoted. They are still
 * parsed, because a configuration that cannot even fund the quote is a real refusal, but they never
 * raise the release amount.
 *
 * Without an admission (rehearsal and other non-quote-bound callers) the legacy static sum is kept
 * unchanged.
 */
export function decideCycleBudget(input, { admittedAggregateFundingUsdg = null } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('cycle budget input must be a plain object');
  }
  if (Object.keys(input).length !== fields.length || !fields.every(field => Object.hasOwn(input, field))) {
    throw new Error('cycle budget input must use the exact schema');
  }
  if (input.activeCycleId !== null && (
    typeof input.activeCycleId !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/.test(input.activeCycleId)
  )) throw new Error('activeCycleId is invalid');

  const available = parseAtomicUsdg(input.availableProcessUsdg, 'availableProcessUsdg');
  const packPrice = parseAtomicUsdg(input.packPriceUsdg, 'packPriceUsdg', { positive: true });
  const outboundCap = parseAtomicUsdg(input.outboundCapUsdg, 'outboundCapUsdg');
  const returnCap = parseAtomicUsdg(input.returnCapUsdg, 'returnCapUsdg');
  const operatingMargin = parseAtomicUsdg(input.operatingMarginUsdg, 'operatingMarginUsdg');
  const staticRequired = packPrice + outboundCap + returnCap + operatingMargin;
  if (staticRequired > MAX_UINT256) throw new Error('required process budget overflow');
  const admitted = admittedAggregateFundingUsdg === null
    ? null
    : parseAtomicUsdg(admittedAggregateFundingUsdg, 'admittedAggregateFundingUsdg', { positive: true });
  const required = admitted === null ? staticRequired : admitted;

  const result = {
    ready: false,
    reason: input.activeCycleId === null ? 'INSUFFICIENT_PROCESS_LIABILITY' : 'ACTIVE_CYCLE',
    requiredProcessUsdg: required.toString(),
    releaseAmount: '0',
  };
  if (input.activeCycleId !== null || available < required) return result;
  return {
    ready: true,
    reason: 'READY',
    requiredProcessUsdg: required.toString(),
    releaseAmount: required.toString(),
  };
}
