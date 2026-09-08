// Missing-authority nonce recovery, prevention slice: claim-process.mjs reserves the global EVM
// wallet nonce (reserveClaimWalletNonce) before it reaches any signer, and its own missing-authority
// refusal previously only happened later, inside the guarded sign() call -- deep inside
// handler.mutate, after that nonce reservation had already durably landed under the current
// attempt's lease fencing token. A refusal that late left the nonce reserved with no signature ever
// produced; the next lease's rotated fencing token then made cycle-repository.mjs's own
// reserveWalletNonce refuse the retry until that stale fence expired -- a real, bounded delay, not a
// permanent deadlock (expiry takeover is a repository invariant this change does not touch).
//
// stage-driver.mjs's execute() now resolves and verifies the exact operator-evm step authorization
// for claim-process -- using the same production resolver/provider contract
// (config.standingAuthorityStepAuthorization + createStandingAuthoritySigningGuard) the real sign()
// boundary already used -- before calling claim-process's own mutate, and therefore before that
// nonce is ever reserved. These tests are the narrow, focused proof for that one change: a real
// production-shaped standing authority (createProductionTestFixture, the same helper the existing
// production-signing tests in stage-driver.test.mjs use), a built-in claim-process handler (no
// injected stageHandlers), and a fake repository that tracks wallet-nonce reservation calls
// directly, not just their absence of effect.
import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { createStageDriver } from '../../src/app/stage-driver.mjs';
import { createHistoricalErc20EvidenceClient } from '../../src/robinhood-rpc.mjs';
import { buildAndSignStepAuthorization, createProductionTestFixture } from '../../../runner/test/cycle/production-cycle.mjs';

const CYCLE_ID = 'claim-authority-readiness-cycle';
const fixtureStageDriverOptions = Object.freeze({ preflightAuthority: createTestProfileMutationAuthority() });
const CLAIM_HOOK_BLOCK_HASH = `0x${'9'.repeat(64)}`;

function baseConfig(overrides = {}) {
  return {
    contracts: { vault: null, hook: null },
    accounts: { evm: null, solana: null },
    ...overrides,
  };
}

function claimMoneyConfiguration() {
  const usdg = { chainId: '4663', assetId: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', decimals: 6 };
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
      nativeReserve: { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '10' },
    },
    solana: {
      priorityFeeCap: { chainId: '792703809', assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '2' },
      lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '2' },
    },
  };
}

/** Same real archive-read machinery `stage-driver.test.mjs`'s own claim-process tests use: always
 * solvent, always ample liability. These tests are about the authority/nonce ordering, not the
 * liability boundary, which has its own focused coverage. */
function claimHookLiabilityArchive({ operations }) {
  const covers = 10n ** 12n;
  const values = {
    processLiability: covers, remainingProcessClaimCapacity: covers, processClaimsPaused: false,
    processClaimCycleUsed: false, activeProcessClaimLimit: covers, totalLiability: covers,
    hookUsdgBalance: covers, isSolvent: true,
  };
  const readContractClient = {
    async readContract({ functionName }) {
      if (functionName === 'readRoles') {
        return [{ programmableBeneficiary: operations, treasury: operations, operations }, {}, {}, {}];
      }
      if (!(functionName in values)) throw new Error(`unexpected getter ${functionName}`);
      return values[functionName];
    },
    async getBlock({ blockNumber } = {}) {
      return { number: blockNumber ?? 10n, hash: CLAIM_HOOK_BLOCK_HASH, timestamp: 1n };
    },
  };
  return {
    getBlock: readContractClient.getBlock,
    historicalEvidenceClient: createHistoricalErc20EvidenceClient({ client: readContractClient }),
  };
}

/** A resolver shaped exactly like the real production one (environment.mjs's `loadStandingAuthority`
 * builds `resolveStepAuthorization` as an async function of the same request shape, re-reading its
 * source of truth on every call) -- `available()` stands in for "the artifact has been published to
 * disk yet", toggled by the test itself instead of a real file, so the exact same
 * cycle/stage/requestDigest/signerRole binding the production resolver contract requires is what
 * this test exercises, with no invented shortcut. */
function claimStepAuthorizationResolver(fixture, available) {
  return async ({ cycleId, stage, requestDigest, signerRole }) => {
    if (!available()) {
      throw new Error('standing authority artifact has no matching step authorization');
    }
    return buildAndSignStepAuthorization(fixture, {
      cycleId,
      actionKind: stage,
      authorizationKind: 'sign',
      subjectDigest: requestDigest,
      destination: fixture.standingAuthority.allowedDestinations[0],
      pack: fixture.standingAuthority.allowedPacks[0],
      spendAmount: '1',
      nonce: `claim-authority-readiness-${signerRole}-${requestDigest.slice(-8)}`,
    });
  };
}

function claimAuthorityReadinessRepository() {
  const attempts = new Map();
  const chainAttempts = new Map();
  const custodyLedgers = new Map();
  const decisions = new Map();
  const keyFor = (cycleId, stage) => `${cycleId}:${stage}`;
  const chainKeyFor = (cycleId, stage, requestDigest) => `${cycleId}:${stage}:${requestDigest}`;
  const custodyKeyFor = ledger => `${ledger.chainId}\u0000${ledger.assetId}`;
  return {
    attempts,
    chainAttempts,
    custodyLedgers,
    recordedStageRequestDigests: [],
    walletNonceReservations: [],
    async readStage(_cycleId, stage) {
      return stage === 'eligibility-snapshot' ? { status: 'COMPLETE', evidence: { finalized: true } } : { status: 'PENDING' };
    },
    async readClaimPreconditions() { return { heldAssets: false, unattributed: false, unresolvedObligations: false }; },
    async describeCycle() { return { releaseAmount: '1', chainAttempts: new Map(chainAttempts), custodyLedgers: new Map(custodyLedgers) }; },
    async readStageAttempt(cycleId, stage) {
      const record = attempts.get(keyFor(cycleId, stage));
      return record?.responseEvidence ?? null;
    },
    async readOperationalStageAttempt(cycleId, stage) {
      return attempts.get(keyFor(cycleId, stage)) ?? null;
    },
    async prepareStageAttempt(cycleId, stage, attempt) {
      attempts.set(keyFor(cycleId, stage), { attempt, responseEvidence: null, reconciliationEvidence: null });
    },
    async markStageAttemptSentUnknown(cycleId, stage) {
      const record = attempts.get(keyFor(cycleId, stage));
      record.attempt = { ...record.attempt, state: 'SENT_UNKNOWN' };
    },
    async markStageAttemptNotSent(cycleId, stage) {
      const record = attempts.get(keyFor(cycleId, stage));
      record.attempt = { ...record.attempt, state: 'NOT_SENT' };
    },
    async recordStageAttemptResponse(cycleId, stage, evidence) {
      const record = attempts.get(keyFor(cycleId, stage));
      record.attempt = { ...record.attempt, state: 'RESPONSE_RECORDED', responseDigest: `sha256:${'e'.repeat(64)}` };
      record.responseEvidence = evidence;
    },
    async reconcileStageAttempt(cycleId, stage, evidence) {
      const record = attempts.get(keyFor(cycleId, stage));
      record.attempt = { ...record.attempt, state: 'RECONCILED', reconciliationDigest: `sha256:${'f'.repeat(64)}` };
      record.reconciliationEvidence = evidence;
    },
    async readChainTransactionAttempt(cycleId, stage, requestDigest) {
      return chainAttempts.get(chainKeyFor(cycleId, stage, requestDigest)) ?? null;
    },
    async prepareChainTransactionAttempt(cycleId, stage, attempt) {
      const key = chainKeyFor(cycleId, stage, attempt.requestDigest);
      const record = { attempt, broadcastEvidence: null, finalityEvidence: null };
      chainAttempts.set(key, record);
      return record;
    },
    async recordSignedTransaction(cycleId, stage, requestDigest, material) {
      const key = chainKeyFor(cycleId, stage, requestDigest);
      const previous = chainAttempts.get(key);
      const record = { ...previous, attempt: { ...previous.attempt, state: 'SIGNED', ...material } };
      chainAttempts.set(key, record);
      return record;
    },
    async recordBroadcast(cycleId, stage, requestDigest, evidence) {
      const key = chainKeyFor(cycleId, stage, requestDigest);
      const previous = chainAttempts.get(key);
      const record = { ...previous, attempt: { ...previous.attempt, state: 'BROADCAST' }, broadcastEvidence: evidence };
      chainAttempts.set(key, record);
      return record;
    },
    async recordCustodyLedger(_cycleId, ledger) {
      custodyLedgers.set(custodyKeyFor(ledger), ledger);
    },
    async recordFinality(cycleId, stage, requestDigest, evidence) {
      const key = chainKeyFor(cycleId, stage, requestDigest);
      const previous = chainAttempts.get(key);
      const record = { ...previous, attempt: { ...previous.attempt, state: 'FINALIZED' }, finalityEvidence: evidence };
      chainAttempts.set(key, record);
      return record;
    },
    async recordStageRequestDigest(cycleId, stage, requestDigest) {
      this.recordedStageRequestDigests.push({ cycleId, stage, requestDigest });
    },
    async reserveWalletNonce(cycleId, reservation) {
      this.walletNonceReservations.push({ cycleId, reservation });
    },
    async assertWalletNonce() {},
    async releaseWalletNonce() {},
    async recordStandingAuthorityDecision(_cycleId, decision) {
      decisions.set(decision.intentDigest, decision);
      return decision;
    },
    async readStandingAuthorityDecision(_cycleId, intentDigest) {
      return decisions.get(intentDigest) ?? null;
    },
  };
}

function claimDriverConfig({ account, fixture, available }) {
  return baseConfig({
    contracts: {
      vault: null,
      hook: `0x${'1'.repeat(40)}`,
      usdg: '0x5fc5360d0400a0fd4f2af552add042d716f1d168',
    },
    accounts: { evm: account.address, solana: null },
    moneyConfiguration: claimMoneyConfiguration(),
    execution: { profile: 'production', providerMode: 'live' },
    standingAuthority: { ...fixture.standingAuthority, provider: fixture.standingAuthorityProvider },
    standingAuthorityStepAuthorization: claimStepAuthorizationResolver(fixture, available),
  });
}

function claimAdapters({ account, broadcasted, signCalls }) {
  const { getBlock, historicalEvidenceClient } = claimHookLiabilityArchive({ operations: account.address });
  return {
    collectorCrypt: null,
    relay: null,
    robinhood: {
      client: {
        async getChainId() { return 4663; },
        async getTransactionCount() { return 0n; },
        async estimateGas() { return 100n; },
        async estimateFeesPerGas() { return { maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }; },
        async getBalance() { return 1_000_000n; },
        async sendRawTransaction({ serializedTransaction }) {
          broadcasted.push(serializedTransaction);
          return keccak256(serializedTransaction);
        },
        getBlock,
      },
      historicalEvidenceClient,
    },
    solana: { client: null },
  };
}

function claimSigner({ account, signCalls }) {
  return {
    evm: {
      async sign({ transaction }) {
        signCalls.count += 1;
        const { from, ...unsigned } = transaction;
        return {
          signedTx: await account.signTransaction({
            ...unsigned,
            value: BigInt(unsigned.value),
            nonce: BigInt(unsigned.nonce),
            gas: BigInt(unsigned.gas),
            maxFeePerGas: BigInt(unsigned.maxFeePerGas),
            maxPriorityFeePerGas: BigInt(unsigned.maxPriorityFeePerGas),
          }),
        };
      },
    },
  };
}

test('claim-process refuses before reserving the wallet nonce when the operator-evm step authorization is unavailable', async () => {
  const account = privateKeyToAccount(`0x${'2'.repeat(64)}`);
  const fixture = createProductionTestFixture();
  const cycleRepository = claimAuthorityReadinessRepository();
  const signCalls = { count: 0 };
  const broadcasted = [];
  let available = false;
  const driver = createStageDriver({
    liveMode: true,
    adapters: claimAdapters({ account, broadcasted, signCalls }),
    signerClient: claimSigner({ account, signCalls }),
    config: claimDriverConfig({ account, fixture, available: () => available }),
    cycleRepository,
    ...fixtureStageDriverOptions,
  });

  await assert.rejects(
    () => driver.execute({
      cycleId: CYCLE_ID,
      stage: 'claim-process',
      intent: { journalHead: 'claim-authority-readiness-missing' },
      fencingToken: 'lease-fence-first',
      assertMutationAllowed: async () => {},
    }),
    /standing authority artifact has no matching step authorization/,
  );

  assert.equal(signCalls.count, 0, 'no signer call may occur before authority is verified available');
  assert.equal(broadcasted.length, 0, 'no broadcast may occur before authority is verified available');
  assert.equal(
    cycleRepository.walletNonceReservations.length, 0,
    'the global wallet nonce must never be reserved for a claim-process attempt whose own authorization is unavailable',
  );
  assert.equal(cycleRepository.chainAttempts.size, 0, 'no chain attempt may be durably prepared before authority is verified available');
  assert.equal(
    cycleRepository.recordedStageRequestDigests.length, 1,
    'the stage request digest is still durably recorded, before the readiness check, so a later retry resolves against the same digest',
  );
});

test('the same prepared claim reaches its one real signature once the operator-evm step authorization becomes available on retry', async () => {
  const account = privateKeyToAccount(`0x${'3'.repeat(64)}`);
  const fixture = createProductionTestFixture();
  const cycleRepository = claimAuthorityReadinessRepository();
  const signCalls = { count: 0 };
  const broadcasted = [];
  let available = false;
  const driverConfig = claimDriverConfig({ account, fixture, available: () => available });
  const firstAttempt = createStageDriver({
    liveMode: true,
    adapters: claimAdapters({ account, broadcasted, signCalls }),
    signerClient: claimSigner({ account, signCalls }),
    config: driverConfig,
    cycleRepository,
    ...fixtureStageDriverOptions,
  });

  await assert.rejects(
    () => firstAttempt.execute({
      cycleId: CYCLE_ID,
      stage: 'claim-process',
      intent: { journalHead: 'claim-authority-readiness-retry' },
      fencingToken: 'lease-fence-attempt-1',
      assertMutationAllowed: async () => {},
    }),
    /standing authority artifact has no matching step authorization/,
  );
  assert.equal(cycleRepository.walletNonceReservations.length, 0, 'the failed first attempt must not have reserved the wallet nonce');

  // The retry is a fresh driver instance under a new lease's fencing token, exactly as the real
  // scheduler produces one -- the same durable repository is the only thing carried over, matching
  // how a real restart or lease rotation reaches claim-process again for the identical prepared
  // request digest recorded by the failed first attempt above.
  available = true;
  const retry = createStageDriver({
    liveMode: true,
    adapters: claimAdapters({ account, broadcasted, signCalls }),
    signerClient: claimSigner({ account, signCalls }),
    config: driverConfig,
    cycleRepository,
    ...fixtureStageDriverOptions,
  });
  await retry.execute({
    cycleId: CYCLE_ID,
    stage: 'claim-process',
    intent: { journalHead: 'claim-authority-readiness-retry' },
    fencingToken: 'lease-fence-attempt-2',
    assertMutationAllowed: async () => {},
  });

  assert.equal(signCalls.count, 1, 'exactly one real signature must occur once authority is verified available');
  assert.equal(broadcasted.length, 1);
  assert.equal(
    cycleRepository.walletNonceReservations.length, 1,
    'the wallet nonce must be reserved exactly once, only on the attempt that actually reaches the signer',
  );
  const [{ attempt }] = cycleRepository.chainAttempts.values();
  assert.equal(attempt.state, 'BROADCAST');
});

test('a lease lost immediately after the claim-process readiness check refuses before the signer is ever reached', async () => {
  const account = privateKeyToAccount(`0x${'4'.repeat(64)}`);
  const fixture = createProductionTestFixture();
  const cycleRepository = claimAuthorityReadinessRepository();
  const signCalls = { count: 0 };
  const broadcasted = [];
  // Flips true from inside the real resolver call the readiness check itself makes -- i.e. exactly
  // once the readiness check's own await has genuinely completed -- rather than guessing a call
  // count, so the very next lease check (this test's own new one, right after the guard, and no
  // other) is the one that observes the lost lease.
  let authorityResolved = false;
  const config = claimDriverConfig({ account, fixture, available: () => true });
  config.standingAuthorityStepAuthorization = async request => {
    const authorization = await claimStepAuthorizationResolver(fixture, () => true)(request);
    authorityResolved = true;
    return authorization;
  };
  const driver = createStageDriver({
    liveMode: true,
    adapters: claimAdapters({ account, broadcasted, signCalls }),
    signerClient: claimSigner({ account, signCalls }),
    config,
    cycleRepository,
    ...fixtureStageDriverOptions,
  });

  await assert.rejects(
    () => driver.execute({
      cycleId: CYCLE_ID,
      stage: 'claim-process',
      intent: { journalHead: 'claim-authority-readiness-lease-loss' },
      fencingToken: 'lease-fence-lost',
      assertMutationAllowed: async () => {},
      assertLease: () => {
        // The readiness check itself is real production verification-and-recording work with a real
        // await inside it; losing the lease during that exact window must still refuse before any
        // broker (signer/provider) call, the same guarantee the existing sign-time standing-authority
        // recheck already gives for its own await (stage-driver.mjs's `guardedSignerRole`).
        if (authorityResolved) throw new Error('lease lost during claim-process readiness check');
      },
    }),
    /lease lost during claim-process readiness check/,
  );

  assert.equal(signCalls.count, 0, 'no signer call may occur once the lease is lost, even with authority verified available');
  assert.equal(broadcasted.length, 0);
  assert.equal(
    cycleRepository.walletNonceReservations.length, 0,
    'a lease lost right after the readiness check must refuse before the wallet nonce is ever reserved',
  );
});

test('authority revoked between a successful readiness check and the actual signing boundary refuses with zero broker or broadcast calls', async () => {
  const account = privateKeyToAccount(`0x${'5'.repeat(64)}`);
  const fixture = createProductionTestFixture();
  const cycleRepository = claimAuthorityReadinessRepository();
  const signCalls = { count: 0 };
  const broadcasted = [];
  // The new readiness precheck and the real per-sign standing-authority guard both call
  // `config.standingAuthorityStepAuthorization` -- the readiness check once, before
  // `handler.mutate`, then `guardedSignerRole`'s own recheck once more, immediately before the real
  // `signerClient.evm.sign()` call. This resolver succeeds only the first time, so readiness
  // genuinely passes (the wallet nonce is reserved, exactly like a real successful readiness check),
  // and then refuses the second, later call -- standing in for authority actually being removed or
  // revoked in that window, e.g. a policy service withdrawing the published artifact. This is a
  // distinct property from a lost lease: `authorityResolved`/lease loss above never lets the real
  // resolver run a second time and never lets the wallet nonce be reserved at all; this case proves
  // the opposite window -- authority was genuinely available and consumed once, then stops being
  // available before the signer is ever actually reached.
  let resolverCalls = 0;
  const config = claimDriverConfig({ account, fixture, available: () => true });
  config.standingAuthorityStepAuthorization = async request => {
    resolverCalls += 1;
    if (resolverCalls > 1) {
      throw new Error('standing authority artifact has no matching step authorization');
    }
    return claimStepAuthorizationResolver(fixture, () => true)(request);
  };
  const driver = createStageDriver({
    liveMode: true,
    adapters: claimAdapters({ account, broadcasted, signCalls }),
    signerClient: claimSigner({ account, signCalls }),
    config,
    cycleRepository,
    ...fixtureStageDriverOptions,
  });

  await assert.rejects(
    () => driver.execute({
      cycleId: CYCLE_ID,
      stage: 'claim-process',
      intent: { journalHead: 'claim-authority-readiness-revoked' },
      fencingToken: 'lease-fence-revoked',
      assertMutationAllowed: async () => {},
    }),
    /standing authority artifact has no matching step authorization/,
  );

  assert.equal(resolverCalls, 2, 'the real resolver must have been consulted both at readiness and again at the actual sign boundary');
  assert.equal(signCalls.count, 0, 'no real signer call may occur once authority refuses at the sign boundary');
  assert.equal(broadcasted.length, 0, 'no broadcast may occur once authority refuses at the sign boundary');
});
