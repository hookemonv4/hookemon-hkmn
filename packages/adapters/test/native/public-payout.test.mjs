import assert from 'node:assert/strict';
import test from 'node:test';
import { keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createNativePaymentProof, isProcessNativePaymentProof } from '../../src/native-payment-proof.mjs';
import { projectCycleAccounting } from '../../src/app/accounting-projection.mjs';
import { buildPublicCommunitySnapshot } from '../../../dashboard/src/projections/community-snapshot-projection.mjs';
import { buildPublicCycleStatus } from '../../../dashboard/src/projections/cycle-status-projection.mjs';
import { normalizePublicCommunitySnapshot } from '../../../../apps/web/lib/public-community-snapshot.ts';
import { latestPayout, validateDashboardPair, processStep } from '../../../../apps/web/public/comic-production/dashboard.mjs';

// Existing public transaction fixture key, used only for local signing. No transport broadcasts.
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const receiver = `0x${'44'.repeat(20)}`;
const rejected = `0x${'55'.repeat(20)}`;
const blockHash = `0x${'ab'.repeat(32)}`;
const generatedAt = '2026-09-08T12:00:00.000Z';
const nativeAsset = { chainId: '4663', assetId: 'native', decimals: 18 };
const amount = amountAtomic => ({ ...nativeAsset, amountAtomic });

async function finalizedProof() {
  const signedTransaction = await account.signTransaction({ chainId: 4663, to: receiver,
    value: 42n, data: '0x', gas: 65000n, maxFeePerGas: 5n, maxPriorityFeePerGas: 2n, nonce: 8 });
  const transactionHash = keccak256(signedTransaction);
  let balanceReads = 0;
  const client = {
    getChainId: async () => 4663,
    getTransaction: async () => ({ hash: transactionHash, from: account.address, to: receiver,
      value: 42n, input: '0x', nonce: 8, blockNumber: 10n, blockHash }),
    getTransactionReceipt: async () => ({ transactionHash, blockNumber: 10n, blockHash,
      status: 'success', logs: [], gasUsed: 21000n, effectiveGasPrice: 3n }),
    getBlock: async () => ({ number: 10n, hash: blockHash, timestamp: 100n }),
    // A forwarding recipient retains none of the payment. This balance cannot establish payment.
    getBalance: async () => { balanceReads += 1; return 0n; },
  };
  const proof = await createNativePaymentProof({ client, signedTransaction, expected: {
    kind: 'direct', ...nativeAsset, source: account.address.toLowerCase(), recipient: receiver,
    amountWei: '42', transactionHash, calldataDigest: keccak256('0x'), nonce: '8',
  } });
  assert.equal(balanceReads, 0);
  assert.equal(isProcessNativePaymentProof(proof), true);
  assert.equal(isProcessNativePaymentProof(structuredClone(proof)), false);
  return proof;
}

function payoutEvidence(proof) {
  return {
    schema: 'hookemon.direct-payout-result.v2', cycleId: 'native-public-payout',
    distributablePool: amount('52'), totalAllocated: amount('49'), dust: amount('3'),
    recipients: [
      { recipient: receiver, state: 'FINALIZED', amount: amount('42'), transactionHash: proof.transactionHash, finalizedTransfer: proof },
      { recipient: rejected, state: 'REFUSED', amount: amount('7') },
    ],
    quarantine: [{ recipient: rejected, amount: amount('7') }],
  };
}

async function project(evidence) {
  return projectCycleAccounting({ cycleId: evidence.cycleId,
    trustedPayoutContext: { nativeAsset, operationsAddress: account.address.toLowerCase() },
    cycleRepository: {
      describeCycle: async () => ({ admission: { schema: 'hookemon.policy-admission.v3' }, releaseAmount: '52', relayLegs: new Map() }),
      readStage: async (_, stage) => stage === 'payout' ? { status: 'COMPLETE', evidence } : null,
    },
  });
}

test('finalized native payment reaches the served comic with exact principal and a rejected-recipient liability', async () => {
  const proof = await finalizedProof();
  const round = await project(payoutEvidence(proof));
  assert.equal(round.paidHolderRewardsWei, '42');
  assert.equal(round.payoutLiabilityWei, '7');
  assert.equal(round.payoutDustWei, '3');
  assert.equal(round.paidHolderRewardsRecipientCount, 1);
  assert.equal(round.holderRewardsStatus, 'paid-with-liabilities');
  assert.equal(round.paidHolderRewardsWei === proof.gasSpentWei, false);
  const community = await buildPublicCommunitySnapshot({ profileId: 'mainnet', generatedAt,
    repositoryCycles: [{ cycleId: 'native-public-payout', terminalState: 'COMPLETE' }], readAccounting: async () => round });
  const status = buildPublicCycleStatus({ profileId: 'mainnet', internalStatus: { generatedAt,
    intervalMinutes: 20, paused: false, nextRunAt: null,
    activeCycle: { cycleId: 'native-public-payout', stage: 'payout', accounting: round }, heldPositions: [] } });
  assert.deepEqual(normalizePublicCommunitySnapshot(community, 'mainnet'), community);
  assert.deepEqual(validateDashboardPair(status, community), { status, community });
  assert.deepEqual(latestPayout(community.latestCycle), { unit: 'ETH', paid: '42', recipients: 1, average: '42' });
  assert.equal(processStep('holders', status).amount, '0.000000000000000042 ETH');
});

test('tampered JSON and duplicate payment attribution cannot become public payout facts', async () => {
  const proof = await finalizedProof();
  for (const edit of [
    record => { record.recipients[0].finalizedTransfer.amountWei = '43'; },
    record => { record.recipients[0].finalizedTransfer.recipient = rejected; },
    record => { record.recipients[0].finalizedTransfer.evidenceDigest = `sha256:${'00'.repeat(32)}`; },
    record => { record.recipients.push(record.recipients[0]); },
    record => { record.recipients[0].finalizedTransfer = { amountWei: '42' }; },
  ]) {
    const record = structuredClone(payoutEvidence(proof)); edit(record);
    assert.equal((await project(record)).paidHolderRewardsWei, null);
  }
});
