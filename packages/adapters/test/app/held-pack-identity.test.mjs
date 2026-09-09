import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileLiveOpen } from '../../src/app/stages/open.mjs';
import {
  existingHeldPackOutcome,
  heldPackIdForMemo,
} from '../../src/app/stages/held-pack.mjs';

function planRepository({ requests, admission }) {
  return {
    async describeCycle() {
      return { admission };
    },
    async readPackOrderRequest(_cycleId, orderIndex) {
      return requests.get(orderIndex) ?? null;
    },
  };
}

test('resolves mixed plan order pack identities from each memo-bound request', async () => {
  const admission = {
    schema: 'hookemon.policy-admission.v4',
    orders: [
      { orderIndex: 0, packId: 'base-pack', quantity: 1 },
      { orderIndex: 1, packId: 'premium-pack', quantity: 1 },
    ],
  };
  const repository = planRepository({
    admission,
    requests: new Map([
      [0, { packs: [{ packIndex: 0, memo: 'memo-0', packType: 'base-pack' }] }],
      [1, { packs: [{ packIndex: 1, memo: 'memo-1', packType: 'premium-pack' }] }],
    ]),
  });

  assert.equal(await heldPackIdForMemo({
    cycleRepository: repository,
    cycleId: 'cycle-plan',
    memo: 'memo-1',
    config: { pack: { code: 'wrong-config-pack' } },
  }), 'premium-pack');
  assert.equal(await heldPackIdForMemo({
    cycleRepository: repository,
    cycleId: 'cycle-plan',
    memo: 'memo-0',
    config: { pack: { code: 'wrong-config-pack' } },
  }), 'base-pack');
});

test('falls back from a plan request null packType to its admitted order packId', async () => {
  const repository = planRepository({
    admission: {
      schema: 'hookemon.policy-admission.v4',
      orders: [{ orderIndex: 0, packId: 'admitted-pack', quantity: 1 }],
    },
    requests: new Map([[0, { packs: [{ packIndex: 0, memo: 'memo-0', packType: null }] }]]),
  });

  assert.equal(await heldPackIdForMemo({
    cycleRepository: repository,
    cycleId: 'cycle-plan',
    memo: 'memo-0',
    config: { pack: { code: 'wrong-config-pack' } },
  }), 'admitted-pack');
});

test('resolves a legacy batch packType and rejects disagreement with its admission', async () => {
  const repository = {
    async describeCycle() {
      return { admission: { schema: 'hookemon.policy-admission.v3', packId: 'admitted-pack' } };
    },
    async readPackBatchRequest() {
      return { packs: [{ packIndex: 0, memo: 'memo-0', packType: 'recorded-pack' }] };
    },
  };

  await assert.rejects(
    () => heldPackIdForMemo({ cycleRepository: repository, cycleId: 'cycle-legacy', memo: 'memo-0', config: {} }),
    /conflicting durable pack identities.*memo-0/,
  );
  assert.equal(await heldPackIdForMemo({
    cycleRepository: {
      async describeCycle() {
        return { admission: { schema: 'hookemon.policy-admission.v3', packId: null } };
      },
      async readPackBatchRequest() {
        return { packs: [{ packIndex: 0, memo: 'memo-0', packType: 'recorded-pack' }] };
      },
    },
    cycleId: 'cycle-legacy',
    memo: 'memo-0',
    config: { pack: { code: 'wrong-config-pack' } },
  }), 'recorded-pack');
});

test('uses legacy config.pack.code only when no durable pack identity exists', async () => {
  const repository = {
    async describeCycle() {
      return { admission: { schema: 'hookemon.policy-admission.v3' } };
    },
    async readPackBatchRequest() {
      return null;
    },
  };

  assert.equal(await heldPackIdForMemo({
    cycleRepository: repository,
    cycleId: 'cycle-fallback',
    memo: 'memo-0',
    config: { pack: { code: 'legacy-config-pack' } },
  }), 'legacy-config-pack');
  await assert.rejects(
    () => heldPackIdForMemo({
      cycleRepository: repository,
      cycleId: 'cycle-fallback',
      memo: 'memo-0',
      config: {},
    }),
    /held card attribution requires a durable pack identity for memo memo-0/,
  );
});

test('rejects disagreement between a plan request packType and admitted order packId', async () => {
  const repository = planRepository({
    admission: {
      schema: 'hookemon.policy-admission.v4',
      orders: [{ orderIndex: 0, packId: 'admitted-pack', quantity: 1 }],
    },
    requests: new Map([[0, { packs: [{ packIndex: 0, memo: 'memo-0', packType: 'recorded-pack' }] }]]),
  });

  await assert.rejects(
    () => heldPackIdForMemo({ cycleRepository: repository, cycleId: 'cycle-plan', memo: 'memo-0', config: {} }),
    /conflicting durable pack identities.*memo-0/,
  );
});

test('returns the held outcome shape for unresolved or resolved positions', async () => {
  const position = {
    positionId: 'held:position-0',
    cycleId: 'cycle-held',
    memo: 'memo-0',
    mint: 'mint-0',
    terminalState: 'HELD_UNRESOLVED',
    reason: 'SENT_UNKNOWN_DEADLINE',
    evidenceDigest: `sha256:${'a'.repeat(64)}`,
    resolution: { terminalState: 'SOLD' },
  };
  const repository = {
    async listHeldPositions(input) {
      assert.deepEqual(input, { cycleId: 'cycle-held', includeResolved: true });
      return [position];
    },
  };

  assert.deepEqual(await existingHeldPackOutcome({
    cycleRepository: repository,
    cycleId: 'cycle-held',
    memo: 'memo-0',
    packIndex: 3,
  }), {
    packIndex: 3,
    memo: 'memo-0',
    expectedCardCount: 1,
    mint: 'mint-0',
    decision: 'held',
    terminalState: 'HELD_UNRESOLVED',
    reason: 'SENT_UNKNOWN_DEADLINE',
    heldPosition: {
      positionId: 'held:position-0',
      evidenceDigest: `sha256:${'a'.repeat(64)}`,
      terminalState: 'HELD_UNRESOLVED',
      reason: 'SENT_UNKNOWN_DEADLINE',
    },
  });
  assert.equal(await existingHeldPackOutcome({
    cycleRepository: repository,
    cycleId: 'cycle-held',
    memo: 'missing',
    packIndex: 3,
  }), null);
  assert.equal(await existingHeldPackOutcome({
    cycleRepository: {},
    cycleId: 'cycle-held',
    memo: 'memo-0',
    packIndex: 3,
  }), null);
});

test('open hold attribution uses the persisted purchase batch packType over configuration', async () => {
  let recorded = null;
  const cycleRepository = {
    async readStage(_cycleId, stage) {
      assert.equal(stage, 'purchase');
      return {
        status: 'COMPLETE',
        evidence: {
          packs: [{ packIndex: 0, memo: 'memo-0', status: 'purchased', expectedCardCount: 1 }],
        },
      };
    },
    async readPackBatchIntent() {
      return { intent: { playerAddress: 'PLAYER' } };
    },
    async readOperationalStageAttempt() {
      return { attempt: { state: 'SENT_UNKNOWN' }, sentAtMs: 0, responseEvidence: null };
    },
    async readPackBatchRequest() {
      return { packs: [{ packIndex: 0, memo: 'memo-0', expectedCardCount: 1, packType: 'persisted-pack' }] };
    },
    async describeCycle() {
      return {
        admission: { schema: 'hookemon.policy-admission.v3', aggregateFundingUsd: { amountMicroUsd: '100' } },
      };
    },
    async recordHeldPosition(_cycleId, input) {
      recorded = input;
      return {
        positionId: 'held:position-0',
        evidenceDigest: `sha256:${'b'.repeat(64)}`,
        terminalState: input.terminalState,
        reason: input.reason,
      };
    },
  };

  const result = await reconcileLiveOpen({
    adapters: {
      collectorCrypt: { async getPackStatus() { return { memo: 'different-memo', send: null }; } },
      solana: { client: {} },
    },
    config: { pack: { code: 'wrong-config-pack' } },
    cycleRepository,
    context: { cycleId: 'cycle-held', nowMs: 0 },
  });

  assert.equal(result.packs[0].decision, 'held');
  assert.equal(recorded.packId, 'persisted-pack');
});
