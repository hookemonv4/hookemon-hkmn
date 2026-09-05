import { installCoinSpin } from "./coin-spin.mjs";

const STORY = [
  ["Fees fund the adventure.", "Trading fees fund the card packs. The dashboard shows the recorded pot and the current cycle status."],
  ["One pack. New possibilities.", "Hookemon uses the pack allocation to buy gacha card packs, then opens them. Each pack's contents can differ."],
  ["Meet the cards.", "The cards shown here are examples. Completed openings and their cards appear in the dashboard when recorded."],
  ["Cards become proceeds.", "Hookemon sells the opened cards. The proceeds depend on the cards and their sale prices."],
  ["Back to HKMN holders.", "The recorded proceeds are paid to eligible HKMN holders. Distribution follows the cycle's rules and recorded results."],
];

export function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

export function getJourneyProgress(sectionTop, sectionHeight, viewportHeight, stickyOffset = 0) {
  const distance = sectionHeight - viewportHeight + stickyOffset;
  return distance > 0 ? clamp((stickyOffset - sectionTop) / distance) : 0;
}

export function getJourneyPhase(progress) {
  return Math.min(STORY.length - 1, Math.floor(clamp(progress) * STORY.length));
}

export function installJourneyMotion(root = globalThis.document, browser = globalThis.window) {
  const journey = root.getElementById("journey");
  const scene = root.getElementById("journey-scene");
  if (!journey || !scene) return () => {};

  const title = root.getElementById("story-title");
  const copy = root.getElementById("story-copy");
  const index = root.getElementById("story-index");
  const progressBar = root.getElementById("journey-progress");
  const buttons = [...root.querySelectorAll("[data-scene-stage]")];
  const reducedMotion = browser.matchMedia("(prefers-reduced-motion: reduce)");
  const finePointer = browser.matchMedia("(hover: hover) and (pointer: fine)");
  const cleanups = [];
  const tilts = [...root.querySelectorAll(".js-tilt")].map((element) => {
    const surface = element.querySelector("[data-tilt-surface]") ?? element;
    return { element, surface, originalTransform: surface.style.transform, rect: null, x: 0, y: 0, active: false, dirty: false };
  });
  let frame = 0;
  let scrollDirty = true;
  let currentPhase = -1;
  let stickyOffset = 0;
  let scrollControlled = true;
  let disposed = false;

  function listen(target, event, callback, options) {
    target.addEventListener(event, callback, options);
    cleanups.push(() => target.removeEventListener(event, callback, options));
  }

  function setPhase(phase) {
    if (phase === currentPhase) return;
    currentPhase = phase;
    scene.dataset.phase = String(phase);
    if (title) title.textContent = STORY[phase][0];
    if (copy) copy.textContent = STORY[phase][1];
    if (index) index.textContent = String(phase + 1).padStart(2, "0");
    buttons.forEach((button) => {
      button.setAttribute("aria-pressed", String(Number(button.dataset.sceneStage) === phase));
    });
  }

  function setProgress(progress) {
    scene.style.setProperty("--journey-progress", String(progress));
    scene.style.setProperty("--scene-travel", String(reducedMotion.matches ? 0 : progress));
    scene.style.setProperty("--landscape-x", `${reducedMotion.matches ? 0 : (progress - 0.5) * -24}px`);
    scene.style.setProperty("--landscape-y", `${reducedMotion.matches ? 0 : (progress - 0.5) * -8}px`);
    scene.style.setProperty("--coin-scroll-rotation", `${reducedMotion.matches ? 0 : progress * 36}deg`);
    if (progressBar) progressBar.style.transform = `scaleX(${progress})`;
  }

  function render() {
    frame = 0;
    if (root.hidden || disposed) return;
    if (scrollDirty) {
      scrollDirty = false;
      if (scrollControlled) {
        const rect = journey.getBoundingClientRect();
        const progress = getJourneyProgress(rect.top, rect.height, browser.innerHeight, stickyOffset);
        setProgress(progress);
        setPhase(getJourneyPhase(progress));
      }
      tilts.forEach((tilt) => {
        if (tilt.active) tilt.rect = tilt.element.getBoundingClientRect();
      });
    }
    tilts.forEach((tilt) => {
      if (!tilt.dirty) return;
      tilt.dirty = false;
      tilt.surface.style.transform = tilt.active && finePointer.matches && !reducedMotion.matches
        ? `perspective(1000px) rotateX(${(-tilt.y * 10).toFixed(2)}deg) rotateY(${(tilt.x * 13).toFixed(2)}deg)`
        : tilt.originalTransform;
    });
  }

  function schedule() {
    if (!frame && !root.hidden && !disposed) frame = browser.requestAnimationFrame(render);
  }

  function onScroll() {
    scrollDirty = true;
    schedule();
  }

  function measure() {
    const sceneStyle = browser.getComputedStyle(scene);
    stickyOffset = Math.max(0, Number.parseFloat(sceneStyle.top) || 0);
    scrollControlled = sceneStyle.position === "sticky" && !reducedMotion.matches;
    if (!scrollControlled) setProgress(Math.max(0, currentPhase) / (STORY.length - 1));
    onScroll();
  }

  function resetTilts() {
    tilts.forEach((tilt) => {
      tilt.active = false;
      tilt.dirty = true;
      tilt.rect = null;
      tilt.surface.style.transform = tilt.originalTransform;
    });
  }

  function selectPhase(phase) {
    if (!Number.isInteger(phase) || phase < 0 || phase >= STORY.length) return;
    const progress = phase / (STORY.length - 1);
    if (!scrollControlled) {
      setPhase(phase);
      setProgress(progress);
      return;
    }
    const rect = journey.getBoundingClientRect();
    const distance = Math.max(0, rect.height - browser.innerHeight + stickyOffset);
    const top = browser.scrollY + rect.top - stickyOffset + distance * progress;
    browser.scrollTo({ top, behavior: "smooth" });
  }

  buttons.forEach((button) => {
    listen(button, "click", () => selectPhase(Number(button.dataset.sceneStage)));
  });
  root.querySelectorAll("[data-replay]").forEach((button) => {
    listen(button, "click", () => selectPhase(0));
  });

  tilts.forEach((tilt) => {
    listen(tilt.element, "pointerenter", (event) => {
      if (event.pointerType === "touch" || reducedMotion.matches || !finePointer.matches) return;
      tilt.rect = tilt.element.getBoundingClientRect();
      tilt.active = true;
    });
    listen(tilt.element, "pointermove", (event) => {
      if (!tilt.active || !tilt.rect) return;
      tilt.x = clamp((event.clientX - tilt.rect.left) / tilt.rect.width, 0, 1) * 2 - 1;
      tilt.y = clamp((event.clientY - tilt.rect.top) / tilt.rect.height, 0, 1) * 2 - 1;
      tilt.dirty = true;
      schedule();
    }, { passive: true });
    const leave = () => {
      tilt.active = false;
      tilt.dirty = true;
      schedule();
    };
    listen(tilt.element, "pointerleave", leave);
    listen(tilt.element, "pointercancel", leave);
  });

  listen(browser, "scroll", onScroll, { passive: true });
  listen(browser, "resize", measure, { passive: true });
  listen(browser, "load", measure);
  listen(finePointer, "change", () => { resetTilts(); schedule(); });
  listen(reducedMotion, "change", () => {
    resetTilts();
    setProgress(Math.max(0, currentPhase) / (STORY.length - 1));
    measure();
  });
  listen(root, "visibilitychange", () => {
    if (root.hidden) {
      if (frame) browser.cancelAnimationFrame(frame);
      frame = 0;
      resetTilts();
    } else {
      measure();
    }
  });

  setPhase(0);
  setProgress(0);
  measure();

  return () => {
    disposed = true;
    if (frame) browser.cancelAnimationFrame(frame);
    frame = 0;
    resetTilts();
    cleanups.forEach((cleanup) => cleanup());
  };
}

if (globalThis.document && globalThis.window) {
  installJourneyMotion();
  installCoinSpin();
}
