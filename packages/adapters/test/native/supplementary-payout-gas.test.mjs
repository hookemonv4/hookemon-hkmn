import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { createNativePaymentProof, createNativeTransactionGasProof } from '../../src/native-payment-proof.mjs';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { OPERATIONAL_CYCLE_STAGES, CUSTODY_LEDGER_BUCKETS } from '../../../runner/src/cycle/money-schemas.mjs';
import { digest, canonicalJson } from '../../../runner/src/cycle/journal.mjs';
import { nativeProducedAdmissionFixture } from './admission-fixture.mjs';
const asset = { chainId: '4663', assetId: 'native', decimals: 18 };
const now = () => 1_700_000_000_000;
// Public synthetic key; transactions are signed locally and never broadcast.
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const recipient = `0x${'44'.repeat(20)}`;
async function fixture(t) {
  const path = await mkdtemp(join(tmpdir(), 'supplementary-gas-'));
  t.after(() => rm(path, { recursive: true, force: true }));
  const repository = await CycleRepository.open(path, now, { testAuthority: createTestProfileMutationAuthority() });
  const cycleId = 'synthetic-supplementary-gas';
  await repository.createCycle({ cycleId, releaseAmount: '42', mode: 'production', admission: await nativeProducedAdmissionFixture(cycleId) });
  const position = await repository.recordHeldPosition(cycleId, { packId: 'base-pack', memo: 'synthetic-memo', mint: 'synthetic-mint', cardRef: 'synthetic-mint',
    costMicroUsd: '35000000', valueMicroUsd: '35000000', insuredValue: null, reason: 'EPIC_THRESHOLD', terminalState: 'HELD_OWNER_DECISION', evidence: { synthetic: true } });
  const initial = { schema: 'hookemon.custody-ledger.v3', cycleId, ...asset, ...Object.fromEntries(CUSTODY_LEDGER_BUCKETS.map(key => [key, '0'])),
    claimed: '42', bridgeOut: '42', verifiedCurrentBalance: null, expectedCycleAsset: null,
    gasReserve: { ...asset, amountAtomic: '200000' }, gasSpent: { ...asset, amountAtomic: '0' }, gasPayments: [] };
  await repository.recordCustodyLedger(cycleId, initial);
  for (const stage of OPERATIONAL_CYCLE_STAGES) { await repository.prepareStage(cycleId, stage); await repository.completeStage(cycleId, stage, { synthetic: true }); }
  await repository.completeCycle(cycleId);
  await repository.recordHeldOwnerDecision(position.positionId, { heldEvidenceDigest: position.evidenceDigest, requestId: 'gas-fixture', expectedRevision: 0, choice: 'sell' });
  const settlement = await repository.readSupplementarySettlement(position.positionId);
  const planDigest = digest({ cycleId, positionId: position.positionId, purpose: 'synthetic-gas-test' });
  return { repository, path, cycleId, initial, settlement, planDigest };
}
async function payment(status = 'success', nonce = 0) {
  const rawSignedBytes = await account.signTransaction({ chainId: 4663, to: recipient, value: 42n, data: '0x', gas: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, nonce });
  const txHash = keccak256(rawSignedBytes), blockHash = `0x${'ab'.repeat(32)}`;
  const client = { getChainId: async () => 4663,
    getTransaction: async () => ({ hash: txHash, from: account.address, to: recipient, value: 42n, input: '0x', nonce, blockNumber: 10n, blockHash }),
    getTransactionReceipt: async () => ({ transactionHash: txHash, blockNumber: 10n, blockHash, status, logs: [], gasUsed: 21000n, effectiveGasPrice: 2n }),
    getBlock: async () => ({ number: 10n, hash: blockHash, timestamp: 100n }) };
  const expected = { kind: 'direct', ...asset, source: account.address.toLowerCase(), recipient, amountWei: '42', transactionHash: txHash, calldataDigest: keccak256('0x'), nonce: String(nonce) };
  const proof = await (status === 'success' ? createNativePaymentProof : createNativeTransactionGasProof)({ client, signedTransaction: rawSignedBytes, expected });
  return { proof, candidate: { recipient, amount: { ...asset, amountAtomic: '42' }, state: 'BROADCAST', txHash, rawSignedBytes, nonce: String(nonce), replacementHistory: [] } };
}
async function persist(f, candidate) {
  const s = f.settlement;
  await f.repository.persistPagedPayoutState(f.cycleId, `supplementary-${s.positionId.slice(5, 53)}`, {
    schema: 'hookemon.supplementary-payout-state.v2', cycleId: f.cycleId, positionId: s.positionId, manifestId: s.manifestId,
    positionEvidenceDigest: s.positionEvidenceDigest, eligibilitySnapshotEvidenceDigest: s.eligibilitySnapshotEvidenceDigest, payoutSourceDigest: s.payoutSourceDigest,
    payoutState: { planDigest: f.planDigest, plan: { cycleId: f.cycleId }, operations: account.address.toLowerCase(), assetId: 'native' }, recipients: [candidate] });
}
test('completed supplementary payout records authenticated gas once across reopen without changing principal', async t => {
  const f = await fixture(t), { proof, candidate } = await payment();
  await persist(f, candidate);
  await assert.rejects(f.repository.recordSupplementaryPayoutGas(f.cycleId, { planDigest: f.planDigest, proof: structuredClone(proof) }), /process|proof|authenticated/);
  await assert.rejects(f.repository.recordSupplementaryPayoutGas(f.cycleId, { planDigest: digest('wrong-plan'), proof }), /persisted signed/);
  const result = await f.repository.recordSupplementaryPayoutGas(f.cycleId, { planDigest: f.planDigest, proof });
  assert.equal(result.gasSpent.amountAtomic, '42000'); assert.equal(result.gasPayments.length, 1);
  for (const bucket of CUSTODY_LEDGER_BUCKETS) assert.equal(result[bucket], f.initial[bucket]);
  await assert.rejects(f.repository.recordCustodyLedger(f.cycleId, result), /verifiedCurrentBalance/);
  const reopened = await CycleRepository.open(f.path, now, { testAuthority: createTestProfileMutationAuthority() });
  assert.deepEqual(await reopened.recordSupplementaryPayoutGas(f.cycleId, { planDigest: f.planDigest, proof }), result);
  assert.equal((await reopened.describeCycle(f.cycleId)).terminalState, 'COMPLETED');
});
test('reverted supplementary transaction grants gas only and refuses unbound signed bytes', async t => {
  const f = await fixture(t), { proof, candidate } = await payment('reverted', 1);
  await persist(f, { ...candidate, rawSignedBytes: '0xdead' });
  await assert.rejects(f.repository.recordSupplementaryPayoutGas(f.cycleId, { planDigest: f.planDigest, proof }), /persisted signed/);
  await persist(f, candidate);
  const result = await f.repository.recordSupplementaryPayoutGas(f.cycleId, { planDigest: f.planDigest, proof });
  assert.equal(result.gasSpent.amountAtomic, '42000');
  for (const bucket of CUSTODY_LEDGER_BUCKETS) assert.equal(result[bucket], f.initial[bucket]);
  assert.equal(result.returnReceived, '0');
});
test('a finalized supplementary gas transaction cannot be reassigned to a different payout plan', async t => {
  const f = await fixture(t), { proof, candidate } = await payment();
  await persist(f, candidate);
  await f.repository.recordSupplementaryPayoutGas(f.cycleId, { planDigest: f.planDigest, proof });
  f.planDigest = digest({ differentPayoutPlan: true });
  await persist(f, candidate);
  await assert.rejects(f.repository.recordSupplementaryPayoutGas(f.cycleId, { planDigest: f.planDigest, proof }), /belongs to another payout/);
  assert.equal((await f.repository.describeCycle(f.cycleId)).custodyLedgers.get('4663\u0000native').gasSpent.amountAtomic, '42000');
});

for (const mutation of ['plan', 'proof']) test(`reopen refuses a rehashed supplementary gas ${mutation} that differs from its atomic reservation`, async t => {
  const f = await fixture(t), { proof, candidate } = await payment();
  await persist(f, candidate);
  await f.repository.recordSupplementaryPayoutGas(f.cycleId, { planDigest: f.planDigest, proof });
  const path = join(f.path, 'active', `${encodeURIComponent(f.cycleId)}.json`);
  const stored = JSON.parse(await readFile(path, 'utf8'));
  const entry = stored.cycle.entries.find(entry => entry.kind === 'supplementary-payout-gas-recorded');
  assert.ok(entry);
  if (mutation === 'plan') entry.payload.planDigest = digest('altered-plan');
  else {
    entry.payload.proof.gasSpentWei = '42001';
    const { evidenceDigest, ...facts } = entry.payload.proof;
    entry.payload.proof.evidenceDigest = digest(facts);
  }
  let previous = null;
  for (const [index, item] of stored.cycle.entries.entries()) {
    item.digest = digest({ cycleId: f.cycleId, index, previousDigest: previous, kind: item.kind, payload: item.payload });
    previous = item.digest;
  }
  stored.cycle.journalHead = previous;
  await writeFile(path, `${canonicalJson(stored)}\n`);
  const reopened = await CycleRepository.open(f.path, now, { testAuthority: createTestProfileMutationAuthority() });
  await assert.rejects(reopened.describeCycle(f.cycleId), /atomic signed payment reservation/);
});
