const CATALOG_PRICE = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

export function catalogAtomicAmount(price, decimals, label) {
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

function mapCatalogMachines(machines) {
  const packs = [];
  for (const machine of machines) {
    if (!machine || typeof machine !== 'object' || machine.public === false) continue;
    try {
      packs.push({
        id: machine.code,
        name: machine.name ?? machine.shortName ?? machine.code,
        priceMicroStablecoin: catalogAtomicAmount(machine.price, 6, `Collector machine "${machine.code}" price`).toString(),
        available: null,
      });
    } catch {
      // Invalid prices are not admissible catalog evidence.
    }
  }
  return packs;
}

export function createActivationReadiness({
  collectorClient,
  execution,
  now = Date.now,
  catalogTtlMs = 60_000,
}) {
  let cached = null;
  let inFlight = null;

  async function readCatalog() {
    if (collectorClient === null || collectorClient === undefined) {
      return { status: 'NOT_CONFIGURED', fetchedAtMs: 0, packs: [] };
    }
    const current = now();
    if (cached !== null && current - cached.fetchedAtMs < catalogTtlMs) return cached;
    if (inFlight !== null) return inFlight;
    inFlight = (async () => {
      try {
        const machines = await collectorClient.getMachines();
        const result = {
          status: 'LOADED',
          fetchedAtMs: now(),
          packs: mapCatalogMachines(Array.isArray(machines) ? machines : []),
        };
        cached = result;
        return result;
      } catch {
        return cached === null
          ? { status: 'UNAVAILABLE', fetchedAtMs: 0, packs: [] }
          : { ...cached, status: 'STALE' };
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  async function readReadiness({ authorityStatus, catalog }) {
    const reasons = [];
    if (catalog?.status !== 'LOADED') reasons.push('catalog-not-loaded');
    if (authorityStatus === null || authorityStatus === undefined) {
      reasons.push('authority-unavailable');
    } else if (authorityStatus.configuration === null || authorityStatus.configuration === undefined) {
      reasons.push('configuration-missing');
    } else if (catalog?.status === 'LOADED') {
      const packIds = new Set(catalog.packs.map(pack => pack.id));
      if (authorityStatus.configuration.packPlan.orders.some(order => !packIds.has(order.pack))) {
        reasons.push('pack-plan-not-in-catalog');
      }
    }
    if (execution?.profile === 'inspection') reasons.push('execution-profile-inspection');
    return { ready: reasons.length === 0, reasons: [...new Set(reasons)] };
  }

  return { readCatalog, readReadiness };
}
