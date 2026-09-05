#!/usr/bin/env node

import { hash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Sensitive retired names are represented only by lowercase SHA-256 digests.
// Length is measured in ASCII code units. Boundary rules prevent a retired
// repository slug from matching the approved slug when it is only a prefix.
export const DEFAULT_DIGEST_RULES = Object.freeze([
  { id: 'personal-name', length: 5, sha256: 'bf2c47223aeab03eb14749cc1a07fddffaa208f4158ca9a486a30f36118f83e0', boundary: false },
  { id: 'unrelated-brand', length: 6, sha256: '30d701c58428692f75ae7e9031d9e7619b6ce2a49841af82dbbb9440c1203cc3', boundary: false },
  { id: 'historical-architecture', length: 8, sha256: 'b60d7bdd334cd3768d43f14a05c7fe7e886ba5bcb77e1064530052fed1a3f145', boundary: false },
  { id: 'historical-architecture', length: 4, sha256: 'a34645ceb35b11e4a8aa9e39fd3b06fe6a6cd5f5028efbe1c53f8e2903aab966', boundary: false },
  { id: 'historical-architecture', length: 4, sha256: '57d4eaf1091577a6b7d121202afbd2808134f117fc4724c8b83fccfc6ce9d8e1', boundary: false },
  { id: 'historical-architecture', length: 10, sha256: '59c7475940f8242c90975ff557203e996569693a48ed817f955ca698fb3b5a7b', boundary: false },
  { id: 'historical-architecture', length: 27, sha256: 'd21202e0de6ec188433223f8246a9b429219f454b7054b7af8f5b9873b7d9bee', boundary: false },
  { id: 'historical-architecture', length: 21, sha256: '52dadc5ae9222525dc1a65da013ac760e660b44104785a9cb20ff62cb324d528', boundary: false },
  { id: 'historical-architecture', length: 24, sha256: 'fcdc5dd2765f7cd7618588655ccc5a41610825d32aab996f1eac618b1611037b', boundary: false },
  { id: 'historical-architecture', length: 24, sha256: '944c9d290c9e8a9ad8af543f45b96f7d76f2571dc0adc5a0a81bb3a5a3044b56', boundary: false },
  { id: 'historical-architecture', length: 9, sha256: '5ca7bdaec3bd799c779d682fa4fbd223498d0e72359e6241c7139809a5255a04', boundary: false },
  { id: 'historical-architecture', length: 9, sha256: 'af9bcad3a1f9e6d9341ec0a4dbd3e1b964f5be76983fe2e69cfc254674e4e516', boundary: false },
  { id: 'historical-architecture', length: 8, sha256: 'fece2f9ba2b4a27ced51850c0517ec962c53b5ed76a82f35b12ace4e0a4b545c', boundary: false },
  { id: 'historical-architecture', length: 8, sha256: '6111b28a1553883be9900227cfc38bc5b001be51a8ad25576b9fb1b32fa139e9', boundary: false },
  { id: 'historical-repository', length: 22, sha256: 'd9b0d2aeeb568ddb4e763d62dc3c5072e747894dac13d62df1dff95daa830f9d', boundary: false },
  { id: 'historical-repository', length: 16, sha256: '4407ecd74431d0a9f6733334848bc5708595c90b8c00aba0934380af7e7f18f8', boundary: false },
  { id: 'historical-repository', length: 27, sha256: '13f9d8d6e7b6538d6fe2a920ab486cbf7409360cc41ccf55ababd274e2936d74', boundary: false },
  { id: 'historical-repository', length: 19, sha256: 'd15f383e88bcc5a373351c62bbd1a65483fbddc4f567517196dd4a33057d9fc1', boundary: true },
  { id: 'historical-repository', length: 20, sha256: '0228a01d24b6d633601bfbb4f0618b8e4adf15a087ad0a9454203b3a6b35fd8b', boundary: true },
  { id: 'historical-repository', length: 13, sha256: 'dd62776781a3875728c94bdb377050c33cdcb697679612c34c2632d4b9b9c2f1', boundary: false },
  { id: 'historical-identity', length: 14, sha256: '5803aeef8e73d21e32bbeb6fc18b4a2c88d408782c9edf4ed5ab905e209673bf', boundary: false },
  { id: 'historical-identity', length: 18, sha256: 'fe1ac15a487753fb53a7eaf69463681a1f9d0764424fb9e0223e00fec4541f39', boundary: false },
  { id: 'historical-identity', length: 10, sha256: 'd67be943f4a368068987bf02ffff0db30f51ce0cf44fe58aed6a564db616b6d4', boundary: false },
  { id: 'historical-identity', length: 10, sha256: '15a0177c4681b926a87e27b8c99b63832be49d02243ed382f183dae53b11e6f3', boundary: false },
]);

const REGEX_RULES = [
  {
    id: 'local-home-path',
    pattern: /(?:\/(?:Users|home)\/[^/\s]+|[A-Za-z]:[\\/]Users[\\/][^\\/\s]+)/gi,
  },
  {
    id: 'private-email',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    allow: value => value.toLowerCase() === '312745360+hookemonv4@users.noreply.github.com',
  },
  {
    id: 'co-author-trailer',
    pattern: new RegExp(['Co', '-Authored-By:'].join(''), 'gi'),
  },
  {
    id: 'programmable-live-key',
    pattern: new RegExp(['pm', '_live_', '[A-Za-z0-9_-]+'].join(''), 'g'),
  },
];

const boundaryCharacter = /[\s/?#.,;:'"`\)\]}]/;
const DIGEST_CACHE_LIMIT = 100_000;
const DYNAMIC_RECONSTRUCTION_RULE = 'dynamic-protected-reconstruction';
const DIRECT_CHAR_CODE_PATTERN = /\bString\.fromCharCode\s*\(\s*(?<codes>\d{1,5}(?:\s*,\s*\d{1,5})*)\s*\)/g;
const SPREAD_CHAR_CODE_ARRAY_PATTERN = /\bString\.fromCharCode\s*\(\s*\.\.\.\s*\[\s*(?<codes>\d{1,5}(?:\s*,\s*\d{1,5})*)\s*\]\s*\)/g;
const CHAR_CODE_ARRAY_MAP_PATTERN = /\[\s*(?<codes>\d{1,5}(?:\s*,\s*\d{1,5})*)\s*\]\s*\.map\(\s*String\.fromCharCode\s*\)\s*\.join\(\s*(?<quote>['"])\k<quote>\s*\)/g;
const CHAR_CODE_ARRAY_ARROW_MAP_PATTERN = /\[\s*(?<codes>\d{1,5}(?:\s*,\s*\d{1,5})*)\s*\]\s*\.map\(\s*(?<parameter>[A-Za-z_$][A-Za-z0-9_$]*)\s*=>\s*String\.fromCharCode\s*\(\s*\k<parameter>\s*\)\s*\)\s*\.join\(\s*(?<quote>['"])\k<quote>\s*\)/g;
const CHAR_CODE_ARRAY_ASSIGNMENT_PATTERN = /\b(?:const|let|var)\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*\[\s*(?<codes>\d{1,5}(?:\s*,\s*\d{1,5})*)\s*\]/g;
const CHAR_CODE_ARRAY_SPREAD_REFERENCE_PATTERN = /\bString\.fromCharCode\s*\(\s*\.\.\.\s*(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*\)/g;
const BUFFER_RECONSTRUCTION_PATTERN = /\bBuffer\.from\(\s*(?<encodedQuote>['"])(?<encoded>[A-Za-z0-9+/=]+)\k<encodedQuote>\s*,\s*(?<encodingQuote>['"])(?<encoding>hex|base64)\k<encodingQuote>\s*\)\s*\.toString\(\s*(?:(?<outputQuote>['"])(?:utf8|utf-8|ascii|latin1)\k<outputQuote>\s*)?\)/gi;
const DYNAMIC_FUNCTION_PATTERN = /\bnew\s+Function\s*\(\s*(?<quote>['"])(?<value>[^\\\r\n]*)\k<quote>\s*\)/g;
const EVAL_PATTERN = /\beval\s*\(\s*(?<quote>['"])(?<value>[^\\\r\n]*)\k<quote>\s*\)/g;
const RETIRED_CYCLE_VAULT_DIGEST = '59c7475940f8242c90975ff557203e996569693a48ed817f955ca698fb3b5a7b';
const PREVIOUS_CHAIN_NAME_DIGEST = 'b60d7bdd334cd3768d43f14a05c7fe7e886ba5bcb77e1064530052fed1a3f145';
const PREVIOUS_CHAIN_ARTIFACT_PATH_LENGTH = 48;
const PREVIOUS_CHAIN_NAME_OFFSET = 25;
const PREVIOUS_CHAIN_ARTIFACT_PATH_DIGEST = '6dc4389c92063b6382d5e95697b3a488562784c494e7ac150b2718f0d1ab4ba9';
const PREVIOUS_CHAIN_ARTIFACT_CONTENT_DIGEST = 'a888007a9ff5555b309c2cec782ee33a6ec9f0831d9a69a93a000f38850cf9c3';
const approvedPathDelimiter = /[\s"'`()\[\]{},;]/;
const identifierCharacter = /[A-Za-z0-9_$\\]|[^\x00-\x7f]/;
const PHASE_THREE_JSON_PATH = /^release\/phase3\/[^/]+\.json$/;
const PHASE_THREE_PROVIDER_ADDRESS_ENUM = ['nonzero', ['ethe', 'reum'].join(''), 'address'].join('-');

// Exact full-token hashes keep the revision-56 exception fail-closed. New
// identifiers require an explicit control change instead of inheriting a
// substring exemption.
const APPROVED_REVISION_56_IDENTIFIER_DIGESTS = new Set([
  '13:766614d1dbef1b6ef00b31bcc895f9203acfb52dfaf9eb6ac67eab0a5f049e68',
  '13:e49083b2d6c9a630d57c9bf666bb34f443335a7676c6c7a25e78f20de71731be',
  '14:3c89498de8d087eebba08667fae1a6c3c10166effe702208d10d74e506d660a9',
  '14:4888a93020ad456cdde21f5a7dd882757d31a2862c9f0a23e3c7eae174bde412',
  '14:b9ca42ca733f8c6dbce64007f12bb1353a31ff98a05f5d490aa6402c3435a0c9',
  '17:0689234f2900a0772287a869071ec26e8382d44606695b893db184077e558632',
  '17:34e402ea72bd45dabedf4bc6d95ed1916af916dba63a731505b2d19e88c58a2b',
  '18:3429a0ae4a2625607269a8f5e88a00e864c06d65d729ec9333931cb142880098',
  '19:239ece8e6eb18157c8264562b9828131f09a7f9305386027f58e3cf3a9a521ef',
  '21:5f016584c63b964c9375fef7ecd3900fb5a6b5c5144592bf78c3ac2db131848e',
  '22:90a41b51bbf1ac537e819f3885b14064e55a297414e521972038abcf6c94d8d8',
  '24:672d8016d55ea1c3e329b30cbc639617dc8ef2f1222d7ad815ff0323800f0199',
  '24:9dff94c698f4b94208299e206bdbaf961f8899782e7d068f0a9fb502801aa101',
  '25:1488ba32de610eb1adca3d8c5013181b110e22776d9d0a10c91a0b6772fa8445',
  '25:aad76af67da21dc502137d5b3ad9a6c5e0d690ebca64983f871abb687447035d',
  '27:55e900884dc2a30915388d77241d7bcffd781dc8ad6488b693298ce10948bce7',
  '28:50f44664439bb89f05cb6fd82707802bb25d09968a95f37717c99bceeaa1da02',
  '29:5b38808628999575e3818dc0f23919e0c46d7dfdcb39ee7561b244578a595084',
  '31:d3590d39c5064a436f752f0ecd579572041851fd70c20bcca1bc5fe319a66944',
  '34:c71e635be5cc3527896a3c6e7a70ddeebe923367c00343d0479330492478dc90',
  '36:8dd4259e16599998e98954a815b3f80aa58abc75c13b910f99fecb8345e5b6ea',
]);

function sha256Text(text) {
  return hash('sha256', text, 'hex');
}

function isApprovedRevision56Identifier(text, offset, length) {
  let tokenStart = offset;
  let tokenEnd = offset + length;
  while (tokenStart > 0 && identifierCharacter.test(text[tokenStart - 1])) tokenStart -= 1;
  while (tokenEnd < text.length && identifierCharacter.test(text[tokenEnd])) tokenEnd += 1;
  const token = text.slice(tokenStart, tokenEnd);
  return APPROVED_REVISION_56_IDENTIFIER_DIGESTS.has(`${token.length}:${sha256Text(token)}`);
}

function isApprovedPreviousChainPathToken(text, offset) {
  const tokenStart = offset - PREVIOUS_CHAIN_NAME_OFFSET;
  const tokenEnd = tokenStart + PREVIOUS_CHAIN_ARTIFACT_PATH_LENGTH;
  if (tokenStart < 0 || tokenEnd > text.length) return false;
  if (tokenStart > 0 && !approvedPathDelimiter.test(text[tokenStart - 1])) return false;
  if (tokenEnd < text.length && !approvedPathDelimiter.test(text[tokenEnd])) return false;
  return sha256Text(text.slice(tokenStart, tokenEnd)) === PREVIOUS_CHAIN_ARTIFACT_PATH_DIGEST;
}

function isApprovedPhaseThreeProviderAddressEnum(text, offset, rule, file) {
  if (rule.sha256 !== PREVIOUS_CHAIN_NAME_DIGEST || !PHASE_THREE_JSON_PATH.test(file ?? '')) return false;
  const enumStart = offset - 'nonzero-'.length;
  const enumEnd = offset + rule.length + '-address'.length;
  if (enumStart < 0 || enumEnd > text.length) return false;
  if (text.slice(enumStart, enumEnd) !== PHASE_THREE_PROVIDER_ADDRESS_ENUM) return false;
  const prefix = text.slice(Math.max(0, enumStart - 64), enumStart);
  const suffix = text.slice(enumEnd, enumEnd + 64);
  return /:\s*"$/.test(prefix) && /^"\s*(?:[,}\]])/.test(suffix);
}

function isApprovedCurrentMarkerContext(text, offset, rule, file) {
  if (rule.sha256 === RETIRED_CYCLE_VAULT_DIGEST) {
    return isApprovedRevision56Identifier(text, offset, rule.length);
  }
  if (rule.sha256 === PREVIOUS_CHAIN_NAME_DIGEST) {
    return isApprovedPreviousChainPathToken(text, offset)
      || isApprovedPhaseThreeProviderAddressEnum(text, offset, rule, file);
  }
  return false;
}

export function scanDigestMarkers(text, digestRules = DEFAULT_DIGEST_RULES, file = null) {
  const normalized = text.toLowerCase();
  const grouped = new Map();
  for (const rule of digestRules) {
    if (!grouped.has(rule.length)) grouped.set(rule.length, new Map());
    const byDigest = grouped.get(rule.length);
    if (!byDigest.has(rule.sha256)) byDigest.set(rule.sha256, []);
    byDigest.get(rule.sha256).push(rule);
  }

  const findings = [];
  for (const [length, byDigest] of grouped) {
    const digestCache = new Map();
    for (let offset = 0; offset + length <= normalized.length; offset += 1) {
      const candidate = normalized.slice(offset, offset + length);
      let digest = digestCache.get(candidate);
      if (!digest) {
        digest = sha256Text(candidate);
        if (digestCache.size < DIGEST_CACHE_LIMIT) digestCache.set(candidate, digest);
      }
      const matches = byDigest.get(digest);
      if (!matches) continue;
      for (const rule of matches) {
        if (isApprovedCurrentMarkerContext(text, offset, rule, file)) continue;
        const next = normalized[offset + length];
        if (rule.boundary && next !== undefined && !boundaryCharacter.test(next)) continue;
        findings.push({ rule: rule.id, offset });
      }
    }
  }
  return findings.sort((a, b) => a.offset - b.offset || a.rule.localeCompare(b.rule));
}

function decodeCharacterCodes(source) {
  const codes = source.split(',').map(value => Number(value.trim()));
  if (codes.length === 0 || codes.some(code => !Number.isInteger(code) || code < 0 || code > 0xffff)) return null;
  return String.fromCharCode(...codes);
}

function isProtectedReconstruction(value, digestRules) {
  return scanDigestMarkers(value, digestRules).length > 0
    || digestRules.some(rule => rule.length === value.length);
}

function scanDynamicReconstructions(text, digestRules) {
  const findings = [];
  const offsets = new Set();
  const record = (offset, value) => {
    if (value === null || !isProtectedReconstruction(value, digestRules) || offsets.has(offset)) return;
    offsets.add(offset);
    findings.push({ rule: DYNAMIC_RECONSTRUCTION_RULE, offset });
  };

  for (const pattern of [DIRECT_CHAR_CODE_PATTERN, SPREAD_CHAR_CODE_ARRAY_PATTERN, CHAR_CODE_ARRAY_MAP_PATTERN, CHAR_CODE_ARRAY_ARROW_MAP_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) record(match.index, decodeCharacterCodes(match.groups.codes));
  }

  const namedCharCodeArrays = new Map();
  CHAR_CODE_ARRAY_ASSIGNMENT_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(CHAR_CODE_ARRAY_ASSIGNMENT_PATTERN)) {
    namedCharCodeArrays.set(match.groups.name, decodeCharacterCodes(match.groups.codes));
  }
  CHAR_CODE_ARRAY_SPREAD_REFERENCE_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(CHAR_CODE_ARRAY_SPREAD_REFERENCE_PATTERN)) {
    record(match.index, namedCharCodeArrays.get(match.groups.name) ?? null);
  }

  BUFFER_RECONSTRUCTION_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(BUFFER_RECONSTRUCTION_PATTERN)) {
    const { encoded, encoding } = match.groups;
    if (encoding.toLowerCase() === 'hex' && encoded.length % 2 !== 0) continue;
    record(match.index, Buffer.from(encoded, encoding).toString('utf8'));
  }

  for (const pattern of [DYNAMIC_FUNCTION_PATTERN, EVAL_PATTERN]) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) record(match.index, match.groups.value);
  }

  return findings.sort((a, b) => a.offset - b.offset || a.rule.localeCompare(b.rule));
}

function scanText(text, digestRules, file = null) {
  const findings = [...scanDigestMarkers(text, digestRules, file), ...scanDynamicReconstructions(text, digestRules)];
  for (const rule of REGEX_RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      if (rule.allow?.(match[0])) continue;
      findings.push({ rule: rule.id, offset: match.index });
    }
  }
  return findings.sort((a, b) => a.offset - b.offset || a.rule.localeCompare(b.rule));
}

function isPreviousChainArtifactPath(file) {
  return file.length === PREVIOUS_CHAIN_ARTIFACT_PATH_LENGTH
    && sha256Text(file) === PREVIOUS_CHAIN_ARTIFACT_PATH_DIGEST;
}

function isContentAddressedHistoricalEvidence(file, text) {
  return isPreviousChainArtifactPath(file)
    && sha256Text(text) === PREVIOUS_CHAIN_ARTIFACT_CONTENT_DIGEST;
}

function gitBuffer(root, args) {
  return execFileSync(
    'git',
    ['-C', root, ...args],
    { encoding: 'buffer' },
  );
}

function listFiles(root) {
  const files = [];
  const seen = new Set();

  for (const record of gitBuffer(root, ['ls-files', '-z', '--stage']).toString('utf8').split('\0')) {
    if (!record) continue;
    const separator = record.indexOf('\t');
    if (separator === -1) continue;
    const [mode, objectId, stage] = record.slice(0, separator).split(' ');
    const file = record.slice(separator + 1);
    if (stage !== '0' || seen.has(file)) continue;
    seen.add(file);
    const path = resolve(root, file);
    if (mode === '120000') {
      files.push({ file, buffer: gitBuffer(root, ['cat-file', 'blob', objectId]) });
    } else if (existsSync(path) && lstatSync(path).isFile()) {
      files.push({ file, path });
    }
  }

  for (const file of gitBuffer(root, ['ls-files', '-z', '--others', '--exclude-standard']).toString('utf8').split('\0')) {
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const path = resolve(root, file);
    if (existsSync(path) && lstatSync(path).isFile()) files.push({ file, path });
  }
  return files;
}

export function scanTree(rootPath, options = {}) {
  const root = resolve(rootPath);
  const digestRules = options.digestRules ?? DEFAULT_DIGEST_RULES;
  const findings = [];
  let scannedFiles = 0;

  for (const entry of listFiles(root)) {
    const buffer = entry.buffer ?? readFileSync(entry.path);
    scannedFiles += 1;
    const text = buffer.toString('utf8');
    const historicalEvidence = isContentAddressedHistoricalEvidence(entry.file, text);
    if (isPreviousChainArtifactPath(entry.file) && !historicalEvidence) {
      findings.push({ file: entry.file, rule: 'invalid-content-addressed-evidence', offset: 0 });
    }
    for (const match of scanText(entry.file, digestRules)) findings.push({ file: entry.file, ...match });
    // The provider's required address-validation enum is permitted only as a JSON value
    // in the direct Phase 3 package files; all other marker contexts remain rejected.
    for (const match of scanText(text, digestRules, entry.file)) {
      if (historicalEvidence && match.rule === 'historical-architecture') continue;
      findings.push({ file: entry.file, ...match });
    }
  }

  return { findings, scannedFiles };
}

function main() {
  const root = process.argv[2] ?? '.';
  const result = scanTree(root);

  if (result.findings.length === 0) {
    console.log('clean-room check passed (' + result.scannedFiles + ' text files)');
    return;
  }

  console.log('clean-room check failed: ' + result.findings.length + ' violation(s)');
  for (const finding of result.findings) {
    console.log('- ' + finding.file + ': ' + finding.rule);
  }
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
