export const MAX_RECOVERY_ATTEMPTS = 8;
export const PENDING_COMMAND_STORAGE_KEY = 'hookemon.operator.pending-command.v1';

/**
 * @typedef {object} CommandEnvelope
 * @property {string} requestId
 * @property {number} expectedVersion
 * @property {{ type: string }} command
 * @property {string} [note]
 */

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PLAIN_OBJECT = value => value !== null
  && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

export function buildCommandEnvelope({ command, expectedVersion, note, requestId }) {
  return {
    requestId,
    expectedVersion,
    command,
    ...(note ? { note } : {}),
  };
}

export function classifyDecisionOutcome({ status, body, requestId }) {
  const code = typeof body?.code === 'string' ? body.code : null;
  const replayed = body?.replayed === true;
  const receipt = body?.receipt;
  const durable = PLAIN_OBJECT(receipt)
    && typeof requestId === 'string' && receipt.requestId === requestId
    && Number.isSafeInteger(receipt.sequence) && receipt.sequence > 0
    && typeof receipt.eventId === 'string' && receipt.eventId.length > 0
    && /^sha256:[0-9a-f]{64}$/.test(receipt.commandDigest)
    && typeof receipt.action === 'string' && receipt.action.length > 0
    && Number.isSafeInteger(receipt.observedVersion) && receipt.observedVersion >= 0
    && receipt.resultCode === code && receipt.commandState === body.commandState;
  if (durable && receipt.commandState === 'APPLIED' && status === 200) {
    return { phase: 'success', code, replayed };
  }
  if (durable && receipt.commandState === 'REJECTED' && status === 409) {
    return { phase: 'failure', code, replayed };
  }
  if (durable && receipt.commandState === 'PREPARED') {
    return { phase: 'prepared', code, replayed };
  }
  return { phase: 'uncertain', code, replayed };
}

/** Reserve one recovery identity synchronously, including across rapid UI submissions. */
export function reservePendingCommand(storage, envelope) {
  const serialized = serializePendingCommand(envelope);
  const existing = storage.getItem(PENDING_COMMAND_STORAGE_KEY);
  if (existing !== null && existing !== serialized) {
    throw new Error('An unresolved command must be recovered before another command can be submitted');
  }
  storage.setItem(PENDING_COMMAND_STORAGE_KEY, serialized);
  return envelope;
}

export function nextRecoveryDelayMs(attempt) {
  return Math.min(1000 * (2 ** attempt), 15000);
}

export function serializePendingCommand(envelope) {
  return JSON.stringify(envelope);
}

export function parsePendingCommand(text) {
  if (typeof text !== 'string') return null;
  try {
    const value = JSON.parse(text);
    if (!PLAIN_OBJECT(value)
      || typeof value.requestId !== 'string'
      || !REQUEST_ID_PATTERN.test(value.requestId)
      || !Number.isSafeInteger(value.expectedVersion)
      || !PLAIN_OBJECT(value.command)
      || typeof value.command.type !== 'string') return null;
    if (value.note !== undefined && typeof value.note !== 'string') return null;
    return value;
  } catch {
    return null;
  }
}
