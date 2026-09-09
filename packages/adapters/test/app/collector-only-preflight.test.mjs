import { createRelayClient, createQuoteUsdValuation } from '../../src/relay-client.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { CIRCLE_USD_DECIMALS, CIRCLE_USD_MINT, deriveAssociatedTokenAddress } from '../../src/solana-rpc.mjs';
import { attachCollectorPolicyBundle, loadCollectorPolicyBundle } from '../../src/signing/collector-policy-loader.mjs';
import { createTransactionPolicy, TRANSACTION_POLICY_SCHEMA } from '../../src/signing/transaction-policy.mjs';
import { runCollectorOnlyPreflight } from '../../rehearsal/collector-only-preflight.mjs';
import { createDefaultOperatorConfiguration } from '../../../runner/src/config/state-schema.mjs';

const OPERATOR = 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE';
const RECIPIENTS = Object.freeze([
  'GfFAJnHnSgP7C2FQZLz6ogpdTV6Y7259f83qFFm9wxKm',
  'H9ZXYkudxn6qhyp5S25jm5SrA8Vnu8naSfvymm9TptLA',
]);
const PROCEEDS = deriveAssociatedTokenAddress(OPERATOR, CIRCLE_USD_MINT).toBase58();
const SPEND = '25000000';

const USD_COST = '21000001';
const NOW = 1_700_000_000_000;
const recipient = `0x${'aa'.repeat(20)}`, zero = `0x${'00'.repeat(20)}`;
const rawQuote = { requestId: 'synthetic-preflight-usd', details: { sender: OPERATOR, recipient,
  currencyIn: { currency: { chainId: 792703809, address: CIRCLE_USD_MINT, decimals: 6 }, amount: SPEND, amountUsd: '21.000001' },
  currencyOut: { currency: { chainId: 4663, address: zero, decimals: 18 }, amount: '42', minimumAmount: '42', amountUsd: '20' } },
  protocol: { v2: { orderId: `0x${'44'.repeat(32)}`, orderData: { inputs: [{ payment: { chainId: 'solana', currency: CIRCLE_USD_MINT, amount: SPEND },
    refunds: [{ chainId: 'solana', currency: CIRCLE_USD_MINT, recipient: OPERATOR, deadline: 2_000_000_000 }] }], output: { chainId: 'robinhood', deadline: 2_000_000_000, calls: [],
    payments: [{ recipient, currency: zero, expectedAmount: '42', minimumAmount: '42' }] } } } }, steps: [] };
const quote = await createRelayClient({ now: () => NOW, quoteValidityMs: 60000,
  fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(rawQuote) })
}).quoteReturnBridge({ user: OPERATOR, recipient, amount: SPEND, skipRouteCheck: true });
const packFundingUsd = createQuoteUsdValuation({ quote, side: 'origin', rounding: 'up', nowMs: NOW,
  amount: { chainId: '792703809', assetId: CIRCLE_USD_MINT, decimals: 6, amountAtomic: SPEND } });

function pinnedPolicy(stage) {
  return createTransactionPolicy({
    policy: {
      schema: TRANSACTION_POLICY_SCHEMA,
      chainId: 'solana-mainnet',
      stage,
      requestDigest: `sha256:${'0'.repeat(64)}`,
      expectedRecipient: OPERATOR,
      amount: { chainId: 'solana-mainnet', assetId: CIRCLE_USD_MINT, decimals: CIRCLE_USD_DECIMALS, amountAtomic: '0' },
      allowedTargets: [],
      allowedPrograms: ['11111111111111111111111111111111'],
    },
    rules: [{}],
  });
}

function config(overrides = {}) {
  return {
    now: () => NOW,
    execution: { profile: 'rehearsal', providerMode: 'live' },
    accounts: { solana: OPERATOR },
    pack: { code: 'collector-25' },
    solana: {
      chainId: 'solana-mainnet',
      blockhashContextResolver: async blockhash => ({ blockhash, lastValidBlockHeight: '1' }),
      lookupTableResolver: async () => null,
    },
    rehearsal: {
      mode: 'collector-only',
      proceedsAccount: PROCEEDS,
      payoutRecipients: RECIPIENTS,
      payoutPolicy: pinnedPolicy('payout'),
    },
    collectorCrypt: {
      packFundingUsd,
      settlementAsset: { chainId: 'solana-mainnet', assetId: CIRCLE_USD_MINT, decimals: CIRCLE_USD_DECIMALS },
      packPrice: { chainId: 'solana-mainnet', assetId: CIRCLE_USD_MINT, decimals: CIRCLE_USD_DECIMALS, amountAtomic: SPEND },
      purchase: { policy: pinnedPolicy('purchase') },
      buyback: {
        policy: pinnedPolicy('buyback'),
        collectorProgramId: '11111111111111111111111111111111',
        collectorRecipient: RECIPIENTS[0],
      },
      epicGate: {
        nftAddressField: 'nft_address',
        insuredValueField: 'insured_value',
        prizeTierField: 'prize_tier',
        rarityField: 'rarity',
        asset: { chainId: 'solana-mainnet', assetId: CIRCLE_USD_MINT, decimals: CIRCLE_USD_DECIMALS },
      },
    },
    moneyConfiguration: {
      solana: { lamportReserve: { chainId: 'solana-mainnet', assetId: 'native', decimals: 9, amountAtomic: '1000' } },
    },
    ...overrides,
  };
}

function policy(overrides = {}) {
  return {
    ...createDefaultOperatorConfiguration(),
    liveMode: true,
    allowedPackIds: ['collector-25'],
    requestedOrders: 1,
    maxBoostersPerCycle: 1,
    maxUnitPriceMicroUsd: USD_COST,
    maxCycleBudgetMicroUsd: USD_COST,
    max24HourBudgetMicroUsd: USD_COST,
    perCycleCapMicroUsd: USD_COST,
    maxCyclesPerDay: 1,
    manualApprovalCycles: 1,
    ...overrides,
  };
}

function dependencies({ missingRecipient = null, readiness = { ready: true, publicKey: OPERATOR } } = {}) {
  const calls = [];
  return {
    calls,
    probeKeychain: async () => ({ 'operator-solana': readiness }),
    adapters: {
      collectorCrypt: {
        async getMachines() {
          calls.push('machines');
          return { machines: [{ code: 'collector-25', contains: 1, price: { amount: 25 } }] };
        },
      },
    },
    readers: {
      async readUsableLatestBlockhash() {
        calls.push('blockhash');
        return { blockhash: 'SysvarC1ock11111111111111111111111111111111', lastValidBlockHeight: 1 };
      },
      async readSolBalance() {
        calls.push('sol');
        return 1000n;
      },
      async readAssociatedTokenAccount(_client, owner) {
        calls.push(`token:${owner}`);
        if (owner === missingRecipient) return { address: deriveAssociatedTokenAddress(owner, CIRCLE_USD_MINT).toBase58(), exists: false, amount: null, decimals: null };
        return {
          address: deriveAssociatedTokenAddress(owner, CIRCLE_USD_MINT).toBase58(),
          exists: true,
          amount: owner === OPERATOR ? 25_000_000n : 0n,
          decimals: CIRCLE_USD_DECIMALS,
        };
      },
    },
  };
}

test('collector-only preflight makes a no-mutation exact-spend plan from a dedicated Operations token account', async () => {
  const fixture = dependencies();
  const result = await runCollectorOnlyPreflight({
    config: config(),
    policyConfiguration: policy(),
    ...fixture,
  });

  assert.deepEqual(result.spend, {
    chainId: 'solana-mainnet', assetId: CIRCLE_USD_MINT, decimals: 6, amountAtomic: SPEND,
  });
  assert.equal(result.machine.priceAtomic, SPEND);
  assert.equal(result.proceedsAccount, PROCEEDS);
  assert.deepEqual(result.recipients.map(entry => entry.owner), RECIPIENTS);
  assert.deepEqual(fixture.calls, [
    'machines', 'blockhash', 'sol', `token:${OPERATOR}`, `token:${RECIPIENTS[0]}`, `token:${RECIPIENTS[1]}`,
  ]);
});

test('collector-only preflight refuses a catalog price that differs from the exact planned spend', async () => {
  const fixture = dependencies();
  fixture.adapters.collectorCrypt.getMachines = async () => ({
    machines: [{ code: 'collector-25', contains: 1, price: { amount: 26 } }],
  });
  await assert.rejects(
    () => runCollectorOnlyPreflight({ config: config(), policyConfiguration: policy(), ...fixture }),
    /catalog price does not match the exact planned spend/,
  );
});

test('collector-only preflight refuses an absent trusted execution policy bundle before provider reads', async () => {
  const fixture = dependencies();
  const configured = config();
  delete configured.collectorCrypt.purchase;
  await assert.rejects(
    () => runCollectorOnlyPreflight({ config: configured, policyConfiguration: policy(), ...fixture }),
    /trusted Collector execution bundle is missing purchase transaction policy/,
  );
  assert.deepEqual(fixture.calls, []);
});

test('collector-only preflight refuses an evidence-only Collector bundle before provider reads', async () => {
  const fixture = dependencies();
  const bundle = await loadCollectorPolicyBundle();
  const configured = attachCollectorPolicyBundle(config(), bundle);
  await assert.rejects(
    () => runCollectorOnlyPreflight({ config: configured, policyConfiguration: policy(), ...fixture }),
    /no verified current-operator runtime authorization/,
  );
  assert.deepEqual(fixture.calls, []);
});

test('collector-only preflight refuses a missing recipient account before any mutation', async () => {
  const fixture = dependencies({ missingRecipient: RECIPIENTS[1] });
  await assert.rejects(
    () => runCollectorOnlyPreflight({ config: config(), policyConfiguration: policy(), ...fixture }),
    /recipient token account is missing/,
  );
  assert.equal(fixture.calls.includes('machines'), true);
});

test('collector-only preflight refuses a keychain identity that does not match Operations', async () => {
  const fixture = dependencies({ readiness: { ready: true, publicKey: RECIPIENTS[0] } });
  await assert.rejects(
    () => runCollectorOnlyPreflight({ config: config(), policyConfiguration: policy(), ...fixture }),
    /did not confirm the configured Operations public key/,
  );
  assert.deepEqual(fixture.calls, []);
});


test('collector-only preflight refuses JSON valuation without querying providers', async () => {
  const fixture = dependencies(), configured = config();
  configured.collectorCrypt.packFundingUsd = structuredClone(packFundingUsd);
  await assert.rejects(runCollectorOnlyPreflight({ config: configured, policyConfiguration: policy(), ...fixture }), /fresh authenticated exact settlement token/);
  assert.deepEqual(fixture.calls, []);
});
