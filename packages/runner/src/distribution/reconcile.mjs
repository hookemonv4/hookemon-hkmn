import { digest } from '../cycle/journal.mjs';
import { assertDigest, assertPlainObject } from '../cycle/schemas.mjs';

const closedLedgerFields = [
  'schema',
  'cycleId',
  'requirementsRevision',
  'preflightDigest',
  'fundingAuthorizationDigest',
  'operationsTrigger',
  'cycleVaultAccount',
  'policyAccount',
  'returnAccount',
  'closedJournalHead',
  'orderedReceiptDigests',
  'orderedExecutionAccountingDigests',
  'actualNativeGasUsed',
  'collectorOpen',
  'collectorOpenExecutionDigest',
  'collectorStatusDigest',
  'collectorOpenCustodyDigest',
  'collectorRpcFinalityDigest',
  'finalCredit',
  'ledgerDigest',
];
const finalCreditFields = [
  'receiptDigest',
  'destinationAccount',
  'asset',
  'preBalance',
  'postBalance',
  'amount',
  'transactionSignature',
  'blockHeight',
  'blockHash',
];
const closedProceedsBasisFields = [
  'schema',
  'authority',
  'cycleId',
  'proceedsKey',
  'closedLedgerDigest',
  'closedJournalHead',
  'operationsTrigger',
  'cycleVaultAccount',
  'policyAccount',
  'returnAccount',
  'finalCredit',
  'basisDigest',
];
const snapshotFields = [
  'schema',
  'authority',
  'asset',
  'chainId',
  'tokenAddress',
  'blockNumber',
  'blockHash',
  'finalized',
  'directBalances',
];
const snapshotBalanceFields = ['recipient', 'directHkmnBalance'];
const candidateEntryFields = ['index', 'recipient', 'directHkmnBalance', 'amountAtomicUSDG'];
const decimal = /^(?:0|[1-9][0-9]*)$/;
const positiveDecimal = /^(?:[1-9][0-9]*)$/;
const evmAddress = /^0x[0-9a-f]{40}$/;
const evmBlockHash = /^0x[0-9a-f]{64}$/;
const zeroEvmAddress = `0x${'0'.repeat(40)}`;
const maximumCandidateEntries = 1024;

function assertNonemptyString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} is invalid`);
}

function assertPositiveDecimal(value, label) {
  if (typeof value !== 'string' || !positiveDecimal.test(value)) {
    throw new Error(`${label} must be positive`);
  }
}

function assertEvmRecipient(value, label) {
  if (typeof value !== 'string' || !evmAddress.test(value) || value === zeroEvmAddress) {
    throw new Error(`${label} must be a canonical nonzero EVM address`);
  }
}

function assertExactPlainObjectShape(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error(`${label} symbols are unsupported`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (
    keys.length !== fields.length
    || !fields.every(field => Object.hasOwn(descriptors, field))
    || Object.values(descriptors).some(descriptor => !descriptor.enumerable || !Object.hasOwn(descriptor, 'value'))
  ) throw new Error(`${label} must use the exact schema`);
  return value;
}

function assertCandidateArray(value, label) {
  if (
    !Array.isArray(value)
    || Object.getPrototypeOf(value) !== Array.prototype
    || value.length < 1
    || value.length > maximumCandidateEntries
  ) throw new Error(`${label} must contain between 1 and 1024 entries`);
  if (Object.getOwnPropertySymbols(value).length !== 0) throw new Error(`${label} symbols are unsupported`);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length !== value.length + 1 || !Object.hasOwn(descriptors, 'length')) {
    throw new Error(`${label} must be dense and unadorned`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw new Error(`${label} must be dense and unadorned`);
    }
  }
  return value;
}

function digestOrderedItems(domain, items) {
  let head = digest({ domain: `${domain}.start`, count: items.length });
  for (const [index, item] of items.entries()) {
    head = digest({ domain, previousDigest: head, index, item });
  }
  return head;
}

function assertDigestList(value, label) {
  if (!Array.isArray(value) || value.length !== 4) throw new Error(`${label} is invalid`);
  value.forEach((item, index) => assertDigest(item, `${label} item ${index}`));
}

function assertClosedUsdGCredit(value) {
  const credit = assertPlainObject(value, finalCreditFields, 'closed proceeds basis final credit');
  assertDigest(credit.receiptDigest, 'closed proceeds basis final credit receipt digest');
  for (const field of ['destinationAccount', 'transactionSignature', 'blockHash']) {
    assertNonemptyString(credit[field], `closed proceeds basis final credit ${field}`);
  }
  if (credit.asset !== 'USDG') throw new Error('closed proceeds basis final credit must use USDG');
  for (const field of ['preBalance', 'postBalance']) {
    if (typeof credit[field] !== 'string' || !decimal.test(credit[field])) {
      throw new Error(`closed proceeds basis final credit ${field} is invalid`);
    }
  }
  if (typeof credit.amount !== 'string' || !positiveDecimal.test(credit.amount)) {
    throw new Error('closed proceeds basis final credit amount is invalid');
  }
  if (BigInt(credit.postBalance) - BigInt(credit.preBalance) !== BigInt(credit.amount)) {
    throw new Error('closed proceeds basis final credit must be activity-isolated');
  }
  if (typeof credit.blockHeight !== 'string' || !positiveDecimal.test(credit.blockHeight)) {
    throw new Error('closed proceeds basis final credit blockHeight is invalid');
  }
  return credit;
}

export function deriveClosedProceedsBasis(handoffValue) {
  const handoff = assertPlainObject(
    handoffValue,
    ['schema', 'authority', 'cycleId', 'proceedsKey', 'closedLedger'],
    'closed proceeds basis handoff',
  );
  if (
    handoff.schema !== 'hookemon.closed-proceeds-basis-handoff.v1'
    || handoff.authority !== 'READ_ONLY_SELF_CONSISTENT_NOT_STORE_MEMBERSHIP_PROOF'
  ) {
    throw new Error('closed proceeds basis handoff schema or authority is invalid');
  }
  assertPlainObject(handoff.closedLedger, closedLedgerFields, 'closed proceeds basis ledger');
  if (handoff.closedLedger.schema !== 'hookemon.fixture-closed-cycle-ledger.v4') {
    throw new Error('closed proceeds basis ledger schema is invalid');
  }
  assertDigest(handoff.proceedsKey, 'closed proceeds basis key');
  const { ledgerDigest, ...ledgerContent } = handoff.closedLedger;
  assertDigest(ledgerDigest, 'closed proceeds basis ledger digest');
  const expectedLedgerDigest = digest({
    domain: 'hookemon.fixture-closed-cycle-ledger.v4',
    ledger: ledgerContent,
  });
  if (ledgerDigest !== expectedLedgerDigest) throw new Error('closed ledger digest mismatch');
  const expectedProceedsKey = digest({
    domain: 'hookemon.cycle-runner.proceeds.v4',
    cycleId: handoff.cycleId,
    preflightDigest: handoff.closedLedger.preflightDigest,
    closedJournalHead: handoff.closedLedger.closedJournalHead,
    ledgerDigest,
    cycleVaultAccount: handoff.closedLedger.cycleVaultAccount,
    returnAccount: handoff.closedLedger.returnAccount,
    finalCredit: handoff.closedLedger.finalCredit,
  });
  if (handoff.proceedsKey !== expectedProceedsKey) throw new Error('proceeds key mismatch');
  assertNonemptyString(handoff.cycleId, 'closed proceeds basis handoff cycle');
  assertNonemptyString(handoff.closedLedger.cycleId, 'closed proceeds basis ledger cycle');
  if (handoff.closedLedger.cycleId !== handoff.cycleId) {
    throw new Error('closed proceeds basis cycle mismatch');
  }
  if (handoff.closedLedger.requirementsRevision !== 57) throw new Error('closed proceeds basis requirements revision is invalid');
  assertDigest(handoff.closedLedger.preflightDigest, 'closed proceeds basis preflight digest');
  assertDigest(handoff.closedLedger.fundingAuthorizationDigest, 'closed proceeds basis funding authorization digest');
  assertDigest(handoff.closedLedger.closedJournalHead, 'closed proceeds basis journal head');
  assertDigestList(handoff.closedLedger.orderedReceiptDigests, 'closed proceeds basis receipt digests');
  assertDigestList(
    handoff.closedLedger.orderedExecutionAccountingDigests,
    'closed proceeds basis execution accounting digests',
  );
  for (const field of [
    'collectorOpenExecutionDigest',
    'collectorStatusDigest',
    'collectorOpenCustodyDigest',
    'collectorRpcFinalityDigest',
  ]) assertDigest(handoff.closedLedger[field], `closed proceeds basis ${field}`);
  for (const field of ['operationsTrigger', 'cycleVaultAccount', 'policyAccount', 'returnAccount']) {
    assertNonemptyString(handoff.closedLedger[field], `closed proceeds basis ${field}`);
  }
  if (new Set([
    handoff.closedLedger.operationsTrigger,
    handoff.closedLedger.cycleVaultAccount,
    handoff.closedLedger.policyAccount,
    handoff.closedLedger.returnAccount,
  ]).size !== 4) throw new Error('closed proceeds basis custody binding is invalid');
  const finalCredit = assertClosedUsdGCredit(handoff.closedLedger.finalCredit);
  if (finalCredit.destinationAccount !== handoff.closedLedger.returnAccount) throw new Error('closed proceeds basis final credit must belong to the return account');
  const basis = {
    schema: 'hookemon.closed-proceeds-basis.v1',
    authority: 'READ_ONLY_SELF_CONSISTENT_NOT_STORE_MEMBERSHIP_PROOF',
    cycleId: handoff.cycleId,
    proceedsKey: handoff.proceedsKey,
    closedLedgerDigest: handoff.closedLedger.ledgerDigest,
    closedJournalHead: handoff.closedLedger.closedJournalHead,
    operationsTrigger: handoff.closedLedger.operationsTrigger,
    cycleVaultAccount: handoff.closedLedger.cycleVaultAccount,
    policyAccount: handoff.closedLedger.policyAccount,
    returnAccount: handoff.closedLedger.returnAccount,
    finalCredit: structuredClone(finalCredit),
  };
  return {
    ...basis,
    basisDigest: digest({ domain: 'hookemon.closed-proceeds-basis.v1', basis }),
  };
}

function validateClosedProceedsBasis(value) {
  const basis = assertPlainObject(value, closedProceedsBasisFields, 'closed proceeds basis');
  if (
    basis.schema !== 'hookemon.closed-proceeds-basis.v1'
    || basis.authority !== 'READ_ONLY_SELF_CONSISTENT_NOT_STORE_MEMBERSHIP_PROOF'
  ) throw new Error('closed proceeds basis schema or authority is invalid');
  assertNonemptyString(basis.cycleId, 'closed proceeds basis cycle');
  assertDigest(basis.proceedsKey, 'closed proceeds basis key');
  assertDigest(basis.closedLedgerDigest, 'closed proceeds basis ledger digest');
  assertDigest(basis.closedJournalHead, 'closed proceeds basis journal head');
  for (const field of ['operationsTrigger', 'cycleVaultAccount', 'policyAccount', 'returnAccount']) assertNonemptyString(basis[field], `closed proceeds basis ${field}`);
  if (new Set([
    basis.operationsTrigger,
    basis.cycleVaultAccount,
    basis.policyAccount,
    basis.returnAccount,
  ]).size !== 4) throw new Error('closed proceeds basis custody binding is invalid');
  assertClosedUsdGCredit(basis.finalCredit);
  if (basis.finalCredit.destinationAccount !== basis.returnAccount) throw new Error('closed proceeds basis final credit must belong to the return account');
  assertDigest(basis.basisDigest, 'closed proceeds basis digest');
  const { basisDigest, ...content } = basis;
  if (basisDigest !== digest({ domain: 'hookemon.closed-proceeds-basis.v1', basis: content })) {
    throw new Error('closed proceeds basis digest mismatch');
  }
  return basis;
}

function validateSnapshot(value) {
  const snapshot = assertExactPlainObjectShape(value, snapshotFields, 'HKMN snapshot candidate');
  if (
    snapshot.schema !== 'hookemon.input-bound-hkmn-snapshot-candidate.v1'
    || snapshot.authority !== 'INPUT_BOUND_CANDIDATE_NOT_AUTHENTICATED'
  ) throw new Error('HKMN snapshot schema or authority is invalid');
  if (snapshot.asset !== 'HKMN') throw new Error('snapshot asset must be HKMN');
  assertPositiveDecimal(snapshot.chainId, 'snapshot chainId');
  assertEvmRecipient(snapshot.tokenAddress, 'snapshot token address');
  assertPositiveDecimal(snapshot.blockNumber, 'snapshot block number');
  if (typeof snapshot.blockHash !== 'string' || !evmBlockHash.test(snapshot.blockHash)) {
    throw new Error('snapshot block hash is invalid');
  }
  if (snapshot.finalized !== true) throw new Error('snapshot must be finalized');
  const directBalances = assertCandidateArray(snapshot.directBalances, 'snapshot direct balances');
  const balancesByRecipient = new Map();
  for (const value of directBalances) {
    const balance = assertPlainObject(value, snapshotBalanceFields, 'snapshot direct balance');
    assertEvmRecipient(balance.recipient, 'snapshot recipient');
    assertPositiveDecimal(balance.directHkmnBalance, 'snapshot direct HKMN balance');
    if (balancesByRecipient.has(balance.recipient)) throw new Error('snapshot recipients must be unique');
    balancesByRecipient.set(balance.recipient, balance.directHkmnBalance);
  }
  return { snapshot, balancesByRecipient };
}

export function deriveHolderDistributionCandidate(inputValue) {
  const input = assertExactPlainObjectShape(
    inputValue,
    ['closedProceedsBasis', 'snapshot', 'entries'],
    'holder distribution candidate input',
  );
  const closedProceedsBasis = validateClosedProceedsBasis(input.closedProceedsBasis);
  const { snapshot, balancesByRecipient } = validateSnapshot(input.snapshot);
  const entries = assertCandidateArray(input.entries, 'holder candidate entries');
  if (entries.length !== snapshot.directBalances.length) {
    throw new Error('holder candidate entries do not match the snapshot holder set');
  }
  const recipients = new Set();
  let totalAmountAtomicUSDG = 0n;
  let previousIndex = -1;
  for (const value of entries) {
    const entry = assertPlainObject(value, candidateEntryFields, 'holder candidate entry');
    if (!Number.isInteger(entry.index)) {
      throw new Error('holder candidate index must be an integer');
    }
    if (entry.index < 0 || entry.index > 1023) {
      throw new Error('holder candidate index must be between 0 and 1023');
    }
    if (entry.index <= previousIndex) {
      throw new Error('holder candidate indices must be strictly increasing and unique');
    }
    previousIndex = entry.index;
    assertEvmRecipient(entry.recipient, 'holder candidate recipient');
    if (recipients.has(entry.recipient)) throw new Error('holder candidate recipients must be unique');
    recipients.add(entry.recipient);
    assertPositiveDecimal(entry.directHkmnBalance, 'holder candidate direct HKMN balance');
    if (balancesByRecipient.get(entry.recipient) !== entry.directHkmnBalance) {
      throw new Error('holder candidate direct HKMN balance does not match the snapshot');
    }
    assertPositiveDecimal(entry.amountAtomicUSDG, 'holder candidate USDG amount');
    totalAmountAtomicUSDG += BigInt(entry.amountAtomicUSDG);
  }
  if (totalAmountAtomicUSDG !== BigInt(closedProceedsBasis.finalCredit.amount)) {
    throw new Error('holder candidate USDG sum must equal the closed proceeds final credit');
  }

  const { directBalances, ...snapshotMetadata } = snapshot;
  const directBalancesDigest = digestOrderedItems(
    'hookemon.input-bound-hkmn-snapshot-balances-candidate.v1',
    directBalances,
  );
  const snapshotDigest = digest({
    domain: 'hookemon.input-bound-hkmn-snapshot-candidate.v1',
    snapshotMetadata,
    directBalancesDigest,
  });
  const entriesDigest = digestOrderedItems('hookemon.holder-distribution-candidate-entries.v1', entries);
  const candidate = {
    schema: 'hookemon.holder-distribution-candidate.v1',
    status: 'PENDING_OWNER_APPROVAL_AND_PROOF_DOMAIN',
    authority: 'INPUT_BOUND_CANDIDATE_NOT_AUTHENTICATED',
    closedProceedsBasisDigest: closedProceedsBasis.basisDigest,
    snapshotDigest,
    entriesDigest,
    entryCount: entries.length,
    totalAmountAtomicUSDG: totalAmountAtomicUSDG.toString(),
    snapshot: structuredClone(snapshot),
    entries: structuredClone(entries),
  };
  const candidateDigestInput = {
    schema: candidate.schema,
    status: candidate.status,
    authority: candidate.authority,
    closedProceedsBasisDigest: candidate.closedProceedsBasisDigest,
    snapshotDigest: candidate.snapshotDigest,
    entriesDigest: candidate.entriesDigest,
    entryCount: candidate.entryCount,
    totalAmountAtomicUSDG: candidate.totalAmountAtomicUSDG,
  };
  return {
    ...candidate,
    candidateDigest: digest({
      domain: 'hookemon.holder-distribution-candidate.v1',
      candidate: candidateDigestInput,
    }),
  };
}
