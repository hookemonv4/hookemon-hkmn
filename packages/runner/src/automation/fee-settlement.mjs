const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const decimalPattern = /^(0|[1-9][0-9]*)$/;

function exactObject(value, fields, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new Error(`${label} must be a plain object`);
  }
  if (Object.keys(value).length !== fields.length || !fields.every(field => Object.hasOwn(value, field))) {
    throw new Error(`${label} must use the exact schema`);
  }
  return value;
}

function assertAddress(value, label) {
  if (typeof value !== 'string' || !addressPattern.test(value)) throw new Error(`${label} is invalid`);
}

function assertAmount(value, label) {
  if (typeof value !== 'string' || !decimalPattern.test(value)) throw new Error(`${label} is invalid`);
  if (BigInt(value) > (1n << 256n) - 1n) throw new Error(`${label} exceeds uint256`);
}

function planClaim(kind, liability, asset, source) {
  exactObject(liability, ['beneficiary', 'amount', 'claimAuthorityAvailable'], `${kind} liability`);
  assertAddress(liability.beneficiary, `${kind} beneficiary`);
  assertAmount(liability.amount, `${kind} amount`);
  if (typeof liability.claimAuthorityAvailable !== 'boolean') throw new Error(`${kind} claim authority is invalid`);
  return {
    kind,
    beneficiary: liability.beneficiary,
    destination: liability.beneficiary,
    asset,
    source,
    amount: liability.amount,
    status: liability.claimAuthorityAvailable ? 'READY' : 'PENDING_BENEFICIARY_AUTHORITY',
  };
}

export function planFeeSettlements(snapshot) {
  exactObject(snapshot, ['asset', 'source', 'programmable', 'treasuries', 'processLiability'], 'fee liability snapshot');
  if (!Array.isArray(snapshot.treasuries)) throw new Error('Treasury liabilities must be an array');
  assertAddress(snapshot.asset, 'fee liability asset');
  assertAddress(snapshot.source, 'fee liability source');
  assertAmount(snapshot.processLiability, 'process liability');
  const plans = [];
  const programmable = planClaim('PROGRAMMABLE', snapshot.programmable, snapshot.asset, snapshot.source);
  if (programmable.amount !== '0') plans.push(programmable);
  const seen = new Set();
  for (const liability of snapshot.treasuries) {
    const treasury = planClaim('TREASURY', liability, snapshot.asset, snapshot.source);
    const key = treasury.beneficiary.toLowerCase();
    if (seen.has(key)) throw new Error('duplicate Treasury beneficiary liability');
    seen.add(key);
    if (treasury.amount !== '0') plans.push(treasury);
  }
  return structuredClone(plans);
}

export function verifyFeeSettlement(receipt, plan, evidence) {
  exactObject(plan, ['kind', 'beneficiary', 'destination', 'asset', 'source', 'amount', 'status'], 'fee settlement plan');
  assertAddress(plan.asset, 'fee settlement plan asset');
  assertAddress(plan.source, 'fee settlement plan source');
  if (plan.status !== 'READY') throw new Error('beneficiary claim authority is unavailable');
  exactObject(
    receipt,
    ['kind', 'beneficiary', 'destination', 'asset', 'source', 'amount', 'transactionId', 'status', 'finalized'],
    'fee settlement receipt',
  );
  if (receipt.kind !== plan.kind || receipt.beneficiary !== plan.beneficiary) {
    throw new Error('fee settlement beneficiary mismatch');
  }
  if (receipt.destination !== plan.destination || receipt.destination !== receipt.beneficiary) {
    throw new Error('fee settlement destination mismatch');
  }
  if (receipt.asset !== plan.asset) throw new Error('fee settlement asset mismatch');
  if (receipt.source !== plan.source) throw new Error('fee settlement source mismatch');
  if (receipt.amount !== plan.amount) throw new Error('fee settlement amount mismatch');
  if (receipt.status !== 'SUCCESS') throw new Error('fee settlement is not success');
  if (receipt.finalized !== true) throw new Error('fee settlement is not finalized');
  if (typeof receipt.transactionId !== 'string' || receipt.transactionId.length === 0) {
    throw new Error('fee settlement transaction identity is invalid');
  }
  exactObject(evidence, ['chainReceipt', 'credit'], 'fee settlement independent evidence');
  exactObject(evidence.chainReceipt, ['transactionId', 'status', 'finalized', 'asset', 'source', 'destination', 'amount'], 'fee settlement chain receipt');
  assertAddress(evidence.chainReceipt.source, 'fee settlement chain source');
  if (
    evidence.chainReceipt.transactionId !== receipt.transactionId
    || evidence.chainReceipt.status !== 'SUCCESS'
    || evidence.chainReceipt.finalized !== true
    || evidence.chainReceipt.asset !== receipt.asset
    || evidence.chainReceipt.source !== receipt.source
    || evidence.chainReceipt.destination !== receipt.destination
    || evidence.chainReceipt.amount !== receipt.amount
    || typeof evidence.chainReceipt.source !== 'string'
    || evidence.chainReceipt.source.length === 0
  ) throw new Error('fee settlement chain receipt is not independently bound');
  exactObject(evidence.credit, ['asset', 'source', 'destination', 'amount', 'beforeBalance', 'afterBalance'], 'fee settlement credit evidence');
  assertAddress(evidence.credit.source, 'fee settlement credit source');
  for (const field of ['beforeBalance', 'afterBalance']) assertAmount(evidence.credit[field], `fee settlement ${field}`);
  if (
    evidence.credit.asset !== receipt.asset
    || evidence.credit.source !== receipt.source
    || evidence.credit.destination !== receipt.destination
    || evidence.credit.amount !== receipt.amount
    || BigInt(evidence.credit.afterBalance) - BigInt(evidence.credit.beforeBalance) !== BigInt(receipt.amount)
  ) throw new Error('fee settlement credit evidence is not independently bound');
  return structuredClone(receipt);
}
