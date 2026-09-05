const AUTHORIZATION_FIELDS = [
  'requirementsRevision',
  'chainId',
  'cycleId',
  'hook',
  'vault',
  'usdg',
  'operationsTrigger',
  'bindingManifestDigest',
  'payoutId',
  'manifestDigest',
  'rootHash',
  'rootSum',
  'returnActionDigest',
  'returnReceiptDigest',
  'expiresAt',
  'nonce',
];
const ADDRESS = /^0x[0-9a-f]{40}$/;
const BYTES32 = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/;
const POSITIVE_DECIMAL = /^(?:[1-9][0-9]*)$/;
const ZERO_ADDRESS = `0x${'0'.repeat(40)}`;
const ZERO_BYTES32 = `0x${'0'.repeat(64)}`;
const UINT256_MAX = (1n << 256n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;
const MASK_64 = (1n << 64n) - 1n;
const RATE_BYTES = 136;
const ROTATION = [
  0, 1, 62, 28, 27,
  36, 44, 6, 55, 20,
  3, 10, 43, 25, 39,
  41, 45, 15, 21, 8,
  18, 2, 61, 56, 14,
];
const ROUND_CONSTANTS = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

function exactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) throw new Error(`${label} must be a plain object`);
  if (Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) throw new Error(`${label} must use the exact schema`);
  return value;
}

function readUint(value, bits, label, positive = false) {
  if (typeof value !== 'string' || !(positive ? POSITIVE_DECIMAL : DECIMAL).test(value)) throw new Error(`${label} is invalid`);
  const parsed = BigInt(value);
  const maximum = bits === 64 ? UINT64_MAX : UINT256_MAX;
  if (parsed > maximum) throw new Error(`${label} is invalid`);
  return parsed;
}

function assertAddress(value, label) {
  if (typeof value !== 'string' || !ADDRESS.test(value) || value === ZERO_ADDRESS) throw new Error(`${label} is invalid or zero`);
}

function assertBytes32(value, label) {
  if (typeof value !== 'string' || !BYTES32.test(value) || value === ZERO_BYTES32) throw new Error(`${label} is invalid or zero`);
}

export function validateVaultPayoutAuthorization(value) {
  const authorization = exactObject(value, AUTHORIZATION_FIELDS, 'vault payout authorization');
  if (authorization.requirementsRevision !== 57) throw new Error('vault payout authorization revision is invalid');
  readUint(authorization.chainId, 256, 'vault payout authorization chainId', true);
  for (const field of ['cycleId', 'bindingManifestDigest', 'payoutId', 'manifestDigest', 'rootHash', 'returnActionDigest', 'returnReceiptDigest']) assertBytes32(authorization[field], `vault payout authorization ${field}`);
  for (const field of ['hook', 'vault', 'usdg', 'operationsTrigger']) assertAddress(authorization[field], `vault payout authorization ${field}`);
  if (new Set([authorization.hook, authorization.vault, authorization.usdg, authorization.operationsTrigger]).size !== 4) throw new Error('vault payout authorization identities must be distinct');
  readUint(authorization.rootSum, 256, 'vault payout authorization rootSum', true);
  readUint(authorization.expiresAt, 64, 'vault payout authorization expiresAt', true);
  readUint(authorization.nonce, 256, 'vault payout authorization nonce', true);
  return structuredClone(authorization);
}

function word(value) {
  return value.toString(16).padStart(64, '0');
}

export function encodeVaultPayoutAuthorization(value) {
  const authorization = validateVaultPayoutAuthorization(value);
  return `0x${[
    word(BigInt(authorization.requirementsRevision)),
    word(BigInt(authorization.chainId)),
    authorization.cycleId.slice(2),
    authorization.hook.slice(2).padStart(64, '0'),
    authorization.vault.slice(2).padStart(64, '0'),
    authorization.usdg.slice(2).padStart(64, '0'),
    authorization.operationsTrigger.slice(2).padStart(64, '0'),
    authorization.bindingManifestDigest.slice(2),
    authorization.payoutId.slice(2),
    authorization.manifestDigest.slice(2),
    authorization.rootHash.slice(2),
    word(BigInt(authorization.rootSum)),
    authorization.returnActionDigest.slice(2),
    authorization.returnReceiptDigest.slice(2),
    word(BigInt(authorization.expiresAt)),
    word(BigInt(authorization.nonce)),
  ].join('')}`;
}

function rotateLeft64(value, shift) {
  if (shift === 0) return value & MASK_64;
  const bits = BigInt(shift);
  return ((value << bits) | (value >> (64n - bits))) & MASK_64;
}

function keccakF1600(state) {
  for (const roundConstant of ROUND_CONSTANTS) {
    const columns = Array(5).fill(0n);
    const deltas = Array(5).fill(0n);
    const permuted = Array(25).fill(0n);
    for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) columns[x] ^= state[x + 5 * y];
    for (let x = 0; x < 5; x += 1) deltas[x] = columns[(x + 4) % 5] ^ rotateLeft64(columns[(x + 1) % 5], 1);
    for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) state[x + 5 * y] = (state[x + 5 * y] ^ deltas[x]) & MASK_64;
    for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) permuted[y + 5 * ((2 * x + 3 * y) % 5)] = rotateLeft64(state[x + 5 * y], ROTATION[x + 5 * y]);
    for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) state[x + 5 * y] = (permuted[x + 5 * y] ^ ((~permuted[(x + 1) % 5 + 5 * y]) & permuted[(x + 2) % 5 + 5 * y])) & MASK_64;
    state[0] = (state[0] ^ roundConstant) & MASK_64;
  }
}

export function keccak256(hexValue) {
  if (typeof hexValue !== 'string' || !/^0x(?:[0-9a-f]{2})*$/.test(hexValue)) throw new Error('keccak256 input must be canonical hex bytes');
  const input = Buffer.from(hexValue.slice(2), 'hex');
  const paddedLength = Math.ceil((input.length + 1) / RATE_BYTES) * RATE_BYTES;
  const padded = Buffer.alloc(paddedLength);
  input.copy(padded);
  padded[input.length] = 0x01;
  padded[padded.length - 1] |= 0x80;
  const state = Array(25).fill(0n);
  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let lane = 0; lane < RATE_BYTES / 8; lane += 1) {
      state[lane] ^= padded.readBigUInt64LE(offset + lane * 8);
    }
    keccakF1600(state);
  }
  const output = Buffer.alloc(32);
  for (let lane = 0; lane < 4; lane += 1) output.writeBigUInt64LE(state[lane], lane * 8);
  return `0x${output.toString('hex')}`;
}

export function vaultPayoutAuthorizationDigest(value) {
  return keccak256(encodeVaultPayoutAuthorization(value));
}

export function contractBytes32FromDigest(value, label = 'canonical digest') {
  if (typeof value !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${label} is invalid`);
  return `0x${value.slice(7)}`;
}
