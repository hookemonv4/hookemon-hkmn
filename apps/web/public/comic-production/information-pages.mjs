import { validateDashboardPair, formatMicroUsdc, latestPayout, historyPresentation, dashboardTiming } from './dashboard.mjs';

export function cycleRecord(status, community, now = Date.now()) {
  const pair = validateDashboardPair(status, community);
  const cycle = community.latestCycle;
  const round = cycle?.roundAccounting;
  const payout = latestPayout(cycle);
  const timing = dashboardTiming(pair, now);
  const history = historyPresentation(community);
  return {
    feed: `${community.badge} · ${status.network.ethereum.label} / ${status.network.solana.label} · ${timing.delayed ? 'Delayed observations' : 'Validated public observations'} · ${community.generatedAt}`,
    pool: formatMicroUsdc(community.metrics.latestObservedProjectPoolMicroUsdc),
    paid: formatMicroUsdc(payout?.paid),
    count: history.completedCycles,
    history: history.note,
    title: cycle ? `Cycle ${cycle.cycleId}` : 'Latest cycle · unavailable',
    status: cycle ? `${cycle.status} · ${cycle.updatedAt ?? 'Update time not reported'}` : 'No verified cycle record is available.',
    breakdown: [
      ['Pack spend', formatMicroUsdc(round?.packSpendMicroUsdc)],
      ['Card sale / buyback proceeds', formatMicroUsdc(round?.buybackMicroUsdc)],
      ['Protected operating costs', formatMicroUsdc(round?.protectedCostsMicroUsdc)],
      ['Reserve after the cycle', formatMicroUsdc(round?.feeReserveAfterMicroUsdc)],
      ['Completed holder payout', formatMicroUsdc(payout?.paid)],
    ],
    transactions: (cycle?.transactions ?? []).map((tx) => ({
      label: `${tx.purpose} · ${tx.chain} · ${tx.id}`,
      url: tx.chain === 'ethereum'
        ? `https://${pair.status.profile === 'testnet' ? 'sepolia.' : ''}etherscan.io/tx/${tx.id}`
        : `https://explorer.solana.com/tx/${tx.id}${pair.status.profile === 'testnet' ? '?cluster=devnet' : ''}`,
    })),
  };
}

export function renderRecord(doc, model) {
  const values = { cycleFeedState: model.feed, recordPool: model.pool, recordPaid: model.paid,
    recordCount: model.count, recordHistory: model.history, recordTitle: model.title, recordStatus: model.status };
  for (const [id, value] of Object.entries(values)) doc.getElementById(id).textContent = value;
  const ledger = doc.getElementById('recordBreakdown');
  ledger.replaceChildren();
  for (const [label, value] of model.breakdown) {
    const row = doc.createElement('div');
    const term = doc.createElement('dt');
    const amount = doc.createElement('dd');
    term.textContent = label; amount.textContent = value;
    row.append(term, amount); ledger.append(row);
  }
  const references = doc.getElementById('recordTransactions');
  references.replaceChildren();
  for (const reference of model.transactions) {
    const item = doc.createElement('li');
    const anchor = doc.createElement('a');
    anchor.textContent = reference.label;
    anchor.href = reference.url; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer';
    item.append(anchor); references.append(item);
  }
  if (!model.transactions.length) {
    const item = doc.createElement('li'); item.textContent = 'No verified transaction references reported.';
    references.append(item);
  }
}

export function installCycleRecords(doc = document, request = fetch) {
  const button = doc.getElementById('refreshCycles');
  if (!button) return () => {};
  let active = null;
  let stopped = false;
  const unavailable = () => {
    doc.getElementById('cycleFeedState').textContent = 'Live cycle data is unavailable. No unverified or partial payout is shown.';
    for (const id of ['recordPool', 'recordPaid', 'recordCount']) doc.getElementById(id).textContent = '—';
    doc.getElementById('recordTitle').textContent = 'Latest cycle · unavailable';
    doc.getElementById('recordHistory').textContent = 'Awaiting verified history.';
    doc.getElementById('recordStatus').textContent = 'No verified cycle record is available.';
    doc.getElementById('recordBreakdown').querySelectorAll('dd').forEach((node) => { node.textContent = '—'; });
    doc.getElementById('recordTransactions').textContent = 'No verified transaction references reported.';
  };
  const refresh = async () => {
    if (active || stopped) return;
    const controller = new AbortController(); active = controller;
    button.disabled = true;
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const [status, community] = await Promise.all(['/api/cycle-status', '/api/community-dashboard'].map(async (url) => {
        const response = await request(url, { cache: 'no-store', credentials: 'omit', signal: controller.signal });
        if (!response.ok) throw new Error('Unavailable');
        return response.json();
      }));
      if (!stopped) renderRecord(doc, cycleRecord(status, community));
    } catch { if (!stopped) unavailable(); }
    finally { clearTimeout(timer); active = null; if (!stopped) button.disabled = false; }
  };
  button.addEventListener('click', refresh);
  void refresh();
  return () => { stopped = true; active?.abort(); button.removeEventListener('click', refresh); };
}

if (typeof document !== 'undefined' && document.body?.dataset.informationPage === 'cycles') {
  const stop = installCycleRecords();
  window.addEventListener('pagehide', stop, { once: true });
}
