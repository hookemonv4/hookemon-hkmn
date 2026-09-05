import { createHash } from "node:crypto";

import { applyOperatorDecision } from "./operator-control-policy.js";

export const ZERO_HASH = "0".repeat(64);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function canonicalDecisionJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function verifyDecisionChain(events) {
  try {
    if (!Array.isArray(events)) return false;
    const ordered = [...events].sort((left, right) => {
      const leftSequence = BigInt(left.sequence);
      const rightSequence = BigInt(right.sequence);
      return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : 0;
    });
    for (let index = 0; index < ordered.length; index += 1) {
      const event = ordered[index];
      if (!hashValue(event.previousHash) || !hashValue(event.eventHash)) return false;
      if (hashDecisionEvent(event) !== event.eventHash) return false;
      if (index > 0 && event.previousHash !== ordered[index - 1].eventHash) return false;
      if (index > 0 && event.sequence === ordered[index - 1].sequence) return false;
      if (index === 0 && event.sequence === "1" && event.previousHash !== ZERO_HASH) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function evaluateSubmission(input, state) {
  if (input.role !== "operator") {
    return { accepted: false, code: "OPERATOR_ROLE_REQUIRED", nextState: state };
  }
  if (input.expectedVersion !== state.version) {
    return { accepted: false, code: "OPERATOR_STATE_VERSION_CONFLICT", nextState: state };
  }
  return applyOperatorDecision({
    state,
    command: input.command,
    hardCaps: input.hardCaps,
    catalog: input.catalog,
    nowMs: input.nowMs,
  });
}

export function validateSubmission(submission) {
  if (!plainObject(submission) || !plainObject(submission.actor)) {
    throw new TypeError("OPERATOR_DECISION_SUBMISSION_INVALID");
  }
  const actor = submission.actor;
  for (const field of ["issuer", "subject", "email"]) {
    if (typeof actor[field] !== "string" || actor[field].length === 0 || actor[field].length > 512) {
      throw new TypeError("OPERATOR_DECISION_ACTOR_INVALID");
    }
  }
  if (!new Set(["viewer", "operator"]).has(submission.role)) {
    throw new TypeError("OPERATOR_DECISION_ROLE_INVALID");
  }
  if (typeof submission.requestId !== "string" || !UUID_PATTERN.test(submission.requestId)) {
    throw new TypeError("OPERATOR_DECISION_REQUEST_ID_INVALID");
  }
  if (!Number.isSafeInteger(submission.expectedVersion) || submission.expectedVersion < 0) {
    throw new TypeError("OPERATOR_DECISION_EXPECTED_VERSION_INVALID");
  }
  if (!Number.isSafeInteger(submission.nowMs) || submission.nowMs < 0) {
    throw new TypeError("OPERATOR_DECISION_TIME_INVALID");
  }
  if (
    submission.note !== undefined &&
    submission.note !== null &&
    (typeof submission.note !== "string" || submission.note.length > 500)
  ) {
    throw new TypeError("OPERATOR_DECISION_NOTE_INVALID");
  }
  canonicalDecisionJson(submission.command);
  return {
    ...submission,
    actor: {
      issuer: actor.issuer,
      subject: actor.subject,
      email: actor.email,
    },
    command: JSON.parse(canonicalDecisionJson(submission.command)),
    note: submission.note ?? null,
  };
}

export function eventMatchesSubmission(event, input) {
  return (
    event.requestId === input.requestId &&
    event.actor.issuer === input.actor.issuer &&
    event.actor.subject === input.actor.subject &&
    event.actor.email === input.actor.email &&
    event.actorRole === input.role &&
    event.expectedVersion === input.expectedVersion &&
    event.note === input.note &&
    canonicalDecisionJson(event.proposal) === canonicalDecisionJson(input.command)
  );
}

export function hashDecisionEvent(event) {
  const { eventHash: _eventHash, ...hashable } = event;
  return createHash("sha256").update(canonicalDecisionJson(hashable)).digest("hex");
}

export function normalizeTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("OPERATOR_CONTROL_TIMESTAMP_INVALID");
  return date.toISOString();
}

export function normalizeSequence(value) {
  const sequence = String(value);
  if (!/^[1-9]\d*$/.test(sequence)) throw new Error("OPERATOR_CONTROL_SEQUENCE_INVALID");
  return sequence;
}

export function normalizeOptionalCursor(value) {
  if (value === null || value === undefined) return null;
  return normalizeSequence(value);
}

export function clampLimit(value) {
  const numeric = Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 50;
  return Math.min(100, Math.max(1, numeric));
}

export function nullableVersion(value) {
  return value === null || value === undefined ? null : versionNumber(value);
}

export function versionNumber(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) {
    throw new Error("OPERATOR_CONTROL_VERSION_INVALID");
  }
  return number;
}

export function plainObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}

export function hashValue(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function canonicalValue(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (plainObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalValue(value[key])]),
    );
  }
  throw new TypeError("OPERATOR_CANONICAL_JSON_INVALID");
}
