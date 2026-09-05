import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import test from "node:test";
import { installJourneyMotion } from "../public/comic-production/motion.mjs";

const publicRoot = new URL("../public/", import.meta.url);
const html = (await readFile(new URL("comic-production/index.html", publicRoot), "utf8"))
  .replace(/>\s+</g, "><").replace(/\s+/g, " ");
const description = "Hookemon buys gacha card packs, opens them, sells the cards and pays the proceeds to HKMN holders. Trading fees fund the packs.";

test("serves the illustrated homepage through the production asset route", async () => {
  const worker = await readFile(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(worker, /comic-production\/index\.html/);
  assert.match(worker, /url\.pathname\s*===\s*["']\/["']/);
  assert.match(html, /href="\/comic-production\/adventure\.css"/);
  for (const name of ["motion", "dashboard"]) {
    assert.match(html, new RegExp(`<script[^>]*type="module"[^>]*src="/comic-production/${name}\\.mjs"`));
    assert.ok((await stat(new URL(`comic-production/${name}.mjs`, publicRoot))).size > 0);
  }
});

test("uses one local illustrated world without video buffering or NPC overlays", async () => {
  const motion = await readFile(new URL("comic-production/motion.mjs", publicRoot), "utf8");
  const css = await readFile(new URL("comic-production/adventure.css", publicRoot), "utf8");
  assert.doesNotMatch(html, /<video\b|\.mp4|data-comic-video|id="traveler"|class="npc\b/i);
  assert.doesNotMatch(motion, /\bfetch\(|createObjectURL|\.play\(|setInterval/);
  assert.match(html + css, /\/comic\/landscape\.png/);
  const sizes = await Promise.all(["landscape.png", "hero-coin.png"].map(async (name) => (await stat(new URL(`comic/${name}`, publicRoot))).size));
  assert.ok(sizes.every((size) => size > 0));
  assert.ok(sizes.reduce((sum, size) => sum + size, 0) < 8_000_000, "the shared scenery and hero stay below the old video payload");
});

test("retains the three approved brand assets byte for byte", async () => {
  const approved = {
    "hookemon-banner.jpeg": "a716aab18df57b0c77890b65b8cd8de424a5b09a8107eaf437dc01c97a4febc8",
    "hookemon-mark.png": "d21a88989a104f6534741861cb9966bf0d3b12fe86457d73d143de2fe83ed2ad",
    "hookemon-logo.svg": "bf8d4acbed9572277fa8bf5238739ae1d410ee3dac6c3aced1f173b692475fbf",
  };
  for (const [name, digest] of Object.entries(approved)) {
    const bytes = await readFile(new URL(name, publicRoot));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), digest, name);
    const used = html.includes(`/${name}`)
      || (name === "hookemon-mark.png" && html.includes("/hookemon-symbol.svg"));
    assert.ok(used || name === "hookemon-banner.jpeg", `${name} or its transparent symbol remains used; the original banner is preserved as an asset`);
  }
});

test("keeps the approved product description and conditional outcome language", () => {
  assert.ok(html.includes(description));
  assert.ok(html.includes(`content="${description}"`));
  assert.match(html, /Quick answers/i);
  assert.doesNotMatch(html, /guaranteed (?:profit|income|returns)|risk.free|passive income|Your wallet receives\. You do nothing/i);
  assert.doesNotMatch(html, /How do I earn rewards\?/i);
  assert.doesNotMatch(html, /github\.com|Hookemon on GitHub/i);
});

test("states the gross-volume fee without a trading interface or deployment addresses", () => {
  assert.ok(html.includes("3,00 % auf Brutto‑Volumen"));
  for (const amount of ["0,10", "0,40", "2,50"]) assert.ok(html.includes(`${amount} %`));
  assert.doesNotMatch(html, /3\.00% fee on the USDG side/i);
  assert.doesNotMatch(html, /0x[a-f\d]{40}/i);
  assert.doesNotMatch(html, /(?:href|action)="\/swap(?:[?#/"])/);
  assert.doesNotMatch(html, /Swap HKMN|Connect wallet|Get quote|Swap whole amount/i);
});

test("offers accessible market links and an honest header cycle shortcut", async () => {
  const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
  for (const [url, name] of [["https://www.fomoapp.net/", "Fomo"], ["https://dexscreener.com/", "DEX Screener"]]) {
    const tag = [...header.matchAll(/<a\b[^>]*>/g)].map(([value]) => value).find((value) => value.includes(`href="${url}"`));
    assert.ok(tag, `${name} destination is available`);
    assert.ok(tag.includes(`aria-label="Open ${name}"`));
    assert.ok(tag.includes('rel="noopener noreferrer"'));
  }
  assert.match(header, /href="#machine"[^>]*id="navCycle"/);
  assert.match(header, /id="navCountdown"[^>]*>--:--</);
  for (const asset of ["fomo.svg", "dexscreener.png"]) {
    assert.ok((await stat(new URL(`partners/${asset}`, publicRoot))).size > 0);
  }
});

test("keeps every requested live metric available without invented initial values", () => {
  for (const id of ["metricPool", "metricPaid", "metricAverage", "metricCountdown", "metricPacks", "metricCards", "metricRecipients", "latestCards", "dashboardStatus", "headerCountdown", "headerCycleState"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} must be present`);
  }
  for (const id of ["metricPool", "metricPaid", "metricAverage"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*>\\s*(?:—|--|Not available|Unavailable)`));
  }
  assert.match(html, /id="top"[\s\S]*id="machine"[\s\S]*id="journey"/);
});

test("provides five native stage controls and a complete textual fallback", () => {
  const controls = [...html.matchAll(/<button\b[^>]*data-scene-stage="(\d)"[^>]*>/g)];
  assert.deepEqual(controls.map((match) => match[1]), ["0", "1", "2", "3", "4"]);
  assert.ok(controls.every(([tag]) => tag.includes('type="button"') && tag.includes("aria-pressed=")));
  assert.match(html, /class="[^"]*story-transcript/);
  assert.match(html, /data-replay/);
  for (const id of ["journey-scene", "journey-progress", "story-title", "story-copy", "story-index", "story-coin", "story-pack", "story-cards", "story-payout"]) {
    assert.ok(html.includes(`id="${id}"`), `${id} must be present`);
  }
});

test("keeps navigation fragments valid and scene IDs unique", () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  assert.equal(new Set(ids).size, ids.length, "duplicate IDs break dashboard and scene controls");
  const targets = [...html.matchAll(/\bhref="#([^"]+)"/g)].map((match) => match[1]);
  assert.ok(targets.length > 0);
  for (const target of targets) assert.ok(ids.includes(target), `missing #${target} target`);
});

test("retains keyboard focus and removes the long pinned sequence for reduced motion", async () => {
  const css = await readFile(new URL("comic-production/adventure.css", publicRoot), "utf8");
  assert.match(css, /:focus-visible/);
  const reduced = css.slice(css.search(/@media\s*\(prefers-reduced-motion:\s*reduce\)/));
  assert.match(reduced, /\.journey\b[^{}]*\{[^}]*height:\s*auto/s);
  assert.match(reduced, /\.scene-sticky\b[^{}]*\{[^}]*position:\s*(?:relative|static)/s);
  assert.match(reduced, /transition:\s*none|transition-duration:\s*0/s);
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<nav\b[^>]*aria-label="Primary navigation"/);
});

test("labels illustrative card art separately from actual card history", () => {
  const journey = html.slice(html.indexOf('id="journey"'), html.indexOf('id="economics"'));
  assert.match(journey, /example|illustrative/i);
  assert.match(journey, /id="story-cards"/);
  assert.match(html, /id="latestCards"/);
  assert.doesNotMatch(journey, /you (?:won|earned)|guaranteed reward/i);
});

test("keeps the selected Lugia visible as the gallery chase card and holder arrows above cards", async () => {
  const css = await readFile(new URL("comic-production/adventure.css", publicRoot), "utf8");
  assert.match(html, /class="chase-ribbon">Chase card/);
  assert.match(html, /class="card-collection"><figure class="collectible-card js-tilt card-lugia"/);
  assert.match(css, /\.collectible-card\.card-lugia\s*\{[^}]*grid-column:\s*1 \/ -1/s);
  assert.match(css, /\.payout-lines\s*\{[^}]*z-index:\s*4/s);
  assert.match(css, /\.holder-row\s*\{[^}]*z-index:\s*3/s);
  assert.match(css, /\.payout-lines i::after\s*\{[^}]*padding:\s*6px/s);
});

test("binds production assets to the worker and disables the local inspector", async () => {
  const config = await readFile(new URL("../vite.config.ts", import.meta.url), "utf8");
  assert.match(config, /assets:\s*\{[^}]*binding:\s*["']ASSETS["']/s);
  assert.match(config, /run_worker_first:\s*true/);
  assert.match(config, /inspectorPort:\s*false/);
});

function motionHarness({ fine = true, reduced = false, stageValues = [0, 1, 2, 3, 4] } = {}) {
  function element() {
    return Object.assign(new EventTarget(), {
      dataset: {}, textContent: "", attributes: new Map(),
      style: { transform: "", values: new Map(), setProperty(key, value) { this.values.set(key, value); } },
      setAttribute(key, value) { this.attributes.set(key, value); },
      querySelector() { return null; },
    });
  }
  const ids = new Map(["journey", "journey-scene", "journey-progress", "story-title", "story-copy", "story-index"].map((id) => [id, element()]));
  const controls = stageValues.map((value) => Object.assign(element(), { dataset: { sceneStage: String(value) } }));
  const replay = element();
  const tilt = element();
  const surface = element();
  surface.style.transform = "translateZ(2px)";
  tilt.querySelector = () => surface;
  let reads = 0;
  tilt.getBoundingClientRect = () => { reads += 1; return { top: 0, left: 0, width: 200, height: 100 }; };
  const geometry = { top: 78, height: 3200, stickyTop: 78 };
  ids.get("journey").getBoundingClientRect = () => geometry;
  const reducedPreference = Object.assign(new EventTarget(), { matches: reduced });
  const pointerPreference = Object.assign(new EventTarget(), { matches: fine });
  const root = Object.assign(new EventTarget(), {
    hidden: false,
    getElementById: (id) => ids.get(id),
    querySelectorAll: (selector) => ({ "[data-scene-stage]": controls, "[data-replay]": [replay], ".js-tilt": [tilt] })[selector] ?? [],
  });
  const frames = new Map();
  const scrolls = [];
  let nextFrame = 0;
  const browser = Object.assign(new EventTarget(), {
    scrollY: 400, innerHeight: 800,
    getComputedStyle: () => ({ top: `${geometry.stickyTop}px`, position: "sticky" }),
    matchMedia: (query) => query.includes("reduced-motion") ? reducedPreference : pointerPreference,
    requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; },
    cancelAnimationFrame: (id) => frames.delete(id),
    scrollTo: (options) => scrolls.push(options),
  });
  const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((callback) => callback()); };
  const pointer = (type, coordinates = {}) => tilt.dispatchEvent(Object.assign(new Event(type), { pointerType: "mouse", ...coordinates }));
  const cleanup = installJourneyMotion(root, browser);
  flush();
  return { ids, controls, replay, tilt, surface, reads: () => reads, geometry, reducedPreference, pointerPreference, root, browser, frames, scrolls, flush, pointer, cleanup };
}

test("tilts the inner card surface without reading layout on every pointer event", () => {
  const state = motionHarness();
  state.pointer("pointerenter");
  state.pointer("pointermove", { clientX: 200, clientY: 0 });
  state.pointer("pointermove", { clientX: 0, clientY: 100 });
  assert.equal(state.reads(), 1);
  assert.equal(state.frames.size, 1);
  assert.equal(state.surface.style.transform, "translateZ(2px)");
  state.flush();
  assert.match(state.surface.style.transform, /rotateX\(-10\.00deg\) rotateY\(-13\.00deg\)/);
  assert.equal(state.tilt.style.transform, "");
  state.pointer("pointerleave");
  state.flush();
  assert.equal(state.surface.style.transform, "translateZ(2px)");
  state.cleanup();
});

test("leaves touch and coarse pointer interactions native", () => {
  for (const options of [{ fine: false }, { fine: true }]) {
    const state = motionHarness(options);
    const pointerType = options.fine ? "touch" : "mouse";
    state.pointer("pointerenter", { pointerType });
    state.pointer("pointermove", { pointerType, clientX: 200, clientY: 0 });
    state.flush();
    assert.equal(state.reads(), 0);
    assert.equal(state.surface.style.transform, "translateZ(2px)");
    state.cleanup();
  }
});

test("applies reduced-motion changes immediately and leaves every stage selectable", () => {
  const state = motionHarness();
  state.pointer("pointerenter");
  state.pointer("pointermove", { clientX: 200, clientY: 0 });
  state.flush();
  state.reducedPreference.matches = true;
  state.reducedPreference.dispatchEvent(new Event("change"));
  assert.equal(state.surface.style.transform, "translateZ(2px)");
  assert.equal(state.ids.get("journey-scene").style.values.get("--landscape-x"), "0px");
  state.controls.forEach((button, phase) => {
    button.dispatchEvent(new Event("click"));
    assert.equal(state.ids.get("journey-scene").dataset.phase, String(phase));
    assert.equal(button.attributes.get("aria-pressed"), "true");
    assert.ok(state.ids.get("story-title").textContent.length > 0);
    assert.ok(state.ids.get("story-copy").textContent.length > 0);
  });
  assert.equal(state.scrolls.length, 0);
  state.reducedPreference.matches = false;
  state.reducedPreference.dispatchEvent(new Event("change"));
  state.flush();
  assert.equal(state.ids.get("journey-scene").dataset.phase, "0");
  state.cleanup();
});

test("remeasures the sticky offset after responsive layout changes", () => {
  const state = motionHarness();
  state.geometry.stickyTop = 64;
  state.geometry.height = 2800;
  state.browser.innerHeight = 700;
  state.browser.dispatchEvent(new Event("resize"));
  state.controls[4].dispatchEvent(new Event("click"));
  assert.deepEqual(state.scrolls.at(-1), { top: 2578, behavior: "smooth" });
  state.cleanup();
});

test("replays from the beginning in scroll and reduced-motion modes", () => {
  for (const reduced of [false, true]) {
    const state = motionHarness({ reduced });
    state.controls[4].dispatchEvent(new Event("click"));
    state.replay.dispatchEvent(new Event("click"));
    if (reduced) {
      assert.equal(state.ids.get("journey-scene").dataset.phase, "0");
      assert.equal(state.scrolls.length, 0);
    } else {
      assert.deepEqual(state.scrolls.at(-1), { top: 400, behavior: "smooth" });
    }
    state.cleanup();
  }
});

test("restores existing transforms and removes input listeners on cleanup", () => {
  const state = motionHarness();
  state.pointer("pointerenter");
  state.pointer("pointermove", { clientX: 200, clientY: 0 });
  state.flush();
  state.pointer("pointermove", { clientX: 0, clientY: 100 });
  state.cleanup();
  assert.equal(state.surface.style.transform, "translateZ(2px)");
  assert.equal(state.frames.size, 0);
  state.controls[4].dispatchEvent(new Event("click"));
  state.browser.dispatchEvent(new Event("scroll"));
  state.pointer("pointerenter");
  state.pointer("pointermove", { clientX: 200, clientY: 0 });
  assert.equal(state.scrolls.length, 0);
  assert.equal(state.frames.size, 0);
});

test("ignores malformed stage controls instead of scrolling to an invalid offset", () => {
  const state = motionHarness({ stageValues: ["invalid", -1, 5, 2.5] });
  state.controls.forEach((button) => button.dispatchEvent(new Event("click")));
  assert.equal(state.scrolls.length, 0);
  assert.equal(state.ids.get("journey-scene").dataset.phase, "0");
  state.cleanup();
});

test("does not install motion when the page has no journey scene", () => {
  const cleanup = installJourneyMotion({ getElementById: () => null }, {});
  assert.equal(typeof cleanup, "function");
  assert.doesNotThrow(cleanup);
});


test("shows seven sourced insurance valuations without presenting them as sales", async () => {
  const snapshot = JSON.parse(await readFile(new URL("../../../config/collector-showcase.json", import.meta.url), "utf8"));
  const gallery = html.slice(html.indexOf('id="cards"'), html.indexOf('id="economics"'));
  assert.equal(snapshot.cards.length, 7);
  assert.equal((gallery.match(/class="card-valuation"/g) ?? []).length, 7);
  for (const card of snapshot.cards) {
    assert.ok(gallery.includes(card.image));
    assert.ok(gallery.includes(`https://collectorcrypt.com/assets/solana/${card.nftAddress}`));
    assert.ok(gallery.includes(`$${Number(card.insuredValue).toLocaleString("en-US")}`));
  }
  assert.match(gallery, /insurance valuations in USD.*not sale prices/);
  assert.match(gallery, /Charizard/);
  assert.doesNotMatch(html, /Explore the dashboard/);
});
