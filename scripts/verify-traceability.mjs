#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TRACEABILITY_PATH,
  WORK_PACKAGE_IDS,
  buildTraceability,
  eligibleFindings,
  loadSourceReports,
  validateSanitizedSourceReports,
} from './build-traceability.mjs';

const DISPOSITION_KEYS = new Set(['wp', 'resolved', 'ownerOverride', 'openFailClosed', 'notApplicable']);

function exactDispositionKeys(disposition) {
  if (!disposition || typeof disposition !== 'object' || Array.isArray(disposition)) return [];
  return Object.keys(disposition).filter(key => DISPOSITION_KEYS.has(key));
}

function hasOnlyKeys(value, expected) {
  return Object.keys(value).every(key => expected.has(key)) && Object.keys(value).length === expected.size;
}

export function verifyTraceability({
  traceability,
  sourceReports,
  workPackageIds = WORK_PACKAGE_IDS,
} = {}) {
  validateSanitizedSourceReports(sourceReports);
  const errors = [];
  const expectedIds = new Set(eligibleFindings(sourceReports).map(finding => finding.id));
  const entries = Array.isArray(traceability?.findings) ? traceability.findings : [];
  const entryCount = new Map();

  for (const entry of entries) {
    entryCount.set(entry?.id, (entryCount.get(entry?.id) ?? 0) + 1);
  }

  for (const id of [...expectedIds].sort()) {
    const count = entryCount.get(id) ?? 0;
    if (count === 0) errors.push(`missing disposition for ${id}`);
    if (count > 1) errors.push(`multiple dispositions for ${id}`);
  }

  for (const entry of entries) {
    const id = entry?.id;
    if (!expectedIds.has(id)) {
      errors.push(`unexpected disposition for ${id ?? '(missing id)'}`);
      continue;
    }

    const disposition = entry.disposition;
    const keys = exactDispositionKeys(disposition);
    if (keys.length !== 1) {
      errors.push(`invalid disposition shape for ${id}`);
      continue;
    }

    const [key] = keys;
    if (key === 'wp') {
      if (!Array.isArray(disposition.wp) || disposition.wp.length === 0 || new Set(disposition.wp).size !== disposition.wp.length) {
        errors.push(`invalid work package list for ${id}`);
      }
      if (typeof disposition.acceptance !== 'string' || disposition.acceptance.trim() === '') {
        errors.push(`missing acceptance for ${id}`);
      }
      if (!hasOnlyKeys(disposition, new Set(['wp', 'acceptance']))) {
        errors.push(`invalid disposition fields for ${id}`);
      }
      for (const workPackageId of disposition.wp ?? []) {
        if (!workPackageIds.includes(workPackageId)) errors.push(`unknown work package ${workPackageId} for ${id}`);
      }
    } else {
      if (typeof disposition[key] !== 'string' || disposition[key].trim() === '') {
        errors.push(`missing ${key} reason for ${id}`);
      }
      if (!hasOnlyKeys(disposition, new Set([key]))) {
        errors.push(`invalid disposition fields for ${id}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function verifyCommittedTraceability(root = '.') {
  const sourceReports = loadSourceReports(root);
  validateSanitizedSourceReports(sourceReports);
  const traceabilityPath = resolve(root, TRACEABILITY_PATH);
  const traceabilityBytes = readFileSync(traceabilityPath, 'utf8');
  const traceability = JSON.parse(traceabilityBytes);
  const result = verifyTraceability({ traceability, sourceReports });
  try {
    const generated = buildTraceability({ root, sourceReports });
    const generatedBytes = JSON.stringify(generated, null, 2) + '\n';
    if (traceabilityBytes !== generatedBytes) {
      result.errors.push(`${TRACEABILITY_PATH} does not match generated output`);
    }
  } catch (error) {
    result.errors.push(error.message);
  }
  return { valid: result.errors.length === 0, errors: result.errors };
}

export function parseInvocation(argv) {
  const args = argv.slice(2);
  if (args.length === 0) return { root: '.' };
  if (args.length === 2 && args[0] === '--root') return { root: args[1] };
  throw new Error('usage: node scripts/verify-traceability.mjs [--root <path>]');
}

function main() {
  try {
    const { root } = parseInvocation(process.argv);
    const result = verifyCommittedTraceability(root);
    if (result.valid) {
      console.log('traceability check passed');
      return;
    }
    for (const error of result.errors) console.error(error);
    process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
