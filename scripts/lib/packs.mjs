import { join } from 'node:path';
import { readJson } from './util.mjs';

const CONTRIBUTION_KEYS = ['feasibilityModels', 'gateItems', 'certifiedModules', 'releaseStates',
  'sourceHierarchy', 'opsTemplates', 'advisories', 'discoveryQuestions', 'phaseAdapters'];
const CORE_VERSION = '0.1.0';
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PATH_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;
const WINDOWS_DEVICE_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const VERSION_SOURCE = '(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)';
const VERSION_PATTERN = new RegExp(`^${VERSION_SOURCE}$`);
const COMPARISON_PATTERN = new RegExp(`^(>=|<=|>|<|=)?${VERSION_SOURCE}$`);

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = VERSION_PATTERN.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function isValidId(value) {
  return typeof value === 'string' && value.length <= 120 && ID_PATTERN.test(value);
}

function isValidOwnedPath(value) {
  if (typeof value !== 'string' || value === '' || value.startsWith('/') || value.includes('\\')) return false;
  const path = value.endsWith('/') ? value.slice(0, -1) : value;
  if (path === '') return false;
  return path.split('/').every(segment =>
    segment !== '.' && segment !== '..' && !segment.endsWith('.') && !segment.endsWith(' ') &&
    !WINDOWS_DEVICE_PATTERN.test(segment) && PATH_SEGMENT_PATTERN.test(segment));
}

function validateArray(errors, manifest, key, itemLabel, isValid) {
  if (manifest[key] === undefined) return;
  if (!Array.isArray(manifest[key])) {
    errors.push(`${key} must be an array`);
    return;
  }
  for (const value of manifest[key]) {
    if (!isValid(value)) errors.push(`invalid ${itemLabel} ${JSON.stringify(value)}`);
  }
}

function compareVersions(left, right) {
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return left[i] < right[i] ? -1 : 1;
  }
  return 0;
}

function parseCoreRange(value) {
  if (typeof value !== 'string' || value === '' || value.trim() !== value) return null;
  const comparisons = [];
  for (const clause of value.split(/\s+/)) {
    const match = COMPARISON_PATTERN.exec(clause);
    if (!match) return null;
    const version = match.slice(2).map(Number);
    if (!version.every(Number.isSafeInteger)) return null;
    comparisons.push({ operator: match[1] ?? '=', version });
  }
  return comparisons;
}

function coreRangeIncludesCurrent(comparisons) {
  const current = parseVersion(CORE_VERSION);
  return comparisons.every(({ operator, version }) => {
    const order = compareVersions(current, version);
    if (operator === '=') return order === 0;
    if (operator === '>') return order > 0;
    if (operator === '>=') return order >= 0;
    if (operator === '<') return order < 0;
    return order <= 0;
  });
}

function pathsOverlap(left, right) {
  const a = (left.endsWith('/') ? left.slice(0, -1) : left).toLowerCase();
  const b = (right.endsWith('/') ? right.slice(0, -1) : right).toLowerCase();
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function findDependencyCycle(manifests) {
  const packs = new Map(manifests.map(manifest => [manifest.id, manifest]));
  const visited = new Set();
  const stack = [];
  function visit(id) {
    if (visited.has(id)) return null;
    const cycleStart = stack.indexOf(id);
    if (cycleStart !== -1) return [...stack.slice(cycleStart), id];
    stack.push(id);
    for (const dependency of packs.get(id).dependsOn) {
      if (dependency === id || !packs.has(dependency)) continue;
      const cycle = visit(dependency);
      if (cycle) return cycle;
    }
    stack.pop();
    visited.add(id);
    return null;
  }
  for (const id of packs.keys()) {
    const cycle = visit(id);
    if (cycle) return cycle;
  }
  return null;
}

function readValidatedPack(packDir) {
  const errors = [];
  let m;
  try { m = readJson(join(packDir, 'pack.json')); }
  catch (e) {
    return { manifest: null, validation: { ok: false, errors: [String(e.message)] } };
  }
  if (!m || typeof m !== 'object' || Array.isArray(m)) {
    return { manifest: null, validation: { ok: false, errors: ['manifest must be an object'] } };
  }
  for (const k of ['id', 'version', 'coreCompat', 'namespaces', 'pathOwnership', 'dependsOn', 'contributions']) {
    if (m[k] === undefined) errors.push(`missing field ${k}`);
  }
  if (m.id !== undefined && !isValidId(m.id)) errors.push(`invalid id ${JSON.stringify(m.id)}`);
  if (m.version !== undefined && !parseVersion(m.version)) {
    errors.push(`invalid version ${JSON.stringify(m.version)}`);
  }
  validateArray(errors, m, 'namespaces', 'namespace', isValidId);
  validateArray(errors, m, 'pathOwnership', 'path', isValidOwnedPath);
  validateArray(errors, m, 'dependsOn', 'dependency id', isValidId);
  if (Array.isArray(m.dependsOn) && m.dependsOn.includes(m.id)) {
    errors.push(`pack ${m.id} depends on itself`);
  }
  if (m.coreCompat !== undefined) {
    const range = parseCoreRange(m.coreCompat);
    if (!range) errors.push(`invalid coreCompat ${JSON.stringify(m.coreCompat)}`);
    else if (!coreRangeIncludesCurrent(range)) {
      errors.push(`coreCompat ${m.coreCompat} does not include core ${CORE_VERSION}`);
    }
  }
  const contributionsAreObject = Boolean(m.contributions) &&
    typeof m.contributions === 'object' && !Array.isArray(m.contributions);
  if (m.contributions !== undefined && !contributionsAreObject) {
    errors.push('contributions must be a non-array object');
  }
  for (const k of CONTRIBUTION_KEYS) {
    if (!contributionsAreObject || m.contributions[k] === undefined) {
      errors.push(`missing contributions.${k}`);
    } else if (!Array.isArray(m.contributions[k])) {
      errors.push(`contributions.${k} must be an array`);
    }
  }
  if (JSON.stringify(m.contributions?.advisories ?? []).includes('"blocking":true')) {
    errors.push('advisories are advisory-only; a blocking advisory violates owner constraint 1');
  }
  const validation = { ok: errors.length === 0, errors };
  return { manifest: validation.ok ? m : null, validation };
}

export function validatePack(packDir) {
  return readValidatedPack(packDir).validation;
}

export function composePacks(packDirs) {
  const errors = [];
  const manifests = [];
  const seenIds = new Map(); const seenNs = new Map(); const seenPath = new Map();
  for (const dir of packDirs) {
    const { manifest: m, validation: v } = readValidatedPack(dir);
    if (!v.ok) { errors.push(...v.errors.map(e => `${dir}: ${e}`)); continue; }
    manifests.push(m);
    if (seenIds.has(m.id)) errors.push(`duplicate pack id ${m.id} in ${seenIds.get(m.id)} and ${dir}`);
    else seenIds.set(m.id, dir);
    for (const ns of m.namespaces) {
      if (seenNs.has(ns)) errors.push(`namespace ${ns} claimed by ${seenNs.get(ns)} and ${m.id}`);
      else seenNs.set(ns, m.id);
    }
    for (const p of m.pathOwnership) {
      if (seenPath.has(p)) errors.push(`path ${p} owned by ${seenPath.get(p)} and ${m.id}`);
      else {
        const overlap = [...seenPath.keys()].find(existing => pathsOverlap(existing, p));
        if (overlap) errors.push(`path ${p} overlaps ${overlap} owned by ${seenPath.get(overlap)} and ${m.id}`);
        else seenPath.set(p, m.id);
      }
    }
  }
  const packIds = new Set(manifests.map(m => m.id));
  for (const m of manifests) {
    for (const dependency of m.dependsOn) {
      if (dependency === m.id) errors.push(`pack ${m.id} depends on itself`);
      else if (!packIds.has(dependency)) errors.push(`pack ${m.id} depends on missing pack ${dependency}`);
    }
  }
  const cycle = findDependencyCycle(manifests);
  if (cycle) errors.push(`dependency cycle: ${cycle.join(' -> ')}`);
  return { ok: errors.length === 0, errors };
}
