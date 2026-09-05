import assert from "node:assert/strict";
import test from "node:test";

import {
  cardResultMicroUsdc,
  formatGermanDate,
  formatGermanUsdc,
  germanStatus,
  parseGermanUsdc,
} from "../app/operator/operator-locale.ts";

test("converts German USDC without floating point", () => {
  assert.equal(parseGermanUsdc("12,50"), "12500000");
  assert.equal(parseGermanUsdc("0,000001"), "1");
  assert.equal(parseGermanUsdc("42"), "42000000");
  assert.equal(formatGermanUsdc("12500000"), "12,50 USDC");
  assert.equal(formatGermanUsdc("1"), "0,000001 USDC");
  assert.equal(formatGermanUsdc("-2500000"), "−2,50 USDC");

  for (const value of ["", "-1", "1.000,00", "1e3", "1,0000001", "NaN"]) {
    assert.throws(() => parseGermanUsdc(value), { message: "USDC_BETRAG_UNGUELTIG" });
  }
  for (const value of ["", "01", "1.5", "NaN"]) {
    assert.throws(() => formatGermanUsdc(value), { message: "USDC_WERT_UNGUELTIG" });
  }
});

test("calculates confirmed per-card gain or loss exactly", () => {
  assert.equal(cardResultMicroUsdc("10000000", "12500000"), "2500000");
  assert.equal(cardResultMicroUsdc("12500000", "10000000"), "-2500000");
  assert.equal(cardResultMicroUsdc(null, "12500000"), null);
  assert.equal(cardResultMicroUsdc("10000000", null), null);
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
