import assert from "node:assert/strict";
import test from "node:test";

import { normalizePublicCycleStatus } from "../lib/public-cycle-status.ts";

const TESTNET_NETWORK = {
  ethereum: { name: "sepolia", chainId: 11155111, label: "Sepolia" },
  solana: {
    name: "devnet",
    genesisHash: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
    label: "Solana Devnet",
  },
};

const validStatus = {
  schemaVersion: 3,
  profile: "testnet",
  network: TESTNET_NETWORK,
  executionState: "active",
  executionReason: null,
  generatedAt: "2026-08-09T12:00:00.000Z",
  nextCycleAt: "2026-08-09T12:20:00.000Z",
  countdownSeconds: 1_200,
  cycle: {
    cycleId: "cycle-7",
    status: "awaiting-buybacks",
    selectedPackId: "pokemon_25",
    maxBoostersPerCycle: 100,
    plannedBoosters: 100,
    openedBoosters: 1,
    actions: [
      { type: "fees-collected", status: "complete", at: "2026-08-09T11:56:00.000Z" },
      { type: "packs-bought", status: "complete", at: "2026-08-09T11:59:00.000Z" },
    ],
    cards: [{
      productId: "pokemon_25",
      rarity: "Rare",
      nftAddress: "public-address",
      cardName: "Pikachu",
      setName: "Base Set",
      cardNumber: "58/102",
      imageUrl: "https://images.example/pikachu.png",
      packPriceMicroUsdc: "100000000",
      buybackMicroUsdc: "90000000",
    }],
    returnedMicroUsdc: "90000000",
    rewardStatus: "pending",
    roundAccounting: null,
    startedAt: "2026-08-09T11:55:00.000Z",
    updatedAt: "2026-08-09T12:00:00.000Z",
    spentMicroUsdc: "100000000",
    paidMicroUsdc: "0",
  },
};

test("accepts the exact public cycle contract", () => {
  const result = normalizePublicCycleStatus(validStatus, "testnet");

  assert.deepEqual(result, validStatus);
  assert.notEqual(result, validStatus);
  assert.notEqual(result.cycle, validStatus.cycle);
  assert.throws(
    () => normalizePublicCycleStatus(validStatus, "mainnet"),
    /PUBLIC_CYCLE_STATUS_INVALID/,
  );
});

test("accepts a variable operator cap with an exact latest-card window", () => {
  const cards = Array.from({ length: 60 }, (_, index) => card(`product-${index}`));
  const status = {
    ...validStatus,
    cycle: {
      ...validStatus.cycle,
      maxBoostersPerCycle: 20_000,
      plannedBoosters: 20_000,
      openedBoosters: 20_000,
      cards,
    },
  };

  assert.equal(normalizePublicCycleStatus(status).cycle.cards.length, 60);
});

test("keeps provider count drift visible without blanking the tracker", () => {
  const cards = Array.from({ length: 60 }, (_, index) => card(`product-${index}`));
  const status = {
    ...validStatus,
    cycle: {
      ...validStatus.cycle,
      maxBoostersPerCycle: 100,
      plannedBoosters: 101,
      openedBoosters: 102,
      cards,
    },
  };

  const result = normalizePublicCycleStatus(status);
  assert.equal(result.cycle.plannedBoosters, 101);
  assert.equal(result.cycle.openedBoosters, 102);
});

test("rejects unknown fields instead of forwarding private cycle data", () => {
  assert.throws(
    () => normalizePublicCycleStatus({
      ...validStatus,
      cycle: { ...validStatus.cycle, holders: [{ address: "private" }] },
    }),
    /PUBLIC_CYCLE_STATUS_INVALID/,
  );
  assert.throws(
    () => normalizePublicCycleStatus({ ...validStatus, authorization: "private" }),
    /PUBLIC_CYCLE_STATUS_INVALID/,
  );
});

test("rejects malformed money, counts, timestamps, actions and card images", () => {
  const invalidCycles = [
    { ...validStatus.cycle, returnedMicroUsdc: "-1" },
    { ...validStatus.cycle, maxBoostersPerCycle: 0 },
    {
      ...validStatus.cycle,
      plannedBoosters: 61,
      openedBoosters: 61,
      cards: Array.from({ length: 61 }, (_, index) => card(`product-${index}`)),
    },
    { ...validStatus.cycle, actions: [{ type: "fees-collected", status: "secret", at: validStatus.generatedAt }] },
    { ...validStatus.cycle, cards: [{ ...card("pack"), imageUrl: "javascript:alert(1)" }] },
  ];

  for (const cycle of invalidCycles) {
    assert.throws(
      () => normalizePublicCycleStatus({ ...validStatus, cycle }),
      /PUBLIC_CYCLE_STATUS_INVALID/,
    );
  }
  assert.throws(
    () => normalizePublicCycleStatus({ ...validStatus, generatedAt: "not-a-date" }),
    /PUBLIC_CYCLE_STATUS_INVALID/,
  );

  for (const paidMicroUsdc of [
    "01",
    "",
    1,
    true,
    "+1",
    "-1",
    " 1",
    "1 ",
    "1".repeat(79),
  ]) {
    assert.throws(
      () => normalizePublicCycleStatus({
        ...validStatus,
        cycle: { ...validStatus.cycle, paidMicroUsdc },
      }),
      /PUBLIC_CYCLE_STATUS_INVALID/,
    );
  }
});

test("accepts an explicit idle status and clamps no values", () => {
  const idle = {
    schemaVersion: 3,
    profile: "testnet",
    network: TESTNET_NETWORK,
    executionState: "paused",
    executionReason: "operator-paused",
    generatedAt: "2026-08-09T12:20:00.000Z",
    nextCycleAt: "2026-08-09T12:40:00.000Z",
    countdownSeconds: 1_200,
    cycle: null,
  };

  assert.deepEqual(normalizePublicCycleStatus(idle), idle);
});

test("normalizes one legacy cycle schema to explicit pending fields", () => {
  const legacy = structuredClone(validStatus);
  legacy.schemaVersion = 2;
  delete legacy.cycle.roundAccounting;
  delete legacy.cycle.cards[0].packPriceMicroUsdc;
  delete legacy.cycle.cards[0].buybackMicroUsdc;

  const result = normalizePublicCycleStatus(legacy, "testnet");

  assert.equal(result.schemaVersion, 3);
  assert.equal(result.cycle.roundAccounting, null);
  assert.equal(result.cycle.cards[0].packPriceMicroUsdc, null);
  assert.equal(result.cycle.cards[0].buybackMicroUsdc, null);
});

test("binds only an empty schema-1 tracker response to the expected profile", () => {
  const legacyIdle = {
    schemaVersion: 1,
    generatedAt: "2026-08-25T01:15:19.076Z",
    nextCycleAt: "2026-08-25T01:15:19.076Z",
    countdownSeconds: 0,
    cycle: null,
  };

  assert.deepEqual(normalizePublicCycleStatus(legacyIdle, "testnet"), {
    schemaVersion: 3,
    profile: "testnet",
    network: TESTNET_NETWORK,
    executionState: "unknown",
    executionReason: null,
    generatedAt: legacyIdle.generatedAt,
    nextCycleAt: legacyIdle.nextCycleAt,
    countdownSeconds: 0,
    cycle: null,
  });
  assert.throws(
    () => normalizePublicCycleStatus(legacyIdle),
    /PUBLIC_CYCLE_STATUS_INVALID/,
  );
  assert.throws(
    () => normalizePublicCycleStatus({ ...legacyIdle, cycle: validStatus.cycle }, "testnet"),
    /PUBLIC_CYCLE_STATUS_INVALID/,
  );
  assert.throws(
    () => normalizePublicCycleStatus({ ...legacyIdle, privateField: true }, "testnet"),
    /PUBLIC_CYCLE_STATUS_INVALID/,
  );
});

test("accepts only the neutral allowlisted public pause reason", () => {
  const paused = {
    ...validStatus,
    executionState: "paused",
    executionReason: "operator-paused",
  };
  assert.deepEqual(normalizePublicCycleStatus(paused, "testnet"), paused);

  for (const value of [
    { ...paused, executionReason: "database-password-invalid" },
    { ...validStatus, executionReason: "operator-paused" },
    { ...paused, executionReason: null },
  ]) {
    assert.throws(
      () => normalizePublicCycleStatus(value, "testnet"),
      { message: "PUBLIC_CYCLE_STATUS_INVALID" },
    );
  }
});

test("accepts only stable public reasons for skipped cycles", () => {
  const skipped = {
    ...validStatus,
    cycle: {
      ...validStatus.cycle,
      status: "skipped",
      reason: "insufficient-cycle-reserve",
      plannedBoosters: 0,
      openedBoosters: 0,
      cards: [],
    },
  };

  assert.equal(normalizePublicCycleStatus(skipped).cycle.reason, "insufficient-cycle-reserve");
  assert.throws(
    () => normalizePublicCycleStatus({
      ...skipped,
      cycle: { ...skipped.cycle, reason: "private provider detail" },
    }),
    /PUBLIC_CYCLE_STATUS_INVALID/,
  );
});

function card(productId) {
  return {
    productId,
    rarity: "Rare",
    nftAddress: null,
    cardName: null,
    setName: null,
    cardNumber: null,
    imageUrl: null,
    packPriceMicroUsdc: null,
    buybackMicroUsdc: null,
  };
}
