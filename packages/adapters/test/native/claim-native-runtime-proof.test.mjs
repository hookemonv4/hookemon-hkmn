// Synthetic deterministic public fixture key only. No owner key, network or broadcast.
import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, keccak256, parseAbi } from 'viem';
import { reconcileLiveClaimProcess } from '../../src/app/stages/claim-process.mjs';
import { deriveOnchainCycleId } from '../../src/app/stages/action-builder.mjs';
import { createNativePaymentProof, isProcessNativePaymentProof } from '../../src/native-payment-proof.mjs';
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const hook = `0x${'22'.repeat(20)}`;
const cycleId = `0x${'33'.repeat(32)}`;
const blockHash = `0x${'44'.repeat(32)}`;
const runtime = '0x6000';
const abi = parseAbi(['function claimProcess(bytes32 cycleId, uint256 amountWei, address destination)',
  'event ProcessClaimed(bytes32 indexed cycleId, uint256 amountWei, address indexed destination, uint256 timestamp, uint256 capWei, uint256 usedAfterWei)']);
async function setup(claimCycleId = cycleId) {
  const data = encodeFunctionData({ abi, functionName: 'claimProcess', args: [claimCycleId, 42n, account.address] });
  const signedTransaction = await account.signTransaction({ chainId: 4663, to: hook, nonce: 0, value: 0n, data, gas: 100000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
  const transactionHash = keccak256(signedTransaction);
  const log = { address: hook, logIndex: 0, transactionHash, blockHash, blockNumber: 10n, topics: encodeEventTopics({ abi, eventName: 'ProcessClaimed', args: { cycleId, destination: account.address } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [42n, 100n, 100n, 42n]) };
  const receipt = { transactionHash, blockNumber: 10n, blockHash, status: 'success', logs: [log], gasUsed: 21000n, effectiveGasPrice: 1n };
  const tx = { hash: transactionHash, from: account.address, to: hook, value: 0n, input: data, nonce: 0, blockNumber: 10n, blockHash };
  const client = { getChainId: async () => 4663, getCode: async () => runtime, getTransaction: async () => tx,
    getTransactionReceipt: async () => receipt, getBlock: async () => ({ number: 10n, hash: blockHash, timestamp: 100n }) };
  const expected = { kind: 'hook-claim', chainId: '4663', assetId: 'native', decimals: 18, source: hook, recipient: account.address,
    transactionSender: account.address, amountWei: '42', cycleId, hookRuntimeHash: keccak256(runtime), transactionHash, calldataDigest: keccak256(data), nonce: '0' };
  return { client, signedTransaction, expected, receipt };
}
test('synthetic native claim requires exact signed intent and unique runtime-authenticated post-payment event', async () => {
  const input = await setup(); const proof = await createNativePaymentProof(input);
  assert.ok(isProcessNativePaymentProof(proof, { kind: 'hook-claim', amountWei: '42', cycleId }));
  assert.equal(proof.gasSpentWei, '21000');
  assert.equal(proof.logIndex, 0);
});
test('synthetic native claim refuses missing/duplicate event, wrong runtime, removed log and signed amount substitution', async () => {
  for (const mutate of [x => { x.receipt.logs = []; }, x => { x.receipt.logs.push(x.receipt.logs[0]); },
    x => { x.client.getCode = async () => '0x6001'; }, x => { x.receipt.logs[0].removed = true; }, x => { x.expected.amountWei = '43'; }]) {
    const input = await setup(); mutate(input); await assert.rejects(createNativePaymentProof(input));
  }
});

test('reverted native claim records authenticated gas once without crediting principal across recovery', async () => {
  const id = 'synthetic-reverted-claim';
  const input = await setup(deriveOnchainCycleId(id)); input.receipt.status = 'reverted'; input.receipt.logs = [];
  const eth = { chainId: '4663', assetId: 'native', decimals: 18 };
  const sol = { chainId: '792703809', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
  const amount = (asset, amountAtomic) => ({ ...asset, amountAtomic });
  const config = { chainId: 4663, contracts: { hook }, accounts: { evm: account.address }, moneyConfiguration: {
    schema: 'hookemon.money-configuration.v2', assets: { eth, solanaStablecoin: sol },
    minimums: { robinhoodReceive: amount(eth, '0'), returnEth: amount(eth, '0'), solanaReceive: amount(sol, '0') },
    evm: { perTransactionGasPriceCap: amount(eth, '100'), nativeReserve: amount(eth, '30000') },
    solana: { priorityFeeCap: amount({ chainId: sol.chainId, assetId: 'microlamports-per-compute-unit', decimals: 0 }, '100'), lamportReserve: amount({ chainId: sol.chainId, assetId: 'native', decimals: 9 }, '200') } } };
  let ledger = null;
  const repository = { finalizeProcessUsdClaim: async (_id, { proof }) => assert.equal(proof.receiptStatus, 'reverted'), describeCycle: async () => ({ admission: { schema: 'hookemon.policy-admission.v3' }, releaseAmount: '42',
      custodyLedgers: new Map(ledger ? [['4663\u0000native', structuredClone(ledger)]] : []),
      chainAttempts: new Map([['claim', { attempt: { stage: 'claim-process', state: 'BROADCAST', hash: input.expected.transactionHash, rawBytes: input.signedTransaction, requestDigest: 'synthetic' } }]]) }),
    readStage: async () => ({ status: 'COMPLETE' }), readClaimPreconditions: async () => ({}),
    recordCustodyLedger: async (_id, value) => { ledger = structuredClone(value); }, recordFinality: async () => assert.fail('revert cannot finalize a claim payment') };
  const adapters = { robinhood: { client: input.client, historicalEvidenceClient: { readNativeBalanceAtBlock: async () => ({ value: 9000n, blockNumber: 10n, blockHash }) } } };
  for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(reconcileLiveClaimProcess({ adapters, config, cycleRepository: repository, context: { cycleId: id } }), /reverted on-chain/);
    assert.equal(ledger.claimed, '0'); assert.equal(ledger.gasSpent.amountAtomic, '21000'); assert.equal(ledger.gasPayments.length, 1);
    assert.equal(ledger.gasReserve.amountAtomic, '30000');
  }
  input.client.getTransaction = async () => ({ hash: input.expected.transactionHash, from: hook });
  await assert.rejects(reconcileLiveClaimProcess({ adapters, config, cycleRepository: repository, context: { cycleId: id } }), /gas RPC transaction mismatch/);
  assert.equal(ledger.gasPayments.length, 1);
});
