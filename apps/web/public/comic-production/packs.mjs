const list = document.querySelector("#pack-list");
const status = document.querySelector("#catalog-status");
const refresh = document.querySelector("#refresh-packs");
const currency = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const label = value => value.charAt(0).toUpperCase() + value.slice(1);
const element = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
function sourceLink(url, text) { const link = element("a", "", text); link.href = url; link.target = "_blank"; link.rel = "noopener noreferrer"; return link; }
async function get(url, signal) { const response = await fetch(url, { signal, cache: "no-store" }); const body = await response.json(); if (!response.ok) throw new Error(body.error || "Inventory unavailable."); return body; }
const time = date => new Date(date).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const availability = value => value === "open" ? "Provider reports open" : value === "closed" ? "Provider reports closed" : "Availability not reported";

function cardView(card) {
  const article = element("article", "inventory-card"); article.dataset.rarity = card.rarity;
  const imageArea = element("div", "inventory-image");
  if (card.image) { const image = element("img"); image.src = card.image; image.alt = card.name; image.loading = "lazy"; image.width = 250; image.height = 350; image.addEventListener("error", () => imageArea.replaceChildren(element("p", "pack-status", "Image unavailable")), { once: true }); imageArea.append(image); }
  else imageArea.append(element("p", "pack-status", "Image unavailable"));
  const copy = element("div", "inventory-copy");
  copy.append(element("p", "inventory-tier", `${label(card.rarity)} · ${card.gradingCompany || "Grade not reported"}`), element("h3", "", card.name), element("p", "inventory-value", currency.format(card.insuredValue)), element("p", "inventory-value-note", "Provider insured value · USD"));
  const details = element("details"); details.append(element("summary", "", "Card details & reverse"));
  const dl = element("dl");
  for (const [name, value] of [["Grade", card.grade], ["Certificate", card.certification], ["Year", card.year], ["Category", card.category], ["Variant", card.parallel], ["Grade population", card.population], ["Vault", card.vault]]) { dl.append(element("dt", "", name), element("dd", "", value === null || value === undefined ? "Not reported" : String(value))); }
  details.append(dl);
  if (card.backImage) { const image = element("img"); image.src = card.backImage; image.alt = `Reverse of ${card.name}`; image.loading = "lazy"; image.addEventListener("error", () => image.replaceWith(element("p", "", "Reverse image unavailable")), { once: true }); details.append(image); }
  details.append(sourceLink(card.sourceUrl, "View provider record ↗")); copy.append(details); article.append(imageArea, copy); return article;
}

function packView(pack) {
  const accordion = element("details", "pack-accordion"); const summary = element("summary");
  const glyph = element("span", "pack-glyph"); glyph.setAttribute("aria-hidden", "true"); const mark = element("img"); mark.src = "/hookemon-symbol.svg"; mark.alt = ""; glyph.append(mark);
  const main = element("div", "pack-summary-main"); main.append(element("h3", "", pack.name), element("p", "", `${pack.contains} card${pack.contains === 1 ? "" : "s"} per pack · ${availability(pack.availability)}`));
  const plus = element("span", "pack-chevron", "+"); plus.setAttribute("aria-hidden", "true");
  summary.append(glyph, main, element("span", "pack-price", currency.format(pack.price)), plus); accordion.append(summary);
  const body = element("div", "pack-body"); const intro = element("div", "pack-body-intro"); intro.append(element("p", "", "Choose a rarity to browse its current cards. Value bands are provider insured values."), sourceLink(pack.sourceUrl, "View this pack at Collector Crypt ↗"));
  const filters = element("div", "pack-filters"); filters.setAttribute("role", "group"); filters.setAttribute("aria-label", `${pack.name} rarity filters`);
  const message = element("p", "inventory-status"); message.setAttribute("role", "status");
  const grid = element("div", "inventory-grid"); const more = element("button", "inventory-more", "Load more cards"); more.type = "button"; more.hidden = true;
  let active = "epic", page = 0, loaded = false, busy = false, loadedAt = 0, requestId = 0, controller;
  const seen = new Set(); const buttons = [];
  async function load(reset) {
    if (busy && !reset) return;
    controller?.abort(); controller = new AbortController(); const id = ++requestId; busy = true;
    if (reset) { page = 0; seen.clear(); grid.replaceChildren(); }
    more.hidden = true; more.disabled = true; message.textContent = `Loading ${label(active)} cards…`;
    try {
      const data = await get(`/api/packs/inventory?${new URLSearchParams({ code: pack.code, rarity: active, page: String(page + 1) })}`, controller.signal);
      if (id !== requestId) return;
      for (const card of data.cards) if (!seen.has(card.id)) { seen.add(card.id); grid.append(cardView(card)); }
      page = data.page; loaded = true; loadedAt = Date.now();
      message.textContent = `${seen.size} ${label(active)} card${seen.size === 1 ? "" : "s"} loaded${data.hasMore ? " · more available" : ""}. ${availability(data.availability)}. Checked ${time(data.fetchedAt)}. Inventory may change before purchase.`;
      if (!seen.size) message.textContent = `No ${label(active)} cards reported in this pack at ${time(data.fetchedAt)}. This is not a guaranteed future inventory.`;
      more.textContent = "Load more cards"; more.hidden = !data.hasMore;
    } catch (error) {
      if (id !== requestId || error.name === "AbortError") return;
      // Clear previous pages rather than displaying an old snapshot as available stock.
      page = 0; seen.clear(); grid.replaceChildren(); loaded = false;
      message.textContent = `${error.message} No current inventory is shown.`; more.textContent = "Retry inventory"; more.hidden = false;
    } finally { if (id === requestId) { busy = false; more.disabled = false; } }
  }
  for (const tier of pack.tiers) {
    const button = element("button"); button.type = "button"; button.setAttribute("aria-pressed", String(active === tier.rarity));
    button.append(element("span", "", label(tier.rarity)), element("small", "", tier.minimum === null ? "Value band not reported" : tier.maximum === null ? `${currency.format(tier.minimum)}+` : `${currency.format(tier.minimum)} – ${currency.format(tier.maximum)}`));
    button.addEventListener("click", () => { active = tier.rarity; buttons.forEach(([node, rarity]) => node.setAttribute("aria-pressed", String(rarity === active))); load(true); });
    buttons.push([button, tier.rarity]); filters.append(button);
  }
  more.addEventListener("click", () => load(page === 0));
  accordion.addEventListener("toggle", () => { if (accordion.open && (!loaded || Date.now() - loadedAt > 60_000) && !busy) load(true); if (!accordion.open && busy) { controller?.abort(); requestId++; busy = false; loaded = false; } });
  body.append(intro, filters, message, grid, more); accordion.append(body); return accordion;
}

let catalogueRequest;
async function loadCatalogue() {
  catalogueRequest?.abort(); const controller = new AbortController(); catalogueRequest = controller;
  refresh.disabled = true; list.replaceChildren(); status.textContent = "Loading the provider catalogue…";
  try {
    const data = await get("/api/packs", controller.signal);
    status.textContent = `${data.packs.length} publicly listed Pokémon packs · checked ${time(data.fetchedAt)}. Expand a pack to load its inventory.`;
    list.replaceChildren(...data.packs.map(packView));
    if (!data.packs.length) status.textContent = "No public Pokémon packs reported by the provider.";
  } catch (error) { if (error.name !== "AbortError") { status.textContent = `${error.message} `; status.append(sourceLink("https://gacha.collectorcrypt.com/", "View provider ↗")); } }
  finally { if (catalogueRequest === controller) refresh.disabled = false; }
}
refresh.addEventListener("click", loadCatalogue);
loadCatalogue();
