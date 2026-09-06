// Public, read-only projections. They consume the same injected operator-control status snapshot as
// the private dashboard and never open a lifecycle store or consult local cycle state.
import { buildPublicCycleStatus } from '../projections/cycle-status-projection.mjs';
import { buildPublicCommunitySnapshot } from '../projections/community-snapshot-projection.mjs';
import { OperatorControlUnavailable } from '../projections/decision-application.mjs';
import { OPERATIONAL_CYCLE_STAGES } from '../../../runner/src/cycle/money-schemas.mjs';

function sendJson(res, status, body, { cache = 'no-store' } = {}) {
  const bytes = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'cache-control': cache,
    'content-length': bytes.length,
  });
  res.end(bytes);
}

export function healthzHandler(_req, res) {
  sendJson(res, 200, { status: 'ok' });
}

function methodAndQueryGuard(req, res) {
  if (req.method !== 'GET') {
    sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED' });
    return false;
  }
  const search = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  if (search.length > 0) {
    sendJson(res, 400, { code: 'QUERY_INVALID' });
    return false;
  }
  return true;
}

async function loadAuthorityStatus(ctx) {
  if (!ctx.operatorControl || typeof ctx.operatorControl.status !== 'function') throw new OperatorControlUnavailable();
  return ctx.operatorControl.status();
}

function activeCycle(authorityStatus) {
  if (!authorityStatus?.activeCycleId || !Array.isArray(authorityStatus.cycles)) return null;
  return authorityStatus.cycles.find(cycle => cycle?.cycleId === authorityStatus.activeCycleId) ?? null;
}

function activeStage(cycle) {
  if (typeof cycle?.terminalState === 'string') return cycle.terminalState;
  if (!Array.isArray(cycle?.stages) || cycle.stages.length === 0) return 'UNKNOWN';
  const byStage = new Map(cycle.stages
    .filter(stage => typeof stage?.stage === 'string' && typeof stage.status === 'string')
    .map(stage => [stage.stage, stage.status]));
  for (const stage of OPERATIONAL_CYCLE_STAGES) {
    if (byStage.has(stage) && byStage.get(stage) !== 'COMPLETE') return stage;
  }
  return cycle.stages.find(stage => stage?.status !== 'COMPLETE')?.stage
    ?? OPERATIONAL_CYCLE_STAGES.filter(stage => byStage.has(stage)).at(-1)
    ?? 'UNKNOWN';
}

function readNextCycleAt(ctx) {
  const tick = ctx.lastTick ? ctx.lastTick() : null;
  if (!tick || !Number.isSafeInteger(tick.at) || !Number.isSafeInteger(tick.intervalMs)) return null;
  return new Date(tick.at + tick.intervalMs).toISOString();
}

function projectPublicHeldPositions(positions, cycles, generatedAt) {
  if (positions === undefined || positions === null) return [];
  if (!Array.isArray(positions)) throw new Error('authority held positions are invalid');
  const cycleStates = new Map((Array.isArray(cycles) ? cycles : [])
    .filter(cycle => typeof cycle?.cycleId === 'string')
    .map(cycle => [cycle.cycleId, typeof cycle.terminalState === 'string' ? cycle.terminalState : activeStage(cycle)]));
  const generatedAtMs = Date.parse(generatedAt);
  return positions.map(position => {
    if (!position || typeof position !== 'object' || Array.isArray(position)
      || typeof position.positionId !== 'string' || typeof position.cycleId !== 'string'
      || typeof position.reason !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(position.reason)
      || !Number.isSafeInteger(position.openedAtMs)
      || position.openedAtMs < 0) {
      throw new Error('authority held position is invalid');
    }
    return {
      reason: position.reason,
      ageSeconds: Math.max(0, Math.floor((generatedAtMs - position.openedAtMs) / 1_000)),
      cycleState: cycleStates.get(position.cycleId) ?? 'UNKNOWN',
    };
  });
}

async function readAuthorityProjection(ctx) {
  const authorityStatus = await loadAuthorityStatus(ctx);
  const configuration = authorityStatus.configuration ?? null;
  const current = activeCycle(authorityStatus);
  const generatedAt = new Date(ctx.now()).toISOString();
  const accounting = current && typeof ctx.readAccounting === 'function'
    ? await ctx.readAccounting(current.cycleId)
    : null;
  const cycles = Array.isArray(authorityStatus.cycles) ? authorityStatus.cycles : [];
  const heldPositions = projectPublicHeldPositions(authorityStatus.heldPositions, cycles, generatedAt);
  const terminals = cycles.filter(cycle => typeof cycle?.terminalState === 'string');
  const completedCycles = terminals.filter(cycle => cycle.terminalState === 'COMPLETE' || cycle.terminalState === 'COMPLETED').length;

  return {
    authorityStatus,
    configuration,
    internalStatus: {
      generatedAt,
      paused: Boolean(configuration?.paused || configuration?.executionPaused || configuration?.killSwitch),
      intervalMinutes: configuration?.intervalMinutes ?? null,
      nextRunAt: readNextCycleAt(ctx),
      activeCycle: current ? { cycleId: current.cycleId, stage: activeStage(current), accounting } : null,
      lastPayout: null,
      totals: { paidOut: completedCycles },
      heldPositions,
    },
    // Every terminal cycle is passed through; buildPublicCommunitySnapshot itself decides whether
    // "latest" is determinable (see its own header) — this route never pre-guesses an order.
    terminalCycles: terminals,
    completedCycles,
    heldPositions,
  };
}

export function createCycleStatusHandler(ctx) {
  return async function cycleStatusHandler(req, res) {
    if (!methodAndQueryGuard(req, res)) return;
    try {
      const { configuration, internalStatus } = await readAuthorityProjection(ctx);
      // `ctx.getSchedulerView` is an entirely optional live capability, the same pattern as
      // `ctx.readAccounting`/`ctx.listRecentWinners` — typically bound to
      // `packages/runner/src/scheduler/scheduler.mjs`'s `createScheduler().getView`. Its absence or
      // failure degrades to buildPublicCycleStatus's own conservative fallback, never a 503.
      let schedulerView = null;
      if (typeof ctx.getSchedulerView === 'function') {
        try {
          schedulerView = ctx.getSchedulerView();
        } catch (error) {
          ctx.onError?.('cycle-status-scheduler-view', error);
        }
      }
      const status = buildPublicCycleStatus({
        profileId: ctx.profileId,
        internalStatus,
        configuration,
        schedulerView,
      });
      sendJson(res, 200, status, { cache: 'public, max-age=5, stale-while-revalidate=30' });
    } catch (error) {
      ctx.onError?.('cycle-status', error);
      sendJson(res, 503, { code: error instanceof OperatorControlUnavailable ? error.code : 'PUBLIC_CYCLE_STATUS_UNAVAILABLE' });
    }
  };
}

export function createCommunityDashboardHandler(ctx) {
  return async function communityDashboardHandler(req, res) {
    if (!methodAndQueryGuard(req, res)) return;
    try {
      const projection = await readAuthorityProjection(ctx);
      // `ctx.listRecentWinners` is an entirely optional live capability, the same pattern as
      // `ctx.readAccounting`/`ctx.triggerTick` — typically bound to
      // `packages/adapters/src/collector/recent-winners.mjs`'s `createRecentWinnersCollector().list`.
      // Its absence or failure must never break this route (recent-winners is purely observational),
      // so a thrown/rejected call degrades to an empty card feed rather than a 503.
      let recentWinners = [];
      if (typeof ctx.listRecentWinners === 'function') {
        try {
          recentWinners = await ctx.listRecentWinners({ limit: 12 });
        } catch (error) {
          ctx.onError?.('community-dashboard-recent-winners', error);
        }
      }
      const snapshot = await buildPublicCommunitySnapshot({
        profileId: ctx.profileId,
        repositoryCycles: projection.terminalCycles,
        generatedAt: projection.internalStatus.generatedAt,
        nextCycleAt: projection.internalStatus.nextRunAt,
        completedCycles: projection.completedCycles,
        skippedCycles: 0,
        openedPacks: 0,
        heldPositions: projection.heldPositions,
        readAccounting: ctx.readAccounting ? cycleId => ctx.readAccounting(cycleId) : null,
        recentWinners,
      });
      sendJson(res, 200, snapshot, { cache: 'public, max-age=30, stale-while-revalidate=60' });
    } catch (error) {
      ctx.onError?.('community-dashboard', error);
      sendJson(res, 503, { code: error instanceof OperatorControlUnavailable ? error.code : 'PUBLIC_COMMUNITY_SNAPSHOT_UNAVAILABLE' });
    }
  };
}

export { sendJson };
