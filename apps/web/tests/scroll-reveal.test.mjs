import assert from "node:assert/strict";
import test from "node:test";
import { installRevealTracking } from "../lib/scroll-reveal.ts";

function fakeElement(reveal = "up") {
  const classes = new Set();
  return {
    dataset: { reveal },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
  };
}

function fakeRoot(elements) {
  return { querySelectorAll: () => elements };
}

test("reveals elements when they become visible and stops observing after", () => {
  const first = fakeElement();
  const second = fakeElement("left");
  const callbacks = new Map();
  const disposed = [];
  const cleanup = installRevealTracking(fakeRoot([first, second]), {
    observe: (element, onVisible) => {
      callbacks.set(element, onVisible);
      return () => disposed.push(element);
    },
  });

  assert.equal(first.classList.contains("is-revealed"), false);
  callbacks.get(first)(true);
  assert.equal(first.classList.contains("is-revealed"), true);
  assert.equal(second.classList.contains("is-revealed"), false);
  assert.deepEqual(disposed, [first], "revealed element is unobserved once");

  callbacks.get(second)(false);
  assert.equal(second.classList.contains("is-revealed"), false);

  cleanup();
  assert.ok(disposed.includes(second), "cleanup unobserves remaining elements");
});

test("cleanup is idempotent and safe with zero targets", () => {
  const cleanup = installRevealTracking(fakeRoot([]), {
    observe: () => () => {},
  });
  cleanup();
  cleanup();
});

test("elements already revealed are not re-observed by a second install", () => {
  const element = fakeElement();
  const observed = [];
  const options = {
    observe: (target, onVisible) => {
      observed.push(target);
      onVisible(true);
      return () => {};
    },
  };
  installRevealTracking(fakeRoot([element]), options);
  installRevealTracking(fakeRoot([element]), options);
  assert.equal(observed.length, 1, "second install skips revealed element");
});
