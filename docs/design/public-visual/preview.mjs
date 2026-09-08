import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve, extname, sep } from "node:path";

const publicRoot = resolve(fileURLToPath(new URL("../../../apps/web/public/", import.meta.url)));
const css = new URL("./public-visual.css", import.meta.url);
const mime = { ".html": "text/html", ".css": "text/css", ".mjs": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp", ".jpg": "image/jpeg", ".mp3": "audio/mpeg" };
// Local design preview only. No API proxy, credentials, or production route changes.
createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (request.method !== "GET" || url.pathname.startsWith("/api/") || url.pathname.startsWith("/operator")) {
    response.writeHead(404).end();
    return;
  }
  try {
    if (url.pathname === "/public-visual.css") {
      response.writeHead(200, { "content-type": "text/css" }).end(await readFile(css));
      return;
    }
    const path = resolve(publicRoot, "." + (url.pathname === "/" ? "/comic-production/index.html" : url.pathname));
    if (!path.startsWith(publicRoot + sep)) {
      response.writeHead(404).end();
      return;
    }
    let body = await readFile(path);
    if (url.pathname === "/") {
      let html = body.toString();
      // Both views are static: retain original markup, omit live data and animation scripts.
      html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
      if (!url.searchParams.has("baseline")) {
        html = html.replace('<html lang="en">', '<html lang="en" data-public-visual>');
        html = html.replace("</head>", '<link rel="stylesheet" href="/public-visual.css"></head>');
      }
      body = html;
    }
    response.writeHead(200, { "content-type": mime[extname(path)] || "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch {
    response.writeHead(404).end();
  }
}).listen(4179, "127.0.0.1", () => console.log("Design: http://127.0.0.1:4179/ | Original: http://127.0.0.1:4179/?baseline"));
