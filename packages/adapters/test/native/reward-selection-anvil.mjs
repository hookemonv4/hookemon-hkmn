import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPublicClient, http, keccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createTestProfileMutationAuthority } from '../../../runner/src/cycle/preflight.mjs';
import { compileDirectPayoutPlan, createNativePayoutAmount } from '../../../runner/src/distribution/payout-plan.mjs';
import { buildHolderSnapshot, selectEligibilityRecipients } from '../../../runner/src/distribution/snapshot-indexer.mjs';
import { createRewardSelectionSnapshot } from '../../../runner/src/automation/reward-selection-snapshot.mjs';
import { createEligibilityPayoutManifest } from '../../../runner/src/distribution/pro-rata.mjs';
import { wrapSignerClient } from '../../src/signing/signer-client.mjs';
import { advanceDirectPayout, createDirectPayoutState, isDirectPayoutComplete } from '../../src/app/stages/payout.mjs';

// PUBLIC, deterministic fixture key. This harness creates its own unforked loopback chain.
// No environment URL, wallet, secret, production adapter or external provider is accepted.
const account = privateKeyToAccount(`0x${'11'.repeat(32)}`);
const operations = account.address.toLowerCase();
const token = `0x${'aa'.repeat(20)}`;
const native = amountAtomic => createNativePayoutAmount({ assetId: 'native', amountAtomic: String(amountAtomic) });
const address = index => `0x${(0x10000 + index).toString(16).padStart(40, '0')}`;
const cap = 2_000_000_000n;
function manifest(count, cycleId, block) {
  const fee = BigInt(count) * 21000n * cap;
  const size = count + 17;
  const snapshot = buildHolderSnapshot({ chainId: '4663', tokenAddress: token, blockNumber: String(block.number), blockHash: block.hash,
    finalized: true, totalSupply: String(size + 10), excludedAddresses: [{ address: operations, reason: 'operations' }],
    transferLogs: [...Array.from({ length: size }, (_, i) => ({ blockNumber: '0', logIndex: String(i), from: `0x${'0'.repeat(40)}`, to: address(i), value: '1' })),
      { blockNumber: '0', logIndex: String(size), from: `0x${'0'.repeat(40)}`, to: operations, value: '10' }] });
  const supply = { chainId: '4663', assetId: token, decimals: 18, amountAtomic: String(size + 10) };
  const rewardSelection = createRewardSelectionSnapshot({ cycleId, configurationRevision: 1, rewardRecipientLimit: count });
  const { entries, selection } = selectEligibilityRecipients({ holderSnapshot: snapshot, supply, rewardSelection });
  return createEligibilityPayoutManifest({ cycleId,
    snapshotBlock: String(block.number), snapshotHash: block.hash,
    finality: { policyId: 'local-anvil-finalized', depth: '1' },
    supply, entries, selection, exclusions: snapshot.excludedAddresses,
    feasibility: { recipientCount: count, transactionCount: count, maxRecipientCount: 1000, maxTransactionCount: 1000,
      measuredTransferGas: '21000', maxGasPriceWei: String(cap), estimatedNativeFee: native(fee), nativeReserve: native(10),
      nativeBalance: native(10n ** 21n), requiredNativeAmount: native(fee + 10n), feasible: true, reason: null },
    logCompleteness: { mode: 'dual-source', primary: { sourceId: 'fixture-a', transferLogDigest: `sha256:${'cc'.repeat(32)}`, logCount: count },
      secondary: { sourceId: 'fixture-b', transferLogDigest: `sha256:${'cc'.repeat(32)}`, logCount: count } },
    holderSnapshotDigest: snapshot.holderSnapshotDigest, launchManifestDigest: `sha256:${'ee'.repeat(32)}`,
  });
}
function config() {
  const eth = { chainId: '4663', assetId: 'native', decimals: 18 };
  const stable = { chainId: '792703809', assetId: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 };
  return { chainId: 4663, accounts: { evm: operations }, moneyConfiguration: {
    schema: 'hookemon.money-configuration.v2', assets: { eth, solanaStablecoin: stable },
    minimums: { robinhoodReceive: native(0), solanaReceive: { ...stable, amountAtomic: '0' }, returnEth: native(0) },
    evm: { perTransactionGasPriceCap: native(cap), nativeReserve: native(10) },
    solana: { priorityFeeCap: { chainId: '792703809', assetId: 'microlamports-per-compute-unit', decimals: 0, amountAtomic: '2' },
      lamportReserve: { chainId: '792703809', assetId: 'native', decimals: 9, amountAtomic: '2' } },
  } };
}
async function port() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const value = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return value;
}
async function diskStore(path) {
  return {
    load: async () => JSON.parse(await readFile(path, 'utf8')),
    persist: async value => { await writeFile(`${path}.tmp`, JSON.stringify(value)); await rename(`${path}.tmp`, path); },
  };
}
for (const count of (process.env.REWARD_SELECTION_TEST_COUNTS ?? '100,200,300,400,500,600').split(',').map(Number)) {
  test(`local native selected payout N=${count}: mined transfers, accounting and restart`, { timeout: 900_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'reward-selection-anvil-'));
    const child = spawn(process.env.REWARD_SELECTION_ANVIL ?? 'anvil',
      ['--host', '127.0.0.1', '--port', String(await port()), '--chain-id', '4663', '--accounts', '0', '--prune-history', '128', '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let anvilExit = null, anvilStderr = '';
    child.on('exit', (code, signal) => { anvilExit = { code, signal }; });
    child.stderr.on('data', chunk => { anvilStderr = (anvilStderr + chunk.toString()).slice(-4096); });
    t.after(() => { if (anvilExit) t.diagnostic(JSON.stringify({ anvilExit, anvilStderr })); });
    const childPort = child.spawnargs[child.spawnargs.indexOf('--port') + 1];
    t.after(async () => { child.kill(); await rm(directory, { recursive: true, force: true }); });
    const client = createPublicClient({ transport: http(`http://127.0.0.1:${childPort}`, { retryCount: 0 }), cacheTime: 0 });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { assert.equal(await client.getChainId(), 4663); ready = true; break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    assert.ok(ready, 'own local Anvil must start; no skip or provider fallback');
    assert.match(await client.request({ method: 'web3_clientVersion' }), /anvil/i);
    await client.request({ method: 'anvil_setBalance', params: [operations, `0x${(10n ** 21n).toString(16)}`] });
    const before = await client.getBalance({ address: operations });
    const cycleId = `reward-selection-${count}`;
    const eligibilityManifest = manifest(count, cycleId, await client.getBlock());
    const pool = BigInt(count) * 1000n + 1n;
    const plan = compileDirectPayoutPlan({ cycleId, eligibilityManifest, finalizedReturn: native(pool), previousDust: native(0),
      returnBinding: { operations, assetId: 'native', evidenceDigest: `sha256:${'ff'.repeat(32)}` } });
    assert.equal(plan.schema, 'hookemon.direct-payout-plan.v3');
    assert.equal(plan.eligibility.selection.eligibleCount, count + 17);
    assert.equal(plan.eligibility.selection.selectedCount, count);
    assert.equal(plan.eligibility.selection.excludedBalanceTotal.amountAtomic, '10');
    const path = join(directory, 'payout.json');
    let store = await diskStore(path);
    await store.persist(createDirectPayoutState({ plan, operations, assetId: 'native', firstNonce: '0' }));
    let crash = true;
    const broadcastHashes = [];
    const signerClient = { evm: wrapSignerClient({ role: 'operator-evm', liveMode: true,
      preflightAuthority: createTestProfileMutationAuthority(), inner: {
        async sign({ transaction }) {
          const tx = { ...transaction };
          for (const key of ['nonce', 'value', 'gas', 'gasPrice']) tx[key] = BigInt(tx[key]);
          return { signedTx: await account.signTransaction(tx) };
        },
        async broadcast({ signedTx }) {
          const hash = await client.sendRawTransaction({ serializedTransaction: signedTx });
          assert.equal(hash, keccak256(signedTx)); broadcastHashes.push(hash);
          await client.request({ method: 'anvil_mine', params: ['0x50', '0x0'] });
          if (crash) { crash = false; throw new Error('LOCAL_TEST_CRASH_AFTER_MINED_BROADCAST'); }
          return { transactionHash: hash };
        },
      } }) };
    const advance = recipient => advanceDirectPayout({ payoutStore: store, recipient, adapters: { robinhood: { client } }, signerClient, config: config() });
    for (let i = 0; i < count; i++) {
      for (let step = 0; step < 6; step++) {
        try { await advance(address(i)); } catch (error) {
          if (!/LOCAL_TEST_CRASH_AFTER_MINED_BROADCAST/.test(error.message)) throw error;
          assert.equal(i, 0); assert.equal((await store.load()).recipients[0].state, 'SIGNED');
          store = await diskStore(path);
        }
        if ((await store.load()).recipients[i].state === 'FINALIZED') break;
      }
      assert.equal((await store.load()).recipients[i].state, 'FINALIZED');
      if ((i + 1) % 100 === 0) t.diagnostic(`N=${count}: ${i + 1} actual transfers finalized`);
    }
    store = await diskStore(path);
    const result = await store.load();
    assert.equal(isDirectPayoutComplete(result), true);
    for (const recipient of result.recipients) await advance(recipient.recipient);
    assert.equal(broadcastHashes.length, count);
    assert.equal(new Set(broadcastHashes).size, count);
    assert.equal(new Set(result.recipients.map(item => item.nonce)).size, count);
    let paid = 0n, gas = 0n;
    for (const item of result.recipients) {
      assert.ok(BigInt(item.amount.amountAtomic) > 0n);
      const receipt = await client.getTransactionReceipt({ hash: item.txHash });
      assert.equal(receipt.status, 'success');
      assert.equal(item.finalizedTransfer.gasSpentWei, String(receipt.gasUsed * receipt.effectiveGasPrice));
      const transaction = await client.getTransaction({ hash: item.txHash });
      assert.equal(String(transaction.nonce), item.nonce);
      assert.equal(transaction.value, BigInt(item.amount.amountAtomic));
      assert.equal(await client.getBalance({ address: item.recipient }), BigInt(item.amount.amountAtomic));
      paid += BigInt(item.amount.amountAtomic); gas += receipt.gasUsed * receipt.effectiveGasPrice;
    }
    for (let i = count; i < count + 17; i++) assert.equal(await client.getBalance({ address: address(i) }), 0n);
    assert.equal(paid + BigInt(result.dust.amountAtomic), pool);
    assert.equal(before - await client.getBalance({ address: operations }), paid + gas);
    assert.equal(await client.getTransactionCount({ address: operations }), count);
    t.diagnostic(JSON.stringify({ count, finalized: result.recipients.length, paidWei: String(paid), dustWei: result.dust.amountAtomic,
      gasWei: String(gas), broadcastCount: broadcastHashes.length, restartAfterMinedBroadcast: true }));
  });
}
