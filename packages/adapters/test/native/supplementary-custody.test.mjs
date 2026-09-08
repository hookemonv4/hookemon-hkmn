import { projectPolicyCustody } from '../../src/app/accounting-projection.mjs';
import { createRelayClient, createQuoteUsdValuation, readProcessQuoteUsdProvenance } from '../../src/relay-client.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import { OPERATIONAL_CYCLE_STAGES, CUSTODY_LEDGER_BUCKETS } from '../../../runner/src/cycle/money-schemas.mjs';
import { digest } from '../../../runner/src/cycle/journal.mjs';
import { readReturnLegDestinationProof } from '../../src/app/stages/return.mjs';
import { nativeProducedAdmissionFixture } from './admission-fixture.mjs';
import { setup } from './relay-native-proof-fixture.mjs';
async function repositoryFixture(t, id = 'synthetic-supplementary') {
  const path = await mkdtemp(join(tmpdir(), 'native-supplementary-')); t.after(() => rm(path, { recursive: true, force: true }));
  const repository = await CycleRepository.open(path, () => 1_700_000_000_000, { testAuthority: createTestProfileMutationAuthority() });
  await repository.createCycle({ cycleId: id, releaseAmount: '42', mode: 'production', admission: await nativeProducedAdmissionFixture(id) });
  return { repository, path, cycleId: id };
}
async function positionFor(repository, cycleId, index = 0) {
  return repository.recordHeldPosition(cycleId, { packId: 'base-pack', memo: `synthetic-memo-${index}`, mint: `synthetic-mint-${index}`, cardRef: `synthetic-mint-${index}`,
    costMicroUsd: '35000000', valueMicroUsd: '35000000', insuredValue: null, reason: 'EPIC_THRESHOLD', terminalState: 'HELD_OWNER_DECISION', evidence: { synthetic: true } });
}
async function prepareSettlement(repository, position) {
  await repository.recordHeldOwnerDecision(position.positionId, { heldEvidenceDigest: position.evidenceDigest, requestId: `decision-${position.positionId}`, expectedRevision: 0, choice: 'sell' });
  await repository.advanceSupplementarySettlement(position.positionId, { expectedState: 'PREPARED', nextState: 'BUYBACK_SENT_UNKNOWN', evidence: { synthetic: true } });
  return repository.readSupplementarySettlement(position.positionId);
}
async function boundaryFor(repository, position, settlement, fixture) {
  const intent = { sender: fixture.expected.sourceOwner, recipient: fixture.expected.recipient, orderId: fixture.expected.orderId };
  const leg = { schema: 'hookemon.relay-leg.v2', relayRequestId: fixture.expected.relayRequestId, sourceTxHash: fixture.expected.sourceTransactionHash,
    sourceAssetId: fixture.expected.sourceMint, sourceAmountAtomic: fixture.expected.sourceAmountAtomic, destinationAssetId: 'native', destinationDecimals: 18, returnAttribution: { intent } };
  const blockReader = fixture.client.getBlock;
  fixture.client.getBlock = async () => ({ ...await blockReader(), timestamp: 1_700_000_001n });
  const proof = await readReturnLegDestinationProof({ client: fixture.client, nativePaymentBinding: fixture.binding, sourceProof: fixture.sourceProof, leg,
    pointer: { schema: 'hookemon.relay-terminal-destination-pointer.v1', relayRequestId: leg.relayRequestId, status: 'SUCCESS', destinationTxHash: fixture.expected.transactionHash } });
  const stage = `supplementary-${digest({ schema: 'hookemon.supplementary-return-stage.v1', positionId: position.positionId }).slice(7, 55)}`;
  const zero = `0x${'00'.repeat(20)}`, destinationAmount = { chainId: '4663', assetId: 'native', decimals: 18, amountAtomic: '42' };
  const raw = { requestId: leg.relayRequestId, details: { sender: intent.sender, recipient: intent.recipient,
    currencyIn: { currency: { chainId: 792703809, address: leg.sourceAssetId, decimals: 6 }, amount: leg.sourceAmountAtomic, amountUsd: '25' },
    currencyOut: { currency: { chainId: 4663, address: zero, decimals: 18 }, amount: '42', minimumAmount: '42', amountUsd: '20.0000009' } },
    protocol: { v2: { orderId: intent.orderId, orderData: { inputs: [{ payment: { chainId: 'solana', currency: leg.sourceAssetId, amount: leg.sourceAmountAtomic },
      refunds: [{ chainId: 'solana', currency: leg.sourceAssetId, recipient: intent.sender, deadline: 2_000_000_000 }] }],
      output: { chainId: 'robinhood', deadline: 2_000_000_000, calls: [], payments: [{ recipient: intent.recipient, currency: zero, expectedAmount: '42', minimumAmount: '42' }] } } } }, steps: [] };
  const client = createRelayClient({ now: () => 1_700_000_000_000, quoteValidityMs: 60000, fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify(raw) }) });
  const quote = await client.quoteReturnBridge({ user: intent.sender, recipient: intent.recipient, amount: leg.sourceAmountAtomic, skipRouteCheck: true });
  const destinationUsd = createQuoteUsdValuation({ quote, side: 'destination', amount: destinationAmount, rounding: 'down', nowMs: 1_700_000_000_000 });
  const attempt = { schema: 'hookemon.supplementary-return-attempt.v2', cycleId: position.cycleId, positionId: position.positionId, manifestId: settlement.manifestId,
    recipients: [], rawSignedBytes: fixture.encoded, relayRequestId: leg.relayRequestId, intent, destinationAmount, destinationUsd,
    destinationUsdEvidence: { ...readProcessQuoteUsdProvenance(destinationUsd), quote } };
  await assert.rejects(repository.persistPagedPayoutState(position.cycleId, stage, structuredClone(attempt)), /producer capability/);
  await repository.persistPagedPayoutState(position.cycleId, stage, attempt);
  await assert.rejects(repository.persistPagedPayoutState(position.cycleId, stage, { ...attempt, destinationUsd: { ...destinationUsd, amountMicroUsd: '1' } }), /immutable/);
  return { schema: 'hookemon.supplementary-return-boundary.v2', positionId: position.positionId, cycleId: position.cycleId, manifestId: settlement.manifestId,
    finalizedReturnEvidence: { schema: 'hookemon.supplementary-finalized-return.v2', positionId: position.positionId, cycleId: position.cycleId, manifestId: settlement.manifestId,
      operations: fixture.expected.recipient, assetId: 'native', amountAtomic: '42', finalityEvidence: proof } };
}
test('held native positions retain USD cost without principal and consume an attributed supplementary return once', async t => {
  const { repository, cycleId, path } = await repositoryFixture(t);
  const first = await positionFor(repository, cycleId, 0), second = await positionFor(repository, cycleId, 1);
  assert.equal((await repository.describeCycle(cycleId)).custodyLedgers.size, 0);
  assert.equal(first.costMicroUsd, '35000000'); assert.equal(Object.hasOwn(first, 'ledgerAsset'), false);
  const asset = { chainId: '4663', assetId: 'native', decimals: 18 };
  const buckets = Object.fromEntries(CUSTODY_LEDGER_BUCKETS.map(key => [key, '0']));
  await repository.recordCustodyLedger(cycleId, { schema: 'hookemon.custody-ledger.v3', cycleId, ...asset, ...buckets, claimed: '42', bridgeOut: '42',
    verifiedCurrentBalance: null, expectedCycleAsset: null, gasReserve: { ...asset, amountAtomic: '200' }, gasSpent: { ...asset, amountAtomic: '0' }, gasPayments: [] });
  for (const stage of OPERATIONAL_CYCLE_STAGES) { await repository.prepareStage(cycleId, stage); await repository.completeStage(cycleId, stage, { synthetic: true }); }
  await repository.completeCycle(cycleId);
  const one = await prepareSettlement(repository, first), two = await prepareSettlement(repository, second);
  const fixture = await setup();
  const evidence = await boundaryFor(repository, first, one, fixture);
  await assert.rejects(repository.advanceSupplementarySettlement(first.positionId, { expectedState: 'BUYBACK_SENT_UNKNOWN', nextState: 'RETURN_BROADCAST', evidence: structuredClone(evidence) }), /process payment proof/);
  const result = await repository.advanceSupplementarySettlement(first.positionId, { expectedState: 'BUYBACK_SENT_UNKNOWN', nextState: 'RETURN_BROADCAST', evidence });
  assert.equal(result.state, 'RETURN_BROADCAST');
  const replay = await CycleRepository.open(path, () => 1_700_000_000_000, { testAuthority: createTestProfileMutationAuthority() });
  assert.deepEqual(await replay.readSupplementarySettlement(first.positionId), result);
  const ledger = [...(await replay.describeCycle(cycleId)).custodyLedgers.values()][0];
  assert.equal(ledger.returnReceived, '42');
  assert.equal(ledger.bridgeOut, '42');
  assert.equal(ledger.heldAssets, '0');
  assert.deepEqual(ledger.gasPayments, []);
  assert.equal(ledger.gasReserve.amountAtomic, '200');
  assert.equal((await replay.describeCycle(cycleId)).supplementaryRealizedProceedsUsd.get(first.positionId).destinationUsd.amountMicroUsd, '20000000');
  const custody = await projectPolicyCustody({ cycleRepository: replay, nativeAsset: asset, valueAmountUsd: async () => assert.fail('settled supplementary proceeds stay frozen') });
  assert.equal(custody.realizedLossMicroUsd, '15000000');
  assert.equal(custody.heldPositions.valueMicroUsd, '70000000');
  const secondDestination = `0x${'77'.repeat(32)}`;
  fixture.expected.transactionHash = secondDestination;
  fixture.receipt.transactionHash = secondDestination;
  fixture.receipt.logs[0].transactionHash = secondDestination;
  const duplicate = await boundaryFor(repository, second, two, fixture);
  await assert.rejects(repository.advanceSupplementarySettlement(second.positionId, { expectedState: 'BUYBACK_SENT_UNKNOWN', nextState: 'RETURN_BROADCAST', evidence: duplicate }));
});
