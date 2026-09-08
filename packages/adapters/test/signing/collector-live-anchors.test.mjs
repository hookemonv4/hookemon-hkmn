import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from '../../../runner/src/cycle/journal.mjs';

import { Keypair } from '@solana/web3.js';
import { COLLECTOR_PURCHASE_BINDING_SCHEMA } from '../../src/signing/collector-purchase-policy.mjs';
import { COLLECTOR_BUYBACK_BINDING_SCHEMA } from '../../src/signing/collector-buyback-policy.mjs';

const source = new URL('../../../../', import.meta.url);
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const MEMO_PROGRAM_ID = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
const COLLECTOR_PROGRAM_ID = Keypair.generate().publicKey.toBase58();

const PURCHASE_BINDING = Object.freeze({
  schema: COLLECTOR_PURCHASE_BINDING_SCHEMA,
  version: 1,
  provider: 'collector-crypt',
  chainId: 'solana-mainnet',
  format: 'legacy',
  addressLookupTables: [],
  settlement: {
    destination: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    decimals: 6,
  },
  providerCoSigner: Keypair.generate().publicKey.toBase58(),
  instructions: [
    { kind: 'compute-budget-set-unit-limit', programId: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], computeUnitLimit: 40000, priorityFeeCapAtomic: null, memoPrefix: null },
    { kind: 'compute-budget-set-unit-price', programId: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], computeUnitLimit: null, priorityFeeCapAtomic: '5000', memoPrefix: null },
    {
      kind: 'spl-transfer-checked',
      programId: TOKEN_PROGRAM_ID,
      accounts: [
        { role: 'source-ata', isSigner: false, isWritable: true },
        { role: 'settlement-mint', isSigner: false, isWritable: false },
        { role: 'settlement-destination', isSigner: false, isWritable: true },
        { role: 'operator-fee-payer', isSigner: true, isWritable: true },
      ],
      computeUnitLimit: null,
      priorityFeeCapAtomic: null,
      memoPrefix: null,
    },
    {
      kind: 'unknown',
      programId: MEMO_PROGRAM_ID,
      accounts: [{ role: 'provider-co-signer', isSigner: true, isWritable: false }],
      computeUnitLimit: null,
      priorityFeeCapAtomic: null,
      memoPrefix: 'collector-purchase:v1:',
    },
  ],
});

const BUYBACK_BINDING = Object.freeze({
  schema: COLLECTOR_BUYBACK_BINDING_SCHEMA,
  version: 1,
  provider: 'collector-crypt',
  chainId: 'solana-mainnet',
  format: 'legacy',
  addressLookupTables: [],
  proceeds: {
    source: Keypair.generate().publicKey.toBase58(),
    mint: Keypair.generate().publicKey.toBase58(),
    decimals: 6,
  },
  collectorAuthority: Keypair.generate().publicKey.toBase58(),
  collectorRecipient: Keypair.generate().publicKey.toBase58(),
  instructions: [
    { kind: 'compute-budget-set-unit-limit', programId: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], computeUnitLimit: 40000, priorityFeeCapAtomic: null, discriminatorHex: null },
    { kind: 'compute-budget-set-unit-price', programId: COMPUTE_BUDGET_PROGRAM_ID, accounts: [], computeUnitLimit: null, priorityFeeCapAtomic: '5000', discriminatorHex: null },
    {
      kind: 'unknown',
      programId: COLLECTOR_PROGRAM_ID,
      accounts: [
        { role: 'operator-fee-payer', isSigner: true, isWritable: true },
        { role: 'collector-authority', isSigner: true, isWritable: false },
        { role: 'opened-asset-mint', isSigner: false, isWritable: true },
        { role: 'collector-recipient', isSigner: false, isWritable: true },
      ],
      computeUnitLimit: null,
      priorityFeeCapAtomic: null,
      discriminatorHex: 'a1b2c3d4e5f60718',
    },
    {
      kind: 'spl-transfer-checked',
      programId: TOKEN_PROGRAM_ID,
      accounts: [
        { role: 'proceeds-source', isSigner: false, isWritable: true },
        { role: 'proceeds-mint', isSigner: false, isWritable: false },
        { role: 'proceeds-destination', isSigner: false, isWritable: true },
        { role: 'collector-authority', isSigner: true, isWritable: false },
      ],
      computeUnitLimit: null,
      priorityFeeCapAtomic: null,
      discriminatorHex: null,
    },
  ],
});


const sha = value => createHash('sha256').update(value).digest('hex');
async function fixture(t, suffix = '') {
  const root = await mkdtemp(join(tmpdir(), 'collector-anchors-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['packages/adapters/src', 'packages/runner/src', 'bindings', 'architecture']) {
    await cp(new URL(dir, source), join(root, dir), { recursive: true });
  }
  await symlink(await realpath(new URL('packages/adapters/node_modules', source)), join(root, 'packages/adapters/node_modules'));
  await mkdir(join(root, 'receipts'), { recursive: true });
  await mkdir(join(root, 'decisions'), { recursive: true });
  const manifest = { schema: 'hookemon.collector-live-release.v1', requirementsRevision: 69, architectureRevision: 10, anchors: [], approvalEvidence: [] };
  const artifacts = {};
  for (const [index, stage] of ['purchase', 'buyback'].entries()) {
    const bindingPath = `bindings/test-${stage}${suffix}.json`;
    const bytes = JSON.stringify(stage === 'purchase' ? PURCHASE_BINDING : BUYBACK_BINDING);
    const anchor = { stage, provider: 'collector-crypt', chainId: 'solana-mainnet', bindingPath, bindingDigest: digest(JSON.parse(bytes)), ownerApprovalReceiptId: `r-${String(index + 1).padStart(5, '0')}` };
    const approvalPath = `decisions/test-${stage}${suffix}-approval.json`;
    const approval = { schema: 'hookemon.collector-live-binding-approval.v1', authority: 'OWNER', approvalToken: 'OWNER APPROVED', anchor };
    const approvalBytes = JSON.stringify(approval);
    const receipt = { id: anchor.ownerApprovalReceiptId, type: 'collector-live-binding-approved', result: 'PASSED', inputHashes: { [bindingPath]: sha(bytes), [approvalPath]: sha(approvalBytes) } };
    artifacts[bindingPath] = bytes;
    artifacts[approvalPath] = approvalBytes;
    artifacts[`receipts/${receipt.id}.json`] = JSON.stringify(receipt);
    manifest.anchors.push(anchor);
    manifest.approvalEvidence.push({ receiptId: receipt.id, receiptSha256: sha(JSON.stringify(receipt)), approvalPath, approvalSha256: sha(approvalBytes) });
  }
  const active = JSON.parse(await readFile(join(root, 'architecture/interfaces.json'), 'utf8'));
  Object.assign(active, { status: 'FROZEN_BUILD_CONTRACT_PRODUCTION_INTEGRATION_PENDING', requirementsRevision: 69, architectureRevision: 10, bindingManifestDigest: digest(manifest) });
  artifacts['architecture/interfaces.json'] = JSON.stringify(active);
  artifacts['bindings/collector-live-release.json'] = JSON.stringify(manifest);
  async function reset() { for (const [path, bytes] of Object.entries(artifacts)) await writeFile(join(root, path), bytes); }
  await reset();
  const modulePath = join(root, 'packages/adapters/src/signing/collector-live-anchors.mjs');
  const moduleSource = await readFile(modulePath, 'utf8');
  await writeFile(modulePath, moduleSource.replace('const COLLECTOR_LIVE_RELEASE_SHA256 = null;',
    `const COLLECTOR_LIVE_RELEASE_SHA256 = '${sha(artifacts['bindings/collector-live-release.json'])}';`));
  const api = await import(pathToFileURL(join(root, 'packages/adapters/src/signing/collector-live-anchors.mjs')));
  const registryApi = await import(pathToFileURL(join(root, 'packages/adapters/src/signing/collector-production-binding.mjs')));
  return { root, manifest, artifacts, reset, api, registryApi };
}

test('live anchors authenticate both independently approved artifacts through the fixed frozen release', async t => {
  const f = await fixture(t);
  const entries = f.api.requireCollectorLiveBindingAnchors();
  assert.deepEqual(entries.map(value => value.stage), ['purchase', 'buyback']);
  assert.ok(Object.isFrozen(entries));
  const registry = { schema: 'hookemon.collector-production-binding-registry.v1', version: 1,
    entries: entries.map(value => ({ schema: 'hookemon.collector-production-binding-entry.v1', version: 1,
      authority: 'live', stage: value.stage, provider: value.provider, chainId: value.chainId,
      expectedDigest: value.bindingDigest, binding: value.binding })) };
  const loaded = f.registryApi.loadCollectorProductionBindingRegistry(registry);
  for (const stage of ['purchase', 'buyback']) {
    assert.equal(f.registryApi.resolveCollectorProductionBinding({ registry: loaded, authority: 'live', stage }).expectedDigest,
      entries.find(value => value.stage === stage).bindingDigest);
  }
  const forged = structuredClone(loaded); forged.entries[0].binding.providerCoSigner = Keypair.generate().publicKey.toBase58();
  forged.entries[0].expectedDigest = digest(forged.entries[0].binding);
  assert.throws(() => f.registryApi.resolveCollectorProductionBinding({ registry: forged, authority: 'live', stage: 'purchase' }), /approved release anchor/);

  for (const path of ['bindings/test-purchase.json', 'decisions/test-buyback-approval.json', 'receipts/r-00001.json', 'bindings/collector-live-release.json']) {
    await writeFile(join(f.root, path), '{}');
    assert.throws(() => f.api.requireCollectorLiveBindingAnchors());
    await f.reset();
  }
  const changed = structuredClone(f.manifest);
  changed.anchors[0].bindingDigest = digest({ rewritten: true });
  await writeFile(join(f.root, 'bindings/collector-live-release.json'), JSON.stringify(changed));
  assert.throws(() => f.api.requireCollectorLiveBindingAnchors(), /manifest/);
});

test('release authentication refuses absent approval and malformed anchor relationships', async t => {
  const f = await fixture(t);
  for (const mutate of [
    m => m.anchors.pop(),
    m => { m.anchors[1].stage = 'purchase'; },
    m => { m.anchors[1].ownerApprovalReceiptId = m.anchors[0].ownerApprovalReceiptId; },
    m => { m.anchors[0].bindingPath = '../outside.json'; },
    m => { m.anchors[0].extra = true; },
  ]) {
    const manifest = structuredClone(f.manifest); mutate(manifest);
    const active = JSON.parse(f.artifacts['architecture/interfaces.json']); active.bindingManifestDigest = digest(manifest);
    await writeFile(join(f.root, 'architecture/interfaces.json'), JSON.stringify(active));
    await writeFile(join(f.root, 'bindings/collector-live-release.json'), JSON.stringify(manifest));
    assert.throws(() => f.api.requireCollectorLiveBindingAnchors());
    await f.reset();
  }
});

function registryFor(entries) {
  return { schema: 'hookemon.collector-production-binding-registry.v1', version: 1,
    entries: entries.map(entry => ({ schema: 'hookemon.collector-production-binding-entry.v1', version: 1,
      authority: 'live', stage: entry.stage, provider: entry.provider, chainId: entry.chainId,
      expectedDigest: entry.bindingDigest, binding: entry.binding })) };
}

test('rewriting every release data file cannot replace the executable approval root', async t => {
  const first = await fixture(t);
  const replacement = await fixture(t, '-replacement');
  for (const [path, bytes] of Object.entries(replacement.artifacts)) await writeFile(join(first.root, path), bytes);
  assert.throws(() => first.api.requireCollectorLiveBindingAnchors(), /release authority/);
});

test('loaded registry retains the full release identity even when a new release binds identical transactions', async t => {
  const first = await fixture(t);
  const next = await fixture(t, '-next');
  const loadedFirst = first.registryApi.loadCollectorProductionBindingRegistry(registryFor(first.api.requireCollectorLiveBindingAnchors()));
  const loadedNext = next.registryApi.loadCollectorProductionBindingRegistry(registryFor(next.api.requireCollectorLiveBindingAnchors()));
  assert.equal(loadedFirst.entries[0].expectedDigest, loadedNext.entries[0].expectedDigest);
  assert.throws(() => next.registryApi.resolveCollectorProductionBinding({ registry: loadedFirst, authority: 'live', stage: 'purchase' }), /loaded release identity/);
  assert.ok(next.registryApi.resolveCollectorProductionBinding({ registry: loadedNext, authority: 'live', stage: 'purchase' }));
});

test('an authenticated live release cannot run inside a synthetic child context', async t => {
  const f = await fixture(t);
  const registry = f.registryApi.loadCollectorProductionBindingRegistry(registryFor(f.api.requireCollectorLiveBindingAnchors()));
  assert.throws(() => f.registryApi.resolveCollectorProductionBinding({ registry, authority: 'live', stage: 'purchase',
    config: { signer: { keychain: { isolatedChildSetup: {} } } } }), /synthetic isolated child/);
});
