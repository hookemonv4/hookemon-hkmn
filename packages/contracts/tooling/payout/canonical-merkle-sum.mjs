import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const DEPTH = 10;
export const WIDTH = 1 << DEPTH;
export const UINT256_MAX = (1n << 256n) - 1n;

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
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an,
  0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an,
  0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n,
  0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n,
  0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];

function rotateLeft(value, shift) {
  if (shift === 0) return value;
  const bits = BigInt(shift);
  return ((value << bits) | (value >> (64n - bits))) & MASK_64;
}

function permute(state) {
  for (const roundConstant of ROUND_CONSTANTS) {
    const columns = Array(5).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) columns[x] ^= state[x + 5 * y];
    }

    const mixed = columns.map((_, x) => columns[(x + 4) % 5] ^ rotateLeft(columns[(x + 1) % 5], 1));
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) state[x + 5 * y] ^= mixed[x];
    }

    const rotated = Array(25).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        rotated[y + 5 * ((2 * x + 3 * y) % 5)] =
          rotateLeft(state[x + 5 * y], ROTATION[x + 5 * y]);
      }
    }

    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        const offset = x + 5 * y;
        state[offset] =
          rotated[offset] ^ ((~rotated[((x + 1) % 5) + 5 * y]) & rotated[((x + 2) % 5) + 5 * y]);
        state[offset] &= MASK_64;
      }
    }
    state[0] ^= roundConstant;
  }
}

export function keccak256(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
  const paddedLength = Math.ceil((input.length + 1) / RATE_BYTES) * RATE_BYTES;
  const padded = new Uint8Array(paddedLength);
  padded.set(input);
  padded[input.length] = 0x01;
  padded[padded.length - 1] |= 0x80;

  const state = Array(25).fill(0n);
  for (let block = 0; block < padded.length; block += RATE_BYTES) {
    for (let lane = 0; lane < RATE_BYTES / 8; lane += 1) {
      let value = 0n;
      for (let byte = 0; byte < 8; byte += 1) {
        value |= BigInt(padded[block + lane * 8 + byte]) << BigInt(byte * 8);
      }
      state[lane] ^= value;
    }
    permute(state);
  }

  const output = new Uint8Array(32);
  for (let byte = 0; byte < output.length; byte += 1) {
    output[byte] = Number((state[Math.floor(byte / 8)] >> BigInt((byte % 8) * 8)) & 0xffn);
  }
  return output;
}

function bytesToHex(bytes) {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function hexToBytes(value, expectedBytes) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]*$/.test(value)) throw new TypeError('invalid hex');
  const digits = value.slice(2);
  if (digits.length !== expectedBytes * 2) throw new RangeError(`expected ${expectedBytes} bytes`);
  return Uint8Array.from(digits.match(/.{2}/g).map((byte) => Number.parseInt(byte, 16)));
}

function hashHex(bytes) {
  return bytesToHex(keccak256(bytes));
}

function utf8Hash(value) {
  return hashHex(new TextEncoder().encode(value));
}

export const TAGS = Object.freeze({
  manifest: utf8Hash('HOOKEMON_PAYOUT_MANIFEST_R55_A4_V1'),
  nonemptyLeaf: utf8Hash('HOOKEMON_PAYOUT_NONEMPTY_LEAF_R55_A4_V1'),
  emptyLeaf: utf8Hash('HOOKEMON_PAYOUT_EMPTY_LEAF_R55_A4_V1'),
  node: utf8Hash('HOOKEMON_PAYOUT_NODE_R55_A4_V1'),
});

function concatBytes(parts) {
  const size = parts.reduce((total, part) => total + part.length, 0);
  const result = new Uint8Array(size);
  let cursor = 0;
  for (const part of parts) {
    result.set(part, cursor);
    cursor += part.length;
  }
  return result;
}

function uintWord(value, bits = 256) {
  const integer = BigInt(value);
  if (integer < 0n || integer >= (1n << BigInt(bits))) throw new RangeError(`uint${bits} out of range`);
  return hexToBytes(`0x${integer.toString(16).padStart(64, '0')}`, 32);
}

function bytes32Word(value) {
  return hexToBytes(value, 32);
}

function addressWord(value) {
  return concatBytes([new Uint8Array(12), hexToBytes(value, 20)]);
}

function encodeStatic(words) {
  return concatBytes(words);
}

function validateEntries(entries, hook) {
  let previous = -1;
  for (const entry of entries) {
    if (!Number.isInteger(entry.index) || entry.index < 0 || entry.index >= WIDTH) {
      throw new RangeError('entry index out of range');
    }
    if (entry.index <= previous) throw new RangeError('entry indices must be strictly increasing');
    if (
      entry.recipient.toLowerCase() === '0x0000000000000000000000000000000000000000'
      || entry.recipient.toLowerCase() === hook.toLowerCase()
    ) {
      throw new RangeError('entry recipient must be nonzero and differ from the hook');
    }
    if (BigInt(entry.amount) <= 0n) throw new RangeError('entry amount must be positive');
    if (BigInt(entry.directBalance) <= 0n) throw new RangeError('entry direct balance must be positive');
    uintWord(entry.amount);
    uintWord(entry.directBalance);
    addressWord(entry.recipient);
    previous = entry.index;
  }
}

export function manifestBytes({ domain, snapshotNumber, snapshotHash, entries }) {
  validateEntries(entries, domain.hook);
  const headSize = 9 * 32;
  const head = encodeStatic([
    bytes32Word(TAGS.manifest),
    uintWord(1, 8),
    uintWord(domain.chainId),
    addressWord(domain.hook),
    bytes32Word(domain.cycleId),
    bytes32Word(domain.payoutId),
    uintWord(snapshotNumber),
    bytes32Word(snapshotHash),
    uintWord(headSize),
  ]);
  const encodedEntries = entries.flatMap((entry) => [
    uintWord(entry.index, 16),
    addressWord(entry.recipient),
    uintWord(entry.amount),
    uintWord(entry.directBalance),
  ]);
  return bytesToHex(concatBytes([head, uintWord(entries.length), ...encodedEntries]));
}

function leafDomainWords(domain) {
  return [
    uintWord(domain.chainId),
    addressWord(domain.hook),
    bytes32Word(domain.cycleId),
    bytes32Word(domain.payoutId),
    bytes32Word(domain.manifestDigest),
  ];
}

export function nonemptyLeaf(domain, index, recipient, amount) {
  if (!Number.isInteger(index) || index < 0 || index >= WIDTH) throw new RangeError('leaf index out of range');
  if (
    recipient.toLowerCase() === '0x0000000000000000000000000000000000000000'
    || recipient.toLowerCase() === domain.hook.toLowerCase()
  ) {
    throw new RangeError('leaf recipient must be nonzero and differ from the hook');
  }
  const sum = BigInt(amount);
  if (sum <= 0n || sum > UINT256_MAX) throw new RangeError('leaf amount must be positive uint256');
  const encoded = encodeStatic([
    bytes32Word(TAGS.nonemptyLeaf),
    ...leafDomainWords(domain),
    uintWord(index, 16),
    addressWord(recipient),
    uintWord(sum),
  ]);
  return { hash: hashHex(encoded), sum: sum.toString() };
}

export function emptyLeaf(domain, index) {
  if (!Number.isInteger(index) || index < 0 || index >= WIDTH) throw new RangeError('leaf index out of range');
  const encoded = encodeStatic([
    bytes32Word(TAGS.emptyLeaf),
    ...leafDomainWords(domain),
    uintWord(index, 16),
  ]);
  return { hash: hashHex(encoded), sum: '0' };
}

export function parentNode(level, left, right) {
  if (!Number.isInteger(level) || level < 0 || level >= DEPTH) throw new RangeError('node level out of range');
  const leftSum = BigInt(left.sum);
  const rightSum = BigInt(right.sum);
  if (leftSum < 0n || rightSum < 0n || leftSum > UINT256_MAX - rightSum) {
    throw new RangeError('uint256 sum overflow');
  }
  const encoded = encodeStatic([
    bytes32Word(TAGS.node),
    uintWord(level, 8),
    bytes32Word(left.hash),
    uintWord(leftSum),
    bytes32Word(right.hash),
    uintWord(rightSum),
  ]);
  return { hash: hashHex(encoded), sum: (leftSum + rightSum).toString() };
}

export function verifyProof(leaf, index, proof, expectedRoot) {
  if (!Number.isInteger(index) || index < 0 || index >= WIDTH) throw new RangeError('proof index out of range');
  if (proof.siblingHashes.length !== DEPTH || proof.siblingSums.length !== DEPTH) {
    throw new RangeError('proof must have depth 10');
  }
  let node = leaf;
  for (let level = 0; level < DEPTH; level += 1) {
    const sibling = { hash: proof.siblingHashes[level], sum: proof.siblingSums[level] };
    node = ((index >> level) & 1) === 0
      ? parentNode(level, node, sibling)
      : parentNode(level, sibling, node);
  }
  return node.hash === expectedRoot.hash && node.sum === expectedRoot.sum;
}

// Ordered fold: D[-1] = bytes32(0), D[i] = keccak256(abi.encode(
// D[i - 1], uint16(i), bytes32[10] siblingHashes, uint256[10] siblingSums)).
export function orderedProofsDigest(proofs) {
  if (proofs.length !== WIDTH) throw new RangeError('expected 1024 proofs');
  let digest = new Uint8Array(32);
  for (let index = 0; index < proofs.length; index += 1) {
    const proof = proofs[index];
    if (proof.siblingHashes.length !== DEPTH || proof.siblingSums.length !== DEPTH) {
      throw new RangeError('proof must have depth 10');
    }
    digest = keccak256(encodeStatic([
      digest,
      uintWord(index, 16),
      ...proof.siblingHashes.map(bytes32Word),
      ...proof.siblingSums.map((sum) => uintWord(sum)),
    ]));
  }
  return bytesToHex(digest);
}

export function buildDistribution({ domain, snapshotNumber, snapshotHash, entries }) {
  const encodedManifest = manifestBytes({ domain, snapshotNumber, snapshotHash, entries });
  const manifestDigest = hashHex(hexToBytes(encodedManifest, (encodedManifest.length - 2) / 2));
  const leafDomain = { ...domain, manifestDigest };
  const entryByIndex = new Map(entries.map((entry) => [entry.index, entry]));
  const leaves = Array.from({ length: WIDTH }, (_, index) => {
    const entry = entryByIndex.get(index);
    return entry
      ? nonemptyLeaf(leafDomain, index, entry.recipient, entry.amount)
      : emptyLeaf(leafDomain, index);
  });

  const levels = [leaves];
  for (let level = 0; level < DEPTH; level += 1) {
    const children = levels[level];
    const parents = Array.from(
      { length: children.length / 2 },
      (_, index) => parentNode(level, children[index * 2], children[index * 2 + 1]),
    );
    levels.push(parents);
  }

  const proofs = Array.from({ length: WIDTH }, (_, index) => {
    let cursor = index;
    const siblingHashes = [];
    const siblingSums = [];
    for (let level = 0; level < DEPTH; level += 1) {
      const sibling = levels[level][cursor ^ 1];
      siblingHashes.push(sibling.hash);
      siblingSums.push(sibling.sum);
      cursor >>= 1;
    }
    return { siblingHashes, siblingSums };
  });

  return {
    manifestBytes: encodedManifest,
    manifestDigest,
    leaves,
    root: levels[DEPTH][0],
    proofs,
  };
}

function paddedBytes32(value) {
  return `0x${BigInt(value).toString(16).padStart(64, '0')}`;
}

export function canonicalVector() {
  const input = {
    domain: {
      chainId: '466',
      hook: '0x1111111111111111111111111111111111111111',
      cycleId: paddedBytes32(0xc1c1en),
      payoutId: paddedBytes32(0xa110cn),
    },
    snapshotNumber: 12_345_678n,
    snapshotHash: paddedBytes32(0xabcdefn),
    entries: [
      { index: 0, recipient: '0x0000000000000000000000000000000000001001', amount: 100n, directBalance: 5n },
      { index: 1, recipient: '0x0000000000000000000000000000000000001002', amount: 200n, directBalance: 10n },
      { index: 17, recipient: '0x0000000000000000000000000000000000001012', amount: 300n, directBalance: 15n },
      { index: 511, recipient: '0x0000000000000000000000000000000000001511', amount: 400n, directBalance: 20n },
      { index: 1023, recipient: '0x0000000000000000000000000000000000002023', amount: 500n, directBalance: 25n },
    ],
  };
  const built = buildDistribution(input);
  return {
    schema: 'hookemon-canonical-merkle-sum-v1',
    depth: DEPTH,
    width: WIDTH,
    tags: TAGS,
    domain: input.domain,
    snapshot: { number: input.snapshotNumber.toString(), hash: input.snapshotHash },
    entries: input.entries.map((entry) => ({
      ...entry,
      amount: entry.amount.toString(),
      directBalance: entry.directBalance.toString(),
    })),
    manifest: { bytes: built.manifestBytes, digest: built.manifestDigest },
    root: built.root,
    proofsDigest: orderedProofsDigest(built.proofs),
    proofs: built.proofs,
  };
}

export function writeCanonicalVector(outputPath) {
  writeFileSync(outputPath, `${JSON.stringify(canonicalVector(), null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (process.argv.length !== 3) throw new Error('usage: node canonical-merkle-sum.mjs OUTPUT_PATH');
  writeCanonicalVector(process.argv[2]);
}
