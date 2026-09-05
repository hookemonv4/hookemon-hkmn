export type CycleStartProjectPool = {
  cycleStartProjectPoolMicroUsdg: string | null;
  cycleStartProjectPoolObservedAt: string | null;
};

const DASHBOARD_RESPONSE_INVALID = "Dashboard-Daten sind ungültig oder nicht verfügbar.";

export function decodeCycleStartProjectPool(
  poolMicroUsdg: unknown,
  poolObservedAt: unknown,
): CycleStartProjectPool {
  const decodedPool = poolMicroUsdg === null ? null : dashboardMoney(poolMicroUsdg);
  const decodedObservedAt = poolObservedAt === null ? null : dashboardTimestamp(poolObservedAt);
  if ((decodedPool === null) !== (decodedObservedAt === null)) {
    throw new Error(DASHBOARD_RESPONSE_INVALID);
  }
  return {
    cycleStartProjectPoolMicroUsdg: decodedPool,
    cycleStartProjectPoolObservedAt: decodedObservedAt,
  };
}

export function formatCycleStartProjectPool(pool: CycleStartProjectPool): string {
  if (pool.cycleStartProjectPoolMicroUsdg === null || pool.cycleStartProjectPoolObservedAt === null) {
    return "Nicht beobachtet";
  }
  return `${formatMicroUsdg(pool.cycleStartProjectPoolMicroUsdg)} · Stand ${formatDate(pool.cycleStartProjectPoolObservedAt)}`;
}

function dashboardMoney(value: unknown): string {
  if (typeof value !== "string" || !/^\d{1,78}$/.test(value)) {
    throw new Error(DASHBOARD_RESPONSE_INVALID);
  }
  return value;
}

function dashboardTimestamp(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !Number.isFinite(Date.parse(value))) {
    throw new Error(DASHBOARD_RESPONSE_INVALID);
  }
  return value;
}

function formatMicroUsdg(value: string): string {
  const amount = Number(value) / 1_000_000;
  return `${new Intl.NumberFormat("de-DE", { maximumFractionDigits: 6 }).format(amount)} USDG`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("de-DE", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}
