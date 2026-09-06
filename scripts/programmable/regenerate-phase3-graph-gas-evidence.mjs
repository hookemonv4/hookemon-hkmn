#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { regeneratePhaseThreeGraphGasEvidence } from './lib/release-evidence.mjs';

const root = resolve(import.meta.dirname, '../..');
const evidencePath = resolve(root, 'release/phase3/graph-gas-evidence.json');
const archiveForkPath = resolve(root, 'packages/contracts/test/integration/RobinhoodV4ArchiveFork.t.sol');

const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
const archiveForkSource = readFileSync(archiveForkPath, 'utf8');
const regenerated = regeneratePhaseThreeGraphGasEvidence(evidence, archiveForkSource);

writeFileSync(evidencePath, `${JSON.stringify(regenerated, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  ok: true,
  graphDeploymentHash: regenerated.route.graphDeploymentHash,
  hookRuntimeCodeHash: regenerated.route.deployments.hook.runtimeCodeHash,
})}\n`);
