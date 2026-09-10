/** Canonical next-cycle reward policy; missing historical policy never implies this default. */
export const REWARD_RECIPIENT_LIMIT_OPTIONS = Object.freeze([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]);
export const REWARD_RECIPIENT_LIMITS = REWARD_RECIPIENT_LIMIT_OPTIONS;
export const MAXIMUM_REWARD_RECIPIENT_LIMIT = 1000;
export const DEFAULT_REWARD_RECIPIENT_LIMIT = 200;
export function assertRewardRecipientLimit(value) {
  if (!Number.isInteger(value) || !REWARD_RECIPIENT_LIMIT_OPTIONS.includes(value)) {
    throw new Error('rewardRecipientLimit must be an integer from 100 through 1000 in increments of 100');
  }
  return value;
}
