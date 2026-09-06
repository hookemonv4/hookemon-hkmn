import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeCycleStartProjectPool,
  formatCycleStartProjectPool,
} from "../lib/operator-dashboard-pool.ts";

test("renders cycle-start pool observations in German", () => {
  const unobserved = decodeCycleStartProjectPool(null, null);
  assert.deepEqual(unobserved, {
    cycleStartProjectPoolMicroUsdg: null,
    cycleStartProjectPoolObservedAt: null,
  });
  assert.equal(formatCycleStartProjectPool(unobserved), "Nicht beobachtet");

  const observed = decodeCycleStartProjectPool(
    "70000000",
    "2026-08-10T00:00:00.000Z",
  );
  assert.deepEqual(observed, {
    cycleStartProjectPoolMicroUsdg: "70000000",
    cycleStartProjectPoolObservedAt: "2026-08-10T00:00:00.000Z",
  });
  assert.match(formatCycleStartProjectPool(observed), /^70 USDG · Stand /);
});

test("rejects malformed or partially observed cycle-start pool pairs", () => {
  for (const [poolMicroUsdg, poolObservedAt] of [
    [null, "2026-08-10T00:00:00.000Z"],
    ["70000000", null],
  ]) {
    assert.throws(
      () => decodeCycleStartProjectPool(poolMicroUsdg, poolObservedAt),
      { message: "Dashboard-Daten sind ungültig oder nicht verfügbar." },
    );
  }
});
