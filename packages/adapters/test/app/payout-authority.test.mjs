import assert from 'node:assert/strict';
import test from 'node:test';

import { mutatePayout, probePayout } from '../../src/app/stages/payout.mjs';

const ADDRESS = `0x${'a'.repeat(40)}`;

function configuredPayout() {
  const broadcasts = [];
  const signerCalls = [];
  return {
    adapters: {
      robinhood: {
        client: {
          async sendRawTransaction(request) {
            broadcasts.push(request);
            return `0x${'b'.repeat(64)}`;
          },
        },
      },
    },
    broadcasts,
    config: {
      chainId: 4663,
      payout: { legacyVault: true },
      accounts: { evm: ADDRESS, operationsTrigger: `0x${'c'.repeat(40)}` },
      contracts: { hook: ADDRESS, usdg: ADDRESS, vault: ADDRESS },
    },
    signerCalls,
    signerClient: {
      evm: {
        async sign(request) {
          signerCalls.push(request);
          return { signedTx: `0x${'d'.repeat(64)}` };
        },
      },
      operationsTrigger: {
        async sign(request) {
          signerCalls.push(request);
          return { signedTx: `0x${'e'.repeat(64)}` };
        },
      },
    },
  };
}

test('payout probe remains available without a live authority', async () => {
  const result = await probePayout({ adapters: { robinhood: { client: null } }, config: { contracts: {} } });
  assert.deepEqual(result, {
    wouldPayout: true,
    configured: false,
    reason: 'HOOKEMON_VAULT_ADDRESS / robinhood RPC client is not configured',
  });
});

test('mutatePayout completes read-only preparation before refusing an unproven authority at the authorize signer', async () => {
  const fixture = configuredPayout();
  const repositoryReads = [];
  const cycleRepository = {
    async readStageAttempt() {
      repositoryReads.push('attempt');
      return null;
    },
    async readStage(_cycleId, stage) {
      repositoryReads.push(stage);
      if (stage === 'funding') {
        return { status: 'COMPLETE', evidence: { returnActionDigest: 'sha256:' + '1'.repeat(64) } };
      }
      if (stage === 'distribution') {
        return {
          status: 'COMPLETE',
          evidence: {
            manifestDigest: 'sha256:' + '2'.repeat(64),
            rootHash: 'sha256:' + '3'.repeat(64),
            rootSum: '10',
            payoutId: 'sha256:' + '4'.repeat(64),
            distributionSignature: '0x' + '5'.repeat(130),
            verifierSignature: '0x' + '6'.repeat(130),
          },
        };
      }
      if (stage === 'return') return { status: 'COMPLETE', evidence: { receipt: 'finalized' } };
      throw new Error('unexpected stage ' + stage);
    },
    async nextStageAttemptIndex() {
      repositoryReads.push('attempt-index');
      return 0;
    },
  };

  await assert.rejects(
    mutatePayout({
      liveMode: true,
      adapters: fixture.adapters,
      config: fixture.config,
      signerClient: fixture.signerClient,
      cycleRepository,
      context: { cycleId: 'cycle-authority-check' },
    }),
    /active frozen interface authority is invalid/,
  );
  assert.deepEqual(repositoryReads, ['attempt', 'funding', 'distribution', 'return', 'attempt-index']);
  assert.equal(fixture.signerCalls.length, 0);
  assert.equal(fixture.broadcasts.length, 0);
});

test('mutatePayout returns an unresolved fund attempt without requiring a live authority', async () => {
  const fixture = configuredPayout();
  const attempt = { phase: 'fund', transactionHash: '0x' + 'f'.repeat(64) };

  assert.deepEqual(
    await mutatePayout({
      liveMode: true,
      adapters: fixture.adapters,
      config: fixture.config,
      signerClient: fixture.signerClient,
      cycleRepository: {
        async readStageAttempt() { return attempt; },
      },
      context: { cycleId: 'cycle-payout-fund-wait' },
    }),
    attempt,
  );
  assert.equal(fixture.signerCalls.length, 0);
  assert.equal(fixture.broadcasts.length, 0);
});
