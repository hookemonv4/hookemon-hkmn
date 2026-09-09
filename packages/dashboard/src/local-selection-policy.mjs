import { assertRewardRecipientLimit } from '../../runner/src/config/reward-recipient-selection.mjs';

// The disconnected local dashboard may persist selection settings, never execution controls.
export function assertLocalSelectionCommand(command, { configuration, catalogCodes = [] }) {
  if (configuration?.paused !== true || configuration.executionPaused !== true || configuration.liveMode !== false) {
    throw new Error('Local dashboard requires non-live, paused configuration');
  }
  const patch = command?.configuration;
  if (command?.type !== 'update-configuration' || !patch || typeof patch !== 'object' || Array.isArray(patch)
    || !['packPlan', 'rewardRecipientLimit'].some(key => Object.hasOwn(patch, key))
    || Object.keys(patch).some(key => !['packPlan', 'allowedPackIds', 'rewardRecipientLimit'].includes(key))) {
    throw new Error('Only local pack and reward recipient selections can be changed');
  }
  if (Object.hasOwn(patch, 'rewardRecipientLimit')) assertRewardRecipientLimit(patch.rewardRecipientLimit);
  if (!Object.hasOwn(patch, 'packPlan')) {
    if (Object.hasOwn(patch, 'allowedPackIds')) throw new Error('Allowlist changes require a pack selection');
    return;
  }
  const allowed = patch.allowedPackIds ?? configuration.allowedPackIds;
  if (!Array.isArray(allowed) || configuration.allowedPackIds.some(code => !allowed.includes(code))) {
    throw new Error('Local selection cannot remove safety allowlist entries');
  }
  const selected = patch.packPlan?.orders;
  const catalog = new Set(catalogCodes);
  if (!Array.isArray(selected) || selected.some(order => !catalog.has(order?.pack))) {
    throw new Error('Selection must use the current public catalog');
  }
  if (allowed.some(code => !configuration.allowedPackIds.includes(code) && !selected.some(order => order.pack === code))) {
    throw new Error('Only newly selected packs can be added to the local allowlist');
  }
}
