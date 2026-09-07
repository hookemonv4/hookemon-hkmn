import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { createRecordedRelayLeg } from '../../../runner/src/cycle/money-schemas.mjs';
import { digest as canonicalDigest } from '../../../runner/src/cycle/journal.mjs';
import { createSolanaRpcClient, TOKEN_PROGRAM_ID } from '../../src/solana-rpc.mjs';
import { mutateReturn, reconcileLiveReturn, ReturnRecoveryRequiredError } from '../../src/app/stages/return.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { createStageDriver } from '../../src/app/stage-driver.mjs';

// Focused coverage for ordinary return's EVM USDG custody-v2 write introduced by interfaces.json
// revision 67 / ADR-0026: `recordReturnCustodyExpectation` inside `stages/return.mjs`, which
// replaces the bare `recordRelayLeg` call with the atomic `recordReturnRelayLegExpectation`
// primitive, called exactly once per leg (mutateReturn skips it entirely once the leg already
// durably exists, so the leg's own lifecycle fields can freely advance afterward). Every genuinely
// new leg obtains a fresh, non-null observation regardless of whether its destination row already
// exists as v1 or v2 for some unrelated reason (an earlier claim, payout, or a different,
// already-cleared return); only a genuine resume of the same durable leg skips the repository call
// entirely. Drives the real `mutateReturn` entrypoint (and, once, the real stage-driver) against a
// real, durable `CycleRepository` and the real `createEvmCustodyBalanceObservationReader` producer
// -- never a bare unit-tested helper -- so every assertion here observes what the actual repository
// journal and the actual observation reader produced. The atomic creation primitive's own CAS
// semantics (replay, conflict refusal) are already proven in cycle-repository.test.mjs; this file
// proves the stage's own wiring around it instead.

// Fixed by relay-client.mjs's RELAY_CONSTANTS (chain 4663 / USDG_ADDRESS) -- return.mjs binds
// MoneyConfigurationV1.assets.usdg to this exact route, never an arbitrary configured token.
const TOKEN = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const OPERATIONS = `0x${'b'.repeat(40)}`;
const SOLANA_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOLANA_OPERATOR = '8PJ6Nrp5eyzBzYCvApEZCGpdw9AreDAnM2Haf4QRGUto';
const SOLANA_SOURCE = '8MWgLuNVQAhpoTUQZiUUkG9Q1569HCkJbmAivoQ5VhDN';
const SOLANA_DESTINATION = '4nvJ5zWdVspxJiNZzB127U6amPH98SFFkBx2JZrAduia';
const NUL = String.fromCharCode(0);

const CANONICAL_CHAIN_ID = 'eip155:4663';
const CANONICAL_ASSET_ID = `eip155:4663/erc20:${TOKEN}`;
const CANONICAL_KEY = `${CANONICAL_CHAIN_ID}${NUL}${CANONICAL_ASSET_ID}`;
const RAW_KEY = `4663${NUL}${TOKEN}`;

const TEST_PREFLIGHT_AUTHORITY = createTestProfileMutationAuthority();
const MARKER_STOP = 'MARKER_STOP_AFTER_CUSTODY_WRITE';

function baseConfig() {
  return {
    chainId: 4663,
    accounts: { evm: OPERATIONS, solana: SOLANA_OPERATOR },
    relay: { solanaMint: SOLANA_MINT, maxSettlementWindowSeconds: '600' },
    moneyConfiguration: {
      schema: 'hookemon.money-configuration.v1',
      assets: {
        usdg: { chainId: '4663', assetId: TOKEN, decimals: 6 },
        solanaStablecoin: { chainId: '792703809', assetId: SOLANA_MINT, decimals: 6 },
      },
      minimums: {
        robinhoodReceive: { chainId: '4663', assetId: TOKEN, decimals: 6, amountAtomic: '0' },
        solanaReceive: { chainId: '792703809', assetId: SOLANA_MINT, decimals: 6, amountAtomic: '0' },
        returnUsdg: { chainId: '4663', assetId: TOKEN, decimals: 6, amountAtomic: '0' },
      },
      evm: {
        perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '100' },
        nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '1000' },
      },
      solana: {
        priorityFeeCap: { chainId: '792703809', assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '100' },
        lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '1000' },
      },
    },
  };
}

function rpc({
  finalizedNumber = 100n,
  finalizedHash = `0x${'f'.repeat(64)}`,
  recheckHash = undefined,
  archiveBalance = 500_000n,
  archiveBlockNumber = undefined,
  archiveBlockHash = undefined,
  historicalEvidenceClient = 'default',
} = {}) {
  const client = {
    async getBlock({ blockTag } = {}) {
      if (blockTag === 'finalized') return { number: finalizedNumber, hash: finalizedHash, timestamp: 1_700_000_000n };
      return { number: finalizedNumber, hash: recheckHash ?? finalizedHash, timestamp: 1_700_000_000n };
    },
  };
  // return.mjs (like claim-process.mjs) reads the archive client from the separate
  // `adapters.robinhood.historicalEvidenceClient` field, never from `client.historicalEvidenceClient`.
  let archiveClient = null;
  if (historicalEvidenceClient === 'default') {
    archiveClient = {
      async readErc20BalanceAtBlock({ blockNumber, blockHash }) {
        return {
          value: archiveBalance,
          blockNumber: archiveBlockNumber ?? blockNumber,
          blockHash: archiveBlockHash ?? blockHash,
        };
      },
    };
  } else if (historicalEvidenceClient === 'same') {
    archiveClient = client;
  } else if (historicalEvidenceClient && historicalEvidenceClient !== 'none') {
    archiveClient = historicalEvidenceClient;
  }
  return { client, historicalEvidenceClient: archiveClient };
}

const UNTOUCHABLE_ROBINHOOD = new Proxy({}, { get() { throw new Error('must not read the balance observer here'); } });

function splTransferCheckedPlan(amountAtomic) {
  const data = Buffer.alloc(10);
  data.writeUInt8(12, 0);
  data.writeBigUInt64LE(BigInt(amountAtomic), 1);
  data.writeUInt8(6, 9);
  return {
    instructions: [{
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: SOLANA_SOURCE, isSigner: false, isWritable: true },
        { pubkey: SOLANA_MINT, isSigner: false, isWritable: false },
        { pubkey: SOLANA_DESTINATION, isSigner: false, isWritable: true },
        { pubkey: SOLANA_OPERATOR, isSigner: true, isWritable: false },
      ],
      data: data.toString('hex'),
    }],
    addressLookupTableAddresses: [],
  };
}

function solanaClient(blockhash = '11111111111111111111111111111111') {
  return createSolanaRpcClient({
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      const resultByMethod = {
        getBalance: { context: { slot: 9 }, value: 10_000 },
        getLatestBlockhash: { context: { slot: 10 }, value: { blockhash, lastValidBlockHeight: 100 } },
        isBlockhashValid: { context: { slot: 10 }, value: true },
        getBlockHeight: 10,
      };
      if (!Object.hasOwn(resultByMethod, body.method)) throw new Error(`unexpected Solana RPC ${body.method}`);
      return { ok: true, status: 200, text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: resultByMethod[body.method] }) };
    },
  });
}

function markerSigner() {
  return { solana: { role: 'operator-solana', async sign() { throw new Error(MARKER_STOP); }, async broadcast() {} } };
}

async function durableCycle(t, cycleId = 'cycle-return-custody-v2-1') {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-return-custody-v2-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = await CycleRepository.open(directory);
  await repository.createCycle({ releaseAmount: '1', mode: 'production', cycleId });
  return { directory, repository, cycleId };
}

async function seedSolanaProceeds(cycleRepository, cycleId, proceeds = '17') {
  await cycleRepository.recordCustodyLedger(cycleId, {
    schema: 'hookemon.custody-ledger.v1',
    cycleId,
    chainId: '792703809',
    assetId: SOLANA_MINT,
    decimals: 6,
    claimed: '0', bridgeOut: '0', bridgeIn: '0', packCost: '0', buybackProceeds: proceeds,
    returnInput: '0', returnReceived: '0', refunds: '0', residual: '0', heldAssets: '0',
    heldPositions: '0', payoutLiability: '0', dust: '0', unattributed: '0',
  });
}

function evmCustodyBuckets(overrides = {}) {
  return {
    claimed: '0', bridgeOut: '0', bridgeIn: '0', packCost: '0', buybackProceeds: '0',
    returnInput: '0', returnReceived: '0', refunds: '0', residual: '0', heldAssets: '0',
    heldPositions: '0', payoutLiability: '0', dust: '0', unattributed: '0',
    ...overrides,
  };
}

async function canonicalRow(cycleRepository, cycleId, overrides = {}) {
  const row = {
    schema: 'hookemon.custody-ledger.v1',
    cycleId,
    chainId: CANONICAL_CHAIN_ID,
    assetId: CANONICAL_ASSET_ID,
    decimals: 6,
    ...evmCustodyBuckets(overrides),
  };
  await cycleRepository.recordCustodyLedger(cycleId, row);
  return row;
}

async function canonicalV2Row(cycleRepository, cycleId, overrides = {}) {
  const row = {
    schema: 'hookemon.custody-ledger.v2',
    cycleId,
    chainId: CANONICAL_CHAIN_ID,
    assetId: CANONICAL_ASSET_ID,
    decimals: 6,
    ...evmCustodyBuckets(overrides),
    verifiedCurrentBalance: {
      schema: 'hookemon.custody-balance-observation.v1',
      account: OPERATIONS.toLowerCase(),
      balance: { chainId: CANONICAL_CHAIN_ID, assetId: CANONICAL_ASSET_ID, decimals: 6, amountAtomic: '250000' },
      finality: { height: '50', hash: `0x${'5'.repeat(64)}`, timestampUnixSeconds: '1699999999' },
    },
    expectedCycleAsset: null,
    ...overrides,
  };
  await cycleRepository.recordCustodyLedger(cycleId, row);
  return row;
}

async function rawRow(cycleRepository, cycleId, overrides = {}) {
  const row = {
    schema: 'hookemon.custody-ledger.v1',
    cycleId,
    chainId: '4663',
    assetId: TOKEN,
    decimals: 6,
    ...evmCustodyBuckets(overrides),
  };
  await cycleRepository.recordCustodyLedger(cycleId, row);
  return row;
}

function returnRequest({ cycleId, requestId, amountAtomic = '17', destinationAmountAtomic = '16', deadlineUnixSeconds = 4_102_444_800 }) {
  return {
    schema: 'hookemon.return-relay-request.v1',
    cycleId,
    inputAmount: { chainId: '792703809', assetId: SOLANA_MINT, decimals: 6, amountAtomic },
    destinationAmount: { chainId: '4663', assetId: TOKEN, decimals: 6, amountAtomic: destinationAmountAtomic },
    requestCreatedAtUnixSeconds: '1700000000',
    maxSettlementWindowSeconds: '600',
    intent: {
      schema: 'hookemon.relay-intent.v1',
      requestId,
      orderId: `0x${'9'.repeat(64)}`,
      direction: 'RETURN',
      tradeType: 'EXACT_INPUT',
      quoteDigest: `sha256:${'7'.repeat(64)}`,
      originChainId: 792703809,
      destinationChainId: 4663,
      originAssetId: SOLANA_MINT,
      originDecimals: 6,
      destinationAssetId: TOKEN,
      destinationDecimals: 6,
      originAmount: amountAtomic,
      quotedDestinationAmount: destinationAmountAtomic,
      quotedDestinationMinimumAmount: destinationAmountAtomic,
      sender: SOLANA_OPERATOR,
      recipient: OPERATIONS,
      deadlineUnixSeconds,
    },
    solanaInstructionPlan: splTransferCheckedPlan(amountAtomic),
  };
}

function returnContext(cycleId, seed = '1') {
  return {
    cycleId,
    requestDigest: `sha256:${seed.repeat(64)}`,
    fencingToken: `1111111${seed}-1111-4111-8111-111111111111`.slice(0, 36),
  };
}

async function runMutateReturn({ cycleRepository, cycleId, config, robinhood, request, ctx, signerClient = markerSigner() }) {
  return mutateReturn({
    liveMode: true,
    config,
    cycleRepository,
    context: ctx,
    request,
    adapters: {
      solana: { client: solanaClient() },
      robinhood,
    },
    signerClient,
    preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
    now: () => 1_700_000_000_000,
  });
}

// The exact leg-construction formula private to `stages/return.mjs#returnRelayLeg`, so a test can
// seed a leg through the legacy, unsanctioned `recordRelayLeg` with the identical immutable
// identity `mutateReturn` would itself compute for the same request -- proving the resume path
// checks durable association, not merely matching request identity.
function bareReturnRelayLeg(request) {
  return createRecordedRelayLeg({
    cycleId: request.cycleId,
    direction: 'return',
    relayRequestId: request.intent.requestId,
    quoteDigest: canonicalDigest({
      schema: 'hookemon.relay-quote-digest.v1',
      intent: request.intent,
      inputAmount: request.inputAmount,
      destinationAmount: request.destinationAmount,
    }),
    source: request.inputAmount,
    destination: request.destinationAmount,
    returnAttribution: {
      schema: 'hookemon.return-leg-attribution-context.v1',
      intent: request.intent,
      requestCreatedAtUnixSeconds: request.requestCreatedAtUnixSeconds,
      maxSettlementWindowSeconds: request.maxSettlementWindowSeconds,
    },
  });
}

function countingSigner(counters) {
  return {
    solana: {
      role: 'operator-solana',
      async sign() { counters.sign = (counters.sign ?? 0) + 1; throw new Error(MARKER_STOP); },
      async broadcast() { counters.broadcast = (counters.broadcast ?? 0) + 1; throw new Error(MARKER_STOP); },
    },
  };
}

function countingNonceRepository(cycleRepository, counters) {
  const original = cycleRepository.reserveWalletNonce.bind(cycleRepository);
  cycleRepository.reserveWalletNonce = async (...args) => {
    counters.nonce = (counters.nonce ?? 0) + 1;
    return original(...args);
  };
  return cycleRepository;
}

test('refuses a raw-only legacy USDG predecessor before any leg creation, nonce reservation, or signing', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await seedSolanaProceeds(cycleRepository, cycleId);
  await rawRow(cycleRepository, cycleId, { claimed: '100' });

  await assert.rejects(
    () => runMutateReturn({
      cycleRepository, cycleId, config: baseConfig(), robinhood: { client: UNTOUCHABLE_ROBINHOOD, historicalEvidenceClient: UNTOUCHABLE_ROBINHOOD },
      request: returnRequest({ cycleId, requestId: 'relay-return-raw-only' }), ctx: returnContext(cycleId),
    }),
    error => error instanceof ReturnRecoveryRequiredError && error.recoveryState === 'RETURN_LEGACY_RAW_CUSTODY_PREDECESSOR',
  );

  const state = await cycleRepository.describeCycle(cycleId);
  assert.equal(state.relayLegs.size, 0, 'must not create a Relay leg before the refusal');
  assert.equal(state.custodyLedgers.get(CANONICAL_KEY), undefined, 'must not create a competing canonical row');
});

test('refuses when a raw predecessor coexists with a canonical row, leaving both untouched', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await seedSolanaProceeds(cycleRepository, cycleId);
  const raw = await rawRow(cycleRepository, cycleId, { claimed: '40' });
  const canonical = await canonicalV2Row(cycleRepository, cycleId, { claimed: '9' });

  await assert.rejects(
    () => runMutateReturn({
      cycleRepository, cycleId, config: baseConfig(), robinhood: { client: UNTOUCHABLE_ROBINHOOD, historicalEvidenceClient: UNTOUCHABLE_ROBINHOOD },
      request: returnRequest({ cycleId, requestId: 'relay-return-raw-and-canonical' }), ctx: returnContext(cycleId),
    }),
    error => error instanceof ReturnRecoveryRequiredError && error.recoveryState === 'RETURN_LEGACY_RAW_CUSTODY_PREDECESSOR',
  );

  const state = await cycleRepository.describeCycle(cycleId);
  assert.equal(state.relayLegs.size, 0);
  assert.deepEqual(state.custodyLedgers.get(RAW_KEY), raw);
  assert.deepEqual(state.custodyLedgers.get(CANONICAL_KEY), canonical);
});

test('creates a new canonical v2 row and the RECORDED leg expectation together, with a real observation', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await seedSolanaProceeds(cycleRepository, cycleId);

  await assert.rejects(
    () => runMutateReturn({
      cycleRepository, cycleId, config: baseConfig(), robinhood: rpc(),
      request: returnRequest({ cycleId, requestId: 'relay-return-new-row' }), ctx: returnContext(cycleId),
    }),
    new RegExp(MARKER_STOP),
  );

  const state = await cycleRepository.describeCycle(cycleId);
  const leg = state.relayLegs.get('relay-return-new-row');
  assert.equal(leg.state, 'RECORDED');
  const row = state.custodyLedgers.get(CANONICAL_KEY);
  assert.equal(row.schema, 'hookemon.custody-ledger.v2');
  assert.equal(row.returnReceived, '0');
  assert.ok(row.verifiedCurrentBalance, 'expected a non-null verifiedCurrentBalance on the fresh write');
  assert.equal(row.verifiedCurrentBalance.balance.amountAtomic, '500000');
  assert.equal(row.verifiedCurrentBalance.finality.height, '100');
  assert.deepEqual(row.expectedCycleAsset, {
    chainId: CANONICAL_CHAIN_ID, assetId: CANONICAL_ASSET_ID, decimals: 6, amountAtomic: '16',
  });
  assert.equal(state.returnLegLedgerKeys.get('relay-return-new-row'), CANONICAL_KEY);
});

test('upgrades a legitimate existing canonical v1 row, retaining every bucket, only with a genuine observation', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await seedSolanaProceeds(cycleRepository, cycleId);
  await canonicalRow(cycleRepository, cycleId, { claimed: '100', bridgeIn: '20' });

  await assert.rejects(
    () => runMutateReturn({
      cycleRepository, cycleId, config: baseConfig(), robinhood: rpc(),
      request: returnRequest({ cycleId, requestId: 'relay-return-v1-upgrade' }), ctx: returnContext(cycleId),
    }),
    new RegExp(MARKER_STOP),
  );

  const state = await cycleRepository.describeCycle(cycleId);
  const row = state.custodyLedgers.get(CANONICAL_KEY);
  assert.equal(row.schema, 'hookemon.custody-ledger.v2');
  assert.equal(row.claimed, '100');
  assert.equal(row.bridgeIn, '20');
  assert.ok(row.verifiedCurrentBalance);
  assert.deepEqual(row.expectedCycleAsset, {
    chainId: CANONICAL_CHAIN_ID, assetId: CANONICAL_ASSET_ID, decimals: 6, amountAtomic: '16',
  });
});

test('a genuinely new leg on an existing v2 row (written earlier by claim or payout) still obtains a fresh observation', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await seedSolanaProceeds(cycleRepository, cycleId);
  const existing = await canonicalV2Row(cycleRepository, cycleId, { claimed: '9' });

  await assert.rejects(
    () => runMutateReturn({
      cycleRepository, cycleId, config: baseConfig(), robinhood: rpc(),
      request: returnRequest({ cycleId, requestId: 'relay-return-refresh-v2' }), ctx: returnContext(cycleId),
    }),
    new RegExp(MARKER_STOP),
  );

  const state = await cycleRepository.describeCycle(cycleId);
  const row = state.custodyLedgers.get(CANONICAL_KEY);
  assert.equal(row.claimed, '9', 'every existing bucket must be carried forward unchanged');
  assert.notDeepEqual(row.verifiedCurrentBalance, existing.verifiedCurrentBalance, 'a genuinely new leg must never skip the real observation');
  assert.equal(row.verifiedCurrentBalance.balance.amountAtomic, '500000');
  assert.equal(row.verifiedCurrentBalance.finality.height, '100');
  assert.deepEqual(row.expectedCycleAsset, {
    chainId: CANONICAL_CHAIN_ID, assetId: CANONICAL_ASSET_ID, decimals: 6, amountAtomic: '16',
  });
});

test('a restarted resume replays the same leg and ledger association byte-identically, with no re-observation', async t => {
  const { directory, repository: cycleRepository, cycleId } = await durableCycle(t);
  await seedSolanaProceeds(cycleRepository, cycleId);
  const ctx = returnContext(cycleId);
  const request = returnRequest({ cycleId, requestId: 'relay-return-resume' });

  await assert.rejects(
    () => runMutateReturn({ cycleRepository, cycleId, config: baseConfig(), robinhood: rpc(), request, ctx }),
    new RegExp(MARKER_STOP),
  );
  const first = await cycleRepository.describeCycle(cycleId);
  const firstLeg = first.relayLegs.get('relay-return-resume');
  const firstRow = first.custodyLedgers.get(CANONICAL_KEY);

  const reopened = await CycleRepository.open(directory);
  await assert.rejects(
    () => runMutateReturn({
      cycleRepository: reopened, cycleId, config: baseConfig(), robinhood: { client: UNTOUCHABLE_ROBINHOOD, historicalEvidenceClient: UNTOUCHABLE_ROBINHOOD }, request, ctx,
    }),
    new RegExp(MARKER_STOP),
  );
  const replayed = await reopened.describeCycle(cycleId);
  assert.deepEqual(replayed.relayLegs.get('relay-return-resume'), firstLeg);
  assert.deepEqual(replayed.custodyLedgers.get(CANONICAL_KEY), firstRow);
});

test('a conflicting second unresolved leg for the same destination refuses before append, leaving the first expectation unchanged', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await seedSolanaProceeds(cycleRepository, cycleId);
  const ctx = returnContext(cycleId);

  await assert.rejects(
    () => runMutateReturn({
      cycleRepository, cycleId, config: baseConfig(), robinhood: rpc(),
      request: returnRequest({ cycleId, requestId: 'relay-return-first' }), ctx,
    }),
    new RegExp(MARKER_STOP),
  );
  const afterFirst = await cycleRepository.describeCycle(cycleId);
  const firstLeg = afterFirst.relayLegs.get('relay-return-first');
  const firstRow = afterFirst.custodyLedgers.get(CANONICAL_KEY);

  // The conflict is detected from durable state alone, before any observation is attempted --
  // an untouchable Robinhood adapter proves the row is never even read for a fresh balance.
  await assert.rejects(
    () => runMutateReturn({
      cycleRepository, cycleId, config: baseConfig(), robinhood: { client: UNTOUCHABLE_ROBINHOOD, historicalEvidenceClient: UNTOUCHABLE_ROBINHOOD },
      request: returnRequest({ cycleId, requestId: 'relay-return-second', amountAtomic: '17', destinationAmountAtomic: '16' }), ctx,
    }),
    /unresolved return leg for this destination already exists/,
  );

  const afterSecond = await cycleRepository.describeCycle(cycleId);
  assert.deepEqual(afterSecond.relayLegs.get('relay-return-first'), firstLeg);
  assert.deepEqual(afterSecond.custodyLedgers.get(CANONICAL_KEY), firstRow, 'the row must be byte-identical: refused before any write, not merely before the atomic append');
  assert.equal(afterSecond.relayLegs.has('relay-return-second'), false);
});

test('a leg durably recorded only through the legacy bare recordRelayLeg, with no association at all, refuses on resume before any nonce reservation or signing', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await seedSolanaProceeds(cycleRepository, cycleId);
  const request = returnRequest({ cycleId, requestId: 'relay-return-legacy-unassociated' });
  await cycleRepository.recordRelayLeg(cycleId, bareReturnRelayLeg(request));

  const counters = {};
  countingNonceRepository(cycleRepository, counters);
  await assert.rejects(
    () => runMutateReturn({
      cycleRepository, cycleId, config: baseConfig(), robinhood: { client: UNTOUCHABLE_ROBINHOOD, historicalEvidenceClient: UNTOUCHABLE_ROBINHOOD },
      request, ctx: returnContext(cycleId), signerClient: countingSigner(counters),
    }),
    error => error instanceof ReturnRecoveryRequiredError && error.recoveryState === 'RETURN_CUSTODY_ASSOCIATION_MISSING',
  );
  assert.equal(counters.nonce, undefined, 'must not reserve a wallet nonce before the association check');
  assert.equal(counters.sign, undefined, 'must not sign before the association check');
  assert.equal(counters.broadcast, undefined, 'must not broadcast before the association check');

  const state = await cycleRepository.describeCycle(cycleId);
  assert.equal(state.custodyLedgers.get(CANONICAL_KEY), undefined, 'must not fabricate a canonical row for the legacy leg');
});

test('a leg durably recorded only through the legacy bare recordRelayLeg over a raw-identity row refuses on resume before any nonce reservation or signing', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await seedSolanaProceeds(cycleRepository, cycleId);
  const request = returnRequest({ cycleId, requestId: 'relay-return-legacy-raw' });
  await cycleRepository.recordRelayLeg(cycleId, bareReturnRelayLeg(request));
  await rawRow(cycleRepository, cycleId, { returnReceived: '16' });

  const counters = {};
  countingNonceRepository(cycleRepository, counters);
  await assert.rejects(
    () => runMutateReturn({
      cycleRepository, cycleId, config: baseConfig(), robinhood: { client: UNTOUCHABLE_ROBINHOOD, historicalEvidenceClient: UNTOUCHABLE_ROBINHOOD },
      request, ctx: returnContext(cycleId), signerClient: countingSigner(counters),
    }),
    error => error instanceof ReturnRecoveryRequiredError && error.recoveryState === 'RETURN_CUSTODY_ASSOCIATION_MISSING',
  );
  assert.equal(counters.nonce, undefined, 'must not reserve a wallet nonce before the association check');
  assert.equal(counters.sign, undefined, 'must not sign before the association check');
});

test('a resumed leg whose canonical association coexists with a later raw-identity predecessor refuses before any nonce reservation or signing', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await seedSolanaProceeds(cycleRepository, cycleId);
  const ctx = returnContext(cycleId);
  const request = returnRequest({ cycleId, requestId: 'relay-return-split-on-resume' });

  await assert.rejects(
    () => runMutateReturn({ cycleRepository, cycleId, config: baseConfig(), robinhood: rpc(), request, ctx }),
    new RegExp(MARKER_STOP),
  );
  // A raw-identity row for the same asset appears later (e.g. an unrelated legacy write) --
  // resuming the already-durable leg must refuse rather than proceed on its still-valid association.
  await rawRow(cycleRepository, cycleId, { claimed: '5' });

  const counters = {};
  countingNonceRepository(cycleRepository, counters);
  await assert.rejects(
    () => runMutateReturn({
      cycleRepository, cycleId, config: baseConfig(), robinhood: { client: UNTOUCHABLE_ROBINHOOD, historicalEvidenceClient: UNTOUCHABLE_ROBINHOOD },
      request, ctx, signerClient: countingSigner(counters),
    }),
    error => error instanceof ReturnRecoveryRequiredError && error.recoveryState === 'RETURN_CUSTODY_IDENTITY_SPLIT',
  );
  assert.equal(counters.nonce, undefined, 'must not reserve a second wallet nonce before the association check');
  assert.equal(counters.sign, undefined, 'must not sign before the association check');
});

test('a lease lost while the final public recheck is suspended reaches zero custody or leg-creation writes', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await seedSolanaProceeds(cycleRepository, cycleId);

  let recordCustodyLedgerCalls = 0;
  const originalRecordCustodyLedger = cycleRepository.recordCustodyLedger.bind(cycleRepository);
  cycleRepository.recordCustodyLedger = async (...args) => { recordCustodyLedgerCalls += 1; return originalRecordCustodyLedger(...args); };
  let recordExpectationCalls = 0;
  const originalRecordExpectation = cycleRepository.recordReturnRelayLegExpectation.bind(cycleRepository);
  cycleRepository.recordReturnRelayLegExpectation = async (...args) => { recordExpectationCalls += 1; return originalRecordExpectation(...args); };

  let signalSuspended;
  const suspended = new Promise(resolve => { signalSuspended = resolve; });
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  let leaseLost = false;
  let getBlockCalls = 0;
  const robinhood = {
    client: {
      async getBlock() {
        getBlockCalls += 1;
        if (getBlockCalls === 1) return { number: 100n, hash: `0x${'f'.repeat(64)}`, timestamp: 1_700_000_000n };
        signalSuspended();
        await gate;
        return { number: 100n, hash: `0x${'f'.repeat(64)}`, timestamp: 1_700_000_000n };
      },
    },
    historicalEvidenceClient: {
      async readErc20BalanceAtBlock({ blockNumber, blockHash }) {
        return { value: 500_000n, blockNumber, blockHash };
      },
    },
  };
  const ctx = { ...returnContext(cycleId), assertLease() { if (leaseLost) throw new Error('LEASE_LOST_DURING_RECHECK'); } };

  const runPromise = runMutateReturn({
    cycleRepository, cycleId, config: baseConfig(), robinhood,
    request: returnRequest({ cycleId, requestId: 'relay-return-lease-recheck-race' }), ctx,
  });

  await suspended;
  leaseLost = true;
  releaseGate();

  await assert.rejects(() => runPromise, /LEASE_LOST_DURING_RECHECK/);
  assert.equal(recordCustodyLedgerCalls, 0, 'must not refresh custody once the lease was lost during the observation');
  assert.equal(recordExpectationCalls, 0, 'must not create the leg once the lease was lost during the observation');
  const state = await cycleRepository.describeCycle(cycleId);
  assert.equal(state.relayLegs.size, 0);
  assert.equal(state.custodyLedgers.get(CANONICAL_KEY), undefined);
});

test('a lease lost immediately after the custody refresh write reaches zero atomic leg-creation calls', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await seedSolanaProceeds(cycleRepository, cycleId);
  await canonicalRow(cycleRepository, cycleId, { claimed: '9' });

  let recordExpectationCalls = 0;
  const originalRecordExpectation = cycleRepository.recordReturnRelayLegExpectation.bind(cycleRepository);
  cycleRepository.recordReturnRelayLegExpectation = async (...args) => { recordExpectationCalls += 1; return originalRecordExpectation(...args); };

  let leaseLost = false;
  const originalRecordCustodyLedger = cycleRepository.recordCustodyLedger.bind(cycleRepository);
  cycleRepository.recordCustodyLedger = async (...args) => {
    const result = await originalRecordCustodyLedger(...args);
    leaseLost = true;
    return result;
  };
  const ctx = { ...returnContext(cycleId), assertLease() { if (leaseLost) throw new Error('LEASE_LOST_AFTER_REFRESH'); } };

  await assert.rejects(
    () => runMutateReturn({
      cycleRepository, cycleId, config: baseConfig(), robinhood: rpc(),
      request: returnRequest({ cycleId, requestId: 'relay-return-lease-after-refresh' }), ctx,
    }),
    /LEASE_LOST_AFTER_REFRESH/,
  );
  assert.equal(recordExpectationCalls, 0, 'must not create the leg once the lease was lost right after the refresh write');
  const state = await cycleRepository.describeCycle(cycleId);
  assert.equal(state.relayLegs.size, 0, 'the leg must never be created once the lease was lost after the refresh write');
  const row = state.custodyLedgers.get(CANONICAL_KEY);
  assert.equal(row.schema, 'hookemon.custody-ledger.v2', 'the refresh write itself already durably happened before the lease loss');
});

test('propagates the observation reader\'s refusal for a missing archive client, writing no leg or row', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await seedSolanaProceeds(cycleRepository, cycleId);

  await assert.rejects(
    () => runMutateReturn({
      cycleRepository, cycleId, config: baseConfig(), robinhood: rpc({ historicalEvidenceClient: 'none' }),
      request: returnRequest({ cycleId, requestId: 'relay-return-no-archive' }), ctx: returnContext(cycleId),
    }),
    /distinct archive-capable historical evidence client is required/,
  );

  const state = await cycleRepository.describeCycle(cycleId);
  assert.equal(state.relayLegs.size, 0);
  assert.equal(state.custodyLedgers.get(CANONICAL_KEY), undefined);
});

test('propagates the observation reader\'s refusal for a public reorg between the finalized read and the recheck', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t);
  await seedSolanaProceeds(cycleRepository, cycleId);

  await assert.rejects(
    () => runMutateReturn({
      cycleRepository, cycleId, config: baseConfig(), robinhood: rpc({ recheckHash: `0x${'2'.repeat(64)}` }),
      request: returnRequest({ cycleId, requestId: 'relay-return-reorg' }), ctx: returnContext(cycleId),
    }),
    /public finalized block hash changed after the archive read/,
  );

  const state = await cycleRepository.describeCycle(cycleId);
  assert.equal(state.relayLegs.size, 0);
  assert.equal(state.custodyLedgers.get(CANONICAL_KEY), undefined);
});

test('the real stage-driver dispatches mutateReturn into the real repository through the new capability', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t, 'cycle-return-driver');
  await seedSolanaProceeds(cycleRepository, cycleId, '17');
  await canonicalV2Row(cycleRepository, cycleId);

  const config = baseConfig();
  const requestId = 'relay-return-driver-case';
  const quote = {
    direction: 'RETURN',
    requestId,
    origin: { chainId: 792703809, address: SOLANA_MINT, decimals: 6, amount: '17' },
    destination: { chainId: 4663, address: TOKEN, decimals: 6, amount: '16', minimumAmount: '16' },
    sender: SOLANA_OPERATOR,
    recipient: OPERATIONS,
    deadlineUnixSeconds: 4_102_444_800,
  };
  const intent = returnRequest({ cycleId, requestId }).intent;
  const steps = [{
    kind: 'transaction',
    requestId,
    items: [{ data: splTransferCheckedPlan('17') }],
  }];
  const relay = {
    async quoteReturnBridge() { return quote; },
    prepareExecution({ liveMode }) {
      if (liveMode !== true) throw new Error('return driver fixture requires liveMode');
      return { intent, steps };
    },
  };

  const driver = createStageDriver({
    liveMode: true,
    adapters: {
      relay,
      robinhood: rpc(),
      solana: { client: solanaClient() },
    },
    signerClient: markerSigner(),
    config,
    cycleRepository,
    preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
  });

  const context = {
    cycleId,
    stage: 'return',
    intent: { journalHead: 'return-custody-v2-driver' },
    fencingToken: '22222222-2222-4222-8222-222222222222',
    assertLease() {},
    async assertMutationAllowed() {},
  };

  await assert.rejects(() => driver.execute(context), new RegExp(MARKER_STOP));

  const state = await cycleRepository.describeCycle(cycleId);
  const leg = state.relayLegs.get(requestId);
  assert.ok(leg, 'the real stage-driver must reach recordReturnRelayLegExpectation');
  assert.equal(leg.state, 'RECORDED');
  assert.equal(state.returnLegLedgerKeys.get(requestId), CANONICAL_KEY);
  const row = state.custodyLedgers.get(CANONICAL_KEY);
  assert.deepEqual(row.expectedCycleAsset, {
    chainId: CANONICAL_CHAIN_ID, assetId: CANONICAL_ASSET_ID, decimals: 6, amountAtomic: '16',
  });
});

test('the real stage-driver reaches zero custody or leg-creation writes when the lease is lost while the real driver-fenced observation is suspended', async t => {
  const { repository: cycleRepository, cycleId } = await durableCycle(t, 'cycle-return-driver-lease-race');
  await seedSolanaProceeds(cycleRepository, cycleId, '17');

  let recordCustodyLedgerCalls = 0;
  const originalRecordCustodyLedger = cycleRepository.recordCustodyLedger.bind(cycleRepository);
  cycleRepository.recordCustodyLedger = async (...args) => { recordCustodyLedgerCalls += 1; return originalRecordCustodyLedger(...args); };
  let recordExpectationCalls = 0;
  const originalRecordExpectation = cycleRepository.recordReturnRelayLegExpectation.bind(cycleRepository);
  cycleRepository.recordReturnRelayLegExpectation = async (...args) => { recordExpectationCalls += 1; return originalRecordExpectation(...args); };

  const config = baseConfig();
  const requestId = 'relay-return-driver-lease-race';
  const quote = {
    direction: 'RETURN',
    requestId,
    origin: { chainId: 792703809, address: SOLANA_MINT, decimals: 6, amount: '17' },
    destination: { chainId: 4663, address: TOKEN, decimals: 6, amount: '16', minimumAmount: '16' },
    sender: SOLANA_OPERATOR,
    recipient: OPERATIONS,
    deadlineUnixSeconds: 4_102_444_800,
  };
  const intent = returnRequest({ cycleId, requestId }).intent;
  const steps = [{ kind: 'transaction', requestId, items: [{ data: splTransferCheckedPlan('17') }] }];
  const relay = {
    async quoteReturnBridge() { return quote; },
    prepareExecution({ liveMode }) {
      if (liveMode !== true) throw new Error('return driver fixture requires liveMode');
      return { intent, steps };
    },
  };

  let signalSuspended;
  const suspended = new Promise(resolve => { signalSuspended = resolve; });
  let releaseGate;
  const gate = new Promise(resolve => { releaseGate = resolve; });
  let leaseLost = false;
  let getBlockCalls = 0;
  const robinhood = {
    client: {
      async getBlock() {
        getBlockCalls += 1;
        if (getBlockCalls === 1) return { number: 100n, hash: `0x${'f'.repeat(64)}`, timestamp: 1_700_000_000n };
        signalSuspended();
        await gate;
        return { number: 100n, hash: `0x${'f'.repeat(64)}`, timestamp: 1_700_000_000n };
      },
    },
    historicalEvidenceClient: {
      async readErc20BalanceAtBlock({ blockNumber, blockHash }) {
        return { value: 500_000n, blockNumber, blockHash };
      },
    },
  };

  const driver = createStageDriver({
    liveMode: true,
    adapters: { relay, robinhood, solana: { client: solanaClient() } },
    signerClient: markerSigner(),
    config,
    cycleRepository,
    preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
  });

  const context = {
    cycleId,
    stage: 'return',
    intent: { journalHead: 'return-custody-v2-driver-lease-race' },
    fencingToken: '22222222-2222-4222-8222-222222222222',
    assertLease() { if (leaseLost) throw new Error('LEASE_LOST_DURING_DRIVER_RECHECK'); },
    async assertMutationAllowed() {},
  };

  const runPromise = driver.execute(context);
  await suspended;
  leaseLost = true;
  releaseGate();

  await assert.rejects(() => runPromise, /LEASE_LOST_DURING_DRIVER_RECHECK/);
  assert.equal(recordCustodyLedgerCalls, 0);
  assert.equal(recordExpectationCalls, 0);
  const state = await cycleRepository.describeCycle(cycleId);
  assert.equal(state.relayLegs.size, 0);
  assert.equal(state.custodyLedgers.get(CANONICAL_KEY), undefined);
});

function fakeReturnLegRepository({ state, associated, rawRowPresent, canonicalRowPresent }) {
  const leg = {
    relayRequestId: 'relay-return-settled-fake',
    direction: 'return',
    state,
    sourceTxHash: state === 'RECORDED' ? null : 'return-source-fake',
    destinationChainId: '4663',
    destinationAssetId: TOKEN,
    destinationDecimals: 6,
    destinationAmountAtomic: '16',
  };
  const custodyLedgers = new Map();
  if (rawRowPresent) custodyLedgers.set(RAW_KEY, { schema: 'hookemon.custody-ledger.v1', chainId: '4663', assetId: TOKEN, decimals: 6 });
  if (canonicalRowPresent) {
    custodyLedgers.set(CANONICAL_KEY, { schema: 'hookemon.custody-ledger.v2', chainId: CANONICAL_CHAIN_ID, assetId: CANONICAL_ASSET_ID, decimals: 6 });
  }
  const returnLegLedgerKeys = new Map();
  if (associated) returnLegLedgerKeys.set(leg.relayRequestId, CANONICAL_KEY);
  return {
    async describeCycle() {
      return { relayLegs: new Map([[leg.relayRequestId, leg]]), custodyLedgers, returnLegLedgerKeys, chainAttempts: new Map() };
    },
  };
}

test('the SETTLED fast path refuses when the attributed custody row is missing instead of deriving from raw identity', async () => {
  const cycleRepository = fakeReturnLegRepository({ state: 'SETTLED', associated: true, rawRowPresent: false, canonicalRowPresent: false });
  await assert.rejects(
    () => reconcileLiveReturn({ adapters: null, config: baseConfig(), cycleRepository, context: { cycleId: 'cycle-return-settled-missing' } }),
    error => error instanceof ReturnRecoveryRequiredError && error.recoveryState === 'RETURN_CUSTODY_ASSOCIATION_MISSING',
  );
});

test('the SETTLED fast path refuses when a raw predecessor coexists alongside the settled leg\'s own canonical row', async () => {
  const cycleRepository = fakeReturnLegRepository({ state: 'SETTLED', associated: true, rawRowPresent: true, canonicalRowPresent: true });
  await assert.rejects(
    () => reconcileLiveReturn({ adapters: null, config: baseConfig(), cycleRepository, context: { cycleId: 'cycle-return-settled-split' } }),
    error => error instanceof ReturnRecoveryRequiredError && error.recoveryState === 'RETURN_CUSTODY_IDENTITY_SPLIT',
  );
});

test('the SETTLED fast path refuses a pre-migration leg attributed only to its own raw row rather than trusting its raw identity', async () => {
  const cycleRepository = fakeReturnLegRepository({ state: 'SETTLED', associated: false, rawRowPresent: true, canonicalRowPresent: false });
  await assert.rejects(
    () => reconcileLiveReturn({ adapters: null, config: baseConfig(), cycleRepository, context: { cycleId: 'cycle-return-settled-legacy' } }),
    error => error instanceof ReturnRecoveryRequiredError && error.recoveryState === 'RETURN_CUSTODY_ASSOCIATION_MISSING',
  );
});

test('a RECORDED leg with no durable canonical association refuses before any broadcast, finality, or settlement effect', async () => {
  const cycleRepository = fakeReturnLegRepository({ state: 'RECORDED', associated: false, rawRowPresent: false, canonicalRowPresent: false });
  cycleRepository.recordBroadcast = async () => { throw new Error('must not broadcast before the association check'); };
  cycleRepository.recordFinality = async () => { throw new Error('must not finalize before the association check'); };
  cycleRepository.settleRelayLeg = async () => { throw new Error('must not settle before the association check'); };
  await assert.rejects(
    () => reconcileLiveReturn({ adapters: null, config: baseConfig(), cycleRepository, context: { cycleId: 'cycle-return-recorded-unassociated' } }),
    error => error instanceof ReturnRecoveryRequiredError && error.recoveryState === 'RETURN_CUSTODY_ASSOCIATION_MISSING',
  );
});

test('a RECORDED leg with a legitimate canonical association passes the pre-settlement check and proceeds', async () => {
  const cycleRepository = fakeReturnLegRepository({ state: 'RECORDED', associated: true, rawRowPresent: false, canonicalRowPresent: true });
  // No sourceTxHash yet -- reconcileLiveReturn must return null right after the association check
  // passes, never reaching a repository method this fake does not implement.
  const result = await reconcileLiveReturn({ adapters: null, config: baseConfig(), cycleRepository, context: { cycleId: 'cycle-return-recorded-associated' } });
  assert.equal(result, null);
});
