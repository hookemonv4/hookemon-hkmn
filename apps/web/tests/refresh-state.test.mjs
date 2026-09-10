import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  describeRevisionConflict,
  mergeAuditEntries,
  reconcileConfigurationForm,
} from '../app/operator/refresh-state.mjs';

function state(version) {
  return { version, enabled: version % 2 === 0 };
}

test('clean configuration forms adopt fresh state and revision', () => {
  const fresh = state(3);
  const result = reconcileConfigurationForm({
    form: { enabled: false },
    baseSnapshot: '{"enabled":false}',
    freshState: fresh,
    freshSnapshot: '{"enabled":false}',
    formFromState: value => ({ enabled: value.enabled }),
    baseVersion: 2,
    formSnapshot: '{"enabled":false}',
  });
  assert.deepEqual(result, {
    form: { enabled: false },
    baseVersion: 3,
    externalChange: null,
  });

});

test('dirty forms preserve edits and only flag changed external snapshots', () => {
  const changed = reconcileConfigurationForm({
    form: { enabled: true },
    baseSnapshot: '{"enabled":false}',
    freshState: state(4),
    freshSnapshot: '{"enabled":true}',
    formFromState: value => ({ enabled: value.enabled }),
    baseVersion: 2,
    formSnapshot: '{"enabled":"edited"}',
  });
  assert.deepEqual(changed, {
    form: { enabled: true },
    baseVersion: 2,
    externalChange: { fromVersion: 2, toVersion: 4 },
  });

  const matchesFreshState = reconcileConfigurationForm({
    form: { enabled: true },
    baseSnapshot: '{"enabled":false}',
    freshState: state(4),
    freshSnapshot: '{"enabled":true}',
    formFromState: value => ({ enabled: value.enabled }),
    baseVersion: 2,
    formSnapshot: '{"enabled":true}',
  });
  assert.deepEqual(matchesFreshState, {
    form: { enabled: true },
    baseVersion: 4,
    externalChange: null,
  });
});

test('audit merge deduplicates, orders newest first, and preserves older pages', () => {
  assert.deepEqual(mergeAuditEntries(
    [{ sequence: '3', action: 'new' }, { sequence: '1', action: 'old' }],
    [{ sequence: '4', action: 'newest' }, { sequence: '3', action: 'replacement' }],
  ), [
    { sequence: '4', action: 'newest' },
    { sequence: '3', action: 'replacement' },
    { sequence: '1', action: 'old' },
  ]);
});

test('revision conflict description identifies both revisions', () => {
  assert.equal(
    describeRevisionConflict({ expectedVersion: 2, currentVersion: 5 }),
    'Revisionskonflikt: Befehl basierte auf Konfigurationsstand 2, aktueller Stand ist 5. Bitte Änderungen prüfen und erneut senden.',
  );
});
