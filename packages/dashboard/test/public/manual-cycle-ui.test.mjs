import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';

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


const html = await readFile('packages/dashboard/src/public/index.html', 'utf8');
const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)[1];
const readiness = () => ({ schemaVersion: 1, ready: true, reasons: [], executionMode: 'manual',
  plan: { packCode: 'pokemon_25', quantity: 1, packPriceMicroUsd: '25000000', recipientLimit: 100, fundingSource: 'existing-wallet', recipientTokenAddress: '0xC60bA256B44334A0Cd2C7242E98B88f031abB006', chainId: 4663 }, request: null });
async function manualPage({ state = readiness(), session = new Map(), requests = [], response, nextRequestId = () => 'one-cycle' } = {}) {
  const page = browserHarness({ session, requests, nextRequestId, response,
    async get(path) {
      if (path.endsWith('/bootstrap')) return { state: { version: 7, allowedPackIds: [], packPlan: { orders: [] } } };
      if (path.endsWith('/manual-cycle')) {
        if (state instanceof Error) throw state;
        return typeof state === 'function' ? state() : state;
      }
      return {};
    }
  });
  vm.runInNewContext(script, page.context);
  assert.equal(page.element('startManualCycleBtn').disabled, true);
  page.click('loadBtn'); await settlePage();
  return { page, session, requests };
}

test('one-cycle start requires explicit mainnet readiness, exact plan, and recipient address', async () => {
  for (const change of [s => { s.ready = false; s.reasons = ['OPERATOR_NOT_CONFIGURED']; }, s => { s.reasons = ['EXECUTION_PAUSED']; }, s => { s.executionMode = 'unavailable'; },
    s => { s.plan.recipientTokenAddress = null; }, s => { s.plan.quantity = 2; }, s => { s.plan.chainId = 1; },
    s => { s.plan.fundingSource = 'hook-claim'; }, s => { s.plan.recipientLimit = 200; }, s => { s.plan.packCode = 'pokemon_50'; }, s => { s.plan.packPriceMicroUsd = '50000000'; }]) {
    const state = readiness(); change(state);
    const { page, requests } = await manualPage({ state });
    assert.equal(page.element('startManualCycleBtn').disabled, true);
    page.click('startManualCycleBtn'); await settlePage(); assert.equal(requests.length, 0);
  }
  const { page } = await manualPage();
  assert.equal(page.element('startManualCycleBtn').disabled, false);
  assert.match(page.element('manualCyclePlan').textContent, /Top 100.*0xC60bA256/);
});

test('unavailable or malformed endpoint fails closed and preserves dashboard access', async () => {
  for (const state of [new Error('NOT_FOUND'), {}, null]) {
    const { page, requests } = await manualPage({ state });
    assert.equal(page.element('startManualCycleBtn').disabled, true);
    assert.equal(page.element('dashboard').hidden, false);
    assert.match(page.element('manualCycleMessage').textContent, /Unavailable/);
    assert.equal(requests.length, 0);
  }
});

test('lost POST response, double click, refresh and reload retain the original unresolved intent', async () => {
  const { page, session, requests } = await manualPage();
  page.click('startManualCycleBtn'); page.click('startManualCycleBtn'); await settlePage();
  assert.deepEqual(requests, [{ requestId: 'one-cycle', expectedRevision: 7 }]);
  assert.match(page.element('manualCycleMessage').textContent, /not confirmed/);
  page.click('refreshManualCycleBtn'); await settlePage();
  assert.equal(page.element('startManualCycleBtn').disabled, true);
  const reloaded = await manualPage({ session, requests, nextRequestId: () => { throw new Error('must not create another intent'); } });
  reloaded.page.click('startManualCycleBtn'); await settlePage();
  assert.equal(requests.length, 1);
  assert.equal(JSON.parse(session.values().next().value)['manual-mainnet-cycle'].requestId, 'one-cycle');
});

test('accepted cycle stays unresolved until matching authoritative terminal status', async () => {
  let state = readiness();
  const { page, session } = await manualPage({ state: () => state, response: async () => {
    state = { ...readiness(), ready: false, request: { requestId: 'one-cycle', status: 'accepted', cycleId: 'cycle-1', resultCode: null } };
    return { ok: true, text: async () => JSON.stringify(state) };
  } });
  page.click('startManualCycleBtn'); await settlePage();
  assert.match(page.element('manualCycleMessage').textContent, /accepted.*Acceptance does not confirm/);
  assert.equal(page.element('startManualCycleBtn').disabled, true);
  state.request = { ...state.request, requestId: 'another-request', status: 'completed' };
  page.click('refreshManualCycleBtn'); await settlePage();
  assert.ok(JSON.parse(session.values().next().value)['manual-mainnet-cycle']);
  state.request = { ...state.request, requestId: 'one-cycle', status: 'completed' };
  page.click('refreshManualCycleBtn'); await settlePage();
  assert.equal(JSON.parse(session.values().next().value)['manual-mainnet-cycle'], undefined);
  assert.match(page.element('manualCycleMessage').textContent, /completed/);
  assert.equal(page.element('startManualCycleBtn').disabled, true);
});

for (const code of ['MANUAL_NOT_READY', 'STALE_REVISION', 'COMMAND_UNCERTAIN']) test(`manual POST ${code} clears intent only for proven no admission`, async () => {
  const { page, session } = await manualPage({ response: async () => ({ ok: false, status: 409,
    text: async () => JSON.stringify({ code, request: null }) }) });
  page.click('startManualCycleBtn'); await settlePage();
  const pending = JSON.parse(session.values().next().value)['manual-mainnet-cycle'];
  assert.equal(Boolean(pending), code === 'COMMAND_UNCERTAIN');
  assert.equal(page.element('startManualCycleBtn').disabled, true, 'fresh readiness is required before retry');
});

for (const finalized of [false, true]) test(`holder snapshot displays exact balances and ${finalized ? 'finalized' : 'preview'} status without payout claims`, async () => {
  const state = readiness();
  state.holderSnapshot = { status: 'verified', finalized, tokenAddress: state.plan.recipientTokenAddress, blockNumber: '77', blockHash: '0x123',
    observedAt: '2026-09-11T00:00:00Z', reasons: [], recipients: [{ rank: 1, address: '<unsafe-markup>', balanceAtomic: '999999999999999999999999', sharePercent: '12.3456' }] };
  const { page } = await manualPage({ state });
  assert.match(page.element('manualHolderMessage').textContent, finalized ? /Verified finalized/ : /Preview only/);
  assert.match(page.element('manualHolderMessage').textContent, /not payout results/);
  const row = page.element('manualHolderTable').children[0].children[2].children[0];
  assert.deepEqual(row.children.map(cell => cell.textContent), ['1', '<unsafe-markup>', '999999999999999999999999', '12.3456']);
});

test('unavailable or mismatched holder data never appears as recipient evidence', async () => {
  for (const holderSnapshot of [undefined, { status: 'unavailable', recipients: [] }, { status: 'verified', tokenAddress: 'another-token', recipients: [] }]) {
    const { page } = await manualPage({ state: { ...readiness(), holderSnapshot } });
    assert.equal(page.element('manualHolderMessage').textContent, 'Holder snapshot not available.');
    assert.equal(page.element('manualHolderTable').children.length, 0);
  }
});

test('readiness explains missing live funding and payout binding without claiming readiness', async () => {
  const state = { ...readiness(), ready: false, reasons: ['DIRECT_WALLET_FUNDING_NOT_IMPLEMENTED', 'EXTERNAL_TOKEN_RECIPIENT_BINDING_UNAVAILABLE'] };
  const { page } = await manualPage({ state });
  assert.match(page.element('manualCycleMessage').textContent, /Existing-wallet funding is not connected/);
  assert.match(page.element('manualCycleMessage').textContent, /holder snapshot is not connected to payouts/);
  assert.equal(page.element('startManualCycleBtn').disabled, true);
});

test('manual cycle accepts selected V4 token case-insensitively and rejects another valid coin', async () => {
  for (const address of ['0xc60ba256b44334a0cd2c7242e98b88f031abb006', '0x' + '1'.repeat(40)]) {
    const state = readiness(); state.plan.recipientTokenAddress = address;
    const { page, requests } = await manualPage({ state });
    const wrongCoin = address.endsWith('1111');
    assert.equal(page.element('startManualCycleBtn').disabled, wrongCoin);
    if (wrongCoin) { page.click('startManualCycleBtn'); await settlePage(); assert.equal(requests.length, 0); }
  }
});

for (const [decimals, atomic, expected] of [
  [18, '12345678901234567890123456', '12345678.901234567890123456'],
  [18, '1', '0.000000000000000001'], [18, '1000000000000000000', '1'],
  [0, '999999999999999999999999', '999999999999999999999999'], [36, '1', '0.' + '0'.repeat(35) + '1'],
  [18, '0', '0'], [18, '0001000000000000000000', '1'],
  [undefined, '1000000000000000000', '1000000000000000000'],
  [-1, '1000000000000000000', '1000000000000000000'], [37, '1000000000000000000', '1000000000000000000'],
  ['18', '1000000000000000000', '1000000000000000000'], [1.5, '1000', '1000']
]) test(`holder display formats exact balance with decimals=${decimals} atomic=${atomic}`, async () => {
  const state = readiness();
  state.holderSnapshot = { status: 'preview', tokenAddress: state.plan.recipientTokenAddress, tokenDecimals: decimals,
    recipients: [{ rank: 1, address: 'holder', balanceAtomic: atomic, sharePercent: '1' }] };
  const { page } = await manualPage({ state });
  const table = page.element('manualHolderTable').children[0];
  const cell = table.children[2].children[0].children[2];
  assert.equal(cell.textContent, expected);
  assert.equal(cell.title, atomic + ' atomic token units');
  const validDecimals = Number.isInteger(decimals) && decimals >= 0 && decimals <= 36;
  assert.equal(table.children[1].children[0].children[2].textContent, validDecimals ? 'Balance (V4)' : 'Balance (atomic)');
});
