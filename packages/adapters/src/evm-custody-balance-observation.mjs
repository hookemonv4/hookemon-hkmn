// Dedicated canonical EVM USDG `CustodyBalanceObservationV1` producer (architecture/interfaces.json
// revision 67, owner-approved; `custodyLedger.verifiedCurrentBalance`'s EVM row -- the sibling of
// the pure `solana-custody-balance-observation.mjs` combiner). This module is not a pure combiner:
// it owns the actual public/archive reads through injected clients, reusing the exact
// public-finalized-head -> distinct-archive-`readErc20BalanceAtBlock`-at-that-height/hash ->
// same-height-public-recheck discipline private to
// packages/adapters/src/app/payout-availability.mjs#reloadFinalizedOperationsUsdgBalance, without
// calling into or modifying that file. No bindings/index.json entry exists for this interface; a
// non-null output here is evidence-construction only, never a live production binding or readiness
// proof.
//
// The trusted identity is pinned once at construction, not accepted per read: `identity` must
// already be the exact canonical custody-ledger row identity (CAIP-2 chain, CAIP-19 erc20 asset,
// six decimals, a raw EVM Operations address), independently validated and frozen before the
// zero-argument reader is ever returned. This module never selects that identity from RPC output
// and never derives it from a raw chain id or a raw un-wrapped ERC20 address.
import { USDG_PAYOUT_CHAIN_ID, USDG_PAYOUT_DECIMALS } from '../../runner/src/distribution/payout-plan.mjs';
import { readBlockByNumber, readFinalizedBlock } from './robinhood-rpc.mjs';

export const EVM_CUSTODY_BALANCE_OBSERVATION_SCHEMA = 'hookemon.custody-balance-observation.v1';

const CANONICAL_CHAIN_ID = `eip155:${USDG_PAYOUT_CHAIN_ID}`;
const RAW_ADDRESS = /^0x[0-9a-f]{40}$/;
const IDENTITY_FIELDS = ['chainId', 'assetId', 'decimals', 'account'];

export class EvmCustodyBalanceObservationError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = this.constructor.name;
    Object.assign(this, details);
  }
}

function refuse(message, details) {
  throw new EvmCustodyBalanceObservationError(`evm-custody-balance-observation reader refuses: ${message}`, details);
}

function assertRawAddress(value, label) {
  if (typeof value !== 'string' || !RAW_ADDRESS.test(value)) refuse(`${label} must be a canonical lowercase EVM address`);
  return value;
}

/**
 * Validates and freezes the exact canonical `CustodyBalanceObservationV1.balance` identity plus
 * the Operations account this reader is pinned to. `chainId` must be the canonical CAIP-2 EVM
 * chain identifier; `assetId` must use the CAIP-19 erc20 prefix built from that exact `chainId`
 * (never a separately hardcoded prefix, so a chain/asset splice -- a `chainId` and an `assetId`
 * naming two different chains -- is refused here, not silently reconciled); the ERC20 address is
 * parsed only out of that verified prefix, never accepted as a bare/raw address field.
 */
function assertIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('a canonical identity object is required for finalized balance evidence');
  if (Object.keys(value).length !== IDENTITY_FIELDS.length || !IDENTITY_FIELDS.every(field => Object.hasOwn(value, field))) {
    refuse('identity must use its exact canonical schema');
  }
  if (value.chainId !== CANONICAL_CHAIN_ID) {
    refuse(`identity chainId must be the canonical CAIP-2 identifier ${CANONICAL_CHAIN_ID}`);
  }
  const assetPrefix = `${value.chainId}/erc20:`;
  if (typeof value.assetId !== 'string' || !value.assetId.startsWith(assetPrefix)) {
    refuse(`identity assetId must use the canonical erc20 CAIP-19 prefix ${assetPrefix}`);
  }
  const tokenAddress = value.assetId.slice(assetPrefix.length);
  if (!RAW_ADDRESS.test(tokenAddress)) refuse('identity assetId must encode a canonical lowercase EVM address');
  if (value.decimals !== USDG_PAYOUT_DECIMALS) refuse(`identity decimals must equal ${USDG_PAYOUT_DECIMALS}`);
  const account = assertRawAddress(value.account, 'identity account');
  return Object.freeze({ chainId: value.chainId, assetId: value.assetId, decimals: value.decimals, account, tokenAddress });
}

/**
 * Builds the owned EVM USDG `CustodyBalanceObservationV1` reader, pinned for its lifetime to one
 * validated, frozen `identity` (never a per-read candidate -- mutating the object passed in after
 * construction has no effect on the pinned copy). `publicClient` and `archiveClient` must be
 * distinct: the public client only ever proves block identity (a finalized head, then a
 * same-height recheck), the archive client is the sole source of historical ERC20 state. Neither
 * client is trusted alone -- a mismatch between them at any step is a refusal.
 */
export function createEvmCustodyBalanceObservationReader({ publicClient, archiveClient, identity }) {
  if (!publicClient) refuse('a public Robinhood RPC client is required for finalized balance evidence');
  if (archiveClient === publicClient || !archiveClient || typeof archiveClient.readErc20BalanceAtBlock !== 'function') {
    refuse('a distinct archive-capable historical evidence client is required for finalized balance evidence');
  }
  const pinned = assertIdentity(identity);
  return async function readEvmCustodyBalanceObservation() {
    const finalized = await readFinalizedBlock(publicClient);
    if (typeof finalized.number !== 'bigint' || finalized.number < 0n) {
      refuse('the public finalized block returned an invalid height');
    }
    if (typeof finalized.timestamp !== 'bigint' || finalized.timestamp < 0n) {
      refuse('the public finalized block returned an invalid timestamp');
    }
    const observed = await archiveClient.readErc20BalanceAtBlock({
      token: pinned.tokenAddress,
      account: pinned.account,
      blockNumber: finalized.number,
      blockHash: finalized.hash,
    });
    if (!observed || typeof observed.value !== 'bigint' || observed.value < 0n) {
      refuse('the archive USDG balance read returned a malformed amount');
    }
    if (observed.blockNumber !== finalized.number || String(observed.blockHash).toLowerCase() !== finalized.hash.toLowerCase()) {
      refuse('the archive USDG balance read did not bind the requested finalized block');
    }
    const recheck = await readBlockByNumber(publicClient, finalized.number);
    if (String(recheck.hash).toLowerCase() !== finalized.hash.toLowerCase()) {
      refuse('the public finalized block hash changed after the archive read');
    }
    return Object.freeze({
      schema: EVM_CUSTODY_BALANCE_OBSERVATION_SCHEMA,
      account: pinned.account,
      balance: Object.freeze({
        chainId: pinned.chainId,
        assetId: pinned.assetId,
        decimals: pinned.decimals,
        amountAtomic: observed.value.toString(),
      }),
      finality: Object.freeze({
        height: finalized.number.toString(),
        hash: finalized.hash,
        timestampUnixSeconds: finalized.timestamp.toString(),
      }),
    });
  };
}
