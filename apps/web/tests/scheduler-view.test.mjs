import assert from "node:assert/strict";
import test from "node:test";

import { normalizeSchedulerView, presentSchedulerView } from "../lib/scheduler-view.ts";

const activeCycleView = {
  nextCycleAt: "2026-09-06T12:00:00.000Z", nextReconcileAt: null,
  automationEnabled: true, paused: false, pendingReason: null,
};

test("normalizeSchedulerView accepts the exact frozen shape", () => {
  assert.deepEqual(normalizeSchedulerView(activeCycleView), activeCycleView);
});

test("normalizeSchedulerView rejects nextCycleAt and nextReconcileAt both set", () => {
  assert.throws(
    () => normalizeSchedulerView({
      ...activeCycleView, nextReconcileAt: "2026-09-06T12:05:00.000Z",
    }),
    /SCHEDULER_VIEW_INVALID/,
  );
});

test("normalizeSchedulerView rejects extra, missing, or malformed fields", () => {
  const mutations = [
    (view) => { view.extra = true; },
    (view) => { delete view.paused; },
    (view) => { view.automationEnabled = "true"; },
    (view) => { view.pendingReason = ""; },
    (view) => { view.nextCycleAt = "not-a-timestamp"; },
  ];
  for (const mutate of mutations) {
    const view = structuredClone(activeCycleView);
    mutate(view);
    assert.throws(() => normalizeSchedulerView(view), /SCHEDULER_VIEW_INVALID/);
  }
});

test("normalizeSchedulerView accepts a fully idle/stopped view (both wakeups null)", () => {
  const idle = {
    nextCycleAt: null, nextReconcileAt: null,
    automationEnabled: false, paused: true, pendingReason: "SCHEDULER_STOPPED",
  };
  assert.deepEqual(normalizeSchedulerView(idle), idle);
});

test("presentSchedulerView surfaces the actually scheduled wakeup, never both", () => {
  const cycle = presentSchedulerView(normalizeSchedulerView(activeCycleView));
  assert.equal(cycle.wakeupKind, "cycle");
  assert.equal(cycle.countdownTarget, activeCycleView.nextCycleAt);

  const reconciling = presentSchedulerView(normalizeSchedulerView({
    nextCycleAt: null, nextReconcileAt: "2026-09-06T12:00:05.000Z",
    automationEnabled: true, paused: false, pendingReason: "RECONCILING_PENDING_TRANSACTION",
  }));
  assert.equal(reconciling.wakeupKind, "reconcile");
  assert.equal(reconciling.countdownTarget, "2026-09-06T12:00:05.000Z");
  assert.equal(reconciling.reasonLabel, "Reconciling a pending transaction");

  const idle = presentSchedulerView(normalizeSchedulerView({
    nextCycleAt: null, nextReconcileAt: null,
    automationEnabled: false, paused: true, pendingReason: null,
  }));
  assert.equal(idle.wakeupKind, "none");
  assert.equal(idle.countdownTarget, null);
  assert.equal(idle.reasonLabel, null);
});

test("presentSchedulerView reports automation and paused independently of the block reason", () => {
  const blockedButEnabled = presentSchedulerView(normalizeSchedulerView({
    nextCycleAt: null, nextReconcileAt: null,
    automationEnabled: true, paused: false, pendingReason: "INSUFFICIENT_FUNDS",
  }));
  assert.equal(blockedButEnabled.automationLabel, "Automation enabled");
  assert.equal(blockedButEnabled.pausedLabel, "Not paused");
  assert.equal(blockedButEnabled.reasonLabel, "Waiting for sufficient funds");
});

test("presentSchedulerView humanizes known, prefixed, and unknown reason codes without hiding them", () => {
  const view = (pendingReason) => presentSchedulerView(normalizeSchedulerView({
    nextCycleAt: null, nextReconcileAt: null, automationEnabled: true, paused: false, pendingReason,
  }));
  assert.equal(view("LEASE_HELD_BY_ANOTHER_RUNNER").reasonLabel, "Another runner holds the active lease");
  assert.equal(view("POLICY_REFUSED_MAX_BOOSTERS_EXCEEDED").reasonLabel, "Policy refused: Max Boosters Exceeded");
  assert.equal(view("RECOVERY_REFUSED_STALE_REVISION").reasonLabel, "Recovery refused: Stale Revision");
  // A future/unrecognized reason must still be shown, humanized, never dropped or guessed away.
  assert.equal(view("SOME_FUTURE_REASON").reasonLabel, "Some Future Reason");
});
