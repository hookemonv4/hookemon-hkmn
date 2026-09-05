import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const projectionPaths = Object.freeze({
  capabilityMapMarkdown: 'architecture/capability-map.md',
  executionTopologyMarkdown: 'architecture/execution-topology.md',
});
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const escapePattern = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function readRegularRepositoryFile(repositoryRoot, relativePath) {
  const absolutePath = resolve(repositoryRoot, relativePath);
  const realPath = realpathSync(absolutePath);
  const stat = lstatSync(absolutePath);
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || !realPath.startsWith(`${repositoryRoot}${sep}`)
  ) throw new Error(`architecture projection must be a regular repository file: ${relativePath}`);
  return readFileSync(realPath);
}

export function buildArchitectureProjectionBytes(repositoryRoot) {
  const root = realpathSync(repositoryRoot);
  const capabilityMapPath = resolve(root, 'architecture/capability-map.json');
  const capabilityMapBytes = readRegularRepositoryFile(root, 'architecture/capability-map.json');
  const capabilityMap = JSON.parse(capabilityMapBytes);
  if (
    Object.keys(capabilityMap.projection ?? {}).sort().join('\n')
      !== Object.keys(projectionPaths).sort().join('\n')
  ) throw new Error('architecture projection keys are invalid');

  let generatedText = capabilityMapBytes.toString('utf8');
  for (const [name, relativePath] of Object.entries(projectionPaths)) {
    const projection = capabilityMap.projection[name];
    if (
      projection?.path !== relativePath
      || Object.keys(projection).sort().join('\n') !== 'path\nsha256'
      || !/^[0-9a-f]{64}$/.test(projection.sha256 ?? '')
    ) {
      throw new Error(`architecture projection path is invalid: ${name}`);
    }
    const digest = sha256(readRegularRepositoryFile(root, relativePath));
    const pattern = new RegExp(
      `("${escapePattern(name)}"\\s*:\\s*\\{\\s*"path"\\s*:\\s*"${escapePattern(relativePath)}"\\s*,\\s*"sha256"\\s*:\\s*")[0-9a-f]{64}("\\s*\\})`,
      'g',
    );
    const matches = [...generatedText.matchAll(pattern)];
    if (matches.length !== 1) throw new Error(`architecture projection entry is invalid: ${name}`);
    generatedText = generatedText.replace(pattern, `$1${digest}$2`);
    projection.sha256 = digest;
  }
  return {
    capabilityMapPath,
    bytes: Buffer.from(generatedText),
    projection: structuredClone(capabilityMap.projection),
  };
}

export function refreshArchitectureProjections(repositoryRoot = defaultRoot, { check = false } = {}) {
  const generated = buildArchitectureProjectionBytes(repositoryRoot);
  const current = readFileSync(generated.capabilityMapPath);
  if (check) {
    if (!current.equals(generated.bytes)) {
      throw new Error('architecture/capability-map.json is stale');
    }
    return { status: 'CURRENT', projection: generated.projection };
  }
  writeFileSync(generated.capabilityMapPath, generated.bytes);
  return { status: 'REGENERATED', projection: generated.projection };
}

function parseArgs(args) {
  if (args.length === 0) return { check: false };
  if (args.length === 1 && args[0] === '--check') return { check: true };
  throw new Error('usage: node feasibility/refresh-architecture-projections.mjs [--check]');
}

if (
  process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const result = refreshArchitectureProjections(defaultRoot, parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
