import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }
export function hashFile(p) { return sha256(readFileSync(p)); }
export function readJson(p, fallback) {
  if (!existsSync(p)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`missing ${p}`);
  }
  return JSON.parse(readFileSync(p, 'utf8'));
}
export function writeJson(p, o) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(o, null, 2) + '\n');
}
export function nowIso() { return new Date().toISOString(); }
