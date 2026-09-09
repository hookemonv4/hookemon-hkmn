import { assertPackPlan } from '../config/pack-plan.mjs';
import { canonicalJson, digest } from '../cycle/journal.mjs';

export const PACK_PLAN_SNAPSHOT_SCHEMA = 'hookemon.pack-plan-snapshot.v1';
const cycleIdPattern = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;

export function createPackPlanSnapshot({ cycleId, plan }) {
  if (typeof cycleId !== 'string' || !cycleIdPattern.test(cycleId)) {
    throw new Error('pack plan snapshot cycleId is invalid');
  }
  const payload = { schema: PACK_PLAN_SNAPSHOT_SCHEMA, cycleId, plan: assertPackPlan(plan) };
  return Object.freeze({ ...payload, digest: digest(payload) });
}

export function assertPackPlanSnapshot(value, { cycleId } = {}) {
  canonicalJson(value);
  const fields = ['schema', 'cycleId', 'plan', 'digest'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== fields.length
    || !fields.every(field => Object.hasOwn(value, field))) {
    throw new Error('pack plan snapshot must use the exact schema');
  }
  if (value.schema !== PACK_PLAN_SNAPSHOT_SCHEMA) throw new Error('pack plan snapshot schema is invalid');
  const snapshot = createPackPlanSnapshot(value);
  if (value.digest !== snapshot.digest) throw new Error('pack plan snapshot digest mismatch');
  if (cycleId !== undefined && snapshot.cycleId !== cycleId) throw new Error('pack plan snapshot cycleId mismatch');
  return snapshot;
}
