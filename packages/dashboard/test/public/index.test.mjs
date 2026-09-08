import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';

import { DECISION_TYPES } from '../../src/contracts/operator-contracts.mjs';

function browserHarness({ session, requests, nextRequestId, response = undefined, get = undefined }) {
  const elements = new Map();
  function element() {
    const listeners = new Map();
    return {
      value: '',
      textContent: '',
      hidden: true,
      className: '',
      children: [],
      checked: false,
      disabled: false,
      addEventListener(type, listener) { listeners.set(type, listener); },
      trigger(type) { listeners.get(type)?.(); },
      replaceChildren(...children) { this.children = children; },
      appendChild(child) { this.children.push(child); },
      append(...children) { this.children.push(...children); },
    };
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement() { return element(); },
  };
  return {
    context: {
      document,
      crypto: { randomUUID: nextRequestId },
      sessionStorage: {
        getItem(key) { return session.get(key) ?? null; },
        setItem(key, value) { session.set(key, String(value)); },
        removeItem(key) { session.delete(key); },
      },
      fetch: async (_path, options) => {
        if (!options.body && get) return { ok: true, text: async () => JSON.stringify(await get(_path)) };
        requests.push(JSON.parse(options.body));
        if (response !== undefined) return response();
        throw new Error('lost response');
      },
    },
    click(id) { elements.get(id).trigger('click'); },
    element(id) { return elements.get(id); },
  };
}

async function settlePage() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

test('owner page shows only controls backed by the operator authority', async () => {
  const html = await readFile(join(process.cwd(), 'packages/dashboard/src/public/index.html'), 'utf8');
  for (const id of [
    'pauseBtn', 'resumeBtn', 'killBtn', 'manualApprovalBtn',
    'heldDecisionCycleId', 'heldDecisionEvidenceDigest', 'heldDecisionRevision',
    'recordSellDecisionBtn', 'recordKeepHoldingDecisionBtn',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const section of ['networkBadge', 'cycleList', 'claimCapacity', 'custodyBuckets', 'approvalQueue', 'epicHeld', 'alertFeed', 'payoutStatus', 'walletIdentities']) {
    assert.match(html, new RegExp(`id="${section}"`));
  }
  for (const staleControl of ['runNowBtn', 'reconcileBtn', 'resumeCycleBtn', 'saveConfigBtn', 'sellEpicBtn', 'keepEpicBtn']) {
    assert.doesNotMatch(html, new RegExp(staleControl));
  }
  const commandTypes = [...html.matchAll(/dispatch\(\{ type: '([^']+)'/g)].map(match => match[1]).sort();
  assert.deepEqual(commandTypes, ['held-owner-decision', 'kill', 'manual-approval', 'pause', 'resume']);
  assert.ok(commandTypes.every(type => DECISION_TYPES.includes(type)));
  assert.match(html, /does not sell a card/);
  for (const label of ['Claimed', 'Bridged out', 'Bridged in', 'Pack cost', 'Buyback proceeds', 'Returned', 'Payout waiting', 'Dust', 'Held cards']) {
    assert.match(html, new RegExp(`'${label}'`));
  }
  assert.match(html, /min-height:\s*44px/);
  assert.match(html, /max-width:\s*1280px/);
});

test('owner page retains one request ID after a lost response, double-click, and reload', async () => {
  const html = await readFile(join(process.cwd(), 'packages/dashboard/src/public/index.html'), 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'owner page must include its control script');
  const session = new Map();
  const requests = [];
  let generated = 0;
  const nextRequestId = () => `request-${++generated}`;

  const firstPage = browserHarness({ session, requests, nextRequestId });
  vm.runInNewContext(script, firstPage.context);
  firstPage.click('pauseBtn');
  firstPage.click('pauseBtn');
  await settlePage();

  const reloadedPage = browserHarness({ session, requests, nextRequestId });
  vm.runInNewContext(script, reloadedPage.context);
  reloadedPage.click('pauseBtn');
  await settlePage();

  assert.equal(requests.length, 3);
  assert.deepEqual(requests.map(request => request.requestId), ['request-1', 'request-1', 'request-1']);
});

test('owner page retains an uncertain request ID until its effect is reconciled', async () => {
  const html = await readFile(join(process.cwd(), 'packages/dashboard/src/public/index.html'), 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'owner page must include its control script');
  const session = new Map();
  const requests = [];
  let generated = 0;
  const nextRequestId = () => `request-${++generated}`;
  const uncertain = () => ({
    ok: false,
    text: async () => JSON.stringify({ code: 'COMMAND_UNCERTAIN', commandState: 'UNCERTAIN' }),
  });

  const firstPage = browserHarness({ session, requests, nextRequestId, response: uncertain });
  vm.runInNewContext(script, firstPage.context);
  firstPage.click('pauseBtn');
  await settlePage();

  const reloadedPage = browserHarness({ session, requests, nextRequestId, response: uncertain });
  vm.runInNewContext(script, reloadedPage.context);
  reloadedPage.click('pauseBtn');
  await settlePage();

  assert.deepEqual(requests.map(request => request.requestId), ['request-1', 'request-1']);
});

async function packPage({ catalog, selected = ['old-pack'], quantities = {}, allowed = selected, legacy = false, response } = {}) {
  const html = await readFile('packages/dashboard/src/public/index.html', 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
  const requests = [];
  let saved = selected.map(pack => ({ pack, quantity: quantities[pack] ?? 1 }));
  let allowedIds = allowed;
  let revision = 7;
  let generated = 0;
  const page = browserHarness({
    session: new Map(), requests, nextRequestId: () => `pack-selection-${++generated}`,
    async get(path) {
      if (path.endsWith('/bootstrap')) return { state: { version: revision, allowedPackIds: allowedIds, ...(legacy ? {} : { packPlan: { schema: 'hookemon.pack-plan.v1', revision, orders: saved } }) } };
      if (path.endsWith('/packs')) {
        if (catalog instanceof Error) throw catalog;
        return typeof catalog === 'function' ? catalog() : catalog;
      }
      if (path.endsWith('/network')) return { profile: 'testnet' };
      return {};
    },
    response: response ?? (() => {
      saved = requests.at(-1).command.configuration.packPlan.orders;
      allowedIds = requests.at(-1).command.configuration.allowedPackIds;
      revision += 1;
      return { ok: true, text: async () => JSON.stringify({ commandState: 'APPLIED' }) };
    }),
  });
  vm.runInNewContext(script, page.context);
  page.click('loadBtn');
  await settlePage();
  return { page, requests };
}

test('pack selection lists the catalog and saves sorted plan orders without shrinking permissions', async () => {
  const { page, requests } = await packPage({ catalog: { configured: true, machines: [
    { code: 'zz-pack', name: '<script>untrusted</script>' }, { code: 'aa-pack', name: 'Alpha' },
    { code: 'aa-pack', name: 'Alpha' }, { code: null },
  ] } });
  assert.equal(requests.length, 0, 'loading must never mutate configuration');
  const rows = page.element('packList').children;
  assert.equal(rows.length, 3);
  assert.match(rows[1].children[1].textContent, /Not in current catalog/);
  assert.equal(rows[2].children[1].textContent, '<script>untrusted</script> · zz-pack');
  page.click('selectAllPacksBtn');
  page.click('savePacksBtn');
  page.click('savePacksBtn');
  await settlePage();
  assert.equal(requests.length, 1, 'double click must not create another request');
  assert.deepEqual(requests[0], {
    requestId: 'pack-selection-1', expectedVersion: 7,
    command: { type: 'update-configuration', configuration: { allowedPackIds: ['aa-pack', 'old-pack', 'zz-pack'], packPlan: { orders: [{ pack: 'aa-pack', quantity: 1 }, { pack: 'old-pack', quantity: 1 }, { pack: 'zz-pack', quantity: 1 }] } } },
  });
  assert.equal(page.element('packMessage').textContent, 'Pack plan saved.');
  assert.equal(page.element('savePacksBtn').disabled, true);
  page.click('clearPacksBtn');
  page.click('savePacksBtn');
  await settlePage();
  assert.deepEqual(requests[1].command.configuration.allowedPackIds, ['aa-pack', 'old-pack', 'zz-pack']);
  assert.deepEqual(requests[1].command.configuration.packPlan.orders, []);
  assert.equal(requests[1].expectedVersion, 8);
  assert.notEqual(requests[0].requestId, requests[1].requestId);
});

test('missing or failed catalog disables pack saves without hiding the rest of the dashboard', async () => {
  for (const catalog of [{ configured: false, machines: [] }, new Error('PACK_CATALOG_UNAVAILABLE')]) {
    const { page, requests } = await packPage({ catalog });
    assert.equal(page.element('dashboard').hidden, false);
    assert.equal(page.element('packList').children[0].children[0].checked, true);
    assert.equal(page.element('savePacksBtn').disabled, true);
    page.click('clearPacksBtn'); page.click('savePacksBtn');
    await settlePage();
    assert.equal(requests.length, 0);
  }
});

test('pack save reports authority rejection and retries uncertain writes with the same identity', async () => {
  for (const state of ['REJECTED', 'UNCERTAIN']) {
    const { page, requests } = await packPage({
      catalog: { configured: true, machines: [{ code: 'aa-pack' }] },
      response: () => ({ ok: false, text: async () => JSON.stringify({ code: 'AUTHORITY_REFUSAL', commandState: state }) }),
    });
    page.click('selectAllPacksBtn'); page.click('savePacksBtn'); await settlePage();
    assert.equal(page.element('packMessage').textContent, 'AUTHORITY_REFUSAL');
    assert.equal(page.element('savePacksBtn').disabled, false);
    page.click('savePacksBtn'); await settlePage();
    assert.equal(requests[0].expectedVersion, 7);
    assert.equal(requests[1].expectedVersion, 7);
    if (state === 'UNCERTAIN') assert.equal(requests[0].requestId, requests[1].requestId);
    else assert.notEqual(requests[0].requestId, requests[1].requestId);
  }
});

test('pack loading and saving are serialized across delayed catalog responses', async () => {
  const catalog = { configured: true, machines: [{ code: 'aa-pack' }] };
  let catalogCalls = 0;
  let release;
  const delayed = new Promise(resolve => { release = resolve; });
  const { page, requests } = await packPage({ catalog: () => ++catalogCalls === 1 ? catalog : delayed });
  page.click('selectAllPacksBtn');
  page.click('loadBtn');
  await settlePage();
  page.click('loadBtn'); page.click('savePacksBtn');
  await settlePage();
  assert.equal(catalogCalls, 2, 'only one reload may be in flight');
  assert.equal(requests.length, 0, 'saving cannot race a pending reload');
  release(catalog);
  await settlePage();
  page.click('selectAllPacksBtn'); page.click('savePacksBtn');
  await settlePage();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].expectedVersion, 7);
});


test('plan selection preserves quantities and keeps previously allowed active-cycle packs', async () => {
  const { page, requests } = await packPage({
    catalog: { configured: true, machines: [{ code: 'aa-pack' }, { code: 'old-pack' }, { code: 'active-pack' }] },
    quantities: { 'old-pack': 3 }, allowed: ['active-pack', 'old-pack'],
  });
  const rows = page.element('packList').children;
  assert.equal(rows[1].children[0].checked, false, 'allowlist membership is not plan selection');
  assert.match(rows[2].children[1].textContent, /Quantity 3/);
  rows[0].children[0].checked = true;
  rows[0].children[0].trigger('change');
  page.click('savePacksBtn');
  await settlePage();
  assert.deepEqual(requests[0].command.configuration, {
    packPlan: { orders: [{ pack: 'aa-pack', quantity: 1 }, { pack: 'old-pack', quantity: 3 }] },
    allowedPackIds: ['aa-pack', 'active-pack', 'old-pack'],
  });
  assert.equal(page.element('packMessage').textContent, 'Pack plan saved.');
  page.click('loadBtn');
  await settlePage();
  assert.equal(page.element('packList').children[1].children[0].checked, false);
  assert.match(page.element('packList').children[2].children[1].textContent, /Quantity 3/);
});

test('legacy bootstrap cannot turn the safety allowlist into a new plan implicitly', async () => {
  const { page, requests } = await packPage({ catalog: { configured: true, machines: [{ code: 'old-pack' }] }, legacy: true });
  assert.equal(page.element('packList').children[0].children[0].checked, false);
  page.click('selectAllPacksBtn');
  assert.equal(page.element('savePacksBtn').disabled, true);
  page.click('savePacksBtn');
  assert.equal(requests.length, 0);
});
