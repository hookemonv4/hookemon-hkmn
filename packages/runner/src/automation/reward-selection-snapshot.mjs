import { createHash } from 'node:crypto';
import { assertRewardRecipientLimit } from '../config/reward-recipient-selection.mjs';
export const REWARD_SELECTION_SNAPSHOT_SCHEMA = 'hookemon.reward-selection-snapshot.v1';
const INPUT_FIELDS = ['cycleId', 'configurationRevision', 'rewardRecipientLimit'];
function exact(value, fields) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) throw new Error('reward selection snapshot must be a plain object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== fields.length || !fields.every(key => descriptors[key]?.enumerable && Object.hasOwn(descriptors[key], 'value'))) throw new Error('reward selection snapshot must use the exact schema');
}
function payload(value) {
  if (typeof value.cycleId !== 'string' || !value.cycleId.trim()) throw new Error('reward selection snapshot cycleId is invalid');
  if (!Number.isSafeInteger(value.configurationRevision) || value.configurationRevision < 0) throw new Error('reward selection snapshot configurationRevision is invalid');
  return { schema: REWARD_SELECTION_SNAPSHOT_SCHEMA, cycleId: value.cycleId, configurationRevision: value.configurationRevision, rewardRecipientLimit: assertRewardRecipientLimit(value.rewardRecipientLimit) };
}
function digest(value) {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
  return `sha256:${createHash('sha256').update(REWARD_SELECTION_SNAPSHOT_SCHEMA).update('\n').update(canonical).digest('hex')}`;
}
export function createRewardSelectionSnapshot(value) {
  exact(value, INPUT_FIELDS);
  const content = payload(value);
  return Object.freeze({ ...content, digest: digest(content) });
}
export function assertRewardSelectionSnapshot(value, { cycleId } = {}) {
  exact(value, ['schema', ...INPUT_FIELDS, 'digest']);
  const content = payload(value);
  if (value.schema !== REWARD_SELECTION_SNAPSHOT_SCHEMA || value.digest !== digest(content)) throw new Error('reward selection snapshot digest or schema mismatch');
  if (cycleId !== undefined && value.cycleId !== cycleId) throw new Error('reward selection snapshot cycleId mismatch');
  return value;
}
