#!/usr/bin/env node

// Explicit, sorted, recursive test-file manifest used by .github/workflows/v4-gates.yml.
// Every *.test.mjs file in the repository (outside the excluded contract dependency tree)
// must belong to exactly one suite here. `check` fails closed on any file that does not.

import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TEST_FILE_SUFFIX = '.test.mjs';
export const TEST_TIMEOUT_MS = 120000;
export const EXCLUDED_DIRECTORY_NAMES = new Set(['node_modules', '.git', '.worktrees']);
export const EXCLUDED_PATHS = new Set(['packages/contracts/lib']);

export const SUITES = Object.freeze({
  runner: Object.freeze({ roots: Object.freeze(['packages/runner/test']) }),
  adapters: Object.freeze({ roots: Object.freeze(['packages/adapters/test']) }),
  dashboard: Object.freeze({ roots: Object.freeze(['packages/dashboard/test']) }),
  'contracts-js': Object.freeze({ roots: Object.freeze(['packages/contracts/test-js', 'packages/contracts/test/blind']) }),
  'contracts-abi': Object.freeze({ roots: Object.freeze(['packages/contracts/test/process']) }),
  scripts: Object.freeze({ roots: Object.freeze(['scripts/tests']) }),
});

function toPosix(path) {
  return path.split('\\').join('/');
}

function isExcludedPath(relativePath) {
  for (const excluded of EXCLUDED_PATHS) {
    if (relativePath === excluded || relativePath.startsWith(`${excluded}/`)) return true;
  }
  return false;
}

function isContained(root, candidate) {
  const path = relative(root, candidate);
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`));
}

function createRootContext(root) {
  const absoluteRoot = resolve(root);
  let stats;
  try {
    stats = lstatSync(absoluteRoot);
  } catch (error) {
    throw new Error(`test manifest repository root could not be read: ${error.message}`);
  }
  if (stats.isSymbolicLink()) throw new Error('test manifest repository root must not be a symbolic link');
  if (!stats.isDirectory()) throw new Error('test manifest repository root must be a regular directory');
  return { absoluteRoot, realRoot: realpathSync(absoluteRoot) };
}

function checkedNode(context, absolutePath, relativePath) {
  if (!isContained(context.absoluteRoot, absolutePath)) {
    throw new Error(`test manifest path escapes repository root: ${relativePath}`);
  }

  let stats;
  try {
    stats = lstatSync(absolutePath);
  } catch (error) {
    throw new Error(`test manifest path could not be read: ${relativePath}: ${error.message}`);
  }
  if (stats.isSymbolicLink()) throw new Error(`test manifest rejects symbolic link: ${relativePath}`);
  if (!stats.isDirectory() && !stats.isFile()) {
    throw new Error(`test manifest requires a regular file or directory: ${relativePath}`);
  }

  const realPath = realpathSync(absolutePath);
  if (!isContained(context.realRoot, realPath)) {
    throw new Error(`test manifest path resolves outside repository root: ${relativePath}`);
  }
  return stats;
}

function suiteDirectory(context, relativeRoot, { required = false } = {}) {
  const normalized = toPosix(relativeRoot);
  const absoluteRoot = resolve(context.absoluteRoot, relativeRoot);
  if (!isContained(context.absoluteRoot, absoluteRoot)) {
    throw new Error(`test manifest path escapes repository root: ${normalized}`);
  }

  let stats;
  try {
    stats = lstatSync(absoluteRoot);
  } catch (error) {
    if (error.code === 'ENOENT') {
      if (required) throw new Error(`test suite root must exist: ${normalized}`);
      return null;
    }
    throw new Error(`test manifest path could not be read: ${normalized}: ${error.message}`);
  }
  if (stats.isSymbolicLink()) throw new Error(`test manifest rejects symbolic link: ${normalized}`);
  if (!stats.isDirectory()) throw new Error(`test suite root must be a regular directory: ${normalized}`);
  checkedNode(context, absoluteRoot, normalized);
  return absoluteRoot;
}

function enumerateUnder(context, relativeRoot, options) {
  const absoluteRoot = suiteDirectory(context, relativeRoot, options);
  if (absoluteRoot === null) return [];
  const results = [];

  function visit(absoluteDir, relativeDir) {
    if (isExcludedPath(relativeDir)) return;
    for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      const absolutePath = join(absoluteDir, entry.name);
      const stats = checkedNode(context, absolutePath, relativePath);
      if (stats.isDirectory()) {
        if (EXCLUDED_DIRECTORY_NAMES.has(entry.name) || isExcludedPath(relativePath)) continue;
        visit(absolutePath, relativePath);
      } else if (entry.name.endsWith(TEST_FILE_SUFFIX)) {
        results.push(relativePath);
      }
    }
  }

  visit(absoluteRoot, toPosix(relativeRoot));
  results.sort();
  return results;
}

/**
 * Recursively lists every `.test.mjs` file under `root/relativeRoot`, sorted by code unit.
 * Returns repo-relative, forward-slash paths. Returns [] if the directory does not exist.
 * Skips EXCLUDED_DIRECTORY_NAMES and EXCLUDED_PATHS anywhere in the walk.
 */
export function enumerateTestFiles(root, relativeRoot) {
  return enumerateUnder(createRootContext(root), relativeRoot);
}

function walkAllTestFiles(context) {
  const results = [];

  function visit(absoluteDir, relativeDir) {
    if (isExcludedPath(relativeDir)) return;
    let entries;
    try {
      entries = readdirSync(absoluteDir, { withFileTypes: true });
    } catch (error) {
      throw new Error(`test manifest directory could not be read: ${relativeDir || '.'}: ${error.message}`);
    }
    for (const entry of entries) {
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`;
      const absolutePath = join(absoluteDir, entry.name);
      const stats = checkedNode(context, absolutePath, relativePath);
      if (stats.isDirectory()) {
        if (EXCLUDED_DIRECTORY_NAMES.has(entry.name) || isExcludedPath(relativePath)) continue;
        visit(absolutePath, relativePath);
      } else if (entry.name.endsWith(TEST_FILE_SUFFIX)) {
        results.push(relativePath);
      }
    }
  }

  visit(context.absoluteRoot, '');
  results.sort();
  return results;
}

/**
 * Builds the full manifest report: each suite's file list, plus any test file found in the
 * repository that is not covered by any suite root (an "orphan"). ok is true only when every
 * declared suite root is non-empty, every test path has one suite owner, and there are no orphans.
 */
export function checkManifest(root, suiteDefinitions = SUITES) {
  const errors = [];
  const suites = {};
  const claimed = new Map();
  let context;
  try {
    context = createRootContext(root);
  } catch (error) {
    return { ok: false, errors: [error.message], orphans: [], suites };
  }

  for (const [name, suite] of Object.entries(suiteDefinitions)) {
    const files = new Set();
    for (const suiteRoot of suite.roots) {
      try {
        const rootFiles = enumerateUnder(context, suiteRoot, { required: true });
        if (rootFiles.length === 0) errors.push(`suite root ${suiteRoot} has no test files`);
        for (const file of rootFiles) {
          files.add(file);
          const owner = claimed.get(file);
          if (owner && owner !== name) {
            errors.push(`${file} belongs to multiple suites: ${owner}, ${name}`);
          } else if (!owner) {
            claimed.set(file, name);
          }
        }
      } catch (error) {
        errors.push(error.message);
      }
    }
    const sorted = [...files].sort();
    suites[name] = { files: sorted };
    if (sorted.length === 0) errors.push(`suite ${name} has no test files`);
  }

  let allTestFiles = [];
  try {
    allTestFiles = walkAllTestFiles(context);
  } catch (error) {
    errors.push(error.message);
  }
  const orphans = allTestFiles.filter(file => !claimed.has(file));
  for (const file of orphans) errors.push(`${file} is not in any suite`);

  return { ok: errors.length === 0, errors, orphans, suites };
}

/** Returns the sorted file list for one suite. Throws if the suite is unknown or empty. */
export function listSuite(root, name) {
  const suite = SUITES[name];
  if (!suite) throw new Error(`unknown suite ${name}`);
  const context = createRootContext(root);
  const files = new Set();
  for (const suiteRoot of suite.roots) {
    const rootFiles = enumerateUnder(context, suiteRoot, { required: true });
    if (rootFiles.length === 0) throw new Error(`suite root ${suiteRoot} has no test files`);
    for (const file of rootFiles) files.add(file);
  }
  const sorted = [...files].sort();
  if (sorted.length === 0) throw new Error(`suite ${name} has no test files`);
  return sorted;
}

function usage() {
  return 'usage: node scripts/test-manifest.mjs <check|list <suite>>';
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const root = process.cwd();

  if (command === 'check' && rest.length === 0) {
    const report = checkManifest(root);
    if (!report.ok) {
      for (const error of report.errors) process.stderr.write(`${error}\n`);
      process.exitCode = 1;
      return;
    }
    const counts = Object.fromEntries(Object.entries(report.suites).map(([name, suite]) => [name, suite.files.length]));
    process.stdout.write(`${JSON.stringify(counts)}\n`);
    return;
  }

  if (command === 'list' && rest.length === 1) {
    try {
      const files = listSuite(root, rest[0]);
      process.stdout.write(`${files.join('\n')}\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

  process.stderr.write(`${usage()}\n`);
  process.exitCode = 1;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
