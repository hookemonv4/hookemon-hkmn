import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import vm from 'node:vm';

import { DECISION_TYPES } from '../../src/contracts/operator-contracts.mjs';

function browserHarness({ session, requests, nextRequestId, response = undefined }) {
  const elements = new Map();
  function element() {
    const listeners = new Map();
    return {
      value: '',
      textContent: '',
      hidden: true,
      className: '',
      addEventListener(type, listener) { listeners.set(type, listener); },
      trigger(type) { listeners.get(type)?.(); },
      replaceChildren() {},
      appendChild() {},
      append() {},
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
        requests.push(JSON.parse(options.body));
        if (response !== undefined) return response();
        throw new Error('lost response');
      },
    },
    click(id) { elements.get(id).trigger('click'); },
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
