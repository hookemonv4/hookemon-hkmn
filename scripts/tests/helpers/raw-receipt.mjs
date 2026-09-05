import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { listReceipts, resolveReceiptInput } from '../../lib/receipts.mjs';
import { hashFile, nowIso } from '../../lib/util.mjs';

// Test-only fixture writer for malformed/adversarial receipt cases. Production
// code intentionally exposes no raw writer for reserved gate receipt types.
export function writeRawReceipt(root, {
  type, phase = null, result = null, data = {}, inputs = [],
}) {
  const history = listReceipts(root);
  const sequence = history.length === 0 ? 1n : BigInt(history.at(-1).id.slice(2)) + 1n;
  const id = `r-${sequence.toString().padStart(5, '0')}`;
  const inputHashes = {};
  for (const input of inputs) inputHashes[input] = hashFile(resolveReceiptInput(root, input));
  const receipt = { id, at: nowIso(), type, phase, result, data, inputHashes };
  const directory = join(root, 'receipts');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, `${id}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx' });
  return receipt;
}
