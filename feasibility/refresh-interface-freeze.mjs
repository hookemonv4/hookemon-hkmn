#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { hashFile, readJson, writeJson } from '../scripts/lib/util.mjs';
import {
  INTERFACE_FREEZE_INPUTS,
  validateInterfaceFreeze,
} from './verify-robinhood-binding.mjs';
import {
  validateCycleControlBounds,
  validateCycleControlResults,
} from './cycle-control-model.mjs';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outputPath = join(projectRoot, 'feasibility', 'interface-freeze.json');

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function names(entries) {
  return entries.map(entry => typeof entry === 'string' ? entry : entry.name).sort();
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function activeSurface(frozen, provisional) {
  return JSON.stringify({
    frozen: frozen.moduleInterfaces.map((module) => ({
      id: module.id,
      operations: names(module.operations),
      records: names(module.records),
      events: names(module.events),
    })),
    provisional: provisional.modules.map((module) => ({
      id: module.id,
      operations: names(module.operations),
      records: names(module.data),
      events: names(module.events),
    })),
  }).toLowerCase();
}

function cycleControlCoverage(results) {
  return {
    status: 'PASSED_LOCAL_REVISION_57_ARCHITECTURE_5',
    requirementsRevision: results.requirementsRevision,
    architectureRevision: results.architectureRevision,
    maximumCrossCycleContaminationAtomicUSDG:
      results.aggregate.maximumCrossCycleContaminationAtomicUSDG,
    maximumBlindRetryMoneyMutationAtomicUSDG:
      results.aggregate.maximumBlindRetryMoneyMutationAtomicUSDG,
    maximumActiveCycles: results.aggregate.maximumActiveCycles,
    minimumDistinctEscrowsObserved: results.aggregate.minimumDistinctEscrowsObserved,
    maximumAuthorizedLossPerCycleAtomicUSDG:
      results.aggregate.maximumAuthorizedLossPerCycleAtomicUSDG,
    cumulativeSystemLossCap: results.aggregate.cumulativeSystemLossCap.status,
  };
}

function buildFreeze() {
  const requirements = readJson(join(projectRoot, 'specs', 'requirements.json'));
  const frozen = readJson(join(projectRoot, 'architecture', 'interfaces.json'));
  const provisional = readJson(join(projectRoot, 'architecture', 'provisional-interfaces.json'));
  const manifest = readJson(join(projectRoot, 'bindings', 'robinhood-chain.json'));
  const historicalModelResults = readJson(join(projectRoot, 'feasibility', 'model-results.json'));
  const cycleControlResults = readJson(
    join(projectRoot, 'feasibility', 'cycle-control-model-results.json'),
  );
  const cycleControlBounds = readJson(
    join(projectRoot, 'feasibility', 'cycle-control-survivability-bounds.json'),
  );
  const dependencyPins = readJson(join(projectRoot, 'product', 'dependency-pins.json'));
  const previous = readJson(outputPath);

  // The freeze records the current interface snapshot while retaining older model results as
  // historical evidence. Phase 3 is explicitly provisional, so its snapshot cannot promote the
  // Phase 1 or Phase 2 model results into Phase 3 feasibility evidence.
  const requirementsRevision = frozen.requirementsRevision;
  const architectureRevision = frozen.architectureRevision;
  invariant(requirements.revision >= requirementsRevision,
    'live requirements revision must not regress behind the frozen interface evidence');
  invariant(provisional.requirementsRevision === requirementsRevision, 'provisional requirements revision mismatch');
  invariant(provisional.architectureRevision === architectureRevision, 'provisional architecture revision mismatch');
  invariant(historicalModelResults.requirementsRevision === 56,
    'historical model requirements revision mismatch');
  invariant(historicalModelResults.architectureRevision === 4,
    'historical model architecture revision mismatch');
  invariant(dependencyPins.phase1Toolchain.requirementsRevision === 56,
    'historical dependency-pin requirements revision mismatch');
  invariant(dependencyPins.phase1Toolchain.architectureRevision === 4,
    'historical dependency-pin architecture revision mismatch');
  if (frozen.productPhase === 3) {
    invariant(cycleControlResults.requirementsRevision === 57,
      'historical cycle-control model requirements revision mismatch');
    invariant(cycleControlResults.architectureRevision === 5,
      'historical cycle-control model architecture revision mismatch');
  } else {
    invariant(cycleControlResults.requirementsRevision === requirementsRevision,
      'cycle-control model requirements revision mismatch');
    invariant(cycleControlResults.architectureRevision === architectureRevision,
      'cycle-control model architecture revision mismatch');
  }
  validateCycleControlResults(cycleControlResults);
  validateCycleControlBounds(cycleControlBounds, cycleControlResults);

  const frozenById = new Map(frozen.moduleInterfaces.map(module => [module.id, module]));
  const provisionalById = new Map(provisional.modules.map(module => [module.id, module]));
  const moduleIds = [...frozenById.keys()].sort();
  const provisionalIds = [...provisionalById.keys()].sort();
  const exactModuleSet = same(moduleIds, provisionalIds);
  const exactOperationSets = exactModuleSet && moduleIds.every(id => same(
    names(frozenById.get(id).operations), names(provisionalById.get(id).operations),
  ));
  const exactRecordSets = exactModuleSet && moduleIds.every(id => same(
    names(frozenById.get(id).records), names(provisionalById.get(id).data),
  ));
  const exactEventSets = exactModuleSet && moduleIds.every(id => same(
    names(frozenById.get(id).events), names(provisionalById.get(id).events),
  ));
  const surface = activeSurface(frozen, provisional);

  const inputHashes = {};
  for (const relativePath of [...INTERFACE_FREEZE_INPUTS].sort()) {
    inputHashes[relativePath] = `sha256:${hashFile(join(projectRoot, relativePath))}`;
  }

  return {
    freeze: {
      schemaVersion: 'hookemon.interface-freeze.v1',
      productPhase: frozen.productPhase,
      requirementsRevision,
      architectureRevision,
      status: frozen.status,
      bindingManifestDigest: frozen.bindingManifestDigest,
      inputHashes,
      compatibilityVerdict: {
        status: exactModuleSet && exactOperationSets && exactRecordSets && exactEventSets ? 'PASSED' : 'FAILED',
        exactModuleSet,
        exactOperationSets,
        exactRecordSets,
        exactEventSets,
        unresolvedProviderFactPromoted: false,
        deferredSelectorOrStoragePresent: /deferredselector|deferredstorage/.test(surface),
        genericAdministratorPresent: /genericadministrator|genericadmin/.test(surface),
        outOfScopePhase2SurfacePresent: frozen.productPhase === 2
          && /dashboard|browserui|httpservice|database|scheduler|routediscovery|automaticpackselection|concurrentcycles|automaticretry|genericadmin|\bpause\b|upgrade|deferredselector|deferredstorage/.test(surface),
      },
      proofCoverage: {
        ...previous.proofCoverage,
        historicalPhase1Model: {
          status: 'PRESERVED_HISTORICAL_REVISION_56_ARCHITECTURE_4',
          requirementsRevision: historicalModelResults.requirementsRevision,
          architectureRevision: historicalModelResults.architectureRevision,
          schemaVersion: historicalModelResults.schemaVersion,
        },
        cycleControl: cycleControlCoverage(cycleControlResults),
        ...(frozen.productPhase === 3 ? {
          phase3Interface: {
            status: 'PROVISIONAL_PENDING_FEASIBILITY',
            requirementsRevision,
            architectureRevision,
            bindingManifest: frozen.bindingManifest,
            bindingManifestDigest: frozen.bindingManifestDigest,
            providerBindingStatus: frozen.providerBinding.status,
            codeReadinessDoesNotAuthorizeLive:
              frozen.phaseBoundary.codeReadinessDoesNotAuthorizeLive,
          },
        } : {}),
      },
      verification: [
        ...previous.verification,
        'node feasibility/cycle-control-model.mjs --verify feasibility/cycle-control-model-results.json --verify-bounds feasibility/cycle-control-survivability-bounds.json',
      ].filter((entry, index, entries) => entries.indexOf(entry) === index),
      productionReadiness: {
        ready: false,
        unprovenFacts: frozen.productPhase === 3
          ? [...frozen.productionBlockers]
          : previous.productionReadiness.unprovenFacts,
        blockers: frozen.productPhase === 3
          ? [...frozen.productionBlockers]
          : [...manifest.productionReadiness.blockers],
        ownerAndClaimDestinationPolicy: frozen.productPhase === 3
          ? 'OPERATIONS_CALLER_SELF_DESTINATION_WITH_SEPARATE_OWNER_ACTIONS'
          : 'UNRESOLVED',
        rule: frozen.productPhase === 3
          ? 'The Phase 3 interface is provisional and cannot authorize signing, broadcast, deployment, asset movement, gas spend, or publication.'
          : previous.productionReadiness.rule,
      },
    },
    frozen,
    provisional,
    manifest,
  };
}

const args = process.argv.slice(2);
invariant(args.length <= 1 && (args.length === 0 || args[0] === '--check'),
  'usage: node feasibility/refresh-interface-freeze.mjs [--check]');

const generated = buildFreeze();
const canonical = `${JSON.stringify(generated.freeze, null, 2)}\n`;
validateInterfaceFreeze({ ...generated, projectRoot });
if (args[0] === '--check') {
  invariant(readFileSync(outputPath, 'utf8') === canonical, 'feasibility/interface-freeze.json is stale; run the refresh generator');
} else {
  writeJson(outputPath, generated.freeze);
}
