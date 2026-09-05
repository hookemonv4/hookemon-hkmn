import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { digest } from '../../../runner/src/cycle/journal.mjs';
import { ERC20_TRANSFER_TOPIC } from '../../src/robinhood-rpc.mjs';
import { CycleRepository } from '../../src/app/cycle-repository.mjs';
import {
  freezeEligibilityBeforeClaim,
  reconcileLiveEligibilitySnapshot,
} from '../../src/app/stages/eligibility-snapshot.mjs';

const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const BURN_ADDRESS = `0x${'0'.repeat(36)}dead`;
const TOKEN = `0x${'a'.repeat(40)}`;
const HOLDER_A = `0x${'1'.repeat(40)}`;
const HOLDER_B = `0x${'2'.repeat(40)}`;
const HOLDER_CONTRACT = `0x${'3'.repeat(40)}`;
const HOOK = `0x${'4'.repeat(40)}`;
const POOL_MANAGER = `0x${'5'.repeat(40)}`;
const CUSTODY = `0x${'6'.repeat(40)}`;
const OPERATIONS = `0x${'7'.repeat(40)}`;
const TREASURY = `0x${'8'.repeat(40)}`;
const PROGRAMMABLE = `0x${'9'.repeat(40)}`;
const LAUNCH_CONTRACT = `0x${'b'.repeat(40)}`;
const FORMER_ROLE_HOLDER = `0x${'c'.repeat(40)}`;

function hash(byte) {
  return `0x${byte.repeat(64)}`;
}

function topicAddress(address) {
  return `0x${'0'.repeat(24)}${address.slice(2)}`;
}

function rawTransfer({ blockNumber, logIndex, from, to, value }) {
  return {
    address: TOKEN,
    topics: [ERC20_TRANSFER_TOPIC, topicAddress(from), topicAddress(to)],
    data: `0x${BigInt(value).toString(16).padStart(64, '0')}`,
    blockNumber: `0x${BigInt(blockNumber).toString(16)}`,
    logIndex: `0x${BigInt(logIndex).toString(16)}`,
    transactionHash: hash('d'),
    transactionIndex: '0x0',
    blockHash: hash('e'),
    removed: false,
  };
}

function block(number, blockHash) {
  return { number: BigInt(number), hash: blockHash, timestamp: 0n };
}

function fakeRpc({ latest = 10n, finalized = latest, hashes = new Map(), logs = [], onBlockRead = null } = {}) {
  const calls = [];
  const client = {
    calls,
    async getBlock({ blockTag, blockNumber }) {
      const number = blockTag === 'latest'
        ? latest
        : blockTag === 'finalized'
          ? finalized
          : BigInt(blockNumber);
      calls.push({ method: 'eth_getBlockByNumber', number, blockTag: blockTag ?? null });
      const value = onBlockRead?.({ number, calls }) ?? hashes.get(number) ?? hash('f');
      return block(number, value);
    },
    async request({ method, params }) {
      calls.push({ method, params });
      assert.equal(method, 'eth_getLogs');
      const [{ fromBlock, toBlock }] = params;
      const lower = BigInt(fromBlock);
      const upper = BigInt(toBlock);
      return logs.filter(log => {
        const current = BigInt(log.blockNumber);
        return current >= lower && current <= upper;
      });
    },
  };
  client.independentReplica = () => fakeRpc({ latest, finalized, hashes, logs, onBlockRead });
  return client;
}

function dualSourceAdapters(primary, secondary = primary.independentReplica()) {
  return { robinhood: { client: primary, secondaryLogClient: secondary } };
}

function launchManifestDigest(launchManifest) {
  return digest({
    domain: 'hookemon.eligibility-launch-manifest.v1',
    launchManifest: {
      supply: launchManifest.supply,
      hook: launchManifest.hook,
      poolManager: launchManifest.poolManager,
      custody: launchManifest.custody,
      operations: launchManifest.operations,
      treasury: launchManifest.treasury,
      programmableRecipient: launchManifest.programmableRecipient,
      launchContracts: [...launchManifest.launchContracts].sort(),
      burnAddresses: [...launchManifest.burnAddresses].sort(),
      roleHistory: launchManifest.roleHistory
        .map(({ role, address }) => ({ role, address }))
        .sort((a, b) => (a.address === b.address ? a.role.localeCompare(b.role) : a.address.localeCompare(b.address))),
    },
  });
}

function baseConfig(overrides = {}) {
  const launchManifest = {
    supply: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '30' },
    hook: HOOK,
    poolManager: POOL_MANAGER,
    custody: CUSTODY,
    operations: OPERATIONS,
    treasury: TREASURY,
    programmableRecipient: PROGRAMMABLE,
    launchContracts: [LAUNCH_CONTRACT],
    burnAddresses: [BURN_ADDRESS],
    roleHistory: [{ role: 'former-operations', address: FORMER_ROLE_HOLDER }],
  };
  return {
    chainId: 4663,
    hkmn: { address: TOKEN, deployBlock: 0n, decimals: 18 },
    eligibilitySnapshot: {
      finality: { policyId: 'robinhood-stage-finality-v1', depth: '2' },
      launchManifest,
      launchManifestDigest: launchManifestDigest(launchManifest),
      primaryLogSourceId: 'fake-primary',
      secondaryLogSourceId: 'fake-secondary',
      logPageSize: '2',
      maxRetriesPerPage: 2,
      feasibility: {
        measuredTransferGas: '50000',
        maxGasPriceWei: '2',
        nativeReserveWei: '10',
        nativeBalanceWei: '400000',
        maxRecipientCount: 2000,
        maxTransactionCount: 2000,
      },
    },
    ...overrides,
  };
}

function holdingRepository() {
  const holds = [];
  return {
    holds,
    async holdCycle(cycleId, terminalState, evidence) {
      holds.push({ cycleId, terminalState, evidence });
    },
  };
}

async function durableCycle(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hookemon-eligibility-snapshot-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = await CycleRepository.open(directory);
  const { cycleId } = await repository.createCycle({ releaseAmount: '1', mode: 'production' });
  return { directory, repository, cycleId };
}

test('freezes a pre-claim manifest from pinned Transfer logs without a historical state call', async () => {
  const snapshotHash = hash('1');
  const client = fakeRpc({
    hashes: new Map([[8n, snapshotHash]]),
    logs: [
      rawTransfer({ blockNumber: 1, logIndex: 0, from: ZERO_ADDRESS, to: HOLDER_A, value: 20 }),
      rawTransfer({ blockNumber: 2, logIndex: 0, from: HOLDER_A, to: HOLDER_B, value: 5 }),
      rawTransfer({ blockNumber: 3, logIndex: 0, from: ZERO_ADDRESS, to: HOLDER_CONTRACT, value: 10 }),
    ],
  });

  const manifest = await freezeEligibilityBeforeClaim({
    adapters: dualSourceAdapters(client),
    config: baseConfig(),
    context: { cycleId: 'cycle-snapshot-1', assertLease() {} },
  });

  assert.equal(manifest.cycleId, 'cycle-snapshot-1');
  assert.equal(manifest.snapshotBlock, '8');
  assert.equal(manifest.snapshotHash, snapshotHash);
  assert.deepEqual(manifest.finality, { policyId: 'robinhood-stage-finality-v1', depth: '2' });
  assert.deepEqual(manifest.supply, { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '30' });
  assert.deepEqual(
    manifest.entries.map(entry => [entry.recipient, entry.hkmnBalance.amountAtomic]),
    [[HOLDER_A, '15'], [HOLDER_B, '5'], [HOLDER_CONTRACT, '10']],
  );
  assert.equal(manifest.feasibility.recipientCount, 3);
  assert.equal(manifest.feasibility.transactionCount, 3);
  assert.equal(manifest.feasibility.feasible, true);
  assert.equal(manifest.logCompleteness.mode, 'dual-source');
  assert.equal(manifest.logCompleteness.secondary.sourceId, 'fake-secondary');
  assert.equal(client.calls.some(call => call.method === 'eth_call'), false);
});

test('holds the cycle before claim when the pinned block hash changes after log paging', async () => {
  const firstHash = hash('2');
  const secondHash = hash('3');
  let targetReads = 0;
  const client = fakeRpc({
    hashes: new Map([[8n, firstHash]]),
    logs: [rawTransfer({ blockNumber: 1, logIndex: 0, from: ZERO_ADDRESS, to: HOLDER_A, value: 30 })],
    onBlockRead({ number }) {
      if (number !== 8n) return hash('f');
      targetReads += 1;
      return targetReads >= 6 ? secondHash : firstHash;
    },
  });
  const cycleRepository = holdingRepository();

  await assert.rejects(
    reconcileLiveEligibilitySnapshot({
      adapters: dualSourceAdapters(client),
      config: baseConfig(),
      cycleRepository,
      context: { cycleId: 'cycle-reorg-1', assertLease() {} },
    }),
    /hash|reorg/i,
  );
  assert.equal(cycleRepository.holds.length, 1);
  assert.equal(cycleRepository.holds[0].terminalState, 'HELD_DATA_UNVERIFIED');
});

test('holds the cycle when the full Transfer replay does not reconcile to immutable supply', async () => {
  const client = fakeRpc({
    hashes: new Map([[8n, hash('4')]]),
    logs: [rawTransfer({ blockNumber: 1, logIndex: 0, from: ZERO_ADDRESS, to: HOLDER_A, value: 29 })],
  });
  const cycleRepository = holdingRepository();

  await assert.rejects(
    reconcileLiveEligibilitySnapshot({
      adapters: dualSourceAdapters(client),
      config: baseConfig(),
      cycleRepository,
      context: { cycleId: 'cycle-incomplete-1', assertLease() {} },
    }),
    /supply|incomplete/i,
  );
  assert.equal(cycleRepository.holds.at(-1).terminalState, 'HELD_DATA_UNVERIFIED');
});

test('holds incomplete snapshot logs durably after reopen before the sole claim transition', async t => {
  const { directory, repository, cycleId } = await durableCycle(t);
  const client = fakeRpc({
    hashes: new Map([[8n, hash('4')]]),
    logs: [rawTransfer({ blockNumber: 1, logIndex: 0, from: ZERO_ADDRESS, to: HOLDER_A, value: 29 })],
  });

  await assert.rejects(
    reconcileLiveEligibilitySnapshot({
      adapters: dualSourceAdapters(client),
      config: baseConfig(),
      cycleRepository: repository,
      context: { cycleId, assertLease() {} },
    }),
    /supply|incomplete/i,
  );

  const reopened = await CycleRepository.open(directory);
  assert.equal((await reopened.describeCycle(cycleId)).terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(await reopened.readOperationalStageAttempt(cycleId, 'eligibility-snapshot'), null);
  await assert.rejects(() => reopened.prepareStage(cycleId, 'claim-process'), /terminal as HELD_DATA_UNVERIFIED/);
});

test('holds a snapshot reorg durably after reopen before the sole claim transition', async t => {
  const { directory, repository, cycleId } = await durableCycle(t);
  const firstHash = hash('2');
  const secondHash = hash('3');
  let targetReads = 0;
  const client = fakeRpc({
    hashes: new Map([[8n, firstHash]]),
    logs: [rawTransfer({ blockNumber: 1, logIndex: 0, from: ZERO_ADDRESS, to: HOLDER_A, value: 30 })],
    onBlockRead({ number }) {
      if (number !== 8n) return hash('f');
      targetReads += 1;
      return targetReads >= 6 ? secondHash : firstHash;
    },
  });

  await assert.rejects(
    reconcileLiveEligibilitySnapshot({
      adapters: dualSourceAdapters(client),
      config: baseConfig(),
      cycleRepository: repository,
      context: { cycleId, assertLease() {} },
    }),
    /hash|reorg/i,
  );

  const reopened = await CycleRepository.open(directory);
  assert.equal((await reopened.describeCycle(cycleId)).terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(await reopened.readOperationalStageAttempt(cycleId, 'eligibility-snapshot'), null);
  await assert.rejects(() => reopened.prepareStage(cycleId, 'claim-process'), /terminal as HELD_DATA_UNVERIFIED/);
});

test('requires an independent log source even when a legacy single-source flag is present', async () => {
  const client = fakeRpc({
    hashes: new Map([[8n, hash('7')]]),
    logs: [rawTransfer({ blockNumber: 1, logIndex: 0, from: ZERO_ADDRESS, to: HOLDER_A, value: 30 })],
  });
  const cycleRepository = holdingRepository();
  const config = baseConfig({
    eligibilitySnapshot: { ...baseConfig().eligibilitySnapshot, allowSingleLogSource: true },
  });

  await assert.rejects(
    reconcileLiveEligibilitySnapshot({
      adapters: { robinhood: { client } },
      config,
      cycleRepository,
      context: { cycleId: 'cycle-source-consent-1', assertLease() {} },
    }),
    /independent/i,
  );
  assert.equal(cycleRepository.holds.at(-1).terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(client.calls.some(call => call.method === 'eth_getLogs'), false);
});

test('fails closed before RPC reads when the finality policy has no configured depth', async () => {
  const client = fakeRpc();
  const cycleRepository = holdingRepository();
  const config = baseConfig({
    eligibilitySnapshot: {
      ...baseConfig().eligibilitySnapshot,
      finality: { policyId: 'robinhood-stage-finality-v1' },
    },
  });

  await assert.rejects(
    reconcileLiveEligibilitySnapshot({
      adapters: dualSourceAdapters(client),
      config,
      cycleRepository,
      context: { cycleId: 'cycle-no-depth-1', assertLease() {} },
    }),
    /depth|required/i,
  );
  assert.equal(cycleRepository.holds.at(-1).terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(client.calls.length, 0);
});

test('rejects a launch manifest whose configured digest does not bind its current contents', async () => {
  const client = fakeRpc();
  const cycleRepository = holdingRepository();
  const config = baseConfig();
  config.eligibilitySnapshot.launchManifestDigest = `sha256:${'0'.repeat(64)}`;

  await assert.rejects(
    reconcileLiveEligibilitySnapshot({
      adapters: dualSourceAdapters(client),
      config,
      cycleRepository,
      context: { cycleId: 'cycle-manifest-digest-1', assertLease() {} },
    }),
    /manifest.*digest|digest.*manifest/i,
  );
  assert.equal(cycleRepository.holds.at(-1).terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(client.calls.length, 0);
});

test('holds the cycle when latest block is below the configured finality depth', async () => {
  const client = fakeRpc({ latest: 1n });
  const cycleRepository = holdingRepository();

  await assert.rejects(
    reconcileLiveEligibilitySnapshot({
      adapters: dualSourceAdapters(client),
      config: baseConfig(),
      cycleRepository,
      context: { cycleId: 'cycle-shallow-chain-1', assertLease() {} },
    }),
    /finality depth|unavailable/i,
  );
  assert.equal(cycleRepository.holds.at(-1).terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(client.calls.some(call => call.method === 'eth_getLogs'), false);
});

test('holds the cycle when an independent source omits an ordinary Transfer', async () => {
  const snapshotHash = hash('8');
  const primary = fakeRpc({
    hashes: new Map([[8n, snapshotHash]]),
    logs: [
      rawTransfer({ blockNumber: 1, logIndex: 0, from: ZERO_ADDRESS, to: HOLDER_A, value: 30 }),
      rawTransfer({ blockNumber: 2, logIndex: 0, from: HOLDER_A, to: HOLDER_B, value: 5 }),
    ],
  });
  const secondary = fakeRpc({
    hashes: new Map([[8n, snapshotHash]]),
    logs: [rawTransfer({ blockNumber: 1, logIndex: 0, from: ZERO_ADDRESS, to: HOLDER_A, value: 30 })],
  });
  const cycleRepository = holdingRepository();

  await assert.rejects(
    reconcileLiveEligibilitySnapshot({
      adapters: { robinhood: { client: primary, secondaryLogClient: secondary } },
      config: baseConfig({
        eligibilitySnapshot: {
          ...baseConfig().eligibilitySnapshot,
          secondaryLogSourceId: 'fake-secondary',
        },
      }),
      cycleRepository,
      context: { cycleId: 'cycle-source-mismatch-1', assertLease() {} },
    }),
    /source|digest|complete/i,
  );
  assert.equal(cycleRepository.holds.at(-1).terminalState, 'HELD_DATA_UNVERIFIED');
});

test('requires configured identities for both dual log sources', async () => {
  const snapshotHash = hash('a');
  const primary = fakeRpc({
    hashes: new Map([[8n, snapshotHash]]),
    logs: [rawTransfer({ blockNumber: 1, logIndex: 0, from: ZERO_ADDRESS, to: HOLDER_A, value: 30 })],
  });
  const secondary = fakeRpc({
    hashes: new Map([[8n, snapshotHash]]),
    logs: [rawTransfer({ blockNumber: 1, logIndex: 0, from: ZERO_ADDRESS, to: HOLDER_A, value: 30 })],
  });
  const cycleRepository = holdingRepository();
  const config = baseConfig({
    eligibilitySnapshot: {
      ...baseConfig().eligibilitySnapshot,
      primaryLogSourceId: undefined,
      secondaryLogSourceId: undefined,
    },
  });

  await assert.rejects(
    reconcileLiveEligibilitySnapshot({
      adapters: { robinhood: { client: primary, secondaryLogClient: secondary } },
      config,
      cycleRepository,
      context: { cycleId: 'cycle-source-identity-1', assertLease() {} },
    }),
    /source.*id/i,
  );
  assert.equal(cycleRepository.holds.at(-1).terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(primary.calls.length, 0);
  assert.equal(secondary.calls.length, 0);
});

test('requires a secondary source identity when a secondary log client is configured', async () => {
  const snapshotHash = hash('a');
  const primary = fakeRpc({ hashes: new Map([[8n, snapshotHash]]) });
  const secondary = fakeRpc({ hashes: new Map([[8n, snapshotHash]]) });
  const cycleRepository = holdingRepository();
  const config = baseConfig({
    eligibilitySnapshot: {
      ...baseConfig().eligibilitySnapshot,
      secondaryLogSourceId: undefined,
    },
  });

  await assert.rejects(
    reconcileLiveEligibilitySnapshot({
      adapters: { robinhood: { client: primary, secondaryLogClient: secondary } },
      config,
      cycleRepository,
      context: { cycleId: 'cycle-secondary-source-identity-1', assertLease() {} },
    }),
    /secondary.*source.*id/i,
  );
  assert.equal(cycleRepository.holds.at(-1).terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(primary.calls.length, 0);
  assert.equal(secondary.calls.length, 0);
});

test('rejects a repeated primary client as a false independent log source', async () => {
  const client = fakeRpc({
    hashes: new Map([[8n, hash('9')]]),
    logs: [rawTransfer({ blockNumber: 1, logIndex: 0, from: ZERO_ADDRESS, to: HOLDER_A, value: 30 })],
  });
  const cycleRepository = holdingRepository();

  await assert.rejects(
    reconcileLiveEligibilitySnapshot({
      adapters: { robinhood: { client, secondaryLogClient: client } },
      config: baseConfig({
        eligibilitySnapshot: {
          ...baseConfig().eligibilitySnapshot,
          secondaryLogSourceId: 'fake-secondary',
        },
      }),
      cycleRepository,
      context: { cycleId: 'cycle-repeated-source-1', assertLease() {} },
    }),
    /independent|distinct/i,
  );
  assert.equal(cycleRepository.holds.at(-1).terminalState, 'HELD_DATA_UNVERIFIED');
});

test('retains every holder above 1024 and lets the feasibility envelope refuse the claim', async () => {
  const holders = Array.from({ length: 1025 }, (_, index) => `0x${(index + 1000).toString(16).padStart(40, '0')}`);
  const client = fakeRpc({
    hashes: new Map([[8n, hash('5')]]),
    logs: holders.map((holder, index) => rawTransfer({
      blockNumber: 1,
      logIndex: index,
      from: ZERO_ADDRESS,
      to: holder,
      value: 1,
    })),
  });
  const cycleRepository = holdingRepository();
  const launchManifest = {
    ...baseConfig().eligibilitySnapshot.launchManifest,
    supply: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1025' },
  };
  const config = baseConfig({
    eligibilitySnapshot: {
      ...baseConfig().eligibilitySnapshot,
      launchManifest,
      launchManifestDigest: launchManifestDigest(launchManifest),
      feasibility: { ...baseConfig().eligibilitySnapshot.feasibility, maxRecipientCount: 1024 },
    },
  });

  let error;
  await assert.rejects(
    reconcileLiveEligibilitySnapshot({
      adapters: dualSourceAdapters(client),
      config,
      cycleRepository,
      context: { cycleId: 'cycle-envelope-1', assertLease() {} },
    }),
    caught => {
      error = caught;
      return /feasibility|recipient/i.test(caught.message);
    },
  );
  assert.equal(error.manifest.entries.length, 1025);
  assert.equal(cycleRepository.holds.at(-1).terminalState, 'HELD_UNAVAILABLE');
  assert.equal(client.calls.filter(call => call.method === 'eth_getLogs').length > 1, true);
});

test('holds a holder envelope breach durably after reopen before the sole claim transition', async t => {
  const { directory, repository, cycleId } = await durableCycle(t);
  const holders = Array.from({ length: 1025 }, (_, index) => `0x${(index + 1000).toString(16).padStart(40, '0')}`);
  const client = fakeRpc({
    hashes: new Map([[8n, hash('5')]]),
    logs: holders.map((holder, index) => rawTransfer({
      blockNumber: 1,
      logIndex: index,
      from: ZERO_ADDRESS,
      to: holder,
      value: 1,
    })),
  });
  const launchManifest = {
    ...baseConfig().eligibilitySnapshot.launchManifest,
    supply: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1025' },
  };
  const config = baseConfig({
    eligibilitySnapshot: {
      ...baseConfig().eligibilitySnapshot,
      launchManifest,
      launchManifestDigest: launchManifestDigest(launchManifest),
      feasibility: { ...baseConfig().eligibilitySnapshot.feasibility, maxRecipientCount: 1024 },
    },
  });

  await assert.rejects(
    reconcileLiveEligibilitySnapshot({
      adapters: dualSourceAdapters(client),
      config,
      cycleRepository: repository,
      context: { cycleId, assertLease() {} },
    }),
    /feasibility|recipient/i,
  );

  const reopened = await CycleRepository.open(directory);
  assert.equal((await reopened.describeCycle(cycleId)).terminalState, 'HELD_UNAVAILABLE');
  assert.equal(await reopened.readOperationalStageAttempt(cycleId, 'eligibility-snapshot'), null);
  await assert.rejects(() => reopened.prepareStage(cycleId, 'claim-process'), /terminal as HELD_UNAVAILABLE/);
});

test('refuses 1,026 recipients at the direct-payout capacity before claim processing', async () => {
  const holders = Array.from({ length: 1026 }, (_, index) => `0x${(index + 3000).toString(16).padStart(40, '0')}`);
  const client = fakeRpc({
    hashes: new Map([[8n, hash('6')]]),
    logs: holders.map((holder, index) => rawTransfer({
      blockNumber: 1,
      logIndex: index,
      from: ZERO_ADDRESS,
      to: holder,
      value: 1,
    })),
  });
  const cycleRepository = holdingRepository();
  const launchManifest = {
    ...baseConfig().eligibilitySnapshot.launchManifest,
    supply: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '1026' },
  };
  const config = baseConfig({
    eligibilitySnapshot: {
      ...baseConfig().eligibilitySnapshot,
      launchManifest,
      launchManifestDigest: launchManifestDigest(launchManifest),
      feasibility: {
        ...baseConfig().eligibilitySnapshot.feasibility,
        nativeBalanceWei: '200000000',
      },
    },
  });

  let error;
  await assert.rejects(
    reconcileLiveEligibilitySnapshot({
      adapters: dualSourceAdapters(client),
      config,
      cycleRepository,
      context: { cycleId: 'cycle-direct-payout-capacity', assertLease() {} },
    }),
    caught => {
      error = caught;
      return /direct-payout.*capacity/i.test(caught.message);
    },
  );

  assert.equal(error.manifest.entries.length, 1026);
  assert.equal(error.manifest.feasibility.maxRecipientCount, 1025);
  assert.equal(error.manifest.feasibility.maxTransactionCount, 1025);
  assert.match(error.manifest.feasibility.reason, /recipient-count-exceeds-direct-payout-capacity/);
  assert.equal(cycleRepository.holds.at(-1).terminalState, 'HELD_UNAVAILABLE');
});

test('excludes deployment and historical role addresses without excluding unrelated contract recipients', async () => {
  const snapshotHash = hash('6');
  const client = fakeRpc({
    hashes: new Map([[8n, snapshotHash]]),
    logs: [
      rawTransfer({ blockNumber: 1, logIndex: 0, from: ZERO_ADDRESS, to: HOOK, value: 1 }),
      rawTransfer({ blockNumber: 1, logIndex: 1, from: ZERO_ADDRESS, to: POOL_MANAGER, value: 1 }),
      rawTransfer({ blockNumber: 1, logIndex: 2, from: ZERO_ADDRESS, to: CUSTODY, value: 1 }),
      rawTransfer({ blockNumber: 1, logIndex: 3, from: ZERO_ADDRESS, to: OPERATIONS, value: 1 }),
      rawTransfer({ blockNumber: 1, logIndex: 4, from: ZERO_ADDRESS, to: TREASURY, value: 1 }),
      rawTransfer({ blockNumber: 1, logIndex: 5, from: ZERO_ADDRESS, to: PROGRAMMABLE, value: 1 }),
      rawTransfer({ blockNumber: 1, logIndex: 6, from: ZERO_ADDRESS, to: LAUNCH_CONTRACT, value: 1 }),
      rawTransfer({ blockNumber: 1, logIndex: 7, from: ZERO_ADDRESS, to: FORMER_ROLE_HOLDER, value: 1 }),
      rawTransfer({ blockNumber: 1, logIndex: 8, from: ZERO_ADDRESS, to: HOLDER_CONTRACT, value: 22 }),
    ],
  });
  const config = baseConfig({
    eligibilitySnapshot: {
      ...baseConfig().eligibilitySnapshot,
      launchManifest: { ...baseConfig().eligibilitySnapshot.launchManifest, supply: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '30' } },
    },
  });

  const manifest = await freezeEligibilityBeforeClaim({
    adapters: dualSourceAdapters(client),
    config,
    context: { cycleId: 'cycle-exclusions-1', assertLease() {} },
  });

  assert.deepEqual(manifest.entries, [{
    recipient: HOLDER_CONTRACT,
    hkmnBalance: { chainId: '4663', assetId: TOKEN, decimals: 18, amountAtomic: '22' },
  }]);
  assert.equal(manifest.exclusions.some(entry => entry.address === FORMER_ROLE_HOLDER), true);
});

test('holds before log paging when the configured finality depth reaches past the finalized head', async () => {
  const client = fakeRpc({
    latest: 10n,
    finalized: 7n,
    hashes: new Map([[8n, hash('b')]]),
    logs: [rawTransfer({ blockNumber: 1, logIndex: 0, from: ZERO_ADDRESS, to: HOLDER_A, value: 30 })],
  });
  const cycleRepository = holdingRepository();

  await assert.rejects(
    reconcileLiveEligibilitySnapshot({
      adapters: dualSourceAdapters(client),
      config: baseConfig(),
      cycleRepository,
      context: { cycleId: 'cycle-finalized-head-lag-1', assertLease() {} },
    }),
    /finalized|finality/i,
  );
  assert.equal(cycleRepository.holds.at(-1).terminalState, 'HELD_DATA_UNVERIFIED');
  assert.equal(client.calls.some(call => call.method === 'eth_getLogs'), false);
  assert.equal(client.calls.some(call => call.blockTag === 'finalized'), true);
});

test('does not write an unfenced terminal hold after the snapshot lease is lost', async () => {
  const client = fakeRpc({
    hashes: new Map([[8n, hash('c')]]),
    logs: [rawTransfer({ blockNumber: 1, logIndex: 0, from: ZERO_ADDRESS, to: HOLDER_A, value: 30 })],
  });
  const cycleRepository = holdingRepository();
  let leaseChecks = 0;

  await assert.rejects(
    reconcileLiveEligibilitySnapshot({
      adapters: dualSourceAdapters(client),
      config: baseConfig(),
      cycleRepository,
      context: {
        cycleId: 'cycle-lease-loss-1',
        assertLease() {
          leaseChecks += 1;
          if (leaseChecks >= 3) throw new Error('lease lost during eligibility snapshot');
        },
      },
    }),
    /lease lost during eligibility snapshot/,
  );
  assert.equal(cycleRepository.holds.length, 0);
});
