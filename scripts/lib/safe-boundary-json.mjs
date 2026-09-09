// Gitleaks 8.30.1 reads a plain file in 100 kB chunks and extends each chunk by at most
// 25 000 bytes until it reaches two consecutive newlines (sources/common.go,
// readUntilSafeBoundary). Pretty-printed JSON never contains a blank line, so a large
// manifest is cut mid-line and a digest split across two fragments no longer matches the
// exact full-line allowlists in .gitleaks.toml. Blank lines are insignificant JSON
// whitespace: inserting one at least every SAFE_BOUNDARY_GAP_BYTES keeps every line
// inside a single fragment without relaxing any scanner rule.
export const GITLEAKS_SAFE_BOUNDARY_PEEK_BYTES = 25_000;
export const SAFE_BOUNDARY_GAP_BYTES = 16_384;

// JSON.stringify(value, null, indent) with an empty line inserted before the first line
// that would leave more than maxGapBytes bytes between two blank-line boundaries.
// Deterministic for a given value; JSON.parse returns the same value.
export function stringifyWithSafeBoundaries(value, { indent = 2, maxGapBytes = SAFE_BOUNDARY_GAP_BYTES } = {}) {
  if (!Number.isInteger(maxGapBytes) || maxGapBytes < 2 || maxGapBytes > GITLEAKS_SAFE_BOUNDARY_PEEK_BYTES) {
    throw new RangeError(`maxGapBytes must be an integer between 2 and ${GITLEAKS_SAFE_BOUNDARY_PEEK_BYTES}`);
  }
  const limit = maxGapBytes - 1; // the inserted blank line itself costs one byte
  const lines = [];
  let gap = 0;
  for (const line of JSON.stringify(value, null, indent).split('\n')) {
    const bytes = Buffer.byteLength(line, 'utf8') + 1;
    if (bytes > limit) throw new RangeError(`a single line of ${bytes} bytes cannot satisfy maxGapBytes ${maxGapBytes}`);
    if (gap + bytes > limit) {
      lines.push('');
      gap = 0;
    }
    lines.push(line);
    gap += bytes;
  }
  return `${lines.join('\n')}\n`;
}

// Largest byte distance between consecutive blank-line boundaries ("\n\n"), measured from
// the file start and to the file end. Must stay at or below SAFE_BOUNDARY_GAP_BYTES.
export function maxBlankLineGapBytes(content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  let max = 0;
  let last = 0;
  for (let i = 1; i < bytes.length; i++) {
    if (bytes[i] === 0x0a && bytes[i - 1] === 0x0a) {
      max = Math.max(max, i + 1 - last);
      last = i + 1;
    }
  }
  return Math.max(max, bytes.length - last);
}
