// Pure, injectable combiner for a Solana current-finalized custody balance observation.
//
// This module performs no RPC I/O and imports no transport. It only validates and binds
// already-fetched read results from two independently configured sources; the caller owns
// issuing the underlying `getMultipleAccounts`/`getBlock` requests (see
// packages/adapters/src/solana-rpc.mjs for that transport's request/error style) and owns
// proving the two sources are operationally independent.
//
// Scope (see product/SOLANA_CUSTODY_CURRENT_BALANCE_OBSERVATION_DRAFT.md): this produces a
// *current-observation* evidence value, never a historical-balance reconstruction.
// `minContextSlot` is a lower bound on a node's context, not an exact historical-state selector,
// so this module never accepts one as if it pinned a specific past slot.
//
// This module never selects a chain/asset identity for the caller (no `solana-mainnet`, no Relay
// `792703809` literal anywhere below): the returned observation is bound only to the caller-supplied
// canonical `{chainId, assetId, decimals}` after this module has independently verified the two
// sources agree with each other and with the caller-supplied expected mint/owner/tokenProgram.

export class SolanaCustodyObservationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = this.constructor.name;
    Object.assign(this, details);
  }
}

function invariant(condition, message, details) {
  if (!condition) throw new SolanaCustodyObservationError(message, details);
}

const canonicalUnsignedInteger = /^(0|[1-9][0-9]*)$/;

function canonicalInteger(value, label) {
  invariant(typeof value === 'string' && canonicalUnsignedInteger.test(value), `${label} must be a canonical unsigned integer string`, { value });
  return value;
}

function nonEmptyString(value, label) {
  invariant(typeof value === 'string' && value.length > 0, `${label} must be a non-empty string`, { value });
  return value;
}

function requireFinalizedSide(side, label) {
  invariant(side !== null && typeof side === 'object' && !Array.isArray(side), `${label} read side is required`, { side });
  invariant(side.commitment === 'finalized', `${label} read side must be at finalized commitment`, { commitment: side.commitment });

  const context = side.context;
  invariant(context !== null && typeof context === 'object', `${label} read side is missing a context`, { side });
  invariant(Number.isSafeInteger(context.slot) && context.slot >= 0, `${label} read side context.slot must be a non-negative safe integer`, { slot: context?.slot });

  const tokenAccount = side.tokenAccount;
  invariant(tokenAccount !== null && typeof tokenAccount === 'object', `${label} read side is missing tokenAccount`, { side });
  nonEmptyString(tokenAccount.address, `${label} tokenAccount.address`);
  nonEmptyString(tokenAccount.tokenProgram, `${label} tokenAccount.tokenProgram`);
  nonEmptyString(tokenAccount.owner, `${label} tokenAccount.owner`);
  nonEmptyString(tokenAccount.mint, `${label} tokenAccount.mint`);
  canonicalInteger(tokenAccount.amountAtomic, `${label} tokenAccount.amountAtomic`);
  invariant(Number.isInteger(tokenAccount.decimals) && tokenAccount.decimals >= 0 && tokenAccount.decimals <= 255, `${label} tokenAccount.decimals must be a uint8`, { decimals: tokenAccount.decimals });

  const block = side.block;
  invariant(block !== null && typeof block === 'object', `${label} read side is missing block`, { side });
  nonEmptyString(block.blockhash, `${label} block.blockhash`);
  invariant(block.blockTime === null || Number.isSafeInteger(block.blockTime), `${label} block.blockTime must be null or a safe integer`, { blockTime: block.blockTime });

  if (side.genesisHash !== undefined) nonEmptyString(side.genesisHash, `${label} genesisHash`);

  return side;
}

/**
 * Validates that two independently read finalized-commitment sides agree on context slot, block
 * identity, and token-account contents, that both agree with the caller-supplied expected mint,
 * owner, and token program, and — only after all of that strict equality — binds the result to the
 * caller-supplied canonical `{chainId, assetId, decimals}`.
 *
 * Rejects (never silently coerces): a null/malformed side, a non-finalized commitment, a
 * mismatched context.slot or blockhash, a null block (block not yet available), a mismatched
 * token-account address, any other token-account field mismatch between the two sides or against
 * the expected mint/owner/tokenProgram/decimals,
 * a decimals mismatch against the canonical identity, and — when `expectedGenesisHash` is supplied
 * — either side's genesis hash disagreeing with it or with the other side.
 *
 * `blockTime` is never invented: a `null` on both sides is preserved as `timestampUnixSeconds: null`
 * rather than replaced with a wall-clock or synthesized value.
 */
export function combineFinalizedBalanceObservation(sideA, sideB, {
  chainId,
  assetId,
  decimals,
  mint,
  owner,
  tokenProgramId,
  expectedGenesisHash,
} = {}) {
  nonEmptyString(chainId, 'chainId');
  nonEmptyString(assetId, 'assetId');
  invariant(Number.isInteger(decimals) && decimals >= 0 && decimals <= 255, 'decimals must be a uint8', { decimals });
  nonEmptyString(mint, 'mint');
  nonEmptyString(owner, 'owner');
  nonEmptyString(tokenProgramId, 'tokenProgramId');

  const a = requireFinalizedSide(sideA, 'first');
  const b = requireFinalizedSide(sideB, 'second');

  invariant(a.context.slot === b.context.slot, 'the two read sides do not share one finalized context slot', { slotA: a.context.slot, slotB: b.context.slot });
  invariant(a.block.blockhash === b.block.blockhash, 'the two read sides do not share one finalized block hash', { blockhashA: a.block.blockhash, blockhashB: b.block.blockhash });
  invariant(a.block.blockTime === b.block.blockTime, 'the two read sides disagree on block time for the same block hash', { blockTimeA: a.block.blockTime, blockTimeB: b.block.blockTime });

  if (expectedGenesisHash !== undefined) {
    nonEmptyString(expectedGenesisHash, 'expectedGenesisHash');
    invariant(a.genesisHash === expectedGenesisHash && b.genesisHash === expectedGenesisHash, 'the two read sides do not both prove the expected genesis hash', {
      expectedGenesisHash, genesisHashA: a.genesisHash, genesisHashB: b.genesisHash,
    });
  }

  for (const [side, label] of [[a, 'first'], [b, 'second']]) {
    invariant(side.tokenAccount.mint === mint, `${label} read side mint does not match the expected mint`, { expected: mint, actual: side.tokenAccount.mint });
    invariant(side.tokenAccount.owner === owner, `${label} read side owner does not match the expected owner`, { expected: owner, actual: side.tokenAccount.owner });
    invariant(side.tokenAccount.tokenProgram === tokenProgramId, `${label} read side token program does not match the expected token program`, { expected: tokenProgramId, actual: side.tokenAccount.tokenProgram });
    invariant(side.tokenAccount.decimals === decimals, `${label} read side decimals do not match the canonical decimals`, { expected: decimals, actual: side.tokenAccount.decimals });
  }
  invariant(a.tokenAccount.amountAtomic === b.tokenAccount.amountAtomic, 'the two read sides disagree on the token account amount', {
    amountAtomicA: a.tokenAccount.amountAtomic, amountAtomicB: b.tokenAccount.amountAtomic,
  });
  invariant(a.tokenAccount.address === b.tokenAccount.address, 'the two read sides disagree on the token account address', {
    addressA: a.tokenAccount.address, addressB: b.tokenAccount.address,
  });

  return Object.freeze({
    account: a.tokenAccount.address,
    balance: Object.freeze({
      chainId,
      assetId,
      decimals,
      amountAtomic: a.tokenAccount.amountAtomic,
    }),
    finality: Object.freeze({
      height: String(a.context.slot),
      hash: a.block.blockhash,
      timestampUnixSeconds: a.block.blockTime === null ? null : String(a.block.blockTime),
    }),
  });
}

/**
 * Runs a caller-supplied `readRound(attempt)` up to `maxAttempts` bounded times, accepting the
 * first round whose two sides pass `combineFinalizedBalanceObservation`. `readRound` is the only
 * place I/O happens; this function never calls `fetch` or any RPC client itself; a test can supply
 * a plain function that returns fixture sides synchronously or asynchronously. Retry is bounded
 * and never open-ended: after `maxAttempts` failed rounds this throws instead of returning a
 * partially validated result.
 */
export async function observeFinalizedBalanceWithRetry(readRound, request, { maxAttempts = 3 } = {}) {
  invariant(typeof readRound === 'function', 'readRound must be a function');
  invariant(Number.isInteger(maxAttempts) && maxAttempts >= 1, 'maxAttempts must be a positive integer', { maxAttempts });

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { sideA, sideB } = await readRound(attempt);
    try {
      return combineFinalizedBalanceObservation(sideA, sideB, request);
    } catch (error) {
      lastError = error;
    }
  }
  throw new SolanaCustodyObservationError(`finalized balance observation did not agree after ${maxAttempts} attempt(s)`, { cause: lastError, maxAttempts });
}
