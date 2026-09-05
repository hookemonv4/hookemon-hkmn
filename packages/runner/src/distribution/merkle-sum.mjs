import {
  DEPTH,
  TAGS,
  WIDTH,
  buildDistribution,
  manifestBytes,
  orderedProofsDigest,
  verifyProof,
} from '../../../contracts/tooling/payout/canonical-merkle-sum.mjs';

export { DEPTH, TAGS, WIDTH, buildDistribution, manifestBytes, orderedProofsDigest, verifyProof };

function readWord(bytes, offset, label) {
  if (offset < 0 || offset + 32 > bytes.length) throw new Error(`${label} is truncated`);
  return bytes.subarray(offset, offset + 32);
}

function readUint(bytes, offset, bits, label) {
  const value = BigInt(`0x${Buffer.from(readWord(bytes, offset, label)).toString('hex')}`);
  if (value >= (1n << BigInt(bits))) throw new Error(`${label} exceeds uint${bits}`);
  return value;
}

function readBytes32(bytes, offset, label) {
  return `0x${Buffer.from(readWord(bytes, offset, label)).toString('hex')}`;
}

function readAddress(bytes, offset, label) {
  const word = readWord(bytes, offset, label);
  if (word.subarray(0, 12).some((byte) => byte !== 0)) throw new Error(`${label} is not canonical`);
  return `0x${Buffer.from(word.subarray(12)).toString('hex')}`;
}

export function decodeCanonicalManifest(value) {
  if (
    typeof value !== 'string'
    || !/^0x(?:[0-9a-f]{2})+$/.test(value)
    || (value.length - 2) % 64 !== 0
  ) throw new Error('canonical manifest bytes are invalid');
  const bytes = Buffer.from(value.slice(2), 'hex');
  if (bytes.length < 320) throw new Error('canonical manifest bytes are truncated');
  if (readBytes32(bytes, 0, 'manifest tag') !== TAGS.manifest) {
    throw new Error('canonical manifest tag is invalid');
  }
  if (readUint(bytes, 32, 8, 'manifest schema') !== 1n) {
    throw new Error('canonical manifest schema is invalid');
  }
  if (readUint(bytes, 256, 256, 'manifest entries offset') !== 288n) {
    throw new Error('canonical manifest entries offset is invalid');
  }
  const entryCount = readUint(bytes, 288, 256, 'manifest entry count');
  if (entryCount < 1n || entryCount > BigInt(WIDTH)) {
    throw new Error('canonical manifest entry count is invalid');
  }
  const expectedLength = 320 + Number(entryCount) * 128;
  if (bytes.length !== expectedLength) throw new Error('canonical manifest length is invalid');

  const domain = {
    chainId: readUint(bytes, 64, 256, 'manifest chainId').toString(),
    hook: readAddress(bytes, 96, 'manifest hook'),
    cycleId: readBytes32(bytes, 128, 'manifest cycleId'),
    payoutId: readBytes32(bytes, 160, 'manifest payoutId'),
  };
  const snapshotNumber = readUint(bytes, 192, 256, 'manifest snapshot number').toString();
  const snapshotHash = readBytes32(bytes, 224, 'manifest snapshot hash');
  const entries = [];
  for (let index = 0; index < Number(entryCount); index += 1) {
    const offset = 320 + index * 128;
    entries.push({
      index: Number(readUint(bytes, offset, 16, 'manifest entry index')),
      recipient: readAddress(bytes, offset + 32, 'manifest entry recipient'),
      amount: readUint(bytes, offset + 64, 256, 'manifest entry amount').toString(),
      directBalance: readUint(bytes, offset + 96, 256, 'manifest entry direct balance').toString(),
    });
  }
  const decoded = { domain, snapshotNumber, snapshotHash, entries };
  if (manifestBytes(decoded) !== value) throw new Error('canonical manifest encoding is noncanonical');
  return decoded;
}
