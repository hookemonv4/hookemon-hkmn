import { randomUUID } from "node:crypto";

import { createInitialOperatorState } from "./operator-control-policy.js";
import {
  ZERO_HASH,
  canonicalDecisionJson,
  clampLimit,
  evaluateSubmission,
  eventMatchesSubmission,
  hashDecisionEvent,
  hashValue,
  normalizeOptionalCursor,
  normalizeSequence,
  normalizeTimestamp,
  nullableVersion,
  plainObject,
  validateSubmission,
  versionNumber,
  verifyDecisionChain,
} from "./operator-control-decision.js";

export { canonicalDecisionJson, verifyDecisionChain };

export const OPERATOR_CONTROL_MIGRATION = `
CREATE TABLE IF NOT EXISTS hookemon_operator_state (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  version bigint NOT NULL CHECK (version >= 0),
  payload jsonb NOT NULL,
  last_event_sequence bigint,
  last_event_hash text NOT NULL CHECK (last_event_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS hookemon_operator_decisions (
  sequence bigserial PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  request_id uuid NOT NULL UNIQUE,
  occurred_at timestamptz NOT NULL,
  actor_issuer text NOT NULL,
  actor_subject text NOT NULL,
  actor_email text NOT NULL,
  actor_role text NOT NULL CHECK (actor_role IN ('viewer', 'operator')),
  action text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'rejected')),
  result_code text NOT NULL,
  expected_version bigint,
  observed_version bigint NOT NULL,
  proposal jsonb NOT NULL,
  before_state jsonb NOT NULL,
  after_state jsonb,
  note text,
  previous_hash text NOT NULL CHECK (previous_hash ~ '^[0-9a-f]{64}$'),
  event_hash text NOT NULL UNIQUE CHECK (event_hash ~ '^[0-9a-f]{64}$')
);

CREATE TABLE IF NOT EXISTS hookemon_operator_catalog_cache (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  fetched_at timestamptz NOT NULL,
  payload jsonb NOT NULL,
  stored_at timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION reject_hookemon_operator_decision_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  RAISE EXCEPTION 'HOOKEMON_OPERATOR_DECISIONS_IMMUTABLE';
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'hookemon_operator_decisions_immutable'
  ) THEN
    CREATE TRIGGER hookemon_operator_decisions_immutable
    BEFORE UPDATE OR DELETE ON hookemon_operator_decisions
    FOR EACH ROW EXECUTE FUNCTION reject_hookemon_operator_decision_mutation();
  END IF;
END $$;
`;

export class PostgresOperatorControlStore {
  constructor({ pool }) {
    if (!pool?.query || !pool?.connect) throw new TypeError("OPERATOR_CONTROL_POOL_INVALID");
    this.pool = pool;
  }

  async initialize() {
    try {
      await this.pool.query(OPERATOR_CONTROL_MIGRATION);
      const initial = createInitialOperatorState();
      await this.pool.query(
        `INSERT INTO hookemon_operator_state
           (singleton, version, payload, last_event_sequence, last_event_hash)
         VALUES (true, 0, $1, NULL, '${ZERO_HASH}')
         ON CONFLICT (singleton) DO NOTHING`,
        [initial],
      );
    } catch {
      throw new Error("OPERATOR_CONTROL_MIGRATION_FAILED");
    }
  }

  async readState() {
    try {
      const result = await this.pool.query(
        "SELECT payload FROM hookemon_operator_state WHERE singleton = true",
      );
      const payload = result?.rows?.[0]?.payload;
      if (!plainObject(payload)) throw new Error("missing state");
      return structuredClone(payload);
    } catch {
      throw new Error("OPERATOR_CONTROL_STATE_READ_FAILED");
    }
  }

  async submitDecision(submission) {
    const input = validateSubmission(submission);
    const client = await this.#connect();
    try {
      await client.query("BEGIN");
      const stateResult = await client.query(
        `SELECT payload, last_event_sequence, last_event_hash
         FROM hookemon_operator_state
         WHERE singleton = true
         FOR UPDATE`,
      );
      const stateRow = stateResult?.rows?.[0];
      if (!plainObject(stateRow?.payload) || !hashValue(stateRow.last_event_hash)) {
        throw new Error("OPERATOR_CONTROL_STATE_INVALID");
      }
      const replayResult = await client.query(
        "SELECT * FROM hookemon_operator_decisions WHERE request_id = $1",
        [input.requestId],
      );
      if (replayResult?.rows?.[0]) {
        const event = rowToEvent(replayResult.rows[0]);
        if (!eventMatchesSubmission(event, input)) {
          throw new Error("OPERATOR_REQUEST_ID_COLLISION");
        }
        await client.query("COMMIT");
        return {
          event,
          state: structuredClone(event.afterState ?? event.beforeState),
          replayed: true,
        };
      }

      const beforeState = structuredClone(stateRow.payload);
      const policyResult = evaluateSubmission(input, beforeState);
      const afterState = policyResult.accepted ? policyResult.nextState : null;

      const sequenceResult = await client.query(
        "SELECT nextval(pg_get_serial_sequence('hookemon_operator_decisions', 'sequence')) AS sequence",
      );
      const timeResult = await client.query("SELECT clock_timestamp() AS occurred_at");
      const sequence = normalizeSequence(sequenceResult?.rows?.[0]?.sequence);
      const occurredAt = normalizeTimestamp(timeResult?.rows?.[0]?.occurred_at);
      const event = {
        sequence,
        eventId: randomUUID(),
        requestId: input.requestId,
        occurredAt,
        actor: structuredClone(input.actor),
        actorRole: input.role,
        action: typeof input.command.type === "string" ? input.command.type : "invalid",
        outcome: policyResult.accepted ? "accepted" : "rejected",
        resultCode: policyResult.code,
        expectedVersion: input.expectedVersion,
        observedVersion: beforeState.version,
        proposal: structuredClone(input.command),
        beforeState,
        afterState,
        note: input.note,
        previousHash: stateRow.last_event_hash,
      };
      event.eventHash = hashDecisionEvent(event);

      const inserted = await client.query(
        `INSERT INTO hookemon_operator_decisions (
           sequence, event_id, request_id, occurred_at,
           actor_issuer, actor_subject, actor_email, actor_role,
           action, outcome, result_code, expected_version, observed_version,
           proposal, before_state, after_state, note, previous_hash, event_hash
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
           $11, $12, $13, $14, $15, $16, $17, $18, $19
         )
         RETURNING *`,
        eventToParams(event),
      );
      const persistedEvent = rowToEvent(inserted?.rows?.[0]);
      const persistedState = policyResult.accepted ? policyResult.nextState : beforeState;
      if (policyResult.accepted) {
        await client.query(
          `UPDATE hookemon_operator_state
           SET version = (($1::jsonb)->>'version')::bigint, payload = $1::jsonb,
               last_event_sequence = $2, last_event_hash = $3
           WHERE singleton = true`,
          [persistedState, sequence, persistedEvent.eventHash],
        );
      } else {
        await client.query(
          `UPDATE hookemon_operator_state
           SET last_event_sequence = $1, last_event_hash = $2
           WHERE singleton = true`,
          [sequence, persistedEvent.eventHash],
        );
      }
      await client.query("COMMIT");
      return {
        event: persistedEvent,
        state: structuredClone(persistedState),
        replayed: false,
      };
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // Preserve the authoritative transaction failure.
      }
      if (error?.message === "OPERATOR_REQUEST_ID_COLLISION") throw error;
      throw new Error("OPERATOR_CONTROL_DECISION_FAILED");
    } finally {
      client.release();
    }
  }

  async listDecisions({ beforeSequence = null, limit = 50 } = {}) {
    const cursor = normalizeOptionalCursor(beforeSequence);
    const boundedLimit = clampLimit(limit);
    try {
      const result = await this.pool.query(
        `SELECT * FROM hookemon_operator_decisions
         WHERE ($1::bigint IS NULL OR sequence < $1::bigint)
         ORDER BY sequence DESC
         LIMIT $2`,
        [cursor, boundedLimit],
      );
      return (result?.rows ?? []).map(rowToEvent);
    } catch {
      throw new Error("OPERATOR_CONTROL_DECISIONS_READ_FAILED");
    }
  }

  async saveCatalog(catalog) {
    if (
      !plainObject(catalog) ||
      !Number.isSafeInteger(catalog.fetchedAtMs) ||
      catalog.fetchedAtMs < 0
    ) {
      throw new TypeError("OPERATOR_CATALOG_INVALID");
    }
    const payload = JSON.parse(canonicalDecisionJson(catalog));
    try {
      await this.pool.query(
        `INSERT INTO hookemon_operator_catalog_cache (singleton, fetched_at, payload)
         VALUES (true, to_timestamp($1 / 1000.0), $2::jsonb)
         ON CONFLICT (singleton) DO UPDATE
         SET fetched_at = EXCLUDED.fetched_at,
             payload = EXCLUDED.payload,
             stored_at = now()`,
        [catalog.fetchedAtMs, payload],
      );
    } catch {
      throw new Error("OPERATOR_CATALOG_SAVE_FAILED");
    }
  }

  async readCatalog() {
    try {
      const result = await this.pool.query(
        "SELECT payload FROM hookemon_operator_catalog_cache WHERE singleton = true",
      );
      const payload = result?.rows?.[0]?.payload;
      return payload === undefined ? null : structuredClone(payload);
    } catch {
      throw new Error("OPERATOR_CATALOG_READ_FAILED");
    }
  }

  async #connect() {
    try {
      return await this.pool.connect();
    } catch {
      throw new Error("OPERATOR_CONTROL_CONNECTION_FAILED");
    }
  }
}

function eventToParams(event) {
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
    event.proposal,
    event.beforeState,
    event.afterState,
    event.note,
    event.previousHash,
    event.eventHash,
  ];
}

function rowToEvent(row) {
  if (!plainObject(row)) throw new Error("OPERATOR_CONTROL_EVENT_INVALID");
  return {
    sequence: normalizeSequence(row.sequence),
    eventId: row.event_id,
    requestId: row.request_id,
    occurredAt: normalizeTimestamp(row.occurred_at),
    actor: {
      issuer: row.actor_issuer,
      subject: row.actor_subject,
      email: row.actor_email,
    },
    actorRole: row.actor_role,
    action: row.action,
    outcome: row.outcome,
    resultCode: row.result_code,
    expectedVersion: nullableVersion(row.expected_version),
    observedVersion: versionNumber(row.observed_version),
    proposal: structuredClone(row.proposal),
    beforeState: structuredClone(row.before_state),
    afterState: row.after_state === null ? null : structuredClone(row.after_state),
    note: row.note,
    previousHash: row.previous_hash,
    eventHash: row.event_hash,
  };
}
