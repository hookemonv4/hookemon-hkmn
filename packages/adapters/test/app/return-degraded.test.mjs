import assert from 'node:assert/strict';
import test from 'node:test';

import { submitDegradedReturnAcceptance } from '../../src/app/stages/return.mjs';

test('submitDegradedReturnAcceptance is unavailable in the Phase 3 Operations model', async () => {
  await assert.rejects(
    () => submitDegradedReturnAcceptance(),
    /unavailable in the Phase 3 Operations model/,
  );
});
