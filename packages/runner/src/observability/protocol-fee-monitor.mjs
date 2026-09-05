// Protocol-fee-brick detection on the canonical pool (design section 3.7): `CanonicalMarket._matches`
// re-checks `StateLibrary.getSlot0`'s protocol-fee field on every swap and reverts the moment it is
// nonzero — correct, fail-closed contract behavior, but a real, external, governance-controlled brick
// risk with no on-chain remedy, and (before this module) nothing watching for it. This module is the
// watch: given the protocol-fee field from a pool-state read, it fires the same alert-webhook path
// (alert-webhook.mjs) used for DEGRADED/FAILED cycle transitions the instant that field goes nonzero,
// deduplicated so a governance-set nonzero fee pages once, not once per remaining scheduler tick.
//
// Deliberately reads no chain state itself. The design's stated mechanism is "poll
// StateLibrary.getSlot0's protocol-fee field for the canonical pool on every scheduler tick,
// piggybacking on the existing budget-gate pool-state read, no extra RPC call" — i.e. this monitor is
// meant to observe a pool-state value some other part of the tick already fetched, never to issue its
// own RPC call. No merged work package currently wires a live RPC-backed pool-state read into the
// scheduler tick (budget-gate.mjs's `decideCycleBudget` takes an already-resolved USDG-amount input,
// not a chain read), so this module exposes the seam (`observe(poolState)`) ready for whichever future
// package adds that live read to call once per tick, rather than inventing a call site of its own.
import { buildAlert, createTransitionDeduper } from './alert-webhook.mjs';

const decimalPattern = /^(0|[1-9][0-9]*)$/;

function normalizeProtocolFee(value) {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new Error('protocol fee must be nonnegative');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('protocol fee must be a nonnegative safe integer');
    return BigInt(value);
  }
  if (typeof value === 'string' && decimalPattern.test(value)) return BigInt(value);
  throw new Error('protocol fee must be a bigint, a nonnegative safe integer, or a canonical unsigned decimal string');
}

/**
 * Build a protocol-fee monitor for one canonical pool.
 *
 * @param {object} options
 * @param {string} options.poolId - an opaque identifier for the canonical pool (e.g. its PoolId hex
 *   string), carried in every alert's `detail` and used to key the dedupe tracker so a future multi-pool
 *   deployment could run one monitor instance per pool without their alerts colliding.
 * @param {(alert: object) => Promise<object>} options.send - typically `createAlertWebhook(...).send`
 *   from alert-webhook.mjs.
 * @param {{error: Function}} [options.logger] - optional; logs once per alert fired, mirroring
 *   alert-webhook.mjs's own delivery-failure logging (see observability/logger.mjs's `createLogger`).
 * @param {ReturnType<import('./alert-webhook.mjs').createTransitionDeduper>} [options.deduper] -
 *   defaults to a fresh, private deduper. Inject a shared one only if a caller deliberately wants this
 *   monitor's dedupe state to interact with another consumer's — ordinary use needs no override.
 */
export function createProtocolFeeMonitor(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('protocol fee monitor options must be an object');
  const { poolId, send, readPoolState = null, logger = null, deduper = createTransitionDeduper() } = options;
  if (typeof poolId !== 'string' || poolId.length === 0) throw new Error('protocol fee monitor poolId must be a nonempty string');
  if (typeof send !== 'function') throw new Error('protocol fee monitor send must be a function');
  if (readPoolState !== null && typeof readPoolState !== 'function') throw new Error('protocol fee monitor readPoolState must be a function');
  if (logger !== null && typeof logger.error !== 'function') throw new Error('protocol fee monitor logger.error must be a function');

  const alertKey = `protocol-fee:${poolId}`;

  return Object.freeze({
    poolId,

    /** Read and normalize both fee fields without emitting an alert. The pre-signature canary owns
     * alerting for this path so one observed drift produces one alert through the shared sink. */
    async read() {
      if (readPoolState === null) throw new Error('protocol fee monitor read requires readPoolState');
      const poolState = await readPoolState(poolId);
      if (!poolState || typeof poolState !== 'object' || Array.isArray(poolState)) {
        throw new Error('protocol fee monitor read requires a pool-state object');
      }
      return Object.freeze({
        protocolFee: normalizeProtocolFee(poolState.protocolFee),
        lpFee: normalizeProtocolFee(poolState.lpFee),
      });
    },

    /**
     * Observe one tick's pool-state read. `poolState.protocolFee` is whatever
     * `StateLibrary.getSlot0`'s protocol-fee field decoded to for this pool on this tick.
     *
     * Returns `{fired, deduped, protocolFee}` (plus `alert`/`delivery` when `fired` is true) rather
     * than throwing on a nonzero fee — this is a monitor, not a guard, and reacting by throwing would
     * make the caller's tick loop itself brittle to the exact condition this module exists to report.
     */
    async observe(poolState) {
      if (!poolState || typeof poolState !== 'object' || Array.isArray(poolState)) {
        throw new Error('protocol fee monitor observe requires a pool-state object with a protocolFee field');
      }
      const fee = normalizeProtocolFee(poolState.protocolFee);
      if (fee === 0n) {
        // A fee that reads back to zero re-arms the alert: if governance later sets it nonzero again,
        // that is a fresh onset and must page again, not be silently swallowed by stale dedupe state.
        deduper.reset(alertKey);
        return Object.freeze({ fired: false, deduped: false, protocolFee: '0' });
      }
      if (!deduper.shouldFire(alertKey)) {
        return Object.freeze({ fired: false, deduped: true, protocolFee: fee.toString() });
      }
      const alert = buildAlert({
        reason: 'PROTOCOL_FEE_NONZERO',
        severity: 'critical',
        message: `canonical pool ${poolId} protocol fee went nonzero (${fee.toString()}); every swap will begin reverting`,
        detail: { poolId, protocolFee: fee.toString() },
      });
      logger?.error('protocol-fee-nonzero', { poolId, protocolFee: fee.toString() });
      const delivery = await send(alert);
      return Object.freeze({ fired: true, deduped: false, protocolFee: fee.toString(), alert, delivery });
    },
  });
}
