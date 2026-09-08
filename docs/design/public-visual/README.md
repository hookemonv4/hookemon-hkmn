# Public website visual proposal

This isolated proposal makes the hero easier to read over the existing illustrated landscape. DM Sans gives the main heading and FAQ a clear hierarchy; Lilita One remains on the adventure heading. A softer landscape and a warm paper background reduce competition with the copy. Font sizes step at fixed breakpoints.

Run `node docs/design/public-visual/preview.mjs` from the repository root. Open `http://127.0.0.1:4179/` for the proposal and `http://127.0.0.1:4179/?baseline` for the original. The server binds to loopback only. It reads existing public assets without modifying them and removes scripts in both views. Live data, motion, and operator behavior are not part of this static preview. Stop it with Ctrl-C.

## Ownership and integration

The base is `b2cb737a298522e3944652e862c4eeab195667d8`, fetched from origin/main on 2026-09-08. The homepage is served from `apps/web/public/comic-production/index.html`; the React fallback is `apps/web/app/page.tsx`. The existing website module card still describes a standalone repository, so source and Worker routing were checked directly.

PR43 (`codex/eth-interface-20260908`) modifies both homepage files. The ledger associates ETH-UI with `eth-ui-worker-20260908`, fencing token 1. PR43 also modifies the static dashboard script, React dashboard components, and operator controls. Its ownership document is explicitly a proposal, not a live assignment. No existing task assignment or lease was changed for this design preparation.

The exact collision for a production implementation is `apps/web/public/comic-production/index.html`: it contains the font links and would need the stylesheet link and opt-in marker. The React alternative would collide with `apps/web/app/page.tsx`. This proposal therefore changes neither file and is not wired into the production asset pipeline.

When file ownership is released, the smallest integration is a dedicated public stylesheet plus the opt-in marker and stylesheet link in the static homepage. Keep all selectors restricted to marketing sections. Do not put these styles in `globals.css`, `hoenn-theme.css`, or `layout.tsx`, which also reach the operator interface. Keep dashboard font tokens and inherited body styles unchanged. Both existing font families and their original Google Fonts display=swap request are reused; no extra font request or preload is introduced.

## Verification

Chromium comparison at widths 320, 360, 390, 430, 768, 1024, 1280, 1440, and 1920 found no horizontal page overflow. Additional checks used 320x568, 390x844, and 780x360. Desktop and phone screenshots were visually inspected. Every computed CSS property of the dashboard and its descendants matched the baseline at all nine widths. The font stylesheet and WOFF2 request sets matched after fonts settled, including a repeat at 320px.

`node --check docs/design/public-visual/preview.mjs` passed. With Node 24, `node --test apps/web/tests/comic-production.test.mjs apps/web/tests/comic-scroll.test.mjs` passed all 25 tests. No application build was run because no application source or build input changed. This evidence covers the static proposal; it does not claim production integration or live dashboard validation.
