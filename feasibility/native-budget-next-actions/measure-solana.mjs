// Public, read-only RPC measurements. Builds unsigned messages only; never signs or submits.
import { readFile, writeFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(new URL('../../packages/adapters/package.json', import.meta.url));
const { PublicKey, Transaction, TransactionInstruction } = require('@solana/web3.js');
const directory = new URL('./', import.meta.url);
const raw = JSON.parse(await readFile(new URL('relay-return-scenario-response.json', directory)));
const plan = raw.steps[0].items[0].data;
const payer = raw.details.sender;
try { await access(new URL('solana-measurement-sources.json', directory)); throw new Error('Refusing to overwrite retained Solana observations; use a fresh directory'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const observations = [];
async function rpc(name, method, params) {
  const request = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const endpoint = 'https://api.mainnet-beta.solana.com';
  await writeFile(new URL(`${name}-request.json`, directory), `${request}\n`);
  const response = execFileSync('curl', ['--max-time', '30', '--fail-with-body', '-sS', '-H', 'content-type: application/json', '--data-binary', '@-', endpoint], { input: request, encoding: 'utf8' });
  await writeFile(new URL(`${name}-response.json`, directory), response);
  observations.push({ name, method, endpoint, observedAt: new Date().toISOString(), responseSha256: createHash('sha256').update(response).digest('hex') });
  await writeFile(new URL('solana-measurement-sources.json', directory), JSON.stringify(observations, null, 2)+'\n');
  const decoded = JSON.parse(response); if (decoded.error) throw new Error(JSON.stringify(decoded.error)); return decoded.result;
}
const block = await rpc('solana-blockhash', 'getLatestBlockhash', [{ commitment: 'finalized' }]);
const transaction = new Transaction({ feePayer: new PublicKey(payer), recentBlockhash: block.value.blockhash });
for (const ix of plan.instructions) transaction.add(new TransactionInstruction({ programId: new PublicKey(ix.programId), keys: ix.keys.map(k => ({ ...k, pubkey: new PublicKey(k.pubkey) })), data: Buffer.from(ix.data, 'hex') }));
const message = transaction.serializeMessage().toString('base64');
await writeFile(new URL('unsigned-return-message.json', directory), JSON.stringify({ encoding:'base64', message, feePayer:payer, requiredSignatures: transaction.compileMessage().header.numRequiredSignatures, sourceQuoteRequestId: raw.steps[0].requestId, sourceProtocolOrderId: raw.protocol.v2.orderId, signed:false }, null,2)+'\n');
await rpc('solana-return-message-fee', 'getFeeForMessage', [message, { commitment: 'finalized' }]);
await rpc('solana-token-account-rent', 'getMinimumBalanceForRentExemption', [165, { commitment: 'finalized' }]);
await rpc('solana-wallet-balance', 'getBalance', [payer, { commitment: 'finalized' }]);
const accounts = [...new Set(plan.instructions.flatMap(ix => ix.keys.map(k => k.pubkey)))];
await rpc('solana-return-accounts', 'getMultipleAccounts', [accounts, { encoding: 'base64', dataSlice: { offset: 0, length: 0 }, commitment: 'finalized' }]);
const writable = [...new Set(plan.instructions.flatMap(ix => ix.keys.filter(k => k.isWritable).map(k => k.pubkey)))];
await rpc('solana-recent-priority-fees', 'getRecentPrioritizationFees', [writable]);
