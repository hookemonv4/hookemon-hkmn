// Tests for src/solana-rpc.mjs.
//
// RPC-touching functions are exercised through an injected `fetchImpl` (never a real network
// call), mirroring test/relay-client.test.mjs's house style — every mock asserts the exact JSON-RPC
// method/params sent, not just the parsed return value.
//
// Construction functions (`deriveAssociatedTokenAddress`, `buildTransferCheckedInstruction`,
// `buildUnsignedTransaction`) touch no network at all; PROGRAM_ID constants were independently
// verified live on 2026-09-02 (see the header comment below and solana-rpc.mjs's own header) via
// a direct `getAccountInfo` RPC call confirming each is a real, executable on-chain program (not
// merely well-formed base58) before this suite was written.
import assert from 'node:assert/strict';
import test from 'node:test';

import { Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';

import {
  SOLANA_CONSTANTS,
  CIRCLE_USD_MINT,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  createSolanaRpcClient,
  readSolBalance,
  readTokenAccountBalance,
  readLatestBlockhash,
  readBlockHeight,
  readBlockhashValidity,
  readUsableLatestBlockhash,
  getTransaction,
  getFinalizedTransaction,
  getTransactionTokenBalanceChanges,
  getFinalizedTokenBalanceChanges,
  isProcessRpcRelayDestinationObservation,
  readFinalizedRelayDestinationObservation,
  discoverFinalizedRelayDestinationObservation,
  readFinalizedRelayDestinationAttribution,
  readFinalizedRelaySourceDebit,
  readSignatureStatus,
  readFinalizedSignatureStatus,
  readAssociatedTokenAccount,
  deriveAssociatedTokenAddress,
  buildPriorityFeeInstructions,
  buildTransferCheckedInstruction,
  buildRelayLegacyTransaction,
  buildUnsignedTransaction,
  signedSolanaTransactionSignature,
  submitSignedTransaction,
  SolanaAdapterError,
  SolanaNetworkError,
  SolanaRpcError,
  SolanaMalformedResponseError,
} from '../src/solana-rpc.mjs';

const OWNER = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const SIGNATURE = '5'.repeat(88);

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

function mockClient(handler, opts = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    calls.push({ url: String(url), method: body.method, params: body.params, id: body.id, jsonrpc: body.jsonrpc });
    return handler(body);
  };
  return { client: createSolanaRpcClient({ fetchImpl, ...opts }), calls };
}

// ---------------------------------------------------------------------------
// Well-known program/mint constants — independently verified live (see module header)
// ---------------------------------------------------------------------------

test('SOLANA_CONSTANTS matches the live-verified mainnet identities (2026-09-02)', () => {
  assert.equal(SOLANA_CONSTANTS.CIRCLE_USD_MINT, 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  assert.equal(SOLANA_CONSTANTS.CIRCLE_USD_DECIMALS, 6);
  assert.equal(SOLANA_CONSTANTS.TOKEN_PROGRAM_ID, 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  assert.equal(SOLANA_CONSTANTS.ASSOCIATED_TOKEN_PROGRAM_ID, 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  assert.equal(SOLANA_CONSTANTS.SOLANA_RELAY_CHAIN_ID, 792703809);
});

test('every well-known program/mint constant is a valid 32-byte Solana public key', () => {
  for (const value of [CIRCLE_USD_MINT, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SYSTEM_PROGRAM_ID]) {
    assert.doesNotThrow(() => new PublicKey(value), `${value} is not a valid public key`);
  }
});

test('SYSTEM_PROGRAM_ID is exactly 32 zero bytes (a regression guard: an earlier draft of this '
  + 'constant was mistyped one character too long and silently failed transaction serialization)', () => {
  const key = new PublicKey(SYSTEM_PROGRAM_ID);
  assert.ok(key.toBuffer().every((byte) => byte === 0));
  assert.equal(key.toBuffer().length, 32);
});

// ---------------------------------------------------------------------------
// Reads — exact JSON-RPC method/params
// ---------------------------------------------------------------------------

test('readSolBalance calls getBalance with the exact base58 pubkey and commitment', async () => {
  const { client, calls } = mockClient(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: 123 } }));
  const balance = await readSolBalance(client, OWNER);
  assert.equal(balance, 123n);
  assert.equal(calls[0].method, 'getBalance');
  assert.deepEqual(calls[0].params, [OWNER, { commitment: 'finalized' }]);
});

test('readTokenAccountBalance calls getTokenAccountBalance and returns a bigint amount', async () => {
  const { client, calls } = mockClient(() => jsonResponse({
    jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: { amount: '25000000', decimals: 6, uiAmountString: '25' } },
  }));
  const result = await readTokenAccountBalance(client, OWNER);
  assert.equal(result.amount, 25000000n);
  assert.equal(result.decimals, 6);
  assert.equal(calls[0].method, 'getTokenAccountBalance');
  assert.deepEqual(calls[0].params, [OWNER, { commitment: 'finalized' }]);
});

test('readLatestBlockhash calls getLatestBlockhash and returns blockhash + lastValidBlockHeight', async () => {
  const { client, calls } = mockClient(() => jsonResponse({
    jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: { blockhash: 'abc123', lastValidBlockHeight: 999 } },
  }));
  const result = await readLatestBlockhash(client);
  assert.equal(result.blockhash, 'abc123');
  assert.equal(result.lastValidBlockHeight, 999);
  assert.equal(calls[0].method, 'getLatestBlockhash');
});

test('readBlockHeight and readBlockhashValidity use their exact RPC methods', async () => {
  const { client, calls } = mockClient(body => {
    if (body.method === 'getBlockHeight') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: 987 });
    if (body.method === 'isBlockhashValid') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { context: { slot: 1 }, value: true } });
    throw new Error(`unexpected RPC method ${body.method}`);
  });

  assert.equal(await readBlockHeight(client), 987n);
  assert.equal(await readBlockhashValidity(client, SYSTEM_PROGRAM_ID), true);
  assert.deepEqual(calls.map(call => [call.method, call.params]), [
    ['getBlockHeight', [{ commitment: 'finalized' }]],
    ['isBlockhashValid', [SYSTEM_PROGRAM_ID, { commitment: 'finalized' }]],
  ]);
});

test('readUsableLatestBlockhash refuses an already-invalid blockhash before a signer can see it', async () => {
  const { client, calls } = mockClient(body => {
    if (body.method === 'getLatestBlockhash') {
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { value: { blockhash: SYSTEM_PROGRAM_ID, lastValidBlockHeight: 999 } } });
    }
    if (body.method === 'isBlockhashValid') return jsonResponse({ jsonrpc: '2.0', id: body.id, result: { value: false } });
    throw new Error(`unexpected RPC method ${body.method}`);
  });

  await assert.rejects(() => readUsableLatestBlockhash(client), SolanaAdapterError);
  assert.deepEqual(calls.map(call => call.method), ['getLatestBlockhash', 'isBlockhashValid']);
});

test('getFinalizedTransaction always pins commitment to "finalized" regardless of the client default', async () => {
  const { client, calls } = mockClient(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: null }), { commitment: 'confirmed' });
  await getFinalizedTransaction(client, SIGNATURE);
  assert.equal(calls[0].method, 'getTransaction');
  assert.deepEqual(calls[0].params, [SIGNATURE, { commitment: 'finalized', maxSupportedTransactionVersion: 0, encoding: 'json' }]);
});

test('getTransaction rejects an empty signature before any RPC call', async () => {
  const { client } = mockClient(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: null }));
  await assert.rejects(() => getTransaction(client, ''), SolanaAdapterError);
});

// --- getTransactionTokenBalanceChanges (WP-36) ------------------------------------------------

const OPERATOR = 'HWPRgtDGpBm8mByTGS57BWCsijMo53qPPSbskWDukfTc';
const PACK_MINT = 'H9ZXYkudxn6qhyp5S25jm5SrA8Vnu8naSfvymm9TptLA';
const CARD_MINT_A = 'GfFAJnHnSgP7C2FQZLz6ogpdTV6Y7259f83qFFm9wxKm';
const CARD_MINT_B = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const PACK_TOKEN_ACCOUNT = 'CardTokenAccount11111111111111111111111111';
const CARD_TOKEN_ACCOUNT = 'CardTokenAccount22222222222222222222222222';

function jsonParsedTransactionFixture({ postTokenBalances, preTokenBalances, accountKeys }) {
  return jsonResponse({
    jsonrpc: '2.0',
    id: 1,
    result: {
      slot: 100,
      transaction: {
        message: {
          accountKeys: accountKeys ?? [
            { pubkey: OPERATOR, signer: true, writable: true, source: 'transaction' },
            { pubkey: PACK_TOKEN_ACCOUNT, signer: false, writable: true, source: 'transaction' },
            { pubkey: CARD_TOKEN_ACCOUNT, signer: false, writable: true, source: 'transaction' },
          ],
        },
      },
      meta: {
        preTokenBalances: preTokenBalances ?? [
          { accountIndex: 1, mint: PACK_MINT, owner: OPERATOR, uiTokenAmount: { amount: '1', decimals: 0, uiAmountString: '1' } },
        ],
        postTokenBalances: postTokenBalances ?? [
          { accountIndex: 1, mint: PACK_MINT, owner: OPERATOR, uiTokenAmount: { amount: '0', decimals: 0, uiAmountString: '0' } },
          { accountIndex: 2, mint: CARD_MINT_A, owner: OPERATOR, uiTokenAmount: { amount: '1', decimals: 0, uiAmountString: '1' } },
        ],
      },
    },
  });
}

test('getTransactionTokenBalanceChanges calls getTransaction with jsonParsed encoding at the client\'s default (finalized) commitment', async () => {
  const { client, calls } = mockClient(() => jsonParsedTransactionFixture({}));
  await getTransactionTokenBalanceChanges(client, SIGNATURE);
  assert.equal(calls[0].method, 'getTransaction');
  assert.deepEqual(calls[0].params, [SIGNATURE, { commitment: 'finalized', maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]);
});

test('getFinalizedTokenBalanceChanges pins the observed delta to finalized commitment', async () => {
  const { client, calls } = mockClient(() => jsonParsedTransactionFixture({}));
  await getFinalizedTokenBalanceChanges(client, SIGNATURE);
  assert.deepEqual(calls[0].params, [SIGNATURE, { commitment: 'finalized', maxSupportedTransactionVersion: 0, encoding: 'jsonParsed' }]);
});

test('readFinalizedRelayDestinationAttribution requires this process to observe one in-window memo-bound destination credit', async () => {
  const relayRequestId = 'relay-return-request-1';
  const { client, calls } = mockClient(body => {
    assert.equal(body.method, 'getTransaction');
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        slot: 42,
        blockTime: 1_700_000_010,
        transaction: {
          message: {
            accountKeys: [{ pubkey: PACK_TOKEN_ACCOUNT, signer: false, writable: true }],
            instructions: [{ program: 'spl-memo', parsed: relayRequestId }],
          },
        },
        meta: {
          err: null,
          preTokenBalances: [{
            accountIndex: 0,
            mint: CIRCLE_USD_MINT,
            owner: OWNER,
            uiTokenAmount: { amount: '100', decimals: 6, uiAmountString: '0.0001' },
          }],
          postTokenBalances: [{
            accountIndex: 0,
            mint: CIRCLE_USD_MINT,
            owner: OWNER,
            uiTokenAmount: { amount: '125', decimals: 6, uiAmountString: '0.000125' },
          }],
        },
      },
    });
  });

  const observation = await readFinalizedRelayDestinationAttribution(client, {
    signature: SIGNATURE,
    owner: OWNER,
    mint: CIRCLE_USD_MINT,
    amountAtomic: '25',
    relayRequestId,
    earliestTimestampUnixSeconds: '1700000000',
    latestTimestampUnixSeconds: '1700000020',
  });

  assert.deepEqual(observation, {
    transactionHash: SIGNATURE,
    mint: CIRCLE_USD_MINT,
    netDeltaAtomic: '25',
    finality: { height: '42', hash: SIGNATURE, timestampUnixSeconds: '1700000010' },
    attribution: {
      schema: 'hookemon.relay-attribution.v1',
      observer: 'process-rpc',
      requestId: relayRequestId,
      memo: relayRequestId,
      observedAmountAtomic: '25',
    },
  });
  assert.equal(isProcessRpcRelayDestinationObservation(observation, { owner: OWNER, relayRequestId }), true);
  assert.deepEqual(calls[0].params, [SIGNATURE, {
    commitment: 'finalized',
    maxSupportedTransactionVersion: 0,
    encoding: 'jsonParsed',
  }]);
});

test('readFinalizedRelayDestinationObservation preserves a finalized memo-bound destination delta before settlement classification', async () => {
  const relayRequestId = 'relay-return-request-observation';
  const { client } = mockClient(body => {
    assert.equal(body.method, 'getTransaction');
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        slot: 44,
        blockTime: 1_700_000_040,
        transaction: {
          message: {
            accountKeys: [{ pubkey: PACK_TOKEN_ACCOUNT, signer: false, writable: true }],
            instructions: [{ program: 'spl-memo', parsed: relayRequestId }],
          },
        },
        meta: {
          err: null,
          preTokenBalances: [{
            accountIndex: 0,
            mint: TOKEN_PROGRAM_ID,
            owner: OWNER,
            uiTokenAmount: { amount: '100', decimals: 6, uiAmountString: '0.0001' },
          }],
          postTokenBalances: [{
            accountIndex: 0,
            mint: TOKEN_PROGRAM_ID,
            owner: OWNER,
            uiTokenAmount: { amount: '117', decimals: 6, uiAmountString: '0.000117' },
          }],
        },
      },
    });
  });

  assert.deepEqual(await readFinalizedRelayDestinationObservation(client, {
    signature: SIGNATURE,
    owner: OWNER,
    relayRequestId,
  }), {
    transactionHash: SIGNATURE,
    mint: TOKEN_PROGRAM_ID,
    netDeltaAtomic: '17',
    finality: { height: '44', hash: SIGNATURE, timestampUnixSeconds: '1700000040' },
    attribution: {
      schema: 'hookemon.relay-attribution.v1',
      observer: 'process-rpc',
      requestId: relayRequestId,
      memo: relayRequestId,
      observedAmountAtomic: '17',
    },
  });
});

test('discoverFinalizedRelayDestinationObservation scans a bounded finalized owner history and returns one memo-bound observation', async () => {
  const relayRequestId = 'relay-return-discovery';
  const unrelatedSignature = '6'.repeat(88);
  const matchedSignature = '7'.repeat(88);
  const { client, calls } = mockClient(body => {
    if (body.method === 'getSignaturesForAddress') {
      return jsonResponse({
        jsonrpc: '2.0',
        id: body.id,
        result: [
          { signature: unrelatedSignature, err: null },
          { signature: matchedSignature, err: null },
        ],
      });
    }
    assert.equal(body.method, 'getTransaction');
    const signature = body.params[0];
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        slot: signature === matchedSignature ? 46 : 45,
        blockTime: 1_700_000_060,
        transaction: {
          message: {
            accountKeys: [{ pubkey: PACK_TOKEN_ACCOUNT, signer: false, writable: true }],
            instructions: [{ program: 'spl-memo', parsed: signature === matchedSignature ? relayRequestId : 'different-request' }],
          },
        },
        meta: {
          err: null,
          preTokenBalances: [{
            accountIndex: 0,
            mint: CIRCLE_USD_MINT,
            owner: OWNER,
            uiTokenAmount: { amount: '100', decimals: 6, uiAmountString: '0.0001' },
          }],
          postTokenBalances: [{
            accountIndex: 0,
            mint: CIRCLE_USD_MINT,
            owner: OWNER,
            uiTokenAmount: { amount: signature === matchedSignature ? '119' : '100', decimals: 6, uiAmountString: '0.000119' },
          }],
        },
      },
    });
  });

  assert.deepEqual(await discoverFinalizedRelayDestinationObservation(client, {
    owner: OWNER,
    relayRequestId,
    maxSignatures: 2,
  }), {
    transactionHash: matchedSignature,
    mint: CIRCLE_USD_MINT,
    netDeltaAtomic: '19',
    finality: { height: '46', hash: matchedSignature, timestampUnixSeconds: '1700000060' },
    attribution: {
      schema: 'hookemon.relay-attribution.v1',
      observer: 'process-rpc',
      requestId: relayRequestId,
      memo: relayRequestId,
      observedAmountAtomic: '19',
    },
  });
  assert.deepEqual(calls[0].params, [OWNER, { commitment: 'finalized', limit: 2 }]);
});

test('discoverFinalizedRelayDestinationObservation rejects two finalized request-memo matches', async () => {
  const relayRequestId = 'relay-return-discovery-ambiguous';
  const firstSignature = '8'.repeat(88);
  const secondSignature = '9'.repeat(88);
  const { client } = mockClient(body => {
    if (body.method === 'getSignaturesForAddress') {
      return jsonResponse({ jsonrpc: '2.0', id: body.id, result: [{ signature: firstSignature, err: null }, { signature: secondSignature, err: null }] });
    }
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        slot: 47,
        blockTime: 1_700_000_061,
        transaction: {
          message: {
            accountKeys: [{ pubkey: PACK_TOKEN_ACCOUNT, signer: false, writable: true }],
            instructions: [{ program: 'spl-memo', parsed: relayRequestId }],
          },
        },
        meta: {
          err: null,
          preTokenBalances: [{ accountIndex: 0, mint: CIRCLE_USD_MINT, owner: OWNER, uiTokenAmount: { amount: '100', decimals: 6, uiAmountString: '0.0001' } }],
          postTokenBalances: [{ accountIndex: 0, mint: CIRCLE_USD_MINT, owner: OWNER, uiTokenAmount: { amount: '119', decimals: 6, uiAmountString: '0.000119' } }],
        },
      },
    });
  });

  await assert.rejects(
    () => discoverFinalizedRelayDestinationObservation(client, { owner: OWNER, relayRequestId, maxSignatures: 2 }),
    /ambiguous/,
  );
});

test('readFinalizedRelaySourceDebit requires one successful finalized source debit', async () => {
  const { client } = mockClient(body => {
    assert.equal(body.method, 'getTransaction');
    return jsonResponse({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        slot: 43,
        blockTime: 1_700_000_011,
        transaction: {
          message: {
            accountKeys: [{ pubkey: PACK_TOKEN_ACCOUNT, signer: false, writable: true }],
            instructions: [],
          },
        },
        meta: {
          err: null,
          preTokenBalances: [{
            accountIndex: 0,
            mint: CIRCLE_USD_MINT,
            owner: OWNER,
            uiTokenAmount: { amount: '125', decimals: 6, uiAmountString: '0.000125' },
          }],
          postTokenBalances: [{
            accountIndex: 0,
            mint: CIRCLE_USD_MINT,
            owner: OWNER,
            uiTokenAmount: { amount: '100', decimals: 6, uiAmountString: '0.0001' },
          }],
        },
      },
    });
  });

  assert.deepEqual(await readFinalizedRelaySourceDebit(client, {
    signature: SIGNATURE,
    owner: OWNER,
    mint: CIRCLE_USD_MINT,
    amountAtomic: '25',
  }), {
    transactionHash: SIGNATURE,
    debitedAmountAtomic: '25',
    finality: { height: '43', hash: SIGNATURE, timestampUnixSeconds: '1700000011' },
  });
});

test('signedSolanaTransactionSignature reads the signed wire transaction identity instead of hashing opaque bytes', () => {
  const signer = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_unused, index) => index + 1));
  const recipient = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_unused, index) => index + 33));
  const transaction = new Transaction({
    feePayer: signer.publicKey,
    recentBlockhash: '11111111111111111111111111111111',
  }).add(SystemProgram.transfer({ fromPubkey: signer.publicKey, toPubkey: recipient.publicKey, lamports: 1 }));
  transaction.sign(signer);

  const signedTxBase64 = transaction.serialize().toString('base64');
  assert.match(signedSolanaTransactionSignature(signedTxBase64), /^[1-9A-HJ-NP-Za-km-z]{87,88}$/);
});

test('getTransactionTokenBalanceChanges folds pre/post token balances per account index, filling in "0" for the side an account is absent from', async () => {
  const { client } = mockClient(() => jsonParsedTransactionFixture({}));
  const changes = await getTransactionTokenBalanceChanges(client, SIGNATURE);
  assert.deepEqual(changes, [
    { accountIndex: 1, mint: PACK_MINT, owner: OPERATOR, preAmount: '1', postAmount: '0', tokenAccount: PACK_TOKEN_ACCOUNT },
    { accountIndex: 2, mint: CARD_MINT_A, owner: OPERATOR, preAmount: '0', postAmount: '1', tokenAccount: CARD_TOKEN_ACCOUNT },
  ]);
});

test('getTransactionTokenBalanceChanges resolves the token account address from accountKeys, whether given as a plain string (legacy encoding leak) or a jsonParsed {pubkey} object', async () => {
  const { client } = mockClient(() => jsonParsedTransactionFixture({
    accountKeys: [OPERATOR, PACK_TOKEN_ACCOUNT, { pubkey: CARD_TOKEN_ACCOUNT, signer: false, writable: true }],
  }));
  const changes = await getTransactionTokenBalanceChanges(client, SIGNATURE);
  assert.equal(changes[0].tokenAccount, PACK_TOKEN_ACCOUNT);
  assert.equal(changes[1].tokenAccount, CARD_TOKEN_ACCOUNT);
});

test('getTransactionTokenBalanceChanges can report more than one 0->1 credit for the same owner (the caller decides which candidate to trust, or refuses on ambiguity)', async () => {
  const { client } = mockClient(() => jsonParsedTransactionFixture({
    accountKeys: [
      { pubkey: OPERATOR, signer: true, writable: true },
      { pubkey: PACK_TOKEN_ACCOUNT, signer: false, writable: true },
      { pubkey: CARD_TOKEN_ACCOUNT, signer: false, writable: true },
      { pubkey: 'AnotherCardTokenAccount111111111111111111', signer: false, writable: true },
    ],
    preTokenBalances: [
      { accountIndex: 1, mint: PACK_MINT, owner: OPERATOR, uiTokenAmount: { amount: '1', decimals: 0, uiAmountString: '1' } },
    ],
    postTokenBalances: [
      { accountIndex: 1, mint: PACK_MINT, owner: OPERATOR, uiTokenAmount: { amount: '0', decimals: 0, uiAmountString: '0' } },
      { accountIndex: 2, mint: CARD_MINT_A, owner: OPERATOR, uiTokenAmount: { amount: '1', decimals: 0, uiAmountString: '1' } },
      { accountIndex: 3, mint: CARD_MINT_B, owner: OPERATOR, uiTokenAmount: { amount: '1', decimals: 0, uiAmountString: '1' } },
    ],
  }));
  const changes = await getTransactionTokenBalanceChanges(client, SIGNATURE);
  const credited = changes.filter(entry => entry.owner === OPERATOR && entry.preAmount === '0' && entry.postAmount === '1');
  assert.equal(credited.length, 2, 'both zero-to-one credits must be reported — the caller decides ambiguity, not this generic RPC wrapper');
});

test('getTransactionTokenBalanceChanges throws SolanaMalformedResponseError when the result has no meta (e.g. an unfinalized/unknown signature)', async () => {
  const { client } = mockClient(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: null }));
  await assert.rejects(() => getTransactionTokenBalanceChanges(client, SIGNATURE), SolanaMalformedResponseError);
});

test('getTransactionTokenBalanceChanges throws SolanaMalformedResponseError when pre/post entries disagree on mint/owner for the same account index', async () => {
  const { client } = mockClient(() => jsonParsedTransactionFixture({
    preTokenBalances: [
      { accountIndex: 2, mint: CARD_MINT_A, owner: OPERATOR, uiTokenAmount: { amount: '1', decimals: 0, uiAmountString: '1' } },
    ],
    postTokenBalances: [
      { accountIndex: 2, mint: CARD_MINT_B, owner: OPERATOR, uiTokenAmount: { amount: '0', decimals: 0, uiAmountString: '0' } },
    ],
  }));
  await assert.rejects(() => getTransactionTokenBalanceChanges(client, SIGNATURE), SolanaMalformedResponseError);
});

test('readSignatureStatus calls getSignatureStatuses with searchTransactionHistory:true and returns the first status', async () => {
  const statusFixture = { slot: 1, confirmations: null, err: null, confirmationStatus: 'finalized' };
  const { client, calls } = mockClient(() => jsonResponse({
    jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: [statusFixture] },
  }));
  const result = await readSignatureStatus(client, SIGNATURE);
  assert.deepEqual(result, statusFixture);
  assert.deepEqual(calls[0].params, [[SIGNATURE], { searchTransactionHistory: true }]);
});

test('readSignatureStatus returns null (not undefined, not a throw) for an unknown signature', async () => {
  const { client } = mockClient(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: [null] } }));
  const result = await readSignatureStatus(client, SIGNATURE);
  assert.equal(result, null);
});

test('readFinalizedSignatureStatus returns null until the signature is finalized', async () => {
  const pending = mockClient(() => jsonResponse({
    jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: [{ err: null, confirmationStatus: 'confirmed' }] },
  }));
  assert.equal(await readFinalizedSignatureStatus(pending.client, SIGNATURE), null);

  const finalized = { err: null, confirmationStatus: 'finalized', slot: 10 };
  const settled = mockClient(() => jsonResponse({
    jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: [finalized] },
  }));
  assert.deepEqual(await readFinalizedSignatureStatus(settled.client, SIGNATURE), finalized);
});

test('readAssociatedTokenAccount confirms the derived account owner, mint, and token program', async () => {
  const expectedAddress = deriveAssociatedTokenAddress(OWNER, CIRCLE_USD_MINT).toBase58();
  const { client, calls } = mockClient(() => jsonResponse({
    jsonrpc: '2.0', id: 1,
    result: {
      value: {
        owner: TOKEN_PROGRAM_ID,
        data: {
          program: 'spl-token',
          parsed: {
            type: 'account',
            info: { mint: CIRCLE_USD_MINT, owner: OWNER, tokenAmount: { amount: '42', decimals: 6 } },
          },
        },
      },
    },
  }));

  assert.deepEqual(await readAssociatedTokenAccount(client, OWNER, CIRCLE_USD_MINT), {
    address: expectedAddress,
    exists: true,
    amount: 42n,
    decimals: 6,
  });
  assert.deepEqual(calls[0].params, [expectedAddress, { commitment: 'finalized', encoding: 'jsonParsed' }]);
});

test('readAssociatedTokenAccount reports a missing account without treating it as a valid token account', async () => {
  const { client } = mockClient(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: { value: null } }));
  const account = await readAssociatedTokenAccount(client, OWNER, CIRCLE_USD_MINT);
  assert.deepEqual(account, {
    address: deriveAssociatedTokenAddress(OWNER, CIRCLE_USD_MINT).toBase58(),
    exists: false,
    amount: null,
    decimals: null,
  });
});

// ---------------------------------------------------------------------------
// Error handling — every failure mode is a typed error, never a bare Error or a silent default
// ---------------------------------------------------------------------------

test('an RPC-level JSON-RPC error is surfaced as SolanaRpcError, never treated as a success', async () => {
  const { client } = mockClient(() => jsonResponse({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'Invalid params' } }));
  await assert.rejects(() => readSolBalance(client, OWNER), SolanaRpcError);
});

test('an HTTP error status is surfaced as SolanaRpcError', async () => {
  const { client } = mockClient(() => jsonResponse({ jsonrpc: '2.0', id: 1, error: { message: 'rate limited' } }, 429));
  await assert.rejects(() => readSolBalance(client, OWNER), SolanaRpcError);
});

test('malformed JSON in the response body is surfaced as SolanaMalformedResponseError', async () => {
  const client = createSolanaRpcClient({
    fetchImpl: async () => ({ ok: true, status: 200, text: async () => 'not json{' }),
  });
  await assert.rejects(() => readSolBalance(client, OWNER), SolanaMalformedResponseError);
});

test('a fetch-level failure (DNS/timeout/connection reset) is surfaced as SolanaNetworkError', async () => {
  const client = createSolanaRpcClient({
    fetchImpl: async () => { throw new Error('ECONNRESET'); },
  });
  await assert.rejects(() => readSolBalance(client, OWNER), SolanaNetworkError);
});

test('a response missing the result field is surfaced as SolanaMalformedResponseError, never returned as-is', async () => {
  const client = createSolanaRpcClient({
    fetchImpl: async () => jsonResponse({ jsonrpc: '2.0', id: 1 }),
  });
  await assert.rejects(() => readSolBalance(client, OWNER), SolanaMalformedResponseError);
});

test('readSolBalance rejects an invalid public key before any RPC call', async () => {
  const { client, calls } = mockClient(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: { context: {}, value: 0 } }));
  await assert.rejects(() => readSolBalance(client, 'not-a-pubkey'), SolanaAdapterError);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------------------
// Construction — pure, no network, no signing
// ---------------------------------------------------------------------------

test('deriveAssociatedTokenAddress is deterministic and produces a valid off-curve public key', () => {
  const first = deriveAssociatedTokenAddress(OWNER, CIRCLE_USD_MINT);
  const second = deriveAssociatedTokenAddress(OWNER, CIRCLE_USD_MINT);
  assert.equal(first.toBase58(), second.toBase58());
  assert.equal(first.toBuffer().length, 32);
});

test('deriveAssociatedTokenAddress produces a different address for a different owner or mint', () => {
  const otherOwner = new PublicKey(TOKEN_PROGRAM_ID); // any distinct valid pubkey
  const forOwner = deriveAssociatedTokenAddress(OWNER, CIRCLE_USD_MINT);
  const forOtherOwner = deriveAssociatedTokenAddress(otherOwner.toBase58(), CIRCLE_USD_MINT);
  const forOtherMint = deriveAssociatedTokenAddress(OWNER, TOKEN_PROGRAM_ID);
  assert.notEqual(forOwner.toBase58(), forOtherOwner.toBase58());
  assert.notEqual(forOwner.toBase58(), forOtherMint.toBase58());
});

test('buildTransferCheckedInstruction encodes the SPL Token TransferChecked layout exactly: '
  + 'tag(u8=12) || amount(u64 LE) || decimals(u8)', () => {
  const ata = deriveAssociatedTokenAddress(OWNER, CIRCLE_USD_MINT);
  const ix = buildTransferCheckedInstruction({
    source: ata.toBase58(), destination: ata.toBase58(), owner: OWNER, mint: CIRCLE_USD_MINT,
    amount: 25_000_000n, decimals: 6,
  });
  assert.equal(ix.programId.toBase58(), TOKEN_PROGRAM_ID);
  assert.equal(ix.data.length, 10);
  assert.equal(ix.data[0], 12); // TransferChecked opcode
  assert.equal(ix.data.readBigUInt64LE(1), 25_000_000n);
  assert.equal(ix.data[9], 6); // decimals
  assert.equal(ix.keys.length, 4);
  const [source, mint, destination, owner] = ix.keys;
  assert.equal(source.isWritable, true);
  assert.equal(source.isSigner, false);
  assert.equal(mint.isWritable, false);
  assert.equal(destination.isWritable, true);
  assert.equal(owner.isSigner, true);
  assert.equal(owner.isWritable, false);
});

test('buildTransferCheckedInstruction rejects a negative or non-bigint amount', () => {
  const ata = deriveAssociatedTokenAddress(OWNER, CIRCLE_USD_MINT);
  assert.throws(() => buildTransferCheckedInstruction({
    source: ata.toBase58(), destination: ata.toBase58(), owner: OWNER, mint: CIRCLE_USD_MINT, amount: -1n, decimals: 6,
  }), SolanaAdapterError);
  assert.throws(() => buildTransferCheckedInstruction({
    source: ata.toBase58(), destination: ata.toBase58(), owner: OWNER, mint: CIRCLE_USD_MINT, amount: 100, decimals: 6,
  }), SolanaAdapterError);
});

test('buildUnsignedTransaction produces base64 wire bytes that legacy-deserialize back to the exact instruction', async () => {
  const { Transaction } = await import('@solana/web3.js');
  const ata = deriveAssociatedTokenAddress(OWNER, CIRCLE_USD_MINT);
  const ix = buildTransferCheckedInstruction({
    source: ata.toBase58(), destination: ata.toBase58(), owner: OWNER, mint: CIRCLE_USD_MINT, amount: 1_000_000n, decimals: 6,
  });
  const unsignedBase64 = buildUnsignedTransaction({ feePayer: OWNER, recentBlockhash: SYSTEM_PROGRAM_ID, instructions: [ix] });
  const decoded = Transaction.from(Buffer.from(unsignedBase64, 'base64'));
  assert.equal(decoded.feePayer.toBase58(), OWNER);
  assert.equal(decoded.recentBlockhash, SYSTEM_PROGRAM_ID);
  assert.equal(decoded.instructions.length, 1);
  assert.equal(decoded.instructions[0].data.toString('hex'), ix.data.toString('hex'));
  assert.equal(decoded.signatures.length, 1);
  assert.equal(decoded.signatures[0].signature, null); // unsigned
});

test('buildUnsignedTransaction rejects an empty instruction list', () => {
  assert.throws(() => buildUnsignedTransaction({ feePayer: OWNER, recentBlockhash: SYSTEM_PROGRAM_ID, instructions: [] }), SolanaAdapterError);
});

test('buildRelayLegacyTransaction refuses an instruction plan with address lookup tables instead of guessing a legacy account layout', () => {
  assert.throws(
    () => buildRelayLegacyTransaction({
      feePayer: OWNER,
      recentBlockhash: SYSTEM_PROGRAM_ID,
      instructionPlan: {
        instructions: [{
          programId: SYSTEM_PROGRAM_ID,
          keys: [
            { pubkey: OWNER, isSigner: true, isWritable: true },
            { pubkey: CIRCLE_USD_MINT, isSigner: false, isWritable: true },
          ],
          data: '020000000100000000000000',
        }],
        addressLookupTableAddresses: [ASSOCIATED_TOKEN_PROGRAM_ID],
      },
    }),
    /address lookup tables/,
  );
});

test('buildPriorityFeeInstructions produces explicit compute-budget instructions from integer configuration', () => {
  const instructions = buildPriorityFeeInstructions({ computeUnitLimit: 200_000, microLamports: '1234' });
  assert.equal(instructions.length, 2);
  assert.equal(instructions[0].data.readUInt8(0), 2);
  assert.equal(instructions[0].data.readUInt32LE(1), 200_000);
  assert.equal(instructions[1].data.readUInt8(0), 3);
  assert.equal(instructions[1].data.readBigUInt64LE(1), 1234n);
});

test('buildPriorityFeeInstructions refuses non-canonical or incomplete configuration', () => {
  assert.throws(() => buildPriorityFeeInstructions({ computeUnitLimit: 0, microLamports: '1' }), SolanaAdapterError);
  assert.throws(() => buildPriorityFeeInstructions({ computeUnitLimit: 200_000, microLamports: '01' }), SolanaAdapterError);
});

// ---------------------------------------------------------------------------
// Broadcast — never signs, only submits pre-signed bytes
// ---------------------------------------------------------------------------

test('submitSignedTransaction calls sendTransaction with exactly the given base64 payload and base64 encoding', async () => {
  const { client, calls } = mockClient(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: SIGNATURE }));
  const signature = await submitSignedTransaction(client, 'ZmFrZS1zaWduZWQtYnl0ZXM=');
  assert.equal(signature, SIGNATURE);
  assert.equal(calls[0].method, 'sendTransaction');
  assert.deepEqual(calls[0].params, ['ZmFrZS1zaWduZWQtYnl0ZXM=', { encoding: 'base64', skipPreflight: false, preflightCommitment: 'finalized' }]);
});

test('submitSignedTransaction rejects an empty payload before ever calling the RPC', async () => {
  const { client, calls } = mockClient(() => jsonResponse({ jsonrpc: '2.0', id: 1, result: SIGNATURE }));
  await assert.rejects(() => submitSignedTransaction(client, ''), SolanaAdapterError);
  assert.equal(calls.length, 0);
});
