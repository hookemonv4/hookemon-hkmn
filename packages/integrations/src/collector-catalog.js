const PACK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/;
const STOCK_TIERS = ["common", "uncommon", "rare", "epic"];
const DEFAULT_TIMEOUT_MS = 3_500;
const MAX_RESPONSE_BYTES = 1_048_576;

export class CollectorCatalogClient {
  #apiKey;
  #baseUrl;
  #fetchImpl;
  #now;
  #timeoutMs;

  constructor({ baseUrl, apiKey, fetchImpl = fetch, now = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.#baseUrl = collectorOrigin(baseUrl);
    if (typeof apiKey !== "string" || apiKey.length === 0 || apiKey.trim() !== apiKey) {
      throw new TypeError("COLLECTOR_CATALOG_API_KEY_INVALID");
    }
    if (
      typeof fetchImpl !== "function" ||
      typeof now !== "function" ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0
    ) {
      throw new TypeError("COLLECTOR_CATALOG_CLIENT_INVALID");
    }
    this.#apiKey = apiKey;
    this.#fetchImpl = fetchImpl;
    this.#now = now;
    this.#timeoutMs = timeoutMs;
  }

  async getPacks() {
    let response;
    try {
      response = await this.#fetchImpl(`${this.#baseUrl}/api/machines`, {
        method: "GET",
        redirect: "error",
        signal: AbortSignal.timeout(this.#timeoutMs),
        headers: {
          accept: "application/json",
          "x-api-key": this.#apiKey,
        },
      });
    } catch {
      throw new Error("COLLECTOR_CATALOG_REQUEST_FAILED");
    }
    if (response?.ok !== true) throw new Error("COLLECTOR_CATALOG_REQUEST_FAILED");

    let payload;
    try {
      payload = await readBoundedJson(response);
    } catch {
      throw new Error("COLLECTOR_CATALOG_RESPONSE_INVALID");
    }
    if (!plainObject(payload) || !Array.isArray(payload.machines)) {
      throw new Error("COLLECTOR_CATALOG_RESPONSE_INVALID");
    }
    const updatedAtMs = this.#now();
    if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs < 0) {
      throw new Error("COLLECTOR_CATALOG_TIME_INVALID");
    }
    const ids = new Set();
    return payload.machines
      .filter((machine) => machine?.public === true)
      .map((machine) => {
        const pack = normalizePack(machine, updatedAtMs);
        if (ids.has(pack.id)) throw new Error("COLLECTOR_CATALOG_PACK_DUPLICATE");
        ids.add(pack.id);
        return pack;
      });
  }
}

async function readBoundedJson(response) {
  const declaredLength = response.headers.get("content-length");
  if (/^\d+$/.test(declaredLength ?? "") && Number(declaredLength) > MAX_RESPONSE_BYTES) {
    throw new Error("response too large");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response body missing");

  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error("response body invalid");
      totalBytes += value.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error("response too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
}

function normalizePack(machine, updatedAtMs) {
  if (!plainObject(machine) || typeof machine.code !== "string" || !PACK_ID_PATTERN.test(machine.code)) {
    throw new Error("COLLECTOR_CATALOG_PACK_ID_INVALID");
  }
  if (
    typeof machine.name !== "string" ||
    machine.name.length === 0 ||
    machine.name.length > 120 ||
    machine.name.trim() !== machine.name
  ) {
    throw new Error("COLLECTOR_CATALOG_PACK_NAME_INVALID");
  }
  const priceMicroUsdc = microUsdc(machine.price);
  const buybackBps = percentageBps(machine.instantBuyback);
  const expectedValueMicroUsdc = economicMicroUsdc(
    machine.ev,
    "COLLECTOR_CATALOG_EXPECTED_VALUE_INVALID",
  );
  if (!plainObject(machine.stock)) throw new Error("COLLECTOR_CATALOG_PACK_STOCK_INVALID");
  let available = 0;
  let lowestInsuredValueMicroUsdc;
  for (const tier of STOCK_TIERS) {
    const count = machine.stock[tier];
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error("COLLECTOR_CATALOG_PACK_STOCK_INVALID");
    }
    available += count;
    if (!Number.isSafeInteger(available)) {
      throw new Error("COLLECTOR_CATALOG_PACK_STOCK_INVALID");
    }
    if (count > 0 && lowestInsuredValueMicroUsdc === undefined) {
      const range = machine.tierRanges?.[tier];
      if (!plainObject(range)) throw new Error("COLLECTOR_CATALOG_TIER_RANGE_INVALID");
      lowestInsuredValueMicroUsdc = economicMicroUsdc(
        range.start,
        "COLLECTOR_CATALOG_TIER_RANGE_INVALID",
      );
    }
  }
  const instantBuybackFloorMicroUsdc = available === 0
    ? 0n
    : (lowestInsuredValueMicroUsdc * buybackBps) / 10_000n;
  const expectedBuybackMicroUsdc = (expectedValueMicroUsdc * buybackBps) / 10_000n;
  const collectorEconomicCostMicroUsdc = priceMicroUsdc > instantBuybackFloorMicroUsdc
    ? priceMicroUsdc - instantBuybackFloorMicroUsdc
    : 0n;
  return {
    id: machine.code,
    name: machine.name,
    priceMicroUsdc: priceMicroUsdc.toString(),
    instantBuybackFloorMicroUsdc: instantBuybackFloorMicroUsdc.toString(),
    expectedBuybackMicroUsdc: expectedBuybackMicroUsdc.toString(),
    collectorEconomicCostMicroUsdc: collectorEconomicCostMicroUsdc.toString(),
    available,
    updatedAtMs,
  };
}

function microUsdc(value) {
  const decimal = typeof value === "number" ? String(value) : value;
  if (typeof decimal !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(decimal)) {
    throw new Error("COLLECTOR_CATALOG_PACK_PRICE_INVALID");
  }
  const [whole, fraction = ""] = decimal.split(".");
  const amount = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (amount <= 0n) throw new Error("COLLECTOR_CATALOG_PACK_PRICE_INVALID");
  return amount;
}

function economicMicroUsdc(value, code) {
  try {
    const decimal = typeof value === "number" ? String(value) : value;
    if (typeof decimal !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(decimal)) {
      throw new Error(code);
    }
    const [whole, fraction = ""] = decimal.split(".");
    const quantized = fraction.length > 6 ? `${whole}.${fraction.slice(0, 6)}` : decimal;
    return microUsdc(quantized);
  } catch {
    throw new Error(code);
  }
}

function percentageBps(value) {
  const decimal = typeof value === "number" ? String(value) : value;
  if (typeof decimal !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(decimal)) {
    throw new Error("COLLECTOR_CATALOG_BUYBACK_INVALID");
  }
  const [whole, fraction = ""] = decimal.split(".");
  const bps = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (bps <= 0n || bps > 10_000n) {
    throw new Error("COLLECTOR_CATALOG_BUYBACK_INVALID");
  }
  return bps;
}

function collectorOrigin(value) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.port.length > 0 ||
      url.pathname !== "/" ||
      url.search.length > 0 ||
      url.hash.length > 0
    ) {
      throw new Error("invalid");
    }
    return url.origin;
  } catch {
    throw new TypeError("COLLECTOR_CATALOG_URL_INVALID");
  }
}

function plainObject(value) {
  return value !== null && !Array.isArray(value) && typeof value === "object";
}
