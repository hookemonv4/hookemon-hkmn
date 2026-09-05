export type OperatorProxyEnv = Pick<
  Env,
  "OPERATOR_CONTROL_SERVICE_URL" | "OPERATOR_CONTROL_PROXY_CREDENTIAL"
>;

const MAX_BODY_BYTES = 32_768;
const ROUTES = new Map([
  ["/operator/api/bootstrap", "GET"],
  ["/operator/api/dashboard", "GET"],
  ["/operator/api/cards", "GET"],
  ["/operator/api/audit", "GET"],
  ["/operator/api/decisions", "POST"],
]);
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "origin",
  "sec-fetch-site",
  "x-hookemon-request",
  "x-hookemon-request-id",
  "cf-access-jwt-assertion",
] as const;
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "x-hookemon-request-id",
] as const;

export function operatorPageAuthorized(request: Request): boolean {
  const assertion = request.headers.get("cf-access-jwt-assertion");
  return typeof assertion === "string" && assertion.length > 0 && assertion.trim() === assertion;
}

export function operatorAccessRequiredResponse(): Response {
  return jsonResponse(401, "ACCESS_ASSERTION_REQUIRED");
}

export async function proxyOperatorRequest(
  request: Request,
  env: OperatorProxyEnv,
): Promise<Response> {
  if (!operatorPageAuthorized(request)) return operatorAccessRequiredResponse();

  const requestUrl = new URL(request.url);
  const expectedMethod = ROUTES.get(requestUrl.pathname);
  if (!expectedMethod) return jsonResponse(404, "OPERATOR_ROUTE_NOT_FOUND");
  if (request.method !== expectedMethod) {
    return jsonResponse(405, "OPERATOR_METHOD_NOT_ALLOWED");
  }
  if (!operatorQueryValid(requestUrl)) {
    return jsonResponse(400, "OPERATOR_QUERY_INVALID");
  }

  const copiedBody = await boundedRequestBody(request);
  if (copiedBody.error) return jsonResponse(copiedBody.error.status, copiedBody.error.code);

  const headers = new Headers();
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const upstream = operatorUpstream(env, requestUrl);
  if (!upstream) return jsonResponse(503, "OPERATOR_CONTROL_UNAVAILABLE");
  headers.set("x-hookemon-proxy-credential", env.OPERATOR_CONTROL_PROXY_CREDENTIAL);

  const privateRequest = new Request(upstream, {
    method: request.method,
    headers,
    body: copiedBody.body,
    redirect: "manual",
  });

  try {
    const response = await fetch(privateRequest);
    if (response.status >= 300 && response.status < 400) {
      return jsonResponse(502, "OPERATOR_CONTROL_INVALID");
    }
    return sanitizedBindingResponse(response);
  } catch {
    return jsonResponse(503, "OPERATOR_CONTROL_UNAVAILABLE");
  }
}

function operatorUpstream(env: OperatorProxyEnv, requestUrl: URL): URL | null {
  if (
    typeof env.OPERATOR_CONTROL_PROXY_CREDENTIAL !== "string" ||
    env.OPERATOR_CONTROL_PROXY_CREDENTIAL.length < 32 ||
    env.OPERATOR_CONTROL_PROXY_CREDENTIAL.length > 512 ||
    env.OPERATOR_CONTROL_PROXY_CREDENTIAL.trim() !== env.OPERATOR_CONTROL_PROXY_CREDENTIAL
  ) {
    return null;
  }
  try {
    const base = new URL(env.OPERATOR_CONTROL_SERVICE_URL);
    if (
      base.protocol !== "https:" ||
      base.username ||
      base.password ||
      base.search ||
      base.hash ||
      !new Set(["", "/"]).has(base.pathname)
    ) {
      return null;
    }
    return new URL(`${requestUrl.pathname}${requestUrl.search}`, base);
  } catch {
    return null;
  }
}

function operatorQueryValid(url: URL): boolean {
  if (url.pathname === "/operator/api/cards") return cardQueryValid(url.searchParams);
  if (url.pathname !== "/operator/api/audit") return url.search.length === 0;

  const keys = [...url.searchParams.keys()];
  if (
    keys.some((key) => key !== "cursor" && key !== "limit") ||
    new Set(keys).size !== keys.length
  ) {
    return false;
  }
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null && !/^[1-9]\d*$/.test(cursor)) return false;
  const limitText = url.searchParams.get("limit");
  if (limitText === null) return true;
  const limit = Number(limitText);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= 100;
}

const CARD_QUERY_KEYS = new Set([
  "cursor",
  "limit",
  "sort",
  "cycleId",
  "productId",
  "rarity",
  "from",
  "to",
  "minBuybackMicroUsdc",
  "maxBuybackMicroUsdc",
]);
const CARD_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const CARD_MONEY_PATTERN = /^(0|[1-9]\d{0,77})$/;
const CARD_CURSOR_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

function cardQueryValid(searchParams: URLSearchParams): boolean {
  const keys = [...searchParams.keys()];
  if (
    keys.some((key) => !CARD_QUERY_KEYS.has(key)) ||
    new Set(keys).size !== keys.length
  ) return false;

  const limitText = searchParams.get("limit");
  if (limitText !== null) {
    const limit = Number(limitText);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) return false;
  }

  const sort = searchParams.get("sort");
  if (sort !== null && !new Set(["recent", "buyback-desc", "buyback-asc"]).has(sort)) {
    return false;
  }

  const cursor = searchParams.get("cursor");
  if (cursor !== null && !CARD_CURSOR_PATTERN.test(cursor)) return false;
  for (const key of ["cycleId", "productId"]) {
    const value = searchParams.get(key);
    if (value !== null && !CARD_ID_PATTERN.test(value)) return false;
  }

  const rarity = searchParams.get("rarity");
  if (
    rarity !== null &&
    (rarity.length < 1 || rarity.length > 128 || rarity.trim() !== rarity || /[\u0000-\u001f\u007f]/.test(rarity))
  ) return false;

  for (const key of ["from", "to"]) {
    const value = searchParams.get(key);
    if (value !== null && !validCardTimestamp(value)) return false;
  }
  for (const key of ["minBuybackMicroUsdc", "maxBuybackMicroUsdc"]) {
    const value = searchParams.get(key);
    if (value !== null && !CARD_MONEY_PATTERN.test(value)) return false;
  }
  return true;
}

function validCardTimestamp(value: string): boolean {
  if (value.length !== 24) return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

async function boundedRequestBody(request: Request): Promise<
  | { body: ArrayBuffer | undefined; error?: never }
  | { body?: never; error: { status: number; code: string } }
> {
  if (request.method !== "POST") return { body: undefined };

  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return { error: { status: 413, code: "OPERATOR_BODY_TOO_LARGE" } };
  }
  if (request.body === null) return { body: new ArrayBuffer(0) };

  const chunks: Uint8Array[] = [];
  const reader = request.body.getReader();
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { error: { status: 413, code: "OPERATOR_BODY_TOO_LARGE" } };
      }
      chunks.push(value);
    }
  } catch {
    return { error: { status: 400, code: "OPERATOR_BODY_INVALID" } };
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { body: body.buffer };
}

function sanitizedBindingResponse(response: Response): Response {
  const headers = new Headers({
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = response.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    headers,
  });
}

function jsonResponse(status: number, code: string): Response {
  return Response.json(
    { code },
    {
      status,
      headers: {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
