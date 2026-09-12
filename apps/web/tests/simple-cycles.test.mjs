import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import {
  formatEth, formatUsdc, readSimpleCyclesFeed, renderSimpleCycleRecord, renderSimpleCycles,
  simpleCycleRecord, simpleCyclesPresentation, startSimpleCycles,
} from '../public/comic-production/simple-cycles.mjs';

const publishedFeed = JSON.parse(await readFile(new URL('../public/comic-production/simple-cycles.json', import.meta.url), 'utf8'));

function fixture() {
  return {
    schema: 'hookemon-simple-cycles/1',
    generatedAt: '2026-09-12T13:35:30.328Z',
    wallet: { observedAt: '2026-09-12T13:35:30.328Z', usdcSolana: 129.711608, ethRobinhood: 0.0193694 },
    cycles: [
      {
        cycleId: 'mtyenuiz', startedAt: '2026-09-12T13:12:55.115Z', purchasedAt: '2026-09-12T13:24:12.329Z',
        completedAt: '2026-09-12T13:25:49.029Z', packType: 'pokemon_25', packPriceUsdc: 25,
        cards: [{ mint: '6y9RbkCEpdn4KfHjZcoUdx5Sw55SjDyitqbE4BQnBefZ', name: '2015 #155 Full Art/Gardevoir EX', image: 'https://arweave.net/en24WPkfvw3xBootUZt6cRWV68QFbSlA-j1o6RLzKq8' }],
        saleUsdc: 79.9, receivedEth: 0.03136634664445922, holdersSnapshot: 100, holdersPaid: 100, holdersReverted: 0,
        paidEth: 0.03136634664445917, averagePayoutEth: 0.0003136634664445917,
        purchaseSignature: '5L9qwHrdnraiTNYpqjkrX4mRweS4XPWyMd76jhRUnhoK2Xxvei26nRaT2SpdeUMQnhFYKsjaVWvMyaho8xWcbotY',
        returnTxHash: '0xde3a0d88d7aa663bd8e0b0d6df733d90e8d53f30a1db43038bd21cfc8e8bef77',
      },
      {
        cycleId: 'mtyefesm', startedAt: '2026-09-12T13:06:21.479Z', purchasedAt: '2026-09-12T13:08:45.143Z',
        completedAt: '2026-09-12T13:12:31.538Z', packType: 'pokemon_25', packPriceUsdc: 25,
        cards: [{ mint: '6vmfstTJ2AFZcEvoyJwu7qVH2seW9Hz2Q37D4rfmUCGX', name: '2026 #30 Mega Charizard Y Ex CGC', image: null }],
        saleUsdc: 29.75, receivedEth: 0.011669367642358524, holdersSnapshot: 100, holdersPaid: 48, holdersReverted: 28,
        paidEth: 0.00719865882194158, averagePayoutEth: 0.0001499720587904496,
        purchaseSignature: null, returnTxHash: null,
      },
    ],
  };
}

function fakeDocument() {
  const nodes = new Map();
  const make = (tag) => {
    const node = {
      tag, textContent: '', children: [], dataset: {}, attributes: {}, hidden: false, className: '',
      append(...items) { node.children.push(...items); },
      replaceChildren() { node.children = []; },
      setAttribute(name, value) { node.attributes[name] = value; },
      querySelector(selector) { return node.children.find((child) => child.className === selector.slice(1)) ?? null; },
    };
    return node;
  };
  const withId = (id, tag = 'div') => { const node = make(tag); node.id = id; nodes.set(id, node); return node; };
  for (const id of ['dashboardStatus', 'headerCycleState', 'headerCountdown', 'navCountdown', 'navCycle', 'metricCountdown', 'metricCountdownNote',
    'metricPool', 'metricPoolNote', 'metricPaid', 'metricPaidNote', 'metricAverage', 'metricAverageNote', 'metricRecipients', 'metricTotalPaid',
    'metricCompletedCycles', 'metricSkippedCycles', 'metricPacks', 'metricCards', 'latestCards', 'cycleHistoryStatus', 'cycleHistoryList', 'cycleHistoryMore',
    'cycleFeedState', 'recordPool', 'recordPaid', 'recordCount', 'recordHistory', 'recordTitle', 'recordStatus', 'recordBreakdown', 'recordTransactions']) withId(id);
  const historyNotes = [make('p'), make('p')];
  const steps = ['fees', 'budget', 'packs', 'cards', 'sales', 'return', 'holders'].map((step) => {
    const node = make('div'); node.dataset.step = step;
    const amount = make('span'); amount.className = 's'; const label = make('span'); label.className = 'w';
    node.children.push(amount, label); return node;
  });
  return {
    getElementById: (id) => nodes.get(id) ?? null,
    querySelectorAll: (selector) => selector === '[data-history-note]' ? historyNotes : selector === '[data-step]' ? steps : [],
    createElement: (tag) => make(tag),
    steps, historyNotes, nodes,
  };
}

test('the published feed is well formed and newest-first', () => {
  const feed = readSimpleCyclesFeed(publishedFeed);
  assert.ok(feed, 'the committed feed must validate');
  assert.ok(feed.cycles.length >= 2);
  for (let index = 1; index < feed.cycles.length; index += 1) {
    assert.ok(Date.parse(feed.cycles[index - 1].purchasedAt) >= Date.parse(feed.cycles[index].purchasedAt));
  }
  for (const cycle of feed.cycles) {
    assert.ok(cycle.cards.length >= 1);
    assert.ok(cycle.cards.every((card) => card.name));
    assert.ok(cycle.holdersPaid > 0);
  }
});

test('malformed or empty feeds are rejected, never rendered', () => {
  assert.equal(readSimpleCyclesFeed(null), null);
  assert.equal(readSimpleCyclesFeed({ ...fixture(), schema: 'other' }), null);
  assert.equal(readSimpleCyclesFeed({ ...fixture(), cycles: [] }), null);
  const negative = fixture(); negative.cycles[0].paidEth = -1;
  assert.equal(readSimpleCyclesFeed(negative), null);
  const badCard = fixture(); badCard.cycles[0].cards[0].mint = 'not-a-mint';
  assert.equal(readSimpleCyclesFeed(badCard), null);
  const httpImage = fixture(); httpImage.cycles[0].cards[0].image = 'http://images.example/card.png';
  assert.equal(readSimpleCyclesFeed(httpImage).cycles[0].cards[0].image, null);
  const noWallet = fixture(); delete noWallet.wallet;
  assert.equal(readSimpleCyclesFeed(noWallet).wallet, null);
});

test('amounts are formatted for people, not machines', () => {
  assert.equal(formatEth(0.03136634664445917), '0.031366 ETH');
  assert.equal(formatEth(0.0003136634664445917), '0.000314 ETH');
  assert.equal(formatEth(1.5), '1.5 ETH');
  assert.equal(formatEth(0), '0 ETH');
  assert.equal(formatUsdc(79.9), '79.90 USDC');
  assert.equal(formatEth('x'), '—');
});

test('the presentation reports the latest cycle, the totals and the average per holder', () => {
  const view = simpleCyclesPresentation(readSimpleCyclesFeed(fixture()));
  assert.equal(view.paid, '0.031366 ETH');
  assert.equal(view.average, '0.000314 ETH');
  assert.equal(view.recipients, '100');
  assert.equal(view.totalPaid, '0.038565 ETH');
  assert.equal(view.completedCycles, '2');
  assert.equal(view.openedPacks, '2');
  assert.equal(view.skippedCycles, '0');
  assert.equal(view.pool, '129.71 USDC');
  assert.equal(view.countdown, '--:--');
  assert.equal(view.steps.sales.amount, '79.90 USDC');
  assert.equal(view.steps.return.amount, '0.031366 ETH');
  assert.equal(view.steps.holders.amount, '100 paid');
  assert.ok(Object.values(view.steps).every((step) => step.state === 'complete'));
  assert.equal(view.cards.length, 2);
  assert.equal(view.cards[0].label, '2015 #155 Full Art/Gardevoir EX');
  assert.match(view.cards[0].detailLine, /Sold for 79\.90 USDC · Cycle 2/);
  assert.equal(view.history.length, 2);
  assert.match(view.history[0].title, /^Cycle 2 · /);
  assert.match(view.history[1].line, /Mega Charizard Y Ex CGC · Bought 25\.00 USDC · Sold 29\.75 USDC · Paid 0\.007199 ETH to 48 holders · 0\.00015 ETH each/);
  assert.match(view.historyNote, /2 recorded test cycles · 148 payouts/);
});

test('failed transfers of a cycle are shown, never hidden', () => {
  const feed = fixture(); feed.cycles.shift();
  const view = simpleCyclesPresentation(readSimpleCyclesFeed(feed));
  assert.equal(view.steps.holders.amount, '48 paid · 28 failed');
  assert.match(view.paidNote, /48 holders paid · 28 transfers failed/);
});

test('rendering fills every dashboard slot and hides the load-more button', () => {
  const doc = fakeDocument();
  renderSimpleCycles(doc, readSimpleCyclesFeed(fixture()));
  assert.equal(doc.nodes.get('metricPaid').textContent, '0.031366 ETH');
  assert.equal(doc.nodes.get('metricAverage').textContent, '0.000314 ETH');
  assert.equal(doc.nodes.get('metricTotalPaid').textContent, '0.038565 ETH');
  assert.equal(doc.nodes.get('metricCompletedCycles').textContent, '2');
  assert.equal(doc.nodes.get('metricPacks').textContent, '2');
  assert.equal(doc.nodes.get('metricPool').textContent, '129.71 USDC');
  assert.equal(doc.nodes.get('dashboardStatus').dataset.state, 'live');
  assert.equal(doc.nodes.get('headerCycleState').textContent, 'RECORDED');
  assert.equal(doc.nodes.get('cycleHistoryMore').hidden, true);
  assert.equal(doc.nodes.get('latestCards').children.length, 2);
  assert.equal(doc.nodes.get('latestCards').children[0].children[0].tag, 'img');
  assert.equal(doc.nodes.get('latestCards').children[0].children[0].referrerPolicy, 'no-referrer');
  assert.equal(doc.nodes.get('latestCards').children[1].children[0].tag, 'div', 'a card without an image gets no img node');
  assert.equal(doc.nodes.get('cycleHistoryList').children.length, 2);
  assert.ok(doc.historyNotes.every((node) => /2 recorded test cycles/.test(node.textContent)));
  assert.ok(doc.steps.every((node) => node.dataset.state === 'complete'));
});

test('the cycles record page lists the breakdown and links only Solana transactions', () => {
  const model = simpleCycleRecord(readSimpleCyclesFeed(fixture()));
  assert.match(model.title, /^Cycle 2 · /);
  assert.deepEqual(model.breakdown.map(([label]) => label), ['Pack spend', 'Card pulled', 'Card sale / buyback proceeds', 'Bridged to Robinhood Chain', 'Completed holder payout', 'Average per holder']);
  assert.equal(model.breakdown[4][1], '0.031366 ETH to 100 holders');
  assert.equal(model.transactions.length, 2);
  assert.match(model.transactions[0].url, /^https:\/\/explorer\.solana\.com\/tx\/5L9qw/);
  assert.equal(model.transactions[1].url, null, 'no unconfirmed EVM explorer is linked');
  const doc = fakeDocument();
  renderSimpleCycleRecord(doc, readSimpleCyclesFeed(fixture()));
  assert.equal(doc.nodes.get('recordPaid').textContent, '0.031366 ETH');
  assert.equal(doc.nodes.get('recordBreakdown').children.length, 6);
  assert.equal(doc.nodes.get('recordTransactions').children.length, 2);
});

test('the homepage falls back to the live feed when the static feed is missing or empty', async () => {
  const doc = fakeDocument();
  assert.equal(await startSimpleCycles(doc, async () => ({ ok: false, json: async () => ({}) })), false);
  assert.equal(await startSimpleCycles(doc, async () => ({ ok: true, json: async () => ({ ...fixture(), cycles: [] }) })), false);
  assert.equal(await startSimpleCycles(doc, async () => { throw new Error('offline'); }), false);
  assert.equal(doc.nodes.get('metricPaid').textContent, '', 'nothing was rendered');
  assert.equal(await startSimpleCycles(doc, async () => ({ ok: true, json: async () => fixture() })), true);
  assert.equal(doc.nodes.get('metricPaid').textContent, '0.031366 ETH');
});
