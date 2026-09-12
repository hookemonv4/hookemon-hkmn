// Recorded cycles of the wallet-funded bot, published as a static feed
// (/comic-production/simple-cycles.json, schema hookemon-simple-cycles/1). The feed is written by
// the bot after every completed cycle and copied into the site; this module renders it into the
// same dashboard slots the live-feed renderer in dashboard.mjs uses, so the page looks identical
// whichever source is active. When the feed is absent or empty the caller falls back to the live
// feed and nothing here touches the page.
const FEED_URL = '/comic-production/simple-cycles.json';
const FEED_SCHEMA = 'hookemon-simple-cycles/1';
const SOLANA_EXPLORER = 'https://explorer.solana.com/tx/';
const MISSING = '—';

const isText = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512;
const isAmount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isTimestamp = (value) => isText(value) && Number.isFinite(Date.parse(value));
const isBase58 = (value) => isText(value) && /^[1-9A-HJ-NP-Za-km-z]{32,128}$/.test(value);
const isHexHash = (value) => isText(value) && /^0x[0-9a-fA-F]{64}$/.test(value);

function safeImage(value) {
  try {
    if (!isText(value)) return null;
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function readCard(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!isBase58(value.mint)) return null;
  return { mint: value.mint, name: isText(value.name) ? value.name : null, image: safeImage(value.image) };
}

function readCycle(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const numbers = ['packPriceUsdc', 'saleUsdc', 'receivedEth', 'paidEth', 'averagePayoutEth'];
  if (!isText(value.cycleId) || !isTimestamp(value.startedAt) || !isTimestamp(value.purchasedAt)) return null;
  if (!numbers.every((key) => isAmount(value[key]))) return null;
  if (![value.holdersPaid, value.holdersReverted].every(isCount)) return null;
  if (!Array.isArray(value.cards) || value.cards.length > 24) return null;
  const cards = value.cards.map(readCard);
  if (cards.some((card) => card === null)) return null;
  return {
    cycleId: value.cycleId,
    startedAt: value.startedAt,
    purchasedAt: value.purchasedAt,
    completedAt: isTimestamp(value.completedAt) ? value.completedAt : null,
    packType: isText(value.packType) ? value.packType : 'pack',
    packPriceUsdc: value.packPriceUsdc,
    cards,
    saleUsdc: value.saleUsdc,
    receivedEth: value.receivedEth,
    holdersSnapshot: isCount(value.holdersSnapshot) ? value.holdersSnapshot : null,
    holdersPaid: value.holdersPaid,
    holdersReverted: value.holdersReverted,
    paidEth: value.paidEth,
    averagePayoutEth: value.averagePayoutEth,
    purchaseSignature: isBase58(value.purchaseSignature) ? value.purchaseSignature : null,
    saleSignature: isBase58(value.saleSignature) ? value.saleSignature : null,
    returnTxHash: isHexHash(value.returnTxHash) ? value.returnTxHash : null,
  };
}

/** Validates the static feed. Returns null for anything that is not a well-formed feed with at least one cycle. */
export function readSimpleCyclesFeed(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.schema !== FEED_SCHEMA || !isTimestamp(value.generatedAt) || !Array.isArray(value.cycles)) return null;
  if (value.cycles.length === 0 || value.cycles.length > 1000) return null;
  const cycles = value.cycles.map(readCycle);
  if (cycles.some((cycle) => cycle === null)) return null;
  const wallet = value.wallet && typeof value.wallet === 'object' && isTimestamp(value.wallet.observedAt)
    && isAmount(value.wallet.usdcSolana) && isAmount(value.wallet.ethRobinhood)
    ? { observedAt: value.wallet.observedAt, usdcSolana: value.wallet.usdcSolana, ethRobinhood: value.wallet.ethRobinhood }
    : null;
  const ordered = [...cycles].sort((a, b) => Date.parse(b.purchasedAt) - Date.parse(a.purchasedAt));
  return { generatedAt: value.generatedAt, wallet, cycles: ordered };
}

export function formatEth(value) {
  if (!isAmount(value)) return MISSING;
  const fixed = value >= 1 ? value.toFixed(4) : value.toFixed(6);
  return `${fixed.replace(/0+$/, '').replace(/\.$/, '')} ETH`;
}

export function formatUsdc(value) {
  if (!isAmount(value)) return MISSING;
  return `${value.toFixed(2)} USDC`;
}

function formatTime(value) {
  return `${new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value))} UTC`;
}

function cardNames(cycle) {
  return cycle.cards.map((card) => card.name ?? 'Unnamed card').join(', ');
}

/** Everything the homepage dashboard shows, as plain strings, derived only from the validated feed. */
export function simpleCyclesPresentation(feed) {
  const latest = feed.cycles[0];
  const total = feed.cycles.length;
  const totalPaidEth = feed.cycles.reduce((sum, cycle) => sum + cycle.paidEth, 0);
  const totalPayouts = feed.cycles.reduce((sum, cycle) => sum + cycle.holdersPaid, 0);
  const holdersLine = latest.holdersReverted > 0
    ? `${latest.holdersPaid} paid · ${latest.holdersReverted} failed`
    : `${latest.holdersPaid} paid`;
  const cards = feed.cycles.flatMap((cycle, index) => cycle.cards.map((card) => ({
    key: `${cycle.cycleId}:${card.mint}`,
    imageUrl: card.image,
    label: card.name ?? card.mint,
    stateLabel: 'Sold back',
    detailLine: `Sold for ${formatUsdc(cycle.saleUsdc)} · Cycle ${total - index} · ${formatTime(cycle.purchasedAt)}`,
  })));
  return {
    banner: `Mainnet · Robinhood Chain · Wallet-funded test cycles · Updated ${formatTime(feed.generatedAt)}`,
    bannerState: 'live',
    headerState: 'RECORDED',
    countdown: '--:--',
    countdownNote: 'Cycles are started manually',
    pool: feed.wallet ? formatUsdc(feed.wallet.usdcSolana) : MISSING,
    poolNote: feed.wallet ? `Pack budget in the bot wallet · Observed ${formatTime(feed.wallet.observedAt)}` : 'Wallet balance not reported',
    paid: formatEth(latest.paidEth),
    paidNote: `Cycle ${total} · ${latest.holdersPaid} holders paid${latest.holdersReverted > 0 ? ` · ${latest.holdersReverted} transfers failed` : ''}`,
    average: formatEth(latest.averagePayoutEth),
    averageNote: 'Per paid holder · pro rata by HKMN balance',
    recipients: latest.holdersPaid.toLocaleString('en-US'),
    totalPaid: formatEth(totalPaidEth),
    completedCycles: total.toLocaleString('en-US'),
    skippedCycles: '0',
    openedPacks: total.toLocaleString('en-US'),
    historyNote: `${total} recorded test ${total === 1 ? 'cycle' : 'cycles'} · ${totalPayouts.toLocaleString('en-US')} payouts`,
    cardsCount: String(Math.min(cards.length, 12)),
    steps: {
      fees: { state: 'complete', amount: 'Wallet-funded' },
      budget: { state: 'complete', amount: formatUsdc(latest.packPriceUsdc) },
      packs: { state: 'complete', amount: `1 pack · ${formatUsdc(latest.packPriceUsdc)}` },
      cards: { state: 'complete', amount: `${latest.cards.length} ${latest.cards.length === 1 ? 'card' : 'cards'}` },
      sales: { state: 'complete', amount: formatUsdc(latest.saleUsdc) },
      return: { state: 'complete', amount: formatEth(latest.receivedEth) },
      holders: { state: latest.holdersPaid > 0 ? 'complete' : 'failed', amount: holdersLine },
    },
    cards: cards.slice(0, 12),
    history: feed.cycles.map((cycle, index) => ({
      title: `Cycle ${total - index} · ${formatTime(cycle.purchasedAt)}`,
      line: `${cardNames(cycle)} · Bought ${formatUsdc(cycle.packPriceUsdc)} · Sold ${formatUsdc(cycle.saleUsdc)} · Paid ${formatEth(cycle.paidEth)} to ${cycle.holdersPaid} holders · ${formatEth(cycle.averagePayoutEth)} each`,
    })),
  };
}

const STATE_LABELS = { complete: 'Complete', failed: 'Action needs attention' };

/** Writes the presentation into the homepage dashboard. Only text nodes and https images are ever created. */
export function renderSimpleCycles(doc, feed) {
  const view = simpleCyclesPresentation(feed);
  const setText = (id, value) => { const node = doc.getElementById(id); if (node) node.textContent = value; };
  const banner = doc.getElementById('dashboardStatus');
  if (banner) { banner.dataset.state = view.bannerState; banner.textContent = view.banner; }
  setText('headerCycleState', view.headerState);
  setText('headerCountdown', view.countdown);
  setText('navCountdown', view.countdown);
  const navCycle = doc.getElementById('navCycle');
  if (navCycle) {
    navCycle.title = view.countdownNote;
    navCycle.setAttribute('aria-label', `Next cycle: ${view.countdownNote}. Open dashboard.`);
    navCycle.dataset.state = 'unknown';
  }
  setText('metricCountdown', view.countdown);
  setText('metricCountdownNote', view.countdownNote);
  setText('metricPool', view.pool);
  setText('metricPoolNote', view.poolNote);
  setText('metricPaid', view.paid);
  setText('metricPaidNote', view.paidNote);
  setText('metricAverage', view.average);
  setText('metricAverageNote', view.averageNote);
  setText('metricRecipients', view.recipients);
  setText('metricTotalPaid', view.totalPaid);
  setText('metricCompletedCycles', view.completedCycles);
  setText('metricSkippedCycles', view.skippedCycles);
  setText('metricPacks', view.openedPacks);
  setText('metricCards', view.cardsCount);
  doc.querySelectorAll('[data-history-note]').forEach((node) => { node.textContent = view.historyNote; });
  doc.querySelectorAll('[data-step]').forEach((node) => {
    const step = view.steps[node.dataset.step];
    if (!step) return;
    node.dataset.state = step.state;
    const amount = node.querySelector('.s'), label = node.querySelector('.w');
    if (amount) amount.textContent = step.amount;
    if (label) label.textContent = STATE_LABELS[step.state];
  });
  const cardList = doc.getElementById('latestCards');
  if (cardList) {
    cardList.replaceChildren();
    for (const card of view.cards) {
      const article = doc.createElement('article'); article.className = 'history-card';
      if (card.imageUrl) {
        const image = doc.createElement('img'); image.src = card.imageUrl; image.alt = card.label;
        image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; article.append(image);
      }
      const copy = doc.createElement('div'); copy.className = 'card-copy';
      for (const [tag, value] of [['span', card.stateLabel], ['strong', card.label], ['small', card.detailLine]]) {
        const node = doc.createElement(tag); node.textContent = value; copy.append(node);
      }
      article.append(copy); cardList.append(article);
    }
  }
  setText('cycleHistoryStatus', 'Recorded cycles, newest first');
  const historyList = doc.getElementById('cycleHistoryList');
  if (historyList) {
    historyList.replaceChildren();
    for (const item of view.history) {
      const article = doc.createElement('article');
      const title = doc.createElement('h3'); title.textContent = item.title;
      const line = doc.createElement('p'); line.textContent = item.line;
      article.append(title, line); historyList.append(article);
    }
  }
  const moreButton = doc.getElementById('cycleHistoryMore');
  if (moreButton) moreButton.hidden = true;
  return view;
}

/** The record shown on the cycles information page, derived only from the validated feed. */
export function simpleCycleRecord(feed) {
  const latest = feed.cycles[0];
  const total = feed.cycles.length;
  const view = simpleCyclesPresentation(feed);
  const transactions = [];
  if (latest.purchaseSignature) transactions.push({ label: `Pack purchase · Solana · ${latest.purchaseSignature}`, url: `${SOLANA_EXPLORER}${latest.purchaseSignature}` });
  if (latest.saleSignature) transactions.push({ label: `Card sale · Solana · ${latest.saleSignature}`, url: `${SOLANA_EXPLORER}${latest.saleSignature}` });
  if (latest.returnTxHash) transactions.push({ label: `Proceeds bridged to Robinhood Chain · ${latest.returnTxHash}`, url: null });
  return {
    feed: view.banner,
    pool: view.pool,
    paid: view.paid,
    count: view.completedCycles,
    history: view.historyNote,
    title: `Cycle ${total} · ${formatTime(latest.purchasedAt)}`,
    status: latest.completedAt ? `Complete · holders paid ${formatTime(latest.completedAt)}` : 'Complete',
    breakdown: [
      ['Pack spend', formatUsdc(latest.packPriceUsdc)],
      ['Card pulled', cardNames(latest)],
      ['Card sale / buyback proceeds', formatUsdc(latest.saleUsdc)],
      ['Bridged to Robinhood Chain', formatEth(latest.receivedEth)],
      ['Completed holder payout', `${formatEth(latest.paidEth)} to ${latest.holdersPaid} holders`],
      ['Average per holder', formatEth(latest.averagePayoutEth)],
    ],
    transactions,
  };
}

export function renderSimpleCycleRecord(doc, feed) {
  const model = simpleCycleRecord(feed);
  const values = { cycleFeedState: model.feed, recordPool: model.pool, recordPaid: model.paid,
    recordCount: model.count, recordHistory: model.history, recordTitle: model.title, recordStatus: model.status };
  for (const [id, value] of Object.entries(values)) { const node = doc.getElementById(id); if (node) node.textContent = value; }
  const ledger = doc.getElementById('recordBreakdown');
  if (ledger) {
    ledger.replaceChildren();
    for (const [label, value] of model.breakdown) {
      const row = doc.createElement('div');
      const term = doc.createElement('dt'); term.textContent = label;
      const amount = doc.createElement('dd'); amount.textContent = value;
      row.append(term, amount); ledger.append(row);
    }
  }
  const references = doc.getElementById('recordTransactions');
  if (references) {
    references.replaceChildren();
    for (const reference of model.transactions) {
      const item = doc.createElement('li');
      if (reference.url) {
        const anchor = doc.createElement('a');
        anchor.textContent = reference.label;
        anchor.href = reference.url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
        item.append(anchor);
      } else {
        item.textContent = reference.label;
      }
      references.append(item);
    }
    if (!model.transactions.length) {
      const item = doc.createElement('li'); item.textContent = 'No transaction references recorded.';
      references.append(item);
    }
  }
  return model;
}

/** Loads the static feed; null when it is missing, malformed or empty. */
export async function loadSimpleCyclesFeed(request = fetch) {
  try {
    const response = await request(FEED_URL, { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) return null;
    return readSimpleCyclesFeed(await response.json());
  } catch { return null; }
}

/** Renders the homepage dashboard from the static feed. Resolves true when it did, false when the live feed should take over. */
export async function startSimpleCycles(doc, request = fetch) {
  const feed = await loadSimpleCyclesFeed(request);
  if (!feed) return false;
  renderSimpleCycles(doc, feed);
  return true;
}

export async function startSimpleCycleRecord(doc, request = fetch) {
  const feed = await loadSimpleCyclesFeed(request);
  if (!feed) return false;
  renderSimpleCycleRecord(doc, feed);
  return true;
}
