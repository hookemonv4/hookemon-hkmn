import { execFileSync } from 'node:child_process';
import { copyFileSync, lstatSync, mkdirSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

function isInside(root, candidate) {
  const path = relative(root, candidate);
  return path !== '' && path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function overlaps(root, candidate) {
  return root === candidate || isInside(root, candidate) || isInside(candidate, root);
}

function resolvedPathBeforeCreation(path) {
  const missing = [];
  let ancestor = path;
  while (true) {
    try {
      return resolve(realpathSync(ancestor), ...missing);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw error;
      missing.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

function assertNoTargetSymlinkComponents(path) {
  const root = parse(path).root;
  let candidate = root;
  for (const component of relative(root, path).split(sep).filter(Boolean)) {
    candidate = join(candidate, component);
    try {
      if (lstatSync(candidate).isSymbolicLink()) {
        throw new Error('tracked fixture target path must not contain symlinks');
      }
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
}

function safeRelativePath(path) {
  const parts = path.split(/[\\/]/);
  if (!path || isAbsolute(path) || parts[0] === '.git' || parts.some(part => part === '.' || part === '..')) {
    throw new Error(`tracked fixture path must be repo-relative: ${path}`);
  }
  return path;
}

function trackedEntries(root) {
  const output = execFileSync('git', ['-C', root, 'ls-files', '--stage', '-z']);
  return output.toString('utf8').split('\0').filter(Boolean).map(record => {
    const separator = record.indexOf('\t');
    if (separator === -1) throw new Error('tracked fixture index entry is malformed');
    const [mode, , stage] = record.slice(0, separator).split(' ');
    if (stage !== '0') throw new Error('tracked fixture index must not contain unmerged entries');
    return { mode, path: safeRelativePath(record.slice(separator + 1)) };
  });
}

function validateTrackedPath(sourceRoot, tracked) {
  const { mode, path } = tracked;
  const source = resolve(sourceRoot, path);
  if (!isInside(sourceRoot, source)) {
    throw new Error(`tracked fixture path escapes project root: ${path}`);
  }
  if (mode === '160000') return { path, type: 'gitlink' };

  const sourceStat = lstatSync(source);
  if (sourceStat.isFile()) {
    if (!isInside(sourceRoot, realpathSync(source))) {
      throw new Error(`tracked fixture path escapes project root: ${path}`);
    }
    return { path, source, type: 'file' };
  }
  if (sourceStat.isSymbolicLink()) {
    const link = readlinkSync(source);
    if (
      isAbsolute(link)
      || !isInside(sourceRoot, resolve(dirname(source), link))
      || !isInside(sourceRoot, realpathSync(source))
    ) {
      throw new Error(`tracked fixture symlink escapes project root: ${path}`);
    }
    return { path, source, type: 'symlink', link };
  }
  throw new Error(`tracked fixture path must be a regular file or symlink: ${path}`);
}

function copyTrackedPath(targetRoot, entry) {
  const target = resolve(targetRoot, entry.path);
  if (!isInside(targetRoot, target)) {
    throw new Error(`tracked fixture path escapes project root: ${entry.path}`);
  }
  assertNoTargetSymlinkComponents(target);
  mkdirSync(dirname(target), { recursive: true });
  assertNoTargetSymlinkComponents(target);
  const targetParent = realpathSync(dirname(target));
  if (!isInside(targetRoot, targetParent) && targetParent !== targetRoot) {
    throw new Error(`tracked fixture target path escapes project root: ${entry.path}`);
  }
  if (entry.type === 'file') {
    copyFileSync(entry.source, target);
    return;
  }
  if (entry.type === 'gitlink') return;
  symlinkSync(entry.link, target);
}

export function copyTrackedProjectFiles(sourceRoot, targetRoot) {
  const source = realpathSync(resolve(sourceRoot));
  const entries = trackedEntries(source).map(entry => validateTrackedPath(source, entry));
  const requestedTarget = resolve(targetRoot);
  assertNoTargetSymlinkComponents(requestedTarget);
  if (overlaps(source, requestedTarget) || overlaps(source, resolvedPathBeforeCreation(requestedTarget))) {
    throw new Error('tracked fixture source and target roots must not overlap');
  }
  mkdirSync(requestedTarget, { recursive: true });
  if (lstatSync(requestedTarget).isSymbolicLink()) {
    throw new Error('tracked fixture target root must not be a symlink');
  }
  const target = realpathSync(requestedTarget);
  if (overlaps(source, target)) {
    throw new Error('tracked fixture source and target roots must not overlap');
  }
  for (const entry of entries) copyTrackedPath(target, entry);
}
