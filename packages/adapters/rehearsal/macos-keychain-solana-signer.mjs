import { PublicKey } from '@solana/web3.js';

import {
  decodeProviderTransaction,
  evaluate,
  revalidateSignedMessage,
} from '../src/signing/transaction-policy.mjs';

const DEFAULT_TIMEOUT_MS = 10_000;

export class RehearsalSignerError extends Error {}

function fail(message) {
  throw new RehearsalSignerError(message);
}

function timeout(value) {
  if (!Number.isSafeInteger(value) || value <= 0) fail('timeoutMs must be a positive safe integer');
  return value;
}

function expectedPublicKey(value) {
  if (typeof value !== 'string' || value.length === 0) fail('rehearsal signer requires an expected Solana account');
  try {
    return new PublicKey(value).toBase58();
  } catch {
    fail('rehearsal signer expectedAccount must be a valid Solana public key');
  }
}

function requestBase64(request) {
  if (typeof request === 'string' && request.length > 0) return request;
  if (request && request.encoding === 'base64' && typeof request.data === 'string' && request.data.length > 0) return request.data;
  fail('rehearsal Solana signer expects a non-empty base64 transaction string');
}

function policyDecodeInput(transactionBase64, options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    fail('rehearsal Solana signer requires transactionDecodeOptions with its explicit transaction policy');
  }
  if (options.family !== undefined && options.family !== 'solana') {
    fail('rehearsal Solana signer transactionDecodeOptions.family must be solana');
  }
  if (typeof options.blockhashContextResolver !== 'function') {
    fail('rehearsal Solana signer requires a blockhashContextResolver');
  }
  if (typeof options.currentBlockHeightResolver !== 'function') {
    fail('rehearsal Solana signer requires a currentBlockHeightResolver');
  }
  return Object.freeze({ ...options, family: 'solana', transaction: transactionBase64 });
}

function externalResult(result, operation) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    fail(`external rehearsal signer produced no ${operation} result`);
  }
  return result;
}

/**
 * Constructs the collector rehearsal signer around an injected external signing boundary. The
 * boundary receives only public account metadata, operation names, and serialized transactions;
 * it never receives a raw credential and this module never reconstructs a Keypair. An operator
 * supplies the external service or tool integration through `externalSigner`.
 */
export function createSignerClient(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('rehearsal signer options must be an object');
  if (Object.hasOwn(options, 'readSecret')) fail('rehearsal signer does not accept readSecret in the parent process');
  if (typeof options.externalSigner !== 'function') {
    fail('rehearsal signer requires an external secret-free signer');
  }
  const expectedAccount = expectedPublicKey(options.expectedAccount ?? process.env.HOOKEMON_SOLANA_ACCOUNT);
  const service = options.service ?? 'hookemon-rehearsal';
  const account = options.account ?? 'operator-solana';
  if (typeof service !== 'string' || service.length === 0 || typeof account !== 'string' || account.length === 0) {
    fail('rehearsal signer service and account must be non-empty strings');
  }
  const timeoutMs = timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const { externalSigner, transactionPolicy, transactionDecodeOptions } = options;

  async function invoke(operation, payload = {}) {
    let result;
    try {
      result = await externalSigner(Object.freeze({ operation, expectedAccount, service, account, timeoutMs, ...payload }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      fail(`external rehearsal signer ${operation} failed: ${message}`);
    }
    return externalResult(result, operation);
  }

  const solana = Object.freeze({
    async probe() {
      const result = await invoke('probe');
      if (result.ready !== true) fail('external rehearsal signer did not confirm readiness');
      return { ready: true };
    },
    async sign(request) {
      if (transactionPolicy === undefined) {
        fail('rehearsal Solana signer requires an explicit transaction policy before signing');
      }
      const transactionBase64 = requestBase64(request);
      const input = policyDecodeInput(transactionBase64, transactionDecodeOptions);
      const approved = await decodeProviderTransaction(input);
      evaluate(transactionPolicy, approved);
      const result = await invoke('sign', { transactionBase64 });
      if (typeof result.signedTxBase64 !== 'string' || result.signedTxBase64.length === 0) {
        fail('external rehearsal signer did not return signedTxBase64');
      }
      const redecoded = await revalidateSignedMessage({ signedTxBase64: result.signedTxBase64 }, approved, input);
      evaluate(transactionPolicy, redecoded);
      return Object.freeze({ signedTxBase64: result.signedTxBase64 });
    },
    broadcast() {
      fail('external rehearsal signer does not broadcast; use solana-rpc.mjs');
    },
  });
  return Object.freeze({
    evm: null,
    solana,
    operationsTrigger: null,
    distributionSigner: null,
  });
}
