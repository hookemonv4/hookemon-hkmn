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
    for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) columns[x] ^= state[x + 5 * y];
    const deltas = columns.map((_, x) => columns[(x + 4) % 5] ^ rotateLeft(columns[(x + 1) % 5], 1));
    for (let x = 0; x < 5; x += 1) for (let y = 0; y < 5; y += 1) state[x + 5 * y] = (state[x + 5 * y] ^ deltas[x]) & MASK_64;

    const rotated = Array(25).fill(0n);
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        rotated[y + 5 * ((2 * x + 3 * y) % 5)] = rotateLeft(state[x + 5 * y], ROTATION[x + 5 * y]);
      }
    }
    for (let x = 0; x < 5; x += 1) {
      for (let y = 0; y < 5; y += 1) {
        state[x + 5 * y] = (rotated[x + 5 * y]
          ^ ((~rotated[(x + 1) % 5 + 5 * y]) & rotated[(x + 2) % 5 + 5 * y])) & MASK_64;
      }
    }
    state[0] = (state[0] ^ roundConstant) & MASK_64;
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
      for (let byte = 0; byte < 8; byte += 1) value |= BigInt(padded[block + lane * 8 + byte]) << BigInt(byte * 8);
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

export function keccak256Hex(bytes) {
  return `0x${Buffer.from(keccak256(bytes)).toString('hex')}`;
}
