import { createHash } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, parse, posix, resolve, sep } from 'node:path';
import { assertSourceBundleManifest } from './source-bundle.mjs';

const sha256 = bytes => `0x${createHash('sha256').update(bytes).digest('hex')}`;
const fail = message => { throw new TypeError(`native build closure: ${message}`); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function relativePath(path) {
  if (typeof path !== 'string' || !path || /[^\x20-\x7e]|[\\:]/u.test(path) || path.startsWith('/')
    || path.split('/').some(part => !part || part === '.' || part === '..')) fail(`invalid relative POSIX path ${String(path)}`);
  return path;
}
function closurePath(path) {
  relativePath(path);
  if (!/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u.test(path)) fail(`invalid commitment closure path ${path}`);
  return path;
}
function directoryWithoutSymlinks(path) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of absolute.slice(current.length).split(sep).filter(Boolean)) {
    current = resolve(current, part);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`directory component is not a real directory: ${current}`);
  }
  return absolute;
}
function fileBytes(root, path) {
  closurePath(path);
  const absolute = resolve(root, path);
  directoryWithoutSymlinks(resolve(absolute, '..'));
  const before = lstatSync(absolute);
  if (!before.isFile() || before.isSymbolicLink()) fail(`not a regular file: ${path}`);
  const fd = openSync(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) fail(`file rebound: ${path}`);
    const bytes = readFileSync(fd);
    const after = fstatSync(fd);
    directoryWithoutSymlinks(resolve(absolute, '..'));
    const linked = lstatSync(absolute);
    if (after.size !== bytes.length || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.mode !== before.mode
      || linked.isSymbolicLink() || linked.dev !== before.dev || linked.ino !== before.ino) fail(`file changed during read: ${path}`);
    return { bytes, mode: before.mode & 0o777, physicalPath: path };
  } finally { closeSync(fd); }
}
function parseStandardInput(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail('standard input is not exact UTF-8');
  const value = JSON.parse(text);
  // JSON.parse otherwise silently accepts duplicate source keys and keeps only the last one.
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/gu);
  let index = 0;
  function visit() {
    const token = tokens[index++];
    if (token === '{') {
      const keys = new Set();
      while (tokens[index] !== '}') {
        const key = JSON.parse(tokens[index++]);
        if (keys.has(key)) fail(`duplicate standard-input key ${key}`);
        keys.add(key); index++; visit();
        if (tokens[index] !== ',') break;
        index++;
      }
      index++;
    } else if (token === '[') {
      while (tokens[index] !== ']') { visit(); if (tokens[index] !== ',') break; index++; }
      index++;
    }
  }
  visit();
  if (!object(value) || value.language !== 'Solidity' || !object(value.sources) || !Object.keys(value.sources).length
    || Object.keys(value).some(key => !['language', 'sources', 'settings'].includes(key))
    || !object(value.settings)) fail('requires an inline Solidity standard input');
  if (value.settings?.libraries !== undefined && (!object(value.settings.libraries) || Object.keys(value.settings.libraries).length)) {
    fail('external library linking is not allowed');
  }
  return value;
}
function remappingsFor(settings) {
  const entries = settings?.remappings ?? [];
  if (!Array.isArray(entries)) fail('remappings must be an array');
  const seen = new Set();
  return entries.map((entry, index) => {
    if (typeof entry !== 'string' || !/^([^:=]*:)?[^:=]+=[^:=]*$/u.test(entry)) fail('invalid import remapping');
    const [left, target] = entry.split('=');
    const [context, prefix] = left.includes(':') ? left.split(':') : ['', left];
    for (const path of [context, prefix, target].filter(Boolean)) relativePath(path.endsWith('/') ? path.slice(0, -1) : path);
    const identity = `${context}:${prefix}`;
    if (seen.has(identity)) fail('duplicate or conflicting import remapping');
    seen.add(identity);
    return { context, prefix, target, index };
  });
}
function importsIn(content) {
  // Solidity import grammar and VFS semantics: https://docs.soliditylang.org/en/v0.8.26/path-resolution.html
  // Comments and complete string tokens cannot introduce an import declaration.
  const tokens = content.match(/\/\/[^\r\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[A-Za-z_$][\w$]*|[^\s]/gu) ?? [];
  const clean = tokens.filter(token => !token.startsWith('//') && !token.startsWith('/*'));
  const imports = [];
  for (let i = 0; i < clean.length; i++) if (clean[i] === 'import') {
    const strings = [];
    for (i++; i < clean.length && clean[i] !== ';'; i++) if (/^["']/u.test(clean[i])) strings.push(clean[i]);
    if (i === clean.length || strings.length !== 1 || strings[0].includes('\\')) fail('unsupported import declaration');
    imports.push(strings[0].slice(1, -1));
  }
  return imports;
}
function resolvedImport(importer, specifier, remappings) {
  if (!specifier || /[\\:\x00-\x1f\x7f]/u.test(specifier) || specifier.startsWith('/')) fail('external import path');
  let path = specifier.startsWith('./') || specifier.startsWith('../')
    ? posix.normalize(posix.join(posix.dirname(importer), specifier)) : specifier;
  const applicable = remappings.filter(entry => importer.startsWith(entry.context) && path.startsWith(entry.prefix))
    // solc v0.8.26 implementation takes context precedence before prefix, then latest entry.
    // https://github.com/ethereum/solidity/blob/v0.8.26/libsolidity/interface/ImportRemapper.cpp
    .sort((a, b) => b.context.length - a.context.length || b.prefix.length - a.prefix.length || b.index - a.index);
  if (applicable.length) path = applicable[0].target + path.slice(applicable[0].prefix.length);
  return closurePath(path);
}

/**
 * Verifies every declared bundle member and unions it with compiler/input/source bytes.
 * This does not establish that the bundle contains the complete compiler/tool inventory:
 * the root producer must enforce that inventory and its mapping under the approved policy.
 * A compiler is required in the commitment closure, not necessarily in the provider bundle.
 * No compiler approval, readiness, or global output acyclicity is asserted here.
 */
export function collectNativeBuildClosure({ root, compilerPath, compilerSha256, standardInputPath,
  sourceBundleManifest, excludedOutputPaths, sourceRoot = '.' } = {}) {
  if (typeof root !== 'string' || !isAbsolute(root)) fail('root must be an absolute directory');
  const base = directoryWithoutSymlinks(root);
  closurePath(compilerPath); closurePath(standardInputPath);
  if (compilerPath === standardInputPath) fail('compiler and standard input paths must differ');
  if (!/^0x[0-9a-f]{64}$/u.test(compilerSha256 ?? '')) fail('expected compiler SHA-256 is required');
  if (!Array.isArray(excludedOutputPaths) || !excludedOutputPaths.length) fail('explicit excluded output paths are required');
  const excluded = new Set(excludedOutputPaths.map(closurePath));
  if (excluded.size !== excludedOutputPaths.length) fail('duplicate excluded output path');
  if (sourceRoot !== '.') closurePath(sourceRoot);
  directoryWithoutSymlinks(resolve(base, sourceRoot));
  assertSourceBundleManifest(sourceBundleManifest);
  const collected = new Map();
  function add(key, physicalPath = key) {
    closurePath(key); closurePath(physicalPath);
    for (const forbidden of excluded) if ([key, physicalPath].some(path => path === forbidden || path.startsWith(`${forbidden}/`))) {
      fail(`forbidden output path ${physicalPath}`);
    }
    const current = fileBytes(base, physicalPath);
    const prior = collected.get(key);
    if (prior && (prior.physicalPath !== physicalPath || !prior.bytes.equals(current.bytes))) fail(`ambiguous or rebound closure path ${key}`);
    collected.set(key, current);
    return current;
  }
  if (sha256(add(compilerPath).bytes) !== compilerSha256) fail('compiler SHA-256 mismatch');
  const input = parseStandardInput(add(standardInputPath).bytes);
  const remappings = remappingsFor(input.settings);
  for (const [path, source] of Object.entries(input.sources)) {
    closurePath(path);
    if (!object(source) || Object.keys(source).length !== 1 || typeof source.content !== 'string') fail(`source must contain inline content only: ${path}`);
    const physical = sourceRoot === '.' ? path : `${sourceRoot}/${path}`;
    if (!add(path, physical).bytes.equals(Buffer.from(source.content, 'utf8'))) fail(`embedded source bytes mismatch: ${path}`);
    for (const specifier of importsIn(source.content)) {
      const imported = resolvedImport(path, specifier, remappings);
      if (!Object.hasOwn(input.sources, imported)) fail(`unresolved import requires an external callback: ${imported}`);
    }
  }
  for (const entry of sourceBundleManifest.entries) {
    const file = add(entry.path);
    if (file.mode !== 0o644 || String(file.bytes.length) !== entry.byteLength
      || `sha256:${sha256(file.bytes).slice(2)}` !== entry.contentSha256) fail(`source bundle filesystem mismatch: ${entry.path}`);
  }
  const ordered = [...collected].sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return { sourceClosure: { compilerPath, standardInputPath, files: ordered.map(([path, file]) => ({ path, sha256: sha256(file.bytes) })) },
    sourceBytes: Object.fromEntries(ordered.map(([path, file]) => [path, Buffer.from(file.bytes)])) };
}
