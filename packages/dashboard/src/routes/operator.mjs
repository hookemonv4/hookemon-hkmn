// Authenticated dashboard routes. Status and every command cross the one injected
// `operatorControl` boundary; this package never opens or reads lifecycle state on its own.
import {
  assertAuditResponse,
  assertBootstrap,
  assertCardsResponse,
  assertDashboardResponse,
  ContractValidationError,
  readDecisionRequest,
} from '../contracts/operator-contracts.mjs';
import { buildBootstrap, buildDashboardReadModel } from '../projections/operator-projection.mjs';
import { applyDecision, OperatorControlUnavailable } from '../projections/decision-application.mjs';
import { proxyCredentialMatches } from '../auth/proxy-credential.mjs';
import {
  AuditRequestConflict,
  AuditedCommandEffectError,
  executeAuditedCommand,
  readAllAuditEntries,
} from '../auth/audit-log.mjs';
import { sendJson } from './public.mjs';

const MAX_BODY_BYTES = 32_768;
const CARD_QUERY_KEYS = new Set([
  'cursor', 'limit', 'sort', 'cycleId', 'productId', 'rarity', 'from', 'to',
  'minBuybackMicroUsdg', 'maxBuybackMicroUsdg',
]);

function parsedUrl(req) {
  return new URL(req.url, 'http://internal.invalid');
}

async function authenticate(req, res, ctx) {
  const header = req.headers['x-hookemon-proxy-credential'];
  if (!proxyCredentialMatches(Array.isArray(header) ? header[0] : header, ctx.proxyCredential)) {
    sendJson(res, 401, { code: 'PROXY_CREDENTIAL_REQUIRED' });
    return false;
  }
  if (!ctx.accessJwtVerifier) return { email: 'local-operator' };
  const assertion = req.headers['cf-access-jwt-assertion'];
  const token = Array.isArray(assertion) ? assertion[0] : assertion;
  if (!token) {
    sendJson(res, 401, { code: 'ACCESS_ASSERTION_REQUIRED' });
    return false;
  }
  try {
    const payload = await ctx.accessJwtVerifier(token);
    return { email: typeof payload.email === 'string' ? payload.email : 'local-operator' };
  } catch {
    sendJson(res, 401, { code: 'ACCESS_ASSERTION_INVALID' });
    return false;
  }
}

async function readBoundedBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function loadAuthorityStatus(ctx) {
  if (!ctx.operatorControl || typeof ctx.operatorControl.status !== 'function') throw new OperatorControlUnavailable();
  return ctx.operatorControl.status();
}

function identityFor(email) {
  return { subject: email, email, role: 'operator' };
}

async function projectDurableAuditReceipt(ctx, receipt) {
  if (!ctx.sqliteProjection || typeof ctx.sqliteProjection.appendAuditEntry !== 'function') return;
  try {
    const entry = (await readAllAuditEntries(ctx.auditLogPath)).find(record => record.eventId === receipt.eventId);
    if (entry) ctx.sqliteProjection.appendAuditEntry(entry);
    else ctx.onError?.('operator-audit-projection', new Error('durable audit receipt was not found'));
  } catch (error) {
    // The sqlite database is an optional, rebuildable read projection. Its failure cannot decide
    // whether a command reaches the already-audited runner authority.
    ctx.onError?.('operator-audit-projection', error);
  }
}

function unavailable(res, error) {
  if (error instanceof OperatorControlUnavailable) {
    sendJson(res, 503, { code: error.code });
    return true;
  }
  return false;
}

function receiptResultCode(command, authorityStatus) {
  if (command.type === 'run-cycle-now') return 'TICK_TRIGGERED';
  if (command.type === 'resume-cycle') {
    return authorityStatus.activeCycleId === null ? 'RECOVERY_NO_ACTIVE_CYCLE' : 'RECOVERY_DISPATCHED';
  }
  if (command.type === 'reconcile') return 'RECONCILIATION_DISPATCHED';
  return 'DECISION_ACCEPTED';
}

function auditCommandHttpStatus(commandState) {
  if (commandState === 'PREPARED') return 202;
  if (commandState === 'REJECTED') return 409;
  if (commandState === 'UNCERTAIN') return 503;
  return 200;
}

function isDeterministicAuthorityRejection(error) {
  if (!error || typeof error.message !== 'string') return false;
  return error.message === 'stale operator state revision'
    || /^operator configuration (maxBoostersPerCycle|maxUnitPriceMicroUsdg|maxCycleBudgetMicroUsdg|max24HourBudgetMicroUsdg) exceeds the fixed hard cap$/.test(error.message);
}

export function createBootstrapHandler(ctx) {
  return async function bootstrapHandler(req, res) {
    const identity = await authenticate(req, res, ctx);
    if (!identity) return;
    if (req.method !== 'GET') return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED' });
    try {
      const authorityStatus = await loadAuthorityStatus(ctx);
      const body = buildBootstrap({
        authorityStatus,
        identity: identityFor(identity.email),
        catalog: ctx.catalog ?? null,
        readiness: ctx.readiness ?? { ready: false, reasons: ['catalog-not-loaded'] },
      });
      sendJson(res, 200, assertBootstrap(body));
    } catch (error) {
      if (unavailable(res, error)) return;
      ctx.onError?.('operator-bootstrap', error);
      sendJson(res, 503, { code: 'OPERATOR_BOOTSTRAP_UNAVAILABLE' });
    }
  };
}

export function createDashboardHandler(ctx) {
  return async function dashboardHandler(req, res) {
    const identity = await authenticate(req, res, ctx);
    if (!identity) return;
    if (req.method !== 'GET') return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED' });
    try {
      const authorityStatus = await loadAuthorityStatus(ctx);
      const body = buildDashboardReadModel({
        authorityStatus,
        now: ctx.now,
        lastTick: ctx.lastTick ? ctx.lastTick() : null,
      });
      sendJson(res, 200, assertDashboardResponse(body));
    } catch (error) {
      if (unavailable(res, error)) return;
      ctx.onError?.('operator-dashboard', error);
      sendJson(res, 503, { code: 'OPERATOR_DASHBOARD_UNAVAILABLE' });
    }
  };
}

export function createPacksHandler(ctx) {
  return async function packsHandler(req, res) {
    const identity = await authenticate(req, res, ctx);
    if (!identity) return;
    if (req.method !== 'GET') return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED' });
    if (parsedUrl(req).searchParams.size > 0) return sendJson(res, 400, { code: 'PACKS_QUERY_INVALID' });
    if (typeof ctx.listPacks !== 'function') return sendJson(res, 200, { configured: false, machines: [] });
    try {
      const result = await ctx.listPacks();
      const machines = Array.isArray(result) ? result : result?.machines;
      const fields = ['code', 'name', 'shortName', 'price', 'public', 'instantBuyback', 'turboMode'];
      sendJson(res, 200, {
        configured: true,
        machines: (Array.isArray(machines) ? machines : []).map(machine => Object.fromEntries(
          fields.map(field => [field, machine?.[field] ?? null]),
        )),
      });
    } catch (error) {
      ctx.onError?.('packs', error);
      sendJson(res, 502, { code: 'PACK_CATALOG_UNAVAILABLE' });
    }
  };
}

export function createIdentitiesHandler(ctx) {
  return async function identitiesHandler(req, res) {
    const identity = await authenticate(req, res, ctx);
    if (!identity) return;
    if (req.method !== 'GET') return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED' });
    sendJson(res, 200, { identities: ctx.identities ?? null });
  };
}

export function createNetworkHandler(ctx) {
  return async function networkHandler(req, res) {
    const identity = await authenticate(req, res, ctx);
    if (!identity) return;
    if (req.method !== 'GET') return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED' });
    sendJson(res, 200, { profile: ctx.profileId });
  };
}

export function createCardsHandler(ctx) {
  return async function cardsHandler(req, res) {
    const identity = await authenticate(req, res, ctx);
    if (!identity) return;
    if (req.method !== 'GET') return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED' });
    const url = parsedUrl(req);
    for (const key of url.searchParams.keys()) {
      if (!CARD_QUERY_KEYS.has(key)) return sendJson(res, 400, { code: 'CARDS_QUERY_INVALID' });
    }
    const limitText = url.searchParams.get('limit');
    const limit = limitText === null ? 20 : Number(limitText);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) return sendJson(res, 400, { code: 'CARDS_QUERY_INVALID' });
    const sort = url.searchParams.get('sort') ?? 'recent';
    if (!['recent', 'buyback-desc', 'buyback-asc'].includes(sort)) return sendJson(res, 400, { code: 'CARDS_QUERY_INVALID' });
    try {
      const { cards, nextCursor } = ctx.sqliteProjection.listCards({
        productId: url.searchParams.get('productId'),
        rarity: url.searchParams.get('rarity'),
        from: url.searchParams.get('from'),
        to: url.searchParams.get('to'),
        minBuybackMicroUsdg: url.searchParams.get('minBuybackMicroUsdg'),
        maxBuybackMicroUsdg: url.searchParams.get('maxBuybackMicroUsdg'),
        sort,
        cursor: url.searchParams.get('cursor'),
        limit,
      });
      const total = ctx.sqliteProjection.countCards();
      sendJson(res, 200, assertCardsResponse({ cards, nextCursor, historyComplete: total === cards.length && nextCursor === null }));
    } catch (error) {
      ctx.onError?.('operator-cards', error);
      sendJson(res, 503, { code: 'OPERATOR_CARDS_UNAVAILABLE' });
    }
  };
}

export function createAuditHandler(ctx) {
  return async function auditHandler(req, res) {
    const identity = await authenticate(req, res, ctx);
    if (!identity) return;
    if (req.method !== 'GET') return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED' });
    const url = parsedUrl(req);
    const cursorText = url.searchParams.get('cursor');
    if (cursorText !== null && !/^[1-9]\d*$/.test(cursorText)) return sendJson(res, 400, { code: 'AUDIT_QUERY_INVALID' });
    const limitText = url.searchParams.get('limit');
    const limit = limitText === null ? 25 : Number(limitText);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return sendJson(res, 400, { code: 'AUDIT_QUERY_INVALID' });
    try {
      const body = ctx.sqliteProjection.listAuditEntries({ cursor: cursorText === null ? null : Number(cursorText), limit });
      const decisions = body.decisions.map(entry => ({ ...entry, sequence: String(entry.sequence) }));
      sendJson(res, 200, assertAuditResponse({ decisions, nextCursor: body.nextCursor === null ? null : String(body.nextCursor) }));
    } catch (error) {
      ctx.onError?.('operator-audit', error);
      sendJson(res, 503, { code: 'OPERATOR_AUDIT_UNAVAILABLE' });
    }
  };
}

export function createDecisionsHandler(ctx) {
  return async function decisionsHandler(req, res) {
    const identity = await authenticate(req, res, ctx);
    if (!identity) return;
    if (req.method !== 'POST') return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED' });

    let request;
    try {
      request = readDecisionRequest(JSON.parse(await readBoundedBody(req)));
    } catch (error) {
      if (error?.code === 'BODY_TOO_LARGE') return sendJson(res, 413, { code: 'DECISION_BODY_TOO_LARGE' });
      return sendJson(res, 400, { code: error instanceof ContractValidationError ? error.code : 'DECISION_BODY_INVALID' });
    }

    try {
      const observed = await loadAuthorityStatus(ctx);
      const audit = await executeAuditedCommand({
        path: ctx.auditLogPath,
        requestId: request.requestId,
        expectedVersion: request.expectedVersion,
        observedVersion: observed.revision ?? 0,
        command: request.command,
        resultCode: receiptResultCode(request.command, observed),
        actor: { email: identity.email },
        actorRole: 'operator',
        note: request.note,
        now: ctx.now,
        effect: async receipt => {
          await projectDurableAuditReceipt(ctx, receipt);
          try {
            return await applyDecision({
              requestId: request.requestId,
              expectedVersion: request.expectedVersion,
              command: request.command,
              operatorControl: ctx.operatorControl,
            });
          } catch (error) {
            if (isDeterministicAuthorityRejection(error)) return { auditCommandState: 'REJECTED' };
            throw error;
          }
        },
      });

      await projectDurableAuditReceipt(ctx, audit.receipt);

      let state = null;
      try {
        const current = await loadAuthorityStatus(ctx);
        state = buildBootstrap({ authorityStatus: current, identity: identityFor(identity.email) }).state;
      } catch (error) {
        ctx.onError?.('operator-decision-status', error);
      }
      sendJson(res, auditCommandHttpStatus(audit.commandState), {
        code: audit.receipt.resultCode,
        eventId: audit.receipt.eventId,
        replayed: audit.replayed,
        receipt: audit.receipt,
        commandState: audit.commandState,
        state,
      });
    } catch (error) {
      if (error instanceof AuditRequestConflict) return sendJson(res, 409, { code: error.code });
      if (unavailable(res, error)) return;
      if (error instanceof AuditedCommandEffectError) {
        await projectDurableAuditReceipt(ctx, error.receipt);
        ctx.onError?.('operator-decision-effect', error.cause ?? error);
        return sendJson(res, auditCommandHttpStatus(error.commandState), {
          code: error.receipt.resultCode,
          receipt: error.receipt,
          commandState: error.commandState,
        });
      }
      ctx.onError?.('operator-decision', error);
      sendJson(res, 503, { code: 'OPERATOR_DECISION_UNAVAILABLE' });
    }
  };
}
