// Rebuilds private card-history rows from the durable purchase batch and validated lifecycle
// evidence. Stage completions do not carry a per-pack wall-clock observation, so every card in a
// cycle shares the purchase batch's requestedAtMs timestamp; dashboard cursors therefore tie-break
// by (cycle_id, pack_index) rather than timestamp alone.
import { resolvePackLifecycle, validateCompleteStages } from './durable-card-feed.mjs';

function validAtomic(value) {
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value);
}

function sixDecimalAmount(value) {
  return value?.decimals === 6 && validAtomic(value.amountAtomic) ? value.amountAtomic : null;
}

export function buildDurableCardHistory({
  cycleId,
  packBatchRequestPacks,
  purchaseRequestedAtMs,
  stages,
}) {
  if (typeof cycleId !== 'string' || cycleId.length === 0) throw new TypeError('buildDurableCardHistory requires a cycleId');
  if (!Number.isSafeInteger(purchaseRequestedAtMs) || purchaseRequestedAtMs < 0) {
    throw new TypeError("buildDurableCardHistory requires the purchase batch's requestedAtMs");
  }
  if (!Array.isArray(packBatchRequestPacks) || packBatchRequestPacks.length === 0) {
    return { cards: [], skipped: 0 };
  }
  const validated = validateCompleteStages(packBatchRequestPacks, stages);
  if (validated === null) return { cards: [], skipped: packBatchRequestPacks.length };
  const observedAt = new Date(purchaseRequestedAtMs).toISOString();
  const cards = [];
  let skipped = 0;
  for (const request of packBatchRequestPacks) {
    const epic = validated.epicGate?.get(request.packIndex) ?? null;
    const lifecycle = resolvePackLifecycle(request.packIndex, validated);
    if (typeof request.packType !== 'string' || request.packType.length === 0
      || epic === null || typeof epic.rarity !== 'string' || epic.rarity.length === 0 || lifecycle === null) {
      skipped += 1;
      continue;
    }
    const purchase = validated.purchase?.get(request.packIndex);
    const buyback = validated.buyback?.get(request.packIndex);
    cards.push({
      cycleId,
      packIndex: request.packIndex,
      productId: request.packType,
      rarity: epic.rarity,
      nftAddress: lifecycle.mint ?? null,
      cardName: null,
      setName: null,
      cardNumber: null,
      imageUrl: null,
      packPriceMicroUsdg: sixDecimalAmount(purchase?.packCost),
      buybackMicroUsdg: buyback?.decision === 'sold' ? sixDecimalAmount(buyback.proceeds) : null,
      observedAt,
    });
  }
  return { cards, skipped };
}
