import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import {
  normalizeCollectorCards,
  prioritizeCollectorCards,
} from "../lib/collector-cards.ts";
import * as collectorCardHelpers from "../lib/collector-cards.ts";
import { resolveMetadataBase } from "../lib/metadata.ts";

const templateRoot = new URL("../", import.meta.url);
const comicHtml = (await readFile(
  new URL("../public/comic-production/index.html", import.meta.url),
  "utf8",
)).replace(/>\s+</g, "><").replace(/\s+/g, " ");
const showcaseImages = [
  "https://d1xpxki1g4htqu.cloudfront.net/G7-UpVecMsF9fyxKMoVun6yRqahg-2fDLtHvwS9Lt34",
  "https://d1xpxki1g4htqu.cloudfront.net/A7Vvp6B8ov3_jFmjR-gFmW2wf3J93_oL67PgCYK8Sn4",
  "https://d1xpxki1g4htqu.cloudfront.net/-bohVu_T0vqivMHLHBvJq46JcuPFl0N3g-QWI2uIBHY",
];

async function render(path = "/", env = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(new URL(path, "http://localhost/"), {
      headers: { accept: path.startsWith("/api/") ? "application/json" : "text/html" },
    }),
    {
      ASSETS: {
        fetch: async (assetRequest) => {
          const assetUrl = new URL(assetRequest.url);
          if (assetUrl.pathname !== "/comic-production/index.html") {
            return new Response("Not found", { status: 404 });
          }
          return new Response(assetRequest.method === "HEAD" ? null : comicHtml, {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        },
      },
      ...env,
    },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

async function withMockedFetch(fetchImpl, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function collectorInventoryCard({
  id,
  rarity,
  insuredValue = 245,
  image = `https://images.example/${id}.jpg`,
}) {
  const attributes = [
    { value: "Card", trait_type: "Type" },
    { value: "Pokemon", trait_type: "Category" },
    { value: "2019", trait_type: "Year" },
    { value: String(insuredValue), trait_type: "Insured Value" },
    { value: "PSA Vault", trait_type: "Vault" },
    { value: "PSA Vault, New Castle, DE", trait_type: "Location" },
    { value: `vault-${id}`, trait_type: "Vault ID" },
    { value: `grade-${id}`, trait_type: "Grading ID" },
    { value: "PSA", trait_type: "Grading Company" },
    { value: "NM-MT 8", trait_type: "The Grade" },
    { value: "true", trait_type: "Authenticated" },
    { value: "8", trait_type: "GradeNum" },
  ];

  return {
    nft_address: id,
    name: "2003 #25 Politoed-Reverse Foil PSA 8",
    description: "2003 #25 Politoed-Reverse Foil PSA 8 Skyridge Pokemon",
    rarity,
    attributes,
    image,
    insured_value: insuredValue,
    id,
    content: {
      files: [
        { uri: image, cdn_uri: image, cc_cdn: image },
        {
          uri: `https://images.example/${id}-back.jpg`,
          cdn_uri: `https://images.example/${id}-back.jpg`,
          cc_cdn: `https://images.example/${id}-back.jpg`,
        },
      ],
      metadata: { name: "2003 #25 Politoed-Reverse Foil PSA 8", attributes },
    },
    ownership: { owner: "collector-owner" },
    taggedAt: "2026-08-06T00:00:00.000Z",
    justLanded: false,
    gradePopulation: 208,
    cardYear: "2019",
    parallel: "Base",
    gemGrade: "g8",
  };
}

test("prioritizes valid Collector card values without mutating stable ties", () => {
  const cards = [
    { id: "missing" },
    { id: "tie-a", insuredValueUsd: 500 },
    { id: "invalid-zero", insuredValueUsd: 0 },
    { id: "tie-b", insuredValueUsd: 500 },
    { id: "lower", insuredValueUsd: 100 },
    { id: "invalid-nan", insuredValueUsd: Number.NaN },
  ];
  const originalOrder = cards.map(({ id }) => id);

  const prioritized = prioritizeCollectorCards(cards);

  assert.deepEqual(
    prioritized.map(({ id }) => id),
    ["tie-a", "tie-b", "lower", "missing", "invalid-zero", "invalid-nan"],
  );
  assert.deepEqual(cards.map(({ id }) => id), originalOrder);
});

test("removes duplicate Collector cards by ID and trimmed image URL", () => {
  const sharedImage = "https://images.example/shared-card.jpg";
  const cards = normalizeCollectorCards({
    nfts: [
      collectorInventoryCard({ id: "first-card", rarity: "epic", image: sharedImage }),
      collectorInventoryCard({ id: "duplicate-id", rarity: "rare" }),
      collectorInventoryCard({ id: "duplicate-id", rarity: "uncommon" }),
      collectorInventoryCard({
        id: "duplicate-image",
        rarity: "common",
        image: `  ${sharedImage}  `,
      }),
    ],
  });

  assert.deepEqual(cards.map(({ id }) => id), ["first-card", "duplicate-id"]);
  assert.equal(new Set(cards.map(({ imageUrl }) => imageUrl.trim())).size, cards.length);
});

test("collector presentation keeps active and background cards unique", () => {
  assert.equal(typeof collectorCardHelpers.selectCollectorPresentation, "function");

  const cards = [
    { id: "premium", imageUrl: "https://images.example/premium.jpg", insuredValueUsd: 4_000 },
    { id: "second", imageUrl: "https://images.example/second.jpg", insuredValueUsd: 900 },
    { id: "second", imageUrl: "https://images.example/duplicate-id.jpg", insuredValueUsd: 800 },
    { id: "third", imageUrl: "https://images.example/third.jpg", insuredValueUsd: 500 },
    { id: "duplicate-image", imageUrl: "  https://images.example/third.jpg  ", insuredValueUsd: 300 },
    { id: "fourth", imageUrl: "https://images.example/fourth.jpg", insuredValueUsd: 100 },
  ];

  const presentation = collectorCardHelpers.selectCollectorPresentation(cards, 0, 3);
  const visibleCards = [presentation.activeCard, ...presentation.backgroundCards].filter(Boolean);

  assert.equal(presentation.activeCard?.id, "premium");
  assert.equal(visibleCards.length, 4);
  assert.equal(new Set(visibleCards.map(({ id }) => id.trim())).size, visibleCards.length);
  assert.equal(
    new Set(visibleCards.map(({ imageUrl }) => imageUrl.trim())).size,
    visibleCards.length,
  );
});

test("collector presentation rotates the complete unique deck with wrapped indexes", () => {
  assert.equal(typeof collectorCardHelpers.selectCollectorPresentation, "function");

  const cards = Array.from({ length: 6 }, (_, index) => ({
    id: `card-${index}`,
    imageUrl: `https://images.example/card-${index}.jpg`,
    insuredValueUsd: 600 - index * 50,
  }));
  const presentations = Array.from({ length: cards.length }, (_, index) =>
    collectorCardHelpers.selectCollectorPresentation(cards, index, 3),
  );

  assert.deepEqual(
    presentations.map(({ activeCard }) => activeCard?.id),
    cards.map(({ id }) => id),
  );
  assert.equal(
    collectorCardHelpers.selectCollectorPresentation(cards, cards.length, 3).activeCard?.id,
    cards[0].id,
  );
  assert.ok(
    presentations.every(({ activeCard, backgroundCards }) =>
      backgroundCards.every(({ id }) => id !== activeCard?.id),
    ),
  );
});

test("server-renders the complete illustrated Hookemon page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Hookemon — Every pack\. A new adventure\.<\/title>/);
  assert.match(html, /Hookemon buys gacha card packs, opens them, sells the cards and pays the proceeds to HKMN holders\. Trading fees fund the packs\./);
  assert.match(html, /id="top"[\s\S]*id="machine"[\s\S]*id="journey"[\s\S]*id="cards"[\s\S]*id="economics"[\s\S]*id="faq"/);
  assert.doesNotMatch(html, /href="\/swap(?:[/?#]|")/i);
  assert.doesNotMatch(html, /react-loading-skeleton|Your site is taking shape|<video\b/i);
});

test("keeps public claims tied to variable proceeds and verified data", async () => {
  const html = await (await render()).text();
  assert.match(html, /Distributions depend on actual card sale proceeds, costs, reserves and holder eligibility/);
  assert.match(html, /a cycle may have no distributable proceeds/);
  assert.match(html, /when a verified schedule is available/);
  assert.match(html, /not completed Hookemon pulls or a promise of future pack contents/);
  assert.doesNotMatch(html, /guaranteed (?:profit|income|returns)|risk.free|passive income|every 20 minutes|Top 200/i);
  assert.doesNotMatch(html, /Prototype · Simulator/i);
});

test("states the gross-volume fee and its complete split", async () => {
  const html = await (await render()).text();
  assert.ok(html.includes("3,00 % auf Brutto‑Volumen"));
  for (const amount of ["0,10 %", "0,40 %", "2,50 %"]) assert.ok(html.includes(amount));
  for (const recipient of ["Programmable", "Treasury", "Card packs"]) assert.ok(html.includes(recipient));
  assert.doesNotMatch(html, /fee on the USDG side|97%[^<]*continues into the pool swap/i);
  assert.doesNotMatch(html, /data-w="97"/);
});

test("explains holder payouts without displaying an invented payout receipt", async () => {
  const html = await (await render()).text();
  const scene = html.slice(html.indexOf('id="story-payout"'), html.indexOf('class="scene-bottom'));
  assert.match(scene, /Proceeds → eligible holders/);
  assert.match(scene, /HKMN holder/);
  assert.doesNotMatch(scene, /(?:\d+\.\d{2})\s*USDG|Paid successfully|confirmed transaction/i);
  assert.match(html, /Illustrative cycle · example cards/);
});

test("keeps the product accessible with native navigation and informational controls", async () => {
  const html = await (await render()).text();
  assert.match(html, /<html[^>]*lang="en"/i);
  assert.match(html, /<main id="main">/);
  assert.match(html, /<nav[^>]*aria-label="Primary navigation"/);
  assert.match(html, /class="skip-link" href="#main"/);
  for (const id of ["journey", "machine", "economics", "faq"]) assert.ok(html.includes('id="' + id + '"'));
  assert.doesNotMatch(html, /href="\/swap(?:[/?#]|")/i);
  assert.doesNotMatch(html, /<button[^>]*>\s*(?:Claim|Pause|Run now)/i);
});

test("returns 404 for the removed swap route without exposing trading controls", async () => {
  const response = await render("/swap");
  assert.equal(response.status, 404);

  const html = await response.text();
  assert.doesNotMatch(html, /SwapPanel|Connect wallet|Swap whole amount|Exact input|Exact output/i);
});

test("server-renders the live cycle tracker with unavailable initial states", async () => {
  const html = await (await render()).text();
  assert.match(html, /Cycle overview/);
  assert.match(html, /Next cycle/);
  assert.match(html, /id="dashboardStatus"[^>]*>Connecting to cycle data…/);
  assert.match(html, /id="metricCountdown">--:--/);
  assert.match(html, /Awaiting a verified pool observation/);
  assert.match(html, /Schedule not reported/);
  assert.match(html, /src="\/comic-production\/dashboard\.mjs"/);
});

test("renders the public dashboard between the hero and journey with semantic lifecycle facts", async () => {
  const html = await (await render()).text();
  assert.match(html, /id="top"[\s\S]*id="machine"[\s\S]*id="journey"/);
  for (const label of ["Current pot", "Latest cycle payout", "Average per recipient", "Next cycle", "Total actually paid", "Completed cycles", "Skipped cycles", "Packs opened", "Fees collected", "Pack budget", "Packs bought", "Cards revealed", "Cards sold", "Proceeds back", "Holders paid"]) {
    assert.ok(html.includes(label), label);
  }
  assert.equal((html.match(/data-step="[^"]+" data-state="waiting"/g) ?? []).length, 7);
  assert.match(html, /No verified card results reported/);
  for (const id of ["metricTotalPaid", "metricCompletedCycles", "metricSkippedCycles", "metricPacks"]) {
    assert.ok(html.includes(`id="${id}">—`), id);
  }
  assert.match(html, /Awaiting verified history/);
  assert.doesNotMatch(html, /<button[^>]*>\s*(?:Claim|Pause|Run now)/i);
});

test("renders profile-aware community totals beside the live cycle", async () => {
  const [source, css] = await Promise.all([
    readFile(new URL("../app/PublicCycleTracker.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/PublicCycleTracker.module.css", import.meta.url), "utf8"),
  ]);

  assert.equal((source.match(/fetch\("\/api\/community-dashboard"/g) ?? []).length, 1);
  assert.equal((source.match(/credentials:\s*"omit"/g) ?? []).length, 2);
  assert.match(source, /normalizePublicCommunitySnapshot/);
  assert.match(source, /resolveDashboardPresentation/);
  assert.match(source, /dashboardCommunity\?\.badge/);
  assert.match(source, /community:\s*dashboardCommunity/);
  assert.match(source, /NETWORK UNAVAILABLE/);
  assert.match(source, /Cycle funding/);
  assert.match(source, /Collector spend/);
  assert.match(source, /Buybacks returned/);
  assert.match(source, /Latest round actually paid/);
  assert.doesNotMatch(source, /label="Holder rewards paid"/);
  assert.match(source, /historyMoney/);
  assert.match(source, /History incomplete/);
  assert.match(source, /Retained reserve/);
  assert.match(source, /Completed cycles/);
  assert.match(source, /Skipped cycles/);
  assert.match(source, /Packs opened/);
  assert.match(source, /Last pool observation/);
  assert.match(source, /Last verified snapshot/);
  assert.match(source, /latestDashboardCards\(cycle, dashboardCommunity\)/);
  assert.match(css, /\.testnetBadge/);
  assert.match(css, /\.primaryMetrics/);
  assert.match(css, /\.process/);
  assert.match(css, /\.communityMetrics/);
  assert.match(css, /minmax\(0,\s*1fr\)/);
  assert.match(css, /overflow-wrap:\s*anywhere/);
});

test("renders a complete and truthful latest Holder Rewards round", async () => {
  const source = await readFile(new URL("../app/PublicCycleTracker.tsx", import.meta.url), "utf8");

  assert.match(source, /aria-label="Latest Holder Rewards round"/);
  for (const label of [
    "Pack spend",
    "Buyback",
    "Pack gain",
    "Pack loss",
    "Wallet before",
    "Wallet after",
    "Quoted outbound bridge",
    "Quoted inbound bridge",
    "Quoted Collector API",
    "Quoted Ethereum network",
    "Quoted Solana network",
    "Quoted slippage",
    "Protected cost forecast",
    "Confirmed costs",
    "Purchase transaction fee",
    "Buyback transaction fee",
    "Player wallet fee",
    "Reserve before",
    "Reserve target (50%)",
    "Reserve top-up",
    "Reserve after",
    "Planned Holder Rewards",
    "Actually paid",
    "Eligible allocations",
    "Complete cycle gain",
    "Complete cycle loss",
  ]) assert.match(source, new RegExp(label.replace(/[()]/g, "\\$&")));
  assert.match(source, /Awaiting confirmed receipts/);
  assert.match(source, /Not executed in this pack check/);
  assert.match(source, /Fee evidence unavailable/);
  assert.match(source, /lamports/);
  assert.match(source, /Paid by/);
  assert.match(source, /Name pending/);
  assert.match(source, /Set: \{card\.setName \?\? "pending"\}/);
  assert.match(source, /Card number: \{card\.cardNumber \?\? "pending"\}/);
  assert.match(source, /Image pending/);
  assert.match(
    source,
    /<span>Paid<\/span>[\s\S]*roundAccounting\s*\?[\s\S]*roundAccounting\.paidHolderRewardsMicroUsdc[\s\S]*roundAccounting\.distributionStatus/,
  );
  assert.doesNotMatch(source, /label="(?:Donation|Spende|Guaranteed profit|Holder Rewards)"/i);
});

test("keeps dashboard presentation credential-free and free of partial network facts", async () => {
  const [html, source, page, viewSource] = await Promise.all([
    render().then((response) => response.text()),
    readFile(new URL("../app/PublicCycleTracker.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/public-dashboard-view.ts", import.meta.url), "utf8"),
  ]);

  assert.match(source, /resolveDashboardPresentation/);
  assert.match(viewSource, /dashboardFeedState/);
  assert.doesNotMatch(source, /function resolveConnectionState/);
  assert.match(source, /hasLatestPayoutFacts\(latestCycle\)/);
  assert.match(source, /card\.cardName \?\? "Name pending"/);
  assert.match(html, /Connecting to cycle data/i);
  assert.doesNotMatch(html, /Latest verified payout/i);
  assert.doesNotMatch(page, /canonical HOOKEMON \/ USDC pool runs/i);
  assert.match(page, /protocol design routes HOOKEMON \/ USDC swaps through one immutable Uniswap v4 hook/i);
});

test("keeps the visible testnet disclosure free of mainnet labeling", async () => {
  const source = await readFile(new URL("../app/PublicCycleTracker.tsx", import.meta.url), "utf8");
  const disclosure = source.match(
    /if \(environment\.profile === "testnet"\) \{\s*return <span>([^<]+)<\/span>;/,
  );

  assert.ok(disclosure, "testnet disclosure must remain explicit");
  assert.doesNotMatch(disclosure[1], /\bmainnet\b/i);
});

test("server-renders the shared cycle countdown and verified card history", async () => {
  const [html, page] = await Promise.all([
    render().then((response) => response.text()),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(html, /id="headerCountdown">--:--/);
  assert.match(html, /id="headerCycleState">Schedule not reported/);
  assert.match(html, /id="metricCountdown">--:--/);
  assert.match(html, /The latest pulls/);
  assert.match(html, /Verified cycle history/);
  assert.match(html, /href="#machine"/);
  assert.equal((page.match(/<PublicCycleProvider>/g) ?? []).length, 1);
  assert.match(page, /<PublicCycleHeaderStatus \/>/);
  assert.match(page, /<PublicCycleCardRail \/>/);
});

test("keeps one shared poller behind every live cycle surface", async () => {
  const source = await readFile(new URL("../app/PublicCycleTracker.tsx", import.meta.url), "utf8");

  assert.equal((source.match(/fetch\("\/api\/cycle-status"/g) ?? []).length, 1);
  assert.equal((source.match(/setInterval\(pollIfVisible, POLL_INTERVAL_MS\)/g) ?? []).length, 1);
  assert.ok((source.match(/POLL_INTERVAL_MS/g) ?? []).length >= 2);
  assert.equal((source.match(/window\.setInterval\(/g) ?? []).length, 2);
  assert.equal((source.match(/<PublicCycleContext\.Provider/g) ?? []).length, 1);
  assert.match(source, /document\.visibilityState\s*===\s*["']visible["']/);
  assert.equal((source.match(/href="#live-machine"/g) ?? []).length, 2);
});

test("keeps every compact live cycle state honest", async () => {
  const source = await readFile(new URL("../app/PublicCycleTracker.tsx", import.meta.url), "utf8");

  assert.match(source, /const RAIL_CARD_COUNT = 4/);
  assert.match(source, /slice\(0, RAIL_CARD_COUNT\)/);
  assert.match(source, /"Connecting to live pulls"/);
  assert.match(source, /"No cycle running right now"/);
  assert.match(source, /"No cards revealed in this cycle yet"/);
  assert.match(source, /Showing latest \{cards\.length\} of \{cycle\.openedBoosters\} revealed cards/);
  assert.match(source, /`\$\{cycle\.openedBoosters\} revealed`/);
  assert.match(source, /feedState\.toUpperCase\(\)/);
  assert.match(source, /card\.cardName \? `\$\{card\.cardName\} card` : `Revealed \$\{card\.rarity\} card`/);
});

test("styles the compact live cycle surfaces for touch, desktop, and narrow screens", async () => {
  const trackerCss = await readFile(
    new URL("../app/PublicCycleTracker.module.css", import.meta.url),
    "utf8",
  );

  assert.match(trackerCss, /\.headerStatus[\s\S]*min-height:\s*44px/);
  assert.match(trackerCss, /\.pullRailCards[\s\S]*grid-template-columns:\s*repeat\(4/);
  assert.match(
    trackerCss,
    /@media[^}]*max-width:[^}]*[\s\S]*\.pullRailCards[\s\S]*overflow-x:\s*auto/,
  );
  assert.match(trackerCss, /\.headerStatus:focus-visible/);
  assert.match(trackerCss, /\.pullRailLink:focus-visible/);
  assert.match(trackerCss, /\.pullRailLink\s*\{[^}]*min-height:\s*44px/s);
  assert.match(
    trackerCss,
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*\.pullRailCards[^}]*scroll-behavior:\s*auto/,
  );
});

test("server-renders the five-stage card cycle with a textual explanation", async () => {
  const html = await (await render()).text();
  const transcript = html.match(/<details[^>]*class="[^"]*story-transcript[^"]*"[^>]*>([\s\S]*?)<\/details>/)?.[1];
  assert.ok(transcript);
  assert.equal((transcript.match(/<li\b/g) ?? []).length, 5);
  assert.deepEqual([...html.matchAll(/data-scene-stage="(\d)"/g)].map((match) => match[1]), ["0", "1", "2", "3", "4"]);
  assert.match(html, /id="story-pack"/);
  assert.match(html, /id="story-cards"/);
  assert.match(html, /id="story-payout"/);
  assert.doesNotMatch(html, /class="npc"|Every trainer on the way|id="traveler"/i);
});

test("renders the approved Hookemon assets and contains the coin within the scenes", async () => {
  const html = await (await render()).text();
  for (const path of ["hookemon-logo.svg", "hookemon-symbol.svg"]) {
    assert.ok(html.includes("/" + path));
    await access(new URL("../public/" + path, import.meta.url));
  }
  await access(new URL("../public/hookemon-mark.png", import.meta.url));
  await access(new URL("../public/hookemon-banner.jpeg", import.meta.url));
  assert.doesNotMatch(html, /hookemon-mark\.png/);
  assert.match(html, /<button class="hero-coin"[^>]*aria-label="Pause coin rotation/);
  assert.match(html, /id="story-coin"/);
  assert.doesNotMatch(html, /id="traveler"|id="tCoin"|id="wisp"|id="burst"/);
});

test("defines a one-shot full-screen mobile thunder impact", async () => {
  const css = await readFile(new URL("../app/hoenn-theme.css", import.meta.url), "utf8");
  const mobileStart = css.indexOf("@media (max-width: 820px)");
  const mobileEnd = css.indexOf("@media (max-width: 520px)", mobileStart);
  const mobileCss = css.slice(mobileStart, mobileEnd);
  const reducedMotionCss = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));

  assert.notEqual(mobileStart, -1);
  assert.notEqual(mobileEnd, -1);
  assert.match(
    mobileCss,
    /main\[data-visual-theme="hoenn-gacha"\]:has\(\.journey-section\[data-thunder-finale="active"\]\)\s*\{[^}]*animation:\s*thunder-mobile-viewport-impact\s+1200ms[^;]*\s1\sboth/s,
  );
  assert.match(
    mobileCss,
    /body:has\(main\[data-visual-theme="hoenn-gacha"\][^)]*\.journey-section\[data-thunder-finale="active"\]\)::after\s*\{[^}]*position:\s*fixed[^}]*inset:\s*0[^}]*pointer-events:\s*none[^}]*animation:\s*thunder-mobile-viewport-flash\s+1200ms[^;]*\s1\sboth/s,
  );
  assert.match(
    mobileCss,
    /html:has\(main\[data-visual-theme="hoenn-gacha"\][^)]*\.journey-section\[data-thunder-finale="active"\]\)\s*\{[^}]*overflow-x:\s*clip/s,
  );
  assert.match(
    css,
    /@keyframes thunder-mobile-viewport-impact\s*\{[\s\S]*?7%\s*\{[^}]*translate3d\(-8px,\s*6px,\s*0\)[\s\S]*?100%\s*\{[^}]*translate3d\(0,\s*0,\s*0\)[^}]*rotate\(0\)/,
  );
  assert.match(css, /@keyframes thunder-mobile-viewport-flash\s*\{/);
  assert.match(
    reducedMotionCss,
    /main\[data-visual-theme="hoenn-gacha"\]:has\([^}]*\)\s*\{[^}]*animation:\s*none[^}]*transform:\s*none/s,
  );
  assert.match(
    reducedMotionCss,
    /body:has\([^}]*\)::after\s*\{[^}]*content:\s*none[^}]*animation:\s*none/s,
  );
});

test("loads the scroll controller as a local module without video playback", async () => {
  const html = await (await render()).text();
  assert.match(html, /<script type="module" src="\/comic-production\/motion\.mjs"><\/script>/);
  assert.match(html, /id="journey-scene" data-phase="0"/);
  assert.match(html, /id="journey-progress"/);
  assert.doesNotMatch(html, /<video\b|\.mp4|createObjectURL|video\.play\(/);
});

test("renders the same illustrated identity as the local preview", async () => {
  const [html, css] = await Promise.all([
    render().then((response) => response.text()),
    readFile(new URL("../public/comic-production/adventure.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /<title>Hookemon — Every pack\. A new adventure\.<\/title>/);
  assert.match(css, /--navy:\s*#15345f/);
  assert.match(css, /--yellow:\s*#ffcb05/);
  assert.match(css, /--cream:\s*#fff9ef/);
  assert.match(html, /class="hero" id="top"/);
  assert.match(html, /class="coin-face coin-front"><img src="\/hookemon-symbol\.svg"/);
});

test("defines the four-tone monochrome responsive retro shell", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  for (const token of ["--gb-ink", "--gb-dark", "--gb-mid", "--gb-light", "--pixel-unit"]) {
    assert.match(css, new RegExp(token));
  }

  assert.match(css, /\.retro-dialogue\s*\{/);
  assert.match(css, /\.retro-button/);
  assert.match(css, /\.brand\s*\{[^}]*gap:\s*2px/s);
  assert.doesNotMatch(css, /backdrop-filter:\s*blur/);
  assert.match(css, /body\s*\{[^}]*min-width:\s*0/s);
});

test("renders native chapter navigation and a replay control", async () => {
  const html = await (await render()).text();
  const controls = [...html.matchAll(/<button\b[^>]*data-scene-stage="\d"[^>]*>/g)];
  assert.equal(controls.length, 5);
  assert.ok(controls.every(([tag]) => tag.includes('type="button"') && tag.includes("aria-pressed=")));
  assert.match(html, /<button[^>]*type="button"[^>]*data-replay[^>]*aria-label="Replay the illustrated cycle"/);
});

test("keeps the rounded Nintendo-style dialogue beside Pikachu", async () => {
  const [journey, css] = await Promise.all([
    readFile(new URL("../app/HookemonJourney.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(journey, /journey-mobile-speech/);
  assert.match(
    css,
    /\.journey-speech\.retro-dialogue,[\s\S]*?\.journey-speech\s*\{[^}]*right:\s*calc\(100% \+ 18px\)[^}]*border-radius:\s*16px[^}]*clip-path:\s*none/,
  );
  assert.match(
    css,
    /\.journey-speech::before,[\s\S]*?\.journey-speech::after\s*\{[^}]*border-top:\s*10px solid transparent[^}]*border-bottom:\s*10px solid transparent/,
  );
  assert.match(
    css,
    /@media \(max-width:\s*860px\)\s*\{\s*\.journey-section[\s\S]*?\.journey-speech\.retro-dialogue,[\s\S]*?\.journey-speech\s*\{[^}]*display:\s*block[^}]*border-radius:\s*14px/,
  );
  assert.match(
    css,
    /@media \(max-width:\s*860px\)[\s\S]*?\.journey-mobile-speech\s*\{[^}]*display:\s*none/,
  );
  assert.match(
    css,
    /@media \(max-width:\s*860px\)\s*\{\s*\.journey-section[\s\S]*?\.journey-bolt,[\s\S]*?\.journey-thunder-finale\s*\{[^}]*inset:\s*130px\s+0\s+60px/,
  );
  assert.match(
    css,
    /@media \(max-width:\s*860px\)\s*\{\s*\.journey-section[\s\S]*?\.retro-route-node:nth-child\(6\)\s*\{[^}]*top:\s*calc\(90\.8%\s*-\s*57\.5px\)/,
  );
  assert.match(
    css,
    /@media \(max-width:\s*860px\)\s*\{\s*\.journey-section[\s\S]*?\.journey-copy\s*\{[^}]*z-index:\s*4[^}]*margin-top:\s*16px/,
  );
  assert.match(
    css,
    /@media \(max-width:\s*860px\) and \(max-height:\s*600px\)[\s\S]*?\.journey-stage\.retro-map,[\s\S]*?\.retro-map\s*\{[^}]*height:\s*min\(74dvh,\s*340px\)[^}]*min-height:\s*300px/,
  );
  assert.match(
    css,
    /@media \(max-width:\s*860px\) and \(max-height:\s*600px\)[\s\S]*?\[data-active-step="6"\] \.journey-speech\s*\{[^}]*top:\s*14px[\s\S]*?\[data-active-step="6"\] \.journey-speech::before,[\s\S]*?\.journey-speech::after\s*\{[^}]*top:\s*56px/,
  );
});

test("keeps the active journey explanation inside the mobile sticky stage", async () => {
  const [journey, journeyRoute, css] = await Promise.all([
    readFile(new URL("../app/HookemonJourney.tsx", import.meta.url), "utf8"),
    readFile(new URL("../lib/journey-route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(journey, /className="journey-active-copy"/);
  assert.match(journey, /installJourneyScrollTracking/);
  assert.match(journeyRoute, /compactJourney[\s\S]*mobileReadingLane[\s\S]*viewportAnchor/);
  assert.match(
    css,
    /@media \(max-width:\s*860px\)[\s\S]*?\.journey-active-copy\s*\{[^}]*display:\s*block[^}]*grid-column:\s*1\s*\/\s*-1/,
  );
  assert.match(
    css,
    /@media \(max-width:\s*860px\)[\s\S]*?\.journey-step\.quest-panel,[\s\S]*?\.quest-panel\s*\{[^}]*min-height:\s*max\(188px,\s*24dvh\)/,
  );
});

test("applies one stylesheet across the complete illustrated homepage", async () => {
  const html = await (await render()).text();
  for (const id of ["top", "machine", "journey", "economics", "cards", "faq"]) assert.ok(html.includes('id="' + id + '"'));
  assert.match(html, /class="site-footer"/);
  assert.equal((html.match(/href="\/comic-production\/adventure\.css"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /hero-video|npc-row|<style\b/);
});

test("reserves a mobile icon rail above the payout copy", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(
    css,
    /@media \(max-width:\s*760px\)[\s\S]*?\.payout-card\.payout-menu,[\s\S]*?\.payout-menu\s*\{[^}]*padding:\s*104px\s+24px\s+36px/,
  );
  assert.match(
    css,
    /@media \(max-width:\s*760px\)[\s\S]*?\.payout-card::before\s*\{[^}]*width:\s*56px[^}]*height:\s*56px/,
  );
});

test("keeps the hero coin separate from the card examples and reusable in the journey", async () => {
  const html = await (await render()).text();
  const hero = html.slice(html.indexOf('id="top"'), html.indexOf('id="machine"'));
  assert.match(hero, /class="hero-coin"[^>]*><span class="coin-spinner">/);
  assert.match(hero, /class="coin-face coin-front"><img src="\/hookemon-symbol\.svg"/);
  assert.doesNotMatch(hero, /cloudfront\.net|trainer|npc|<video\b/i);
  const journey = html.slice(html.indexOf('id="journey"'), html.indexOf('class="collection'));
  for (const marker of ['id="story-coin"', 'class="payout-coin"']) {
    const coin = journey.slice(journey.indexOf(marker));
    assert.match(coin, /^[^>]*><span class="coin-display"><span class="coin-face"><img src="\/hookemon-symbol\.svg"/);
  }
  assert.doesNotMatch(html, /\/comic\/(?:hero-)?coin\.png/);
});

test("enforces the mobile typography and touch journey contract", async () => {
  const [page, journey, css] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/HookemonJourney.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  for (const trailingHeadline of [
    "NEVER STOPS.",
    "Watch the value move.",
    "Simple on the surface. Strict underneath.",
    "Your wallet receives. You do nothing.",
    "Open source does not mean risk free.",
    "Follow every hook, bridge, pack and payout.",
    "Six stops. One visible loop.",
  ]) {
    assert.doesNotMatch(`${page}\n${journey}`, new RegExp(trailingHeadline.replaceAll(".", "\\.")));
  }

  assert.match(css, /h1,\s*h2,\s*h3\s*\{[^}]*text-wrap:\s*balance/);
  assert.match(css, /h1 span\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(css, /\.hero-copy\s*\{[^}]*container-type:\s*inline-size/);
  assert.match(css, /h1\s*\{[^}]*font-size:\s*clamp\([^;]*cqi/);
  assert.match(css, /\.journey-section\s*\{[^}]*touch-action:\s*pan-y/);
  assert.match(css, /\.journey-stage > \.particle-field\s*\{[^}]*z-index:\s*0[^}]*pointer-events:\s*none/);
  assert.match(css, /\.journey-bolt\s*\{[^}]*z-index:\s*1/);
  assert.match(css, /\.journey-nodes\s*\{[^}]*z-index:\s*2[^}]*pointer-events:\s*none/);
  assert.match(css, /\.journey-thunder-finale\s*\{[^}]*z-index:\s*4[^}]*pointer-events:\s*none/);
  assert.match(css, /\.journey-guide\s*\{[^}]*z-index:\s*5/);
  assert.match(css, /\.journey-active-label\s*\{[^}]*z-index:\s*6/);
  assert.match(
    css,
    /\.journey-guide\s*\{[^}]*top:\s*clamp\(145px,\s*var\(--guide-y\),\s*calc\(100% - 155px\)\)/,
  );
  assert.match(
    css,
    /@media \(max-width:\s*760px\)[\s\S]*?h1\s*\{[^}]*letter-spacing:\s*-0\.045em[^}]*line-height:\s*0\.88/,
  );
  assert.match(
    css,
    /@media \(max-width:\s*760px\)[\s\S]*?\.journey-guide\s*\{[^}]*top:\s*clamp\(108px,\s*var\(--guide-y\),\s*calc\(100% - 100px\)\)[^}]*left:\s*clamp\(31%,\s*var\(--guide-x\),\s*61%\)/,
  );
  assert.match(
    css,
    /@media \(max-width:\s*430px\)[\s\S]*?\[data-active-step="1"\][\s\S]*?\.journey-speech[^}]*right:\s*auto[^}]*left:\s*calc\(100% \+ 10px\)/,
  );
  assert.match(
    css,
    /@media \(max-width:\s*760px\)[\s\S]*?\.journey-bolt-live\s*\{[^}]*transition:[^}]*280ms/,
  );
});

test("removes the disposable starter and freezes Hookemon metadata", async () => {
  const [page, layout, css, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  await assert.rejects(access(new URL("../app/_sites-preview", import.meta.url)));
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  assert.match(packageJson, /"name": "@hookemon\/web"/);
  assert.doesNotMatch(page, /SkeletonPreview/);
  assert.match(layout, /Hookemon: The cycle never stops\./);
  assert.match(layout, /metadataBase/);
  assert.match(css, /--color-background:\s*#050505/i);
  assert.match(css, /--color-pikachu:\s*#f2f2f2/i);
  assert.match(css, /--color-holo:\s*#d4d4d4/i);
  assert.match(css, /--color-pack:\s*#ffffff/i);
  assert.match(css, /--gb-ink:\s*#050505/i);
  assert.match(css, /--gb-dark:\s*#171717/i);
  assert.match(css, /--gb-mid:\s*#7a7a7a/i);
  assert.match(css, /--gb-light:\s*#f2f2f2/i);
  assert.match(css, /filter:\s*grayscale\(1\) contrast\(1\.28\) brightness\(1\.06\)/i);
  assert.match(css, /\.journey-stage\s*\{/);
  assert.match(css, /position:\s*sticky/);
  assert.match(css, /\.journey-step\s*\{[\s\S]*?min-height:\s*52vh/);
  assert.match(css, /\.journey-guide\s*\{[\s\S]*?transition:[\s\S]*?380ms/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /@media \(max-width:\s*760px\)/);
  const socialLinks = await readFile(new URL("../app/SocialLinks.tsx", import.meta.url), "utf8");
  assert.match(socialLinks, /https:\/\/github\.com\/hookemonv4\/hookemon-hkmn/);
  assert.match(page, /GITHUB_REPO_URL/);
  assert.match(page, /HookemonJourney/);
  assert.match(page, /Pay holders automatically/);
  await access(templateRoot);
});

test("defines font variables at the document root before global aliases resolve", async () => {
  const layout = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");

  assert.match(
    layout,
    /<html lang="en" className=\{`\$\{geistSans\.variable\} \$\{geistMono\.variable\}`\}>/,
  );
  assert.match(layout, /<body>\{children\}<\/body>/);
});

test("keeps local metadata assets on HTTP behind a forwarded HTTPS header", () => {
  assert.equal(
    resolveMetadataBase("127.0.0.1:3000", "https").href,
    "http://127.0.0.1:3000/",
  );
  assert.equal(
    resolveMetadataBase("localhost:3000", "https").href,
    "http://localhost:3000/",
  );
  assert.equal(
    resolveMetadataBase("hookemon.example", "https").href,
    "https://hookemon.example/",
  );
});

test("serves approved Collector Crypt fallback inventory when upstream is unavailable", async () => {
  const upstreamRequests = [];
  const response = await withMockedFetch(
    async (url, init) => {
      upstreamRequests.push({ url: String(url), init });
      return new Response("upstream unavailable", { status: 503 });
    },
    () => render("/api/collector-cards", { COLLECTOR_API_KEY: "collector-secret-marker" }),
  );

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json\b/i);
  assert.equal(
    response.headers.get("cache-control"),
    "public, max-age=60, stale-while-revalidate=300",
  );

  const payload = await response.json();
  assert.equal(payload.source, "fallback");
  assert.ok(payload.cards.length >= 3);
  assert.ok(payload.cards.some((card) => /Politoed/i.test(card.name)));
  assert.ok(payload.cards.some((card) => /Marowak/i.test(card.name)));
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].init.headers["x-api-key"], "collector-secret-marker");
  assert.doesNotMatch(JSON.stringify(payload), /collector-secret-marker|COLLECTOR_API_KEY/);
});

test("normalizes and limits live Collector Crypt inventory without exposing its key", async () => {
  const upstreamRequests = [];
  const response = await withMockedFetch(
    async (url, init) => {
      const requestUrl = new URL(String(url));
      upstreamRequests.push({ url: requestUrl, init });

      if (requestUrl.pathname === "/api/gachas/all") {
        return Response.json([
          {
            code: "pokemon_50",
            name: "Elite Pokémon Gacha Pack",
            public: true,
            instantBuyback: { percentageOfValue: 85 },
          },
        ]);
      }

      const rarity = requestUrl.searchParams.get("rarity");
      return Response.json({
        nfts: [
          collectorInventoryCard({ id: "duplicate-nft-address", rarity }),
          collectorInventoryCard({ id: `${rarity}-a`, rarity }),
          collectorInventoryCard({
            id: `${rarity}-b`,
            rarity,
            insuredValue: rarity === "common" ? "not-a-number" : 245,
          }),
          collectorInventoryCard({
            id: `${rarity}-c`,
            rarity,
            image: rarity === "common" ? "" : `https://images.example/${rarity}-c.jpg`,
          }),
        ],
        hasMore: true,
        page: 1,
        limit: 3,
      });
    },
    () =>
      render("/api/collector-cards", {
        COLLECTOR_API_BASE_URL: "https://collector.example",
        COLLECTOR_API_KEY: "collector-secret-marker",
        COLLECTOR_MACHINE_CODE: "pokemon_50",
      }),
  );

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.source, "remote");
  assert.equal(payload.cards.length, 12);
  assert.equal(new Set(payload.cards.map((card) => card.id)).size, payload.cards.length);
  assert.deepEqual(new Set(payload.cards.map((card) => card.rarity)), new Set([
    "common",
    "uncommon",
    "rare",
    "epic",
  ]));
  assert.ok(payload.cards.every((card) => card.instantBuybackPercent === 85));
  assert.ok(payload.cards.every((card) => card.year === 2003));
  assert.ok(payload.cards.every((card) => card.set === "Skyridge"));
  assert.ok(payload.cards.every((card) => card.imageUrl.startsWith("https://")));
  assert.ok(!("insuredValueUsd" in payload.cards.find((card) => card.id === "common-b")));
  assert.equal(upstreamRequests.length, 5);
  assert.ok(upstreamRequests.every(({ init }) => init.headers["x-api-key"] === "collector-secret-marker"));
  assert.doesNotMatch(JSON.stringify(payload), /collector-secret-marker|COLLECTOR_API_KEY/);
});

test("falls back when Collector Crypt inventory is malformed or empty", async () => {
  for (const mode of ["malformed", "empty"]) {
    const response = await withMockedFetch(
      async (url) => {
        if (new URL(String(url)).pathname === "/api/gachas/all") {
          return Response.json([
            {
              code: "pokemon_50",
              instantBuyback: { percentageOfValue: 85 },
            },
          ]);
        }
        return mode === "malformed"
          ? new Response("{not-json", {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          : Response.json({ nfts: [], hasMore: false, page: 1, limit: 3 });
      },
      () => render("/api/collector-cards"),
    );

    const payload = await response.json();
    assert.equal(payload.source, "fallback", `${mode} inventory must use the fallback deck`);
    assert.ok(payload.cards.length >= 3);
  }
});

test("server-renders clearly labelled examples from Collector Crypt inventory", async () => {
  const html = await (await render("/", { COLLECTOR_API_KEY: "collector-secret-marker" })).text();
  assert.match(html, /Example cards from Collector Crypt inventory/);
  assert.match(html, /not completed Hookemon pulls or a promise of future pack contents/);
  assert.doesNotMatch(html, /collector-secret-marker|COLLECTOR_API_KEY/);
  assert.ok(showcaseImages.filter((imageUrl) => html.includes(imageUrl)).length >= 3);
});

test("keeps the hero focused on the coin while showing inventory cards later", async () => {
  const html = await (await render()).text();
  const heroStart = html.indexOf('id="top"');
  const heroEnd = html.indexOf('id="machine"');
  const cardsStart = html.indexOf('id="cards"');
  assert.ok(heroStart > -1 && heroEnd > heroStart && cardsStart > heroEnd);
  assert.doesNotMatch(html.slice(heroStart, heroEnd), /d1xpxki1g4htqu\.cloudfront\.net/);
  assert.match(html.slice(cardsStart), /Lugia-Holo SL7/);
});

test("shows the same labelled example cards in the scroll scene and collection", async () => {
  const html = await (await render()).text();
  const journeyStart = html.indexOf('id="journey"');
  const cardsStart = html.indexOf('id="cards"');
  const collectionEnd = html.indexOf('id="economics"');
  assert.ok(journeyStart > -1 && cardsStart > journeyStart && collectionEnd > cardsStart);
  const journey = html.slice(journeyStart, cardsStart);
  const collection = html.slice(cardsStart, collectionEnd);
  assert.match(journey, /Illustrative cycle · example cards/);
  assert.match(collection, /Example cards from Collector Crypt inventory/);
  const sharedImages = showcaseImages.filter((image) => journey.includes(image) && collection.includes(image));
  assert.equal(sharedImages.length, 3);
});

test("keeps the Collector Crypt partner secret out of every client asset", async () => {
  const assetRoot = new URL("../dist/client/assets/", import.meta.url);
  const assetEntries = await readdir(assetRoot, { recursive: true, withFileTypes: true });
  const clientSource = (
    await Promise.all(
      assetEntries
        .filter((assetEntry) => assetEntry.isFile())
        .map((assetEntry) => readFile(join(assetEntry.parentPath, assetEntry.name), "utf8")),
    )
  ).join("\n");

  assert.doesNotMatch(clientSource, /COLLECTOR_API_KEY|collector-secret-marker|x-api-key/);
});

test("maps the five-stage journey to the shared coin, pack, cards and holders", async () => {
  const html = await (await render()).text();
  assert.deepEqual([...html.matchAll(/data-scene-stage="(\d)"/g)].map((match) => match[1]), ["0", "1", "2", "3", "4"]);
  for (const id of ["story-coin", "story-pack", "story-cards", "story-payout"]) {
    assert.equal((html.match(new RegExp('id="' + id + '"', "g")) ?? []).length, 1);
  }
  assert.match(html, /Cards sold <span>→<\/span> Proceeds returned/);
});

test("reuses the same daylight landscape in the hero and scroll scene", async () => {
  const [html, css] = await Promise.all([
    render().then((response) => response.text()),
    readFile(new URL("../public/comic-production/adventure.css", import.meta.url), "utf8"),
  ]);
  assert.match(html, /class="hero-landscape" aria-hidden="true"/);
  assert.match(html, /class="scene-landscape" aria-hidden="true"/);
  assert.match(css, /\.hero-landscape\s*\{[^}]*\/comic\/landscape\.png/s);
  assert.match(css, /\.scene-landscape\s*\{[^}]*\/comic\/landscape\.png/s);
  assert.doesNotMatch(html, /<feGaussianBlur|<video\b|class="tint"/);
});

test("styles the Collector Crypt encounter for touch, responsive, and reduced-motion use", async () => {
  const [css, collectorCards] = await Promise.all([
    readFile(new URL("../app/hoenn-theme.css", import.meta.url), "utf8"),
    readFile(new URL("../app/CollectorCryptCards.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(css, /\.collector-active-card\s*\{[^}]*aspect-ratio:/s);
  assert.match(css, /\.collector-controls button\s*\{[^}]*min-width:\s*44px[^}]*min-height:\s*44px/s);
  assert.match(css, /\.collector-hero\s*\{[^}]*touch-action:\s*pan-y/s);
  assert.match(css, /@media \(max-width:\s*820px\)[\s\S]*?\.hero\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /@media \(max-width:\s*430px\)[\s\S]*?\.collector-card-facts/s);
  assert.match(
    css,
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.collector-active-frame[\s\S]*?animation:\s*none/s,
  );
  assert.match(
    css,
    /@media \(prefers-reduced-motion:\s*reduce\)[\s\S]*?\.journey-card-frame[\s\S]*?transform:\s*none/s,
  );
  assert.match(collectorCards, /document\.hidden/);
  assert.match(collectorCards, /visibilitychange/);
  assert.match(collectorCards, /prefers-reduced-motion:\s*reduce/);
  assert.match(collectorCards, /const HERO_ROTATION_MS = 1_800/);
  assert.match(collectorCards, /setRotationEpoch\(\(current\) => current \+ 1\)/);
  assert.match(collectorCards, /selectCollectorPresentation\(/);
  assert.doesNotMatch(collectorCards, /normalizedActiveIndex \+ offset \+ 1/);
});

test("defines the compact 14-inch laptop journey contract", async () => {
  const css = await readFile(new URL("../app/hoenn-theme.css", import.meta.url), "utf8");
  const query = "@media (min-width: 861px) and (max-width: 1600px) and (max-height: 820px)";
  const queryStart = css.indexOf(query);
  const collectorStateRuleStart = css.indexOf(
    'main[data-visual-theme="hoenn-gacha"] .journey-collector-viewport[data-collector-state="payout"] .journey-card-frame',
  );

  assert.notEqual(queryStart, -1, "short laptop media query must exist");
  assert.ok(
    queryStart > collectorStateRuleStart,
    "short laptop overrides must follow the Collector journey state rules",
  );

  const shortLaptopCss = css.slice(queryStart);
  assert.match(shortLaptopCss, /\.journey-section\s*\{[^}]*padding-bottom:\s*16px/s);
  assert.match(shortLaptopCss, /\.journey-copy\s*\{[^}]*padding-bottom:\s*112px/s);
  assert.match(
    shortLaptopCss,
    /\.journey-stage\.retro-map\.hoenn-route-map\s*\{[^}]*height:\s*min\(560px,\s*calc\(100dvh - 108px\)\)[^}]*min-height:\s*0/s,
  );
  assert.match(
    shortLaptopCss,
    /\.journey-collector-viewport\s*\{[^}]*right:\s*2px[^}]*width:\s*min\(300px,\s*52%\)[^}]*height:\s*220px/s,
  );
  assert.match(shortLaptopCss, /\.journey-hook-fee\s*\{[^}]*top:\s*40px/s);
  assert.match(
    shortLaptopCss,
    /\.retro-route-node:nth-child\(1\)\s*\{[^}]*left:\s*18%/s,
  );
  assert.match(
    shortLaptopCss,
    /\.collector-lane-label\s*\{[^}]*grid-template-columns:\s*auto minmax\(0,\s*1fr\) auto minmax\(0,\s*1fr\) auto/s,
  );
  assert.match(shortLaptopCss, /\.journey-guide\s*\{[^}]*width:\s*82px/s);
  assert.match(shortLaptopCss, /\.journey-speech\s*\{[^}]*width:\s*140px/s);
  assert.match(
    shortLaptopCss,
    /\.journey-active-label\s*\{[^}]*top:\s*284px[^}]*right:\s*10px[^}]*left:\s*auto[^}]*width:\s*37%/s,
  );
  assert.match(shortLaptopCss, /\.journey-step\.quest-panel\s*\{[^}]*padding:\s*20px/s);
  assert.doesNotMatch(
    shortLaptopCss,
    /\.journey-hook-fee\s*\{[^}]*top:\s*62px/s,
    "short laptop Hook fee must not cover the first route station",
  );
});

test("renders progress and chapter text inside the sticky scene", async () => {
  const html = await (await render()).text();
  const scene = html.slice(html.indexOf('id="journey-scene"'), html.indexOf('class="collection'));
  for (const id of ["journey-progress", "story-title", "story-copy", "story-index"]) assert.ok(scene.includes('id="' + id + '"'));
  assert.equal((scene.match(/data-scene-stage=/g) ?? []).length, 5);
  assert.match(scene, /data-replay/);
});

test("defines collision-free journey safety zones and route stations", async () => {
  const css = await readFile(new URL("../app/hoenn-theme.css", import.meta.url), "utf8");

  assert.match(
    css,
    /\.journey-stage\.retro-map\.hoenn-route-map,[^{]*\{[^}]*--journey-evidence-top:\s*70px[^}]*--journey-evidence-height:\s*244px[^}]*--journey-lower-safe-area:\s*150px[^}]*--journey-cta-inset:\s*18px/s,
  );
  assert.match(
    css,
    /\.journey-collector-viewport\s*\{[^}]*top:\s*var\(--journey-evidence-top\)[^}]*height:\s*var\(--journey-evidence-height\)/s,
  );
  assert.match(css, /\.journey-hook-fee\s*\{[^}]*top:\s*54px/s);
  assert.match(css, /\.journey-bolt-filled\s*\{[^}]*width:\s*58%/s);
  assert.match(css, /\.journey-active-label\s*\{[^}]*right:\s*3%[^}]*width:\s*37%/s);
  assert.match(css, /\.journey-active-copy\s*\{[^}]*display:\s*block/s);
});

test("defines a collision-free compact mobile journey route", async () => {
  const css = await readFile(new URL("../app/hoenn-theme.css", import.meta.url), "utf8");
  const mobileStart = css.indexOf("@media (max-width: 820px)");
  const mobileEnd = css.indexOf("@media (max-width: 520px)", mobileStart);
  const mobileCss = css.slice(mobileStart, mobileEnd);

  assert.notEqual(mobileStart, -1);
  assert.notEqual(mobileEnd, -1);
  assert.match(
    mobileCss,
    /\.journey-collector-viewport\s*\{[^}]*width:\s*min\(292px,\s*54%\)/s,
  );
  assert.match(mobileCss, /\.journey-bolt-filled\s*\{[^}]*left:\s*-8%[^}]*width:\s*68%/s);
  assert.match(mobileCss, /\.journey-active-label\s*\{[^}]*bottom:\s*4px/s);
  assert.match(mobileCss, /\.journey-active-copy\s*\{[^}]*display:\s*none/s);
  assert.match(mobileCss, /\.risk-section\.system-warning\s*\{[^}]*margin-bottom:\s*0/s);
  assert.match(
    mobileCss,
    /\.closing-section\.retro-closing,[^{]*\{[^}]*padding-block:\s*56px/s,
  );
});

test("renders the cycle dashboard and X link without GitHub promotion", async () => {
  const html = await (await render()).text();
  assert.match(html, /Cycle overview/);
  assert.match(html, /Holders paid/);
  assert.match(html, /Packs opened/);
  assert.match(html, /href="https:\/\/x\.com\/hookemon4"/);
  assert.match(html, /aria-label="Hookemon on X"/);
  assert.doesNotMatch(html, /github\.com|Hookemon on GitHub/);
});

test("keeps all explanatory content available without JavaScript", async () => {
  const html = await (await render()).text();
  const transcript = html.match(/<details[^>]*class="[^"]*story-transcript[^"]*"[^>]*>([\s\S]*?)<\/details>/)?.[1];
  assert.ok(transcript);
  assert.equal((transcript.match(/<li\b/g) ?? []).length, 5);
  assert.match(html, /<details>\s*<summary>\s*What is Hookemon\?/);
  assert.match(html, /<details>\s*<summary>\s*How much do holders receive\?/);
  assert.doesNotMatch(html, /class="[^"]*\breveal\b|\bhidden\b[^>]*id="(?:machine|economics|faq)"/);
});

test("renders seven tactile card examples with their names and grades", async () => {
  const html = await (await render()).text();
  assert.match(html, /id="cards"/);
  assert.equal((html.match(/<figure class="collectible-card js-tilt/g) ?? []).length, 7);
  for (const card of ["Rayquaza", "Lugia", "Poncho Pikachu", "Charizard", "Umbreon VMAX", "Shining Mewtwo", "Mew Gold Star"]) assert.ok(html.includes(card));
  for (const grade of ["BGS 8", "PSA 10", "PSA 9"]) assert.ok(html.includes(grade));
  assert.match(html, /not completed Hookemon pulls or a promise of future pack contents/);
});

test("summarizes recent cards and the latest cycle payout separately", async () => {
  const html = await (await render()).text();
  assert.match(html, /id="metricCards">—<\/strong> recent cards/);
  assert.match(html, /Verified cycle history/);
  assert.match(html, /Average per recipient/);
  assert.match(html, /Latest cycle payout/);
  assert.match(html, /Awaiting verified payout data/);
});

test("targets inner tilt surfaces and links only the gallery valuations", async () => {
  const html = await (await render()).text();
  assert.equal((html.match(/data-tilt-surface/g) ?? []).length, 10);
  assert.match(html, /<figure class="scene-card [^"]+ js-tilt"><div data-tilt-surface>/);
  assert.match(html, /src="\/comic-production\/motion\.mjs"/);
  const cards = html.slice(html.indexOf('id="cards"'), html.indexOf('id="economics"'));
  const links = [...cards.matchAll(/<a\b[^>]*>/g)].map(([tag]) => tag);
  assert.equal(links.length, 7);
  assert.ok(links.every((tag) => tag.includes('class="card-valuation"') && tag.includes('href="https://collectorcrypt.com/assets/solana/')));
});
