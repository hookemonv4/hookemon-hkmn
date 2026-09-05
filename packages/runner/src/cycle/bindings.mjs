const CIRCLE_USD_COIN_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const identifier = /^[A-Za-z0-9][A-Za-z0-9:._-]{1,127}$/;
const bindingAccount = /^[A-Za-z0-9-]{8,64}$/;
const packCode = /^[a-z0-9][a-z0-9-]{1,63}$/;

export function validateCycleCustody(custody) {
  const fields = ['operationsTrigger', 'cycleVaultAccount', 'policyAccount', 'returnAccount'];
  if (!custody || typeof custody !== 'object' || Array.isArray(custody) || Object.getPrototypeOf(custody) !== Object.prototype || Object.keys(custody).length !== fields.length || !fields.every(field => Object.hasOwn(custody, field))) {
    throw new Error('cycle custody must use the exact schema');
  }
  for (const field of fields) {
    if (typeof custody[field] !== 'string' || !identifier.test(custody[field])) throw new Error(`cycle custody ${field} is invalid`);
  }
  if (new Set(fields.map(field => custody[field])).size !== fields.length) throw new Error('cycle custody accounts, including the return escrow, must be distinct');
  return Object.fromEntries(fields.map(field => [field, custody[field]]));
}

export function validateBinding(binding) {
  const fields = ['sourceChainId', 'executionCluster', 'circleDollarMint', 'circleDollarDecimals', 'pack', 'quantity', 'turbo', 'executionWallet', 'refundTokenAccount', 'refundTokenAccountOwner'];
  if (!binding || typeof binding !== 'object' || Array.isArray(binding) || Object.keys(binding).length !== fields.length || !fields.every(field => Object.hasOwn(binding, field))) throw new Error('binding must use the exact schema');
  const required = ['executionWallet', 'refundTokenAccount', 'refundTokenAccountOwner'];
  for (const field of required) if (typeof binding[field] !== 'string' || binding[field].trim() !== binding[field] || !bindingAccount.test(binding[field])) throw new Error(`binding ${field} is invalid`);
  if (binding.sourceChainId !== 4663) throw new Error('binding source chain is invalid');
  if (binding.executionCluster !== 'mainnet-beta') throw new Error('binding execution cluster is invalid');
  if (binding.circleDollarMint !== CIRCLE_USD_COIN_MINT || binding.circleDollarDecimals !== 6) throw new Error('binding Circle USD Coin is invalid');
  if (typeof binding.pack !== 'string' || !packCode.test(binding.pack)) throw new Error('binding pack is invalid');
  if (binding.quantity !== 1) throw new Error('binding quantity is invalid');
  if (binding.turbo !== false) throw new Error('binding turbo is invalid');
  if (binding.refundTokenAccountOwner !== binding.executionWallet) throw new Error('binding refund account must belong to execution wallet');
  return Object.fromEntries(fields.map(field => [field, binding[field]]));
}
