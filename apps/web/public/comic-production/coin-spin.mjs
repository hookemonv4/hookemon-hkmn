export function installCoinSpin(root = globalThis.document, browser = globalThis.window) {
  const coin = root.querySelector(".hero-coin");
  if (!coin) return () => {};
  const spinner = coin.querySelector(".coin-spinner");
  const reduced = browser.matchMedia("(prefers-reduced-motion: reduce)");
  const cleanups = [];
  const edges = [];
  const segments = 96;
  for (let index = 0; index < segments; index++) {
    const edge = root.createElement("span");
    edge.className = "coin-edge";
    edge.setAttribute("aria-hidden", "true");
    edge.style.setProperty("--coin-segment-angle", `${index * 360 / segments}deg`);
    const lightness = 43 + 13 * Math.cos(index * 2 * Math.PI / segments - Math.PI / 4);
    edge.style.setProperty("--coin-edge-gold", `hsl(41 85% ${lightness}%)`);
    spinner.append(edge);
    edges.push(edge);
  }
  let angle = 0, velocity = 0, frame = 0;
  let auto = !reduced.matches, visible = true, disposed = false;
  let last = null, drag = null, suppressClick = false;
  function listen(target, name, fn) {
    target.addEventListener(name, fn);
    cleanups.push(() => target.removeEventListener(name, fn));
  }
  function measure() {
    const radius = coin.clientWidth * 0.46;
    spinner.style.setProperty("--coin-radius", `${radius}px`);
    spinner.style.setProperty("--coin-half-depth", `${radius * 0.045}px`);
    spinner.style.setProperty("--coin-segment-width", `${2 * radius * Math.tan(Math.PI / segments) + 2}px`);
  }
  function paint() {
    angle = ((angle % 360) + 360) % 360;
    spinner.style.setProperty("--coin-spin", `${angle}deg`);
  }
  function label() {
    coin.setAttribute("aria-pressed", String(!auto));
    coin.setAttribute("aria-label", reduced.matches ? "Spin coin. Drag or use left and right arrow keys." : `${auto ? "Pause" : "Start"} coin rotation. Drag to spin, or use left and right arrow keys.`);
  }
  function schedule() {
    if (!disposed && !frame && !root.hidden && visible && !drag && !reduced.matches && (auto || Math.abs(velocity) > 0.5)) frame = browser.requestAnimationFrame(tick);
  }
  function stop() {
    if (frame) browser.cancelAnimationFrame(frame);
    frame = 0;
    last = null;
  }
  function tick(now) {
    frame = 0;
    const dt = last === null ? 0 : Math.min((now - last) / 1000, 0.05);
    last = now;
    angle += ((auto ? 18 : 0) + velocity) * dt;
    velocity *= Math.exp(-2.6 * dt);
    paint();
    schedule();
  }
  function release(event) {
    if (!drag || (event && event.pointerId !== drag.id)) return;
    const id = drag.id;
    if (!event || event.type !== "pointerup" || event.timeStamp - drag.time > 100) velocity = 0;
    drag = null;
    coin.removeAttribute("data-dragging");
    if (coin.hasPointerCapture(id)) coin.releasePointerCapture(id);
    last = null;
    schedule();
  }
  listen(coin, "pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0 || drag) return;
    stop();
    suppressClick = false;
    velocity = 0;
    drag = { id: event.pointerId, x: event.clientX, startX: event.clientX, startY: event.clientY, time: event.timeStamp, active: false, width: Math.max(1, coin.getBoundingClientRect().width) };
  });
  listen(coin, "pointermove", (event) => {
    if (!drag || drag.id !== event.pointerId) return;
    const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
    if (!drag.active) {
      if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) > 8) { release(); return; }
      if (Math.abs(dx) < 5) return;
      drag.active = true;
      suppressClick = true;
      coin.setPointerCapture(drag.id);
      coin.setAttribute("data-dragging", "");
    }
    const delta = (event.clientX - drag.x) / drag.width * 360;
    velocity = reduced.matches ? 0 : Math.max(-900, Math.min(900, delta / Math.max(0.008, (event.timeStamp - drag.time) / 1000)));
    angle += delta;
    drag.x = event.clientX;
    drag.time = event.timeStamp;
    paint();
  });
  for (const event of ["pointerup", "pointercancel", "lostpointercapture"]) listen(coin, event, release);
  listen(coin, "pointerleave", (event) => { if (drag && !drag.active) release(event); });
  listen(coin, "click", () => {
    if (suppressClick) { suppressClick = false; return; }
    if (reduced.matches) { angle += 45; paint(); return; }
    auto = !auto;
    velocity = 0;
    stop(); label(); schedule();
  });
  listen(coin, "keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    angle += event.key === "ArrowRight" ? 45 : -45;
    paint();
  });
  listen(reduced, "change", () => { auto = false; velocity = 0; release(); stop(); label(); });
  listen(root, "visibilitychange", () => { release(); stop(); schedule(); });
  listen(browser, "blur", () => { release(); });
  const observer = browser.IntersectionObserver ? new browser.IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    stop(); schedule();
  }) : null;
  observer?.observe(coin);
  const resizeObserver = browser.ResizeObserver ? new browser.ResizeObserver(measure) : null;
  resizeObserver?.observe(coin);
  listen(browser, "resize", measure);
  measure();
  label(); schedule();
  return () => {
    disposed = true;
    release(); stop();
    observer?.disconnect();
    resizeObserver?.disconnect();
    cleanups.forEach((cleanup) => cleanup());
    edges.forEach((edge) => edge.remove());
  };
}
