// Public deterministic synthetic key; no network or broadcast.
import test from 'node:test';
import assert from 'node:assert/strict';
import { privateKeyToAccount } from 'viem/accounts';
import { encodeFunctionData, parseAbi, keccak256 } from 'viem';
import { reconcileLiveOutbound } from '../../src/app/stages/outbound.mjs';
test('reverted native outbound records gas once and never consumes reserved principal', async () => {
  const account = privateKeyToAccount(`0x${'11'.repeat(32)}`), target = `0x${'22'.repeat(20)}`, order = `0x${'33'.repeat(32)}`, blockHash = `0x${'44'.repeat(32)}`;
  const data = encodeFunctionData({ abi: parseAbi(['function depositNative(address depositor, bytes32 orderId)']), functionName: 'depositNative', args: [account.address, order] });
  const rawBytes = await account.signTransaction({ chainId: 4663, to: target, value: 42n, data, nonce: 0, gas: 100000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
  const hash = keccak256(rawBytes), asset = { chainId: '4663', assetId: 'native', decimals: 18 };
  let ledger = { schema: 'hookemon.custody-ledger.v3', ...asset, claimed: '42', bridgeOut: '0', gasReserve: { ...asset, amountAtomic: '30000' }, gasSpent: { ...asset, amountAtomic: '0' }, gasPayments: [] };
  const leg = { schema: 'hookemon.relay-leg.v2', direction: 'outbound', sourceAssetId: 'native', sourceDecimals: 18, sourceAmountAtomic: '42', sourceTxHash: hash, state: 'RECORDED' };
  const tx = { hash, from: account.address, to: target, value: 42n, input: data, nonce: 0, blockNumber: 10n, blockHash };
  const client = { getChainId: async () => 4663, getTransaction: async () => tx, getBlock: async () => ({ number: 10n, hash: blockHash, timestamp: 100n }),
    getTransactionReceipt: async () => ({ transactionHash: hash, blockNumber: 10n, blockHash, status: 'reverted', logs: [], gasUsed: 21000n, effectiveGasPrice: 1n }) };
  const repository = { describeCycle: async () => ({ relayLegs: new Map([['leg', leg]]), custodyLedgers: new Map([['4663\u0000native', structuredClone(ledger)]]),
      chainAttempts: new Map([['attempt', { attempt: { stage: 'outbound', state: 'BROADCAST', hash, rawBytes, requestDigest: 'synthetic' } }]]) }),
    readChainAttemptRecoveryContext: async () => ({ relayIntent: { orderId: order } }), recordCustodyLedger: async (_id, value) => { ledger = structuredClone(value); },
    recordFinality: async () => assert.fail('revert cannot finalize payment') };
  const input = { adapters: { robinhood: { client, historicalEvidenceClient: { readNativeBalanceAtBlock: async () => ({ value: 9042n, blockNumber: 10n, blockHash }) } } },
    config: { accounts: { evm: account.address, solana: 'synthetic' }, relay: { evmDepository: target, solanaMint: 'synthetic' } }, cycleRepository: repository, context: { cycleId: 'synthetic' } };
  for (let retry = 0; retry < 2; retry++) {
    await assert.rejects(reconcileLiveOutbound(input), /finalized outbound source reverted/);
    assert.equal(ledger.claimed, '42'); assert.equal(ledger.bridgeOut, '0'); assert.equal(ledger.gasSpent.amountAtomic, '21000'); assert.equal(ledger.gasPayments.length, 1);
  }
  tx.value = 43n;
  assert.equal(await reconcileLiveOutbound(input), null);
  assert.equal(ledger.gasPayments.length, 1);
});
