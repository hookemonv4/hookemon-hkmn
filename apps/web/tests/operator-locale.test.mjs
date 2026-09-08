import assert from "node:assert/strict";
import test from "node:test";

import {
  cardResultMicroUsdg,
  formatGermanDate,
  formatGermanUsdg,
  germanStatus,
  parseGermanUsdg,
} from "../app/operator/operator-locale.ts";

test("converts German USDG without floating point", () => {
  assert.equal(parseGermanUsdg("12,50"), "12500000");
  assert.equal(parseGermanUsdg("0,000001"), "1");
  assert.equal(parseGermanUsdg("42"), "42000000");
  assert.equal(formatGermanUsdg("12500000"), "12,50 USDG");
  assert.equal(formatGermanUsdg("1"), "0,000001 USDG");
  assert.equal(formatGermanUsdg("-2500000"), "−2,50 USDG");

  for (const value of ["", "-1", "1.000,00", "1e3", "1,0000001", "NaN"]) {
    assert.throws(() => parseGermanUsdg(value), { message: "USDG_BETRAG_UNGUELTIG" });
  }
  for (const value of ["", "01", "1.5", "NaN"]) {
    assert.throws(() => formatGermanUsdg(value), { message: "USDG_WERT_UNGUELTIG" });
  }
});

test("calculates confirmed per-card gain or loss exactly", () => {
  assert.equal(cardResultMicroUsdg("10000000", "12500000"), "2500000");
  assert.equal(cardResultMicroUsdg("12500000", "10000000"), "-2500000");
  assert.equal(cardResultMicroUsdg(null, "12500000"), null);
  assert.equal(cardResultMicroUsdg("10000000", null), null);
});

test("formats timestamps and every operator code family in German", () => {
  assert.equal(formatGermanDate("2026-08-25T20:00:00.000Z"), "25.08.2026, 22:00");
  assert.throws(() => formatGermanDate("2026-08-25"), { message: "DATUM_UNGUELTIG" });

  const expected = new Map([
    ["active", "Aktiv"],
    ["paused", "Pausiert"],
    ["collecting-fees", "Gebühren werden erfasst"],
    ["complete", "Abgeschlossen"],
    ["CONFIGURATION_INCOMPLETE", "Konfiguration ist unvollständig"],
    ["update-configuration", "Konfiguration ändern"],
    ["accepted", "Angenommen"],
    ["rejected", "Abgelehnt"],
    ["computed", "Berechnet"],
    ["pending", "Ausstehend"],
    ["collector-buyback", "Collector-Buyback"],
    ["OPERATOR_CONTROL_UNAVAILABLE", "Private Steuerung ist vorübergehend nicht erreichbar"],
  ]);
  for (const [code, label] of expected) assert.equal(germanStatus(code), label, code);
  assert.equal(germanStatus("future-code"), "Unbekannter Status");
});

test("keeps USD controls, exact ETH principal and historical USDG distinct", async () => {
  const { parseGermanUsd, formatGermanUsd, formatGermanEth, assertNativeOperatorConfiguration } = await import("../app/operator/operator-locale.ts");
  assert.equal(parseGermanUsd("55,000001"), "55000001");
  assert.equal(formatGermanUsd("55000000"), "55,00 USD");
  assert.equal(formatGermanEth("1"), "0,000000000000000001 ETH");
  assert.equal(formatGermanEth("123456789012345678901234567890"), "123.456.789.012,34567890123456789 ETH");
  assert.equal(formatGermanUsdg("1"), "0,000001 USDG");
  const limits = { maxUnitPriceMicroUsd: "55000000", maxCycleBudgetMicroUsd: "165000000", max24HourBudgetMicroUsd: "495000000" };
  assert.doesNotThrow(() => assertNativeOperatorConfiguration(limits, limits));
  for (const bad of [{ maxUnitPriceMicroUsdg: "55000000" }, { ...limits, maxUnitPriceMicroUsdg: "1" }, { ...limits, maxUnitPriceMicroUsd: "55000001" }, { ...limits, maxCycleBudgetMicroUsd: 165000000 }]) {
    assert.throws(() => assertNativeOperatorConfiguration(bad, limits), /OPERATOR_CONFIGURATION_INVALID/);
  }
  for (const bad of ["1e18", "1.2", "01", "-0"]) assert.throws(() => formatGermanEth(bad));
});
