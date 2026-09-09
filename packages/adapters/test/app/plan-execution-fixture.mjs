import { createRelayClient } from '../../src/relay-client.mjs';
import { buildAdmissionPlanner } from '../../src/app/compose.mjs';
import { deriveOnchainCycleId } from '../../src/app/stages/action-builder.mjs';
const HOOK = `0x${'1'.repeat(40)}`;
const ETH = 'native';
const BLOCK_HASH = `0x${'1'.repeat(64)}`;
const COVERS = 10n ** 12n;
const PLANNER_OPERATIONS = '0xb54aaf746eb1e80afdb5eb0992a75b08db2e4384';
const SETTLEMENT_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export function planFixture({ processLiabilityReader = fakeProcessLiabilityReader(), quantity = 1, unitAtomic = '1000000', unitDeadlineUnixSeconds = 2_000_000_000 } = {}) {
  const eth = { chainId: '4663', assetId: ETH, decimals: 18 };
  const settlement = { chainId: '792703809', assetId: SETTLEMENT_MINT, decimals: 6 };
  let quoteCount = 0;
  const plannerOptions = {
    config: {
      now: () => 1_700_000_000_000,
      contracts: { hook: HOOK },
      accounts: { evm: PLANNER_OPERATIONS, solana: 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE' },
      moneyConfiguration: { assets: { eth, solanaStablecoin: settlement } },
    },
    adapters: {
      collectorCrypt: {
        async getMachines() {
          return { machines: [{ code: 'base-pack', price: '1', available: true, enabled: true, contains: 1 }, { code: 'premium-pack', price: '2', available: true, enabled: true, contains: 1 }] };
        },
      },
      relay: (() => {
        const client = createRelayClient({ now: () => 1_700_000_000_000, quoteValidityMs: 60000,
          fetchImpl: async (_url, options) => {
            const request = JSON.parse(options.body); quoteCount += 1;
            const zero = `0x${'00'.repeat(20)}`;
            const raw = { requestId: `req-${quoteCount}`, details: { sender: request.user, recipient: request.recipient,
              currencyIn: { currency: { chainId: 4663, address: zero, decimals: 18 }, amount: request.amount, amountUsd: '1' },
              currencyOut: { currency: { chainId: 792703809, address: SETTLEMENT_MINT, decimals: 6 }, amount: request.amount, minimumAmount: request.amount } },
              protocol: { v2: { orderId: `0x${String(quoteCount).padStart(64, '0')}`, orderData: { inputs: [{ payment: { chainId: 'robinhood', currency: zero, amount: request.amount },
                refunds: [{ chainId: 'robinhood', currency: zero, recipient: request.user, deadline: quoteCount <= 2 ? unitDeadlineUnixSeconds : 2_000_000_000 }] }],
                output: { chainId: 'solana', deadline: quoteCount <= 2 ? unitDeadlineUnixSeconds : 2_000_000_000, calls: [], payments: [{ recipient: request.recipient, currency: SETTLEMENT_MINT, expectedAmount: request.amount, minimumAmount: request.amount }] } } } }, steps: [] };
            return { ok: true, status: 200, text: async () => JSON.stringify(raw) };
          } });
        return { quoteOutboundBridge: params => client.quoteOutboundBridge({ ...params, skipRouteCheck: true }) };
      })(),
    },
    readConfiguration: async () => ({ liveMode: true, requestedOrders: quantity, allowedPackIds: ['base-pack', 'premium-pack'], maxBoostersPerCycle: 64 }),
    processLiabilityReader,
  };
  const planner = buildAdmissionPlanner(plannerOptions);
  return { planner, unitAtomic, config: plannerOptions.config, adapters: plannerOptions.adapters, processLiabilityReader };
}

/** A finalized evidence record a real reader would only produce once every control passed. */
function fakeProcessLiabilityEvidence(cycleId, overrides = {}) {
  return {
    schema: 'hookemon.process-liability-evidence.v2',
    chainId: '4663',
    assetId: ETH,
    decimals: 18,
    hook: HOOK,
    cycleId,
    onchainCycleId: deriveOnchainCycleId(cycleId),
    blockNumber: '10',
    blockHash: BLOCK_HASH,
    finalized: true,
    processLiability: COVERS.toString(),
    remainingProcessClaimCapacity: COVERS.toString(),
    processClaimsPaused: false,
    processClaimCycleUsed: false,
    activeProcessClaimLimit: COVERS.toString(),
    totalLiability: COVERS.toString(),
    hookNativeBalance: COVERS.toString(),
    isSolvent: true,
    operations: PLANNER_OPERATIONS,
    ceilingAtomic: COVERS.toString(),
    ...overrides,
  };
}

function fakeProcessLiabilityReader(overrides = {}) {
  return { async read({ cycleId }) { return fakeProcessLiabilityEvidence(cycleId, overrides); } };
}
