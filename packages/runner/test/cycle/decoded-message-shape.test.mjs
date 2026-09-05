import assert from 'node:assert/strict';
import test from 'node:test';

import { assertDecodedMessageShape, DECODED_MESSAGE_FIELDS, encodeFixtureOnlyMessage, fixtureMessageForAction } from '../../src/cycle/decoder.mjs';
import { fixtureActionDigests } from '../../src/cycle/schemas.mjs';
import { fixtureCycleAction, fixtureCyclePreflight } from './fixture-cycle.mjs';

test('a fixture-mode decoded message satisfies the shared DecodedMessage field shape', () => {
  const preflight = fixtureCyclePreflight('cycle-decoded-shape');
  const action = fixtureCycleAction('outbound', 'cycle-decoded-shape', preflight.preflightDigest);
  const digests = fixtureActionDigests(action);
  const message = fixtureMessageForAction(action, { ...digests, approvalKey: `sha256:${'a'.repeat(64)}` });
  assert.doesNotThrow(() => assertDecodedMessageShape(message));
  assert.doesNotThrow(() => encodeFixtureOnlyMessage(message));
});

test('assertDecodedMessageShape rejects a message missing a required field, regardless of schema string', () => {
  const preflight = fixtureCyclePreflight('cycle-decoded-shape-missing');
  const action = fixtureCycleAction('outbound', 'cycle-decoded-shape-missing', preflight.preflightDigest);
  const digests = fixtureActionDigests(action);
  const message = fixtureMessageForAction(action, { ...digests, approvalKey: `sha256:${'a'.repeat(64)}` });
  const { memo, ...withoutMemo } = message;
  assert.throws(() => assertDecodedMessageShape(withoutMemo), /exact schema/i);
});

test('DECODED_MESSAGE_FIELDS is the exact field set a production decoder (WP-10) must produce', () => {
  assert.ok(Array.isArray(DECODED_MESSAGE_FIELDS));
  assert.ok(DECODED_MESSAGE_FIELDS.includes('actionDigest'));
  assert.ok(DECODED_MESSAGE_FIELDS.includes('approvalKey'));
  assert.ok(Object.isFrozen(DECODED_MESSAGE_FIELDS));
});
