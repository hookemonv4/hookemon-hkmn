import {
  existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { hashFile, readJson, nowIso } from './util.mjs';
import { PHASES } from './phases.mjs';

const DIR = 'receipts';
const RECEIPT_KEYS = ['at', 'data', 'id', 'inputHashes', 'phase', 'result', 'type'];
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const BASE_RESERVED_TYPES = ['gate', 'owner-not-applicable-authorized'];

export function addReceipt(root, { type, phase = null, result = null, data = {}, inputs = [] }) {
  if (reservedReceiptTypes(root).has(type)) {
    throw new Error(`${type} receipt type is reserved for dedicated gate commands`);
  }
  return writeReceipt(root, { type, phase, result, data, inputs });
}

export function reservedReceiptTypes(root) {
  const types = new Set(BASE_RESERVED_TYPES);
  for (const phase of PHASES) {
    const path = join(root, 'gates', `${phase}.json`);
    if (!existsSync(path)) continue;
    const definition = readJson(path);
    if (!definition || !Array.isArray(definition.items)) {
      throw new Error(`gate ${phase} must define an items array before receipts can be written`);
    }
    for (const item of definition.items) {
      if (!item || typeof item.receiptType !== 'string' || !item.receiptType.trim()) {
        throw new Error(`gate ${phase} has an invalid reserved receiptType`);
      }
      types.add(item.receiptType);
    }
  }
  return types;
}

function writeReceipt(root, { type, phase, result, data, inputs }) {
  if (!Array.isArray(inputs)) throw new Error('receipt inputs must be an array');
  const inputHashes = {};
  for (const rel of inputs) inputHashes[rel] = hashFile(resolveReceiptInput(root, rel));
  const seq = nextReceiptSequence(root);
  const receipt = { id: `r-${seq.toString().padStart(5, '0')}`, at: nowIso(), type, phase, result, data, inputHashes };
  const dir = join(root, DIR);
  mkdirSync(dir, { recursive: true });
  const file = `${receipt.id}.json`;
  validateReceiptSchema(receipt, file);
  writeFileSync(join(dir, file), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return receipt;
}

function nextReceiptSequence(root) {
  const entries = readValidatedReceiptEntries(root);
  return entries.length === 0 ? 1n : entries.at(-1).sequence + 1n;
}

function receiptSequence(file) {
  const match = /^r-(\d+)\.json$/.exec(file);
  if (!match) throw new Error(`receipt filename must be canonical r-NNNNN.json: ${file}`);
  const sequence = BigInt(match[1]);
  if (sequence < 1n || file !== `r-${sequence.toString().padStart(5, '0')}.json`) {
    throw new Error(`receipt filename must be canonical r-NNNNN.json: ${file}`);
  }
  return sequence;
}

export function compareReceiptFilenames(left, right) {
  const a = receiptSequence(left);
  const b = receiptSequence(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

function validateReceiptSchema(receipt, file) {
  if (!isPlainObject(receipt)) throw new Error(`receipt ${file} must be a plain object`);
  const keys = Object.keys(receipt).sort();
  if (keys.length !== RECEIPT_KEYS.length || keys.some((key, index) => key !== RECEIPT_KEYS[index])) {
    throw new Error(`receipt ${file} must contain exactly ${RECEIPT_KEYS.join(', ')}`);
  }
  const expectedId = file.slice(0, -'.json'.length);
  if (receipt.id !== expectedId) throw new Error(`receipt id ${String(receipt.id)} does not match filename ${file}`);
  if (typeof receipt.at !== 'string' || Number.isNaN(Date.parse(receipt.at))
      || new Date(receipt.at).toISOString() !== receipt.at) {
    throw new Error(`receipt ${file} has invalid at timestamp`);
  }
  if (typeof receipt.type !== 'string' || !receipt.type.trim()) throw new Error(`receipt ${file} has invalid type`);
  if (receipt.phase !== null && (typeof receipt.phase !== 'string' || !receipt.phase.trim())) {
    throw new Error(`receipt ${file} has invalid phase`);
  }
  if (receipt.result !== null && (typeof receipt.result !== 'string' || !receipt.result.trim())) {
    throw new Error(`receipt ${file} has invalid result`);
  }
  if (!isPlainObject(receipt.data)) throw new Error(`receipt ${file} data must be a plain object`);
  if (!isPlainObject(receipt.inputHashes)) throw new Error(`receipt ${file} inputHashes must be a plain object`);
  for (const [input, hash] of Object.entries(receipt.inputHashes)) {
    if (!input || !HASH_PATTERN.test(hash)) throw new Error(`receipt ${file} has invalid input hash for ${input}`);
  }
}

function readValidatedReceiptEntries(root) {
  const dir = join(root, DIR);
  if (!existsSync(dir)) return [];
  const dirStat = lstatSync(dir);
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) throw new Error('receipts must be a real directory, not a symlink');
  const files = readdirSync(dir).filter(file => {
    if (file !== '.gitkeep') return true;
    const placeholder = lstatSync(join(dir, file));
    if (placeholder.isSymbolicLink() || !placeholder.isFile() || placeholder.size !== 0) {
      throw new Error('receipts/.gitkeep must be an empty regular placeholder');
    }
    return false;
  });
  const entries = files.map(file => {
    const path = join(dir, file);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`receipt file must not be a symlink: ${file}`);
    if (!stat.isFile()) throw new Error(`receipt entry must be a regular file: ${file}`);
    return { file, path, sequence: receiptSequence(file) };
  }).sort((left, right) => left.sequence < right.sequence ? -1 : left.sequence > right.sequence ? 1 : 0);

  let expected = 1n;
  for (const entry of entries) {
    if (entry.sequence !== expected) {
      throw new Error(`receipt sequences must be unique and contiguous: expected ${expected}, found ${entry.sequence}`);
    }
    entry.receipt = readJson(entry.path);
    validateReceiptSchema(entry.receipt, entry.file);
    expected += 1n;
  }
  return entries;
}

export function resolveReceiptInput(root, input) {
  if (typeof input !== 'string' || input.length === 0 || isAbsolute(input)
      || input.split(/[\\/]/).includes('..')) {
    throw new Error(`receipt input must be a repo-relative input path: ${String(input)}`);
  }
  const repoRoot = realpathSync(root);
  const candidate = resolve(repoRoot, input);
  const lexical = relative(repoRoot, candidate);
  if (lexical === '..' || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    throw new Error(`receipt input must be a repo-relative input path: ${input}`);
  }
  const target = realpathSync(candidate);
  const physical = relative(repoRoot, target);
  if (physical === '..' || physical.startsWith(`..${sep}`) || isAbsolute(physical)) {
    throw new Error(`receipt input resolves outside repository: ${input}`);
  }
  return target;
}

export function listReceipts(root) {
  return readValidatedReceiptEntries(root).map(entry => entry.receipt);
}

export function isStale(root, receipt) {
  const visiting = new Set();

  function visit(current) {
    const identity = current.id ?? current;
    if (visiting.has(identity)) return true;
    visiting.add(identity);
    try {
      for (const [rel, h] of Object.entries(current.inputHashes ?? {})) {
        let p;
        try { p = resolveReceiptInput(root, rel); }
        catch { return true; }
        if (hashFile(p) !== h) return true;
        if (/^receipts\/[^/]+\.json$/.test(rel) && visit(readJson(p))) return true;
      }
      return false;
    } finally {
      visiting.delete(identity);
    }
  }

  return visit(receipt);
}
