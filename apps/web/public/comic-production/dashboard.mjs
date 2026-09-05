const UNAVAILABLE = '—';
const MISSING_VALUE = '—';
const FRESH_MS = 90_000;
const POLL_MS = 15_000;
const money = (value) => typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value);
const text = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const nullable = (check) => (value) => value === null || check(value);
const optional = (check) => (value) => value === undefined || check(value);
const oneOf = (...values) => (value) => values.includes(value);
const timestamp = (value) => text(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
const fields = (keys, check) => Object.fromEntries(keys.split(' ').map((key) => [key, check]));
const record = (shape) => (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value))
  && Object.keys(value).every((key) => Object.hasOwn(shape, key))
  && Object.entries(shape).every(([key, check]) => check(Object.hasOwn(value, key) ? value[key] : undefined));
const list = (check, max) => (value) => Array.isArray(value) && value.length <= max
  && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index) && check(value[index])).every(Boolean);

export function safeCardImage(value) {
  try {
    if (!text(value)) return null;
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

// The Worker normalizes legacy inputs. This client accepts only its canonical public output.
const cardShape = {
  productId: text, rarity: text,
  ...fields('nftAddress cardName setName cardNumber', nullable(text)),
  imageUrl: nullable((value) => safeCardImage(value) !== null),
  ...fields('packPriceMicroUsdc buybackMicroUsdc', nullable(money)),
};
const nativeFee = nullable(record({ lamports: money, paidBy: text }));
const roundShape = record({
  ...fields('packSpendMicroUsdc buybackMicroUsdc packGainMicroUsdc packLossMicroUsdc', money),
  quotedCosts: record(fields('outboundBridgeMicroUsdc inboundBridgeMicroUsdc collectorApiMicroUsdc ethereumNetworkMicroUsdc solanaNetworkMicroUsdc slippageMicroUsdc', nullable(money))),
  ...fields('protectedCostsMicroUsdc cycleGainMicroUsdc cycleLossMicroUsdc walletBalanceBeforeMicroUsdc walletBalanceAfterMicroUsdc feeReserveBeforeMicroUsdc feeReserveTargetMicroUsdc feeReserveTopUpMicroUsdc feeReserveAfterMicroUsdc plannedHolderRewardsMicroUsdc paidHolderRewardsMicroUsdc', nullable(money)),
  confirmedCostsMicroUsdc: nullable((value) => typeof value === 'string' && /^(0|-?[1-9]\d{0,77})$/.test(value)),
  networkFees: record({ walletLamportsCharged: nullable(money), purchase: nativeFee, buyback: nativeFee }),
  holderRewardsStatus: text, distributionStatus: text,
});
const exclusive = (gain, loss) => (gain === null && loss === null)
  || (gain !== null && loss !== null && (gain === '0' || loss === '0'));
const accounting = nullable((value) => roundShape(value)
  && exclusive(value.packGainMicroUsdc, value.packLossMicroUsdc)
  && exclusive(value.cycleGainMicroUsdc, value.cycleLossMicroUsdc));
const action = record({ type: text, status: oneOf('pending', 'complete', 'failed'), at: timestamp });
const cycleShape = record({
  cycleId: text, status: text, selectedPackId: nullable(text),
  maxBoostersPerCycle: nullable((value) => count(value) && value > 0),
  plannedBoosters: count, openedBoosters: count, actions: list(action, 128), cards: list(record(cardShape), 60),
  returnedMicroUsdc: nullable(money), rewardStatus: nullable(text), roundAccounting: accounting,
  startedAt: optional(timestamp), updatedAt: optional(timestamp),
  spentMicroUsdc: optional(nullable(money)), paidMicroUsdc: optional(nullable(money)),
  reason: optional((value) => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)),
});
const cycle = nullable((value) => cycleShape(value) && value.cards.length === Math.min(value.openedBoosters, 60));
const network = record({
  ethereum: record({ name: text, chainId: count, label: text }),
  solana: record({ name: text, genesisHash: text, label: text }),
});
const transactionShape = record({ chain: oneOf('ethereum', 'solana'), purpose: text, id: text });
const transaction = (value) => transactionShape(value) && (value.chain === 'ethereum'
  ? ['outbound-burn', 'inbound-finalization', 'reward-settlement'].includes(value.purpose) && /^0x[0-9a-fA-F]{64}$/.test(value.id)
  : ['outbound-mint', 'inbound-burn', 'collector-purchase', 'collector-buyback'].includes(value.purpose) && /^[1-9A-HJ-NP-Za-km-z]{32,88}$/.test(value.id));
const transactions = (value) => list(transaction, 24)(value)
  && new Set(value.map(({ chain, id }) => `${chain}:${chain === 'ethereum' ? id.toLowerCase() : id}`)).size === value.length;
const latestCycleShape = {
  cycleId: text, status: text, reason: nullable(text), updatedAt: nullable(timestamp),
  paidMicroUsdc: nullable(money), payoutRecipientCount: count, roundAccounting: accounting, transactions,
};
const recipientLimit = (value) => count(value) && (value === 50 || (value >= 100 && value <= 1000 && value % 100 === 0));
const statusShape = record({
  schemaVersion: oneOf(3), profile: oneOf('testnet', 'mainnet'), network,
  executionState: oneOf('active', 'paused', 'unknown'), executionReason: oneOf(null, 'operator-paused'),
  generatedAt: timestamp, nextCycleAt: timestamp, countdownSeconds: count, cycle,
});
const metricsShape = record({
  latestObservedProjectPoolMicroUsdc: nullable(money),
  ...fields('totalCycleFundingMicroUsdc totalCollectorSpendMicroUsdc totalBuybacksReturnedMicroUsdc totalBridgedBackMicroUsdc totalRewardsPaidMicroUsdc totalRewardsDeferredMicroUsdc totalQuotedOperatingCostsMicroUsdc latestRetainedReserveMicroUsdc latestCycleReserveTargetMicroUsdc', money),
  ...fields('completedCycles skippedCycles openedPacks', count),
});
const communityShape = record({
  schemaVersion: oneOf(4), profile: oneOf('testnet', 'mainnet'), badge: oneOf('TESTNET', 'MAINNET'), network,
  historyComplete: oneOf(true, false), generatedAt: timestamp, nextCycleAt: nullable(timestamp),
  delayed: oneOf(true, false), poolObservedAt: nullable(timestamp), metrics: metricsShape,
  latestCycle: (value) => value === null || record(latestCycleShape)(value)
    || record({ ...latestCycleShape, rewardRecipientLimit: recipientLimit })(value),
  cards: list(record({ cycleId: text, ...cardShape }), 12),
});
const networkIdentity = (value) => [value.ethereum.name, value.ethereum.chainId, value.ethereum.label,
  value.solana.name, value.solana.genesisHash, value.solana.label].join('|');
const identities = {
  testnet: 'sepolia|11155111|Sepolia|devnet|EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG|Solana Devnet',
  mainnet: 'mainnet|1|Ethereum|mainnet-beta|5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d|Solana',
};

export function validateDashboardPair(status, community) {
  if (!statusShape(status) || !communityShape(community)
    || status.profile !== community.profile || community.badge !== status.profile.toUpperCase()
    || networkIdentity(status.network) !== identities[status.profile]
    || networkIdentity(community.network) !== identities[status.profile]
    || status.executionReason !== (status.executionState === 'paused' ? 'operator-paused' : null)
    || status.countdownSeconds !== Math.ceil(Math.max(0, Date.parse(status.nextCycleAt) - Date.parse(status.generatedAt)) / 1000)
    || (community.latestCycle !== null && Object.hasOwn(community.latestCycle, 'rewardRecipientLimit') !== (community.schemaVersion === 5))
    || (community.poolObservedAt === null) !== (community.metrics.latestObservedProjectPoolMicroUsdc === null)
    || (community.poolObservedAt !== null && (Date.parse(community.poolObservedAt) > Date.parse(community.generatedAt)
      || (Date.parse(community.generatedAt) - Date.parse(community.poolObservedAt) > FRESH_MS && !community.delayed)))) {
    throw new TypeError('PUBLIC_DASHBOARD_INVALID');
  }
  return { status, community };
}

export function formatMicroUsdc(value) {
  if (!money(value)) return MISSING_VALUE;
  const digits = value.padStart(7, '0');
  const whole = BigInt(digits.slice(0, -6)).toLocaleString('en-US');
  const fraction = digits.slice(-6).replace(/0+$/, '');
  return `${whole}${fraction ? `.${fraction}` : ''} USDC`;
}

export function latestPayout(cycle) {
  if (!cycle || !text(cycle.status) || cycle.status.toLowerCase() !== 'complete') return null;
  const accounting = cycle.roundAccounting;
  if (accounting && !['reconciled', 'complete', 'paid', 'settled', 'legacy-settlement-recorded'].includes(accounting.distributionStatus.toLowerCase())) return null;
  const paid = accounting?.paidHolderRewardsMicroUsdc ?? cycle.paidMicroUsdc;
  if (!money(paid) || !count(cycle.payoutRecipientCount) || cycle.payoutRecipientCount <= 0) return null;
  if (money(accounting?.paidHolderRewardsMicroUsdc) && money(cycle.paidMicroUsdc) && accounting.paidHolderRewardsMicroUsdc !== cycle.paidMicroUsdc) return null;
  return { paid, recipients: cycle.payoutRecipientCount, average: (BigInt(paid) / BigInt(cycle.payoutRecipientCount)).toString() };
}

export function historyPresentation(community) {
  const complete = community?.historyComplete === true;
  const metrics = community?.metrics;
  const formatCount = (value) => complete && count(value) ? value.toLocaleString('en-US') : MISSING_VALUE;
  return {
    totalPaid: formatMicroUsdc(complete ? metrics?.totalRewardsPaidMicroUsdc : null),
    completedCycles: formatCount(metrics?.completedCycles),
    skippedCycles: formatCount(metrics?.skippedCycles),
    openedPacks: formatCount(metrics?.openedPacks),
    note: !community ? 'Awaiting verified history' : complete ? 'Complete verified cycle history' : 'Verified history is incomplete',
  };
}

export function payoutPresentation(community) {
  const payout = latestPayout(community?.latestCycle);
  const cycle = community?.latestCycle;
  const note = !community ? 'Awaiting verified payout data'
    : payout ? 'Completed holder distribution'
      : cycle && cycle.status.toLowerCase() !== 'complete' ? 'Latest cycle has no completed payout'
        : !cycle && !community.historyComplete ? 'Payout history not reported' : 'No completed payout reported';
  return { payout, note };
}

export function dashboardTiming(pair, now = Date.now(), failed = false) {
  if (!pair) return { delayed: false, countdown: '--:--', note: 'Schedule not reported' };
  const { status, community } = pair;
  const observations = [status.generatedAt, community.generatedAt, community.poolObservedAt].filter(Boolean);
  const delayed = failed || community.delayed || observations.some((value) => now - Date.parse(value) > FRESH_MS || Date.parse(value) - now > 5000);
  const target = Date.parse(status.nextCycleAt);
  const schedulesAgree = community.nextCycleAt === null || community.nextCycleAt === status.nextCycleAt;
  if (status.executionState !== 'active' || delayed || !schedulesAgree || target <= now) {
    return { delayed, countdown: '--:--', note: status.executionState === 'paused' ? 'Cycles paused'
      : delayed ? 'Waiting for fresh schedule data' : target <= now && status.executionState === 'active' ? 'Waiting for the next cycle update' : 'Schedule not reported' };
  }
  const seconds = Math.ceil((target - now) / 1000);
  const parts = [Math.floor(seconds / 3600), Math.floor(seconds % 3600 / 60), seconds % 60];
  return { delayed, countdown: (parts[0] ? parts : parts.slice(1)).map((value) => String(value).padStart(2, '0')).join(':'), note: `Scheduled ${formatTime(status.nextCycleAt)}` };
}

const stepActions = { fees: ['fees-collected'], budget: ['pack-plan-ready'], packs: ['packs-bought'], cards: ['packs-bought'],
  sales: ['buybacks-settled'], return: ['return-bridge-finalized', 'ethereum-funded'], holders: ['rewards-complete', 'rewards-paid', 'payouts-settled'] };
const stateLabels = { waiting: 'Waiting for this step', active: 'In progress', complete: 'Complete', paused: 'Paused', skipped: 'Skipped', failed: 'Action needs attention', deferred: 'Distribution pending' };
export function processStep(id, status) {
  const cycle = status?.cycle;
  if (!cycle || !stepActions[id]) return { state: status?.executionState === 'paused' ? 'paused' : 'waiting', amount: UNAVAILABLE };
  const actions = cycle.actions.filter((action) => stepActions[id].includes(action.type));
  const done = actions.some((action) => action.status === 'complete');
  const complete = id === 'budget' ? cycle.selectedPackId !== null || cycle.plannedBoosters > 0 || done
    : id === 'cards' ? cycle.openedBoosters > 0
      : id === 'holders' ? money(cycle.paidMicroUsdc) || ['complete', 'paid', 'settled'].includes(cycle.rewardStatus) || done : done;
  const state = actions.some((action) => action.status === 'failed') ? 'failed'
    : id === 'holders' && /deferred|pending|not-executed/i.test(cycle.rewardStatus ?? '') ? 'deferred'
      : complete ? 'complete' : cycle.status === 'skipped' ? 'skipped'
        : status.executionState === 'paused' ? 'paused'
          : actions.some((action) => action.status === 'pending') || (id === 'cards' && done) ? 'active' : 'waiting';
  const amounts = { packs: cycle.spentMicroUsdc, sales: cycle.roundAccounting?.buybackMicroUsdc, return: cycle.returnedMicroUsdc, holders: cycle.paidMicroUsdc };
  const amount = id === 'budget' ? cycle.plannedBoosters > 0 ? `${cycle.plannedBoosters} planned` : cycle.selectedPackId ? 'Pack selected' : UNAVAILABLE
    : id === 'cards' ? cycle.openedBoosters > 0 ? `${cycle.openedBoosters} opened` : UNAVAILABLE : formatMicroUsdc(amounts[id]);
  return { state, amount };
}

function formatTime(value) {
  return new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
}

export function startDashboard(doc = document) {
  const setText = (id, value) => { const node = doc.getElementById(id); if (node) node.textContent = value; };
  let pair = null, failed = false, controller = null, version = 0, pollTimer, tickTimer, stopped = false;
  const visible = () => doc.visibilityState === 'visible';
  const renderTiming = () => {
    const timing = dashboardTiming(pair, Date.now(), failed);
    setText('headerCountdown', timing.countdown);
    setText('navCountdown', timing.countdown);
    const navCycle = doc.getElementById('navCycle');
    if (navCycle) {
      navCycle.title = timing.note;
      navCycle.setAttribute('aria-label', `Next cycle: ${timing.countdown === '--:--' ? timing.note : timing.countdown}. Open dashboard.`);
      navCycle.dataset.state = timing.countdown === '--:--' ? 'unknown' : 'scheduled';
    }
    setText('metricCountdown', timing.countdown);
    setText('metricCountdownNote', timing.note);
    const feedState = !pair ? failed ? 'unavailable' : 'connecting' : timing.delayed ? 'delayed' : 'live';
    const banner = doc.getElementById('dashboardStatus');
    if (banner) {
      banner.dataset.state = feedState;
      banner.textContent = pair ? `${pair.community.badge} · ${pair.status.network.ethereum.label} · ${timing.delayed ? 'Updates delayed · showing last verified data' : 'Verified public observations'}`
        : failed ? 'Live cycle data is temporarily unavailable' : 'Connecting to cycle data…';
    }
    setText('headerCycleState', pair ? timing.delayed ? 'DELAYED' : pair.status.executionState === 'paused' ? 'PAUSED' : pair.community.badge : failed ? 'UNAVAILABLE' : 'CONNECTING');
  };
  const render = () => {
    renderTiming();
    const status = pair?.status, community = pair?.community;
    const { payout, note: payoutNote } = payoutPresentation(community);
    const history = historyPresentation(community);
    const cards = status?.cycle?.cards.length ? [...status.cycle.cards].reverse() : community?.cards ?? [];
    setText('metricPool', formatMicroUsdc(community?.metrics.latestObservedProjectPoolMicroUsdc));
    setText('metricPoolNote', community?.poolObservedAt ? `Observed ${formatTime(community.poolObservedAt)}` : 'Awaiting a verified pool observation');
    setText('metricPaid', formatMicroUsdc(payout?.paid));
    setText('metricAverage', formatMicroUsdc(payout?.average));
    setText('metricPaidNote', payoutNote);
    setText('metricAverageNote', payout ? 'Per actual recipient · rounded down to 0.000001 USDC' : payoutNote);
    setText('metricRecipients', payout ? payout.recipients.toLocaleString('en-US') : MISSING_VALUE);
    setText('metricPacks', history.openedPacks);
    setText('metricTotalPaid', history.totalPaid);
    setText('metricCompletedCycles', history.completedCycles);
    setText('metricSkippedCycles', history.skippedCycles);
    doc.querySelectorAll('[data-history-note]').forEach((node) => { node.textContent = history.note; });
    setText('metricCards', cards.length ? String(Math.min(cards.length, 12)) : community?.historyComplete ? '0' : MISSING_VALUE);
    doc.querySelectorAll('[data-step]').forEach((node) => {
      const step = processStep(node.dataset.step, status);
      node.dataset.state = step.state;
      const amount = node.querySelector('.s'), label = node.querySelector('.w');
      if (amount) amount.textContent = step.amount;
      if (label) label.textContent = stateLabels[step.state];
    });
    const cardList = doc.getElementById('latestCards');
    if (!cardList) return;
    cardList.replaceChildren();
    if (!cards.length) { cardList.textContent = 'No verified card results reported.'; return; }
    cards.slice(0, 12).forEach((card) => {
      const article = doc.createElement('article'); article.className = 'history-card';
      const src = safeCardImage(card.imageUrl);
      if (src) {
        const image = doc.createElement('img'); image.src = src; image.alt = card.cardName ?? card.productId;
        image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; article.append(image);
      }
      const copy = doc.createElement('div'); copy.className = 'card-copy';
      for (const [tag, value] of [['span', card.rarity], ['strong', card.cardName ?? card.productId],
        ['small', [card.setName, card.cardNumber].filter(Boolean).join(' · ') || card.productId],
        ['small', `Buyback: ${formatMicroUsdc(card.buybackMicroUsdc)}`]]) {
        const node = doc.createElement(tag); node.textContent = value; copy.append(node);
      }
      article.append(copy); cardList.append(article);
    });
  };
  const poll = async () => {
    if (stopped || !visible() || controller) return;
    const requestVersion = ++version;
    const requestController = new AbortController();
    controller = requestController;
    const signal = requestController.signal;
    const timeout = setTimeout(() => requestController.abort(), 8000);
    try {
      const [status, community] = await Promise.all(['/api/cycle-status', '/api/community-dashboard'].map(async (url) => {
        const response = await fetch(url, { cache: 'no-store', credentials: 'omit', signal });
        if (!response.ok) throw new Error('PUBLIC_DASHBOARD_UNAVAILABLE');
        return response.json();
      }));
      if (requestVersion !== version || !visible() || stopped) return;
      try { pair = validateDashboardPair(status, community); }
      catch (error) { pair = null; throw error; }
      failed = false;
    } catch { if (requestVersion === version && visible() && !stopped) failed = true; }
    finally {
      clearTimeout(timeout);
      if (requestVersion === version) {
        controller?.abort(); controller = null;
        if (!stopped && visible()) { render(); pollTimer = setTimeout(poll, POLL_MS); }
      }
    }
  };
  const visibilityChanged = () => {
    clearTimeout(pollTimer); clearInterval(tickTimer);
    version += 1; controller?.abort(); controller = null;
    if (visible() && !stopped) {
      renderTiming(); tickTimer = setInterval(renderTiming, 1000); void poll();
    }
  };
  doc.addEventListener('visibilitychange', visibilityChanged);
  render(); visibilityChanged();
  return () => { stopped = true; visibilityChanged(); doc.removeEventListener('visibilitychange', visibilityChanged); };
}

if (typeof document !== 'undefined') startDashboard();
