import assert from "node:assert/strict";
import test from "node:test";

import {
  clampUnit,
  resolveComicFrame,
  resolveComicTime,
} from "../lib/comic-scroll.ts";

test("clamps scroll progress to the unit interval", () => {
  assert.equal(clampUnit(-1), 0);
  assert.equal(clampUnit(0.35), 0.35);
  assert.equal(clampUnit(2), 1);
  assert.equal(clampUnit(Number.NaN), 0);
});

test("maps the complete route across six clips without crossing the final index", () => {
  assert.deepEqual(resolveComicFrame(0, 6), { clipIndex: 0, localProgress: 0 });
  assert.deepEqual(resolveComicFrame(0.5, 6), { clipIndex: 3, localProgress: 0 });
  assert.deepEqual(resolveComicFrame(1, 6), { clipIndex: 5, localProgress: 1 });
});

test("maps local progress to a finite seek time inside the media duration", () => {
  assert.equal(resolveComicTime(0.5, 7), 3.48);
  assert.equal(resolveComicTime(1, 7), 6.96);
  assert.equal(resolveComicTime(0.5, Number.NaN), 0);
});
