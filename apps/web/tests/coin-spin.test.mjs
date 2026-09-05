import assert from "node:assert/strict";
import test from "node:test";
import { installCoinSpin } from "../public/comic-production/coin-spin.mjs";

function fixture(reduce = false) {
  function element() {
    const listeners = new Map(), attributes = new Map(), styles = new Map();
    return {
      attributes, styles,
      style: { setProperty: (k, v) => styles.set(k, v) },
      addEventListener: (k, fn) => listeners.set(k, fn),
      removeEventListener: (k) => listeners.delete(k),
      emit: (type, props = {}) => listeners.get(type)?.({ type, pointerId: 1, isPrimary: true, button: 0, clientX: 0, clientY: 0, timeStamp: 0, ...props }),
      setAttribute: (k, v) => attributes.set(k, v), removeAttribute: (k) => attributes.delete(k),
      cloneNode: () => element(), append() {}, remove() {},
    };
  }
  const coin = element(), spinner = element(), front = element();
  const root = element(), browser = element(), media = element();
  let captured = false, id = 0, now = 0, observe;
  const frames = new Map();
  coin.querySelector = (s) => s === ".coin-spinner" ? spinner : front;
  coin.getBoundingClientRect = () => ({ width: 400 });
  coin.clientWidth = 400;
  coin.setPointerCapture = () => { captured = true; };
  coin.hasPointerCapture = () => captured;
  coin.releasePointerCapture = () => { captured = false; };
  root.querySelector = () => coin;
  root.createElement = () => element();
  media.matches = reduce;
  browser.matchMedia = () => media;
  browser.requestAnimationFrame = (fn) => { frames.set(++id, fn); return id; };
  browser.cancelAnimationFrame = (key) => frames.delete(key);
  browser.IntersectionObserver = class { constructor(fn) { observe = fn; } observe() {} disconnect() {} };
  const cleanup = installCoinSpin(root, browser);
  const step = () => { now += 16; const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach((fn) => fn(now)); };
  return { coin, root, media, frames, cleanup, step, visible: (value) => observe([{ isIntersecting: value }]), angle: () => parseFloat(spinner.styles.get("--coin-spin") ?? 0) };
}

test("coin rotates, pauses on click, and suspends offscreen and hidden work", () => {
  const f = fixture();
  f.step(); f.step();
  assert.ok(f.angle() > 0);
  f.visible(false);
  assert.equal(f.frames.size, 0);
  f.visible(true);
  assert.equal(f.frames.size, 1);
  f.root.hidden = true; f.root.emit("visibilitychange");
  assert.equal(f.frames.size, 0);
  f.root.hidden = false; f.root.emit("visibilitychange");
  f.coin.emit("click");
  assert.equal(f.frames.size, 0);
  assert.equal(f.coin.attributes.get("aria-pressed"), "true");
  f.cleanup();
});

test("drag turns both ways and release keeps momentum without triggering a click", () => {
  const f = fixture();
  f.coin.emit("click"); // Pause automatic rotation to isolate the flick.
  f.coin.emit("pointerdown");
  f.coin.emit("pointermove", { clientX: 100, timeStamp: 100 });
  assert.equal(f.angle(), 90);
  f.coin.emit("pointermove", { clientX: 50, timeStamp: 150 });
  assert.equal(f.angle(), 45);
  f.coin.emit("pointerup", { timeStamp: 160 });
  f.coin.emit("click");
  assert.equal(f.coin.attributes.get("aria-pressed"), "true");
  f.step(); f.step();
  assert.ok(f.angle() < 45);
  f.cleanup();
  assert.equal(f.frames.size, 0);
});

test("vertical touch intent and cancellation never leave the coin captured", () => {
  const f = fixture();
  f.coin.emit("pointerdown");
  f.coin.emit("pointermove", { clientX: 2, clientY: 30 });
  assert.equal(f.angle(), 0);
  assert.equal(f.coin.hasPointerCapture(), false);
  f.coin.emit("pointerdown");
  f.coin.emit("pointermove", { clientX: 80, timeStamp: 20 });
  assert.equal(f.coin.hasPointerCapture(), true);
  f.coin.emit("pointercancel");
  assert.equal(f.coin.hasPointerCapture(), false);
  f.cleanup();
});

test("reduced motion permits direct rotation without autoplay or inertia", () => {
  const f = fixture(true);
  assert.equal(f.frames.size, 0);
  f.coin.emit("pointerdown");
  f.coin.emit("pointermove", { clientX: 100, timeStamp: 50 });
  f.coin.emit("pointerup", { timeStamp: 60 });
  assert.equal(f.angle(), 90);
  assert.equal(f.frames.size, 0);
  f.coin.emit("keydown", { key: "ArrowLeft", preventDefault() {} });
  assert.equal(f.angle(), 45);
  f.cleanup();
});
