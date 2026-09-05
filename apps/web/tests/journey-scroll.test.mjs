import assert from "node:assert/strict";
import test from "node:test";
import {
  JOURNEY_ROUTE_MARKER_CLEARANCE,
  THUNDER_FINALE_THRESHOLD,
  THUNDER_HOLD_DURATION_MS,
  THUNDER_HOLD_RESET_THRESHOLD,
  installJourneyScrollTracking,
  journeyBoltPolygon,
  journeyRoutePoints,
  resolveThunderProgress,
} from "../lib/journey-route.ts";

function distanceToSegment([x, y], [ax, ay], [bx, by]) {
  const dx = bx - ax;
  const dy = by - ay;
  const denominator = dx * dx + dy * dy;
  const t = denominator
    ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / denominator))
    : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

function isInsidePolygon([x, y], polygon) {
  let inside = false;

  for (let index = 0, previous = polygon.length - 1; index < polygon.length; previous = index++) {
    const [currentX, currentY] = polygon[index];
    const [previousX, previousY] = polygon[previous];
    const crosses = currentY > y !== previousY > y;
    const boundaryX =
      ((previousX - currentX) * (y - currentY)) / (previousY - currentY) + currentX;

    if (crosses && x < boundaryX) inside = !inside;
  }

  return inside;
}

function markerClearance(point) {
  const coordinate = [point.x, point.y];
  const distances = journeyBoltPolygon.map((start, index) =>
    distanceToSegment(coordinate, start, journeyBoltPolygon[(index + 1) % journeyBoltPolygon.length]),
  );
  return isInsidePolygon(coordinate, journeyBoltPolygon) ? Math.min(...distances) : -1;
}

function createJourneyHarness({
  initialScrollBehavior = "",
  initialScrollBehaviorPriority = "",
  scrollAnchorOffset = 0,
} = {}) {
  const browserEvents = new EventTarget();
  const cancelledFrames = [];
  const queuedFrames = [];
  const timers = new Map();
  const scrollCalls = [];
  const articleTops = [480, 680, 880, 1080, 1280, 1480];
  const articles = articleTops.map((_, index) => ({
    getBoundingClientRect: () => ({ top: articleTops[index], height: 80 }),
  }));
  const styleValues = new Map();
  const rootStyleValues = new Map();
  const rootStylePriorities = new Map();
  let nextTimerId = 1;
  let scrollY = 0;

  const rootStyle = {
    getPropertyPriority: (name) => rootStylePriorities.get(name) ?? "",
    getPropertyValue: (name) => rootStyleValues.get(name) ?? "",
    removeProperty: (name) => {
      rootStyleValues.delete(name);
      rootStylePriorities.delete(name);
    },
    setProperty: (name, value, priority = "") => {
      rootStyleValues.set(name, value);
      rootStylePriorities.set(name, priority);
    },
  };
  if (initialScrollBehavior) {
    rootStyle.setProperty(
      "scroll-behavior",
      initialScrollBehavior,
      initialScrollBehaviorPriority,
    );
  }
  const section = {
    querySelectorAll: () => articles,
    querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 400 }) }),
    style: { setProperty: (name, value) => styleValues.set(name, value) },
  };
  const browser = {
    innerHeight: 1000,
    document: { documentElement: { style: rootStyle } },
    get scrollY() {
      return scrollY;
    },
    matchMedia: () => ({ matches: false }),
    addEventListener: (...args) => browserEvents.addEventListener(...args),
    removeEventListener: (...args) => browserEvents.removeEventListener(...args),
    requestAnimationFrame: (callback) => {
      queuedFrames.push(callback);
      return queuedFrames.length;
    },
    cancelAnimationFrame: (frameId) => cancelledFrames.push(frameId),
    setTimeout: (callback, delay) => {
      const timerId = nextTimerId++;
      timers.set(timerId, { callback, delay });
      return timerId;
    },
    clearTimeout: (timerId) => timers.delete(timerId),
    scrollTo: (optionsOrX, y) => {
      const requestedScrollY =
        typeof optionsOrX === "object" ? Number(optionsOrX.top ?? 0) : Number(y ?? 0);
      const nextScrollY = requestedScrollY + scrollAnchorOffset;
      const delta = nextScrollY - scrollY;
      scrollY = nextScrollY;
      articleTops.forEach((_, index) => {
        articleTops[index] -= delta;
      });
      scrollCalls.push(nextScrollY);
    },
  };
  const states = [];
  const cleanup = installJourneyScrollTracking({
    section,
    browser,
    onChange: (state) => states.push(state),
  });

  return {
    browserEvents,
    cancelledFrames,
    cleanup,
    rootStyle,
    scrollCalls,
    states,
    styleValues,
    timers,
    scrollBy: (delta) => {
      scrollY += delta;
      articleTops.forEach((_, index) => {
        articleTops[index] -= delta;
      });
      browserEvents.dispatchEvent(new Event("scroll"));
      queuedFrames.shift()?.(0);
    },
    dispatchInput: (type, key, target) => {
      const event = new Event(type, { cancelable: true });
      if (key) Object.defineProperty(event, "key", { value: key });
      if (target) Object.defineProperty(event, "target", { value: target });
      browserEvents.dispatchEvent(event);
      return event;
    },
    runOnlyTimer: () => {
      const [timerId, timer] = timers.entries().next().value;
      timers.delete(timerId);
      timer.callback();
    },
  };
}

test("keeps every numbered route marker fully inside the filled bolt", () => {
  assert.equal(journeyRoutePoints.length, 6);

  journeyRoutePoints.forEach((point, index) => {
    assert.ok(
      markerClearance(point) >= JOURNEY_ROUTE_MARKER_CLEARANCE,
      `route point ${index + 1} must clear the bolt edge by ${JOURNEY_ROUTE_MARKER_CLEARANCE}px`,
    );
  });
});

test("normalizes the visible charge at the exact finale threshold", () => {
  assert.deepEqual(resolveThunderProgress(THUNDER_FINALE_THRESHOLD - 0.0001), {
    progress: THUNDER_FINALE_THRESHOLD - 0.0001,
    displayProgress: THUNDER_FINALE_THRESHOLD - 0.0001,
    isThunderFinale: false,
  });
  assert.deepEqual(resolveThunderProgress(THUNDER_FINALE_THRESHOLD), {
    progress: THUNDER_FINALE_THRESHOLD,
    displayProgress: 1,
    isThunderFinale: true,
  });
});

test("tracks scroll from idle to a synchronized 100% finale and back to idle", () => {
  const harness = createJourneyHarness();

  assert.deepEqual(harness.states.at(-1), {
    activeIndex: 0,
    progress: 0,
    displayProgress: 0,
    isThunderFinale: false,
    isThunderHold: false,
  });

  harness.scrollBy(1000);

  assert.equal(harness.states.at(-1).activeIndex, 5);
  assert.equal(harness.states.at(-1).progress, 1);
  assert.equal(harness.states.at(-1).displayProgress, 1);
  assert.equal(harness.states.at(-1).isThunderFinale, true);
  assert.equal(harness.states.at(-1).isThunderHold, true);
  assert.equal(harness.styleValues.get("--journey-progress"), "1");

  harness.runOnlyTimer();
  harness.scrollBy(-500);

  assert.ok(harness.states.at(-1).progress < THUNDER_FINALE_THRESHOLD);
  assert.equal(harness.states.at(-1).isThunderFinale, false);
  assert.equal(harness.states.at(-1).displayProgress, harness.states.at(-1).progress);

  harness.cleanup();
});

test("holds a fast finale leap at the threshold for exactly two seconds", () => {
  const harness = createJourneyHarness();

  assert.equal(harness.states.at(-1).isThunderHold, false);
  harness.scrollBy(2500);

  assert.equal(harness.states.at(-1).isThunderFinale, true);
  assert.equal(harness.states.at(-1).isThunderHold, true);
  assert.equal(harness.states.at(-1).displayProgress, 1);
  assert.equal(harness.timers.size, 1);
  assert.equal([...harness.timers.values()][0].delay, THUNDER_HOLD_DURATION_MS);
  assert.ok(Math.abs(harness.scrollCalls.at(-1) - 965) < 0.001);
  assert.equal(harness.styleValues.get("--journey-progress"), "1");
  assert.equal(harness.dispatchInput("wheel").defaultPrevented, true);
  assert.equal(harness.dispatchInput("touchmove").defaultPrevented, true);
  assert.equal(harness.dispatchInput("keydown", "PageDown").defaultPrevented, true);

  harness.runOnlyTimer();

  assert.equal(harness.states.at(-1).isThunderHold, false);
  assert.equal(harness.dispatchInput("wheel").defaultPrevented, false);
  harness.cleanup();
});

test("preserves native control keys while blocking page scroll keys during the hold", () => {
  const harness = createJourneyHarness();
  const scrollKeyValues = [
    "ArrowDown",
    "ArrowUp",
    "PageDown",
    "PageUp",
    "Home",
    "End",
    " ",
    "Spacebar",
  ];
  const pageTarget = { tagName: "DIV", isContentEditable: false };

  harness.scrollBy(1000);
  scrollKeyValues.forEach((key) => {
    assert.equal(harness.dispatchInput("keydown", key, pageTarget).defaultPrevented, true);
  });

  const buttonTarget = { tagName: "BUTTON", isContentEditable: false };
  assert.equal(harness.dispatchInput("keydown", " ", buttonTarget).defaultPrevented, false);
  assert.equal(harness.dispatchInput("keydown", "Spacebar", buttonTarget).defaultPrevented, false);
  assert.equal(harness.dispatchInput("keydown", "PageDown", buttonTarget).defaultPrevented, true);

  [
    { tagName: "INPUT", isContentEditable: false },
    { tagName: "TEXTAREA", isContentEditable: false },
    { tagName: "SELECT", isContentEditable: false },
    { tagName: "SPAN", isContentEditable: true },
  ].forEach((target) => {
    scrollKeyValues.forEach((key) => {
      assert.equal(harness.dispatchInput("keydown", key, target).defaultPrevented, false);
    });
  });

  harness.dispatchInput("keydown", "Escape", { tagName: "INPUT", isContentEditable: false });
  assert.equal(harness.states.at(-1).isThunderHold, false);
  harness.cleanup();
});

test("cleanup cancels pending hold work and restores the prior scroll behavior", () => {
  const harness = createJourneyHarness({
    initialScrollBehavior: "smooth",
    initialScrollBehaviorPriority: "important",
  });

  harness.scrollBy(1000);
  harness.browserEvents.dispatchEvent(new Event("resize"));

  assert.equal(harness.rootStyle.getPropertyValue("scroll-behavior"), "auto");
  assert.equal(harness.rootStyle.getPropertyPriority("scroll-behavior"), "important");
  assert.equal(harness.timers.size, 1);

  harness.cleanup();

  assert.equal(harness.timers.size, 0);
  assert.deepEqual(harness.cancelledFrames, [1]);
  assert.equal(harness.dispatchInput("wheel").defaultPrevented, false);
  assert.equal(harness.dispatchInput("touchmove").defaultPrevented, false);
  assert.equal(
    harness.dispatchInput("keydown", "PageDown", {
      tagName: "DIV",
      isContentEditable: false,
    }).defaultPrevented,
    false,
  );
  assert.equal(harness.rootStyle.getPropertyValue("scroll-behavior"), "smooth");
  assert.equal(harness.rootStyle.getPropertyPriority("scroll-behavior"), "important");
});

test("keeps the finale active when the hold anchor quantizes below the threshold", () => {
  const harness = createJourneyHarness({ scrollAnchorOffset: -0.25 });

  harness.scrollBy(2500);
  harness.scrollBy(0);

  const state = harness.states.at(-1);
  assert.equal(state.isThunderFinale, true);
  assert.equal(state.displayProgress, 1);
  assert.equal(state.isThunderHold, true);
  assert.ok(state.progress >= THUNDER_FINALE_THRESHOLD);

  harness.runOnlyTimer();

  const releasedState = harness.states.at(-1);
  assert.equal(releasedState.isThunderHold, false);
  assert.equal(releasedState.isThunderFinale, false);
  assert.equal(releasedState.displayProgress, releasedState.progress);
  assert.ok(releasedState.progress < THUNDER_FINALE_THRESHOLD);
  harness.cleanup();
});

test("releases on Escape and rearms only after leaving the finale", () => {
  const harness = createJourneyHarness();
  harness.scrollBy(1000);

  assert.equal(harness.states.at(-1).isThunderHold, true);
  harness.dispatchInput("keydown", "Escape");
  assert.equal(harness.states.at(-1).isThunderHold, false);
  assert.equal(harness.timers.size, 0);

  harness.scrollBy(20);
  assert.equal(harness.timers.size, 0);

  harness.scrollBy(-200);
  assert.ok(harness.states.at(-1).progress < THUNDER_HOLD_RESET_THRESHOLD);
  harness.scrollBy(200);
  assert.equal(harness.states.at(-1).isThunderHold, true);
  assert.equal(harness.timers.size, 1);

  harness.cleanup();
  assert.equal(harness.timers.size, 0);
  assert.equal(harness.dispatchInput("wheel").defaultPrevented, false);
});
