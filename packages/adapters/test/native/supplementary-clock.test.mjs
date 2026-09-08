import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Keypair } from '@solana/web3.js';

import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { createStageDriver } from '../../src/app/stage-driver.mjs';
import { createProductionSupplementaryStageHandlers } from '../../src/app/compose.mjs';
import { createRelayClient, RelayQuoteExpiredError } from '../../src/relay-client.mjs';
import { COLLECTOR_CRYPT_SETTLEMENT_ASSET } from '../../src/collector-crypt.mjs';
import { returnSigningFixture } from './return-signing-fixture.mjs';

// The composed return path uses the injected Relay clock while config stays canonical data.

const RAW_FIXTURE_URL = new URL(
  '../../../../docs/evidence/native-relay-source-instruction-20260908/relay-return-scenario-response.json',
  import.meta.url,
);
const POSITION_ID = `held:${'a'.repeat(64)}`;
const RECIPIENT = '0x2222222222222222222222222222222222222222';

function moneyConfiguration() {
  const solanaStablecoin = { chainId: '792703809', assetId: COLLECTOR_CRYPT_SETTLEMENT_ASSET.assetId, decimals: COLLECTOR_CRYPT_SETTLEMENT_ASSET.decimals };
  const native = { chainId: '4663', assetId: 'native', decimals: 18 };
  return {
    schema: 'hookemon.money-configuration.v2',
    assets: { eth: native, solanaStablecoin },
    minimums: {
      robinhoodReceive: { ...native, amountAtomic: '0' },
      solanaReceive: { ...solanaStablecoin, amountAtomic: '0' },
      returnEth: { ...native, amountAtomic: '0' },
    },
    evm: {
      perTransactionGasPriceCap: { ...native, amountAtomic: '100' },
      nativeReserve: { ...native, amountAtomic: '1000' },
    },
    solana: {
      priorityFeeCap: { chainId: '792703809', assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '100' },
      lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '1000' },
    },
  };
}

function returnConfig(operator, now) {
  return {
    chainId: 4663,
    accounts: { evm: RECIPIENT, solana: operator },
    relay: { solanaMint: COLLECTOR_CRYPT_SETTLEMENT_ASSET.assetId, maxSettlementWindowSeconds: '600' },
    moneyConfiguration: moneyConfiguration(),
    // The one capability this fix is about: a caller-injected clock, independent of Date.now.
    now,
    effectfulCapability() { throw new Error('must not execute'); },
  };
}

function confirmedSale(amountAtomic = '17') {
  return {
    status: 'CONFIRMED',
    memo: `hookemon:${POSITION_ID}`,
    mint: COLLECTOR_CRYPT_SETTLEMENT_ASSET.assetId,
    signature: `${'g'.repeat(88)}`,
    proceeds: { ...COLLECTOR_CRYPT_SETTLEMENT_ASSET, amountAtomic },
    createdAt: '1700000000',
  };
}

function positionAndSettlement(cycleId) {
  const position = Object.freeze({
    positionId: POSITION_ID,
    cycleId,
    evidenceDigest: `sha256:${'b'.repeat(64)}`,
    ownerDecision: { choice: 'sell' },
    resolution: null,
  });
  const settlement = Object.freeze({
    positionId: POSITION_ID,
    cycleId,
    manifestId: `${cycleId}:supplementary:1`,
    state: 'BUYBACK_SENT_UNKNOWN',
    positionEvidenceDigest: position.evidenceDigest,
    eligibilitySnapshotEvidenceDigest: `sha256:${'3'.repeat(64)}`,
    payoutSourceDigest: null,
  });
  return { position, settlement };
}

/**
 * A real `createRelayClient`, wired the same way compose.mjs's `buildAdapters` wires the
 * production Relay client (`now`, `quoteValidityMs`), against the actual captured native
 * return-bridge instruction plan (`return-signing-fixture.mjs`) instead of a hand-built one. Only
 * the wire transport is faked; `now` stays caller-controlled so tests can move it independently of
 * `Date.now`, which `producedReturnSigningFixture`'s own fixed-clock relay cannot do.
 */
function capturedInstructionRelayAdapter({ sender, amountAtomic, now, quoteValidityMs, onQuoted = () => {} }) {
  const fixture = returnSigningFixture({ sender, recipient: RECIPIENT, amount: amountAtomic });
  const raw = JSON.parse(readFileSync(RAW_FIXTURE_URL));
  const { intent } = fixture.request;
  raw.details.sender = intent.sender;
  raw.details.recipient = intent.recipient;
  Object.assign(raw.details.currencyIn, { amount: intent.originAmount, minimumAmount: intent.originAmount, amountUsd: '0.000016' });
  Object.assign(raw.details.currencyOut, { amount: intent.quotedDestinationAmount, minimumAmount: intent.quotedDestinationMinimumAmount, amountUsd: '0.000015' });
  const order = raw.protocol.v2.orderData;
  order.inputs[0].payment.amount = intent.originAmount;
  for (const refund of order.inputs[0].refunds) {
    refund.recipient = refund.chainId === 'solana' ? intent.sender : intent.recipient;
    refund.deadline = intent.deadlineUnixSeconds;
  }
  Object.assign(order.output.payments[0], { recipient: intent.recipient, expectedAmount: intent.quotedDestinationAmount, minimumAmount: intent.quotedDestinationMinimumAmount });
  order.output.deadline = intent.deadlineUnixSeconds;
  raw.steps[0].items[0].data = fixture.request.solanaInstructionPlan;
  const client = createRelayClient({
    now,
    quoteValidityMs,
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(raw) }),
  });
  return { ...client, async quoteReturnBridge(params) {
    const quote = await client.quoteReturnBridge({ ...params, skipRouteCheck: true });
    onQuoted();
    return quote;
  } };
}

function fakeCycleRepository({ settlement, evidence, onPersist }) {
  return {
    async readOperationalStageAttempt() { return null; },
    async prepareStageAttempt() {},
    async markStageAttemptNotSent() {},
    async markStageAttemptSentUnknown() {},
    async recordStageAttemptResponse() {},
    async reconcileStageAttempt() {},
    async readSupplementarySettlement(positionId) { assert.equal(positionId, POSITION_ID); return settlement; },
    async readSupplementarySettlementEvidence(positionId) { assert.equal(positionId, POSITION_ID); return { state: 'BUYBACK_SENT_UNKNOWN', evidence }; },
    async readPagedPayoutState() { return null; },
    async persistPagedPayoutState(_cycleId, _stage, value) {
      onPersist(value);
      // Deliberate, safe pre-sign stop: a fresh, correctly-valued attempt was about to become
      // durable, but nothing has touched a blockhash or a signer yet.
      throw new Error('supplementary-clock fixture: stopped after persistence, before signing');
    },
  };
}

function driverFor({ config, adapters, repository }) {
  const production = createProductionSupplementaryStageHandlers({ async assertCanary() {} });
  const returnHandler = production.BUYBACK_SENT_UNKNOWN;
  return createStageDriver({
    liveMode: true,
    adapters: { collectorCrypt: null, relay: null, robinhood: { client: null }, solana: { client: null } },
    signerClient: null,
    config,
    cycleRepository: repository,
    preflightAuthority: createTestProfileMutationAuthority(),
    supplementaryAdapters: adapters,
    supplementarySignerClient: { solana: { async sign() { throw new Error('must not sign: pre-sign stop was bypassed'); } } },
    productionSupplementaryStageHandlers: {
      ...production,
      BUYBACK_SENT_UNKNOWN: {
        stage: returnHandler.stage,
        async reconcile(input) {
          // The canonicalized config must still strip the injected clock function; the trusted
          // clock must reach the handler only as the explicit `now` sibling.
          assert.notEqual(typeof input.config.now, 'function', 'canonical config must not retain executable clock authority');
          assert.notEqual(typeof input.config.effectfulCapability, 'function');
          return returnHandler.reconcile(input);
        },
      },
    },
  });
}

test('supplementary return honors an injected clock unlike real wall time: a fresh quote is not wrongly stale', async t => {
  const cycleId = 'cycle-supplementary-clock-fresh';
  const owner = Keypair.fromSeed(new Uint8Array(32).fill(9)).publicKey.toBase58();
  const { position, settlement } = positionAndSettlement(cycleId);

  // Real wall time is deliberately far from the injected clock below; the success path below
  // must not depend on it.
  t.mock.timers.enable({ apis: ['Date'], now: 1_900_000_000_000 });
  const injectedNowMs = 1_700_000_000_000;
  const config = returnConfig(owner, () => injectedNowMs);

  let quoted = 0;
  const relay = capturedInstructionRelayAdapter({
    sender: owner, amountAtomic: '17', now: config.now, quoteValidityMs: 60_000,
    onQuoted: () => { quoted += 1; },
  });

  let persisted = null;
  const repository = fakeCycleRepository({ settlement, evidence: confirmedSale(), onPersist: value => { persisted = value; } });
  const driver = driverFor({ config, adapters: { relay }, repository });

  await assert.rejects(
    () => driver.runSupplementarySettlement({
      position, settlement,
      fencingToken: '11111111-1111-4111-8111-111111111111',
      assertLease() {},
    }),
    /stopped after persistence, before signing/,
  );
  assert.equal(quoted, 1);
  assert.ok(persisted, 'a fresh attempt reached durable persistence instead of being rejected as stale');
  assert.equal(persisted.destinationUsd.observedAtMs, injectedNowMs, 'USD valuation was observed under the injected clock, not Date.now');
});

test('supplementary return still refuses a quote genuinely stale under the trusted clock, before persistence', async t => {
  const cycleId = 'cycle-supplementary-clock-expired';
  const owner = Keypair.fromSeed(new Uint8Array(32).fill(11)).publicKey.toBase58();
  const { position, settlement } = positionAndSettlement(cycleId);

  t.mock.timers.enable({ apis: ['Date'], now: 5_000_000_000_000 });
  const startedAt = 1_700_000_000_000;
  let injectedNowMs = startedAt;
  const config = returnConfig(owner, () => injectedNowMs);

  const relay = capturedInstructionRelayAdapter({
    sender: owner, amountAtomic: '17', now: config.now, quoteValidityMs: 60_000,
    // Delay delivery after the real HTTP producer stamps the quote. The original TTL
    // expires before the return handler checks it; no quote bytes or capability are replaced.
    onQuoted: () => { injectedNowMs = startedAt + 61_000; },
  });

  let persisted = null;
  const repository = fakeCycleRepository({ settlement, evidence: confirmedSale(), onPersist: value => { persisted = value; } });
  const driver = driverFor({ config, adapters: { relay }, repository });

  await assert.rejects(
    () => driver.runSupplementarySettlement({
      position, settlement,
      fencingToken: '22222222-2222-4222-8222-222222222222',
      assertLease() {},
    }),
    error => error instanceof RelayQuoteExpiredError || /stale/.test(error.message),
  );
  assert.equal(persisted, null, 'a genuinely expired quote must never reach durable persistence');
});
