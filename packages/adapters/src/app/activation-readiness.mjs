const CATALOG_PRICE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

function catalogAtomicAmount(price, decimals, label) {
  const text = typeof price === 'number' && Number.isFinite(price) ? String(price) : price;
  if (typeof text !== 'string' || !CATALOG_PRICE.test(text)) {
    throw new Error(`${label} is not a canonical catalog price`);
  }
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > decimals) throw new Error(`${label} has more precision than the settlement asset`);
  const atomic = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
  if (atomic <= 0n) throw new Error(`${label} must be positive`);
  return atomic;
}

function mapMachines(value) {
  const machines = Array.isArray(value) ? value : value?.machines;
  if (!Array.isArray(machines)) throw new Error('Collector machine catalog response is invalid');
  return machines.flatMap(machine => {
    if (!machine || typeof machine !== 'object' || machine.public === false
      || typeof machine.code !== 'string' || machine.code.length === 0) return [];
    try {
      return [{
        id: machine.code,
        name: machine.name ?? machine.shortName ?? machine.code,
        priceMicroStablecoin: catalogAtomicAmount(
          machine.price,
          6,
          `Collector machine "${machine.code}" price`,
        ).toString(),
        available: null,
      }];
    } catch {
      return [];
    }
  });
}

function boundedReadinessReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  return `start-readiness: ${message}`.slice(0, 256);
}

export function createActivationReadiness({
  collectorClient,
  assertStartReadiness,
  readinessOptions,
  now = Date.now,
  ttlMs = 30_000,
} = {}) {
  let catalogCache = null;
  let catalogInFlight = null;
  let readinessCache = null;
  let readinessInFlight = null;

  async function readCatalog() {
    if (collectorClient === null || collectorClient === undefined) {
      return { status: 'NOT_CONFIGURED', fetchedAtMs: 0, packs: [] };
    }
    const current = now();
    if (catalogCache !== null && current - catalogCache.fetchedAtMs < ttlMs) return catalogCache;
    if (catalogInFlight !== null) return catalogInFlight;
    catalogInFlight = (async () => {
      try {
        const response = await collectorClient.getMachines();
        const result = Object.freeze({
          status: 'LOADED',
          fetchedAtMs: now(),
          packs: Object.freeze(mapMachines(response)),
        });
        catalogCache = result;
        return result;
      } catch {
        return catalogCache === null
          ? { status: 'UNAVAILABLE', fetchedAtMs: 0, packs: [] }
          : { ...catalogCache, status: 'STALE' };
      } finally {
        catalogInFlight = null;
      }
    })();
    return catalogInFlight;
  }

  async function readReadiness() {
    const current = now();
    if (readinessCache !== null && current - readinessCache.fetchedAtMs < ttlMs) {
      return readinessCache.value;
    }
    if (readinessInFlight !== null) return readinessInFlight;
    readinessInFlight = (async () => {
      try {
        await assertStartReadiness(readinessOptions);
        const value = { ready: true, reasons: [] };
        readinessCache = { fetchedAtMs: now(), value };
        return value;
      } catch (error) {
        const value = { ready: false, reasons: [boundedReadinessReason(error)] };
        readinessCache = { fetchedAtMs: now(), value };
        return value;
      } finally {
        readinessInFlight = null;
      }
    })();
    return readinessInFlight;
  }

  return { readCatalog, readReadiness };
}
