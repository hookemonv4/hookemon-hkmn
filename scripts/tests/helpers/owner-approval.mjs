import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { OWNER_APPROVAL_SCHEMA } from '../../lib/gates.mjs';
import { listReceipts } from '../../lib/receipts.mjs';
import { hashFile, readJson, writeJson } from '../../lib/util.mjs';

export function approvalSubjectHashes(root, inputs) {
  return Object.fromEntries(
    [...new Set(inputs)].sort().map(input => [input, hashFile(join(root, input))]),
  );
}

export function writeOwnerApproval(root, path, fields, subjectInputs) {
  const artifact = {
    schema: OWNER_APPROVAL_SCHEMA,
    authority: 'OWNER',
    action: fields.action,
    phase: fields.phase,
    itemId: fields.itemId,
    rationale: fields.rationale,
    approvalToken: fields.approvalToken ?? 'OWNER APPROVED',
    subjectHashes: approvalSubjectHashes(root, subjectInputs),
  };
  writeJson(join(root, path), artifact);
  return path;
}

export function overrideSubjectInputs(root, phase, excludedInput = null) {
  const inputs = new Set([`gates/${phase}.json`, 'policy/policy.json']);
  const runInput = `gates/runs/${phase}.json`;
  const definition = readJson(join(root, 'gates', `${phase}.json`));
  const itemById = new Map(definition.items.map(item => [item.id, item]));
  const receiptById = new Map(listReceipts(root).map(receipt => [receipt.id, receipt]));
  const receiptByInput = new Map(
    [...receiptById.values()].map(receipt => [`receipts/${receipt.id}.json`, receipt]),
  );

  if (existsSync(join(root, runInput))) {
    inputs.add(runInput);
    const run = readJson(join(root, runInput));
    for (const [itemId, entry] of Object.entries(run.items ?? {})) {
      if (entry?.status === 'ESCALATE') {
        for (const input of itemById.get(itemId)?.evidencePolicy?.requiredInputs ?? []) {
          if (existsSync(join(root, input))) inputs.add(input);
        }
      }
      if (!['RUN', 'INHERITED', 'NOT_APPLICABLE'].includes(entry?.status)) continue;
      const receipt = receiptById.get(entry.receipt);
      if (receipt) inputs.add(`receipts/${receipt.id}.json`);
    }
  }

  const queue = [...inputs].filter(input => receiptByInput.has(input));
  while (queue.length > 0) {
    const receipt = receiptByInput.get(queue.shift());
    for (const input of Object.keys(receipt.inputHashes ?? {})) {
      if (inputs.has(input)) continue;
      inputs.add(input);
      if (receiptByInput.has(input)) queue.push(input);
    }
  }
  return [...inputs]
    .filter(input => input !== excludedInput && existsSync(join(root, input)))
    .sort();
}
