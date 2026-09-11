import { proxyCredentialMatches } from '../auth/proxy-credential.mjs';
import { sendJson } from './public.mjs';
import { unavailableManualCycle } from '../../../runner/src/operator/manual-cycle.mjs';

export function createManualCycleHandler(ctx) {
  return async (req, res) => {
    const credential = req.headers['x-hookemon-proxy-credential'];
    if (!proxyCredentialMatches(Array.isArray(credential) ? credential[0] : credential, ctx.proxyCredential)) {
      return sendJson(res, 401, { code: 'PROXY_CREDENTIAL_REQUIRED' });
    }
    let actor = 'local-operator';
    if (ctx.accessJwtVerifier) {
      const assertion = req.headers['cf-access-jwt-assertion'];
      const token = Array.isArray(assertion) ? assertion[0] : assertion;
      if (!token) return sendJson(res, 401, { code: 'ACCESS_ASSERTION_REQUIRED' });
      try {
        const payload = await ctx.accessJwtVerifier(token);
        if (typeof payload.email === 'string') actor = payload.email;
      }
      catch { return sendJson(res, 401, { code: 'ACCESS_ASSERTION_INVALID' }); }
    }
    if (req.method === 'GET') {
      const result = ctx.manualCycleControl ? await ctx.manualCycleControl.status() : unavailableManualCycle();
      if (typeof ctx.readManualCycleHolders === 'function') {
        try { result.holderSnapshot = await ctx.readManualCycleHolders(); }
        catch { result.holderSnapshot = { status: 'unavailable', recipients: [], finalized: false,
          reasons: ['HOLDER_SNAPSHOT_UNAVAILABLE'] }; }
      }
      return sendJson(res, 200, result);
    }
    if (req.method !== 'POST') return sendJson(res, 405, { code: 'METHOD_NOT_ALLOWED' });
    if (!ctx.manualCycleControl) return sendJson(res, 503, { ...unavailableManualCycle(), code: 'MANUAL_RUNTIME_NOT_CONNECTED' });
    let input;
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 4096) return sendJson(res, 413, { code: 'BODY_TOO_LARGE' });
        chunks.push(chunk);
      }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!input || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'expectedRevision,requestId') throw new Error();
    } catch { return sendJson(res, 400, { code: 'INVALID_MANUAL_REQUEST' }); }
    try {
      const result = await ctx.manualCycleControl.request({ ...input, actor });
      return sendJson(res, result.httpStatus, result.body);
    } catch {
      return sendJson(res, 503, { code: 'MANUAL_REQUEST_UNCERTAIN', ready: false,
        reasons: ['Refresh status using the same request ID; do not assume the request was rejected.'] });
    }
  };
}
