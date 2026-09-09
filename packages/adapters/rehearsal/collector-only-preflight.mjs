import { collectorOnlyPackCostMicroUsd } from '../src/app/compose.mjs';
// Read-only admission for the one-pack Collector-only rehearsal. It intentionally has no
// provider mutation or signer capability: the caller must complete this plan before `run` can
// construct a transaction-capable signer.
import {
  CIRCLE_USD_DECIMALS,
  CIRCLE_USD_MINT,
  deriveAssociatedTokenAddress,
  readAssociatedTokenAccount,
  readSolBalance,
  readUsableLatestBlockhash,
} from '../src/solana-rpc.mjs';
import { parseCollectorMachineContains } from '../src/collector-crypt.mjs';
import { assertCollectorPolicyBundleRuntimeReady } from '../src/signing/collector-policy-loader.mjs';
import { readTransactionPolicyRules } from '../src/signing/transaction-policy.mjs';
import { assertCollectorOnlyRehearsalPolicy } from '../../runner/src/automation/policy-engine.mjs';

const decimalPattern = /^(0|[1-9][0-9]*)$/;

function fail(message) {
  throw new Error(`collector-only preflight refused: ${message}`);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typedCircleUsd(value, label, { positive = false } = {}) {
  if (!plainObject(value)
    || value.chainId !== 'solana-mainnet'
    || value.assetId !== CIRCLE_USD_MINT
    || value.decimals !== CIRCLE_USD_DECIMALS
    || typeof value.amountAtomic !== 'string'
    || !decimalPattern.test(value.amountAtomic)
    || (positive && value.amountAtomic === '0')) {
    fail(`${label} must be a typed positive Circle USD atomic amount`);
  }
  return Object.freeze({
    chainId: value.chainId,
    assetId: value.assetId,
    decimals: value.decimals,
    amountAtomic: value.amountAtomic,
  });
}

function assertLiveCollectorOnlyConfig(config) {
  if (!plainObject(config)
    || config.execution?.profile !== 'rehearsal'
    || config.execution?.providerMode !== 'live'
    || config.rehearsal?.mode !== 'collector-only') {
    fail('configuration is not a live collector-only rehearsal');
  }
  const operator = config.accounts?.solana;
  const packCode = config.pack?.code;
  const proceedsAccount = config.rehearsal?.proceedsAccount;
  const recipients = config.rehearsal?.payoutRecipients;
  if (typeof operator !== 'string' || operator.length === 0) fail('configured Operations Solana account is missing');
  if (typeof packCode !== 'string' || packCode.length === 0) fail('configured pack code is missing');
  if (typeof proceedsAccount !== 'string' || proceedsAccount.length === 0) fail('dedicated proceeds account is missing');
  if (!Array.isArray(recipients) || recipients.length === 0) fail('payout recipients are missing');
  const settlementAsset = config.collectorCrypt?.settlementAsset;
  if (!plainObject(settlementAsset)
    || settlementAsset.chainId !== 'solana-mainnet'
    || settlementAsset.assetId !== CIRCLE_USD_MINT
    || settlementAsset.decimals !== CIRCLE_USD_DECIMALS) {
    fail('configured settlement asset is not the documented Circle USD asset');
  }
  const spend = typedCircleUsd(config.collectorCrypt?.packPrice, 'configured pack price', { positive: true });
  const expectedProceedsAccount = deriveAssociatedTokenAddress(operator, CIRCLE_USD_MINT).toBase58();
  if (proceedsAccount !== expectedProceedsAccount) {
    fail('dedicated proceeds account must be the Operations Circle USD associated token account');
  }
  const reserve = config.moneyConfiguration?.solana?.lamportReserve;
  if (!plainObject(reserve) || reserve.chainId !== 'solana-mainnet' || reserve.assetId !== 'native'
    || reserve.decimals !== 9 || typeof reserve.amountAtomic !== 'string' || !decimalPattern.test(reserve.amountAtomic)) {
    fail('typed Solana lamport reserve is missing');
  }
  return Object.freeze({ operator, packCode, proceedsAccount, recipients: Object.freeze([...recipients]), spend, reserve: BigInt(reserve.amountAtomic) });
}

function assertProbeIdentity(readiness, operator) {
  const solana = readiness?.['operator-solana'];
  if (!plainObject(solana) || solana.ready !== true) fail('Operations Keychain sign-only check did not succeed');
  if (solana.publicKey !== operator) {
    fail('Operations Keychain sign-only check did not confirm the configured Operations public key');
  }
}

function requirePinnedPolicy(policy, { stage, label }) {
  if (!plainObject(policy)) fail(`trusted Collector execution bundle is missing ${label} transaction policy`);
  if (policy.stage !== stage) fail(`trusted Collector execution bundle ${label} transaction policy is bound to the wrong stage`);
  try {
    const rules = readTransactionPolicyRules(policy);
    if (!Array.isArray(rules) || rules.length === 0) throw new Error('no rules');
  } catch {
    fail(`trusted Collector execution bundle ${label} transaction policy is not pinned in this process`);
  }
}

function assertTrustedExecutionBundle(config) {
  const collector = config?.collectorCrypt;
  const bundle = collector?.executionBundle;
  if (bundle !== undefined) {
    requirePinnedPolicy(bundle?.policies?.purchase, { stage: 'purchase', label: 'purchase' });
    requirePinnedPolicy(bundle?.policies?.open, { stage: 'open', label: 'open' });
    requirePinnedPolicy(bundle?.policies?.buyback, { stage: 'buyback', label: 'buyback' });
    try {
      assertCollectorPolicyBundleRuntimeReady(bundle);
    } catch (error) {
      fail(error.message);
    }
  } else {
    requirePinnedPolicy(collector?.purchase?.policy, { stage: 'purchase', label: 'purchase' });
    const buyback = collector?.buyback;
    requirePinnedPolicy(buyback?.policy, { stage: 'buyback', label: 'buyback' });
    if (typeof buyback?.collectorProgramId !== 'string' || buyback.collectorProgramId.length === 0
      || typeof buyback.collectorRecipient !== 'string' || buyback.collectorRecipient.length === 0) {
      fail('trusted Collector execution bundle is missing buyback program or recipient binding');
    }
  }

  const gate = collector?.epicGate;
  if (!plainObject(gate)
    || ['nftAddressField', 'insuredValueField', 'prizeTierField', 'rarityField'].some(field => (
      typeof gate[field] !== 'string' || gate[field].length === 0
    ))
    || !plainObject(gate.asset)
    || gate.asset.chainId !== 'solana-mainnet'
    || gate.asset.assetId !== CIRCLE_USD_MINT
    || gate.asset.decimals !== CIRCLE_USD_DECIMALS) {
    fail('trusted Collector execution bundle is missing verified epic-gate field bindings');
  }

  requirePinnedPolicy(config?.rehearsal?.payoutPolicy, { stage: 'payout', label: 'payout' });
  if (typeof config?.solana?.blockhashContextResolver !== 'function'
    || typeof config?.solana?.lookupTableResolver !== 'function') {
    fail('trusted Collector execution bundle is missing Solana transaction context resolvers');
  }
}

function catalogPriceAtomic(machine) {
  const price = plainObject(machine.price) ? machine.price.amount : machine.price;
  if (!Number.isSafeInteger(price) || price < 0) fail('selected Collector pack has no whole-dollar price');
  return (BigInt(price) * 1_000_000n).toString();
}

function selectedMachine(catalog, packCode, spendAtomic) {
  if (!plainObject(catalog) || !Array.isArray(catalog.machines)) fail('Collector machine response is invalid');
  const matches = catalog.machines.filter(machine => plainObject(machine) && machine.code === packCode);
  if (matches.length !== 1) fail('selected Collector pack is missing or ambiguous');
  const contains = parseCollectorMachineContains(matches[0].contains);
  if (contains !== 1) fail('selected Collector pack must contain exactly one card');
  const priceAtomic = catalogPriceAtomic(matches[0]);
  if (priceAtomic !== spendAtomic) fail('selected Collector catalog price does not match the exact planned spend');
  return Object.freeze({ code: packCode, contains, priceAtomic });
}

function assertTokenAccount(account, { owner, expectedAddress, minimum = null, label }) {
  if (!plainObject(account) || account.exists !== true || account.address !== expectedAddress
    || account.decimals !== CIRCLE_USD_DECIMALS) {
    fail(`${label} token account is missing or invalid`);
  }
  if (minimum !== null && (typeof account.amount !== 'bigint' || account.amount < minimum)) {
    fail(`${label} Circle USD balance is below the exact planned spend`);
  }
  return Object.freeze({ owner, tokenAccount: account.address, amountAtomic: account.amount.toString() });
}

/**
 * Validates every read-only prerequisite and returns the immutable purchase plan. Injected readers
 * make the boundary testable without an RPC or Keychain; defaults call the normal finalized RPC
 * helpers. No mutation endpoint is accepted by this function.
 */
export async function runCollectorOnlyPreflight({
  config,
  policyConfiguration,
  adapters,
  probeKeychain,
  readers = {},
} = {}) {
  const plan = assertLiveCollectorOnlyConfig(config);
  if (typeof probeKeychain !== 'function') fail('Operations Keychain sign-only probe is unavailable');
  if (typeof adapters?.collectorCrypt?.getMachines !== 'function') fail('Collector machine reader is unavailable');
  const solanaClient = adapters?.solana?.client;
  const readBlockhash = readers.readUsableLatestBlockhash ?? readUsableLatestBlockhash;
  const readNativeBalance = readers.readSolBalance ?? readSolBalance;
  const readTokenAccount = readers.readAssociatedTokenAccount ?? readAssociatedTokenAccount;

  assertCollectorOnlyRehearsalPolicy(policyConfiguration, {
    packCode: plan.packCode,
    packPriceAtomic: plan.spend.amountAtomic,
    packCostMicroUsd: collectorOnlyPackCostMicroUsd(config),
  });
  assertTrustedExecutionBundle(config);

  const readiness = await probeKeychain();
  assertProbeIdentity(readiness, plan.operator);

  const [catalog, blockhash, solBalance, source, ...recipientAccounts] = await Promise.all([
    adapters.collectorCrypt.getMachines(),
    readBlockhash(solanaClient),
    readNativeBalance(solanaClient, plan.operator),
    readTokenAccount(solanaClient, plan.operator, CIRCLE_USD_MINT),
    ...plan.recipients.map(recipient => readTokenAccount(solanaClient, recipient, CIRCLE_USD_MINT)),
  ]);
  const machine = selectedMachine(catalog, plan.packCode, plan.spend.amountAtomic);
  if (!plainObject(blockhash) || typeof blockhash.blockhash !== 'string' || blockhash.blockhash.length === 0) {
    fail('Solana RPC did not return a usable blockhash');
  }
  if (typeof solBalance !== 'bigint' || solBalance < plan.reserve) {
    fail('Operations SOL balance is below the configured lamport reserve');
  }
  const sourceAccount = assertTokenAccount(source, {
    owner: plan.operator,
    expectedAddress: plan.proceedsAccount,
    minimum: BigInt(plan.spend.amountAtomic),
    label: 'dedicated proceeds',
  });
  const recipients = recipientAccounts.map((account, index) => assertTokenAccount(account, {
    owner: plan.recipients[index],
    expectedAddress: deriveAssociatedTokenAddress(plan.recipients[index], CIRCLE_USD_MINT).toBase58(),
    label: 'payout recipient',
  }));

  return Object.freeze({
    schema: 'hookemon.collector-only-preflight.v1',
    mode: 'collector-only',
    machine,
    spend: plan.spend,
    proceedsAccount: plan.proceedsAccount,
    sourceAccount,
    solBalanceLamports: solBalance.toString(),
    lamportReserve: plan.reserve.toString(),
    recipients: Object.freeze(recipients),
  });
}
