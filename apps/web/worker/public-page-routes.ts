const PUBLIC_PAGES: Readonly<Record<string, string>> = Object.freeze({
  "/packs": "/comic-production/packs.html",
  "/cycles": "/comic-production/cycles.html",
  "/holders": "/comic-production/holders.html",
  "/transparency": "/comic-production/transparency.html",
});

/** Fixed informational routes only; never derive an asset path from user input. */
export async function publicPageResponse(
  request: Request,
  assets: { fetch(request: Request): Promise<Response> },
): Promise<Response | null> {
  const url = new URL(request.url);
  const canonical = url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  if (!Object.hasOwn(PUBLIC_PAGES, canonical)) return null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
  }
  if (url.pathname !== canonical) {
    url.pathname = canonical;
    return Response.redirect(url, 308);
  }
  const response = await assets.fetch(new Request(new URL(PUBLIC_PAGES[canonical], url), {
    method: request.method,
    headers: request.headers,
  }));
  const headers = new Headers(response.headers);
  headers.set("cache-control", "public, max-age=0, must-revalidate");
  headers.set("content-location", canonical);
  headers.set("x-content-type-options", "nosniff");
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
