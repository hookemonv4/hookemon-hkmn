#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_DIGEST_RULES, scanDigestMarkers } from './check-cleanroom.mjs';

export const SOURCE_PATHS = Object.freeze([
  'docs/audit/2026-09-04/findings/verified-L3.json',
  'docs/audit/2026-09-04/findings/verified-L1-L2-L4-L5-L6.json',
]);

export const TRACEABILITY_PATH = 'docs/audit/2026-09-04/traceability.json';

export const WORK_PACKAGE_IDS = Object.freeze([
  'WP23', 'WP00a', 'WP00b', 'WP18', 'WP01', 'WP02', 'WP03A', 'WP04a', 'WP04b',
  'WP04c', 'WP04A', 'WP05', 'WP06', 'WP07-0', 'WP07', 'WP08a', 'WP08b', 'WP09a',
  'WP09b', 'WP10a', 'WP10b', 'WP12', 'WP13', 'WP14', 'WP15', 'WP17', 'WP19', 'WP20',
  'WP22b', 'WP26', 'WP27', 'WP28', 'WP16', 'WP24', 'WP25',
]);

const ACCEPTANCE = Object.freeze({
  launchComposition: 'The atomic launch composition seeds the canonical pool and finalizes custody in one transaction.',
  initializationGuard: 'External initialization is rejected while the approved launch path can initialize exactly once.',
  partialFillPolicy: 'The owner-approved partial-fill policy is enforced by the fork proof.',
  grossFeeAccounting: 'Gross-volume accounting conserves all three cumulative fee streams across every swap path.',
  canariesAndRunbook: 'Pre-signature canaries stop on drift and the incident runbook defines safe recovery.',
  forkProof: 'The non-skipping fork suite proves the configured router, quoter, runtime, and launch path.',
  realDependencies: 'The real vendored launch dependencies compile under the pinned build profile.',
  routerResolution: 'Router removal or the operational pin produces one coherent deployment candidate.',
  specification: 'The approved revision aligns the specification, architecture, and delivery-boundary records.',
  programmableGate: 'The two-stage gate reports repair and launch eligibility from current provider facts.',
  legacyProcess: 'The phase-three deployment manifest excludes this legacy process contract and records the decision.',
  runnerContract: 'The authoritative cycle repository and write-ahead schema replace the old money path.',
  directPayout: 'The direct payout path persists each transition and marks payment complete only after finality.',
  relayStages: 'Relay stages persist requests, validate policy, and require attributable finalized deltas.',
  configuration: 'Production configuration is explicit, fail-closed, and checked before any irreversible action.',
  journalSafety: 'Write-ahead records and mutation fencing prevent duplicate external effects after restart.',
  policyEngine: 'Policy controls gate claims and purchases before signing and persist their accounting.',
  signerPolicy: 'Signing stays outside Node and policy decoders reject an unapproved transaction.',
  collectorLifecycle: 'Collector mutations reconcile ambiguous outcomes without retrying a sent request.',
  recovery: 'Recovery commands resume or abort only durable, explicit cycle states.',
  snapshot: 'Eligibility is pinned before claim and the replayed state passes completeness checks.',
  dashboard: 'Dashboard controls use the authoritative repository and do not imply an inert or spending action.',
  observability: 'One composed alert sink deduplicates drift alerts and redacts sensitive values.',
  cleanRoom: 'The scanner detects unsafe reconstruction and the source tree contains no forbidden marker.',
  ciCoverage: 'The explicit CI list executes every required script, runner, adapter, and dashboard suite.',
  packageEvidence: 'The release package binds the approved graph, build evidence, and current phase records.',
  addressEvidence: 'Address derivation is reproducible from frozen graph and compiler inputs.',
  controlledMerge: 'Repair merge eligibility requires current checks and protected integration evidence.',
});

function wp(ids, acceptance) {
  return Object.freeze({ wp: Object.freeze(ids), acceptance });
}

function notApplicable(reason = ACCEPTANCE.legacyProcess) {
  return Object.freeze({ notApplicable: reason });
}

export const DISPOSITION_BY_FINDING_ID = Object.freeze({
  'L1-M1': wp(['WP04c'], ACCEPTANCE.launchComposition),
  'L1-M2': wp(['WP04a'], ACCEPTANCE.initializationGuard),
  'L1-M3': wp(['WP00a', 'WP05'], ACCEPTANCE.partialFillPolicy),
  'L1-M4': wp(['WP03A'], ACCEPTANCE.grossFeeAccounting),
  'L1-M5': wp(['WP14', 'WP19'], ACCEPTANCE.canariesAndRunbook),
  'L1-M6': wp(['WP14', 'WP19'], ACCEPTANCE.canariesAndRunbook),
  'L1-M7': wp(['WP18', 'WP05'], ACCEPTANCE.forkProof),
  'L1-M8': wp(['WP01', 'WP05', 'WP22b'], ACCEPTANCE.routerResolution),
  'L1-M9': wp(['WP17'], ACCEPTANCE.programmableGate),
  'L1-M11': wp(['WP18'], ACCEPTANCE.realDependencies),
  'L1-M12': wp(['WP00a', 'WP20'], ACCEPTANCE.specification),

  'L2-M1': notApplicable(),
  'L2-M2': notApplicable(),
  'L2-M3': notApplicable(),
  'L2-M4': notApplicable(),
  'L2-M5': notApplicable(),
  'L2-M6': notApplicable(),
  'L2-M7': notApplicable(),
  'L2-M8': notApplicable(),
  'L2-M9': notApplicable(),
  'L2-M10': notApplicable(),
  'L2-M11': notApplicable(),
  'L2-M12': notApplicable(),
  'L2-M13': notApplicable(),
  'L2-M14': notApplicable(),
  'L2-M15': notApplicable(),
  'L2-M16': notApplicable(),
  'L2-M17': notApplicable(),
  'L2-M18': notApplicable(),
  'L2-M19': notApplicable(),
  'L2-M20': notApplicable(),
  'L2-M21': notApplicable(),

  'L3-M1': wp(['WP07-0', 'WP07'], ACCEPTANCE.runnerContract),
  'L3-M2': wp(['WP07-0', 'WP09b'], ACCEPTANCE.directPayout),
  'L3-M3': wp(['WP09b'], ACCEPTANCE.directPayout),
  'L3-M4': wp(['WP07'], ACCEPTANCE.relayStages),
  'L3-M5': wp(['WP12'], ACCEPTANCE.configuration),
  'L3-M6': wp(['WP07-0', 'WP08b'], ACCEPTANCE.journalSafety),
  'L3-M7': wp(['WP07', 'WP09b'], ACCEPTANCE.relayStages),
  'L3-M8': wp(['WP12'], ACCEPTANCE.recovery),
  'L3-M9': wp(['WP07-0', 'WP07'], ACCEPTANCE.journalSafety),
  'L3-M10': wp(['WP10a', 'WP12'], ACCEPTANCE.policyEngine),
  'L3-M11': wp(['WP07-0'], ACCEPTANCE.runnerContract),
  'L3-M13': wp(['WP07'], ACCEPTANCE.relayStages),
  'L3-M14': wp(['WP07', 'WP09b'], ACCEPTANCE.directPayout),
  'L3-M15': wp(['WP07'], ACCEPTANCE.relayStages),
  'L3-M16': wp(['WP12', 'WP16'], ACCEPTANCE.ciCoverage),
  'L3-M17': wp(['WP08a'], ACCEPTANCE.signerPolicy),
  'L3-M20': wp(['WP15'], ACCEPTANCE.cleanRoom),
  'L3-M23': wp(['WP12'], ACCEPTANCE.configuration),

  'L4-M1': wp(['WP08b'], ACCEPTANCE.collectorLifecycle),
  'L4-M2': wp(['WP08a'], ACCEPTANCE.signerPolicy),
  'L4-M3': wp(['WP08b'], ACCEPTANCE.collectorLifecycle),
  'L4-M4': wp(['WP07-0', 'WP08b'], ACCEPTANCE.journalSafety),
  'L4-M5': wp(['WP08a'], ACCEPTANCE.signerPolicy),
  'L4-M6': wp(['WP08a'], ACCEPTANCE.signerPolicy),
  'L4-M7': wp(['WP08b'], ACCEPTANCE.collectorLifecycle),
  'L4-M8': wp(['WP12'], ACCEPTANCE.configuration),
  'L4-M9': wp(['WP08a', 'WP13'], ACCEPTANCE.signerPolicy),
  'L4-M10': wp(['WP09b', 'WP12'], ACCEPTANCE.directPayout),
  'L4-M11': wp(['WP12'], ACCEPTANCE.configuration),
  'L4-M12': wp(['WP07'], ACCEPTANCE.relayStages),
  'L4-M13': wp(['WP07'], ACCEPTANCE.relayStages),
  'L4-M14': wp(['WP07'], ACCEPTANCE.relayStages),
  'L4-M15': wp(['WP07', 'WP12'], ACCEPTANCE.relayStages),
  'L4-M16': wp(['WP13', 'WP16'], ACCEPTANCE.ciCoverage),

  'L5-M1': wp(['WP10a'], ACCEPTANCE.policyEngine),
  'L5-M2': wp(['WP07-0', 'WP10b'], ACCEPTANCE.runnerContract),
  'L5-M3': wp(['WP10b'], ACCEPTANCE.dashboard),
  'L5-M4': wp(['WP07-0', 'WP07'], ACCEPTANCE.runnerContract),
  'L5-M5': wp(['WP09b'], ACCEPTANCE.directPayout),
  'L5-M6': wp(['WP09b'], ACCEPTANCE.directPayout),
  'L5-M7': wp(['WP09b'], ACCEPTANCE.directPayout),
  'L5-M8': wp(['WP09b'], ACCEPTANCE.directPayout),
  'L5-M9': wp(['WP09a'], ACCEPTANCE.snapshot),
  'L5-M10': wp(['WP09a'], ACCEPTANCE.snapshot),
  'L5-M11': wp(['WP07'], ACCEPTANCE.relayStages),
  'L5-M12': wp(['WP07-0'], ACCEPTANCE.journalSafety),
  'L5-M13': wp(['WP10b'], ACCEPTANCE.dashboard),
  'L5-M14': wp(['WP10b'], ACCEPTANCE.dashboard),
  'L5-M15': wp(['WP10b'], ACCEPTANCE.dashboard),
  'L5-M16': wp(['WP10b'], ACCEPTANCE.dashboard),
  'L5-M18': wp(['WP14'], ACCEPTANCE.observability),
  'L5-M19': wp(['WP08a'], ACCEPTANCE.signerPolicy),
  'L5-M20': wp(['WP12'], ACCEPTANCE.configuration),
  'L5-M21': Object.freeze({
    openFailClosed: 'PLAN does not state a bind-host or TLS posture for the dashboard; keep exposure fail-closed until an approved criterion exists.',
  }),
  'L5-M22': wp(['WP16'], ACCEPTANCE.ciCoverage),
  'L5-M23': wp(['WP12'], ACCEPTANCE.configuration),
  'L5-M24': wp(['WP10a'], ACCEPTANCE.policyEngine),

  'L6-M1': wp(['WP04c'], ACCEPTANCE.launchComposition),
  'L6-M2': wp(['WP17'], ACCEPTANCE.programmableGate),
  'L6-M3': wp(['WP16'], ACCEPTANCE.ciCoverage),
  'L6-M4': wp(['WP20'], ACCEPTANCE.packageEvidence),
  'L6-M5': wp(['WP15'], ACCEPTANCE.cleanRoom),
  'L6-M6': wp(['WP00b', 'WP20', 'WP04A'], ACCEPTANCE.packageEvidence),
  'L6-M7': wp(['WP18'], ACCEPTANCE.realDependencies),
  'L6-M8': wp(['WP01', 'WP05', 'WP22b'], ACCEPTANCE.routerResolution),
  'L6-M9': wp(['WP16'], ACCEPTANCE.ciCoverage),
  'L6-M10': wp(['WP16'], ACCEPTANCE.ciCoverage),
  'L6-M11': wp(['WP00b', 'WP18', 'WP04A'], ACCEPTANCE.addressEvidence),
  'L6-M12': wp(['WP00a'], ACCEPTANCE.specification),
  'L6-M13': wp(['WP20'], ACCEPTANCE.packageEvidence),
  'L6-M14': wp(['WP00a', 'WP20'], ACCEPTANCE.specification),
  'L6-M15': wp(['WP00a', 'WP20'], ACCEPTANCE.specification),
  'L6-M16': wp(['WP16'], ACCEPTANCE.ciCoverage),
  'L6-M17': wp(['WP24'], ACCEPTANCE.controlledMerge),
});

const FINDING_FIELDS = Object.freeze(['id', 'severity', 'tag', 'verdict', 'title', 'where']);
const REPLACEMENT_BY_RULE = Object.freeze({
  'personal-name': 'historical committer identity',
  'unrelated-brand': 'external brand',
  'historical-architecture': 'legacy component',
  'historical-repository': 'archived repository',
  'historical-identity': 'historical identity',
});
const FIELD_OVERRIDES = Object.freeze({
  'L4-M15': Object.freeze({
    title: 'Production sweeps the operator balance while rehearsal distributes only observed buyback proceeds; settlement mint is never verified.',
  }),
  'L6-M5': Object.freeze({
    where: 'packages/adapters/src/app/accounting-projection.mjs:25,74-79 (legacy accounting field reconstruction); packages/adapters/test/app/accounting-projection.test.mjs:112-122; scripts/check-cleanroom.mjs:129-164,214-235',
  }),
  'L6-M16': Object.freeze({
    where: 'scripts/check-commit-identity.mjs:8-33 (historical identity exception map); pr5.diff:3052-3068 (historical committer identity commits); scripts/check-append-only.mjs:41; scripts/verify-control-dependencies.mjs:24',
  }),
});
const LOCAL_HOME_PATH_PATTERN = /(?:\/(?:Users|home)\/[^/\s]+|[A-Za-z]:[\\/]Users[\\/][^\\/\s]+)/gi;
const PRIVATE_EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const COAUTHOR_PATTERN = new RegExp(['Co', '-Authored-By:'].join(''), 'gi');
const LIVE_KEY_PATTERN = new RegExp(['pm', '_live_', '[A-Za-z0-9_-]+'].join(''), 'g');
const SOURCE_LANE_FIELDS = new Set(['lane', 'verified']);
const SOURCE_FINDING_FIELDS = new Set(FINDING_FIELDS);

function compareFindingIds(left, right) {
  return left.localeCompare(right, 'en', { numeric: true });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function hash(text) {
  return createHash('sha256').update(text).digest('hex');
}

function matchingRule(text, marker) {
  const normalized = text.toLowerCase();
  return DEFAULT_DIGEST_RULES
    .filter(rule => rule.id === marker.rule)
    .filter(rule => hash(normalized.slice(marker.offset, marker.offset + rule.length)) === rule.sha256)
    .sort((left, right) => right.length - left.length)[0];
}

function redactRegexMarkers(text) {
  return text
    .replace(LOCAL_HOME_PATH_PATTERN, '[redacted local path]')
    .replace(PRIVATE_EMAIL_PATTERN, '[redacted email]')
    .replace(COAUTHOR_PATTERN, '[redacted attribution]')
    .replace(LIVE_KEY_PATTERN, '[redacted credential]');
}

export function sanitizeText(value) {
  const text = redactRegexMarkers(String(value));
  const replacements = scanDigestMarkers(text)
    .map(marker => ({ marker, rule: matchingRule(text, marker) }))
    .filter(entry => entry.rule)
    .sort((left, right) => right.marker.offset - left.marker.offset || right.rule.length - left.rule.length);

  let sanitized = text;
  let protectedEnd = text.length;
  for (const { marker, rule } of replacements) {
    const end = marker.offset + rule.length;
    if (end > protectedEnd) continue;
    sanitized = `${sanitized.slice(0, marker.offset)}${REPLACEMENT_BY_RULE[rule.id] ?? 'redacted marker'}${sanitized.slice(end)}`;
    protectedEnd = marker.offset;
  }
  return sanitized;
}

function compactFinding(finding) {
  const compact = {};
  for (const field of FINDING_FIELDS) {
    if (typeof finding?.[field] !== 'string') throw new Error(`finding ${finding?.id ?? '(unknown)'} is missing ${field}`);
    compact[field] = sanitizeText(finding[field]);
  }
  return { ...compact, ...(FIELD_OVERRIDES[compact.id] ?? {}) };
}

export function sanitizeSourceReport(report) {
  if (!Array.isArray(report)) throw new Error('verified findings source must be an array');
  return report.map(lane => ({
    lane: sanitizeText(lane?.lane ?? ''),
    verified: (lane?.verified ?? []).map(compactFinding),
  }));
}

export function importVerifiedReports({ root = '.', inputPaths }) {
  if (!Array.isArray(inputPaths) || inputPaths.length !== SOURCE_PATHS.length) {
    throw new Error(`import requires ${SOURCE_PATHS.length} source paths`);
  }
  const resolvedRoot = resolve(root);
  for (const [index, inputPath] of inputPaths.entries()) {
    const outputPath = resolve(resolvedRoot, SOURCE_PATHS[index]);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, JSON.stringify(sanitizeSourceReport(readJson(inputPath)), null, 2) + '\n');
  }
}

function assertExactFields(value, expectedFields, context) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  for (const field of Object.keys(value)) {
    if (!expectedFields.has(field)) throw new Error(`${context} has unexpected field ${field}`);
  }
  for (const field of expectedFields) {
    if (!(field in value)) throw new Error(`${context} is missing field ${field}`);
  }
}

export function validateSanitizedSourceReports(sourceReports) {
  for (const source of sourceReports) {
    if (!Array.isArray(source.report)) throw new Error(`source ${source.path} must be an array`);
    for (const [laneIndex, lane] of source.report.entries()) {
      const laneContext = `source ${source.path} lane ${laneIndex}`;
      assertExactFields(lane, SOURCE_LANE_FIELDS, laneContext);
      if (typeof lane.lane !== 'string') throw new Error(`${laneContext} has a non-string lane`);
      if (!Array.isArray(lane.verified)) throw new Error(`${laneContext} verified must be an array`);
      for (const finding of lane.verified) {
        const findingContext = `source ${source.path} finding ${finding?.id ?? '(unknown)'}`;
        assertExactFields(finding, SOURCE_FINDING_FIELDS, findingContext);
        for (const field of FINDING_FIELDS) {
          if (typeof finding[field] !== 'string') throw new Error(`${findingContext} has a non-string ${field}`);
        }
      }
    }
  }
}

export function eligibleFindings(sourceReports) {
  return sourceReports
    .flatMap(source => source.report.flatMap(lane => lane.verified ?? []))
    .filter(finding => finding.verdict === 'CONFIRMED' || finding.verdict === 'CONTESTED')
    .sort((left, right) => compareFindingIds(left.id, right.id));
}

export function loadSourceReports(root = '.') {
  const resolvedRoot = resolve(root);
  return SOURCE_PATHS.map(path => ({
    path,
    report: readJson(resolve(resolvedRoot, path)),
  }));
}

export function buildTraceability({
  root = '.',
  sourceReports = loadSourceReports(root),
  dispositionByFindingId = DISPOSITION_BY_FINDING_ID,
  workPackageIds = WORK_PACKAGE_IDS,
} = {}) {
  validateSanitizedSourceReports(sourceReports);
  const findings = eligibleFindings(sourceReports).map(finding => {
    const disposition = dispositionByFindingId[finding.id];
    if (!disposition) throw new Error(`missing disposition mapping for ${finding.id}`);
    return {
      id: finding.id,
      severity: finding.severity,
      tag: finding.tag,
      verdict: finding.verdict,
      title: finding.title,
      where: finding.where,
      disposition,
    };
  });

  return {
    schemaVersion: 'hookemon.finding-traceability.v1',
    generatedFrom: SOURCE_PATHS,
    workPackageIds,
    findings,
  };
}

export function parseInvocation(argv) {
  const args = argv.slice(2);
  let root = '.';
  let rootSpecified = false;
  let inputPaths = null;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--root' && !rootSpecified && args[index + 1]) {
      root = args[index + 1];
      rootSpecified = true;
      index += 1;
      continue;
    }
    if (args[index] === '--import' && !inputPaths && args[index + 1] && args[index + 2]) {
      inputPaths = [args[index + 1], args[index + 2]];
      index += 2;
      continue;
    }
    throw new Error('usage: node scripts/build-traceability.mjs [--root <path>] [--import <l3> <l1-l2-l4-l5-l6>]');
  }
  return { root, inputPaths };
}

function main() {
  const { root, inputPaths } = parseInvocation(process.argv);
  if (inputPaths) importVerifiedReports({ root, inputPaths });
  const traceability = buildTraceability({ root });
  const outputPath = resolve(root, TRACEABILITY_PATH);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, JSON.stringify(traceability, null, 2) + '\n');
  console.log(`wrote ${TRACEABILITY_PATH} (${traceability.findings.length} findings)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
