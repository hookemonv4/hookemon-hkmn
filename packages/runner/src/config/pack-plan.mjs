import { canonicalJson } from '../cycle/journal.mjs';
import { MAXIMUM_PACK_BATCH_SIZE } from '../cycle/money-schemas.mjs';

export const PACK_PLAN_SCHEMA = 'hookemon.pack-plan.v1';
export const MAX_PACK_PLAN_ORDERS = MAXIMUM_PACK_BATCH_SIZE;
const packCodePattern = /^[a-z0-9][a-z0-9_-]{1,63}$/;

function exactObject(value, fields, label) {
  canonicalJson(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== fields.length
    || !fields.every(field => Object.hasOwn(value, field))) {
    throw new Error(`${label} must use the exact schema`);
  }
}

// Quantities count unit purchases; they never authorize a bulk Collector binding.
export function assertPackPlan(value) {
  exactObject(value, ['schema', 'revision', 'orders'], 'pack plan');
  if (value.schema !== PACK_PLAN_SCHEMA) throw new Error('pack plan schema is invalid');
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) throw new Error('pack plan revision is invalid');
  if (!Array.isArray(value.orders)) throw new Error('pack plan orders must be an array');
  let previous = null;
  let total = 0;
  const orders = value.orders.map(order => {
    exactObject(order, ['pack', 'quantity'], 'pack plan order');
    if (typeof order.pack !== 'string' || !packCodePattern.test(order.pack)) throw new Error('pack plan pack is invalid');
    if (previous !== null && order.pack <= previous) throw new Error('pack plan orders must be unique and sorted');
    if (!Number.isSafeInteger(order.quantity) || order.quantity < 1 || order.quantity > MAX_PACK_PLAN_ORDERS) {
      throw new Error('pack plan quantity is invalid');
    }
    previous = order.pack;
    total += order.quantity;
    if (total > MAX_PACK_PLAN_ORDERS) throw new Error('pack plan total quantity exceeds the hard cap');
    return Object.freeze({ pack: order.pack, quantity: order.quantity });
  });
  return Object.freeze({ schema: PACK_PLAN_SCHEMA, revision: value.revision, orders: Object.freeze(orders) });
}

export function createEmptyPackPlan() {
  return assertPackPlan({ schema: PACK_PLAN_SCHEMA, revision: 0, orders: [] });
}

export function replacePackPlan(current, orders) {
  const base = assertPackPlan(current);
  const candidate = assertPackPlan({ schema: PACK_PLAN_SCHEMA, revision: base.revision, orders });
  if (canonicalJson(base.orders) === canonicalJson(candidate.orders)) return base;
  return assertPackPlan({ ...candidate, revision: base.revision + 1 });
}

// Checkbox selection preserves an existing explicit quantity, defaulting new packs to one.
export function packPlanFromSelection(codes, current = createEmptyPackPlan()) {
  const base = assertPackPlan(current);
  canonicalJson(codes);
  if (!Array.isArray(codes) || codes.some(code => typeof code !== 'string' || !packCodePattern.test(code))) {
    throw new Error('pack plan selection is invalid');
  }
  const quantities = new Map(base.orders.map(order => [order.pack, order.quantity]));
  const orders = [...new Set(codes)].sort().map(pack => ({ pack, quantity: quantities.get(pack) ?? 1 }));
  return replacePackPlan(base, orders);
}
