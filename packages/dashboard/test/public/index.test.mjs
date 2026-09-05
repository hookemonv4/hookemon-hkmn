import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';

import { DECISION_TYPES } from '../../src/contracts/operator-contracts.mjs';

function browserHarness({ session, requests, nextRequestId, response = undefined, getResponse = undefined }) {
  const elements = new Map();
  const created = [];
  function register(node) {
    if (node?.id) elements.set(node.id, node);
  }
  function element(tagName = 'div') {
    const listeners = new Map();
    return {
      tagName,
      value: '',
      textContent: '',
      hidden: true,
      className: '',
      children: [],
      addEventListener(type, listener) { listeners.set(type, listener); },
      trigger(type) { return listeners.get(type)?.(); },
      replaceChildren(...children) { this.children = children; children.forEach(register); },
      appendChild(child) { this.children.push(child); register(child); return child; },
      append(...children) { children.forEach(child => this.appendChild(child)); },
    };
  }
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, element());
      return elements.get(id);
    },
    createElement(tagName) { const node = element(tagName); created.push(node); return node; },
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
      fetch: async (path, options = {}) => {
        if (options.method === 'POST') {
          requests.push(JSON.parse(options.body));
          if (response !== undefined) return response();
          throw new Error('lost response');
        }
        if (getResponse !== undefined) return getResponse(path, options);
        throw new Error('lost response');
      },
    },
    click(id) { return elements.get(id).trigger('click'); },
    clickElement(node) { return node.trigger('click'); },
    setValue(id, value) { document.getElementById(id).value = value; },
    buttons(text) { return created.filter(node => node.tagName === 'button' && node.textContent === text); },
    nodes(text) { return created.filter(node => node.textContent === text); },
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
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  for (const section of ['networkBadge', 'cycleList', 'claimCapacity', 'custodyBuckets', 'approvalQueue', 'heldPositionLimits', 'heldPositions', 'alertFeed', 'payoutStatus', 'walletIdentities']) {
    assert.match(html, new RegExp(`id="${section}"`));
  }
  for (const staleControl of [
    'runNowBtn', 'reconcileBtn', 'resumeCycleBtn', 'saveConfigBtn', 'sellEpicBtn', 'keepEpicBtn',
    'heldDecisionPositionId', 'heldDecisionEvidenceDigest', 'heldDecisionPositionRevision',
    'recordSellDecisionBtn', 'recordKeepHoldingDecisionBtn',
  ]) {
    assert.doesNotMatch(html, new RegExp(staleControl));
  }
  const commandTypes = [...html.matchAll(/dispatch\(\{ type: '([^']+)'/g)].map(match => match[1]).sort();
  assert.deepEqual(commandTypes, ['held-owner-decision', 'kill', 'manual-approval', 'pause', 'resume']);
  assert.ok(commandTypes.every(type => DECISION_TYPES.includes(type)));
  assert.match(html, /starts a supplementary settlement/);
  assert.doesNotMatch(html, /does not start settlement or payout today/);
  assert.match(html, /Held-position custody is unavailable/);
  assert.match(html, /'Limit value': position\.valueMicroUsdg/);
  for (const label of ['Claimed', 'Bridged out', 'Bridged in', 'Pack cost', 'Buyback proceeds', 'Returned', 'Payout waiting', 'Dust', 'Held cards']) {
    assert.match(html, new RegExp(`'${label}'`));
  }
  assert.match(html, /min-height:\s*44px/);
  assert.match(html, /max-width:\s*1280px/);
});

test('owner page binds sell and keep-holding controls to each held position', async () => {
  const html = await readFile(join(process.cwd(), 'packages/dashboard/src/public/index.html'), 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'owner page must include its control script');
  const requests = [];
  const response = body => ({ ok: true, text: async () => JSON.stringify(body) });
  const heldPositions = [
    {
      positionId: 'position-one', cycleId: 'cycle-one', reason: 'EPIC_THRESHOLD', openedAtMs: 0,
      ageSeconds: 1, insuredValue: null, costMicroUsdg: '100', valueMicroUsdg: '400',
      evidenceDigest: `sha256:${'a'.repeat(64)}`, ownerDecision: null, terminalState: 'HELD_OWNER_DECISION', positionRevision: 4,
    },
    {
      positionId: 'position-two', cycleId: 'cycle-two', reason: 'DATA_UNVERIFIED', openedAtMs: 0,
      ageSeconds: 2, insuredValue: null, costMicroUsdg: '200', valueMicroUsdg: '500',
      evidenceDigest: `sha256:${'b'.repeat(64)}`, ownerDecision: null, terminalState: 'HELD_DATA_UNVERIFIED', positionRevision: 7,
    },
  ];
  const page = browserHarness({
    session: new Map(),
    requests,
    nextRequestId: () => 'held-request',
    response: () => ({ ok: false, text: async () => JSON.stringify({ code: 'COMMAND_UNCERTAIN', commandState: 'UNCERTAIN' }) }),
    getResponse(path) {
      if (path === '/operator/api/bootstrap') return response({ state: { version: 3, unresolvedCardDeadlineMinutes: 30 } });
      if (path === '/operator/api/dashboard') return response({
        cycles: [],
        cap: { heldPositions: { count: 2, maxCount: 10, valueMicroUsdg: '900', maxValueMicroUsdg: '5000000000' } },
        custody: { buckets: [] },
        heldPositions,
        alerts: [],
        alertSources: { safetyTelemetry: true },
      });
      if (path === '/operator/api/identities') return response({ identities: null });
      if (path === '/operator/api/network') return response({ profile: 'mainnet' });
      throw new Error(`unexpected request: ${path}`);
    },
  });
  vm.runInNewContext(script, page.context);
  await page.click('loadBtn');
  await settlePage();

  const sellButtons = page.buttons('Sell and start supplementary settlement');
  const keepButtons = page.buttons('Keep holding');
  assert.equal(sellButtons.length, 2);
  assert.equal(keepButtons.length, 2);
  assert.ok(page.nodes('400 micro-USDG').length > 0);
  assert.ok(page.nodes('900 of 5000000000 micro-USDG').length > 0);

  await page.clickElement(sellButtons[0]);
  await settlePage();
  await page.clickElement(keepButtons[1]);
  await settlePage();

  assert.deepEqual(requests[0].command, {
    type: 'held-owner-decision',
    positionId: 'position-one',
    heldEvidenceDigest: `sha256:${'a'.repeat(64)}`,
    expectedPositionRevision: 4,
    choice: 'sell',
  });
  assert.deepEqual(requests[1].command, {
    type: 'held-owner-decision',
    positionId: 'position-two',
    heldEvidenceDigest: `sha256:${'b'.repeat(64)}`,
    expectedPositionRevision: 7,
    choice: 'keep-holding',
  });
});

test('owner page labels unavailable held custody instead of treating it as an empty position list', async () => {
  const html = await readFile(join(process.cwd(), 'packages/dashboard/src/public/index.html'), 'utf8');
  const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'owner page must include its control script');
  const response = body => ({ ok: true, text: async () => JSON.stringify(body) });
  const page = browserHarness({
    session: new Map(),
    requests: [],
    nextRequestId: () => 'unused',
    getResponse(path) {
      if (path === '/operator/api/bootstrap') return response({ state: { version: 3, unresolvedCardDeadlineMinutes: 30 } });
      if (path === '/operator/api/dashboard') return response({
        cycles: [], cap: { heldPositions: null }, custody: { buckets: [] }, heldPositions: [], alerts: [],
        alertSources: { safetyTelemetry: false },
      });
      if (path === '/operator/api/identities') return response({ identities: null });
      if (path === '/operator/api/network') return response({ profile: 'mainnet' });
      throw new Error(`unexpected request: ${path}`);
    },
  });

  vm.runInNewContext(script, page.context);
  await page.click('loadBtn');
  await settlePage();

  assert.equal(page.nodes('Held-position custody is unavailable; limit usage cannot be verified.').length, 1);
  assert.equal(page.nodes('No held positions are reported.').length, 0);
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
