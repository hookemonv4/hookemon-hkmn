import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const SCHEMA = 'hookemon.launch-delivery.v1';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = bytes => JSON.parse(bytes.toString('utf8'));
const wire = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const fail = message => { throw new Error(`launch delivery: ${message}`); };
const SECRET_PATH = /(^|\/)(?:\.env(?:\..*)?|\.git|\.session|\.v4|node_modules|.*\.(?:pem|key|p12|keystore))($|\/)/i;
const TREES = ['release/phase3', 'scripts/programmable'];
const FILES = ['specs/requirements.json', 'packages/contracts/foundry.toml', 'packages/contracts/remappings.txt', '.gitmodules',
  'decisions/owner-inputs/launch-inputs-owner.json', 'decisions/owner-inputs/programmable-acceptance.json',
  'apps/web/public/comic/coin.png'];

function safeName(name) {
  if (typeof name !== 'string' || !name || isAbsolute(name) || name.includes('\\') || name.split('/').some(p => !p || p === '.' || p === '..') || SECRET_PATH.test(name)) fail('unsafe input path');
  return name;
}

function safeFile(root, name) {
  safeName(name);
  let path = root;
  for (const component of name.split('/')) {
    path = resolve(path, component);
    if (lstatSync(path).isSymbolicLink()) fail(`symbolic link refused: ${name}`);
  }
  if (!lstatSync(path).isFile()) fail(`not a regular file: ${name}`);
  return path;
}

function git(root, args) {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
}

function gitIdentity(root) {
  return { head: git(root, ['rev-parse', 'HEAD']), tree: git(root, ['rev-parse', 'HEAD^{tree}']), branch: git(root, ['rev-parse', '--abbrev-ref', 'HEAD']) };
}

function treeFiles(root, name) {
  const output = [];
  function walk(path) {
    safeName(path);
    const stat = lstatSync(resolve(root, path));
    if (stat.isSymbolicLink()) fail(`symbolic link refused: ${path}`);
    if (stat.isDirectory()) for (const entry of readdirSync(resolve(root, path)).sort()) walk(`${path}/${entry}`);
    else if (stat.isFile()) output.push(path);
    else fail(`non-file input: ${path}`);
  }
  walk(name);
  return output;
}

function secretCheck(bytes, name) {
  const text = bytes.toString('utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text)
    || /(?:PROGRAMMABLE_API_KEY|HOOKEMON_COLLECTOR_CRYPT_API_KEY)["']?\s*[:=]\s*["']?(?!\$|<|process\.|YOUR_|your_|example|placeholder)[A-Za-z0-9_-]{24,}/.test(text)
    || /["']?Authorization["']?\s*[:=]\s*["']?Bearer\s+(?!\$|<|YOUR_|your_|example|placeholder)[A-Za-z0-9_.-]{24,}/i.test(text)
    || /["']?privateKey["']?\s*[:=]\s*["'](?:0x)?[a-f0-9]{64}["']/i.test(text)) fail(`credential-like input refused: ${name}`);
}

function collect(root) {
  const standardPath = 'release/phase3/build-info/launch.json';
  const input = json(readFileSync(safeFile(root, standardPath)));
  if (!input.sources || !Object.keys(input.sources).length) fail('compiler source inventory is empty');
  const paths = new Set(TREES.flatMap(name => treeFiles(root, name)));
  for (const name of FILES) if (existsSync(resolve(root, name))) paths.add(name);
  for (const name of Object.keys(input.sources)) paths.add(safeName(`packages/contracts/${name}`));
  const bytes = new Map();
  function add(name) {
    safeName(name);
    if (bytes.has(name)) return;
    const data = readFileSync(safeFile(root, name));
    secretCheck(data, name);
    bytes.set(name, data);
    // Only collect literal relative module imports; never execute source to discover inputs.
    if (/\.[cm]?js$/.test(name)) for (const match of data.toString('utf8').matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["'](\.[^"']+)["']/g)) {
      const dependency = relative(root, resolve(root, dirname(name), match[1]));
      add(dependency);
    }
  }
  for (const name of [...paths].sort()) add(name);
  for (const [name, source] of Object.entries(input.sources)) {
    if (typeof source.content !== 'string' || !bytes.get(`packages/contracts/${name}`).equals(Buffer.from(source.content))) fail(`compiler source differs from current source: ${name}`);
  }
  return new Map([...bytes].sort(([a], [b]) => a.localeCompare(b, 'en')));
}

function inspect(bytes) {
  const read = name => json(bytes.get(name));
  const input = read('release/phase3/build-info/launch.json');
  const artifacts = {};
  for (const name of ['token', 'custody', 'hook']) {
    const artifact = read(`release/phase3/artifacts/${name}.json`);
    const runtime = artifact.deployedBytecode?.object?.replace(/^0x/, '');
    if (!runtime || !/^[0-9a-f]+$/i.test(runtime) || runtime.length % 2) fail(`invalid runtime template: ${name}`);
    const metadata = typeof artifact.metadata === 'string' ? JSON.parse(artifact.metadata) : artifact.metadata;
    for (const setting of ['optimizer', 'evmVersion']) if (!isDeepStrictEqual(metadata?.settings?.[setting], input.settings[setting])) fail(`artifact compiler setting mismatch: ${name}/${setting}`);
    if ((metadata?.settings?.viaIR ?? false) !== (input.settings.viaIR ?? false)) fail(`artifact compiler setting mismatch: ${name}/viaIR`);
    artifacts[name] = { runtimeBytes: runtime.length / 2, runtimeTemplateSha256: sha(Buffer.from(runtime, 'hex')), withinEip170: runtime.length / 2 <= 24576 };
  }
  const unresolvedPaths = [];
  function visit(value, path = '') {
    if (value === null) unresolvedPaths.push(path || '/');
    else if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) visit(child, `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
  }
  visit(read('release/phase3/package/create-request.json'));
  const inputs = read('release/phase3/launch-inputs.json');
  const packageManifest = read('release/phase3/package/package-manifest.json');
  return {
    compilerSettings: input.settings, compilerSourceCount: Object.keys(input.sources).length, artifacts,
    metadata: inputs.metadata, roles: inputs.roles, token: inputs.token,
    requestNullPaths: unresolvedPaths,
    nullPathsMeaning: 'Inventory only; some nullable fields are valid. Official config-bound validation decides validity.',
    packageStatus: packageManifest.status ?? null, packageUnverified: packageManifest.unverified ?? [],
    openFacts: inputs.openFacts ?? [],
    evidenceBoundary: 'Source byte correspondence and artifact settings are checked. Compilation, runtime authority, provider admission and wallet authorization are separate.',
  };
}

function assertEqualSnapshot(before, after) {
  if (before.size !== after.size) fail('source changed during assembly');
  for (const [name, bytes] of before) if (!after.get(name)?.equals(bytes)) fail(`source changed during assembly: ${name}`);
}

function canonicalOutput(path) {
  let ancestor = resolve(path);
  const missing = [];
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    missing.unshift(relative(parent, ancestor));
    ancestor = parent;
  }
  return resolve(realpathSync(ancestor), ...missing);
}

/** Creates a fresh local delivery snapshot. Never creates or validates a launch request. */
export function assembleLaunchDelivery({ sourceRoot, outputDirectory }) {
  const root = realpathSync(sourceRoot), output = canonicalOutput(outputDirectory);
  if (existsSync(output)) fail('output exists; use a new snapshot directory');
  const within = relative(root, output);
  if (within === '' || (!within.startsWith('..') && !isAbsolute(within))) fail('output must be outside source worktree');
  const identity = gitIdentity(root), bytes = collect(root), inspection = inspect(bytes);
  const files = [...bytes].map(([path, data]) => ({ path, bytes: data.length, sha256: sha(data) }));
  const manifest = { schemaVersion: SCHEMA, createdAt: new Date().toISOString(), source: { root, ...identity }, files,
    contentSha256: sha(wire(files)), status: 'PREPARATION_SNAPSHOT', readyForPreflight: false,
    providerAdmission: 'NOT_PERFORMED', walletAuthorization: 'NOT_REQUESTED', inspection };
  mkdirSync(dirname(output), { recursive: true });
  const stage = `${output}.partial-${process.pid}`;
  mkdirSync(stage);
  try {
    for (const [name, data] of bytes) {
      const destination = resolve(stage, 'source', name);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, data, { flag: 'wx', mode: 0o600 });
    }
    assertEqualSnapshot(bytes, collect(root));
    if (!isDeepStrictEqual(identity, gitIdentity(root))) fail('source revision changed during assembly');
    writeFileSync(resolve(stage, 'manifest.json'), wire(manifest), { flag: 'wx', mode: 0o600 });
    writeFileSync(resolve(stage, 'README.md'), `# Hookemon launch delivery\n\nThis is an immutable local preparation snapshot, not a provider submission or signable launch.\n\nSource commit: ${identity.head}. Content SHA-256: ${manifest.contentSha256}. Source bytes may include uncommitted work; the file inventory binds the actual bytes rather than claiming they equal HEAD.\n\nThe source/ directory retains launch inputs, compiler sources, artifacts, package tools and metadata image when available. manifest.json records input gaps and runtime sizes. No API key or wallet secret is included.\n\nRefresh from the current source worktree into a new directory when upstream work changes. Check freshness before using any evidence. The existing commitment owner must finish the authenticated prebinding and official pack configuration. Official V4 validation must rebuild with that config; request-shape validation alone is insufficient. Never post release/phase3/package/create-request.json while it is a template.\n\nCLI sequence for a complete config: pack --config CONFIG --output launch.json --receipt receipt.json; validate launch.json --config CONFIG. Remote preflight and wallet action remain separate.\n`, { flag: 'wx', mode: 0o600 });
    verifyLaunchDelivery({ directory: stage });
    renameSync(stage, output);
    return { directory: output, contentSha256: manifest.contentSha256, fileCount: files.length, status: manifest.status, readyForPreflight: false, inspection };
  } catch (error) { rmSync(stage, { recursive: true, force: true }); throw error; }
}

export function verifyLaunchDelivery({ directory, sourceRoot }) {
  const root = realpathSync(directory);
  if (lstatSync(resolve(root, 'source')).isSymbolicLink()) fail('symbolic link refused: source');
  const manifest = json(readFileSync(safeFile(root, 'manifest.json')));
  if (manifest.schemaVersion !== SCHEMA || manifest.readyForPreflight !== false || manifest.status !== 'PREPARATION_SNAPSHOT') fail('unsupported delivery claims');
  if (!Array.isArray(manifest.files) || !manifest.files.length || sha(wire(manifest.files)) !== manifest.contentSha256) fail('inventory digest mismatch');
  const seen = new Set();
  for (const entry of manifest.files) {
    safeName(entry.path);
    if (seen.has(entry.path)) fail('duplicate inventory path');
    seen.add(entry.path);
    const bytes = readFileSync(safeFile(resolve(root, 'source'), entry.path));
    if (bytes.length !== entry.bytes || sha(bytes) !== entry.sha256) fail(`delivery bytes changed: ${entry.path}`);
  }
  const actual = treeFiles(root, 'source').map(name => name.slice(7));
  if (actual.length !== seen.size || actual.some(name => !seen.has(name))) fail('unexpected delivery file');
  const changes = [];
  if (sourceRoot) {
    const currentRoot = realpathSync(sourceRoot), current = collect(currentRoot);
    const entries = new Map(manifest.files.map(entry => [entry.path, entry]));
    for (const [name, bytes] of current) if (entries.get(name)?.sha256 !== sha(bytes)) changes.push(name);
    for (const name of entries.keys()) if (!current.has(name)) changes.push(name);
    if (gitIdentity(currentRoot).head !== manifest.source.head) changes.push('@source-commit');
  }
  return { integrity: 'VERIFIED', freshness: sourceRoot ? changes.length ? 'STALE' : 'CURRENT' : 'NOT_CHECKED', changes, contentSha256: manifest.contentSha256, readyForPreflight: false };
}
