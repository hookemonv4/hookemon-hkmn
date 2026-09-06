import test from "node:test";
import assert from "node:assert/strict";
import { publicPageResponse } from "../worker/public-page-routes.ts";

for (const page of ["packs", "cycles", "holders", "transparency"]) {
  test(`${page} serves its allowlisted asset and HEAD omits its body`, async () => {
    const seen = [];
    const assets = { fetch: async (request) => {
      seen.push(request);
      return new Response("page", { headers: { "content-type": "text/html" } });
    } };
    for (const method of ["GET", "HEAD"]) {
      const response = await publicPageResponse(new Request(`https://hookemon.com/${page}`, { method }), assets);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), method === "HEAD" ? "" : "page");
      assert.equal(response.headers.get("content-location"), `/${page}`);
      assert.equal(response.headers.get("cache-control"), "public, max-age=0, must-revalidate");
      assert.equal(seen.at(-1).url, `https://hookemon.com/comic-production/${page}.html`);
      assert.equal(seen.at(-1).method, method);
    }
  });
}

test("trailing slash redirects preserve the query without fetching an asset", async () => {
  const response = await publicPageResponse(new Request("https://hookemon.com/packs/?category=rare"), {
    fetch: () => assert.fail("unexpected fetch"),
  });
  assert.equal(response.status, 308);
  assert.equal(response.headers.get("location"), "https://hookemon.com/packs?category=rare");
});

test("unsupported methods cannot fetch public assets", async () => {
  const response = await publicPageResponse(new Request("https://hookemon.com/holders/", { method: "POST" }), {
    fetch: () => assert.fail("unexpected fetch"),
  });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});

test("unrecognized paths remain owned by the existing router", async () => {
  for (const path of ["/swap", "/packs/secret", "/constructor", "/packs//", "/api/packs"]) {
    assert.equal(await publicPageResponse(new Request(`https://hookemon.com${path}`), {
      fetch: () => assert.fail("unexpected fetch"),
    }), null);
  }
});

test("missing assets keep their error status", async () => {
  const response = await publicPageResponse(new Request("https://hookemon.com/cycles"), {
    fetch: async () => new Response("Missing", { status: 404 }),
  });
  assert.equal(response.status, 404);
});
