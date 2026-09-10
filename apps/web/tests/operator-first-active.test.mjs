import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { decodeCycleStartProjectPool } from '../lib/operator-dashboard-pool.ts';
import { buildDashboardReadModel } from '../../../packages/dashboard/src/projections/operator-projection.mjs';

// Execute the production decoder without mounting the React UI or copying its implementation.
async function panelDecoder() {
  const text = await readFile(new URL('../app/operator/OperatorControlPanel.tsx', import.meta.url), 'utf8');
  const parsed = ts.createSourceFile('panel.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const imports = parsed.statements.filter(ts.isImportDeclaration);
  let source = text;
  for (const declaration of [...imports].reverse()) source = source.slice(0, declaration.pos) + source.slice(declaration.end);
  const { outputText } = ts.transpileModule(source + '\nexport { decodeDashboard };', {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  });
  const context = { exports: {}, require: () => ({}), structuredClone, decodeCycleStartProjectPool };
  vm.runInNewContext(outputText, context);
  return context.exports.decodeDashboard;
}

test('the panel preserves first-cycle USD budgets without terminal accounting', async () => {
  const decodeDashboard = await panelDecoder();
  const model = buildDashboardReadModel({
    authorityStatus: {
      revision: 3, configuration: null, activeCycleId: 'first-native-cycle',
      cycles: [{ cycleId: 'first-native-cycle', terminalState: null,
        stages: [{ stage: 'purchase', status: 'PREPARED' }], payout: null }],
      heldPositions: [], manualApprovals: [],
      cap: { offChain24Hour: null, onChainRemainingCapacity: null },
      custody: { buckets: [] }, alerts: [],
    },
    cardHistory: { cards: [], complete: true }, now: () => Date.UTC(2026, 0, 1),
  });
  model.activeCycle.maxCycleBudgetMicroUsd = '25000000000';
  const decoded = decodeDashboard(model);
  assert.equal(decoded.latestCycle, null);
  assert.equal(decoded.activeCycle.maxCycleBudgetMicroUsd, '25000000000');
  assert.equal(decoded.activeCycle.maxCycleBudgetMicroUsdg, null);
  const mixed = structuredClone(model);
  mixed.activeCycle.maxCycleBudgetMicroUsdg = '5';
  assert.throws(() => decodeDashboard(mixed), /ungültig/);
});
