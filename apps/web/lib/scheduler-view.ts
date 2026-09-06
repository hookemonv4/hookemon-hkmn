// Renderer-side port of the frozen plan contract (see docs/modules/public-website.md) mirroring
// packages/runner/src/scheduler/scheduler.mjs's getView() (see E-interface.json):
//   type SchedulerView = {
//     nextCycleAt: string | null; nextReconcileAt: string | null;
//     automationEnabled: boolean; paused: boolean; pendingReason: string | null;
//   };
// nextCycleAt and nextReconcileAt are mutually exclusive at any instant (one timer drives the
// loop); this module only validates/presents that shape, it does not fetch it -- no backend
// route emitting it has landed yet.

const MAX_TEXT_LENGTH = 512;
const SCHEDULER_VIEW_KEYS = new Set([
  "nextCycleAt", "nextReconcileAt", "automationEnabled", "paused", "pendingReason",
]);

export type SchedulerView = {
  nextCycleAt: string | null;
  nextReconcileAt: string | null;
  automationEnabled: boolean;
  paused: boolean;
  pendingReason: string | null;
};

export function normalizeSchedulerView(value: unknown): SchedulerView {
  const source = requiredRecord(value);
  exactKeys(source, SCHEDULER_VIEW_KEYS);
  requiredKeys(source, SCHEDULER_VIEW_KEYS);
  const nextCycleAt = nullableTimestamp(source.nextCycleAt);
  const nextReconcileAt = nullableTimestamp(source.nextReconcileAt);
  if (nextCycleAt !== null && nextReconcileAt !== null) invalid();
  return {
    nextCycleAt,
    nextReconcileAt,
    automationEnabled: boolean(source.automationEnabled),
    paused: boolean(source.paused),
    pendingReason: nullableText(source.pendingReason),
  };
}

export type SchedulerWakeupKind = "cycle" | "reconcile" | "none";

export type SchedulerPresentation = {
  wakeupKind: SchedulerWakeupKind;
  countdownTarget: string | null;
  automationLabel: string;
  pausedLabel: string;
  reasonLabel: string | null;
};

const KNOWN_REASON_LABELS: Readonly<Record<string, string>> = Object.freeze({
  INSUFFICIENT_FUNDS: "Waiting for sufficient funds",
  LEASE_HELD_BY_ANOTHER_RUNNER: "Another runner holds the active lease",
  RECONCILING_PENDING_TRANSACTION: "Reconciling a pending transaction",
  TICK_FAILED: "Last tick failed; retrying",
  STATE_UNAVAILABLE: "Operator state is unavailable",
  WORKER_UNAVAILABLE: "Execution worker is unavailable",
  CONFIGURATION_NOT_SET: "Configuration is not set",
  SCHEDULER_STOPPED: "Scheduler is stopped",
});

/**
 * Presents the scheduler's real wakeup and blocking state. `nextCycleAt` and `nextReconcileAt`
 * are mutually exclusive (enforced by normalizeSchedulerView): whichever is non-null is the
 * actually scheduled wakeup, so this never invents a "next cycle" countdown while a reconcile
 * retry is what's really pending. `automationEnabled`/`paused` are reported independently of
 * `pendingReason`, since a specific external block (e.g. INSUFFICIENT_FUNDS) can co-exist with
 * automation being otherwise enabled and unpaused.
 */
export function presentSchedulerView(view: SchedulerView): SchedulerPresentation {
  const wakeupKind: SchedulerWakeupKind = view.nextCycleAt !== null
    ? "cycle"
    : view.nextReconcileAt !== null
      ? "reconcile"
      : "none";
  return {
    wakeupKind,
    countdownTarget: view.nextCycleAt ?? view.nextReconcileAt,
    automationLabel: view.automationEnabled ? "Automation enabled" : "Automation disabled",
    pausedLabel: view.paused ? "Paused" : "Not paused",
    reasonLabel: view.pendingReason === null ? null : humanizeReason(view.pendingReason),
  };
}

function humanizeReason(reason: string): string {
  const known = KNOWN_REASON_LABELS[reason];
  if (known !== undefined) return known;
  const policyRefused = /^POLICY_REFUSED_(.+)$/.exec(reason);
  if (policyRefused) return `Policy refused: ${humanizeCode(policyRefused[1])}`;
  const recoveryRefused = /^RECOVERY_REFUSED_(.+)$/.exec(reason);
  if (recoveryRefused) return `Recovery refused: ${humanizeCode(recoveryRefused[1])}`;
  return humanizeCode(reason);
}

function humanizeCode(code: string): string {
  return code
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part[0].toUpperCase()}${part.slice(1).toLowerCase()}`)
    .join(" ");
}

function requiredRecord(value: unknown): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  ) invalid();
  return value as Record<string, unknown>;
}

function requiredKeys(value: Record<string, unknown>, required: ReadonlySet<string>) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid();
  }
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid();
  }
}

function boundedText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH) invalid();
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : boundedText(value);
}

function isoTimestamp(value: unknown): string {
  const text = boundedText(value);
  const timestamp = new Date(text);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== text) invalid();
  return text;
}

function nullableTimestamp(value: unknown): string | null {
  return value === null ? null : isoTimestamp(value);
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") invalid();
  return value;
}

function invalid(): never {
  throw new TypeError("SCHEDULER_VIEW_INVALID");
}
