import test from 'node:test';
import assert from 'node:assert/strict';
import { assertMoneyConfiguration, assertHistoricalMoneyConfiguration, assertCustodyLedger, CUSTODY_LEDGER_BUCKETS } from '../../../runner/src/cycle/money-schemas.mjs';
import { createNativeCustodyBalanceObservationReader } from '../../src/evm-custody-balance-observation.mjs';
import { prepareClaimProcessRequest } from '../../src/app/stages/claim-process.mjs';
const eth = { chainId: '4663', assetId: 'native', decimals: 18 };
const sol = { chainId: '792703809', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
const amount = (asset, amountAtomic) => ({ ...asset, amountAtomic });
function configuration() { return { schema: 'hookemon.money-configuration.v2', assets: { eth, solanaStablecoin: sol },
  minimums: { robinhoodReceive: amount(eth, '0'), returnEth: amount(eth, '0'), solanaReceive: amount(sol, '0') },
  evm: { perTransactionGasPriceCap: amount(eth, '100'), nativeReserve: amount(eth, '200') },
  solana: { priorityFeeCap: amount({ chainId: sol.chainId, assetId: 'microlamports-per-compute-unit', decimals: 0 }, '100'),
    lamportReserve: amount({ chainId: sol.chainId, assetId: 'native', decimals: 9 }, '200') } }; }
test('native money v2 rejects old execution identity while historical v1 remains readable', () => {
  assert.deepEqual(assertMoneyConfiguration(configuration()), configuration());
  const old = configuration(); old.schema = 'hookemon.money-configuration.v1';
  old.assets.usdg = { chainId: '4663', assetId: `0x${'11'.repeat(20)}`, decimals: 6 }; delete old.assets.eth;
  old.minimums.robinhoodReceive = amount(old.assets.usdg, '0'); old.minimums.returnUsdg = amount(old.assets.usdg, '0'); delete old.minimums.returnEth;
  assert.equal(assertHistoricalMoneyConfiguration(old).schema, old.schema);
  assert.throws(() => assertMoneyConfiguration(old));
  for (const change of [{ assetId: 'ETH' }, { decimals: 6 }, { chainId: '1' }]) {
    const bad = configuration(); bad.assets.eth = { ...eth, ...change }; assert.throws(() => assertMoneyConfiguration(bad));
  }
});
test('native custody v3 keeps gas typed and separate from principal', () => {
  const row = { schema: 'hookemon.custody-ledger.v3', cycleId: 'cycle-native', ...eth,
    ...Object.fromEntries(CUSTODY_LEDGER_BUCKETS.map(key => [key, key === 'claimed' ? '42' : '0'])),
    verifiedCurrentBalance: null, expectedCycleAsset: null, gasReserve: amount(eth, '200'), gasSpent: amount(eth, '12') };
  assert.deepEqual(assertCustodyLedger(row), row);
  assert.throws(() => assertCustodyLedger({ ...row, gasReserve: amount(sol, '200') }));
  assert.throws(() => assertCustodyLedger({ ...row, gasSpent: undefined }));
});
test('native custody observation requires distinct archive checkpoint and canonical recheck', async () => {
  const hash = `0x${'ab'.repeat(32)}`; const account = `0x${'11'.repeat(20)}`;
  const block = { number: 10n, hash, timestamp: 100n };
  const publicClient = { getBlock: async () => block };
  const archiveClient = { readNativeBalanceAtBlock: async args => ({ value: 242n, blockNumber: args.blockNumber, blockHash: args.blockHash }) };
  const read = createNativeCustodyBalanceObservationReader({ publicClient, archiveClient, identity: { ...eth, account } });
  assert.equal((await read()).balance.amountAtomic, '242');
  archiveClient.readNativeBalanceAtBlock = async () => ({ value: 242n, blockNumber: 9n, blockHash: hash });
  await assert.rejects(read());
});
test('claim request v2 uses native typed principal and refuses historical money config', async () => {
  const config = { chainId: 4663, contracts: { hook: `0x${'22'.repeat(20)}` }, accounts: { evm: `0x${'11'.repeat(20)}` }, moneyConfiguration: configuration() };
  const cycleRepository = { readStage: async () => ({ status: 'COMPLETE' }), readClaimPreconditions: async () => ({}), describeCycle: async () => ({ releaseAmount: '42', admission: { schema: 'hookemon.policy-admission.v3' } }) };
  const args = { config, cycleRepository, context: { cycleId: 'native-cycle' } };
  const request = await prepareClaimProcessRequest(args);
  assert.equal(request.schema, 'hookemon.claim-process-request.v2');
  assert.deepEqual(request.amount, amount(eth, '42'));
  config.moneyConfiguration.schema = 'hookemon.money-configuration.v1';
  await assert.rejects(prepareClaimProcessRequest(args));
});
