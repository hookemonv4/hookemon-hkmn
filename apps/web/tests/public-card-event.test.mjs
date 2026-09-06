import assert from "node:assert/strict";
import test from "node:test";

import {
  formatAmount,
  mergeCardEvents,
  normalizeAmount,
  normalizePublicCardEvent,
  operationIdentityKey,
  presentCardEvent,
} from "../lib/public-card-event.ts";

const validAmount = { chainId: "evm:4663", assetId: "USDG", units: "1500000", decimals: 6 };

const validEvent = {
  cycleId: "cycle-1", operationId: "op-1", packIndex: 0, memo: "memo-1", mint: null,
  eventId: "evt-1", sequence: "1", state: "observed", name: "Pikachu", imageUrl: "https://images.example/card.png",
  observedAt: "2026-09-06T10:00:00.000Z", finalizedAt: null, transactionId: null, proceeds: null,
};

test("normalizeAmount accepts the exact frozen shape and rejects extra or missing keys", () => {
  assert.deepEqual(normalizeAmount(validAmount), validAmount);
  assert.throws(() => normalizeAmount({ ...validAmount, extra: 1 }), /PUBLIC_CARD_EVENT_INVALID/);
  const missingChainId = { ...validAmount };
  delete missingChainId.chainId;
  assert.throws(() => normalizeAmount(missingChainId), /PUBLIC_CARD_EVENT_INVALID/);
  assert.throws(() => normalizeAmount({ ...validAmount, units: "01" }), /PUBLIC_CARD_EVENT_INVALID/);
  assert.throws(() => normalizeAmount({ ...validAmount, units: "-1" }), /PUBLIC_CARD_EVENT_INVALID/);
  assert.throws(() => normalizeAmount({ ...validAmount, decimals: -1 }), /PUBLIC_CARD_EVENT_INVALID/);
});

test("normalizePublicCardEvent accepts the exact frozen shape", () => {
  assert.deepEqual(normalizePublicCardEvent(validEvent), validEvent);
});

test("normalizePublicCardEvent accepts a finalized event with proceeds", () => {
  const finalized = {
    ...validEvent, state: "finalized", finalizedAt: "2026-09-06T10:05:00.000Z",
    transactionId: "5xJ8vN2q3", proceeds: validAmount,
  };
  assert.deepEqual(normalizePublicCardEvent(finalized), finalized);
});

test("normalizePublicCardEvent rejects malformed, extra, or impossible fields", () => {
  const mutations = [
    (event) => { delete event.mint; },
    (event) => { event.extra = "unexpected"; },
    (event) => { event.packIndex = -1; },
    (event) => { event.packIndex = 1.5; },
    (event) => { event.observedAt = "not-a-timestamp"; },
    (event) => { event.imageUrl = "javascript:alert(1)"; },
    (event) => { event.imageUrl = "http://images.example/card.png"; },
    (event) => { event.imageUrl = "https://user:secret@images.example/card.png"; },
    // finalizedAt before observedAt is never possible for a real observation.
    (event) => { event.finalizedAt = "2026-09-06T09:00:00.000Z"; },
    (event) => { event.proceeds = { ...validAmount, extra: 1 }; },
  ];
  for (const mutate of mutations) {
    const event = structuredClone(validEvent);
    mutate(event);
    assert.throws(() => normalizePublicCardEvent(event), /PUBLIC_CARD_EVENT_INVALID/);
  }
});

test("mergeCardEvents keeps one card per identity, preferring the latest sequence", () => {
  const first = normalizePublicCardEvent(validEvent);
  const secondObservation = normalizePublicCardEvent({
    ...validEvent, sequence: "2", state: "finalized",
    finalizedAt: "2026-09-06T10:05:00.000Z", proceeds: validAmount,
  });
  const otherCard = normalizePublicCardEvent({
    ...validEvent, operationId: "op-2", eventId: "evt-2",
  });
  const merged = mergeCardEvents([first, secondObservation, otherCard]);
  assert.equal(merged.length, 2);
  const merged1 = merged.find((event) => event.operationId === "op-1");
  assert.equal(merged1.state, "finalized");
  assert.equal(merged1.sequence, "2");
});

test("operationIdentityKey is stable across repeated observations of the same operation", () => {
  const key1 = operationIdentityKey(validEvent);
  const key2 = operationIdentityKey({ ...validEvent, sequence: "9", state: "finalized" });
  assert.equal(key1, key2);
});

test("presentCardEvent never invents a name/image and treats null proceeds as not-yet-sold, not zero", () => {
  const pending = presentCardEvent(normalizePublicCardEvent({
    ...validEvent, name: null, imageUrl: null,
  }));
  assert.equal(pending.label, "Name pending");
  assert.equal(pending.imageUrl, null);
  assert.equal(pending.isFinalized, false);
  assert.equal(pending.proceedsText, "Not yet sold");

  const sold = presentCardEvent(normalizePublicCardEvent({
    ...validEvent, state: "finalized", finalizedAt: "2026-09-06T10:05:00.000Z", proceeds: validAmount,
  }));
  assert.equal(sold.isFinalized, true);
  assert.equal(sold.proceedsText, "1.5 USDG");
  assert.equal(sold.stateLabel, "Finalized");
});

test("presentCardEvent never presents provider-observed-only state as finalized money", () => {
  // state says "finalized" but neither finalizedAt nor proceeds confirm it -- must not claim finalized.
  const provisional = presentCardEvent(normalizePublicCardEvent({ ...validEvent, state: "finalized" }));
  assert.equal(provisional.isFinalized, false);
  assert.equal(provisional.proceedsText, "Not yet sold");
});

test("formatAmount groups whole units, trims trailing fraction zeros, and keeps the real asset label", () => {
  assert.equal(formatAmount({ chainId: "evm:4663", assetId: "USDG", units: "0", decimals: 6 }), "0 USDG");
  assert.equal(formatAmount({ chainId: "evm:4663", assetId: "USDG", units: "1000000", decimals: 6 }), "1 USDG");
  assert.equal(
    formatAmount({ chainId: "solana:mainnet-beta", assetId: "SOL", units: "1234500000000", decimals: 9 }),
    "1,234.5 SOL",
  );
  assert.equal(formatAmount({ chainId: "evm:4663", assetId: "USDG", units: "1", decimals: 0 }), "1 USDG");
});
