// Dedicated canonical EVM USDG `CustodyBalanceObservationV1` producer (architecture/interfaces.json
// revision 67, custodyLedger.verifiedCurrentBalance's EVM row -- the sibling of the pure
// `solana-custody-balance-observation.mjs` combiner). This module is not a pure combiner: it owns
// the actual public/archive reads through injected clients, reusing the exact public-finalized-head
// -> distinct-archive-`readErc20BalanceAtBlock`-at-that-height/hash -> same-height-public-recheck
// discipline private to
// packages/adapters/src/app/payout-availability.mjs#reloadFinalizedOperationsUsdgBalance, without
// calling into or modifying that file.
//
// This module never selects a chain/asset/account identity itself -- every identity field is
// caller-pinned and only checked against the configured canonical EVM USDG identity
// (USDG_PAYOUT_CHAIN_ID/USDG_PAYOUT_DECIMALS). It never values obligations, never writes a
// repository, and never implies a live production binding: see architecture/interfaces.json's
// custodyLedger entry for the (still unapproved) liveBindingStatus this producer only feeds.
import { USDG_PAYOUT_CHAIN_ID, USDG_PAYOUT_DECIMALS } from '../../runner/src/distribution/payout-plan.mjs';
import { readBlockByNumber, readFinalizedBlock } from './robinhood-rpc.mjs';

export const EVM_CUSTODY_BALANCE_OBSERVATION_SCHEMA = 'hookemon.custody-balance-observation.v1';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const REQUEST_FIELDS = ['chainId', 'assetId', 'decimals', 'account'];

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

function assertAddress(value, label) {
  if (typeof value !== 'string' || !ADDRESS.test(value)) refuse(`${label} must be an EVM address`);
  return value.toLowerCase();
}

function assertIdentity(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) refuse('request must be an object');
  if (Object.keys(value).length !== REQUEST_FIELDS.length || !REQUEST_FIELDS.every(field => Object.hasOwn(value, field))) {
    refuse('request must use its exact schema');
  }
  if (!(value.chainId === USDG_PAYOUT_CHAIN_ID || value.chainId === String(USDG_PAYOUT_CHAIN_ID))) {
    refuse(`request chainId must identify chain ${USDG_PAYOUT_CHAIN_ID}`);
  }
  if (value.decimals !== USDG_PAYOUT_DECIMALS) refuse(`request decimals must equal ${USDG_PAYOUT_DECIMALS}`);
  const assetId = assertAddress(value.assetId, 'request assetId');
  const account = assertAddress(value.account, 'request account');
  return { chainId: value.chainId, assetId, decimals: value.decimals, account };
}

/**
 * Builds the owned EVM USDG `CustodyBalanceObservationV1` reader. `publicClient` and
 * `archiveClient` must be distinct: the public client only ever proves block identity (a finalized
 * head, then a same-height recheck), the archive client is the sole source of historical ERC20
 * state. Neither client is trusted alone -- a mismatch between them at any step is a refusal.
 */
export function createEvmCustodyBalanceObservationReader({ publicClient, archiveClient }) {
  if (!publicClient) refuse('a public Robinhood RPC client is required for finalized balance evidence');
  if (archiveClient === publicClient || !archiveClient || typeof archiveClient.readErc20BalanceAtBlock !== 'function') {
    refuse('a distinct archive-capable historical evidence client is required for finalized balance evidence');
  }
  return async function readEvmCustodyBalanceObservation(requestValue) {
    const request = assertIdentity(requestValue);
    const finalized = await readFinalizedBlock(publicClient);
    if (typeof finalized.number !== 'bigint' || finalized.number < 0n) {
      refuse('the public finalized block returned an invalid height');
    }
    if (typeof finalized.timestamp !== 'bigint' || finalized.timestamp < 0n) {
      refuse('the public finalized block returned an invalid timestamp');
    }
    const observed = await archiveClient.readErc20BalanceAtBlock({
      token: request.assetId,
      account: request.account,
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
      account: request.account,
      balance: Object.freeze({
        chainId: request.chainId,
        assetId: request.assetId,
        decimals: request.decimals,
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
