// The eight focused negatives the frozen process-liability interface requires. Every case drives the
// real archive read, the real admission evidence check, or the real pre-sign veto against isolated
// in-memory chain state; none contacts a provider, and no address here stands in for a deployed one.
import assert from 'node:assert/strict';
import test from 'node:test';
import { privateKeyToAccount } from 'viem/accounts';

import { createHistoricalErc20EvidenceClient } from '../../src/robinhood-rpc.mjs';
import { mutateClaimProcess, prepareClaimProcessRequest } from '../../src/app/stages/claim-process.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';

const HOOK = `0x${'1'.repeat(40)}`;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const BLOCK_HASH = `0x${'1'.repeat(64)}`;
const OTHER_HASH = `0x${'2'.repeat(64)}`;
const CYCLE_ID = 'cycle-process-liability-1';
const COVERS = 10n ** 12n;
const AUTHORITY = createTestProfileMutationAuthority();

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

// 1 + 2. The source of truth is the hook ledger, not the Operations wallet.
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

// 3. Each control refuses independently.
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

// 4. Block binding: one height, one hash, no fallback.
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

// 5. A full active-entry ring is invisible to the getters; the canonical estimate is the veto.
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

// 6. A snapshot that drops below the admitted amount refuses without repricing.
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
