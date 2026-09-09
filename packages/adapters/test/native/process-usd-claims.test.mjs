import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbi } from 'viem';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { createStageDriver } from '../../src/app/stage-driver.mjs';
import { createNativePaymentProof, createNativeTransactionGasProof, createTestNativePaymentBinding } from '../../src/native-payment-proof.mjs';
import { deriveOnchainCycleId } from '../../src/app/stages/action-builder.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { createPreparedChainTransactionAttempt, OPERATIONAL_CYCLE_STAGES, CUSTODY_LEDGER_BUCKETS } from '../../../runner/src/cycle/money-schemas.mjs';
import { createDefaultOperatorConfiguration, assertOperatorConfiguration, migrateOperatorConfiguration, applyOperatorConfiguration } from '../../../runner/src/config/state-schema.mjs';
import { nativeProducedAdmissionFixture } from './admission-fixture.mjs';
const hook = `0x${'77'.repeat(20)}`, epoch = 1_700_000_000_000;
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`); // Public synthetic test key only.
const claim = { hook, amountWei: '42' };
const eth = { chainId: '4663', assetId: 'native', decimals: 18 };
async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), 'process-usd-')); t.after(() => rm(path, { recursive: true, force: true }));
  let time = epoch;
  const now = () => time;
  const reopen = () => CycleRepository.open(path, now, { testAuthority: createTestProfileMutationAuthority() });
  const repository = await reopen();
  async function open(id, cost = '15000000000') {
    const admission = await nativeProducedAdmissionFixture(id, { costMicroUsd: cost, nowMs: time });
    await repository.createCycle({ cycleId: id, releaseAmount: '42', mode: 'production', admission });
  }
  async function archive(id) {
    for (const stage of OPERATIONAL_CYCLE_STAGES) { await repository.prepareStage(id, stage); await repository.completeStage(id, stage, { synthetic: true }); }
    await repository.completeCycle(id);
  }
  return { repository, open, archive, reopen, time: value => { time = value; } };
}
async function payment(id, { reverted = false, timestamp = epoch / 1000 } = {}) {
  const abi = parseAbi(['function claimProcess(bytes32 cycleId, uint256 amountWei, address destination)',
    'event ProcessClaimed(bytes32 indexed cycleId, uint256 amountWei, address indexed destination, uint256 timestamp, uint256 capWei, uint256 usedAfterWei)']);
  const cycleId = deriveOnchainCycleId(id), blockHash = `0x${'44'.repeat(32)}`, runtime = '0x6000';
  const data = encodeFunctionData({ abi, functionName: 'claimProcess', args: [cycleId, 42n, account.address] });
  const signedTransaction = await account.signTransaction({ chainId: 4663, to: hook, nonce: 0, value: 0n, data, gas: 100000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
  const transactionHash = keccak256(signedTransaction);
  const receipt = { transactionHash, blockNumber: 10n, blockHash, status: reverted ? 'reverted' : 'success', gasUsed: 21000n, effectiveGasPrice: 1n,
    logs: reverted ? [] : [{ address: hook, logIndex: 0, transactionHash, blockHash, blockNumber: 10n,
      topics: encodeEventTopics({ abi, eventName: 'ProcessClaimed', args: { cycleId, destination: account.address } }),
      data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [42n, BigInt(timestamp), 100n, 42n]) }] };
  const client = { getChainId: async () => 4663, getCode: async () => runtime,
    getTransaction: async () => ({ hash: transactionHash, from: account.address, to: hook, value: 0n, input: data, nonce: 0, blockNumber: 10n, blockHash }),
    getTransactionReceipt: async () => receipt, getBlock: async () => ({ number: 10n, hash: blockHash, timestamp: BigInt(timestamp) }) };
  const expected = { kind: 'hook-claim', ...eth, transactionHash, source: reverted ? account.address : hook, recipient: reverted ? hook : account.address,
    transactionSender: account.address, amountWei: reverted ? '0' : '42', cycleId, hookRuntimeHash: keccak256(runtime), calldataDigest: keccak256(data), nonce: '0' };
  const proof = await (reverted ? createNativeTransactionGasProof : createNativePaymentProof)({ client, signedTransaction, expected });
  return { proof, signedTransaction, transactionHash, client, blockHash };
}
test('owner control defaults to USD25000, migrates absent knob, accepts zero and USD50000, rejects larger values', () => {
  const config = createDefaultOperatorConfiguration(); assert.equal(config.processClaimLimit6hMicroUsd, '25000000000');
  const old = { ...config }; delete old.processClaimLimit6hMicroUsd;
  assert.equal(migrateOperatorConfiguration(old).configuration.processClaimLimit6hMicroUsd, '25000000000');
  assert.equal(migrateOperatorConfiguration(old).migrated, true);
  for (const version of [4, 5]) {
    const legacy = { ...old, schema: `hookemon.operator-configuration.v${version}` };
    delete legacy.rewardRecipientLimit; if (version === 4) delete legacy.packPlan;
    assert.equal(migrateOperatorConfiguration(legacy).configuration.processClaimLimit6hMicroUsd, '25000000000');
  }
  for (const limit of ['0', '50000000000']) assert.equal(applyOperatorConfiguration(config, { processClaimLimit6hMicroUsd: limit }).processClaimLimit6hMicroUsd, limit);
  for (const limit of ['50000000001', '-1', '1.5', null]) assert.throws(() => assertOperatorConfiguration({ ...config, processClaimLimit6hMicroUsd: limit }));
});
test('claims share durable six-hour USD capacity across cycles and exact expiry, while wei amounts stay unchanged', async t => {
  const f = await fixture(t); await f.open('claim-first');
  assert.equal((await f.repository.reserveProcessClaimUsd('claim-first', claim)).amountWei, '42');
  const { proof } = await payment('claim-first');
  await f.repository.finalizeProcessClaimUsd('claim-first', { hook, proof });
  await f.repository.finalizeProcessClaimUsd('claim-first', { hook, proof });
  await f.archive('claim-first');
  f.time(epoch + 21_599_000); await f.open('claim-next');
  await assert.rejects(f.repository.reserveProcessClaimUsd('claim-next', claim), /six-hour limit/);
  f.time(epoch + 21_600_000);
  assert.equal((await f.repository.reserveProcessClaimUsd('claim-next', claim)).amountMicroUsd, '15000000000');
});
test('unknown reservations never expire and restart cannot reset used USD or duplicate a cycle debit', async t => {
  const f = await fixture(t); await f.open('claim-unknown');
  const first = await f.repository.reserveProcessClaimUsd('claim-unknown', claim);
  const restarted = await f.reopen(); assert.deepEqual(await restarted.reserveProcessClaimUsd('claim-unknown', claim), first);
  // Archival does not represent transaction finality and cannot free the global reservation.
  await f.archive('claim-unknown'); f.time(epoch + 30_000_000); await f.open('claim-after-restart');
  await assert.rejects((await f.reopen()).reserveProcessClaimUsd('claim-after-restart', claim), /six-hour limit/);
});
test('parallel same-cycle attempts reserve once and configured lowering or zero refuses reuse before broadcast', async t => {
  const f = await fixture(t); await f.open('claim-race', '25000000000');
  const results = await Promise.allSettled([f.repository.reserveProcessClaimUsd('claim-race', claim), f.repository.reserveProcessClaimUsd('claim-race', claim)]);
  assert.ok(results.some(result => result.status === 'fulfilled'));
  assert.equal((await f.repository.reserveProcessClaimUsd('claim-race', claim)).amountMicroUsd, '25000000000');
  for (const limitMicroUsd of ['0', '24999999999']) await assert.rejects(f.repository.reserveProcessClaimUsd('claim-race', { ...claim, limitMicroUsd }), /six-hour limit/);
});
test('USD50000 requires explicit configured increase; excess, changed amount, wrong hook and stale prices refuse', async t => {
  const f = await fixture(t); await f.open('claim-large', '50000000000');
  await assert.rejects(f.repository.reserveProcessClaimUsd('claim-large', claim), /six-hour limit/);
  for (const patch of [{ limitMicroUsd: '50000000001' }, { amountWei: '43' }, { hook: `0x${'66'.repeat(20)}` }]) await assert.rejects(f.repository.reserveProcessClaimUsd('claim-large', { ...claim, ...patch }));
  assert.equal((await f.repository.reserveProcessClaimUsd('claim-large', { ...claim, limitMicroUsd: '50000000000' })).amountMicroUsd, '50000000000');
  f.time(epoch + 60_000); await assert.rejects(f.repository.reserveProcessClaimUsd('claim-large', { ...claim, limitMicroUsd: '50000000000' }), /fresh authenticated/);
});
test('copied finality and another cycle proof cannot release reservations; authenticated revert releases exactly once', async t => {
  const f = await fixture(t); await f.open('claim-revert', '25000000000'); await f.repository.reserveProcessClaimUsd('claim-revert', claim);
  const other = await payment('claim-other'); await assert.rejects(f.repository.finalizeProcessClaimUsd('claim-revert', { hook, proof: other.proof }), /unverified/);
  const { proof, signedTransaction, transactionHash } = await payment('claim-revert', { reverted: true });
  const requestDigest = `sha256:${'ab'.repeat(32)}`;
  await f.repository.prepareChainTransactionAttempt('claim-revert', 'claim-process', createPreparedChainTransactionAttempt({ cycleId: 'claim-revert', stage: 'claim-process', requestDigest }));
  await f.repository.recordSignedTransaction('claim-revert', 'claim-process', requestDigest, { rawBytes: signedTransaction, nonce: '0', blockhash: null, hash: transactionHash });
  await f.repository.recordCustodyLedger('claim-revert', { schema: 'hookemon.custody-ledger.v3', cycleId: 'claim-revert', ...eth,
    ...Object.fromEntries(CUSTODY_LEDGER_BUCKETS.map(key => [key, '0'])), verifiedCurrentBalance: null, expectedCycleAsset: null,
    gasReserve: { ...eth, amountAtomic: '30000' }, gasSpent: { ...eth, amountAtomic: '0' }, gasPayments: [] });
  await assert.rejects(f.repository.finalizeProcessClaimUsd('claim-revert', { hook, proof: structuredClone(proof) }), /process native payment proof/);
  assert.equal((await f.repository.finalizeProcessClaimUsd('claim-revert', { hook, proof })).state, 'REVERTED');
  assert.equal((await (await f.reopen()).finalizeProcessClaimUsd('claim-revert', { hook, proof })).state, 'REVERTED');
  await assert.rejects(f.repository.reserveProcessClaimUsd('claim-revert', claim), /already finalized/);
});

for (const reverted of [false, true]) test(`actual stage driver reconciles USD ${reverted ? 'revert' : 'success'} through lease-fenced facade`, async t => {
  const f = await fixture(t), id = `driver-${reverted ? 'revert' : 'success'}`;
  await f.open(id); await f.repository.reserveProcessClaimUsd(id, claim);
  await f.repository.prepareStage(id, 'eligibility-snapshot'); await f.repository.completeStage(id, 'eligibility-snapshot', { synthetic: true });
  const p = await payment(id, { reverted }), requestDigest = `sha256:${'cd'.repeat(32)}`;
  await f.repository.prepareChainTransactionAttempt(id, 'claim-process', createPreparedChainTransactionAttempt({ cycleId: id, stage: 'claim-process', requestDigest }));
  await f.repository.recordSignedTransaction(id, 'claim-process', requestDigest, { rawBytes: p.signedTransaction, nonce: '0', blockhash: null, hash: p.transactionHash });
  await f.repository.recordBroadcast(id, 'claim-process', requestDigest, { transactionHash: p.transactionHash });
  const sol = { chainId: '792703809', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
  const amount = (asset, amountAtomic) => ({ ...asset, amountAtomic });
  const authority = createTestProfileMutationAuthority();
  const config = { chainId: 4663, contracts: { hook }, accounts: { evm: account.address },
    nativePaymentBinding: createTestNativePaymentBinding({ schema: 'hookemon.native-payment-binding.v1', chainId: '4663', hook: { address: hook, runtimeHash: keccak256('0x6000') } }, authority),
    moneyConfiguration: { schema: 'hookemon.money-configuration.v2', assets: { eth, solanaStablecoin: sol },
      minimums: { robinhoodReceive: amount(eth, '0'), returnEth: amount(eth, '0'), solanaReceive: amount(sol, '0') },
      evm: { perTransactionGasPriceCap: amount(eth, '100'), nativeReserve: amount(eth, '30000') },
      solana: { priorityFeeCap: amount({ ...sol, assetId: 'microlamports-per-compute-unit', decimals: 0 }, '100'), lamportReserve: amount({ ...sol, assetId: 'native', decimals: 9 }, '200') } } };
  const driver = createStageDriver({ liveMode: true, config, cycleRepository: f.repository, signerClient: null, preflightAuthority: authority,
    adapters: { robinhood: { client: p.client, historicalEvidenceClient: { readNativeBalanceAtBlock: async () => ({ value: 9000n, blockNumber: 10n, blockHash: p.blockHash }) } } } });
  let leaseChecks = 0;
  await f.repository.reserveWalletNonce(id, { chainId: '4663', wallet: account.address.toLowerCase(), stage: 'claim-process', fencingToken: '11111111-1111-4111-8111-111111111111', leaseAcquiredAtMs: 0, leaseExpiresAtMs: Number.MAX_SAFE_INTEGER });
  const run = () => driver.reconcile({ cycleId: id, stage: 'claim-process', fencingToken: '11111111-1111-4111-8111-111111111111', assertLease() { leaseChecks++; } });
  if (reverted) await assert.rejects(run(), /reverted on-chain/);
  else assert.equal((await run()).claimedAmountAtomic, '42');
  assert.ok(leaseChecks > 0);
  const result = await f.repository.finalizeProcessClaimUsd(id, { hook, proof: p.proof });
  assert.equal(result.state, reverted ? 'REVERTED' : 'CONFIRMED');
});
