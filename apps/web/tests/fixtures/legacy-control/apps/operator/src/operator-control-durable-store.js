import { randomUUID } from "node:crypto";

import { createInitialOperatorState } from "./operator-control-policy.js";
import {
  ZERO_HASH,
  canonicalDecisionJson,
  clampLimit,
  evaluateSubmission,
  eventMatchesSubmission,
  hashValue,
  hashDecisionEvent,
  normalizeOptionalCursor,
  normalizeSequence,
  normalizeTimestamp,
  nullableVersion,
  plainObject,
  validateSubmission,
  versionNumber,
} from "./operator-control-decision.js";

const DURABLE_OPERATOR_CONTROL_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS hookemon_operator_state (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     version INTEGER NOT NULL CHECK (version >= 0),
     payload TEXT NOT NULL,
     last_event_sequence INTEGER,
     last_event_hash TEXT NOT NULL CHECK (length(last_event_hash) = 64)
   )`,
  `CREATE TABLE IF NOT EXISTS hookemon_operator_decisions (
     sequence INTEGER PRIMARY KEY AUTOINCREMENT,
     event_id TEXT NOT NULL UNIQUE,
     request_id TEXT NOT NULL UNIQUE,
     occurred_at TEXT NOT NULL,
     actor_issuer TEXT NOT NULL,
     actor_subject TEXT NOT NULL,
     actor_email TEXT NOT NULL,
     actor_role TEXT NOT NULL CHECK (actor_role IN ('viewer', 'operator')),
     action TEXT NOT NULL,
     outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
     result_code TEXT NOT NULL,
     expected_version INTEGER,
     observed_version INTEGER NOT NULL,
     proposal TEXT NOT NULL,
     before_state TEXT NOT NULL,
     after_state TEXT,
     note TEXT,
     previous_hash TEXT NOT NULL CHECK (length(previous_hash) = 64),
     event_hash TEXT NOT NULL UNIQUE CHECK (length(event_hash) = 64)
   )`,
  `CREATE TABLE IF NOT EXISTS hookemon_operator_catalog_cache (
     singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
     fetched_at INTEGER NOT NULL,
     payload TEXT NOT NULL,
     stored_at TEXT NOT NULL
   )`,
  `CREATE TRIGGER IF NOT EXISTS hookemon_operator_decisions_immutable_update
   BEFORE UPDATE ON hookemon_operator_decisions
   FOR EACH ROW BEGIN
     SELECT RAISE(ABORT, 'HOOKEMON_OPERATOR_DECISIONS_IMMUTABLE');
   END`,
  `CREATE TRIGGER IF NOT EXISTS hookemon_operator_decisions_immutable_delete
   BEFORE DELETE ON hookemon_operator_decisions
   FOR EACH ROW BEGIN
     SELECT RAISE(ABORT, 'HOOKEMON_OPERATOR_DECISIONS_IMMUTABLE');
   END`,
];

export class DurableOperatorControlStore {
  constructor({ storage, now = () => new Date(), eventId = randomUUID }) {
    if (!storage?.sql?.exec || !storage?.transactionSync) {
      throw new TypeError("OPERATOR_CONTROL_STORAGE_INVALID");
    }
    if (typeof now !== "function" || typeof eventId !== "function") {
      throw new TypeError("OPERATOR_CONTROL_CLOCK_INVALID");
    }
    this.storage = storage;
    this.now = now;
    this.eventId = eventId;
  }

  initialize() {
    try {
      for (const statement of DURABLE_OPERATOR_CONTROL_SCHEMA) this.#exec(statement);
      this.#exec(
        `INSERT INTO hookemon_operator_state
           (singleton, version, payload, last_event_sequence, last_event_hash)
         VALUES (1, 0, ?, NULL, ?)
         ON CONFLICT (singleton) DO NOTHING`,
        canonicalDecisionJson(createInitialOperatorState()),
        ZERO_HASH,
      );
    } catch {
      throw new Error("OPERATOR_CONTROL_MIGRATION_FAILED");
    }
  }

  readState() {
    try {
      const row = this.#exec(
        "SELECT payload FROM hookemon_operator_state WHERE singleton = 1",
      )[0];
      const payload = parseJson(row?.payload);
      if (!plainObject(payload)) throw new Error("missing state");
      return structuredClone(payload);
    } catch {
      throw new Error("OPERATOR_CONTROL_STATE_READ_FAILED");
    }
  }

  submitDecision(submission) {
    const input = validateSubmission(submission);
    try {
      return this.storage.transactionSync(() => {
        const stateRow = this.#exec(
          `SELECT payload, last_event_sequence, last_event_hash
           FROM hookemon_operator_state WHERE singleton = 1`,
        )[0];
        const beforeState = parseJson(stateRow?.payload);
        if (!plainObject(beforeState) || !hashValue(stateRow?.last_event_hash)) {
          throw new Error("OPERATOR_CONTROL_STATE_INVALID");
        }
        const replayRow = this.#exec(
          "SELECT * FROM hookemon_operator_decisions WHERE request_id = ?",
          input.requestId,
        )[0];
        if (replayRow) {
          const event = durableRowToEvent(replayRow);
          if (!eventMatchesSubmission(event, input)) throw new Error("OPERATOR_REQUEST_ID_COLLISION");
          return {
            event,
            state: structuredClone(event.afterState ?? event.beforeState),
            replayed: true,
          };
        }

        const policyResult = evaluateSubmission(input, beforeState);
        const afterState = policyResult.accepted ? policyResult.nextState : null;
        const sequence = normalizeSequence(
          this.#exec("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM hookemon_operator_decisions")[0]
            .sequence,
        );
        const event = {
          sequence,
          eventId: this.eventId(),
          requestId: input.requestId,
          occurredAt: normalizeTimestamp(this.now()),
          actor: structuredClone(input.actor),
          actorRole: input.role,
          action: typeof input.command.type === "string" ? input.command.type : "invalid",
          outcome: policyResult.accepted ? "accepted" : "rejected",
          resultCode: policyResult.code,
          expectedVersion: input.expectedVersion,
          observedVersion: beforeState.version,
          proposal: structuredClone(input.command),
          beforeState: structuredClone(beforeState),
          afterState,
          note: input.note,
          previousHash: stateRow.last_event_hash,
        };
        event.eventHash = hashDecisionEvent(event);
        this.#exec(
          `INSERT INTO hookemon_operator_decisions (
             sequence, event_id, request_id, occurred_at,
             actor_issuer, actor_subject, actor_email, actor_role,
             action, outcome, result_code, expected_version, observed_version,
             proposal, before_state, after_state, note, previous_hash, event_hash
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ...durableEventParams(event),
        );
        const persistedState = policyResult.accepted ? policyResult.nextState : beforeState;
        if (policyResult.accepted) {
          this.#exec(
            `UPDATE hookemon_operator_state
             SET version = ?, payload = ?, last_event_sequence = ?, last_event_hash = ?
             WHERE singleton = 1`,
            persistedState.version,
            canonicalDecisionJson(persistedState),
            sequence,
            event.eventHash,
          );
        } else {
          this.#exec(
            `UPDATE hookemon_operator_state
             SET last_event_sequence = ?, last_event_hash = ? WHERE singleton = 1`,
            sequence,
            event.eventHash,
          );
        }
        return { event: structuredClone(event), state: structuredClone(persistedState), replayed: false };
      });
    } catch (error) {
      if (error?.message === "OPERATOR_REQUEST_ID_COLLISION") throw error;
      throw new Error("OPERATOR_CONTROL_DECISION_FAILED");
    }
  }

  listDecisions({ beforeSequence = null, limit = 50 } = {}) {
    const cursor = normalizeOptionalCursor(beforeSequence);
    const boundedLimit = clampLimit(limit);
    try {
      return this.#exec(
        `SELECT * FROM hookemon_operator_decisions
         WHERE (? IS NULL OR sequence < ?)
         ORDER BY sequence DESC LIMIT ?`,
        cursor,
        cursor,
        boundedLimit,
      ).map(durableRowToEvent);
    } catch {
      throw new Error("OPERATOR_CONTROL_DECISIONS_READ_FAILED");
    }
  }

  saveCatalog(catalog) {
    if (!plainObject(catalog) || !Number.isSafeInteger(catalog.fetchedAtMs) || catalog.fetchedAtMs < 0) {
      throw new TypeError("OPERATOR_CATALOG_INVALID");
    }
    const payload = canonicalDecisionJson(catalog);
    try {
      this.#exec(
        `INSERT INTO hookemon_operator_catalog_cache (singleton, fetched_at, payload, stored_at)
         VALUES (1, ?, ?, ?)
         ON CONFLICT (singleton) DO UPDATE
         SET fetched_at = excluded.fetched_at, payload = excluded.payload, stored_at = excluded.stored_at`,
        catalog.fetchedAtMs,
        payload,
        normalizeTimestamp(this.now()),
      );
    } catch {
      throw new Error("OPERATOR_CATALOG_SAVE_FAILED");
    }
  }

  readCatalog() {
    try {
      const row = this.#exec(
        "SELECT payload FROM hookemon_operator_catalog_cache WHERE singleton = 1",
      )[0];
      return row === undefined ? null : structuredClone(parseJson(row.payload));
    } catch {
      throw new Error("OPERATOR_CATALOG_READ_FAILED");
    }
  }

  #exec(sql, ...parameters) {
    const result = this.storage.sql.exec(sql, ...parameters);
    return result?.[Symbol.iterator] ? [...result] : [];
  }
}

function durableEventParams(event) {
  return [
    event.sequence,
    event.eventId,
    event.requestId,
    event.occurredAt,
    event.actor.issuer,
    event.actor.subject,
    event.actor.email,
    event.actorRole,
    event.action,
    event.outcome,
    event.resultCode,
    event.expectedVersion,
    event.observedVersion,
    canonicalDecisionJson(event.proposal),
    canonicalDecisionJson(event.beforeState),
    event.afterState === null ? null : canonicalDecisionJson(event.afterState),
    event.note,
    event.previousHash,
    event.eventHash,
  ];
}

function durableRowToEvent(row) {
  if (!plainObject(row)) throw new Error("OPERATOR_CONTROL_EVENT_INVALID");
  return {
    sequence: normalizeSequence(row.sequence),
    eventId: row.event_id,
    requestId: row.request_id,
    occurredAt: normalizeTimestamp(row.occurred_at),
    actor: { issuer: row.actor_issuer, subject: row.actor_subject, email: row.actor_email },
    actorRole: row.actor_role,
    action: row.action,
    outcome: row.outcome,
    resultCode: row.result_code,
    expectedVersion: nullableVersion(row.expected_version),
    observedVersion: versionNumber(row.observed_version),
    proposal: parseJson(row.proposal),
    beforeState: parseJson(row.before_state),
    afterState: row.after_state === null ? null : parseJson(row.after_state),
    note: row.note,
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
  };
}

function parseJson(value) {
  if (typeof value !== "string") throw new Error("OPERATOR_CONTROL_JSON_INVALID");
  return JSON.parse(value);
}
