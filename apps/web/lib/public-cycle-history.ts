import {
  readDashboardProfile,
  type DashboardNetwork,
  type DashboardProfileId,
} from "./public-dashboard-profile.ts";

// Mirrors packages/dashboard/src/contracts/public-cycle-history.mjs's schemaVersion 1 contract
// verbatim (read off F's committed source on codex/launch-f). A cycle without a verified
// terminalAt is never silently reordered around or hidden -- itemOrderDescends treats a null
// terminalAt as unorderable relative to its neighbor, matching the producer's own fail-closed
// pagination (a source set missing even one terminalAtMs returns items:[] historyComplete:false
// entirely, rather than ordering the reachable subset).
export type PublicCycleHistoryItem = {
  cycleId: string;
  status: string;
  terminalAt: string | null;
  updatedAt: string | null;
};

export type PublicCycleHistory = {
  schemaVersion: 1;
  profile: DashboardProfileId;
  network: DashboardNetwork;
  generatedAt: string;
  asOf: string;
  historyComplete: boolean;
  items: PublicCycleHistoryItem[];
  nextCursor: string | null;
};

const RESPONSE_KEYS = new Set([
  "schemaVersion",
  "profile",
  "network",
  "generatedAt",
  "asOf",
  "historyComplete",
  "items",
  "nextCursor",
]);
const ITEM_KEYS = new Set(["cycleId", "status", "terminalAt", "updatedAt"]);
const NETWORK_KEYS = new Set(["evm", "solana"]);
const EVM_NETWORK_KEYS = new Set(["name", "chainId", "label"]);
const SOLANA_NETWORK_KEYS = new Set(["name", "genesisHash", "label"]);
const MAX_TEXT_LENGTH = 512;
export const MAX_HISTORY_PAGE_SIZE = 20;

export function normalizePublicCycleHistory(
  value: unknown,
  expectedProfile?: DashboardProfileId,
): PublicCycleHistory {
  try {
    return readPublicCycleHistory(value, expectedProfile);
  } catch {
    throw new TypeError("PUBLIC_CYCLE_HISTORY_INVALID");
  }
}

function readPublicCycleHistory(
  value: unknown,
  expectedProfile?: DashboardProfileId,
): PublicCycleHistory {
  const source = requiredRecord(value);
  exactKeys(source, RESPONSE_KEYS);
  requiredKeys(source, RESPONSE_KEYS);
  if (source.schemaVersion !== 1) invalid();
  const selected = readDashboardProfile(source.profile as string);
  if (expectedProfile !== undefined && readDashboardProfile(expectedProfile).id !== selected.id) invalid();
  const generatedAt = isoTimestamp(source.generatedAt);
  const asOf = isoTimestamp(source.asOf);
  if (Date.parse(asOf) > Date.parse(generatedAt)) invalid();
  if (typeof source.historyComplete !== "boolean") invalid();
  const items = boundedArray(source.items, MAX_HISTORY_PAGE_SIZE).map(readItem);
  for (let index = 1; index < items.length; index += 1) {
    if (!itemOrderDescends(items[index - 1], items[index])) invalid();
  }
  if (!source.historyComplete && (items.length !== 0 || source.nextCursor !== null)) invalid();
  return {
    schemaVersion: 1,
    profile: selected.id,
    network: readNetwork(source.network, selected.network),
    generatedAt,
    asOf,
    historyComplete: source.historyComplete,
    items,
    nextCursor: source.nextCursor === null ? null : boundedText(source.nextCursor),
  };
}

function itemOrderDescends(previous: PublicCycleHistoryItem, current: PublicCycleHistoryItem): boolean {
  if (previous.terminalAt === null || current.terminalAt === null) return true;
  const previousMs = Date.parse(previous.terminalAt);
  const currentMs = Date.parse(current.terminalAt);
  if (previousMs !== currentMs) return previousMs > currentMs;
  return previous.cycleId.localeCompare(current.cycleId) < 0;
}

function readNetwork(value: unknown, expected: DashboardNetwork): DashboardNetwork {
  const source = requiredRecord(value);
  exactKeys(source, NETWORK_KEYS);
  requiredKeys(source, NETWORK_KEYS);
  const evm = requiredRecord(source.evm);
  const solana = requiredRecord(source.solana);
  exactKeys(evm, EVM_NETWORK_KEYS);
  exactKeys(solana, SOLANA_NETWORK_KEYS);
  requiredKeys(evm, EVM_NETWORK_KEYS);
  requiredKeys(solana, SOLANA_NETWORK_KEYS);
  if (
    evm.name !== expected.evm.name ||
    evm.chainId !== expected.evm.chainId ||
    evm.label !== expected.evm.label ||
    solana.name !== expected.solana.name ||
    solana.genesisHash !== expected.solana.genesisHash ||
    solana.label !== expected.solana.label
  ) invalid();
  return expected;
}

function readItem(value: unknown): PublicCycleHistoryItem {
  const source = requiredRecord(value);
  exactKeys(source, ITEM_KEYS);
  requiredKeys(source, ITEM_KEYS);
  return {
    cycleId: boundedText(source.cycleId),
    status: boundedText(source.status),
    terminalAt: optionalTimestamp(source.terminalAt),
    updatedAt: optionalTimestamp(source.updatedAt),
  };
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

function requiredKeys(value: Record<string, unknown>, required: ReadonlySet<string> | readonly string[]) {
  for (const key of required) {
    if (!Object.hasOwn(value, key)) invalid();
  }
}

function exactKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) invalid();
  }
}

function boundedArray(value: unknown, maximumLength: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximumLength) invalid();
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) invalid();
  }
  return value;
}

function boundedText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH) invalid();
  return value;
}

function optionalTimestamp(value: unknown): string | null {
  return value === null ? null : isoTimestamp(value);
}

function isoTimestamp(value: unknown): string {
  const text = boundedText(value);
  const timestamp = new Date(text);
  if (Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== text) invalid();
  return text;
}

function invalid(): never {
  throw new TypeError("PUBLIC_CYCLE_HISTORY_INVALID");
}
