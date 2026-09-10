import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("keeps German configuration controls separate from canonical decision payloads", async () => {
  const source = await readFile(new URL("../app/operator/OperatorControlPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /germanMoneyFormValue\(state\.maxUnitPriceMicroUsd\)/);
  assert.match(source, /parseGermanUsd\(form\.maxUnitPriceMicroUsd\)/);
  assert.match(source, /allowedPackIds:\s*\[\.\.\.form\.allowedPackIds\]\.sort\(\)/);
  assert.match(source, /requestedOrders:\s*Number\(form\.requestedOrders\)/);
  assert.match(source, /formBaseSnapshot/);
  assert.match(source, /Ungespeicherte Änderungen werden für diesen Befehl nicht verwendet/);
  assert.match(source, /command\.type === "update-configuration"/);
  assert.doesNotMatch(source, /abort-active-cycle|cancel-active-cycle/);

  const submitCommandBody = source.slice(
    source.indexOf("function submitCommand"),
    source.indexOf("function saveConfiguration"),
  );
  const runCommandBody = source.slice(
    source.indexOf("const runCommandEnvelope"),
    source.indexOf("const initialLoad"),
  );
  assert.match(
    runCommandBody,
    /await Promise\.all\(\[\s*loadBootstrap[\s\S]*?\]\);\s*setMessage\(/,
  );
  assert.match(
    runCommandBody,
    /await loadBootstrap\(\{ replaceForm: "if-clean" \}\);[\s\S]*?setMessage\("Entscheidung wurde nicht angenommen\."\);/,
  );
  assert.match(submitCommandBody, /reservePendingCommand\(window\.sessionStorage, envelope\)/);
  assert.match(source, /formBaseVersion,\s*$/m);
  assert.match(source, /loadBootstrap\(\{ replaceForm: "if-clean" \}\)/);
  assert.match(source, /mergeAuditEntries\(current, body\.decisions\)/);
  assert.match(source, /describeRevisionConflict/);
  const bootstrapCallback = source.slice(
    source.indexOf("const loadBootstrap"),
    source.indexOf("const loadDashboard"),
  );
  assert.match(bootstrapCallback, /}, \[\]\);/);
  const mountEffect = source.slice(
    source.lastIndexOf("useEffect(() => {", source.indexOf("const initialLoad")),
    source.indexOf("function submitCommand"),
  );
  assert.doesNotMatch(mountEffect, /}, \[busy/);
  assert.doesNotMatch(mountEffect, /\bform\b/);
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
  assert.equal((panel.match(/crypto\.randomUUID\(\)/g) ?? []).length, 1);
  assert.match(panel, /buildCommandEnvelope/);
  assert.match(panel, /reservePendingCommand\(window\.sessionStorage, envelope\)/);
  assert.match(panel, /serializePendingCommand\(envelope\)/);
  assert.match(panel, /runCommandEnvelope\(envelope/);
  assert.match(panel, /MAX_RECOVERY_ATTEMPTS/);
  assert.match(panel, /Ergebnis noch unbestimmt/);
  assert.match(panel, /parsePendingCommand\(window\.sessionStorage\.getItem\(PENDING_COMMAND_STORAGE_KEY\)\)/);
  assert.match(panel, /status: null/);
  assert.doesNotMatch(panel, /status: null[\s\S]{0,500}Entscheidung wurde nicht angenommen/);
  assert.match(panel, /cache:\s*["']no-store["']/);
  assert.match(proxy, /OPERATOR_CONTROL_SERVICE_URL/);
  assert.match(proxy, /OPERATOR_CONTROL_PROXY_CREDENTIAL/);
  assert.match(proxy, /cf-access-jwt-assertion/);
  assert.doesNotMatch(panel, /DatabaseSync|DurableOperatorControlStore|createBindingOperatorControlHandler/);
});

test("renders held cards and approvals with operator-only commands and unavailable null states", async () => {
  const source = await readFile(new URL("../app/operator/OperatorControlPanel.tsx", import.meta.url), "utf8");

  assert.match(source, /Gehaltene Karten/);
  assert.match(source, /Manuelle Freigaben/);
  assert.match(source, /Verkaufen/);
  assert.match(source, /Weiter halten/);
  assert.match(source, /Zyklus fortsetzen/);
  assert.match(source, /positionId:\s*position\.positionId/);
  assert.match(source, /heldEvidenceDigest:\s*position\.evidenceDigest/);
  assert.match(source, /expectedPositionRevision:\s*position\.positionRevision/);
  assert.match(source, /choice,\s*\},\s*choice === "sell"/);
  assert.match(source, /onClick=\{\(\) => decideHeld\(position, "sell"\)\}/);
  assert.match(source, /type:\s*"manual-approval"/);
  assert.match(source, /type:\s*"restart-request"/);
  assert.match(source, /Nicht verfügbar/);
  assert.match(source, /!readOnly \?/);
  assert.match(source, /!approval\.approved && !readOnly/);
});


test("unresolved command disables new actions and offers recovery of the same envelope", async () => {
  const source = await readFile(new URL("../app/operator/OperatorControlPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /const controlsDisabled = .*pendingCommand !== null/);
  assert.match(source, /onClick=\{\(\) => void runCommandEnvelope\(pendingCommand,/);
  const exhaustion = source.slice(source.indexOf("if (attempt >= MAX_RECOVERY_ATTEMPTS)"), source.indexOf("setBusy(false)", source.indexOf("if (attempt >= MAX_RECOVERY_ATTEMPTS)")));
  assert.doesNotMatch(exhaustion, /removeItem|setPendingCommand\(null\)/);
});
