import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { DIRECTIONS, RELAY_CONSTANTS } from '../../src/relay-client.mjs';
import { createSolanaRpcClient, TOKEN_PROGRAM_ID } from '../../src/solana-rpc.mjs';
import {
  ReturnRecoveryRequiredError,
  mutateReturn,
  prepareReturnRequest,
  probeReturn,
  reconcileLiveReturn,
} from '../../src/app/stages/return.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';

// Focused coverage for BOT-RETURN-CHAIN-IDENTITY: buyback.mjs attributes realized Solana proceeds
// under the native Collector/Solana settlement identity (chain id `solana-mainnet`,
// COLLECTOR_CRYPT_SETTLEMENT_ASSET's mint) -- never Relay's own wire SOLANA_CHAIN_ID (792703809),
// which return.mjs used to (wrongly) look custody rows up by. Every test here drives the real
// `prepareReturnRequest`/`probeReturn`/`mutateReturn`/`reconcileLiveReturn` entrypoints against a
// real, durable `CycleRepository` -- never a bare unit-tested helper -- so every assertion observes
// what the actual repository journal produced.

const EVM_ACCOUNT = `0x${'b'.repeat(40)}`;
const SOLANA_OPERATOR = '8PJ6Nrp5eyzBzYCvApEZCGpdw9AreDAnM2Haf4QRGUto';
const SOLANA_SOURCE = '8MWgLuNVQAhpoTUQZiUUkG9Q1569HCkJbmAivoQ5VhDN';
const SOLANA_DESTINATION = '4nvJ5zWdVspxJiNZzB127U6amPH98SFFkBx2JZrAduia';
// The real Collector settlement mint (`CIRCLE_USD_MINT` in collector-crypt.mjs / solana-rpc.mjs):
// the native settlement identity is only trusted when its assetId matches this exact mint.
const SOLANA_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const USDG_TOKEN = RELAY_CONSTANTS.USDG_ADDRESS;
const NATIVE_CHAIN_ID = 'solana-mainnet';
const RELAY_WIRE_CHAIN_ID = String(RELAY_CONSTANTS.SOLANA_CHAIN_ID);
const TEST_PREFLIGHT_AUTHORITY = createTestProfileMutationAuthority();
const MARKER_STOP = 'MARKER_STOP_AFTER_RETURN_CHAIN_IDENTITY';

async function durableCycle(t, cycleId = 'cycle-return-chain-identity-1') {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-return-chain-identity-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = await CycleRepository.open(directory);
  await repository.createCycle({ releaseAmount: '1', mode: 'production', cycleId });
  return { repository, cycleId };
}

function custodyBuckets(overrides = {}) {
  return {
    claimed: '0', bridgeOut: '0', bridgeIn: '0', packCost: '0', buybackProceeds: '0',
    returnInput: '0', returnReceived: '0', refunds: '0', residual: '0', heldAssets: '0',
    heldPositions: '0', payoutLiability: '0', dust: '0', unattributed: '0',
    ...overrides,
  };
}

/** The real native identity buyback.mjs writes realized proceeds under. */
async function seedNativeProceeds(repository, cycleId, { proceeds = '90', committed = '0' } = {}) {
  await repository.recordCustodyLedger(cycleId, {
    schema: 'hookemon.custody-ledger.v1',
    cycleId,
    chainId: NATIVE_CHAIN_ID,
    assetId: SOLANA_MINT,
    decimals: 6,
    ...custodyBuckets({ buybackProceeds: proceeds, returnInput: committed }),
  });
}

/** A row keyed by Relay's own wire chain id -- the identity the pre-fix lookup wrongly used. */
async function seedWireIdentityProceeds(repository, cycleId, { proceeds = '90', committed = '0' } = {}) {
  await repository.recordCustodyLedger(cycleId, {
    schema: 'hookemon.custody-ledger.v1',
    cycleId,
    chainId: RELAY_WIRE_CHAIN_ID,
    assetId: SOLANA_MINT,
    decimals: 6,
    ...custodyBuckets({ buybackProceeds: proceeds, returnInput: committed }),
  });
}

async function seedHeldPosition(repository, cycleId, suffix = '1') {
  return repository.recordHeldPosition(cycleId, {
    packId: `pack-${suffix}`,
    memo: `memo-${suffix}`,
    mint: `mint-${suffix}`,
    cardRef: `mint-${suffix}`,
    costMicroUsdg: '1000000',
    valueMicroUsdg: '1000000',
    insuredValue: null,
    reason: 'EPIC_THRESHOLD',
    terminalState: 'HELD_OWNER_DECISION',
    evidence: { note: `held-${suffix}` },
  });
}

/**
 * The real durable buyback stage-attempt evidence shape (`reconcilePack`/`reconcileLiveBuyback`'s
 * own `{ packs, soldCount }` result, persisted through the generic stage-driver
 * `recordStageAttempt`/`readStageAttempt('buyback', ...)`), recording a sold pack -- with no
 * matching native custody ledger row, exactly the state a process interrupted between
 * `reconcileLiveBuyback`'s own custody write and the stage-driver's own attempt write leaves
 * behind.
 */
async function seedSoldBuybackAttemptWithoutLedger(repository, cycleId, { proceeds = '90' } = {}) {
  const sold = {
    packIndex: 0,
    decision: 'sold',
    memo: 'memo-sold',
    mint: SOLANA_SOURCE,
    signature: 'fixture-finalized-sale',
    proceeds: { chainId: NATIVE_CHAIN_ID, assetId: SOLANA_MINT, decimals: 6, amountAtomic: proceeds },
  };
  await repository.recordStageAttempt(cycleId, 'buyback', { packs: [sold], soldCount: 1 });
}

function moneyConfiguration() {
  return {
    schema: 'hookemon.money-configuration.v1',
    assets: {
      usdg: { chainId: '4663', assetId: USDG_TOKEN, decimals: 6 },
      solanaStablecoin: { chainId: RELAY_WIRE_CHAIN_ID, assetId: SOLANA_MINT, decimals: 6 },
    },
    minimums: {
      robinhoodReceive: { chainId: '4663', assetId: USDG_TOKEN, decimals: 6, amountAtomic: '0' },
      solanaReceive: { chainId: RELAY_WIRE_CHAIN_ID, assetId: SOLANA_MINT, decimals: 6, amountAtomic: '0' },
      returnUsdg: { chainId: '4663', assetId: USDG_TOKEN, decimals: 6, amountAtomic: '0' },
    },
    evm: {
      perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '100' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '1000' },
    },
    solana: {
      priorityFeeCap: { chainId: RELAY_WIRE_CHAIN_ID, assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '100' },
      lamportReserve: { chainId: RELAY_WIRE_CHAIN_ID, assetId: 'native', decimals: 9, amountAtomic: '1000' },
    },
  };
}

function baseConfig(overrides = {}) {
  return {
    chainId: 4663,
    accounts: { evm: EVM_ACCOUNT, solana: SOLANA_OPERATOR },
    relay: { solanaMint: SOLANA_MINT, maxSettlementWindowSeconds: '600' },
    moneyConfiguration: moneyConfiguration(),
    solana: { chainId: NATIVE_CHAIN_ID },
    collectorCrypt: { settlementAsset: { chainId: NATIVE_CHAIN_ID, assetId: SOLANA_MINT, decimals: 6 } },
    ...overrides,
  };
}

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

function returnIntentFor({ requestId, amountAtomic, destinationAmountAtomic, sender, recipient }) {
  return {
    schema: 'hookemon.relay-intent.v1',
    requestId,
    orderId: `0x${'9'.repeat(64)}`,
    direction: 'RETURN',
    tradeType: 'EXACT_INPUT',
    quoteDigest: `sha256:${'7'.repeat(64)}`,
    originChainId: RELAY_CONSTANTS.SOLANA_CHAIN_ID,
    destinationChainId: RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID,
    originAssetId: SOLANA_MINT,
    originDecimals: 6,
    destinationAssetId: USDG_TOKEN,
    destinationDecimals: 6,
    originAmount: amountAtomic,
    quotedDestinationAmount: destinationAmountAtomic,
    quotedDestinationMinimumAmount: destinationAmountAtomic,
    sender,
    recipient,
    deadlineUnixSeconds: 4_102_444_800,
  };
}

/** A minimal, self-contained Relay double: never real network, but a faithful quote/execution shape. */
function relayStub() {
  const quoteCalls = [];
  return {
    quoteCalls,
    async quoteReturnBridge(args) {
      quoteCalls.push(args);
      const destinationAmountAtomic = (BigInt(args.amount) - 1n).toString();
      return {
        direction: DIRECTIONS.RETURN,
        requestId: `relay-return-chain-identity-${quoteCalls.length}`,
        origin: { chainId: RELAY_CONSTANTS.SOLANA_CHAIN_ID, address: args.originCurrency, decimals: 6, amount: args.amount },
        destination: { chainId: RELAY_CONSTANTS.ROBINHOOD_CHAIN_ID, address: USDG_TOKEN, decimals: 6, amount: destinationAmountAtomic, minimumAmount: destinationAmountAtomic },
        sender: args.user,
        recipient: args.recipient,
        deadlineUnixSeconds: 4_102_444_800,
      };
    },
    prepareExecution({ quote, liveMode }) {
      if (liveMode !== true) throw new Error('return-chain-identity relay stub requires liveMode');
      return {
        intent: returnIntentFor({
          requestId: quote.requestId,
          amountAtomic: quote.origin.amount,
          destinationAmountAtomic: quote.destination.amount,
          sender: quote.sender,
          recipient: quote.recipient,
        }),
        steps: [{ kind: 'transaction', requestId: quote.requestId, items: [{ data: splTransferCheckedPlan(quote.origin.amount) }] }],
      };
    },
    simulateExecution({ quote }) { return { quote }; },
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

function robinhoodObservationClient({ archiveBalance = 0n } = {}) {
  return {
    client: { async getBlock() { return { number: 100n, hash: `0x${'f'.repeat(64)}`, timestamp: 1_700_000_000n }; } },
    historicalEvidenceClient: {
      async readErc20BalanceAtBlock({ blockNumber, blockHash }) { return { value: archiveBalance, blockNumber, blockHash }; },
    },
  };
}

function markerSigner() {
  return { solana: { role: 'operator-solana', async sign() { throw new Error(MARKER_STOP); }, async broadcast() {} } };
}

const UNTOUCHABLE_RELAY = new Proxy({}, { get() { throw new Error('must not call Relay on a refused path'); } });
const UNTOUCHABLE_SIGNER = { solana: { async sign() { throw new Error('must not sign on a refused path'); }, async broadcast() { throw new Error('must not broadcast on a refused path'); } } };

test('prepareReturnRequest quotes exactly the native ledger delta despite a distinct held position, never emitting zero evidence', async t => {
  const { repository, cycleId } = await durableCycle(t);
  await seedNativeProceeds(repository, cycleId, { proceeds: '90', committed: '0' });
  await seedHeldPosition(repository, cycleId, 'distinct-held');
  const relay = relayStub();

  const request = await prepareReturnRequest({
    adapters: { relay },
    config: baseConfig(),
    cycleRepository: repository,
    context: { cycleId },
    nowMs: 1_700_000_000_000,
  });

  assert.equal(relay.quoteCalls.length, 1, 'quoteReturnBridge must be called exactly once');
  assert.equal(relay.quoteCalls[0].amount, '90');
  assert.equal(request.schema, 'hookemon.return-relay-request.v1');
  assert.equal(request.inputAmount.amountAtomic, '90');
  assert.equal(request.inputAmount.chainId, RELAY_WIRE_CHAIN_ID, 'the Relay-facing typed amount keeps Relay\'s own wire chain id');
});

test('probeReturn reports the exact native ledger delta and quotes it', async t => {
  const { repository, cycleId } = await durableCycle(t);
  await seedNativeProceeds(repository, cycleId, { proceeds: '90', committed: '0' });
  const relay = relayStub();

  const probe = await probeReturn({
    adapters: { relay },
    config: baseConfig(),
    cycleRepository: repository,
    context: { cycleId },
  });

  assert.equal(probe.configured, true);
  assert.equal(probe.availableAmount, '90');
  assert.equal(relay.quoteCalls.length, 1);
  assert.equal(relay.quoteCalls[0].amount, '90');
});

test('a partial committed delta quotes only the uncommitted remainder', async t => {
  const { repository, cycleId } = await durableCycle(t);
  await seedNativeProceeds(repository, cycleId, { proceeds: '90', committed: '30' });
  const relay = relayStub();

  const request = await prepareReturnRequest({
    adapters: { relay },
    config: baseConfig(),
    cycleRepository: repository,
    context: { cycleId },
    nowMs: 1_700_000_000_000,
  });

  assert.equal(relay.quoteCalls[0].amount, '60');
  assert.equal(request.inputAmount.amountAtomic, '60');
});

test('positive mutation validation resolves the same native row and reaches signing, not a missing-ledger failure', async t => {
  const { repository, cycleId } = await durableCycle(t);
  await seedNativeProceeds(repository, cycleId, { proceeds: '90', committed: '0' });
  await seedHeldPosition(repository, cycleId, 'distinct-held');
  const relay = relayStub();
  const config = baseConfig();

  const request = await prepareReturnRequest({
    adapters: { relay },
    config,
    cycleRepository: repository,
    context: { cycleId },
    nowMs: 1_700_000_000_000,
  });
  assert.equal(request.inputAmount.amountAtomic, '90');

  await assert.rejects(
    () => mutateReturn({
      liveMode: true,
      adapters: { solana: { client: solanaClient() }, robinhood: robinhoodObservationClient() },
      signerClient: markerSigner(),
      config,
      cycleRepository: repository,
      context: {
        cycleId,
        stage: 'return',
        requestDigest: `sha256:${'a'.repeat(64)}`,
        fencingToken: '11111111-1111-4111-8111-111111111111',
      },
      request,
      preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
      now: () => 1_700_000_000_000,
    }),
    new RegExp(MARKER_STOP),
  );

  const state = await repository.describeCycle(cycleId);
  const leg = state.relayLegs.get(request.intent.requestId);
  assert.ok(leg, 'mutation must reach real leg creation, not refuse for a missing source row');
  assert.equal(leg.state, 'RECORDED');
  const evmRow = [...state.custodyLedgers.values()].find(row => row.chainId !== NATIVE_CHAIN_ID);
  assert.ok(evmRow, 'the EVM destination custody row must have been written alongside the leg');
  assert.equal(evmRow.expectedCycleAsset.amountAtomic, request.destinationAmount.amountAtomic);
});

test('a competing Relay-wire-identity custody row refuses prepare, probe, and mutation before any quote or write', async t => {
  const { repository, cycleId } = await durableCycle(t);
  await seedNativeProceeds(repository, cycleId, { proceeds: '90', committed: '0' });
  await seedWireIdentityProceeds(repository, cycleId, { proceeds: '5', committed: '0' });
  const before = await repository.describeCycle(cycleId);

  await assert.rejects(
    () => prepareReturnRequest({
      adapters: { relay: UNTOUCHABLE_RELAY },
      config: baseConfig(),
      cycleRepository: repository,
      context: { cycleId },
      nowMs: 1_700_000_000_000,
    }),
    /conflicting with the native settlement identity/,
  );

  const probe = await probeReturn({
    adapters: { relay: UNTOUCHABLE_RELAY },
    config: baseConfig(),
    cycleRepository: repository,
    context: { cycleId },
  });
  assert.equal(probe.configured, true);
  assert.match(probe.reason, /conflicting with the native settlement identity/);

  const request = {
    schema: 'hookemon.return-relay-request.v1',
    cycleId,
    inputAmount: { chainId: RELAY_WIRE_CHAIN_ID, assetId: SOLANA_MINT, decimals: 6, amountAtomic: '90' },
    destinationAmount: { chainId: '4663', assetId: USDG_TOKEN, decimals: 6, amountAtomic: '89' },
    requestCreatedAtUnixSeconds: '1700000000',
    maxSettlementWindowSeconds: '600',
    intent: returnIntentFor({ requestId: 'relay-return-conflict', amountAtomic: '90', destinationAmountAtomic: '89', sender: SOLANA_OPERATOR, recipient: EVM_ACCOUNT }),
    solanaInstructionPlan: splTransferCheckedPlan('90'),
  };
  await assert.rejects(
    () => mutateReturn({
      liveMode: true,
      adapters: { solana: { client: solanaClient() }, robinhood: robinhoodObservationClient() },
      signerClient: UNTOUCHABLE_SIGNER,
      config: baseConfig(),
      cycleRepository: repository,
      context: {
        cycleId,
        stage: 'return',
        requestDigest: `sha256:${'b'.repeat(64)}`,
        fencingToken: '11111111-1111-4111-8111-111111111111',
      },
      request,
      preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
      now: () => 1_700_000_000_000,
    }),
    /conflicting with the native settlement identity/,
  );

  const after = await repository.describeCycle(cycleId);
  assert.deepEqual([...after.custodyLedgers.entries()], [...before.custodyLedgers.entries()], 'a refused path must write no custody row');
  assert.equal(after.relayLegs.size, 0, 'a refused path must create no Relay leg');
});

test('a missing native source row with Relay-wire-identity sold evidence and a held position refuses, never zero', async t => {
  const { repository, cycleId } = await durableCycle(t);
  await seedWireIdentityProceeds(repository, cycleId, { proceeds: '90', committed: '0' });
  await seedHeldPosition(repository, cycleId, 'distinct-held');

  await assert.rejects(
    () => prepareReturnRequest({
      adapters: { relay: UNTOUCHABLE_RELAY },
      config: baseConfig(),
      cycleRepository: repository,
      context: { cycleId },
      nowMs: 1_700_000_000_000,
    }),
    /conflicting with the native settlement identity/,
  );
});

test('a genuine all-held zero return persists final evidence, replays byte-identically, and reconciles the same evidence', async t => {
  const { repository, cycleId } = await durableCycle(t);
  await seedHeldPosition(repository, cycleId, 'all-held');
  const config = baseConfig();

  const request = await prepareReturnRequest({
    adapters: { relay: UNTOUCHABLE_RELAY },
    config,
    cycleRepository: repository,
    context: { cycleId },
    nowMs: 1_700_000_000_000,
  });
  assert.equal(request.schema, 'hookemon.return-zero-proceeds-request.v1');
  assert.equal(request.inputAmount.amountAtomic, '0');

  const context = { cycleId, stage: 'return', requestDigest: `sha256:${'c'.repeat(64)}` };
  const first = await mutateReturn({
    liveMode: true, adapters: null, signerClient: UNTOUCHABLE_SIGNER, config, cycleRepository: repository,
    context, request, preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
  });
  assert.equal(first.schema, 'hookemon.return-zero-proceeds-evidence.v1');

  const replay = await mutateReturn({
    liveMode: true, adapters: null, signerClient: UNTOUCHABLE_SIGNER, config, cycleRepository: repository,
    context, request, preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
  });
  assert.deepEqual(replay, first);

  const reconciled = await reconcileLiveReturn({ adapters: null, config, cycleRepository: repository, context: { cycleId } });
  assert.deepEqual(reconciled, first);
});

test('a false zero-proceeds evidence recorded before this fix cannot finalize or replay once positive native proceeds exist', async t => {
  const { repository, cycleId } = await durableCycle(t);
  await seedHeldPosition(repository, cycleId, 'stale-zero');
  const config = baseConfig();

  const zeroRequest = await prepareReturnRequest({
    adapters: { relay: UNTOUCHABLE_RELAY },
    config,
    cycleRepository: repository,
    context: { cycleId },
    nowMs: 1_700_000_000_000,
  });
  const context = { cycleId, stage: 'return', requestDigest: `sha256:${'d'.repeat(64)}` };
  const staleEvidence = await mutateReturn({
    liveMode: true, adapters: null, signerClient: UNTOUCHABLE_SIGNER, config, cycleRepository: repository,
    context, request: zeroRequest, preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
  });
  assert.equal(staleEvidence.schema, 'hookemon.return-zero-proceeds-evidence.v1');

  // A genuinely sold pack settles after the stale zero evidence was already durably recorded --
  // exactly the false-zero scenario this identity fix closes.
  await seedNativeProceeds(repository, cycleId, { proceeds: '90', committed: '0' });

  await assert.rejects(
    () => mutateReturn({
      liveMode: true, adapters: null, signerClient: UNTOUCHABLE_SIGNER, config, cycleRepository: repository,
      context, request: zeroRequest, preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
    }),
    /conflicts with a positive cycle-attributed proceeds delta observed now/,
  );

  await assert.rejects(
    () => reconcileLiveReturn({ adapters: null, config, cycleRepository: repository, context: { cycleId } }),
    error => error instanceof ReturnRecoveryRequiredError && error.recoveryState === 'RETURN_ZERO_PROCEEDS_EVIDENCE_STALE',
  );

  const state = await repository.describeCycle(cycleId);
  const ledger = [...state.custodyLedgers.values()].find(row => row.chainId === NATIVE_CHAIN_ID);
  assert.equal(ledger.buybackProceeds, '90', 'the refused recheck must not mutate the native ledger it read');
});

test('a native settlement asset that only self-agrees with config.solana.chainId, without matching the trusted constant, refuses', async t => {
  const { repository, cycleId } = await durableCycle(t);
  await seedNativeProceeds(repository, cycleId, { proceeds: '90', committed: '0' });
  // Both configured fields wrongly "agree" on Relay's own wire chain id instead of the real
  // native `solana-mainnet` identity -- mutual self-consistency alone must not be trusted.
  const config = baseConfig({
    solana: { chainId: RELAY_WIRE_CHAIN_ID },
    collectorCrypt: { settlementAsset: { chainId: RELAY_WIRE_CHAIN_ID, assetId: SOLANA_MINT, decimals: 6 } },
  });

  await assert.rejects(
    () => prepareReturnRequest({
      adapters: { relay: UNTOUCHABLE_RELAY },
      config,
      cycleRepository: repository,
      context: { cycleId },
      nowMs: 1_700_000_000_000,
    }),
    /does not match the trusted native Collector settlement identity/,
  );
});

test('prepareReturnRequest refuses a durably sold pack with no matching custody ledger row, even with a distinct held position', async t => {
  const { repository, cycleId } = await durableCycle(t);
  await seedHeldPosition(repository, cycleId, 'distinct-held');
  await seedSoldBuybackAttemptWithoutLedger(repository, cycleId, { proceeds: '90' });
  const before = await repository.describeCycle(cycleId);
  assert.equal(before.custodyLedgers.size, 0, 'fixture must start with no custody ledger row of either identity');

  await assert.rejects(
    () => prepareReturnRequest({
      adapters: { relay: UNTOUCHABLE_RELAY },
      config: baseConfig(),
      cycleRepository: repository,
      context: { cycleId },
      nowMs: 1_700_000_000_000,
    }),
    /durable buyback evidence records a sold pack with no matching native custody ledger row/,
  );

  const after = await repository.describeCycle(cycleId);
  assert.equal(after.custodyLedgers.size, 0, 'a refused prepare must write no custody row');
  assert.deepEqual([...after.heldPositions.entries()], [...before.heldPositions.entries()]);
});

test('mutateReturn refuses a preexisting zero-proceeds request once durable sold-without-ledger evidence surfaces, persisting no zero attempt', async t => {
  const { repository, cycleId } = await durableCycle(t);
  await seedHeldPosition(repository, cycleId, 'distinct-held');
  const config = baseConfig();

  // Genuinely all-held at the moment this request was built -- no sold evidence exists yet.
  const zeroRequest = await prepareReturnRequest({
    adapters: { relay: UNTOUCHABLE_RELAY },
    config,
    cycleRepository: repository,
    context: { cycleId },
    nowMs: 1_700_000_000_000,
  });
  assert.equal(zeroRequest.schema, 'hookemon.return-zero-proceeds-request.v1');

  // A durable buyback sold outcome now surfaces (e.g. a resumed buyback reconciliation) with its
  // custody-ledger write still missing -- inconsistent with the request built a moment earlier.
  await seedSoldBuybackAttemptWithoutLedger(repository, cycleId, { proceeds: '90' });

  const context = { cycleId, stage: 'return', requestDigest: `sha256:${'e'.repeat(64)}` };
  await assert.rejects(
    () => mutateReturn({
      liveMode: true, adapters: null, signerClient: UNTOUCHABLE_SIGNER, config, cycleRepository: repository,
      context, request: zeroRequest, preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
    }),
    /durable buyback evidence records a sold pack with no matching native custody ledger row/,
  );

  assert.equal(await repository.readStageAttempt(cycleId, 'return'), null, 'a refused mutation must persist no zero-proceeds attempt');
  const after = await repository.describeCycle(cycleId);
  assert.equal(after.custodyLedgers.size, 0, 'a refused mutation must write no custody row');
});

test('reconcileLiveReturn refuses preexisting zero-proceeds evidence once durable sold-without-ledger evidence surfaces', async t => {
  const { repository, cycleId } = await durableCycle(t);
  await seedHeldPosition(repository, cycleId, 'distinct-held');
  const config = baseConfig();

  const zeroRequest = await prepareReturnRequest({
    adapters: { relay: UNTOUCHABLE_RELAY },
    config,
    cycleRepository: repository,
    context: { cycleId },
    nowMs: 1_700_000_000_000,
  });
  const context = { cycleId, stage: 'return', requestDigest: `sha256:${'f'.repeat(64)}` };
  const zeroEvidence = await mutateReturn({
    liveMode: true, adapters: null, signerClient: UNTOUCHABLE_SIGNER, config, cycleRepository: repository,
    context, request: zeroRequest, preflightAuthority: TEST_PREFLIGHT_AUTHORITY,
  });
  assert.equal(zeroEvidence.schema, 'hookemon.return-zero-proceeds-evidence.v1');

  // The durable sold outcome surfaces only after the zero evidence was already finalized.
  await seedSoldBuybackAttemptWithoutLedger(repository, cycleId, { proceeds: '90' });

  await assert.rejects(
    () => reconcileLiveReturn({ adapters: null, config, cycleRepository: repository, context: { cycleId } }),
    error => error instanceof ReturnRecoveryRequiredError && error.recoveryState === 'RETURN_ZERO_PROCEEDS_EVIDENCE_SOLD_WITHOUT_LEDGER',
  );

  const storedEvidence = await repository.readStageAttempt(cycleId, 'return');
  assert.deepEqual(storedEvidence, zeroEvidence, 'a refused reconciliation must not alter the recorded evidence');
  const after = await repository.describeCycle(cycleId);
  assert.equal(after.custodyLedgers.size, 0, 'a refused reconciliation must write no custody row');
});
