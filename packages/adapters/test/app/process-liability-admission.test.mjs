// The focused negatives the frozen process-liability interface requires. Every case drives the real
// archive read, the real admission planner, or the real pre-sign veto against isolated in-memory
// chain state; none contacts a provider, and no address here stands in for a deployed one.
import assert from 'node:assert/strict';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';

import { createHistoricalErc20EvidenceClient } from '../../src/robinhood-rpc.mjs';
import { buildAdmissionPlanner, buildProcessLiabilityReader } from '../../src/app/compose.mjs';
import { mutateClaimProcess, prepareClaimProcessRequest } from '../../src/app/stages/claim-process.mjs';
import { deriveOnchainCycleId } from '../../src/app/stages/action-builder.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';

const HOOK = `0x${'1'.repeat(40)}`;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const BLOCK_HASH = `0x${'1'.repeat(64)}`;
const OTHER_HASH = `0x${'2'.repeat(64)}`;
const CYCLE_ID = 'cycle-process-liability-1';
const COVERS = 10n ** 12n;
const AUTHORITY = createTestProfileMutationAuthority();
const PLANNER_OPERATIONS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SETTLEMENT_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function moneyConfiguration() {
  const usdg = { chainId: '4663', assetId: USDG, decimals: 6 };
  const solanaStablecoin = { chainId: '792703809', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
  return {
    schema: 'hookemon.money-configuration.v1',
    assets: { usdg, solanaStablecoin },
    minimums: {
      robinhoodReceive: { ...usdg, amountAtomic: '0' },
      solanaReceive: { ...solanaStablecoin, amountAtomic: '0' },
      returnUsdg: { ...usdg, amountAtomic: '0' },
    },
    evm: {
      perTransactionGasPriceCap: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '2' },
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '100' },
    },
    solana: {
      priorityFeeCap: { chainId: '792703809', assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '2' },
      lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '2' },
    },
  };
}

/**
 * An isolated chain that answers each hook getter from in-memory state at an explicit block, so the
 * real `readHookProcessStateAtBlock` performs its own height and hash binding over these values.
 */
function isolatedChain({ state = {}, blockHashAt = () => BLOCK_HASH, operations } = {}) {
  const values = {
    processLiability: COVERS,
    remainingProcessClaimCapacity: COVERS,
    processClaimsPaused: false,
    processClaimCycleUsed: false,
    activeProcessClaimLimit: 4n,
    totalLiability: COVERS,
    hookUsdgBalance: COVERS,
    isSolvent: true,
    ...state,
  };
  const reads = [];
  return {
    reads,
    client: {
      async readContract({ functionName, blockNumber }) {
        reads.push({ functionName, blockNumber });
        if (functionName === 'readRoles') {
          return [{ programmableBeneficiary: HOOK, treasury: HOOK, operations }, {}, {}, {}];
        }
        if (!(functionName in values)) throw new Error(`unexpected getter ${functionName}`);
        return values[functionName];
      },
      async getBlock({ blockNumber } = {}) {
        // The finalized-head selection and the explicit-height recheck are distinct reads; both are
        // answered here so the real block binding runs against this isolated chain.
        const height = blockNumber ?? 10n;
        return { number: height, hash: blockHashAt(height), timestamp: 1n };
      },
    },
  };
}

function evidenceClientFor(chain) {
  return createHistoricalErc20EvidenceClient({ client: chain.client });
}

async function readState(chain, overrides = {}) {
  return evidenceClientFor(chain).readHookProcessStateAtBlock({
    hook: HOOK,
    onchainCycleId: BLOCK_HASH,
    blockNumber: 10n,
    blockHash: BLOCK_HASH,
    ...overrides,
  });
}

// The source of truth is the hook ledger, not the Operations wallet.
test('a prefunded Operations wallet cannot substitute for hook liability below the amount', async () => {
  const operations = `0x${'2'.repeat(40)}`;
  const chain = isolatedChain({ operations, state: { processLiability: 0n } });
  const state = await readState(chain);
  // The wallet is irrelevant to this evidence; the hook reports nothing claimable.
  assert.equal(state.processLiability, 0n);
  assert.ok(state.processLiability < COVERS, 'a zero ledger cannot cover the amount');
});

test('an empty Operations wallet still admits when hook liability and capacity cover the amount', async () => {
  const operations = `0x${'2'.repeat(40)}`;
  const state = await readState(isolatedChain({ operations }));
  assert.equal(state.processLiability, COVERS);
  assert.equal(state.remainingProcessClaimCapacity, COVERS);
  assert.equal(state.operations, operations.toLowerCase());
});

// Each control refuses independently.
test('each hook control is reported so admission can refuse on it alone', async () => {
  const operations = `0x${'2'.repeat(40)}`;
  const capped = await readState(isolatedChain({ operations, state: { remainingProcessClaimCapacity: 1n } }));
  assert.equal(capped.remainingProcessClaimCapacity, 1n);
  assert.equal((await readState(isolatedChain({ operations, state: { processClaimsPaused: true } }))).processClaimsPaused, true);
  assert.equal((await readState(isolatedChain({ operations, state: { processClaimCycleUsed: true } }))).processClaimCycleUsed, true);
  assert.equal((await readState(isolatedChain({ operations, state: { isSolvent: false } }))).isSolvent, false);
  const rotated = await readState(isolatedChain({ operations: `0x${'9'.repeat(40)}` }));
  assert.notEqual(rotated.operations, operations.toLowerCase());
});

// Block binding: one height, one hash, no fallback.
test('every getter is read at the one requested height', async () => {
  const chain = isolatedChain({ operations: `0x${'2'.repeat(40)}` });
  await readState(chain);
  assert.ok(chain.reads.length >= 9, 'every hook getter is read');
  assert.ok(chain.reads.every(read => read.blockNumber === 10n), 'no getter may read a different height');
});

test('a different hash at the same height refuses', async () => {
  const chain = isolatedChain({ operations: `0x${'2'.repeat(40)}`, blockHashAt: () => OTHER_HASH });
  await assert.rejects(() => readState(chain), /does not match the requested canonical block/);
});

test('a malformed getter return refuses rather than being coerced', async () => {
  const chain = isolatedChain({ operations: `0x${'2'.repeat(40)}`, state: { processLiability: '1000' } });
  await assert.rejects(() => readState(chain), /processLiability is not a nonnegative uint256/);
  const flags = isolatedChain({ operations: `0x${'2'.repeat(40)}`, state: { isSolvent: 'yes' } });
  await assert.rejects(() => readState(flags), /non-boolean control flag/);
  const roles = isolatedChain({ operations: 'not-an-address' });
  await assert.rejects(() => readState(roles), /did not return an Operations address/);
});

test('a read failure refuses with no latest or configured fallback', async () => {
  const chain = isolatedChain({ operations: `0x${'2'.repeat(40)}` });
  chain.client.readContract = async () => { throw new Error('archive unavailable'); };
  await assert.rejects(() => readState(chain), /archive unavailable/);
});

// A public reorg discovered strictly after the archive-bound read completes, but before this
// evidence is handed back to a caller. The archive's own internal hash check (case above) cannot
// see this: it only proves the archive answered the height it was asked for, not that the public
// chain still agrees after the fact.
function reorgAfterArchiveReadClient({ operations }) {
  const values = {
    processLiability: COVERS, remainingProcessClaimCapacity: COVERS, processClaimsPaused: false,
    processClaimCycleUsed: false, activeProcessClaimLimit: 4n, totalLiability: COVERS, hookUsdgBalance: COVERS, isSolvent: true,
  };
  let getBlockCalls = 0;
  return {
    async readContract({ functionName }) {
      if (functionName === 'readRoles') return [{ programmableBeneficiary: HOOK, treasury: HOOK, operations }, {}, {}, {}];
      if (!(functionName in values)) throw new Error(`unexpected getter ${functionName}`);
      return values[functionName];
    },
    async getBlock({ blockNumber } = {}) {
      getBlockCalls += 1;
      // 1st call: the finalized-tag selection. 2nd call: the archive's own internal height/hash
      // binding inside `readHookProcessStateAtBlock`. 3rd call: the post-archive-read public recheck.
      return { number: blockNumber ?? 10n, hash: getBlockCalls <= 2 ? BLOCK_HASH : OTHER_HASH, timestamp: 1n };
    },
  };
}

// Admission-time evidence: the same reorg window, at the planner/composition boundary rather than
// through the archive client's own requested-hash check (the different-hash case above).
test('a public reorg discovered after the archive read refuses admission-time evidence, not only the pre-sign veto', async () => {
  const operations = `0x${'2'.repeat(40)}`;
  const client = reorgAfterArchiveReadClient({ operations });
  const reader = buildProcessLiabilityReader({
    config: {
      contracts: { hook: HOOK },
      accounts: { evm: operations },
      moneyConfiguration: { assets: { usdg: { chainId: '4663', assetId: USDG, decimals: 6 } } },
    },
    adapters: { robinhood: { client, historicalEvidenceClient: createHistoricalErc20EvidenceClient({ client }) } },
  });
  await assert.rejects(() => reader.read({ cycleId: CYCLE_ID }), /block hash changed between the archive read and its recheck/);
});

/**
 * A minimal, isolated admission planner: one configured Collector machine, a Relay client that
 * echoes back a controllable funding amount, and whichever `processLiabilityReader` the test
 * supplies. This proves admission behavior end to end -- quoting, the ceiling comparison, and each
 * independent control refusal -- rather than only the low-level `readHookProcessStateAtBlock` reads
 * above.
 */
function plannerFixture({ processLiabilityReader, quantity = 1, unitAtomic = '1000000' }) {
  const usdg = { chainId: '4663', assetId: USDG, decimals: 6 };
  const settlement = { chainId: '792703809', assetId: SETTLEMENT_MINT, decimals: 6 };
  let quoteCount = 0;
  const planner = buildAdmissionPlanner({
    config: {
      contracts: { hook: HOOK },
      accounts: { evm: PLANNER_OPERATIONS, solana: 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE' },
      moneyConfiguration: { assets: { usdg, solanaStablecoin: settlement } },
    },
    adapters: {
      collectorCrypt: {
        async getMachines() {
          return { machines: [{ code: 'base-pack', price: '1', available: true, enabled: true }] };
        },
      },
      relay: {
        async quoteOutboundBridge({ amount }) {
          quoteCount += 1;
          return {
            requestId: `req-${quoteCount}`,
            orderId: `0x${String(quoteCount).padStart(64, '0')}`,
            deadlineUnixSeconds: 2_000_000_000,
            sender: PLANNER_OPERATIONS,
            recipient: 'BrvhPB9EeAukw8g3jibQDFBYY5abu3Vchdm9ri3PHZNE',
            // Funding cost tracks the requested settlement amount 1:1; the fixture only needs a
            // controllable number to compare against the evidence ceiling, not a realistic price.
            origin: { amount },
            destination: { amount, minimumAmount: amount },
            quoteDigest: `sha256:${String(quoteCount).padStart(64, '0')}`,
          };
        },
      },
    },
    readConfiguration: async () => ({ liveMode: true, requestedOrders: quantity, allowedPackIds: ['base-pack'] }),
    processLiabilityReader,
  });
  return { planner, unitAtomic };
}

/** A finalized evidence record a real reader would only produce once every control passed. */
function fakeProcessLiabilityEvidence(cycleId, overrides = {}) {
  return {
    schema: 'hookemon.process-liability-evidence.v1',
    chainId: '4663',
    assetId: USDG,
    decimals: 6,
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
    hookUsdgBalance: COVERS.toString(),
    isSolvent: true,
    operations: PLANNER_OPERATIONS,
    ceilingAtomic: COVERS.toString(),
    ...overrides,
  };
}

function fakeProcessLiabilityReader(overrides = {}) {
  return { async read({ cycleId }) { return fakeProcessLiabilityEvidence(cycleId, overrides); } };
}

test('an empty Operations wallet still admits when the planner is handed sufficient hook liability', async () => {
  const { planner } = plannerFixture({ processLiabilityReader: fakeProcessLiabilityReader() });
  const admission = await planner.plan({ cycleId: 'cycle-planner-sufficient', packId: 'base-pack' });
  assert.equal(admission.schema, 'hookemon.policy-admission.v2');
  assert.equal(admission.aggregateFundingQuote.amountAtomic, '1000000');
  assert.equal(admission.processLiabilityEvidence.ceilingAtomic, COVERS.toString());
});

test('a prefunded Operations wallet cannot substitute for zero hook liability at the planner boundary', async () => {
  const { planner } = plannerFixture({
    processLiabilityReader: fakeProcessLiabilityReader({
      processLiability: '0', remainingProcessClaimCapacity: '0', ceilingAtomic: '0',
    }),
  });
  await assert.rejects(
    () => planner.plan({ cycleId: 'cycle-planner-zero-liability', packId: 'base-pack' }),
    /refuses an aggregate quote above the attributable process liability/,
  );
});

test('the aggregate quote is admitted exactly at the ceiling and refused one atomic unit above it', async () => {
  const atCeiling = plannerFixture({
    processLiabilityReader: fakeProcessLiabilityReader({
      processLiability: '1000000', remainingProcessClaimCapacity: '1000000', ceilingAtomic: '1000000',
    }),
  });
  const admitted = await atCeiling.planner.plan({ cycleId: 'cycle-planner-at-ceiling', packId: 'base-pack' });
  assert.equal(admitted.aggregateFundingQuote.amountAtomic, '1000000');

  const belowCeiling = plannerFixture({
    processLiabilityReader: fakeProcessLiabilityReader({
      processLiability: '999999', remainingProcessClaimCapacity: '999999', ceilingAtomic: '999999',
    }),
  });
  await assert.rejects(
    () => belowCeiling.planner.plan({ cycleId: 'cycle-planner-one-under', packId: 'base-pack' }),
    /refuses an aggregate quote above the attributable process liability/,
  );
});

test('each independent hook control refuses admission at the planner boundary, from evidence alone', async () => {
  for (const [override, pattern] of [
    [{ processClaimsPaused: true }, /refuses while hook process claims are paused/],
    [{ processClaimCycleUsed: true }, /refuses a cycle id the hook already used/],
    [{ isSolvent: false }, /refuses while the hook is not solvent/],
    [{ operations: `0x${'9'.repeat(40)}` }, /Operations role does not match the configured Operations account/],
  ]) {
    const { planner } = plannerFixture({ processLiabilityReader: fakeProcessLiabilityReader(override) });
    await assert.rejects(
      () => planner.plan({ cycleId: 'cycle-planner-control', packId: 'base-pack' }),
      pattern,
      JSON.stringify(override),
    );
  }
});

function claimFixture({ operations, chain, estimate }) {
  const config = {
    chainId: 4663,
    contracts: { hook: HOOK, usdg: USDG },
    accounts: { evm: operations },
    nativeGasCaps: { robinhood: '999999' },
    moneyConfiguration: moneyConfiguration(),
  };
  let signed = 0;
  let prepared = null;
  const client = {
    ...chain.client,
    async getChainId() { return 4663; },
    async getTransactionCount() { return 7n; },
    async estimateGas() { return 120000n; },
    async estimateFeesPerGas() { return { maxFeePerGas: 2n, maxPriorityFeePerGas: 1n }; },
    async getBalance() { return 1_000_000n; },
    // Present only so the stage's own preconditions pass; a refused claim never reaches it.
    async sendRawTransaction() { throw new Error('a refused claim must never broadcast'); },
    ...(estimate ? { estimateContractGas: estimate } : {}),
  };
  const cycleRepository = {
    async readStage() { return { status: 'COMPLETE', evidence: { finalizedBlock: '123' } }; },
    async readClaimPreconditions() { return { heldAssets: false, unattributed: false, unresolvedObligations: false }; },
    async describeCycle() { return { releaseAmount: '25000000', chainAttempts: new Map(), custodyLedgers: new Map() }; },
    async readOperationalStageAttempt() { return null; },
    async readChainTransactionAttempt() { return prepared; },
    async prepareChainTransactionAttempt(_cycleId, _stage, attempt) {
      prepared = { attempt, broadcastEvidence: null, finalityEvidence: null };
      return prepared;
    },
    async reserveWalletNonce() {},
    async assertWalletNonce() {},
  };
  return {
    config,
    cycleRepository,
    signedCount: () => signed,
    adapters: { robinhood: { client, historicalEvidenceClient: evidenceClientFor(chain) } },
    signerClient: { evm: { async sign() { signed += 1; throw new Error('a refused claim must never reach the signer'); } } },
  };
}

async function runClaim(fixture) {
  const request = await prepareClaimProcessRequest({
    config: fixture.config,
    cycleRepository: fixture.cycleRepository,
    context: { cycleId: CYCLE_ID },
  });
  return mutateClaimProcess({
    liveMode: true,
    adapters: fixture.adapters,
    signerClient: fixture.signerClient,
    config: fixture.config,
    cycleRepository: fixture.cycleRepository,
    context: { cycleId: CYCLE_ID, stage: 'claim-process', requestDigest: `sha256:${'c'.repeat(64)}`, fencingToken: 'fence-1' },
    request,
    preflightAuthority: AUTHORITY,
  });
}

// A full active-entry ring is invisible to the getters; the canonical estimate is the veto.
test('a reverting canonical claim estimate refuses before any signer call', async () => {
  const operations = privateKeyToAccount(`0x${'3'.repeat(64)}`).address;
  const fixture = claimFixture({
    operations,
    chain: isolatedChain({ operations }),
    estimate: async () => { throw new Error('ProcessClaimEntryLimitReached'); },
  });
  await assert.rejects(() => runClaim(fixture), /ProcessClaimEntryLimitReached/);
  assert.equal(fixture.signedCount(), 0, 'no signature may be attempted after the estimate reverts');
});

// A snapshot that drops below the admitted amount refuses without repricing.
test('a fresh snapshot below the admitted amount refuses instead of repricing', async () => {
  const operations = privateKeyToAccount(`0x${'4'.repeat(64)}`).address;
  const fixture = claimFixture({
    operations,
    chain: isolatedChain({ operations, state: { processLiability: 1n, remainingProcessClaimCapacity: 1n } }),
    estimate: async () => 120000n,
  });
  await assert.rejects(() => runClaim(fixture), /no longer covered by hook liability and capacity/);
  assert.equal(fixture.signedCount(), 0);
});

test('paused claims, a used cycle, insolvency and a rotated Operations role each refuse before signing', async () => {
  const operations = privateKeyToAccount(`0x${'5'.repeat(64)}`).address;
  for (const [state, pattern] of [
    [{ processClaimsPaused: true }, /process claims are paused/],
    [{ processClaimCycleUsed: true }, /already claimed/],
    [{ isSolvent: false }, /not solvent/],
  ]) {
    const fixture = claimFixture({ operations, chain: isolatedChain({ operations, state }), estimate: async () => 120000n });
    await assert.rejects(() => runClaim(fixture), pattern);
    assert.equal(fixture.signedCount(), 0);
  }
  const rotated = claimFixture({
    operations,
    chain: isolatedChain({ operations: `0x${'8'.repeat(40)}` }),
    estimate: async () => 120000n,
  });
  await assert.rejects(() => runClaim(rotated), /changed hook Operations role/);
  assert.equal(rotated.signedCount(), 0);
});

test('missing archive capability refuses the claim rather than signing unproven', async () => {
  const operations = privateKeyToAccount(`0x${'6'.repeat(64)}`).address;
  const fixture = claimFixture({ operations, chain: isolatedChain({ operations }), estimate: async () => 120000n });
  fixture.adapters.robinhood.historicalEvidenceClient = undefined;
  await assert.rejects(() => runClaim(fixture), /requires finalized hook process-liability evidence before signing/);
  assert.equal(fixture.signedCount(), 0);
});

// Call-sequenced regression for the pre-sign veto's own public recheck: the finalized selection and
// the archive-bound read both see BLOCK_HASH, but the public client reports OTHER_HASH the moment
// this stage asks it again -- after the archive read, strictly before any control check, estimate,
// or signer call.
test('a public reorg discovered after the archive read refuses to sign, before any control check or estimate', async () => {
  const operations = privateKeyToAccount(`0x${'7'.repeat(64)}`).address;
  const chain = { client: reorgAfterArchiveReadClient({ operations }) };
  const fixture = claimFixture({ operations, chain, estimate: async () => { throw new Error('a refused claim must never reach the estimate'); } });
  await assert.rejects(() => runClaim(fixture), /public finalized block hash changed after the archive read/);
  assert.equal(fixture.signedCount(), 0);
});
