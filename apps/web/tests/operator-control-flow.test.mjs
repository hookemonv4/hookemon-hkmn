import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps German configuration controls separate from canonical decision payloads", async () => {
  const source = await readFile(new URL("../app/operator/OperatorControlPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /germanMoneyFormValue\(state\.maxUnitPriceMicroUsdg\)/);
  assert.match(source, /parseGermanUsdg\(form\.maxUnitPriceMicroUsdg\)/);
  assert.match(source, /allowedPackIds:\s*\[\.\.\.form\.allowedPackIds\]\.sort\(\)/);
  assert.match(source, /requestedOrders:\s*Number\(form\.requestedOrders\)/);
  assert.match(source, /configurationSnapshotFromState\(bootstrap\.state\)/);
  assert.match(source, /Ungespeicherte Änderungen werden für diesen Befehl nicht verwendet/);
  assert.match(source, /command\.type === "update-configuration"/);
  assert.doesNotMatch(source, /abort-active-cycle|cancel-active-cycle/);
});

test("uses the authenticated operator proxy instead of a browser-side control service", async () => {
  const [panel, proxy] = await Promise.all([
    readFile(new URL("../app/operator/OperatorControlPanel.tsx", import.meta.url), "utf8"),
    readFile(new URL("../worker/operator-proxy.ts", import.meta.url), "utf8"),
  ]);

  assert.match(panel, /\/operator\/api\/bootstrap/);
  assert.match(panel, /\/operator\/api\/decisions/);
  assert.match(panel, /expectedVersion/);
  assert.match(panel, /crypto\.randomUUID\(\)/);
  assert.match(panel, /cache:\s*["']no-store["']/);
  assert.match(proxy, /OPERATOR_CONTROL_SERVICE_URL/);
  assert.match(proxy, /OPERATOR_CONTROL_PROXY_CREDENTIAL/);
  assert.match(proxy, /cf-access-jwt-assertion/);
  assert.doesNotMatch(panel, /DatabaseSync|DurableOperatorControlStore|createBindingOperatorControlHandler/);
});
