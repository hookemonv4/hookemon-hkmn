const HELD_POSITION_ID = /^held:[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const SETTLEMENT_STATES = new Set([
  'PREPARED',
  'BUYBACK_SENT_UNKNOWN',
  'RETURN_BROADCAST',
  'PAYOUT_BROADCAST',
]);

function fail(message) {
  throw new Error(`supplementary settlement dispatch: ${message}`);
}

function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is invalid`);
  return value;
}

/**
 * Validates the immutable relationship between a held position and the supplementary settlement
 * that may act on it. Provider-specific handlers own their durable write-ahead boundaries; the
 * dispatcher owns only discovery, identity binding, and lease fencing.
 */
function assertSupplementarySettlementIdentity(positionValue, settlementValue) {
  const position = object(positionValue, 'position');
  const settlement = object(settlementValue, 'settlement');
  if (typeof position.positionId !== 'string' || !HELD_POSITION_ID.test(position.positionId)) {
    fail('positionId is invalid');
  }
  if (typeof position.cycleId !== 'string' || position.cycleId.length === 0) fail('position cycleId is invalid');
  if (position.ownerDecision?.choice !== 'sell') fail('position does not have a sell decision');
  if (position.resolution !== null) fail('position is already resolved');
  if (typeof position.evidenceDigest !== 'string' || !DIGEST.test(position.evidenceDigest)) {
    fail('position evidenceDigest is invalid');
  }
  if (settlement.positionId !== position.positionId || settlement.cycleId !== position.cycleId
    || settlement.positionEvidenceDigest !== position.evidenceDigest) {
    fail('settlement does not bind the held position');
  }
  if (typeof settlement.manifestId !== 'string' || !settlement.manifestId.startsWith(`${position.cycleId}:supplementary:`)) {
    fail('settlement manifestId is invalid');
  }
  return Object.freeze({
    position: Object.freeze(structuredClone(position)),
    settlement: Object.freeze(structuredClone(settlement)),
  });
}

export function assertSupplementarySettlementDispatch(positionValue, settlementValue) {
  const checked = assertSupplementarySettlementIdentity(positionValue, settlementValue);
  if (!SETTLEMENT_STATES.has(checked.settlement.state)) fail('settlement state is not dispatchable');
  return checked;
}

/** Validates a handler result without admitting a terminal settlement for another dispatch. */
export function assertSupplementarySettlementResult(positionValue, previous, settlementValue) {
  const checked = assertSupplementarySettlementIdentity(positionValue, settlementValue);
  const { settlement } = checked;
  if (!SETTLEMENT_STATES.has(settlement.state)
    && !(settlement.state === 'COMPLETE' && ['RETURN_BROADCAST', 'PAYOUT_BROADCAST'].includes(previous.state))) {
    fail('settlement result state is invalid');
  }
  for (const key of ['manifestId', 'eligibilitySnapshotEvidenceDigest']) {
    if (settlement[key] !== previous[key]) fail('settlement identity changed during reconciliation');
  }
  if (previous.payoutSourceDigest != null && settlement.payoutSourceDigest !== previous.payoutSourceDigest) {
    fail('settlement payout source identity changed during reconciliation');
  }
  return checked;
}
